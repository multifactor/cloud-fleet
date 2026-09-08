import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  verdictFromCounts, repairPlan, readyState, scanTree, countFiles, lockfileHashOf,
  snapshotReference, verifyInstall, writeReadySentinel, clearReadySentinel, readSentinel,
  observeWorktree, readyFlagPath, referenceFile, installOne, runInstalls, BOOTSTRAP_TIMEOUT_MS,
} from '../src/core/install.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'

const GB = 1024 ** 3
const T0 = Date.parse('2026-03-14T10:00:00Z')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-install-'))

const cfg = (stateDir, over = {}) => {
  const c = defaultsFor()
  setPath(c, 'commands.bootstrap', 'npm install')
  setPath(c, 'paths.stateDir', stateDir)
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

/** Build a checkout: `{ 'node_modules/react': 12 }` → that directory with 12 files in it. */
function makeTree(root, spec, { lockfile = '{"lockfileVersion":3}' } = {}) {
  fs.mkdirSync(root, { recursive: true })
  if (lockfile !== null) fs.writeFileSync(path.join(root, 'package-lock.json'), lockfile)
  for (const [pkg, count] of Object.entries(spec)) {
    const dir = path.join(root, ...pkg.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'module.exports = {}\n')
  }
  return root
}

const asObject = m => Object.fromEntries(m)

// ---- the verdict ----------------------------------------------------------------------------------

test('a half-extracted package hides inside the aggregate — only the per-package gate sees it', () => {
  // 2,700 packages, one of them extracted to an empty directory. The aggregate barely moves, so an
  // aggregate ratio passes the 0.98 tolerance while the tree cannot build.
  const reference = {}
  const actual = {}
  for (let i = 0; i < 2700; i++) {
    reference[`node_modules/p${i}`] = 100
    actual[`node_modules/p${i}`] = 100
  }
  actual['node_modules/p42'] = 0 // the interrupted extract: the directory exists, the files do not

  const v = verdictFromCounts(actual, reference, 0.98)
  assert.equal(v.ok, false)
  assert.ok(v.aggregateRatio > 0.98, 'the aggregate ratio still passes the tolerance — that is the trap')
  assert.deepEqual(v.damaged.map(d => d.pkg), ['node_modules/p42'])
  assert.equal(v.damaged[0].actual, 0)
  assert.equal(v.worstRatio, 0)
  assert.match(v.reason, /half-extracted/)
})

test('a package the reference does not have is not damage — a live primary carries files a fresh tree never will', () => {
  const reference = { 'node_modules/a': 10, 'node_modules/b': 10 }
  const ok = verdictFromCounts({ 'node_modules/a': 12, 'node_modules/b': 10, 'node_modules/only-here': 400 }, reference, 0.98)
  assert.equal(ok.ok, true)
  // a package present in the reference and absent in the tree IS damage
  const gone = verdictFromCounts({ 'node_modules/a': 10 }, reference, 0.98)
  assert.deepEqual(gone.missing, ['node_modules/b'])
  assert.equal(gone.worstRatio, 0)
})

test('an empty reference, or a zero tolerance, certifies everything — so both are refusals', () => {
  // A reference captured while the primary was mid-install would otherwise pass every broken tree.
  const empty = verdictFromCounts({ 'node_modules/a': 0 }, {}, 0.98)
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /reference tree is empty/)

  const zero = verdictFromCounts({ 'node_modules/a': 0 }, { 'node_modules/a': 500 }, 0)
  assert.equal(zero.ok, false)
  assert.match(zero.reason, /tolerance must be greater than 0/)
})

test('repair deletes the damaged package directories, never a tree root', () => {
  // The tree roots are in the REFERENCE, which is what repairPlan() derives its keys from — putting
  // them only in `actual` would make the guard unreachable and this test a tautology.
  const v = verdictFromCounts(
    { 'node_modules/a': 0 },
    { 'node_modules': 900_000, 'packages/pkg-a/node_modules': 12, 'node_modules/a': 10, 'node_modules/b': 5 },
    0.98,
  )
  assert.deepEqual(v.missing, ['node_modules', 'packages/pkg-a/node_modules', 'node_modules/b'], 'both roots reach the verdict as missing')
  const plan = repairPlan(v, '/w/app-session-3')
  // only the packages: deleting either root turns a one-package repair into a full rebuild, and the
  // nested one is a workspace tree whose links point back at the primary
  assert.deepEqual(plan.map(p => p.split(path.sep).join('/')), ['/w/app-session-3/node_modules/b', '/w/app-session-3/node_modules/a'])
})

