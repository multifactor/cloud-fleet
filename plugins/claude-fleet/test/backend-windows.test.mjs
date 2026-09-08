import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createWindowsTerminalBackend, WT_CAPABILITIES, WT_INJECT, wtArgv, titleOf, injectorArgv, parseInjectorResult, focusScript, parseFocusResult, encodeUtf16 } from '../src/backends/windows-terminal.mjs'
import { createPowerShellBackend, POWERSHELL_CAPABILITIES, PS_LAUNCHER, launchScript, quoteArg, psLiteral, parseHostPid } from '../src/backends/powershell.mjs'
import { createNoneBackend, NONE_CAPABILITIES, logPathFor } from '../src/backends/none.mjs'
import {
  chunkText, planSend, deliverChunks, normalizeWrite, messageNumber, spawnState, markerPids, assertSnapshot, createSnapshotSource,
  CHUNK_CHARS, POINTER_THRESHOLD, MESSAGES_DIR,
} from '../src/backends/registry-first.mjs'
import { validateBackend, validateResultShape, CAPABILITY_NAMES } from '../src/backends/types.mjs'
import { snapshotFrom, killPlan } from '../src/sys/proc.mjs'
import { which } from '../src/sys/exec.mjs'
import { writeSession, readSession, sessionsDir } from '../src/core/fleet.mjs'
import { parseSessionState } from '../src/session/shim.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { defaultsFor } from '../src/config/defaults.mjs'

const T0 = Date.parse('2026-03-14T10:00:00Z')

/**
 * A temp root that goes away with the test, however the test ends. `before` runs first, in the SAME
 * hook: node:test runs after-hooks in registration order, so a kill registered after this one would
 * run after the rm — and on Windows removing a log a live child still holds open fails, its EBUSY
 * masking the assertion that actually failed.
 */
function tmpRoot(t, prefix = 'fleet-backend-', { before = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    if (before) await before()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return root
}

const configFor = stateDir => {
  const c = defaultsFor()
  c.paths.stateDir = stateDir
  return c
}

/** A spawn spec exactly as the launcher builds one: the marker FIRST, then the descriptor path. */
const spec = (label, over = {}) => {
  const { role = 'working', session = {}, ...rest } = over
  return {
    id: String(label),
    role,
    title: `session ${label}`,
    cwd: `/w/app session-${label}`,
    command: 'node',
    args: ['/plugin/src/session/shim.mjs', `--fleet-session=${label}`, `/state/my fleet/sessions/${label}.json`],
    env: buildSessionEnv(defaultsFor(), { label: String(label), role, file: `/state/my fleet/sessions/${label}.json`, stateFile: `/state/my fleet/sessions/${label}.state`, stateDir: '/state/my fleet', ...session }),
    ...rest,
  }
}

/** A shim as a snapshot sees it: the label lives in an exact argv token. */
const shim = (pid, label, extra = {}) => ({ pid, ppid: 1, name: 'node', cmd: `node shim.mjs --fleet-session=${label} /s/sessions/${label}.json`, startedAt: 100, ...extra })
const table = (...procs) => snapshotFrom([{ pid: 1, ppid: 0, name: 'WindowsTerminal.exe', cmd: 'WindowsTerminal.exe', startedAt: 1 }, ...procs])

/**
 * Everything a backend test needs, with every side effect scripted and logged: a real registry in a
 * temp state dir (the launcher's half), a process table the test edits, an exec that records what
 * would have run, an injector that returns whatever the script says, and a clock that stands still.
 * The descriptor is dated an hour before T0 so the reconciler's birth-grace window never applies —
 * a test about "gone" must not pass because the session was merely too young to judge.
 */
function world(t, { platform = 'win32' } = {}) {
  const root = tmpRoot(t)
  const stateDir = path.join(root, 'state')
  const w = {
    stateDir,
    config: configFor(stateDir),
    procs: table(),
    snapshots: [],
    runs: [],
    execResult: { ok: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false },
    injections: [],
    injectScript: () => null, // null → accept everything
    focused: [],
    focusResult: true,
    kills: [],
    now: T0,
  }
  // A NEW Map per reading, as the real provider hands back once its cache has expired: the snapshot
  // source dates a reading by Map identity, and a fixture that returned the same Map forever would
  // pin every reading to T0 and hold a newborn in the grace window no matter how the clock moved.
  w.takeSnapshot = ({ maxAgeMs }) => {
    w.snapshots.push(maxAgeMs)
    return new Map(w.procs)
  }
  w.run = (command, args, opts) => {
    w.runs.push({ command, args: args.slice(), opts })
    return typeof w.execResult === 'function' ? w.execResult(command, args) : w.execResult
  }
  w.inject = (pid, text, opts) => {
    const n = w.injections.length
    w.injections.push({ pid, text, enter: !!opts.enter })
    const scripted = w.injectScript(n, text, opts)
    return scripted === null || scripted === undefined ? (opts.enter ? 1 : text.length) : scripted
  }
  w.focusWindow = token => {
    w.focused.push(token)
    return w.focusResult
  }
  // killTree as sys/kill.mjs would plan it, minus the signals: the real killPlan decides the order and
  // the test decides which pids survive, so the backend's root choice and survivor handling are what
  // is exercised.
  w.survivorsOf = () => []
  w.killTree = (snap, root, opts) => {
    const planned = killPlan(snap, root, { selfPid: opts.selfPid }).order
    const survivors = w.survivorsOf(planned)
    w.kills.push({ snap, root, opts, planned })
    for (const pid of planned) if (!survivors.includes(pid)) w.procs.delete(pid)
    opts.resnapshot()
    return { planned, killed: planned.filter(p => !survivors.includes(p)), survivors, skippedProtected: [] }
  }
  w.descriptor = (label, over = {}) => {
    const d = {
      label: String(label),
      id: String(label),
      role: 'working',
      worktree: `/w/app session-${label}`,
      stateFile: path.join(sessionsDir(stateDir), `${label}.state`),
      createdAt: new Date(T0 - 3_600_000).toISOString(),
      ...over,
    }
    writeSession(d, { stateDir })
    return d
  }
  /** What the launcher does after spawn: record the ref the backend minted (contract §4 backendRef). */
  w.stamp = handle => {
    const d = readSession(handle.id, { stateDir })
    writeSession({ ...d, backendRef: handle.backendRef }, { stateDir })
  }
  w.wt = (over = {}) => createWindowsTerminalBackend({
    config: w.config, platform, run: w.run, which: () => 'wt.exe', takeSnapshot: w.takeSnapshot, killTree: w.killTree,
    selfPid: 999_999, now: () => w.now, inject: w.inject, focusWindow: w.focusWindow, ...over,
  })
  w.ps = (over = {}) => createPowerShellBackend({
    config: w.config, platform, run: w.run, which: () => 'powershell.exe', takeSnapshot: w.takeSnapshot, killTree: w.killTree,
    selfPid: 999_999, now: () => w.now, inject: w.inject, focusWindow: w.focusWindow, ...over,
  })
  w.none = (over = {}) => createNoneBackend({
    config: w.config, platform, takeSnapshot: w.takeSnapshot, killTree: w.killTree, selfPid: 999_999, now: () => w.now,
    spawnDetached: (command, args, opts) => {
      w.runs.push({ command, args: args.slice(), opts })
      return { pid: 4242, pgid: platform === 'win32' ? undefined : 4242, child: { on() {} } }
    },
    ...over,
  })
  return w
}

/** Spawn under wt with the registry playing the launcher: descriptor first, then stamp the ref, then a shim appears. */
function liveSession(w, backend, label, { shimPid = 100 + Number(label) || 100, over = {} } = {}) {
  w.descriptor(label, over)
  const h = backend.spawn(spec(label))
  w.stamp(h)
  w.procs.set(shimPid, shim(shimPid, label))
  w.descriptor(label, { ...readSession(String(label), { stateDir: w.stateDir }), shimPid })
  return h
}

// ---- the interface -----------------------------------------------------------------------------

test('all three backends implement the whole interface and declare their capabilities honestly', t => {
  // A backend that quietly claims a capability it lacks means the caller's degradation branch is
  // never taken by any test and ships unexecuted; on Windows Terminal that is every capability but one.
  const w = world(t)
  for (const [b, caps] of [[w.wt(), WT_CAPABILITIES], [w.ps(), POWERSHELL_CAPABILITIES], [w.none(), NONE_CAPABILITIES]]) {
    assert.deepEqual(validateBackend(b), { ok: true, missing: [], badCapabilities: [] }, b.name)
    assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_NAMES].sort(), b.name)
    const c = b.capabilities()
    assert.equal(c.authoritativeList, false, `${b.name}: a registry reconciled against a snapshot is not authoritative`)
    assert.equal(c.reliableSend, false, `${b.name}: a console buffer can come up short`)
    assert.equal(c.observableStatus, false, `${b.name}: a written status cannot be read back`)
    assert.equal(c.focusById, false, b.name)
    assert.equal(c.gridLayout, false, b.name)
    assert.equal(c.pixelLayout, false, `${b.name}: pixel placement is an extras hook, absent by default`)
    assert.equal(c.multiMonitor, false, b.name)
    assert.equal(c.detachSurvivesLauncher, true, b.name)
  }
  assert.equal(w.wt().capabilities().freeFloatingWindows, false, 'wt tabs share one window')
  assert.equal(w.ps().capabilities().freeFloatingWindows, true, 'each PowerShell session is its own window')
  assert.equal(w.none().capabilities().freeFloatingWindows, false)
})

