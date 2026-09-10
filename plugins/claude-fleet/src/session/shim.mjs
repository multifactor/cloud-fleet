// The process that runs inside every session window:
// `node shim.mjs --fleet-session=<label> <descriptor.json>`.
//
// It is the session's supervisor and its only durable record. It writes the registry entry every
// other part of the tool looks the session up by, keeps the pool locks the session holds alive,
// paints the status indicator the operator reads across a screen of windows, and — the reason it is
// a process at all rather than a wrapper script — it OUTLIVES the agent long enough to write an exit
// record and hand the locks back.
//
// The decisions are pure functions of the descriptor and the resolved config (`buildChildSpec`,
// `parseSessionState`, `ownedLockDirs`, `exitRecord`); `runShim` takes its side effects injected.
// That is what lets each trap below be a unit test instead of a comment.

import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { SESSION_MARKER } from '../sys/proc.mjs'
import { heartbeat, release, readHolder } from '../sys/lock.mjs'
import { buildSessionEnv } from '../config/env.mjs'
import { SCHEMA_BY_KEY } from '../config/schema.mjs'
import { STATUS } from '../backends/types.mjs'

/**
 * ⛔ Both are deleted from the environment of the spawned agent AND from the shim's own.
 *
 * A Claude Code session spawned from inside another one inherits `CLAUDE_CODE_CHILD_SESSION` (and
 * `CLAUDECODE`), and a child session writes NO transcript: every watcher that reads transcripts goes
 * blind (no stall detection, no liveness, no dedup) and session resume silently has nothing to
 * resume from. Nothing about the window looks wrong, which is why this is deleted rather than
 * detected.
 */
export const STRIPPED_ENV = Object.freeze(['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'])

/**
 * The mirrored scalars only SOME roles get (contract §4), deleted from the inherited environment
 * before this session's own are applied.
 *
 * A launcher started from inside a session window — or a relaunch inheriting an environment a
 * previous session already grew — passes these down, and `buildSessionEnv` emits them for `testing`
 * and `checker` only. A `working` session would then read another session's slot, branch and port as
 * its own, which playbooks/testing.md tells it to trust. The role-independent scalars need no such
 * delete: every role overwrites all of them. `FLEET_*` config overrides (contract §3's env layer,
 * `FLEET_COMMANDS_DEV_SERVER` and friends) are deliberately NOT touched — they are the operator's.
 */
export const ROLE_SCOPED_ENV = Object.freeze(['FLEET_SWEEP_DIR', 'FLEET_SLICE', 'FLEET_SLOT', 'FLEET_SLOT_BRANCH', 'FLEET_PORT'])

/** The CEILING on the lock heartbeat / status repaint cadence — `heartbeatMsFor` may go faster. */
export const HEARTBEAT_MS = 30_000

/** Never faster than this, whatever the config says: each tick rewrites a holder file per lock. */
export const MIN_HEARTBEAT_MS = 1_000

/**
 * ⛔ The cadence is a QUARTER of the shortest staleness this config configures, never a constant.
 *
 * `testing.lock.staleMinutes` (12) and `emulator.lockStaleMinutes` (45) are plain ints with no floor,
 * so a project may set a staleness a fixed 30s cadence leaves no margin inside: one slow tick — this
 * walks the whole locks tree and rewrites a holder file per slot — and the slot is stolen mid-work.
 */
export function heartbeatMsFor(config) {
  const stale = [config?.testing?.lock?.staleMinutes, config?.emulator?.lockStaleMinutes]
    .filter(m => Number.isFinite(m) && m > 0)
    .map(m => m * 60_000)
  if (!stale.length) return HEARTBEAT_MS
  return Math.max(MIN_HEARTBEAT_MS, Math.min(HEARTBEAT_MS, Math.floor(Math.min(...stale) / 4)))
}

export const ROLES = Object.freeze(['working', 'testing', 'checker'])

/** The agent CLIs, straight from the schema so this list can never drift from `fleet.agent`. */
export const AGENTS = Object.freeze(SCHEMA_BY_KEY.get('fleet.agent').enum)

