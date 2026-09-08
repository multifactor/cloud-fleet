// Reclaiming finished sessions: the token-free loop that frees a worktree the moment its session
// says it is done, and the fallback that recovers one whose session crashed before saying so.
//
// A session announces itself by writing `<stateDir>/flags/done-<label>.json` (contract §5) as its
// LAST action. The flag authorises immediate teardown with no waiting period — but four things are
// re-verified first, and every one of them is a run that went wrong:
//
//   1. the worktree is DETACHED (`git symbolic-ref` fails) and CLEAN (`git status --porcelain` is
//      empty) — a session that wrote its flag over uncommitted work is not done, whatever it says;
//   2. the outcome is one of contract §5's, and for `pr-pushed` the session's branch is on the
//      remote (`git ls-remote --heads`, run from the PRIMARY checkout) — the ledger of record is the
//      remote, not the flag, and a flag once said "pushed" for a push that had failed;
//   3. an `amended` prescription is on its way to where it is read — `bodyPatched` is true, or an
//      op-15 body patch for that key is queued in the outbox — or the reclaim REFUSES: once the
//      worktree is gone there is nobody left to ask for the correction;
//   4. no SECOND process is live in that worktree (registry + snapshot) — a relaunch that spawned
//      beside a wedged agent left two in one tree, and reclaiming one deletes the tree under the other.
//
// Then, in this order: kill through the backend and VERIFY zero survivors; remove the worktree and
// VERIFY with `git worktree list`; sweep the leftover folder (git routinely deregisters and then fails
// to delete); remove the registry entry; delete the flag LAST; forget the label so a reused number
// can flag again. A `cancelled`, `duplicate` or `no-code-change` flag over local changes saves a patch
// to `<stateDir>/wip/<label>-<at>.patch` first and proceeds — that once preserved an hour of abandoned
// work, and the alternative (refusing) was a gate no finished session could ever satisfy, so the
// reclaimer, not the session, was the thing that sat stuck.
//
// The fallback for a session that crashed before flagging infers "finished" from git alone: detached,
// clean, and a reflog move from a session branch back to the base — the move the close-out itself
// performs — or never branched at all, fully installed, dead and long idle. It NEVER fires on a tree
// that is still installing (no ready flag, an empty shim directory): a fresh worktree is detached,
// clean and branch-less until its install finishes, which under wave pacing is most of an hour. And
// it never consults a PR lookup: a finished session may legitimately have no PR, and a PR list
// filtered on an empty branch name returns every PR there is.
//
// Split like the rest of the plugin: reclaimPlan(), inferFinished(), parseReflog(), strike() and
// secondProcesses() are PURE over injected data; observeWorktree(), saveWipPatch() and reclaimOnce()
// are the thin halves with git, the snapshot, the backend and the filesystem injected.

import fs from 'node:fs'
import path from 'node:path'

import { git as gitExec } from '../sys/exec.mjs'
import { inDirectory, descendants, protectedSet, sessionLabelOf } from '../sys/proc.mjs'
import { stateLayout } from '../config/paths.mjs'
import { listSessions, removeSession, reconcilePlan } from '../core/fleet.mjs'
import {
  listWorktrees as listWorktreesGit, findWorktree, removeWorktree as removeWorktreeGit,
  templatePattern, samePath, canonicalPath,
} from '../core/worktree.mjs'
import { readyFlagPath } from '../core/install.mjs'

/** Contract §5's outcome enum. Anything else is a flag the reclaimer refuses to act on. */
export const OUTCOMES = Object.freeze(['pr-pushed', 'cancelled', 'duplicate', 'no-code-change', 'check-complete'])

/** Outcomes under which local changes are SAVED as a patch and the reclaim proceeds (see reclaimPlan). */
export const PATCH_OUTCOMES = Object.freeze(['cancelled', 'duplicate', 'no-code-change'])

/** Consecutive passes an inference verdict must hold before it is acted on. The done flag needs none. */
export const STRIKES_TO_ARM = 2

/**
 * The idle the never-branched arm needs (no contract key exists for it). A session cancelled before
 * it ever branched leaves a tree indistinguishable from a freshly installed one, so only a long
 * silence from a DEAD session separates the two.
 */
export const NEVER_BRANCHED_IDLE_MS = 30 * 60_000

// A label is a FILENAME: `done-<label>.json` is joined onto the flags directory, and anything that
// could climb out of it is not a flag (the same rule core/fleet.mjs applies to descriptors).
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DONE_RE = /^done-([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/

/** The reflog subject git writes for every checkout: `checkout: moving from <a> to <b>`. */
const MOVE_RE = /^checkout: moving from (\S+) to (\S+)$/

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function assertLabel(label) {
  const s = typeof label === 'number' ? String(label) : label
  if (typeof s !== 'string' || !LABEL_RE.test(s)) {
    throw new Error(`reclaim: invalid session label ${JSON.stringify(label)}: a label is a filename ([A-Za-z0-9._-], not starting with "."), never a path`)
  }
  return s
}

// ---- paths -------------------------------------------------------------------------------------

/** `<stateDir>/flags` — the layout itself lives in config/paths.mjs. */
export function flagsDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('reclaim: stateDir is required')
  return stateLayout(stateDir, process.platform).flags
}

/** `done-<label>.json` and its one-line `.txt` twin (contract §4). */
export function doneFlagPaths(stateDir, label) {
  const dir = flagsDir(stateDir)
  const id = assertLabel(label)
  return { json: path.join(dir, `done-${id}.json`), txt: path.join(dir, `done-${id}.txt`) }
}

/** `<stateDir>/wip` — where abandoned work is saved before its worktree goes (not in contract §4's table yet). */
export function wipDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('reclaim: stateDir is required')
  return path.join(stateDir, 'wip')
}

/** `<stateDir>/wip/<label>-<at>.patch`, with the instant made filename-safe (colons are illegal on Windows). */
export function wipPatchPath(stateDir, label, nowMs) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  return path.join(wipDir(stateDir), `${assertLabel(label)}-${stamp}.patch`)
}

