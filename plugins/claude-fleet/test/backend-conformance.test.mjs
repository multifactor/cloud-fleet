// The backend conformance suite: ONE file, parameterised over every terminal backend this machine can
// offer. If two backends pass it, the abstraction in src/backends/types.mjs is real; if only the fake
// passes it, every CLI test that runs against the fake proves nothing about a fleet.
//
// What always runs: `fake` (the reference implementation) and `none` (registry-first + a real
// detached process — the machinery Windows Terminal and PowerShell share, exercised on every OS).
// What runs on request: `tmux` and `windows-terminal`, because each opens real windows on the machine
// running the tests. FLEET_TEST_INTEGRATION=1 opts into whichever of the two this machine can run;
// FLEET_TEST_BACKEND=<name> demands exactly that one and FAILS rather than skips when it cannot run —
// the CI job that installs tmux and sets that variable must never go green on a run that quietly
// exercised the fake alone. A backend whose module is not in the tree yet is skipped with a printed
// reason: the real backends land independently of this file, and a suite that fails until the last of
// them exists gates nothing.
//
// Every "agent" spawned here is a `node -e` one-liner (a test brings its own world), and every claim a
// backend makes about a real process is checked against what actually happened — the bytes that
// reached the agent's stdin, the environment it saw, a fresh process snapshot — never against the
// backend's own report alone, because a backend that reports success is exactly what this suite exists
// to distrust.
//
// ⛔ The harness plays the LAUNCHER, not just the caller: a registry-first backend answers list/kill
// from `<stateDir>/sessions/<label>.json` (core/fleet.mjs), which the launcher writes — so this file
// writes and refreshes that descriptor on every spawn, stamped with the handle the backend returned.
// The fake keeps its own in-memory registry and ignores the file; writing it anyway is harmless there
// and is what lets ONE harness drive both. Without it the two are not interchangeable, only similar.

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { validateBackend, validateResultShape, CAPABILITY_NAMES, STATUS } from '../src/backends/types.mjs'
import { createFakeBackend, envMapOf } from '../src/backends/fake.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { stateLayout } from '../src/config/paths.mjs'
import { writeSession } from '../src/core/fleet.mjs'
import { which, run } from '../src/sys/exec.mjs'
import { snapshot } from '../src/sys/snapshot.mjs'
import { descendants, hasSessionMarker, findByCommand } from '../src/sys/proc.mjs'

// ---- which backends, and why not ----------------------------------------------------------------

/** Every backend this suite knows, in the order they run. `fake` first: if the reference fails, the rest is noise. */
const NAMES = Object.freeze(['fake', 'none', 'tmux', 'windows-terminal'])

/** How each real backend is loaded (the factory names are the ones src/backends/index.mjs looks up). */
const REAL = Object.freeze({
  none: { file: 'none.mjs', factory: 'createNoneBackend', tool: null, platform: null },
  tmux: { file: 'tmux.mjs', factory: 'createTmuxBackend', tool: 'tmux', platform: null },
  'windows-terminal': { file: 'windows-terminal.mjs', factory: 'createWindowsTerminalBackend', tool: 'wt.exe', platform: 'win32' },
})

const backendUrl = name => new URL(`../src/backends/${REAL[name].file}`, import.meta.url)

/**
 * PURE. Which backends to run, which to skip, and which the operator DEMANDED.
 *
 * A blank variable is unset — the same rule config/env.mjs applies to FLEET_* config, so
 * `FLEET_TEST_BACKEND=` in a CI matrix means "default", never "a backend called the empty string". A
 * value that names no backend THROWS: a typo that silently selected nothing would run the fake alone
 * and report the integration job green.
 *
 * @returns {Array<{name: string, run: boolean, required: boolean, reason: string|null}>}
 */
export function planCandidates({ env = {}, platform = process.platform, onPath = () => null, present = () => true } = {}) {
  const explicit = String(env.FLEET_TEST_BACKEND ?? '').trim() || null
  const integration = String(env.FLEET_TEST_INTEGRATION ?? '').trim() !== ''
  if (explicit && !NAMES.includes(explicit)) {
    throw new Error(`FLEET_TEST_BACKEND=${JSON.stringify(explicit)} names no backend (one of ${NAMES.join(' | ')})`)
  }
  const skip = (name, reason) => ({ name, run: false, required: false, reason })
  return NAMES.map(name => {
    const required = explicit === name
    if (name === 'fake') return { name, run: true, required, reason: null }
    const spec = REAL[name]
    // Absent is a skip even when demanded: the backends land independently of this file, and the job
    // that demands tmux must be able to run before tmux.mjs exists. Once it exists, a failing import
    // or a missing export is a FAILURE (see the discovery loop) — only the file's absence is benign.
    if (!present(name)) return skip(name, `src/backends/${spec.file} is not in the tree yet`)
    if (!spec.tool) return { name, run: true, required, reason: null }
    if (required) return { name, run: true, required, reason: null }
    if (explicit) return skip(name, `FLEET_TEST_BACKEND=${explicit} selects a different backend`)
    if (!integration) return skip(name, `set FLEET_TEST_INTEGRATION=1 (or FLEET_TEST_BACKEND=${name}) to run it against a real terminal`)
    if (spec.platform && spec.platform !== platform) return skip(name, `runs only on ${spec.platform} (this is ${platform})`)
    if (!onPath(spec.tool)) return skip(name, `${spec.tool} is not on PATH`)
    return { name, run: true, required, reason: null }
  })
}

