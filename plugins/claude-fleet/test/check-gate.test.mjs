import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, decideCorpus, parseVerdicts, assertVerdictCoverage, applyPlan, promotionPlan, normaliseFixAxis } from '../src/check/gate.mjs'
import { admit, screenQueue, gateStatusOf, buildSelector, REFUSAL } from '../src/core/intake.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'

function cfg(over = {}) {
  const c = defaultsFor()
  setPath(c, 'checker.ready.state', 'Todo')
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

// ---- gate.decide -------------------------------------------------------------------------------

test('a real finding with a verified or absent fix passes', () => {
  assert.equal(decide({ diagnosis: 'real', severity: 'confirmed', fixAxis: 'verified' }).status, 'passed')
  assert.equal(decide({ diagnosis: 'real', severity: 'confirmed', fixAxis: 'absent' }).status, 'passed')
})

test('untested is NOT passed — a row nobody scored is a gap, not a pass', () => {
  const d = decide({ diagnosis: 'real', severity: 'confirmed' })
  assert.equal(d.status, 'pending')
  assert.match(d.reasons.join(' '), /untested/)
  assert.match(d.requires.join(' '), /score the prescribed fix/)
})

test('a defective prescription does not pass until the correction is in the BODY, where it is read', () => {
  const bad = decide({ diagnosis: 'real', severity: 'confirmed', fixAxis: 'defective' })
  assert.equal(bad.status, 'pending')
  assert.match(bad.requires.join(' '), /⛔ DO NOT block into the description/)
  const fixed = decide({ diagnosis: 'real', severity: 'confirmed', fixAxis: 'defective', bodyCorrected: true })
  assert.equal(fixed.status, 'passed')
  // a no-op prescription is treated the same way
  assert.equal(decide({ diagnosis: 'real', severity: 'confirmed', fixAxis: 'no_op' }).status, 'pending')
})

test('an understated or overstated severity blocks until priority, title and body are corrected', () => {
  assert.equal(decide({ diagnosis: 'real', severity: 'understated', fixAxis: 'verified' }).status, 'pending')
  assert.equal(decide({ diagnosis: 'real', severity: 'understated', fixAxis: 'verified', bodyCorrected: true }).status, 'passed')
})

test('false positives and already-fixed fail; uncertain stays uncertain — and they are different outcomes', () => {
  const fp = decide({ diagnosis: 'false_positive' })
  assert.equal(fp.status, 'failed')
  assert.match(fp.requires.join(' '), /evidence comment, then cancel/)
  const af = decide({ diagnosis: 'already_fixed' })
  assert.equal(af.status, 'failed')
  assert.match(af.requires.join(' '), /report separately/)
  assert.equal(decide({ diagnosis: 'uncertain' }).status, 'uncertain')
})

test('enum values normalise across case and separators; anything else throws', () => {
  assert.equal(decide({ diagnosis: 'REAL', severity: 'Confirmed', fixAxis: 'Verified' }).status, 'passed')
  assert.equal(normaliseFixAxis('no-op'), 'no_op')
  assert.throws(() => decide({ diagnosis: 'probably' }), /unrecognised/)
})

test('a corpus is not "gated" while any row is untested, and passed keys are listed', () => {
  const rows = [
    { fid: 'a|1|1', key: 'ABC-1', diagnosis: 'real', severity: 'confirmed', fixAxis: 'verified' },
    { fid: 'a|1|2', key: 'ABC-2', diagnosis: 'false_positive' },
    { fid: 'a|2|1', key: 'ABC-3', diagnosis: 'real', severity: 'confirmed' },
  ]
  const c = decideCorpus(rows)
  assert.equal(c.complete, false)
  assert.deepEqual(c.untested, ['a|2|1'])
  assert.deepEqual(c.passed, ['ABC-1'])
  assert.equal(c.counts.passed, 1)
  assert.equal(c.counts.failed, 1)
  const all = decideCorpus(rows.map(r => ({ ...r, fixAxis: r.fixAxis || 'verified' })))
  assert.equal(all.complete, true)
})

test('every filed finding must have exactly one verdict row — including the audit\'s own filings', () => {
  const filed = ['a|1|1', 'a|1|2', 'a|2|1']
  const rows = parseVerdicts([
    ['a|1|1', 'ABC-1', 'real', 'confirmed', 'verified', 'passed', 'run1', 'evidence'],
    ['a|1|2', 'ABC-2', 'real', 'confirmed', 'verified', 'passed', 'run1', ''],
  ])
  const gap = assertVerdictCoverage(filed, rows)
  assert.equal(gap.ok, false)
  assert.deepEqual(gap.missing, ['a|2|1'])
  const dupes = assertVerdictCoverage(['a|1|1'], parseVerdicts([['a|1|1', 'ABC-1', 'real', 'confirmed', 'verified', 'passed', 'r', ''], ['a|1|1', 'ABC-1', 'real', 'confirmed', 'verified', 'passed', 'r', '']]))
  assert.deepEqual(dupes.duplicates, ['a|1|1'])
  const extra = assertVerdictCoverage([], parseVerdicts([['x|1|1', 'ABC-9', 'real', 'confirmed', 'verified', 'passed', 'r', '']]))
  assert.deepEqual(extra.extra, ['x|1|1'])
})

test('applyPlan comments BEFORE cancelling and patches the Gate line', () => {
  const c = cfg()
  const decided = decideCorpus([
    { fid: 'a|1|1', key: 'ABC-1', diagnosis: 'real', severity: 'confirmed', fixAxis: 'verified', auditRunId: 'run1' },
    { fid: 'a|1|2', key: 'ABC-2', diagnosis: 'false_positive', evidence: 'the guard is present at example/x.ts:12', auditRunId: 'run1' },
  ])
  const ops = applyPlan(decided, c, 'ABC-1234')
  const forTwo = ops.filter(o => o.key === 'ABC-2').map(o => o.op)
  assert.deepEqual(forTwo, ['comment', 'updateIssue', 'cancel'])
  assert.equal(ops.find(o => o.key === 'ABC-2' && o.op === 'comment').verbatim, true)
  const patch = ops.find(o => o.key === 'ABC-1' && o.op === 'patchBody')
  assert.equal(patch.args.edits[0].find, '**Gate:** pending (ABC-1234)')
  assert.match(patch.args.edits[0].replace, /\*\*Gate:\*\* passed — diagnosis real · severity confirmed · fix verified \(run1\)/)
  const label = ops.find(o => o.key === 'ABC-1' && o.op === 'updateIssue')
  assert.deepEqual(label.args.labels, { add: ['gate:passed'], remove: ['gate:pending'] })
})

test('promotion only ever moves passed rows, and only with --auto', () => {
  const c = cfg()
  const decided = decideCorpus([
    { key: 'ABC-1', fid: 'a|1|1', diagnosis: 'real', severity: 'confirmed', fixAxis: 'verified' },
    { key: 'ABC-2', fid: 'a|1|2', diagnosis: 'real', severity: 'confirmed', fixAxis: 'defective' },
    { key: 'ABC-3', fid: 'a|1|3', diagnosis: 'false_positive' },
  ])
  assert.deepEqual(promotionPlan(decided, c, { auto: false }), [])
  const auto = promotionPlan(decided, c, { auto: true })
  assert.deepEqual(auto.map(o => o.key), ['ABC-1'])
  assert.deepEqual(auto[0].args.labels.remove, ['triage'])
  assert.equal(auto[0].args.state, 'Todo')
})

// ---- intake ------------------------------------------------------------------------------------

const filed = (labels, body = '') => ({ key: 'ABC-1', labels: ['filed-by:fleet-check', ...labels], body })

test('a human-filed ticket is admitted unconditionally — the gate is for machine findings', () => {
  const r = admit({ key: 'ABC-9', labels: ['bug'] }, cfg())
  assert.deepEqual([r.admit, r.reason], [true, null])
})

test('a checker-filed ticket is refused without a passed gate, whatever state a human moved it to', () => {
  const c = cfg()
  assert.equal(admit(filed(['gate:pending']), c).reason, REFUSAL.UNGATED)
  assert.equal(admit(filed([]), c).reason, REFUSAL.UNGATED)
  assert.equal(admit(filed(['gate:failed']), c).reason, REFUSAL.GATE_FAILED)
  assert.equal(admit(filed(['gate:disputed']), c).reason, REFUSAL.GATE_DISPUTED)
  assert.equal(admit(filed(['gate:uncertain']), c).reason, REFUSAL.GATE_UNCERTAIN)
  assert.equal(admit(filed(['gate:passed']), c).admit, true)
  const waived = admit(filed(['gate:waived']), c)
  assert.deepEqual([waived.admit, waived.warn], [true, 'intake.waived'])
})

test('the gate status falls back to the body line when labels are unavailable', () => {
  const c = cfg()
  assert.equal(gateStatusOf({ labels: [], body: '**Gate:** passed — diagnosis real' }, c), 'passed')
  assert.equal(admit(filed([], '**Gate:** passed — diagnosis real · severity confirmed'), c).admit, true)
  assert.equal(gateStatusOf({ labels: [], body: 'no gate line' }, c), null)
})

test('a tracker/local mismatch is admitted with a warning, not silently trusted', () => {
  const c = cfg()
  const r = admit(filed(['gate:passed']), c, { localFinding: { gate: { status: 'pending' } } })
  assert.deepEqual([r.admit, r.warn], [true, 'intake.mismatch'])
})

test('requireGate can be turned off, and says so', () => {
  const c = cfg({ 'fleet.queue.requireGate': false })
  const r = admit(filed(['gate:pending']), c)
  assert.deepEqual([r.admit, r.warn], [true, 'intake.gate-disabled'])
})

test('screenQueue partitions and summarises refusals so a shrinking queue is never silent', () => {
  const c = cfg()
  const issues = [
    { key: 'ABC-1', labels: ['filed-by:fleet-check', 'gate:passed'] },
    { key: 'ABC-2', labels: ['filed-by:fleet-check', 'gate:pending'] },
    { key: 'ABC-3', labels: ['filed-by:fleet-check'] },
    { key: 'ABC-4', labels: ['bug'] },
  ]
  const r = screenQueue(issues, c)
  assert.deepEqual(r.admitted.map(a => a.issue.key), ['ABC-1', 'ABC-4'])
  assert.deepEqual(r.refused.map(a => a.issue.key), ['ABC-2', 'ABC-3'])
  assert.deepEqual(r.byReason, { ungated: 2 })
  assert.equal(r.summary, '2 refused: ungated')
})

test('buildSelector excludes the triage label by default', () => {
  const c = cfg()
  setPath(c, 'fleet.queue.selector.excludeLabels', ['triage'])
  setPath(c, 'fleet.queue.selector.state', 'Todo')
  assert.deepEqual(buildSelector(c), { state: 'Todo', labels: [], excludeLabels: ['triage'], group: undefined, assignee: undefined })
})