// ---- flags -------------------------------------------------------------------------------------

/**
 * PURE. Parse a done flag's text. `{flag}` or `{error}` — never a throw, because one unreadable flag
 * must not stop the pass over the other eleven, and never a silent null, because a flag nobody can
 * read is a session nobody reclaims.
 */
export function parseDoneFlag(text) {
  let d
  try {
    d = JSON.parse(String(text))
  } catch {
    return { error: 'is not valid JSON' }
  }
  if (!isPlainObject(d)) return { error: 'is not a JSON object' }
  return { flag: d }
}

/**
 * Every done flag in the flags directory: `{label, file, txt, flag, error}`. Only `done-<label>.json`
 * is read — the `.txt` twin is for tailing, a blocked flag is another watcher's, and a name that is
 * not a flag is not a flag.
 */
export function listDoneFlags(stateDir) {
  const dir = flagsDir(stateDir)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const name of names) {
    const m = DONE_RE.exec(name)
    if (!m) continue
    const label = m[1]
    const { json, txt } = doneFlagPaths(stateDir, label)
    let text
    try {
      text = fs.readFileSync(json, 'utf8')
    } catch (e) {
      out.push({ label, file: json, txt, flag: null, error: `cannot be read: ${e.code || e.message}` })
      continue
    }
    const p = parseDoneFlag(text)
    out.push({ label, file: json, txt, flag: p.flag || null, error: p.error || null })
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

/**
 * Issue keys with a PENDING outbox entry for `op` (default op-15 patchBody), read minimally from
 * `<stateDir>/tracker-outbox/*.json` — only `key` and `n` are looked at, and an entry that cannot be
 * read counts for nothing: a correction that cannot be proven queued is not on its way.
 */
export function pendingOutboxKeys(stateDir, { op = 15 } = {}) {
  const dir = stateLayout(stateDir, process.platform).outbox
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const keys = new Set()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let j
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (isPlainObject(j) && j.n === op && typeof j.key === 'string' && j.key) keys.add(j.key)
  }
  return [...keys].sort()
}

// ---- pure: the gate ----------------------------------------------------------------------------

/**
 * PURE. May this flagged session be torn down? The four preconditions, each a refusal with a code.
 *
 * `worktreeState` is observeWorktree()'s reading: `{label, detached, clean, changes, sessionBranch}`.
 * `remoteBranches` is the remote's head list, or null when the lookup FAILED — and a failed lookup
 * refuses rather than passes, because the gate must fail in the direction that loses nothing.
 * `outboxKeys` are the issue keys with a queued op-15 patch; `liveInWorktree` the processes that are
 * not this session's own (secondProcesses()).
 *
 * ⛔ Dirty is a refusal for `pr-pushed` and `check-complete` and a PATCH for the three no-code
 * outcomes. Two gates once contradicted each other on one session — "cancelled, nothing to preserve"
 * accepted, "a tracked file is modified" refused — and because both were permanent the watcher
 * retried every fifteen seconds for hours while the finished session sat open. A gate that can never
 * be satisfied resolves its blocker (save the diff, proceed) or abandons loudly; it never loops.
 * @returns {{proceed: boolean, refusals: Array<{code: string, reason: string}>, savePatch: boolean, branch: string|null}}
 */
export function reclaimPlan({ flag, worktreeState, remoteBranches = null, outboxKeys = [], liveInWorktree = [] } = {}) {
  const refusals = []
  const refuse = (code, reason) => refusals.push({ code, reason })
  const w = isPlainObject(worktreeState) ? worktreeState : {}
  const f = isPlainObject(flag) ? flag : null
  const outcome = f ? f.outcome : null

  if (!f) refuse('no-flag', 'no done flag to act on')
  else if (!OUTCOMES.includes(outcome)) {
    refuse('bad-outcome', `outcome ${JSON.stringify(outcome)} is not one of ${OUTCOMES.join(' | ')} (contract §5)`)
  }
  if (f && f.session !== undefined && f.session !== null && w.label !== undefined && w.label !== null && String(f.session) !== String(w.label)) {
    // The filename is the identity. A flag written under label 3 that says session 7 would reclaim
    // 3's worktree on 7's say-so. A flag that names no session at all is judged by its filename.
    refuse('flag-session-mismatch', `the flag file is for session ${w.label} but its body says session ${JSON.stringify(f.session)}`)
  }

  if (w.detached !== true) {
    const where = w.detached === false ? `on branch ${JSON.stringify(w.currentBranch ?? '?')}` : 'in an unknown state'
    refuse('not-detached', `the worktree is ${where} — a finished session detaches at the base as its close-out, so a checked-out branch means it is not done`)
  }

  const knownDirty = w.clean === false
  const savePatch = knownDirty && PATCH_OUTCOMES.includes(outcome)
  if (w.clean !== true && !savePatch) {
    const changes = Array.isArray(w.changes) ? w.changes : []
    const what = knownDirty
      ? `${changes.length} local change(s) (${changes.slice(0, 3).join(', ')}${changes.length > 3 ? ', …' : ''})`
      : 'a working tree whose cleanliness could not be read'
    refuse('dirty', `${what} — a session that flagged ${outcome ?? 'done'} with uncommitted work is not done`)
  }

  if (outcome === 'pr-pushed') {
    const branch = w.sessionBranch || null
    if (!branch) {
      refuse('no-branch', 'no session branch is known (neither the descriptor nor the reflog names one), so the push cannot be verified')
    } else if (!Array.isArray(remoteBranches)) {
      refuse('remote-unverified', `the remote branch list could not be read, so "${branch}" cannot be confirmed pushed — refusing to delete what cannot be verified`)
    } else if (!remoteBranches.includes(branch)) {
      refuse('branch-not-on-remote', `branch "${branch}" is not on the remote — the ledger of record is the remote, not the flag`)
    }
  }

  if (f && f.prescription === 'amended' && f.bodyPatched !== true) {
    const key = f.issue === undefined || f.issue === null ? '' : String(f.issue)
    const queued = (outboxKeys || []).map(String).includes(key)
    if (!queued) {
      refuse('amended-unpatched', `the prescription was amended but the ticket body is neither patched (bodyPatched: false) nor has an op-15 patchBody queued for ${key || 'its key'} — the correction must be on its way to where it is read before the session that knows it is gone`)
    }
  }

  const live = Array.isArray(liveInWorktree) ? liveInWorktree : []
  if (live.length) {
    const who = live.slice(0, 4).map(p => `${p.pid}${p.label ? ` (session ${p.label})` : ''}`).join(', ')
    refuse('second-process', `${live.length} process(es) other than this session's are live in the worktree: ${who}${live.length > 4 ? ', …' : ''} — reclaiming would delete the tree under them`)
  }

  return { proceed: refusals.length === 0, refusals, savePatch, branch: w.sessionBranch ?? null }
}

