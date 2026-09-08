// The audit gate — the precondition for handing a checker-filed ticket to a fleet session.
//
// Why this is mandatory rather than advisory: an implementation spec was once generated from a
// finding that had not passed the gate; the gate later returned `understated` and the spec inherited
// both gaps. The rule drawn was "never generate an implementation spec from a finding that has not
// passed the severity gate — make the gate a precondition of spec-writing, not a parallel track",
// with the diagnostic: if you can produce a spec faster than the finding can be adversarially
// verified, you are producing specs from unverified input by construction.
//
// The second axis exists because the PRESCRIBED FIX is not the diagnosis and fails independently of
// it — measured worst in the band where the diagnosis was most accurate. A defective prescription is
// not "a note for later": in a pipeline where work-orders are generated from descriptions, the
// harmful instruction is the thing that gets executed. So a defective fix does not pass until the
// correction is in the BODY, where the next reader acts, not only in a comment.

export const DIAGNOSIS = ['real', 'false_positive', 'already_fixed', 'uncertain']
export const SEVERITY = ['confirmed', 'understated', 'overstated', 'n/a']
export const FIX_AXIS = ['verified', 'defective', 'no_op', 'absent', 'untested']
export const GATE = ['pending', 'passed', 'failed', 'uncertain', 'disputed', 'waived']

const oneOf = (name, list, v) => {
  const k = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const hit = list.find(x => x.replace(/[\s-]+/g, '_') === k)
  if (!hit) throw new Error(`${name}: unrecognised value "${v}" (expected one of ${list.join('|')})`)
  return hit
}

export const normaliseDiagnosis = v => oneOf('diagnosis', DIAGNOSIS, v)
export const normaliseSeverity = v => oneOf('severity', SEVERITY, v)
export const normaliseFixAxis = v => oneOf('fixAxis', FIX_AXIS, v)

/**
 * Decide one row's gate status.
 * @param {{diagnosis, severity, fixAxis, bodyCorrected?: boolean}} row
 * @returns {{status: string, reasons: string[], requires: string[]}}
 *   `requires` lists the concrete action that would move the row to `passed`.
 */
export function decide(row) {
  const diagnosis = normaliseDiagnosis(row.diagnosis)
  const fixAxis = normaliseFixAxis(row.fixAxis ?? 'untested')
  const severity = normaliseSeverity(row.severity ?? (diagnosis === 'real' ? 'confirmed' : 'n/a'))
  const reasons = []
  const requires = []

  if (diagnosis === 'false_positive') return { status: 'failed', reasons: ['diagnosis: false_positive'], requires: ['post the evidence comment, then cancel'] }
  if (diagnosis === 'already_fixed') return { status: 'failed', reasons: ['diagnosis: already_fixed'], requires: ['post the evidence comment, then cancel (report separately from confirmed-bogus)'] }
  if (diagnosis === 'uncertain') return { status: 'uncertain', reasons: ['diagnosis: uncertain'], requires: ['a second, independent verification'] }

  if (fixAxis === 'untested') {
    reasons.push('fixAxis: untested — the gate was not completed for this row')
    requires.push('score the prescribed fix (verified | defective | no_op | absent)')
  }
  if (fixAxis === 'defective' || fixAxis === 'no_op') {
    reasons.push(`fixAxis: ${fixAxis}`)
    if (!row.bodyCorrected) requires.push('patch a ⛔ DO NOT block into the description immediately after the prescription, then re-decide')
  }
  if (severity !== 'confirmed' && severity !== 'n/a') {
    reasons.push(`severity: ${severity}`)
    if (!row.bodyCorrected) requires.push('correct the priority field, the title AND the body, then re-decide')
  }

  const fixOk = fixAxis === 'verified' || fixAxis === 'absent' || ((fixAxis === 'defective' || fixAxis === 'no_op') && row.bodyCorrected === true)
  const sevOk = severity === 'confirmed' || severity === 'n/a' || row.bodyCorrected === true
  if (fixOk && sevOk) return { status: 'passed', reasons, requires: [] }
  return { status: 'pending', reasons, requires }
}

