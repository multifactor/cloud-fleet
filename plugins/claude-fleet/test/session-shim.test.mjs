import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  buildChildSpec, runShim, main, parseArgv, markerFor, assertDescriptor, readDescriptor,
  patchDescriptor, readResolvedConfig, parseSessionState, nextPaint, prependPath, pathKeyOf,
  scanLocks, exitRecord, lockOwnersOf, heartbeatMsFor, defaultSpawn, installSignalGuards,
  STRIPPED_ENV, HEARTBEAT_MS, AGENTS, BYPASS_ARGS,
} from '../src/session/shim.mjs'
import { hasSessionMarker, sessionLabelOf } from '../src/sys/proc.mjs'
import { tryAcquire, readHolder } from '../src/sys/lock.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'

const SHIM_URL = new URL('../src/session/shim.mjs', import.meta.url).href

const T0 = Date.parse('2026-03-14T09:00:00Z')
const STALE_MS = 12 * 60_000

const cfg = (over = {}) => {
  const c = defaultsFor()
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

/** A temp root that goes away with the test, however the test ends. */
function tmpRoot(t, prefix = 'fleet-shim-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

/** A state directory, a worktree, a descriptor, and two pool locks: ours and another session's. */
function setup(t, { role = 'working', extra = {} } = {}) {
  const root = tmpRoot(t)
  const stateDir = path.join(root, 'state')
  const worktree = path.join(root, 'app-session-3')
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })

  const file = path.join(stateDir, 'sessions', '3.json')
  const onDisk = {
    id: 'sess-3-9f2a', label: '3', role, worktree, branch: '', issue: 'ABC-1234',
    stateFile: path.join(stateDir, 'sessions', '3.state'),
    ticketFile: path.join(stateDir, 'tickets', 'ABC-1234.md'),
    backendRef: { window: 'fleet:3' },
    tracker: { id: 'example-tracker', mode: 'mcp', scope: 'team-1', states: { 'in-progress': 'In Progress' }, assignee: 'me' },
    paths: {
      stateDir,
      flagsDir: path.join(stateDir, 'flags'),
      outboxDir: path.join(stateDir, 'tracker-outbox'),
      artifactsDir: path.join(stateDir, 'dev-pages'),
    },
    playbook: '/plugin/playbooks/session.md',
    readyFlag: '.fleet-ready', agent: 'claude', model: 'opus',
    testingUrls: ['http://localhost:3000'],
    ...extra,
  }
  // The launcher does not write the descriptor's own path inside it; the shim knows it from argv.
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2))

  const locksDir = path.join(stateDir, 'locks')
  fs.mkdirSync(path.join(locksDir, 'testing'), { recursive: true })
  fs.mkdirSync(path.join(locksDir, 'emulator'), { recursive: true })
  const ours = path.join(locksDir, 'testing', 'testing')
  const theirs = path.join(locksDir, 'emulator', 'emulator-5554')
  tryAcquire(ours, { owner: onDisk.id, nowMs: T0, staleMs: STALE_MS })
  tryAcquire(theirs, { owner: 'sess-4-11bc', nowMs: T0, staleMs: STALE_MS })

  return { root, stateDir, worktree, file, locksDir, ours, theirs, descriptor: { ...onDisk, file } }
}

/** A fake agent process whose exit the test controls. */
function fakeAgent(pid = 4242) {
  const calls = []
  let settle = null
  return {
    calls,
    spawn(spec) {
      calls.push(spec)
      return { pid, pgid: pid, wait: () => new Promise((resolve, reject) => { settle = { resolve, reject } }) }
    },
    exit(r) { settle.resolve(r) },
    fail(e) { settle.reject(e) },
  }
}

/** A timer the test steps by hand, so a heartbeat is deterministic rather than a sleep. */
function fakeTimer() {
  const state = { fn: null, ms: null, cleared: false }
  return {
    state,
    setTimer: (fn, ms) => { state.fn = fn; state.ms = ms; return { unref() {} } },
    clearTimer: () => { state.cleared = true },
    tick: () => state.fn(),
  }
}

