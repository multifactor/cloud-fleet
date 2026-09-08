// What every backend WITHOUT a query API shares.
//
// Windows Terminal, a bare PowerShell window and the headless `none` backend can start a process,
// but none of them can ask its host "which sessions are running?", "did my text arrive?" or "which
// tab is session 3?". Each of those questions is answered here from two sources and nothing else:
//
//   1. the REGISTRY — `<stateDir>/sessions/<label>.json` (core/fleet.mjs), the launcher's word on
//      which sessions exist and which SPAWN currently owns each label;
//   2. ONE process snapshot per pass (sys/snapshot.mjs), matched by the exact argv token
//      `--fleet-session=<label>` — the reconciler's proof that a registered session is alive.
//
// ⛔ Never a command-line search for anything else. The private original compensated for the missing
// query API by grepping process lines for a worktree path, and list, send and kill each resolved a
// different set: one reported a session that had died an hour earlier, another could not find a
// session whose window was open, and a kill landed on the wrong tab.
//
// Everything that decides is pure and takes its inputs (a snapshot, a descriptor, a scripted
// injector), so each trap below is a unit test; the thin I/O around it is injected by each backend.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

import { STATUS, degradationNotice, fullDelivery, shortDelivery } from './types.mjs'
import { hasSessionMarker } from '../sys/proc.mjs'
import { snapshot as sysSnapshot } from '../sys/snapshot.mjs'
import { killTree as sysKillTree } from '../sys/kill.mjs'
import { listSessions, reconcilePlan } from '../core/fleet.mjs'

/** How old a cached process snapshot may be for list/isAlive/send. A kill always takes a fresh one. */
export const SNAPSHOT_MAX_AGE_MS = 2_000

/**
 * ⛔ 100 characters per injected write. A console input buffer holds ~256 records and one typed
 * character is two of them (key down, key up), so ~128 characters fit; WriteConsoleInput writes what
 * fits, reports the count, and the Enter that follows submits the fragment. The incident: a
 * ~700-character message arrived as 62 characters and the session acted on them.
 */
export const CHUNK_CHARS = 100

/** Above this the text goes to a file and only a short pointer is injected (the `fleet send --file` shape). */
export const POINTER_THRESHOLD = 500

/** `<stateDir>/messages/<label>-<n>.md` — where a pointed-at message is written. */
export const MESSAGES_DIR = 'messages'

// --- the snapshot -------------------------------------------------------------------------------

/**
 * ⛔ An empty snapshot is a FAILED snapshot, never an empty fleet: an honest reading always contains
 * at least the process that took it, and the cheap listing degrades to nothing on a loaded box.
 * Answering "no sessions" or "not alive" from it would mark every live session dead in one pass.
 */
export function assertSnapshot(snap) {
  if (!snap || typeof snap.size !== 'number' || snap.size === 0) {
    throw new Error('process snapshot is empty: a failed reading, never an empty fleet — refusing to answer from it')
  }
  return snap
}

/**
 * A snapshot provider that remembers WHEN each reading was taken. sys/snapshot.mjs caches for
 * `maxAgeMs` and hands the same Map back, so the identity of the Map says whether this is the
 * earlier reading; the reconciler needs that time, not "now", or a session spawned after the reading
 * is judged dead against a snapshot that predates it.
 * @returns {{cached: () => {snap: Map, takenMs: number}, fresh: () => {snap: Map, takenMs: number}}}
 */
export function createSnapshotSource({ take = sysSnapshot, platform = process.platform, maxAgeMs = SNAPSHOT_MAX_AGE_MS, now = Date.now } = {}) {
  let last = null
  let lastAt = 0
  const read = age => {
    const snap = take({ platform, maxAgeMs: age })
    const t = now()
    const takenMs = snap === last ? lastAt : t
    last = snap
    lastAt = takenMs
    return { snap: assertSnapshot(snap), takenMs }
  }
  return { cached: () => read(maxAgeMs), fresh: () => read(0) }
}

