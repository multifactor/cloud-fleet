import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'

import { snapshotFrom } from '../src/sys/proc.mjs'
import { tryAcquire, heartbeat } from '../src/sys/lock.mjs'
import { runOrThrow } from '../src/sys/exec.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { buildSlots } from '../src/config/derive.mjs'
import { stateLayout } from '../src/config/paths.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import { writeSession } from '../src/core/fleet.mjs'

import * as orphans from '../src/supervisor/checks/orphans.mjs'
import * as rogue from '../src/supervisor/checks/rogue-servers.mjs'
import * as staleLocks from '../src/supervisor/checks/stale-locks.mjs'
import * as memory from '../src/supervisor/checks/memory.mjs'
import * as sessions from '../src/supervisor/checks/sessions.mjs'
import * as services from '../src/supervisor/checks/services.mjs'
import * as slots from '../src/supervisor/checks/slots.mjs'
import {
  runPass, startLoop, instanceDecision, isWatchArgv, strikesFrom, buildStatus, formatLogLine,
  leftoverPatterns, defaultLeftovers, readStatus, statusPath, logPath, CHECK_NAMES,
} from '../src/supervisor/loop.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const iso = ms => new Date(ms).toISOString()
const T0 = Date.parse('2026-03-14T10:00:00Z')
const GB = 1024 ** 3
const W = '/w'