// ---- the child spec (pure) ----------------------------------------------------------------------

test('the two variables that silence a session transcript are deleted from the agent environment', t => {
  // Inherited, the agent is a CHILD session: it writes no transcript at all, so every watcher that
  // reads transcripts goes blind and resume has nothing to resume from — with a window that looks fine.
  const s = setup(t)
  const spec = buildChildSpec(s.descriptor, cfg(), {
    baseEnv: { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', HOME: '/home/ada', PATH: '/usr/bin' },
  })
  for (const name of STRIPPED_ENV) assert.equal(name in spec.env, false, `${name} must not reach the agent`)
  assert.deepEqual(spec.stripped, ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'])
  assert.equal(spec.env.HOME, '/home/ada', 'the rest of the environment is passed through untouched')
})

test('the session marker names the SHIM — one exact argv token, and never on the agent', t => {
  const s = setup(t)
  const seven = buildChildSpec({ ...s.descriptor, label: '7' }, cfg())
  const seventy = buildChildSpec({ ...s.descriptor, label: '70' }, cfg())
  assert.equal(seven.marker, '--fleet-session=7')
  assert.equal(hasSessionMarker(seven.marker, 7), true)
  assert.equal(hasSessionMarker(seven.marker, 70), false)
  assert.equal(sessionLabelOf(seventy.marker), '70')
  // ⛔ The launcher puts it on the shim's own command line and there only. Carried by the agent too,
  // reconcilePlan sees TWO marked pids for every healthy label — the duplicate launch it is built to
  // report — and may bind `shimPid` to the agent, so `fleet kill` walks the tree from the wrong root.
  assert.equal(sessionLabelOf(seven.args.join(' ')), null, 'the agent is not a second shim')
  assert.deepEqual(parseArgv(['--fleet-session=7', '/state/app/sessions/7.json']),
    { label: '7', file: '/state/app/sessions/7.json' })
  // a label that tokenises into two words would match nothing at all
  assert.throws(() => markerFor('3 extra'), /cannot be an argv token/)
  assert.throws(() => markerFor(''), /cannot be an argv token/)
})

test('the model is always on the command line, and a fleet with no model refuses to start', t => {
  // With no model in the host settings the CLI picks its own default; a settings change once moved a
  // whole running fleet onto the wrong model without a word.
  const s = setup(t)
  const spec = buildChildSpec({ ...s.descriptor, model: null }, cfg())
  assert.deepEqual(spec.args.slice(0, 2), ['--model', 'opus'])
  assert.equal(buildChildSpec({ ...s.descriptor, model: 'sonnet' }, cfg()).args[1], 'sonnet')
  assert.throws(() => buildChildSpec({ ...s.descriptor, model: null }, cfg({ 'fleet.model': null })), /wrong model/)
  assert.throws(() => buildChildSpec({ ...s.descriptor, agent: 'bash' }, cfg()), /unknown agent/)
})

test('an unattended session is spawned in bypass-permissions mode, and "inherit" is the only way out', t => {
  // ⛔ Nobody is in the window. A session left on the host's default mode can stop on a permission
  // prompt no one will ever answer, and it then reads on `fleet status` as alive, ready and idle —
  // the same picture as a session with nothing left to do.
  const s = setup(t)
  assert.deepEqual(buildChildSpec(s.descriptor, cfg()).args, ['--model', 'opus', '--permission-mode', 'bypassPermissions'])
  // The model comes first: the flags are independent, but the model assertion above pins the order.
  assert.deepEqual(
    buildChildSpec(s.descriptor, cfg({ 'fleet.permissionMode': 'inherit' })).args,
    ['--model', 'opus'],
    'inherit is explicit, and leaves the agent on the host default',
  )
  // Every agent the schema allows must have a bypass argv, or the default mode cannot be honoured.
  for (const agent of AGENTS) {
    const args = buildChildSpec({ ...s.descriptor, agent }, cfg({ 'fleet.agent': agent })).args
    assert.ok(args.length > 2, `${agent} must carry a bypass-permissions argv, not just the model`)
    assert.deepEqual(args.slice(2), [...BYPASS_ARGS[agent]], `${agent}'s bypass argv reaches the command line verbatim`)
  }
})

test('a testing session carries its own slot and port, and refuses to start without them', t => {
  // {port} is otherwise only a URL placeholder, so a fixed-port project cannot start a second slot.
  const s = setup(t, { role: 'testing', extra: { slot: 2, branch: 'testing-2', port: 3001 } })
  const spec = buildChildSpec(s.descriptor, cfg())
  assert.equal(spec.env.FLEET_SLOT, '2')
  assert.equal(spec.env.FLEET_SLOT_BRANCH, 'testing-2')
  assert.equal(spec.env.FLEET_PORT, '3001')
  assert.equal(spec.env.FLEET_ROLE, 'testing')
  assert.throws(() => buildChildSpec({ ...s.descriptor, slot: undefined }, cfg()), /needs a slot number/)

  const w = setup(t)
  const working = buildChildSpec(w.descriptor, cfg())
  assert.equal('FLEET_SLOT' in working.env, false, 'a working session has no slot to own')
  assert.equal(working.env.FLEET_SESSION, '1')
  assert.equal(working.env.FLEET_SESSION_FILE, w.file)
  assert.equal(working.env.FLEET_STATE_DIR, w.stateDir)
  assert.equal(working.env.FLEET_TESTING_URL, 'http://localhost:3000')
  assert.equal(working.env.FLEET_TRACKER_MODE, 'mcp')
})

test('a role-scoped scalar in the inherited environment is another session\'s identity, and is dropped', t => {
  // A launcher started from inside a session window — or a relaunch inheriting an environment a
  // previous session grew — passes these down, and buildSessionEnv emits them for testing/checker
  // only. Left in place, playbooks/testing.md has a WORKING session reading another session's slot,
  // branch and port as its own. The default baseEnv is {}, so this is the only way to test it at all.
  const s = setup(t)
  const inherited = {
    FLEET_SLOT: '1', FLEET_SLOT_BRANCH: 'testing', FLEET_PORT: '3000',
    FLEET_SWEEP_DIR: '/state/app/sweeps/s1', FLEET_SLICE: 'a',
    FLEET_LABEL: '9', FLEET_ROLE: 'testing',
    // a config override the OPERATOR set (contract §3's env layer) is not ours to delete
    FLEET_COMMANDS_DEV_SERVER: 'npm run dev',
  }
  const working = buildChildSpec(s.descriptor, cfg(), { baseEnv: inherited })
  for (const name of ['FLEET_SLOT', 'FLEET_SLOT_BRANCH', 'FLEET_PORT', 'FLEET_SWEEP_DIR', 'FLEET_SLICE']) {
    assert.equal(name in working.env, false, `${name} belonged to another session`)
  }
  assert.equal(working.env.FLEET_LABEL, '3', 'the role-wide scalars are overwritten, not inherited')
  assert.equal(working.env.FLEET_ROLE, 'working')
  assert.equal(working.env.FLEET_COMMANDS_DEV_SERVER, 'npm run dev')

  // and a checker keeps the two that are its own, having dropped the testing session's
  const c = setup(t, { role: 'checker', extra: { sweepDir: '/state/app/sweeps/s2', slice: 'b' } })
  const checker = buildChildSpec(c.descriptor, cfg(), { baseEnv: inherited })
  assert.equal(checker.env.FLEET_SWEEP_DIR, '/state/app/sweeps/s2')
  assert.equal(checker.env.FLEET_SLICE, 'b')
  assert.equal('FLEET_SLOT' in checker.env, false)
})

test('PATH is prepended under the key the environment already spells (Windows says "Path")', t => {
  // A copied environment keeps the `Path` spelling; writing `PATH` beside it leaves the child with
  // two variables and the loader reading the one we did not touch — which is how a helper binary
  // goes missing from a spawned window and the proxy serves its own 404 instead of the app.
  const s = setup(t)
  const c = cfg({ 'paths.pathPrepend': ['C:\\tools\\bin'], 'paths.nodeBinDirs': ['C:\\node\\v20', 'C:\\tools\\bin\\'] })
  const spec = buildChildSpec(s.descriptor, c, { baseEnv: { Path: 'C:\\Windows' }, platform: 'win32' })
  assert.equal('PATH' in spec.env, false)
  assert.equal(spec.env.Path, 'C:\\tools\\bin;C:\\node\\v20;C:\\Windows')
  assert.equal(pathKeyOf({ Path: 'x' }, 'win32'), 'Path')
  assert.equal(pathKeyOf({}, 'linux'), 'PATH')
  // already present, in either spelling of the trailing separator: prepended once, never twice
  assert.equal(prependPath({ PATH: '/opt/n/bin:/usr/bin' }, ['/opt/n/bin'], 'linux').value, '/opt/n/bin:/usr/bin')
  // ⛔ but case-folding is a WINDOWS filesystem rule: on POSIX /opt/Bin and /opt/bin are two
  // directories, and dropping the second is the missing-helper-binary failure above.
  assert.equal(prependPath({ PATH: '/opt/Bin:/usr/bin' }, ['/opt/bin'], 'linux').value, '/opt/bin:/opt/Bin:/usr/bin')
  assert.equal(prependPath({ Path: 'C:\\Tools\\Bin' }, ['C:\\tools\\bin'], 'win32').value, 'C:\\Tools\\Bin')
})

// ---- running a session --------------------------------------------------------------------------

test('runShim registers itself, spawns the agent in the worktree, then records the exit and releases its slot', async t => {
  const s = setup(t)
  const agent = fakeAgent(4242)
  const timer = fakeTimer()
  const chdirs = []
  const baseEnv = { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', PATH: '/usr/bin' }

  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv, platform: 'linux',
    now: () => T0, selfPid: 1010, selfPgid: 1010,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    chdir: d => chdirs.push(d),
  })

  // registered BEFORE the agent starts: a session that is not in the registry cannot be killed,
  // sent to, or told apart from an unrelated agent.
  const midRun = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  assert.equal(midRun.shimPid, 1010)
  assert.equal(midRun.pgid, 1010)
  assert.equal(midRun.agentPid, 4242)
  assert.equal(midRun.startedAt, '2026-03-14T09:00:00.000Z')
  assert.equal(midRun.issue, 'ABC-1234', 'a patch never drops a field the launcher wrote')
  assert.deepEqual(midRun.backendRef, { window: 'fleet:3' })

  agent.exit({ code: 0, signal: null })
  const r = await run

  assert.deepEqual(chdirs, [s.worktree])
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0].cwd, s.worktree)
  assert.equal(agent.calls[0].stdio, 'inherit')
  assert.deepEqual(agent.calls[0].args, ['--model', 'opus', '--permission-mode', 'bypassPermissions'], 'the marker stays on the shim, not the agent; the model and the bypass mode are the only agent flags')
  for (const name of STRIPPED_ENV) assert.equal(name in agent.calls[0].env, false)
  // and out of the shim's own environment too, so nothing else the session spawns inherits them
  for (const name of STRIPPED_ENV) assert.equal(name in baseEnv, false)

  const onDisk = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  assert.deepEqual(onDisk.exit, {
    v: 1, session: '3', role: 'working', issue: 'ABC-1234', agentPid: 4242,
    code: 0, signal: null, error: null,
    releasedLocks: [{ pool: 'testing', slot: 'testing' }],
    at: '2026-03-14T09:00:00.000Z',
  })
  assert.deepEqual(r.released, [{ pool: 'testing', slot: 'testing' }])
  assert.equal(fs.existsSync(s.ours), false, 'our slot goes back to the pool')
  assert.equal(readHolder(s.theirs).owner, 'sess-4-11bc', 'another session\'s lock is never touched')
  assert.equal(timer.state.cleared, true)
})

