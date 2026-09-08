// Guardian: crash recovery for an unattended fleet. Token-free on purpose — it must keep working at
// the usage limit, which is exactly when everything else stops.
//
// Four jobs, each shaped by a real failure:
//
//   * snapshotWip()     writes each session worktree's uncommitted work to `<stateDir>/wip/<label>-<at>.patch`
//                       as ONE `git apply`-able patch: `git diff-index -p --binary HEAD` — plumbing,
//                       which never refreshes or writes the session's index, where porcelain
//                       `git diff HEAD` takes `index.lock` and rewrites stat data, a second writer in a
//                       tree that is one agent's — plus a creation hunk per untracked file (a list of
//                       names cannot bring a helper script back). ⛔ NEVER `git stash`, because
//                       `refs/stash` is one ref shared by every worktree of the repo, so one session's
//                       stash is visible and poppable by another;
//   * fleetManifest()   writes `<stateDir>/fleet-manifest.json` — label, role, issue, branch, worktree
//                       for every session — so a fleet can be rebuilt after a machine reset from a
//                       file, not from memory;
//   * quotaPark()       records parked=true when the stall watcher reports a usage limit (account-level;
//                       relaunching hits the same wall) and unparks on the account-switch signal,
//                       handing back to the stall watcher's fleet-wide nudge — sessions do NOT
//                       self-recover; after an unpark only evidence NEWER than the unpark parks again,
//                       because the stall watcher reports the limit as a level, not an edge;
//   * superviseHelper() restarts a helper loop that died — a reclaimer once died twice with an empty
//                       stderr, and unsupervised, worktrees silently stopped being freed. Presence is
//                       judged by the EXACT argv token through proc.findByCommand excluding self and
//                       its ancestors (a filter self-matches the shell running it), never by a pid
//                       file (pids are recycled); after a start the count is re-probed and must be
//                       EXACTLY one AND include the pid just spawned — a restart that "printed
//                       stopping" and left zero, a duplicate, or a spawn that died at once beside a
//                       straggler are all failures and all raise `notifications.command`;
//   * stopHelper()      stops a helper by the PID superviseHelper RECORDED at spawn (held by the caller
//                       between passes) — one pid, never a tree, never a command-line search — and
//                       re-queries to prove it gone.
//
// `wip/` and `fleet-manifest.json` are declared in contract §4. `wip/` is still taken from
// watchers/reclaim.mjs, the other writer of that directory, so the two cannot drift from each other.
// The helper marker `--fleet-helper=<name>@<fleet>`, beside `--fleet-session=<label>`, is this file's
// own and is not in the contract — it addresses a supervisor helper, never a session.
//
// Pure decisions (renderWip, fleetManifest, quotaPark, helperToken, findHelper's regex, wipDue) are
// exported on their own; the I/O halves take their git, snapshot, spawner and killer injected.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { git } from '../sys/exec.mjs'
import { findByCommand, protectedSet } from '../sys/proc.mjs'
import { escapeRegex } from '../config/derive.mjs'
import { readyFlagPath } from '../core/install.mjs'
import { wipDir, wipPatchPath } from './reclaim.mjs'

export { wipDir, wipPatchPath }

/** WIP snapshots every this many ms unless the caller says otherwise (no contract key exists yet). */
export const DEFAULT_WIP_INTERVAL_MS = 5 * 60_000

/** `<stateDir>/fleet-manifest.json` — not yet in contract §4's layout table (see the header). */
export function manifestPath(stateDir) {
  return path.join(stateDir, 'fleet-manifest.json')
}

// ---- atomic text writes ------------------------------------------------------------------------

let tmpCounter = 0

/**
 * Write text so a reader never sees half of it and a reboot never leaves a torn file: a temp file in
 * the SAME directory (rename is atomic only within one filesystem), its fd fsync'd BEFORE the rename
 * — a rename that reaches disk before its contents leaves a zero-length file, and every file written
 * through here (the WIP patch, the manifest, the autowave's queue) exists for exactly the reboot case
 * — then renamed over the target, then the directory flushed best-effort. The temp file is removed on
 * failure; nothing else ever sweeps `<file>.<pid>.<n>.tmp`.
 */
