// Finding-level normalisation: priority, the a11y classification, and joining a ticket back to its PR.
//
// ⛔ Normalise every enum before you filter on it. A lowercase `high` once hid a High from a
// severity-scoped gate: the filter matched `High` and the row was invisible.
//
// ⛔ Join a ticket to its PR on the `**PR:**` HEADER LINE only. A good ticket body cites related PRs
// in prose, so a document-wide `#\d+` scan attributes findings to the wrong PR.

export const PRIORITIES = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' }

const PRIORITY_ALIASES = new Map([
  ['urgent', 1], ['p0', 1], ['critical', 1], ['blocker', 1],
  ['high', 2], ['p1', 2], ['major', 2],
  ['medium', 3], ['p2', 3], ['normal', 3], ['moderate', 3],
  ['low', 4], ['p3', 4], ['minor', 4], ['trivial', 4],
])

/** Canonical 1..4 from a number, a name in any case, or a P-code. Throws on anything else. */
export function normalisePriority(v) {
  if (v === null || v === undefined || v === '') throw new Error('priority: missing')
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v)
    if (n >= 1 && n <= 4) return n
    throw new Error(`priority: ${n} is outside 1..4`)
  }
  const k = String(v).trim().toLowerCase().replace(/\s+/g, '')
  if (PRIORITY_ALIASES.has(k)) return PRIORITY_ALIASES.get(k)
  throw new Error(`priority: unrecognised value "${v}"`)
}

export function priorityName(n) {
  return PRIORITIES[normalisePriority(n)]
}

/**
 * Distribution of a column's raw values — run this BEFORE filtering, so a stray casing shows up as
 * two buckets instead of hiding a row.
 * @returns {{distribution: Record<string, number>, canonical: Record<string, number>, offenders: string[]}}
 */
export function enumDistribution(values, normaliser) {
  const distribution = {}
  const canonical = {}
  const offenders = new Set()
  for (const v of values) {
    const raw = String(v)
    distribution[raw] = (distribution[raw] || 0) + 1
    try {
      const c = String(normaliser(v))
      canonical[c] = (canonical[c] || 0) + 1
      if (raw !== c && raw.toLowerCase() === c.toLowerCase()) offenders.add(raw)
      else if (raw !== c && normaliser(raw.toLowerCase()) === normaliser(c)) offenders.add(raw)
    } catch {
      offenders.add(raw)
    }
  }
  return { distribution, canonical, offenders: [...offenders] }
}

export const A11Y_CLASSES = ['none', 'keyboard', 'screen_reader', 'both']

/** Accept `screen-reader`, `screenReader`, `screen reader` … as one class. */
export function normaliseA11yClass(v) {
  const k = String(v || 'none').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (k === 'screenreader') return 'screen_reader'
  if (A11Y_CLASSES.includes(k)) return k
  throw new Error(`a11y: unrecognised class "${v}"`)
}

/**
 * The WHO-IS-HARMED test decides whether the a11y label goes on AT ALL; once it is on, the forced
 * priority is unconditional. A defect that harms everyone and merely has an a11y dimension is filed
 * at true severity WITHOUT the label — labelling it buries a real bug.
 * @param {{a11yClass: string, harmsEveryone: boolean, assessedPriority: number}} f
 * @param {{umbrella: boolean, forcedPriority: number|null, labels: {keyboard: string, screenReader: string}}} cfg
 */
export function classifyA11y(f, cfg) {
  const cls = normaliseA11yClass(f.a11yClass)
  const assessed = normalisePriority(f.assessedPriority)
  if (cls === 'none' || f.harmsEveryone) {
    return { labelled: false, labels: [], priority: assessed, assessedPriority: assessed, parented: false, note: null }
  }
  const labels = []
  if (cls === 'keyboard' || cls === 'both') labels.push(cfg.labels.keyboard)
  if (cls === 'screen_reader' || cls === 'both') labels.push(cfg.labels.screenReader)
  const forced = cfg.forcedPriority == null ? assessed : normalisePriority(cfg.forcedPriority)
  const note = forced !== assessed
    ? `filed ${PRIORITIES[forced]} per the standing accessibility rule; the review assessed this ${PRIORITIES[assessed]}`
    : null
  return { labelled: true, labels, priority: forced, assessedPriority: assessed, parented: !!cfg.umbrella, note }
}

const PR_HEADER = /^\s*\*\*PRs?:\*\*\s*(.+)$/im

/** The PR(s) a ticket body declares in its header line — never a `#\d+` from prose. */
export function joinToPr(body) {
  const m = PR_HEADER.exec(String(body || ''))
  if (!m) return []
  return [...m[1].matchAll(/#(\d+)/g)].map(x => x[1])
}

/** Render the issue body template (contract: the Gate line sits under Priority). */
export function renderIssueBody({ prs, prUrl, whatThePrDoes, edgeCase, priority, why, where = [], sweepId, screenshot = null, caption = null, noUiReason = null }) {
  const p = normalisePriority(priority)
  const lines = [
    `**PR:** ${prs.map(n => `#${n}`).join(', ')}${prUrl ? ` — ${prUrl}` : ''}`,
    `**What the PR does:** ${whatThePrDoes}`,
    `**Edge case:** ${edgeCase}`,
    `**Priority:** ${PRIORITIES[p]} — ${why}`,
    `**Gate:** pending (${sweepId})`,
  ]
  if (where.length) lines.push(`**Where:** ${where.map(w => `${w.path}:${w.line}${w.symbol ? ` (${w.symbol})` : ''}`).join(', ')}`)
  lines.push('')
  if (screenshot) {
    lines.push(`![screenshot](${screenshot})`)
    if (caption) lines.push(`_${caption}_`)
  } else if (noUiReason) {
    lines.push(`_No UI surface — ${noUiReason}._`)
  }
  return lines.join('\n')
}