test('every lock this session holds is heartbeated while the agent runs — and only this session\'s', async t => {
  // Staleness is timestamp-only, so a lock nobody refreshes is stolen on schedule while its owner is
  // still working: two sessions on one dev server, one capturing the other's merge.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  fs.mkdirSync(path.join(s.locksDir, 'testing', 'testing.steal'), { recursive: true })
  let clock = T0

  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => clock, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })

  clock = T0 + 60_000
  timer.tick()
  clock = T0 + 120_000
  timer.tick()

  assert.equal(readHolder(s.ours).heartbeatAt, new Date(T0 + 120_000).toISOString())
  assert.equal(readHolder(s.theirs).heartbeatAt, new Date(T0).toISOString(), 'a foreign lock is never refreshed')

  // the steal mutex is a lock-in-progress marker, not a slot: counted as one it would read as a
  // permanently unheartbeated, ownerless slot
  assert.deepEqual(scanLocks(s.locksDir).map(e => `${e.pool}/${e.slot}`).sort(), ['emulator/emulator-5554', 'testing/testing'])

  agent.exit({ code: 0, signal: null })
  const r = await run
  assert.deepEqual(r.heartbeats, [{ pool: 'testing', slot: 'testing' }, { pool: 'testing', slot: 'testing' }])
})

