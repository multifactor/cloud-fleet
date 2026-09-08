// The offline ticket cache: `<stateDir>/tickets/<KEY>.json` + `<KEY>.md` (contract §4), written by
// `fleet ticket cache --issue K --from-json -` from an op-2 result BEFORE a session is spawned, and
// named in the session descriptor as `ticketFile`.
//
// Why it exists: tracker tools can race a fleet-launch burst and never register in a session, and a
// session that cannot read its own ticket stalls on its first turn. The cache is the degradation path
// the sessions are promised — a session reads the file and carries on; it flags `tracker` only when
// the cache is missing too. So the cache is written here or nowhere, and a cache that exists but is
// wrong is worse than none:
//   * the KEY is a path segment — it is joined into a filename off a CLI flag, so anything that could
//     climb out of the tickets directory is refused before a path is built;
//   * the LABELS travel with the ticket: the autowave admits a queued key through core/intake.admit
//     against this cache, and the gate reads the labels — a cache that dropped them would admit a
//     checker-filed hypothesis the audit never verified, which is the one thing intake exists to stop.
//     ⛔ Contract §6 op-2 carries NO labels field, so a cache fed from op-2 alone cannot gate: the
//     record then says `labels: null` ("the feeder carried none"), never `[]` ("none on the issue"),
//     and the readable twin says so — a gate that is blind must at least be visibly blind;
//   * the read result carries the description under `body` as well, the name core/intake.gateStatusOf
//     reads its `**Gate:**` fallback from — one record shape for the file and for the gate;
//   * the JSON is the record and the description is stored BYTE FOR BYTE — a session works from this
//     text as its specification, and a refuted prescription patched into the body (op-15) must reach
//     the next session exactly as written;
//   * the `.md` is the readable twin, written FIRST, so a JSON that exists always has the text a
//     descriptor's `ticketFile` points at;
//   * writes are temp+rename in the same directory, so a session opening the file mid-write sees the
//     old ticket or none, never half of one;
//   * an unreadable or half-written entry is REPORTED, never skipped — a cache the launcher believes
//     is present and a session finds unreadable is a session that flags instead of working.
//
// Pure decisions (assertKey, renderTicketMarkdown, ticketRecord) are separate from the thin
// filesystem wrappers, in the shape of core/fleet.mjs.

import fs from 'node:fs'
import path from 'node:path'

import { stateLayout } from '../config/paths.mjs'

/**
 * A key is a FILENAME segment. Every bundled adapter's example key fits (`ABC-1234`, `GH-1234`, an
 * asana gid, a trello shortLink) and the test asserts that against the adapter files themselves, so
 * a new adapter whose keys carry a separator fails CI here rather than a fleet at spawn time.
 */
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---- pure --------------------------------------------------------------------------------------

/** Refuse anything that is not a plain filename segment. Returns the key. */
export function assertKey(key) {
  // Not String(key): `String(undefined)` is "undefined", a perfectly good filename, and a cache
  // written under it is a ticket no session ever finds.
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error(`tickets: ${JSON.stringify(key)} is not an issue key ([A-Za-z0-9._-], not starting with "."), never a path`)
  }
  return key
}

const optionalString = (v, what) => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`tickets: ${what} must be a string, got ${typeof v}`)
  return String(v)
}

/**
 * Label NAMES, from whatever shape the feeder supplied them in — a list of names, or a list of
 * `{name}` objects (the shape op-17 listLabels returns). Anything else is refused rather than
 * dropped: core/intake.admit matches names, and a label it cannot see is a gate it cannot apply.
 * No list at all is `null` — op-2 (contract §6) carries no labels, and "the feeder carried none"
 * must stay distinguishable from "the issue has none".
 */
const labelNames = (labels, key) => {
  if (labels === undefined || labels === null) return null
  if (!Array.isArray(labels)) throw new Error(`tickets: ${key}: labels must be a list of names, got ${typeof labels}`)
  return labels.map(l => {
    if (typeof l === 'string') return l
    if (isPlainObject(l) && typeof l.name === 'string') return l.name
    throw new Error(`tickets: ${key}: every label must be a name or {name}, got ${JSON.stringify(l)}`)
  })
}

/**
 * PURE. The canonical priority (contract §6: `1 Urgent · 2 High · 3 Medium · 4 Low`) or null. Only an
 * integer in that range, as a number or a digit string — `true` would coerce to 1 (Urgent) and a
 * tracker's raw `9` would be cached as a legal urgency.
 */
function priorityOf(priority, key) {
  if (priority === undefined || priority === null || priority === '') return null
  const n = typeof priority === 'number' ? priority : typeof priority === 'string' && /^\s*\d+\s*$/.test(priority) ? Number(priority) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new Error(`tickets: ${key}: priority must be 1 Urgent … 4 Low (contract §6) or null, got ${JSON.stringify(priority)}`)
  }
  return n
}

