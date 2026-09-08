// Git worktree lifecycle: the one place a fleet worktree is found, created, reused and removed.
//
// Every rule below is a bug that happened on a real fleet, and each is stated where it is enforced:
//
//   * a worktree is created DETACHED at the base ref, so a session that never starts (the wave was
//     cut short, the agent died before its first turn) leaves no branch behind to explain later;
//   * an existing worktree is REUSED, never recreated — a relaunched agent's branch, commits and
//     untracked helper files live there, and recreating the tree throws them away;
//   * `git worktree remove` has TWO effects (deregister, delete) and ONE exit code, so removal is
//     verified against `git worktree list` and the filesystem, never against the exit code;
//   * paths are compared canonically and whole — `git` prints `C:/w/app-session-1` where Node hands
//     you `C:\w\app-session-1`, a macOS temp path resolves through a symlink, and a Windows runner
//     hands out an 8.3 short name; a naive string compare recreates a worktree that already exists;
//   * anything that walks the worktree parent matches on a path BOUNDARY, so `<repo>-testing` never
//     claims `<repo>-testing-2`.
//
// Pure decision helpers (parseWorktreeList, samePath, templatePattern, leftoversFrom) take data and
// carry the traps; the wrappers add only `git()` from sys/exec.mjs and `fs`.
//
// `templatePattern` + `leftoversFrom` are the CANONICAL folder-name rule for every template the
// contract defines (`repo.sessionDirTemplate`, `repo.slotDirTemplate`, `repo.checkerDirTemplate`).
// core/fleet.mjs still carries a second, weaker matcher of its own (`folderLabel`, which understands
// only `{repo}` and `{n}`) behind `takenLabels`; until that one is folded onto this module the two can
// drift, and where they disagree THIS one is right.

import fs from 'node:fs'
import path from 'node:path'
import { git, gitOrThrow } from '../sys/exec.mjs'
import { escapeRegex } from '../config/derive.mjs'

/**
 * Checking out or deleting a multi-gigabyte tree routinely runs past the 60 s default in exec.mjs,
 * and a killed checkout leaves a half-written worktree that every cheap check calls healthy.
 */
const GIT_TREE_TIMEOUT_MS = 10 * 60_000

// ---- pure path comparison ----------------------------------------------------------------------

/** Lexical form of a path for comparison: one separator, no trailing slash, case-folded on Windows. */
function normalizePath(p, platform = process.platform) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/(?!^)\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}

/**
 * Are these two paths the same location? PURE and WHOLE-path — never a prefix test, which is how a
 * check for `<repo>-testing` swallows `<repo>-testing-2`. Separator- and (on Windows) case-blind,
 * because `git worktree list` prints forward slashes while Node builds backslashes.
 */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false
  return normalizePath(a, platform) === normalizePath(b, platform)
}

const realpathSync = fs.realpathSync.native || fs.realpathSync

/**
 * A path argument must be a non-empty string, at the door.
 *
 * ⛔ Never let a missing config key or a template that rendered empty through: `path.resolve('')` is
 * the process cwd and `path.resolve(undefined)` throws only sometimes, so an empty `path` would make
 * `git worktree remove` take the launcher's own checkout and an undefined one would create a worktree
 * literally named `undefined` beside it.
 */