test('a lock is ours under either name the session answers to — the label acquire records, or its id', async t => {
  // `fleet pool acquire` records the session LABEL (docs/gotchas.md); `id` is the other spelling of
  // the same session (core/prompts.mjs defaults it to the label). A shim that recognised only one
  // heartbeats NOTHING — silently — and every slot it holds is stolen on schedule while it works.
  const s = setup(t)
  assert.deepEqual(lockOwnersOf(s.descriptor), ['3', 'sess-3-9f2a'])
  const byLabel = path.join(s.locksDir, 'testing', 'testing-2')
  tryAcquire(byLabel, { owner: s.descriptor.label, nowMs: T0, staleMs: STALE_MS })

  const agent = fakeAgent()
  const timer = fakeTimer()
  let clock = T0
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => clock, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  clock = T0 + 60_000
  timer.tick()
  assert.equal(readHolder(byLabel).heartbeatAt, new Date(T0 + 60_000).toISOString())
  assert.equal(readHolder(s.ours).heartbeatAt, new Date(T0 + 60_000).toISOString())

  agent.exit({ code: 0, signal: null })
  const r = await run
  assert.deepEqual(r.released.map(x => x.slot).sort(), ['testing', 'testing-2'])
  assert.equal(fs.existsSync(byLabel), false)
  assert.equal(readHolder(s.theirs).owner, 'sess-4-11bc')
})