test('probe names the fix: wt.exe on PATH on Windows, nothing anywhere else', t => {
  const w = world(t)
  assert.equal(w.wt({ platform: 'linux' }).probe().available, false)
  const missing = w.wt({ which: () => null }).probe()
  assert.equal(missing.available, false)
  assert.match(missing.reason, /wt\.exe is not on PATH/)
  assert.match(missing.reason, /terminal\.backend to powershell/, 'the fallback is named, not left to be discovered')
  assert.deepEqual(w.wt().probe(), { available: true, name: 'windows-terminal', reason: null })
  assert.equal(w.ps({ platform: 'darwin' }).probe().available, false)
  assert.deepEqual(w.ps().probe(), { available: true, name: 'powershell', reason: null })
  for (const platform of ['win32', 'linux', 'darwin']) assert.deepEqual(w.none({ platform }).probe(), { available: true, name: 'none', reason: null })
})

// ---- spawn -------------------------------------------------------------------------------------

test('the wt argv groups the tab into the named window and hands the shim its descriptor — env is not forwarded', t => {
  // wt cannot pass an environment to the tab it opens; the shim rebuilds FLEET_* from the descriptor.
  // `--` ends wt's own options so the shim's flags are never read as wt's.
  const s = spec(3)
  assert.deepEqual(wtArgv(s), [
    '-w', 'fleet', 'new-tab', '--title', 'session 3', '-d', '/w/app session-3', '--',
    'node', '/plugin/src/session/shim.mjs', '--fleet-session=3', '/state/my fleet/sessions/3.json',
  ])
  assert.equal(wtArgv(s, { window: 'fleet-2' })[1], 'fleet-2')
  assert.ok(!wtArgv(s).some(a => /FLEET_/.test(a)), 'no env token anywhere in the argv')
  assert.equal(titleOf({ id: '3' }), '3', 'the label is the title when the launcher gives none')

  const w = world(t)
  w.descriptor(3)
  const h = w.wt().spawn(s)
  assert.equal(w.runs.length, 1)
  assert.equal(w.runs[0].command, 'wt.exe')
  assert.deepEqual(w.runs[0].args, wtArgv(s))
  assert.equal(w.runs[0].opts.env, undefined, 'and none is passed to wt.exe either')
  assert.deepEqual([h.id, h.role, h.backendRef.backend, h.backendRef.label, h.backendRef.window, h.backendRef.title], ['3', 'working', 'windows-terminal', '3', 'fleet', 'session 3'])
  assert.equal(validateResultShape('spawn', h).ok, true)
})

test('a spawn wt.exe refuses leaves nothing behind, and a half-built spec never reaches wt.exe', t => {
  // Otherwise the next status read invents a session that nothing can address or kill.
  const w = world(t)
  w.descriptor(3)
  w.execResult = { ok: false, code: 1, signal: null, stdout: '', stderr: 'wt: unknown window', timedOut: false }
  assert.throws(() => w.wt().spawn(spec(3)), /wt: unknown window/)
  assert.throws(() => w.wt().spawn(spec(3, { role: 'reviewer' })), /unknown role "reviewer"/)
  assert.throws(() => w.wt().spawn(spec('../evil')), /invalid session label/)
  assert.equal(w.runs.length, 1, 'only the well-formed spec reached wt.exe')
  assert.deepEqual(w.wt().list(), [])
})

test('a label that is already running is refused — two agents in one worktree collide on the git index', t => {
  const w = world(t)
  const b = w.wt()
  liveSession(w, b, 3)
  assert.throws(() => b.spawn(spec(3)), /already running/)
  assert.equal(w.runs.length, 1, 'wt.exe was not asked a second time')
})