/** A resolved config with the derived keys the supervisor reads filled in by hand. */
const cfg = (over = {}) => {
  const c = defaultsFor()
  setPath(c, 'commands.bootstrap', 'npm install')
  setPath(c, 'commands.devServer', 'node dev-server.mjs')
  setPath(c, 'devServer.serverProcessPattern', 'dev-server\\.mjs')
  setPath(c, 'repo.name', 'app')
  setPath(c, 'repo.worktreeParent', W)
  setPath(c, 'testing.branches', ['testing', 'testing-2', 'testing-3', 'testing-4'])
  setPath(c, 'testing.count', 0)
  setPath(c, 'fleet.size', 4)
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

const desc = (label, over = {}) => ({ label: String(label), role: 'working', worktree: `${W}/app-session-${label}`, branch: '', issue: 'ABC-1234', ...over })
const slotDesc = (n, over = {}) => {
  const branch = n === 1 ? 'testing' : `testing-${n}`
  return { label: branch, role: 'testing', slot: n, port: 3000 + n - 1, branch, worktree: `${W}/app-${branch}`, ...over }
}
const proc = (pid, ppid, name, cmd, extra = {}) => ({ pid, ppid, name, cmd, startedAt: 200, ...extra })
const shim = (pid, label) => proc(pid, 1, 'node', `node shim.mjs --fleet-session=${label} /s/sessions/${label}.json`, { startedAt: 100 })

/**
 * The machine as a fleet sees it: the terminal (1); the supervisor (50) under the shell that launched
 * it (40), whose own command line carries the words `cli.mjs watch`; sessions 1 and 10; the testing
 * slot with its server (122); the operator's own hand-started agent (900); a browser (901).
 */
function machine() {
  return snapshotFrom([
    proc(1, 0, 'terminal', 'terminal', { startedAt: 0 }),
    proc(40, 1, 'powershell', 'powershell -Command node cli.mjs watch', { startedAt: 90 }),
    proc(50, 40, 'node', 'node C:\\plugin\\src\\cli.mjs watch', { startedAt: 95 }),
    shim(100, 1), proc(101, 100, 'claude', 'claude --model opus'),
    shim(110, 10), proc(111, 110, 'claude', 'claude --model opus'),
    shim(120, 'testing'), proc(121, 120, 'claude', 'claude --model opus'),
    proc(122, 121, 'node', `node ${W}/app-testing/node_modules/.bin/dev-server.mjs`),
    proc(900, 1, 'claude', 'claude weekly-demo', { startedAt: 50 }),
    proc(901, 1, 'browser', 'browser --profile', { rssBytes: 6 * GB }),
  ])
}
const withProcs = (...more) => snapshotFrom([...machine().values(), ...more])
const without = (...pids) => snapshotFrom([...machine().values()].filter(p => !pids.includes(p.pid)))

// ---- the single-instance guard --------------------------------------------------------------------

test('guard: the shell that launched the supervisor self-matches the argv text and is NOT a second instance', () => {
  // A substring filter once counted the querying shell (and its children) and flipped the instance
  // count between 5 and 0 across three reads; the guard excludes self and every ancestor by pid.
  const naive = [...machine().values()].filter(p => /cli\.mjs watch/.test(p.cmd)).map(p => p.pid)
  assert.deepEqual(naive, [40, 50], 'the naive filter invents a phantom instance out of the launching shell')
  const d = instanceDecision(machine(), { selfPid: 50 })
  assert.equal(d.keep, true)
  assert.deepEqual(d.others, [])
})

test('guard: the OLDEST instance stays and the newer one exits; lookalike argvs and an empty snapshot decide nothing', () => {
  // An orphaned second scanner once kept reporting "all healthy" at 1.9 GB free — the fix is a
  // deterministic winner, not "both continue".
  const older = withProcs(proc(60, 1, 'node', 'node /opt/plugin/src/cli.mjs watch', { startedAt: 10 }))
  const lose = instanceDecision(older, { selfPid: 50 })
  assert.equal(lose.keep, false)
  assert.equal(lose.oldest.pid, 60)
  assert.match(lose.reason, /older supervisor/)

  const newer = withProcs(proc(60, 1, 'node', 'node /opt/plugin/src/cli.mjs watch', { startedAt: 500 }))
  const win = instanceDecision(newer, { selfPid: 50 })
  assert.equal(win.keep, true)
  assert.deepEqual(win.others.map(o => o.pid), [60])

  // `cli.mjs status`, `cli.mjs watcher`, the words inside a quoted message, and a shell whose single
  // quoted argument contains them are none of them the supervisor
  const lookalikes = withProcs(
    proc(61, 1, 'node', 'node cli.mjs status'),
    proc(62, 1, 'node', 'node cli.mjs watcher'),
    proc(63, 1, 'node', 'node cli.mjs send 3 "please run cli.mjs watch"'),
    proc(64, 1, 'bash', 'bash -c "node cli.mjs watch"'),
  )
  assert.equal(instanceDecision(lookalikes, { selfPid: 50 }).others.length, 0)
  assert.ok(isWatchArgv('node "C:\\p q\\src\\cli.mjs" watch'))
  assert.ok(isWatchArgv('node /opt/plugin/src/cli.mjs watch --json'))
  assert.ok(!isWatchArgv('node cli.mjs status'))
  // the operator's own `npx claude-fleet watch` runs the bin entry (contract §2: bin/claude-fleet.mjs →
  // src/cli.mjs) — a guard that knew only `cli.mjs` would let it run beside the launcher's
  assert.ok(isWatchArgv('node /home/ada/.npm/_npx/abc/node_modules/claude-fleet/bin/claude-fleet.mjs watch'))
  const viaBin = withProcs(proc(65, 1, 'node', 'node /opt/plugin/bin/claude-fleet.mjs watch', { startedAt: 10 }))
  assert.equal(instanceDecision(viaBin, { selfPid: 50 }).keep, false)

  // an empty snapshot is a failed listing, never proof of being alone
  const empty = instanceDecision(snapshotFrom([]), { selfPid: 50 })
  assert.equal(empty.keep, true)
  assert.equal(empty.degraded, true)
})

// ---- orphans ---------------------------------------------------------------------------------------

test('orphans: only node/agent processes inside an UNREGISTERED fleet folder, on a path boundary; killed from the root, deepest-first', () => {
  // Kill-by-exclusion once destroyed the operator's hour-old agent. Here 900 (no fleet ancestor),
  // the sibling app-session-20, a git process in the leftover, and a registered session's helper
  // reading out of the leftover are all left alone; only the positively identified tree goes.
  const snap = withProcs(
    proc(300, 1, 'node', `node ${W}/app-session-2/node_modules/.bin/vitest`),
    proc(301, 300, 'node', `node ${W}/app-session-2/worker.js`),
    proc(310, 1, 'node', `node ${W}/app-session-20/build.js`),
    proc(320, 1, 'git', `git -C ${W}/app-session-2 status`),
    proc(330, 101, 'node', `node ${W}/app-session-2/read.js`),
  )
  const v = orphans.verdict({ snapshot: snap, leftovers: [{ path: `${W}/app-session-2` }], selfPid: 50 })
  assert.deepEqual(v.found.map(f => f.pid).sort((a, b) => a - b), [300, 301])
  assert.deepEqual(v.repairs.map(r => r.root), [300], 'one repair per tree root; the kill itself walks deepest-first')

  const calls = []
  const a = orphans.apply(v.repairs, { killTree: root => { calls.push(root); return { killed: [301, 300], survivors: [] } } })
  assert.deepEqual(calls, [300])
  assert.equal(a.repaired.length, 1)

  // a survivor is a failed repair whatever the kill call reported
  const b = orphans.apply(v.repairs, { killTree: () => ({ killed: [300], survivors: [301] }) })
  assert.equal(b.failed.length, 1)
  assert.match(b.failed[0].error, /survived/)

  // an empty snapshot judges nothing
  const e = orphans.verdict({ snapshot: snapshotFrom([]), leftovers: [{ path: `${W}/app-session-2` }], selfPid: 50 })
  assert.deepEqual(e.repairs, [])
  assert.equal(e.ok, false)
})

// ---- rogue servers ---------------------------------------------------------------------------------

test('rogue-servers: a dev server inside a WORKING worktree is tree-killed; the same server inside the testing slot is the slot', () => {
  // Working sessions are serverless — a dozen stacks at once hard-powered a machine off — and this
  // check is what makes that a rule rather than a request. The slot's server (122) is never touched.
  const snap = withProcs(
    proc(200, 101, 'node', `node ${W}/app-session-1/node_modules/.bin/dev-server.mjs`),
    proc(201, 200, 'node', `node ${W}/app-session-1/node_modules/.bin/dev-server.mjs --child`),
  )
  const registry = [desc(1), desc(10), slotDesc(1)]
  const v = rogue.verdict({ snapshot: snap, registry, pattern: 'dev-server\\.mjs', selfPid: 50 })
  assert.deepEqual(v.found.map(f => f.pid).sort((a, b) => a - b), [200, 201])
  assert.deepEqual(v.repairs.map(r => [r.root, r.label]), [[200, '1']])
  assert.ok(!v.found.some(f => f.pid === 122), 'a testing slot\'s server is the point of the slot')
  const calls = []
  rogue.apply(v.repairs, { killTree: root => { calls.push(root); return { killed: [201, 200], survivors: [] } } })
  assert.deepEqual(calls, [200])
})

test('rogue-servers: the worktree is matched on a path boundary, and a false-positive pattern never reaches the agent', () => {
  // `app-session-1` is a prefix of `app-session-10`; and a pattern derived as `claude` from a bad
  // package script would tree-kill the session's own agent — the exact false positive the doctor
  // echoes the pattern for.
  const snap = withProcs(proc(210, 1, 'node', `node ${W}/app-session-10/node_modules/.bin/dev-server.mjs`))
  assert.deepEqual(rogue.verdict({ snapshot: snap, registry: [desc(1)], pattern: 'dev-server\\.mjs', selfPid: 50 }).found, [])
  assert.deepEqual(rogue.verdict({ snapshot: snap, registry: [desc(1)], pattern: 'claude|shim', selfPid: 50 }).found, [])
  const none = rogue.verdict({ snapshot: snap, registry: [desc(1)], pattern: null, selfPid: 50 })
  assert.equal(none.ok, true)
  assert.match(none.notes[0], /not derived/)
})

// ---- stale locks -----------------------------------------------------------------------------------

test('stale-locks: staleness is the TIMESTAMP only — a dead holder pid with a fresh heartbeat is held; the mid-acquire empty directory is held', () => {
  // The pid in a holder file is the short-lived acquire shell; "holder gone" once handed one slot to
  // two sessions. The emulator pool has its own, longer window.
  const config = cfg()
  const fresh = { pool: 'testing', slot: 'testing', dir: '/l/testing/testing', holder: { owner: '3', pid: 999999, acquiredAt: iso(T0 - 60 * 60_000), heartbeatAt: iso(T0 - 60_000) } }
  const old = { pool: 'testing', slot: 'testing-2', dir: '/l/testing/testing-2', holder: { owner: '4', pid: 1, acquiredAt: iso(T0 - 60 * 60_000), heartbeatAt: iso(T0 - 13 * 60_000) } }
  const emu = { pool: 'emulator', slot: 'emulator-5554', dir: '/l/emulator/emulator-5554', holder: { owner: '5', heartbeatAt: iso(T0 - 20 * 60_000) } }
  const empty = { pool: 'testing', slot: 'testing-3', dir: '/l/testing/testing-3', holder: null, dirMtimeMs: T0 - 5_000 }
  const v = staleLocks.verdict({ locks: [fresh, old, emu, empty], nowMs: T0, config })
  assert.deepEqual(v.repairs.map(r => `${r.pool}/${r.slot}`), ['testing/testing-2'])
  assert.equal(v.found[0].owner, '4')
  assert.equal(v.ok, false)
})

test('stale-locks: on disk, removal re-checks under the steal mutex and refuses a lock refreshed since the verdict', () => {
  const dir = tmp()
  const config = cfg({ 'paths.stateDir': dir })
  const locks = stateLayout(dir, process.platform).locks
  // `<locksDir>/<pool>/` is the pool's directory (ResourcePool creates it); the slot's mkdir is the mutex
  fs.mkdirSync(path.join(locks, 'testing'), { recursive: true })
  const d = path.join(locks, 'testing', 'testing')
  tryAcquire(d, { owner: '3', nowMs: T0 - 20 * 60_000, staleMs: 12 * 60_000 })
  const v = staleLocks.verdict({ locks: staleLocks.readLocks(locks), nowMs: T0, config })
  assert.equal(v.repairs.length, 1)

  // the holder heartbeats between the verdict and the apply: removing it now would steal a live slot
  heartbeat(d, '3', T0 - 1_000)
  const refused = staleLocks.apply(v.repairs, { nowMs: T0 })
  assert.equal(refused.failed.length, 1)
  assert.ok(fs.existsSync(d))

  const later = staleLocks.verdict({ locks: staleLocks.readLocks(locks), nowMs: T0 + 20 * 60_000, config })
  const removed = staleLocks.apply(later.repairs, { nowMs: T0 + 20 * 60_000 })
  assert.equal(removed.repaired.length, 1)
  assert.equal(fs.existsSync(d), false)
  assert.equal(fs.existsSync(d + '.steal'), false, 'the steal mutex is released')
})

// ---- memory ----------------------------------------------------------------------------------------

test('memory: below the reserve is ATTENTION naming the biggest NON-fleet consumers; fleet trees are excluded; a failed probe reads tight', () => {
  // The real hogs are the browser and the design tools; a per-session cost by subtraction once blamed
  // every worker for forty browser processes and the file cache.
  const snap = withProcs(
    proc(902, 901, 'browser', 'browser --renderer', { rssBytes: 4 * GB }),
    proc(903, 1, 'design-tool', 'design-tool', { rssBytes: 3 * GB }),
  )
  snap.get(101).rssBytes = 10 * GB // the fleet's own agent is the single biggest process, and is not named
  const config = cfg()
  const v = memory.verdict({ reading: { freeBytes: 1.9 * GB, totalBytes: 64 * GB, pressure: 'warn' }, snapshot: snap, config, selfPid: 50 })
  assert.equal(v.ok, false)
  assert.match(v.notes[0], /^ATTENTION/)
  assert.deepEqual(v.found.map(c => c.name), ['browser', 'design-tool'])
  assert.equal(v.found[0].gb, 10)
  assert.ok(!v.found.some(c => c.name === 'claude'))

  assert.equal(memory.verdict({ reading: { degraded: true }, snapshot: snap, config, selfPid: 50 }).ok, false)
  assert.equal(memory.verdict({ reading: { freeBytes: 30 * GB, totalBytes: 64 * GB, pressure: 'normal' }, snapshot: snap, config, selfPid: 50 }).ok, true)
})

// ---- sessions --------------------------------------------------------------------------------------

test('sessions: alive via the backend handle, idle from the transcript mtime, stalled only when working and idle past the threshold', () => {
  // A session whose turn died on an API error sits behind a green tab forever; the transcript mtime
  // is the token-free tell. A dead session is dead (the reclaimer's business), not stalled, and a
  // handle the backend never minted is unknown, not dead.
  const backend = createFakeBackend({ clock: () => T0 })
  const spec = label => ({ id: String(label), role: 'working', title: 's', cwd: `${W}/app-session-${label}`, env: [], command: 'node', args: ['shim.mjs', `--fleet-session=${label}`] })
  const h1 = backend.spawn(spec(1))
  const h2 = backend.spawn(spec(2))
  const h3 = backend.spawn(spec(3))
  injectFault(backend, { dies: '2' })
  const registry = [
    desc(1, { backendRef: h1.backendRef }), desc(2, { backendRef: h2.backendRef }), desc(3, { backendRef: h3.backendRef }),
    desc(4, { backendRef: { ref: 'fake:never-minted' } }),
  ]
  const mt = { 1: T0 - 15 * 60_000, 2: T0 - 15 * 60_000, 3: T0 - 60_000, 4: null }
  const st = { 1: 'working', 2: 'working', 3: 'working', 4: 'ready' }
  const v = sessions.verdict({ registry, backend, nowMs: T0, newestMtime: d => mt[d.label], readState: d => st[d.label] })
  const by = Object.fromEntries(v.found.map(f => [f.label, f]))
  assert.deepEqual([by[1].alive, by[1].idleMinutes, by[1].state, by[1].stalled], [true, 15, 'working', true])
  assert.deepEqual([by[2].alive, by[2].stalled], [false, false], 'a dead session is dead, not stalled')
  assert.equal(by[3].stalled, false)
  assert.deepEqual([by[4].alive, by[4].idleMinutes, by[4].stalled], [null, null, false])
  assert.equal(v.ok, false)
  assert.match(v.notes[0], /1 session\(s\) stalled/)
})

test('sessions: the thin readers answer null for what is absent, and the newest mtime of what is there', () => {
  const dir = tmp()
  const a = path.join(dir, 'a.jsonl')
  const b = path.join(dir, 'b.jsonl')
  fs.writeFileSync(a, '')
  fs.utimesSync(a, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000))
  fs.writeFileSync(b, '')
  assert.equal(sessions.newestFileMtime(dir), fs.statSync(b).mtimeMs)
  assert.equal(sessions.newestFileMtime(path.join(dir, 'absent')), null)
  assert.equal(sessions.newestFileMtime(null), null)
  const sf = path.join(dir, '1.state')
  assert.equal(sessions.readStateFile(sf), null)
  fs.writeFileSync(sf, 'working\n')
  assert.equal(sessions.readStateFile(sf), 'working\n')
})

