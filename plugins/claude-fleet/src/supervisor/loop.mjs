// The supervisor: `fleet watch`, the one long-lived loop that replaces six background scripts.
//
// One pass takes ONE process snapshot, runs every check against it, applies the repairs, writes
// `<stateDir>/watch.status.json` and appends one line to `<stateDir>/logs/watch.log`. Nothing in a
// check can end the pass: a check that throws is recorded as a fault in the status file and the next
// check still runs, because a supervisor that dies on one bad reading is a supervisor nobody notices
// is gone until the fleet has drained.
//
// ⛔ Exactly ONE supervisor per fleet, and the guard is done properly. A second instance is detected
// by the exact `cli.mjs watch` argv through proc.findByCommand EXCLUDING self and its ancestors — a
// substring filter once matched the shell that launched the probe and invented a phantom instance,
// flipping the count between 5 and 0 across three consecutive reads. The OLDEST instance is kept and
// the newer one exits, because an orphaned second scanner once kept reporting "all healthy" at
// 1.9 GB free while the first one had already been killed and nothing was repairing anything. An
// empty snapshot decides nothing: it is a failed listing, never proof of being alone.
//
// ⛔ The snapshot is taken once per pass (sys/snapshot caches it for `SNAPSHOT_MAX_AGE_MS`) and every
// check reasons over that one Map: the Windows scan alone costs ~450 ms, and two checks reading two
// different snapshots disagree about which processes exist.
//
// Check order is deliberate: orphans and rogue servers (kills) first, locks, then the memory reading,
// then sessions, then services BEFORE slots — the container engine and its containers must be up
// before a dev server is judged, or every restart lands on a slot whose database is down.
//
// Pure decisions (instanceDecision, strikesFrom, buildStatus, formatLogLine, leftoverPatterns) are
// exported on their own; runPass takes every side effect injected and startLoop takes its timer.

import fs from 'node:fs'
import path from 'node:path'

import { snapshot as takeSnapshot } from '../sys/snapshot.mjs'
import { findByCommand, tokenize } from '../sys/proc.mjs'
import { killTree } from '../sys/kill.mjs'
import { probeMemory, bytesToGb } from '../sys/memory.mjs'
import { shellCommand } from '../sys/exec.mjs'
import { listSessions } from '../core/fleet.mjs'
import { listWorktrees, sweepLeftovers, templatePattern } from '../core/worktree.mjs'
import { stateLayout } from '../config/paths.mjs'
import { buildSlots } from '../config/derive.mjs'

import * as orphans from './checks/orphans.mjs'
import * as rogueServers from './checks/rogue-servers.mjs'
import * as staleLocks from './checks/stale-locks.mjs'
import * as memory from './checks/memory.mjs'
import * as sessions from './checks/sessions.mjs'
import * as services from './checks/services.mjs'
import * as slots from './checks/slots.mjs'

/**
 * `<stateDir>/watch.status.json` — the supervisor's report, read by `fleet status` and the launcher.
 *
 * ⛔ This name is NOT declared in contract §4's state layout, and stateLayout() in
 * src/config/paths.mjs (which mirrors that section key for key) does not know it either. The
 * contract wins: declaring it in both is the fix — not tucking the report under some directory §4
 * happens to list, which would trade a documentation gap for a layout lie.
 */
export const STATUS_FILE = 'watch.status.json'

/** `<stateDir>/logs/watch.log` — one line per pass, append-only. */
export const LOG_FILE = 'watch.log'

/** How often a pass runs unless the caller says otherwise (no contract key exists for this). */
export const DEFAULT_INTERVAL_MS = 60_000

/** One pass reuses one snapshot; a kill's after-check asks for a FRESH one (maxAgeMs 0). */
export const SNAPSHOT_MAX_AGE_MS = 5_000

