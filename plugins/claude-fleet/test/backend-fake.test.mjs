import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createFakeBackend, injectFault, FAKE_CAPABILITIES, renderCommandLine, shortWrite, planLayout, envMapOf,
} from '../src/backends/fake.mjs'
import { validateBackend, CAPABILITY_NAMES, NO_CAPABILITIES, STATUS } from '../src/backends/types.mjs'
import { hasSessionMarker, sessionLabelOf, descendants, findByCommand, tokenize } from '../src/sys/proc.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { defaultsFor } from '../src/config/defaults.mjs'

// A deterministic clock: the process table's startedAt values are the pid-reuse guard's input, so
// wall-clock time here would make `descendants` order-dependent on how fast the machine runs.
const fake = () => {
  let t = 0
  return createFakeBackend({ clock: () => ++t })
}

const CONFIG = defaultsFor()

/**
 * A spawn spec exactly as the launcher builds one, env included, so the fake is fed real data.
 * The role is read ONCE and reaches both the spec field and the env: a spec whose handle says
 * `testing` while FLEET_ROLE still says `working` is a fiction, and a test written against it proves
 * something that cannot happen. `session` carries the role-conditional descriptor fields
 * (slot/branch/port for testing, sweepDir/slice for checker) straight to buildSessionEnv.
 */
const spec = (label, over = {}) => {
  const { role = 'working', session = {}, ...rest } = over
  return {
    id: String(label),
    role,
    title: `session ${label}`,
    cwd: `/w/app-session-${label}`,
    command: 'node',
    // a worktree path with a space in it, because that is what breaks argv rendering
    args: ['shim.mjs', `--fleet-session=${label}`, `/state/my fleet/sessions/${label}.json`],
    env: buildSessionEnv(CONFIG, {
      label: String(label),
      role,
      file: `/state/my fleet/sessions/${label}.json`,
      stateFile: `/state/my fleet/sessions/${label}.json`,
      stateDir: '/state/my fleet',
      ...session,
    }),
    ...rest,
  }
}

// ---- the interface -----------------------------------------------------------------------------

test('the fake implements the whole interface and declares its capabilities honestly', () => {
  // A backend that quietly claims a capability it lacks means the caller's degradation branch is
  // never taken by any test and ships unexecuted.
  const b = fake()
  assert.deepEqual(validateBackend(b), { ok: true, missing: [], badCapabilities: [] })
  assert.deepEqual(Object.keys(FAKE_CAPABILITIES).sort(), [...CAPABILITY_NAMES].sort())
  const caps = b.capabilities()
  assert.equal(caps.authoritativeList, true)
  assert.equal(caps.reliableSend, true)
  assert.equal(caps.observableStatus, true)
  assert.equal(caps.gridLayout, true)
  assert.equal(caps.focusById, true)
  assert.equal(caps.pixelLayout, false)
  assert.equal(caps.multiMonitor, false)
  assert.equal(caps.freeFloatingWindows, false)
  assert.equal(caps.detachSurvivesLauncher, false)
  assert.equal(b.probe().available, true)
})

