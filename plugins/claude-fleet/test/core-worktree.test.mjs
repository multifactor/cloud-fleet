import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run } from '../src/sys/exec.mjs'
import {
  primaryRoot, listWorktrees, parseWorktreeList, findWorktree, ensureWorktree, removeWorktree,
  pruneWorktrees, sweepLeftovers, leftoversFrom, templatePattern, samePath, canonicalPath,
} from '../src/core/worktree.mjs'

// Real repositories in a temp dir — git is never mocked, because every trap in this module is a
// behaviour of git itself (what `add` accepts, what `remove` half-does, what `list` prints).

const G = (cwd, ...args) => {
  const r = run('git', args, { cwd })
  if (!r.ok) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** @returns {{root: string, primary: string, name: string}} root is NOT realpath'd on purpose. */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wt-'))
  const primary = path.join(root, 'app')
  fs.mkdirSync(primary)
  // `-b` fixes the branch name on any git that has it; older ones get the same result explicitly.
  if (!run('git', ['init', '-q', '-b', 'main'], { cwd: primary }).ok) {
    G(primary, 'init', '-q')
    G(primary, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  }
  // A bare CI runner has no git identity, and a contributor's machine may sign every commit.
  G(primary, 'config', 'user.email', 'ada@example.com')
  G(primary, 'config', 'user.name', 'ada')
  G(primary, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(primary, 'README.md'), '# app\n')
  G(primary, 'add', '-A')
  G(primary, 'commit', '-q', '-m', 'first')
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { root, primary, name: 'app' }
}

const at = (root, name) => path.join(root, name)
const assertSame = (a, b, msg) => assert.ok(samePath(canonicalPath(a), canonicalPath(b)), msg || `${a} != ${b}`)

/**
 * Run `fn` with git's repository search fenced just above `dir`, and with an inherited GIT_DIR /
 * GIT_WORK_TREE cleared — run() hands `process.env` straight to git, so "this directory is not a
 * repository" is otherwise an assertion about the contributor's machine (a TMPDIR that happens to sit
 * inside a checkout makes git find that one and the test fails with no hint why).
 */
function outsideAnyRepository(dir, fn) {
  const saved = ['GIT_CEILING_DIRECTORIES', 'GIT_DIR', 'GIT_WORK_TREE'].map(k => [k, process.env[k]])
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir)
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ---- listing ------------------------------------------------------------------------------------

test('primaryRoot answers the MAIN checkout from inside a linked worktree, and null outside a repo', t => {
  const { root, primary } = makeRepo(t)
  const wt = at(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: wt, baseBranch: 'main' })
  // `rev-parse --show-toplevel` from here would answer the session's own tree, and every path
  // derived from it would hang off a directory the reclaimer later deletes.
  assertSame(primaryRoot(wt), primary)
  assertSame(primaryRoot(primary), primary)
  assert.equal(outsideAnyRepository(root, () => primaryRoot(root)), null, 'the worktree parent is not itself a repository')
})

test('listWorktrees reports each real git state: branch, detached, locked, prunable', t => {
  const { root, primary } = makeRepo(t)
  ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: at(root, 'app-testing'), branch: 'testing', baseBranch: 'main' })
  G(primary, 'worktree', 'lock', '--reason', 'held by the operator', at(root, 'app-testing'))
  const gone = at(root, 'app-session-2')
  ensureWorktree({ repo: primary, path: gone, baseBranch: 'main' })
  fs.rmSync(gone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  const list = listWorktrees(primary)
  assert.equal(list.length, 4)
  assertSame(list[0].path, primary, 'the main checkout is always the first record')
  assert.equal(list[0].branch, 'main')
  assert.equal(findWorktree(list, at(root, 'app-session-1')).detached, true)
  assert.equal(findWorktree(list, at(root, 'app-session-1')).branch, null)
  const slot = findWorktree(list, at(root, 'app-testing'))
  assert.equal(slot.branch, 'testing')
  assert.equal(slot.locked, true)
  assert.equal(slot.lockReason, 'held by the operator')
  // a hand-deleted directory keeps its registration — the folder is gone, the capacity is not
  assert.equal(findWorktree(list, gone).prunable, true)

  assert.throws(() => outsideAnyRepository(root, () => listWorktrees(root)), /git worktree list failed/)
})

