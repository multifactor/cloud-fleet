// The fleet registry: one descriptor per session at `<stateDir>/sessions/<label>.json` (contract §4),
// plus the reconciler that rebuilds it from a process snapshot after a crash or a reboot.
//
// Identity comes from the REGISTRY. `list`, `send` and `kill` all resolve a label through its
// descriptor, never by searching process command lines: on a terminal with no query API every
// operation once compensated by grepping for a worktree path, and the greps disagreed — one reported
// a session that had died an hour earlier, another could not find a session whose window was open,
// and a kill landed on the wrong tab.
//
// ⛔ reconcile() is the ONE place command-line matching is allowed, and it matches the exact argv
// token `--fleet-session=<label>` through sessionLabelOf() — never a substring, or session 7 claims
// session 70's process.
//
// Split like everything else here: reconcilePlan() decides from injected data (descriptors + a
// snapshot) and reconcile() is the thin half that reads the directory and applies the plan.

import fs from 'node:fs'
import path from 'node:path'

import { sessionLabelOf } from '../sys/proc.mjs'
import { stateLayout } from '../config/paths.mjs'
import { defaultsFor } from '../config/defaults.mjs'
import { templatePattern } from './worktree.mjs'

const ROLES = ['working', 'testing', 'checker']

// A label is a FILENAME. `sessions/<label>.json` is a path join over a value that reaches us from a
// CLI flag, so anything that could climb out of the state directory is refused here rather than
// discovered later as a file written somewhere else entirely.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// The folder template default comes from the schema so it cannot drift from repo.sessionDirTemplate.
const SESSION_DIR_TEMPLATE = defaultsFor().repo.sessionDirTemplate

// How long a session is too young to be called dead: the launcher writes the descriptor, THEN spawns
// the shim, and the snapshot that will see it may already have been taken. Generous on purpose — the
// cost of waiting is one more pass, the cost of being wrong is a reclaimed worktree.
const BIRTH_GRACE_MS = 10_000

function assertLabel(label) {
  // Not String(label): `String(undefined)` is "undefined", a perfectly good filename, so a
  // descriptor that lost its label would be written to `undefined.json` and every lookup after it
  // would miss a session that is running.
  const s = typeof label === 'number' ? String(label) : label
  if (typeof s !== 'string' || !LABEL_RE.test(s)) {
    throw new Error(`invalid session label ${JSON.stringify(label)}: a label is a filename ([A-Za-z0-9._-], not starting with "."), never a path`)
  }
  return s
}

/** Numeric labels first and in numeric order: 10 sorting before 2 makes an operator read the wrong line. */
function compareLabels(a, b) {
  const na = /^\d+$/.test(a) ? Number(a) : null
  const nb = /^\d+$/.test(b) ? Number(b) : null
  if (na !== null && nb !== null) return na - nb
  if (na !== null) return -1
  if (nb !== null) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** `<stateDir>/sessions` — the layout itself lives in config/paths.mjs. */
export function sessionsDir(stateDir) {
  return stateLayout(stateDir, process.platform).sessions
}

/** `<stateDir>/sessions/<label>.json`. Throws on a label that is not a plain filename. */
export function sessionPath(stateDir, label) {
  return path.join(sessionsDir(stateDir), `${assertLabel(label)}.json`)
}

let tmpCounter = 0

/**
 * Write a JSON file so a reader never sees a half-written one: a temp file IN THE SAME DIRECTORY,
 * flushed, then renamed over the target, then the DIRECTORY flushed too. Same directory because
 * rename is atomic only within one filesystem — a temp file on another volume turns the rename into
 * a copy, which is the non-atomic write we are avoiding. The flushes matter for the reboot case: a
 * rename that reaches disk before the contents leaves a zero-length descriptor behind, and a
 * directory entry that never reaches disk leaves no descriptor at all — either way a live session
 * that `fleet kill` can no longer address, and whose worktree the reclaimer takes out from under it.
 *
 * A failure removes the temp file: nothing else in the plugin ever does, so a leaked
 * `.<label>.json.<pid>.<n>.tmp` sits in `sessions/` forever and every listing pass pays for it.
 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpCounter++}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fsyncDir(dir)
  return file
}

/**
 * Flush the directory entry the rename just created. Best effort by design: Windows cannot open a
 * directory for fsync at all, and a platform that refuses the flush is never a reason to fail a write
 * that has already landed.
 */
function fsyncDir(dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // EPERM/EISDIR/EACCES on Windows and some network filesystems: nothing to do here.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * Write (or replace) a session descriptor. Fields: contract §4.
 * @returns {string} the descriptor path
 */
export function writeSession(descriptor, { stateDir }) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('writeSession: a descriptor object is required')
  const label = assertLabel(descriptor.label)
  // The role decides which FLEET_* scalars the session is given, so a typo'd role produces a testing
  // session with no FLEET_PORT — which fails much later, inside its dev-server command.
  if (!ROLES.includes(descriptor.role)) throw new Error(`writeSession: unknown role ${JSON.stringify(descriptor.role)} (${ROLES.join(' | ')})`)
  return writeJsonAtomic(sessionPath(stateDir, label), descriptor)
}

/**
 * Read one descriptor. Returns null when it is absent OR unreadable: one damaged file must not blind
 * `fleet status` to the other eleven sessions, and nothing is lost silently — a session whose
 * descriptor cannot be read still carries its argv marker, so reconcile() reports it as an orphan.
 */
export function readSession(label, { stateDir }) {
  // Resolved BEFORE the try: an invalid label is a programmer error and must still throw, while
  // every failure of the read itself is answered with null.
  const id = assertLabel(label)
  const file = sessionPath(stateDir, id)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // Absent, a directory in the way, locked by another process, EACCES: all of them are "unreadable",
    // and only ENOENT being caught here let one bad entry throw out of listSessions and blind
    // `fleet status`, `reconcile` and `takenLabels` to the whole fleet.
    return null
  }
  try {
    const d = JSON.parse(text)
    // The FILENAME is the identity. `3.json` carrying {"label":"7"} would make reconcile write
    // `7.json` and leave `3.json` untouched forever — one session forked into two, and the stale file
    // rewritten on every poll because it never stops looking changed.
    return d && typeof d === 'object' && String(d.label) === id ? d : null
  } catch {
    return null
  }
}

