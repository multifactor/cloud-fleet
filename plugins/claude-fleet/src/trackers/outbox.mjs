// The tracker outbox: `<stateDir>/tracker-outbox/<ts>-<label>-<seq>.json` (contract §4), one file per
// tracker operation a session could not perform — its tools were down, it runs in `tracker.mode:
// manual`, or the op is launcher-only (op-18, op-27). The launcher drains it (`fleet outbox list`),
// applies each op through the adapter, re-reads the issue, and acks (`fleet outbox ack`), which MOVES
// the file to `applied/`. Nothing here ever deletes an entry: the applied record is the only evidence
// that a state change happened for a reason.
//
// Every rule below is an incident:
//   * the op is validated at ENQUEUE, against the registry's 27 names — an invalid op discovered at
//     drain time has already lost its context (the session that knew what it meant is gone);
//   * entries drain in the ORDER THEY WERE ADDED, by a per-outbox sequence number and never by
//     timestamp — op-11 comment before op-9 cancel, op-15 patchBody before a done flag: a state change
//     moves an issue out from under the rationale, and a clock that steps backwards must not reorder
//     the queue; the sequence is minted under a cross-process mutex (`locks/outbox/seq/`), because
//     two adds scanning at once would mint the same seq and hand the order back to the clock;
//   * a comment (op-11), a cancellation reason (op-9), a body patch (op-15) and duplicate evidence
//     (op-24) are verbatim BY DEFINITION, flag or no flag, and verbatimText() hands the text back
//     byte for byte — a cancellation rationale is evidence, and paraphrasing it is how a wrong
//     cancellation becomes unfindable; the flag is re-derived on READ too, so an entry another
//     producer wrote without it (or a hand edit) is never paraphrased for want of a boolean;
//   * an entry that failed to apply stays PENDING with the failure recorded, and is marked
//     `refetchBeforeRetry` — a tracker once applied an oversized write and then errored on the echo,
//     so a blind retry applied it twice;
//   * an entry present in BOTH `tracker-outbox/` and `applied/` is an ack that died between the
//     applied write and the unlink — the op landed and was verified — and the drain view hands it
//     back under `alreadyApplied`, never under `entries`: a drain that re-applied one posted a
//     comment twice;
//   * an unreadable entry is REPORTED beside the healthy ones, never skipped — a skipped entry is a
//     tracker op nobody ever applies, and the session that queued it believes it done;
//   * the entry's KEY is data, never a path — an op-13 createIssue has no key yet and is queued under
//     its finding's fid, which carries the `|` separator no filename accepts.
//
// Pure decisions (normalizeOp, verbatimPayload, entryName/parseEntryName, drainOrder) are separate
// from the thin filesystem wrappers, in the shape of core/fleet.mjs.

import fs from 'node:fs'
import path from 'node:path'

import { stateLayout } from '../config/paths.mjs'
import { mkdirLock } from '../sys/lock.mjs'
import { OP_COUNT, OP_NAMES } from './registry.mjs'

/** Where acknowledged entries go, under the outbox dir (contract §4: `tracker-outbox/*.json · applied/`). */
export const APPLIED_DIR = 'applied'

