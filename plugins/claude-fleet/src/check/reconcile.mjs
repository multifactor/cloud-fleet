// Reconciling against the system of record — the tracker — before a filing batch, and the frame
// arithmetic that makes a gate's denominator a fact rather than a claim. PURE: pages, rows and
// changed paths are injected, and nothing here reads a file or calls a tracker. The I/O belongs to
// the contract §7 commands this module is written for (`fleet check reconcile tracker --pages`,
// `frame check`, `blast-radius`); the `--pages` page shape is the one assertComplete() documents.
//
// ⛔ Never track "what have I already filed" in a hand-kept file or a running tally — both drift, and
// the failure mode is DUPLICATE tickets (a hand-kept index once under-reported by 4; a conversational
// tally drifted from an actual 296 to a believed 275). Ask the tracker at the START of every batch.
//
// ⛔ A page that returns exactly its `limit` with no explicit completeness signal is truncated by
// definition: `limit` is a page size, not a total, and a full page comes back with no error and no
// ellipsis. An exactly-250 page once made a reconcile report 338 unfiled including an "unfiled Urgent"
// that had been filed hours earlier — a truncated FILED set makes real work look undone.
//
// ⛔ Join a ticket to its PR on the `**PR:**` header line, never the title: titles are rewritten at
// filing time, and a title matcher once recognised only 28 of 100 issues it had demonstrably created.
//
// ⛔ Match a blast radius on the FULL path: a basename match claimed 66 findings where the truth was
// 24, because `page.tsx` exists in 134 places.
//
// ⛔ A gate's work-list must be machine-derived from the attribute that defines the gate: "22 of 22
// done" once hid a frame of 58 because the list was hand-kept, and a gate reports 100% of its input,
// always — completeness is not observable from inside the gate.

import { joinToPr, normalisePriority } from './findings.mjs'
import { parseFid } from './fid.mjs'
import { ENUMS } from '../trackers/registry.mjs'

export const PRIORITY_BANDS = [1, 2, 3, 4]
/** Contract §6's completeness mechanisms — the registry's copy, so the two lists cannot drift. */
export const FIND_COMPLETE = ENUMS.findComplete

/** A band identity: canonical 1..4, or `null` for the no-priority band. Throws on anything else. */
const normaliseBand = p => (p === null ? null : normalisePriority(p))

const bandLabel = priority => (priority === null ? 'no priority' : `priority ${priority}`)

/**
 * The op-16 findIssues queries to run, one per priority band, so each fits in one page.
 * `selector` is the op-16 argument shape (group, labels, state, parentIsNull, …); any `priority`,
 * `limit` or `band` on it is replaced, because the band IS the priority and the limit is what a page
 * is judged against. A `null` in `priorities` is the NO-PRIORITY band — the rows carrying none of the
 * four priority values (a labels-scale tracker's unlabelled issues). Contract §6 gives op-16 no
 * spelling for "no priority" (`priority?` is optional; an explicit null renders as `priority.map[null]`
 * in jira.md's JQL and passes straight through linear.md's call), so that band is emitted as the query
 * WITHOUT a `priority` — the provenance-label query, the whole set — marked `band: null`. The marker
 * is for assertComplete (bandOfPage reads it back off the page's `query`), not an op-16 argument, and
 * the CLI subtracts the four banded pages from that page the way github.md's op-16 describes.
 */
export function bandQueries(selector, { priorities = PRIORITY_BANDS, limit } = {}) {
  // A query without a limit cannot be judged against its size, which is the whole check.
  if (!Number.isInteger(limit) || limit < 1) throw new Error('bandQueries: a positive integer limit is required — a page cannot be checked against a size it never declared')
  if (!Array.isArray(priorities) || !priorities.length) throw new Error('bandQueries: at least one priority band is required')
  const bands = priorities.map(normaliseBand)
  // Two pages for one band double-count it when the pages are combined.
  if (new Set(bands).size !== bands.length) throw new Error('bandQueries: a priority band may appear once')
  const base = { ...(selector || {}) }
  delete base.priority
  delete base.limit
  delete base.band
  return bands.map(priority => (priority === null ? { ...base, band: null, limit } : { ...base, priority, limit }))
}

