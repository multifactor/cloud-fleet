// Stale pool locks: a holder whose timestamp is older than the pool's stale window is removed.
//
// ⛔ Staleness is decided by TIMESTAMP ONLY — never "the holder pid is gone". The pid in a holder
// file belongs to the short-lived `fleet pool acquire` shell and is dead within seconds of every
// healthy acquire; a supervisor that read "holder gone" as "stale" handed one testing slot to two
// sessions and one captured the other's merge. The session shim heartbeats the locks it holds, so a
// live holder is never stale and a crashed one ages out on the pool's schedule.
//
// A lock directory with NO readable holder is judged by the directory's own mtime, not called stale:
// mkdir wins the mutex and holder.json lands a moment later, and a reader in that window sees an
// empty directory. Removing it hands the slot to a second session (sys/lock.mjs learned this on 3 of
// 9 CI runners).

import fs from 'node:fs'
import path from 'node:path'
import { readHolder, holderTimestamp } from '../../sys/lock.mjs'

export const NAME = 'stale-locks'

/**
 * The stale window for a pool, in ms. Contract §7 names four pools (testing, emulator, e2e-port,
 * tracker-worklist:<KEY>) and defines a stale window for two; the others use the testing window,
 * which is the shorter and therefore the safer default for a lock nobody is heartbeating.
 */
export function staleMsFor(pool, config) {
  if (pool === 'emulator') return config.emulator.lockStaleMinutes * 60_000
  return config.testing.lock.staleMinutes * 60_000
}

/** The timestamp a lock is judged by: heartbeat, else acquire, else the directory's mtime. PURE. */
export function lockTimestamp(entry) {
  const h = entry.holder
  const t = h && Date.parse(h.heartbeatAt || h.acquiredAt || '')
  if (Number.isFinite(t)) return t
  return Number.isFinite(entry.dirMtimeMs) ? entry.dirMtimeMs : null
}

/**
 * @param {{locks: Array<{pool, slot, dir, holder, dirMtimeMs?}>, nowMs: number, config: object}} input
 * @returns {{ok: boolean, found: Array, repairs: Array, notes: string[]}}
 */
export function verdict({ locks = [], nowMs = Date.now(), config }) {
  const found = []
  const repairs = []
  let held = 0
  for (const e of locks) {
    const ts = lockTimestamp(e)
    if (ts === null) continue // the directory is gone or unstattable: nothing to judge, nothing to remove
    const staleMs = staleMsFor(e.pool, config)
    const ageMs = nowMs - ts
    const owner = e.holder && e.holder.owner ? String(e.holder.owner) : null
    if (ageMs <= staleMs) { held++; continue }
    const ageMinutes = Math.round(ageMs / 60_000)
    found.push({ pool: e.pool, slot: e.slot, owner, ageMinutes, staleMinutes: staleMs / 60_000 })
    repairs.push({ kind: 'remove-lock', pool: e.pool, slot: e.slot, dir: e.dir, owner, ageMinutes, staleMs })
  }
  const notes = []
  if (held) notes.push(`${held} lock(s) held within their stale window`)
  if (found.length) notes.push(`${found.length} stale lock(s): ${found.map(f => `${f.pool}/${f.slot} (${f.owner || 'no holder'}, ${f.ageMinutes} min)`).join(', ')}`)
  return { ok: found.length === 0, found, repairs, notes }
}

/**
 * Remove one lock directory — under the same `.steal` mutex sys/lock.tryAcquire uses, re-checking
 * the timestamp inside it. A stealer that just won the lock writes its holder into this directory a
 * moment after the re-read; removing it out from under that write hands the slot to nobody.
 * @returns {boolean} whether the directory was removed
 */
export function removeLockDir(dir, { nowMs = Date.now(), staleMs }) {
  const stealDir = dir + '.steal'
  try {
    fs.mkdirSync(stealDir, { recursive: false })
  } catch (e) {
    if (e.code === 'EEXIST') return false // a steal is in progress: whoever wins it owns the lock now
    throw e
  }
  try {
    const again = readHolder(dir)
    const ts = holderTimestamp(dir, again)
    if (ts === null) return false // already gone
    if (nowMs - ts <= staleMs) return false // refreshed or re-acquired since the verdict
    fs.rmSync(dir, { recursive: true, force: true })
    return !fs.existsSync(dir)
  } finally {
    fs.rmSync(stealDir, { recursive: true, force: true })
  }
}

/** `io.removeLock(dir, {nowMs, staleMs})` → boolean (default: removeLockDir). */
export function apply(repairs, io = {}) {
  const remove = io.removeLock || removeLockDir
  const repaired = []
  const failed = []
  for (const r of repairs) {
    if (r.kind !== 'remove-lock') continue
    try {
      if (remove(r.dir, { nowMs: io.nowMs, staleMs: r.staleMs })) repaired.push({ ...r })
      else failed.push({ ...r, error: 'not removed: refreshed, re-acquired or mid-steal since the verdict' })
    } catch (e) {
      failed.push({ ...r, error: e.message })
    }
  }
  return { repaired, failed }
}

/** Every lock directory under `<stateDir>/locks/<pool>/<slot>/`, with its holder and mtime. Thin I/O. */
export function readLocks(locksDir) {
  const out = []
  const list = dir => {
    try {
      return fs.readdirSync(dir)
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
      throw e
    }
  }
  for (const pool of list(locksDir)) {
    for (const slot of list(path.join(locksDir, pool))) {
      if (slot.endsWith('.steal')) continue
      const dir = path.join(locksDir, pool, slot)
      let dirMtimeMs = null
      try {
        dirMtimeMs = fs.statSync(dir).mtimeMs
      } catch { /* vanished between readdir and stat */ }
      out.push({ pool, slot, dir, holder: readHolder(dir), dirMtimeMs })
    }
  }
  return out
}