// --- addressing ---------------------------------------------------------------------------------

/**
 * Mint the backend-private address of ONE spawn (contract §4: a backendRef "must identify the SPAWN,
 * not the label"). The nonce is fresh per spawn: a relaunch reuses the label and the worktree, and a
 * handle that resolved by label would aim a nudge or a kill meant for the dead session at its
 * replacement. The launcher records this ref in the descriptor; that record is what later tells a
 * stale handle apart from the current one (see spawnState).
 */
export function mintRef(backend, label, extra = {}) {
  return Object.freeze({ backend, label: String(label), spawn: `${backend}:${randomUUID()}`, ...extra })
}

/**
 * The ref list() hands out for a descriptor the launcher never stamped, or stamped under another
 * backend. `spawn: null` says "whatever currently owns this label" — the registry claims the session
 * and the snapshot proves a marked process, which is the strongest evidence a backend without a
 * query API can have. It is marked `recovered` so a caller can see it is not a minted address.
 */
export function recoveredRef(backend, descriptor) {
  const prior = descriptor && descriptor.backendRef && typeof descriptor.backendRef === 'object' ? descriptor.backendRef : null
  return Object.freeze({ backend, label: String(descriptor.label), spawn: null, recovered: true, from: prior ? prior.backend ?? null : null })
}

/**
 * Refuse anything that is not a well-formed handle for THIS backend. Membership in an in-memory set
 * cannot be the test here — the launcher that spawned a session and the `fleet kill` that ends it are
 * different processes — so the shape is: minted by this backend, naming a label, carrying a spawn
 * nonce or the explicit null of a recovered ref. A bare `{id}` or a label string still throws:
 * addressing by label is exactly the guessing this file exists to forbid.
 */
export function assertRef(handle, backend) {
  const ref = handle && typeof handle === 'object' ? handle.backendRef : null
  if (!ref || typeof ref !== 'object') {
    throw new TypeError(`${backend} backend: a session is addressed by its registry handle (backendRef), never by label — searching for a session is how list, send and kill came to resolve three different sets`)
  }
  if (ref.backend !== backend) throw new TypeError(`${backend} backend: backendRef was minted by "${ref.backend}", not by this backend`)
  if (typeof ref.label !== 'string' || !ref.label) throw new TypeError(`${backend} backend: backendRef carries no label`)
  if (ref.spawn !== null && typeof ref.spawn !== 'string') throw new TypeError(`${backend} backend: backendRef.spawn must be a spawn nonce or null`)
  return ref
}

/** setStatus refuses an unknown status BEFORE resolving anything: a typo that silently no-ops loses the fleet's red/green. */
export function assertStatus(status) {
  if (!STATUS.includes(status)) throw new Error(`setStatus: unknown status "${status}" (${STATUS.join('|')})`)
  return status
}

// --- liveness -----------------------------------------------------------------------------------

/** Every pid whose argv carries the exact `--fleet-session=<label>` token, ascending. Token match, never substring. */
export function markerPids(snap, label) {
  const out = []
  for (const p of snap.values()) if (hasSessionMarker(p.cmd, label)) out.push(Number(p.pid))
  return out.sort((a, b) => a - b)
}

/**
 * PURE. Is the spawn this ref names still the one running?
 *
 * `replaced` is the relaunch case: the descriptor now records a different spawn nonce, so the marked
 * process in the snapshot belongs to the successor and this handle must read as gone — even though
 * "a process with that label" plainly exists. A recovered ref (spawn null) can never be replaced.
 *
 * `shimPid` prefers the pid the shim wrote into its own descriptor: a PowerShell host window carries
 * the shim's argv (and therefore the marker) on its own command line, so two marked pids for one
 * label is normal there, and console injection must target the shim rather than guess.
 * @returns {{pids: number[], replaced: boolean, alive: boolean, shimPid: number|null}}
 */
