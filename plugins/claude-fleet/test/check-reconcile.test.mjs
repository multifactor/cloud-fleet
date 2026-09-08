import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './helpers/prose.mjs'
import { bandQueries, assertComplete, joinFiledToPrs, unfiledCandidates, blastRadius, normalisePath, frameCheck, PRIORITY_BANDS, FIND_COMPLETE } from '../src/check/reconcile.mjs'
import { makeFid } from '../src/check/fid.mjs'
import { listAdapters, loadAdapter, parseAdapter, ENUMS } from '../src/trackers/registry.mjs'

const BUNDLED = path.join(ROOT, 'trackers')
const issues = (n, base = 1000) => Array.from({ length: n }, (_, i) => ({ key: `ABC-${base + i}`, title: `finding ${base + i}` }))
const selector = { group: 'proj-uuid', labels: ['filed-by:fleet-check'] }

// ---- bandQueries -------------------------------------------------------------------------------

// Banding is what makes each band fit in one page: a single group-wide query once came back as
// exactly 250 rows. One op-16 call per priority, each carrying the selector and the limit.
test('bandQueries: one op-16 query per priority band, each with the selector and its limit', () => {
  const qs = bandQueries(selector, { limit: 250 })
  assert.deepEqual(qs.map(q => q.priority), PRIORITY_BANDS)
  assert.deepEqual(qs[0], { group: 'proj-uuid', labels: ['filed-by:fleet-check'], priority: 1, limit: 250 })
  // the selector's own priority/limit are replaced, never merged with the band
  assert.deepEqual(bandQueries({ ...selector, priority: 3, limit: 10 }, { priorities: ['High'], limit: 100 }), [{ group: 'proj-uuid', labels: ['filed-by:fleet-check'], priority: 2, limit: 100 }])
})

// A query without a limit cannot be judged against its size, which is the whole check; a repeated
// band would double-count when the pages are combined.
test('bandQueries refuses a missing limit, a bad priority, and a repeated band', () => {
  assert.throws(() => bandQueries(selector, {}), /limit is required/)
  assert.throws(() => bandQueries(selector, { limit: 0 }), /limit is required/)
  assert.throws(() => bandQueries(selector, { priorities: [5], limit: 10 }), /outside 1..4/)
  assert.throws(() => bandQueries(selector, { priorities: [1, 'Urgent'], limit: 10 }), /may appear once/)
  assert.throws(() => bandQueries(selector, { priorities: [], limit: 10 }), /at least one/)
})

// A labels-scale tracker's unlabelled issues form a fifth band (the adapter says "query by the
// provenance label, subtract the four bands"). `null` names it. Contract §6 gives op-16's `priority?`
// no null spelling (jira.md would render `priority.map[null]`), so bandQueries emits that band as the
// query WITHOUT a priority — the whole provenance set — marked `band: null` for assertComplete, which
// requires it like any other band.
test('a null band is the no-priority band: bandQueries emits it without a priority and assertComplete requires it', () => {
  const five = [...PRIORITY_BANDS, null]
  const qs = bandQueries(selector, { priorities: five, limit: 100 })
  assert.equal(qs.length, 5)
  assert.deepEqual(qs[4], { group: 'proj-uuid', labels: ['filed-by:fleet-check'], band: null, limit: 100 })
  assert.equal('priority' in qs[4], false, 'an explicit priority: null is not an op-16 argument any adapter renders')
  assert.throws(() => bandQueries(selector, { priorities: [null, null], limit: 100 }), /may appear once/)
  const four = qs.slice(0, 4).map(query => ({ query, issues: [], complete: true }))
  const r = assertComplete(four, { findComplete: 'link-header', priorities: five })
  assert.equal(r.complete, false)
  assert.match(r.reason, /no priority: no page — the band was never queried/)
  const unlabelled = { query: qs[4], issues: issues(3), complete: true }
  const all = assertComplete([...four, unlabelled], { findComplete: 'link-header', priorities: five })
  assert.equal(all.complete, true)
  assert.equal(all.total, 3)
  assert.equal(all.bands[4].label, 'no priority')
  assert.throws(() => assertComplete([...four, unlabelled, { priority: null, limit: 100, issues: [], complete: true }], { findComplete: 'link-header' }), /no priority appears twice/)
  // a page with no priority key at all is unbanded, not the no-priority band
  const unbanded = assertComplete([{ limit: 10, issues: [], complete: true }], { findComplete: 'page-flag', priorities: null })
  assert.equal(unbanded.bands[0].label, 'page 1')
  assert.equal(unbanded.complete, true)
})

// ---- assertComplete ----------------------------------------------------------------------------