// ---- pure: the reflog --------------------------------------------------------------------------

/** PURE. The checkout moves in a list of reflog subjects (newest first, as `git log -g` prints them). */
export function parseReflog(subjects) {
  const out = []
  for (const raw of subjects || []) {
    const m = MOVE_RE.exec(String(raw).trim())
    if (m) out.push({ from: m[1], to: m[2] })
  }
  return out
}

/**
 * PURE. The anchored pattern a session branch matches, from `vcs.branchTemplate` and the derived
 * `vcs.branchPrefix`. With no prefix the first segment is free, which is why `isSessionBranch` also
 * rules out the base branch and anything under the remote by name.
 */
export function sessionBranchPattern(config) {
  return templatePattern(config.vcs.branchTemplate, { prefix: config.vcs.branchPrefix ?? null })
}

/** PURE. Is `name` a session's branch? The descriptor's own branch always is; the base and remote refs never are. */
export function isSessionBranch(name, { pattern, remote, baseBranch, descriptorBranch = null }) {
  const n = String(name || '')
  if (!n) return false
  if (descriptorBranch && n === descriptorBranch) return true
  if (n === baseBranch || n.startsWith(`${remote}/`)) return false
  return pattern.test(n)
}

/**
 * PURE. The close-out move, if the reflog shows one: the NEWEST checkout from a session branch to
 * any spelling of the base (`<remote>/<base>`, `<base>`, or its commit). The reflog is the signal —
 * not a notes file the session may or may not have deleted, not a PR lookup.
 */
export function closeOutMove(moves, { baseRefs, ...branchRule }) {
  const bases = new Set((baseRefs || []).map(String))
  for (const m of moves || []) {
    if (bases.has(m.to) && isSessionBranch(m.from, branchRule)) return m
  }
  return null
}

// ---- pure: inference ---------------------------------------------------------------------------

/**
 * PURE. Is this UNFLAGGED session finished? Two arms, both gated on the tree being INSTALLED and the
 * session being DEAD:
 *   reflog         — detached, clean, and a checkout from a session branch back to the base;
 *   never-branched — detached, clean, no checkout move at all, and idle past `neverBranchedIdleMs`.
 *
 * ⛔ Never while installing. A fresh worktree is detached, clean and branch-less until its install
 * finishes — by git state alone identical to a finished one — and under wave pacing that install may
 * not have STARTED for most of an hour. The ready flag missing, or a shim directory with nothing in
 * it, is the tree saying so.
 *
 * ⛔ Never on a live session. A relaunched agent reading its ticket in a reused tree is detached and
 * clean too, and an old close-out move is still in that tree's reflog.
 *
 * ⛔ Never on a PR lookup, and this signature has no way to receive one: passing `pr`, `prs` or
 * `prUrl` throws. A finished session may legitimately have no PR and no branch, and a PR list filtered
 * on an empty branch name once returned every PR there was — the first row was an unrelated one.
 * @returns {{finished: boolean, arm: 'reflog'|'never-branched'|null, reason: string}}
 */
export function inferFinished({ worktreeState, alive, idleMs = null, neverBranchedIdleMs = NEVER_BRANCHED_IDLE_MS, ...rest } = {}) {
  for (const k of ['pr', 'prs', 'prUrl']) {
    if (k in rest) throw new Error(`inferFinished: a PR lookup (${k}) is not evidence of a finished session — a finished session may have no PR, and an empty head filter lists every PR; the reflog is the signal`)
  }
  const no = reason => ({ finished: false, arm: null, reason })
  const w = isPlainObject(worktreeState) ? worktreeState : null
  if (!w || w.registered === false) return no('not a registered worktree')
  if (w.readyFlag !== true) return no('still installing: the ready flag is absent (a fresh tree is detached, clean and branch-less until its install finishes)')
  if (w.binShims !== null && w.binShims !== undefined && w.binShims < 1) return no('still installing: node_modules has no shims')
  if (alive !== false) return no(alive === null ? 'liveness is unknown this pass' : 'the session is alive — only a crashed session is inferred finished')
  if (w.detached !== true) return no(w.detached === false ? `on branch ${JSON.stringify(w.currentBranch ?? '?')}` : 'HEAD state unknown')
  if (w.clean !== true) return no(w.clean === false ? `${(w.changes || []).length} local change(s)` : 'cleanliness unknown')
  if (w.closeOut) return { finished: true, arm: 'reflog', reason: `the reflog shows the close-out move from ${w.closeOut.from} to ${w.closeOut.to}` }
  if (w.moves === 0) {
    const idle = Number.isFinite(idleMs) ? idleMs : null
    if (idle === null || idle < neverBranchedIdleMs) {
      return no(`never branched and ${idle === null ? 'idle time unknown' : `idle ${Math.round(idle / 60_000)} min`} (needs ${Math.round(neverBranchedIdleMs / 60_000)} min dead and idle)`)
    }
    return { finished: true, arm: 'never-branched', reason: `never branched, fully installed, dead and idle ${Math.round(idle / 60_000)} min` }
  }
  return no('the reflog shows checkouts but no move from a session branch back to the base')
}

