// The falsifiable half of an audit's evidence: does the cited file exist, and is the cited line in it?
//
// Each test here is an incident from the field notes, not a shape check.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractCitations, extractPaths, basenameIndex, resolvePath, verifyCitations, verifyPaths, matcherControl } from '../src/check/citations.mjs'

const TREE = [
  'apps/site/src/app/page.tsx',
  'apps/admin/src/app/page.tsx',
  'packages/kit/src/index.ts',
  'src/cli/args.mjs',
  'README.md',
]
const LENGTHS = { 'apps/site/src/app/page.tsx': 120, 'apps/admin/src/app/page.tsx': 40, 'packages/kit/src/index.ts': 12, 'src/cli/args.mjs': 300, 'README.md': 80 }
const lengthOf = p => (p in LENGTHS ? LENGTHS[p] : null)

test('citations are extracted from prose, de-duplicated, separator-blind', () => {
  const text = [
    'The guard is at src/cli/args.mjs:156 and again at src/cli/args.mjs:156.',
    'On Windows the note said src\\cli\\args.mjs:12.',
    'A range reads packages/kit/src/index.ts:4-9 and a bare basename page.tsx:99.',
    'Version 1.2.3 is not a citation, nor is 10:30 in a timestamp.',
  ].join('\n')
  const found = extractCitations(text)
  assert.deepEqual(found.map(c => c.raw), ['src/cli/args.mjs:156', 'src/cli/args.mjs:12', 'packages/kit/src/index.ts:4', 'page.tsx:99'])
  // A range cites its first line; the check is "is this line inside the file", and the first line is
  // the one the reader is sent to.
  assert.equal(found[2].line, 4)
})

test('an ambiguous basename is untestable, not a failure — and never a regex', () => {
  // ⛔ `page.tsx` matches 134 files in a real tree. Counting it as a miss would bury the real ones,
  // and resolving it to "the first one" would send a reader to the wrong file with full confidence.
  const index = basenameIndex(TREE)
  const tree = new Set(TREE)
  assert.equal(resolvePath('page.tsx', tree, index).how, 'ambiguous')
  assert.equal(resolvePath('apps/site/src/app/page.tsx', tree, index).how, 'exact')
  assert.equal(resolvePath('index.ts', tree, index).how, 'basename', 'a basename with exactly one home resolves')
  assert.equal(resolvePath('nope/missing.ts', tree, index).how, 'absent')

  const r = verifyCitations(extractCitations('page.tsx:9 and index.ts:4 and gone.ts:1'), TREE, lengthOf)
  assert.equal(r.testable, 1, 'only index.ts could be resolved to one file')
  assert.equal(r.ok, 1)
  assert.equal(r.ambiguous.length, 1)
  assert.equal(r.absent.length, 1)
})

test('a line past the end of the file is a citation to nothing', () => {
  const r = verifyCitations(extractCitations('packages/kit/src/index.ts:4 then packages/kit/src/index.ts:900'), TREE, lengthOf)
  assert.equal(r.testable, 2)
  assert.equal(r.ok, 1)
  assert.deepEqual(r.failures.map(f => f.raw), ['packages/kit/src/index.ts:900'])
  assert.equal(r.failures[0].length, 12)
})

test('an unreadable file is not a zero-length one', () => {
  // A binary or deleted file answers null. Treating that as 0 would flag every line cited in it, and
  // a corpus citing one such file would read as wholly fabricated.
  const r = verifyCitations(extractCitations('src/cli/args.mjs:10 and README.md:1'), TREE, p => (p === 'README.md' ? null : lengthOf(p)))
  assert.equal(r.testable, 1)
  assert.equal(r.ok, 1)
  assert.equal(r.unreadable.length, 1)
  assert.equal(r.failures.length, 0)
})

test('the control covers the direction you are NOT expecting', () => {
  // ⛔ The incident: an escaping step the shell reduced to one character turned every pattern into
  // garbage, and the audit reported EVERY citation as a phantom. The control in place proved the
  // file list had loaded — which was true, and useless. So the control asserts both directions.
  const good = matcherControl(TREE, lengthOf)
  assert.equal(good.ok, true)
  assert.equal(good.goodPassed, true)
  assert.equal(good.badFlagged, true)

  // A matcher that flags everything fails the control even though the tree loaded fine.
  const brokenAll = matcherControl(TREE, () => 0)
  assert.equal(brokenAll.ok, false)

  // And the third direction a naive control misses entirely: a path that cannot be in any tree must
  // come back untestable. A resolver answering "yes" to everything passes the first two cases, then
  // resolves a PR-branch file to an unrelated one with the same basename.
  assert.equal(good.phantomAbsent, true)
  const resolvesAnything = matcherControl([...TREE, 'zz-not-a-real-directory/zz-not-a-real-file.zzz'], p => (p.startsWith('zz-') ? 10 : lengthOf(p)))
  assert.equal(resolvesAnything.phantomAbsent, false)
  assert.equal(resolvesAnything.ok, false)

  assert.equal(matcherControl([], lengthOf).ok, false, 'an empty tree tests nothing and must never report ok')
})

test('verify-paths set-differences the cited paths, and a miss is triage not an error', () => {
  const text = 'see apps/site/src/app/page.tsx and packages/kit/src/index.ts and apps/site/src/app/new-file.tsx'
  const r = verifyPaths(extractPaths(text), TREE)
  assert.equal(r.total, 3)
  assert.equal(r.exact, 2)
  assert.deepEqual(r.missing, ['apps/site/src/app/new-file.tsx'], 'a PR-branch file is legitimately absent from the base')

  // A prose word is not a path: without a separator and an extension there is nothing to check.
  assert.deepEqual(extractPaths('the component and the page.tsx file'), [])
})