test('a slot stolen while the agent ran is left with its new holder, and never reported as given back', async t => {
  // release() refuses anything owned by anyone else, and the exit record must not claim a slot the
  // pool has already handed on: a launcher reading it would count a free slot that is in use.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  const stolen = { owner: 'sess-9-aa01', pid: 999, acquiredAt: new Date(T0).toISOString(), heartbeatAt: new Date(T0).toISOString() }
  fs.writeFileSync(path.join(s.ours, 'holder.json'), JSON.stringify(stolen))

  agent.exit({ code: 0, signal: null })
  const r = await run
  assert.deepEqual(r.released, [])
  assert.deepEqual(r.exit.releasedLocks, [])
  assert.equal(readHolder(s.ours).owner, 'sess-9-aa01', 'the thief keeps the slot it took')
})

test('an agent that never started still gives its slot back and says why', async t => {
  // Otherwise the pool silently loses one slot per crashed session, and the fleet stops working
  // while looking busy.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  agent.fail(new Error('spawn claude ENOENT'))
  const r = await run

  assert.match(r.exit.error, /ENOENT/)
  assert.equal(r.exit.code, null)
  assert.deepEqual(r.released, [{ pool: 'testing', slot: 'testing' }])
  assert.equal(fs.existsSync(s.ours), false)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).exit.error, r.exit.error)
  assert.equal(timer.state.cleared, true)
})