/**
 * The argv that puts a session in its agent's BYPASS-PERMISSIONS mode, per agent.
 *
 * ⛔ A fleet session is unattended by definition — its own seed prompt tells it "nobody is reading
 * this window". A session left on the host's default mode can still stop and wait for a permission
 * decision, and there is no one there to make one: it then sits `alive` and `ready` forever, which
 * reads on `fleet status` exactly like a session with nothing to do. That is the same stall class as
 * an unanswered dialog, arriving through the one door a spawn flag can close.
 *
 * An agent with no entry here is a spawn that FAILS rather than one that quietly runs attended —
 * `fleet.permissionMode: inherit` is how an operator asks for the host default, explicitly.
 */
export const BYPASS_ARGS = Object.freeze({
  claude: Object.freeze(['--permission-mode', 'bypassPermissions']),
  codex: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
})

// ---- pure ---------------------------------------------------------------------------------------

/**
 * The one argv token a session is identified by: `--fleet-session=<label>`.
 *
 * ⛔ One token, matched whole. Every command-line filter this tool ever had was wrong in both
 * directions — a probe counting itself, and session 7 matching session 70 — so the marker must
 * survive tokenisation intact: a label carrying whitespace splits into two tokens and matches
 * nothing.
 */
export function markerFor(label) {
  const s = String(label ?? '')
  if (!s || /\s/.test(s)) throw new Error(`shim: session label ${JSON.stringify(label)} cannot be an argv token`)
  return SESSION_MARKER + s
}

/** Throw unless the descriptor carries what the shim needs, naming every missing field at once. */
export function assertDescriptor(descriptor) {
  const d = descriptor || {}
  const missing = []
  for (const f of ['id', 'label', 'role', 'worktree', 'file', 'stateFile']) {
    if (d[f] === undefined || d[f] === null || d[f] === '') missing.push(f)
  }
  if (!d.paths || !d.paths.stateDir) missing.push('paths.stateDir')
  if (missing.length) throw new Error(`shim: descriptor is missing ${missing.join(', ')}`)
  if (!ROLES.includes(d.role)) throw new Error(`shim: unknown role "${d.role}" (one of ${ROLES.join('|')})`)
  return d
}

/**
 * The names this session's locks may be held under. A lock is held by the SESSION, never by the
 * shell that acquired it (contract §4).
 *
 * ⛔ The LABEL first, because that is what `fleet pool acquire` records (docs/gotchas.md, "A lock
 * that tracks the acquire child does not hold") and what a session is addressed by everywhere else.
 * The id is accepted too: it is `label` unless a launcher supplies one (core/prompts.mjs), and a
 * shim that recognised only one spelling would heartbeat NOTHING when acquire wrote the other —
 * silently, and the pool would steal every slot on schedule while its owner worked.
 */
export function lockOwnersOf(descriptor) {
  return [...new Set([String(descriptor.label), String(descriptor.id)])]
}

/** The descriptor, reshaped into the session object `buildSessionEnv` consumes. */
export function sessionEnvInput(descriptor) {
  return {
    label: descriptor.label,
    role: descriptor.role,
    file: descriptor.file,
    stateFile: descriptor.stateFile,
    stateDir: descriptor.paths.stateDir,
    testingUrl: descriptor.testingUrl,
    testingUrls: descriptor.testingUrls,
    sweepDir: descriptor.sweepDir,
    slice: descriptor.slice,
    slot: descriptor.slot,
    branch: descriptor.branch,
    port: descriptor.port,
  }
}

/**
 * The PATH key ALREADY spelled in this environment.
 *
 * Windows conventionally spells it `Path`, and a plain object copy of the environment keeps that
 * spelling: writing `PATH` beside it leaves the child holding two variables, and the one the loader
 * reads is not the one we prepended to.
 */
export function pathKeyOf(env, platform = process.platform) {
  const found = Object.keys(env || {}).find(k => k.toLowerCase() === 'path')
  return found || (platform === 'win32' ? 'Path' : 'PATH')
}

/**
 * Prepend `dirs` to the environment's PATH, skipping any already on it.
 *
 * A required helper binary missing from a spawned window's PATH once killed the per-branch proxy at
 * spawn: the host never registered, the proxy answered its own 404, and the app read as broken. The
 * de-duplication is because a relaunched session inherits the PATH the previous one already grew —
 * and it case-folds on Windows ONLY, because `/opt/Bin` and `/opt/bin` are two directories on POSIX
 * and dropping the second one recreates the very missing-binary failure above.
 * @returns {{key: string, value: string}}
 */