export function spawnState(ref, snap, descriptor = null) {
  const pids = markerPids(snap, ref.label)
  const stamped = descriptor && descriptor.backendRef && typeof descriptor.backendRef === 'object' ? descriptor.backendRef.spawn : undefined
  const replaced = ref.spawn !== null && typeof stamped === 'string' && stamped !== ref.spawn
  const known = !!descriptor && pids.includes(Number(descriptor.shimPid))
  return { pids, replaced, alive: !replaced && pids.length > 0, shimPid: known ? Number(descriptor.shimPid) : pids.length ? pids[0] : null }
}

/** A session that is registered and alive must not be spawned beside: two agents in one worktree collide on the git index. */
export function assertNotRunning(label, snap) {
  if (markerPids(snap, label).length) throw new Error(`spawn: session "${label}" is already running`)
}

/** The interface handle for a descriptor: the launcher's stamped ref when it is ours, a recovered one otherwise. */
export function handleFor(backend, descriptor, { shimPid = null } = {}) {
  const stamped = descriptor.backendRef && typeof descriptor.backendRef === 'object' ? descriptor.backendRef : null
  const own = !!stamped && stamped.backend === backend && typeof stamped.label === 'string'
  const h = { id: String(descriptor.label), role: descriptor.role, backendRef: own ? Object.freeze({ ...stamped }) : recoveredRef(backend, descriptor) }
  if (Number.isInteger(shimPid)) h.shimPid = shimPid
  if (Number.isInteger(descriptor.pgid)) h.pgid = descriptor.pgid
  return Object.freeze(h)
}

/**
 * The live set, REGISTRY-FIRST: every readable descriptor, judged against ONE cached snapshot by the
 * reconciler. A session the snapshot proves is listed; a session too young for the snapshot to be
 * evidence about (reconcilePlan's `pending`) is listed too, because the launcher that just spawned
 * it must not read its absence as a failed spawn; a session with no process is not; a marked
 * process with no descriptor is an orphan for the reconciler to report, never a session to list.
 * With no descriptors there is nothing to judge and no snapshot is taken — the Windows reading
 * costs ~450 ms and an empty registry must not pay it.
 */
export function listHandles({ backend, stateDir, source, nowMs = Date.now() }) {
  if (!stateDir) return []
  const descriptors = listSessions({ stateDir })
  if (!descriptors.length) return []
  const { snap, takenMs } = source.cached()
  const plan = reconcilePlan(descriptors, snap, { nowMs, snapshotTakenMs: takenMs })
  const alive = new Map(plan.alive.map(a => [a.label, a.shimPid]))
  const pending = new Set(plan.pending.map(p => p.label))
  const out = []
  for (const d of descriptors) {
    const label = String(d.label)
    if (alive.has(label)) out.push(handleFor(backend, d, { shimPid: alive.get(label) }))
    else if (pending.has(label)) out.push(handleFor(backend, d, { shimPid: Number.isInteger(d.shimPid) ? d.shimPid : null }))
  }
  return out
}

// --- kill ---------------------------------------------------------------------------------------

/**
 * Kill the spawn's tree: a FRESH snapshot (never the cached one — a kill planned on a stale reading
 * misses the dev server the agent started since), rooted at every pid carrying the marker, deepest
 * first through sys/kill.killTree, which re-snapshots and reports survivors; taskkill is its own
 * one-pid-per-call survivors fallback. A replaced handle is "already gone": killing the label's pids
 * would take the relaunched successor. Killed pids are de-duplicated because a host window and the
 * shim under it are both roots and the second plan walks the first one's remains.
 * @returns {{ok: boolean, killed: number[], alreadyGone: boolean, survivors: number[]}}
 */