// ---- services --------------------------------------------------------------------------------------

test('services: the engine is repaired first and containers are deferred until it is up; nothing declared is a no-op; a non-zero start is a failed repair', () => {
  // After a reboot the container engine does not auto-start, the database stays down and every login
  // 500s while `/` serves 200 — the order engine → containers → ports is the rule.
  const config = cfg({
    'services.docker.required': true,
    'services.docker.startCommand': 'start-engine',
    'services.containers': [
      { name: 'app-postgres', startCommand: 'docker start app-postgres', healthHost: '127.0.0.1', healthPort: 5432 },
      { name: 'app-cache', startCommand: 'docker start app-cache' },
    ],
  })
  const down = services.verdict({ config, observed: { dockerUp: false, ports: { 'app-postgres': false, 'app-cache': null } } })
  assert.deepEqual(down.repairs.map(r => r.kind), ['start-docker'])
  assert.ok(down.notes.some(n => /deferred until the container engine/.test(n)))
  assert.ok(down.notes.some(n => /app-cache: no healthHost\/healthPort/.test(n)))

  const up = services.verdict({ config, observed: { dockerUp: true, ports: { 'app-postgres': false, 'app-cache': null } } })
  assert.deepEqual(up.repairs.map(r => [r.kind, r.command]), [['start-container', 'docker start app-postgres']])
  const ran = []
  const a = services.apply(up.repairs, { shellCommand: c => { ran.push(c); return { ok: false, code: 1, stderr: 'no such container' } } })
  assert.deepEqual(ran, ['docker start app-postgres'])
  assert.equal(a.failed.length, 1)
  assert.match(a.failed[0].error, /no such container/)

  const none = services.verdict({ config: cfg(), observed: {} })
  assert.equal(none.ok, true)
  assert.deepEqual(none.notes, ['no services declared'])
})

