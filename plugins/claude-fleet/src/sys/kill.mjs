// Tree kill that honours the safety rule in proc.mjs. Deepest-first, protected set excluded,
// re-snapshot afterwards and REPORT survivors — never trust the exit code of the kill itself.
//
// POSIX: when the root was spawned detached (its own process group), the whole group is signalled
// first (SIGTERM, grace, SIGKILL), then the descendants pass catches anything that called setsid.
// Windows: process.kill(pid) per pid, deepest first; `taskkill /T` is a survivors-only last resort
// and is invoked ONE PID PER CALL (a collection silently fails while printing "killed").

import { spawnSync } from 'node:child_process'
import { killPlan, descendants } from './proc.mjs'

function tryKill(pid, signal) {
  try {
    process.kill(pid, signal)
    return true
  } catch (e) {
    return e.code === 'ESRCH' ? true : false
  }
}

function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* busy wait; only used for short grace periods */ }
}

/**
 * @param {Map} snap        a fresh snapshot
 * @param {number} root     the pid to kill (with its tree)
 * @param {object} opts     {selfPid, protect: number[], graceMs, pgid, resnapshot: () => Map, platform, dryRun}
 * @returns {{planned: number[], killed: number[], survivors: number[], skippedProtected: number[]}}
 */
export function killTree(snap, root, opts = {}) {
  const { selfPid = process.pid, protect = [], graceMs = 2000, pgid = null, resnapshot = null, platform = process.platform, dryRun = false } = opts
  const plan = killPlan(snap, root, { selfPid, protect, includeRoot: true })
  if (dryRun) return { planned: plan.order, killed: [], survivors: [], skippedProtected: plan.skippedProtected }

  const killed = []
  if (platform !== 'win32' && pgid && pgid > 1 && !plan.skippedProtected.length) {
    // whole process group first
    tryKill(-pgid, 'SIGTERM')
    sleep(Math.min(graceMs, 5000))
    tryKill(-pgid, 'SIGKILL')
  }
  for (const pid of plan.order) {
    if (platform !== 'win32') tryKill(pid, 'SIGTERM')
  }
  if (platform !== 'win32' && plan.order.length) sleep(Math.min(graceMs, 5000))
  for (const pid of plan.order) {
    if (tryKill(pid, 'SIGKILL')) killed.push(pid)
  }

  // ⛔ A ZOMBIE IS NOT A SURVIVOR. On POSIX a killed process stays in the table as an exit status
  // nobody has collected yet: it runs no code, holds no port and no lock, and cannot be killed again
  // — `kill` on it succeeds and changes nothing. Under load the parent can take a moment to reap, and
  // tmux with `remain-on-exit on` deliberately keeps a dead pane around, so this is the common case
  // rather than the exotic one. Counting it as a survivor makes `fleet kill` report failure for a
  // session that is genuinely gone, and `fleet down` then refuses to remove a worktree nothing is
  // using — a fleet that cannot be torn down because everything worked. Presence is not liveness; the
  // snapshot carries the state so this can tell them apart (sys/proc-posix).
  const gone = (after, pid) => {
    const p = after.get(pid)
    return !p || p.zombie === true
  }

  let survivors = []
  if (resnapshot) {
    const after = resnapshot()
    const still = new Set([...descendants(after, root), root].filter(p => !gone(after, p)))
    survivors = plan.order.filter(p => still.has(p))
    if (survivors.length && platform === 'win32') {
      for (const pid of survivors) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, encoding: 'utf8' })
      const after2 = resnapshot()
      const still2 = new Set([...descendants(after2, root), root].filter(p => !gone(after2, p)))
      survivors = survivors.filter(p => still2.has(p))
    }
  }
  return { planned: plan.order, killed, survivors, skippedProtected: plan.skippedProtected }
}