export function prependPath(env, dirs, platform = process.platform) {
  const key = pathKeyOf(env, platform)
  const sep = platform === 'win32' ? ';' : ':'
  const norm = s => {
    const t = String(s).replace(/[\\/]+$/, '')
    return platform === 'win32' ? t.toLowerCase() : t
  }
  const current = String((env && env[key]) || '')
  const have = new Set(current.split(sep).filter(Boolean).map(norm))
  const add = []
  for (const d of dirs || []) {
    if (!d || have.has(norm(d))) continue
    have.add(norm(d))
    add.push(String(d))
  }
  return { key, value: add.length ? [...add, current].filter(Boolean).join(sep) : current }
}

/**
 * Everything needed to start this session's agent. PURE — no spawn, no filesystem.
 * @param {object} descriptor  sessions/<label>.json, plus its own path in `file`
 * @param {object} config      the resolved config (`<stateDir>/resolved.json` → `config`)
 * @returns {{command: string, args: string[], env: object, cwd: string, stdio: string, marker: string, stripped: string[]}}
 *          `marker` is the SHIM's own argv token, reported here for the caller that checks its own
 *          command line — it is never an argument to the agent.
 */
export function buildChildSpec(descriptor, config, { baseEnv = {}, platform = process.platform } = {}) {
  assertDescriptor(descriptor)
  const agent = descriptor.agent || config.fleet.agent
  if (!AGENTS.includes(agent)) throw new Error(`shim: unknown agent "${agent}" (fleet.agent is one of ${AGENTS.join('|')})`)

  // ⛔ The model goes on every agent command line and is never inherited: with no model in the host's
  // settings the CLI picks its own default, and a settings change once moved a whole running fleet
  // onto the wrong model without a word.
  const model = descriptor.model || config.fleet.model
  if (!model) throw new Error('shim: no model to pass — an inherited default once put a whole fleet on the wrong model, so fleet.model must be set')

  // ⛔ The marker is the SHIM's, and stays off the agent's command line. It is how the shim "matches
  // itself" (contract §4), and the launcher already puts it on the shim's own argv
  // (backends/types.mjs SpawnSpec). On both processes, every marked-pid count doubles: `reconcilePlan`
  // reads two shims answering to one label — its duplicate-launch signal — and binds `shimPid` to the
  // lower pid, which may be the agent, so `fleet kill` walks the tree from the wrong root. It is also
  // an unknown flag to the agent CLI.
  const marker = markerFor(descriptor.label)
  const args = ['--model', String(model)]

  // Unattended sessions run in bypass-permissions mode unless the operator asked for the host
  // default. See BYPASS_ARGS: an unanswerable permission prompt is an invisible stall.
  const permissionMode = descriptor.permissionMode || config.fleet.permissionMode || 'bypass'
  if (permissionMode !== 'inherit') {
    const bypass = BYPASS_ARGS[agent]
    if (!bypass) {
      throw new Error(`shim: no bypass-permissions argv is known for agent "${agent}" — set fleet.permissionMode to "inherit" to run it on the host default, and accept that the session can stop on a prompt nobody will answer`)
    }
    args.push(...bypass)
  }

  const env = { ...baseEnv }
  for (const name of STRIPPED_ENV) delete env[name]
  for (const name of ROLE_SCOPED_ENV) delete env[name]
  for (const { name, value } of buildSessionEnv(config, sessionEnvInput(descriptor))) env[name] = value
  const { key, value } = prependPath(env, [...(config.paths.pathPrepend || []), ...(config.paths.nodeBinDirs || [])], platform)
  if (value) env[key] = value

  return { command: agent, args, env, cwd: descriptor.worktree, stdio: 'inherit', marker, stripped: [...STRIPPED_ENV] }
}

/**
 * The status the hook wrote, or null when the file is absent, empty, half-written or unrecognised.
 *
 * null means "keep whatever is painted". The hook writes this file while the shim reads it, so a
 * torn read is normal; repainting on one flips a working session to another colour, and the colour
 * is what an operator triages a screen of windows by.
 */
export function parseSessionState(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s)
      const v = String(j.status ?? j.state ?? '')
      return STATUS.includes(v) ? v : null
    } catch {
      return null
    }
  }
  const first = s.split(/\r?\n/)[0].trim().toLowerCase()
  return STATUS.includes(first) ? first : null
}

/**
 * Repaint only on a CHANGE.
 *
 * The title hook and the tmux status bar repaint on state changes only; repainting every tick would
 * fight anything else that stamps a window (pixel placement does, to find it again) and would cost a
 * subprocess per session per tick across the whole fleet.
 * @returns {{paint: boolean, status: string|null}}
 */
