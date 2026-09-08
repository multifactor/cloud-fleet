// Cross-process mutexes and named resource pools.
//
// Primitive: `fs.mkdirSync(dir)` — atomic on every OS and filesystem, including network shares. No
// dependency.
//
// ⛔ IT IS NOT ALWAYS `EEXIST`. Windows answers **EPERM** when the name exists but is PENDING DELETE,
// which is precisely the state a concurrent release leaves it in — `rmSync` returns once the delete
// is posted, not once the directory is gone. So a release racing an acquire threw out of the lock
// instead of reporting contention, and every lock in the fleet is built on this call: a pool acquire,
// the outbox sequence, the shim's heartbeat. Collision detection goes through `isHeldError` below,
// and nothing calls `mkdirSync` for a lock directly.
//
// ⛔ Staleness is decided by TIMESTAMP ONLY, never by "holder process gone". The pid in a holder
// file belongs to the short-lived process that ran `acquire`, dead within seconds for every holder;
// treating "holder gone" as stealable hands one slot to two sessions. Long-lived owners (the
// session shim) HEARTBEAT their locks so the stale window can be short.
//
// Pure decision logic is exported separately (isStale, chooseSlot) so it is unit-testable; the
// filesystem half is thin.

import fs from 'node:fs'
import path from 'node:path'

/** How long a Windows pending-delete window lasts, in practice: milliseconds, not seconds. */
const PENDING_DELETE_MS = 20

/** Block without spinning (Atomics.wait is allowed on Node's main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * PURE. Does this `mkdirSync` failure mean somebody else holds the name?
 *
 * `EEXIST` always does. On Windows `EPERM`/`EACCES` does too — but ONLY when the directory is
 * actually there: the same codes come back for a parent nobody may write to, and treating that as
 * contention would make `fleet pool acquire` report "every slot is held" on a broken state
 * directory, which sends an operator to look at the wrong thing entirely.
 *
 * @param {{code?: string}} e
 * @param {{exists: boolean, platform?: string}} ctx  `exists` = does the lock directory exist NOW
 */
export function isHeldError(e, { exists, platform = process.platform }) {
  if (!e) return false
  if (e.code === 'EEXIST') return true
  if (platform !== 'win32') return false
  return (e.code === 'EPERM' || e.code === 'EACCES') && exists
}

/**
 * Take the mkdir lock at `dir`, or report that someone else has it.
 * @returns {'created'|'held'}
 */
export function mkdirLock(dir, { platform = process.platform, sleep = sleepSync } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(dir, { recursive: false })
      return 'created'
    } catch (e) {
      if (e.code === 'EEXIST') return 'held'
      // One retry before judging: a pending-delete window is milliseconds, so the name is usually
      // free by the time we look again — and "created" is a better answer than "held" when it is.
      if (platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES') && attempt === 0) {
        sleep(PENDING_DELETE_MS)
        continue
      }
      if (isHeldError(e, { exists: fs.existsSync(dir), platform })) return 'held'
      throw e
    }
  }
}

/** A holder is stale when its last heartbeat (or acquire) is older than staleMs. Pure. */
export function isStale(holder, nowMs, staleMs) {
  if (!holder) return true
  const t = Date.parse(holder.heartbeatAt || holder.acquiredAt || '')
  if (!Number.isFinite(t)) return true
  return nowMs - t > staleMs
}

/** Read a holder file; null when absent or unparsable (unparsable = stale). */
export function readHolder(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'holder.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The timestamp staleness is judged against, for a lock whose holder file cannot be read.
 *
 * ⛔ An unreadable holder is NOT automatically stale. `mkdir` wins the mutex, and the holder file is
 * written a moment later; a reader that lands in that window sees an empty directory. Treating it as
 * stale hands the slot to a second session — the exact double-grant the pool exists to prevent, and
 * it reproduced on 3 of 9 CI runners. Fall back to the directory's own mtime instead: an empty lock
 * directory was still created at a knowable time, and it ages out on the same schedule.
 */
export function holderTimestamp(dir, holder) {
  const t = holder && Date.parse(holder.heartbeatAt || holder.acquiredAt || '')
  if (Number.isFinite(t)) return t
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return null // the directory is gone: genuinely free
  }
}