/**
 * PURE. The record that is written, from an op-2 `getIssue` result (contract §6: `{key, id, title,
 * description, url, status, priority, parentId, suggestedBranch?}`) plus `labels` when the feeder has
 * them. Only the key and the title are required; a ticket with no body is a legal ticket and is
 * cached with an empty description.
 *
 * The description must be a STRING: a tracker that returns rich text as an object would otherwise
 * be cached as "[object Object]", and a session would work from that.
 */
export function ticketRecord({ key, id, title, description, url, status, priority, parentId, suggestedBranch, labels, at } = {}) {
  assertKey(key)
  if (typeof title !== 'string' || !title.trim()) throw new Error(`tickets: ${key} needs a title`)
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new Error(`tickets: ${key}: description must be a string, got ${typeof description} — a session works from this text verbatim`)
  }
  const ms = at === undefined || at === null ? Date.now() : at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at))
  if (!Number.isFinite(ms)) throw new Error(`tickets: at ${JSON.stringify(at)} is not an instant`)
  const pr = priorityOf(priority, key)
  return {
    v: 1,
    key,
    id: optionalString(id, 'id'),
    title,
    description: description === undefined || description === null ? '' : description,
    url: optionalString(url, 'url'),
    status: optionalString(status, 'status'),
    priority: pr,
    parentId: optionalString(parentId, 'parentId'),
    suggestedBranch: optionalString(suggestedBranch, 'suggestedBranch'),
    labels: labelNames(labels, key),
    cachedAt: new Date(ms).toISOString(),
  }
}

/**
 * PURE. The readable twin. A heading, the facts a session needs as a short list, a rule, then the
 * description EXACTLY as cached — the only change is a final newline when the text has none, so a
 * tail of the file ends on a line. A title with a newline in it is folded onto the heading line; the
 * JSON keeps the title as given.
 */
export function renderTicketMarkdown(t) {
  const lines = [`# ${t.key} — ${String(t.title).replace(/[\r\n]+/g, ' ')}`, '']
  if (t.url) lines.push(`- url: ${t.url}`)
  if (t.status) lines.push(`- status: ${t.status}`)
  if (t.priority !== null && t.priority !== undefined) lines.push(`- priority: ${t.priority}`)
  if (t.parentId) lines.push(`- parent: ${t.parentId}`)
  if (t.labels === null || t.labels === undefined) lines.push('- labels: not supplied by the feeder (op-2 carries none) — the intake gate cannot see a provenance label here')
  else if (Array.isArray(t.labels) && t.labels.length) lines.push(`- labels: ${t.labels.join(', ')}`)
  if (t.suggestedBranch) lines.push(`- suggested branch: ${t.suggestedBranch}`)
  lines.push(`- cached: ${t.cachedAt}`, '', '---', '')
  const body = t.description ? t.description : '(no description)'
  return lines.join('\n') + '\n' + body + (body.endsWith('\n') ? '' : '\n')
}

// ---- paths -------------------------------------------------------------------------------------

/** `<stateDir>/tickets` — the layout itself lives in config/paths.mjs. */
export function ticketsDir(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('tickets: stateDir is required')
  return stateLayout(stateDir, process.platform).tickets
}

/** Both files of one cached ticket. Throws on a key that is not a filename. */
export function ticketPaths(stateDir, key) {
  const dir = ticketsDir(stateDir)
  const k = assertKey(key)
  return { json: path.join(dir, `${k}.json`), md: path.join(dir, `${k}.md`) }
}

let tmpCounter = 0

/**
 * Temp file IN THE SAME DIRECTORY, flushed, renamed over the target, then the DIRECTORY flushed: a
 * rename is atomic only within one filesystem, and a session opening its ticket mid-write must see
 * the old text or none, never half of one. The directory flush is for the reboot case — a hard freeze
 * that takes the new directory entry with it leaves a descriptor pointing at a ticketFile that is not
 * there. A failure removes the temp file, because nothing else ever sweeps `.<name>.<pid>.<n>.tmp`.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpCounter++}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text)
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

// ---- write -------------------------------------------------------------------------------------

/**
 * Cache one ticket: `<KEY>.md` first, then `<KEY>.json`. The JSON is the record (readTicket reads it);
 * the markdown is what a session opens. Writing the twin first means a JSON that exists always has
 * its text beside it — the other order leaves a descriptor pointing at a `ticketFile` that is not
 * there when the process dies between the two writes.
 * @returns {object} the record, plus `file` (the JSON) and `mdFile`
 */