/**
 * Decide a whole corpus and refuse to call it gated while any row is untested.
 * "Untested" only applies to rows whose diagnosis is `real` — a false positive or an already-fixed
 * finding has no prescribed fix to score, and demanding one would make a complete gate unreachable.
 */
export function decideCorpus(rows) {
  const decided = rows.map(r => ({ ...r, gate: decide(r) }))
  const counts = Object.fromEntries(GATE.map(g => [g, 0]))
  for (const d of decided) counts[d.gate.status]++
  const untested = decided.filter(d => normaliseDiagnosis(d.diagnosis) === 'real' && normaliseFixAxis(d.fixAxis ?? 'untested') === 'untested')
  return {
    rows: decided,
    counts,
    complete: untested.length === 0,
    untested: untested.map(d => d.fid || d.key),
    passed: decided.filter(d => d.gate.status === 'passed').map(d => d.key).filter(Boolean),
  }
}

/** Parse an audit verdicts.tsv row set (field-based, never regex over the file). */
export function parseVerdicts(rows) {
  return rows.map(r => ({ fid: r[0], key: r[1], diagnosis: r[2], severity: r[3], fixAxis: r[4], gate: r[5], auditRunId: r[6], evidence: r[7] || '' }))
}

/**
 * Every filed finding must have exactly one verdict row — including the findings the audit itself
 * filed, because a gate that files findings extends its own denominator.
 */
export function assertVerdictCoverage(filedFids, verdictRows) {
  const v = new Set(verdictRows.map(r => r.fid))
  const f = new Set(filedFids)
  const missing = [...f].filter(x => !v.has(x))
  const extra = [...v].filter(x => !f.has(x))
  const dupes = []
  const seen = new Set()
  for (const r of verdictRows) { if (seen.has(r.fid)) dupes.push(r.fid); seen.add(r.fid) }
  return { ok: !missing.length && !extra.length && !dupes.length, missing, extra, duplicates: dupes }
}

/** The tracker ops that apply a decided corpus. Returns outbox entries, in a safe order. */
export function applyPlan(decided, cfg, sweepId) {
  const L = cfg.checker.gate.labels
  const ops = []
  for (const row of decided.rows) {
    const status = row.gate.status
    const label = L[status] || L.pending
    if (status === 'failed') {
      ops.push({ op: 'comment', key: row.key, args: { text: row.evidence || 'Cancelled by the audit gate.' }, verbatim: true })
      ops.push({ op: 'updateIssue', key: row.key, args: { labels: { add: [label], remove: [L.pending] } } })
      ops.push({ op: 'cancel', key: row.key, args: { reason: row.diagnosis } })
      continue
    }
    ops.push({ op: 'updateIssue', key: row.key, args: { labels: { add: [label], remove: [L.pending] } } })
    ops.push({
      op: 'patchBody',
      key: row.key,
      args: { edits: [{ find: `**Gate:** pending (${sweepId})`, replace: `**Gate:** ${status} — diagnosis ${row.diagnosis} · severity ${row.severity ?? 'n/a'} · fix ${row.fixAxis ?? 'untested'} (${row.auditRunId || 'audit'})` }] },
    })
  }
  return ops
}

/** Promotion ops for the rows a human (or --auto) may hand to the fleet. */
export function promotionPlan(decided, cfg, { auto }) {
  if (!auto) return []
  const L = cfg.checker.gate.labels
  return decided.rows
    .filter(r => r.gate.status === 'passed')
    .map(r => ({
      op: 'updateIssue',
      key: r.key,
      args: {
        labels: { add: cfg.checker.ready.label ? [cfg.checker.ready.label] : [], remove: [cfg.checker.triage.label].filter(Boolean) },
        state: cfg.checker.ready.state || undefined,
      },
      note: `promoted after the audit gate (${L.passed})`,
    }))
}