test('services: observe probes a real TCP port and reads a refused one as down; the engine is not probed unless required', async () => {
  const srv = net.createServer()
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const open = srv.address().port
  const probe = net.createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const closed = probe.address().port
  await new Promise(r => probe.close(r))
  try {
    const config = cfg({ 'services.containers': [{ name: 'a', healthHost: '127.0.0.1', healthPort: open }, { name: 'b', healthHost: '127.0.0.1', healthPort: closed }, { name: 'c' }] })
    const o = await services.observe(config, { probeDocker: () => { throw new Error('must not be probed when not required') } })
    assert.deepEqual(o, { dockerUp: null, ports: { a: true, b: false, c: null } })
  } finally {
    await new Promise(r => srv.close(r))
  }
})

// ---- slots -----------------------------------------------------------------------------------------

test('slots: a dead slot answers 404 — only 2xx/3xx is up; expectNotStatus covers a route that has no GET; dependsOnPrevious skips rather than double-counts', () => {
  const probes = [
    { path: '/', expectStatus: '2xx,3xx', timeoutSec: 45 },
    { path: '/api/health', expectStatus: '2xx,3xx', dependsOnPrevious: true },
    { path: '/api/login', expectNotStatus: [500] },
  ]
  for (const [status, ok] of [[200, true], [302, true], [404, false], [502, false], [500, false], [0, false]]) {
    assert.equal(slots.statusOk(status, probes[0]), ok, `status ${status}`)
  }
  assert.equal(slots.statusOk(404, probes[2]), true, 'a 404 on a non-GET route is the healthy answer')
  assert.equal(slots.statusOk(500, probes[2]), false)
  assert.equal(slots.statusOk(0, probes[2]), false)

  const v = slots.probeVerdict(probes, [{ status: 404 }, { status: 200 }, { status: 404 }])
  assert.equal(v.up, false)
  assert.equal(v.results[1].skipped, true)
  assert.equal(slots.probeVerdict(probes, [{ status: 200 }, { status: 200 }, { status: 404 }]).up, true)
  assert.equal(slots.probeVerdict([], []).up, null)
})

test('slots: a slot with NO server process is restarted only after softFaultStrikes consecutive faults, with the slot env, and the count resets on recovery', () => {
  // Two strikes once killed a healthy server that was still compiling; the default is four.
  const config = cfg({ 'testing.count': 1, 'devServer.softFaultStrikes': 4 })
  const table = buildSlots(config)
  const snap = without(122)
  const registry = [slotDesc(1)]
  const observed = { 1: { ready: true, routes: null, probes: [{ path: '/', status: 404 }] } }
  let strikes = {}
  for (let pass = 1; pass <= 3; pass++) {
    const v = slots.verdict({ slots: table, registry, config, snapshot: snap, observed, strikes })
    assert.deepEqual(v.repairs, [], `pass ${pass} must not restart`)
    assert.equal(v.found[0].state, 'down')
    assert.equal(v.found[0].strikes, pass)
    strikes = { 1: v.found[0].strikes }
  }
  const v4 = slots.verdict({ slots: table, registry, config, snapshot: snap, observed, strikes })
  assert.equal(v4.found[0].strikes, 4)
  assert.equal(v4.repairs.length, 1)
  const r = v4.repairs[0]
  assert.equal(r.kind, 'restart-slot')
  assert.equal(r.worktree, `${W}/app-testing`)
  assert.equal(r.command, 'node dev-server.mjs')
  assert.deepEqual(r.env, { FLEET_SLOT: '1', FLEET_SLOT_BRANCH: 'testing', FLEET_PORT: '3000' })

  const up = slots.verdict({ slots: table, registry, config, snapshot: snap, observed: { 1: { ready: true, routes: null, probes: [{ path: '/', status: 200 }] } }, strikes: { 1: 3 } })
  assert.deepEqual([up.found[0].state, up.found[0].strikes, up.ok], ['up', 0, true])

  // no commands.devServer: the fault is reported, nothing can be restarted from here
  const bare = slots.verdict({ slots: table, registry, config: cfg({ 'testing.count': 1, 'commands.devServer': null }), snapshot: snap, observed, strikes: { 1: 3 } })
  assert.deepEqual(bare.repairs, [])
  assert.ok(bare.notes.some(n => /commands\.devServer is unset/.test(n)))
})