// A label is a FILENAME segment (the same rule core/fleet.mjs applies to `sessions/<label>.json`):
// `requestedBy` reaches us from FLEET_LABEL or a CLI flag and is joined into the entry's path.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// `<ts>-<label>-<seq>`: ts is a compact ISO instant with milliseconds (colons are illegal in a
// Windows filename), the label is greedy, and the seq is the trailing digit run — so a label that
// itself ends in `-<digits>` (`check-12`) still parses, because the seq is always the LAST group.
const ENTRY_RE = /^(\d{8}T\d{9}Z)-([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+)$/
const SEQ_WIDTH = 6

/**
 * Ops whose text is verbatim BY DEFINITION (contract §6: op-11 "never paraphrased", op-9 and op-24
 * "comment FIRST"; the session playbook: "comments and body patches always carry it"). A session
 * that forgets `--verbatim` on a comment must not have its comment tidied.
 */
export const ALWAYS_VERBATIM = Object.freeze([9, 11, 15, 24])

/** The single text field each op posts verbatim. op-15 is the exception: its `edits[].replace` texts. */
export const VERBATIM_FIELD = Object.freeze({ 9: 'reason', 11: 'text', 13: 'body', 14: 'body', 24: 'evidence', 25: 'note' })

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** What a verbatim op-`n` must carry, as a sentence for an error — null when the op has no text at all. */
const verbatimWant = n => (n === 15 ? 'args.edits: [{find, replace}] with a non-empty find' : VERBATIM_FIELD[n] ? `a non-empty string in args.${VERBATIM_FIELD[n]}` : null)

// ---- pure --------------------------------------------------------------------------------------

/**
 * PURE. Resolve what a caller wrote as an op — `op-11`, `11`, 11, or the name `comment` — to the
 * contract's number and name, or throw. Refused HERE, at enqueue: an entry with an op the adapter has
 * no section for would sit in the outbox until drain time, when the session that knew what it meant
 * is already reclaimed.
 *
 * A bare NAME resolves to the first op carrying it: `setState` is op-5, and op-7 (op-5 applied to the
 * in-review state) is reachable by number — the args carry the state either way, so nothing is lost,
 * and a name is never refused for being shared.
 * @returns {{n: number, op: string}}
 */
export function normalizeOp(input) {
  const s = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : ''
  let n = null
  const byNumber = /^(?:op-)?(\d+)$/i.exec(s)
  if (byNumber) n = Number(byNumber[1])
  else if (s) {
    const i = OP_NAMES.indexOf(s)
    if (i > 0) n = i
  }
  if (!Number.isInteger(n) || n < 1 || n > OP_COUNT) {
    throw new Error(`outbox: ${JSON.stringify(input)} is not a tracker op — pass op-1 … op-${OP_COUNT} (or its name, e.g. "comment"); contract §6 lists them`)
  }
  return { n, op: OP_NAMES[n] }
}

/**
 * PURE. The text an op would post verbatim, located in its args — or null when the op carries none.
 * @returns {{kind: 'text', field: string, value: string} | {kind: 'edits', value: Array} | null}
 */
export function verbatimPayload(n, args) {
  const a = isPlainObject(args) ? args : {}
  if (n === 15) {
    const edits = a.edits
    if (!Array.isArray(edits) || !edits.length) return null
    for (const e of edits) {
      if (!isPlainObject(e) || typeof e.find !== 'string' || !e.find || typeof e.replace !== 'string') return null
    }
    return { kind: 'edits', value: edits }
  }
  const field = VERBATIM_FIELD[n]
  if (!field) return null
  const value = a[field]
  if (typeof value !== 'string' || !value) return null
  return { kind: 'text', field, value }
}

/**
 * The text of a verbatim entry EXACTLY as it was queued — not trimmed, not re-wrapped, not
 * re-phrased; the launcher posts this string and nothing else. Null for an entry that is not
 * verbatim, and for op-15, whose verbatim texts are the `replace` strings inside `entry.args.edits`
 * (read them from there; there is no single text to return).
 */
export function verbatimText(entry) {
  if (!entry || !entry.verbatim) return null
  const p = verbatimPayload(entry.n, entry.args)
  return p && p.kind === 'text' ? p.value : null
}

/** PURE. `2026-03-14T10:00:00.123Z` → `20260314T100000123Z`, the filename form of an instant. */
export function compactInstant(iso) {
  return String(iso).replace(/[-:.]/g, '')
}

/** PURE. The filename (no extension) of an entry. */
export function entryName({ at, requestedBy, seq }) {
  return `${compactInstant(at)}-${requestedBy}-${String(seq).padStart(SEQ_WIDTH, '0')}`
}

/** PURE. `{ts, label, seq}` from an entry id, or null when the name is not an outbox entry. */
export function parseEntryName(name) {
  const m = ENTRY_RE.exec(String(name))
  return m ? { ts: m[1], label: m[2], seq: Number(m[3]) } : null
}

/**
 * PURE. The order the launcher drains in: the per-outbox sequence FIRST, the instant and the label
 * only as tie-breaks between entries queued in the same scan window. The sequence is the order of
 * addition; a timestamp is not — one clock step backwards (an NTP correction mid-run) would put a
 * session's op-9 cancel ahead of the op-11 comment carrying its rationale.
 */
export function drainOrder(entries) {
  return entries.slice().sort((a, b) =>
    a.seq - b.seq ||
    (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ||
    (a.requestedBy < b.requestedBy ? -1 : a.requestedBy > b.requestedBy ? 1 : 0))
}

/** PURE. Has this pending entry been tried before? Then the launcher re-reads the issue (op-2) first. */
export function refetchBeforeRetry(entry) {
  return Array.isArray(entry && entry.attempts) && entry.attempts.length > 0
}

// ---- paths -------------------------------------------------------------------------------------

/** `<stateDir>/tracker-outbox` — the layout itself lives in config/paths.mjs. */
export function outboxDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('outbox: stateDir is required')
  return stateLayout(stateDir, process.platform).outbox
}

/** `<stateDir>/tracker-outbox/applied`. */
export function appliedDir(stateDir) {
  return path.join(outboxDir(stateDir), APPLIED_DIR)
}

function assertLabel(label) {
  // Not String(label): `String(undefined)` is "undefined", a perfectly good filename, and an entry
  // filed under it would never be attributed to the session that queued it.
  const s = typeof label === 'number' ? String(label) : label
  if (typeof s !== 'string' || !LABEL_RE.test(s)) {
    throw new Error(`outbox: requestedBy ${JSON.stringify(label)} is not a session label ([A-Za-z0-9._-], not starting with "."), never a path`)
  }
  return s
}

function assertId(id) {
  const s = typeof id === 'string' ? id : ''
  if (!parseEntryName(s)) throw new Error(`outbox: ${JSON.stringify(id)} is not an outbox entry id (<ts>-<label>-<seq>)`)
  return s
}

function instantOf(at, what) {
  const ms = at === undefined || at === null ? Date.now() : at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at))
  if (!Number.isFinite(ms)) throw new Error(`outbox: ${what} ${JSON.stringify(at)} is not an instant`)
  return new Date(ms).toISOString()
}