// The phantom Urgent: a page of exactly 250 with no flag was reconciled as the whole filed set, and
// the subtraction "invented" an unfiled Urgent that had been filed hours earlier. Exactly-limit with
// no signal is truncated by definition, and an incomplete set is never handed to a subtraction.
test('a band returning exactly its limit with no completeness signal is TRUNCATED, and nothing is combined', () => {
  const pages = [
    { priority: 1, limit: 250, issues: issues(3, 100), hasNextPage: false },
    { priority: 2, limit: 250, issues: issues(250, 1000) },        // full page, flag never read
    { priority: 3, limit: 250, issues: issues(44, 2000), hasNextPage: false },
    { priority: 4, limit: 250, issues: [], hasNextPage: false },
  ]
  const r = assertComplete(pages, { findComplete: 'page-flag', priorities: PRIORITY_BANDS })
  assert.equal(r.complete, false)
  assert.match(r.reason, /priority 2: returned 250 rows against a limit of 250 with no completeness signal — truncated by definition/)
  assert.equal(r.total, null, 'a truncated set must not be subtractable')
  assert.deepEqual(r.issues, [])
  // the per-band counts and flags are still printed — a band silently at its cap is the failure
  assert.deepEqual(r.bands.map(b => [b.priority, b.count, b.complete]), [[1, 3, true], [2, 250, false], [3, 44, true], [4, 0, true]])

  // with the flag actually read, the same four pages combine to the true total
  pages[1].hasNextPage = false
  const ok = assertComplete(pages, { findComplete: 'page-flag', priorities: PRIORITY_BANDS })
  assert.equal(ok.complete, true)
  assert.equal(ok.reason, null)
  assert.equal(ok.total, 297)
  assert.equal(ok.issues.length, 297)
})

// op-16 returns {issues[], complete} (contract §6) and every adapter's Call: line derives `complete`
// from a raw field. One page per shipped adapter, shaped the way that Call: line emits it — full to
// the limit, so only the signal can prove it — must combine; the raw field alone must too; and a full
// page carrying neither is truncated whatever the adapter. Every raw field present is read whatever
// the front matter declares: jira.md declares `page-flag` and its Call: line still derives `complete`
// from `total` on a self-hosted site, so a short `total` beside a `complete: true` is the same
// contradiction as a `hasNextPage: true` beside one. The pages carry 100 rows.
const OP16_SHAPES = {
  linear: { done: [{ hasNextPage: false }], more: [{ hasNextPage: true }] },
  jira: {
    done: [{ isLast: true }, { nextPageToken: null }, { startAt: 0, total: 100 }],
    // the self-hosted REST form: 100 of a declared 240, from the first window and from the last one
    more: [{ isLast: false }, { nextPageToken: 'CAEaAggD' }, { startAt: 0, total: 240 }, { startAt: 140, total: 240 }],
  },
  asana: { done: [{ next_page: null }], more: [{ next_page: { offset: 'offset-page-2', path: '/tasks?offset=offset-page-2' } }] },
  github: { done: [{ exitCode: 0 }], more: [{ next: 'https://api.github.com/repos/acme/app/issues?page=2' }, { exitCode: 0, next: 'https://api.github.com/repos/acme/app/issues?page=2' }] },
  trello: { done: [{ dropped: 0 }], more: [{ dropped: 3 }] },
}
test('assertComplete honours the `complete` op-16 returns, and reads each shipped adapter\'s raw signal the way its Call: line does', () => {
  const ids = listAdapters({ bundledDir: BUNDLED })
  assert.deepEqual(ids, Object.keys(OP16_SHAPES).sort(), 'every shipped adapter has a row in the shape table')
  for (const id of ids) {
    const findComplete = loadAdapter(id, { bundledDir: BUNDLED }).front.capabilities.findComplete
    const page = extra => ({ priority: 1, limit: 100, issues: issues(100), ...extra })
    const opts = { findComplete, priorities: [1] }
    // the contract shape: what the adapter derived
    const contract = assertComplete([page({ complete: true })], opts)
    assert.equal(contract.complete, true, `${id}: {issues, complete:true} → ${contract.reason}`)
    assert.equal(contract.total, 100)
    const stopped = assertComplete([page({ complete: false })], opts)
    assert.equal(stopped.complete, false, `${id}: complete:false is never overruled`)
    assert.match(stopped.reason, /reported complete:false/)
    // the raw field behind it, alone
    for (const raw of OP16_SHAPES[id].done) {
      const r = assertComplete([page(raw)], opts)
      assert.equal(r.complete, true, `${id}: ${JSON.stringify(raw)} → ${r.reason}`)
      assert.equal(r.total, 100, `${id}: ${JSON.stringify(raw)} combines to the rows it carries`)
    }
    for (const raw of OP16_SHAPES[id].more) {
      const r = assertComplete([page(raw)], opts)
      assert.equal(r.complete, false, `${id}: ${JSON.stringify(raw)} must read as more pages`)
      assert.match(r.reason, /more pages follow|response was cut/)
      assert.equal(r.total, null)
      // a complete:true typed next to a raw "more pages" was not derived from it
      const typed = assertComplete([page({ ...raw, complete: true })], opts)
      assert.equal(typed.complete, false, `${id}: complete:true beside ${JSON.stringify(raw)}`)
      assert.match(typed.reason, /complete:true contradicts its own signal/)
    }
    // no signal at all: a full page is truncated by definition
    const none = assertComplete([page({})], opts)
    assert.equal(none.complete, false)
    assert.match(none.reason, /truncated by definition/)
  }
})