export function writeTextAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  // Windows cannot open a directory for fsync at all; a platform that refuses the flush is never a
  // reason to fail a write that has already landed.
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // EPERM/EISDIR/EACCES: nothing to do here.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
  return file
}

// ---- WIP patches -------------------------------------------------------------------------------

/** PURE. Is the next snapshot due? A never-run guardian is always due. */
export function wipDue({ lastAt, nowMs, everyMs = DEFAULT_WIP_INTERVAL_MS }) {
  return lastAt === null || lastAt === undefined || nowMs - lastAt >= everyMs
}

/** The digest that tells "the same work again" from "new work", so an idle worktree is not re-snapshotted forever. */
export function wipDigest({ body, untracked }) {
  return createHash('sha1').update(String(body)).update('\n--untracked--\n').update((untracked || []).join('\n')).digest('hex')
}

/**
 * PURE. The patch file's text: a `#` header (what `git apply` ignores) naming the session, its tree,
 * its branch, the untracked files and the digest, then `body` — the tracked diff plus one creation
 * hunk per untracked file, the same construction reclaim.saveWipPatch writes into this directory, so
 * one `git apply` restores the work. The header's untracked LIST is for the reader; the hunks are
 * what bring the files back — `git diff` cannot see untracked files at all, and a snapshot that
 * carried only their names would resume a session without the helper scripts it wrote.
 */
export function renderWip({ label, worktree, branch, at, body, untracked }) {
  const files = untracked || []
  const head = [
    '# claude-fleet wip snapshot: git diff-index -p --binary HEAD plus one creation hunk per untracked file',
    '# apply with: git apply <this file>   (never git stash — refs/stash is shared by every worktree)',
    `# label: ${label}`,
    `# worktree: ${worktree}`,
    `# branch: ${branch || '(detached)'}`,
    `# at: ${at}`,
    `# digest: ${wipDigest({ body, untracked: files })}`,
    `# untracked (${files.length}):`,
    ...files.map(f => `#   ${f}`),
    '',
  ]
  return head.join('\n') + String(body)
}