// ---- scanning -------------------------------------------------------------------------------------

test('the scan reaches NESTED node_modules — a root-only scan misses exactly the tree that breaks a build', () => {
  const root = tmp()
  const primary = makeTree(path.join(root, 'app'), {
    'node_modules/react': 20,
    'node_modules/@scope/ui': 8,
    'packages/pkg-a/node_modules/typescript': 40, // the nested copy the compiler resolves through
  })
  const worktree = makeTree(path.join(root, 'app-session-1'), {
    'node_modules/react': 20,
    'node_modules/@scope/ui': 8,
    'packages/pkg-a/node_modules/typescript': 2, // interrupted mid-extract
  })

  const ref = scanTree(primary)
  assert.deepEqual([...ref.keys()].sort(), ['node_modules/@scope/ui', 'node_modules/react', 'packages/pkg-a/node_modules/typescript'])
  assert.equal(ref.get('packages/pkg-a/node_modules/typescript'), 40)

  // a root-only comparison — the mistake — passes this tree
  const rootOnly = Object.fromEntries([...ref].filter(([k]) => k.startsWith('node_modules/')))
  assert.equal(verdictFromCounts(scanTree(worktree), rootOnly, 0.98).ok, true)
  // the full scan catches it, and names the nested package
  const full = verdictFromCounts(scanTree(worktree), asObject(ref), 0.98)
  assert.equal(full.ok, false)
  assert.deepEqual(full.damaged.map(d => d.pkg), ['packages/pkg-a/node_modules/typescript'])
})

test('a nested tree is never double counted inside its parent package', () => {
  const root = tmp()
  const app = makeTree(path.join(root, 'app'), {
    'node_modules/big': 5,
    'node_modules/big/node_modules/small': 7,
  })
  const counts = scanTree(app)
  assert.equal(counts.get('node_modules/big'), 5, 'the parent counts only its own files')
  assert.equal(counts.get('node_modules/big/node_modules/small'), 7)
})

test('the walk never follows a workspace link — following one has emptied a primary', () => {
  const root = tmp()
  const app = makeTree(path.join(root, 'app'), {
    'packages/pkg-a/src': 50,      // the real workspace package
    'node_modules/@scope': 0,   // the scope directory is real
    'node_modules/small': 2,
  })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  // the workspace link every monorepo install creates: node_modules/@scope/ui → packages/pkg-a
  fs.symlinkSync(path.join(app, 'packages', 'pkg-a'), path.join(app, 'node_modules', '@scope', 'ui'), linkType)
  // and a link INSIDE a package, which must count as one entry rather than its target's whole tree
  fs.symlinkSync(path.join(app, 'packages', 'pkg-a'), path.join(app, 'node_modules', 'small', 'linked'), linkType)

  const counts = scanTree(app)
  assert.ok(!counts.has('node_modules/@scope/ui'), 'a link is not a package of this tree')
  assert.equal(counts.get('node_modules/small'), 3, '2 files + the link itself, never the 50 files behind it')
})

test('volatile dot directories are skipped, .bin is not', () => {
  const root = tmp()
  const app = makeTree(path.join(root, 'app'), {
    'node_modules/.bin': 4,
    'node_modules/.cache': 6, // a live primary accumulates these; a fresh worktree never has them
    'node_modules/react': 3,
  })
  const counts = scanTree(app)
  assert.deepEqual([...counts.keys()].sort(), ['node_modules/.bin', 'node_modules/react'])
  assert.equal(counts.get('node_modules/.bin'), 4)
  // a fresh tree without the cache still matches the primary
  const fresh = makeTree(path.join(root, 'app-session-1'), { 'node_modules/.bin': 4, 'node_modules/react': 3 })
  assert.equal(verdictFromCounts(scanTree(fresh), asObject(counts), 0.98).ok, true)
})

test('countFiles ignores a nested node_modules and counts a link as one entry', () => {
  const root = tmp()
  const pkg = makeTree(path.join(root, 'pkg'), { 'lib': 3, 'node_modules/dep': 100 }, { lockfile: null })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(path.join(pkg, 'node_modules', 'dep'), path.join(pkg, 'lib', 'linked'), linkType)
  assert.equal(countFiles(pkg), 4, '3 files + the link itself — never the 100 files behind it, and never the nested tree')
})