test('spawn records the whole spec and puts an exactly-matchable shim in the process table', () => {
  // Session 7 must never match session 70, and an unquoted path with a space in it splits the argv
  // so the marker token stops being findable at all.
  const b = fake()
  const h7 = b.spawn(spec(7))
  const h70 = b.spawn(spec(70))

  const rec = b.spawned()[0]
  assert.equal(rec.id, '7')
  assert.equal(rec.role, 'working')
  assert.equal(rec.cwd, '/w/app-session-7')
  assert.equal(rec.command, 'node')
  assert.deepEqual(rec.args.slice(0, 2), ['shim.mjs', '--fleet-session=7'])
  // all nine mandatory scalars (contract §4), read back off the spec the backend actually recorded
  const env = envMapOf(rec.env)
  assert.equal(env.FLEET_SESSION, '1')
  assert.equal(env.FLEET_SESSION_FILE, '/state/my fleet/sessions/7.json')
  assert.equal(env.FLEET_LABEL, '7')
  assert.equal(env.FLEET_ROLE, 'working')
  assert.equal(env.FLEET_STATE_FILE, '/state/my fleet/sessions/7.json')
  assert.equal(env.FLEET_STATE_DIR, '/state/my fleet')
  assert.equal(env.FLEET_TESTING_URL, '')
  assert.equal(env.FLEET_TESTING_URLS, '')
  assert.equal(env.FLEET_TRACKER_MODE, 'mcp')

  const procs = b.processes()
  const cmd = procs.get(h7.shimPid).cmd
  assert.ok(hasSessionMarker(cmd, 7))
  assert.ok(!hasSessionMarker(cmd, 70))
  assert.ok(hasSessionMarker(procs.get(h70.shimPid).cmd, 70))
  assert.equal(sessionLabelOf(cmd), '7')
  assert.equal(renderCommandLine('node', ['a b', 'c']), 'node "a b" c')
  // an EMPTY token has to survive too: unquoted it vanishes from the line and every positional argv
  // index after it shifts by one, so a caller reading argv[2] reads argv[3]'s value
  const withEmpty = renderCommandLine('node', ['shim.mjs', '', '--fleet-session=7'])
  assert.equal(withEmpty, 'node shim.mjs "" --fleet-session=7')
  assert.equal(tokenize(withEmpty).length, 4)
})

test('a testing session carries its slot, branch and port; a checker its sweep dir and slice', () => {
  // Contract §4: without FLEET_SLOT/FLEET_SLOT_BRANCH/FLEET_PORT a fixed-port project cannot start a
  // second slot at all, and these are the scalars no working-role test ever reads back.
  const b = fake()
  b.spawn(spec(1, { role: 'testing', session: { slot: 2, branch: 'testing-2', port: 3101 } }))
  b.spawn(spec(2, { role: 'checker', session: { sweepDir: '/state/my fleet/sweeps/s-1', slice: 'a' } }))
  const [testing, checker] = b.spawned()

  const te = envMapOf(testing.env)
  assert.equal(testing.role, 'testing')
  assert.equal(te.FLEET_ROLE, 'testing')
  assert.equal(te.FLEET_SLOT, '2')
  assert.equal(te.FLEET_SLOT_BRANCH, 'testing-2')
  assert.equal(te.FLEET_PORT, '3101')
  assert.equal(te.FLEET_SWEEP_DIR, undefined, 'the checker scalars are role-conditional, not always-on')

  const ce = envMapOf(checker.env)
  assert.equal(checker.role, 'checker')
  assert.equal(ce.FLEET_ROLE, 'checker')
  assert.equal(ce.FLEET_SWEEP_DIR, '/state/my fleet/sweeps/s-1')
  assert.equal(ce.FLEET_SLICE, 'a')
  assert.equal(ce.FLEET_SLOT, undefined)

  assert.throws(() => spec(3, { role: 'testing' }), /needs a slot number/)
})

test('spawn refuses a half-built spec — that is what produces a session with no FLEET_* env', () => {
  const b = fake()
  assert.throws(() => b.spawn(spec(1, { role: 'reviewer' })), /unknown role "reviewer"/)
  assert.throws(() => b.spawn(spec(1, { args: 'shim.mjs' })), /args must be an array/)
  assert.throws(() => b.spawn(spec(1, { env: [{ name: 'FLEET_LABEL' }] })), /env entries must be \{name: string, value: string\}/)
  assert.throws(() => b.spawn(spec(1, { cwd: '' })), /cwd is required/)
  assert.deepEqual(b.spawned(), [], 'a refused spec leaves nothing behind')
  assert.deepEqual(b.list(), [])
})

test('spawning a label that is already live is refused — two agents in one worktree collide on the git index', () => {
  const b = fake()
  b.spawn(spec(3))
  assert.throws(() => b.spawn(spec(3)), /already running/)
  assert.equal(b.list().length, 1)
})

