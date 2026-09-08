// Ticking work items in a tracker checklist — the human-visible mirror of the sweep ledger (op-27).
//
// PURE. Joins the ledger to the rows op-26 returned, builds the edit for one tick, groups a wave's
// ticks into ONE op-15 patchBody call, splits an oversized wave, and emulates the patch locally for
// trackers without an atomic one. No I/O here: the tracker is reached only through an outbox entry
// the launcher drains. Consumer pending: `fleet check tick plan` (contract §7) is where planTicks()
// meets the ledger and op-26; nothing imports this module yet.
//
// Rules encoded here, each a bug that happened:
//   * anchor on the ORIGINAL line op-26 returned (`raw`, byte-for-byte) — a bare `#<pr>` also
//     appears inside other PRs' titles on the same list, so an unanchored replace ticks the wrong row;
//   * a row is `- [ ] #<pr>` OR `- [ ] <PR URL>` — op-26 returns both shapes, so the PR is read with
//     worklist.parseItem rather than a second regex that could drift from what op-26 parses;
//   * two anchor shapes, two boundaries — a whole raw line must END its line (`- [ ] #2 two` is a
//     prefix of `- [ ] #2 two (renamed)`, and the keys would land mid-line), while a bare
//     `- [ ] #<pr>` prefix (the shape the read-modify-write adapters send) ends at a word boundary,
//     so `- [ ] #12` never matches the `- [ ] #123 …` row and the tracker does not reject the wave;
//   * every appended key is whole by the adapter's `issueKey.pattern` and backtick-wrapped — a key
//     truncated at a character offset (`ABC-1234` → `ABC-1`) autolinks to an unrelated issue on
//     trackers that autolink, and a bare key autolinks even when whole;
//   * N edits go in ONE call per wave — the response echoes the whole body every time, so one call
//     per tick pays ~25 KB per row;
//   * at most 50 edits per call — the call is rejected as a whole above that, and a rejected wave
//     leaves the mirror stale, which from outside is indistinguishable from a dead run;
//   * on the read-modify-write path every `find` must match exactly once and a miss is REPORTED —
//     a silently skipped edit is a mirror that quietly stops moving while the ledger says otherwise.

import { parseItem } from './worklist.mjs'
import { latestByPr } from './ledger.mjs'

/** One tracker caps patch ops per call at 50; a larger wave is split into consecutive calls. */
export const MAX_EDITS_PER_CALL = 50

// The unticked checkbox, in the same shape worklist.parseItem accepts (indent, `-` or `*` bullet).
// What follows it — `#<pr>` or a PR URL — is parseItem's call, not a second regex here.
const UNTICKED = /^(\s*[-*]\s*)\[ \]/
const TICKED = /^\s*[-*]\s*\[[xX]\]/
// A bare `- [ ] #<pr>` with nothing after the number: the prefix anchor shape, as opposed to a whole line.
const BARE_PREFIX = /^\s*[-*]\s*\[ \]\s*#\d+$/
// The contract's issue key (§6 front matter); the resolved adapter's `issueKey` is passed in over it.
const DEFAULT_ISSUE_KEY = { pattern: '[A-Z][A-Z0-9]+-[0-9]+', caseInsensitive: false }

function wholeKeyRegex(issueKey) {
  if (!issueKey || !issueKey.pattern) throw new Error('tickEdit: issueKey.pattern is required — the adapter front matter declares it')
  return new RegExp(`^(?:${issueKey.pattern})$`, issueKey.caseInsensitive ? 'i' : '')
}

/**
 * The op-15 edit that ticks one work item: `{find, replace}`.
 * `raw` is the line op-26 returned, byte-for-byte; it becomes `find` unchanged, and the rest of the
 * line survives verbatim in `replace` with the keys appended.
 * @param {{pr: string|number, keys?: string[], raw: string}} item
 * @param {{issueKey?: {pattern: string, caseInsensitive?: boolean}}} [opts]  the adapter's `issueKey`
 */
