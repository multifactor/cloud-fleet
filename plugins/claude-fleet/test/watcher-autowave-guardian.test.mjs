import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run } from '../src/sys/exec.mjs'
import { snapshotFrom } from '../src/sys/proc.mjs'
import { ensureWorktree, listWorktrees } from '../src/core/worktree.mjs'
import { writeSession, listSessions } from '../src/core/fleet.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { stateLayout } from '../src/config/paths.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import {
  capacity, measureCapacity, sessionWorktrees, parseQueue, readQueue, writeQueue, nextKeys, pushFront,
  queuePath, refusedPath, readCachedTicket, admitKeys, readRefusals, refillPlan, upArgv, downTransition,
  stopPlan, autowavePass, REFUSAL_NO_CACHE, DEFAULT_INTERVAL_MS,
} from '../src/watchers/autowave.mjs'
import {
  wipDir, manifestPath, wipDue, stampOf, wipFileName, renderWip, snapshotWip, fleetManifest,
  writeFleetManifest, readFleetManifest, initialParkState, quotaPark, helperTokenPattern, findHelper,
  superviseHelper,
} from '../src/watchers/guardian.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-'))
const T0 = Date.parse('2026-03-14T10:00:00Z')

/** A resolved-enough config: the schema defaults plus the three derived keys these modules read. */
function cfg(over = {}) {
  const c = defaultsFor()
  c.repo.name = 'app'
  c.fleet.size = 7
  c.fleet.hardCeiling = 9
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

const G = (cwd, ...args) => {
  const r = run('git', args, { cwd })
  if (!r.ok) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** A real repository in a temp dir — git is never mocked; the traps here are git's own behaviour. */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-repo-'))
  const primary = path.join(root, 'app')
  fs.mkdirSync(primary)
  if (!run('git', ['init', '-q', '-b', 'main'], { cwd: primary }).ok) {
    G(primary, 'init', '-q')
    G(primary, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  }
  G(primary, 'config', 'user.email', 'ada@example.com')
  G(primary, 'config', 'user.name', 'ada')
  G(primary, 'config', 'commit.gpgsign', 'false')
  G(primary, 'config', 'core.autocrlf', 'false') // a diff that flips line endings is not the session's work
  fs.writeFileSync(path.join(primary, 'README.md'), '# app\n')
  G(primary, 'add', '-A')
  G(primary, 'commit', '-q', '-m', 'first')
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { root, primary }
}

/** Write `<stateDir>/tickets/<KEY>.json` the way the offline cache lays it out. */
function cacheTicket(stateDir, key, extra = {}) {
  const dir = stateLayout(stateDir, process.platform).tickets
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ v: 1, key, title: `ticket ${key}`, description: '', ...extra }))
}

const registeredSessions = n => Array.from({ length: n }, (_, i) => ({ path: `/w/app-session-${i + 1}`, bare: false }))

// ---- autowave: capacity ----------------------------------------------------------------------------