test('every backendRef identifies the SPAWN, not the label', t => {
  // A relaunch reuses the label and the worktree; two refs for one label must never be equal, and
  // the ref is minted by the backend rather than derived from the label anyone could type.
  const w = world(t)
  const b = w.wt()
  w.descriptor(3)
  const first = b.spawn(spec(3))
  const second = b.spawn(spec(3))
  assert.notEqual(first.backendRef.spawn, second.backendRef.spawn)
  assert.match(first.backendRef.spawn, /^windows-terminal:[0-9a-f-]{36}$/)
  assert.ok(Object.isFrozen(first.backendRef))
  const n = w.none().spawn(spec(3))
  assert.match(n.backendRef.spawn, /^none:/)
  assert.equal(n.shimPid, 4242, 'the none backend knows its pid at spawn; wt learns it from the snapshot')
})

// ---- list --------------------------------------------------------------------------------------

test('list is registry-first, reconciled against ONE cached snapshot by the exact marker token', t => {
  // No query API: a session is listed when the registry has it AND the snapshot proves it — and
  // session 7 must never be proven by session 70's process. A marked process with no descriptor is
  // an orphan for the reconciler, not a session to list.
  const w = world(t)
  const b = w.wt()
  const h7 = liveSession(w, b, 7, { shimPid: 107 })
  liveSession(w, b, 70, { shimPid: 170 })
  w.descriptor(9) // registered, no process: dead
  w.procs.set(555, shim(555, 12)) // running, no descriptor: orphan
  w.snapshots.length = 0

  const listed = b.list()
  assert.deepEqual(listed.map(h => h.id), ['7', '70'])
  assert.deepEqual(listed.map(h => h.shimPid), [107, 170])
  assert.equal(listed[0].backendRef.spawn, h7.backendRef.spawn, 'the handle carries the ref the launcher stamped')
  assert.deepEqual(w.snapshots, [2000], 'one snapshot, and the cached one')

  // session 7 alone: 70's process is not evidence for it
  w.procs.delete(107)
  assert.deepEqual(b.list().map(h => h.id), ['70'])
  assert.equal(validateResultShape('list', b.list()).ok, true)
})

test('an empty registry takes no snapshot, and an empty snapshot is refused rather than read as an empty fleet', t => {
  // The Windows reading costs ~450 ms and an empty registry must not pay it; the cheap process
  // listing degrades to nothing on a loaded box, and acting on that marks every session dead.
  const w = world(t)
  const b = w.wt()
  assert.deepEqual(b.list(), [])
  assert.deepEqual(w.snapshots, [])

  const h = liveSession(w, b, 3)
  w.procs = snapshotFrom([])
  assert.throws(() => b.list(), /never an empty fleet/)
  assert.throws(() => b.isAlive(h), /never an empty fleet/)
  assert.throws(() => assertSnapshot(new Map()), /never an empty fleet/)
})

test('a newborn session absent from a stale snapshot is listed, not called dead on its first breath', t => {
  // The launcher writes the descriptor BEFORE the shim exists and the snapshot is a PAST reading; a
  // launcher that read the absence as a failed spawn would spawn again beside it.
  const w = world(t)
  const b = w.wt()
  w.descriptor(3, { createdAt: new Date(T0 - 1_000).toISOString() })
  const h = b.spawn(spec(3))
  w.stamp(h)
  assert.deepEqual(b.list().map(x => x.id), ['3'])
  assert.equal(b.list()[0].shimPid, undefined, 'no pid is claimed for it yet')
  // list, isAlive, send and setStatus judge the newborn by the SAME grace: a session list() shows
  // that isAlive() calls dead is the "three different sets" disagreement again, and a send it cannot
  // receive yet says pending — never gone, which a caller reads as "stop retrying".
  assert.equal(b.isAlive(h), true)
  const pending = b.send(h, 'status please')
  assert.deepEqual([pending.ok, pending.requested, pending.delivered, pending.reason], [false, 13, 0, 'session-pending'])
  assert.equal(w.injections.length, 0, 'nothing is typed at a pid that does not exist yet')
  assert.equal(b.setStatus(h, 'working'), true)
  assert.equal(parseSessionState(fs.readFileSync(readSession('3', { stateDir: w.stateDir }).stateFile, 'utf8')), 'working')
  for (const other of [w.ps(), w.none()]) {
    const label = `n-${other.name}`
    w.descriptor(label, { createdAt: new Date(T0 - 1_000).toISOString() })
    const nh = other.spawn(spec(label))
    w.stamp(nh)
    assert.ok(other.list().some(x => x.id === label), `${other.name}: listed`)
    assert.equal(other.isAlive(nh), true, `${other.name}: and alive, because listed`)
    assert.equal(other.setStatus(nh, 'working'), true, `${other.name}: a status set on a newborn is recorded`)
  }
  // …and once it is older than the grace window the same absence is a death, for every method alike
  w.now = T0 + 60_000
  assert.deepEqual(b.list(), [])
  assert.equal(b.isAlive(h), false)
  assert.equal(b.send(h, 'status please').reason, 'session-gone')
  assert.equal(b.setStatus(h, 'ready'), false)
})

test('a descriptor the launcher never stamped, or stamped under another backend, is listed with a recovered ref', t => {
  // The registry claims the session and the snapshot proves the process: that is the strongest
  // evidence available, and it is marked `recovered` rather than passed off as a minted address.
  const w = world(t)
  const b = w.ps()
  w.descriptor(3, { shimPid: 103 })
  w.procs.set(103, shim(103, 3))
  w.descriptor(4, { shimPid: 104, backendRef: { backend: 'windows-terminal', label: '4', spawn: 'windows-terminal:x' } })
  w.procs.set(104, shim(104, 4))
  const [three, four] = b.list()
  assert.deepEqual(three.backendRef, { backend: 'powershell', label: '3', spawn: null, recovered: true, from: null })
  assert.deepEqual(four.backendRef, { backend: 'powershell', label: '4', spawn: null, recovered: true, from: 'windows-terminal' })
  assert.equal(b.isAlive(three), true)
  assert.equal(b.send(three, 'hi').ok, true, 'a recovered handle still addresses the live process')
})

// ---- addressing --------------------------------------------------------------------------------

test('a session is addressed by its registry handle, never by its label', t => {
  // A backend with no query API was once compensated for by searching command lines, and list, send
  // and kill each resolved a different set. A caller that fabricates {id} fails here instead.
  const w = world(t)
  const wt = w.wt()
  const h = liveSession(w, wt, 3)
  const foreign = { id: '3', role: 'working', backendRef: { backend: 'tmux', label: '3', spawn: 'tmux:1' } }
  for (const bad of [{ id: '3' }, '3', null, { id: '3', backendRef: 'windows-terminal:3' }, { backendRef: { backend: 'windows-terminal' } }, foreign]) {
    for (const b of [wt, w.ps(), w.none()]) {
      assert.throws(() => b.send(bad, 'hello'), TypeError)
      assert.throws(() => b.isAlive(bad), TypeError)
      assert.throws(() => b.kill(bad), TypeError)
      assert.throws(() => b.focus(bad), TypeError)
    }
  }
  assert.throws(() => wt.isAlive(foreign), /minted by "tmux"/)
  assert.equal(wt.isAlive(h), true, 'the handle the registry recorded is the only one that resolves')
  assert.equal(w.kills.length, 0, 'and no forged address killed anything')
})