/** The checks, in the order they run. */
export const CHECKS = Object.freeze([orphans, rogueServers, staleLocks, memory, sessions, services, slots])
export const CHECK_NAMES = Object.freeze(CHECKS.map(c => c.NAME))

// ---- single instance (pure) ---------------------------------------------------------------------

/** Strip one layer of shell quoting from an argv token. */
const unquote = t => String(t).replace(/^["']|["']$/g, '')

/** Basename however the path was spelt. */
const basenameOf = p => String(p).replace(/\\/g, '/').split('/').pop()

/**
 * The two entry files contract §1–2 give the CLI: `node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <cmd>` and,
 * for humans, `npx claude-fleet <cmd>` (`bin/claude-fleet.mjs → src/cli.mjs`). An operator who runs
 * `fleet watch` by hand next to the launcher's is the commonest second instance, and their argv
 * carries the bin's name, not `cli.mjs` — a guard that knew only one spelling would let exactly that
 * pair run side by side.
 */
export const WATCH_ENTRY_FILES = Object.freeze(['cli.mjs', 'claude-fleet.mjs'])

/**
 * Is this command line `… cli.mjs watch …`? Token-exact: the token whose basename is an entry file
 * must be IMMEDIATELY followed by the token `watch`. `cli.mjs status` is not the supervisor, `cli.mjs
 * watcher` is not either, and a shell whose argument text merely contains the words is not — that
 * one is excluded by pid, not by text (see instanceDecision).
 */
export function isWatchArgv(cmd) {
  const t = tokenize(cmd).map(unquote)
  for (let i = 0; i + 1 < t.length; i++) {
    if (WATCH_ENTRY_FILES.includes(basenameOf(t[i])) && t[i + 1] === 'watch') return true
  }
  return false
}

/** The coarse RegExp handed to findByCommand; isWatchArgv confirms each hit token by token. */
export const WATCH_PATTERN = /(?:cli|claude-fleet)\.mjs["']?\s+["']?watch(?:["']|\s|$)/

/**
 * PURE. Which supervisor should keep running?
 *
 * `others` come from findByCommand with self and every ancestor of self excluded — the launching
 * shell carries the same argv text and would self-match. The oldest by `startedAt` wins; with no
 * timestamps on either side the lower pid does (pids are recycled, so it is a tiebreak, not proof).
 * @returns {{keep: boolean, degraded: boolean, others: Array<{pid, startedAt}>, oldest: {pid, startedAt}|null, reason: string}}
 */
export function instanceDecision(snapshot, { selfPid, selfStartedAt = null } = {}) {
  if (!snapshot || snapshot.size === 0) {
    return { keep: true, degraded: true, others: [], oldest: null, reason: 'the process snapshot is empty — a failed listing, never proof of being the only instance; continuing' }
  }
  const self = snapshot.get(Number(selfPid)) || null
  const mine = { pid: Number(selfPid), startedAt: selfStartedAt ?? (self ? self.startedAt : undefined) }
  const others = findByCommand(snapshot, WATCH_PATTERN, { selfPid })
    .filter(p => isWatchArgv(p.cmd))
    .map(p => ({ pid: p.pid, startedAt: p.startedAt }))
  if (!others.length) return { keep: true, degraded: false, others, oldest: mine, reason: 'the only supervisor' }
  const key = p => [Number.isFinite(p.startedAt) ? p.startedAt : Number.POSITIVE_INFINITY, p.pid]
  const oldest = [mine, ...others].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])[0]
  const keep = oldest.pid === mine.pid
  const list = others.map(o => `${o.pid}${Number.isFinite(o.startedAt) ? ` (started ${new Date(o.startedAt).toISOString()})` : ''}`).join(', ')
  return {
    keep,
    degraded: false,
    others,
    oldest,
    reason: keep
      ? `${others.length} newer supervisor(s) also running (${list}); this one is the oldest and stays`
      : `an older supervisor is running (pid ${oldest.pid}); exiting so exactly one keeps the fleet`,
  }
}