export function killSpawn(ref, { source, killTree = sysKillTree, selfPid = process.pid, platform = process.platform, descriptor = null, pgidFor = () => null } = {}) {
  const { snap } = source.fresh()
  const st = spawnState(ref, snap, descriptor)
  if (st.replaced || !st.pids.length) return { ok: true, killed: [], alreadyGone: true, survivors: [] }
  const killed = new Set()
  const survivors = new Set()
  for (const root of st.pids) {
    const r = killTree(snap, root, { selfPid, platform, pgid: pgidFor(root), resnapshot: () => source.fresh().snap })
    for (const p of r.killed) killed.add(p)
    for (const p of r.survivors) survivors.add(p)
  }
  for (const p of killed) survivors.delete(p)
  return { ok: survivors.size === 0, killed: [...killed], alreadyGone: false, survivors: [...survivors] }
}

// --- send ---------------------------------------------------------------------------------------

/**
 * Split text into injectable chunks of at most `size` UTF-16 units, never between the two halves of
 * a surrogate pair: the injector writes one key event per unit, and a pair split across two writes
 * arrives as two lone surrogates — an emoji at a chunk boundary would reach the session as garbage.
 */
export function chunkText(text, size = CHUNK_CHARS) {
  const s = String(text ?? '')
  const n = Math.max(1, Math.floor(size))
  const out = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + n, s.length)
    const last = s.charCodeAt(end - 1)
    if (end < s.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1
    out.push(s.slice(i, end))
    i = end
  }
  return out
}

/**
 * PURE. How a message travels. Inline in chunks when it is short and single-line; through a file
 * otherwise. A newline forces the file: Enter is what SUBMITS in the session, so a multi-line message
 * typed key by key would be sent as its first line and the rest typed into the next prompt.
 * @returns {{mode: 'inline'|'pointer', chunks: string[]}}
 */
export function planSend(text, { chunkChars = CHUNK_CHARS, pointerThreshold = POINTER_THRESHOLD } = {}) {
  const s = String(text ?? '')
  if (s.length > pointerThreshold || /[\r\n]/.test(s)) return { mode: 'pointer', chunks: [] }
  return { mode: 'inline', chunks: chunkText(s, chunkChars) }
}

/**
 * What one injector call actually delivered, clamped to what was asked. An injector that returns no
 * count did not prove delivery: "no count" is 0, never "assume it all went", because assuming is
 * exactly what turned a short write into an acted-upon fragment.
 * @returns {{written: number, reason: string|null}}
 */
export function normalizeWrite(result, max) {
  const raw = typeof result === 'number' ? result : result && typeof result === 'object' ? result.written : undefined
  const reason = result && typeof result === 'object' && result.reason ? String(result.reason) : null
  if (!Number.isInteger(raw)) return { written: 0, reason: reason || 'injector returned no count' }
  return { written: Math.max(0, Math.min(max, raw)), reason }
}

/**
 * The delivery loop that HONOURS THE COUNT. Each chunk is written and the accepted count read back;
 * a short count stops the loop right there and reports it — no Enter follows, so the fragment sits
 * unsubmitted in the input line instead of being acted on. Only after every chunk landed whole is
 * one Enter injected to submit, and an Enter the buffer refused is reported too: text that was typed
 * but never submitted is not a delivered message.
 * @param {(chunk: string, opts: {enter: boolean}) => number|{written: number, reason?: string}} inject
 */
export function deliverChunks(text, chunks, inject) {
  const s = String(text ?? '')
  let delivered = 0
  for (const chunk of chunks) {
    const w = normalizeWrite(inject(chunk, { enter: false }), chunk.length)
    delivered += w.written
    if (w.written < chunk.length) return { ...shortDelivery(s, delivered, w.reason || 'short-write'), submitted: false }
  }
  const e = normalizeWrite(inject('', { enter: true }), 1)
  if (e.written < 1) return { ok: false, requested: s.length, delivered, truncated: false, reason: e.reason || 'not-submitted', submitted: false }
  return { ...fullDelivery(s), submitted: true }
}