test('parseWorktreeList keeps the last record when the output has no trailing blank line', () => {
  // A parser that flushes only on a blank line drops the FINAL worktree — always the newest session,
  // so the launcher would create a second worktree on top of the one it just made.
  const entries = parseWorktreeList([
    'worktree /w/app',
    'HEAD ' + 'a'.repeat(40),
    'branch refs/heads/main',
    '',
    'worktree /w/app-session-1',
    'HEAD ' + 'b'.repeat(40),
    'detached',
  ].join('\n'))
  assert.equal(entries.length, 2)
  assert.equal(entries[1].path, '/w/app-session-1')
  assert.equal(entries[1].detached, true)
  assert.equal(entries[1].branch, null)
  // a bare main checkout carries neither HEAD nor branch
  const bare = parseWorktreeList('worktree /w/app.git\nbare\n')
  assert.deepEqual([bare.length, bare[0].bare, bare[0].head], [1, true, null])
})

// ---- create / reuse -----------------------------------------------------------------------------

test('a worktree is created DETACHED at the base ref, so an unstarted session leaves no branch', t => {
  const { root, primary } = makeRepo(t)
  const r = ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), baseBranch: 'main' })
  assert.deepEqual([r.created, r.reused, r.detached, r.branch], [true, false, true, null])
  assert.deepEqual(r.actions, ['created'])
  assert.equal(r.head, G(primary, 'rev-parse', 'main'))
  assert.equal(G(primary, 'branch', '--format=%(refname:short)'), 'main', 'no branch was created')
  assert.throws(
    () => ensureWorktree({ repo: primary, path: at(root, 'app-session-2'), baseBranch: 'origin/main' }),
    /base ref "origin\/main" does not resolve/,
    'an unfetched base ref is named, not left to git to explain',
  )
})

test('an existing worktree is REUSED — its branch, its commits and its untracked helpers survive', t => {
  const { root, primary } = makeRepo(t)
  const wt = at(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: wt, branch: 'ada/abc-1234-fix', baseBranch: 'main' })
  fs.writeFileSync(path.join(wt, 'notes.md'), 'session scratch\n')
  fs.writeFileSync(path.join(wt, 'README.md'), '# app\nedited\n')
  G(wt, 'commit', '-qam', 'work in progress')
  const head = G(wt, 'rev-parse', 'HEAD')

  // the relaunch case: same label, same folder, a fresh spawn asking for the default detached tree
  const again = ensureWorktree({ repo: primary, path: wt, baseBranch: 'main' })
  assert.deepEqual([again.created, again.reused], [false, true])
  assert.equal(again.branch, 'ada/abc-1234-fix', 'the reused tree keeps its own branch')
  assert.equal(again.head, head, 'its commits are still there')
  assert.equal(fs.readFileSync(path.join(wt, 'notes.md'), 'utf8'), 'session scratch\n')
})

