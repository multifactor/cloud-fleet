import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  sessionsDir, sessionPath, writeSession, readSession, listSessions, removeSession,
  reconcilePlan, reconcile, nextLabel, folderLabel, takenLabels,
} from '../src/core/fleet.mjs'
import { snapshotFrom } from '../src/sys/proc.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-registry-'))
const T0 = Date.parse('2026-03-14T10:00:00Z')

/** A descriptor with the contract §4 fields this module actually reasons about. */
const desc = (label, over = {}) => ({
  label: String(label),
  role: 'working',
  worktree: `/w/app-session-${label}`,
  branch: `ada/abc-${label}`,
  issue: 'ABC-1234',
  shimPid: 100 + Number(label),
  agentPid: 200 + Number(label),
  ...over,
})

/** A shim process as the snapshot sees it: the label lives in an exact argv token. */
const shim = (pid, label) => ({ pid, ppid: 1, name: 'node', cmd: `node shim.mjs --fleet-session=${label} /s/sessions/${label}.json` })
const snap = (...procs) => snapshotFrom([{ pid: 1, ppid: 0, name: 'terminal', cmd: 'terminal' }, ...procs])

// ---- the registry file -------------------------------------------------------------------------

test('a descriptor round-trips, a rewrite replaces it, and no temp file is left behind', () => {
  // The temp file must land in the SAME directory as the target: a rename across filesystems is a
  // copy, which is the half-written descriptor this write exists to prevent.
  const dir = tmp()
  const file = writeSession(desc(3), { stateDir: dir })
  assert.equal(file, sessionPath(dir, '3'))
  assert.equal(readSession('3', { stateDir: dir }).worktree, '/w/app-session-3')
  writeSession(desc(3, { shimPid: 999 }), { stateDir: dir })
  assert.equal(readSession('3', { stateDir: dir }).shimPid, 999)
  assert.deepEqual(fs.readdirSync(sessionsDir(dir)), ['3.json'])
  assert.equal(readSession('9', { stateDir: dir }), null)
})

test('an interrupted write leaves a temp file, and the listing never parses it as a session', () => {
  // A listing that globbed the whole directory once resurrected a half-written descriptor, and a
  // descriptor with no shimPid is a live session `fleet kill` can no longer address.
  const dir = tmp()
  writeSession(desc(3), { stateDir: dir })
  fs.writeFileSync(path.join(sessionsDir(dir), '.7.json.4242.0.tmp'), '{"label":"7","role":"work')
  assert.deepEqual(listSessions({ stateDir: dir }).map(d => d.label), ['3'])
})

test('a write that fails removes its temp file', () => {
  // Nothing in the plugin ever sweeps `.<label>.json.<pid>.<n>.tmp`, so one leaked by a failed write
  // stays in sessions/ forever and every listing pass pays for it.
  const dir = tmp()
  writeSession(desc(3), { stateDir: dir })
  fs.mkdirSync(path.join(sessionsDir(dir), '4.json')) // the rename cannot replace a directory
  assert.throws(() => writeSession(desc(4), { stateDir: dir }))
  assert.deepEqual(fs.readdirSync(sessionsDir(dir)).sort(), ['3.json', '4.json'])
})

test('an entry that cannot be read, or that disagrees with its own filename, is not a session', () => {
  // readSession promises null for absent OR unreadable; anything else thrown here escapes through
  // listSessions and blinds `fleet status`, `reconcile` and `takenLabels` to the entire fleet.
  const dir = tmp()
  writeSession(desc(3), { stateDir: dir })
  fs.mkdirSync(path.join(sessionsDir(dir), '9.json')) // a directory where a descriptor should be
  fs.writeFileSync(sessionPath(dir, '5'), JSON.stringify({ ...desc(5), label: '7' }))
  assert.equal(readSession('9', { stateDir: dir }), null)
  // 5.json claiming to be session 7 would make reconcile write 7.json and leave 5.json stale forever
  assert.equal(readSession('5', { stateDir: dir }), null)
  assert.deepEqual(listSessions({ stateDir: dir }).map(d => d.label), ['3'])
  assert.throws(() => readSession('../evil', { stateDir: dir }), /invalid session label/)
})

test('a label is a filename, never a path — and a descriptor that cannot be spawned is refused at write time', () => {
  const dir = tmp()
  for (const bad of ['../evil', 'a/b', 'a\\b', '', '.hidden', '..']) {
    assert.throws(() => sessionPath(dir, bad), /invalid session label/, `label ${JSON.stringify(bad)} must be refused`)
  }
  assert.throws(() => writeSession({ label: '3', role: 'boss' }, { stateDir: dir }), /unknown role/)
  assert.throws(() => writeSession({ role: 'working' }, { stateDir: dir }), /invalid session label/)
  assert.equal(fs.existsSync(sessionsDir(dir)), false)
})