test('a dot directory inside node_modules is not walked, so a cache never enters the counts', () => {
  const root = tmp()
  // a bundler cache on a live primary that happens to carry a vendored tree of its own
  const app = makeTree(path.join(root, 'app'), {
    'node_modules/react': 3,
    'node_modules/.cache/x/node_modules/dep': 40,
  })
  const counts = scanTree(app)
  assert.deepEqual([...counts.keys()].sort(), ['node_modules/react'])
  // and a fresh worktree, which has no cache at all, still matches the primary
  const fresh = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 3 })
  assert.equal(verdictFromCounts(scanTree(fresh), asObject(counts), 0.98).ok, true)
})

// ---- the reference --------------------------------------------------------------------------------

test('the reference is keyed by lockfile hash: it is reused for the same lockfile and rebuilt when it changes', () => {
  const root = tmp()
  const state = path.join(root, 'state')
  const c = cfg(state)
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 5 })

  const first = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(first.fromCache, false)
  assert.equal(first.usable, true)
  assert.equal(first.packageCount, 1)
  assert.ok(fs.existsSync(referenceFile(c)))

  const second = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(second.fromCache, true, 'the same lockfile reuses the snapshot rather than rescanning')

  // one byte of lockfile change reshapes the tree, so the cache must miss
  fs.writeFileSync(path.join(primary, 'package-lock.json'), '{"lockfileVersion":3,"x":1}')
  makeTree(primary, { 'node_modules/left-pad': 2 }, { lockfile: null })
  const third = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(third.fromCache, false)
  assert.equal(third.packageCount, 2)
  assert.notEqual(third.lockfileHash, first.lockfileHash)
})

test('a reference captured from an uninstalled primary is unusable and is never cached', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), {}) // lockfile, no node_modules yet
  const ref = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(ref.usable, false)
  assert.match(ref.reason, /not installed/)
  assert.equal(fs.existsSync(referenceFile(c)), false, 'caching an empty reference would certify every broken tree')
  // and it cannot be used as proof afterwards
  assert.equal(verifyInstall(primary, ref, c).ok, false)
})

// ---- verification and the sentinel ------------------------------------------------------------------

test('the headline: the install exits 0 over a half-extracted tree, and no sentinel is written', async () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 20, 'packages/pkg-a/node_modules/typescript': 40 })
  const reference = snapshotReference(primary, c, { now: () => T0 })
  const worktree = path.join(root, 'app-session-3')

  // The interrupted install, then a re-run: the package manager sees the directory and calls it
  // installed, so the second run re-extracts nothing and exits 0.
  const run = () => {
    makeTree(worktree, { 'node_modules/react': 20, 'packages/pkg-a/node_modules/typescript': 0 })
    return { ok: true, code: 0 }
  }
  const r = await installOne({ label: '3', worktree }, { config: c, reference, run, now: () => T0 })

  assert.equal(r.exitOk, true, 'the installer reported success')
  assert.equal(r.ok, false, 'the proof did not')
  assert.equal(r.sentinel, null)
  assert.equal(fs.existsSync(path.join(worktree, '.fleet-ready')), false)
  assert.deepEqual(r.proof.verdict.damaged.map(d => d.pkg), ['packages/pkg-a/node_modules/typescript'])

  // the repair is those directories, and then an install — not a wipe of the tree
  assert.deepEqual(repairPlan(r.proof.verdict, worktree).map(p => path.relative(worktree, p).split(path.sep).join('/')), ['packages/pkg-a/node_modules/typescript'])

  // a complete install of the same tree does write it
  const good = await installOne({ label: '3', worktree }, {
    config: c,
    reference,
    run: () => { makeTree(worktree, { 'packages/pkg-a/node_modules/typescript': 40 }); return { ok: true, code: 0 } },
    now: () => T0,
  })
  assert.equal(good.ok, true)
  assert.equal(good.sentinel, path.join(worktree, '.fleet-ready'))
  assert.equal(readSentinel(worktree, c).lockfileHash, lockfileHashOf(worktree))
})