test('a worktree that vanished under the shim still releases the slot, records why, and takes its guard down', async t => {
  // chdir and the registration patch used to run OUTSIDE the try: a worktree the reclaimer removed,
  // or a Windows rename losing the race with another reader of the descriptor, threw straight out —
  // no exit record, no release, a SIGINT listener left attached. Both are likelier than a bad spawn.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const signals = new EventEmitter()
  const r = await runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux', signals,
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    chdir: () => {
      const e = new Error(`ENOENT: no such file or directory, chdir '${s.worktree}'`)
      e.code = 'ENOENT'
      throw e
    },
  })

  assert.match(r.exit.error, /ENOENT/)
  assert.equal(agent.calls.length, 0, 'no agent is started in a worktree that is gone')
  assert.deepEqual(r.released, [{ pool: 'testing', slot: 'testing' }])
  assert.equal(fs.existsSync(s.ours), false)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).exit.error, r.exit.error)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('the status indicator repaints on a change only, and never on a half-written state file', async t => {
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const painted = []
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
    setStatus: status => painted.push(status),
  })

  timer.tick()                                                     // no state file yet
  fs.writeFileSync(s.descriptor.stateFile, 'working\n')
  timer.tick()
  timer.tick()                                                     // unchanged
  fs.writeFileSync(s.descriptor.stateFile, '{"status":"bloc')      // caught mid-write by the hook
  timer.tick()
  fs.writeFileSync(s.descriptor.stateFile, '{"status":"blocked","at":"2026-03-14T09:05:00Z"}')
  timer.tick()

  assert.deepEqual(painted, ['working', 'blocked'])
  agent.exit({ code: 0, signal: null })
  const r = await run
  assert.equal(r.painted, 'blocked')

  assert.equal(parseSessionState('ready'), 'ready')
  assert.equal(parseSessionState('{"state":"ready"}'), 'ready')
  assert.equal(parseSessionState('finished'), null, 'an unknown word is not a status')
  assert.deepEqual(nextPaint('working', 'garbage'), { paint: false, status: 'working' })
})

test('a paint that failed is retried on the next tick, never recorded as painted', async t => {
  // setStatus is a backend subprocess (tmux, Windows Terminal). Recording the new status before it
  // returns latches the window on a stale colour for the rest of the session, because nextPaint
  // repaints on a CHANGE only — and the colour is what an operator triages a screen of windows by.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const painted = []
  const logged = []
  let failNext = true
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
    log: m => logged.push(m),
    setStatus: status => {
      if (failNext) { failNext = false; throw new Error('tmux: no server running') }
      painted.push(status)
    },
  })

  fs.writeFileSync(s.descriptor.stateFile, 'working\n')
  timer.tick()
  assert.deepEqual(painted, [])
  assert.match(logged.join('\n'), /status repaint failed/)
  timer.tick()                                                     // same status, still unpainted
  assert.deepEqual(painted, ['working'], 'the tick after a failure repaints instead of giving up')

  agent.exit({ code: 0, signal: null })
  const r = await run
  assert.equal(r.painted, 'working')
})