test('reuse never switches a branch silently — a relaunch onto a NEW ticket is named and refused', t => {
  const { root, primary } = makeRepo(t)
  const wt = at(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: wt, branch: 'ada/abc-1234-a', baseBranch: 'main' })
  // Reusing the tree for a different ticket would commit and push onto the PREVIOUS ticket's branch.
  assert.throws(
    () => ensureWorktree({ repo: primary, path: wt, branch: 'ada/abc-9999-b', baseBranch: 'main' }),
    /but branch "ada\/abc-9999-b" was asked for/,
  )
  assert.equal(G(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ada/abc-1234-a', 'the refusal checked nothing out')
  // asking for the branch it is already on is the ordinary relaunch
  const same = ensureWorktree({ repo: primary, path: wt, branch: 'ada/abc-1234-a', baseBranch: 'main' })
  assert.deepEqual([same.reused, same.branch], [true, 'ada/abc-1234-a'])
})

test('ensureWorktree and removeWorktree refuse a missing or empty path instead of taking the cwd', t => {
  const { root, primary } = makeRepo(t)
  // `path.resolve('')` is the process cwd and `path.resolve(undefined)` is <cwd>/undefined: a config
  // key that went missing must not become `git worktree remove <the launcher's own checkout>`.
  assert.throws(() => removeWorktree({ repo: primary, path: '' }), /removeWorktree: path must be a non-empty path/)
  assert.throws(() => removeWorktree({ repo: '', path: at(root, 'app-session-1') }), /removeWorktree: repo must be a non-empty path/)
  assert.throws(() => ensureWorktree({ repo: primary, path: undefined, baseBranch: 'main' }), /ensureWorktree: path must be a non-empty path/)
  assert.throws(() => ensureWorktree({ repo: null, path: at(root, 'app-session-1'), baseBranch: 'main' }), /ensureWorktree: repo must be a non-empty path/)
  assert.equal(fs.existsSync(path.join(process.cwd(), 'undefined')), false)

  // the two argument guards: a worktree is detached or on a branch, never both and never neither
  assert.throws(
    () => ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), branch: 'ada/abc-1234-a', detached: true, baseBranch: 'main' }),
    /either a branch or detached, not both/,
  )
  assert.throws(
    () => ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), detached: false, baseBranch: 'main' }),
    /non-detached worktree needs a branch/,
  )
})