/**
 * The band a page belongs to: `band` (the no-priority marker bandQueries emits) or `priority` on the
 * page, else on the bandQueries object it carries as `query`. The value is normalised the way
 * bandQueries normalises it — a hand-assembled `--pages` carries `'High'` or `'2'` as readily as `2`,
 * and an un-normalised identity makes the same band "never queried" under one spelling and
 * double-counted under two. An explicit `null` in either key is the no-priority band; a page carrying
 * neither key is unbanded.
 */
function bandOfPage(page) {
  let raw
  for (const o of [page, page.query]) {
    if (!o || typeof o !== 'object') continue
    if (o.band !== undefined) { raw = o.band; break }
    if (o.priority !== undefined) { raw = o.priority; break }
  }
  if (raw === undefined) return { banded: false, priority: null, reason: null }
  if (raw === null) return { banded: true, priority: null, reason: null }
  try {
    return { banded: true, priority: normalisePriority(raw), reason: null }
  } catch (e) {
    return { banded: false, priority: null, reason: `${e.message} — the page cannot be assigned to a band` }
  }
}

const RAW_FIELDS = {
  'page-flag': 'has-more flag (hasNextPage · isLast · nextPageToken · next_page)',
  total: 'total',
  'link-header': 'next link or exit code',
  'all-at-once': 'dropped count',
}

/**
 * The raw signal a page carries, read the way each adapter's op-16 Call: line derives `complete`
 * from it — or null when the page carries none. EVERY field present is read, whatever mechanism the
 * adapter's front matter declares: jira.md declares `page-flag` and its Call: line still derives
 * `complete` from `total` on a self-hosted site, so a `total` travelling beside a `complete: true` is
 * evidence too. A field saying "more pages" outranks one saying "last page".
 *   page-flag    `hasNextPage === false` · `isLast === true` · `nextPageToken` present and empty ·
 *                `next_page === null`
 *   total        `issues.length >= total` — op-16 returns the WHOLE set as `issues[]` (contract §6),
 *                so `startAt` never enters the arithmetic: a page carrying the last window of a walk
 *                (`startAt` 200, 40 rows, `total` 240) is short by 200 rows, and judging it complete
 *                is the phantom backlog that re-files 200 duplicates
 *   link-header  `next === null` (no rel="next" link) · `exitCode === 0` (the paginated run followed
 *                every link itself)
 *   all-at-once  `dropped === 0` (the local limit cut nothing)
 */
function rawSignal(page) {
  const more = reason => ({ complete: false, reason })
  const done = () => ({ complete: true, reason: null })
  const signals = []
  // page-flag
  if (page.hasNextPage === false) signals.push(done())
  else if (page.hasNextPage === true) signals.push(more('hasNextPage is true — more pages follow'))
  if (page.isLast === true) signals.push(done())
  else if (page.isLast === false) signals.push(more('isLast is false — more pages follow'))
  if (page.nextPageToken !== undefined) signals.push(page.nextPageToken ? more('a nextPageToken is present — more pages follow') : done())
  if (page.next_page !== undefined) signals.push(page.next_page === null ? done() : more('next_page is not null — more pages follow'))
  // total
  if (typeof page.total === 'number') {
    const count = page.issues.length
    const window = typeof page.startAt === 'number' && page.startAt > 0 ? ` (startAt ${page.startAt}: a window of the walk, not the concatenated set)` : ''
    signals.push(count >= page.total ? done() : more(`${count} rows < total ${page.total}${window} — more pages follow`))
  }
  // link-header
  if (typeof page.next === 'string' && page.next) signals.push(more('a rel="next" link is present — more pages follow'))
  else if (page.next === null) signals.push(done())
  if (page.exitCode === 0) signals.push(done())
  // all-at-once
  if (typeof page.dropped === 'number') signals.push(page.dropped > 0 ? more(`the local limit dropped ${page.dropped} rows — the response was cut`) : done())
  if (!signals.length) return null
  return signals.find(s => !s.complete) || done()
}