// A short page with no signal is unproven, not complete — an absent flag is never "last page" (the
// hosted-server build that returns no pagination metadata at all is the case).
test('a short page with neither `complete` nor a raw signal is unproven, never assumed complete', () => {
  const short = assertComplete([{ priority: 1, limit: 250, issues: issues(12) }], { findComplete: 'page-flag', priorities: [1] })
  assert.equal(short.complete, false)
  assert.match(short.reason, /no complete flag and no has-more flag .* completeness unproven \(page-flag adapter\)/)
  const full = assertComplete([{ priority: 1, limit: 250, issues: issues(250), hasNextPage: false }], { findComplete: 'page-flag', priorities: [1] })
  assert.equal(full.complete, true)
  assert.equal(full.total, 250)
})

// total: `issues.length >= total` is the proof — op-16 returns the WHOLE set as issues[] (contract §6),
// so `startAt` never enters the arithmetic. A page carrying the last window of a walk (startAt 200,
// 40 rows, total 240) satisfies `startAt + rows >= total` and is still 200 rows short: judged
// complete, the subtraction sees 40 of 240 filed and re-files 200 duplicates. The combined `total`
// must equal the tracker's `total` on every accepted page.
test('total: rows >= total proves completeness; a window of the walk, however far along, is not the set', () => {
  const opts = { findComplete: 'total', priorities: [2] }
  const whole = assertComplete([{ priority: 2, limit: 100, issues: issues(40), total: 40 }], opts)
  assert.equal(whole.complete, true)
  assert.equal(whole.total, 40, 'the combined total is the tracker\'s total')
  const full = assertComplete([{ priority: 2, limit: 100, issues: issues(100), startAt: 0, total: 100 }], opts)
  assert.equal(full.complete, true)
  assert.equal(full.total, 100)
  const short = assertComplete([{ priority: 2, limit: 100, issues: issues(100), startAt: 0, total: 240 }], opts)
  assert.equal(short.complete, false)
  assert.match(short.reason, /100 rows < total 240 — more pages follow/)
  assert.equal(short.total, null)
  // the last window: startAt + rows reaches the total and the page is 200 rows short of it
  const window = assertComplete([{ priority: 2, limit: 100, issues: issues(40), startAt: 200, total: 240 }], opts)
  assert.equal(window.complete, false)
  assert.match(window.reason, /40 rows < total 240 \(startAt 200: a window of the walk, not the concatenated set\) — more pages follow/)
  assert.equal(window.total, null)
  const typed = assertComplete([{ priority: 2, limit: 100, issues: issues(40), startAt: 200, total: 240, complete: true }], opts)
  assert.equal(typed.complete, false)
  assert.match(typed.reason, /complete:true contradicts its own signal/)
  const none = assertComplete([{ priority: 2, limit: 100, issues: issues(100) }], opts)
  assert.match(none.reason, /truncated by definition/)
})

// link-header: `next: null` means the rel="next" link was looked for and is absent; a URL means more
// pages; an exit-0 `--paginate` run followed every link itself; an undefined field is no signal. A
// paginated run that exited non-zero (a 403 mid-way) printed rows and then stopped — incomplete
// however many rows it printed, whatever else the page says.
test('link-header: no next link proves completeness; a failed paginated run is incomplete whatever it printed', () => {
  const opts = { findComplete: 'link-header', priorities: [3] }
  assert.equal(assertComplete([{ priority: 3, limit: 100, issues: issues(100), next: null }], opts).complete, true)
  assert.equal(assertComplete([{ priority: 3, limit: 100, issues: issues(100), exitCode: 0 }], opts).complete, true)
  assert.match(assertComplete([{ priority: 3, limit: 100, issues: issues(100), next: 'https://github.com/acme/app?page=2' }], opts).reason, /rel="next" link is present/)
  assert.match(assertComplete([{ priority: 3, limit: 100, issues: issues(7) }], opts).reason, /no complete flag and no next link or exit code/)
  const failed = assertComplete([{ priority: 3, limit: 100, issues: issues(140), next: null, complete: true, exitCode: 1 }], opts)
  assert.equal(failed.complete, false)
  assert.match(failed.reason, /exited 1 — a run that stopped early is incomplete/)
})

