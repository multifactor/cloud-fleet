// The in-memory terminal backend — what every CLI test runs against.
//
// Two rules shape it, and both are the opposite of "convenient":
//
//   1. It can be made HOSTILE. A fake that always succeeds is how untested error paths ship: every
//      caller looks correct until the day a spawn throws, a send half-delivers, a kill leaves the dev
//      server running, or a session dies on its own, and four branches that never once executed run
//      for the first time in the middle of a fan-out. `injectFault()` turns each of those into a test.
//   2. It is STRICT about addressing. A session is resolved by the opaque `backendRef` the registry
//      recorded at spawn, never by its label — because a backend with no query API was once
//      compensated for by searching command lines, and list, send and kill each resolved a different
//      set. Handing this backend `{id: "3"}` throws instead of guessing, and so does a well-formed
//      ref it never minted: "a session I have never heard of" is not "a session that has ended".
//
// It holds a scripted process table (`addChild`) shaped exactly like the one `sys/proc.mjs` reasons
// over, so a caller's reconciler, reclaimer and kill planner can be tested against a real tree
// without a real fleet. Nothing here touches the filesystem, a process, or a clock it was not given.

import { randomUUID } from 'node:crypto'

import { NO_CAPABILITIES, STATUS, assertSpawnSpec, degradationNotice } from './types.mjs'
import { snapshotFrom, killPlan } from '../sys/proc.mjs'

/**
 * Declared honestly. `pixelLayout`, `multiMonitor`, `freeFloatingWindows` and
 * `detachSurvivesLauncher` are exactly the four an in-memory backend must NOT claim, or the caller's
 * degradation branches are never taken by any test and ship unexecuted.
 *
 * `reliableSend: true` describes the HEALTHY fake; `injectFault({sendLimit})` simulates a
 * console-injection backend's short write, so a caller can be tested against that failure without
 * needing that platform.
 */
export const FAKE_CAPABILITIES = Object.freeze({
  ...NO_CAPABILITIES,
  authoritativeList: true,
  reliableSend: true,
  observableStatus: true,
  gridLayout: true,
  focusById: true,
})

// --- pure decisions -----------------------------------------------------------------------------

/**
 * Render an argv the way a process table shows it. A token containing whitespace is quoted, because
 * an unquoted worktree path with a space in it splits into two tokens and the exact
 * `--fleet-session=<label>` marker stops being findable by the reconciler. An EMPTY token is quoted
 * for the same reason: unquoted it disappears from the line entirely, and every positional argv
 * index after it shifts by one.
 */
export function renderCommandLine(command, args = []) {
  return [command, ...args].map(t => {
    const s = String(t)
    return /\s/.test(s) || s === '' ? `"${s}"` : s
  }).join(' ')
}

/**
 * What a write actually delivered. Modelled on the incident where a ~700-character message arrived
 * as 62 characters followed by Enter and the session acted on the fragment: the buffer takes what
 * fits and the caller must honour the returned count.
 * @returns {{delivered: string, requested: number, truncated: boolean}}
 */
export function shortWrite(text, limit = null) {
  const s = String(text ?? '')
  const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, s.length) : s.length
  return { delivered: s.slice(0, n), requested: s.length, truncated: n < s.length }
}

/**
 * Which layout a backend can honour, and what to say when it cannot. Pure, so the "announce, never
 * silently place nothing" rule is testable without a terminal.
 * @returns {{mode: string, placed: number, notice: string|null}}
 */
export function planLayout(handles, mode, caps) {
  const count = (handles || []).filter(Boolean).length
  if (mode === 'pixel-grid') {
    const notice = degradationNotice(caps, 'pixelLayout', 'pixel-grid placement')
    if (notice) return { mode, placed: 0, notice }
  } else if (mode === 'tiled-panes') {
    const notice = degradationNotice(caps, 'gridLayout', 'tiling')
    if (notice) return { mode, placed: 0, notice }
  } else if (mode !== 'windows') {
    return { mode, placed: 0, notice: `layout: unknown mode "${mode}"` }
  }
  return { mode, placed: count, notice: null }
}