function assertPath(where, what, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where}: ${what} must be a non-empty path, got ${JSON.stringify(value) ?? String(value)}`)
  }
  return value
}

/**
 * Absolute path with symlinks resolved as far as the path exists, the rest appended lexically.
 *
 * Two platforms make this mandatory rather than tidy: on macOS the temp dir is `/var/...` while git
 * records `/private/var/...`, and on a Windows CI runner the temp dir arrives as an 8.3 short name
 * (`RUNNER~1`) while git prints the long one. Only the NATIVE realpath expands a short name. Without
 * this, a registered worktree looks unregistered and the launcher tries to create it again.
 * The "as far as it exists" walk matters because a worktree path is canonicalised BEFORE it exists.
 */
export function canonicalPath(p) {
  assertPath('canonicalPath', 'path', p)
  let head = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail)
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return path.resolve(p)
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

// ---- `git worktree list --porcelain` ------------------------------------------------------------

/**
 * Parse porcelain worktree records. PURE.
 *
 * Records are separated by a blank line, and the LAST record may not be followed by one — a parser
 * that flushes only on a blank line silently drops the newest worktree, which is always the session
 * that was just created.
 * @returns {Array<{path, head, branch, detached, bare, locked, lockReason, prunable, prunableReason}>}
 */
export function parseWorktreeList(text) {
  const out = []
  let cur = null
  const flush = () => {
    if (cur) out.push(cur)
    cur = null
  }
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      flush()
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const value = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      flush()
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, prunableReason: null }
      continue
    }
    if (!cur) continue
    if (key === 'HEAD') cur.head = value
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
    else if (key === 'locked') {
      cur.locked = true
      cur.lockReason = value || null
    } else if (key === 'prunable') {
      cur.prunable = true
      cur.prunableReason = value || null
    }
  }
  flush()
  return out
}

/**
 * Every worktree git knows about, taken from `repoDir` — which must be the PRIMARY checkout or any
 * live worktree, never one you may already have deregistered: a deregistered tree's `.git` file
 * points nowhere and every git command inside it fails, which a caller then reads as "no worktrees".
 *
 * Failure THROWS rather than returning []: an empty list reads as "nothing is registered", and a
 * capacity check that believes it launches sessions on top of live ones.
 */
export function listWorktrees(repoDir) {
  const r = git(canonicalPath(repoDir), ['worktree', 'list', '--porcelain'])
  if (!r.ok) throw new Error(`git worktree list failed in ${repoDir}: ${(r.stderr || r.stdout).trim()}`)
  return parseWorktreeList(r.stdout)
}

/** The registered worktree at `target`, or null. Canonicalises both sides (see canonicalPath). */
export function findWorktree(entries, target) {
  const want = canonicalPath(target)
  return entries.find(e => samePath(canonicalPath(e.path), want)) || null
}

/**
 * The main checkout, from anywhere inside the repository — the first record of `worktree list` is
 * always the main worktree. Returns null when `cwd` is not in a git repository.
 *
 * ⛔ Not `rev-parse --show-toplevel`: run inside a session's worktree that answers the SESSION's
 * tree, so every path derived from it (the worktree parent, the state dir) would hang off a
 * directory that gets deleted when the session is reclaimed.
 */
export function primaryRoot(cwd) {
  const r = git(cwd, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  const first = parseWorktreeList(r.stdout)[0]
  return first ? path.resolve(first.path) : null
}

// ---- create / reuse -----------------------------------------------------------------------------

/** git's own test before it will write into an existing directory (`is_empty_dir`). */
function isEmptyDir(p) {
  try {
    return fs.readdirSync(p).length === 0
  } catch {
    return false
  }
}

function refExists(repoDir, ref) {
  // `^{commit}` needs no quoting: exec.mjs never uses a shell, so the argv reaches git verbatim.
  return git(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok
}

/**
 * Make sure a worktree exists at `path`, creating it only if it is not there.
 *
 * @param {object} o
 * @param {string} o.repo        the primary checkout (or any live worktree)
 * @param {string} o.path        where the worktree goes
 * @param {string|null} o.branch branch to check out / create; omit for the default detached tree
 * @param {string} o.baseBranch  ref a new tree starts at, e.g. `<remote>/<baseBranch>`
 * @param {boolean} o.detached   defaults to true unless a branch was asked for
 * @returns {{path, created, reused, branch, head, detached, actions: string[]}}
 */
export function ensureWorktree({ repo, path: worktreePath, branch = null, baseBranch = null, detached = !branch }) {
  if (detached && branch) throw new Error('ensureWorktree: pass either a branch or detached, not both')
  if (!detached && !branch) throw new Error('ensureWorktree: a non-detached worktree needs a branch')
  assertPath('ensureWorktree', 'repo', repo)
  assertPath('ensureWorktree', 'path', worktreePath)
  const repoDir = canonicalPath(repo)
  const target = canonicalPath(worktreePath)
  const existing = findWorktree(listWorktrees(repoDir), target)
  const onDisk = fs.existsSync(target)
  const actions = []

  // ⛔ Reuse, never recreate. A worktree that is still on disk carries a relaunched agent's branch,
  // its commits and its untracked helper files; recreating it destroys work nobody asked to lose.
  if (existing && onDisk) {
    // …but reuse never switches a branch SILENTLY. A relaunch that reassigns this label to another
    // ticket would otherwise commit and push onto the PREVIOUS ticket's branch, with nothing but a
    // returned field nobody compares to say so. Asking for the default detached tree (no branch)
    // stays the ordinary relaunch: whatever the tree already carries is kept.
    if (branch && existing.branch !== branch) {
      const now = existing.branch ? `on branch "${existing.branch}"` : 'on a detached HEAD'
      throw new Error(`ensureWorktree: ${target} is an existing worktree ${now}, but branch "${branch}" was asked for — reuse never checks out over a session's work; check that branch out in the tree yourself, or use another label`)
    }
    return { path: existing.path, created: false, reused: true, branch: existing.branch, head: existing.head, detached: existing.detached, actions: ['reused'] }
  }

  if (!existing && onDisk) {
    if (!isEmptyDir(target)) {
      // Someone's work, a stranded half-installed tree, or a session another launcher owns. Refusing
      // is the only safe answer; the operator reclaims it (kill the holders, then delete).
      throw new Error(`ensureWorktree: ${target} already exists, is not empty, and is not a registered worktree — reclaim it before reusing this label`)
    }
    // An EMPTY leftover folder is not an error. A teardown routinely leaves one behind when a shell's
    // cwd is still inside it: it holds no disk, carries no registration, and git writes into an empty
    // directory happily — treating it as a collision would strand that label for the rest of the run.
    actions.push('reused-empty-directory')
  }

  if (!baseBranch) throw new Error(`ensureWorktree: baseBranch is required to create ${target}`)
  if (!refExists(repoDir, baseBranch)) {
    throw new Error(`ensureWorktree: base ref "${baseBranch}" does not resolve in ${repoDir} — fetch the remote first`)
  }

  const args = ['worktree', 'add']
  if (existing && !onDisk) {
    // A LOCKED registration whose directory is gone is what a testing slot ends up in, and one
    // `--force` does not cover it: git answers "is a missing but locked worktree; use 'add -f -f'"
    // (exit 128) and the operator gets raw git prose instead of an answer. A lock is a deliberate
    // hold, so it is named and refused rather than broken through.
    if (existing.locked) {
      const why = existing.lockReason ? ` (${existing.lockReason})` : ''
      throw new Error(`ensureWorktree: ${target} is registered, its directory is gone, and the registration is LOCKED${why} — one --force does not override a lock; run \`git worktree unlock ${target}\` once you know the holder is finished, then try again`)
    }
    // The registration survived a hand-deleted directory. Force THIS path back into place; ⛔ never
    // `git worktree prune` here — prune is repo-wide and would also deregister a sibling session's
    // tree that happens to be unreadable at this instant.
    args.push('--force')
    actions.push('forced-over-stale-registration')
  }
  if (detached) args.push('--detach', target, baseBranch)
  else if (refExists(repoDir, `refs/heads/${branch}`)) args.push(target, branch)
  else args.push('-b', branch, target, baseBranch)

  gitOrThrow(repoDir, args, { timeoutMs: GIT_TREE_TIMEOUT_MS })

  const after = findWorktree(listWorktrees(repoDir), target)
  if (!after) throw new Error(`ensureWorktree: git reported success but ${target} is not registered`)
  actions.push('created')
  return { path: after.path, created: true, reused: false, branch: after.branch, head: after.head, detached: after.detached, actions }
}