export function tickEdit({ pr, keys = [], raw }, { issueKey = DEFAULT_ISSUE_KEY } = {}) {
  const line = String(raw ?? '')
  // A CRLF body split on `\n` leaves `\r` on the line; the keys go before it, not on the next line.
  const eol = line.endsWith('\r') ? '\r' : ''
  const core = eol ? line.slice(0, -1) : line
  const item = parseItem(core)
  if (!item) throw new Error(`tickEdit: line does not begin with "- [ ] #<pr>" or "- [ ] <PR URL>": ${JSON.stringify(line)}`)
  if (item.done) {
    if (item.pr === String(pr)) throw new Error(`tickEdit: #${pr} is already ticked — a re-tick is a caller bug, not a no-op`)
    throw new Error(`tickEdit: line is #${item.pr} (already ticked), not #${pr} — ticking it would mark the wrong row`)
  }
  if (item.pr !== String(pr)) throw new Error(`tickEdit: line is #${item.pr}, not #${pr} — ticking it would mark the wrong row`)
  const KEY = wholeKeyRegex(issueKey)
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY.test(k)) {
      throw new Error(`tickEdit: key ${JSON.stringify(k)} is not a whole issue key — a truncated key autolinks to an unrelated issue`)
    }
  }
  const m = UNTICKED.exec(core)
  const flipped = `${m[1]}[x]${core.slice(m[1].length + 3)}`
  const suffix = keys.length ? ` (${keys.map(k => `\`${k}\``).join(', ')})` : ''
  return { find: line, replace: flipped + suffix + eol }
}

/**
 * The ticks a wave owes — what `fleet check tick plan` lists: the ledger's latest outcome per PR
 * (rows are `{pr, status, keys, at, note}`; every status ticks, exactly as the ledger's resume
 * arithmetic counts every row as done) joined on `pr` to the rows op-26 returned
 * (`{pr, done, keys, raw}`). The keys come from the ledger row — an op-26 `keys` is what is already
 * on the line. A row already ticked is `mirrored` (the resume case: the ledger holds every wave, the
 * mirror already shows the earlier ones), a ledger PR with no row is `unmatched`, and a PR with two
 * rows on the list is `duplicated` — never ticked: last-row-wins would flip the outcome with row
 * order, and on the atomic-patch path an anchor that matches twice rejects the whole call. All three
 * are REPORTED rather than thrown, because one odd row must not hold up the wave's other ticks.
 * @returns {{items: Array<{pr: string, keys: string[], raw: string}>, mirrored: string[], unmatched: string[], duplicated: string[]}}
 */
export function planTicks(ledgerEntries, workItems) {
  const rows = new Map()
  const twice = new Set()
  for (const w of workItems) {
    const pr = String(w.pr)
    if (rows.has(pr)) twice.add(pr)
    else rows.set(pr, w)
  }
  const items = []
  const mirrored = []
  const unmatched = []
  const duplicated = []
  for (const [pr, entry] of latestByPr(ledgerEntries)) {
    const row = rows.get(pr)
    if (!row) { unmatched.push(pr); continue }
    if (twice.has(pr)) { duplicated.push(pr); continue }
    if (row.done) { mirrored.push(pr); continue }
    items.push({ pr, keys: entry.keys || [], raw: row.raw })
  }
  return { items, mirrored, unmatched, duplicated }
}

/**
 * Every tick of one wave as the `edits` of ONE op-15 call.
 * A PR twice in one wave is refused: the second anchor cannot match once the first applied, and one
 * failing edit rejects the whole call — pass the latest ledger entry per PR (planTicks does).
 */
export function batchEdits(items, opts) {
  const seen = new Set()
  const edits = []
  for (const item of items) {
    const pr = String(item.pr)
    if (seen.has(pr)) throw new Error(`batchEdits: #${pr} appears twice in one wave — pass the latest ledger entry per PR`)
    seen.add(pr)
    edits.push(tickEdit(item, opts))
  }
  return edits
}