test('slots: live server processes with failing probes are COMPILING and never restarted, however many strikes', () => {
  // A probe-only watchdog restarted a slot thirty seconds from serving, on every tick.
  const config = cfg({ 'testing.count': 1 })
  const v = slots.verdict({ slots: buildSlots(config), registry: [slotDesc(1)], config, snapshot: machine(), observed: { 1: { ready: true, routes: null, probes: [{ path: '/', status: 0 }] } }, strikes: { 1: 9 } })
  assert.deepEqual([v.found[0].state, v.found[0].processes, v.found[0].strikes], ['compiling', 1, 10])
  assert.deepEqual(v.repairs, [])
  assert.equal(v.ok, false)
})

test('slots: no ready flag means installing — the watchdog stands down and drops the strike clock', () => {
  // "Restarting" a slot whose worktree has no dependencies can never succeed, and during the install
  // phase of a big launch that watchdog was a net negative.
  const config = cfg({ 'testing.count': 1 })
  const v = slots.verdict({ slots: buildSlots(config), registry: [slotDesc(1)], config, snapshot: without(122), observed: { 1: { ready: false, routes: null, probes: [] } }, strikes: { 1: 3 } })
  assert.deepEqual([v.found[0].state, v.found[0].strikes, v.found[0].fault], ['installing', 0, false])
  assert.deepEqual(v.repairs, [])
})

test('slots: a route the proxy still lists blocks the restart; an absent route with no process allows it; route matching is boundary-safe', () => {
  // The rule is "no route AND no process"; a per-branch host is matched whole, so `testing.dev.localhost`
  // is not claimed by `x-testing.dev.localhost`, nor `localhost:3000` by `localhost:30001`.
  const config = cfg({ 'testing.count': 1, 'devServer.urlTemplate': 'https://{branch}.dev.localhost', 'devServer.routeListCommand': 'list-routes' })
  const table = buildSlots(config)
  const judge = routes => slots.verdict({ slots: table, registry: [slotDesc(1)], config, snapshot: without(122), observed: { 1: { ready: true, routes, probes: [{ path: '/', status: 404 }] } }, strikes: { 1: 4 } })
  const listed = judge(['testing.dev.localhost', 'testing-2.dev.localhost'])
  assert.equal(listed.found[0].route, true)
  assert.deepEqual(listed.repairs, [])
  assert.match(listed.found[0].reason, /still routes to it/)
  const absent = judge(['x-testing.dev.localhost', 'testing-2.dev.localhost'])
  assert.equal(absent.found[0].route, false)
  assert.equal(absent.repairs.length, 1)
  assert.equal(slots.routeRegistered(['http://localhost:30001 -> app'], 'http://localhost:3000'), false)
  assert.equal(slots.routeRegistered(['http://localhost:3000 -> app'], 'http://localhost:3000'), true)
  assert.equal(slots.routeRegistered(null, 'http://localhost:3000'), null)
})

test('slots: process counting is boundary-safe (app-testing never claims app-testing-2) and every processes[] shape is counted separately', () => {
  // A stack of two halves can be half-dead: pages 200 with every API route 500. The API shape below
  // its minimum is a soft fault; with a live page process it is "compiling", never a restart.
  const config = cfg({ 'testing.count': 2, 'devServer.processes': [{ name: 'api', match: 'api-worker', min: 1 }, { name: 'web', match: 'dev-server\\.mjs', notMatch: '--child', min: 1 }] })
  const snap = withProcs(
    proc(130, 1, 'node', `node ${W}/app-testing-2/node_modules/.bin/dev-server.mjs`),
    proc(131, 130, 'node', `node ${W}/app-testing-2/node_modules/.bin/dev-server.mjs --child`),
    proc(132, 130, 'node', `node ${W}/app-testing-2/api-worker.js`),
  )
  const c1 = slots.processCounts(snap, slotDesc(1), config)
  assert.equal(c1.total, 1)
  assert.deepEqual(c1.shapes.map(s => [s.name, s.count, s.ok]), [['api', 0, false], ['web', 1, true]])
  const c2 = slots.processCounts(snap, slotDesc(2), config)
  assert.deepEqual(c2.pids, [130, 131, 132])
  assert.deepEqual(c2.shapes.map(s => [s.name, s.count, s.ok]), [['api', 1, true], ['web', 1, true]])

  const ok = { ready: true, routes: null, probes: [{ path: '/', status: 200 }] }
  const v = slots.verdict({ slots: buildSlots(config), registry: [slotDesc(1), slotDesc(2)], config, snapshot: snap, observed: { 1: ok, 2: ok }, strikes: {} })
  assert.deepEqual(v.found.map(f => [f.slot, f.state]), [[1, 'compiling'], [2, 'up']])
  assert.match(v.found[0].reason, /api 0\/1/)
  assert.deepEqual(v.repairs, [])
})

test('slots: no pool is nothing to judge; an unregistered slot is reported, never restarted; an empty snapshot carries the strikes', () => {
  assert.equal(slots.verdict({ slots: buildSlots(cfg()), registry: [], config: cfg(), snapshot: machine(), observed: {}, strikes: {} }).ok, true)
  const config = cfg({ 'testing.count': 2 })
  const v = slots.verdict({ slots: buildSlots(config), registry: [slotDesc(1)], config, snapshot: machine(), observed: { 1: { ready: true, routes: null, probes: [{ path: '/', status: 200 }] } }, strikes: {} })
  assert.deepEqual(v.found.map(f => f.state), ['up', 'unregistered'])
  assert.deepEqual(v.repairs, [])
  // a failed snapshot is not evidence of recovery
  const e = slots.verdict({ slots: buildSlots(config), registry: [slotDesc(1)], config, snapshot: snapshotFrom([]), observed: {}, strikes: { 1: 2, 2: 1 } })
  assert.equal(e.ok, false)
  assert.deepEqual(e.found.map(f => f.strikes), [2, 1])
})