// all-at-once: the tracker never pages, so the only proof is that the response did not fill the limit
// — the banding rule still applies where a scope can exceed one response.
test('all-at-once: fewer than the limit is the only proof; at the limit is truncated', () => {
  const opts = { findComplete: 'all-at-once', priorities: [4] }
  assert.equal(assertComplete([{ priority: 4, limit: 1000, issues: issues(999) }], opts).complete, true)
  assert.match(assertComplete([{ priority: 4, limit: 1000, issues: issues(1000) }], opts).reason, /truncated by definition/)
  assert.throws(() => assertComplete([{ priority: 1, limit: 10, issues: [] }], { findComplete: 'guess' }), /must be one of/)
})

// The first reconcile against a tracker throws if its front matter names a mechanism this module
// does not judge — so every bundled adapter's `findComplete:` (the template included) must be one
// the module accepts. The module's list IS the registry's (contract §6's enum, one copy) — pinned
// here so the two cannot drift apart — and the adapters are the check that it is the list they use.
test('every bundled adapter declares a findComplete that assertComplete accepts', () => {
  assert.deepEqual(FIND_COMPLETE, ENUMS.findComplete, 'reconcile.mjs judges the mechanisms the registry validates, no more and no fewer')
  const files = fs.readdirSync(BUNDLED).filter(f => f.endsWith('.md'))
  assert.ok(files.length >= 6, `expected the template and the shipped adapters, got ${files.join(', ')}`)
  for (const f of files) {
    const a = parseAdapter(fs.readFileSync(path.join(BUNDLED, f), 'utf8'), { file: f })
    const fc = a.front.capabilities && a.front.capabilities.findComplete
    assert.ok(FIND_COMPLETE.includes(fc), `${f}: findComplete "${fc}" is not one of ${FIND_COMPLETE.join('|')}`)
    assert.equal(assertComplete([{ priority: 1, limit: 10, issues: [], complete: true }], { findComplete: fc, priorities: [1] }).complete, true, f)
  }
})

// A band never queried is as absent from the filed set as a truncated one; a band queried twice
// double-counts; a page that forgot its limit or its issues cannot be judged. Pages may carry the
// bandQueries object back as `query` instead of repeating priority and limit.
test('assertComplete refuses a missing band, a repeated band, and an unjudgeable page; pages may carry their query', () => {
  const [q1, q2, q3, q4] = bandQueries(selector, { limit: 50 })
  const three = [q1, q2, q3].map((query, i) => ({ query, issues: issues(2, 10 * i), hasNextPage: false }))
  const r = assertComplete(three, { findComplete: 'page-flag', priorities: PRIORITY_BANDS })
  assert.equal(r.complete, false)
  assert.match(r.reason, /priority 4: no page — the band was never queried/)
  assert.equal(assertComplete([...three, { query: q4, issues: [], hasNextPage: false }], { findComplete: 'page-flag', priorities: PRIORITY_BANDS }).total, 6)
  assert.throws(() => assertComplete([...three, { query: q1, issues: [], hasNextPage: false }], { findComplete: 'page-flag' }), /priority 1 appears twice/)
  assert.match(assertComplete([{ priority: 1, issues: issues(3), hasNextPage: false }], { findComplete: 'page-flag', priorities: [1] }).reason, /no limit recorded/)
  assert.match(assertComplete([{ priority: 1, limit: 10, hasNextPage: false }], { findComplete: 'page-flag', priorities: [1] }).reason, /no issues\[\] array/)
  assert.equal(assertComplete([], { findComplete: 'page-flag', priorities: null }).reason, 'no pages')
  // the same key across two bands (a tracker that re-lists a re-prioritised row) is combined once
  const dup = assertComplete([{ priority: 1, limit: 10, issues: [{ key: 'ABC-1' }], hasNextPage: false }, { priority: 2, limit: 10, issues: [{ key: 'ABC-1' }, { key: 'ABC-2' }], hasNextPage: false }], { findComplete: 'page-flag', priorities: [1, 2] })
  assert.equal(dup.total, 2)
})

// The playbook rule is "assert complete on EVERY band before combining", so the four bands are the
// default requirement: a caller that forgets `priorities` cannot combine three of four — or one
// unbanded page at its limit — into "the filed set". `null`/`[]` opts out explicitly, and an empty
// page set names every band it is missing rather than a bare "no pages".
test('assertComplete requires the four bands by default; null opts out; an empty page set names every missing band', () => {
  const [q1, q2, q3] = bandQueries(selector, { limit: 50 })
  const three = [q1, q2, q3].map((query, i) => ({ query, issues: issues(1, 10 * i), hasNextPage: false }))
  const r = assertComplete(three, { findComplete: 'page-flag' })
  assert.equal(r.complete, false)
  assert.match(r.reason, /priority 4: no page — the band was never queried/)
  assert.equal(r.total, null)
  const one = assertComplete([{ limit: 250, issues: issues(250), complete: true }], { findComplete: 'page-flag' })
  assert.equal(one.complete, false, 'one unbanded page is not the filed set')
  assert.match(one.reason, /^priority 1: no page.*; priority 2: no page.*; priority 3: no page.*; priority 4: no page — the band was never queried$/)
  assert.equal(assertComplete(three, { findComplete: 'page-flag', priorities: null }).complete, true)
  assert.equal(assertComplete(three, { findComplete: 'page-flag', priorities: [] }).complete, true)
  const empty = assertComplete([], { findComplete: 'page-flag' })
  assert.equal(empty.complete, false)
  assert.equal(empty.reason, ['no pages', ...PRIORITY_BANDS.map(p => `priority ${p}: no page — the band was never queried`)].join('; '))
  assert.deepEqual(empty.bands, [])
})