export function nextPaint(painted, text) {
  const status = parseSessionState(text)
  if (status === null || status === painted) return { paint: false, status: painted }
  return { paint: true, status }
}

/** The lock entries held under any of `owners`. PURE — takes what `scanLocks` read. */
export function ownedLockDirs(entries, owners) {
  const names = new Set((Array.isArray(owners) ? owners : [owners]).map(String))
  return entries.filter(e => e.holder && names.has(e.holder.owner))
}

/**
 * The exit record: the session's last word, and the only one that survives its window closing. A
 * launcher whose own log redirect failed still ran, headless, leaving nothing to read afterwards.
 * Shaped like the flags in contract §5.
 */
export function exitRecord(descriptor, { code = null, signal = null, at, agentPid = null, releasedLocks = [], error = null }) {
  if (!at) throw new Error('exitRecord: a timestamp is required')
  return {
    v: 1,
    session: String(descriptor.label),
    role: descriptor.role,
    issue: descriptor.issue || null,
    agentPid: agentPid ?? null,
    code: code ?? null,
    signal: signal || null,
    error: error || null,
    releasedLocks,
    at,
  }
}

// ---- thin I/O -----------------------------------------------------------------------------------

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
    throw e
  }
}

/** Read the descriptor and remember the path it came from — that path IS `$FLEET_SESSION_FILE`. */
export function readDescriptor(file) {
  const abs = path.resolve(file)
  const d = JSON.parse(fs.readFileSync(abs, 'utf8'))
  // Unconditionally: `patchDescriptor` persists `file` on the first run, so honouring a stored value
  // would make a path from a previous machine, profile or repoKey outlive the one we were actually
  // invoked with — and that path IS `$FLEET_SESSION_FILE`.
  d.file = abs
  return assertDescriptor(d)
}

