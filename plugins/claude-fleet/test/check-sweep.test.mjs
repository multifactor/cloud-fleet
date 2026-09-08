import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { makeFid, parseFid, mintFids, fourCounts } from '../src/check/fid.mjs'
import { parseItem, parseWorkItems, pendingItems, worklistRows, parseWorklistRows, sweepIdFor } from '../src/check/worklist.mjs'
import { ledgerRow, parseLedger, resumeCounts, reconcileFromFindings, statusCounts, LEDGER_STATUSES } from '../src/check/ledger.mjs'
import { normalisePriority, priorityName, enumDistribution, normaliseA11yClass, classifyA11y, joinToPr, renderIssueBody } from '../src/check/findings.mjs'
import { formatRow, parseTsv } from '../src/sys/tsv.mjs'

const sha1 = s => createHash('sha1').update(s).digest('hex')
const AT = '2026-03-14T10:00:00Z'

// ---- fid ---------------------------------------------------------------------------------------

test('fid is opaque and round-trips; slices may not contain the separator', () => {
  assert.equal(makeFid('a01', 1240, 3), 'a01|1240|3')
  assert.deepEqual(parseFid('a01|1240|3'), { slice: 'a01', pr: '1240', index: 3 })
  assert.equal(parseFid('nope'), null)
  assert.deepEqual(mintFids('a01', 1240, 3), ['a01|1240|1', 'a01|1240|2', 'a01|1240|3'])
  assert.throws(() => makeFid('a|01', 1, 1), /must not contain/)
})

test('fourCounts: 136/136/136/136 passes; a divergence is NAMED', () => {
  const rows = Array.from({ length: 136 }, (_, i) => ({ fid: makeFid('a01', 1000 + i, 1), key: `ABC-${i}` }))
  const ok = fourCounts(rows, 136)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.counts, { rows: 136, uniqueFids: 136, uniqueKeys: 136, sliceTotal: 136 })

  const dupKey = fourCounts([{ fid: 'a|1|1', key: 'ABC-1' }, { fid: 'a|1|2', key: 'ABC-1' }], 2)
  assert.equal(dupKey.ok, false)
  assert.deepEqual(dupKey.diverged, ['uniqueKeys'])
  assert.deepEqual(dupKey.duplicateKeys, ['ABC-1'])

  const short = fourCounts([{ fid: 'a|1|1', key: 'ABC-1' }], 2)
  assert.deepEqual(short.diverged, ['sliceTotal'])

  const missing = fourCounts([{ fid: 'a|1|1', key: 'ABC-1' }, { fid: '', key: 'ABC-2' }], 2)
  assert.equal(missing.missingFid, 1)
  assert.ok(missing.diverged.includes('uniqueFids'))
})

// ---- worklist ----------------------------------------------------------------------------------

test('only list items are work items — a PR number inside another line\'s title is prose', () => {
  const body = [
    '- [ ] #1240 Fix the import flow',
    '- [ ] #1241 Follow-up to #4321 in the same area',   // #4321 is prose, not an item
    'We should also look at #1698 at some point.',        // not a list item at all
    '- [x] #1242 Already checked — `ABC-9` filed',
    '- [ ] https://github.com/acme/app/pull/1243 by URL',
    '* [ ] #1244 asterisk bullets count too',
  ].join('\n')
  const all = parseWorkItems(body)
  assert.deepEqual(all.map(i => i.pr), ['1240', '1241', '1242', '1243', '1244'])
  assert.deepEqual(pendingItems(body).map(i => i.pr), ['1240', '1241', '1243', '1244'])
  assert.equal(all.find(i => i.pr === '1242').done, true)
  assert.deepEqual(all.find(i => i.pr === '1242').keys, ['ABC-9'])
  assert.equal(all.find(i => i.pr === '1240').title, 'Fix the import flow')
  assert.equal(parseItem('not a list item'), null)
  assert.equal(parseItem('- [ ] no pr here'), null)
})

test('worklist rows round-trip and record open vs merged', () => {
  const rows = worklistRows([{ pr: '1240', mergedAt: '2026-03-01T00:00:00Z', title: 'a' }, { pr: '1241', title: 'b' }])
  assert.deepEqual(rows, [['1240', '2026-03-01T00:00:00Z', 'a'], ['1241', 'open', 'b']])
  const back = parseWorklistRows(rows)
  assert.equal(back[1].open, true)
  assert.equal(back[0].mergedAt, '2026-03-01T00:00:00Z')
  // a title containing a tab cannot break the format
  assert.equal(parseTsv(formatRow(['1', 'open', 'a\tb'])).length, 1)
})