// A zero and a broken query (a drifted group id or provenance label) look identical, and from the
// second batch on an empty filed set re-files the entire sweep as duplicates — so a complete set
// that is empty is reported with a warning, the way frameCheck reports an empty frame.
test('an all-empty complete set carries a warn — never a silent "nothing filed"', () => {
  const pages = bandQueries(selector, { limit: 100 }).map(query => ({ query, issues: [], hasNextPage: false }))
  const r = assertComplete(pages, { findComplete: 'page-flag' })
  assert.equal(r.complete, true)
  assert.equal(r.total, 0)
  assert.match(r.warn, /combined filed set is empty — confirm the query ran/)
  pages[2].issues = issues(1)
  const some = assertComplete(pages, { findComplete: 'page-flag' })
  assert.equal(some.total, 1)
  assert.equal(some.warn, null)
  // an incomplete set has a reason, not a warn
  assert.equal(assertComplete(pages.slice(0, 3), { findComplete: 'page-flag' }).warn, null)
})

// `--pages <json>` is hand-assembled: a null or scalar entry is judged like every other malformed
// page (no issues[], no limit), not a TypeError out of bandOfPage.
test('a non-object entry in --pages is a judged failure, not a crash', () => {
  const r = assertComplete([{ priority: 1, limit: 10, issues: [], complete: true }, null, 'page'], { findComplete: 'page-flag', priorities: [1] })
  assert.equal(r.complete, false)
  assert.match(r.reason, /page 2: not an object/)
  assert.match(r.reason, /page 3: not an object/)
  assert.deepEqual(r.bands.map(b => [b.label, b.complete]), [['priority 1', true], ['page 2', false], ['page 3', false]])
})

// The hand-assembled page is normalised symmetrically: `priority: '2'` and `limit: '250'` are both
// read as their numbers, and a limit that is not one is named in the reason rather than reported
// as missing.
test('a digit-string limit is coerced like a string priority; any other limit is named, not "missing"', () => {
  const ok = assertComplete([{ priority: '2', limit: '250', issues: issues(250), hasNextPage: false }], { findComplete: 'page-flag', priorities: [2] })
  assert.equal(ok.complete, true)
  assert.equal(ok.total, 250)
  assert.match(assertComplete([{ priority: 2, limit: 'many', issues: [], hasNextPage: false }], { findComplete: 'page-flag', priorities: [2] }).reason, /limit "many" is not a positive integer/)
  assert.match(assertComplete([{ priority: 2, limit: 0, issues: [], hasNextPage: false }], { findComplete: 'page-flag', priorities: [2] }).reason, /limit 0 is not a positive integer/)
})

// `--pages` is hand-assembled, so a band arrives as `'High'` or `'2'` as readily as `2`. The identity
// is the canonical band: a named page satisfies a numeric requirement, a numeric and a named page for
// one band are the double-count the guard exists for, and a value no band owns is a band failure.
test('assertComplete normalises the band: a named or string priority is the same band as its number', () => {
  const named = assertComplete([{ priority: 'High', limit: 10, issues: issues(2), complete: true }], { findComplete: 'page-flag', priorities: [2] })
  assert.equal(named.complete, true)
  assert.deepEqual(named.bands.map(b => [b.priority, b.label]), [[2, 'priority 2']])
  assert.equal(assertComplete([{ priority: '2', limit: 10, issues: [], complete: true }], { findComplete: 'page-flag', priorities: ['High'] }).complete, true)
  assert.throws(() => assertComplete([{ priority: 2, limit: 10, issues: [], complete: true }, { priority: 'High', limit: 10, issues: [], complete: true }], { findComplete: 'page-flag' }), /priority 2 appears twice/)
  assert.throws(() => assertComplete([{ query: { priority: 3, limit: 10 }, issues: [], complete: true }, { priority: 'medium', limit: 10, issues: [], complete: true }], { findComplete: 'page-flag' }), /priority 3 appears twice/)
  const bad = assertComplete([{ priority: 'Sev1', limit: 10, issues: [], complete: true }], { findComplete: 'page-flag', priorities: [1] })
  assert.equal(bad.complete, false)
  assert.match(bad.reason, /page 1: priority: unrecognised value "Sev1"/)
  assert.match(bad.reason, /priority 1: no page/)
  assert.throws(() => assertComplete([{ priority: 1, limit: 10, issues: [], complete: true }], { findComplete: 'page-flag', priorities: ['Sev1'] }), /unrecognised value/)
})