/**
 * The limit a page was asked with: on the page, else on its `query`. A hand-assembled `--pages`
 * carries `'250'` as readily as `250`, so a digit string is coerced the way normalisePriority coerces
 * one; anything else comes back as it was so the reason can name it.
 */
function limitOf(page) {
  const raw = page.limit ?? (page.query && page.query.limit)
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw)
  return raw
}

/**
 * Judge one page. A page carries `issues[]`, the `limit` it was asked with (or the bandQueries object
 * as `query`), and the `complete` boolean op-16 returns (contract §6) — every adapter's Call: line
 * derives it from the mechanism its `findComplete` names, so `complete` IS the signal. The raw field
 * behind it may travel too (rawSignal), and when it does it is read first: it is the evidence the
 * boolean was derived from, and a `complete: true` beside a `hasNextPage: true` (or a `total` the rows
 * fall short of) was typed, not derived. An explicit `complete: false` is never overruled — "I stopped
 * paging" is incomplete whatever the last page said.
 *
 * With neither `complete` nor a raw field, a page at its limit is truncated by definition and a
 * short one is unproven — an absent signal is never "last page". The one exception is all-at-once,
 * where the tracker never pages and a response short of the limit is proof by construction.
 */
function judgePage(page, findComplete) {
  const fail = reason => ({ complete: false, reason })
  const ok = () => ({ complete: true, reason: null })
  if (!Array.isArray(page.issues)) return fail('no issues[] array on the page')
  const count = page.issues.length
  const limit = limitOf(page)
  if (limit == null) return fail('no limit recorded on the page — it cannot be judged against a size it never declared')
  if (!Number.isInteger(limit) || limit < 1) return fail(`limit ${JSON.stringify(limit)} is not a positive integer — the page cannot be judged against a size it never declared`)
  // A listing that stopped early (a 403 mid-pagination) prints rows and then fails; however many rows
  // it printed, the set is short.
  if (page.exitCode !== undefined && page.exitCode !== 0) return fail(`the listing exited ${page.exitCode} — a run that stopped early is incomplete however many rows it printed`)
  if (page.complete === false) return fail('the adapter reported complete:false — a walk that stopped is not the whole set')
  const raw = rawSignal(page)
  if (raw) {
    if (!raw.complete && page.complete === true) return fail(`${raw.reason} — the page's complete:true contradicts its own signal`)
    return raw
  }
  if (page.complete === true) return ok()
  if (findComplete === 'all-at-once' && count < limit) return ok()
  if (count >= limit) return fail(`returned ${count} rows against a limit of ${limit} with no completeness signal — truncated by definition`)
  return fail(`no complete flag and no ${RAW_FIELDS[findComplete]} on the page — completeness unproven (${findComplete} adapter)`)
}

/**
 * Assert `complete` on EVERY band before combining, and refuse to combine otherwise.
 * @param {Array<{priority?: number|string|null, limit?: number, query?: object, issues: object[], complete?: boolean,
 *   hasNextPage?, isLast?, nextPageToken?, next_page?, startAt?, total?, next?, exitCode?, dropped?}>} pages
 *   one per op-16 call: the band (`priority`, or the bandQueries object as `query`), the `limit` it was
 *   asked with, its `issues[]`, the `complete` op-16 returned, and optionally the raw field behind it.
 * @param {{findComplete: string, priorities?: Array<number|string|null>|null}} opts  `priorities` = the
 *   bands that must be present (a band never queried is as absent from the filed set as a truncated
 *   one). Defaults to the four PRIORITY_BANDS — the playbook asserts complete on EVERY band before
 *   combining, so a caller that forgets the option cannot combine three of four (or one unbanded page)
 *   into "the filed set"; pass `null` or `[]` to opt out and judge only the pages given. A `null`
 *   entry names the no-priority band.
 * @returns {{complete: boolean, reason: string|null, total: number|null, issues: object[], bands: object[], warn: string|null}}
 *   `total` and `issues` are null/empty unless every band is complete — a subtraction cannot tell
 *   you a side was short, so an incomplete set is never handed to one. `warn` is set when a complete
 *   set is EMPTY: a zero and a broken query (a drifted group id or provenance label) look identical,
 *   and against an empty filed set unfiledCandidates re-files the whole batch as duplicates.
 */