test('sweepId is deterministic and order-independent for a PR set', () => {
  assert.equal(sweepIdFor({ kind: 'tracker-issue', ref: 'ABC-1234' }, sha1), 'ABC-1234')
  const a = sweepIdFor({ kind: 'prs', prs: [701, 699, 696] }, sha1)
  const b = sweepIdFor({ kind: 'prs', prs: ['696', '701', '699'] }, sha1)
  assert.equal(a, b)
  assert.match(a, /^prs-[0-9a-f]{8}$/)
  assert.notEqual(a, sweepIdFor({ kind: 'prs', prs: [701, 699] }, sha1))
  assert.match(sweepIdFor({ kind: 'file', ref: '/tmp/list.txt' }, sha1), /^file-[0-9a-f]{8}$/)
  assert.throws(() => sweepIdFor({ kind: 'other' }, sha1), /unknown input kind/)
})

// ---- ledger ------------------------------------------------------------------------------------

test('ledger rows are enum-validated and always carry a timestamp', () => {
  assert.deepEqual(ledgerRow({ pr: 1240, status: 'filed', keys: ['ABC-1', 'ABC-2'], at: AT, note: 'n' }), ['1240', 'filed', 'ABC-1,ABC-2', AT, 'n'])
  assert.deepEqual(ledgerRow({ pr: 1241, status: 'clean', at: AT }), ['1241', 'clean', '-', AT, ''])
  assert.throws(() => ledgerRow({ pr: 1, status: 'done', at: AT }), /must be one of/)
  assert.throws(() => ledgerRow({ pr: 1, status: 'filed' }), /timestamp/)
  assert.throws(() => ledgerRow({ status: 'filed', at: AT }), /pr is required/)
  assert.deepEqual(LEDGER_STATUSES, ['filed', 'clean', 'skipped', 'failed'])
})

test('resume prints three counts; done==0 against a non-empty ledger is an ERROR, not "no work done"', () => {
  const worklistPrs = ['1240', '1241', '1242']
  const entries = parseLedger([['1240', 'filed', 'ABC-1', AT, ''], ['1241', 'clean', '-', AT, '']])
  const r = resumeCounts({ worklistPrs, ledgerEntries: entries, ledgerFileNonEmpty: true })
  assert.deepEqual([r.worklist, r.done, r.remaining], [3, 2, 1])
  assert.deepEqual(r.remainingPrs, ['1242'])
  assert.equal(r.lastFiled.pr, '1240')
  assert.equal(r.error, null)

  // the ledger file has rows but none match the worklist → it did not load
  const bad = resumeCounts({ worklistPrs, ledgerEntries: parseLedger([['9999', 'filed', '-', AT, '']]), ledgerFileNonEmpty: true })
  assert.equal(bad.done, 0)
  assert.match(bad.error, /did not load/)

  // a genuinely fresh sweep is not an error
  const fresh = resumeCounts({ worklistPrs, ledgerEntries: [], ledgerFileNonEmpty: false })
  assert.equal(fresh.error, null)
  assert.equal(fresh.remaining, 3)
})

test('reconcileFromFindings rebuilds the lines a dropped write lost (231 remaining vs a true 148)', () => {
  const worklistPrs = Array.from({ length: 10 }, (_, i) => String(1000 + i))
  // the ledger only recorded two PRs; findings prove eight more resolved
  const entries = parseLedger([['1000', 'filed', 'ABC-1', AT, ''], ['1001', 'clean', '-', AT, '']])
  const findings = []
  for (let i = 2; i < 8; i++) findings.push({ pr: String(1000 + i), key: `ABC-${i}` })
  findings.push({ pr: '1008', key: null }) // reviewed, nothing to file
  const rows = reconcileFromFindings({ worklistPrs, ledgerEntries: entries, findings, at: AT })
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0], ['1002', 'filed', 'ABC-2', AT, 'reconciled from findings'])
  assert.deepEqual(rows[6], ['1008', 'clean', '-', AT, 'reconciled from findings'])
  // after appending them, remaining drops to the PR that genuinely was never attempted
  const after = resumeCounts({ worklistPrs, ledgerEntries: [...entries, ...parseLedger(rows)], ledgerFileNonEmpty: true })
  assert.deepEqual(after.remainingPrs, ['1009'])
})

test('statusCounts uses the LAST entry per PR (a retried PR is not double-counted)', () => {
  const entries = parseLedger([['1', 'failed', '-', AT, ''], ['1', 'filed', 'ABC-1', AT, ''], ['2', 'skipped', '-', AT, '']])
  assert.deepEqual(statusCounts(entries), { filed: 1, clean: 0, skipped: 1, failed: 0 })
})

// ---- findings ----------------------------------------------------------------------------------

test('priority normalises across case, numbers and P-codes; unknown throws (a lowercase "high" once hid a High)', () => {
  for (const v of ['High', 'high', 'HIGH', 2, '2', 'P1', 'major']) assert.equal(normalisePriority(v), 2, String(v))
  assert.equal(normalisePriority('Urgent'), 1)
  assert.equal(normalisePriority('low'), 4)
  assert.equal(priorityName('p2'), 'Medium')
  assert.throws(() => normalisePriority('sev-2'), /unrecognised/)
  assert.throws(() => normalisePriority(9), /outside 1..4/)
  assert.throws(() => normalisePriority(''), /missing/)
})

