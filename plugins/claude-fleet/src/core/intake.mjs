// Fleet intake: which tickets may be worked.
//
// This is the consumer-side half of the audit gate. A human moving an ungated checker ticket into
// the ready state does NOT get it worked — the refusal says why. Refusals are counted and logged,
// never silent, because a silently shrinking queue reads as "there was no work".
//
// A ticket nobody's checker filed (no provenance label) is ordinary human-filed work and is admitted
// unconditionally: the gate exists for machine-generated findings, not for the team's own backlog.

export const REFUSAL = {
  UNGATED: 'ungated',
  GATE_FAILED: 'gate-failed',
  GATE_DISPUTED: 'gate-disputed',
  GATE_UNCERTAIN: 'gate-uncertain',
}

const has = (labels, name) => !!name && Array.isArray(labels) && labels.includes(name)

/** The gate status a ticket declares, from its labels first and its body line as a fallback. */
export function gateStatusOf(issue, cfg) {
  const L = cfg.checker.gate.labels
  const labels = issue.labels || []
  for (const [status, label] of Object.entries(L)) {
    if (has(labels, label)) return status
  }
  const m = /^\s*\*\*Gate:\*\*\s*([a-z]+)/im.exec(issue.body || '')
  return m ? m[1].toLowerCase() : null
}

/**
 * @param {{key, labels?: string[], body?: string}} issue
 * @param {object} cfg  resolved config
 * @param {{localFinding?: {gate?: {status: string}}}} ctx
 * @returns {{admit: boolean, reason: string|null, warn: string|null, gate: string|null}}
 */
export function admit(issue, cfg, ctx = {}) {
  const provenance = cfg.checker.provenanceLabel
  const isCheckerFiled = has(issue.labels, provenance)
  if (!isCheckerFiled) return { admit: true, reason: null, warn: null, gate: null }
  if (!cfg.fleet.queue.requireGate) return { admit: true, reason: null, warn: 'intake.gate-disabled', gate: gateStatusOf(issue, cfg) }

  const gate = gateStatusOf(issue, cfg)
  const local = ctx.localFinding && ctx.localFinding.gate && ctx.localFinding.gate.status
  let warn = null
  if (local && gate && local !== gate) warn = 'intake.mismatch'

  if (gate === 'waived') return { admit: true, reason: null, warn: warn || 'intake.waived', gate }
  if (gate === 'passed') return { admit: true, reason: null, warn, gate }
  if (gate === 'failed') return { admit: false, reason: REFUSAL.GATE_FAILED, warn, gate }
  if (gate === 'disputed') return { admit: false, reason: REFUSAL.GATE_DISPUTED, warn, gate }
  if (gate === 'uncertain') return { admit: false, reason: REFUSAL.GATE_UNCERTAIN, warn, gate }
  return { admit: false, reason: REFUSAL.UNGATED, warn, gate }
}

/** Partition a queue, with a human-readable line per refusal reason. */
export function screenQueue(issues, cfg, findingsByKey = new Map()) {
  const admitted = []
  const refused = []
  for (const issue of issues) {
    const r = admit(issue, cfg, { localFinding: findingsByKey.get(issue.key) })
    if (r.admit) admitted.push({ issue, ...r })
    else refused.push({ issue, ...r })
  }
  const byReason = {}
  for (const r of refused) byReason[r.reason] = (byReason[r.reason] || 0) + 1
  const summary = Object.entries(byReason)
    .map(([reason, n]) => `${n} refused: ${reason}`)
    .join('; ')
  return { admitted, refused, byReason, summary }
}

/** The selector a tracker query is built from (contract: fleet.queue.selector). */
export function buildSelector(cfg) {
  const s = cfg.fleet.queue.selector
  return {
    state: s.state || undefined,
    labels: (s.labels || []).slice(),
    excludeLabels: (s.excludeLabels || []).slice(),
    group: s.group || undefined,
    assignee: s.assignee || undefined,
  }
}