/** Split a wave into consecutive calls of at most `max` edits, in order. */
export function chunk(edits, max = MAX_EDITS_PER_CALL) {
  // A non-array wave must not become zero calls: `chunk('abc')` would yield ['abc'] and `chunk({})` [].
  if (!Array.isArray(edits)) throw new Error(`chunk: edits must be an array, got ${typeof edits}`)
  if (!Number.isInteger(max) || max < 1) throw new Error(`chunk: max must be a positive integer, got ${max}`)
  const out = []
  for (let i = 0; i < edits.length; i += max) out.push(edits.slice(i, i + max))
  return out
}

// Occurrences of `find` that start a line and end where its shape says: a whole raw line ends its
// line (`\r`, `\n` or EOF); a bare `- [ ] #<pr>` prefix ends at a word boundary. A raw line that IS
// a bare prefix (a row with no title) takes the prefix rule. Rows, not substrings: a copy of the line
// that only appears INSIDE another line — an indented (nested) copy, a title quoting it — is not a
// hit, so this applies where a native substring patch would reject the pair.
function anchoredOccurrences(text, find) {
  const hits = []
  if (!find) return hits
  const wordBounded = BARE_PREFIX.test(find)
  let i = text.indexOf(find)
  while (i !== -1) {
    const atLineStart = i === 0 || text[i - 1] === '\n'
    const next = text[i + find.length]
    const bounded = next === undefined || (wordBounded ? !/[0-9A-Za-z]/.test(next) : next === '\n' || next === '\r')
    if (atLineStart && bounded) hits.push(i)
    i = text.indexOf(find, i + 1)
  }
  return hits
}

/**
 * Emulate op-15 for a tracker without an atomic patch (read-modify-write under the
 * `tracker-worklist:<KEY>` lock). Edits apply in order against the current text; an edit whose
 * `find` is not present exactly once as a ROW is reported in `missing` with its hit count (0 = the
 * line changed under us, grown or shrunk; 2+ = the same row twice) rather than silently skipped.
 * A malformed edit (a non-string `find` or `replace`) THROWS — this is the last line before the body
 * is written, and splicing a missing `replace` writes the literal word "undefined" over the row and
 * counts it as applied.
 * The caller then verifies with verifyTicked() that the `- [x]` count grew by exactly N.
 * @returns {{body: string, applied: number, missing: Array<{find: string, count: number}>}}
 */
export function applyEditsToBody(body, edits) {
  let text = String(body ?? '')
  let applied = 0
  const missing = []
  for (const e of edits) {
    if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string') {
      throw new Error(`applyEditsToBody: edit needs string find and replace, got ${JSON.stringify(e)}`)
    }
    const hits = anchoredOccurrences(text, e.find)
    if (hits.length !== 1) { missing.push({ find: e.find, count: hits.length }); continue }
    text = text.slice(0, hits[0]) + e.replace + text.slice(hits[0] + e.find.length)
    applied++
  }
  return { body: text, applied, missing }
}

/** Number of ticked checklist lines (`- [x]` / `- [X]`, either bullet). */
export function tickedCount(body) {
  return String(body ?? '').split(/\r?\n/).filter(l => TICKED.test(l)).length
}

/**
 * The post-write check: the ticked count must have grown by exactly the number of edits sent.
 * A blind retry is how duplicate ticks and stale mirrors get made — count, never retry.
 * `expected` must be a non-negative integer: a string count from argv (`'2'`) would make `ok` false
 * forever under the strict compare, and "count, never retry" then reports a permanently stale mirror.
 */
export function verifyTicked(beforeBody, afterBody, expected) {
  if (!Number.isInteger(expected) || expected < 0) throw new Error(`verifyTicked: expected must be a non-negative integer, got ${JSON.stringify(expected)}`)
  const before = tickedCount(beforeBody)
  const after = tickedCount(afterBody)
  return { ok: after - before === expected, before, after, expected, grewBy: after - before }
}