test('a handle from a killed session never re-binds to its relaunched namesake', () => {
  // A relaunch reuses the label AND the worktree. If the backend resolved by label, a nudge or a
  // kill aimed at the dead session would land in the fresh one.
  const b = fake()
  const stale = b.spawn(spec(3))
  b.kill(stale)
  const fresh = b.spawn(spec(3))

  assert.equal(b.isAlive(stale), false)
  assert.equal(b.isAlive(fresh), true)
  assert.equal(b.send(stale, 'are you there').reason, 'session-gone')
  assert.equal(b.setStatus(stale, 'ready'), false)
  assert.equal(b.focus(stale), false)
  assert.deepEqual(b.kill(stale), { ok: true, killed: [], alreadyGone: true, survivors: [] })
  assert.deepEqual(b.list().map(h => h.backendRef.ref), [fresh.backendRef.ref])
  assert.equal(b.buffer(fresh).length, 0)
})

test('a session is addressed by its registry handle, never by its label', () => {
  // A backend with no query API was once compensated for by searching command lines, and list, send
  // and kill each resolved a different set. A caller that fabricates {id} fails here instead.
  const b = fake()
  const h = b.spawn(spec(3))
  // The last two are WELL-FORMED and unknown: a ref built from the label, and another backend's or a
  // stale generation's handle. Reporting those as "already gone" is a successful teardown of a
  // session this backend never owned — addressing-by-label wearing a handle's clothes.
  const forged = { id: '3', role: 'working', backendRef: { ref: 'fake:3#1' } }
  const foreign = { id: '3', role: 'working', backendRef: { ref: `${h.backendRef.ref}-other` } }
  for (const bad of [{ id: '3' }, '3', null, { id: '3', backendRef: 'fake:3#1' }, forged, foreign]) {
    assert.throws(() => b.send(bad, 'hello'), TypeError)
    assert.throws(() => b.isAlive(bad), TypeError)
    assert.throws(() => b.kill(bad), TypeError)
  }
  assert.throws(() => b.isAlive(forged), /unknown backendRef/)
  assert.equal(b.isAlive(h), true, 'the handle the registry recorded is the only one that resolves')
  assert.equal(b.list().length, 1, 'and no forged address ended a session')
})

// ---- send --------------------------------------------------------------------------------------

test('a short write is reported as not-ok, and only the fragment lands in the buffer', () => {
  // The incident: a ~700-character message arrived as 62 characters followed by Enter, and the
  // session acted on the fragment because the caller ignored the returned count.
  const b = fake()
  const h = b.spawn(spec(1))
  injectFault(b, { sendLimit: 62 })
  const message = 'x'.repeat(700)

  const r = b.send(h, message)
  assert.equal(r.ok, false)
  assert.equal(r.requested, 700)
  assert.equal(r.delivered, 62)
  assert.equal(r.truncated, true)
  assert.equal(r.reason, 'short-write')
  assert.deepEqual(b.buffer(h), [message.slice(0, 62)])

  // the portable fix is `fleet send --file p`: the real message goes to a file under the state dir
  // and only a short pointer is injected, which fits and therefore succeeds
  injectFault(b, { clear: true })
  const ok = b.send(h, 'read /state/my fleet/logs/nudge-1.log')
  assert.equal(ok.ok, true)
  assert.equal(ok.delivered, ok.requested)
  assert.equal(b.buffer(h).length, 2)
  assert.deepEqual(shortWrite('abc', 0), { delivered: '', requested: 3, truncated: true })
})