/** The config the launcher resolved for this repo and machine (contract §4: `resolved.json`). */
export function readResolvedConfig(stateDir) {
  const f = path.join(stateDir, 'resolved.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!j || !j.config) throw new Error(`shim: ${f} carries no "config"; the launcher writes it on every "fleet up"`)
  return j.config
}

/**
 * Merge into the registry entry and replace it atomically (write a sibling, rename over).
 *
 * The launcher, the watchers and `fleet status` read this file continuously; a torn read is a
 * session that vanishes from the registry, and a session that vanishes has its worktree reclaimed
 * under a live agent. `base` (the in-memory descriptor) means a file that is momentarily unreadable
 * costs a merge, never a field.
 */
export function patchDescriptor(file, patch, { base = null } = {}) {
  let cur = base ? { ...base } : {}
  try {
    cur = { ...cur, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    // absent or mid-write: the in-memory descriptor is the base
  }
  const next = { ...cur, ...patch }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}

/** Every `<locksDir>/<pool>/<slot>/` with its holder. A `.steal` directory is a mutex, not a slot. */
export function scanLocks(locksDir) {
  const out = []
  for (const pool of readdirSafe(locksDir)) {
    for (const slot of readdirSafe(path.join(locksDir, pool))) {
      if (slot.endsWith('.steal')) continue
      const dir = path.join(locksDir, pool, slot)
      out.push({ pool, slot, dir, holder: readHolder(dir) })
    }
  }
  return out
}

/**
 * Refresh every lock this session holds.
 *
 * ⛔ Staleness is timestamp-only, so a lock nobody refreshes is stolen on schedule while its owner is
 * still working — a testing slot taken mid-capture, two sessions on one dev server. This heartbeat is
 * what makes a short stale window safe.
 */
export function heartbeatOwnLocks(locksDir, owners, nowMs) {
  const done = []
  for (const e of ownedLockDirs(scanLocks(locksDir), owners)) {
    // `e.holder.owner`, not our preferred spelling: the holder was written by whoever acquired it,
    // and heartbeat()/release() compare the owner string exactly.
    if (heartbeat(e.dir, e.holder.owner, nowMs)) done.push({ pool: e.pool, slot: e.slot })
  }
  return done
}

/** Give back every lock this session holds. `release()` refuses anything owned by anyone else. */
export function releaseOwnLocks(locksDir, owners) {
  const done = []
  for (const e of ownedLockDirs(scanLocks(locksDir), owners)) {
    if (release(e.dir, e.holder.owner)) done.push({ pool: e.pool, slot: e.slot })
  }
  return done
}

/** The hook-written state file; absent is normal until the agent's first turn ends. */
export function readSessionState(stateFile) {
  try {
    return fs.readFileSync(stateFile, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return ''
    throw e
  }
}

/**
 * ⛔ SIGINT must not kill the shim.
 *
 * Ctrl-C in a session window is delivered to the whole foreground process group, so a keystroke
 * meant for the agent hits the shim too. A shim that dies there leaves the exit record unwritten and
 * the session's testing slot held until it ages out. Node terminates on SIGINT only while NO listener
 * is attached, so attaching one IS the guard.
 */
export function installSignalGuards(emitter = process, log = () => {}) {
  const onInt = () => log('shim: SIGINT ignored — the agent owns Ctrl-C, and the shim must outlive it to write the exit record')
  emitter.on('SIGINT', onInt)
  return { dispose: () => emitter.removeListener('SIGINT', onInt) }
}

/**
 * Default child launcher — the agent, in the FOREGROUND, with the environment `buildChildSpec` built
 * and nothing else. Explicit argv, never a shell, exactly as src/sys/exec.mjs insists; it is not
 * `spawnDetached` for three reasons, each of which broke a guarantee this module exists to keep:
 *
 *   ⛔ `unref()` — a detached, unref'd child holds nothing in the event loop, and with `stdio:
 *      'inherit'` there are no pipes either, so the shim REACHED `await child.wait()` and then
 *      exited: no heartbeats (slot stolen mid-work), no exit record, no lock release.
 *   ⛔ `detached: true` — setsid() takes the agent out of the terminal's session, so a Ctrl-C typed
 *      in the window never reaches it, and it leads its own group, so the `pgid` the descriptor
 *      records (the shim's) covers only the shim and `killTree`'s `kill(-pgid)` pass misses the
 *      agent. In the foreground the agent shares both, which is what the descriptor claims.
 *   ⛔ `{ ...process.env, ...env }` — a merge hands back exactly the two variables that must NOT
 *      reach the agent, because a key is stripped by ABSENCE. `spec.env` is already the complete
 *      environment (a copy of the shim's, minus the stripped names, plus this session's), so it
 *      replaces rather than extends.
 */
export function defaultSpawn(spec) {
  const child = spawnChild(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio,
    detached: false,
    shell: false,
  })
  return {
    pid: child.pid,
    wait: () => new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }),
  }
}

// ---- the shim -----------------------------------------------------------------------------------

/**
 * Run one session: register, spawn the agent, keep its locks and its indicator alive, then record the
 * exit and release the locks. Every side effect is injected, so this runs without an agent.
 *
 * @param {object} descriptor
 * @param {object} deps  {config, spawn, now, setTimer, clearTimer, intervalMs, baseEnv, platform,
 *                        selfPid, selfPgid, chdir, setStatus, signals, log}
 * @returns {Promise<{spec, exit, released, heartbeats, painted}>}
 */