export function assertComplete(pages, { findComplete, priorities = PRIORITY_BANDS } = {}) {
  if (!FIND_COMPLETE.includes(findComplete)) throw new Error(`assertComplete: findComplete must be one of ${FIND_COMPLETE.join('|')}, got "${findComplete}"`)
  const wanted = Array.isArray(priorities) ? priorities.map(normaliseBand) : []
  const list = Array.isArray(pages) ? pages : []
  const bands = []
  const seen = new Set()
  for (const [i, page] of list.entries()) {
    // `--pages` is hand-assembled: a null or scalar entry is a judged failure, not a TypeError.
    if (!page || typeof page !== 'object') {
      bands.push({ priority: null, label: `page ${i + 1}`, count: null, limit: null, complete: false, reason: 'not an object — a --pages entry is a page {issues[], limit, complete}' })
      continue
    }
    const band = bandOfPage(page)
    const label = band.banded ? bandLabel(band.priority) : `page ${i + 1}`
    if (band.banded) {
      if (seen.has(band.priority)) throw new Error(`assertComplete: ${label} appears twice — two pages for one band double-count it`)
      seen.add(band.priority)
    }
    const j = band.reason ? { complete: false, reason: band.reason } : judgePage(page, findComplete)
    bands.push({
      priority: band.priority,
      label,
      count: Array.isArray(page.issues) ? page.issues.length : null,
      limit: page.limit ?? (page.query && page.query.limit) ?? null,
      complete: j.complete,
      reason: j.reason,
    })
  }
  const missing = wanted.filter(p => !seen.has(p))
  const bad = bands.filter(b => !b.complete)
  if (!list.length || bad.length || missing.length) {
    // An empty page set still names every band it was asked for — "no pages" alone hides which.
    const reasons = [
      ...(list.length ? [] : ['no pages']),
      ...bad.map(b => `${b.label}: ${b.reason}`),
      ...missing.map(p => `${bandLabel(p)}: no page — the band was never queried`),
    ]
    return { complete: false, reason: reasons.join('; '), total: null, issues: [], bands, warn: null }
  }
  const issues = []
  const keys = new Set()
  for (const page of list) {
    for (const it of page.issues) {
      const k = it && (it.key ?? it.id)
      if (k != null) { if (keys.has(String(k))) continue; keys.add(String(k)) }
      issues.push(it)
    }
  }
  const warn = issues.length === 0 ? 'the combined filed set is empty — confirm the query ran (group, provenance label) before reading this as "nothing filed": against an empty filed set every candidate reads as unfiled and the whole batch is re-filed as duplicates' : null
  return { complete: true, reason: null, total: issues.length, issues, bands, warn }
}

/**
 * Join filed issues to their PRs on the `**PR:**` header line via findings.joinToPr — never a
 * document-wide scan (a good body cites related PRs in prose) and never the title (rewritten at
 * filing time, and a `#<n>` in a title is prose too).
 *
 * The rows are op-2 getIssue rows — `{key,id,title,description,…}` (contract §6) — NOT the rows of an
 * op-16 page: no shipped adapter's op-16 Call: line returns a body (linear.md's field list stops at
 * `url`, github.md's --jq at `sub_issues_total`, jira.md's fields at `created`, asana.md and trello.md
 * map to `{key,id,title,priority,status,parentId}`), so the caller op-2s every key of the combined
 * assertComplete() set before joining. A row handed over without its body attributes nothing, and
 * the reason names that step rather than guessing from the title.
 * @param {Array<{key?, id?, description?: string, body?: string}>} issues  op-2 rows; `body` — the
 *   write-side name op-13/op-14 use — is read too, so a row built from the filing payload joins
 * @returns {{byPr: Record<string, string[]>, unattributed: Array<{key: string, reason: string}>}}
 */