test('a handle from a killed session never re-binds to its relaunched namesake', t => {
  // The launcher records the new spawn's ref in the descriptor; a stale handle disagrees with it and
  // reads as gone even though a process carrying the label is plainly running.
  const w = world(t)
  const b = w.wt()
  const stale = liveSession(w, b, 3, { shimPid: 103 })
  assert.equal(b.kill(stale).ok, true)
  const fresh = liveSession(w, b, 3, { shimPid: 203 })

  assert.equal(b.isAlive(stale), false)
  assert.equal(b.isAlive(fresh), true)
  assert.equal(b.send(stale, 'are you there').reason, 'session-gone')
  assert.equal(b.setStatus(stale, 'ready'), false)
  assert.equal(b.focus(stale), false)
  const kills = w.kills.length
  assert.deepEqual(b.kill(stale), { ok: true, killed: [], alreadyGone: true, survivors: [] })
  assert.equal(w.kills.length, kills, 'the stale handle planned no kill against the successor')
  assert.deepEqual(b.list().map(h => h.backendRef.spawn), [fresh.backendRef.spawn])
  assert.equal(w.injections.length, 0)
  assert.equal(spawnState(stale.backendRef, w.procs, readSession('3', { stateDir: w.stateDir })).replaced, true)
})

// ---- send: the chunking and the count ----------------------------------------------------------

test('a message is chunked at ~100 characters and a long or multi-line one goes through a file', () => {
  // The console input buffer takes ~128 characters per write; Enter is what submits, so a newline
  // typed key by key would send the first line and type the rest into the next prompt.
  const short = 'x'.repeat(250)
  const inline = planSend(short)
  assert.equal(inline.mode, 'inline')
  assert.deepEqual(inline.chunks.map(c => c.length), [100, 100, 50])
  assert.equal(inline.chunks.join(''), short)
  assert.equal(CHUNK_CHARS, 100)
  assert.equal(POINTER_THRESHOLD, 500)
  assert.equal(planSend('y'.repeat(500)).mode, 'inline', 'exactly the threshold still fits inline')
  assert.equal(planSend('y'.repeat(501)).mode, 'pointer')
  assert.equal(planSend('first line\nsecond').mode, 'pointer')
  assert.equal(planSend('ends with a return\r').mode, 'pointer')
  assert.deepEqual(planSend('').chunks, [])

  // a surrogate pair at the boundary stays whole: split, an emoji arrives as two lone surrogates
  const emoji = 'a'.repeat(99) + '\u{1F680}' + 'b'
  const chunks = chunkText(emoji, 100)
  assert.deepEqual(chunks.map(c => c.length), [99, 3])
  assert.equal(chunks[1].codePointAt(0), 0x1f680)
  assert.deepEqual(chunkText('\u{1F680}', 1).length, 2, 'a size too small for a pair still terminates')
})

test('the delivery loop honours the returned count — a short write stops the loop and is reported, and no Enter follows', () => {
  // The incident: ~700 characters arrived as 62 followed by Enter and the session acted on the
  // fragment because the caller ignored the count. Here the fragment stays unsubmitted.
  const text = 'x'.repeat(700)
  const chunks = chunkText(text)
  const log = []
  const limitTo = limit => (chunk, { enter }) => {
    log.push({ chunk, enter })
    return enter ? 1 : Math.min(limit, chunk.length)
  }

  const r = deliverChunks(text, chunks, limitTo(62))
  assert.deepEqual([r.ok, r.requested, r.delivered, r.truncated, r.reason, r.submitted], [false, 700, 62, true, 'short-write', false])
  assert.equal(log.length, 1, 'the loop stopped at the first short chunk')
  assert.ok(!log.some(l => l.enter), 'nothing submitted the fragment')

  // the second chunk short: the count accumulates across the ones that landed whole
  log.length = 0
  let n = 0
  const secondShort = (chunk, { enter }) => { log.push({ chunk, enter }); return enter ? 1 : (n++ === 1 ? 40 : chunk.length) }
  const r2 = deliverChunks(text, chunks, secondShort)
  assert.deepEqual([r2.ok, r2.delivered], [false, 140])
  assert.equal(log.length, 2)

  // everything landed: every chunk in order, then exactly one Enter
  log.length = 0
  const ok = deliverChunks(text, chunks, limitTo(Infinity))
  assert.deepEqual([ok.ok, ok.delivered, ok.truncated, ok.reason, ok.submitted], [true, 700, false, null, true])
  assert.deepEqual(log.map(l => l.enter), [false, false, false, false, false, false, false, true])
  assert.equal(log.slice(0, 7).map(l => l.chunk).join(''), text)
  assert.equal(validateResultShape('send', ok).ok, true)
})

test('an injector that returns no count, or whose Enter was refused, has not delivered', () => {
  // "No count" is 0, never "assume it all went": assuming is exactly what turned the short write
  // into an acted-upon fragment. Text typed but never submitted is not a delivered message either.
  assert.deepEqual(normalizeWrite(undefined, 10), { written: 0, reason: 'injector returned no count' })
  assert.deepEqual(normalizeWrite({ reason: 'AttachConsole(4242): access denied' }, 10), { written: 0, reason: 'AttachConsole(4242): access denied' })
  assert.deepEqual(normalizeWrite(99, 10), { written: 10, reason: null }, 'a count above the request is clamped, not believed')
  assert.deepEqual(normalizeWrite(-3, 10), { written: 0, reason: null })

  const noCount = deliverChunks('abc', ['abc'], () => undefined)
  assert.deepEqual([noCount.ok, noCount.delivered, noCount.reason], [false, 0, 'injector returned no count'])
  const noEnter = deliverChunks('abc', ['abc'], (chunk, { enter }) => (enter ? 0 : 3))
  assert.deepEqual([noEnter.ok, noEnter.delivered, noEnter.truncated, noEnter.reason, noEnter.submitted], [false, 3, false, 'not-submitted', false])
})

