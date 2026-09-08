// `fleet watch` (contract §7) — the one long-lived loop that keeps a fleet alive: the supervisor's
// checks, the reclaimer, the stall watcher, the autowave and the guardian, composed into ONE pass.
//
// One process, one pass, one process snapshot. Every part of this used to be its own background
// script, and the failures were all the same shape:
//
//   ⛔ ONE snapshot per pass, taken by the supervisor and handed to everything else. The Windows scan
//      alone costs ~450 ms, and two watchers reading two different snapshots disagree about which
//      processes exist — which is how a reclaimer removed a worktree a live agent was working in.
//   ⛔ Exactly ONE supervisor per fleet. The guard is the supervisor's own (loop.instanceDecision):
//      the OLDEST instance keeps the fleet and a newer one exits, because an orphaned second scanner
//      once kept reporting "all healthy" while the first had already been killed.
//   ⛔ A watcher that throws does not end the pass. It is recorded as a fault and the next watcher
//      still runs: a supervisor that dies on one bad reading is one nobody notices is gone until the
//      fleet has drained.
//   ⛔ The autowave only runs when `queue.txt` has keys in it. Filling that file is how the operator
//      asks for a topped-up fleet (contract §4 calls it the autowave input); an autowave that ran
//      unasked would keep relaunching a fleet the operator was trying to wind down.
//
// The guardian's helper supervision is deliberately not used here: it restarts helper loops that run
// as their OWN processes, and these run in this one — there is no helper pid to supervise, and a
// supervisor that "restarted" itself would be the duplicate the guard above exists to prevent.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { envelope } from '../../cli.mjs'
import { otherLaunchers } from './up.mjs'
import { DEFAULT_INTERVAL_MS, runPass, startLoop } from '../../supervisor/loop.mjs'
import { newReclaimState, reclaimOnce } from '../../watchers/reclaim.mjs'
import { createStallWatcher } from '../../watchers/stalls.mjs'
import { autowavePass, queuePath, readQueue } from '../../watchers/autowave.mjs'
import { initialParkState, quotaPark, snapshotWip, wipDue, writeFleetManifest } from '../../watchers/guardian.mjs'
import { listSessions } from '../../core/fleet.mjs'
import { stateLayout } from '../../config/paths.mjs'
import { spawnDetached } from '../../sys/exec.mjs'
import { snapshot as takeSnapshot } from '../../sys/snapshot.mjs'

export const name = 'watch'
export const usage = 'fleet watch [--once]'
export const needsConfig = true
// The reclaimer kills through the backend and the stall watcher nudges through it; a watcher with no
// backend would silently do neither.
export const needsBackend = true

/** This process's own CLI entry point — what the autowave starts a `fleet up` with. */
export const CLI = fileURLToPath(new URL('../../cli.mjs', import.meta.url))

/** State that must survive between passes: strikes, cooldowns, the park record, the wave clock. */
export function newWatchState() {
  return { reclaim: newReclaimState(), park: initialParkState(), wipAt: null, lastWaveAt: null }
}

/**
 * Start a `fleet up` for the autowave, DETACHED with both streams on a log file.
 *
 * ⛔ Detached and redirected, both. A launcher started as a child of this loop dies with it, so a
 * teardown of the watcher would take a launching fleet with it; and one whose output goes nowhere
 * leaves a failed launch with nothing to read afterwards — a launcher whose own log redirect failed
 * ran headless and left no trace of why it stopped.
 */