// ---- remove / prune -----------------------------------------------------------------------------

/**
 * Remove a worktree and report what actually happened.
 *
 * ⛔ The exit code is not the answer. `git worktree remove` deregisters AND deletes, and routinely
 * does the first while failing the second because a shell still holds files inside the directory —
 * gigabytes stay on disk while the command reports success. Run again and it says `is not a working
 * tree` (exit 128), which reads like failure and means the registration is already gone. So the
 * truth comes from `git worktree list` plus the filesystem, both taken afterwards.
 *
 * A surviving directory (`deregistered: true, dirExists: true`) is the caller's cue to kill the
 * holders (positively identified — see sys/proc.mjs) and delete the folder, then check again.
 *
 * ⛔ `force` does not cover a LOCK. `git worktree remove --force` on a locked tree exits 128 and
 * changes nothing ("use 'remove -f -f' to override or unlock first"), so a teardown loop that retries
 * while `ok` is false spins forever on git's prose. A lock is the operator holding the tree, and
 * `force` — which means "discard uncommitted work" — is not consent to break that hold, so the lock
 * is reported with its reason and nothing is run.
 * @returns {{path, ok, deregistered, dirExists, code, message}}
 */
export function removeWorktree({ repo, path: worktreePath, force = false }) {
  assertPath('removeWorktree', 'repo', repo)
  assertPath('removeWorktree', 'path', worktreePath)
  const repoDir = canonicalPath(repo)
  const target = canonicalPath(worktreePath)
  const before = findWorktree(listWorktrees(repoDir), target)
  if (before && before.locked) {
    const why = before.lockReason ? ` (${before.lockReason})` : ''
    return {
      path: target,
      ok: false,
      deregistered: false,
      dirExists: fs.existsSync(target),
      code: null,
      message: `worktree is locked${why} — --force does not override a lock; run \`git worktree unlock ${target}\` once the holder is finished, then remove it`,
    }
  }
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(target)
  const r = git(repoDir, args, { timeoutMs: GIT_TREE_TIMEOUT_MS })
  const deregistered = !findWorktree(listWorktrees(repoDir), target)
  const dirExists = fs.existsSync(target)
  return { path: target, ok: deregistered && !dirExists, deregistered, dirExists, code: r.code, message: (r.stderr || r.stdout).trim() }
}