test('slots: apply re-checks the slot branch first and starts the server DETACHED in the slot worktree with the slot env', () => {
  // A server started off-branch registers the shared host, and working sessions capture against
  // whichever slot answered.
  const repair = { kind: 'restart-slot', slot: 2, branch: 'testing-2', worktree: `${W}/app-testing-2`, port: 3001, url: 'http://localhost:3001', command: 'node dev-server.mjs', env: { FLEET_SLOT: '2', FLEET_SLOT_BRANCH: 'testing-2', FLEET_PORT: '3001' } }
  const started = []
  const start = r => { started.push(r); return { pid: 4242, log: '/l/slot-2.log' } }
  const wrong = slots.apply([repair], { currentBranch: () => 'testing', start })
  assert.equal(wrong.failed.length, 1)
  assert.match(wrong.failed[0].error, /on branch "testing", not the slot branch "testing-2"/)
  const detached = slots.apply([repair], { currentBranch: () => '', start })
  assert.match(detached.failed[0].error, /detached HEAD/)
  const unknown = slots.apply([repair], { currentBranch: () => null, start })
  assert.match(unknown.failed[0].error, /cannot report/)
  assert.deepEqual(started, [], 'nothing started off-branch')

  const right = slots.apply([repair], { currentBranch: () => 'testing-2', start })
  assert.deepEqual([right.repaired[0].pid, right.repaired[0].log], [4242, '/l/slot-2.log'])
  assert.equal(started[0].env.FLEET_PORT, '3001')

  assert.deepEqual(slots.shellArgv('node dev-server.mjs', 'win32'), ['cmd.exe', ['/d', '/s', '/c', 'node dev-server.mjs']])
  assert.deepEqual(slots.shellArgv('node dev-server.mjs', 'linux'), ['/bin/sh', ['-c', 'node dev-server.mjs']])
})

test('slots: startSlotServer really spawns detached, in the worktree, with the slot env and both streams in <stateDir>/logs/slot-<n>.log', async () => {
  // A helper that inherits a dying parent's console dies on its next write.
  const dir = tmp()
  const wt = path.join(dir, 'wt')
  fs.mkdirSync(wt)
  const script = path.join(wt, 'serve.mjs')
  // The cwd is proven by a file the child writes RELATIVE to it: comparing process.cwd() against a
  // path handed through the platform shell is not a cwd test (cmd.exe /s passes the quotes through).
  fs.writeFileSync(script, [
    'import fs from "node:fs"',
    'fs.writeFileSync("started-here.txt", process.cwd())',
    'console.log("hello from slot", process.env.FLEET_SLOT, process.env.FLEET_SLOT_BRANCH, process.env.FLEET_PORT)',
    'console.error("stderr too")',
    '',
  ].join('\n'))
  const repair = { slot: 1, branch: 'testing', worktree: wt, command: 'node serve.mjs', env: { FLEET_SLOT: '1', FLEET_SLOT_BRANCH: 'testing', FLEET_PORT: '3000' } }
  const r = slots.startSlotServer(repair, { stateDir: dir })
  assert.ok(Number.isInteger(r.pid) && r.pid > 0)
  assert.equal(r.log, path.join(stateLayout(dir, process.platform).logs, 'slot-1.log'))
  let text = ''
  for (let i = 0; i < 100 && !/stderr too/.test(text); i++) {
    await sleep(50)
    text = fs.readFileSync(r.log, 'utf8')
  }
  assert.match(text, /restart by fleet watch: node serve\.mjs/)
  assert.match(text, /hello from slot 1 testing 3000/)
  assert.match(text, /stderr too/)
  assert.ok(fs.existsSync(path.join(wt, 'started-here.txt')), 'the server was started IN the slot worktree')
})

test('slots: httpProbe reads a real 200 and 404, a refused port and a silent server as 0 within timeoutMs', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return // never answers: the probe must give up on its own
    res.statusCode = req.url === '/api/health' ? 200 : 404
    res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    assert.equal(await slots.httpProbe(`http://127.0.0.1:${port}/api/health`), 200)
    assert.equal(await slots.httpProbe(`http://127.0.0.1:${port}/nope`), 404)
    const t = Date.now()
    assert.equal(await slots.httpProbe(`http://127.0.0.1:${port}/slow`, { timeoutMs: 300 }), 0)
    assert.ok(Date.now() - t < 5_000)
    assert.equal(await slots.httpProbe('not a url'), 0)
  } finally {
    srv.closeAllConnections?.()
    await new Promise(r => srv.close(r))
  }
  assert.equal(await slots.httpProbe(`http://127.0.0.1:${port}/api/health`), 0, 'refused reads as 0')
})

test('slots: observeSlots runs the route list ONCE per pass, never probes an uninstalled slot, honours dependsOnPrevious and the 45 s default', async () => {
  const config = cfg({ 'testing.count': 2, 'devServer.routeListCommand': 'list-routes', 'devServer.probes': [{ path: '/' }, { path: '/api/health', dependsOnPrevious: true }] })
  const table = buildSlots(config)
  const registry = [slotDesc(1), slotDesc(2)]
  const calls = { sh: 0, probes: [] }
  const deps = {
    shellCommand: () => { calls.sh++; return { ok: true, stdout: 'testing.dev.localhost\n' } },
    httpProbe: (url, { timeoutMs }) => { calls.probes.push([url, timeoutMs]); return Promise.resolve(200) },
    ready: wt => wt.endsWith('app-testing'),
  }
  const o = await slots.observeSlots({ slots: table, registry, config, ...deps })
  assert.equal(calls.sh, 1)
  assert.deepEqual(o[1].routes, ['testing.dev.localhost', ''])
  assert.deepEqual(o[1].probes, [{ path: '/', status: 200 }, { path: '/api/health', status: 200 }])
  assert.deepEqual(calls.probes, [['http://localhost:3000/', 45_000], ['http://localhost:3000/api/health', 45_000]])
  assert.deepEqual([o[2].ready, o[2].probes], [false, []], 'an uninstalled slot is not probed')

  const failing = await slots.observeSlots({ slots: table, registry, config, ...deps, httpProbe: () => Promise.resolve(404) })
  assert.deepEqual(failing[1].probes, [{ path: '/', status: 404 }, { path: '/api/health', status: null }])

  const broken = await slots.observeSlots({ slots: table, registry, config, ...deps, shellCommand: () => ({ ok: false, code: 2, stdout: '' }) })
  assert.deepEqual([broken[1].routes, broken[1].routesError], [null, 'exit 2'])
})