/** A fresh watcher state: inference strikes per label, and which refusals were already reported. */
export function newReclaimState() {
  return { strikes: {}, reported: {} }
}

/**
 * PURE. Count consecutive passes a verdict has held. A verdict that changes arm or lapses resets to
 * zero — one pass detached-and-clean followed by one pass on a branch is not two strikes.
 * @returns {{armed: boolean, count: number, strikes: object}}
 */
export function strike(strikes, label, verdict, nowMs = Date.now()) {
  const id = String(label)
  const next = { ...(strikes || {}) }
  if (!verdict || !verdict.finished) {
    delete next[id]
    return { armed: false, count: 0, strikes: next }
  }
  const prev = next[id]
  const count = prev && prev.arm === verdict.arm ? prev.count + 1 : 1
  next[id] = { count, arm: verdict.arm, at: new Date(nowMs).toISOString() }
  return { armed: count >= STRIKES_TO_ARM, count, strikes: next }
}

/** The memory key an INFERENCE refusal is logged under: separate from the flag's, so a later flag for the same label is judged fresh. */
export const INFER_KEY = 'infer:'

/**
 * PURE. Forget what no longer exists. ⛔ A label whose flag file is GONE is forgotten at once — a
 * watcher that remembered handled flags by label silently ignored the next session to wear that
 * number. Strikes are forgotten when the label leaves the registry or gains a flag; an inference
 * refusal's memory lives as long as the label is registered.
 */
export function pruneState(state, { flagLabels = [], registryLabels = [] } = {}) {
  const s = state || newReclaimState()
  const flags = new Set(flagLabels.map(String))
  const reg = new Set(registryLabels.map(String))
  const reported = {}
  for (const [k, v] of Object.entries(s.reported || {})) {
    if (k.startsWith(INFER_KEY) ? reg.has(k.slice(INFER_KEY.length)) : flags.has(k)) reported[k] = v
  }
  const strikes = {}
  for (const [k, v] of Object.entries(s.strikes || {})) if (reg.has(k) && !flags.has(k)) strikes[k] = v
  return { ...s, strikes, reported }
}

// ---- pure: the second-process check ------------------------------------------------------------

/**
 * PURE. Processes live in `worktree` that are NOT this session's own tree: another registered
 * session on the same path with its marker in the snapshot, or anything whose command line names the
 * worktree (boundary-safe, so `app-session-1` never claims `app-session-10`) that is neither a
 * descendant of this label's shim nor the caller and its ancestors.
 *
 * Returns null on an EMPTY snapshot: that is a failed listing, never an idle machine, and a gate that
 * cannot see cannot pass.
 */
export function secondProcesses({ snapshot, worktree, label, registry = [], selfPid = process.pid }) {
  if (!snapshot || snapshot.size === 0) return null
  const id = String(label)
  const prot = protectedSet(snapshot, selfPid)
  const own = new Set()
  for (const p of snapshot.values()) {
    if (sessionLabelOf(p.cmd) !== id) continue
    own.add(p.pid)
    for (const d of descendants(snapshot, p.pid)) own.add(d)
  }
  const found = new Map()
  const here = canonicalPath(worktree)
  for (const d of registry || []) {
    if (!d || String(d.label) === id || typeof d.worktree !== 'string' || !d.worktree.trim()) continue
    if (!samePath(canonicalPath(d.worktree), here)) continue
    for (const p of snapshot.values()) {
      if (sessionLabelOf(p.cmd) === String(d.label)) found.set(p.pid, { pid: p.pid, label: String(d.label), cmd: p.cmd, why: 'registered-session' })
    }
  }
  for (const p of inDirectory(snapshot, worktree)) {
    if (own.has(p.pid) || prot.has(p.pid) || found.has(p.pid)) continue
    found.set(p.pid, { pid: p.pid, label: sessionLabelOf(p.cmd), cmd: p.cmd, why: 'inside-worktree' })
  }
  return [...found.values()].sort((a, b) => a.pid - b.pid)
}

// ---- pure: is this path a fleet worktree folder? ----------------------------------------------

function basenameOf(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()
}

/**
 * PURE. Positively identify a folder as a fleet worktree by name (`repo.sessionDirTemplate` or
 * `repo.checkerDirTemplate`, anchored) and by parent (`repo.worktreeParent`, when configured). The
 * sweep deletes a directory tree, so — like a kill — it acts only on what is positively identified.
 */
export function isFleetFolder(worktree, config) {
  if (typeof worktree !== 'string' || !worktree.trim() || !path.isAbsolute(worktree)) return false
  const name = basenameOf(worktree)
  const vars = { repo: config.repo.name ?? null }
  const templates = [config.repo.sessionDirTemplate, config.repo.checkerDirTemplate].filter(Boolean)
  const named = templates.some(t => {
    try {
      return templatePattern(t, vars).test(name)
    } catch {
      return false
    }
  })
  if (!named) return false
  const parent = config.repo.worktreeParent
  if (parent) return samePath(canonicalPath(path.dirname(worktree)), canonicalPath(parent))
  return true
}

// ---- thin: observing a worktree ----------------------------------------------------------------

/** How many shims `node_modules/.bin` holds; null when there is no node_modules at all (not a Node tree). */
export function countBinShims(worktree) {
  const nm = path.join(worktree, 'node_modules')
  if (!fs.existsSync(nm)) return null
  try {
    return fs.readdirSync(path.join(nm, '.bin')).length
  } catch {
    return 0
  }
}

/** The pathspec that keeps the ready sentinel out of the cleanliness check: it is the launcher's file, not the session's work. */
function readyFlagRel(worktree, config) {
  return path.relative(worktree, readyFlagPath(worktree, config)).split(path.sep).join('/')
}

