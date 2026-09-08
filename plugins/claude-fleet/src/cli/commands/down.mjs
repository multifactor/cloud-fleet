// `fleet down [--dry-run]` (contract §7) — the teardown that returns the machine to a clean state.
//
// Recycling sessions one by one still leaves the testing servers, the pool locks, the flags and the
// terminal backend's own session behind, so this is the command that ends a run. Everything it does
// is destructive, and every rule below is a way it once destroyed the wrong thing:
//
//   ⛔ If `git status --porcelain` in the PRIMARY checkout is non-empty, STOP. That is the operator's
//      own work in the main checkout, not session scratch, and losing it is far worse than leaving a
//      few servers up.
//   ⛔ Never trust an exit code. `git worktree remove` deregisters AND deletes, and routinely does the
//      first while failing the second because a shell still holds a cwd inside the directory — so
//      removal is verified against `git worktree list` and the filesystem, both taken afterwards.
//   ⛔ Never trust a kill either: every session's tree is re-queried after the kill and the survivors
//      are reported, because a pane can close while the dev server it started keeps holding its port.
//   ⛔ Only fleet-shaped folders under `repo.worktreeParent` are touched, matched by the ANCHORED
//      templates (supervisor/loop.leftoverPatterns) — `{repo}-{branch}` with the branch left free
//      would claim every `<repo>-*` sibling, the operator's own checkouts included.
//   ⛔ `paths.artifactsDir` is never touched: a review page must outlive the session that made it,
//      because review starts after the fleet is gone.
//   ⛔ `fleet watch` is stopped too, by its SINGLE pid. It is the one process that outlives the
//      sessions, and its services check has no registry precondition — a supervisor left running past
//      the teardown restarts `services.docker.startCommand` and every container on its next tick and
//      puts back the infrastructure this command just took down. Never with a tree flag: its children
//      are the container engine and the dev servers (playbooks/launcher.md).

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { envelope, errorPayload } from '../../cli.mjs'
import { git } from '../../sys/exec.mjs'
import { listSessions, removeSession } from '../../core/fleet.mjs'
import { canonicalPath, findWorktree, listWorktrees, removeWorktree, samePath, sweepLeftovers } from '../../core/worktree.mjs'
import { sweepFolder } from '../../watchers/reclaim.mjs'
import { DEFAULT_INTERVAL_MS, isWatchArgv, leftoverPatterns, readStatus, WATCH_PATTERN } from '../../supervisor/loop.mjs'
import { stateLayout } from '../../config/paths.mjs'
import { findByCommand } from '../../sys/proc.mjs'
import { markedSessions, safeSnapshot } from './up.mjs'

export const name = 'down'
export const usage = 'fleet down [--dry-run]'
export const needsConfig = true
// The sessions are killed through the backend that spawned them, by the `backendRef` the registry
// recorded — never by searching command lines, which is how a kill once landed on the wrong tab.
export const needsBackend = true

/** PURE. Is `child` a direct entry of `parent`? Both must already be canonical. */
function isChildOf(child, parent) {
  return samePath(path.dirname(child), parent)
}

/**
 * Everything this teardown would remove: the registered fleet worktrees, then the leftover folders
 * git no longer knows about.
 *
 * A descriptor's worktree is included even when git has forgotten it — a `git worktree remove` that
 * deregistered and then failed to delete leaves gigabytes on disk that nothing else will ever sweep.
 * @returns {{worktrees: Array<{path, registered, label}>, leftovers: Array<{name, path}>}}
 */
export function teardownTargets({ config, primary, registry = [] }) {
  const parent = config.repo.worktreeParent ? canonicalPath(config.repo.worktreeParent) : null
  const primaryCanon = canonicalPath(primary)
  const patterns = leftoverPatterns(config)
  const looksLikeFleet = p => patterns.some(re => re.test(path.basename(p)))
  const registered = listWorktrees(primary)

  const byPath = new Map()
  const consider = (p, { registeredHere, label = null }) => {
    if (!p) return
    const canon = canonicalPath(p)
    // ⛔ The primary is never a target, however it was reached: it is the checkout every git command
    // in this teardown runs in, and the operator's own work lives there.
    if (samePath(canon, primaryCanon)) return
    if (!parent || !isChildOf(canon, parent) || !looksLikeFleet(canon)) return
    const prev = byPath.get(canon)
    byPath.set(canon, { path: canon, registered: registeredHere || !!(prev && prev.registered), label: label ?? (prev ? prev.label : null) })
  }

  for (const w of registered) consider(w.path, { registeredHere: true })
  for (const d of registry) consider(d.worktree, { registeredHere: false, label: String(d.label) })

  const leftovers = []
  if (parent) {
    const seen = new Set()
    for (const pattern of patterns) {
      for (const l of sweepLeftovers({ parent, pattern, registered })) {
        if (seen.has(l.path) || byPath.has(canonicalPath(l.path))) continue
        seen.add(l.path)
        leftovers.push({ name: l.name, path: l.path })
      }
    }
  }
  return { worktrees: [...byPath.values()], leftovers }
}