test('enumDistribution surfaces the casing split BEFORE a filter hides a row', () => {
  const values = [...Array(36).fill('High'), 'high', ...Array(10).fill('Low')]
  const d = enumDistribution(values, normalisePriority)
  assert.deepEqual(d.distribution, { High: 36, high: 1, Low: 10 })
  assert.deepEqual(d.canonical, { 2: 37, 4: 10 })
  const naive = values.filter(v => v === 'High').length
  assert.equal(naive, 36, 'the naive filter loses the lowercase row')
  assert.equal(d.canonical['2'], 37)
})

test('a11y: the who-is-harmed test decides the LABEL; the forced priority is then unconditional', () => {
  const cfg = { umbrella: true, forcedPriority: 4, labels: { keyboard: 'a11y: keyboard', screenReader: 'a11y: screen reader' } }
  // keyboard-only → labelled, forced Low, parented, and the assessed severity is recorded
  const kb = classifyA11y({ a11yClass: 'keyboard', harmsEveryone: false, assessedPriority: 'High' }, cfg)
  assert.deepEqual(kb.labels, ['a11y: keyboard'])
  assert.equal(kb.priority, 4)
  assert.equal(kb.assessedPriority, 2)
  assert.equal(kb.parented, true)
  assert.match(kb.note, /assessed this High/)

  // harms everyone with an a11y dimension → NOT labelled, filed at true severity
  const everyone = classifyA11y({ a11yClass: 'screen-reader', harmsEveryone: true, assessedPriority: 'High' }, cfg)
  assert.equal(everyone.labelled, false)
  assert.deepEqual(everyone.labels, [])
  assert.equal(everyone.priority, 2)
  assert.equal(everyone.parented, false)

  // both classes → both labels
  assert.deepEqual(classifyA11y({ a11yClass: 'both', harmsEveryone: false, assessedPriority: 3 }, cfg).labels, ['a11y: keyboard', 'a11y: screen reader'])
  // no forced priority configured → the assessment stands and there is no note
  const free = classifyA11y({ a11yClass: 'keyboard', harmsEveryone: false, assessedPriority: 2 }, { ...cfg, forcedPriority: null })
  assert.equal(free.priority, 2)
  assert.equal(free.note, null)
})

test('a11y class spellings normalise to one value', () => {
  for (const v of ['screen reader', 'screen-reader', 'screen_reader', 'screenReader', 'SCREEN READER']) {
    assert.equal(normaliseA11yClass(v), 'screen_reader', v)
  }
  assert.equal(normaliseA11yClass(undefined), 'none')
  assert.throws(() => normaliseA11yClass('aria'), /unrecognised/)
})

test('joinToPr reads the header line only — a PR cited in prose is not an attribution', () => {
  const body = [
    '**PR:** #1240 — https://github.com/acme/app/pull/1240',
    '**What the PR does:** something',
    '**Edge case:** this is a follow-up to #4300 and relates to #4321',
  ].join('\n')
  assert.deepEqual(joinToPr(body), ['1240'])
  assert.deepEqual(joinToPr('**PRs:** #1240, #1241\n**Edge case:** see #999'), ['1240', '1241'])
  assert.deepEqual(joinToPr('no header here #123'), [])
})

test('renderIssueBody places the Gate line under Priority and requires a valid priority', () => {
  const body = renderIssueBody({
    prs: ['1240'], prUrl: 'https://github.com/acme/app/pull/1240',
    whatThePrDoes: 'adds an import flow', edgeCase: 'a failed read renders as an empty state',
    priority: 'High', why: 'the empty state asserts a security fact', sweepId: 'ABC-1234',
    where: [{ path: 'example/list.tsx', line: 42, symbol: 'List' }],
    screenshot: 'https://assets.example/x.png', caption: 'Area affected (context, not a repro): the list',
  })
  const lines = body.split('\n')
  assert.equal(lines[3], '**Priority:** High — the empty state asserts a security fact')
  assert.equal(lines[4], '**Gate:** pending (ABC-1234)')
  assert.ok(body.includes('**Where:** example/list.tsx:42 (List)'))
  assert.ok(body.includes('![screenshot](https://assets.example/x.png)'))
  assert.deepEqual(joinToPr(body), ['1240'])
  const noUi = renderIssueBody({ prs: ['1'], whatThePrDoes: 'x', edgeCase: 'y', priority: 4, why: 'z', sweepId: 'S', noUiReason: 'pure infrastructure' })
  assert.ok(noUi.includes('_No UI surface — pure infrastructure._'))
  assert.throws(() => renderIssueBody({ prs: ['1'], whatThePrDoes: 'x', edgeCase: 'y', priority: 'sev2', why: 'z', sweepId: 'S' }), /unrecognised/)
})
