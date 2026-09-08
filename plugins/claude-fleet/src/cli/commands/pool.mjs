// `fleet pool acquire|release|status` (contract §7) — the four named pools a session borrows a
// shared machine resource from: `testing` (a dev-server slot), `emulator`, `e2e-port`, and the
// 1-slot `tracker-worklist:<KEY>` a read-modify-write of an issue body serialises on.
//
// Everything here goes through sys/lock.ResourcePool, and the rules below are each an incident:
//
//   ⛔ The owner is the SESSION LABEL (`FLEET_LABEL`), never the pid of the shell that ran
//      `acquire`. That process is dead within seconds of every healthy acquire, staleness is decided
//      by timestamp only, and the shim heartbeats the locks its label owns — an owner spelled any
//      other way is heartbeated by nobody and stolen on schedule while its session is mid-capture.
//   ⛔ `--once` (and the bounded default wait) exists because a patient retry loop is a queue, and a
//      queue on three slots is how a fleet stops working while looking busy. There is no unbounded
//      wait here at all.
//   ⛔ `--slot` demands EXACTLY that slot: a testing session merges its branch into its own slot's
//      worktree, so accepting whatever is free would merge under another session's slot. It never
//      falls back — ResourcePool's `prefer` does, which is why the exact path calls tryAcquire.
//   ⛔ A pool name is not a directory name. `tracker-worklist:ABC-1234` carries a colon, which
//      `mkdir` refuses on Windows (EINVAL) — a lock that cannot be created is a lock nobody holds,
//      and two sessions then rewrite one issue body over each other.

import path from 'node:path'

import { ResourcePool, tryAcquire, isStale, readHolder } from '../../sys/lock.mjs'
import { staleMsFor, readLocks } from '../../supervisor/checks/stale-locks.mjs'
import { buildSlots, renderTemplate } from '../../config/derive.mjs'
import { listSessions } from '../../core/fleet.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, intFlag, stringFlag } from '../args.mjs'

export const name = 'pool'
export const usage = 'fleet pool acquire <pool> [--slot <name>] [--wait <s> | --once] | release <pool> <slot> | status'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['acquire', 'release', 'status']

/** The pools contract §7 declares. `tracker-worklist:<KEY>` is matched by shape, below. */
export const POOLS = Object.freeze(['testing', 'emulator', 'e2e-port'])

/** The prefix of the implicit per-issue pool: one slot, created on first use. */
export const WORKLIST_PREFIX = 'tracker-worklist:'

/**
 * How long a default `acquire` keeps trying, in seconds, and how often it re-tries.
 *
 * Bounded on purpose: the alternative to `--once` is a SHORT wait, never an open-ended one. A
 * session that comes back empty-handed is told to carry on with the work that needs no slot and
 * retry later, which is what keeps twenty sessions from queueing on three dev servers.
 */
export const DEFAULT_WAIT_SEC = 30
export const POLL_MS = 2_000

/** Block this thread for `ms` without spinning the CPU (Atomics.wait is allowed on the main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * PURE. Refuse a pool name that is not one of the contract's.
 *
 * A typo'd pool would otherwise CREATE its own lock directory and hand every caller a free slot: two
 * sessions each holding "their own" pool is indistinguishable from a working one until both drive
 * the same dev server.
 */
export function assertPoolName(pool) {
  const s = String(pool ?? '')
  if (POOLS.includes(s)) return s
  if (s.startsWith(WORKLIST_PREFIX) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.slice(WORKLIST_PREFIX.length))) return s
  throw new CliError(
    'pool.unknown',
    `unknown pool ${JSON.stringify(pool)}`,
    `the pools are ${POOLS.join(', ')} and ${WORKLIST_PREFIX}<KEY> (one slot, created on first use)`,
  )
}

/**
 * PURE. The directory a pool's locks live in, under `<stateDir>/locks/`.
 *
 * `:` becomes `~`: a colon is illegal in a Windows filename (mkdir answers EINVAL), and `~` appears
 * in no issue key, so the mapping is reversible. The pool KEEPS its contract name everywhere a human
 * or a payload reads it; only the directory is spelled differently.
 */
export function poolDirName(pool) {
  return String(pool).replace(':', '~')
}

