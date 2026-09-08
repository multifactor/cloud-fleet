// Services: the container engine and the containers the config declares, probed and restarted.
//
// After a reboot the container engine does not auto-start, so the database stays down and nothing
// listens on its port — while `/` still serves 200 and an authenticated route still 401s correctly,
// so every login and provisioning call returning 500 looks like an app bug, and a session cannot see
// any of it from inside its worktree. The order is the rule: engine → containers → confirm the ports
// → only then dev servers (the slots check runs after this one for that reason).
//
// Only what the config DECLARES is probed. A project whose dev database is remote has no container,
// so "container missing" and "port refused" are expected there — a database alarm that fires on
// every tick forever is noise nobody reads. `services.docker.required: false` and an empty
// `services.containers` make this check a no-op.
//
// Repairs run user-configured command STRINGS (`services.docker.startCommand`,
// `services.containers[].startCommand`), so they go through sys/exec.shellCommand — the one
// sanctioned shell path — and nowhere else.

import net from 'node:net'
import { run, shellCommand } from '../../sys/exec.mjs'

export const NAME = 'services'

/** How long a start command may take before it is reported as failed. */
export const START_TIMEOUT_MS = 5 * 60_000

/** Default probe timeout for one TCP connect. */
export const PORT_TIMEOUT_MS = 3_000

/**
 * @param {{config: object, observed: {dockerUp: boolean|null, ports: Object<string, boolean|null>}}} input
 *   `observed.ports` is keyed by container name; `null` means "not probed" (no health port declared).
 * @returns {{ok: boolean, found: Array, repairs: Array, notes: string[]}}
 */
export function verdict({ config, observed = {} }) {
  const svc = config.services || {}
  const docker = svc.docker || {}
  const containers = Array.isArray(svc.containers) ? svc.containers : []
  const found = []
  const repairs = []
  const notes = []

  if (!docker.required && containers.length === 0) {
    return { ok: true, found, repairs, notes: ['no services declared'] }
  }

  const dockerDown = docker.required && observed.dockerUp === false
  if (dockerDown) {
    found.push({ kind: 'docker', name: 'docker', up: false })
    if (docker.startCommand) repairs.push({ kind: 'start-docker', name: 'docker', command: docker.startCommand })
    else notes.push('the container engine is down and services.docker.startCommand is unset — it cannot be started from here')
  } else if (docker.required && observed.dockerUp === null) {
    notes.push('the container engine was not probed')
  }

  for (const c of containers) {
    if (!c || !c.name) continue
    const up = observed.ports ? observed.ports[c.name] : undefined
    if (up === undefined || up === null) {
      notes.push(`${c.name}: no healthHost/healthPort declared, so it is not probed`)
      continue
    }
    if (up) continue
    found.push({ kind: 'container', name: c.name, up: false, host: c.healthHost || null, port: c.healthPort || null })
    if (dockerDown) {
      // Starting a container while the engine is down fails on every one; the engine repair above
      // runs first and the containers are re-probed next pass, when a start can actually succeed.
      notes.push(`${c.name}: deferred until the container engine is up`)
      continue
    }
    if (c.startCommand) repairs.push({ kind: 'start-container', name: c.name, command: c.startCommand })
    else notes.push(`${c.name}: down and no startCommand declared — it cannot be started from here`)
  }

  if (found.length) notes.unshift(`${found.length} service(s) down: ${found.map(f => f.name).join(', ')}`)
  return { ok: found.length === 0, found, repairs, notes }
}

/**
 * Run each repair's command string through `io.shellCommand(command, {timeoutMs})` (default: the real
 * sys/exec.shellCommand). A non-zero exit is a FAILED repair — the next pass re-probes, so a start that
 * exits 0 but did nothing is caught there rather than trusted here.
 */
export function apply(repairs, io = {}) {
  const sh = io.shellCommand || ((cmd, o) => shellCommand(cmd, o))
  const repaired = []
  const failed = []
  for (const r of repairs) {
    if (r.kind !== 'start-docker' && r.kind !== 'start-container') continue
    try {
      const res = sh(r.command, { timeoutMs: START_TIMEOUT_MS })
      if (res && res.ok) repaired.push({ ...r, code: res.code })
      else failed.push({ ...r, code: res ? res.code : null, error: res && res.timedOut ? 'timed out' : `exit ${res ? res.code : '?'}: ${String((res && (res.stderr || res.stdout)) || '').slice(0, 300)}` })
    } catch (e) {
      failed.push({ ...r, error: e.message })
    }
  }
  return { repaired, failed }
}

// ---- thin probes -----------------------------------------------------------------------------------

/** Is the container engine answering? `docker info` exits non-zero when the daemon is down. */
export function probeDocker({ timeoutMs = 15_000 } = {}) {
  try {
    return run('docker', ['info'], { timeoutMs }).ok
  } catch {
    return false // not installed at all reads as down; the repair command is the operator's to configure
  }
}

/** One TCP connect. Resolves true on connect, false on refusal, error or timeout. */
export function probePort(host, port, { timeoutMs = PORT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = v => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* already closed */ }
      resolve(v)
    }
    const sock = net.connect({ host: host || '127.0.0.1', port: Number(port) })
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

/** Probe everything the config declares. `probes` is injectable for tests. */
export async function observe(config, { probeDocker: pd = probeDocker, probePort: pp = probePort } = {}) {
  const svc = config.services || {}
  const docker = svc.docker || {}
  const containers = Array.isArray(svc.containers) ? svc.containers : []
  const dockerUp = docker.required ? !!pd() : null
  const ports = {}
  await Promise.all(containers.map(async c => {
    if (!c || !c.name) return
    ports[c.name] = c.healthPort ? await pp(c.healthHost || '127.0.0.1', c.healthPort) : null
  }))
  return { dockerUp, ports }
}