/**
 * The spellings of the base a close-out may have checked out: `<remote>/<base>`, `<base>`, and the
 * commit `<remote>/<base>` resolves to in the PRIMARY (a session may detach at the sha).
 */
export function baseRefsOf({ config, primary, git = gitExec }) {
  const remote = config.repo.remote
  const base = config.repo.baseBranch
  const refs = [`${remote}/${base}`, base]
  const r = git(primary, ['rev-parse', '--verify', '--quiet', `${remote}/${base}^{commit}`])
  if (r.ok && r.stdout.trim()) refs.push(r.stdout.trim())
  return refs
}

/**
 * ⛔ Run from the PRIMARY checkout, never from the worktree being judged: a deregistered worktree's
 * `ls-remote` fails with "the remote does not appear to be a git repository", and a gate that read
 * that as "branch not pushed" refused forever — attempt one had broken the check that authorised
 * attempt two. Returns null when the lookup fails, which reclaimPlan reads as a refusal.
 */
export function listRemoteBranches({ config, primary, git = gitExec }) {
  const r = git(primary, ['ls-remote', '--heads', config.repo.remote], { timeoutMs: 60_000 })
  if (!r.ok) return null
  return r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split(/\s+/)[1] || '')
    .filter(ref => ref.startsWith('refs/heads/'))
    .map(ref => ref.slice('refs/heads/'.length))
}

/**
 * Read one worktree: detached? clean? which moves does its reflog show? is it installed? Every git
 * call is `-C <worktree>` and every failure is REPORTED in `error` rather than read as an answer —
 * an unreadable tree is neither clean nor detached.
 *
 * `sessionBranch` is the descriptor's `branch` when the launcher recorded one, else the branch the
 * close-out move left (the done flag carries no branch field, so the reflog is where the name lives).
 */
export function observeWorktree({ worktree, label, descriptor = {}, config, entry = null, baseRefs = [], git = gitExec }) {
  const out = {
    label: String(label),
    worktree,
    registered: !!entry,
    locked: !!(entry && entry.locked),
    currentBranch: entry ? entry.branch : null,
    detached: null,
    clean: null,
    changes: [],
    sessionBranch: (descriptor && descriptor.branch) || null,
    moves: 0,
    closeOut: null,
    readyFlag: false,
    binShims: null,
    error: null,
  }
  if (!entry) return out

  const sr = git(worktree, ['symbolic-ref', '--quiet', 'HEAD'])
  if (sr.ok) {
    out.detached = false
    out.currentBranch = sr.stdout.trim().replace(/^refs\/heads\//, '')
  } else if (sr.code === 1) {
    out.detached = true
  } else {
    out.error = `git symbolic-ref failed: ${(sr.stderr || sr.stdout || `exit ${sr.code}`).trim()}`
    return out
  }

  const st = git(worktree, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${readyFlagRel(worktree, config)}`])
  if (!st.ok) {
    out.error = `git status failed: ${(st.stderr || st.stdout || `exit ${st.code}`).trim()}`
    return out
  }
  out.changes = st.stdout.split(/\r?\n/).filter(l => l.trim())
  out.clean = out.changes.length === 0

  const rl = git(worktree, ['log', '-g', '--format=%gs', 'HEAD'])
  const moves = rl.ok ? parseReflog(rl.stdout.split(/\r?\n/)) : []
  out.moves = moves.length
  const branchRule = {
    pattern: sessionBranchPattern(config),
    remote: config.repo.remote,
    baseBranch: config.repo.baseBranch,
    descriptorBranch: out.sessionBranch,
  }
  out.closeOut = closeOutMove(moves, { baseRefs, ...branchRule })
  if (!out.sessionBranch && out.closeOut) out.sessionBranch = out.closeOut.from
  // Still ON a session branch: that branch is the session's, so the refusal can say "not detached"
  // without also claiming no branch is known.
  if (!out.sessionBranch && out.detached === false && isSessionBranch(out.currentBranch, branchRule)) out.sessionBranch = out.currentBranch

  out.readyFlag = fs.existsSync(readyFlagPath(worktree, config))
  out.binShims = countBinShims(worktree)
  return out
}

// ---- thin: the wip patch -----------------------------------------------------------------------

/**
 * Save a worktree's uncommitted work as ONE `git apply`-able patch: `git diff HEAD --binary` for the
 * tracked changes, plus a creation hunk per untracked file (`git diff --no-index -- /dev/null <f>`),
 * because the tree is about to be deleted and a list of names would not bring the files back.
 * Read-only against the worktree — ⛔ never `git stash`, whose `refs/stash` is shared by every
 * worktree of the repository. The ready sentinel is the launcher's file and is left out.
 * @returns {{file: string, bytes: number, tracked: boolean, untracked: string[]}}
 */
export function saveWipPatch({ stateDir, label, worktree, config, outcome = null, nowMs = Date.now(), git = gitExec }) {
  const d = git(worktree, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--binary'])
  if (!d.ok) throw new Error(`git diff failed in ${worktree}: ${(d.stderr || d.stdout || `exit ${d.code}`).trim()}`)
  const u = git(worktree, ['ls-files', '--others', '--exclude-standard'])
  if (!u.ok) throw new Error(`git ls-files failed in ${worktree}: ${(u.stderr || u.stdout || `exit ${u.code}`).trim()}`)
  const sentinel = readyFlagRel(worktree, config)
  const untracked = u.stdout.split(/\r?\n/).map(s => s.trim()).filter(f => f && f !== sentinel)
  let body = d.stdout
  for (const rel of untracked) {
    const n = git(worktree, ['diff', '--no-index', '--no-ext-diff', '--no-color', '--binary', '--', '/dev/null', rel])
    // `diff --no-index` exits 1 when the two sides differ, which a new file always does.
    if (n.code !== 0 && n.code !== 1) throw new Error(`git diff --no-index failed for ${rel}: ${(n.stderr || n.stdout || `exit ${n.code}`).trim()}`)
    body += n.stdout
  }
  const at = new Date(nowMs).toISOString()
  const head = [
    '# claude-fleet wip patch: uncommitted work saved by the reclaimer before the worktree was removed',
    '# apply with: git apply <this file>   (git diff HEAD --binary, plus one creation hunk per untracked file)',
    `# label: ${label}`,
    `# worktree: ${worktree}`,
    `# outcome: ${outcome ?? '(inferred)'}`,
    `# at: ${at}`,
    `# untracked (${untracked.length}):`,
    ...untracked.map(f => `#   ${f}`),
    '',
  ].join('\n')
  const file = wipPatchPath(stateDir, label, nowMs)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Temp-then-rename: a half-written patch is worse than none — it applies cleanly and restores half the work.
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, head + body)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return { file, bytes: Buffer.byteLength(head + body), tracked: d.stdout.trim().length > 0, untracked }
}