/** Every readable descriptor, ordered for display. */
export function listSessions({ stateDir }) {
  let names
  try {
    names = fs.readdirSync(sessionsDir(stateDir))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const name of names) {
    // Only `<label>.json`: an interrupted write leaves `.<label>.json.<pid>.<n>.tmp` behind, and a
    // listing that parsed everything in the directory would resurrect a half-written descriptor.
    if (!name.endsWith('.json')) continue
    const label = name.slice(0, -'.json'.length)
    if (!LABEL_RE.test(label)) continue
    const d = readSession(label, { stateDir })
    if (d) out.push(d)
  }
  return out.sort((a, b) => compareLabels(String(a.label), String(b.label)))
}

/**
 * Delete one descriptor. Returns false when there was nothing to delete — never `force`, because a
 * teardown that removed nothing must not be able to report success (removal exit codes lie here: the
 * same lesson as a worktree remove that deregisters and then fails to unlink).
 */
export function removeSession(label, { stateDir }) {
  try {
    fs.unlinkSync(sessionPath(stateDir, label))
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

/**
 * PURE. Compare the registry against a process snapshot.
 *
 * A descriptor is alive iff some process in the snapshot carries the exact argv token
 * `--fleet-session=<label>`. The recorded shimPid is NOT evidence on its own: pids are recycled, so
 * "pid 4242 exists" proves nothing about the session that once owned it — the marker is the proof,
 * and the pids carrying it are what the caller should record.
 *
 * ⛔ A snapshot is a PAST reading, never "now": sys/snapshot.mjs caches it for `maxAgeMs` and the
 * Windows scan alone costs ~450 ms, while the launcher writes a descriptor BEFORE its shim exists. A
 * session younger than the snapshot is therefore absent from it for an innocent reason, so it is held
 * in `pending` rather than judged — the consumer of `dead` is the reclaimer, and a session marked dead
 * on its first breath has its worktree deleted under a live agent.
 *
 * @param {Array<object>} descriptors  from listSessions()
 * @param {Map<number, object>} snapshot  from sys/snapshot.mjs
 * @param {{nowMs?: number, snapshotTakenMs?: number|null, graceMs?: number}} [opts]
 *        `snapshotTakenMs` is when the snapshot was CAPTURED — pass it whenever the caller knows it,
 *        so the comparison is against the reading and not against now.
 * @returns {{alive: Array, dead: Array, pending: Array, orphans: Array, degraded: boolean}}
 */
export function reconcilePlan(descriptors, snapshot, { nowMs = Date.now(), snapshotTakenMs = null, graceMs = BIRTH_GRACE_MS } = {}) {
  // ⛔ An empty snapshot is a FAILED snapshot, never an empty fleet: the cheap process listing
  // degrades to empty output on a loaded box, and an honest snapshot always contains at least the
  // process that took it. Acting on it would mark every live session dead in one pass.
  if (!snapshot || snapshot.size === 0) return { alive: [], dead: [], pending: [], orphans: [], degraded: true }

  const running = new Map()
  for (const p of snapshot.values()) {
    const label = sessionLabelOf(p.cmd)
    if (label === null) continue
    if (!running.has(label)) running.set(label, [])
    running.get(label).push(Number(p.pid))
  }

  const alive = []
  const dead = []
  const pending = []
  // Only a session born before this is old enough for the snapshot to be evidence about it.
  const judgeableIfOlderThan = (snapshotTakenMs === null ? nowMs : snapshotTakenMs) - graceMs
  const claimed = new Set()
  for (const d of descriptors) {
    const label = String(d.label)
    claimed.add(label)
    const pids = (running.get(label) || []).slice().sort((a, b) => a - b)
    if (!pids.length) {
      // A descriptor with no createdAt carries no evidence of youth and is judged normally.
      const createdMs = Date.parse(d.createdAt ?? '')
      if (Number.isFinite(createdMs) && createdMs > judgeableIfOlderThan) {
        pending.push({ label, descriptor: d, reason: 'too-new' })
        continue
      }
      dead.push({ label, descriptor: d, reason: 'no-process' })
      continue
    }
    // More than one marked process for one label means two shims answer to the same name — a
    // duplicate launch the caller must see, so every pid is reported rather than just the first.
    const known = d.shimPid !== null && d.shimPid !== undefined && pids.includes(Number(d.shimPid))
    alive.push({ label, descriptor: d, pids, shimPid: known ? Number(d.shimPid) : pids[0], pidChanged: !known })
  }

  const orphans = [...running.entries()]
    .filter(([label]) => !claimed.has(label))
    .map(([label, pids]) => ({ label, pids: pids.slice().sort((a, b) => a - b) }))
    .sort((a, b) => compareLabels(a.label, b.label))

  return { alive, dead, pending, orphans, degraded: false }
}

/**
 * Apply reconcilePlan() to the registry on disk: refresh a shim pid that moved (a relaunch spawns a
 * new agent into the same worktree), mark a descriptor whose process is gone, and REPORT — never act
 * on — a marked process that has no descriptor.
 *
 * A dead descriptor is marked, not deleted: its `worktree` field is what the reclaimer needs, and
 * deleting it strands a multi-gigabyte tree that nothing knows about. An orphan is likewise only
 * reported: adopting or killing it is the launcher's decision, taken against the operator's own
 * hand-started agents, which are indistinguishable from here.
 *
 * ⛔ Every write MERGES onto a fresh read and one bad descriptor never ends the pass:
 *   - the shim read-modify-writes these same files (shimPid, agentPid, the exit record) with no lock
 *     between us, so a full replacement built from the listing at the top of this pass would silently
 *     drop whatever it recorded in between — including the exit record;
 *   - a descriptor that parses but that `writeSession` refuses (a role lost to an interrupted merge)
 *     is reported in `failed` and skipped, because throwing here abandons every session after it,
 *     halfway through the pass.
 *
 * @returns {{alive, dead, pending, orphans, degraded, updated: string[], marked: string[],
 *            failed: Array<{label: string, error: string}>}}
 */
export function reconcile(snapshot, { stateDir, nowMs = Date.now(), snapshotTakenMs = null, graceMs } = {}) {
  const plan = reconcilePlan(listSessions({ stateDir }), snapshot, { nowMs, snapshotTakenMs, graceMs })
  if (plan.degraded) return { ...plan, updated: [], marked: [], failed: [] }

  const at = new Date(nowMs).toISOString()
  const updated = []
  const marked = []
  const failed = []

  const applyTo = (label, fields, { drop = [], skipWhen = null } = {}) => {
    const fresh = readSession(label, { stateDir })
    // Gone (a teardown ran under us) or no longer readable: there is nothing to merge onto, and
    // writing the copy we are holding would resurrect a session that was deliberately removed.
    if (!fresh) return false
    if (skipWhen && skipWhen(fresh)) return false
    const next = { ...fresh, ...fields }
    for (const k of drop) delete next[k]
    try {
      writeSession(next, { stateDir })
      return true
    } catch (e) {
      failed.push({ label, error: e.message })
      return false
    }
  }

  for (const a of plan.alive) {
    const d = a.descriptor
    if (!a.pidChanged && d.liveness !== 'dead') continue // nothing changed: do not rewrite 12 files per poll
    if (applyTo(a.label, { shimPid: a.shimPid, liveness: 'alive', reconciledAt: at }, { drop: ['deadAt'] })) updated.push(a.label)
  }
  for (const x of plan.dead) {
    if (x.descriptor.liveness === 'dead') continue // keep the FIRST observed death time…
    // …including a death some other pass recorded between our listing and this write.
    const stillNew = { skipWhen: f => f.liveness === 'dead' }
    if (applyTo(x.label, { liveness: 'dead', deadAt: at, reconciledAt: at }, stillNew)) marked.push(x.label)
  }

  return { ...plan, updated, marked, failed }
}

/**
 * PURE. The next working-session number: the first free one, given everything already taken.
 * Entries may be labels (`"3"`, `3`) or descriptors (`{label}`); a named label such as a testing
 * slot occupies no number and is ignored.
 */
export function nextLabel(existing = []) {
  const taken = new Set()
  for (const e of existing) {
    const raw = e && typeof e === 'object' ? e.label : e
    if (raw === null || raw === undefined) continue
    const s = String(raw).trim()
    if (!/^\d+$/.test(s)) continue
    taken.add(Number(s))
  }
  let n = 1
  while (taken.has(n)) n++
  return String(n)
}

/**
 * PURE. The session number a worktree FOLDER name carries, or null.
 *
 * The pattern is built from repo.sessionDirTemplate and ANCHORED to the whole basename, because
 * `<repo>-session-1` is a prefix of `<repo>-session-10` and an unanchored match numbers ten sessions
 * into one folder.
 */
export function folderLabel(name, { repoName = '', template = SESSION_DIR_TEMPLATE } = {}) {
  const base = String(name).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  // The compiled template is the boundary rule, and there is exactly ONE compiler for it:
  // worktree.templatePattern. This function used to carry its own, which understood only {repo} and
  // {n} — so it silently numbered nothing for repo.slotDirTemplate ({repo}-{branch}) or
  // repo.checkerDirTemplate ({repo}-check-{slice}), and two matchers that disagree about which
  // folders are taken is how an allocator hands out an occupied number.
  let re
  try {
    re = templatePattern(template, { repo: repoName })
  } catch {
    return null // a template that cannot compile numbers nothing; validate.mjs reports the config error
  }
  const m = re.exec(base)
  return m?.groups?.n ?? null // no {n} in the template ⇒ no group ⇒ this template numbers nothing
}

/**
 * Does this directory entry still hold a worktree's name?
 *
 * ⛔ Not `dirent.isDirectory()`. A Windows junction or a symlink is a symlink, not a directory, and a
 * filesystem that answers readdir with DT_UNKNOWN (XFS, several FUSE/overlay/network mounts) makes
 * EVERY isX() false — so testing for a directory counts no leftover at all there, and numbering hands
 * the folder out again. Only a PLAIN FILE is ruled out cheaply; anything else is asked about, and an
 * entry we cannot stat (a dangling junction) still owns its name.
 */
function ownsTheName(parent, e) {
  if (e.isDirectory()) return true
  if (e.isFile()) return false
  try {
    const st = fs.statSync(path.join(parent, e.name), { throwIfNoEntry: false })
    return st ? st.isDirectory() : true
  } catch {
    return true
  }
}

/**
 * Everything a new session may NOT be numbered as: live descriptors, every leftover folder on disk,
 * and whatever the caller adds (a `git worktree list` reading).
 *
 * ⛔ Folders count. `git worktree remove --force` routinely deregisters a worktree and then fails to
 * delete its directory, so numbering from the registry alone hands out a number whose folder already
 * exists — and the new session inherits that folder's half-installed contents.
 */
export function takenLabels({ stateDir = null, worktreeParent = null, repoName = '', template = SESSION_DIR_TEMPLATE, extra = [] } = {}) {
  const out = new Set()
  if (stateDir) for (const d of listSessions({ stateDir })) out.add(String(d.label))
  if (worktreeParent) {
    let entries = []
    try {
      entries = fs.readdirSync(worktreeParent, { withFileTypes: true })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const e of entries) {
      const label = folderLabel(e.name, { repoName, template })
      if (label === null) continue
      if (!ownsTheName(worktreeParent, e)) continue
      out.add(label)
    }
  }
  for (const e of extra) if (e !== null && e !== undefined) out.add(String(e))
  return [...out].sort(compareLabels)
}
