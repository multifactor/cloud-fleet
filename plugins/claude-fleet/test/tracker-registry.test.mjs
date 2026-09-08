// The adapter contract, enforced: this is what makes "a stranger can add a tracker by PR" true.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './helpers/prose.mjs'
import {
  listAdapters, adapterPath, loadAdapter, parseAdapter, validateAdapter, isConnected, issueKeyRegex,
  canonicalKey, branchCorpus, OP_COUNT, OP_NAMES, CAPABILITY_FOR_OP,
} from '../src/trackers/registry.mjs'

const BUNDLED = path.join(ROOT, 'trackers')

test('the op table has 27 entries and op-5/op-7 share a name (why sections are keyed by number)', () => {
  assert.equal(OP_NAMES.length - 1, OP_COUNT)
  assert.equal(OP_NAMES[5], 'setState')
  assert.equal(OP_NAMES[7], 'setState')
  assert.equal(CAPABILITY_FOR_OP[23], 'subIssues')
})

test('every bundled adapter passes validation with no errors', () => {
  const ids = listAdapters({ bundledDir: BUNDLED })
  assert.ok(ids.length >= 5, `expected the bundled adapters, got ${ids.join(', ')}`)
  const failures = []
  for (const id of ids) {
    const a = loadAdapter(id, { bundledDir: BUNDLED })
    const v = validateAdapter(a, { expectedId: id })
    if (!v.ok) failures.push(`${id}:\n    ${v.errors.join('\n    ')}`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('the template is excluded from listing but still parses and covers every op', () => {
  assert.ok(!listAdapters({ bundledDir: BUNDLED }).includes('_template'))
  const t = parseAdapter(fs.readFileSync(path.join(BUNDLED, '_template.md'), 'utf8'), { file: '_template.md' })
  for (let n = 1; n <= OP_COUNT; n++) assert.ok(t.sections[n], `template lacks op-${n}`)
})

test('a project overlay wins over the bundled adapter', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'fleet-adapters-'))
  fs.writeFileSync(path.join(tmp, 'linear.md'), '---\nid: linear\n---\n')
  assert.equal(adapterPath('linear', { bundledDir: BUNDLED, projectDir: tmp }), path.join(tmp, 'linear.md'))
  assert.equal(adapterPath('linear', { bundledDir: BUNDLED }), path.join(BUNDLED, 'linear.md'))
  assert.equal(adapterPath('nope', { bundledDir: BUNDLED }), null)
  assert.throws(() => adapterPath('../etc', { bundledDir: BUNDLED }), /lowercase slug/)
})

function minimalFront(over = {}) {
  return {
    id: 'x', name: 'X',
    mcp: { toolPrefixes: ['mcp__x__'], install: [{ label: 'l', command: 'c' }] },
    issueKey: { pattern: '[A-Z][A-Z0-9]+-[0-9]+', caseInsensitive: false, example: 'ABC-1234' },
    scope: { label: 'team', required: true, listOp: 'list_teams' },
    capabilities: { resolveChildren: true, cancel: true, attachLink: true, listQueue: true, comment: true, createIssue: true, labels: true, atomicPatch: true, subIssues: true, duplicateRelation: true, relations: true, grouping: 'project', imageEmbed: 'inline', imageUpload: 'mcp', workItems: 'body', findComplete: 'page-flag' },
    priority: { scale: 'numeric', map: { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' } },
    states: { 'in-progress': { promptDefault: 'In Progress' }, 'in-review': { promptDefault: 'In Review' }, cancelled: { promptDefault: 'Canceled' } },
    config: [],
    ...over,
  }
}
function fullBody({ omit = [], strategy = 'native-upload' } = {}) {
  let b = ''
  for (let n = 1; n <= OP_COUNT; n++) {
    if (omit.includes(n)) continue
    b += `## op-${n} ${OP_NAMES[n]}\nCall: \`do_${n}\`\n${n === 22 ? `Strategy: ${strategy}\n` : ''}If unsupported: n/a\n\n`
  }
  return b
}

test('validateAdapter catches the checklist items one by one', () => {
  const ok = validateAdapter({ front: minimalFront(), sections: parseAdapter('---\nid: x\n---\n' + fullBody()).sections }, { expectedId: 'x' })
  assert.deepEqual(ok.errors, [])

  const idMismatch = validateAdapter({ front: minimalFront({ id: 'y' }), sections: parseAdapter('---\nid: y\n---\n' + fullBody()).sections }, { expectedId: 'x' })
  assert.ok(idMismatch.errors.some(e => /must equal the filename/.test(e)))

  // the contract's own trap: case-insensitive, the pattern matches release-2 and testing-2
  const ci = validateAdapter({ front: minimalFront({ issueKey: { pattern: '[A-Z][A-Z0-9]+-[0-9]+', caseInsensitive: true, example: 'ABC-1234' } }), sections: parseAdapter('---\nid: x\n---\n' + fullBody()).sections })
  assert.ok(ci.errors.some(e => /matches the ordinary branch name "release-2"/.test(e)))

  const noExample = validateAdapter({ front: minimalFront({ issueKey: { pattern: '[A-Z]+-[0-9]+', example: 'nope' } }), sections: parseAdapter('---\nid: x\n---\n' + fullBody()).sections })
  assert.ok(noExample.errors.some(e => /does not match its own example/.test(e)))

  const missingOp = validateAdapter({ front: minimalFront(), sections: parseAdapter('---\nid: x\n---\n' + fullBody({ omit: [7] })).sections })
  assert.ok(missingOp.errors.some(e => /no "## op-7 setState"/.test(e)))

  const badStrategy = validateAdapter({ front: minimalFront(), sections: parseAdapter('---\nid: x\n---\n' + fullBody({ strategy: 'magic' })).sections })
  assert.ok(badStrategy.errors.some(e => /Strategy "magic"/.test(e)))

  const labelsPriority = validateAdapter({ front: minimalFront({ capabilities: { ...minimalFront().capabilities, labels: false }, priority: { scale: 'labels', map: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } } }), sections: parseAdapter('---\nid: x\n---\n' + fullBody()).sections })
  assert.ok(labelsPriority.errors.some(e => /priority.scale is "labels" but capabilities.labels is false/.test(e)))

  const dup = validateAdapter({ front: minimalFront(), sections: parseAdapter('---\nid: x\n---\n' + fullBody() + '## op-3 resolveUser\nCall: again\nIf unsupported: x\n').sections })
  assert.ok(dup.errors.some(e => /op-3 appears more than once/.test(e)))
})

test('an unsupported capability makes its op section a degradation, not a required Call', () => {
  const front = minimalFront({ capabilities: { ...minimalFront().capabilities, subIssues: false } })
  let body = fullBody({ omit: [23] })
  body += '## op-23 setParent\nIf unsupported: the umbrella becomes an index card listing children by key.\n'
  const v = validateAdapter({ front, sections: parseAdapter('---\nid: x\n---\n' + body).sections })
  assert.deepEqual(v.errors, [])
})

test('connection is judged from visible tool names; a CLI-only adapter needs none', () => {
  const front = minimalFront()
  assert.deepEqual(isConnected(front, ['mcp__x__get_issue', 'Read']).connected, true)
  assert.deepEqual(isConnected(front, ['mcp__y__get_issue']).connected, false)
  assert.equal(isConnected(minimalFront({ mcp: { toolPrefixes: [], install: [{ label: 'l', command: 'gh auth login' }] } }), []).connected, null)
})

test('issueKeyRegex is word-bounded and canonicalKey upper-cases before matching a case-sensitive pattern', () => {
  const front = minimalFront()
  const re = issueKeyRegex(front)
  assert.deepEqual('fix ABC-1234 and (XYZ-9)'.match(new RegExp(re.source, re.flags + 'g')), ['ABC-1234', 'XYZ-9'])
  assert.equal(re.test('feature/xabc-1234'), false)
  assert.equal(canonicalKey(front, 'abc-1234'), 'ABC-1234')
  // Two different jobs: issueKeyRegex RECOGNISES keys in arbitrary text and must never claim a
  // branch name; canonicalKey normalises something the operator explicitly passed AS a key, so
  // `--issues release-2` means the key RELEASE-2 — the operator said so.
  assert.equal(canonicalKey(front, 'release-2'), 'RELEASE-2')
  assert.equal(canonicalKey(front, 'not a key at all'), null)
  assert.equal(canonicalKey(minimalFront({ issueKey: { pattern: '[a-z0-9]{8}', caseInsensitive: false, example: 'aB3dEf7H' } }), 'aB3dEf7H'), null)
})

test('branchCorpus follows the configured base and testing names', () => {
  const c = branchCorpus({ repo: { baseBranch: 'trunk' }, testing: { base: 'stage' } })
  assert.ok(c.includes('trunk') && c.includes('stage') && c.includes('stage-2'))
})