// ---- joinFiledToPrs ----------------------------------------------------------------------------

// The join is the `**PR:**` header line and nothing else: a body cites related PRs in prose, a title
// carries a `#<n>` of its own, and an issue with no body is unattributed rather than guessed. The
// header is the playbook's — `#<n> — <url> — *(merged 2026-03-14)* | *(open at time of review)*` —
// and a tracker auto-embeds the link, so the line can repeat the number: one key, one PR, once.
test('joinFiledToPrs joins on the header line — never prose, never the title — and once per PR', () => {
  const body = [
    '**PR:** #1240 — https://github.com/acme/app/pull/1240 — *(merged 2026-03-14)*',
    '**What the PR does:** adds an import flow',
    '**Edge case:** a follow-up to #4300 leaves #4321 unhandled',
    '**Priority:** High — x',
    '**Gate:** pending (ABC-1234)',
  ].join('\n')
  const rows = [
    { key: 'ABC-1', title: 'Import flow (#1240)', body },
    { key: 'ABC-2', title: 'Sibling of #1240', description: '**PRs:** #1240, #1241 — *(open at time of review)*\n**Edge case:** see #999' },
    { key: 'ABC-3', title: 'Filed for #1240', body: '**Edge case:** the header line is missing; #1240 is only in the title' },
    { key: 'ABC-4', title: 'Filed for #1240' },
    // the tracker converted the link into an embed: the header line now carries `#1240` twice
    { key: 'ABC-5', title: 'Embedded', body: '**PR:** #1240 — [acme/app#1240](https://github.com/acme/app/pull/1240) — *(merged 2026-03-14)*\n**Edge case:** the embed repeats the number' },
  ]
  const r = joinFiledToPrs(rows)
  assert.deepEqual(r.byPr, { 1240: ['ABC-1', 'ABC-2', 'ABC-5'], 1241: ['ABC-2'] })
  assert.equal(r.byPr[986], undefined)
  assert.equal(r.byPr[4321], undefined)
  assert.equal(Object.keys(r.byPr).length, 2, 'the merged/open marker never reads as a PR')
  assert.deepEqual(r.unattributed.map(u => u.key), ['ABC-3', 'ABC-4'])
  assert.match(r.unattributed[1].reason, /title is never read/)
})

// The rows the join reads are op-2 getIssue rows (contract §6: `description`). No shipped adapter's
// op-16 Call: line returns a body, so an op-16 page handed straight to the join attributes nothing —
// every row is unattributed with a reason that names the op-2 step, never a guess from the title.
test('joinFiledToPrs: op-16 rows as the adapters emit them carry no body and attribute nothing; the op-2 row joins', () => {
  const op16 = [
    // linear.md fields: id, uuid, title, priority, status, statusType, parentId, labels, url
    { key: 'ABC-1', id: 'uuid-1', title: 'Import flow (#1240)', priority: 2, status: 'Todo', statusType: 'unstarted', parentId: null, labels: ['filed-by:fleet-check'], url: 'https://linear.app/acme/issue/ABC-1' },
    // github.md --jq: number, title, labels, state, state_reason, created_at, sub_issues_total
    { key: 'GH-7', id: 7, title: 'Import flow (#1240)', labels: ['filed-by:fleet-check', 'High'], state: 'open', state_reason: null, created_at: '2026-03-14T00:00:00Z', sub_issues_total: 0, priority: 2, status: 'open', parentId: null },
    // jira.md fields: key, summary, priority, status, parent, labels, created
    { key: 'ABC-3', id: '10003', title: 'Import flow (#1240)', priority: 2, status: 'To Do', parentId: 'ABC-100' },
    // asana.md / trello.md / the template: {key, id, title, priority, status, parentId}
    { key: '1200', id: '1200', title: 'Import flow (#1240)', priority: 2, status: 'Backlog', parentId: null },
  ]
  const r = joinFiledToPrs(op16)
  assert.deepEqual(r.byPr, {}, 'the #1240 in every title is never read')
  assert.deepEqual(r.unattributed.map(u => u.key), ['ABC-1', 'GH-7', 'ABC-3', '1200'])
  for (const u of r.unattributed) assert.match(u.reason, /op-16 rows carry none; fetch the row with op-2 getIssue/)
  // the same issue as op-2 returns it — {key,id,title,description,url,status,priority,parentId} — joins
  const op2 = { key: 'ABC-1', id: 'uuid-1', title: 'Import flow (#1240)', description: '**PR:** #1240 — https://github.com/acme/app/pull/1240 — *(open at time of review)*\n**Edge case:** x', url: 'https://linear.app/acme/issue/ABC-1', status: 'Todo', priority: 2, parentId: null }
  assert.deepEqual(joinFiledToPrs([op2]), { byPr: { 1240: ['ABC-1'] }, unattributed: [] })
})