let tmpCounter = 0

/**
 * Temp file IN THE SAME DIRECTORY, flushed, renamed over the target, then the DIRECTORY flushed: a
 * rename is atomic only within one filesystem, and a reader (the launcher's drain, mid-scan) must see
 * a whole entry or none. The directory flush is for the reboot case — a hard freeze that takes the
 * new directory entry with it loses the op entirely, while the session that queued it has already
 * flagged done believing it applied. A failure removes the temp file, because nothing else ever
 * sweeps `.<name>.<pid>.<n>.tmp` here.
 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpCounter++}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fsyncDir(dir)
  return file
}

/**
 * Flush the directory entry the rename just created. Best effort by design: Windows cannot open a
 * directory for fsync at all, and a platform that refuses the flush is never a reason to fail a write
 * that has already landed.
 */
function fsyncDir(dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // EPERM/EISDIR/EACCES on Windows and some network filesystems: nothing to do here.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

function entryNames(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return names.filter(n => n.endsWith('.json'))
}

/**
 * The next sequence number: one past the highest in BOTH pending and applied. Applied counts so an
 * id can never collide with one already acknowledged — pending alone would restart at 1 once the
 * queue drained, and the next entry from the same session in the same millisecond would land on a
 * name `applied/` already holds.
 */
function nextSeq(stateDir) {
  let max = 0
  for (const dir of [outboxDir(stateDir), appliedDir(stateDir)]) {
    for (const name of entryNames(dir)) {
      const p = parseEntryName(name.slice(0, -'.json'.length))
      if (p && p.seq > max) max = p.seq
    }
  }
  return max + 1
}

// The sequence is a read-then-write: two `fleet outbox add` processes scanning at once (a session and
// the launcher, or two sessions) would mint the same seq, and drainOrder would fall to the timestamp
// tie-break — the ordering the header rules out. So the scan and the write are one critical section
// under a mkdir mutex at `locks/outbox/seq/` (contract §4's locks tree; mkdir is atomic and
// EEXIST-on-collision on every filesystem). An add holds it for milliseconds; a holder that died is
// stolen after SEQ_LOCK_STALE_MS, judged by the directory's mtime ONLY (sys/lock.mjs's rule — there is
// no holder to heartbeat and no pid worth trusting); a wait past SEQ_LOCK_WAIT_MS is an error at the
// door, which reaches the session that knows the context.
//
// Not sys/lock.mjs's tryAcquire: its steal path reads "the directory is gone" as "free" and then writes
// its holder INTO the directory a third acquire has just re-created, so two adds cycling the lock
// every few milliseconds both come away holding it — the cross-process test reproduced the duplicate
// seq on the first run. Here a stealer re-stats under its own mkdir guard and never writes into a
// directory it did not create.
const SEQ_LOCK_STALE_MS = 30_000
const SEQ_LOCK_WAIT_MS = 10_000
const SEQ_LOCK_POLL_MS = 5

/** Block this thread for `ms` without spinning the CPU (Atomics.wait is allowed on Node's main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function mtimeOf(dir) {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return null // released (or stolen) since we looked: not held
  }
}

function withSeqLock(stateDir, fn) {
  const dir = path.join(stateLayout(stateDir, process.platform).locks, 'outbox', 'seq')
  const stealDir = `${dir}.steal`
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const deadline = Date.now() + SEQ_LOCK_WAIT_MS
  for (;;) {
    // mkdirLock, not mkdirSync: on Windows a concurrent release leaves the name PENDING DELETE and
    // the collision comes back as EPERM, not EEXIST (see the ⛔ in sys/lock.mjs).
    if (mkdirLock(dir) === 'created') break
    const held = mtimeOf(dir)
    if (held === null) continue
    if (Date.now() - held > SEQ_LOCK_STALE_MS) {
      // Stale. Two waiters judging so at once must not both remove it — the second would remove the
      // first's fresh lock — so the removal re-checks under its own mkdir guard.
      if (mkdirLock(stealDir) === 'held') {
        sleepSync(SEQ_LOCK_POLL_MS)
        continue
      }
      try {
        const again = mtimeOf(dir)
        if (again !== null && Date.now() - again > SEQ_LOCK_STALE_MS) fs.rmSync(dir, { recursive: true, force: true })
      } finally {
        fs.rmSync(stealDir, { recursive: true, force: true })
      }
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`outbox: the sequence lock ${dir} stayed held for ${SEQ_LOCK_WAIT_MS / 1000}s; nothing was queued — another add is stuck, or a dead one's lock is younger than ${SEQ_LOCK_STALE_MS / 1000}s`)
    }
    sleepSync(SEQ_LOCK_POLL_MS)
  }
  try {
    return fn()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---- enqueue -----------------------------------------------------------------------------------

/**
 * Queue one tracker operation. Validated at the door — op against the registry, `key` present,
 * `args` an object, a verbatim entry actually carrying its text — because a refusal here reaches the
 * session that knows the context, and a refusal at drain time reaches nobody.
 *
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string|number} o.op        `op-11`, `11`, or `comment`
 * @param {string} o.key              the issue key — or, for an op-13 createIssue that has no key
 *                                    yet, the finding's fid (opaque; it is data here, never a path)
 * @param {object} [o.args]           the op's arguments (contract §6), default `{}`
 * @param {boolean} [o.verbatim]      post the text unchanged; forced on for op-9/11/15/24
 * @param {string} [o.requestedBy]    the session label (FLEET_LABEL); the launcher queues as "launcher"
 * @param {string|number|Date} [o.at] when it was queued (default: now)
 * @param {string} [o.note]           why it is queued, for the launcher's eyes (the check planner's
 *                                    "promoted after the audit gate"); never posted anywhere
 * @returns {object} the entry as written, plus `file`
 */
export function enqueue({ stateDir, op, key, args = {}, verbatim = false, requestedBy = 'launcher', at, note } = {}) {
  const dir = outboxDir(stateDir)
  const { n, op: name } = normalizeOp(op)
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`outbox: op-${n} ${name} needs a key (an issue key, or the fid of a createIssue that has none yet)`)
  }
  // An array or a string here is a CLI quoting accident (`--args '"text"'`), and an adapter handed
  // it would call a tool with no arguments at all.
  if (!isPlainObject(args)) throw new Error(`outbox: args for op-${n} ${name} must be a JSON object, got ${Array.isArray(args) ? 'an array' : typeof args}`)
  const label = assertLabel(requestedBy)
  const when = instantOf(at, 'at')
  if (note !== undefined && note !== null && typeof note !== 'string') throw new Error(`outbox: note must be a string, got ${typeof note}`)

  const isVerbatim = verbatim === true || ALWAYS_VERBATIM.includes(n)
  if (isVerbatim && !verbatimPayload(n, args)) {
    const want = verbatimWant(n)
    throw new Error(want
      ? `outbox: op-${n} ${name} is verbatim but carries no text to post — it needs ${want}`
      : `outbox: op-${n} ${name} carries no text to post verbatim; --verbatim applies to comments, reasons, bodies and body edits`)
  }

  return withSeqLock(stateDir, () => {
    // Loop on a name collision rather than renaming over it: rename replaces an existing file
    // silently on every platform, and a replaced entry is a tracker op nobody applies.
    let seq = nextSeq(stateDir)
    let id
    for (;;) {
      id = entryName({ at: when, requestedBy: label, seq })
      const taken = fs.existsSync(path.join(dir, `${id}.json`)) || fs.existsSync(path.join(appliedDir(stateDir), `${id}.json`))
      if (!taken) break
      seq++
    }
    const entry = { v: 1, id, seq, n, op: name, key, args, verbatim: isVerbatim, requestedBy: label, at: when, note: note || null, attempts: [] }
    const file = writeJsonAtomic(path.join(dir, `${id}.json`), entry)
    return { ...entry, file }
  })
}