/**
 * Drop registrations whose directories are gone.
 *
 * ⛔ Repo-wide, so only the launcher or the reclaimer ever runs it — a session that prunes
 * deregisters whatever sibling trees were unreadable at that moment.
 *
 * What was pruned comes from diffing two listings rather than parsing `prune -v`, whose output is
 * human prose and translated: a message parser reports nothing on a localised git and the caller
 * concludes the prune did nothing.
 * @returns {{pruned: string[]}}
 */
export function pruneWorktrees(repo) {
  const repoDir = canonicalPath(repo)
  const before = listWorktrees(repoDir)
  gitOrThrow(repoDir, ['worktree', 'prune'], { timeoutMs: GIT_TREE_TIMEOUT_MS })
  const after = listWorktrees(repoDir)
  return { pruned: before.filter(b => !findWorktree(after, b.path)).map(b => b.path) }
}

// ---- leftovers ----------------------------------------------------------------------------------

/**
 * Compile a folder-name template (`repo.sessionDirTemplate`, `repo.slotDirTemplate`) into an
 * ANCHORED RegExp. Known values are substituted and escaped — a repo named `app.web` must not match
 * `app-web` — and what remains becomes a named capture: `{n}` digits, anything else one segment.
 *
 * The anchors ARE the boundary rule: `{repo}-{branch}` with branch `testing` compiles to
 * `^app-testing$`, which never claims `app-testing-2` (a different slot with a live server on it).
 *
 * A placeholder that appears TWICE compiles to a backreference, not to a second free capture: two
 * independent groups let `{repo}-{branch}-{branch}` match `app-testing-staging`, and in a module whose
 * whole thesis is that the compiled pattern is the boundary rule, that is a false leftover.
 */