test('a send to a session that has gone is reported per target, not thrown at the whole loop', () => {
  // "Send to 1, 2, 3" once reached nobody with a single "no matching sessions" error while the
  // listing showed them all; one dead label must not abort the others.
  const b = fake()
  const handles = [1, 2, 3].map(n => b.spawn(spec(n)))
  injectFault(b, { dies: '2' })

  const results = handles.map(h => b.send(h, 'status please'))
  assert.deepEqual(results.map(r => r.ok), [true, false, true])
  assert.equal(results[1].reason, 'session-gone')
  assert.equal(results[1].delivered, 0)
  assert.deepEqual(b.buffer('1'), ['status please'])
  assert.deepEqual(b.buffer('2'), [])
  // the attempt is logged even though nothing landed, so "attempted, the session was gone" is
  // distinguishable from "skipped this target entirely" — which is the bug this test is about
  assert.deepEqual(b.sends('2').map(s => s.reason), ['session-gone'])
  assert.deepEqual(b.sends('1').map(s => s.ok), [true])
})

// ---- status ------------------------------------------------------------------------------------

test('setStatus reads back, keeps repeats, and refuses an unknown status', () => {
  // The status title is repainted only on a CHANGE, so a caller that stamps its own title must be
  // able to see the repeats; and a typo'd status that silently no-ops loses the fleet's red/green.
  const b = fake()
  const h = b.spawn(spec(1))
  assert.equal(b.statusOf(h), null)
  assert.equal(b.setStatus(h, 'working'), true)
  b.setStatus(h, 'working')
  b.setStatus(h, 'blocked')
  assert.equal(b.statusOf(h), 'blocked')
  assert.deepEqual(b.statusHistory(h).map(s => s.status), ['working', 'working', 'blocked'])
  assert.throws(() => b.setStatus(h, 'busy'), /unknown status "busy"/)
  assert.deepEqual([...STATUS], ['working', 'ready', 'blocked'])
})

// ---- kill --------------------------------------------------------------------------------------

test('kill takes the scripted tree deepest-first and leaves the neighbouring session alone', () => {
  // Killing by exclusion once took an operator's unrelated session with it; and a dev server left
  // running under a killed agent holds its port forever.
  const b = fake()
  const one = b.spawn(spec(1))
  const two = b.spawn(spec(2))
  const agent = b.addChild(one, { name: 'claude', cmd: 'claude --model opus' })
  const server = b.addChild(agent, { name: 'node', cmd: 'node /w/app-session-1/node_modules/.bin/next dev' })
  const neighbour = b.addChild(two, { name: 'claude', cmd: 'claude --model opus' })

  const r = b.kill(one)
  assert.equal(r.ok, true)
  assert.equal(r.alreadyGone, false)
  assert.deepEqual(r.killed, [server, agent, one.shimPid])
  assert.deepEqual(r.survivors, [], 'the re-query found nothing left of the tree')

  const after = b.processes()
  for (const pid of [server, agent, one.shimPid]) assert.ok(!after.has(pid), `pid ${pid} should be gone`)
  assert.ok(after.has(two.shimPid) && after.has(neighbour))
  assert.deepEqual(descendants(after, two.shimPid), [neighbour])
  assert.deepEqual(b.list().map(h => h.id), ['2'])
  assert.equal(b.record('1').endReason, 'killed')
})