// ---- reading -----------------------------------------------------------------------------------

/**
 * Read one entry file. `{entry}` or `{error}` — every way a file can be wrong is a sentence, because
 * the caller REPORTS it: a skipped entry is an op that is never applied, and the session that queued
 * it has already moved on believing it done.
 *
 * `verbatim` is re-derived here, not trusted: an op-9/11/15/24 is verbatim whatever its flag says
 * (another producer's bare `{op, key, args}`, or a hand edit, must not get its comment tidied), and a
 * verbatim entry with no text to post is unreadable, mirroring the check at the door.
 */
function readEntryFile(file, id) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { error: `cannot be read: ${e.code || e.message}` }
  }
  let d
  try {
    d = JSON.parse(text)
  } catch {
    return { error: 'is not valid JSON' }
  }
  if (!isPlainObject(d)) return { error: 'is not a JSON object' }
  // The FILENAME is the identity: an entry claiming another id would be acked under one name and
  // listed under the other, forever.
  if (d.id !== id) return { error: `carries id ${JSON.stringify(d.id)}, not its filename` }
  const named = parseEntryName(id)
  if (d.seq !== named.seq) return { error: `carries seq ${JSON.stringify(d.seq)}, its filename says ${named.seq}` }
  if (d.requestedBy !== named.label) return { error: `carries requestedBy ${JSON.stringify(d.requestedBy)}, its filename says ${JSON.stringify(named.label)}` }
  if (!Number.isInteger(d.n) || d.n < 1 || d.n > OP_COUNT) return { error: `carries n ${JSON.stringify(d.n)}, which is not op-1 … op-${OP_COUNT}` }
  if (d.op !== undefined && d.op !== OP_NAMES[d.n]) return { error: `carries op ${JSON.stringify(d.op)}, but op-${d.n} is ${OP_NAMES[d.n]}` }
  if (typeof d.key !== 'string' || !d.key) return { error: 'has no key' }
  if (!isPlainObject(d.args)) return { error: 'has no args object' }
  const at = Date.parse(d.at ?? '')
  if (!Number.isFinite(at)) return { error: `carries at ${JSON.stringify(d.at)}, which is not an instant` }
  const verbatim = d.verbatim === true || ALWAYS_VERBATIM.includes(d.n)
  if (verbatim && !verbatimPayload(d.n, d.args)) {
    const want = verbatimWant(d.n)
    return { error: want ? `is verbatim but carries no text to post — it needs ${want}` : `is flagged verbatim, but op-${d.n} ${OP_NAMES[d.n]} has no text to post` }
  }
  return {
    entry: {
      ...d,
      op: OP_NAMES[d.n],
      verbatim,
      attempts: Array.isArray(d.attempts) ? d.attempts : [],
      file,
    },
  }
}