/** The {name, value} env array a SpawnSpec carries, as a plain object — for assertions. */
export function envMapOf(entries) {
  return Object.fromEntries((entries || []).map(e => [e.name, e.value]))
}

// --- the backend --------------------------------------------------------------------------------

/** Private state, keyed by backend, so `injectFault` can reach it without a public back door. */
const STATES = new WeakMap()

/**
 * @param {{clock?: () => number, hostPid?: number, firstPid?: number}} opts
 *   clock is injected so a test's process table is deterministic rather than wall-clock.
 */
export function createFakeBackend({ clock = Date.now, hostPid = 1, firstPid = 1000 } = {}) {
  const st = {
    clock,
    hostPid,
    nextPid: firstPid,
    // Every session hangs off ONE host process, mirroring a terminal where the owning pid identifies
    // nothing — a caller that tries to tell sessions apart by their parent gets the same answer here.
    procs: new Map([[hostPid, { pid: hostPid, ppid: 0, name: 'terminal-host', cmd: 'terminal-host', startedAt: 0 }]]),
    sessions: new Map(),  // ref -> record (live and ended)
    current: new Map(),   // label -> ref of the LIVE session
    history: new Map(),   // label -> ref[], spawn order
    order: [],            // ref[], spawn order
    spawns: [],           // append-only log of accepted spawns
    layouts: [],
    focused: null,
    faults: { spawnThrows: null, spawnThrowsRemaining: 0, sendLimit: null, killLeaves: new Set() },
  }

  const table = () => snapshotFrom([...st.procs.values()])

  function resolve(handle) {
    if (!handle || typeof handle !== 'object' || !handle.backendRef || typeof handle.backendRef.ref !== 'string') {
      throw new TypeError('fake backend: a session is addressed by its registry handle (backendRef), never by label — searching for a session is how list, send and kill came to resolve three different sets')
    }
    const rec = st.sessions.get(handle.backendRef.ref)
    // A ref this backend never minted is NOT "a session that has ended". Answering "already gone"
    // for another backend's handle, a stale registry generation or a typo reports a successful
    // teardown of a session this backend never owned — the same guessing the strictness above forbids.
    if (!rec) {
      throw new TypeError(`fake backend: unknown backendRef "${handle.backendRef.ref}" — this backend never spawned it; a handle must be the one the registry recorded, not one built from a label`)
    }
    return rec
  }

  /** Inspection helpers take a label OR a handle; the interface methods never do. */
  function lookup(x) {
    if (x && typeof x === 'object') return resolve(x)
    const refs = st.history.get(String(x)) || []
    return refs.length ? st.sessions.get(refs[refs.length - 1]) : null
  }

  function live(rec) {
    return !!rec && rec.endedAt === null
  }

  /**
   * End a session. `orphans` keeps the descendants alive: a pane can close while the dev server it
   * started keeps holding its port, and a reclaimer that assumes the tree went with the window
   * leaves a rogue server behind.
   */
  function endSession(rec, reason, { orphans = false } = {}) {
    const plan = killPlan(table(), rec.pid)
    const removed = orphans ? [rec.pid] : plan.order
    for (const pid of removed) st.procs.delete(pid)
    rec.endedAt = st.clock()
    rec.endReason = reason
    if (st.current.get(rec.id) === rec.ref) st.current.delete(rec.id)
    // Focus dies with the session: a focus left pointing at a torn-down pane reads as "the focus is
    // still on a live session" to every caller that asks.
    if (st.focused === rec.ref) st.focused = null
    return removed
  }

  const backend = {
    // ---- the interface -------------------------------------------------------------------------

    probe() {
      return { available: true, name: 'fake', reason: null }
    },

    capabilities() {
      return FAKE_CAPABILITIES
    },

    spawn(spec) {
      assertSpawnSpec(spec)
      if (st.faults.spawnThrows && st.faults.spawnThrowsRemaining > 0) {
        st.faults.spawnThrowsRemaining -= 1
        // Thrown BEFORE anything is recorded: a failed spawn must leave no half-created session and
        // no orphan process, or the next status read invents a session nobody can address.
        throw new Error(String(st.faults.spawnThrows))
      }
      const id = String(spec.id)
      if (live(st.sessions.get(st.current.get(id)))) {
        // Two agents in one worktree collide on the git index; a relaunch kills first, never spawns beside.
        throw new Error(`spawn: session "${id}" is already running`)
      }
      const pid = st.nextPid++
      const at = st.clock()
      const cmd = renderCommandLine(spec.command, spec.args)
      st.procs.set(pid, { pid, ppid: st.hostPid, pgid: pid, name: String(spec.command), cmd, startedAt: at })

      // The ref is minted fresh and unguessable, so a handle can only come from the registry that
      // recorded it: a ref derived from the label would be addressing-by-label wearing a handle's
      // clothes. It also means a handle from a killed session can never re-bind to its relaunched
      // namesake — a relaunch reuses the label and the worktree, and a nudge sent through the old
      // handle would otherwise land in the new session. The epoch stays on the record, as data.
      const epoch = (st.history.get(id) || []).length + 1
      const ref = `fake:${randomUUID()}`
      const handle = Object.freeze({ id, role: spec.role, backendRef: Object.freeze({ ref }), shimPid: pid, pgid: pid })
      const rec = {
        id,
        ref,
        epoch,
        handle,
        pid,
        role: spec.role,
        title: spec.title ?? null,
        cwd: spec.cwd,
        command: spec.command,
        args: spec.args.slice(),
        env: spec.env.map(e => ({ name: e.name, value: e.value })),
        startedAt: at,
        endedAt: null,
        endReason: null,
        status: null,
        statusHistory: [],
        buffer: [],
        sends: [],
        focusCount: 0,
      }
      st.sessions.set(ref, rec)
      st.current.set(id, ref)
      if (!st.history.has(id)) st.history.set(id, [])
      st.history.get(id).push(ref)
      st.order.push(ref)
      st.spawns.push({
        id,
        role: rec.role,
        title: rec.title,
        cwd: rec.cwd,
        command: rec.command,
        args: rec.args.slice(),
        env: rec.env.map(e => ({ ...e })),
        at,
      })
      return handle
    },

    /** Authoritative: the live set, in spawn order, with no process snapshot needed. */
    list() {
      return st.order.map(ref => st.sessions.get(ref)).filter(live).map(rec => rec.handle)
    },

    isAlive(handle) {
      return live(resolve(handle))
    },

    /**
     * @returns {{ok, requested, delivered, truncated, reason}} — `ok` is false on a short write, so a
     * caller that reads "no exception" as delivery fails here instead of in a fan-out. A send to a
     * session that has gone is reported per target rather than thrown, because one dead label must
     * not abort the loop over the others.
     */
    send(handle, text) {
      const rec = resolve(handle)
      const requested = String(text ?? '').length
      if (!live(rec)) {
        const gone = { ok: false, requested, delivered: 0, truncated: false, reason: 'session-gone' }
        // Recorded, not dropped: `sends()` is the only evidence a caller attempted every target in a
        // fan-out, and an empty log cannot be told apart from a target it skipped entirely.
        rec.sends.push({ ...gone, at: st.clock() })
        return gone
      }
      const w = shortWrite(text, st.faults.sendLimit)
      rec.buffer.push(w.delivered)
      const result = {
        ok: !w.truncated,
        requested: w.requested,
        delivered: w.delivered.length,
        truncated: w.truncated,
        reason: w.truncated ? 'short-write' : null,
      }
      rec.sends.push({ ...result, at: st.clock() })
      return result
    },

    setStatus(handle, status) {
      if (!STATUS.includes(status)) throw new Error(`setStatus: unknown status "${status}" (${STATUS.join('|')})`)
      const rec = resolve(handle)
      if (!live(rec)) return false
      rec.status = status
      // Repeats are recorded, not collapsed: a watcher that repaints only on a CHANGE leaves a
      // stamped title in place forever, and that is only visible if the repeats are visible.
      rec.statusHistory.push({ status, at: st.clock() })
      return true
    },

    /**
     * Removes the session and takes its scripted descendants with it, deepest first.
     * Idempotent: teardown after a crash kills sessions that are already gone, and must not throw.
     * The process table is re-queried afterwards and anything the plan meant to take that is still
     * there comes back in `survivors` with `ok: false` — `fleet relaunch` is "kill the tree, VERIFY
     * GONE, spawn into the same worktree", and a kill that can never fail leaves that verify-gone
     * branch unexecutable. `injectFault({killLeaves})` is what makes it fail.
     * @returns {{ok: boolean, killed: number[], alreadyGone: boolean, survivors: number[]}}
     */
    kill(handle) {
      const rec = resolve(handle)
      if (!live(rec)) return { ok: true, killed: [], alreadyGone: true, survivors: [] }
      const planned = killPlan(table(), rec.pid).order
      const leaves = st.faults.killLeaves.delete(rec.ref)
      const killed = endSession(rec, 'killed', { orphans: leaves })
      const survivors = planned.filter(pid => st.procs.has(pid))
      return { ok: survivors.length === 0, killed, alreadyGone: false, survivors }
    },

    focus(handle) {
      const rec = resolve(handle)
      if (!live(rec)) return false
      rec.focusCount += 1
      st.focused = rec.ref
      return true
    },

    /**
     * @param {Array} handles the live set, recomputed by the caller
     * @param {'windows'|'tiled-panes'|'pixel-grid'} mode  terminal.layout
     * Every call is recorded, because "arrange once at launch" leaves each refilled wave stacked on
     * top of the fleet it joined — a caller must retile after every wave, and that is what gets asserted.
     * A handle whose session has ended is NOT placed: counting it would make a caller that retiles
     * with a stale list indistinguishable from one that recomputed the live set, which is exactly the
     * caller bug this fake exists to catch. The stale ones are named in the notice.
     */
    layout(handles, mode = 'windows') {
      const given = (handles || []).filter(Boolean)
      const alive = []
      const stale = []
      for (const h of given) {
        const rec = resolve(h)
        if (live(rec)) alive.push(h)
        else stale.push(rec.id)
      }
      const plan = planLayout(alive, mode, FAKE_CAPABILITIES)
      const staleNotice = stale.length ? `layout: ${stale.length} of ${given.length} handles are no longer live (${stale.join(', ')})` : null
      const result = {
        ...plan,
        stale,
        notice: [plan.notice, staleNotice].filter(Boolean).join('; ') || null,
        requested: (handles || []).length,
      }
      st.layouts.push({ ...result, stale: stale.slice(), at: st.clock() })
      return result
    },

    // ---- inspection: not part of the interface, for tests ---------------------------------------

    /** Every accepted spawn, in order: {id, role, title, cwd, command, args, env, at}. */
    spawned() {
      return st.spawns.map(s => ({ ...s, args: s.args.slice(), env: s.env.map(e => ({ ...e })) }))
    },

    /**
     * The session record for a label (latest spawn) or a handle — ended sessions included. A COPY,
     * like every inspector here: handing out the live record lets a test that pokes at it end a
     * session or rewrite an argv the reconciler reads.
     */
    record(x) {
      const rec = lookup(x)
      if (!rec) return null
      return {
        ...rec,
        args: rec.args.slice(),
        env: rec.env.map(e => ({ ...e })),
        statusHistory: rec.statusHistory.map(s => ({ ...s })),
        buffer: rec.buffer.slice(),
        sends: rec.sends.map(s => ({ ...s })),
      }
    },

    /** What actually landed in the session's input buffer, fragment by fragment. */
    buffer(x) {
      return (lookup(x)?.buffer || []).slice()
    },

    /**
     * Per-send results, for asserting a caller honoured a short count — every ATTEMPT, including the
     * ones that found the session gone, so "attempted" is distinguishable from "never tried".
     */
    sends(x) {
      return (lookup(x)?.sends || []).map(s => ({ ...s }))
    },

    statusOf(x) {
      return lookup(x)?.status ?? null
    },

    statusHistory(x) {
      return (lookup(x)?.statusHistory || []).map(s => ({ ...s }))
    },

    layouts() {
      return st.layouts.map(l => ({ ...l, stale: l.stale.slice() }))
    },

    focusedId() {
      return st.focused ? st.sessions.get(st.focused).id : null
    },

    /** The process table as `sys/proc.mjs` wants it: Map<pid, ProcInfo>. */
    processes() {
      return table()
    },

    /**
     * Script a child process under a session (or any pid): the agent under the shim, a dev server
     * under the agent. Without one, `kill()` has no tree to prove it walks.
     */
    addChild(parent, { name = 'node', cmd = 'node child.mjs' } = {}) {
      const parentPid = typeof parent === 'object' && parent !== null ? (lookup(parent)?.pid ?? parent.shimPid) : Number(parent)
      if (!st.procs.has(parentPid)) throw new Error(`addChild: no such process ${parentPid}`)
      const pid = st.nextPid++
      st.procs.set(pid, { pid, ppid: parentPid, pgid: st.procs.get(parentPid).pgid, name, cmd, startedAt: st.clock() })
      return pid
    },
  }

  st.endSession = endSession
  st.lookup = lookup
  st.live = live
  STATES.set(backend, st)
  return backend
}