/** PURE. The inverse of poolDirName, for reporting a pool directory this command did not create. */
export function poolNameFromDir(dir) {
  const s = String(dir)
  return s.startsWith('tracker-worklist~') ? `${WORKLIST_PREFIX}${s.slice('tracker-worklist~'.length)}` : s
}

/**
 * PURE. How many testing slots the pool really has: the config's declared count, but never fewer
 * than the highest slot a registered testing session is serving.
 *
 * ⛔ `fleet up --testing 2` carries the count on that one command line and nothing persists it, so a
 * later `fleet pool acquire testing` reading `testing.count` alone would offer ONE slot while two
 * dev servers run — every session queueing on slot 1 while slot 2 sits idle. Capped at
 * `testing.maxSlots`, because branch names, ports and URLs exist for those rows and no others.
 */
export function testingSlotCount(config, sessions = []) {
  const declared = config.testing.enabled ? Math.max(0, config.testing.count) : 0
  let running = 0
  for (const s of sessions) {
    if (!s || s.role !== 'testing' || s.liveness === 'dead') continue
    const n = Number(s.slot)
    if (Number.isInteger(n) && n > running) running = n
  }
  return Math.min(config.testing.maxSlots, Math.max(declared, running))
}

/**
 * The slots of one pool, with everything a caller needs printed beside them. Reads the registry so a
 * testing slot reports the worktree its session was actually created in, rather than a re-rendered
 * template that a changed `repo.slotDirTemplate` would have made a lie.
 * @returns {{pool: string, slots: Array<object>, staleMs: number, reason: string|null}}
 */
export function poolSpec(pool, { config, sessions = [], platform = process.platform }) {
  const staleMs = staleMsFor(pool, config)
  const p = platform === 'win32' ? path.win32 : path.posix

  if (pool === 'testing') {
    const count = testingSlotCount(config, sessions)
    if (!count) {
      return { pool, slots: [], staleMs, reason: 'there is no local testing pool on this machine (testing.count is 0, or testing.enabled is false) — that is "nothing to acquire", never a testing-slot block' }
    }
    const byNumber = new Map(sessions.filter(s => s && s.role === 'testing').map(s => [Number(s.slot), s]))
    const slots = buildSlots(config).slice(0, count).map(s => {
      const session = byNumber.get(s.n) || null
      const folder = renderTemplate(config.repo.slotDirTemplate, { repo: config.repo.name || '', branch: s.branch, slot: s.n, n: s.n })
      return {
        // The slot is NAMED by its branch, the spelling sys/lock's own example uses and the one a
        // release has to type back. `--slot 2` resolves to it too (below): a testing session reads
        // its own slot out of FLEET_SLOT, which is a number.
        name: s.branch,
        n: s.n,
        branch: s.branch,
        port: s.port,
        url: s.url,
        worktree: session && session.worktree ? session.worktree : (config.repo.worktreeParent ? p.join(config.repo.worktreeParent, folder) : null),
        session: session ? String(session.label) : null,
      }
    })
    return { pool, slots, staleMs, reason: null }
  }

  if (pool === 'emulator') {
    if (!config.emulator.enabled || !config.emulator.slots.length) {
      return { pool, slots: [], staleMs, reason: 'no emulator pool is configured (emulator.enabled is false, or emulator.slots is empty)' }
    }
    // The serial is the slot's name: it is what every adb command in the capture is aimed at, and a
    // session that acquired "slot 1" and then guessed a serial drives the other session's emulator.
    const slots = config.emulator.slots.map((s, i) => ({ name: `emulator-${s.port}`, n: i + 1, avd: s.avd, port: s.port, serial: `emulator-${s.port}` }))
    return { pool, slots, staleMs, reason: null }
  }

  // e2e-port and tracker-worklist:<KEY> are one slot each — the point is mutual exclusion, so the
  // name only has to be stable enough to type back into `release`.
  return { pool, slots: [{ name: '1', n: 1 }], staleMs, reason: null }
}

/**
 * PURE. Resolve `--slot` against a pool's slots: an exact name, or — for a numbered pool — the row
 * number, because a testing session reads its own slot from `FLEET_SLOT` as an integer.
 */
export function resolveSlot(spec, wanted) {
  const s = String(wanted)
  return spec.slots.find(x => x.name === s) || (/^\d+$/.test(s) ? spec.slots.find(x => Number(x.n) === Number(s)) : undefined) || null
}