/**
 * Every entry in `dir`, in drain order, plus every `.json` there that is NOT a readable entry.
 * Only `*.json` is looked at: `.<name>.json.<pid>.<n>.tmp` is an interrupted write of ours, and the
 * `applied/` directory is not an entry.
 */
function readDir(dir) {
  const entries = []
  const unreadable = []
  for (const name of entryNames(dir)) {
    const file = path.join(dir, name)
    const id = name.slice(0, -'.json'.length)
    if (!parseEntryName(id)) {
      // A hand-written file with the wrong name is the commonest way an op goes missing: it is in
      // the directory, it looks like JSON, and nothing ever applies it.
      unreadable.push({ id, file, error: 'is not named <ts>-<label>-<seq>.json, so it is not an outbox entry' })
      continue
    }
    const r = readEntryFile(file, id)
    if (r.error) unreadable.push({ id, file, error: r.error })
    else entries.push(r.entry)
  }
  return { entries: drainOrder(entries), unreadable: unreadable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
}

/**
 * The pending entries, in drain order, the unreadable files beside them, and — separately — every
 * pending id that `applied/` ALREADY holds. That is an ack that died between the applied write and
 * the unlink: the op landed and the launcher verified it before the ack began, so it is not pending
 * and must never be handed out as one (the drain would post the comment twice). Each carries the
 * applied record's `appliedAt` and `result`, or `error` when that record cannot be read; either way
 * `ack(id)` is what finishes the move — a read never does, because a read that deletes is how a
 * listing turns into a loss. A missing dir is empty.
 * @returns {{entries: Array<object>, alreadyApplied: Array<object>, unreadable: Array<{id, file, error}>}}
 */
export function pending({ stateDir }) {
  const p = readDir(outboxDir(stateDir))
  const aDir = appliedDir(stateDir)
  const done = new Set(entryNames(aDir))
  const entries = []
  const alreadyApplied = []
  for (const e of p.entries) {
    if (!done.has(`${e.id}.json`)) {
      entries.push(e)
      continue
    }
    const appliedFile = path.join(aDir, `${e.id}.json`)
    const r = readEntryFile(appliedFile, e.id)
    alreadyApplied.push(r.error
      ? { ...e, appliedFile, appliedAt: null, result: null, error: `applied record ${r.error}` }
      : { ...e, appliedFile, appliedAt: r.entry.appliedAt ?? null, result: r.entry.result ?? null, error: null })
  }
  return { entries, alreadyApplied, unreadable: p.unreadable }
}

/** The acknowledged entries (each carrying `result` and `appliedAt`), in drain order, plus the unreadable files. */
export function applied({ stateDir }) {
  return readDir(appliedDir(stateDir))
}

/**
 * The drain view — what `fleet outbox list` shows the launcher: the pending entries IN ORDER, each
 * marked `refetchBeforeRetry` when an earlier attempt was recorded; the entries an interrupted ack
 * already applied, which the launcher only acks; and the unreadable files, which it reports to the
 * operator rather than steps over.
 * @returns {{entries: Array<object>, alreadyApplied: Array<object>, unreadable: Array<{id, file, error}>}}
 */
export function list({ stateDir }) {
  const p = pending({ stateDir })
  return { entries: p.entries.map(e => ({ ...e, refetchBeforeRetry: refetchBeforeRetry(e) })), alreadyApplied: p.alreadyApplied, unreadable: p.unreadable }
}

// ---- ack / attempts ----------------------------------------------------------------------------

function readPending(stateDir, id) {
  const file = path.join(outboxDir(stateDir), `${id}.json`)
  if (!fs.existsSync(file)) return { file, missing: true }
  const r = readEntryFile(file, id)
  if (r.error) throw new Error(`outbox: entry ${id} ${r.error} (${file}) — fix or move it by hand; it is not acknowledged`)
  return { file, entry: r.entry }
}

/**
 * Acknowledge an entry: MOVE it to `applied/` with the launcher's result merged in. Never a delete —
 * the applied record is the only evidence of why an issue changed state, and `applied()` is what a
 * reconciler reads when a session's done flag says "cancelled" and the tracker says otherwise.
 *
 * Only after the launcher has re-read the issue and seen the change: an ack is a claim that the op
 * landed, and a tracker write can fail quietly. A failed apply is recordAttempt(), not ack().
 *
 * Interrupted between the write into `applied/` and the unlink, a re-run finishes the move; a second
 * ack of a finished one throws, because "acknowledged twice" means "applied twice".
 * @returns {object} the applied record
 */
export function ack(id, { stateDir, result, at } = {}) {
  const key = assertId(id)
  const appliedFile = path.join(appliedDir(stateDir), `${key}.json`)
  const p = readPending(stateDir, key)
  if (fs.existsSync(appliedFile)) {
    if (p.missing) throw new Error(`outbox: entry ${key} was already acknowledged (${appliedFile}); acknowledging it again would mean the op was applied twice`)
    // The previous ack wrote the applied record and died before removing the pending file. The
    // applied record is validated BEFORE the pending copy goes: were it torn, the unlink would leave
    // the op's only surviving record unreadable, and list() would no longer show the op at all.
    const done = readEntryFile(appliedFile, key)
    if (done.error) throw new Error(`outbox: applied record ${appliedFile} ${done.error} — the pending entry stays in place; fix or move the applied record by hand`)
    fs.unlinkSync(p.file)
    return done.entry
  }
  if (p.missing) throw new Error(`outbox: no pending entry ${key} (${p.file})`)
  const record = { ...p.entry, result: result === undefined ? null : result, appliedAt: instantOf(at, 'at') }
  delete record.file
  const file = writeJsonAtomic(appliedFile, record)
  fs.unlinkSync(p.file)
  return { ...record, file }
}

/**
 * Record a FAILED apply on a pending entry, in place: it stays in the queue, the note stays with it,
 * and list() marks it `refetchBeforeRetry` — the launcher re-reads the issue (op-2) before trying
 * again, because a tracker that errors on the echo of an oversized write has often applied it, and
 * a blind retry doubles a comment or clobbers a concurrent edit.
 * @returns {object} the updated entry
 */
export function recordAttempt(id, { stateDir, result, at } = {}) {
  const key = assertId(id)
  const p = readPending(stateDir, key)
  if (p.missing) {
    const done = fs.existsSync(path.join(appliedDir(stateDir), `${key}.json`))
    throw new Error(done ? `outbox: entry ${key} is already acknowledged; there is nothing left to retry` : `outbox: no pending entry ${key} (${p.file})`)
  }
  const attempt = { at: instantOf(at, 'at'), result: result === undefined ? null : result }
  const next = { ...p.entry, attempts: [...p.entry.attempts, attempt] }
  delete next.file
  writeJsonAtomic(p.file, next)
  return { ...next, file: p.file }
}