test('candidate selection: FLEET_TEST_BACKEND demands one, FLEET_TEST_INTEGRATION enables the rest, blank is unset, a typo is refused', () => {
  // The selection is itself a behaviour: a wrong "skip" here is a suite that passes while testing
  // nothing, which is the one outcome a conformance suite must never produce.
  const by = plan => Object.fromEntries(plan.map(c => [c.name, c]))
  const linuxWithTmux = { platform: 'linux', onPath: t => (t === 'tmux' ? '/usr/bin/tmux' : null) }

  const quiet = by(planCandidates({ env: {}, ...linuxWithTmux }))
  assert.deepEqual([quiet.fake.run, quiet.none.run, quiet.tmux.run, quiet['windows-terminal'].run], [true, true, false, false])
  assert.match(quiet.tmux.reason, /FLEET_TEST_INTEGRATION/)

  const opted = by(planCandidates({ env: { FLEET_TEST_INTEGRATION: '1' }, ...linuxWithTmux }))
  assert.deepEqual([opted.tmux.run, opted.tmux.required], [true, false])
  assert.match(opted['windows-terminal'].reason, /runs only on win32/)
  assert.match(by(planCandidates({ env: { FLEET_TEST_INTEGRATION: '1' }, platform: 'linux' })).tmux.reason, /tmux is not on PATH/)
  const onWindows = by(planCandidates({ env: { FLEET_TEST_INTEGRATION: '1' }, platform: 'win32', onPath: t => (t === 'wt.exe' ? 'C:/wt.exe' : null) }))
  assert.deepEqual([onWindows['windows-terminal'].run, onWindows.tmux.run], [true, false])

  // demanded: it runs even where auto-detection would skip it, so a missing tool FAILS at the probe
  const demanded = by(planCandidates({ env: { FLEET_TEST_BACKEND: 'tmux' }, platform: 'linux' }))
  assert.deepEqual([demanded.tmux.run, demanded.tmux.required], [true, true])
  assert.deepEqual([demanded.fake.run, demanded.none.run], [true, true], 'the reference and the no-op backend always run')
  assert.match(demanded['windows-terminal'].reason, /selects a different backend/)

  assert.equal(by(planCandidates({ env: { FLEET_TEST_BACKEND: '   ' }, ...linuxWithTmux })).tmux.run, false, 'blank is unset')
  assert.throws(() => planCandidates({ env: { FLEET_TEST_BACKEND: 'tmxu' } }), /names no backend/)

  // not in the tree yet: skipped with the reason, even when demanded
  const absent = by(planCandidates({ env: { FLEET_TEST_BACKEND: 'tmux' }, present: () => false }))
  assert.deepEqual([absent.tmux.run, absent.none.run], [false, false])
  assert.match(absent.tmux.reason, /not in the tree yet/)
})

// ---- the world each backend gets ------------------------------------------------------------------