test('SIGINT does not end the shim — the attached listener IS the guard, and it is removed on exit', async t => {
  // Ctrl-C in a session window reaches the whole foreground process group, so a keystroke meant for
  // the agent hits the shim too; a shim that dies there writes no exit record and holds its slot
  // until it ages out. Node terminates on SIGINT only while no listener is attached.
  const signals = new EventEmitter()
  const logged = []
  const guards = installSignalGuards(signals, m => logged.push(m))
  assert.equal(signals.listenerCount('SIGINT'), 1)
  signals.emit('SIGINT')
  signals.emit('SIGINT')
  assert.equal(logged.length, 2)
  guards.dispose()
  assert.equal(signals.listenerCount('SIGINT'), 0)

  // and a completed run leaves none behind: a relaunched shim would otherwise stack a listener per run
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const run = runShim(s.descriptor, {
    config: cfg(), spawn: agent.spawn, baseEnv: {}, platform: 'linux', signals,
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  assert.equal(signals.listenerCount('SIGINT'), 1)
  agent.exit({ code: 0, signal: null })
  await run
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

// ---- descriptor plumbing ------------------------------------------------------------------------

test('a descriptor missing anything the shim needs fails loudly, naming every field at once', t => {
  const s = setup(t)
  assert.throws(() => assertDescriptor({ label: '3' }), /missing id, role, worktree, file, stateFile, paths.stateDir/)
  assert.throws(() => assertDescriptor({ ...s.descriptor, role: 'boss' }), /unknown role "boss"/)
  // the descriptor's own path is not written inside it — it is argv, and it is $FLEET_SESSION_FILE
  const read = readDescriptor(s.file)
  assert.equal(read.file, s.file)
  assert.equal(read.label, '3')
  // ⛔ and argv wins even once a run has persisted `file`: the state dir moves (another profile, a
  // restored backup, a new repoKey) and a stored path then names a descriptor nobody is writing.
  patchDescriptor(s.file, { file: '/gone/state/sessions/3.json' }, { base: s.descriptor })
  assert.equal(readDescriptor(s.file).file, s.file)
})

test('a registry patch survives a torn file and never loses a field', t => {
  // The launcher and the watchers read this file continuously; a session that vanishes from the
  // registry has its worktree reclaimed under a live agent.
  const s = setup(t)
  fs.writeFileSync(s.file, '{"id": "sess-3-9f2a", "lab')
  const next = patchDescriptor(s.file, { shimPid: 77 }, { base: s.descriptor })
  assert.equal(next.shimPid, 77)
  assert.equal(next.issue, 'ABC-1234')
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), next)
  assert.throws(() => exitRecord(s.descriptor, { code: 0 }), /timestamp is required/)
})

test('main() takes the argv the launcher really spawns: the marker first, then the descriptor', async t => {
  // `node shim.mjs --fleet-session=3 <file>` (backends/types.mjs, and every backend test). Read as
  // argv[0], the marker was opened as a path and the session died of ENOENT before it ever started.
  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const resolved = path.join(s.stateDir, 'resolved.json')
  fs.writeFileSync(resolved, JSON.stringify({ v: 1, inputsHash: 'abc', slots: [] }))
  assert.throws(() => readResolvedConfig(s.stateDir), /carries no "config"/)
  fs.writeFileSync(resolved, JSON.stringify({ v: 1, inputsHash: 'abc', config: cfg(), slots: [] }))

  const done = main(['--fleet-session=3', s.file], {
    spawn: agent.spawn, baseEnv: {}, platform: 'linux', now: () => T0,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  agent.exit({ code: 3, signal: null })
  assert.equal(await done, 3)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).exit.code, 3)

  // a marker naming another session is a mis-paired launch: `fleet kill 4` would walk this tree
  assert.equal(await main(['--fleet-session=4', s.file], { config: cfg() }), 2)
  assert.equal(await main([]), 2)
})

// ---- the real launch path ------------------------------------------------------------------------

test('runShim drives the real child launcher: a live exit code comes back and the slot goes home', async t => {
  // Every other case injects `spawn`, so `defaultSpawn` — the only path a real session takes — could
  // be deleted outright and this file would stay green. Only the agent CLI is substituted here (a
  // test box has none); the spawn, the close event and the environment are the real ones.
  const s = setup(t)
  const timer = fakeTimer()
  const r = await runShim(s.descriptor, {
    config: cfg(),
    spawn: spec => defaultSpawn({ ...spec, command: process.execPath, args: ['-e', 'process.exit(5)'] }),
    baseEnv: { ...process.env }, now: () => T0,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })

  assert.equal(r.exit.code, 5)
  assert.equal(r.exit.error, null)
  assert.ok(r.exit.agentPid > 0, 'the agent pid is the real one, and it is in the registry')
  assert.deepEqual(r.released, [{ pool: 'testing', slot: 'testing' }])
  assert.equal(fs.existsSync(s.ours), false)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).exit.code, 5)
})