test('listSessions orders numerically: session 10 must not read above session 2', () => {
  const dir = tmp()
  for (const n of [10, 2, 1]) writeSession(desc(n), { stateDir: dir })
  writeSession(desc('testing', { role: 'testing', shimPid: 700 }), { stateDir: dir })
  assert.deepEqual(listSessions({ stateDir: dir }).map(d => d.label), ['1', '2', '10', 'testing'])
})

test('removeSession reports whether it removed anything, and touches nothing else', () => {
  // A teardown whose removal silently did nothing must not be able to report success.
  const dir = tmp()
  writeSession(desc(3), { stateDir: dir })
  writeSession(desc(4), { stateDir: dir })
  assert.equal(removeSession('3', { stateDir: dir }), true)
  assert.equal(removeSession('3', { stateDir: dir }), false)
  assert.deepEqual(listSessions({ stateDir: dir }).map(d => d.label), ['4'])
})

// ---- reconciliation ----------------------------------------------------------------------------

test('the marker is matched as an exact token: session 7 does not claim session 70', () => {
  const plan = reconcilePlan([desc(7), desc(70)], snap(shim(170, 70)))
  assert.deepEqual(plan.alive.map(a => a.label), ['70'])
  assert.deepEqual(plan.dead.map(d => d.label), ['7'])
  assert.deepEqual(plan.orphans, [])
})

test('a recycled shimPid is not proof of life — only the argv marker is', () => {
  // pid 4242 exists, but it belongs to whatever the OS handed the number to next.
  const plan = reconcilePlan([desc(3, { shimPid: 4242 })], snap({ pid: 4242, ppid: 1, name: 'node', cmd: 'node build.mjs' }))
  assert.deepEqual(plan.alive, [])
  assert.equal(plan.dead[0].reason, 'no-process')
})

test('an empty snapshot is a failed snapshot, never an empty fleet', () => {
  // The cheap process listing degrades to empty output on a loaded box; acting on that would mark
  // every live session dead in one pass.
  const dir = tmp()
  writeSession(desc(3), { stateDir: dir })
  const r = reconcile(snapshotFrom([]), { stateDir: dir, nowMs: T0 })
  assert.equal(r.degraded, true)
  assert.deepEqual([r.alive, r.dead, r.orphans, r.marked, r.updated], [[], [], [], [], []])
  assert.ok(!fs.readFileSync(sessionPath(dir, '3'), 'utf8').includes('liveness'), 'nothing may be written from a failed snapshot')
})

test('a relaunch into the same worktree updates the descriptor instead of adding a second session', () => {
  const dir = tmp()
  writeSession(desc(3, { shimPid: 103 }), { stateDir: dir })
  const r = reconcile(snap(shim(555, 3)), { stateDir: dir, nowMs: T0 })
  assert.deepEqual(r.updated, ['3'])
  assert.equal(r.alive[0].pidChanged, true)
  assert.equal(readSession('3', { stateDir: dir }).shimPid, 555)
  assert.deepEqual(listSessions({ stateDir: dir }).map(d => d.label), ['3'])
})

test('an unchanged session is not rewritten — a status poll must not churn the registry', () => {
  // Asserted against the FILE, not against the return value: a reconcile that rewrote all twelve
  // descriptors with byte-identical content every poll would report an empty `updated` too.
  const dir = tmp()
  writeSession(desc(3, { shimPid: 103 }), { stateDir: dir })
  const file = sessionPath(dir, '3')
  const past = new Date(T0 - 3_600_000)
  fs.utimesSync(file, past, past)
  const untouched = fs.statSync(file).mtimeMs

  const r = reconcile(snap(shim(103, 3)), { stateDir: dir, nowMs: T0 })
  assert.deepEqual([r.updated, r.marked], [[], []])
  assert.equal(fs.statSync(file).mtimeMs, untouched, 'an unchanged descriptor must not be written at all')
  assert.equal(readSession('3', { stateDir: dir }).reconciledAt, undefined)

  // …and a pass that does have something to record still writes
  const moved = reconcile(snap(shim(555, 3)), { stateDir: dir, nowMs: T0 })
  assert.deepEqual(moved.updated, ['3'])
  assert.notEqual(fs.statSync(file).mtimeMs, untouched)
})