export function cacheTicket({ stateDir, ...ticket } = {}) {
  const record = ticketRecord(ticket)
  const p = ticketPaths(stateDir, record.key)
  writeAtomic(p.md, renderTicketMarkdown(record))
  writeAtomic(p.json, JSON.stringify(record, null, 2) + '\n')
  return { ...record, file: p.json, mdFile: p.md }
}

// ---- read --------------------------------------------------------------------------------------

/**
 * `{record}` or `{error}` for one JSON file; every way it can be wrong is a sentence for a report.
 * The record is the file plus `body`: the description under the name core/intake.gateStatusOf reads
 * its `**Gate:**` fallback from, so `admit(readTicket(k))` sees a gate line the labels did not carry.
 * The file itself keeps op-2's name, `description`, byte for byte.
 */
function readRecordFile(file, key) {
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
  if (d.key !== key) return { error: `carries key ${JSON.stringify(d.key)}, not its filename` }
  if (typeof d.title !== 'string' || !d.title) return { error: 'has no title' }
  if (typeof d.description !== 'string') return { error: 'has no description string' }
  // A cache with no label list (an op-2 feed, or one written before labels travelled) is "labels not
  // supplied", null — not a broken cache, and not `[]`, which would claim the issue carries none.
  return { record: { ...d, labels: Array.isArray(d.labels) ? d.labels : null, body: d.description } }
}

/**
 * One cached ticket, or null when it was never cached. A file that IS there but cannot be read
 * THROWS, naming the file and the reason: the caller asked for one specific key, and "absent" would
 * send a session to flag `tracker` over a cache the launcher can see on disk.
 *
 * Exact key only, on every platform: a lookup that differs from the cached key by case alone is
 * answered null even where the filesystem folds case, so a session and the launcher get the same
 * answer for the same string on Windows and on Linux.
 */
export function readTicket(key, { stateDir } = {}) {
  const p = ticketPaths(stateDir, key)
  if (!fs.existsSync(p.json)) return null
  const r = readRecordFile(p.json, key)
  if (r.error) {
    // The filesystem may have answered for another key's file (a case-folding volume): only when
    // OUR name is really in the directory is the mismatch a corrupt cache rather than a miss.
    if (!fs.readdirSync(ticketsDir(stateDir)).includes(`${key}.json`)) return null
    throw new Error(`tickets: cache ${p.json} ${r.error}`)
  }
  return { ...r.record, file: p.json, mdFile: p.md }
}

/**
 * Every cached ticket, by key, and every file in the directory that is NOT a whole cached ticket: a
 * JSON that will not parse, a JSON under the wrong name, a JSON with no `.md` twin, an `.md` with no
 * JSON (an interrupted cache write). Reported, never skipped — a launcher that believes a ticket is
 * cached spawns a session that finds nothing to read. A missing directory is an empty cache.
 * @returns {{tickets: Array<object>, unreadable: Array<{key, file, error}>}}
 */
export function listTickets({ stateDir } = {}) {
  const dir = ticketsDir(stateDir)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return { tickets: [], unreadable: [] }
    throw e
  }
  const tickets = []
  const unreadable = []
  const jsonKeys = new Set()
  for (const name of names) {
    if (!name.endsWith('.json')) continue // `.md` twins are checked below; `.tmp` is an interrupted write of ours
    const key = name.slice(0, -'.json'.length)
    const file = path.join(dir, name)
    if (!KEY_RE.test(key)) {
      unreadable.push({ key, file, error: 'is not named <KEY>.json, so it is not a cached ticket' })
      continue
    }
    jsonKeys.add(key)
    const r = readRecordFile(file, key)
    if (r.error) {
      unreadable.push({ key, file, error: r.error })
      continue
    }
    const md = path.join(dir, `${key}.md`)
    if (!fs.existsSync(md)) {
      unreadable.push({ key, file, error: 'has no .md twin — the file a descriptor\'s ticketFile points at is missing' })
      continue
    }
    tickets.push({ ...r.record, file, mdFile: md })
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const key = name.slice(0, -'.md'.length)
    const file = path.join(dir, name)
    // The same rule as the JSON sweep: a name that is not a key is not a cached ticket, whatever its
    // extension — `bad key.md` is a stray file, not an interrupted write to cache again.
    if (!KEY_RE.test(key)) {
      unreadable.push({ key, file, error: 'is not named <KEY>.md, so it is not a cached ticket' })
      continue
    }
    if (jsonKeys.has(key)) continue
    unreadable.push({ key, file, error: 'has no .json record — an interrupted cache write; cache the ticket again' })
  }
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return { tickets: tickets.sort(byKey), unreadable: unreadable.sort(byKey) }
}