// Unique per run so two suites on one machine (an operator's and a CI runner's, or two worktrees)
// never share a tmux server, a registry or an agent's output file.
const RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-conformance-${RUN_ID}-`))
const TMUX_SOCKET = `fleet-test-${RUN_ID}`

// ⛔ And the LABELS carry RUN_ID too, because a label is resolved MACHINE-WIDE. `markerPids`,
// `assertNotRunning` and `killSpawn` all find a session by the exact `--fleet-session=<label>` argv
// token across every process on the box (registry-first.mjs) — that is the whole point of the marker.
// A fixed `c1` therefore is not this suite's identity, it is the machine's: two overlapping runs (two
// agent sessions, or one started beside an interrupted one) kill each other's agents mid-poll and
// throw `spawn: session "c7" is already running`. Observed as three intermittent `backend: none`
// failures that looked environmental and cleared on their own, which is exactly how this hides.
// RUN_ID rode on the temp dirs and the output paths — everything EXCEPT the identity that resolves.
const C = n => `c${n}.${RUN_ID}`

// ⛔ The `none` agent is a DETACHED process (it must outlive the launcher), so on Windows it is not
// reaped when this test process exits — a suite that only killed through the backend would leave a
// sleeping `node -e` per spawn behind, and a later run's same-id spawn would collide with it. This
// net matches ONLY this run's processes (RUN_ID rides on every agent's argv, via its out path and the
// grandchild token) and excludes self + ancestors, so it can never touch another suite or the runner.
// Matching a command line is what the interface exists to avoid; it is allowed here for the same
// reason sys/proc.mjs allows it in the reconciler — as a last-resort sweep of the suite's OWN,
// uniquely-tokened, throwaway processes.
const RUN_TOKEN = new RegExp(RUN_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
after(() => {
  for (const p of findByCommand(snapshot(), RUN_TOKEN, { selfPid: process.pid })) {
    try {
      process.kill(p.pid)
    } catch {
      // already gone
    }
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function configFor(name, stateDir) {
  const c = defaultsFor()
  setPath(c, 'repo.name', 'app')
  setPath(c, 'commands.bootstrap', 'true')
  setPath(c, 'paths.stateDir', stateDir)
  setPath(c, 'paths.artifactsDir', path.join(stateDir, 'dev-pages'))
  if (name !== 'fake') setPath(c, 'terminal.backend', name)
  setPath(c, 'terminal.tmux.socket', TMUX_SOCKET)
  setPath(c, 'terminal.tmux.session', TMUX_SOCKET)
  return c
}

async function loadBackend(name, config) {
  if (name === 'fake') {
    // A deterministic clock: the fake's process table carries startedAt, which descendants() reads as
    // its pid-reuse guard, so wall-clock time would make the tree walk depend on machine speed.
    let t = 0
    return createFakeBackend({ clock: () => ++t })
  }
  const { file, factory } = REAL[name]
  const mod = await import(backendUrl(name).href)
  const create = mod[factory]
  if (typeof create !== 'function') throw new Error(`src/backends/${file} does not export ${factory}() — src/backends/index.mjs loads it by that name`)
  // ⛔ snapshotMaxAgeMs: 0 — a registry-first backend caches the process snapshot (SNAPSHOT_MAX_AGE_MS)
  // and would answer isAlive/list from a reading taken BEFORE the agent this test just spawned existed.
  // The launcher tolerates that lag by polling; the suite removes it, so a wrong answer is the
  // backend's and not the cache's. tmux ignores the option (it is authoritative from tmux itself).
  return create({ config, platform: process.platform, snapshotMaxAgeMs: 0 })
}

// The agents. Each is one line with NO spaces and no double quotes, so it survives every terminal's
// quoting and stays a single argv token beside the marker.
//
// argv[1] is the marker and the positionals follow it: the marker comes FIRST on every real command
// line (session/shim.mjs parseArgv), and it sits after `--` because node otherwise reads
// `--fleet-session=<id>` as one of its own options and refuses to start.
//
// PIPE_AGENT copies its stdin to argv[2], byte for byte, and writes the environment it was given to
// argv[2] + '.env' as a ready beacon. TREE_AGENT starts a sleeping grandchild that carries argv[3] on
// its own command line, and writes the grandchild's pid to argv[2].
const PIPE_AGENT = "const f=require('fs'),o=process.argv[2];process.stdin.pipe(f.createWriteStream(o));f.writeFileSync(o+'.env',JSON.stringify(process.env));setInterval(()=>{},1000)"
const TREE_AGENT = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[3]],{stdio:'ignore'});require('fs').writeFileSync(process.argv[2],String(c.pid));setInterval(()=>{},1000)"

// A nudge that fits any input buffer, carrying every quoting hazard a ticket title or a path can: both
// quote kinds, both shells' variable syntaxes, separators, redirection, and two non-ASCII characters —
// because the mangling happens in the backend's rendering, not in the length.
const SHORT_NUDGE = 'status please: "quoted" \'single\' $HOME %PATH% ; & | <angle> é — end'
// Longer than a console line buffer. The incident shape: a message this long arrived as a short
// fragment followed by Enter and the session acted on the fragment.
const LONG_NUDGE = Array.from({ length: 24 }, (_, i) => `part-${String(i).padStart(2, '0')} "q" 'q' $v %v% ;|& é`).join(' ')

/** Poll until `check` is truthy or `ms` elapse — never throws, so the ASSERTION reports the failure. */
async function settle(check, ms, everyMs = 100) {
  const end = Date.now() + ms
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() >= end) return v
    await new Promise(r => setTimeout(r, everyMs))
  }
}

/** The one trailing line terminator a backend appends to SUBMIT the message. Exactly one, exactly at the end. */
const stripSubmit = s => String(s).replace(/\r\n$|\n$|\r$/, '')

const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const markedPids = (snap, id) => [...snap.values()].filter(p => hasSessionMarker(p.cmd, id)).map(p => p.pid)
const someCarriesToken = (snap, token) => [...snap.values()].some(p => !!p && p.cmd.includes(token))
const hasToken = (p, token) => !!p && p.cmd.includes(token)

// A spawn's identity, whatever the backend's ref shape: the fake mints `.ref`, the registry-first
// backends mint `.spawn`. Both are fresh per spawn, so this is what a relaunch must change and what a
// list() entry must still carry to be recognised as the same session.
const spawnKey = h => {
  const r = h && h.backendRef
  if (!r || typeof r !== 'object') return null
  return r.ref ?? r.spawn ?? null
}
const sameSpawn = (a, b) => {
  const k = spawnKey(a)
  return k != null && k === spawnKey(b)
}

/** `alreadyGone` is a boolean in every backend here; accept the typedef's string[] too, refuse anything else. */
const isGone = v => v === true || (Array.isArray(v) && v.length > 0)
const isNotGone = v => v === false || (Array.isArray(v) && v.length === 0)

function assertShape(op, value) {
  const v = validateResultShape(op, value)
  assert.ok(v.ok, `${op}(): ${v.note} — every backend answers with the shapes in src/backends/types.mjs, or a caller that swaps backends is quietly wrong on one platform`)
  return value
}

/**
 * Everything the suite needs to run one backend: the backend, its private world on disk, and the two
 * adapters that differ between the in-memory fake and a backend that runs real processes — where the
 * process table comes from, and how the agent's side of a spawn is observed.
 */
function subjectFor(candidate, backend, config) {
  const name = candidate.name
  const isFake = name === 'fake'
  const stateDir = path.join(TMP_ROOT, name, 'state')
  const agentDir = path.join(TMP_ROOT, name, 'agents')
  fs.mkdirSync(stateLayout(stateDir, process.platform).sessions, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  const validation = validateBackend(backend)
  const probe = typeof backend.probe === 'function' ? backend.probe() : null
  return {
    ...candidate,
    backend,
    config,
    stateDir,
    agentDir,
    isFake,
    validation,
    probe,
    usable: validation.ok && !!probe && probe.available === true,
    caps: validation.missing.includes('capabilities') ? null : backend.capabilities(),
    grandchildren: [], // {pid, token} — real pids the after() hook may still have to take
    // The process table. The fake's is its scripted one; a real backend is judged by the OS.
    processes: isFake ? () => backend.processes() : () => snapshot(),
    // The environment the agent actually saw. The fake runs nothing, so it is what it recorded.
    envSeen: (handle, files) => (isFake ? envMapOf(backend.record(handle).env) : (readText(files.env) ? JSON.parse(readText(files.env)) : null)),
    // The bytes that landed on the agent's stdin, before the backend's submit terminator.
    received: (handle, files) => (isFake ? backend.buffer(handle).join('') : readText(files.out)),
  }
}

/** A session's on-disk artefacts: where its agent writes, keyed by label and spawn epoch. */
function filesFor(s, id, epoch = 1) {
  const base = path.join(s.agentDir, `${id}.${epoch}`)
  return { out: `${base}.out`, env: `${base}.out.env`, pid: `${base}.pid` }
}

/** A spawn spec exactly as the launcher builds one — real env from buildSessionEnv, real paths. */
function specFor(s, id, { role = 'working', script, positionals = [] }) {
  const worktree = path.join(s.agentDir, `app-session-${id}`)
  fs.mkdirSync(worktree, { recursive: true })
  const layout = stateLayout(s.stateDir, process.platform)
  const file = path.join(layout.sessions, `${id}.json`)
  return {
    id,
    role,
    title: `session ${id}`,
    cwd: worktree,
    command: process.execPath,
    args: ['-e', script, '--', `--fleet-session=${id}`, ...positionals],
    env: buildSessionEnv(s.config, { label: id, role, file, stateFile: path.join(layout.sessions, `${id}.state`), stateDir: s.stateDir }),
  }
}

/**
 * Write (or refresh) the registry descriptor the LAUNCHER owns, stamped with the handle this spawn
 * returned. A registry-first backend's list/isAlive/kill read it; a relaunch must overwrite it so the
 * dead spawn's handle reads as replaced (see registry-first.spawnState) rather than re-binding to the
 * successor. createdAt is backdated a minute: the birth grace in reconcilePlan protects a just-spawned
 * session from being called dead before its process is in the snapshot, and here the snapshot is
 * always fresh (snapshotMaxAgeMs: 0) — so a killed session must age past the grace to leave list(),
 * which a real session created a minute ago has.
 */
function writeDescriptor(s, handle, spec) {
  const layout = stateLayout(s.stateDir, process.platform)
  const d = {
    id: handle.id,
    label: handle.id,
    role: spec.role,
    worktree: spec.cwd,
    backendRef: handle.backendRef,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    stateFile: path.join(layout.sessions, `${handle.id}.state`),
    paths: { stateDir: s.stateDir, flagsDir: layout.flags, outboxDir: layout.outbox, artifactsDir: path.join(s.stateDir, 'dev-pages') },
  }
  if (Number.isInteger(handle.shimPid)) d.shimPid = handle.shimPid
  if (Number.isInteger(handle.pgid)) d.pgid = handle.pgid
  writeSession(d, { stateDir: s.stateDir })
  return d
}

/** Spawn, register the descriptor the way the launcher would, and make sure the session is killed however the test ends. */
function launch(t, s, id, opts) {
  const spec = specFor(s, id, opts)
  const handle = assertShape('spawn', s.backend.spawn(spec))
  writeDescriptor(s, handle, spec)
  t.after(() => {
    try {
      s.backend.kill(handle)
    } catch {
      // a conforming backend answers alreadyGone for a session the test already killed; a broken one
      // is reported by the test, not by its cleanup
    }
  })
  return { handle, spec }
}

/** Wait for the agent's ready beacon. The fake runs nothing, so there is nothing to wait for. */
async function ready(s, beacon) {
  if (s.isFake) return
  const up = await settle(() => fs.existsSync(beacon), 30_000)
  assert.ok(up, `the agent never started: ${beacon} did not appear within 30s`)
}

/**
 * The single process that carries `--fleet-session=<id>`, once the snapshot shows exactly one.
 *
 * ⛔ Exactly one. core/fleet.mjs reconcilePlan reads two marked processes as a duplicate launch and
 * binds shimPid to the LOWER pid — so a wrapper shell or a terminal host that keeps the session's argv
 * on its own command line makes `fleet kill` walk the tree from the wrong root, which on a terminal
 * host is the operator's whole terminal.
 */
async function awaitAgentPid(s, id, handle) {
  let snap = s.processes()
  if (markedPids(snap, id).length !== 1) await settle(() => markedPids((snap = s.processes()), id).length === 1, 15_000, 250)
  const pids = markedPids(snap, id)
  // ⛔ Name them. "found [35595,35596]" is not a diagnosis: whether the extra process is a wrapper
  // shell that never exec'd away, a terminal client still holding the pane command on its own argv, or
  // a genuine second agent decides both what is broken and whether `fleet kill` would walk from the
  // wrong root. Two consecutive pids and two command lines answer that on the first failure instead of
  // the third.
  const describe = ps => ps.map(pid => `${pid}: ${JSON.stringify(String((snap.get(pid) || {}).cmd || '').slice(0, 200))}`).join('\n  ')
  assert.equal(pids.length, 1, `exactly one process must carry --fleet-session=${id}; found ${pids.length}:\n  ${describe(pids)}`)
  if (Number.isInteger(handle.shimPid)) {
    assert.equal(handle.shimPid, pids[0], "a handle's shimPid, when it carries one, is the marked process and not a wrapper around it")
  }
  return { pid: pids[0], snap }
}

/** The grandchild's pid: scripted under the fake, reported through a file by the real TREE_AGENT. */
async function plantGrandchild(s, handle, files, token) {
  if (s.isFake) {
    const agent = s.backend.addChild(handle, { name: 'claude', cmd: 'claude --model opus' })
    return s.backend.addChild(agent, { name: 'node', cmd: `node -e setInterval(()=>{},1000) ${token}` })
  }
  const up = await settle(() => fs.existsSync(files.pid) && readText(files.pid).trim() !== '', 30_000)
  assert.ok(up, `the agent never reported its grandchild: ${files.pid} did not appear within 30s`)
  return Number(readText(files.pid).trim())
}

/** Send `text` through a fresh session and return the result beside what actually arrived. */
async function deliver(t, s, id, text) {
  const files = filesFor(s, id)
  const { handle } = launch(t, s, id, { script: PIPE_AGENT, positionals: [files.out] })
  await ready(s, files.env)
  const r = assertShape('send', s.backend.send(handle, text))
  const arrived = () => stripSubmit(s.received(handle, files))
  await settle(() => arrived().length >= Math.min(r.delivered, text.length), 10_000)
  return { r, received: arrived(), handle }
}

/**
 * What every send() must satisfy. `ok` may never be claimed for a short write, and the count it
 * reports must be the count that ARRIVED — the incident was a caller believing a truncated instruction
 * had been delivered whole because the write returned without error.
 */
function assertHonestSend(r, text, received, caps, what) {
  assert.equal(r.requested, text.length, `${what}: requested is the length of the text`)
  assert.ok(Number.isInteger(r.delivered) && r.delivered >= 0 && r.delivered <= r.requested, `${what}: delivered is a count within 0..requested, got ${r.delivered}`)
  assert.equal(r.truncated, r.delivered < r.requested, `${what}: truncated means exactly "delivered < requested"`)
  if (r.ok) assert.equal(r.delivered, r.requested, `${what}: ok was claimed on a short write (${r.delivered} of ${r.requested})`)
  else assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${what}: a failed send says why`)
  assert.equal(received, text.slice(0, r.delivered), `${what}: what arrived must be exactly the ${r.delivered} characters the backend says it delivered`)
  if (caps.reliableSend) assert.equal(r.ok, true, `${what}: a backend that declares reliableSend may never short-write (${r.reason})`)
}