/** Does this worktree hold uncommitted work? `null` when git cannot answer (a deregistered tree). */
function dirtyState(dir) {
  const r = git(dir, ['status', '--porcelain'])
  if (!r.ok) return null
  return r.stdout.trim().length > 0
}

/**
 * Every process still carrying `--fleet-session=<label>`, from a FRESH snapshot. The kill's proof.
 *
 * ⛔ Scoped to THIS fleet by `stateDir` (up.markedSessions). Labels are bare numbers and contract §3
 * gives every repo on a machine its own state dir, so a second checkout routinely has a session
 * labelled "1": a machine-wide match pushed that label into `killFailed`, marked its worktree stuck,
 * kept the descriptor and skipped `killServer()` — a teardown that could never complete while the
 * other fleet ran. `foreign` is the marked pids this fleet cannot speak for, reported and not acted on.
 * @returns {{degraded: boolean, survivors: Array<{label, pid}>, foreign: Array<{label, pid}>, error?: string|null}}
 */
export function survivingSessions(labels, { stateDir = null, snapshot = null } = {}) {
  const reading = snapshot ? { snapshot, error: null } : safeSnapshot()
  const r = markedSessions(reading.snapshot, { stateDir, labels })
  // A listing that failed or came back empty proves nothing: the teardown says so rather than
  // reporting a clean machine it never actually read.
  if (r.degraded) return { degraded: true, survivors: [], foreign: [], error: reading.error }
  return { degraded: false, survivors: r.survivors, foreign: r.foreign, error: null }
}

/**
 * PURE. The `fleet watch` supervisors this teardown must stop, from a process snapshot.
 *
 * MACHINE-WIDE by the same reasoning as `up.otherLaunchers` and the supervisor's own
 * `loop.instanceDecision`: a watcher's argv carries nothing that says which checkout it watches, and
 * `instanceDecision` already keeps exactly ONE supervisor per machine. `findByCommand` excludes self
 * AND every ancestor of self, because the shell that started this teardown carries the same argv text
 * and would self-match.
 * @returns {{degraded: boolean, found: Array<{pid: number, cmd: string}>}}
 */
export function liveSupervisors(snapshot, { selfPid = process.pid } = {}) {
  if (!snapshot || snapshot.size === 0) return { degraded: true, found: [] }
  const found = findByCommand(snapshot, WATCH_PATTERN, { selfPid })
    .filter(p => isWatchArgv(p.cmd))
    .map(p => ({ pid: Number(p.pid), cmd: p.cmd }))
  return { degraded: false, found }
}

/**
 * A watcher that wrote THIS fleet's `watch.status.json` this recently is watching THIS fleet.
 *
 * ⛔ The precondition exists because the process match above cannot be scoped: without it, a teardown
 * in one checkout would stop the supervisor of another. The status file is written on every pass into
 * the state dir the supervisor watches (contract §4), so a fresh one plus a live `fleet watch` — of
 * which there is at most one per machine — is that watcher.
 */
export const WATCH_STATUS_FRESH_MS = 3 * DEFAULT_INTERVAL_MS

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Stop the supervisor, then PROVE it: SIGTERM by its single pid, a grace, then SIGKILL what is left,
 * then a fresh reading. `fleet watch` finishes the pass in flight before it exits, so an immediate
 * re-query would report a survivor that is merely on its way out.
 *
 * ⛔ One pid, never a tree flag. `fleet watch` starts the container engine and the dev servers as its
 * own children, so a tree-kill on its pid takes the database down with it — silently — and every
 * login and provisioning call across the fleet starts returning 500 (playbooks/launcher.md).
 * @returns {Promise<{stopped: number[], survivors: number[], skipped: number[], degraded: boolean}>}
 */