// ---- thin: the sweep ---------------------------------------------------------------------------

/**
 * Delete a leftover folder without following links. ⛔ `fs.rmSync` unlinks a symlink or a junction
 * rather than descending into it — the workspace links inside `node_modules` point back at the
 * primary checkout, and a delete that followed them once emptied the primary. The answer comes from
 * the filesystem afterwards, never from the absence of an error: an EMPTY survivor is a cwd-locked
 * directory (cosmetic; the next `worktree add` reuses it), a non-empty one is a failure.
 * @returns {{existed: boolean, remains: boolean, empty: boolean, error: string|null}}
 */
export function sweepFolder(dir) {
  if (!fs.existsSync(dir)) return { existed: false, remains: false, empty: true, error: null }
  let error = null
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (e) {
    error = e.message
  }
  const remains = fs.existsSync(dir)
  let empty = true
  if (remains) {
    try {
      empty = fs.readdirSync(dir).length === 0
    } catch {
      empty = false
    }
  }
  return { existed: true, remains, empty, error }
}

// ---- the pass ----------------------------------------------------------------------------------

/** Idle time from the reconciler's `deadAt` when the caller has no better source. */
function defaultIdle(descriptor, nowMs) {
  const t = Date.parse(descriptor.deadAt ?? '')
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null
}

function markerPids(snapshot, label) {
  return [...snapshot.values()].filter(p => sessionLabelOf(p.cmd) === String(label)).map(p => p.pid).sort((a, b) => a - b)
}

/**
 * Kill the session through the backend, then PROVE it: re-snapshot and assert nothing carries the
 * label's marker and nothing else lives in the worktree. A kill aimed at a collection once reported
 * success while doing nothing, and left a wedged agent beside a fresh one in one tree.
 */
function killSession(ctx, { label, descriptor: d, worktree }) {
  const handle = d.backendRef ? { id: String(label), role: d.role, backendRef: d.backendRef } : null
  if (!handle) {
    const live = markerPids(ctx.snapshot, label)
    if (live.length) return { ok: false, killed: [], alreadyGone: false, survivors: live, reason: 'the descriptor carries no backendRef, so a live session cannot be addressed for a kill' }
    return { ok: true, killed: [], alreadyGone: true, survivors: [], reason: null }
  }
  let res
  try {
    res = ctx.backend.kill(handle)
  } catch (e) {
    return { ok: false, killed: [], alreadyGone: false, survivors: [], reason: `backend.kill threw: ${e.message}` }
  }
  const survivors = new Set((res && res.survivors) || [])
  const after = typeof ctx.resnapshot === 'function' ? ctx.resnapshot() : null
  if (after && after.size) {
    for (const pid of markerPids(after, label)) survivors.add(pid)
    const prot = protectedSet(after, ctx.selfPid)
    for (const p of inDirectory(after, worktree)) if (!prot.has(p.pid)) survivors.add(p.pid)
  }
  const list = [...survivors].sort((a, b) => a - b)
  const ok = !!(res && res.ok !== false) && list.length === 0
  return { ok, killed: (res && res.killed) || [], alreadyGone: !!(res && res.alreadyGone), survivors: list, reason: ok ? null : `${list.length} process(es) survived the kill` }
}

/**
 * The teardown, in the order that loses nothing if it stops halfway: patch → kill → deregister →
 * verify → sweep → registry → flag LAST → forget. A failure at any stage keeps the flag and the
 * registry entry so the next pass retries from the top; the resume path in reclaimOnce() knows not to
 * run git inside a tree that this pass already deregistered.
 */
function teardown(ctx, { label, descriptor: d, worktree, flag = null, registered, savePatch = false, arm = null, outcome = null }) {
  const r = { label, action: 'reclaimed', outcome, arm, stage: null, error: null, patch: null, kill: null, removal: null, folderRemains: false }
  const fail = (stage, error) => {
    ctx.log(`reclaim: ${label}: FAILED at ${stage} — ${error} (the flag and the registry entry are kept; the next pass retries)`)
    return { ...r, action: 'failed', stage, error }
  }

  if (savePatch) {
    try {
      r.patch = saveWipPatch({ stateDir: ctx.stateDir, label, worktree, config: ctx.config, outcome, nowMs: ctx.nowMs, git: ctx.git })
      ctx.log(`reclaim: ${label}: saved ${r.patch.bytes} bytes of uncommitted work to ${r.patch.file} (${r.patch.untracked.length} untracked file(s))`)
    } catch (e) {
      return fail('patch', e.message)
    }
  }

  r.kill = killSession(ctx, { label, descriptor: d, worktree })
  if (!r.kill.ok) return fail('kill', r.kill.reason)

  if (registered) {
    let rm
    try {
      rm = ctx.removeWorktree({ repo: ctx.primary, path: worktree, force: true })
    } catch (e) {
      return fail('remove', e.message)
    }
    r.removal = rm
    if (!rm.deregistered) return fail('remove', rm.message || 'git worktree remove did not deregister the tree')
  }
  // The exit code is not the answer: the registration is checked against a fresh listing.
  const still = findWorktree(ctx.listWorktrees(ctx.primary), worktree)
  if (still) return fail('verify', 'the worktree is still registered after removal')

  const swept = sweepFolder(worktree)
  r.folderRemains = swept.remains
  if (swept.remains && !swept.empty) return fail('sweep', `the folder survived non-empty (${swept.error || 'holders still inside it'})`)
  if (swept.remains) ctx.log(`reclaim: ${label}: folder survives empty (cwd-locked by a shell); cosmetic, reusable`)

  removeSession(label, { stateDir: ctx.stateDir })
  if (flag) {
    fs.rmSync(flag.file, { force: true })
    fs.rmSync(flag.txt, { force: true })
  }
  delete ctx.state.strikes[label]
  delete ctx.state.reported[label]
  delete ctx.state.reported[INFER_KEY + label]
  ctx.log(`reclaim: ${label}: reclaimed (${outcome ?? `inferred: ${arm}`}) — killed ${r.kill.killed.length}, worktree deregistered, folder ${swept.existed ? (swept.remains ? 'left empty' : 'deleted') : 'already gone'}`)
  return r
}