test('send injects into the shim pid the descriptor names, chunk by chunk, then Enter', t => {
  // A PowerShell host window carries the marker too, so "the first marked pid" would target the
  // wrong process; the pid the shim wrote into its own descriptor is the one whose console to attach.
  const w = world(t)
  const b = w.ps()
  w.descriptor(3, { shimPid: 103 })
  const h = b.spawn(spec(3))
  w.stamp(h)
  w.procs.set(90, { pid: 90, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoExit -File ps-launcher.ps1 "session 3" /w node shim.mjs --fleet-session=3 /s/3.json', startedAt: 90 })
  w.procs.set(103, shim(103, 3, { ppid: 90 }))
  w.descriptor(3, { ...readSession('3', { stateDir: w.stateDir }), shimPid: 103 })
  assert.deepEqual(markerPids(w.procs, '3'), [90, 103], 'both the host window and the shim carry the marker')

  const text = 'status please, ' + 'y'.repeat(120)
  const r = b.send(h, text)
  assert.deepEqual([r.ok, r.delivered, r.requested], [true, text.length, text.length])
  assert.deepEqual(w.injections.map(i => i.pid), [103, 103, 103])
  assert.deepEqual(w.injections.map(i => i.enter), [false, false, true])
  assert.equal(w.injections.slice(0, 2).map(i => i.text).join(''), text)
})

test('a message over the threshold is written to <stateDir>/messages/<id>-<n>.md and only the pointer is typed', t => {
  // The portable fix for the short-write trap (fleet send --file): the text goes to a file the
  // session can read, and the injected line is short enough to always fit.
  const w = world(t)
  const b = w.wt()
  const h = liveSession(w, b, 3)
  const text = 'z'.repeat(700)

  const r = b.send(h, text)
  const file1 = path.join(w.stateDir, MESSAGES_DIR, '3-1.md')
  assert.deepEqual([r.ok, r.requested, r.delivered, r.truncated, r.via, r.file], [true, 700, 700, false, 'file', file1])
  assert.equal(fs.readFileSync(file1, 'utf8'), text)
  const typed = w.injections.filter(i => !i.enter).map(i => i.text).join('')
  assert.equal(typed, `Read ${file1} now`)
  assert.equal(w.injections.at(-1).enter, true)

  // the next one gets the next number; a number is never reused, so a file is never overwritten
  b.send(h, 'a\nb')
  assert.equal(fs.readFileSync(path.join(w.stateDir, MESSAGES_DIR, '3-2.md'), 'utf8'), 'a\nb')
  assert.equal(messageNumber(['3-1.md', '3-7.md', '30-9.md', '3-x.md'], '3'), 8)
  assert.equal(messageNumber([], 'a.b'), 1)

  // a pointer that itself came up short delivered NOTHING of the text — a half-typed path is not a
  // partially delivered message, and it is not submitted
  w.injections.length = 0
  w.injectScript = (n, chunk, { enter }) => (enter ? 1 : Math.min(5, chunk.length))
  const short = b.send(h, text)
  assert.deepEqual([short.ok, short.delivered, short.truncated, short.submitted], [false, 0, true, false])
  assert.match(short.reason, /short-write \(pointer to /)
  assert.ok(!w.injections.some(i => i.enter))
})

test('a send to a session that has gone is reported per target, not thrown at the whole loop', t => {
  // "Send to 1, 2, 3" once reached nobody with a single error while the listing showed them all.
  const w = world(t)
  const b = w.wt()
  const handles = [1, 2, 3].map(n => liveSession(w, b, n))
  w.procs.delete(102)
  const results = handles.map(h => b.send(h, 'status please'))
  assert.deepEqual(results.map(r => r.ok), [true, false, true])
  assert.deepEqual(results[1], { ok: false, requested: 13, delivered: 0, truncated: false, reason: 'session-gone' })
  assert.deepEqual(w.injections.map(i => i.pid).filter((p, i, a) => a.indexOf(p) === i), [101, 103], 'nothing was typed at the dead one')
})

test('the injector helper is invoked detached with base64 text, and its count is parsed — a failed attach is zero', () => {
  // The text goes as UTF-16LE base64: quotes, spaces and non-ASCII would not survive a Windows
  // command line otherwise. Text and Enter are separate invocations, so Enter is only ever sent
  // after every chunk is known to have landed.
  const argv = injectorArgv(4242, 'hi "there"', { enter: false })
  assert.deepEqual(argv.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
  assert.deepEqual(argv.slice(4, 8), ['-File', WT_INJECT, '-TargetPid', '4242'])
  assert.equal(argv[8], '-TextBase64')
  assert.equal(Buffer.from(argv[9], 'base64').toString('utf16le'), 'hi "there"')
  assert.ok(!argv.includes('-Enter'))
  assert.deepEqual(injectorArgv(4242, '', { enter: true }).slice(-1), ['-Enter'])
  assert.ok(!injectorArgv(4242, '', { enter: true }).includes('-TextBase64'))
  assert.ok(fs.existsSync(WT_INJECT), 'the helper the argv points at ships with the backend')
  // The load-bearing statements, comments stripped: a header that merely NAMES the calls must not
  // keep this green once the body that makes them is gone.
  const helper = stripPsComments(fs.readFileSync(WT_INJECT, 'utf8'))
  assert.match(helper, /\[FleetInject\.Injector\]::Inject\(\[uint32\]\$TargetPid, \$text, \[bool\]\$Enter\)/, 'the script runs the injector against the target pid')
  assert.match(helper, /^\s*exit 2$/m, 'a refused attach exits non-zero, which the caller reads as nothing delivered')
  assert.ok(helper.includes('AttachConsole(pid)') && helper.includes('WriteConsoleInputW(h, recs') && helper.includes('FreeConsole()'))

  const ok = { ok: true, code: 0, stdout: '62\r\n', stderr: '' }
  assert.deepEqual(parseInjectorResult(ok), { written: 62, reason: null })
  const refused = { ok: false, code: 2, stdout: '', stderr: 'AttachConsole(4242): Access is denied\r\n' }
  assert.deepEqual(parseInjectorResult(refused), { written: 0, reason: 'injector failed (exit 2): AttachConsole(4242): Access is denied' })
  assert.deepEqual(parseInjectorResult({ ok: true, code: 0, stdout: '', stderr: '' }), { written: 0, reason: 'injector printed no count' })
  assert.match(parseInjectorResult({ ok: false, timedOut: true, code: null, stdout: '', stderr: '' }).reason, /timed out/)
  assert.equal(encodeUtf16('A'), 'QQA=')
})

// ---- status ------------------------------------------------------------------------------------

test('setStatus is write-only: it lands in the state file the shim polls, and an unknown status is refused first', t => {
  // The backend cannot paint another console's title; the shim paints the OSC title from the file.
  // A typo that silently no-ops loses the fleet's red/green, so it throws before resolving anything.
  const w = world(t)
  for (const b of [w.wt(), w.ps(), w.none()]) {
    const label = `s-${b.name}`
    const h = liveSession(w, b, label, { shimPid: 300 + w.procs.size })
    assert.throws(() => b.setStatus(h, 'busy'), /unknown status "busy"/)
    assert.equal(b.setStatus(h, 'blocked'), true)
    const stateFile = readSession(label, { stateDir: w.stateDir }).stateFile
    assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'blocked', `${b.name}: the shim reads it back as the status`)
    assert.equal(b.setStatus(h, 'working'), true)
    assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'working')
    w.procs.delete(readSession(label, { stateDir: w.stateDir }).shimPid)
    assert.equal(b.setStatus(h, 'ready'), false, `${b.name}: nothing is written for a session that is gone`)
    assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'working')
  }
})

// ---- kill --------------------------------------------------------------------------------------

test('kill takes a FRESH snapshot, roots the tree at the shim pid, walks it deepest first and leaves the neighbour alone', t => {
  // A kill planned on the cached reading misses the dev server the agent started since; killing by
  // exclusion once took an operator's unrelated session with it.
  const w = world(t)
  const b = w.wt()
  const one = liveSession(w, b, 1, { shimPid: 101 })
  const two = liveSession(w, b, 2, { shimPid: 102 })
  w.procs.set(111, { pid: 111, ppid: 101, name: 'claude', cmd: 'claude --model opus', startedAt: 101 })
  w.procs.set(121, { pid: 121, ppid: 111, name: 'node', cmd: 'node next dev', startedAt: 102 })
  w.procs.set(112, { pid: 112, ppid: 102, name: 'claude', cmd: 'claude --model opus', startedAt: 101 })
  w.procs.set(900, { pid: 900, ppid: 1, name: 'claude', cmd: 'claude weekly-demo', startedAt: 50 })
  w.snapshots.length = 0

  const r = b.kill(one)
  assert.deepEqual(r, { ok: true, killed: [121, 111, 101], alreadyGone: false, survivors: [] })
  assert.equal(w.kills.length, 1)
  assert.equal(w.kills[0].root, 101)
  assert.equal(w.kills[0].opts.selfPid, 999_999)
  assert.equal(typeof w.kills[0].opts.resnapshot, 'function')
  assert.deepEqual(w.snapshots, [0, 0], 'a fresh snapshot to plan, a fresh one to verify — never the cached one')
  for (const pid of [102, 112, 900]) assert.ok(w.procs.has(pid), `pid ${pid} is untouched`)
  assert.equal(b.isAlive(two), true)
  assert.deepEqual(b.list().map(h => h.id), ['2'])
  assert.equal(validateResultShape('kill', r).ok, true)
})

test('a kill that leaves a survivor reports it — relaunch is kill, VERIFY GONE, then spawn', t => {
  // A kill that can never fail leaves every caller's verify-gone branch unexecuted, and the survivor
  // it should have found is a dev server still holding the slot's port.
  const w = world(t)
  const b = w.wt()
  const h = liveSession(w, b, 1, { shimPid: 101 })
  w.procs.set(111, { pid: 111, ppid: 101, name: 'claude', cmd: 'claude --model opus', startedAt: 101 })
  w.procs.set(121, { pid: 121, ppid: 111, name: 'node', cmd: 'node next dev', startedAt: 102 })
  w.survivorsOf = () => [121]
  const r = b.kill(h)
  assert.deepEqual(r, { ok: false, killed: [111, 101], alreadyGone: false, survivors: [121] })
  assert.ok(w.procs.has(121), 'the dev server is still there for the caller to deal with')
})

test('kill is idempotent, and a duplicate launch (two marked pids) is rooted at both without double counting', t => {
  // Teardown after a crash kills sessions that are already gone and must not throw. A PowerShell
  // host window and its shim are both marked pids: the second plan walks the first one's remains.
  const w = world(t)
  const b = w.ps()
  const h = liveSession(w, b, 3, { shimPid: 103 })
  assert.equal(b.kill(h).alreadyGone, false)
  assert.deepEqual(b.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })

  const dup = liveSession(w, b, 4, { shimPid: 104 })
  w.procs.set(90, { pid: 90, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe -NoExit -File ps-launcher.ps1 "session 4" /w node shim.mjs --fleet-session=4 /s/4.json', startedAt: 90 })
  w.procs.set(104, shim(104, 4, { ppid: 90 }))
  const r = b.kill(dup)
  assert.deepEqual(w.kills.slice(-2).map(k => k.root), [90, 104])
  assert.deepEqual([...r.killed].sort((a, b) => a - b), [90, 104])
  assert.equal(r.ok, true)
})

// ---- focus and layout --------------------------------------------------------------------------

test('focus is best-effort by title token and reports a miss', t => {
  const w = world(t)
  const b = w.wt()
  const h = liveSession(w, b, 3)
  assert.equal(b.focus(h), true)
  assert.deepEqual(w.focused, ['session 3'])
  w.focusResult = false
  assert.equal(b.focus(h), false, 'no window carried the token')
  w.procs.delete(103)
  assert.equal(b.focus(h), false)
  assert.equal(w.focused.length, 2, 'nothing is activated for a session that is gone')
  assert.equal(w.none().focus(h.backendRef ? { ...h, backendRef: { backend: 'none', label: '3', spawn: null } } : h), false)

  // the script escapes the token as data: a title with a quote or a wildcard is neither syntax nor pattern
  const script = focusScript("it's [3] *")
  assert.ok(script.includes("Escape('it''s [3] *')"))
  assert.ok(script.includes('AppActivate'))
  assert.equal(parseFocusResult({ ok: true, stdout: '1\r\n' }), true)
  assert.equal(parseFocusResult({ ok: true, stdout: '0\r\n' }), false)
  assert.equal(parseFocusResult({ ok: false, stdout: '' }), false)
})

test('layout announces what it cannot place; pixel-grid is an extras hook the backend claims only when given', t => {
  // Every degradation is a line the caller can log, never a silent nothing; the SetWindowPos
  // arithmetic lives outside core and its presence is what flips pixelLayout on.
  const w = world(t)
  const b = w.wt()
  const handles = [1, 2, 3].map(n => liveSession(w, b, n))
  // wt sessions are TABS in one window: the `windows` arrangement does not exist for it, and saying
  // `placed: 3` would be the silent no-op the capability table exists to rule out.
  const windows = b.layout(handles, 'windows')
  assert.equal(windows.placed, 0)
  assert.match(windows.notice, /windows layout: sessions are tabs in one window .*\(no freeFloatingWindows\)/)
  assert.deepEqual(w.ps().layout(handles, 'windows'), { mode: 'windows', placed: 3, notice: null }, 'separate PowerShell windows ARE the windows layout')
  const tiled = b.layout(handles, 'tiled-panes')
  assert.equal(tiled.placed, 0)
  assert.match(tiled.notice, /tiling: unavailable on this terminal backend \(no gridLayout\)/)
  const pixel = b.layout(handles, 'pixel-grid')
  assert.equal(pixel.placed, 0)
  assert.match(pixel.notice, /no pixelLayout.*extras\/windows/)
  assert.match(b.layout(handles, 'diagonal').notice, /unknown mode "diagonal"/)
  assert.equal(validateResultShape('layout', pixel).ok, true)

  const placed = []
  const hooked = w.wt({ placeWindows: hs => { placed.push(hs.map(h => h.id)); return hs.length } })
  assert.equal(hooked.capabilities().pixelLayout, true)
  assert.deepEqual(hooked.layout(handles, 'pixel-grid'), { mode: 'pixel-grid', placed: 3, notice: null })
  assert.deepEqual(placed, [['1', '2', '3']])
  const broken = w.ps({ placeWindows: () => { throw new Error('no monitor geometry') } })
  assert.match(broken.layout(handles, 'pixel-grid').notice, /pixel-grid placement failed: no monitor geometry/)

  const none = w.none().layout(handles, 'windows')
  assert.equal(none.placed, 0)
  assert.match(none.notice, /no terminal/)
})

// ---- the PowerShell fallback -------------------------------------------------------------------

test('the PowerShell launch is one Start-Process -NoExit -File per session, with both quoting layers exact', t => {
  // Start-Process joins -ArgumentList with spaces and quotes nothing, so a worktree path with a
  // space would reach the launcher as two arguments; the script rides on -EncodedCommand so no third
  // layer of quoting exists.
  assert.equal(quoteArg('plain'), 'plain')
  assert.equal(quoteArg('with space'), '"with space"')
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteArg('trailing\\'), 'trailing\\', 'no quotes needed, no backslash doubling')
  assert.equal(quoteArg('a b\\'), '"a b\\\\"', 'a quoted trailing backslash is doubled or it escapes the closing quote')
  assert.equal(quoteArg(''), '""', 'an empty token must not vanish and shift every positional after it')
  assert.equal(psLiteral("it's"), "'it''s'")

  const s = spec(3)
  const script = launchScript(s, { launcher: '/plugin/src/backends/ps-launcher.ps1' })
  assert.ok(script.includes("Start-Process -FilePath 'powershell.exe' -WorkingDirectory '/w/app session-3' -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '/plugin/src/backends/ps-launcher.ps1', '\"session 3\"', '\"/w/app session-3\"', 'node', '/plugin/src/session/shim.mjs', '--fleet-session=3', '\"/state/my fleet/sessions/3.json\"') -PassThru"), script)
  assert.ok(script.endsWith('[Console]::Out.WriteLine($p.Id)'))
  assert.equal(parseHostPid({ ok: true, stdout: '31337\r\n' }), 31337)
  assert.equal(parseHostPid({ ok: true, stdout: '' }), null)

  const w = world(t)
  w.descriptor(3)
  w.execResult = { ok: true, code: 0, stdout: '31337\r\n', stderr: '', timedOut: false }
  const h = w.ps({ launcher: '/plugin/src/backends/ps-launcher.ps1' }).spawn(s)
  assert.equal(w.runs[0].command, 'powershell.exe')
  assert.equal(w.runs[0].args.at(-2), '-EncodedCommand')
  assert.equal(Buffer.from(w.runs[0].args.at(-1), 'base64').toString('utf16le'), script)
  assert.deepEqual([h.backendRef.backend, h.backendRef.hostPid, h.backendRef.title], ['powershell', 31337, 'session 3'])
})

test('the PowerShell launcher has no param() block — one would eat the shim\'s own -e and --fleet-session tokens', () => {
  // powershell.exe binds every "-x" argument to a script parameter when the script declares any:
  // `-e` is refused as ambiguous (-ErrorAction, -ErrorVariable) and the marker never reaches the shim.
  assert.ok(fs.existsSync(PS_LAUNCHER))
  const text = fs.readFileSync(PS_LAUNCHER, 'utf8')
  assert.doesNotMatch(text, /^\s*param\s*\(/m)
  // The statements that make it a launcher, comments stripped — the header names every one of them,
  // so a substring check passed with the body gutted. (-NoExit is the CALLER's flag: see launchScript.)
  const code = stripPsComments(text)
  assert.match(code, /^\$title = \[string\]\$args\[0\]$/m, 'the title is bound positionally from $args')
  assert.match(code, /^\$Host\.UI\.RawUI\.WindowTitle = \$title$/m, 'and painted on the window, which is the token focus() looks for')
  assert.match(code, /^Set-Location -LiteralPath \$cwd$/m, 'the shim starts in the worktree')
  assert.match(code, /^& \$command @rest$/m, 'and is actually RUN, with its argv splatted through')
})

// ---- the none backend --------------------------------------------------------------------------

test('the none backend declares what it cannot do: send delivers nothing and says why', t => {
  // A declared inability, never a silent drop — a caller sees delivered 0 and the reason.
  const w = world(t)
  const b = w.none()
  const h = liveSession(w, b, 3)
  assert.deepEqual(b.send(h, 'status please'), { ok: false, requested: 13, delivered: 0, truncated: true, reason: 'no terminal' })
  assert.equal(b.isAlive(h), true)
  // The log is opened by THIS process, so its path is the host's whatever the `platform` seam says.
  // Joined with the target platform's separators it was, on a POSIX host, a relative name with literal
  // backslashes — and every run of this file left `\tmp\...\3.log` junk in the working tree.
  const log = path.join(w.stateDir, 'logs', '3.log')
  assert.equal(logPathFor(w.stateDir, '3'), log)
  assert.ok(fs.existsSync(log), 'the log exists under the temp state dir, not in the cwd')
  const started = w.runs[0]
  assert.equal(started.command, 'node')
  assert.deepEqual(started.args, spec(3).args)
  assert.equal(started.opts.env.FLEET_LABEL, '3', 'the env reaches the detached shim as an object')
  assert.deepEqual(started.opts.stdio.slice(0, 1), ['ignore'])
  assert.equal(typeof started.opts.stdio[1], 'number', 'stdout is the log file descriptor')
  assert.equal(started.opts.stdio[1], started.opts.stdio[2], 'and so is stderr')
})

test('the none backend REALLY spawns, lists, and kills a detached agent through the registry and a live snapshot', { timeout: 90_000 }, async t => {
  // What CI can actually run: a `node -e` agent found by the exact argv marker in a real process
  // snapshot, its output in <stateDir>/logs/<id>.log, killed through the real tree walk, then gone.
  // The agent is killed — and waited for — BEFORE the root is removed: it holds its log open under it.
  let h = null
  const root = tmpRoot(t, 'fleet-none-it-', { before: () => killAndWait(h && h.shimPid) })
  const stateDir = path.join(root, 'state')
  const label = `it-${process.pid}`
  const b = createNoneBackend({ config: configFor(stateDir), snapshotMaxAgeMs: 0 })
  // Dated an hour ago so the reconciler's birth grace does not hold the killed session in `pending`.
  writeSession({ label, id: label, role: 'working', worktree: root, stateFile: path.join(stateDir, 'sessions', `${label}.state`), createdAt: new Date(Date.now() - 3_600_000).toISOString() }, { stateDir })

  const script = "process.stdout.write('agent up\\n');setInterval(function(){},1000)"
  h = b.spawn({
    id: label, role: 'working', title: label, cwd: root, command: process.execPath,
    args: ['-e', script, '--', `--fleet-session=${label}`],
    env: buildSessionEnv(defaultsFor(), { label, role: 'working', file: 'f', stateFile: 's', stateDir }),
  })
  assert.ok(Number.isInteger(h.shimPid) && h.shimPid > 0)
  writeSession({ ...readSession(label, { stateDir }), backendRef: h.backendRef, shimPid: h.shimPid }, { stateDir })

  const log = logPathFor(stateDir, label)
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('agent up'), 20_000, 'the agent wrote to its log')
  assert.equal(b.isAlive(h), true, 'the marker is in the live snapshot')
  const listed = b.list()
  assert.deepEqual(listed.map(x => x.id), [label])
  assert.equal(listed[0].shimPid, h.shimPid)
  assert.equal(listed[0].backendRef.spawn, h.backendRef.spawn)

  const r = b.kill(h)
  assert.equal(r.alreadyGone, false)
  assert.ok(r.killed.includes(h.shimPid), `killed ${JSON.stringify(r.killed)} should include ${h.shimPid}`)
  assert.deepEqual(r.survivors, [])
  assert.equal(r.ok, true)
  await waitFor(() => b.isAlive(h) === false, 10_000, 'the agent is gone from the snapshot')
  assert.deepEqual(b.list(), [])
  assert.deepEqual(b.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
})

// ---- Windows Terminal, for real ----------------------------------------------------------------

const WT_INTEGRATION = !!process.env.FLEET_TEST_INTEGRATION && process.platform === 'win32' && !!which('wt.exe')
const wtSkip = WT_INTEGRATION ? false : `real Windows Terminal test skipped: ${!process.env.FLEET_TEST_INTEGRATION ? 'set FLEET_TEST_INTEGRATION=1' : process.platform !== 'win32' ? 'not Windows' : 'wt.exe is not on PATH'}`

test('a real wt tab receives an injected message through wt-inject.ps1, chunked, and the tree is killed', { skip: wtSkip, timeout: 180_000 }, async t => {
  // Opens a tab in a throwaway window named after this process; the agent echoes what it reads
  // from stdin into a file, which is the only proof that AttachConsole + WriteConsoleInputW typed
  // into the right console. The tab is left for the operator to close: wt keeps a killed tab open.
  const root = tmpRoot(t, 'fleet-wt-it-')
  const stateDir = path.join(root, 'state')
  const label = `wt-${process.pid}`
  const agent = path.join(root, 'agent.mjs')
  const echo = path.join(root, 'echo.txt')
  fs.writeFileSync(agent, [
    "import fs from 'node:fs'",
    'const out = process.argv[3]',
    "fs.appendFileSync(out, 'agent up\\n')",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', d => fs.appendFileSync(out, d))",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  const b = createWindowsTerminalBackend({ config: configFor(stateDir), window: `fleet-test-${process.pid}`, snapshotMaxAgeMs: 0 })
  assert.equal(b.probe().available, true)
  writeSession({ label, id: label, role: 'working', worktree: root, stateFile: path.join(stateDir, 'sessions', `${label}.state`), createdAt: new Date(Date.now() - 3_600_000).toISOString() }, { stateDir })

  const h = b.spawn({ id: label, role: 'working', title: label, cwd: root, command: process.execPath, args: [agent, `--fleet-session=${label}`, echo], env: [] })
  writeSession({ ...readSession(label, { stateDir }), backendRef: h.backendRef }, { stateDir })
  await waitFor(() => fs.existsSync(echo) && fs.readFileSync(echo, 'utf8').includes('agent up'), 30_000, 'the agent started in the tab')
  await waitFor(() => b.isAlive(h), 30_000, 'the marker is in the live snapshot')
  const listed = b.list()
  assert.deepEqual(listed.map(x => x.id), [label])
  const shimPid = listed[0].shimPid
  t.after(() => { try { process.kill(shimPid, 'SIGKILL') } catch { /* already gone */ } })

  const message = 'hello from the fleet ' + 'ab'.repeat(60) + ' end'
  const r = b.send(h, message)
  assert.deepEqual([r.ok, r.delivered, r.requested, r.submitted], [true, message.length, message.length, true], JSON.stringify(r))
  await waitFor(() => fs.readFileSync(echo, 'utf8').includes(message), 30_000, 'the message arrived whole in the agent\'s stdin')
  assert.match(fs.readFileSync(echo, 'utf8'), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n'), 'and Enter submitted it')

  const killed = b.kill(h)
  assert.equal(killed.ok, true, JSON.stringify(killed))
  assert.ok(killed.killed.includes(shimPid))
  await waitFor(() => b.isAlive(h) === false, 15_000, 'the agent is gone')
})

/** Poll until `check` is true, or fail with `what`. */
async function waitFor(check, timeoutMs, what) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      if (check()) return
    } catch (e) {
      last = e
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for: ${what}${last ? ` (last error: ${last.message})` : ''}`)
}

/** The non-comment lines of a PowerShell script, LF-joined, so `^…$` matches a statement and never a header that names it. */
function stripPsComments(text) {
  return String(text).split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
}

/** SIGKILL a pid and wait until the OS says it is gone (signal 0 → ESRCH), so what it held open is closed before its files are removed. */
async function killAndWait(pid, timeoutMs = 5_000) {
  if (!pid) return
  try { process.kill(pid, 'SIGKILL') } catch { return /* already gone */ }
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(r => setTimeout(r, 50))
  }
}

// The snapshot source remembers WHEN a reading was taken: the same Map back is the cached one.
test('the snapshot source dates a cached reading by when it was first seen, not by now', () => {
  let now = T0
  const same = table(shim(103, 3))
  let calls = 0
  const source = createSnapshotSource({ take: () => { calls++; return same }, now: () => now, maxAgeMs: 2000 })
  assert.equal(source.cached().takenMs, T0)
  now = T0 + 1500
  assert.equal(source.cached().takenMs, T0, 'the same Map is the earlier reading')
  assert.equal(calls, 2, 'the provider is asked each time; its cache decides what comes back')
  assert.throws(() => createSnapshotSource({ take: () => new Map() }).fresh(), /never an empty fleet/)
})