test('a session younger than the snapshot is not called dead on its first pass', () => {
  // The launcher writes the descriptor BEFORE its shim exists, and a snapshot is a PAST reading
  // (cached for maxAgeMs; ~450 ms to take on Windows). The consumer of a dead descriptor is the
  // reclaimer, so judging a newborn session here deletes a worktree under a live agent.
  const dir = tmp()
  writeSession(desc(3, { createdAt: new Date(T0 - 1_000).toISOString() }), { stateDir: dir })
  const r = reconcile(snap(shim(999, 'testing')), { stateDir: dir, nowMs: T0 })
  assert.deepEqual([r.dead, r.marked], [[], []])
  assert.deepEqual(r.pending.map(p => p.label), ['3'])
  assert.equal(readSession('3', { stateDir: dir }).liveness, undefined)

  // …and once it is older than the grace window the same absence IS a death
  const later = reconcile(snap(shim(999, 'testing')), { stateDir: dir, nowMs: T0 + 60_000 })
  assert.deepEqual(later.marked, ['3'])

  // the age is measured against the snapshot's capture time whenever the caller knows it
  const fresh = tmp()
  writeSession(desc(4, { createdAt: new Date(T0).toISOString() }), { stateDir: fresh })
  const r2 = reconcile(snap(shim(999, 'testing')), { stateDir: fresh, nowMs: T0 + 600_000, snapshotTakenMs: T0 + 1_000 })
  assert.deepEqual(r2.pending.map(p => p.label), ['4'])
  assert.deepEqual(r2.marked, [])
})

test('a descriptor that parses but cannot be written back does not abandon the rest of the pass', () => {
  // A role lost to an older version or an interrupted merge still LISTS, so it reaches the write —
  // where throwing would leave the pass half applied and blind the fleet to every session after it.
  const dir = tmp()
  writeSession(desc(3, { shimPid: 103 }), { stateDir: dir })
  writeSession(desc(5, { shimPid: 105 }), { stateDir: dir })
  fs.writeFileSync(sessionPath(dir, '4'), JSON.stringify({ label: '4', worktree: '/w/app-session-4' }))

  const r = reconcile(snap(shim(999, 'testing')), { stateDir: dir, nowMs: T0 })
  assert.deepEqual(r.marked, ['3', '5'], 'the healthy sessions are reconciled either side of the bad one')
  assert.deepEqual(r.failed.map(f => f.label), ['4'], 'and the one that could not be written is surfaced, not dropped')
  assert.match(r.failed[0].error, /unknown role/)
  assert.equal(readSession('4', { stateDir: dir }).liveness, undefined)
})

test('a dead session is MARKED, not deleted, and keeps the first observed death time', () => {
  // The descriptor's worktree field is what the reclaimer needs; deleting it strands a
  // multi-gigabyte tree that nothing knows about any more.
  const dir = tmp()
  writeSession(desc(3, { shimPid: 103 }), { stateDir: dir })
  const first = reconcile(snap(shim(999, 'testing')), { stateDir: dir, nowMs: T0 })
  assert.deepEqual(first.marked, ['3'])
  const marked = readSession('3', { stateDir: dir })
  assert.equal(marked.liveness, 'dead')
  assert.equal(marked.deadAt, new Date(T0).toISOString())
  assert.equal(marked.worktree, '/w/app-session-3')

  const second = reconcile(snap(shim(999, 'testing')), { stateDir: dir, nowMs: T0 + 60_000 })
  assert.deepEqual(second.marked, [])
  assert.equal(readSession('3', { stateDir: dir }).deadAt, new Date(T0).toISOString())

  // …and a session that comes back clears the mark rather than staying dead in the registry
  const back = reconcile(snap(shim(777, 3)), { stateDir: dir, nowMs: T0 + 120_000 })
  assert.deepEqual(back.updated, ['3'])
  const alive = readSession('3', { stateDir: dir })
  assert.equal(alive.liveness, 'alive')
  assert.equal(alive.deadAt, undefined)
  assert.equal(alive.shimPid, 777)
})

test('a live session with no readable descriptor is reported as an orphan, never adopted or killed', () => {
  // The operator's own hand-started agents are indistinguishable from here, which is why reconcile
  // only reports: it neither writes a descriptor for an orphan nor plans a kill.
  const dir = tmp()
  writeSession(desc(3, { shimPid: 103 }), { stateDir: dir })
  writeSession(desc(7, { shimPid: 107 }), { stateDir: dir })
  fs.writeFileSync(sessionPath(dir, '7'), '{"label":"7","role":"work') // its descriptor did not survive
  const r = reconcile(snap(shim(103, 3), shim(107, 7)), { stateDir: dir, nowMs: T0 })
  assert.deepEqual(r.alive.map(a => a.label), ['3'])
  assert.deepEqual(r.orphans, [{ label: '7', pids: [107] }])
  assert.deepEqual(fs.readdirSync(sessionsDir(dir)).sort(), ['3.json', '7.json'])
  assert.equal(readSession('7', { stateDir: dir }), null)
})