/**
 * Make the backend hostile. Every field is optional and they compose:
 *   {spawnThrows: string|true, times?: n}  the next `times` spawns throw (default: every spawn;
 *                                          false or null disarms it)
 *   {sendLimit: n}                         every send delivers at most n characters, and says so
 *   {dies: label|handle, orphans?: bool}   that session dies on its own, now
 *   {killLeaves: label|handle}             that session's next kill leaves its descendants running
 *   {clear: true}                          drop the spawn/send/kill faults (a session that died stays dead)
 *
 * Every value is validated, for the same reason a typo'd `dies` label throws: a fault that silently
 * degrades to "no fault" leaves a test that passes while proving nothing.
 * @returns the backend, for chaining
 */
export function injectFault(backend, fault = {}) {
  const st = STATES.get(backend)
  if (!st) throw new TypeError('injectFault: not a fake backend')
  if (fault.clear) {
    st.faults.spawnThrows = null
    st.faults.spawnThrowsRemaining = 0
    st.faults.sendLimit = null
    st.faults.killLeaves.clear()
  }
  if (fault.spawnThrows !== undefined) {
    const v = fault.spawnThrows
    if (v === false || v === null) {
      // "no throw" is a disarm, never a fault labelled "false".
      st.faults.spawnThrows = null
      st.faults.spawnThrowsRemaining = 0
    } else {
      if (v !== true && (typeof v !== 'string' || v === '')) {
        throw new TypeError(`injectFault: spawnThrows must be true, a non-empty message, or false/null to disarm — got ${JSON.stringify(v)}`)
      }
      if (fault.times !== undefined && !(Number.isInteger(fault.times) && fault.times > 0)) {
        throw new TypeError(`injectFault: times must be a positive integer — got ${JSON.stringify(fault.times)}`)
      }
      st.faults.spawnThrows = v === true ? 'the terminal host refused to spawn' : v
      st.faults.spawnThrowsRemaining = fault.times === undefined ? Infinity : fault.times
    }
  }
  if (fault.sendLimit !== undefined) {
    const n = fault.sendLimit
    if (n !== null && !(Number.isInteger(n) && n >= 0)) {
      throw new TypeError(`injectFault: sendLimit must be a non-negative integer, or null for no limit — got ${JSON.stringify(n)}`)
    }
    st.faults.sendLimit = n
  }
  if (fault.killLeaves !== undefined) {
    const rec = st.lookup(fault.killLeaves)
    if (!st.live(rec)) throw new Error(`injectFault: no live session "${fault.killLeaves && fault.killLeaves.id ? fault.killLeaves.id : fault.killLeaves}"`)
    st.faults.killLeaves.add(rec.ref)
  }
  if (fault.dies !== undefined) {
    const rec = st.lookup(fault.dies)
    // A typo'd label that silently injects nothing is a test that proves nothing.
    if (!st.live(rec)) throw new Error(`injectFault: no live session "${fault.dies && fault.dies.id ? fault.dies.id : fault.dies}"`)
    st.endSession(rec, fault.reason ? String(fault.reason) : 'died', { orphans: !!fault.orphans })
  }
  return backend
}