test('a LOCKED worktree is named, not left to git: one --force covers neither repair nor removal', t => {
  const { root, primary } = makeRepo(t)
  const slot = at(root, 'app-testing')
  ensureWorktree({ repo: primary, path: slot, branch: 'testing', baseBranch: 'main' })
  G(primary, 'worktree', 'lock', '--reason', 'the operator is testing on it', slot)

  // `--force` is "discard uncommitted work", never "break the operator's hold": git would exit 128
  // ("use 'remove -f -f'") and a teardown loop retrying while ok is false would spin forever.
  const refused = removeWorktree({ repo: primary, path: slot, force: true })
  assert.deepEqual([refused.ok, refused.deregistered, refused.dirExists], [false, false, true])
  assert.match(refused.message, /locked \(the operator is testing on it\)/)
  assert.match(refused.message, /git worktree unlock/, 'the operator is told what to do')
  assert.ok(findWorktree(listWorktrees(primary), slot), 'the lock held')

  // The missing-but-locked state a slot lands in: the folder is gone, the lock is not. `add --force`
  // exits 128 here ("use 'add -f -f' to override"), so the answer names the lock instead.
  fs.rmSync(slot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.throws(
    () => ensureWorktree({ repo: primary, path: slot, branch: 'testing', baseBranch: 'main' }),
    /LOCKED \(the operator is testing on it\)[\s\S]*git worktree unlock/,
  )

  // and once the operator unlocks it, the same call repairs the slot
  G(primary, 'worktree', 'unlock', slot)
  const repaired = ensureWorktree({ repo: primary, path: slot, branch: 'testing', baseBranch: 'main' })
  assert.deepEqual(repaired.actions, ['forced-over-stale-registration', 'created'])
  assert.equal(repaired.branch, 'testing')
})

test('an EMPTY leftover directory is reused; a non-empty stranded one is refused, never overwritten', t => {
  const { root, primary } = makeRepo(t)
  // A teardown leaves an empty folder behind whenever a shell's cwd is still inside it: no disk, no
  // registration. Erroring on it would strand that label for the rest of the run.
  const empty = at(root, 'app-session-1')
  fs.mkdirSync(empty)
  const r = ensureWorktree({ repo: primary, path: empty, baseBranch: 'main' })
  assert.deepEqual(r.actions, ['reused-empty-directory', 'created'])
  assert.ok(fs.existsSync(path.join(empty, '.git')))

  const stranded = at(root, 'app-session-2')
  fs.mkdirSync(stranded)
  fs.writeFileSync(path.join(stranded, 'unreviewed.patch'), 'someone\'s work\n')
  assert.throws(
    () => ensureWorktree({ repo: primary, path: stranded, baseBranch: 'main' }),
    /is not empty, and is not a registered worktree/,
  )
  assert.ok(fs.existsSync(path.join(stranded, 'unreviewed.patch')), 'the refusal touched nothing')
})

test('a stale registration is forced back for THAT path only — a repo-wide prune would take a sibling', t => {
  const { root, primary } = makeRepo(t)
  const mine = at(root, 'app-session-1')
  const sibling = at(root, 'app-session-2')
  ensureWorktree({ repo: primary, path: mine, baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: sibling, baseBranch: 'main' })
  // both directories are momentarily gone; only one of them is ours to repair
  for (const p of [mine, sibling]) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  const r = ensureWorktree({ repo: primary, path: mine, baseBranch: 'main' })
  assert.deepEqual(r.actions, ['forced-over-stale-registration', 'created'])
  assert.ok(fs.existsSync(path.join(mine, '.git')))
  assert.ok(findWorktree(listWorktrees(primary), sibling), 'the sibling registration survived')
})

// ---- remove / prune -----------------------------------------------------------------------------

test('removal is judged by `git worktree list` and the filesystem, never by the exit code', t => {
  const { root, primary } = makeRepo(t)
  const wt = at(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: wt, baseBranch: 'main' })

  const first = removeWorktree({ repo: primary, path: wt })
  assert.deepEqual([first.ok, first.deregistered, first.dirExists], [true, true, false])

  // Run again and git fails (exit 128, "is not a working tree") — which reads like failure and means
  // the registration was already gone. ⛔ The message is NOT asserted: git's prose is translated, and
  // pinning it here would teach the opposite of the rule this module exists to enforce.
  const second = removeWorktree({ repo: primary, path: wt })
  assert.notEqual(second.code, 0)
  assert.deepEqual([second.ok, second.deregistered], [true, true])

  // The other half of the same trap: deregistered, directory still on disk because something held
  // files inside it. `ok` must stay false — the caller kills the holders and deletes the folder.
  fs.mkdirSync(wt)
  fs.writeFileSync(path.join(wt, 'held.log'), 'x')
  const survivor = removeWorktree({ repo: primary, path: wt })
  assert.deepEqual([survivor.ok, survivor.deregistered, survivor.dirExists], [false, true, true])
})

test('removal without --force refuses a tree with uncommitted work and leaves it whole', t => {
  const { root, primary } = makeRepo(t)
  const wt = at(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: wt, baseBranch: 'main' })
  fs.writeFileSync(path.join(wt, 'notes.md'), 'not committed anywhere\n')

  const refused = removeWorktree({ repo: primary, path: wt })
  assert.deepEqual([refused.ok, refused.deregistered, refused.dirExists], [false, false, true])
  assert.equal(fs.readFileSync(path.join(wt, 'notes.md'), 'utf8'), 'not committed anywhere\n')
  assert.ok(findWorktree(listWorktrees(primary), wt), 'still registered, so capacity is unchanged')

  const forced = removeWorktree({ repo: primary, path: wt, force: true })
  assert.deepEqual([forced.ok, forced.deregistered, forced.dirExists], [true, true, false])
})