test('two shims answering to one label are both reported — a duplicate launch is not hidden', () => {
  const plan = reconcilePlan([desc(4, { shimPid: 104 })], snap(shim(104, 4), shim(305, 4)))
  assert.deepEqual(plan.alive[0].pids, [104, 305])
  assert.equal(plan.alive[0].pidChanged, false)
})

// ---- numbering ---------------------------------------------------------------------------------

test('nextLabel takes the first free number, and a named label occupies none', () => {
  assert.equal(nextLabel([]), '1')
  assert.equal(nextLabel(['1', '3']), '2')
  assert.equal(nextLabel([desc(1), desc(2), desc(3)]), '4')
  assert.equal(nextLabel([1, '2', { label: 'testing' }, null, 'check-a']), '3')
})

test('numbering counts leftover FOLDERS, not just descriptors', () => {
  // A teardown that deregistered a worktree and then failed to delete its directory left folder 2 on
  // disk with no descriptor; numbering from the registry alone handed 2 out again and the new
  // session inherited that folder's half-installed contents.
  const stateDir = tmp()
  const parent = tmp()
  for (const n of [1, 3]) writeSession(desc(n), { stateDir })
  for (const d of ['app-session-1', 'app-session-2', 'app-session-3', 'app-testing', 'other-session-9']) {
    fs.mkdirSync(path.join(parent, d))
  }
  fs.writeFileSync(path.join(parent, 'app-session-8'), 'a file is not a worktree')

  assert.equal(nextLabel(listSessions({ stateDir })), '2', 'the registry alone offers an occupied number')
  const taken = takenLabels({ stateDir, worktreeParent: parent, repoName: 'app' })
  assert.deepEqual(taken, ['1', '2', '3'])
  assert.equal(nextLabel(taken), '4')

  // a registered worktree whose folder is gone is folded in by the caller, not guessed at here
  assert.equal(nextLabel(takenLabels({ stateDir, worktreeParent: parent, repoName: 'app', extra: ['4'] })), '5')
  assert.deepEqual(takenLabels({ stateDir: null, worktreeParent: path.join(parent, 'absent'), repoName: 'app' }), [])
})

test('a leftover worktree that is a junction or a symlink still occupies its number', () => {
  // readdir calls a Windows junction a symlink, not a directory, and a filesystem that answers
  // DT_UNKNOWN calls it nothing at all — so numbering that trusts isDirectory() counts no leftover
  // and hands the folder out again, half-installed contents and all.
  const parent = tmp()
  fs.mkdirSync(path.join(parent, 'app-session-1'))
  let linked = true
  try {
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    fs.symlinkSync(path.join(parent, 'app-session-1'), path.join(parent, 'app-session-2'), kind)
  } catch {
    linked = false // Windows without the privilege to create one
  }
  assert.deepEqual(takenLabels({ worktreeParent: parent, repoName: 'app' }), linked ? ['1', '2'] : ['1'])

  // …while a plain file is still not a worktree
  fs.writeFileSync(path.join(parent, 'app-session-8'), 'a file is not a worktree')
  assert.equal(takenLabels({ worktreeParent: parent, repoName: 'app' }).includes('8'), false)
})

test('folder matching is anchored: session-1 does not swallow session-10', () => {
  const o = { repoName: 'app' }
  assert.equal(folderLabel('app-session-1', o), '1')
  assert.equal(folderLabel('app-session-10', o), '10')
  assert.equal(folderLabel('/w/app-session-7/', o), '7')
  assert.equal(folderLabel('app-session-1-backup', o), null)
  assert.equal(folderLabel('old-app-session-1', o), null)
  assert.equal(folderLabel('app-testing', o), null)
  assert.equal(folderLabel('app-check-ui', o), null)
  // a repo name with regex punctuation is data, not pattern
  assert.equal(folderLabel('a.b-session-2', { repoName: 'a.b' }), '2')
  assert.equal(folderLabel('axb-session-2', { repoName: 'a.b' }), null)
  assert.equal(folderLabel('app-session-2', { repoName: 'app', template: '{repo}-session' }), null)
})