// ---- unfiledCandidates -------------------------------------------------------------------------

// The 28-of-100: tracker titles are shortened rewrites of finding titles, so a token-overlap matcher
// scored 72 created issues as unfiled and would have re-filed them. The opaque fid cannot drift.
test('unfiledCandidates joins by fid — a rewritten title is still filed; a missing fid throws rather than falling back', () => {
  const filed = Array.from({ length: 100 }, (_, i) => ({ fid: makeFid('a01', 1200 + i, 1), key: `ABC-${i}`, title: `Short rewrite ${i}` }))
  const findings = filed.map((r, i) => ({ fid: r.fid, pr: String(1200 + i), title: `A long original finding title with many more tokens than the tracker kept, number ${i}` }))
  const extra = [{ fid: makeFid('a01', 1300, 1), pr: '1300', title: 'genuinely new' }, { fid: makeFid('a01', 1300, 2), pr: '1300', title: 'also new' }]
  const r = unfiledCandidates([...findings, ...extra], filed, { slice: 'a01' })
  assert.equal(r.alreadyFiled.length, 100)
  assert.deepEqual(r.unfiled.map(f => f.fid), ['a01|1300|1', 'a01|1300|2'])
  assert.deepEqual(r.unknownFids, [])
  // no fid on either side is an error, never a title fallback
  assert.throws(() => unfiledCandidates([{ title: 'Short rewrite 3', pr: '1203' }], filed), /never on the title/)
  assert.throws(() => unfiledCandidates(findings, [{ key: 'ABC-9', title: 'Short rewrite 9' }]), /has no fid/)
  // one fid twice in a batch (a hand-edited findings file, a re-minted range) is two op-13 creates
  // for one finding — refused before filing, not caught by the four-count after
  assert.throws(() => unfiledCandidates([{ fid: 'a01|1|1', title: 'x' }, { fid: 'a01|1|1', title: 'y' }], []), /fid "a01\|1\|1" appears twice in this batch/)
})

// The reconcile runs at the start of EVERY batch and filed/<slice>.tsv accumulates across them, so
// from the second batch on every earlier row is one this batch's candidates do not account for —
// informational, not a wrong file. The wrong slice file is detected by the fid's own slice segment.
test('unfiledCandidates: earlier batches\' rows are unknown to this batch, not an error; a foreign slice segment is', () => {
  const batch1 = [{ fid: makeFid('a01', 1200, 1), key: 'ABC-1' }, { fid: makeFid('a01', 1201, 1), key: 'ABC-2' }]
  const batch2 = [{ fid: makeFid('a01', 1300, 1), pr: '1300', title: 'batch two' }]
  const r = unfiledCandidates(batch2, batch1, { slice: 'a01' })
  assert.deepEqual(r.unfiled.map(f => f.fid), ['a01|1300|1'])
  assert.deepEqual(r.alreadyFiled, [])
  assert.deepEqual(r.unknownFids, ['a01|1200|1', 'a01|1201|1'])
  assert.throws(() => unfiledCandidates(batch2, batch1, { slice: 'a02' }), /fid "a01\|1200\|1" from slice "a01", not "a02" — the wrong filed\/<slice>\.tsv was read/)
  assert.throws(() => unfiledCandidates(batch2, [{ fid: 'not-a-fid', key: 'ABC-9' }], { slice: 'a01' }), /is not a fid/)
  // without a slice to check against, the segment is not judged
  assert.deepEqual(unfiledCandidates(batch2, [{ fid: 'not-a-fid', key: 'ABC-9' }]).unknownFids, ['not-a-fid'])
})

// ---- blastRadius -------------------------------------------------------------------------------