// ---- status (pure) ------------------------------------------------------------------------------

/** The per-slot strike counts a previous status file carries — {} when there is none. PURE. */
export function strikesFrom(status) {
  const out = {}
  const found = status && status.checks && status.checks.slots && Array.isArray(status.checks.slots.found) ? status.checks.slots.found : []
  for (const f of found) {
    if (f && Number.isInteger(Number(f.slot)) && Number.isFinite(Number(f.strikes))) out[Number(f.slot)] = Number(f.strikes)
  }
  return out
}

/** The `memory` field of the status file, from a sys/memory reading. PURE. */
export function memorySummary(reading) {
  if (!reading) return { freeGb: null, totalGb: null, pressure: null, degraded: true }
  return {
    freeGb: Number.isFinite(reading.freeBytes) ? Number(bytesToGb(reading.freeBytes).toFixed(2)) : null,
    totalGb: Number.isFinite(reading.totalBytes) ? Number(bytesToGb(reading.totalBytes).toFixed(2)) : null,
    pressure: reading.pressure || null,
    degraded: reading.degraded === true,
  }
}

/**
 * PURE. The status file: `{v, at, pass, checks: {name: {ok, found, repaired, notes}}, memory}`.
 * A failed repair is a NOTE ("repair failed: …") so the shape stays exactly this, and a check that
 * threw is `ok: false` with the error in its notes.
 */
export function buildStatus({ nowMs, pass, results, reading }) {
  const checks = {}
  for (const name of CHECK_NAMES) {
    const r = results[name] || { ok: false, found: [], repaired: [], notes: ['not run'] }
    checks[name] = { ok: !!r.ok, found: r.found || [], repaired: r.repaired || [], notes: r.notes || [] }
  }
  return { v: 1, at: new Date(nowMs).toISOString(), pass, checks, memory: memorySummary(reading) }
}

/** PURE. One log line per pass: every check's verdict, then the first ATTENTION note if any. */
export function formatLogLine(status) {
  const parts = [`${status.at} pass=${status.pass}`]
  for (const [name, c] of Object.entries(status.checks)) {
    const counts = c.found.length || c.repaired.length ? `(${c.found.length}${c.repaired.length ? `,${c.repaired.length} repaired` : ''})` : ''
    parts.push(`${name}=${c.ok ? 'ok' : 'FAULT'}${counts}`)
  }
  parts.push(`mem=${status.memory.freeGb === null ? '?' : `${status.memory.freeGb}GB`}`)
  const attention = Object.values(status.checks).flatMap(c => c.notes).find(n => /^ATTENTION|^repair failed|^check threw/.test(String(n)))
  return parts.join(' ') + (attention ? ` | ${attention}` : '')
}

/**
 * PURE. The anchored folder patterns a leftover may match: session folders, checker folders, and
 * ONLY the actual slot folders (`repo.slotDirTemplate` with each `testing.branches` entry filled in).
 *
 * ⛔ `{repo}-{branch}` with `{branch}` left free compiles to `^app-(?<branch>[^/]+)$`, which claims
 * EVERY `app-*` sibling — the operator's own `app-docs` checkout included — and the orphan check
 * would then kill node processes inside a tree the fleet never owned. Kill by exclusion, by another
 * name.
 */
export function leftoverPatterns(config) {
  const repo = config.repo.name
  const out = []
  out.push(templatePattern(config.repo.sessionDirTemplate, { repo }))
  out.push(templatePattern(config.repo.checkerDirTemplate, { repo }))
  for (const branch of config.testing.branches || []) out.push(templatePattern(config.repo.slotDirTemplate, { repo, branch }))
  return out
}

// ---- thin I/O -----------------------------------------------------------------------------------

export function statusPath(stateDir) {
  return path.join(stateDir, STATUS_FILE)
}

export function logPath(stateDir) {
  return path.join(stateLayout(stateDir, process.platform).logs, LOG_FILE)
}