test('pruneWorktrees reports the registrations that actually disappeared', t => {
  const { root, primary } = makeRepo(t)
  const gone = at(root, 'app-session-1')
  const live = at(root, 'app-session-2')
  ensureWorktree({ repo: primary, path: gone, baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: live, baseBranch: 'main' })
  fs.rmSync(gone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  // Diffing two listings rather than parsing `prune -v`, whose prose is translated.
  const { pruned } = pruneWorktrees(primary)
  assert.equal(pruned.length, 1)
  assertSame(pruned[0], gone)
  assert.ok(findWorktree(listWorktrees(primary), live))
})

// ---- leftovers ----------------------------------------------------------------------------------

test('the sweep matches on a boundary: app-session-1 never claims app-session-10, nor app-testing app-testing-2', t => {
  const { root, primary } = makeRepo(t)
  ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: at(root, 'app-testing-2'), branch: 'testing-2', baseBranch: 'main' })
  fs.mkdirSync(at(root, 'app-session-10')) // deregistered by a removal that failed to delete
  fs.mkdirSync(at(root, 'app-testing'))    // ditto, for slot 1
  fs.mkdirSync(at(root, 'app-testing-3'))  // ditto, for slot 3 — git has forgotten this one entirely
  fs.mkdirSync(at(root, 'scratch'))
  fs.writeFileSync(at(root, 'app-session-9'), 'a file, not a worktree')
  const registered = listWorktrees(primary).map(w => w.path)

  const sessions = sweepLeftovers({ parent: root, pattern: templatePattern('{repo}-session-{n}', { repo: 'app' }), registered })
  assert.deepEqual(sessions.map(l => l.name), ['app-session-10'])
  assert.equal(sessions[0].vars.n, '10', 'the number is captured, so numbering can skip leftovers')

  // ⛔ Slot 3 is the assertion that bites: it is UNREGISTERED, so only the `$` anchor keeps it out of
  // slot 1's sweep. (Slot 2 is registered, and would be dropped by the registered-path filter even if
  // the pattern had no anchor at all — which is why it cannot carry this test on its own.)
  const slot1 = sweepLeftovers({ parent: root, pattern: templatePattern('{repo}-{branch}', { repo: 'app', branch: 'testing' }), registered })
  assert.deepEqual(slot1.map(l => l.name), ['app-testing'], 'slot 1 claims neither slot 2 (live server) nor slot 3')

  // the registered case, kept on its own: a pattern that DOES match the numbered slots still skips
  // the one git knows about, because a live slot is not a leftover.
  const numbered = sweepLeftovers({ parent: root, pattern: templatePattern('{repo}-{branch}-{n}', { repo: 'app', branch: 'testing' }), registered })
  assert.deepEqual(numbered.map(l => l.name), ['app-testing-3'], 'slot 2 is registered, so it is not a leftover')

  assert.deepEqual(sweepLeftovers({ parent: at(root, 'never-created'), pattern: /^app-session-\d+$/, registered }), [])
})