test('capacity comes from `git worktree list`, never from a folder count', t => {
  // Twenty folders sat on disk while seven worktrees were real: a forced removal deregisters and then
  // fails to unlink, and a folder-counting gate saw a full fleet and refused every top-up for hours.
  const { root, primary } = makeRepo(t)
  for (const n of [1, 2, 3]) ensureWorktree({ repo: primary, path: path.join(root, `app-session-${n}`), baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: path.join(root, 'app-testing'), baseBranch: 'main' })
  for (const n of [4, 5, 6, 7, 8, 9, 10]) fs.mkdirSync(path.join(root, `app-session-${n}`)) // stranded, never registered
  // …and one that WAS registered, then deregistered with its folder left behind
  const eleven = path.join(root, 'app-session-11')
  ensureWorktree({ repo: primary, path: eleven, baseBranch: 'main' })
  G(primary, 'worktree', 'remove', '--force', eleven)
  fs.mkdirSync(eleven, { recursive: true })
  // …and the mirror image: a registration whose directory was hand-deleted. `git worktree list` marks
  // it `prunable`, and no session lives in a directory that is not there — counting one would run the
  // fleet permanently one short per stale registration.
  const twelve = path.join(root, 'app-session-12')
  ensureWorktree({ repo: primary, path: twelve, baseBranch: 'main' })
  fs.rmSync(twelve, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  const folders = fs.readdirSync(root).filter(n => /^app-session-\d+$/.test(n)).length
  assert.equal(folders, 11, 'the folder count says the fleet is over its ceiling')

  const config = cfg()
  const cap = measureCapacity({ primary, config })
  assert.deepEqual(cap, { live: 3, target: 7, ceiling: 9, free: 4, headroom: 6, prunable: 1 },
    'the stale registration is reported as prunable, never counted as a live session')
  // the testing slot and the primary checkout are registered too, and neither is a working session
  assert.deepEqual(sessionWorktrees(listWorktrees(primary), config).map(w => path.basename(w.path)).sort(), ['app-session-1', 'app-session-2', 'app-session-3'])
})

test('capacity is capped by fleet.hardCeiling, clamps at zero, and refuses an unresolved fleet.size', () => {
  // A fleet over its ceiling launches nothing — not a negative number a later Math.min turns into a launch.
  assert.deepEqual(capacity({ registered: registeredSessions(10), config: cfg() }), { live: 10, target: 7, ceiling: 9, free: 0, headroom: 0, prunable: 0 })
  // the ceiling caps the target itself when the operator set it below the size
  assert.deepEqual(capacity({ registered: registeredSessions(2), config: cfg({ 'fleet.hardCeiling': 5 }) }), { live: 2, target: 7, ceiling: 5, free: 3, headroom: 3, prunable: 0 })
  // a registration whose directory is gone is REPORTED (so the pass can say so) and is not live
  assert.deepEqual(capacity({ registered: [...registeredSessions(2), { path: '/w/app-session-3', bare: false, prunable: true }], config: cfg() }),
    { live: 2, target: 7, ceiling: 9, free: 5, headroom: 7, prunable: 1 })
  // no ceiling resolved: the contract default of size + 2
  assert.equal(capacity({ registered: [], config: cfg({ 'fleet.hardCeiling': null }) }).ceiling, 9)
  assert.throws(() => capacity({ registered: [], config: cfg({ 'fleet.size': null }) }), /fleet\.size is not resolved/)
})

// ---- autowave: the queue ---------------------------------------------------------------------------

test('parseQueue: one key per line, CRLF tolerated, blanks skipped, a duplicate handed out once', () => {
  // Two sessions on one ticket is the collision the queue bug produced; a repeated line is one key.
  assert.deepEqual(parseQueue('ABC-1234\r\nABC-1240\r\n\r\n  ABC-1234 \nABC-1250'), ['ABC-1234', 'ABC-1240', 'ABC-1250'])
  assert.deepEqual(parseQueue(''), [])
})

test('nextKeys pops the head and rewrites the file in one atomic replace', () => {
  const stateDir = tmp()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1234', 'ABC-1240', 'ABC-1250'])
  assert.deepEqual(nextKeys({ queueFile, n: 2 }), { keys: ['ABC-1234', 'ABC-1240'], remaining: 1, existed: true })
  assert.equal(fs.readFileSync(queueFile, 'utf8'), 'ABC-1250\n', 'the remainder is written with its trailing newline')
  assert.deepEqual(fs.readdirSync(stateDir), ['queue.txt'], 'no temp file is left beside the queue')
  // n = 0 consumes nothing and writes nothing
  assert.deepEqual(nextKeys({ queueFile, n: 0 }).keys, [])
  assert.equal(readQueue(queueFile).length, 1)
})

test('an EMPTY remainder writes an EMPTY file — the pipeline that never ran for an empty batch', () => {
  // The queue was once rewritten by piping the remainder to a file writer; an empty remainder sent no
  // input, the writer never ran, the file kept its keys, and the same two tickets launched six times.
  const stateDir = tmp()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1234', 'ABC-1240'])
  assert.deepEqual(nextKeys({ queueFile, n: 5 }), { keys: ['ABC-1234', 'ABC-1240'], remaining: 0, existed: true })
  assert.equal(fs.existsSync(queueFile), true)
  assert.equal(fs.readFileSync(queueFile, 'utf8'), '', 'the drained queue is an empty file, not the old one')
  assert.deepEqual(nextKeys({ queueFile, n: 5 }).keys, [], 'and nothing is handed out twice')
})

test('a queue that does not exist yet is empty, and reading it creates nothing', () => {
  const stateDir = tmp()
  const queueFile = queuePath(stateDir)
  assert.deepEqual(nextKeys({ queueFile, n: 3 }), { keys: [], remaining: 0, existed: false })
  assert.equal(fs.existsSync(queueFile), false)
})

test('pushFront returns keys to the HEAD of the queue in their original order', () => {
  // A popped key whose launcher never started is a dropped ticket unless it goes back first.
  const stateDir = tmp()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1250'])
  pushFront({ queueFile, keys: ['ABC-1234', 'ABC-1240'] })
  assert.deepEqual(readQueue(queueFile), ['ABC-1234', 'ABC-1240', 'ABC-1250'])
})

// ---- autowave: intake --------------------------------------------------------------------------------

test('an ungated checker ticket is REFUSED and logged to intake-refused.jsonl, never silently dropped', () => {
  // A queue that silently shrinks reads as "there was no work"; the launcher lists every refusal in
  // `fleet status` and tells the operator which keys were refused and why.
  const stateDir = tmp()
  const config = cfg()
  cacheTicket(stateDir, 'ABC-1234') // human-filed: no provenance label, admitted unconditionally
  cacheTicket(stateDir, 'ABC-1240', { labels: [config.checker.provenanceLabel] }) // checker-filed, no gate verdict
  cacheTicket(stateDir, 'ABC-1250', { labels: [config.checker.provenanceLabel, config.checker.gate.labels.passed] })
  cacheTicket(stateDir, 'ABC-1270', { labels: [config.checker.provenanceLabel, config.checker.gate.labels.failed] })

  const r = admitKeys({ keys: ['ABC-1234', 'ABC-1240', 'ABC-1250', 'ABC-1260', 'ABC-1270'], stateDir, config, nowMs: T0 })
  assert.deepEqual(r.admitted, ['ABC-1234', 'ABC-1250'])
  assert.deepEqual(r.refused.map(x => [x.key, x.reason]), [['ABC-1240', 'ungated'], ['ABC-1260', REFUSAL_NO_CACHE], ['ABC-1270', 'gate-failed']])

  const file = refusedPath(stateDir)
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  assert.ok(text.endsWith('\n'), 'every line carries its own newline')
  assert.deepEqual(readRefusals(file).map(x => x.key), ['ABC-1240', 'ABC-1260', 'ABC-1270'])
  assert.equal(readRefusals(file)[0].at, new Date(T0).toISOString())
  // a torn last line (the process died mid-append) hides none of the earlier refusals
  fs.appendFileSync(file, '{"v":1,"key":"ABC-12')
  assert.equal(readRefusals(file).length, 3)
  assert.deepEqual(readRefusals(path.join(stateDir, 'absent.jsonl')), [])
})

test('a key with no ticket cache fails CLOSED, and a key that is a path is uncached rather than joined', () => {
  // The gate cannot be judged without the cached ticket, and the reclaim gate's lesson applies: refuse
  // what cannot be verified rather than launching a session on a possible false positive.
  const stateDir = tmp()
  assert.equal(readCachedTicket(stateDir, 'ABC-1234'), null)
  cacheTicket(stateDir, 'ABC-1234', { description: '**Gate:** passed' })
  const t = readCachedTicket(stateDir, 'ABC-1234')
  assert.equal(t.body, '**Gate:** passed', 'op-2 says description; intake reads body — both are served')
  assert.deepEqual(t.labels, [])
  for (const bad of ['../ABC-1234', 'a/b', 'a\\b', '.', '..', '']) assert.equal(readCachedTicket(stateDir, bad), null, `${JSON.stringify(bad)} must not be joined into the tickets directory`)
})

test('with fleet.queue.requireGate off, a checker ticket is admitted with a warning instead of refused', () => {
  const stateDir = tmp()
  const config = cfg({ 'fleet.queue.requireGate': false })
  cacheTicket(stateDir, 'ABC-1240', { labels: [config.checker.provenanceLabel] })
  const r = admitKeys({ keys: ['ABC-1240'], stateDir, config, nowMs: T0 })
  assert.deepEqual(r.admitted, ['ABC-1240'])
  assert.equal(fs.existsSync(refusedPath(stateDir)), false, 'nothing was refused, so nothing is logged')
})

// ---- autowave: the plan ------------------------------------------------------------------------------

test('refillPlan launches NOTHING while a launcher is busy, whatever the capacity and the queue say', () => {
  // Two launchers read the same worktree list and each skips the worktrees the other just created —
  // a skipped slot silently drops its issue.
  const cap = capacity({ registered: registeredSessions(2), config: cfg() })
  const plan = refillPlan({ capacity: cap, keys: ['ABC-1234', 'ABC-1240'], launcherBusy: true, nowMs: T0 })
  assert.equal(plan.argv, null)
  assert.deepEqual(plan.launch, [])
  assert.equal(plan.hold, 'launcher-busy')
  assert.match(plan.log, /launcher is running/)
})

test('refillPlan aims PAST the target by the overshoot, never past the ceiling, and logs the arithmetic', () => {
  // A launcher run is install-paced and sessions finish during it, so launching exactly target − live
  // lands short every time and the fleet sits at 13–17 with 20 as the target; the log line is what
  // makes a short wave visible instead of looking like a stalled autowave.
  const keys = ['ABC-1234', 'ABC-1240', 'ABC-1250', 'ABC-1260', 'ABC-1270', 'ABC-1280']
  const plan = refillPlan({ capacity: capacity({ registered: registeredSessions(5), config: cfg() }), keys, nowMs: T0 })
  assert.deepEqual(plan.launch, keys.slice(0, 4), 'live 5, target 7, overshoot 2 → aim 9 → launch 4')
  assert.deepEqual(plan.argv, ['up', '--add', '4', '--issues', 'ABC-1234,ABC-1240,ABC-1250,ABC-1260', '--no-wizard'])
  assert.match(plan.log, /live=5 target=7 \+overshoot=2 \(ceiling 9\) → launching 4/)
  // an explicit overshoot is still clamped by the ceiling
  assert.equal(refillPlan({ capacity: capacity({ registered: registeredSessions(5), config: cfg() }), keys, overshoot: 10, nowMs: T0 }).want, 4)
  // over the target but under the ceiling still tops up — the ceiling, not the target, is the stop
  assert.equal(refillPlan({ capacity: capacity({ registered: registeredSessions(8), config: cfg() }), keys, nowMs: T0 }).launch.length, 1)
  // at the ceiling: full, and no key is named
  const full = refillPlan({ capacity: capacity({ registered: registeredSessions(9), config: cfg() }), keys, nowMs: T0 })
  assert.deepEqual([full.hold, full.argv, full.launch], ['full', null, []])
})

test('refillPlan paces: at most one wave per interval, and an empty queue idles loudly', () => {
  const cap = capacity({ registered: registeredSessions(2), config: cfg() })
  const paced = refillPlan({ capacity: cap, keys: ['ABC-1234'], lastWaveAt: T0, nowMs: T0 + 60_000 })
  assert.deepEqual([paced.hold, paced.argv], ['paced', null])
  assert.match(paced.log, /next in 240s/)
  const due = refillPlan({ capacity: cap, keys: ['ABC-1234'], lastWaveAt: T0, nowMs: T0 + DEFAULT_INTERVAL_MS })
  assert.deepEqual(due.launch, ['ABC-1234'])
  const custom = refillPlan({ capacity: cap, keys: ['ABC-1234'], lastWaveAt: T0, nowMs: T0 + 30_000, intervalMs: 20_000 })
  assert.deepEqual(custom.launch, ['ABC-1234'])
  // an empty queue is a task, not a fault: no launch, a QUEUE EMPTY line
  const empty = refillPlan({ capacity: cap, keys: [], nowMs: T0 })
  assert.deepEqual([empty.hold, empty.argv], ['queue-empty', null])
  assert.match(empty.log, /QUEUE EMPTY/)
  assert.deepEqual(upArgv(['ABC-1234']), ['up', '--add', '1', '--issues', 'ABC-1234', '--no-wizard'])
})

test('autowavePass: the launcher-busy hold leaves the queue byte-identical and starts nothing', () => {
  const stateDir = tmp()
  const config = cfg()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1234', 'ABC-1240'])
  const before = fs.readFileSync(queueFile, 'utf8')
  const r = autowavePass({
    config, stateDir, primary: '/w/app', nowMs: T0, launcherBusy: true,
    listWorktrees: () => registeredSessions(2),
    runFleet: () => { throw new Error('a busy launcher must never be joined by a second one') },
  })
  assert.deepEqual([r.hold, r.argv, r.ran], ['launcher-busy', null, false])
  assert.equal(fs.readFileSync(queueFile, 'utf8'), before)
})

test('autowavePass: pops until the wave is FULL, screens it, launches the admitted keys, and paces the next', () => {
  const stateDir = tmp()
  const config = cfg()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1234', 'ABC-1240', 'ABC-1250', 'ABC-1260', 'ABC-1270', 'ABC-1280'])
  for (const k of ['ABC-1234', 'ABC-1250', 'ABC-1260', 'ABC-1270']) cacheTicket(stateDir, k)
  cacheTicket(stateDir, 'ABC-1240', { labels: [config.checker.provenanceLabel] }) // ungated → refused
  const calls = []
  const lines = []
  const pass = over => autowavePass({
    config, stateDir, primary: '/w/app', nowMs: T0, listWorktrees: () => registeredSessions(5),
    runFleet: argv => { calls.push(argv); return { pid: 4242 } }, log: m => lines.push(m), ...over,
  })

  const r = pass()
  assert.equal(r.ran, true)
  // live 5 → aim 9 → four WANTED; the refusal is replaced from the queue, so five keys are popped
  assert.deepEqual(r.launch, ['ABC-1234', 'ABC-1240', 'ABC-1250', 'ABC-1260', 'ABC-1270'], 'four wanted, one refused, one replacement popped')
  assert.deepEqual(r.admitted, ['ABC-1234', 'ABC-1250', 'ABC-1260', 'ABC-1270'])
  assert.deepEqual(r.refused.map(x => x.key), ['ABC-1240'])
  assert.deepEqual(calls, [['up', '--add', '4', '--issues', 'ABC-1234,ABC-1250,ABC-1260,ABC-1270', '--no-wizard']])
  assert.deepEqual(readQueue(queueFile), ['ABC-1280'], 'the refused key is consumed (it is recorded) and replaced, so the wave lands FULL instead of short by its refusals; the surplus stays queued')
  assert.equal(r.lastWaveAt, T0)
  assert.ok(lines.some(l => /refused ABC-1240 at intake \(ungated\)/.test(l)), 'the refusal is said out loud')
  assert.equal(readRefusals(refusedPath(stateDir)).length, 1)

  // the next tick inside the interval holds, and consumes nothing
  const paced = pass({ lastWaveAt: T0, nowMs: T0 + 60_000 })
  assert.deepEqual([paced.hold, paced.ran], ['paced', false])
  assert.deepEqual(readQueue(queueFile), ['ABC-1280'])
  assert.equal(calls.length, 1)

  // a wave whose every key is refused launches nothing and does NOT reset the pacing clock
  writeQueue(queueFile, ['ABC-1290'])
  cacheTicket(stateDir, 'ABC-1290', { labels: [config.checker.provenanceLabel] })
  const refused = pass({ lastWaveAt: T0, nowMs: T0 + DEFAULT_INTERVAL_MS })
  assert.deepEqual([refused.hold, refused.ran, refused.lastWaveAt], ['all-refused', false, T0])
  assert.equal(calls.length, 1)

  // an empty queue: QUEUE EMPTY, nothing started
  const empty = pass({ nowMs: T0 + 2 * DEFAULT_INTERVAL_MS })
  assert.deepEqual([empty.hold, empty.ran], ['queue-empty', false])
  assert.equal(calls.length, 1)
})

test('autowavePass: a launcher that fails to start hands its keys back to the head of the queue', () => {
  // The keys were already popped: without this a launcher that never started has dropped a wave's
  // tickets as surely as a second launcher would have.
  const stateDir = tmp()
  const config = cfg()
  const queueFile = queuePath(stateDir)
  writeQueue(queueFile, ['ABC-1280', 'ABC-1290'])
  cacheTicket(stateDir, 'ABC-1280')
  cacheTicket(stateDir, 'ABC-1290')
  assert.throws(() => autowavePass({
    config, stateDir, primary: '/w/app', nowMs: T0, listWorktrees: () => registeredSessions(8), // want 1
    runFleet: () => { throw new Error('the terminal host refused to spawn') },
  }), /refused to spawn/)
  assert.deepEqual(readQueue(queueFile), ['ABC-1280', 'ABC-1290'], 'the popped key is back in front, in order')
  assert.throws(() => autowavePass({ config, stateDir, primary: '/w/app', listWorktrees: () => [] }), /runFleet is required/)
})

test('teardown fires on the TRANSITION to zero, and the autowave never stops under a busy launcher', () => {
  // Zero working sessions stays true forever once true; an unguarded rule re-runs teardown every tick.
  assert.equal(downTransition({ prevLive: 3, live: 0, resourcesRemain: true }), true)
  assert.equal(downTransition({ prevLive: 0, live: 0, resourcesRemain: true }), false, 'the state, not the transition')
  assert.equal(downTransition({ prevLive: 3, live: 0, resourcesRemain: false }), false, 'nothing left to tear down')
  assert.equal(downTransition({ prevLive: 3, live: 1, resourcesRemain: true }), false)
  // A tree-kill aimed at the autowave once took its in-flight installer down with it and stranded
  // thirteen worktrees with no dependencies.
  assert.equal(stopPlan({ launcherBusy: true }).stopNow, false)
  assert.match(stopPlan({ launcherBusy: true }).reason, /mid-extract/)
  assert.deepEqual(stopPlan({ launcherBusy: false }), { stopNow: true, reason: null })
})

// ---- guardian: WIP patches ---------------------------------------------------------------------------

test('snapshotWip writes a patch for a worktree with changes, nothing for a clean one, and never stashes', t => {
  // `refs/stash` is one ref shared by every worktree of the repo: one session's stash is visible and
  // poppable by another. The patch is read-only, so a session resumes exactly as it left off.
  const { root, primary } = makeRepo(t)
  const w1 = path.join(root, 'app-session-1')
  const w2 = path.join(root, 'app-session-2')
  ensureWorktree({ repo: primary, path: w1, baseBranch: 'main' })
  ensureWorktree({ repo: primary, path: w2, baseBranch: 'main' })
  fs.writeFileSync(path.join(w1, 'README.md'), '# app\nchanged\n')
  fs.writeFileSync(path.join(w1, 'notes.txt'), 'scratch the session wrote\n')
  const stateDir = tmp()
  // the launcher's install sentinel sits untracked in EVERY installed tree; it is not the session's
  // work, so a snapshot that counted it would leave an idle worktree dirty forever — which is why the
  // pass takes a resolved config: install.readyFlag names the file to leave out.
  const config = cfg()
  for (const w of [w1, w2]) fs.writeFileSync(path.join(w, config.install.readyFlag), '')
  const worktrees = [
    { label: '1', worktree: w1, branch: 'ada/abc-1234-fix' },
    { label: '2', worktree: w2, branch: null },
    { label: '9', worktree: path.join(root, 'app-session-9') }, // a tree that is gone must not stop the pass
  ]

  const r = snapshotWip({ worktrees, stateDir, config, nowMs: T0 })
  assert.deepEqual(r.written.map(w => w.label), ['1'])
  assert.deepEqual(r.clean, ['2'], 'a tree holding nothing but the install sentinel is clean')
  assert.deepEqual(r.failed.map(f => f.label), ['9'])
  assert.deepEqual(r.unchanged, [])
  const file = path.join(wipDir(stateDir), '1-2026-03-14T10-00-00-000Z.patch')
  assert.equal(r.written[0].file, file)
  assert.equal(r.written[0].untracked, 1)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^# label: 1$/m)
  assert.match(text, /^# branch: ada\/abc-1234-fix$/m)
  assert.match(text, /^# untracked \(1\):\n#   notes\.txt$/m)
  assert.match(text, /^\+changed$/m)
  assert.equal(text.includes(config.install.readyFlag), false, 'the sentinel is in neither the header list nor the hunks')
  assert.deepEqual(fs.readdirSync(wipDir(stateDir)), [path.basename(file)], 'no temp file left beside the patch')

  // never a stash, and the worktree itself is untouched
  assert.equal(run('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd: primary }).ok, false, 'refs/stash must not exist')
  assert.equal(fs.readFileSync(path.join(w1, 'README.md'), 'utf8'), '# app\nchanged\n')
  assert.equal(fs.existsSync(path.join(w1, 'notes.txt')), true)

  // the patch re-applies onto a fresh tree at the same base — that is what "resume" rests on
  const w3 = path.join(root, 'app-session-3')
  ensureWorktree({ repo: primary, path: w3, baseBranch: 'main' })
  const check = run('git', ['apply', '--check', file], { cwd: w3 })
  assert.ok(check.ok, `git apply --check: ${check.stderr}`)

  // the same work again is not re-snapshotted; new work is
  const again = snapshotWip({ worktrees: worktrees.slice(0, 2), stateDir, config, nowMs: T0 + 60_000 })
  assert.deepEqual([again.written, again.unchanged, again.clean], [[], ['1'], ['2']])
  assert.equal(fs.readdirSync(wipDir(stateDir)).length, 1)
  fs.appendFileSync(path.join(w1, 'README.md'), 'more\n')
  const more = snapshotWip({ worktrees: worktrees.slice(0, 2), stateDir, config, nowMs: T0 + 120_000 })
  assert.deepEqual(more.written.map(w => path.basename(w.file)), ['1-2026-03-14T10-02-00-000Z.patch'])
  assert.equal(fs.readdirSync(wipDir(stateDir)).length, 2)
})

test('a previous patch is matched by whole label: session 1 never reads session 10\'s snapshot as its own', t => {
  const { root, primary } = makeRepo(t)
  const w1 = path.join(root, 'app-session-1')
  ensureWorktree({ repo: primary, path: w1, baseBranch: 'main' })
  fs.writeFileSync(path.join(w1, 'README.md'), '# app\nchanged\n')
  const stateDir = tmp()
  const config = cfg()
  const first = snapshotWip({ worktrees: [{ label: '1', worktree: w1 }], stateDir, config, nowMs: T0 })
  // pretend that same work was session 10's: rename the file under label 10
  fs.renameSync(first.written[0].file, path.join(wipDir(stateDir), wipFileName('10', T0)))
  const second = snapshotWip({ worktrees: [{ label: '1', worktree: w1 }], stateDir, config, nowMs: T0 + 1000 })
  assert.deepEqual(second.written.map(w => w.label), ['1'], 'label 1 has no previous patch of its own')
  assert.deepEqual(second.unchanged, [])
})

test('wipDue, stampOf and renderWip are pure and Windows-safe', () => {
  assert.equal(wipDue({ lastAt: null, nowMs: T0 }), true, 'a never-run guardian is always due')
  assert.equal(wipDue({ lastAt: T0, nowMs: T0 + 1000 }), false)
  assert.equal(wipDue({ lastAt: T0, nowMs: T0 + 5 * 60_000 }), true)
  assert.equal(wipDue({ lastAt: T0, nowMs: T0 + 2000, everyMs: 1000 }), true)
  assert.equal(stampOf(T0), '2026-03-14T10-00-00-000Z', 'colons are illegal in Windows file names')
  // `body` is the tracked diff PLUS one creation hunk per untracked file — a name list cannot bring a
  // helper script back — so the rendered payload is not just the diff, and the digest is taken over it.
  const text = renderWip({ label: '3', worktree: '/w/app-session-3', branch: null, at: 'x', body: 'diff --git a b\n', untracked: ['a.txt', 'b.txt'] })
  assert.match(text, /^# branch: \(detached\)$/m)
  assert.match(text, /^# untracked \(2\):\n#   a\.txt\n#   b\.txt\ndiff --git a b\n$/m, 'the diff follows the header directly — git apply ignores the # lines (proven on a real repo above)')
  assert.match(text, /never git stash/)
})

// ---- guardian: the manifest --------------------------------------------------------------------------

test('the fleet manifest round-trips every session — label, role, issue, branch, worktree', () => {
  // After a machine reset the registry is what is on disk; the manifest is the one file a fleet can
  // be rebuilt from, so every session is in it, a dead one included (its worktree still holds work).
  const stateDir = tmp()
  const config = cfg()
  writeSession({ label: '1', role: 'working', worktree: '/w/app-session-1', branch: 'ada/abc-1234-fix', issue: 'ABC-1234', ticketFile: '/s/tickets/ABC-1234.md' }, { stateDir })
  writeSession({ label: '2', role: 'working', worktree: '/w/app-session-2', branch: '', issue: null, liveness: 'dead' }, { stateDir })
  writeSession({ label: 'testing', role: 'testing', worktree: '/w/app-testing', branch: 'testing', slot: 1, port: 3000 }, { stateDir })
  writeSession({ label: 'check-a01', role: 'checker', worktree: '/w/app-check-a01', branch: 'check/2026-03-14/a01', sweepDir: '/s/sweeps/2026-03-14', slice: 'a01' }, { stateDir })

  const { file, manifest } = writeFleetManifest({ registry: listSessions({ stateDir }), config, stateDir, nowMs: T0 })
  assert.equal(file, manifestPath(stateDir))
  assert.equal(manifest.at, new Date(T0).toISOString())
  assert.deepEqual(manifest.repo, { name: 'app', remote: 'origin', baseBranch: 'main', worktreeParent: null })
  assert.deepEqual(manifest.sessions.map(s => [s.label, s.role, s.issue, s.branch, s.worktree]), [
    ['1', 'working', 'ABC-1234', 'ada/abc-1234-fix', '/w/app-session-1'],
    ['2', 'working', null, '', '/w/app-session-2'],
    ['check-a01', 'checker', null, 'check/2026-03-14/a01', '/w/app-check-a01'],
    ['testing', 'testing', null, 'testing', '/w/app-testing'],
  ])
  assert.equal(manifest.sessions[2].slice, 'a01')
  assert.equal(manifest.sessions[3].slot, 1)
  assert.equal(manifest.sessions[1].liveness, 'dead')

  const back = readFleetManifest(stateDir)
  assert.deepEqual(back, manifest, 'what was written is what is read')
  assert.deepEqual(fleetManifest({ registry: listSessions({ stateDir }), config, nowMs: T0 }), manifest, 'the pure half and the file agree')
  assert.ok(!fs.readdirSync(stateDir).some(n => n.endsWith('.tmp')), 'no temp file is left beside the manifest')

  // a torn manifest is "no manifest", never a crash in the guardian's loop
  fs.writeFileSync(manifestPath(stateDir), '{"v":1,"sessions":[')
  assert.equal(readFleetManifest(stateDir), null)
  assert.equal(readFleetManifest(tmp()), null)
})

// ---- guardian: quota parking -------------------------------------------------------------------------

test('quotaPark: a usage limit parks the fleet once, with its time; an account switch unparks and asks for the nudge', () => {
  // A usage limit is account-level and nothing bypasses it — relaunching hits the same wall. And an
  // account switch resumes nothing by itself: a session whose turn closed on the limit has nothing
  // left to wake it, so the unpark hands back to the stall watcher's fleet-wide nudge.
  const parked = quotaPark({ kind: 'usage-limit', text: 'usage limit reached' }, { state: initialParkState(), nowMs: T0 })
  assert.deepEqual(parked, { state: { parked: true, parkedAt: new Date(T0).toISOString(), reason: 'usage limit reached', unparkedAt: null }, event: 'parked', nudge: false })

  // the alarm keyed on error text plus idle minutes once re-fired every poll: the first parkedAt is kept
  const repeat = quotaPark({ usageLimit: true, text: 'usage limit reached' }, { state: parked.state, nowMs: T0 + 60_000 })
  assert.deepEqual([repeat.event, repeat.nudge, repeat.state.parkedAt], [null, false, parked.state.parkedAt])

  const switched = quotaPark({ kind: 'account-switch' }, { state: repeat.state, nowMs: T0 + 3_600_000 })
  assert.equal(switched.event, 'unparked')
  assert.equal(switched.nudge, true, 'the hand-back to the stall watcher: sessions do not self-recover')
  assert.equal(switched.state.parked, false)
  assert.equal(switched.state.unparkedAt, new Date(T0 + 3_600_000).toISOString())
  assert.equal(switched.state.parkedAt, parked.state.parkedAt, 'the record of when it parked survives')

  // an account switch on a fleet that was never parked is not the guardian's event
  assert.deepEqual(quotaPark({ accountSwitched: true }, { state: initialParkState(), nowMs: T0 }), { state: initialParkState(), event: null, nudge: false })
  assert.deepEqual(quotaPark({}, { state: initialParkState(), nowMs: T0 }).event, null)
  assert.deepEqual(quotaPark(null).state, initialParkState())
})

// ---- guardian: helper supervision --------------------------------------------------------------------

test('helperTokenPattern matches a WHOLE argv token: never a longer token, never a path substring', () => {
  const re = helperTokenPattern('--fleet-helper=reclaim')
  assert.equal(re.test('node watch.mjs --fleet-helper=reclaim'), true)
  assert.equal(re.test('node watch.mjs "--fleet-helper=reclaim" more'), true)
  assert.equal(re.test('node watch.mjs --fleet-helper=reclaimer'), false)
  assert.equal(re.test('node watch.mjs /tmp/--fleet-helper=reclaim/x'), false)
  assert.equal(re.test('node --fleet-helper=reclaim-2'), false)
  assert.throws(() => helperTokenPattern(''), /one non-empty token/)
  assert.throws(() => helperTokenPattern('--fleet helper'), /without whitespace/)
})

test('findHelper excludes self and its ancestors — a probe whose own command line carries the token is not an instance', () => {
  // A count of running supervisors once read 5, 0, 5 across three probes: the probe's shell had the
  // pattern in its own command line and counted itself and its children.
  const snap = snapshotFrom([
    { pid: 1, ppid: 0, name: 'terminal', cmd: 'terminal' },
    { pid: 500, ppid: 1, name: 'sh', cmd: 'sh -c "node guardian.mjs --fleet-helper=reclaim"' }, // the shell running this probe
    { pid: 501, ppid: 500, name: 'node', cmd: 'node guardian.mjs --fleet-helper=reclaim' },     // the probe itself
    { pid: 700, ppid: 1, name: 'node', cmd: 'node watch.mjs --fleet-helper=reclaim' },           // the real helper
    { pid: 800, ppid: 1, name: 'node', cmd: 'node watch.mjs --fleet-helper=reclaimer' },         // a different helper
  ])
  assert.deepEqual(findHelper({ snapshot: snap, argvToken: '--fleet-helper=reclaim', selfPid: 501 }), { pids: [700], degraded: false })
  // the exclusion is by ANCESTRY, not by content: from an unrelated pid the same rows are instances
  assert.deepEqual(findHelper({ snapshot: snap, argvToken: '--fleet-helper=reclaim', selfPid: 999 }).pids, [500, 501, 700])
  // ⛔ an empty snapshot is a failed listing, never "no helper" — starting one on it races the real one
  assert.deepEqual(findHelper({ snapshot: new Map(), argvToken: '--fleet-helper=reclaim', selfPid: 501 }), { pids: [], degraded: true })
  assert.deepEqual(findHelper({ snapshot: null, argvToken: '--fleet-helper=reclaim', selfPid: 501 }).degraded, true)
})

test('superviseHelper restarts a helper that died, and proves the count is exactly one afterwards', () => {
  // A reclaimer once died twice with an empty stderr; unsupervised, worktrees silently stopped being
  // freed. And "killed, never restarted" looks identical to "restarted" unless something re-probes.
  let now = T0
  const backend = createFakeBackend({ clock: () => now, hostPid: 1, firstPid: 1000 })
  const spec = { id: 'reclaim', role: 'working', title: 'reclaim', cwd: '/w', env: [], command: 'node', args: ['watch.mjs', '--fleet-helper=reclaim'] }
  const events = []
  const lines = []
  const pass = (over = {}) => superviseHelper({
    name: 'reclaim',
    argvToken: '--fleet-helper=reclaim',
    start: () => ({ pid: backend.spawn(spec).shimPid }),
    snapshot: backend.processes(),        // taken ONCE for the pass…
    resnapshot: () => backend.processes(), // …and refreshed only for the after-check
    selfPid: 424242,
    nowMs: now,
    notify: (event, message) => events.push([event, message]),
    log: m => lines.push(m),
    ...over,
  })

  const first = pass()
  assert.deepEqual([first.action, first.count, first.ok, first.pids], ['started', 1, true, [1000]])
  assert.deepEqual(first.started, { pid: 1000, at: new Date(T0).toISOString() })
  assert.equal(backend.spawned().length, 1)

  const steady = pass()
  assert.deepEqual([steady.action, steady.count, steady.ok], ['none', 1, true])
  assert.equal(backend.spawned().length, 1, 'a running helper is left alone')

  // it dies on its own (the empty-stderr death): the next pass brings it back
  now = T0 + 60_000
  injectFault(backend, { dies: 'reclaim' })
  const back = pass()
  assert.deepEqual([back.action, back.count, back.ok, back.pids], ['started', 1, true, [1001]])
  assert.equal(backend.spawned().length, 2)
  assert.deepEqual(events, [], 'a clean restart raises nothing')
  assert.ok(lines.some(l => /was not running — started it \(pid 1001\)/.test(l)))
})

test('superviseHelper reports a duplicate, refuses to kill it, and raises notifications.command', () => {
  // Two supervisors race each other's repairs. The only safe stop is by a PID this guardian recorded
  // at spawn; a duplicate it did not start is the operator's to resolve, so it is raised, never killed.
  const backend = createFakeBackend({ clock: () => T0, hostPid: 1, firstPid: 1000 })
  const spec = { id: 'reclaim', role: 'working', title: 'reclaim', cwd: '/w', env: [], command: 'node', args: ['watch.mjs', '--fleet-helper=reclaim'] }
  backend.spawn(spec)
  backend.spawn({ ...spec, id: 'reclaim-again' })
  const events = []
  const r = superviseHelper({
    name: 'reclaim', argvToken: '--fleet-helper=reclaim', selfPid: 424242, nowMs: T0,
    start: () => { throw new Error('must not start a third') },
    snapshot: backend.processes(), resnapshot: () => backend.processes(),
    notify: (event, message) => events.push([event, message]),
  })
  assert.deepEqual([r.action, r.count, r.ok, r.pids], ['duplicate', 2, false, [1000, 1001]])
  assert.equal(backend.processes().size, 3, 'nothing was killed: the host and both instances remain')
  assert.deepEqual(events.map(e => e[0]), ['helper-duplicate'])
  assert.match(events[0][1], /2 instances of reclaim/)
})

test('superviseHelper: a start that leaves zero or throws is a failure that is raised, never assumed', () => {
  // Two restarts in one hour each printed a plausible "stopping N" line and vanished; nothing noticed
  // until the fleet had drained.
  const backend = createFakeBackend({ clock: () => T0, hostPid: 1, firstPid: 1000 })
  const events = []
  const base = {
    name: 'reclaim', argvToken: '--fleet-helper=reclaim', selfPid: 424242, nowMs: T0,
    snapshot: backend.processes(), resnapshot: () => backend.processes(),
    notify: (event, message) => events.push(event),
  }
  // the start "succeeded" but nothing carrying the token is running afterwards
  const zero = superviseHelper({ ...base, start: () => ({ pid: 77 }) })
  assert.deepEqual([zero.action, zero.count, zero.ok], ['started', 0, false])
  // the pid the spawner reported is what the after-check looks for: "exactly one" on its own would
  // pass a corpse standing beside an unrelated straggler, so the reason names the missing pid too
  assert.match(zero.reason, /started as pid 77 but the after-check does not list that pid/)
  assert.match(zero.reason, /0 instance\(s\)/)
  // the start threw: reported, so the pass goes on to the other helpers
  const threw = superviseHelper({ ...base, start: () => { throw new Error('the terminal host refused to spawn') } })
  assert.deepEqual([threw.action, threw.count, threw.ok, threw.started], ['start-failed', 0, false, null])
  assert.match(threw.reason, /refused to spawn/)
  // the after-check itself came back empty: the count is unproven, and says so
  const blind = superviseHelper({ ...base, start: () => ({ pid: 77 }), resnapshot: () => new Map() })
  assert.deepEqual([blind.action, blind.ok], ['started', false])
  assert.match(blind.reason, /unproven/)
  assert.deepEqual(events, ['helper-restart-failed', 'helper-start-failed', 'helper-restart-failed'])
  // and a pass with no fresh snapshot to prove a restart with is refused up front
  assert.throws(() => superviseHelper({ ...base, start: () => ({}), resnapshot: undefined }), /resnapshot is required/)
  assert.throws(() => superviseHelper({ ...base, start: undefined }), /start is required/)
})

test('superviseHelper does nothing on a degraded (empty) snapshot — an empty listing is never evidence of absence', () => {
  // The cheap process listing once returned zero rows while telemetry showed forty-two live agents.
  let started = 0
  const events = []
  const r = superviseHelper({
    name: 'reclaim', argvToken: '--fleet-helper=reclaim', selfPid: 424242, nowMs: T0,
    start: () => { started++; return {} }, snapshot: new Map(), resnapshot: () => new Map(),
    notify: e => events.push(e),
  })
  assert.deepEqual([r.action, r.ok, started], ['skipped', false, 0])
  assert.match(r.reason, /failed listing/)
  assert.deepEqual(events, [])
})