test('kill is idempotent — teardown after a crash kills sessions that are already gone', () => {
  const b = fake()
  const h = b.spawn(spec(1))
  assert.equal(b.kill(h).alreadyGone, false)
  assert.deepEqual(b.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
})

test('a kill that leaves a survivor reports it — relaunch is kill, VERIFY GONE, then spawn', () => {
  // `fleet relaunch` kills the tree, verifies it is gone, and only then spawns into the same
  // worktree. A kill that can never fail leaves every caller's verify-gone branch unexecuted, and
  // the survivor it should have found is a dev server still holding the slot's port.
  const b = fake()
  const h = b.spawn(spec(1))
  const agent = b.addChild(h, { name: 'claude', cmd: 'claude --model opus' })
  const server = b.addChild(agent, { name: 'node', cmd: 'node /w/app-session-1/node_modules/.bin/next dev' })
  injectFault(b, { killLeaves: '1' })

  const r = b.kill(h)
  assert.equal(r.ok, false, 'a kill that left processes behind is not a success')
  assert.equal(r.alreadyGone, false)
  assert.deepEqual(r.killed, [h.shimPid])
  assert.deepEqual(r.survivors, [server, agent], 'deepest first, the pids the plan meant to take')

  // what the caller does with them: the session is gone from the fleet, the tree is not
  const after = b.processes()
  assert.deepEqual(b.list(), [])
  assert.deepEqual(findByCommand(after, /next dev/).map(p => p.pid), [server])
  assert.throws(() => injectFault(b, { killLeaves: '9' }), /no live session "9"/)
})

// ---- injected failures -------------------------------------------------------------------------

test('a thrown spawn leaves no half-created session and no orphan process', () => {
  // Otherwise the next status read invents a session that nothing can address or kill.
  const b = fake()
  const before = b.processes().size
  injectFault(b, { spawnThrows: 'the terminal host refused to spawn', times: 1 })

  assert.throws(() => b.spawn(spec(1)), /refused to spawn/)
  assert.deepEqual(b.list(), [])
  assert.deepEqual(b.spawned(), [])
  assert.equal(b.processes().size, before)

  // the budget was one: the retry succeeds, so a caller's retry path is testable
  const h = b.spawn(spec(1))
  assert.equal(b.isAlive(h), true)
})

test('an unbounded spawn fault throws the default message until it is cleared', () => {
  // No `times` means EVERY spawn throws — a caller that retries forever must be able to see that —
  // and `clear` has to drop the spawn fault, not only the send one.
  const b = fake()
  injectFault(b, { spawnThrows: true })
  assert.throws(() => b.spawn(spec(1)), /the terminal host refused to spawn/)
  assert.throws(() => b.spawn(spec(1)), /the terminal host refused to spawn/)
  assert.deepEqual(b.spawned(), [])

  injectFault(b, { clear: true })
  assert.equal(b.isAlive(b.spawn(spec(1))), true)
})

test('a fault that would silently inject nothing is refused', () => {
  // Same rule as the typo'd `dies` label: a value that degrades to "no fault" leaves a test that
  // passes while proving nothing. A negative or fractional sendLimit used to mean "no limit".
  const b = fake()
  const h = b.spawn(spec(1))
  for (const bad of [-1, 2.5, '62', {}]) assert.throws(() => injectFault(b, { sendLimit: bad }), TypeError)
  for (const bad of [0, '', 62, {}]) assert.throws(() => injectFault(b, { spawnThrows: bad }), TypeError)
  assert.throws(() => injectFault(b, { spawnThrows: true, times: 0 }), TypeError)
  assert.equal(b.send(h, 'abcdef').delivered, 6, 'not one of the refusals armed a fault')

  // false/null is plainly "disarm", never a fault whose message is the word "false"
  injectFault(b, { spawnThrows: true })
  injectFault(b, { spawnThrows: false })
  assert.equal(b.isAlive(b.spawn(spec(2))), true)
  injectFault(b, { sendLimit: null })
  assert.equal(b.send(h, 'abcdef').ok, true)
})

test('an inspector hands out a copy — poking at a record cannot end a live session', () => {
  const b = fake()
  const h = b.spawn(spec(1))
  const rec = b.record('1')
  rec.endedAt = 999
  rec.args.push('--rogue')
  rec.buffer.push('never sent')

  assert.equal(b.isAlive(h), true)
  assert.deepEqual(b.list().map(x => x.id), ['1'])
  assert.equal(b.record('1').endedAt, null)
  assert.ok(!b.record('1').args.includes('--rogue'), 'the argv the reconciler reads is untouched')
  assert.deepEqual(b.buffer('1'), [])
})

test('a session that dies on its own drops out of list while its spawn record survives', () => {
  // The gap between "what the launcher spawned" and "what the backend still has" is the only thing
  // a reclaimer can see, so both halves must stay readable.
  const b = fake()
  const h = b.spawn(spec(5))
  injectFault(b, { dies: '5' })

  assert.deepEqual(b.list(), [])
  assert.equal(b.isAlive(h), false)
  assert.equal(b.spawned().length, 1)
  assert.equal(b.record('5').endReason, 'died')
  assert.equal(b.processes().has(h.shimPid), false)
  assert.throws(() => injectFault(b, { dies: '5' }), /no live session "5"/)
})

test('a session can die and orphan the dev server that is still holding its port', () => {
  // "The window is gone" says nothing about the tree: the reclaimer has to find the survivor by
  // command line, which is the one place command-line matching is still allowed.
  const b = fake()
  const h = b.spawn(spec(1))
  const agent = b.addChild(h, { name: 'claude', cmd: 'claude --model opus' })
  const server = b.addChild(agent, { name: 'node', cmd: 'node /w/app-session-1/node_modules/.bin/next dev' })

  injectFault(b, { dies: '1', orphans: true })

  const after = b.processes()
  assert.equal(after.has(h.shimPid), false, 'the session process is gone')
  assert.ok(after.has(server), 'the dev server it started is not')
  assert.deepEqual(findByCommand(after, /next dev/).map(p => p.pid), [server])
})

// ---- layout ------------------------------------------------------------------------------------

test('layout announces what it cannot place instead of silently placing nothing', () => {
  const b = fake()
  const handles = [1, 2, 3].map(n => b.spawn(spec(n)))

  const tiled = b.layout(handles, 'tiled-panes')
  assert.deepEqual([tiled.placed, tiled.notice], [3, null])
  const windows = b.layout(handles, 'windows')
  assert.deepEqual([windows.placed, windows.notice], [3, null])

  const pixel = b.layout(handles, 'pixel-grid')
  assert.equal(pixel.placed, 0)
  assert.match(pixel.notice, /unavailable on this terminal backend \(no pixelLayout\)/)
  assert.match(planLayout(handles, 'diagonal', b.capabilities()).notice, /unknown mode "diagonal"/)

  // the same for a backend that cannot tile at all: planLayout is pure, so the branch this fake's
  // own capabilities can never reach is still testable
  const noTiling = planLayout(handles, 'tiled-panes', NO_CAPABILITIES)
  assert.equal(noTiling.placed, 0)
  assert.match(noTiling.notice, /tiling: unavailable on this terminal backend \(no gridLayout\)/)
})

test('layout places only the live handles — a stale list is not a recomputed one', () => {
  // A caller that retiles with the list it launched with must be distinguishable from one that
  // recomputed the live set, or exactly the caller bug this fake exists to catch passes here.
  const b = fake()
  const handles = [1, 2, 3].map(n => b.spawn(spec(n)))
  b.kill(handles[0])

  const r = b.layout(handles, 'windows')
  assert.equal(r.placed, 2)
  assert.equal(r.requested, 3)
  assert.deepEqual(r.stale, ['1'])
  assert.match(r.notice, /1 of 3 handles are no longer live \(1\)/)

  const recomputed = b.layout(b.list(), 'windows')
  assert.deepEqual([recomputed.placed, recomputed.stale, recomputed.notice], [2, [], null])
})

test('every layout call is recorded — a refilled wave stacks on the fleet it joined unless the caller retiles', () => {
  const b = fake()
  const first = [1, 2].map(n => b.spawn(spec(n)))
  b.layout(first, 'tiled-panes')
  const all = [...first, b.spawn(spec(3))]
  b.layout(all, 'tiled-panes')
  assert.deepEqual(b.layouts().map(l => l.placed), [2, 3])
})

test('focus is exact and reports a miss', () => {
  const b = fake()
  const one = b.spawn(spec(1))
  const two = b.spawn(spec(2))
  assert.equal(b.focus(two), true)
  assert.equal(b.focusedId(), '2')
  b.kill(one)
  assert.equal(b.focus(one), false)
  assert.equal(b.focusedId(), '2', 'a failed focus must not move the focus')

  // and the focus dies with its session: still reporting '2' here reads as "the focus is on a live
  // session" to a caller asserting the state after a teardown
  b.kill(two)
  assert.equal(b.focusedId(), null)
})