// ---- the loop --------------------------------------------------------------------------------------

/** A fleet under the fake backend: session 1 (working) with a rogue dev server under its agent. */
function fleet({ testingCount = 0, over = {} } = {}) {
  const dir = tmp()
  const config = cfg({ 'paths.stateDir': dir, 'testing.count': testingCount, ...over })
  const backend = createFakeBackend({ clock: () => T0 })
  const h = backend.spawn({ id: '1', role: 'working', title: 's', cwd: `${W}/app-session-1`, env: [], command: 'node', args: ['shim.mjs', '--fleet-session=1'] })
  const agent = backend.addChild(h, { name: 'claude', cmd: 'claude --model opus' })
  const rogueServer = backend.addChild(agent, { name: 'node', cmd: `node ${W}/app-session-1/node_modules/.bin/dev-server.mjs` })
  const transcriptDir = path.join(dir, 'transcripts')
  fs.mkdirSync(transcriptDir)
  fs.writeFileSync(path.join(transcriptDir, 'a.jsonl'), '')
  const stateFile = path.join(dir, '1.state')
  fs.writeFileSync(stateFile, 'working\n')
  writeSession(desc(1, { backendRef: h.backendRef, shimPid: h.shimPid, transcriptDir, stateFile }), { stateDir: dir })
  const killed = []
  let snaps = 0
  const ctx = {
    config,
    stateDir: dir,
    backend,
    selfPid: 50,
    nowMs: T0,
    // the supervisor (50) under the shell that launched it (40), whose argv carries the same words
    snapshot: () => {
      snaps++
      return snapshotFrom([
        ...backend.processes().values(),
        proc(40, 1, 'powershell', 'powershell -Command node cli.mjs watch', { startedAt: 90 }),
        proc(50, 40, 'node', 'node cli.mjs watch', { startedAt: 95 }),
      ])
    },
    probeMemory: () => ({ freeBytes: 30 * GB, totalBytes: 64 * GB, pressure: 'normal' }),
    leftovers: () => [],
    observeServices: async () => ({ dockerUp: null, ports: {} }),
    observeSlots: async () => ({}),
    io: { killTree: root => { killed.push(root); return { killed: [root], survivors: [] } } },
  }
  return { dir, config, backend, ctx, rogueServer, killed, snaps: () => snaps }
}

test('loop: one pass takes ONE snapshot, runs every check, applies repairs, writes watch.status.json in the contract shape and appends one log line', async () => {
  const f = fleet()
  const r = await runPass(f.ctx)
  assert.equal(f.snaps(), 1, 'the snapshot is taken once and reused by every check')
  assert.equal(r.exited, false)
  assert.deepEqual(f.killed, [f.rogueServer], 'the rogue server under the working session is tree-killed')

  const status = JSON.parse(fs.readFileSync(statusPath(f.dir), 'utf8'))
  assert.deepEqual([status.v, status.pass, status.at], [1, 1, iso(T0)])
  assert.deepEqual(Object.keys(status.checks), [...CHECK_NAMES])
  for (const [name, c] of Object.entries(status.checks)) {
    assert.deepEqual(Object.keys(c).sort(), ['found', 'notes', 'ok', 'repaired'], `${name} carries exactly {ok, found, repaired, notes}`)
  }
  assert.equal(status.checks['rogue-servers'].repaired.length, 1)
  assert.equal(status.checks.sessions.found[0].alive, true)
  assert.equal(status.checks.sessions.found[0].state, 'working')
  assert.deepEqual(status.memory, { freeGb: 30, totalGb: 64, pressure: 'normal', degraded: false })
  assert.equal(status.checks.memory.ok, true)

  const lines = fs.readFileSync(logPath(f.dir), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^2026-03-14T10:00:00\.000Z pass=1 orphans=ok rogue-servers=FAULT\(1,1 repaired\)/)
  // services run BEFORE slots: a dev server judged before its database is up is restarted for nothing
  assert.ok(CHECK_NAMES.indexOf('services') < CHECK_NAMES.indexOf('slots'))

  await runPass(f.ctx)
  assert.equal(readStatus(f.dir).pass, 2)
  assert.equal(fs.readFileSync(logPath(f.dir), 'utf8').trim().split('\n').length, 2)
})

test('loop: a check that throws is a recorded fault, and every check after it still runs', async () => {
  // A supervisor that dies on one bad reading is a supervisor nobody notices is gone.
  const f = fleet()
  f.ctx.observeServices = async () => { throw new Error('the container cli exploded') }
  const r = await runPass(f.ctx)
  const s = r.status
  assert.equal(s.checks.services.ok, false)
  assert.match(s.checks.services.notes[0], /^check threw: the container cli exploded/)
  assert.equal(s.checks.slots.ok, true, 'slots ran after the throw')
  assert.ok(fs.existsSync(statusPath(f.dir)))
  assert.match(fs.readFileSync(logPath(f.dir), 'utf8'), /services=FAULT .*\| check threw/)
})