export async function runShim(descriptor, {
  config,
  spawn = defaultSpawn,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = t => clearInterval(t),
  intervalMs = heartbeatMsFor(config),
  baseEnv = process.env,
  platform = process.platform,
  selfPid = process.pid,
  // On POSIX the backend starts the shim detached, so the shim leads the group its agent joins (the
  // agent is spawned in the foreground — see defaultSpawn); on Windows there are no process groups
  // and teardown walks the tree down from `shimPid` instead.
  selfPgid = platform === 'win32' ? null : process.pid,
  chdir = d => process.chdir(d),
  setStatus = null,
  signals = process,
  log = () => {},
} = {}) {
  assertDescriptor(descriptor)
  if (!config) throw new Error('shim: the resolved config is required')

  const spec = buildChildSpec(descriptor, config, { baseEnv, platform })
  // The agent's environment is `spec.env` and is complete; this is the SHIM's own, which anything
  // else started from this window inherits. A shim that still claimed to be a child session would
  // hand the silence on.
  for (const name of STRIPPED_ENV) delete baseEnv[name]

  const locksDir = path.join(descriptor.paths.stateDir, 'locks')
  const owners = lockOwnersOf(descriptor)
  const guards = installSignalGuards(signals, log)

  const heartbeats = []
  let painted = null
  let child = { pid: null }
  let result = { code: null, signal: null }
  let error = null
  let timer = null

  try {
    // ⛔ Inside the try, both of them. A worktree the reclaimer removed (ENOENT from chdir) or a
    // rename that loses the Windows race with another reader of the descriptor throws here on a
    // strictly more likely path than the spawn — and outside, it took the exit record, the lock
    // release and the signal guard's disposal with it, losing one pool slot per crashed session.
    chdir(spec.cwd)
    patchDescriptor(descriptor.file, {
      shimPid: selfPid,
      pgid: selfPgid,
      agent: spec.command,
      model: spec.args[1],
      startedAt: new Date(now()).toISOString(),
    }, { base: descriptor })

    child = spawn(spec)
    patchDescriptor(descriptor.file, { agentPid: child.pid ?? null }, { base: descriptor })

    // NOT unref'd. An unref'd timer next to an unref'd child is what let the shim drop out of its
    // own event loop while the agent worked; `finally` clears it on every path, so unref buys nothing
    // and costs the heartbeat.
    timer = setTimer(() => {
      try {
        heartbeats.push(...heartbeatOwnLocks(locksDir, owners, now()))
      } catch (e) {
        log(`shim: lock heartbeat failed: ${e.message}`)
      }
      try {
        const p = nextPaint(painted, readSessionState(descriptor.stateFile))
        // ⛔ `painted` advances only once setStatus has actually returned. setStatus is a backend
        // subprocess; recording the new status before it throws latches the window on a stale colour
        // for the rest of the session, because nextPaint repaints on a CHANGE only.
        if (p.paint && setStatus) setStatus(p.status, descriptor)
        painted = p.status
      } catch (e) {
        log(`shim: status repaint failed: ${e.message}`)
      }
    }, intervalMs)

    result = await child.wait()
  } catch (e) {
    // An agent that never started must still give its slot back, or the pool loses one slot per crash.
    error = e && e.message ? e.message : String(e)
  } finally {
    if (timer !== null) clearTimer(timer)
    guards.dispose()
  }

  const released = releaseOwnLocks(locksDir, owners)
  const record = exitRecord(descriptor, {
    code: result.code,
    signal: result.signal,
    at: new Date(now()).toISOString(),
    agentPid: child.pid,
    releasedLocks: released,
    error,
  })
  patchDescriptor(descriptor.file, { exit: record }, { base: descriptor })
  return { spec, exit: record, released, heartbeats, painted }
}

/**
 * The launcher's argv, split: `--fleet-session=<label> <descriptor.json>`.
 *
 * ⛔ The marker comes FIRST on every real command line (backends/types.mjs: "argv, already including
 * the --fleet-session=<id> marker"), so reading argv[0] as the path opened `--fleet-session=3` and
 * the session died of ENOENT before it started. The descriptor is the first non-flag argument.
 * @returns {{label: string|null, file: string|null}}
 */
export function parseArgv(argv) {
  let label = null
  let file = null
  for (const raw of argv || []) {
    const t = String(raw)
    if (t.startsWith(SESSION_MARKER)) label = t.slice(SESSION_MARKER.length)
    else if (!t.startsWith('-') && file === null) file = t
  }
  return { label, file }
}

/**
 * `node shim.mjs --fleet-session=<label> <descriptor.json>`. Returns an exit code; it never exits the
 * process itself.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { label, file } = parseArgv(argv)
  if (!file) {
    process.stderr.write('usage: node shim.mjs --fleet-session=<label> <descriptor.json>\n')
    return 2
  }
  const descriptor = readDescriptor(file)
  // The marker is the name every other component finds this process by, and the descriptor is what
  // it then reads. Paired wrongly, `fleet kill 3` walks session 4's tree: refuse instead of running
  // under a name nothing else agrees with.
  if (label !== null && label !== String(descriptor.label)) {
    process.stderr.write(`shim: ${SESSION_MARKER}${label} does not name the session in ${file} ("${descriptor.label}")\n`)
    return 2
  }
  const config = deps.config || readResolvedConfig(descriptor.paths.stateDir)
  const r = await runShim(descriptor, { ...deps, config })
  if (r.exit.error) return 1
  return typeof r.exit.code === 'number' ? r.exit.code : 1
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().then(
    code => { process.exitCode = code },
    err => {
      process.stderr.write(`shim: ${err && err.stack ? err.stack : err}\n`)
      process.exitCode = 1
    },
  )
}