export function autowaveRunner({ stateDir, log = () => {}, spawn = spawnDetached }) {
  return argv => {
    const file = path.join(stateLayout(stateDir, process.platform).logs, 'autowave-up.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, 'a')
    try {
      const child = spawn(process.execPath, [CLI, ...argv], { stdio: ['ignore', fd, fd] })
      log(`watch: started fleet ${argv.join(' ')} (pid ${child.pid}); its output is in ${file}`)
      return { pid: child.pid, log: file }
    } finally {
      // The child holds its own duplicate of the descriptor, so closing ours here leaks nothing and
      // keeps this loop from accumulating one open handle per wave for the length of a run.
      fs.closeSync(fd)
    }
  }
}

/**
 * The four watchers, run against a supervisor pass that has ALREADY happened — so they reason over
 * the snapshot it took rather than taking a second one.
 *
 * @param {{base: object, state: object, pass: object, nowMs?: number}} o
 * @returns {Promise<object>} the pass summary, faults included
 */
export async function runWatchers({ base, state, pass, nowMs = Date.now() }) {
  const { config, stateDir, backend, primary, log } = base
  const faults = []
  const guarded = (watcher, fn, fallback = null) => {
    try {
      return fn()
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      faults.push({ watcher, error: message })
      log(`watch: ${watcher} threw: ${message}`)
      return fallback
    }
  }
  const snapshot = pass.snapshot

  // ---- the reclaimer: flagged sessions, then the crashed-before-flagging inference -----------------
  const reclaim = guarded('reclaim', () => reclaimOnce({
    stateDir,
    backend,
    config,
    primary,
    snapshot,
    // The one sanctioned fresh read: taken AFTER a kill, to prove it.
    resnapshot: () => takeSnapshot({ maxAgeMs: 0 }),
    nowMs,
    state: state.reclaim,
    log,
  }), { results: [], state: state.reclaim, degraded: true })
  state.reclaim = reclaim.state

  // ---- the stall watcher: dead turns, and the account switch that ends a park ----------------------
  const account = guarded('stalls.account', () => base.stalls.accountTick(nowMs), null)
  const stalls = guarded('stalls', () => base.stalls.scan(nowMs), null)

  // ---- the guardian: park on a usage limit, keep the manifest and the WIP patches ------------------
  const park = guarded('guardian.park', () => quotaPark(
    // Either event can arrive on one pass: the scan reports the limit as a LEVEL, the account tick
    // reports the switch as an EDGE, and the park record is the only thing that turns the pair into
    // "resume the fleet" — sessions do NOT self-recover from an account-level usage limit.
    account && account.event === 'switched' ? { kind: 'account-switch' } : stalls ? stalls.status : null,
    { state: state.park, nowMs },
  ), { state: state.park, event: null, nudge: false })
  state.park = park.state
  if (park.event === 'parked') log(`watch: the fleet is PARKED on an account-level usage limit (${park.state.reason || 'no message'}) — nothing bypasses it, so nothing is relaunched until quota returns`)
  if (park.event === 'unparked') log('watch: quota is back — the fleet is unparked, and every stalled session must be nudged, because a session whose turn closed on the limit has nothing left to wake it')

  const registry = guarded('registry', () => listSessions({ stateDir }), [])
  const manifest = guarded('guardian.manifest', () => writeFleetManifest({ registry, config, stateDir, nowMs }), null)
  let wip = null
  if (wipDue({ lastAt: state.wipAt, nowMs })) {
    // ⛔ Patch files, never `git stash`: `refs/stash` is ONE ref shared by every worktree of the repo,
    // so one session's stash is visible and poppable by another.
    wip = guarded('guardian.wip', () => snapshotWip({
      worktrees: registry.filter(d => d.worktree).map(d => ({ label: String(d.label), worktree: d.worktree, branch: d.branch })),
      stateDir,
      config,
      nowMs,
    }), null)
    if (wip) state.wipAt = nowMs
  }

  // ---- the autowave: top the fleet up from queue.txt, when the operator has filled it ---------------
  let autowave = null
  const queued = guarded('autowave.queue', () => readQueue(queuePath(stateDir)).length, 0)
  if (queued > 0) {
    autowave = guarded('autowave', () => autowavePass({
      config,
      stateDir,
      primary,
      nowMs,
      // ⛔ Never launch beside another launcher: two of them each skip the worktrees the other just
      // created, and one issue is then silently never opened. Read from THIS pass's snapshot.
      launcherBusy: otherLaunchers(snapshot).others.length > 0,
      lastWaveAt: state.lastWaveAt,
      runFleet: autowaveRunner({ stateDir, log }),
      log,
    }), null)
    if (autowave && autowave.ran) state.lastWaveAt = autowave.lastWaveAt
  }

  return {
    exited: false,
    status: pass.status,
    reclaimed: reclaim.results || [],
    stalls: stalls ? { stalled: stalls.stalls.length, nudged: stalls.nudged.length, parked: stalls.parked.length, unacknowledged: stalls.unacknowledged.length } : null,
    autowave: autowave ? { hold: autowave.hold, launched: autowave.admitted, refused: autowave.refused.length, ran: autowave.ran } : null,
    guardian: { parked: state.park.parked, event: park.event, manifest: manifest ? manifest.file : null, wip: wip ? wip.written.length : null },
    faults,
  }
}

/** One WHOLE pass: the supervisor's checks (which take the snapshot), then the four watchers. */
export async function watchPass({ base, state, nowMs = Date.now() }) {
  let pass
  try {
    pass = await runPass({ config: base.config, stateDir: base.stateDir, backend: base.backend, primary: base.primary, nowMs, log: base.log })
  } catch (e) {
    // The supervisor owns the snapshot every watcher reasons over, so a pass that could not be taken
    // leaves nothing to hand them — reported as one fault rather than run over a reading that is not
    // there, because acting on a missing process listing is how a live fleet gets reclaimed.
    const error = e && e.message ? e.message : String(e)
    base.log(`watch: the supervisor pass failed, so no watcher ran this tick: ${error}`)
    return { exited: false, status: null, reclaimed: [], stalls: null, autowave: null, guardian: {}, faults: [{ watcher: 'supervisor', error }] }
  }
  // The supervisor's guard says an older instance owns this fleet: it has already logged why, and
  // this instance must not run the watchers — that is the duplicate scanner, one pass of it.
  if (pass.exited) return { exited: true, status: null, reclaimed: [], stalls: null, autowave: null, guardian: {}, faults: [] }
  return runWatchers({ base, state, pass, nowMs })
}

/** Everything the watchers need, built once per process. */
export function watchBase(ctx) {
  const config = ctx.config
  const stateDir = config.paths.stateDir
  return {
    config,
    stateDir,
    backend: ctx.backend,
    primary: ctx.facts.git && ctx.facts.git.primary,
    log: ctx.log,
    stalls: createStallWatcher({
      stateDir,
      transcriptsDir: config.paths.transcriptsDir,
      backend: ctx.backend,
      env: ctx.env,
      homedir: os.homedir(),
      // Read per scan, never captured once: sessions come and go while this loop runs, and a watcher
      // holding the listing it started with nudges labels that no longer exist.
      registry: () => listSessions({ stateDir }),
      now: ctx.now,
      log: ctx.log,
    }),
  }
}

export async function run(ctx, args) {
  const stateDir = ctx.config.paths.stateDir
  if (!(ctx.facts.git && ctx.facts.git.primary)) {
    ctx.fail('watch.no-checkout', `${ctx.cwd} is not inside a git checkout, so there is no fleet to watch`, 'run `fleet watch` from inside the repository the fleet was launched from')
  }
  fs.mkdirSync(stateDir, { recursive: true })
  const base = watchBase(ctx)
  const state = newWatchState()

  if (args.flags.once) {
    const r = await watchPass({ base, state, nowMs: ctx.now() })
    ctx.json(envelope(r.faults.length === 0, { once: true, ...summaryOf(r) }))
    ctx.log(`fleet watch --once: ${r.exited ? 'an older supervisor owns this fleet, so this pass did nothing' : `pass complete${r.faults.length ? `, ${r.faults.length} fault(s)` : ''}`}`)
    return r.faults.length ? 1 : 0
  }

  // `startLoop` owns the timer, the single-instance exit, and the rule that a tick arriving while a
  // pass is still running is SKIPPED rather than queued — two overlapping passes apply the same
  // repair twice (two restarts of one slot). The watchers hang off its `onPass`, so they reason over
  // the snapshot that pass took instead of taking a second one.
  let passes = 0
  let busy = false
  let last = null
  // ⛔ The yield has to REACH the process. When the guard finds an older supervisor, this instance must
  // stop and return — a newer one that merely stopped its timer would sit there forever, alive and
  // doing nothing, which is the "second scanner reporting all healthy" failure wearing a quiet hat.
  let stopLoop = null
  let exitRequested = false
  const loop = startLoop({
    ctx: { config: base.config, stateDir, backend: base.backend, primary: base.primary, log: ctx.log, now: ctx.now },
    intervalMs: DEFAULT_INTERVAL_MS,
    onPass: pass => {
      if (pass.exited || busy) {
        if (busy) ctx.log('watch: the previous watcher pass is still running, so this tick ran the checks only')
        return
      }
      busy = true
      runWatchers({ base, state, pass, nowMs: ctx.now() })
        .then(r => { last = r; passes++ })
        .catch(e => ctx.log(`watch: the watcher pass failed: ${e && e.message ? e.message : e}`))
        .finally(() => { busy = false })
    },
    onError: e => ctx.log(`watch: the supervisor pass failed: ${e && e.message ? e.message : e}`),
    exit: reason => {
      ctx.log(`watch: ${reason}`)
      exitRequested = true
      if (stopLoop) stopLoop()
    },
  })

  await new Promise(resolve => {
    // ⛔ A signal handler, not process.exit: `stop()` resolves only once the pass in flight has
    // finished, so a Ctrl-C cannot land halfway through a kill or a slot restart.
    stopLoop = () => { loop.stop().then(resolve, resolve) }
    process.once('SIGINT', stopLoop)
    process.once('SIGTERM', stopLoop)
    if (exitRequested) stopLoop() // the guard fired before this promise existed
  })
  ctx.json(envelope(true, { once: false, passes, ...(last ? summaryOf(last) : {}) }))
  return 0
}

/** The payload half of a pass, so `--once` and the loop report the same shape. */
function summaryOf(r) {
  return {
    exited: r.exited,
    checks: r.status ? Object.fromEntries(Object.entries(r.status.checks).map(([k, c]) => [k, { ok: c.ok, found: c.found.length, repaired: c.repaired.length }])) : null,
    memory: r.status ? r.status.memory : null,
    reclaimed: (r.reclaimed || []).map(x => ({ label: x.label, action: x.action })),
    stalls: r.stalls,
    autowave: r.autowave,
    guardian: r.guardian,
    faults: r.faults,
  }
}