/** The digest line of an existing patch, read from its header only. */
function digestOf(file) {
  try {
    const m = /^# digest: ([0-9a-f]{40})$/m.exec(fs.readFileSync(file, 'utf8').slice(0, 4096))
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** The newest existing patch for `label`, anchored so label `1` never claims `10-…`. */
function latestWipFor(dir, label) {
  const re = new RegExp(`^${escapeRegex(String(label))}-\\d{4}-\\d{2}-\\d{2}T.*\\.patch$`)
  let names
  try {
    names = fs.readdirSync(dir).filter(n => re.test(n)).sort()
  } catch {
    return null
  }
  return names.length ? path.join(dir, names[names.length - 1]) : null
}

/** The ready sentinel as a pathspec relative to the worktree: the launcher's file, never the session's work (contract §3). */
function readyFlagRel(worktree, config) {
  return path.relative(worktree, readyFlagPath(worktree, config)).split(path.sep).join('/')
}

const gitFailure = (what, r) => new Error(`${what} failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim()}`)

/**
 * Snapshot every worktree that carries uncommitted work.
 *
 * READ-ONLY against the worktree, and that is checked by the test on the index's mtime: the diff is
 * `git diff-index -p --binary HEAD` — plumbing, which compares HEAD with the working tree (staged and
 * unstaged alike, no external diff driver, no colour, binary hunks kept so a changed image is not
 * silently dropped) and never refreshes or writes the index. ⛔ Not porcelain `git diff HEAD`: that
 * refreshes stat data and REWRITES `.git/index` under `index.lock`, and run every five minutes across
 * every worktree it is a second writer in a tree that is one agent's — the session's concurrent
 * `git add` fails with "index.lock: File exists". Untracked files come from `git ls-files --others
 * --exclude-standard`, minus `install.readyFlag` (the launcher's sentinel, present in every installed
 * tree — counted as work, no idle tree is ever `clean`), each rendered as a creation hunk.
 *
 * A clean tree gets no file. A tree whose git fails OR THROWS (a deleted worktree, a NUL-padded index
 * after a hard reset, ENOBUFS on a diff past exec.mjs's buffer, git missing from PATH) is reported in
 * `failed` and the pass goes on — one broken tree must not stop the other nineteen from being
 * protected. A label that is not a filename is a failure too, never `undefined-….patch`.
 *
 * @param {{worktrees: Array<{label, worktree, branch?}>, stateDir: string, config: object, nowMs?: number, git?: Function}} o
 * @returns {{written: Array<{label, file, untracked: number, bytes: number}>, unchanged: string[], clean: string[], failed: Array<{label, error}>}}
 */
/**
 * PURE. A filename-safe instant: an ISO timestamp with every `:` and `.` replaced.
 *
 * ⛔ Colons are illegal in Windows filenames, so a raw `toISOString()` in a patch name fails the
 * write on the platform this fleet most often runs on — and the failure surfaces as "the guardian
 * saved nothing", hours after the work it was meant to preserve was lost.
 */
export function stampOf(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-')
}

/** PURE. The WIP patch filename for one session at one instant. */
export function wipFileName(label, nowMs) {
  return `${label}-${stampOf(nowMs)}.patch`
}

export function snapshotWip({ worktrees, stateDir, config, nowMs = Date.now(), git: g = git }) {
  if (!config || !config.install) throw new Error('snapshotWip: a resolved config is required — install.readyFlag names the sentinel that is not the session\'s work')
  const dir = wipDir(stateDir)
  const at = new Date(nowMs).toISOString()
  const written = []
  const unchanged = []
  const clean = []
  const failed = []
  for (const w of worktrees || []) {
    const label = String(w && w.label)
    try {
      const file = wipPatchPath(stateDir, w.label, nowMs) // asserts the label is a plain filename
      const sentinel = readyFlagRel(w.worktree, config)
      const d = g(w.worktree, ['diff-index', '-p', '--binary', '--no-ext-diff', '--no-color', 'HEAD'])
      if (!d.ok) throw gitFailure('git diff-index', d)
      const u = g(w.worktree, ['ls-files', '--others', '--exclude-standard'])
      if (!u.ok) throw gitFailure('git ls-files', u)
      const untracked = u.stdout.split(/\r?\n/).map(s => s.trim()).filter(f => f && f !== sentinel)
      if (!d.stdout.trim() && !untracked.length) {
        clean.push(label)
        continue
      }
      let body = d.stdout
      for (const rel of untracked) {
        const n = g(w.worktree, ['diff', '--no-index', '--no-ext-diff', '--no-color', '--binary', '--', '/dev/null', rel])
        // `diff --no-index` exits 1 when the two sides differ, which a new file always does.
        if (n.code !== 0 && n.code !== 1) throw gitFailure(`git diff --no-index for ${rel}`, n)
        body += n.stdout
      }
      const digest = wipDigest({ body, untracked })
      const previous = latestWipFor(dir, label)
      if (previous && digestOf(previous) === digest) {
        unchanged.push(label)
        continue
      }
      const text = renderWip({ label, worktree: w.worktree, branch: w.branch, at, body, untracked })
      writeTextAtomic(file, text)
      written.push({ label, file, untracked: untracked.length, bytes: Buffer.byteLength(text) })
    } catch (e) {
      failed.push({ label, error: e && e.message ? e.message : String(e) })
    }
  }
  return { written, unchanged, clean, failed }
}

// ---- the manifest ------------------------------------------------------------------------------

/**
 * PURE. Everything needed to rebuild the fleet after a machine reset, from the registry
 * (core/fleet.listSessions) and the config. Every session, dead ones included — a dead descriptor
 * still names a worktree with work in it.
 */
export function fleetManifest({ registry, config, nowMs = Date.now() }) {
  return {
    v: 1,
    at: new Date(nowMs).toISOString(),
    repo: {
      name: config.repo.name ?? null,
      remote: config.repo.remote ?? null,
      baseBranch: config.repo.baseBranch ?? null,
      worktreeParent: config.repo.worktreeParent ?? null,
    },
    sessions: (registry || []).map(d => ({
      label: String(d.label),
      role: d.role ?? null,
      issue: d.issue ?? null,
      branch: d.branch ?? null,
      worktree: d.worktree ?? null,
      ticketFile: d.ticketFile ?? null,
      slot: d.slot ?? null,
      port: d.port ?? null,
      sweepDir: d.sweepDir ?? null,
      slice: d.slice ?? null,
      liveness: d.liveness ?? null,
    })),
  }
}

/**
 * Write the manifest through writeTextAtomic. The fsync there is the point of this file — it exists
 * for the reboot case, and a rename that reached disk before its contents leaves a zero-length
 * manifest behind, which is no manifest at all.
 */
export function writeFleetManifest({ registry, config, stateDir, nowMs = Date.now() }) {
  const file = manifestPath(stateDir)
  const manifest = fleetManifest({ registry, config, nowMs })
  writeTextAtomic(file, JSON.stringify(manifest, null, 2) + '\n')
  return { file, manifest }
}

/** The manifest on disk, or null when absent or unreadable — a torn file is "no manifest", not a crash. */
export function readFleetManifest(stateDir) {
  let j
  try {
    j = JSON.parse(fs.readFileSync(manifestPath(stateDir), 'utf8'))
  } catch {
    return null
  }
  return j && typeof j === 'object' && Array.isArray(j.sessions) ? j : null
}

// ---- quota parking -----------------------------------------------------------------------------

export function initialParkState() {
  return { parked: false, parkedAt: null, reason: null, unparkedAt: null }
}

/**
 * The stall watcher's verdict, in either spelling: `{kind: 'usage-limit' | 'account-switch'}` or the
 * booleans `{usageLimit, accountSwitched}`, with an optional `text` (the limit message) and an
 * optional `mtimeMs` — when the evidence was WRITTEN: the newest transcript mtime among the parked
 * sessions (stalls.nudgePlan's `park` items each carry `mtimeMs`).
 */
function normalizeStatus(status) {
  const s = status && typeof status === 'object' ? status : {}
  const kind = typeof s.kind === 'string' ? s.kind : ''
  return {
    usageLimit: s.usageLimit === true || kind === 'usage-limit',
    accountSwitched: s.accountSwitched === true || kind === 'account-switch',
    text: typeof s.text === 'string' ? s.text : null,
    mtimeMs: Number.isFinite(s.mtimeMs) ? Number(s.mtimeMs) : null,
  }
}

/**
 * PURE. Park on a usage limit, unpark on an account switch.
 *
 * ⛔ A usage limit is account-level and nothing bypasses it: relaunching hits the same wall in a
 * fresh process, and it stops the whole fleet, not one session. So the fleet PARKS — recorded, with
 * the time — and a repeated limit report while parked changes nothing (the alarm keyed on the error
 * text plus idle minutes once re-fired on every poll; the FIRST parkedAt is kept).
 *
 * ⛔ An account switch does not resume a parked fleet on its own: a session whose turn closed on the
 * limit has nothing left to wake it. So the unpark returns `nudge: true` — the hand-back to the stall
 * watcher's fleet-wide nudge, which is the only thing that resumes them. When the fleet was not
 * parked, an account switch is not the guardian's event and no nudge is requested from here.
 *
 * ⛔ After an unpark, the SAME report does not park again. The stall watcher reports the limit as a
 * LEVEL: every session whose last transcript entry is still the limit error is in `park` on every
 * tick, and a nudged session whose dead turn never consumed the nudge (the case that needs `fleet
 * relaunch`) keeps that level high for as long as it sits there. Re-parking on it would overwrite
 * parkedAt every cycle and leave a fleet that no later account switch could ever unpark. So once
 * `unparkedAt` is set, a limit report parks only when its evidence (`mtimeMs`) is NEWER than the
 * unpark — a report that carries no timestamp after an unpark is the old level, not new evidence.
 * @returns {{state: object, event: 'parked'|'unparked'|null, nudge: boolean}}
 */
export function quotaPark(status, { state = initialParkState(), nowMs = Date.now() } = {}) {
  const s = normalizeStatus(status)
  const at = new Date(nowMs).toISOString()
  if (s.accountSwitched && state.parked) {
    return { state: { ...state, parked: false, unparkedAt: at }, event: 'unparked', nudge: true }
  }
  if (s.usageLimit && !state.parked) {
    const unparkedMs = Date.parse(state.unparkedAt ?? '')
    const stale = Number.isFinite(unparkedMs) && !(s.mtimeMs !== null && s.mtimeMs > unparkedMs)
    if (stale) return { state, event: null, nudge: false }
    return { state: { parked: true, parkedAt: at, reason: s.text, unparkedAt: null }, event: 'parked', nudge: false }
  }
  return { state, event: null, nudge: false }
}

// ---- helper supervision ------------------------------------------------------------------------

/** The helper marker's prefix (not in contract §4 yet — see the header; `--fleet-session=` is the model). */
export const HELPER_MARKER = '--fleet-helper='

/**
 * PURE. The exact argv token a helper carries: `--fleet-helper=<name>@<fleet>`, where `<fleet>` is
 * the state directory's basename — contract §3's `<repoSlug>` under `paths.stateDir`, which is per
 * repo, per machine. ⛔ Scoped, because a bare `--fleet-helper=reclaim` is the same token in every
 * fleet: two repos each running `fleet watch` on one machine would make each guardian count the
 * other's reclaimer, report `duplicate` forever and never restart a dead one of its own. The caller
 * puts this token on the helper's command line at spawn and hands the same string to superviseHelper.
 */
export function helperToken(name, stateDir) {
  const n = String(name || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) throw new Error(`helperToken: the helper name must be a plain word ([A-Za-z0-9._-]), got ${JSON.stringify(name)}`)
  const fleet = path.basename(String(stateDir || '')).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!fleet) throw new Error('helperToken: stateDir is required — the token is scoped per fleet so two repos\' guardians on one machine never count each other\'s helpers')
  return `${HELPER_MARKER}${n}@${fleet}`
}

/**
 * PURE. A RegExp that matches `argvToken` as a WHOLE argv token: preceded by the start of the line or
 * whitespace, optionally quoted, followed by whitespace or the end. `--fleet-helper=reclaim@app`
 * therefore never claims `--fleet-helper=reclaim@app-2` or `…=reclaimer@app`, and no path substring
 * is ever matched.
 */
export function helperTokenPattern(argvToken) {
  const t = String(argvToken || '')
  if (!t || /\s/.test(t)) throw new Error(`helperTokenPattern: the argv token must be one non-empty token without whitespace, got ${JSON.stringify(argvToken)}`)
  return new RegExp(`(?:^|\\s)["']?${escapeRegex(t)}["']?(?=\\s|$)`)
}

/**
 * PURE. Which processes in the snapshot are this helper?
 *
 * ⛔ An EMPTY snapshot is a failed snapshot, never "no helper": the cheap process listing returns
 * nothing on a loaded box, and starting a helper on that evidence is how a second reclaimer races the
 * first. `degraded: true` tells the caller to do nothing this pass.
 * @returns {{pids: number[], degraded: boolean}}
 */
export function findHelper({ snapshot, argvToken, selfPid = process.pid }) {
  if (!snapshot || snapshot.size === 0) return { pids: [], degraded: true }
  const found = findByCommand(snapshot, helperTokenPattern(argvToken), { selfPid })
  return { pids: found.map(p => p.pid).sort((a, b) => a - b), degraded: false }
}

/**
 * Keep exactly one instance of a helper loop alive.
 *
 * @param {object} o
 * @param {string} o.name          for logs and the notification ("reclaim", "stalls", …)
 * @param {string} o.argvToken     the exact token the helper's command line carries
 * @param {() => {pid?: number}} o.start   spawns the helper DETACHED with both streams redirected
 *                                 (sys/exec.spawnDetached with file stdio) — a helper that inherits a
 *                                 dying parent's console dies on its next write, which is the shape
 *                                 of the reclaimer's two silent deaths
 * @param {Map} o.snapshot         this pass's process snapshot (taken ONCE per pass, reused)
 * @param {() => Map} o.resnapshot a FRESH snapshot for the after-check. Required, and it must bypass
 *                                 sys/snapshot's cache (`invalidateSnapshot()` then `snapshot()`): the
 *                                 pass snapshot predates the start, so re-reading it can only ever
 *                                 count zero and every restart would be reported as a failure
 * @param {(event: string, message: string) => void} [o.notify]  raises `notifications.command`
 * @returns {{action: 'none'|'started'|'start-failed'|'duplicate'|'skipped', count: number, pids: number[], started: {pid, at}|null, ok: boolean, reason: string|null}}
 */
export function superviseHelper({ name, argvToken, start, snapshot, resnapshot, selfPid = process.pid, nowMs = Date.now(), notify = () => {}, log = () => {} }) {
  if (typeof start !== 'function') throw new Error(`superviseHelper(${name}): start is required`)
  if (typeof resnapshot !== 'function') throw new Error(`superviseHelper(${name}): resnapshot is required — without a fresh snapshot a restart can never be proven`)
  const before = findHelper({ snapshot, argvToken, selfPid })
  if (before.degraded) {
    const reason = 'the process snapshot is empty, which is a failed listing rather than an absent helper — nothing started this pass'
    log(`guardian: ${name}: ${reason}`)
    return { action: 'skipped', count: 0, pids: [], started: null, ok: false, reason }
  }
  if (before.pids.length === 1) return { action: 'none', count: 1, pids: before.pids, started: null, ok: true, reason: null }
  if (before.pids.length > 1) {
    // Reported and raised, never killed from here: the only safe stop is by a PID this guardian
    // itself recorded at spawn, and a duplicate it did not start is the operator's to resolve.
    const reason = `${before.pids.length} instances of ${name} are running (${before.pids.join(', ')}) — two supervisors race each other's repairs`
    notify('helper-duplicate', `guardian: ${reason}`)
    log(`guardian: ${reason}`)
    return { action: 'duplicate', count: before.pids.length, pids: before.pids, started: null, ok: false, reason }
  }

  // Zero: start it, then PROVE it — a restart that prints "stopping" and never comes back is
  // indistinguishable from a clean one without an after-check, and it happened twice in one hour.
  let spawned
  try {
    spawned = start() || {}
  } catch (e) {
    // Reported, not thrown: one helper whose spawn fails must not end the pass before the other
    // helpers are looked at — a guardian that dies on the first bad start is an unsupervised fleet.
    const reason = `${name} could not be started: ${e.message}`
    notify('helper-start-failed', `guardian: ${reason}`)
    log(`guardian: ${reason}`)
    return { action: 'start-failed', count: 0, pids: [], started: null, ok: false, reason }
  }
  const started = { pid: Number.isInteger(spawned.pid) ? spawned.pid : null, at: new Date(nowMs).toISOString() }
  const after = findHelper({ snapshot: resnapshot(), argvToken, selfPid })
  const count = after.degraded ? 0 : after.pids.length
  // "Exactly one" is not enough on its own: a spawn that died at once beside an unrelated instance
  // that appeared in between also counts one, and `started.pid` would point at a corpse. When the
  // spawner told us its pid, the one instance found must BE that pid.
  const ours = started.pid === null || after.pids.includes(started.pid)
  if (count === 1 && ours) {
    log(`guardian: ${name} was not running — started it (pid ${started.pid ?? 'unknown'})`)
    return { action: 'started', count: 1, pids: after.pids, started, ok: true, reason: null }
  }
  const reason = after.degraded
    ? `${name} was started but the after-check snapshot came back empty, so its count is unproven`
    : !ours
      ? `${name} was started as pid ${started.pid} but the after-check does not list that pid — the spawn died at once, and the ${count} instance(s) it counts (${after.pids.join(', ')}) are not ours`
      : `${name} was started but the after-check counts ${count} instance(s), not exactly one`
  notify('helper-restart-failed', `guardian: ${reason}`)
  log(`guardian: ${reason}`)
  return { action: 'started', count, pids: after.pids, started, ok: false, reason }
}

/** Default killer: one pid, one signal. `process.kill` terminates on Windows and SIGTERMs on POSIX. */
function defaultKill(pid) {
  process.kill(pid, 'SIGTERM')
}

/** A real (non-busy) pause, for the short grace between a signal and the proof it landed. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Stop a helper by the PID this guardian RECORDED when it started it (superviseHelper's
 * `started.pid`, which the caller keeps between passes — nothing here writes a pid file, because a
 * pid on disk outlives the process it named and pids are recycled).
 *
 * ⛔ One pid, never a tree, never a command-line search. A tree-kill aimed at a supervisor once took
 * its in-flight installer with it; a filter on the helper's own argv once matched the shell running
 * the stop and killed the tool mid-run. The recorded pid is re-checked against the pass snapshot
 * BEFORE the kill — a pid that no longer carries the helper's token is somebody else's process now —
 * and against a FRESH snapshot after it, because a kill's own return code proves nothing.
 *
 * @param {object} o
 * @param {string} o.name           for logs and the notification
 * @param {number|null} o.pid       the pid superviseHelper recorded at spawn
 * @param {string} o.argvToken      the exact token the helper's command line carries (helperToken)
 * @param {Map} o.snapshot          this pass's process snapshot
 * @param {() => Map} o.resnapshot  a FRESH snapshot for the after-check (bypassing sys/snapshot's cache)
 * @param {(pid: number) => void} [o.kill]  the single-pid killer (default process.kill SIGTERM)
 * @param {number} [o.graceMs]      how long to wait before the proof (default 2 s, like sys/kill.mjs)
 * @returns {{action: 'stopped'|'already-gone'|'refused'|'stop-failed', pid: number|null, ok: boolean, reason: string|null}}
 */
export function stopHelper({ name, pid, argvToken, snapshot, resnapshot, kill = defaultKill, graceMs = 2000, selfPid = process.pid, notify = () => {}, log = () => {} }) {
  if (typeof resnapshot !== 'function') throw new Error(`stopHelper(${name}): resnapshot is required — without a fresh snapshot a stop can never be proven`)
  const id = Number.isInteger(pid) && pid > 0 ? pid : null
  const refuse = reason => {
    log(`guardian: ${name}: ${reason}`)
    return { action: 'refused', pid: id, ok: false, reason }
  }
  if (id === null) return refuse(`no recorded pid to stop ${name} by — a stop is only ever by the pid recorded at spawn, never by a command-line search`)
  if (!snapshot || snapshot.size === 0) return refuse('the process snapshot is empty, which is a failed listing rather than an absent helper — nothing stopped this pass')
  const p = snapshot.get(id)
  if (!p) {
    log(`guardian: ${name}: pid ${id} is already gone`)
    return { action: 'already-gone', pid: id, ok: true, reason: null }
  }
  const re = helperTokenPattern(argvToken)
  if (!re.test(p.cmd || '')) return refuse(`pid ${id} no longer carries ${argvToken} (${String(p.cmd || '').slice(0, 80)}) — the pid was recycled, and another process is not ours to kill`)
  if (protectedSet(snapshot, selfPid).has(id)) return refuse(`pid ${id} is this process or one of its ancestors — never killed from here`)

  const failed = reason => {
    notify('helper-stop-failed', `guardian: ${reason}`)
    log(`guardian: ${reason}`)
    return { action: 'stop-failed', pid: id, ok: false, reason }
  }
  try {
    kill(id)
  } catch (e) {
    if (e.code !== 'ESRCH') return failed(`${name} (pid ${id}) could not be signalled: ${e.message}`)
  }
  if (graceMs > 0) pause(graceMs)
  const after = resnapshot()
  if (!after || after.size === 0) return failed(`${name} (pid ${id}) was signalled but the after-check snapshot came back empty, so the stop is unproven`)
  const still = after.get(id)
  if (still && re.test(still.cmd || '')) return failed(`${name} (pid ${id}) is still running after the stop`)
  log(`guardian: ${name}: stopped pid ${id} and re-queried — gone`)
  return { action: 'stopped', pid: id, ok: true, reason: null }
}