// The 66-vs-24: `page.tsx` exists in dozens of routes, so a basename match claimed 66 findings where
// the truth was 24. Full-path matching only; a bare filename never matches a nested path.
test('blastRadius matches on the FULL path — a basename match would claim far more', () => {
  const routes = Array.from({ length: 30 }, (_, i) => `example/app/route-${i}/page.tsx`)
  const findings = [
    ...routes.map((p, i) => ({ fid: `a01|${1000 + i}|1`, key: `ABC-${i}`, where: [{ path: p, line: 10 + i, symbol: 'Page' }] })),
    { fid: 'a01|2000|1', key: 'ABC-200', where: [{ path: 'example/lib/util.ts', line: 3 }, { path: 'example/lib/other.ts', line: 9 }] },
    { fid: 'a01|2000|2', key: 'ABC-201', where: [{ path: 'page.tsx', line: 908 }] },            // bare filename — unverifiable
    { fid: 'a01|2000|3', key: 'ABC-202', where: [{ path: '.\\example\\app\\route-2\\page.tsx', line: 1 }] },  // a Windows-authored path
    { fid: 'a01|2000|4', key: 'ABC-203' },                                                        // no where at all
  ]
  const changed = ['example/app/route-2/page.tsx', 'example/app/route-7/page.tsx', './example/lib/util.ts', 'example/app/route-2/layout.tsx']
  const r = blastRadius(changed, findings)
  assert.equal(r.changed, 4)
  assert.deepEqual(r.hits.map(h => h.key).sort(), ['ABC-2', 'ABC-200', 'ABC-202', 'ABC-7'])
  assert.deepEqual(r.hits.find(h => h.key === 'ABC-200').paths, ['example/lib/util.ts'])
  assert.equal(r.matched, 4)
  // the trap, measured: a basename match over the same inputs claims every page.tsx finding
  const basenames = new Set(changed.map(p => normalisePath(p).split('/').pop()))
  const byBasename = findings.filter(f => (f.where || []).some(w => basenames.has(normalisePath(w.path).split('/').pop()))).length
  assert.equal(byBasename, 33)
  assert.ok(r.matched < byBasename)
  assert.equal(normalisePath('.\\a\\b.ts'), 'a/b.ts')
  assert.equal(normalisePath('././a/b.ts'), 'a/b.ts')
  assert.deepEqual(blastRadius([], findings), { changed: 0, matched: 0, hits: [] })
})

// ---- frameCheck --------------------------------------------------------------------------------

// The 22-of-22: a hand-kept gate input of 22 rows was described as "every security-labelled High";
// op-16 over the group returned 58 High + 5 Urgent. A gate reports 100% of its input, always — so the
// list must be machine-derived and the denominator must travel with the tally.
test('frameCheck: "22 of 22 done" against a derived frame of 63 names the 41 never gated', () => {
  const derived = Array.from({ length: 63 }, (_, i) => ({ key: `ABC-${100 + i}`, priority: i < 5 ? 1 : 2 }))
  const gated = derived.slice(5, 27).map(r => r.key)                    // 22 rows, hand-picked, none Urgent
  const r = frameCheck({ derived, gated, provenance: 'op-16 findIssues({labels:[securityLabel]})' })
  assert.equal(r.ok, false)
  assert.equal(r.missing.length, 41)
  assert.ok(r.missing.includes('ABC-100') && r.missing.includes('ABC-104'), 'the two Urgents nobody gated are in the difference')
  assert.deepEqual(r.extra, [])
  assert.deepEqual(r.counts, { derived: 63, gated: 22 })
  assert.equal(r.summary, '22 of 63 gated, derived from op-16 findIssues({labels:[securityLabel]}); 41 never gated, 0 live outside the frame, 0 cancelled outside the frame')
  assert.equal(r.warn, null)
})

// `extra` is the other direction: judged rows outside the frame. The audit is the one step that
// cancels, so a cancelled row there is expected and only a LIVE one is the bug — a check that failed
// on every cancellation would fail every real audit. Keys or rows, arrays or Sets, duplicates
// collapse; an empty frame is warned about because a zero and a broken harness look identical.
test('frameCheck accepts keys or rows, fails only on a LIVE row outside the frame, and warns on an empty frame', () => {
  const ok = frameCheck({ derived: new Set(['ABC-1', 'ABC-2']), gated: [{ key: 'ABC-2' }, 'ABC-1', 'ABC-1'] })
  assert.deepEqual([ok.ok, ok.missing, ok.extra, ok.cancelled], [true, [], [], []])
  assert.equal(ok.summary, '2 of 2 gated; 0 never gated, 0 live outside the frame, 0 cancelled outside the frame')
  const live = frameCheck({ derived: ['ABC-1'], gated: ['ABC-1', 'ABC-9'] })
  assert.deepEqual([live.ok, live.extra, live.cancelled], [false, ['ABC-9'], []])
  const cancelled = frameCheck({ derived: ['ABC-1'], gated: ['ABC-1', 'ABC-9'], cancelled: [{ key: 'ABC-9', stateType: 'cancelled' }] })
  assert.deepEqual([cancelled.ok, cancelled.missing, cancelled.extra, cancelled.cancelled], [true, [], [], ['ABC-9']])
  assert.equal(cancelled.summary, '1 of 1 gated; 0 never gated, 0 live outside the frame, 1 cancelled outside the frame')
  const mixed = frameCheck({ derived: ['ABC-1'], gated: ['ABC-1', 'ABC-9', 'ABC-10'], cancelled: new Set(['ABC-9']) })
  assert.deepEqual([mixed.ok, mixed.extra, mixed.cancelled], [false, ['ABC-10'], ['ABC-9']])
  const empty = frameCheck({ derived: [], gated: [] })
  assert.equal(empty.ok, true)
  assert.match(empty.warn, /derived frame is empty/)
  assert.throws(() => frameCheck({ derived: null, gated: [] }), /must be an array or Set/)
  assert.throws(() => frameCheck({ derived: [], gated: [], cancelled: 'ABC-9' }), /cancelled must be an array or Set/)
})