test("a failed re-install takes the previous run's sentinel down with it", async () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 20 })
  const reference = snapshotReference(primary, c, { now: () => T0 })
  const worktree = path.join(root, 'app-session-2')

  const first = await installOne({ label: '2', worktree }, {
    config: c,
    reference,
    run: () => { makeTree(worktree, { 'node_modules/react': 20 }); return { ok: true, code: 0 } },
    now: () => T0,
  })
  assert.equal(first.ok, true)
  assert.equal(readyState(observeWorktree(worktree, c), c).ready, true)

  // the tree is gutted and the LOCKFILE IS UNTOUCHED — an interrupted install changes no lockfile,
  // so the staleness guard cannot see this and the old sentinel is the only thing left claiming
  fs.rmSync(path.join(worktree, 'node_modules', 'react'), { recursive: true, force: true })
  fs.mkdirSync(path.join(worktree, 'node_modules', 'react'))

  const second = await installOne({ label: '2', worktree }, {
    config: c,
    reference,
    run: () => ({ ok: true, code: 0 }), // the package manager sees the directory and re-extracts nothing
  })
  assert.equal(second.exitOk, true)
  assert.equal(second.ok, false)
  assert.equal(fs.existsSync(readyFlagPath(worktree, c)), false, 'a green sentinel over a half-extracted tree is the failure this module exists to prevent')
  assert.equal(readyState(observeWorktree(worktree, c), c).ready, false)
  assert.equal(readyState(observeWorktree(worktree, c), c).state, 'no-sentinel')
})

test('a worktree whose lockfile is not the reference\'s is refused with a refresh instruction, not a phantom repair', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 20, 'node_modules/dropped-dep': 6 })
  const reference = snapshotReference(primary, c, { now: () => T0 })

  // the session branch drops a dependency: its tree is healthy, its lockfile is its own
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 20 }, { lockfile: '{"lockfileVersion":3,"dropped":true}' })
  const v = verifyInstall(worktree, reference, c)

  assert.equal(v.ok, false)
  assert.match(v.reason, /refresh the reference/)
  assert.equal(v.verdict, null, 'no verdict, so nothing to build a repair plan out of')

  // what comparing across lockfiles produced instead: a plan to delete and reinstall a directory
  // that is not supposed to exist — and never will, so the loop never ends
  const phantom = repairPlan(verdictFromCounts(scanTree(worktree), reference.packages, 0.98), worktree)
  assert.deepEqual(phantom.map(p => path.relative(worktree, p).split(path.sep).join('/')), ['node_modules/dropped-dep'])
  assert.equal(fs.existsSync(path.join(worktree, 'node_modules', 'dropped-dep')), false)
})

test('a tolerance of 0 is refused in every mode — the count path is not the only one that multiplies by it', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'), {
    'install.proof.mode': 'explicit',
    'install.proof.probeFiles': ['node_modules/typescript/lib/tsc.js'],
    'install.proof.tolerance': 0,
  })
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/typescript/lib': 1 })
  fs.writeFileSync(path.join(primary, 'node_modules/typescript/lib/tsc.js'), 'x'.repeat(8000))
  const reference = snapshotReference(primary, c, { now: () => T0 })
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/typescript/lib': 1 })
  fs.writeFileSync(path.join(worktree, 'node_modules/typescript/lib/tsc.js'), 'x') // one byte of an 8000-byte file

  const zero = verifyInstall(worktree, reference, c)
  assert.equal(zero.ok, false, 'floor(8000 * 0) is 0, so every truncated file used to pass as "full size"')
  assert.match(zero.reason, /tolerance must be greater than 0/)

  setPath(c, 'install.proof.tolerance', 0.98)
  const strict = verifyInstall(worktree, reference, c)
  assert.equal(strict.ok, false)
  assert.match(strict.reason, /tsc\.js is 1 bytes, the reference has 8000/)
})

test('proof.mode "explicit" reports what it actually checked, never "full size" it never measured', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'), { 'install.proof.mode': 'explicit', 'install.proof.probeFiles': ['bin/app'] })
  const worktree = makeTree(path.join(root, 'app-session-1'), { bin: 0 })
  fs.writeFileSync(path.join(worktree, 'bin', 'app'), 'x')

  const v = verifyInstall(worktree, null, c) // no reference, so no size to compare against
  assert.equal(v.ok, true)
  assert.match(v.reason, /no reference size to compare/)
  assert.doesNotMatch(v.reason, /full size/, 'a one-byte file passing `bytes > 0` is not proof of full size')
})

