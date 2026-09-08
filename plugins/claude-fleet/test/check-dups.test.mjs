// Structural dedup: the pass that finds the pair a similarity check systematically misses.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cluster, clusterRows, DEFAULT_WINDOW } from '../src/check/dups.mjs'

const at = (fid, path, line, title = '') => ({ fid, title, where: [{ path, line }] })

test('the then- and else-branches of one `if` cluster, however differently they read', () => {
  // ⛔ The measured incident: two tickets at :102-105 and :117-119 of one file, one root fix closing
  // both. A dedicated duplicate-detection pass did not surface them AT ALL — they share a file and
  // almost no words, because the two branches of an `if` describe opposite conditions by
  // construction. So this pass reads no text.
  const r = cluster([
    at('a|1|1', 'scripts/deploy.mjs', 103, 'when the flag is set, the retry never fires'),
    at('a|2|1', 'scripts/deploy.mjs', 118, 'the fallback path drops the error entirely'),
    at('a|3|1', 'scripts/deploy.mjs', 400, 'unrelated, far away'),
  ])
  assert.equal(r.clusters.length, 1)
  assert.deepEqual(r.clusters[0].members.map(m => m.fid), ['a|1|1', 'a|2|1'])
  assert.equal(r.clusters[0].path, 'scripts/deploy.mjs')
  assert.deepEqual([r.clusters[0].first, r.clusters[0].last], [103, 118])
})

test('one finding is never a cluster with itself, and a chain stays one cluster', () => {
  // A finding citing two nearby lines of one file is one finding; pairing it with itself would hand
  // a worker a cluster to read with no second ticket in it.
  const twoSites = { fid: 'a|1|1', where: [{ path: 'src/x.ts', line: 10 }, { path: 'src/x.ts', line: 20 }] }
  assert.equal(cluster([twoSites]).clusters.length, 0)

  // Windowed against the PREVIOUS site, so three findings 25 lines apart are one cluster rather than
  // being cut wherever the first happened to start.
  const chain = cluster([at('a|1|1', 'src/x.ts', 10), at('a|2|1', 'src/x.ts', 35), at('a|3|1', 'src/x.ts', 60)])
  assert.equal(chain.clusters.length, 1)
  assert.equal(chain.clusters[0].members.length, 3)
})

test('findings in different files never cluster, whatever their line numbers', () => {
  // ⚖️ The inverse incident: one ticket's three "shares the fix with…" claims were all false — the
  // siblings lived in different apps. Textual similarity over-groups ACROSS files; this pass cannot,
  // because a file is the grouping key.
  const r = cluster([at('a|1|1', 'apps/site/page.tsx', 100), at('a|2|1', 'apps/admin/page.tsx', 101)])
  assert.equal(r.clusters.length, 0)
  assert.equal(r.files, 2)
})

test('a finding with no usable where[] is reported, never silently dropped', () => {
  // A zero-cluster result over a corpus of unsited findings would read as "no root-fix pairs" when
  // the pass in fact covered nothing.
  const r = cluster([{ fid: 'a|1|1' }, { fid: 'a|2|1', where: [{ path: 'src/x.ts' }] }, at('a|3|1', 'src/x.ts', 5)])
  assert.deepEqual(r.unsited.map(u => u.fid), ['a|1|1', 'a|2|1'], 'a where[] with no line cannot be windowed: placing it at line 0 would cluster it with the top of every file')
  assert.equal(r.sited, 1)
  assert.equal(r.clusters.length, 0)
})

test('the window is the knob, and the rows carry the span', () => {
  const far = [at('a|1|1', 'src/x.ts', 10), at('a|2|1', 'src/x.ts', 100)]
  assert.equal(cluster(far, { window: DEFAULT_WINDOW }).clusters.length, 0)
  const wide = cluster(far, { window: 200 })
  assert.equal(wide.clusters.length, 1)
  assert.deepEqual(clusterRows(wide.clusters).map(r => r.slice(0, 3)), [['src/x.ts', '10-100', 'a|1|1'], ['src/x.ts', '10-100', 'a|2|1']])
  assert.throws(() => cluster(far, { window: 0 }), /positive integer/)
})
