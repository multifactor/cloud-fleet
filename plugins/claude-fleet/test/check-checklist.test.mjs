import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tickEdit, planTicks, batchEdits, chunk, applyEditsToBody, tickedCount, verifyTicked, MAX_EDITS_PER_CALL } from '../src/check/checklist.mjs'
import { parseItem, parseWorkItems } from '../src/check/worklist.mjs'
import { ledgerRow, parseLedger } from '../src/check/ledger.mjs'

// A to-do body the way op-26 reads it back: one PR per line, titles quoting other PRs.
const BODY = [
  '## PRs to check',
  '',
  '- [ ] #1234 Follow-up to #1235 in the same area',   // the bare `#1235` a naive replace hits FIRST
  '- [ ] #1235 Fix the import flow',
  '- [x] #1236 Already checked (`ABC-9`)',
  '- [ ] #123 Short number that is a prefix of the others',
].join('\n')
const AT = '2026-03-14T00:00:00Z'

// ---- tickEdit ----------------------------------------------------------------------------------

test('the anchor is the ORIGINAL line — a bare #1235 inside another title is what a naive replace ticks', () => {
  // the trap, demonstrated: a first-occurrence replace of the bare number lands in #1234's title
  const naive = BODY.replace('#1235', '#1235 (ticked)').split('\n')
  assert.equal(naive[2], '- [ ] #1234 Follow-up to #1235 (ticked) in the same area', 'precondition: the bare number appears in another title first')
  assert.equal(naive[3], '- [ ] #1235 Fix the import flow', 'precondition: the naive replace never reaches the real row')
  const line = BODY.split('\n').find(l => l.startsWith('- [ ] #1235'))
  const edit = tickEdit({ pr: 1235, keys: ['ABC-1234'], raw: line })
  assert.equal(edit.find, line, 'find is the original line, byte-for-byte')
  const r = applyEditsToBody(BODY, [edit])
  assert.equal(r.applied, 1)
  assert.deepEqual(r.missing, [])
  const lines = r.body.split('\n')
  assert.equal(lines[2], '- [ ] #1234 Follow-up to #1235 in the same area', 'the row that merely mentions #1235 is untouched')
  assert.equal(lines[3], '- [x] #1235 Fix the import flow (`ABC-1234`)')
  // handing it the wrong row is refused, not "ticked anyway"
  assert.throws(() => tickEdit({ pr: 1235, keys: [], raw: lines[2] }), /line is #1234, not #1235/)
})

test('a bare "- [ ] #<pr>" prefix anchor ends at a word boundary — "- [ ] #123" must not match the "- [ ] #1234" row', () => {
  // the shape the read-modify-write adapters' op-27 Call: line sends
  const r = applyEditsToBody(BODY, [{ find: '- [ ] #123', replace: '- [x] #123 (`ABC-1`)' }])
  assert.equal(r.applied, 1)
  assert.deepEqual(r.missing, [])
  assert.ok(r.body.includes('- [ ] #1234 Follow-up'), '#1234 is not the row that was ticked')
  assert.ok(r.body.includes('- [x] #123 (`ABC-1`) Short number'), 'the rest of the line survives after a prefix anchor')
  // and tickEdit itself will not read the #1234 line as #123
  assert.throws(() => tickEdit({ pr: 123, keys: [], raw: '- [ ] #1234 x' }), /line is #1234, not #123/)
})

test('a PR-URL row ticks like a #<pr> row — op-26 returns both shapes, and the anchor is always the whole raw line', () => {
  const raw = '- [ ] https://github.com/acme/app/pull/1237 by URL'
  const edit = tickEdit({ pr: 1237, keys: ['ABC-1234'], raw })
  // exactly {find, replace}: find is the raw line byte-for-byte, and no extra field rides into the op-15 payload
  assert.deepEqual(edit, { find: raw, replace: '- [x] https://github.com/acme/app/pull/1237 by URL (`ABC-1234`)' })
  const back = parseItem(edit.replace)
  assert.deepEqual([back.pr, back.done, back.keys], ['1237', true, ['ABC-1234']])
  // the PR is read the way op-26 (worklist.parseItem) reads it, so a wrong-row hand-off is still refused
  assert.throws(() => tickEdit({ pr: 1238, keys: [], raw }), /line is #1237, not #1238/)
  const r = applyEditsToBody(BODY + '\n' + raw, [edit])
  assert.equal(r.applied, 1)
  assert.deepEqual(parseWorkItems(r.body).filter(i => i.done).map(i => i.pr), ['1236', '1237'])
})

test('keys are appended whole and backtick-wrapped — a truncated ABC-1234 autolinks to ABC-1, a bare key autolinks at all', () => {
  const edit = tickEdit({ pr: 1235, keys: ['ABC-1234', 'ABC-1235'], raw: '- [ ] #1235 Fix the import flow' })
  assert.equal(edit.replace, '- [x] #1235 Fix the import flow (`ABC-1234`, `ABC-1235`)')
  // what we write, op-26 reads back as the same keys
  const back = parseItem(edit.replace)
  assert.deepEqual([back.pr, back.done, back.keys], ['1235', true, ['ABC-1234', 'ABC-1235']])
  // a long key list is never cut at a character offset
  const many = Array.from({ length: 40 }, (_, i) => `ABC-${100 + i}`)
  const big = tickEdit({ pr: 1, keys: many, raw: '- [ ] #1 t' })
  assert.deepEqual(parseItem(big.replace).keys, many)
  // anything that is not a whole key is refused rather than written bare or partial
  for (const bad of ['ABC-', 'ABC-1234…', 'ABC 1234', '', '`ABC-1`', 'ABC-12\n34', 'abc-1234', 'a-1']) {
    assert.throws(() => tickEdit({ pr: 1, keys: [bad], raw: '- [ ] #1 t' }), /not a whole issue key/, JSON.stringify(bad))
  }
  // a clean PR ticks with no suffix at all
  assert.equal(tickEdit({ pr: 1, keys: [], raw: '- [ ] #1 t' }).replace, '- [x] #1 t')
})

test("a key is whole by the adapter's issueKey.pattern, not a hardcode — the default is the contract's", () => {
  // the contract default is case-sensitive: a lower-case key is not a key on such a tracker
  assert.throws(() => tickEdit({ pr: 1, keys: ['abc-1234'], raw: '- [ ] #1 t' }), /not a whole issue key/)
  // an underscore project key is a key on a tracker that declares it, and only there
  const underscore = { pattern: '[A-Z][A-Z0-9_]+-[0-9]+', caseInsensitive: false }
  assert.throws(() => tickEdit({ pr: 1, keys: ['AB_C-2'], raw: '- [ ] #1 t' }), /not a whole issue key/)
  assert.equal(tickEdit({ pr: 1, keys: ['AB_C-2'], raw: '- [ ] #1 t' }, { issueKey: underscore }).replace, '- [x] #1 t (`AB_C-2`)')
  // a case-insensitive pattern accepts the lower-case form and still refuses a key of another shape
  const ci = { pattern: 'GH-[0-9]+', caseInsensitive: true }
  assert.equal(tickEdit({ pr: 1, keys: ['gh-12'], raw: '- [ ] #1 t' }, { issueKey: ci }).replace, '- [x] #1 t (`gh-12`)')
  assert.throws(() => tickEdit({ pr: 1, keys: ['ABC-1234'], raw: '- [ ] #1 t' }, { issueKey: ci }), /not a whole issue key/)
  // the pattern is anchored to the whole key: a key with a tail is not a key
  assert.throws(() => tickEdit({ pr: 1, keys: ['GH-12 extra'], raw: '- [ ] #1 t' }, { issueKey: ci }), /not a whole issue key/)
  assert.throws(() => tickEdit({ pr: 1, keys: ['GH-12'], raw: '- [ ] #1 t' }, { issueKey: {} }), /issueKey\.pattern is required/)
  // batchEdits threads the option through
  assert.equal(batchEdits([{ pr: 1, keys: ['AB_C-2'], raw: '- [ ] #1 t' }], { issueKey: underscore })[0].replace, '- [x] #1 t (`AB_C-2`)')
})

test('the rest of the line is preserved verbatim — indentation, bullet, trailing text and a CRLF ending', () => {
  assert.equal(tickEdit({ pr: 7, keys: ['ABC-2'], raw: '  * [ ] #7 — nested, star bullet, dash title  ' }).replace, '  * [x] #7 — nested, star bullet, dash title   (`ABC-2`)')
  // a body read on Windows leaves `\r` on the line; the keys must not land on the next visual line
  const crlf = tickEdit({ pr: 8, keys: ['ABC-3'], raw: '- [ ] #8 title\r' })
  assert.equal(crlf.find, '- [ ] #8 title\r')
  assert.equal(crlf.replace, '- [x] #8 title (`ABC-3`)\r')
})

test('an already-ticked or unrecognised line throws instead of yielding a no-op edit, and names the row it SAW', () => {
  assert.throws(() => tickEdit({ pr: 1236, keys: [], raw: '- [x] #1236 Already checked' }), /#1236 is already ticked/)
  // a ticked line for ANOTHER pr is a wrong-row hand-off, not a re-tick of the right one
  let msg = ''
  try { tickEdit({ pr: 1235, keys: [], raw: '- [x] #1236 Already checked' }) } catch (e) { msg = e.message }
  assert.match(msg, /line is #1236 \(already ticked\), not #1235/)
  assert.doesNotMatch(msg, /#1235 is already ticked/)
  assert.throws(() => tickEdit({ pr: 1236, keys: [], raw: 'We should also look at #1236.' }), /does not begin with/)
  assert.throws(() => tickEdit({ pr: 1236, keys: [], raw: '- [ ] no PR on this row' }), /does not begin with/)
  assert.throws(() => tickEdit({ pr: 1236, keys: [] }), /does not begin with/)
})

// ---- planTicks / batchEdits / chunk ------------------------------------------------------------

test('planTicks joins the ledger to the op-26 rows on pr — keys from the ledger, latest row per PR, ticked rows and rowless PRs REPORTED', () => {
  const ledger = parseLedger([
    ledgerRow({ pr: 1234, status: 'filed', keys: ['ABC-1'], at: AT }),
    ledgerRow({ pr: 1235, status: 'clean', at: AT }),
    ledgerRow({ pr: 1236, status: 'filed', keys: ['ABC-9'], at: AT }),               // already `- [x]` on the list: an earlier wave's tick
    ledgerRow({ pr: 999, status: 'failed', at: AT, note: 'no row on the list' }),
    ledgerRow({ pr: 1234, status: 'filed', keys: ['ABC-1234', 'ABC-1235'], at: AT }), // a retry: the last outcome wins
  ])
  const plan = planTicks(ledger, parseWorkItems(BODY))
  assert.deepEqual(plan.items, [
    { pr: '1234', keys: ['ABC-1234', 'ABC-1235'], raw: '- [ ] #1234 Follow-up to #1235 in the same area' },
    { pr: '1235', keys: [], raw: '- [ ] #1235 Fix the import flow' },
  ])
  assert.deepEqual(plan.mirrored, ['1236'])
  assert.deepEqual(plan.unmatched, ['999'])
  // the items are tickEdit inputs: one wave, one call, verified by count
  const r = applyEditsToBody(BODY, batchEdits(plan.items))
  assert.equal(r.applied, 2)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(verifyTicked(BODY, r.body, plan.items.length), { ok: true, before: 1, after: 3, expected: 2, grewBy: 2 })
  assert.deepEqual(parseWorkItems(r.body).map(i => [i.pr, i.done, i.keys]), [
    ['1234', true, ['ABC-1234', 'ABC-1235']], ['1235', true, []], ['1236', true, ['ABC-9']], ['123', false, []],
  ])
  assert.deepEqual(planTicks([], parseWorkItems(BODY)), { items: [], mirrored: [], unmatched: [], duplicated: [] })
})

test('a PR with two rows on the list is REPORTED as duplicated, never ticked — last-row-wins flips the outcome with row order, and an anchor that matches twice rejects an atomic wave', () => {
  const ledger = parseLedger([
    ledgerRow({ pr: 3, status: 'filed', keys: ['ABC-3'], at: AT }),
    ledgerRow({ pr: 4, status: 'clean', at: AT }),
    ledgerRow({ pr: 5, status: 'filed', keys: ['ABC-5'], at: AT }),
  ])
  const open = ['- [ ] #3 a', '- [ ] #3 b']                    // the same PR twice, both unticked
  const mixed = ['- [x] #4 four (`ABC-4`)', '- [ ] #4 four']   // one ticked, one not: last-wins would say mirrored OR tick, by order
  const rest = ['- [ ] #5 five']
  for (const lines of [[...open, ...mixed, ...rest], [...rest, ...[...mixed].reverse(), ...[...open].reverse()]]) {
    const body = lines.join('\n')
    const plan = planTicks(ledger, parseWorkItems(body))
    assert.deepEqual(plan.duplicated, ['3', '4'], body)
    assert.deepEqual(plan.mirrored, [], body)
    assert.deepEqual(plan.unmatched, [], body)
    assert.deepEqual(plan.items, [{ pr: '5', keys: ['ABC-5'], raw: '- [ ] #5 five' }], body)
    // the odd rows do not hold up the wave's other tick
    const r = applyEditsToBody(body, batchEdits(plan.items))
    assert.equal(r.applied, 1)
    assert.deepEqual(r.missing, [])
    assert.equal(verifyTicked(body, r.body, plan.items.length).ok, true)
  }
  // a duplicate for a PR the ledger has not reached is nobody's tick yet — the plan lists what THIS wave owes
  assert.deepEqual(planTicks(ledger.slice(2), parseWorkItems([...open, ...rest].join('\n'))).duplicated, [])
})

test('a wave is one call; a wave above 50 is split into consecutive calls (one tracker rejects the whole call above 50)', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ pr: 1000 + i, keys: i % 3 ? [`ABC-${i}`] : [], raw: `- [ ] #${1000 + i} title ${i}` }))
  const edits = batchEdits(items)
  assert.equal(edits.length, 120)
  assert.equal(edits[0].find, '- [ ] #1000 title 0')
  assert.deepEqual(Object.keys(edits[0]), ['find', 'replace'], 'an edit is exactly {find, replace} — an extra field would ride into the op-15 payload')
  const calls = chunk(edits)
  assert.equal(MAX_EDITS_PER_CALL, 50)
  assert.deepEqual(calls.map(c => c.length), [50, 50, 20])
  assert.equal(calls[1][0].find, '- [ ] #1050 title 50', 'order is preserved across the split')
  assert.deepEqual(chunk([], 50), [])
  assert.throws(() => chunk(edits, 0), /positive integer/)
  // a non-array wave is refused, not silently turned into one call of one string or zero calls
  assert.throws(() => chunk('abc'), /edits must be an array/)
  assert.throws(() => chunk({}), /edits must be an array/)
  // the same PR twice in one wave would fail its second anchor and reject the whole call
  assert.throws(() => batchEdits([{ pr: 1, keys: [], raw: '- [ ] #1 a' }, { pr: '1', keys: ['ABC-1'], raw: '- [ ] #1 a' }]), /appears twice/)
})

// ---- applyEditsToBody --------------------------------------------------------------------------

test('a missing or ambiguous anchor is REPORTED, never swallowed — the edit that quietly did nothing is a mirror that stops moving', () => {
  const body = [
    '- [ ] #1 one',
    '- [ ] #2 two (renamed since op-26)',   // the line GREW under us: the old line is now a prefix of it
    '- [ ] #3 three',
    '- [ ] #3 three',                       // a duplicate row: the anchor matches twice
    '- [ ] #4 four',                        // the line SHRANK under us
  ].join('\n')
  const edits = [
    tickEdit({ pr: 1, keys: ['ABC-1'], raw: '- [ ] #1 one' }),
    tickEdit({ pr: 2, keys: ['ABC-2'], raw: '- [ ] #2 two' }),
    tickEdit({ pr: 3, keys: [], raw: '- [ ] #3 three' }),
    tickEdit({ pr: 4, keys: [], raw: '- [ ] #4 four (renamed since op-26)' }),
  ]
  const r = applyEditsToBody(body, edits)
  assert.equal(r.applied, 1)
  assert.deepEqual(r.missing, [
    { find: '- [ ] #2 two', count: 0 },
    { find: '- [ ] #3 three', count: 2 },
    { find: '- [ ] #4 four (renamed since op-26)', count: 0 },
  ])
  const lines = r.body.split('\n')
  assert.equal(lines[0], '- [x] #1 one (`ABC-1`)')
  assert.equal(lines[1], '- [ ] #2 two (renamed since op-26)', 'a whole-line anchor that is only a PREFIX of the row is a miss — the keys would have landed mid-line')
  assert.equal(lines[4], '- [ ] #4 four', 'the unmatched row is left exactly as it was')
  // a find inside a line (not starting it) is not an anchor
  assert.equal(applyEditsToBody('note: - [ ] #1 one', [edits[0]]).applied, 0)
})

test('the emulation counts ROWS, not substrings — an indented copy is its own row, so the top-level row ticks where a native substring patch would reject the pair', () => {
  const body = '- [ ] #3 three\n  - [ ] #3 three'
  const top = applyEditsToBody(body, [tickEdit({ pr: 3, keys: ['ABC-1'], raw: '- [ ] #3 three' })])
  assert.equal(top.applied, 1)
  assert.deepEqual(top.missing, [])
  assert.equal(top.body, '- [x] #3 three (`ABC-1`)\n  - [ ] #3 three', 'the nested copy is untouched')
  // and the nested copy's own raw line (indentation included) anchors it alone
  const nested = applyEditsToBody(top.body, [tickEdit({ pr: 3, keys: [], raw: '  - [ ] #3 three' })])
  assert.equal(nested.body, '- [x] #3 three (`ABC-1`)\n  - [x] #3 three')
  assert.equal(verifyTicked(body, nested.body, 2).ok, true)
})

test('edits apply in order against the current text, and a second application of the same edit is reported, not re-applied', () => {
  const edits = batchEdits([{ pr: 1234, keys: ['ABC-4'], raw: '- [ ] #1234 Follow-up to #1235 in the same area' }, { pr: 1235, keys: ['ABC-5'], raw: '- [ ] #1235 Fix the import flow' }])
  const once = applyEditsToBody(BODY, edits)
  assert.equal(once.applied, 2)
  assert.deepEqual(parseWorkItems(once.body).filter(i => i.done).map(i => i.pr), ['1234', '1235', '1236'])
  const twice = applyEditsToBody(once.body, edits)
  assert.equal(twice.applied, 0)
  assert.deepEqual(twice.missing.map(m => m.count), [0, 0])
  assert.equal(twice.body, once.body)
})

test('a malformed edit throws before the body is touched — splicing a missing replace writes the literal word "undefined" over the row and counts it as applied', () => {
  for (const bad of [{ find: '- [ ] #1 one' }, { replace: '- [x] #1 one' }, { find: '- [ ] #1 one', replace: 7 }, null]) {
    assert.throws(() => applyEditsToBody('- [ ] #1 one', [bad]), /edit needs string find and replace/, JSON.stringify(bad))
  }
  // a well-formed edit behind a malformed one is never reached: nothing is applied, nothing is reported as a miss
  const good = tickEdit({ pr: 1, keys: ['ABC-1'], raw: '- [ ] #1 one' })
  assert.throws(() => applyEditsToBody('- [ ] #1 one', [{ find: '- [ ] #1 one' }, good]), /edit needs string find and replace/)
  assert.equal(applyEditsToBody('- [ ] #1 one', [good]).body, '- [x] #1 one (`ABC-1`)')
})

// ---- tickedCount / verifyTicked ----------------------------------------------------------------

test('the "- [x]" count must grow by exactly N — under is a stale anchor, over is a hand tick mid-wave; neither is retried blind', () => {
  assert.equal(tickedCount(BODY), 1)
  assert.equal(tickedCount('- [X] #1 a\r\n* [x] #2 b\r\n- [ ] #3 c\n[x] not a list item'), 2)
  assert.equal(tickedCount(''), 0)
  const edits = batchEdits([
    { pr: 1234, keys: [], raw: '- [ ] #1234 Follow-up to #1235 in the same area' },
    { pr: 1235, keys: ['ABC-5'], raw: '- [ ] #1235 Fix the import flow' },
    { pr: 123, keys: [], raw: '- [ ] #123 Short number that is a prefix of the others' },
  ])
  const ok = verifyTicked(BODY, applyEditsToBody(BODY, edits).body, 3)
  assert.deepEqual(ok, { ok: true, before: 1, after: 4, expected: 3, grewBy: 3 })
  // one anchor gone stale → applied 2 of 3, and the count check says so instead of the caller assuming N
  const stale = [edits[0], { ...edits[1], find: '- [ ] #1235 Fix the import flow (edited)' }, edits[2]]
  const r = applyEditsToBody(BODY, stale)
  assert.equal(r.applied, 2)
  const under = verifyTicked(BODY, r.body, 3)
  assert.equal(under.ok, false)
  assert.equal(under.grewBy, 2)
  // the other half of "exactly N": the operator ticked a row by hand between the read and the write
  const hand = applyEditsToBody(BODY, edits.slice(0, 2)).body.replace('- [ ] #123 Short', '- [x] #123 Short')
  const over = verifyTicked(BODY, hand, 2)
  assert.equal(over.ok, false)
  assert.equal(over.grewBy, 3)
  // a string count from argv would make `ok` false forever under the strict compare — refused up front
  assert.throws(() => verifyTicked(BODY, BODY, '2'), /expected must be a non-negative integer/)
  assert.throws(() => verifyTicked(BODY, BODY, -1), /expected must be a non-negative integer/)
})

test('a CRLF body ticks end to end — the `\\r` on the raw line anchors, the keys land before it, and the body stays CRLF', () => {
  const body = '- [ ] #8 title\r\n- [ ] #9 other\r\n'
  const r = applyEditsToBody(body, [tickEdit({ pr: 8, keys: ['ABC-3'], raw: '- [ ] #8 title\r' })])
  assert.equal(r.applied, 1)
  assert.deepEqual(r.missing, [])
  assert.equal(r.body, '- [x] #8 title (`ABC-3`)\r\n- [ ] #9 other\r\n')
  assert.deepEqual(verifyTicked(body, r.body, 1), { ok: true, before: 0, after: 1, expected: 1, grewBy: 1 })
})

test('the realistic CRLF case — op-26 splits on \\r?\\n, so the raw line carries no `\\r` while the stored body is CRLF; the anchor still ends at the `\\r`', () => {
  const body = '- [ ] #8 title\r\n- [ ] #9 o\r\n'
  const raw = parseWorkItems(body)[0].raw
  assert.equal(raw, '- [ ] #8 title', 'precondition: the line op-26 returns has no \\r on it')
  const r = applyEditsToBody(body, [tickEdit({ pr: 8, keys: ['ABC-1'], raw })])
  assert.equal(r.applied, 1)
  assert.deepEqual(r.missing, [])
  assert.equal(r.body, '- [x] #8 title (`ABC-1`)\r\n- [ ] #9 o\r\n')
  assert.deepEqual(verifyTicked(body, r.body, 1), { ok: true, before: 0, after: 1, expected: 1, grewBy: 1 })
})