test('proof.mode "exists" proves only that an install ran — including for the probe file it computes and ignores', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'), { 'install.proof.mode': 'exists', 'install.proof.probeFiles': ['node_modules/typescript/lib/tsc.js'] })
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 0 }) // an empty package directory

  const v = verifyInstall(worktree, null, c)
  assert.equal(v.ok, true)
  assert.match(v.reason, /existence only/, 'the reason has to name its own weakness')
  // ⛔ the blind spot, pinned rather than assumed: the probe file is missing outright and this mode
  // still passes. It is the fallback for a repo with no primary to compare against, never a proof.
  assert.equal(v.probeFiles[0].ok, false)
  assert.equal(scanTree(worktree).get('node_modules/react'), 0)

  const nothing = makeTree(path.join(root, 'app-session-2'), {})
  assert.equal(verifyInstall(nothing, null, c).ok, false, 'no packages at all is the one thing it does catch')
})

test('a probe file that exists but is truncated fails the proof even though every count passes', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'), { 'install.proof.probeFiles': ['node_modules/typescript/lib/tsc.js'] })
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/typescript/lib': 3 })
  fs.writeFileSync(path.join(primary, 'node_modules/typescript/lib/tsc.js'), 'x'.repeat(8000))
  const reference = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(reference.probeFiles['node_modules/typescript/lib/tsc.js'], 8000)

  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/typescript/lib': 3 })
  fs.writeFileSync(path.join(worktree, 'node_modules/typescript/lib/tsc.js'), 'x'.repeat(2000)) // a quarter of its size
  const v = verifyInstall(worktree, reference, c)
  assert.equal(v.verdict.ok, true, 'the counts match — a file count can never see a truncated file')
  assert.equal(v.ok, false)
  assert.match(v.reason, /tsc\.js is 2000 bytes, the reference has 8000/)
})

test('proof.mode "explicit" with no probe files proves nothing, and says so', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'), { 'install.proof.mode': 'explicit' })
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 5 })
  const v = verifyInstall(worktree, null, c)
  assert.equal(v.ok, false)
  assert.match(v.reason, /probeFiles is empty/)
})

test('the sentinel lives at the WORKTREE ROOT, is refused for a failed proof, and cannot escape the worktree', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 5 })

  assert.equal(readyFlagPath(worktree, c), path.join(worktree, '.fleet-ready'))
  const failed = { ok: false, mode: 'compare-primary', reason: '1 package(s) missing', verdict: null }
  assert.throws(() => writeReadySentinel(worktree, c, { proof: failed }), /refusing to write the ready sentinel/)
  assert.equal(fs.existsSync(path.join(worktree, '.fleet-ready')), false)

  const file = writeReadySentinel(worktree, c, { proof: { ok: true, mode: 'compare-primary', verdict: { checked: 1, worstRatio: 1 } }, now: () => T0 })
  assert.equal(path.dirname(file), worktree, 'a sentinel in the state dir would outlive a hand-deleted worktree')
  assert.equal(clearReadySentinel(worktree, c), true)
  assert.equal(clearReadySentinel(worktree, c), false)

  const escaping = cfg(path.join(root, 'state'), { 'install.readyFlag': '../.fleet-ready' })
  assert.throws(() => readyFlagPath(worktree, escaping), /must name a file inside the worktree/)
})

// ---- readiness ---------------------------------------------------------------------------------------

test('a reused worktree carrying an older lockfile\'s sentinel is NOT ready', () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const worktree = makeTree(path.join(root, 'app-session-1'), { 'node_modules/react': 5 })

  assert.deepEqual(readyState(observeWorktree(worktree, c), c).state, 'no-sentinel')

  writeReadySentinel(worktree, c, { proof: { ok: true, mode: 'compare-primary', verdict: { checked: 1, worstRatio: 1 } }, now: () => T0 })
  const ready = readyState(observeWorktree(worktree, c), c)
  assert.equal(ready.ready, true)
  assert.equal(ready.state, 'ready')

  // the base branch moves and the lockfile changes; the sentinel from the previous run survives the
  // reused worktree and would otherwise make the launcher skip the install entirely
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')
  const stale = readyState(observeWorktree(worktree, c), c)
  assert.equal(stale.ready, false)
  assert.equal(stale.state, 'stale-lockfile')

  // a sentinel that cannot say what it proved proves nothing
  fs.writeFileSync(path.join(worktree, '.fleet-ready'), 'ready\n')
  assert.deepEqual(readSentinel(worktree, c), { unparsable: true })
  assert.equal(readyState(observeWorktree(worktree, c), c).state, 'unproven')
})