async function stopSupervisor({ stateDir, nowMs, log, graceMs = 3000 }) {
  const seen = liveSupervisors(safeSnapshot().snapshot)
  if (seen.degraded) {
    log('fleet down: the process listing failed, so a running `fleet watch` could not be ruled out — if one is still up, stop it by its single PID (never a tree flag: its children are the container engine and the dev servers)')
    return { stopped: [], survivors: [], skipped: [], degraded: true }
  }
  if (!seen.found.length) return { stopped: [], survivors: [], skipped: [], degraded: false }

  const status = readStatus(stateDir)
  const at = status && status.at ? Date.parse(status.at) : NaN
  if (!Number.isFinite(at) || nowMs - at > WATCH_STATUS_FRESH_MS) {
    const pids = seen.found.map(s => s.pid)
    log(`fleet down: a \`fleet watch\` is running (pid ${pids.join(', ')}) but ${stateDir} has no recent watch.status.json, so it is watching another checkout and was left alone — stop it by its single PID if it is in fact this fleet's`)
    return { stopped: [], survivors: [], skipped: pids, degraded: false }
  }

  const targets = seen.found.map(s => s.pid)
  for (const pid of targets) signal(pid, 'SIGTERM', log)
  await sleep(graceMs)
  let still = liveSupervisors(safeSnapshot().snapshot).found.map(s => s.pid).filter(pid => targets.includes(pid))
  for (const pid of still) signal(pid, 'SIGKILL', log)
  if (still.length) {
    await sleep(500)
    still = liveSupervisors(safeSnapshot().snapshot).found.map(s => s.pid).filter(pid => targets.includes(pid))
  }
  const stopped = targets.filter(pid => !still.includes(pid))
  for (const pid of stopped) log(`fleet down: the supervisor (pid ${pid}) was stopped by its single PID, so nothing restarts the services behind this teardown`)
  return { stopped, survivors: still, skipped: [], degraded: false }
}

/** One signal to ONE pid. An ESRCH is the process already gone, which is the outcome we wanted. */
function signal(pid, sig, log) {
  try {
    process.kill(pid, sig)
  } catch (e) {
    if (e.code !== 'ESRCH') log(`fleet down: ${sig} to the supervisor (pid ${pid}) failed: ${e.message}`)
  }
}