test('loop: slot strike counts persist in watch.status.json between passes, and the fourth strike restarts the slot with the slot env', async () => {
  // A supervisor restart must not hand a dead slot a fresh clock; the file is the memory.
  const f = fleet({ testingCount: 1, over: { 'devServer.softFaultStrikes': 4 } })
  writeSession(slotDesc(1), { stateDir: f.dir })
  f.ctx.observeSlots = async () => ({ 1: { ready: true, routes: null, probes: [{ path: '/', status: 404 }] } })
  const starts = []
  f.ctx.io.currentBranch = () => 'testing'
  f.ctx.io.start = r => { starts.push(r); return { pid: 77, log: null } }
  for (let pass = 1; pass <= 3; pass++) {
    await runPass(f.ctx)
    assert.deepEqual(strikesFrom(readStatus(f.dir)), { 1: pass })
    assert.deepEqual(starts, [], `pass ${pass}`)
  }
  await runPass(f.ctx)
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0].env, { FLEET_SLOT: '1', FLEET_SLOT_BRANCH: 'testing', FLEET_PORT: '3000' })
  assert.equal(starts[0].worktree, `${W}/app-testing`)
  const s = readStatus(f.dir)
  assert.equal(s.checks.slots.repaired[0].pid, 77)
  assert.deepEqual(strikesFrom(s), { 1: 4 })
  assert.match(fs.readFileSync(logPath(f.dir), 'utf8').trim().split('\n').pop(), /slots=FAULT\(1,1 repaired\)/)

  // a branch that moved refuses the restart and says so in the notes, keeping the shape
  f.ctx.io.currentBranch = () => 'ada/abc-1234-fix'
  await runPass(f.ctx)
  const refused = readStatus(f.dir).checks.slots
  assert.deepEqual(refused.repaired, [])
  assert.ok(refused.notes.some(n => /^repair failed: restart-slot 1 — worktree is on branch "ada\/abc-1234-fix"/.test(n)))
})

test('loop: startLoop runs on the injected interval, never overlaps a pass in flight, and stop() halts it', async () => {
  // Two overlapping passes apply the same repair twice — two restarts of one slot.
  const f = fleet()
  let concurrent = 0
  let maxConcurrent = 0
  f.ctx.observeServices = async () => {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await sleep(120)
    concurrent--
    return { dockerUp: null, ports: {} }
  }
  const loop = startLoop({ ctx: f.ctx, intervalMs: 50, exit: () => assert.fail('must not exit') })
  await loop.first
  await sleep(450)
  // stop() resolves once the pass in flight has finished, so a teardown never races a repair
  await loop.stop()
  const n = loop.passes()
  await sleep(200)
  assert.equal(loop.passes(), n, 'nothing runs after stop()')
  assert.ok(n >= 2, `expected at least two passes, saw ${n}`)
  assert.ok(loop.skipped() >= 1, 'ticks that land during a pass are skipped, not queued')
  assert.equal(maxConcurrent, 1)
  assert.equal(readStatus(f.dir).pass, n)
  assert.equal(loop.running(), false)
})

test('loop: the single-instance guard — an OLDER supervisor makes this one exit without writing a status; the self-matching launch shell does not', async () => {
  // fleet()'s snapshot already carries the launching shell (40) with `cli.mjs watch` in its argv:
  // the first test above proved that pass runs. An older real instance must make this one yield.
  const f = fleet()
  const base = f.ctx.snapshot
  f.ctx.snapshot = () => snapshotFrom([...base().values(), proc(60, 1, 'node', 'node /opt/plugin/src/cli.mjs watch', { startedAt: 10 })])
  const exits = []
  const loop = startLoop({ ctx: f.ctx, intervalMs: 50, exit: reason => exits.push(reason) })
  const r = await loop.first
  assert.equal(r.exited, true)
  assert.equal(exits.length, 1)
  assert.match(exits[0], /older supervisor is running \(pid 60\)/)
  assert.equal(loop.running(), false)
  assert.equal(fs.existsSync(statusPath(f.dir)), false, 'a yielding instance writes no status')
  assert.match(fs.readFileSync(logPath(f.dir), 'utf8'), /second supervisor/)
  assert.deepEqual(f.killed, [], 'and applies no repair')
  await sleep(120)
  assert.equal(exits.length, 1, 'exit is called once')
})

test('loop: leftover patterns claim only fleet folders — the operator\'s sibling checkout is never a leftover (real git)', () => {
  // `{repo}-{branch}` with the branch left free would match every `app-*` sibling, and the orphan
  // check would then kill node processes inside a tree the fleet never owned.
  const parent = tmp()
  const primary = path.join(parent, 'app')
  fs.mkdirSync(primary)
  const g = (...args) => runOrThrow('git', ['-C', primary, ...args])
  g('init', '-q')
  g('-c', 'user.name=ada', '-c', 'user.email=ada@example.com', 'commit', '--allow-empty', '-q', '-m', 'init')
  g('worktree', 'add', '-q', '--detach', path.join(parent, 'app-session-1'), 'HEAD')
  for (const d of ['app-session-2', 'app-testing', 'app-docs', 'app-check-a01', 'app-testing-9']) {
    fs.mkdirSync(path.join(parent, d))
    fs.writeFileSync(path.join(parent, d, 'x.txt'), 'x')
  }
  const config = cfg({ 'repo.worktreeParent': parent })
  assert.deepEqual(defaultLeftovers(config).map(l => l.name).sort(), ['app-check-a01', 'app-session-2', 'app-testing'])
  assert.ok(leftoverPatterns(cfg()).every(re => !re.test('app-docs') && !re.test('app-testing-9')))
})

test('status: strikesFrom reads the slot counts back, buildStatus keeps the exact shape for a check that never ran, and formatLogLine surfaces ATTENTION', () => {
  assert.deepEqual(strikesFrom(null), {})
  assert.deepEqual(strikesFrom({ checks: { slots: { found: [{ slot: 1, strikes: 2 }, { slot: '2', strikes: 0 }, { slot: 3 }] } } }), { 1: 2, 2: 0 })
  const s = buildStatus({ nowMs: T0, pass: 7, results: { memory: { ok: false, found: [{ name: 'browser' }], repaired: [], notes: ['ATTENTION: 1.9 GB physical free is below the 8 GB reserve'] } }, reading: { freeBytes: 1.9 * GB, totalBytes: 64 * GB, pressure: 'warn' } })
  assert.deepEqual(Object.keys(s.checks), [...CHECK_NAMES])
  assert.deepEqual(s.checks.orphans, { ok: false, found: [], repaired: [], notes: ['not run'] })
  assert.equal(s.memory.freeGb, 1.9)
  const line = formatLogLine(s)
  assert.match(line, /^2026-03-14T10:00:00\.000Z pass=7 orphans=FAULT /)
  assert.match(line, /memory=FAULT\(1\) /)
  assert.match(line, /mem=1\.9GB \| ATTENTION: 1\.9 GB/)
})