function refuse(ctx, label, refusals, extra = {}, memoryKey = label) {
  const digest = refusals.map(x => x.code).join(',')
  // Logged when NEW, not on every pass: the reclaim log once showed the same three lines every
  // fifteen seconds for hours, and nobody reads a log that repeats.
  if (ctx.state.reported[memoryKey] !== digest) {
    ctx.state.reported[memoryKey] = digest
    for (const x of refusals) ctx.log(`reclaim: ${label}: refused (${x.code}) ${x.reason}`)
  }
  return { label, action: 'refused', refusals, ...extra }
}

/**
 * One reclaim pass, callable from `fleet watch`'s loop or once by hand.
 *
 * Every side effect is injected: the process snapshot (taken ONCE per pass by the caller and reused
 * — the reclaimer never takes its own), the backend that kills, git, the worktree remover and the
 * lister, the clock and the log. `resnapshot` is the one sanctioned fresh read, taken after a kill to
 * prove it.
 *
 * @param {object} o
 * @param {string} o.stateDir       contract §4 state directory
 * @param {object} o.backend        the terminal backend (src/backends); `kill(handle)` is what is used
 * @param {object} o.config         resolved + derived config
 * @param {string} o.primary        the PRIMARY checkout — every remote and worktree-list call runs here
 * @param {Map} o.snapshot          this pass's process snapshot (Map<pid, ProcInfo>)
 * @param {() => Map} [o.resnapshot] a fresh snapshot for the after-kill check
 * @param {object} [o.state]        from a previous pass (newReclaimState() when none)
 * @param {boolean} [o.inference]   run the crashed-before-flagging fallback (default true)
 * @param {(d) => number|null} [o.idleOf]  idle ms for a descriptor; default: since the reconciler's deadAt
 * @returns {{results: Array, state: object, degraded: boolean}}
 */
