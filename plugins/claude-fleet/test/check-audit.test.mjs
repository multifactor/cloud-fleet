// The audit's worker layout: three passes with different shapes, and the shapes are not interchangeable.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planAudit, batchRows, BATCH } from '../src/check/audit.mjs'

const f = (fid, pr, priority, extra = {}) => ({ fid, key: fid.replace(/\|/g, '-'), pr: String(pr), priority, ...extra })

test('gate 1 groups by PR, because a worker reads that PR diff once', () => {
  // Grouping by anything else makes the diff read cost N times what it should, and a worker judging
  // one finding without its siblings cannot see the pattern the pair-finding passes are built on.
  const rows = [f('a|1|1', 1712, 3), f('a|1|2', 1712, 3), f('a|2|1', 1719, 3)]
  const p = planAudit(rows)
  assert.deepEqual(p.gate1.map(b => b.pr), ['1712', '1719'])
  assert.deepEqual(p.gate1[0].members, ['a|1|1', 'a|1|2'])
})

test('a PR with more than one batch of findings is split, and a finding with no PR is a named gap', () => {
  const many = Array.from({ length: BATCH + 2 }, (_, i) => f(`a|1|${i + 1}`, 1712, 3))
  const p = planAudit([...many, { fid: 'a|x|1', priority: 3 }])
  assert.equal(p.gate1.length, 2)
  assert.equal(p.gate1[0].members.length, BATCH)
  assert.equal(p.gate1[1].members.length, 2)
  // ⛔ Reported, never dropped: gate 1 reads one PR's diff per worker, so a finding with no PR has no
  // diff to be read against, and an audit that silently skipped it would report a gated corpus.
  assert.ok(p.gaps.some(g => /name no PR/.test(g)))
})

test('the consequence-driven pass takes every Urgent regardless of doubt, and Highs only by label', () => {
  // Doubt and consequence have opposite yields and catch different errors. A corpus scored only for
  // doubt has never had its worst findings' prescribed fixes tested.
  const rows = [
    f('a|1|1', 1712, 1),
    f('a|1|2', 1712, 2, { labels: ['security'] }),
    f('a|1|3', 1712, 2),
    f('a|1|4', 1712, 4),
  ]
  const withLabel = planAudit(rows, { securityLabel: 'security' })
  assert.deepEqual(withLabel.consequence.flatMap(b => b.members), ['a|1|1', 'a|1|2'])
  assert.equal(withLabel.gaps.some(g => /securityLabel/.test(g)), false)

  // Without the label configured the pass covers Urgent only — and says so, rather than quietly
  // producing a smaller set that looks like the full one.
  const without = planAudit(rows)
  assert.deepEqual(without.consequence.flatMap(b => b.members), ['a|1|1'])
  assert.ok(without.gaps.some(g => /securityLabel is not set/.test(g)))
})

test('the contradiction pass batches by a category the findings CARRY, and never invents one', () => {
  // ⛔ A taxonomy guessed here would group tickets that share a word — the over-grouping failure the
  // structural pass exists to complement — and would do it silently.
  const rows = [
    f('a|1|1', 1712, 3, { category: 'aria' }),
    f('a|2|1', 1719, 3, { category: 'aria' }),
    f('a|3|1', 1730, 3, { category: 'focus' }),
    f('a|4|1', 1741, 3),
  ]
  const p = planAudit(rows)
  assert.deepEqual(p.categories.map(c => c.category), ['aria', 'focus'])
  assert.deepEqual(p.categories[0].members, ['a|1|1', 'a|2|1'], 'the pairs it exists to find are two workers at opposite ends of one pattern, each of whom saw only their own PR')
  assert.deepEqual(p.uncategorised, ['a|4|1'])
  assert.ok(p.gaps.some(g => /record no `category`/.test(g)))

  // A corpus with no categories at all lays out no contradiction pass, and says so.
  const none = planAudit([f('a|1|1', 1712, 3)])
  assert.equal(none.categories.length, 0)
  assert.ok(none.gaps.some(g => /record no `category`/.test(g)))
})

test('every batch member lands in the rows, tagged with its pass', () => {
  const rows = [f('a|1|1', 1712, 1, { category: 'aria' })]
  const p = planAudit(rows, { securityLabel: 'security' })
  const out = batchRows(p, rows)
  // One Urgent with a category is read three times, by three passes with three different questions.
  assert.deepEqual(out.map(r => r[0]), ['gate1', 'consequence', 'category'])
  assert.ok(out.every(r => r[2] === 'a|1|1' && r[3] === '1712' && r[4] === '1'))
})