test('a repo with none of the lockfiles still becomes ready — otherwise it is reinstalled forever', async () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 5 }, { lockfile: null })
  const reference = snapshotReference(primary, c, { now: () => T0 })
  assert.equal(reference.lockfileHash, null, 'nothing to hash: a Python/Go repo, or one whose bootstrap is `make setup`')

  const worktree = path.join(root, 'app-session-1')
  const r = await installOne({ label: '1', worktree }, {
    config: c,
    reference,
    run: () => { makeTree(worktree, { 'node_modules/react': 5 }, { lockfile: null }); return { ok: true, code: 0 } },
    now: () => T0,
  })
  assert.equal(r.ok, true)
  assert.equal(readSentinel(worktree, c).lockfileless, true, 'the sentinel records that there was nothing to record')
  assert.equal(readyState(observeWorktree(worktree, c), c).ready, true)

  // "no lockfile in this repo" is still not the same answer as "this sentinel says nothing"
  assert.equal(readyState({ path: worktree, sentinel: { v: 1, at: 'x', lockfileHash: null }, lockfileHash: null }, c).state, 'unproven')

  // and a lockfile appearing later still invalidates the sentinel
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}')
  assert.equal(readyState(observeWorktree(worktree, c), c).state, 'stale-lockfile')
})

// ---- pacing the run ------------------------------------------------------------------------------------

test('waves barrier, and the settle gap falls BETWEEN waves — never after the last one', async () => {
  const c = cfg(tmp())
  const events = []
  const sleeps = []
  const tick = () => new Promise(r => setImmediate(r))
  const jobs = ['1', '2', '3', '4', '5'].map(label => ({ label, worktree: `/w/app-session-${label}` }))

  const out = await runInstalls(jobs, {
    config: c,
    cpuCount: 8, // byCpu = 2 → waves of two
    probe: () => ({ freeBytes: 40 * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'normal' }),
    sleep: async (ms, tag) => { sleeps.push({ ms, tag }); events.push(`sleep:${tag}`) },
    runJob: async job => { events.push(`start ${job.label}`); await tick(); events.push(`end ${job.label}`); return { label: job.label, ok: true } },
  })

  assert.equal(out.waves, 3)
  assert.deepEqual(out.results.map(r => r.label), ['1', '2', '3', '4', '5'])
  assert.deepEqual(events, [
    'start 1', 'start 2', 'end 1', 'end 2', 'sleep:settle',
    'start 3', 'start 4', 'end 3', 'end 4', 'sleep:settle',
    'start 5', 'end 5',
  ])
  // the quiet moment is the point of waves: a rolling pool never has one
  assert.deepEqual(sleeps, [{ ms: 30_000, tag: 'settle' }, { ms: 30_000, tag: 'settle' }])
})

test('one failing install does not stop the run — a fleet blocked on one bad tree looks busy and does nothing', async () => {
  const c = cfg(tmp())
  const jobs = ['1', '2', '3'].map(label => ({ label, worktree: `/w/app-session-${label}` }))
  const out = await runInstalls(jobs, {
    config: c,
    cpuCount: 4,
    probe: () => ({ freeBytes: 40 * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'normal' }),
    sleep: async () => {},
    runJob: async job => { if (job.label === '2') throw new Error('the tree is gone') ; return { label: job.label, ok: true } },
  })
  assert.equal(out.results.length, 3)
  assert.deepEqual(out.results.filter(r => !r.ok).map(r => r.label), ['2'])
  assert.match(out.results.find(r => r.label === '2').reason, /the install threw: the tree is gone/)
})

