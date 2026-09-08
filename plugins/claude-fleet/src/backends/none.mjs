// The headless backend: `terminal.backend: none`, and what CI actually runs.
//
// spawn() starts the shim DETACHED with its stdio on `<stateDir>/logs/<label>.log` — no window, no
// pane, no console to type into. That last part is declared, not hidden: send() answers
// `shortDelivery(text, 0, 'no terminal')`, so a caller sees "nothing was delivered and here is why"
// instead of a message that silently went nowhere. Listing and killing are the same registry-first
// machinery as the Windows backends (registry-first.mjs), which is what makes this backend a real
// test of that machinery on every platform: a `node -e` agent spawned here is found by the exact
// argv marker in a real process snapshot and killed through a real tree walk.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { NO_CAPABILITIES, assertSpawnSpec, shortDelivery } from './types.mjs'
import { spawnDetached as sysSpawnDetached } from '../sys/exec.mjs'
import { stateLayout } from '../config/paths.mjs'
import { readSession, reconcilePlan } from '../core/fleet.mjs'
import {
  createSnapshotSource, mintRef, assertRef, assertStatus, assertNotRunning, spawnState, listHandles, killSpawn,
  writeStatus, planLayout,
} from './registry-first.mjs'

export const BACKEND_NAME = 'none'

/** A detached process outlives the launcher; nothing else is even possible without a terminal. */
export const NONE_CAPABILITIES = Object.freeze({ ...NO_CAPABILITIES, detachSurvivesLauncher: true })

/**
 * `<stateDir>/logs/<label>.log` in the HOST's separators: THIS process opens the file, so the `platform`
 * seam (which only decides how snapshots are read and trees are killed) has no say here — joined with
 * path.win32 on a POSIX host it would be a relative name with literal backslashes, created in the cwd.
 * The layout itself lives in config/paths.mjs (contract §4).
 */
export function logPathFor(stateDir, label) {
  return path.join(stateLayout(stateDir, process.platform).logs, `${label}.log`)
}

/** The {name, value} env entries of a SpawnSpec as the object spawnDetached merges over process.env. */
export function envObjectOf(entries) {
  return Object.fromEntries((entries || []).map(e => [e.name, e.value]))
}

/**
 * @param {object} opts  config, platform, spawnDetached (sys/exec seam), takeSnapshot, snapshotMaxAgeMs,
 *                       killTree, selfPid, now
 */
export function createNoneBackend({
  config,
  platform = process.platform,
  spawnDetached = sysSpawnDetached,
  takeSnapshot,
  snapshotMaxAgeMs,
  killTree,
  selfPid = process.pid,
  now = Date.now,
} = {}) {
  const stateDir = (config && config.paths && config.paths.stateDir) || null
  const source = createSnapshotSource({ take: takeSnapshot, platform, maxAgeMs: snapshotMaxAgeMs, now })
  const descriptorOf = label => (stateDir ? readSession(label, { stateDir }) : null)
  // Liveness with the reconciler's birth grace, so isAlive and setStatus judge a newborn exactly as
  // list() does: a registered session too young for the cached snapshot to be evidence about is
  // `pending`, and pending counts as alive — a session list() shows that isAlive() calls dead is the
  // "different sets" disagreement this machinery exists to end. spawnState has no clock; the rule is
  // reconcilePlan's, applied to this one descriptor.
  const stateOf = ref => {
    const { snap, takenMs } = source.cached()
    const descriptor = descriptorOf(ref.label)
    const st = spawnState(ref, snap, descriptor)
    const pending = !st.alive && !st.replaced && !!descriptor && reconcilePlan([descriptor], snap, { nowMs: now(), snapshotTakenMs: takenMs }).pending.length > 0
    return { ...st, descriptor, pending, alive: st.alive || pending }
  }

  return {
    name: BACKEND_NAME,

    probe() {
      return { available: true, name: BACKEND_NAME, reason: null }
    },

    capabilities() {
      return NONE_CAPABILITIES
    },

    /**
     * The log is opened BEFORE the process and closed right after: the child holds its own copy of
     * the descriptor, and a launcher that kept the fd would keep the file open for as long as it
     * lived. A spawn that yields no pid (an unknown command) throws, and the child's 'error' event
     * is listened for so that failure cannot surface later as an uncaught exception in the launcher.
     */
    spawn(spec) {
      assertSpawnSpec(spec)
      if (!stateDir) throw new Error('spawn: paths.stateDir is not resolved — a registry-first backend has nowhere to look a session up')
      const label = String(spec.id)
      descriptorOf(label)
      assertNotRunning(label, source.cached().snap)
      const log = logPathFor(stateDir, label)
      fs.mkdirSync(path.dirname(log), { recursive: true })
      const fd = fs.openSync(log, 'a')
      let started
      try {
        started = spawnDetached(spec.command, spec.args, { cwd: spec.cwd, env: envObjectOf(spec.env), stdio: ['ignore', fd, fd] })
      } finally {
        fs.closeSync(fd)
      }
      if (started.child && typeof started.child.on === 'function') started.child.on('error', () => {})
      if (!started.pid) throw new Error(`spawn: ${spec.command} did not start for session "${label}"`)
      const pgid = Number.isInteger(started.pgid) ? started.pgid : null
      const backendRef = mintRef(BACKEND_NAME, label, { pid: started.pid, pgid, log, spawnedAt: new Date(now()).toISOString() })
      const handle = { id: label, role: spec.role, backendRef, shimPid: started.pid }
      if (pgid !== null) handle.pgid = pgid
      return Object.freeze(handle)
    },

    list() {
      return listHandles({ backend: BACKEND_NAME, stateDir, source, nowMs: now() })
    },

    isAlive(handle) {
      return stateOf(assertRef(handle, BACKEND_NAME)).alive
    },

    /** A declared inability, never a silent drop: there is no console to type into. */
    send(handle, text) {
      assertRef(handle, BACKEND_NAME)
      return shortDelivery(text, 0, 'no terminal')
    },

    setStatus(handle, status) {
      assertStatus(status)
      const st = stateOf(assertRef(handle, BACKEND_NAME))
      if (!st.alive) return false
      return writeStatus(st.descriptor, status, now())
    },

    /** The process group the shim leads on POSIX is passed for the root the ref spawned, so the whole group is signalled first. */
    kill(handle) {
      const ref = assertRef(handle, BACKEND_NAME)
      const pgidFor = root => (root === ref.pid && Number.isInteger(ref.pgid) ? ref.pgid : null)
      return killSpawn(ref, { source, killTree, selfPid, platform, descriptor: descriptorOf(ref.label), pgidFor })
    },

    focus(handle) {
      assertRef(handle, BACKEND_NAME)
      return false
    },

    layout(handles, mode = 'windows') {
      const plan = planLayout(handles, mode, NONE_CAPABILITIES)
      if (plan.notice) return plan
      return { mode, placed: 0, notice: 'layout: no terminal — there are no windows to arrange (terminal.backend: none)' }
    },
  }
}