/** How long a holder has held its lock, in whole minutes — what a "busy or wedged?" question needs. */
function heldMinutes(holder, nowMs) {
  const t = holder ? Date.parse(holder.heartbeatAt || holder.acquiredAt || '') : NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60_000)) : null
}

/** The owner every caller with no `FLEET_LABEL` holds as — the launcher, and anything hand-run. */
export const LAUNCHER_OWNER = 'launcher'

/**
 * The label this lock is held BY. The launcher has no label of its own and holds as "launcher".
 *
 * ⛔ The fallback is a SHARED name on purpose, and it cannot be made unique here: `acquire` and
 * `release` are separate one-shot processes, and sys/lock.release removes a lock only for an exact
 * owner match — so an owner carrying a pid or a per-invocation id could never release what it took.
 * The cost is that two label-less callers look like one owner (the second is granted the slot
 * re-entrantly) and that nobody heartbeats such a hold, so it ages out on the pool's stale window.
 * `acquire` says both out loud rather than letting a caller discover them; a caller that needs a
 * lock of its own runs with a FLEET_LABEL, which the shim heartbeats.
 */
function ownerFor(env) {
  const label = String(env.FLEET_LABEL || '').trim()
  return label || LAUNCHER_OWNER
}

function stateDirOf(ctx) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('pool.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is nowhere to put a lock', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  return stateDir
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('pool.unknown-subcommand', `fleet pool takes one of ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  if (sub === 'status') return status(ctx)
  if (!args.positionals[1]) throw new CliError('pool.no-pool', `fleet pool ${sub} takes the pool to act on`, `the pools are ${POOLS.join(', ')} and ${WORKLIST_PREFIX}<KEY>`)
  const pool = assertPoolName(args.positionals[1])
  return sub === 'acquire' ? acquire(ctx, args, pool) : release(ctx, args, pool)
}

// ---- acquire ---------------------------------------------------------------------------------

function acquire(ctx, args, pool) {
  const stateDir = stateDirOf(ctx)
  const once = !!args.flags.once
  const waitSec = intFlag(args.flags, 'wait', null)
  if (once && waitSec !== null) {
    // Contract §7 writes them as alternatives. Honouring one silently would give a caller that asked
    // not to queue exactly the queue it refused.
    throw new CliError('pool.wait-and-once', '--wait and --once contradict each other', '--once tries once; --wait <s> retries for that many seconds')
  }
  if (waitSec !== null && waitSec < 0) throw new CliError('pool.bad-wait', `--wait expects a whole number of seconds ≥ 0, got ${waitSec}`, 'for example --wait 120')
  const waitMs = once ? 0 : (waitSec === null ? DEFAULT_WAIT_SEC : waitSec) * 1000

  const spec = poolSpec(pool, { config: ctx.config, sessions: listSessions({ stateDir }) })
  if (!spec.slots.length) {
    ctx.json(envelope(false, { pool, slots: [], error: { code: 'pool.not-configured', message: spec.reason, hint: 'this is not a blocked flag: a pool with no slots means the resource does not exist here, so route the work another way (capture.mode, or the cloud)' } }))
    ctx.log(`pool ${pool}: ${spec.reason}`)
    return 1
  }

  const wanted = stringFlag(args.flags, 'slot', null)
  let demanded = null
  if (wanted !== null) {
    demanded = resolveSlot(spec, wanted)
    if (!demanded) {
      throw new CliError(
        'pool.no-such-slot',
        `pool ${pool} has no slot ${JSON.stringify(wanted)}`,
        `its slots are ${spec.slots.map(s => s.name).join(', ')}`,
      )
    }
  }

  const owner = ownerFor(ctx.env)
  const locksDir = path.join(stateDir, 'locks')
  const rp = new ResourcePool({ locksDir, name: poolDirName(pool), slots: spec.slots.map(s => s.name), staleMs: spec.staleMs })
  const meta = { pool }
  const startedMs = ctx.now()

  for (;;) {
    const nowMs = ctx.now()
    // ⛔ The demanded slot is tried on its own, never through `prefer`: prefer falls back to the next
    // free slot, and a testing session that merged into a slot it does not own merges under another
    // session's capture.
    let got
    if (demanded) {
      const r = tryAcquire(rp.slotDir(demanded.name), { owner, nowMs, staleMs: spec.staleMs, meta })
      got = r.acquired ? { slot: demanded.name, holder: r.holder, stolen: !!r.stolen, reentrant: !!r.reentrant } : null
    } else {
      got = rp.acquire(owner, { nowMs, meta })
    }

    if (got) {
      const slot = spec.slots.find(s => s.name === got.slot) || { name: got.slot }
      // The slot's own name is already the payload's `slot`; carrying it a second time under `name`
      // gives a reader two fields to disagree about.
      const { name: _named, ...fields } = slot
      ctx.json(envelope(true, {
        pool,
        slot: got.slot,
        owner,
        acquired: true,
        stolen: got.stolen,
        reentrant: got.reentrant,
        staleMinutes: spec.staleMs / 60_000,
        waitedMs: nowMs - startedMs,
        ...fields,
        holder: got.holder,
      }))
      // The lines a session reads back: it must use the slot it was GIVEN and never assume slot 1.
      ctx.log(`slot=${got.slot}`)
      for (const field of ['branch', 'worktree', 'url', 'port', 'serial', 'avd']) {
        if (slot && slot[field] !== undefined && slot[field] !== null) ctx.log(`${field}=${slot[field]}`)
      }
      if (got.stolen) ctx.log(`note: this slot was stolen from a holder that had not been heartbeated for over ${spec.staleMs / 60_000} minutes`)
      if (got.reentrant) ctx.log('note: you already held this slot; the lock was refreshed rather than taken twice')
      if (owner === LAUNCHER_OWNER) {
        ctx.log(`note: this lock is owned by "${LAUNCHER_OWNER}" — the name every caller with no FLEET_LABEL holds as${got.reentrant ? ', and it was already held under that name, so another launcher-side command may believe it holds this slot too' : ''}. Nobody heartbeats it, so it ages out after ${spec.staleMs / 60_000} minutes: release it as soon as the work is done.`)
      }
      return 0
    }

    if (ctx.now() - startedMs >= waitMs) break
    sleepSync(POLL_MS)
  }

  const nowMs = ctx.now()
  const held = rp.status(nowMs).map(s => ({ slot: s.name, owner: s.holder ? s.holder.owner : null, heldMinutes: heldMinutes(s.holder, nowMs), stale: s.stale }))
  ctx.json(envelope(false, {
    pool,
    acquired: false,
    slots: held,
    waitedMs: nowMs - startedMs,
    error: {
      code: 'pool.busy',
      message: demanded
        ? `slot ${demanded.name} of pool ${pool} is held by ${held.find(h => h.slot === demanded.name)?.owner ?? 'another session'}`
        : `every slot of pool ${pool} is held (${held.map(h => `${h.slot}: ${h.owner || 'unknown'}`).join(', ')})`,
      hint: 'carry on with the work that needs no slot and retry later — a tight retry loop is a queue, and a queue on three slots stalls the whole fleet',
    },
  }))
  for (const h of held) ctx.log(`slot=${h.slot} held-by=${h.owner || 'unknown'}${h.heldMinutes === null ? '' : ` for=${h.heldMinutes}min`}`)
  return 1
}

// ---- release ---------------------------------------------------------------------------------

function release(ctx, args, pool) {
  const stateDir = stateDirOf(ctx)
  const wanted = args.positionals[2]
  if (!wanted) throw new CliError('pool.release-needs-slot', 'fleet pool release takes the pool and the slot it handed you', 'fleet pool release testing testing-2 — the slot name is the one `acquire` printed')

  const spec = poolSpec(pool, { config: ctx.config, sessions: listSessions({ stateDir }) })
  const slot = resolveSlot(spec, wanted)
  // ⛔ A slot this pool does not have is refused HERE too, exactly as `acquire` refuses it. Probing
  // `<locks>/<pool>/<typo>` instead finds no holder, and the already-free branch below would answer
  // ok:true, alreadyFree:true, exit 0 — while the real lock stays held for the whole stale window and
  // every other session queues on it. The raw token is used only when the pool declares no slots at
  // all (a `testing` pool that is switched off), which is the case that fallback was written for.
  if (!slot && spec.slots.length) {
    throw new CliError(
      'pool.no-such-slot',
      `pool ${pool} has no slot ${JSON.stringify(wanted)}`,
      `its slots are ${spec.slots.map(s => s.name).join(', ')} — release the slot name (or number) that \`acquire\` printed`,
    )
  }
  const slotName = slot ? slot.name : String(wanted)
  const owner = ownerFor(ctx.env)
  const locksDir = path.join(stateDir, 'locks')

  // release() refuses anything owned by anyone else, so this is never a way to take a slot from a
  // session that is still using it — the loud failure is the point.
  const rp = new ResourcePool({ locksDir, name: poolDirName(pool), slots: spec.slots.length ? spec.slots.map(s => s.name) : [slotName], staleMs: spec.staleMs })
  const before = rp.status(ctx.now()).find(s => s.name === slotName) || null
  const released = rp.release(owner, slotName)
  if (released) {
    ctx.json(envelope(true, { pool, slot: slotName, owner, released: true }))
    ctx.log(`released ${pool} slot=${slotName}`)
    return 0
  }
  const holder = before && before.holder ? before.holder.owner : null
  if (!holder) {
    // Already free is the state the caller asked for: a release that ran twice — a retry, or the
    // shim giving back a lock the session had already released — must not read as a failure.
    ctx.json(envelope(true, { pool, slot: slotName, owner, released: false, alreadyFree: true, holder: null }))
    ctx.log(`${pool} slot=${slotName} was already free`)
    return 0
  }
  ctx.json(envelope(false, {
    pool,
    slot: slotName,
    owner,
    released: false,
    holder,
    error: {
      code: 'pool.not-yours',
      message: `${pool} slot ${slotName} is held by ${holder}, not by ${owner}`,
      hint: 'a session releases only the slot it acquired — sys/lock never removes another owner\'s lock, and a lock whose holder is verifiably gone ages out on the pool\'s stale window instead',
    },
  }))
  ctx.log(`${pool} slot=${slotName} is held by ${holder}`)
  return 1
}