function writeHolder(dir, holder) {
  const tmp = path.join(dir, `holder.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(holder, null, 2))
  fs.renameSync(tmp, path.join(dir, 'holder.json'))
}

/**
 * Try to take the mkdir lock at `dir`. Returns {acquired: true, holder} or {acquired: false, holder}.
 * If the directory exists and its holder is stale, the lock is stolen (the old holder is recorded
 * as `stolenFrom`).
 */
export function tryAcquire(dir, { owner, nowMs = Date.now(), staleMs, meta = {} }) {
  const now = new Date(nowMs).toISOString()
  const holder = { owner, pid: process.pid, acquiredAt: now, heartbeatAt: now, ...meta }
  if (mkdirLock(dir) === 'created') {
    writeHolder(dir, holder)
    return { acquired: true, holder }
  }
  const cur = readHolder(dir)
  if (cur && cur.owner === owner) {
    // re-entrant: same owner refreshes its own lock
    const refreshed = { ...cur, heartbeatAt: now }
    writeHolder(dir, refreshed)
    return { acquired: true, holder: refreshed, reentrant: true }
  }

  const heldSince = holderTimestamp(dir, cur)
  if (heldSince !== null && nowMs - heldSince <= staleMs) return { acquired: false, holder: cur }

  // Stealing is not one atomic step, so serialise it behind its own mkdir mutex: without this, two
  // processes can both judge a lock stale and both "win" it.
  const stealDir = dir + '.steal'
  if (mkdirLock(stealDir) === 'held') return { acquired: false, holder: cur, stealInProgress: true }
  try {
    // re-read under the steal mutex: another stealer may have finished while we waited
    const again = readHolder(dir)
    const ts = holderTimestamp(dir, again)
    if (ts !== null && nowMs - ts <= staleMs) return { acquired: false, holder: again }
    const stolen = { ...holder, stolenFrom: again || cur || 'unparsable' }
    writeHolder(dir, stolen)
    return { acquired: true, holder: stolen, stolen: true }
  } finally {
    fs.rmSync(stealDir, { recursive: true, force: true })
  }
}

/** Refresh the heartbeat of a lock this owner holds. Returns false if the lock is no longer ours. */
export function heartbeat(dir, owner, nowMs = Date.now()) {
  const cur = readHolder(dir)
  if (!cur || cur.owner !== owner) return false
  writeHolder(dir, { ...cur, heartbeatAt: new Date(nowMs).toISOString() })
  return true
}

/** Release a lock this owner holds. Returns false if it was not ours (never removes another's lock). */
export function release(dir, owner) {
  const cur = readHolder(dir)
  if (!cur || cur.owner !== owner) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/** Choose the first free (or stale) slot from a status list. Pure. */
export function chooseSlot(slots, nowMs, staleMs) {
  for (const s of slots) {
    if (!s.holder || isStale(s.holder, nowMs, staleMs)) return s.name
  }
  return null
}

/**
 * A named pool of k slots under `<locksDir>/<pool>/<slot>/`.
 *   const p = new ResourcePool({ locksDir, name: 'testing', slots: ['testing','testing-2'], staleMs })
 *   p.acquire(owner) → {slot, holder} | null      p.release(owner, slot)      p.status()
 */
export class ResourcePool {
  constructor({ locksDir, name, slots, staleMs }) {
    if (!Array.isArray(slots) || !slots.length) throw new Error(`pool ${name}: no slots declared`)
    this.dir = path.join(locksDir, name)
    this.name = name
    this.slots = slots.map(String)
    this.staleMs = staleMs
    fs.mkdirSync(this.dir, { recursive: true })
  }

  slotDir(slot) {
    return path.join(this.dir, slot)
  }

  status(nowMs = Date.now()) {
    return this.slots.map(slot => {
      const holder = readHolder(this.slotDir(slot))
      return { name: slot, holder, stale: holder ? isStale(holder, nowMs, this.staleMs) : false }
    })
  }

  /** One pass over the slots; returns {slot, holder, stolen?} or null when every slot is held. */
  acquire(owner, { nowMs = Date.now(), meta = {}, prefer = null } = {}) {
    const order = prefer && this.slots.includes(prefer) ? [prefer, ...this.slots.filter(s => s !== prefer)] : this.slots
    for (const slot of order) {
      const r = tryAcquire(this.slotDir(slot), { owner, nowMs, staleMs: this.staleMs, meta })
      if (r.acquired) return { slot, holder: r.holder, stolen: !!r.stolen, reentrant: !!r.reentrant }
    }
    return null
  }

  heartbeat(owner, slot, nowMs = Date.now()) {
    return heartbeat(this.slotDir(slot), owner, nowMs)
  }

  release(owner, slot) {
    return release(this.slotDir(slot), owner)
  }

  /** Every slot this owner holds (after a crash, a shim can re-heartbeat or release them). */
  heldBy(owner) {
    return this.status().filter(s => s.holder && s.holder.owner === owner).map(s => s.name)
  }
}