/** PURE. The next `<label>-<n>.md` number, from the names already in the messages directory. */
export function messageNumber(names, label) {
  const re = new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.md$`)
  let max = 0
  for (const n of names || []) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** Write the message the pointer will name. `wx`: a number is never reused, so a file is never overwritten. */
export function writeMessageFile(stateDir, label, text) {
  const dir = path.join(stateDir, MESSAGES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${label}-${messageNumber(fs.readdirSync(dir), label)}.md`)
  fs.writeFileSync(file, String(text ?? ''), { flag: 'wx' })
  return file
}

/** The one line that is injected instead of a long message. */
export function pointerFor(file) {
  return `Read ${file} now`
}

/**
 * send() for a console-injecting backend. A gone session is reported per target, never thrown, so
 * one dead label cannot abort a fan-out over the others. `via: 'file'` and `file` are extra fields
 * beside the contract's SendResult: the caller can say where the message went.
 */
export function sendViaInjector({ ref, stateDir, source, descriptor, inject, text, chunkChars = CHUNK_CHARS, pointerThreshold = POINTER_THRESHOLD }) {
  const s = String(text ?? '')
  const st = spawnState(ref, source.cached().snap, descriptor)
  if (!st.alive) return { ok: false, requested: s.length, delivered: 0, truncated: false, reason: 'session-gone' }
  const write = (chunk, opts) => inject(st.shimPid, chunk, opts)
  const plan = planSend(s, { chunkChars, pointerThreshold })
  if (plan.mode === 'inline') return deliverChunks(s, plan.chunks, write)
  const file = writeMessageFile(stateDir, ref.label, s)
  const pointer = pointerFor(file)
  const r = deliverChunks(pointer, chunkText(pointer, chunkChars), write)
  // Nothing of the TEXT reached the session unless the whole pointer did: a half-typed path is not a
  // partially delivered message, it is an undelivered one.
  if (!r.ok) return { ...shortDelivery(s, 0, `${r.reason} (pointer to ${file})`), submitted: false, via: 'file', file }
  return { ...fullDelivery(s), submitted: true, via: 'file', file }
}

// --- status -------------------------------------------------------------------------------------

/**
 * Write-only status: the backend cannot paint another console's title, so it writes the status into
 * the hook-written state file the shim polls (session/shim.mjs parseSessionState) and the shim paints
 * the OSC title from inside the session. `true` means recorded, not observed — observableStatus is
 * false on every backend that uses this.
 */
export function writeStatus(descriptor, status, nowMs = Date.now()) {
  assertStatus(status)
  const file = descriptor && descriptor.stateFile
  if (!file) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ status, at: new Date(nowMs).toISOString(), source: 'backend' }) + '\n')
  return true
}

// --- layout -------------------------------------------------------------------------------------

/**
 * PURE. Which layout this backend can honour, and what to say when it cannot — announced, never
 * silently placing nothing. Pixel placement is a HOOK (`placeWindows`), not core: the SetWindowPos
 * arithmetic lives in extras/windows and is passed in, so the backend claims pixelLayout only when
 * the hook is actually there.
 * @returns {{mode: string, placed: number, notice: string|null}}
 */
export function planLayout(handles, mode, caps, { placeWindows = null } = {}) {
  const live = (handles || []).filter(Boolean)
  if (mode === 'pixel-grid') {
    const notice = degradationNotice(caps, 'pixelLayout', 'pixel-grid placement')
    if (notice) return { mode, placed: 0, notice: `${notice}; the SetWindowPos hook lives in extras/windows and is passed to the backend as placeWindows` }
    try {
      return { mode, placed: Number(placeWindows(live)) || 0, notice: null }
    } catch (e) {
      return { mode, placed: 0, notice: `pixel-grid placement failed: ${e && e.message ? e.message : e}` }
    }
  }
  if (mode === 'tiled-panes') {
    const notice = degradationNotice(caps, 'gridLayout', 'tiling')
    return notice ? { mode, placed: 0, notice } : { mode, placed: live.length, notice: null }
  }
  if (mode !== 'windows') return { mode, placed: 0, notice: `layout: unknown mode "${mode}"` }
  return { mode, placed: live.length, notice: null }
}