export function joinFiledToPrs(issues) {
  const byPr = {}
  const unattributed = []
  for (const issue of issues || []) {
    const key = String(issue.key ?? issue.id ?? '')
    const body = issue.description ?? issue.body
    if (body == null) { unattributed.push({ key, reason: 'no body — op-16 rows carry none; fetch the row with op-2 getIssue (its description) before joining. The header line is the only join key; the title is never read' }); continue }
    const prs = joinToPr(body)
    if (!prs.length) { unattributed.push({ key, reason: 'no **PR:** header line' }); continue }
    // A tracker auto-embeds the PR link, so the header line repeats the number (`#1240 — [acme/app#1240](…)`)
    // and joinToPr returns it twice; a key is attributed to a PR once.
    for (const pr of new Set(prs)) (byPr[pr] ||= []).push(key)
  }
  return { byPr, unattributed }
}

/**
 * What a batch may file: the candidates whose opaque `fid` is not in the filed set. By fid, NEVER by
 * title similarity — a title matcher scored 28 of 100 created issues as unfiled and would have
 * re-filed 72 duplicates. A row on either side without a fid is an error, not a fallback.
 * @param {Array<{fid: string}>} findings     candidates about to be filed — THIS batch, not the slice
 * @param {Array<{fid: string, key?}>} filedIssues  rows that record a fid (the filed/<slice>.tsv rows)
 * @param {{slice?: string|null}} opts  the slice whose filed file was read. When given, a filed row
 *   whose fid names another slice is an error: the wrong filed/<slice>.tsv was read, and against the
 *   wrong file every candidate reads as unfiled and gets re-filed.
 * @returns {{unfiled: object[], alreadyFiled: object[], unknownFids: string[]}}
 *   `unknownFids` = filed rows this batch's candidates do not account for. INFORMATIONAL: the
 *   reconcile runs at the start of every batch and filed/<slice>.tsv accumulates across them, so from
 *   the second batch on every earlier row lands here. It is not evidence of a wrong file — `slice` is.
 */
export function unfiledCandidates(findings, filedIssues, { slice = null } = {}) {
  const filedFids = new Set()
  for (const r of filedIssues || []) {
    if (!r || !r.fid) throw new Error(`unfiledCandidates: filed row ${JSON.stringify(r && r.key)} has no fid — a filed row that cannot be joined reads as unfiled and gets re-filed`)
    const fid = String(r.fid)
    if (slice != null) {
      const parsed = parseFid(fid)
      if (!parsed) throw new Error(`unfiledCandidates: filed row ${JSON.stringify(r.key)} carries "${fid}", which is not a fid — a filed row that cannot be joined reads as unfiled and gets re-filed`)
      if (parsed.slice !== String(slice)) throw new Error(`unfiledCandidates: filed row ${JSON.stringify(r.key)} carries fid "${fid}" from slice "${parsed.slice}", not "${slice}" — the wrong filed/<slice>.tsv was read, and against it every candidate reads as unfiled`)
    }
    filedFids.add(fid)
  }
  const unfiled = []
  const alreadyFiled = []
  const candidateFids = new Set()
  for (const f of findings || []) {
    if (!f || !f.fid) throw new Error(`unfiledCandidates: candidate ${JSON.stringify(f && f.title)} has no fid — join on the opaque fid, never on the title`)
    const fid = String(f.fid)
    // Two candidates for one fid (a hand-edited findings file, a re-minted range) are two op-13
    // creates for one finding, and the four-count then fails after the duplicate is already filed.
    if (candidateFids.has(fid)) throw new Error(`unfiledCandidates: candidate fid "${fid}" appears twice in this batch — two candidates for one fid are two op-13 creates for one finding`)
    candidateFids.add(fid)
    ;(filedFids.has(fid) ? alreadyFiled : unfiled).push(f)
  }
  const unknownFids = [...filedFids].filter(x => !candidateFids.has(x))
  return { unfiled, alreadyFiled, unknownFids }
}