// ---- status ----------------------------------------------------------------------------------

function status(ctx) {
  const stateDir = stateDirOf(ctx)
  const sessions = listSessions({ stateDir })
  const nowMs = ctx.now()
  const locksDir = path.join(stateDir, 'locks')

  // Every declared pool, plus any pool directory already on disk — a `tracker-worklist:<KEY>` pool
  // is created on first use, so the only way to report one is to look.
  const onDisk = new Set(readLocks(locksDir).map(l => poolNameFromDir(l.pool)))
  const names = [...new Set([...POOLS, ...onDisk])]

  const pools = []
  for (const pool of names) {
    let spec
    try {
      spec = poolSpec(assertPoolName(pool), { config: ctx.config, sessions })
    } catch {
      // A directory nobody can map back to a contract pool is REPORTED, not hidden: it is a lock
      // some caller is honouring, and a status that omits it explains nothing about why they wait.
      pools.push({ pool, unknown: true, slots: [], reason: 'not a pool this build declares; its lock directory is on disk' })
      continue
    }
    const slots = spec.slots.map(s => {
      // Through sys/lock, like every other lock read: null is "free, or the holder file has not
      // landed yet" — mkdir wins the mutex and holder.json is written a moment later.
      const holder = readHolder(path.join(locksDir, poolDirName(pool), s.name))
      return {
        ...s,
        slot: s.name,
        held: !!holder,
        owner: holder ? holder.owner : null,
        heldMinutes: heldMinutes(holder, nowMs),
        stale: holder ? isStale(holder, nowMs, spec.staleMs) : false,
      }
    })
    pools.push({ pool, slots, staleMinutes: spec.staleMs / 60_000, reason: spec.reason })
  }

  ctx.json(envelope(true, { pools, locksDir }))
  for (const p of pools) {
    if (!p.slots.length) {
      ctx.log(`${p.pool}: ${p.reason || 'no slots'}`)
      continue
    }
    for (const s of p.slots) {
      ctx.log(`${p.pool} slot=${s.slot} ${s.held ? `held-by=${s.owner}${s.heldMinutes === null ? '' : ` for=${s.heldMinutes}min`}${s.stale ? ' STALE' : ''}` : 'free'}${s.url ? ` url=${s.url}` : ''}`)
    }
  }
  return 0
}