export function templatePattern(template, vars = {}) {
  const used = new Map() // capture name -> the placeholder that owns it
  let src = '^'
  for (const part of String(template).split(/(\{[a-zA-Z0-9_-]+\})/)) {
    if (!part) continue
    const m = /^\{([a-zA-Z0-9_-]+)\}$/.exec(part)
    if (!m) {
      src += escapeRegex(part)
      continue
    }
    const name = m[1]
    if (vars[name] !== undefined && vars[name] !== null) {
      src += escapeRegex(String(vars[name]))
      continue
    }
    const body = name === 'n' ? '\\d+' : '[^\\\\/]+'
    const group = name.replace(/[^A-Za-z0-9_]/g, '_')
    // A capture name is an identifier, so `{2fa}` would make `new RegExp` throw a bare SyntaxError
    // three frames from the config key that caused it. Name the template instead.
    if (!/^[A-Za-z_]/.test(group)) {
      throw new Error(`templatePattern: placeholder {${name}} in "${template}" cannot name a capture group — a placeholder must start with a letter or underscore (repo.sessionDirTemplate / repo.slotDirTemplate / repo.checkerDirTemplate)`)
    }
    const owner = used.get(group)
    if (owner === name) src += `\\k<${group}>` // the SAME placeholder again: the same text, not another value
    else if (owner !== undefined) {
      throw new Error(`templatePattern: placeholders {${owner}} and {${name}} in "${template}" both compile to the capture group "${group}" — rename one`)
    } else {
      used.set(group, name)
      src += `(?<${group}>${body})`
    }
  }
  return new RegExp(`${src}$`)
}

/**
 * Which of `names` look like fleet worktrees but are not registered? PURE — `parent` and every
 * `registered` path must already be canonical (sweepLeftovers does that), because a lexical compare
 * of `/var/...` against git's `/private/var/...` would report every LIVE worktree as a leftover.
 * @returns {Array<{name, path, vars}>}
 */
export function leftoversFrom({ parent, names, pattern, registered = [], platform = process.platform }) {
  const re = pattern instanceof RegExp ? pattern : templatePattern(pattern)
  const P = platform === 'win32' ? path.win32 : path.posix
  const taken = new Set(registered.map(r => normalizePath(typeof r === 'string' ? r : r.path, platform)))
  const out = []
  for (const name of names) {
    const m = re.exec(name)
    if (!m) continue
    const full = P.join(parent, name)
    // Whole-path membership, never a prefix test: `<parent>/app-session-1` being registered must not
    // make `<parent>/app-session-10` look registered too.
    if (taken.has(normalizePath(full, platform))) continue
    out.push({ name, path: full, vars: { ...(m.groups || {}) } })
  }
  return out.sort((a, b) => {
    const an = Number(a.vars.n)
    const bn = Number(b.vars.n)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * Does this readdir entry hold a directory?
 *
 * ⛔ Not `dirent.isDirectory()` alone: that is lstat-based and answers FALSE for a symlink or a
 * Windows junction, while `ensureWorktree` tests the same name with `fs.existsSync`, which follows
 * one. A junction named `app-session-5` therefore occupies the label — the sweep must show it, or the
 * operator meets "already exists, is not empty" for a leftover nothing ever reported. A DANGLING link
 * is not a leftover: there is no tree behind it to reclaim.
 */
function holdsADirectory(parent, d) {
  if (d.isDirectory()) return true
  if (!d.isSymbolicLink()) return false
  try {
    return fs.statSync(path.join(parent, d.name)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Directories under `parent` that look like fleet worktrees but git no longer knows about — the
 * stranded folders a `git worktree remove` deregistered and failed to delete. Capacity and session
 * numbering both have to see these: a folder git has forgotten still collides with a new session of
 * the same name, and counting only registered worktrees numbers a session straight into one.
 *
 * A missing parent is not an error — nothing has been created yet on a first run.
 * @param {{parent: string, pattern: RegExp|string, registered: Array<string|{path: string}>}} o
 */
export function sweepLeftovers({ parent, pattern, registered = [] }) {
  const dir = canonicalPath(parent)
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => holdsADirectory(dir, d)).map(d => d.name)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return leftoversFrom({
    parent: dir,
    names,
    pattern,
    registered: registered.map(r => canonicalPath(typeof r === 'string' ? r : r.path)),
  })
}