/** The previous pass's status, or null when absent or torn (a torn file is "no previous pass"). */
export function readStatus(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(statusPath(stateDir), 'utf8'))
    return j && typeof j === 'object' && j.checks ? j : null
  } catch {
    return null
  }
}

/** Temp-then-rename: `fleet status` reads this file continuously and must never see half of it. */
export function writeStatus(stateDir, status) {
  const file = statusPath(stateDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return file
}

/** Append one line with its own newline, synchronously — never a pipeline. */
export function appendLog(stateDir, line) {
  const file = logPath(stateDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, String(line).replace(/[\r\n]+/g, ' ') + '\n')
  return file
}

/**
 * The fleet-shaped folders git no longer registers, for the orphan check. Thin.
 *
 * `git worktree list` is asked at the PRIMARY checkout. Its derived location is
 * `<repo.worktreeParent>/<repo.name>` (derive.mjs: name = basename(primary), parent = dirname(primary)),
 * but `repo.worktreeParent` is user-scope and an operator may point it at another directory — then no
 * checkout lives at the derived path, the listing throws, and every leftover looks registered (or the
 * check never runs). A caller that knows the primary passes it.
 */
export function defaultLeftovers(config, { primary = null } = {}) {
  const parent = config.repo.worktreeParent
  const repo = config.repo.name
  if (!parent || !repo) return []
  const registered = listWorktrees(primary || path.join(parent, repo))
  const seen = new Map()
  for (const pattern of leftoverPatterns(config)) {
    for (const l of sweepLeftovers({ parent, pattern, registered })) seen.set(l.path, l)
  }
  return [...seen.values()]
}

// ---- one pass -----------------------------------------------------------------------------------

/**
 * Run every check once.
 *
 * @param {object} ctx
 * @param {object} ctx.config          resolved + derived config
 * @param {string} ctx.stateDir        contract §4 state directory
 * @param {object} ctx.backend         the terminal backend (sessions check: isAlive by backendRef)
 * @param {Array}  [ctx.slots]         the slot table (default: buildSlots(config))
 * @param {number} [ctx.selfPid]       this supervisor's pid
 * @param {number} [ctx.nowMs]
 * @param {(o?: {fresh?: boolean}) => Map} [ctx.snapshot]   the process snapshot provider
 * @param {() => object} [ctx.probeMemory]
 * @param {() => Array} [ctx.listSessions]
 * @param {string} [ctx.primary]       the primary checkout `git worktree list` is asked at (default: `<worktreeParent>/<repo.name>`)
 * @param {() => Array} [ctx.leftovers]
 * @param {(locksDir: string) => Array} [ctx.readLocks]
 * @param {(config) => Promise<object>} [ctx.observeServices]
 * @param {(o) => Promise<object>} [ctx.observeSlots]
 * @param {(d) => number|null} [ctx.newestMtime]
 * @param {(d) => string|null} [ctx.readState]
 * @param {object} [ctx.io]            {killTree, shellCommand, removeLock, currentBranch, start}
 * @param {(line: string) => void} [ctx.log]
 * @returns {Promise<{status: object|null, guard: object, snapshot: Map, repaired: number, exited: boolean}>}
 */
export async function runPass(ctx) {
  const {
    config,
    stateDir,
    backend = null,
    selfPid = process.pid,
    nowMs = Date.now(),
    platform = process.platform,
    snapshot: snapshotOf = ({ fresh = false } = {}) => takeSnapshot({ maxAgeMs: fresh ? 0 : SNAPSHOT_MAX_AGE_MS }),
    probeMemory: probe = probeMemory,
    listSessions: list = () => listSessions({ stateDir }),
    primary = null,
    leftovers = () => defaultLeftovers(config, { primary }),
    readLocks = staleLocks.readLocks,
    observeServices = services.observe,
    observeSlots = slots.observeSlots,
    newestMtime = d => sessions.newestFileMtime(d.transcriptDir),
    readState = d => sessions.readStateFile(d.stateFile),
    readStatus: readPrev = () => readStatus(stateDir),
    stallAfterMinutes = undefined,
    io = {},
    log = () => {},
  } = ctx
  if (!config) throw new Error('runPass: config is required')
  if (!stateDir) throw new Error('runPass: stateDir is required')

  // ONE snapshot for the whole pass.
  const snap = snapshotOf()

  const guard = instanceDecision(snap, { selfPid })
  if (!guard.keep) {
    // Not this instance's fleet to report on: no status write, one log line, and the caller exits.
    const line = `${new Date(nowMs).toISOString()} pass=- second supervisor: ${guard.reason}`
    try { appendLog(stateDir, line) } catch { /* the older instance owns the log too */ }
    log(line)
    return { status: null, guard, snapshot: snap, repaired: 0, exited: true }
  }

  const prev = readPrev() || null
  const pass = (prev && Number.isInteger(prev.pass) ? prev.pass : 0) + 1
  const layout = stateLayout(stateDir, platform)
  const slotTable = ctx.slots || buildSlots(config)

  let registry = []
  let registryError = null
  try {
    registry = list() || []
  } catch (e) {
    registryError = e.message
  }
  let reading
  try {
    reading = probe()
  } catch (e) {
    reading = { freeBytes: 0, headroomBytes: 0, totalBytes: 0, pressure: 'critical', degraded: true, error: e.message }
  }

  const kill = io.killTree || (root => killTree(snap, root, { selfPid, platform, resnapshot: () => snapshotOf({ fresh: true }) }))
  const inputs = {
    [orphans.NAME]: () => ({ snapshot: snap, leftovers: leftovers(), selfPid }),
    [rogueServers.NAME]: () => ({ snapshot: snap, registry, pattern: config.devServer.serverProcessPattern, selfPid }),
    [staleLocks.NAME]: () => ({ locks: readLocks(layout.locks), nowMs, config }),
    [memory.NAME]: () => ({ reading, snapshot: snap, config, selfPid }),
    [sessions.NAME]: () => ({ registry, backend, nowMs, newestMtime, readState, ...(stallAfterMinutes === undefined ? {} : { stallAfterMinutes }) }),
    [services.NAME]: async () => ({ config, observed: await observeServices(config) }),
    [slots.NAME]: async () => ({ slots: slotTable, registry, config, snapshot: snap, observed: await observeSlots({ slots: slotTable, registry, config }), strikes: strikesFrom(prev) }),
  }
  const ios = {
    [orphans.NAME]: { killTree: kill },
    [rogueServers.NAME]: { killTree: kill },
    [staleLocks.NAME]: { removeLock: io.removeLock, nowMs },
    [services.NAME]: { shellCommand: io.shellCommand || shellCommand },
    [slots.NAME]: { currentBranch: io.currentBranch, start: io.start, stateDir, platform },
  }

  const results = {}
  let repairedCount = 0
  for (const check of CHECKS) {
    const name = check.NAME
    try {
      const v = check.verdict(await inputs[name]())
      const notes = [...(v.notes || [])]
      let repaired = []
      if (Array.isArray(v.repairs) && v.repairs.length) {
        const a = check.apply(v.repairs, ios[name] || {})
        repaired = a.repaired || []
        for (const f of a.failed || []) notes.push(`repair failed: ${describeRepair(f)} — ${f.error}`)
      }
      repairedCount += repaired.length
      results[name] = { ok: !!v.ok, found: v.found || [], repaired, notes }
    } catch (e) {
      // The strike counts are the one thing worth carrying across a throw: dropping them hands a
      // dead slot a fresh clock every time the probe layer hiccups.
      const carried = name === slots.NAME && prev && prev.checks && prev.checks.slots ? prev.checks.slots.found || [] : []
      results[name] = { ok: false, found: carried, repaired: [], notes: [`check threw: ${e && e.message ? e.message : String(e)}`] }
    }
  }
  if (registryError) results[sessions.NAME].notes.unshift(`the registry could not be listed: ${registryError}`)

  const status = buildStatus({ nowMs, pass, results, reading })
  writeStatus(stateDir, status)
  const line = formatLogLine(status)
  appendLog(stateDir, line)
  log(line)
  return { status, guard, snapshot: snap, repaired: repairedCount, exited: false }
}

function describeRepair(r) {
  if (!r) return 'repair'
  if (r.kind === 'kill-tree') return `kill-tree pid ${r.root}${r.label ? ` (session ${r.label})` : ''}`
  if (r.kind === 'remove-lock') return `remove-lock ${r.pool}/${r.slot}`
  if (r.kind === 'restart-slot') return `restart-slot ${r.slot}`
  if (r.kind === 'start-docker' || r.kind === 'start-container') return `${r.kind} ${r.name}`
  return r.kind || 'repair'
}

// ---- the loop -----------------------------------------------------------------------------------

/**
 * Run passes forever, `intervalMs` apart, with the timer injected.
 *
 * A tick that arrives while a pass is still running is SKIPPED, never queued: a pass carries 45 s
 * probes and a memory read, so on a loaded box passes overlap and two overlapping passes apply the
 * same repair twice (two restarts of one slot). A pass that throws is logged and the loop goes on.
 * When the guard says another instance is older, the loop stops itself and calls `exit`.
 *
 * `stop()` clears the timer at once and resolves when the pass in flight (if any) has finished: a
 * caller that tears the fleet down on `stop()` returning would otherwise race a restart or a kill
 * that pass is still applying.
 *
 * @param {object} o
 * @param {object} o.ctx                what runPass takes
 * @param {number} [o.intervalMs]
 * @param {(fn, ms) => any} [o.setTimer]
 * @param {(t) => void} [o.clearTimer]
 * @param {(result) => void} [o.onPass]
 * @param {(error) => void} [o.onError]
 * @param {(reason: string) => void} [o.exit]  called ONCE when this instance must yield
 * @param {boolean} [o.immediate]       run the first pass now (default true)
 * @returns {{stop: () => Promise<void>, running: () => boolean, passes: () => number, skipped: () => number, first: Promise<any>}}
 *   `passes()` counts COMPLETED passes — the same number `watch.status.json` carries as `pass`.
 */
export function startLoop({
  ctx,
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = t => clearInterval(t),
  onPass = () => {},
  onError = () => {},
  exit = reason => { process.exitCode = 0; process.exit(0); void reason },
  immediate = true,
} = {}) {
  if (!ctx) throw new Error('startLoop: ctx is required')
  let timer = null
  let inFlight = null // the promise of the pass now running, or null
  let stopped = false
  let passes = 0
  let skipped = 0
  let exited = false

  const stop = () => {
    stopped = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    return inFlight ? inFlight.then(() => {}, () => {}) : Promise.resolve()
  }

  const tick = () => {
    if (stopped) return Promise.resolve(null)
    if (inFlight) {
      skipped++
      return Promise.resolve(null)
    }
    inFlight = runOne()
    return inFlight
  }

  const runOne = async () => {
    try {
      const r = await runPass({ ...ctx, nowMs: typeof ctx.now === 'function' ? ctx.now() : Date.now() })
      passes++
      if (r.exited && !exited) {
        exited = true
        stop()
        exit(r.guard.reason)
        return r
      }
      onPass(r)
      return r
    } catch (e) {
      onError(e)
      return null
    } finally {
      inFlight = null
    }
  }

  const first = immediate ? tick() : Promise.resolve(null)
  timer = setTimer(() => { tick() }, intervalMs)
  return { stop, running: () => !stopped, passes: () => passes, skipped: () => skipped, first }
}