test('a machine that never frees memory still finishes the fleet, loudly — the hold budget is run-wide', async () => {
  const c = cfg(tmp())
  const sleeps = []
  const jobs = ['1', '2', '3'].map(label => ({ label, worktree: `/w/app-session-${label}` }))
  const out = await runInstalls(jobs, {
    config: c,
    cpuCount: 8,
    probe: () => ({ freeBytes: 1 * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'critical' }),
    sleep: async (ms, tag) => { sleeps.push(tag) },
    runJob: async job => ({ label: job.label, ok: true }),
  })

  // 600 s of budget in 20 s polls, then the run proceeds one install at a time rather than idling
  // forever while looking healthy
  assert.equal(sleeps.filter(t => t === 'hold').length, 30)
  assert.equal(out.heldMs, 600_000)
  assert.equal(out.waves, 3, 'one install per wave once the budget is spent')
  assert.equal(out.results.length, 3)
  assert.equal(out.warnings.length, 3)
  assert.match(out.warnings[0], /waits forever looks healthy and does nothing/)
  // the budget is not reset per wave: the second hold proceeds immediately
  assert.equal(sleeps.filter(t => t === 'settle').length, 2)
})

test('a wave of REAL installs overlaps — with a synchronous installOne every barrier above paces a queue of one', async () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 2 })
  const reference = snapshotReference(primary, c, { now: () => T0 })
  const events = []
  const jobs = ['1', '2'].map(label => ({ label, worktree: path.join(root, `app-session-${label}`) }))

  const out = await runInstalls(jobs, {
    config: c,
    reference,
    cpuCount: 8, // byCpu = 2 → a single wave of two
    probe: () => ({ freeBytes: 40 * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'normal' }),
    sleep: async () => {},
    // the production runJob, with only the child process replaced by an async stand-in
    runJob: (job, o) => installOne(job, {
      ...o,
      now: () => T0,
      run: async () => {
        events.push(`start ${job.label}`)
        await new Promise(r => setImmediate(r))
        makeTree(job.worktree, { 'node_modules/react': 2 })
        events.push(`end ${job.label}`)
        return { ok: true, code: 0 }
      },
    }),
  })

  assert.equal(out.waves, 1)
  assert.deepEqual(events, ['start 1', 'start 2', 'end 1', 'end 2'], 'serial installs give start/end/start/end, and the wave width, the RAM pacing and the barrier all become decoration')
  assert.deepEqual(out.results.map(r => r.ok), [true, true])
})

test('the default run path really runs commands.bootstrap, with an hour to do it', async () => {
  const root = tmp()
  const c = cfg(path.join(root, 'state'))
  const primary = makeTree(path.join(root, 'app'), { 'node_modules/react': 3 })
  const reference = snapshotReference(primary, c, { now: () => T0 })
  const worktree = makeTree(path.join(root, 'app-session-1'), {}) // the lockfile, no node_modules yet

  // a real child process through the real defaultBootstrap → shellCommand: no package manager, no network
  const script = path.join(root, 'bootstrap.mjs')
  fs.writeFileSync(script, [
    "import fs from 'node:fs'",
    "fs.mkdirSync('node_modules/react', { recursive: true })",
    "for (let i = 0; i < 3; i++) fs.writeFileSync('node_modules/react/f' + i + '.js', 'module.exports = {}')",
  ].join('\n'))
  setPath(c, 'commands.bootstrap', `node ${script}`) // no quotes: the temp path has no spaces, and
  // shellCommand() escapes an embedded quote as \" on Windows, which cmd.exe then passes through

  const r = await installOne({ label: '1', worktree }, { config: c, reference, now: () => T0 })
  assert.equal(r.exitOk, true, 'the configured command ran in the worktree')
  assert.equal(r.ok, true)
  assert.equal(r.sentinel, path.join(worktree, '.fleet-ready'))
  // exec.mjs's own default would kill a large install at 20 minutes, and a killed install is exactly
  // the half-extracted tree at the top of the module
  assert.equal(BOOTSTRAP_TIMEOUT_MS, 60 * 60_000)
})

test('a configured donor is announced as ignored rather than silently doing nothing', async () => {
  const c = cfg(tmp(), { 'install.donor.enabled': true })
  const out = await runInstalls([{ label: '1', worktree: '/w/app-session-1' }], {
    config: c,
    cpuCount: 4,
    probe: () => ({ freeBytes: 40 * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'normal' }),
    sleep: async () => {},
    runJob: async job => ({ label: job.label, ok: true }),
  })
  assert.equal(out.results.length, 1)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /donor is ignored/)
})