export function reclaimOnce({
  stateDir, backend, config, primary, snapshot, resnapshot = null,
  nowMs = Date.now(), selfPid = process.pid, git = gitExec, log = () => {},
  state = null, inference = true, idleOf = null,
  removeWorktree = removeWorktreeGit, listWorktrees = listWorktreesGit, readOutboxKeys = pendingOutboxKeys,
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('reclaimOnce: stateDir is required')
  if (!backend || typeof backend.kill !== 'function') throw new Error('reclaimOnce: a backend with kill() is required')
  if (!config || !config.repo || !config.vcs || !config.install) throw new Error('reclaimOnce: a resolved config is required')
  if (typeof primary !== 'string' || !primary.trim()) throw new Error('reclaimOnce: primary is required')
  if (!(snapshot instanceof Map)) throw new Error('reclaimOnce: a process snapshot (Map) is required — take it once per pass and pass it in')

  const results = []
  const registry = listSessions({ stateDir })
  const byLabel = new Map(registry.map(d => [String(d.label), d]))
  const flags = listDoneFlags(stateDir)
  const flagged = new Set(flags.map(f => f.label))
  const st = pruneState(state || newReclaimState(), { flagLabels: [...flagged], registryLabels: [...byLabel.keys()] })
  const degraded = snapshot.size === 0
  const plan = degraded ? null : reconcilePlan(registry, snapshot, { nowMs })
  const alive = new Set(plan ? plan.alive.map(a => a.label) : [])
  const pending = new Set(plan ? plan.pending.map(p => p.label) : [])
  const worktrees = listWorktrees(primary)
  const primaryCanon = canonicalPath(primary)

  let remoteBranches
  let outboxKeys
  const ctx = {
    stateDir, backend, config, primary, snapshot, resnapshot, nowMs, selfPid, git, log, state: st,
    removeWorktree, listWorktrees,
    baseRefs: baseRefsOf({ config, primary, git }),
    remoteBranchesOf: () => {
      if (remoteBranches === undefined) remoteBranches = listRemoteBranches({ config, primary, git })
      return remoteBranches
    },
    outboxKeysOf: () => {
      if (outboxKeys === undefined) outboxKeys = readOutboxKeys(stateDir)
      return outboxKeys
    },
  }

  const worktreeOf = d => {
    const w = d.worktree
    if (typeof w !== 'string' || !w.trim() || !path.isAbsolute(w)) return { error: `the descriptor's worktree is not an absolute path (${JSON.stringify(w)})` }
    if (samePath(canonicalPath(w), primaryCanon)) return { error: 'the descriptor points at the PRIMARY checkout, which is never reclaimed' }
    if (!isFleetFolder(w, config)) return { error: `${w} is not a fleet worktree folder by name and parent (repo.sessionDirTemplate / repo.checkerDirTemplate under repo.worktreeParent)` }
    return { worktree: w }
  }

  // ---- flagged sessions: the flag authorises teardown now, after the four checks ----
  for (const f of flags) {
    const label = f.label
    if (f.error) {
      results.push(refuse(ctx, label, [{ code: 'unreadable-flag', reason: `${f.file} ${f.error}` }]))
      continue
    }
    const d = byLabel.get(label)
    if (!d) {
      results.push(refuse(ctx, label, [{ code: 'no-descriptor', reason: 'no registry entry names this session, so its worktree is unknown' }]))
      continue
    }
    if (d.role === 'testing') {
      results.push(refuse(ctx, label, [{ code: 'testing-role', reason: 'a testing slot is never reclaimed by the done-flag path; `fleet down` owns it' }]))
      continue
    }
    const w = worktreeOf(d)
    if (w.error) {
      results.push(refuse(ctx, label, [{ code: 'bad-worktree', reason: w.error }]))
      continue
    }
    const worktree = w.worktree
    if (degraded) {
      results.push(refuse(ctx, label, [{ code: 'snapshot-degraded', reason: 'the process snapshot is empty — a failed listing, never an idle machine — so the second-process check cannot run this pass' }]))
      continue
    }
    const entry = findWorktree(worktrees, worktree)
    if (!entry) {
      // ⛔ Already deregistered — by this reclaimer's previous pass (which then failed at the sweep,
      // or died) or by the operator. No git command runs inside a deregistered tree: its `.git` file
      // points nowhere, every command fails, and a gate that read that failure as "not clean" or
      // "not pushed" refused forever. The verification either passed when it was deregistered or is
      // moot; what is left is the second-process check (the snapshot, not git), the sweep and the
      // bookkeeping.
      const live = secondProcesses({ snapshot, worktree, label, registry, selfPid })
      if (live && live.length) {
        results.push(refuse(ctx, label, [{ code: 'second-process', reason: `${live.length} process(es) other than this session's are live in the deregistered folder — sweeping would delete it under them` }]))
        continue
      }
      ctx.log(`reclaim: ${label}: worktree is not registered (deregistered by an earlier pass or by hand); resuming from the sweep`)
      results.push(teardown(ctx, { label, descriptor: d, worktree, flag: f, registered: false, outcome: f.flag.outcome }))
      continue
    }
    const obs = observeWorktree({ worktree, label, descriptor: d, config, entry, baseRefs: ctx.baseRefs, git })
    if (obs.error) {
      results.push(refuse(ctx, label, [{ code: 'git-failed', reason: obs.error }]))
      continue
    }
    if (obs.locked) {
      results.push(refuse(ctx, label, [{ code: 'locked', reason: `the worktree is locked${entry.lockReason ? ` (${entry.lockReason})` : ''} — a lock is the operator holding the tree` }]))
      continue
    }
    const live = secondProcesses({ snapshot, worktree, label, registry, selfPid })
    const p = reclaimPlan({
      flag: f.flag,
      worktreeState: obs,
      remoteBranches: f.flag.outcome === 'pr-pushed' ? ctx.remoteBranchesOf() : null,
      outboxKeys: f.flag.prescription === 'amended' ? ctx.outboxKeysOf() : [],
      liveInWorktree: live,
    })
    if (!p.proceed) {
      results.push(refuse(ctx, label, p.refusals, { observed: obs }))
      continue
    }
    results.push(teardown(ctx, { label, descriptor: d, worktree, flag: f, registered: true, savePatch: p.savePatch, outcome: f.flag.outcome }))
  }

  // ---- unflagged sessions: inference, two strikes, dead and installed only ----
  if (inference && !degraded) {
    for (const d of registry) {
      const label = String(d.label)
      if (flagged.has(label) || d.role === 'testing') continue
      const w = worktreeOf(d)
      if (w.error) continue
      const worktree = w.worktree
      const entry = findWorktree(worktrees, worktree)
      if (!entry) {
        delete st.strikes[label]
        continue
      }
      const isAlive = alive.has(label) ? true : pending.has(label) ? null : false
      const obs = observeWorktree({ worktree, label, descriptor: d, config, entry, baseRefs: ctx.baseRefs, git })
      const idleMs = typeof idleOf === 'function' ? idleOf(d) : defaultIdle(d, nowMs)
      const verdict = obs.error ? { finished: false, arm: null, reason: obs.error } : inferFinished({ worktreeState: obs, alive: isAlive, idleMs })
      const s = strike(st.strikes, label, verdict, nowMs)
      st.strikes = s.strikes
      if (!verdict.finished) {
        results.push({ label, action: 'watching', finished: false, arm: null, strikes: 0, reason: verdict.reason })
        continue
      }
      if (!s.armed) {
        ctx.log(`reclaim: ${label}: looks finished by inference (${verdict.arm}: ${verdict.reason}) — strike ${s.count} of ${STRIKES_TO_ARM}`)
        results.push({ label, action: 'watching', finished: true, arm: verdict.arm, strikes: s.count, reason: verdict.reason })
        continue
      }
      if (obs.locked) {
        results.push(refuse(ctx, label, [{ code: 'locked', reason: 'the worktree is locked — a lock is the operator holding the tree' }], { arm: verdict.arm }, INFER_KEY + label))
        continue
      }
      const live = secondProcesses({ snapshot, worktree, label, registry, selfPid })
      if (live === null || live.length) {
        results.push(refuse(ctx, label, [{ code: 'second-process', reason: `${live ? live.length : '?'} process(es) other than this session's are live in the worktree` }], { arm: verdict.arm }, INFER_KEY + label))
        continue
      }
      ctx.log(`reclaim: ${label}: inferred finished (${verdict.arm}: ${verdict.reason}) after ${s.count} strikes — reclaiming`)
      results.push(teardown(ctx, { label, descriptor: d, worktree, flag: null, registered: true, arm: verdict.arm }))
    }
  }

  return { results, state: st, degraded }
}
