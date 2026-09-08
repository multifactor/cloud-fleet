// Sessions: per registry entry, is the process alive, how long since it wrote a transcript line, and
// is it STALLED — idle past the threshold while its hook-written state still says `working`?
//
// A session whose turn died on an API error sits behind a green "ready" tab forever: it is not
// crashed, not blocked and not finished, so it never writes a flag, and a message injected into the
// dead turn is consumed and lost. The only token-free signal is the TRANSCRIPT — the newest file's
// mtime advancing is proof of life whatever the tail says. This check reads that mtime and the state
// file and reports; the nudge itself belongs to src/watchers/stalls.mjs, which parses the last
// assistant entry to tell a transient error from a usage limit (opposite responses).
//
// Liveness comes from the injected backend's `isAlive(handle)` against the descriptor's own
// `backendRef` — never a command-line search, and never the recorded pid alone (pids are recycled).
// A backend that refuses a handle it never minted answers `null`, not `false`: "I do not know this
// session" is not "this session has ended".

import fs from 'node:fs'
import path from 'node:path'

import { parseSessionState } from '../../session/shim.mjs'

export const NAME = 'sessions'

/**
 * Idle minutes past which a `working` session is reported stalled. There is no config key for this
 * (contract §3 defines none); a caller passes `stallAfterMinutes` to override.
 */
export const STALL_IDLE_MINUTES = 10

/** Ask the backend, safely. `null` when it cannot answer for this descriptor. */
export function aliveOf(backend, descriptor) {
  if (!backend || typeof backend.isAlive !== 'function' || !descriptor.backendRef) return null
  try {
    const r = backend.isAlive({ id: String(descriptor.label), role: descriptor.role, backendRef: descriptor.backendRef })
    return typeof r === 'boolean' ? r : null
  } catch {
    return null
  }
}

/**
 * @param {{registry: Array, backend: object, nowMs: number, newestMtime: (d) => number|null,
 *          readState: (d) => string|null, stallAfterMinutes?: number}} input
 *   `newestMtime` answers the transcript dir's newest file mtime (ms) or null; `readState` answers the
 *   hook-written state text (parsed here with the shim's own parser so the two never drift).
 * @returns {{ok: boolean, found: Array, repairs: [], notes: string[]}}
 */
export function verdict({ registry = [], backend = null, nowMs = Date.now(), newestMtime = () => null, readState = () => null, stallAfterMinutes = STALL_IDLE_MINUTES }) {
  const found = []
  const notes = []
  for (const d of registry) {
    if (!d || d.label === undefined || d.label === null) continue
    const alive = aliveOf(backend, d)
    let mtime = null
    try {
      mtime = newestMtime(d)
    } catch { /* an unreadable transcript dir reads as "never wrote" */ }
    const idleMinutes = Number.isFinite(mtime) && mtime !== null ? Math.max(0, (nowMs - mtime) / 60_000) : null
    let state = null
    try {
      state = parseSessionState(readState(d))
    } catch { /* absent or unreadable: normal until the first turn ends */ }
    // A dead session is not stalled — it is dead, and that is the reclaimer's business.
    const stalled = alive !== false && state === 'working' && idleMinutes !== null && idleMinutes > stallAfterMinutes
    found.push({
      label: String(d.label),
      role: d.role,
      alive,
      idleMinutes: idleMinutes === null ? null : Number(idleMinutes.toFixed(1)),
      state,
      stalled,
    })
  }
  const stalled = found.filter(f => f.stalled)
  const dead = found.filter(f => f.alive === false)
  const unknown = found.filter(f => f.alive === null)
  if (stalled.length) notes.push(`${stalled.length} session(s) stalled (working, idle > ${stallAfterMinutes} min): ${stalled.map(f => `${f.label} (${f.idleMinutes} min)`).join(', ')}`)
  if (dead.length) notes.push(`${dead.length} session(s) not alive per the backend: ${dead.map(f => f.label).join(', ')}`)
  if (unknown.length) notes.push(`${unknown.length} session(s) the backend could not answer for: ${unknown.map(f => f.label).join(', ')}`)
  return { ok: stalled.length === 0, found, repairs: [], notes }
}

/** Nothing to apply: the nudge is src/watchers/stalls.mjs's, because it must first classify the error. */
export function apply() {
  return { repaired: [], failed: [] }
}

// ---- thin I/O -------------------------------------------------------------------------------------

/**
 * The newest file mtime (ms) in a transcript directory, or null when it is absent, empty or
 * unreadable. The MTIME, never the content: a tail grep for an error string once marked five healthy
 * sessions dead because the window still held an older, already-recovered error.
 */
export function newestFileMtime(dir) {
  if (!dir) return null
  let best = null
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      const st = fs.statSync(path.join(dir, e.name))
      if (best === null || st.mtimeMs > best) best = st.mtimeMs
    } catch { /* vanished between readdir and stat */ }
  }
  return best
}

/** The hook-written state file's text, or null when absent (normal until the first turn ends). */
export function readStateFile(file) {
  if (!file) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