test('a leftover sweep through an unresolved parent path does not report LIVE worktrees', t => {
  const { root, primary } = makeRepo(t)
  ensureWorktree({ repo: primary, path: at(root, 'app-session-1'), baseBranch: 'main' })
  const link = path.join(path.dirname(root), `${path.basename(root)}-link`)
  try {
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('this environment does not allow creating a link')
    return
  }
  t.after(() => fs.rmSync(link, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  // git records the resolved path (this is the shape of the macOS /var → /private/var temp dir, and
  // of a Windows 8.3 short name). A lexical compare would call every live worktree a leftover, and
  // whatever cleans up after the sweep would delete a session mid-ticket.
  const found = sweepLeftovers({
    parent: path.join(link, '.'),
    pattern: templatePattern('{repo}-session-{n}', { repo: 'app' }),
    registered: listWorktrees(primary).map(w => w.path),
  })
  assert.deepEqual(found, [])
})

test('the sweep sees a junction that holds a directory — dirent.isDirectory() is lstat and says no', t => {
  const { root, primary } = makeRepo(t)
  const elsewhere = at(root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.writeFileSync(path.join(elsewhere, 'half-installed.txt'), 'gigabytes, in spirit\n')
  const label = at(root, 'app-session-5')
  try {
    fs.symlinkSync(elsewhere, label, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('this environment does not allow creating a link')
    return
  }
  const pattern = templatePattern('{repo}-session-{n}', { repo: 'app' })
  const registered = listWorktrees(primary).map(w => w.path)
  // ensureWorktree tests the same name with existsSync, which FOLLOWS the link: the label is taken,
  // so a sweep that skipped the link would refuse a session over a leftover it never showed.
  assert.throws(
    () => ensureWorktree({ repo: primary, path: label, baseBranch: 'main' }),
    /is not empty, and is not a registered worktree/,
  )
  assert.deepEqual(sweepLeftovers({ parent: root, pattern, registered }).map(l => l.name), ['app-session-5'])

  // a DANGLING link holds no tree, so there is nothing to reclaim and it is not reported
  fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  assert.deepEqual(sweepLeftovers({ parent: root, pattern, registered }), [])
})

test('templatePattern: a repeated placeholder is one value, and an unusable capture name is named', () => {
  // Two independent groups would let `{repo}-{branch}-{branch}` match app-testing-staging, and the
  // compiled pattern IS the boundary rule — a mismatched pair is a false leftover.
  const re = templatePattern('{repo}-{branch}-{branch}', { repo: 'app' })
  assert.ok(re.test('app-testing-testing'), 'the same placeholder twice means the same text twice')
  assert.ok(!re.test('app-testing-staging'))
  // ⛔ `new RegExp` would throw a bare SyntaxError three frames from the config key that caused it.
  assert.throws(
    () => templatePattern('{repo}-{2fa}', { repo: 'app' }),
    /placeholder \{2fa\}[\s\S]*must start with a letter or underscore/,
  )
  assert.throws(() => templatePattern('{a-b}-{a_b}'), /both compile to the capture group "a_b"/)
})

test('templatePattern anchors and escapes: a repo named app.web does not match app-web', () => {
  const re = templatePattern('{repo}-session-{n}', { repo: 'app.web' })
  assert.ok(re.test('app.web-session-3'))
  assert.ok(!re.test('app-web-session-3'), 'the substituted value is regex-escaped')
  assert.ok(!re.test('app.web-session-3x'), '{n} is digits only')
  assert.ok(!re.test('old-app.web-session-3'), 'anchored at both ends')
  assert.equal(templatePattern('{repo}-session-{n}', { repo: 'app' }).exec('app-session-7').groups.n, '7')
  assert.equal(templatePattern('{repo}-check-{slice}', { repo: 'app' }).exec('app-check-ui').groups.slice, 'ui')
})

test('path comparison is whole, separator-blind, and case-blind only where the OS is', () => {
  // git prints `C:/w/app-session-1`; Node builds `C:\w\app-session-1`. A naive compare says
  // "not registered" and the launcher creates a second worktree on top of a live session.
  assert.ok(samePath('C:/w/app-session-1', 'C:\\w\\app-session-1', 'win32'))
  assert.ok(samePath('C:/W/App-Session-1', 'c:/w/app-session-1', 'win32'))
  assert.ok(!samePath('/w/app-session-1', '/w/app-session-10', 'linux'))
  assert.ok(!samePath('/w/app-testing', '/w/app-testing-2', 'linux'))
  assert.ok(samePath('/w/app-session-1/', '/w/app-session-1', 'linux'))
  assert.ok(!samePath('/w/App-Session-1', '/w/app-session-1', 'linux'), 'POSIX paths are case-sensitive')
})

test('leftoversFrom is pure and orders by session number, not by readdir order', () => {
  const found = leftoversFrom({
    parent: '/w',
    names: ['app-session-10', 'app-session-2', 'app-session-1', 'notes'],
    pattern: templatePattern('{repo}-session-{n}', { repo: 'app' }),
    registered: ['/w/app-session-1'],
    platform: 'linux',
  })
  assert.deepEqual(found.map(l => l.name), ['app-session-2', 'app-session-10'])
  assert.equal(found[0].path, '/w/app-session-2')
})