test('the real spawn keeps the shim alive to the end and replaces the agent environment', t => {
  // Both defects are invisible in-process, because the test runner's own loop holds this process
  // open: a detached, unref\'d child with `stdio: "inherit"` refs NOTHING, so the shim reached
  // `await child.wait()` and exited first — no heartbeats, no exit record, no release; and a spawn
  // helper that merges `{...process.env, ...env}` hands back the two variables that are stripped BY
  // ABSENCE. It takes a real node parent and a real child to see either.
  const root = tmpRoot(t, 'fleet-shim-spawn-')
  const probe = path.join(root, 'probe.mjs')
  // `absent`, never `""`: a variable set to the empty string is still a variable, and the agent's
  // own child-session check reads presence.
  const agent = 'setTimeout(() => { process.stdout.write("agent env " + ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"].map(k => k + "=" + (k in process.env ? JSON.stringify(process.env[k]) : "absent")).join(" ") + "; ") ; process.exit(7) }, 300)'
  fs.writeFileSync(probe, [
    `import { defaultSpawn } from ${JSON.stringify(SHIM_URL)}`,
    'const env = { ...process.env }',
    'for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"]) delete env[k]',
    `const child = defaultSpawn({ command: process.execPath, args: ['-e', ${JSON.stringify(agent)}], env, cwd: process.cwd(), stdio: 'inherit' })`,
    'const r = await child.wait()',
    'process.stdout.write("shim outlived it, exit " + r.code)',
  ].join('\n'))

  const out = execFileSync(process.execPath, [probe], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' },
  })
  assert.match(out, /agent env CLAUDECODE=absent CLAUDE_CODE_CHILD_SESSION=absent/,
    'the stripped variables do not come back from process.env')
  assert.match(out, /shim outlived it, exit 7/, 'the shim waited for its agent instead of exiting first')
})

test('the heartbeat cadence is derived from the configured staleness, not from a constant', async t => {
  // 12 minutes is only the DEFAULT of testing.lock.staleMinutes — a plain int with no floor. At
  // staleMinutes: 1 a fixed 30s cadence leaves two ticks of margin for a pass that walks the whole
  // locks tree and rewrites a holder file per slot, and one slow tick loses the slot.
  assert.equal(heartbeatMsFor(cfg()), HEARTBEAT_MS, 'the default staleness is far outside the ceiling')
  assert.equal(heartbeatMsFor(cfg({ 'testing.lock.staleMinutes': 1 })), 15_000)
  assert.equal(heartbeatMsFor(cfg({ 'testing.lock.staleMinutes': 60, 'emulator.lockStaleMinutes': 2 })), 30_000)
  assert.equal(heartbeatMsFor(undefined), HEARTBEAT_MS)

  const s = setup(t)
  const agent = fakeAgent()
  const timer = fakeTimer()
  const run = runShim(s.descriptor, {
    config: cfg({ 'testing.lock.staleMinutes': 1 }), spawn: agent.spawn, baseEnv: {}, platform: 'linux',
    now: () => T0, setTimer: timer.setTimer, clearTimer: timer.clearTimer, chdir: () => {},
  })
  assert.equal(timer.state.ms, 15_000, 'the running shim heartbeats on the derived cadence')
  agent.exit({ code: 0, signal: null })
  await run
})