// ---- discovery ----------------------------------------------------------------------------------

const PLAN = planCandidates({
  env: process.env,
  onPath: which,
  present: name => fs.existsSync(backendUrl(name)),
})

const SUBJECTS = []
for (const candidate of PLAN) {
  if (!candidate.run) {
    test(`backend: ${candidate.name}`, { skip: candidate.reason }, () => {})
    continue
  }
  const config = configFor(candidate.name, path.join(TMP_ROOT, candidate.name, 'state'))
  let backend
  try {
    backend = await loadBackend(candidate.name, config)
  } catch (e) {
    // Present but unloadable is a FAILURE, never a skip: the file exists, so somebody believes it
    // works, and a suite that skipped it would agree with them.
    test(`backend: ${candidate.name} loads`, () => {
      throw e
    })
    continue
  }
  const s = subjectFor(candidate, backend, config)
  if (!s.usable && !s.required && s.validation.ok && s.probe && !s.probe.available) {
    // Not demanded and honestly unavailable here: the probe's reason is the skip's reason.
    test(`backend: ${s.name}`, { skip: `probe: ${s.probe.reason || 'unavailable'}` }, () => {})
    continue
  }
  SUBJECTS.push(s)
}

// ---- the suite, once per backend --------------------------------------------------------------------

for (const s of SUBJECTS) {
  describe(`backend: ${s.name}`, () => {
    const b = s.backend
    // One failure for a backend that cannot run, then a skip on the rest: every later test would only
    // restate the first one.
    const rest = { skip: s.usable ? false : 'the backend failed validation or its probe (see the first test)', timeout: 120_000 }

    after(async () => {
      let live = []
      try {
        live = b.list()
      } catch {
        // an interface so broken that list() throws has already failed; there is nothing to sweep
      }
      for (const h of live) {
        try {
          b.kill(h)
        } catch {
          // reported by the test that spawned it
        }
      }
      if (!s.isFake && s.grandchildren.length) {
        // A grandchild the backend failed to take is killed HERE only when a fresh snapshot shows the
        // pid still carrying our unique token: a pid alone is not identification, it is recycled.
        const snap = s.processes()
        for (const { pid, token } of s.grandchildren) {
          if (!hasToken(snap.get(pid), token)) continue
          try {
            process.kill(pid)
          } catch {
            // already gone between the snapshot and now
          }
        }
      }
      if (s.name === 'tmux') {
        // Our own server on our own socket, never the operator's.
        run('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { timeoutMs: 10_000 })
      }
      // Retried: on Windows a file the agent held stays locked for a moment after its process dies.
      fs.rmSync(path.join(TMP_ROOT, s.name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    test('implements the whole interface, declares every capability as a boolean, and probes available', { timeout: 120_000 }, () => {
      // A half-written backend fails HERE, at load, rather than at 3am in the middle of a fan-out.
      assert.deepEqual(s.validation, { ok: true, missing: [], badCapabilities: [] })
      assert.deepEqual(Object.keys(s.caps).sort(), [...CAPABILITY_NAMES].sort(), 'every capability is declared — a new flag defaults to "no", never to "absent"')
      assertShape('probe', s.probe)
      assert.equal(typeof s.probe.available, 'boolean')
      assert.equal(s.probe.name, s.name, 'probe().name is the name index.mjs selects the backend by')
      if (!s.probe.available) assert.ok(typeof s.probe.reason === 'string' && s.probe.reason, 'an unavailable backend says what to install')
      assert.equal(
        s.probe.available, true,
        s.required
          ? `FLEET_TEST_BACKEND=${s.name} demanded this backend and its probe says: ${s.probe.reason} — a demanded backend fails rather than skips, or the job that asked for it goes green on nothing`
          : `probe: ${s.probe.reason}`,
      )
    })

    test('spawn mints a handle addressed by backendRef; list() carries it and isAlive() confirms it', rest, async t => {
      const files = filesFor(s, C(1))
      const { handle, spec } = launch(t, s, C(1), { script: PIPE_AGENT, positionals: [files.out] })
      await ready(s, files.env)
      assert.equal(handle.id, spec.id)
      assert.equal(handle.role, spec.role)
      assert.ok(handle.backendRef && typeof handle.backendRef === 'object', 'backendRef is the backend-private address the registry records')
      assert.ok(spawnKey(handle) != null, 'a handle names its spawn (the fake mints .ref, a registry-first backend .spawn)')

      // Liveness may lag the spawn on a backend that reads a process snapshot, so it is polled the way
      // the launcher polls — but it MUST resolve, and to exactly one listed handle for this spawn.
      const up = await settle(() => b.isAlive(handle) === true && b.list().some(h => sameSpawn(h, handle)), 15_000, 250)
      assert.ok(up, 'the spawned session never became alive-and-listed')
      assert.equal(assertShape('isAlive', b.isAlive(handle)), true)

      const listed = assertShape('list', b.list())
      const mine = listed.filter(h => sameSpawn(h, handle))
      assert.equal(mine.length, 1, "list() carries exactly one handle for this spawn's backendRef")
      assert.equal(mine[0].id, C(1))
      assert.equal(b.isAlive(mine[0]), true, 'the handle list() hands back resolves — list, send and kill must address one set')

      // Addressing is by the recorded handle, never by label: a handle built from a label must be
      // refused, or a backend with no query API gets compensated for by searching, and list, send and
      // kill each resolve a different set.
      for (const bad of [{ id: C(1), role: 'working' }, C(1), null]) {
        assert.throws(() => b.isAlive(bad), `isAlive(${JSON.stringify(bad)}) must throw rather than guess`)
        assert.throws(() => b.send(bad, 'hello'))
        assert.throws(() => b.kill(bad))
      }
      assert.equal(b.list().length, listed.length, 'and no refused address ended a session')
    })

    test('the argv and the FLEET_* environment reach the agent unmangled, and exactly one process carries the marker', rest, async t => {
      const files = filesFor(s, C(2))
      const { handle, spec } = launch(t, s, C(2), { script: PIPE_AGENT, positionals: [files.out] })
      await ready(s, files.env)
      await awaitAgentPid(s, C(2), handle)

      // Contract §4: the mirrored scalars are how a session finds its descriptor, its flags dir and its
      // role. A backend that launches through a shell profile or a launcher that rebuilds the
      // environment drops them, and the session then reads another session's slot as its own.
      const seen = s.envSeen(handle, files)
      assert.ok(seen, 'the agent reported the environment it was started with')
      for (const { name, value } of spec.env) {
        assert.equal(seen[name], value, `${name} must reach the agent exactly as buildSessionEnv produced it`)
      }
      assert.equal(seen.FLEET_SESSION, '1')
      assert.equal(seen.FLEET_LABEL, C(2))
      assert.equal(seen.FLEET_ROLE, 'working')
    })

    test('send delivers the exact bytes, and a short write is never reported as ok', rest, async t => {
      // A nudge that fits any input buffer either arrives whole or — on a backend that cannot inject at
      // all and declares no reliableSend — not at all. A fragment of it is a bug, not a limit.
      const short = await deliver(t, s, C(3), SHORT_NUDGE)
      assertHonestSend(short.r, SHORT_NUDGE, short.received, s.caps, 'short nudge')
      assert.ok(short.r.delivered === SHORT_NUDGE.length || short.r.delivered === 0, `a ${SHORT_NUDGE.length}-character nudge fits any buffer: delivered ${short.r.delivered} is a fragment`)

      // The long one may legitimately short-write on a backend that says reliableSend: false — but then
      // it says so in the result, and the count it reports is the count that arrived.
      const long = await deliver(t, s, C(4), LONG_NUDGE)
      assertHonestSend(long.r, LONG_NUDGE, long.received, s.caps, 'long message')
      if (long.r.truncated) assert.equal(s.caps.reliableSend, false, 'a truncating backend may not declare reliableSend')
    })

    test('setStatus refuses an unknown status, answers a boolean, and reads back where observableStatus is claimed', rest, async t => {
      const files = filesFor(s, C(5))
      const { handle } = launch(t, s, C(5), { script: PIPE_AGENT, positionals: [files.out] })
      await ready(s, files.env)
      // A typo'd status that silently no-ops loses the fleet's red/green — the thing an operator
      // triages a screen of windows by.
      for (const bad of ['busy', '', null, undefined]) assert.throws(() => b.setStatus(handle, bad), `setStatus(${JSON.stringify(bad)}) must throw`)
      assert.deepEqual([...STATUS], ['working', 'ready', 'blocked'])

      const first = assertShape('setStatus', b.setStatus(handle, 'working'))
      const again = assertShape('setStatus', b.setStatus(handle, 'working'))
      const last = assertShape('setStatus', b.setStatus(handle, 'blocked'))
      if (s.caps.observableStatus) {
        assert.deepEqual([first, again, last], [true, true, true], 'a claimed observable status is applied to a live session')
        // "Can be read back" is the capability's definition, and the interface has no read-back method,
        // so a backend claiming it must expose a `statusOf(handle)` inspector — an unverifiable claim
        // is exactly what the caller's degradation branches would trust blindly.
        assert.equal(typeof b.statusOf, 'function', `${s.name} declares observableStatus but exposes no statusOf(handle) to verify it`)
        assert.equal(await b.statusOf(handle), 'blocked', 'the LAST status set is the one read back')
      } else {
        for (const r of [first, again, last]) assert.equal(typeof r, 'boolean', 'setStatus answers a boolean even when the status cannot be read back')
      }
    })

    test('kill takes the whole tree: the session leaves list() with no survivors, and a grandchild is gone from a fresh snapshot', rest, async t => {
      const id = C(6)
      const files = filesFor(s, id)
      const token = `fleet-conformance-grandchild-${RUN_ID}-${id}`
      const { handle } = launch(t, s, id, { script: TREE_AGENT, positionals: [files.pid, token] })
      const gc = await plantGrandchild(s, handle, files, token)
      s.grandchildren.push({ pid: gc, token })

      // The grandchild is proven present and proven to be OURS before the kill: an absence afterwards
      // proves nothing about a process that was never there, and a pid is recycled.
      const { pid: agent, snap: before } = await awaitAgentPid(s, id, handle)
      assert.ok(hasToken(before.get(gc), token), `grandchild ${gc} is in the snapshot and carries ${token}`)
      assert.ok(descendants(before, agent).includes(gc), 'it is a descendant of the session, so a kill that walks the tree from the session root must reach it')

      const r = assertShape('kill', b.kill(handle))
      assert.equal(r.ok, true, `kill reported failure: ${JSON.stringify(r)}`)
      assert.ok(isNotGone(r.alreadyGone), 'a live session was not "already gone"')
      assert.ok(Array.isArray(r.killed) && r.killed.length > 0, 'a kill that ended a session accounts for what it took')
      assert.deepEqual(r.survivors ?? [], [], 'relaunch is kill, VERIFY GONE, spawn: survivors must be reported, and here there must be none')
      assert.equal(b.isAlive(handle), false)
      assert.equal(b.list().some(h => sameSpawn(h, handle)), false, 'the killed session is out of list()')

      // A fresh snapshot, retried because the OS reaps a little after the kill returns — the backend's
      // own re-query is the report this suite refuses to take on trust.
      const gone = snap => markedPids(snap, id).length === 0 && !someCarriesToken(snap, token)
      let after = s.processes()
      if (!gone(after)) await settle(() => gone((after = s.processes())), 15_000, 250)
      assert.deepEqual(markedPids(after, id), [], 'the session process is gone')
      assert.equal(someCarriesToken(after, token), false, 'the grandchild is gone: a window closing says nothing about the dev server the agent started, and one left behind holds its port forever')
    })

    test('a killed session answers every method instead of throwing, and a relaunch under the same id gets a fresh ref', rest, async t => {
      const id = C(7)
      const first = filesFor(s, id, 1)
      const stale = launch(t, s, id, { script: PIPE_AGENT, positionals: [first.out] }).handle
      await ready(s, first.env)
      const firstKill = assertShape('kill', b.kill(stale))
      assert.equal(firstKill.ok, true, `killing the session must succeed: ${JSON.stringify(firstKill)}`)
      // ⛔ VERIFY GONE before relaunching, exactly as `fleet relaunch` does: kill reports its own
      // re-query, but a just-terminated process can still show in the NEXT independent snapshot for a
      // moment, and spawning into the same worktree while the old marker lingers is refused as a
      // duplicate. The wait is the relaunch procedure, not a workaround for it.
      const cleared = await settle(() => b.isAlive(stale) === false && markedPids(s.processes(), id).length === 0, 15_000, 200)
      assert.ok(cleared, 'the killed session never left the process table, so a relaunch could not verify it gone')

      const second = filesFor(s, id, 2)
      const fresh = launch(t, s, id, { script: PIPE_AGENT, positionals: [second.out] }).handle
      await ready(s, second.env)
      await settle(() => b.isAlive(fresh) === true, 15_000, 250)
      // A relaunch reuses the label AND the worktree. A ref derived from the label would let a nudge
      // aimed at the dead session land in the fresh one.
      assert.notDeepEqual(fresh.backendRef, stale.backendRef, 'backendRef identifies the SPAWN, not the label')
      assert.notEqual(spawnKey(fresh), spawnKey(stale))
      assert.equal(b.isAlive(fresh), true, 'the relaunched session is alive')
      assert.equal(b.isAlive(stale), false, 'the killed session is not')
      assert.deepEqual(b.list().filter(h => h.id === id).map(h => sameSpawn(h, fresh)), [true], 'list() carries the fresh session only')

      // Reported per target, never thrown: one dead label must not abort a fan-out over the others.
      const sent = assertShape('send', b.send(stale, 'are you there'))
      assert.equal(sent.ok, false)
      assert.equal(sent.delivered, 0)
      assert.ok(typeof sent.reason === 'string' && sent.reason, 'a send to a gone session says so')
      assert.equal(assertShape('setStatus', b.setStatus(stale, 'ready')), false)
      assert.equal(assertShape('focus', b.focus(stale)), false)
      const again = assertShape('kill', b.kill(stale))
      assert.equal(again.ok, true, 'teardown after a crash kills sessions that are already gone, and must not fail')
      assert.ok(isGone(again.alreadyGone))
      assert.deepEqual(again.killed, [])
      const placed = assertShape('layout', b.layout([stale, fresh], 'windows'))
      assert.ok(placed.placed <= 1, 'a handle whose session has ended is not placed — a stale list must be distinguishable from a recomputed one')

      // …and the fresh session is untouched by all of that
      assert.equal(b.isAlive(fresh), true)
      const focused = assertShape('focus', b.focus(fresh))
      if (s.caps.focusById) assert.equal(focused, true, 'a claimed focusById is exact, not best-effort')
    })

    test('spawn refuses a half-built spec and a label that is already live, leaving nothing behind', rest, async t => {
      const files = filesFor(s, C(8))
      const { handle, spec } = launch(t, s, C(8), { script: PIPE_AGENT, positionals: [files.out] })
      await ready(s, files.env)
      await awaitAgentPid(s, C(8), handle)

      // A half-built spec is what produces a session with no FLEET_* env; it must be refused BEFORE
      // anything is recorded or started, or the next status read invents a session nobody can address.
      assert.throws(() => b.spawn({ ...spec, id: C(9), role: 'reviewer' }))
      assert.throws(() => b.spawn({ ...spec, id: C(9), args: 'not-an-array' }))
      assert.throws(() => b.spawn({ ...spec, id: C(9), env: [{ name: 'FLEET_LABEL' }] }))
      assert.throws(() => b.spawn({ ...spec, id: C(9), cwd: '' }))
      // Two agents in one worktree collide on the git index; a relaunch kills first, never spawns beside.
      assert.throws(() => b.spawn({ ...spec }), /already running|already live/i)

      // The refusal left no c9 in the registry — a half-created session is one the next status read
      // invents and nothing can address or kill. Asserted against c9 specifically, never the total
      // list length: on a registry-first backend that count still drops as the sessions earlier tests
      // killed drain out of the process snapshot, and that race is not this refused spawn's doing.
      assert.equal(b.list().some(h => h.id === C(9)), false, 'a refused spawn leaves no session behind')
      assert.equal(b.isAlive(handle), true, 'and the live one it collided with is untouched')
      assert.deepEqual(markedPids(s.processes(), C(9)), [], 'no process was started for a refused spec')
      assert.equal(markedPids(s.processes(), C(8)).length, 1, 'and the refused duplicate did not start a second c8')
    })

    test('layout announces what it cannot place instead of throwing, and places what it can', rest, async t => {
      const one = filesFor(s, 'c10')
      const two = filesFor(s, 'c11')
      const handles = [
        launch(t, s, 'c10', { script: PIPE_AGENT, positionals: [one.out] }).handle,
        launch(t, s, 'c11', { script: PIPE_AGENT, positionals: [two.out] }).handle,
      ]
      await ready(s, one.env)
      await ready(s, two.env)

      // A silent no-op is the failure: a fleet that "tiled" nothing looks the same as one that tiled,
      // and the operator finds twelve windows stacked on one spot.
      const needs = { windows: null, 'tiled-panes': 'gridLayout', 'pixel-grid': 'pixelLayout' }
      for (const [mode, capability] of Object.entries(needs)) {
        const r = assertShape('layout', b.layout(handles, mode))
        assert.equal(r.mode, mode)
        if (capability && !s.caps[capability]) {
          assert.equal(r.placed, 0, `${mode}: nothing is placed without ${capability}`)
          assert.ok(typeof r.notice === 'string' && r.notice, `${mode}: the degradation is announced`)
        } else if (capability) {
          assert.equal(r.placed, handles.length, `${mode}: a claimed ${capability} places every live handle`)
          assert.equal(r.notice ?? null, null, `${mode}: nothing to announce when everything was placed`)
        } else {
          assert.ok(r.placed === handles.length || (r.placed === 0 && r.notice), `${mode}: either every handle is placed or a notice says why none was`)
        }
      }
      const unknown = assertShape('layout', b.layout(handles, 'diagonal'))
      assert.equal(unknown.placed, 0)
      assert.ok(typeof unknown.notice === 'string' && unknown.notice, 'an unknown mode is a notice, never a throw')
      assert.ok(b.list().length >= 2, 'layout does not end sessions')
    })
  })
}