export async function run(ctx, args) {
  const config = ctx.config
  const stateDir = config.paths.stateDir
  const dryRun = !!args.flags['dry-run']
  const primary = ctx.facts.git && ctx.facts.git.primary
  if (!primary) ctx.fail('down.no-checkout', `${ctx.cwd} is not inside a git checkout, so there is no fleet to tear down`, 'run `fleet down` from inside the repository the fleet was launched from')

  // ---- check 4 first: the operator's own work ----------------------------------------------------
  const porcelain = git(primary, ['status', '--porcelain'])
  if (!porcelain.ok) {
    ctx.fail('down.primary-unreadable', `git status failed in the primary checkout ${primary}: ${(porcelain.stderr || porcelain.stdout).trim()}`, 'teardown runs every git command there, so it stops rather than guess')
  }
  if (porcelain.stdout.trim()) {
    const files = porcelain.stdout.trim().split(/\r?\n/)
    const message = `the primary checkout ${primary} has ${files.length} uncommitted change(s), so NOTHING was torn down`
    const hint = 'that is your own work in the main checkout, not session scratch — commit or stash it there yourself, then run `fleet down` again; losing it is far worse than leaving a few servers up'
    ctx.json(errorPayload('down.primary-dirty', message, hint, { primary, dirty: files.slice(0, 20) }))
    ctx.log(`fleet down: ${message}`)
    ctx.log(`  hint: ${hint}`)
    return 1
  }

  const registry = listSessions({ stateDir })
  const targets = teardownTargets({ config, primary, registry })
  const dirty = targets.worktrees.map(w => ({ ...w, dirty: dirtyState(w.path) })).filter(w => w.dirty)
  // ⛔ Resolved ONCE, per descriptor, and `null` when the descriptor carries no worktree.
  // `canonicalPath('')` THROWS (core/worktree.assertPath), and the two comparisons below run after the
  // sessions are killed and the worktrees removed but BEFORE the flags, locks and descriptors are
  // cleared — so one hand-edited or older-generation descriptor would abort the teardown half done.
  const worktreeOf = new Map(registry.map(d => [String(d.label), d.worktree ? canonicalPath(d.worktree) : null]))

  if (dryRun) {
    const watcher = liveSupervisors(safeSnapshot().snapshot)
    ctx.json(envelope(true, {
      dryRun: true,
      primary,
      sessions: registry.map(d => String(d.label)),
      worktrees: targets.worktrees.map(w => w.path),
      leftovers: targets.leftovers.map(l => l.path),
      dirtyWorktrees: dirty.map(w => w.path),
      flags: stateLayout(stateDir, process.platform).flags,
      locks: stateLayout(stateDir, process.platform).locks,
      supervisor: watcher.found.map(s => s.pid),
    }))
    ctx.log(`fleet down --dry-run: ${registry.length} session(s) would be killed, ${targets.worktrees.length} worktree(s) removed, ${targets.leftovers.length} leftover folder(s) swept; nothing was touched`)
    for (const s of watcher.found) ctx.log(`  supervisor pid ${s.pid} (\`fleet watch\`) would be stopped by its single PID`)
    for (const w of targets.worktrees) ctx.log(`  worktree ${w.path}${w.registered ? '' : ' (registered nowhere — the folder alone)'}`)
    for (const l of targets.leftovers) ctx.log(`  leftover ${l.path}`)
    for (const w of dirty) ctx.log(`  ⛔ ${w.path} has uncommitted work, which teardown discards`)
    return 0
  }

  // ---- kill every session, then prove it ---------------------------------------------------------
  const killed = []
  const killFailed = []
  for (const d of registry) {
    const label = String(d.label)
    if (!d.backendRef) {
      // Never spawned, or spawned by a fleet this backend does not own: there is no handle to kill by,
      // and killing "whatever is in that folder" is the kill-by-exclusion this tool never does.
      killed.push({ label, result: 'no-backend-ref' })
      continue
    }
    try {
      const r = ctx.backend.kill({ id: label, role: d.role, backendRef: d.backendRef })
      if (r.ok) killed.push({ label, result: r.alreadyGone ? 'already-gone' : 'killed' })
      else killFailed.push({ label, survivors: r.survivors || [] })
    } catch (e) {
      // A handle this backend never minted is not "a session that has ended" — it is a session this
      // teardown cannot speak for, and saying so is the difference between a clean machine and one
      // that only reports being clean.
      killFailed.push({ label, error: e && e.message ? e.message : String(e) })
    }
  }
  const proof = survivingSessions(registry.map(d => d.label), { stateDir })
  for (const s of proof.survivors) {
    if (!killFailed.some(f => f.label === s.label)) killFailed.push({ label: s.label, survivors: [s.pid] })
  }
  if (proof.degraded) ctx.log('fleet down: the process snapshot came back empty, so the kill could not be proven — a failed listing is never proof that nothing is running')
  for (const s of proof.foreign) ctx.log(`fleet down: pid ${s.pid} carries --fleet-session=${s.label} for a different state directory, so it is another fleet's session and this teardown left it alone`)

  // ---- the supervisor, before the worktrees go ---------------------------------------------------
  // Stopped here rather than at the end: a pass that lands mid-teardown reclaims worktrees, restarts
  // slots and re-starts the services this command is taking down.
  const supervisor = await stopSupervisor({ stateDir, nowMs: ctx.now(), log: ctx.log })

  // ---- remove the worktrees, then verify against `git worktree list` -----------------------------
  const removed = []
  const stuck = []
  for (const w of targets.worktrees) {
    if (killFailed.some(f => { const wt = worktreeOf.get(f.label); return wt !== null && wt !== undefined && samePath(wt, w.path) })) {
      // A live agent is still in there: removing the tree under it is how a session's index gets
      // corrupted and its unpushed work goes with it.
      stuck.push({ path: w.path, reason: 'a session process is still alive in this worktree' })
      continue
    }
    let r
    try {
      r = removeWorktree({ repo: primary, path: w.path, force: true })
    } catch (e) {
      stuck.push({ path: w.path, reason: e && e.message ? e.message : String(e) })
      continue
    }
    if (r.deregistered && r.dirExists) {
      // Deregistered but not deleted: the ordinary case where a shell holds a cwd inside. Sweep the
      // folder, then check again — an EMPTY leftover directory is cosmetic (it holds no disk and the
      // next `git worktree add` reuses it), a full one is not.
      const swept = sweepFolder(w.path)
      if (swept.remains && !swept.empty) stuck.push({ path: w.path, reason: `deregistered, but the folder could not be deleted: ${swept.error || 'still holds files'}` })
      else removed.push({ path: w.path, folderRemains: swept.remains })
      continue
    }
    if (!r.ok) {
      stuck.push({ path: w.path, reason: r.message || `git worktree remove exited ${r.code}` })
      continue
    }
    removed.push({ path: w.path, folderRemains: false })
  }

  // The verification, taken AFTER everything: the exit codes above are not evidence.
  const after = listWorktrees(primary)
  const stillRegistered = targets.worktrees.filter(w => findWorktree(after, w.path)).map(w => w.path)
  for (const p of stillRegistered) {
    if (!stuck.some(s => samePath(s.path, p))) stuck.push({ path: p, reason: 'still registered as a worktree after the removal reported success' })
  }

  // ---- leftovers, flags, locks, registry ---------------------------------------------------------
  const sweptLeftovers = []
  for (const l of targets.leftovers) {
    const swept = sweepFolder(l.path)
    sweptLeftovers.push({ path: l.path, remains: swept.remains, empty: swept.empty, error: swept.error })
  }

  const layout = stateLayout(stateDir, process.platform)
  const cleared = { flags: rmTree(layout.flags), locks: rmTree(layout.locks), descriptors: [] }
  for (const d of registry) {
    // The descriptor goes only once its worktree really is gone: a registry entry is the only record
    // of where a stranded tree lives, and deleting it strands gigabytes nothing knows about. A
    // descriptor that names no worktree strands nothing, so it goes.
    const wt = worktreeOf.get(String(d.label))
    const gone = !wt || !stuck.some(s => samePath(s.path, wt))
    if (gone && removeSession(String(d.label), { stateDir })) cleared.descriptors.push(String(d.label))
  }

  // The dedicated terminal server last, when the backend has one: the sessions are killed first
  // because a server exit SIGHUPs every pane and reparents the grandchildren it does not take.
  //
  // ⛔ And only once every session really is gone. Stopping the server out from under a session that
  // survived its own kill is that same uncontrolled hangup, applied to the one agent still working.
  let server = null
  if (killFailed.length === 0 && typeof ctx.backend.killServer === 'function') {
    try {
      server = ctx.backend.killServer()
    } catch (e) {
      server = { ok: false, reason: e && e.message ? e.message : String(e) }
    }
  }

  const ok = killFailed.length === 0 && stuck.length === 0 && supervisor.survivors.length === 0
  ctx.json(ok
    ? envelope(true, { dryRun: false, primary, killed, removed, leftovers: sweptLeftovers, cleared, server, supervisor, dirtyWorktrees: dirty.map(w => w.path) })
    : envelope(false, {
      dryRun: false,
      primary,
      killed,
      killFailed,
      removed,
      stuck,
      leftovers: sweptLeftovers,
      cleared,
      server,
      supervisor,
      dirtyWorktrees: dirty.map(w => w.path),
      error: {
        code: 'down.incomplete',
        message: `${killFailed.length} session(s) survived the kill and ${stuck.length} worktree(s) could not be removed`
          + (supervisor.survivors.length ? `, and the supervisor (pid ${supervisor.survivors.join(', ')}) is still running, which restarts the services on its next pass` : ''),
        hint: 'kill the holders by hand (they are named above), then run `fleet down` again — the teardown is idempotent',
      },
    }))
  ctx.log(`fleet down: killed ${killed.length}, removed ${removed.length} worktree(s), swept ${sweptLeftovers.length} leftover folder(s)`)
  for (const pid of supervisor.survivors) ctx.log(`  ⛔ the supervisor (pid ${pid}) survived: stop it by its single PID — never with a tree flag, its children are the container engine and the dev servers`)
  for (const f of killFailed) ctx.log(`  ⛔ session ${f.label} survived: ${f.error || `pids ${(f.survivors || []).join(', ')}`}`)
  for (const s of stuck) ctx.log(`  ⛔ ${s.path}: ${s.reason}`)
  return ok ? 0 : 1
}

/** Remove a state-dir subtree and say whether it was there. Flags and locks are per-run state only. */
function rmTree(dir) {
  const existed = fs.existsSync(dir)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return { dir, existed, remains: fs.existsSync(dir) }
}