/** Repo-root-relative form: forward slashes, no `./` prefix. Case is preserved — a path is a name. */
export function normalisePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

/**
 * The findings whose `where[].path` is among the changed paths, matched on the FULL path. There is
 * deliberately no basename fallback: `page.tsx` exists in 134 places, and a basename match claimed
 * 66 findings where the truth was 24. A bare filename in `where` therefore never matches a nested
 * path — that is the audit's "unverifiable" rule, not a bug.
 * @param {string[]} changedPaths   `git diff --name-only <snapshot>..origin/<base>`
 * @param {Array<{fid?, key?, where?: Array<{path: string}>}>} findings
 * @returns {{changed: number, matched: number, hits: Array<{fid, key, paths: string[]}>}}
 */
export function blastRadius(changedPaths, findings) {
  const changed = new Set((changedPaths || []).map(normalisePath).filter(Boolean))
  const hits = []
  for (const f of findings || []) {
    const where = Array.isArray(f.where) ? f.where : []
    const paths = [...new Set(where.map(w => normalisePath(w && w.path)).filter(p => p && changed.has(p)))]
    if (paths.length) hits.push({ fid: f.fid, key: f.key, paths })
  }
  return { changed: changed.size, matched: hits.length, hits }
}

const keysOf = (xs, name) => {
  const arr = xs instanceof Set ? [...xs] : Array.isArray(xs) ? xs : null
  if (!arr) throw new Error(`frameCheck: ${name} must be an array or Set of keys or rows`)
  return new Set(arr.map(x => (typeof x === 'string' ? x : x && (x.key ?? x.id))).filter(k => k != null).map(String))
}

/**
 * Assert the gate's work-list equals the machine-derived frame.
 * @param {{derived: Array|Set, gated: Array|Set, cancelled?: Array|Set, provenance?: string}} args
 *   `derived` = the keys op-16 returned for the attribute that defines the gate (after assertComplete);
 *   `gated` = the keys the gate actually judged; `cancelled` = the keys whose state type is `cancelled`
 *   (cancelled or duplicate-closed) — the audit is the one step that cancels, so its own cancellations
 *   legitimately sit in judged−frame; `provenance` = the query that built `derived`, so the denominator
 *   travels with the tally in the same sentence.
 * @returns {{ok: boolean, missing: string[], extra: string[], cancelled: string[], counts: {derived: number, gated: number}, summary: string, warn: string|null}}
 *   `missing` = in the frame, never gated (the 58-vs-22 hole); `extra` = LIVE rows judged outside the
 *   frame — the bug; `cancelled` = cancelled rows judged outside the frame — expected, never a failure.
 */
export function frameCheck({ derived, gated, cancelled = [], provenance = null } = {}) {
  const d = keysOf(derived, 'derived')
  const g = keysOf(gated, 'gated')
  const c = keysOf(cancelled, 'cancelled')
  const missing = [...d].filter(k => !g.has(k))
  const outside = [...g].filter(k => !d.has(k))
  const extra = outside.filter(k => !c.has(k))
  const cancelledOutside = outside.filter(k => c.has(k))
  const covered = g.size - outside.length
  const from = provenance ? `, derived from ${provenance}` : ''
  const summary = `${covered} of ${d.size} gated${from}; ${missing.length} never gated, ${extra.length} live outside the frame, ${cancelledOutside.length} cancelled outside the frame`
  // A zero and a broken harness look identical, so an empty frame is reported, never trusted.
  const warn = d.size === 0 ? 'the derived frame is empty — confirm the query ran before reading this as "nothing to gate"' : null
  return { ok: !missing.length && !extra.length, missing, extra, cancelled: cancelledOutside, counts: { derived: d.size, gated: g.size }, summary, warn }
}
