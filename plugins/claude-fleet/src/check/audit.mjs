// PURE. The audit's worker layout: who reads which findings, and which findings get read twice.
//
// The audit is three passes with different shapes, and the shapes are not interchangeable:
//
//   * GATE 1 — doubt-driven, grouped BY PR. A worker reads one PR's cached diff once and judges every
//     finding filed against it, so grouping by PR is what makes the diff read pay for itself.
//   * The CONSEQUENCE-driven pass — every Urgent, and every High carrying the security label, read
//     again REGARDLESS of gate 1's verdict. Doubt and consequence have opposite yields and catch
//     different errors; a corpus scored only for doubt has never had its worst findings' prescribed
//     fixes tested.
//   * The CONTRADICTION pass — grouped BY CATEGORY, because the pairs it exists to find are two
//     workers at opposite ends of one pattern, each of whom saw only their own PR: one writes "do X"
//     and the other files X as a defect, and nothing inside either ticket reveals it.
//
// ⛔ The category batches are built from a `category` the FINDINGS carry, and this module never
//    invents one. A taxonomy guessed here would group tickets that share a word, which is the
//    over-grouping failure the structural pass exists to complement — and it would do it silently.
//    When the corpus carries no categories, that is REPORTED as a gap in the plan, not papered over
//    by falling back to PR batches under a different name.

/** ~9 findings per worker: enough context to see a pattern, few enough to read every file named. */
export const BATCH = 9

/** Priority 1 is Urgent, 2 is High — the two bands the consequence-driven pass can draw from. */
export const URGENT = 1
export const HIGH = 2

const chunk = (xs, n) => {
  const out = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

const groupBy = (xs, key) => {
  const m = new Map()
  for (const x of xs) {
    const k = key(x)
    if (k == null) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(x)
  }
  return m
}

/**
 * Plan an audit run over a finished corpus.
 *
 * @param {Array<object>} findings   the sweep's findings, joined to what was filed (`fid`, `key`,
 *   `pr`, `priority`, `labels?`, `category?`)
 * @param {{batch?: number, securityLabel?: string|null}} [opts]
 * @returns {{gate1, consequence, categories, uncategorised, counts, gaps}}
 *   `gaps` names what this plan could NOT lay out and why — an audit that silently skipped a pass
 *   would report a gated corpus that two of its three passes never saw.
 */
export function planAudit(findings, { batch = BATCH, securityLabel = null } = {}) {
  if (!Number.isInteger(batch) || batch < 1) throw new Error(`planAudit: batch must be a positive integer, got ${batch}`)
  const rows = (findings || []).filter(f => f && (f.fid || f.key))
  const gaps = []

  // ---- gate 1: by PR ------------------------------------------------------------------------------
  const byPr = groupBy(rows, f => (f.pr == null ? null : String(f.pr)))
  const gate1 = []
  for (const [pr, group] of [...byPr.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    for (const [i, part] of chunk(group, batch).entries()) {
      gate1.push({ id: `g1-${pr}${i ? `-${i + 1}` : ''}`, pr, members: part.map(f => f.fid || f.key) })
    }
  }
  const unpr = rows.filter(f => f.pr == null)
  if (unpr.length) gaps.push(`${unpr.length} finding(s) name no PR and are in no gate-1 batch — gate 1 reads one PR's diff per worker, so a finding with no PR has no diff to be read against`)

  // ---- the consequence-driven pass ----------------------------------------------------------------
  const isSecurity = f => !!(securityLabel && Array.isArray(f.labels) && f.labels.includes(securityLabel))
  const consequenceRows = rows.filter(f => Number(f.priority) === URGENT || (Number(f.priority) === HIGH && isSecurity(f)))
  const consequence = chunk(consequenceRows, batch).map((part, i) => ({ id: `cons-${i + 1}`, members: part.map(f => f.fid || f.key) }))
  if (!securityLabel) {
    gaps.push('checker.securityLabel is not set, so the consequence-driven pass covers Urgent only — a High carrying a security label cannot be identified')
  }

  // ---- the contradiction pass: by category --------------------------------------------------------
  const byCategory = groupBy(rows, f => (typeof f.category === 'string' && f.category.trim() ? f.category.trim() : null))
  const categories = []
  for (const [category, group] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [i, part] of chunk(group, batch).entries()) {
      categories.push({ id: `cat-${category}${i ? `-${i + 1}` : ''}`, category, members: part.map(f => f.fid || f.key) })
    }
  }
  const uncategorised = rows.filter(f => !(typeof f.category === 'string' && f.category.trim())).map(f => f.fid || f.key)
  if (uncategorised.length) {
    gaps.push(`${uncategorised.length} of ${rows.length} finding(s) record no \`category\`, so the contradiction pass cannot be laid out for them — it is the pass that finds one ticket prescribing what another files as a defect, and those pairs are adjacent in the category tree and nowhere else. The worker brief must ask for a category.`)
  }

  return {
    gate1,
    consequence,
    categories,
    uncategorised,
    counts: {
      findings: rows.length,
      gate1Batches: gate1.length,
      consequenceFindings: consequenceRows.length,
      consequenceBatches: consequence.length,
      categories: byCategory.size,
      categoryBatches: categories.length,
    },
    gaps,
  }
}

/** One row per batch member: `pass  batch  fid  pr  priority  category`. */
export function batchRows(plan, findings) {
  const by = new Map((findings || []).map(f => [f.fid || f.key, f]))
  const rows = []
  const emit = (pass, batches) => {
    for (const b of batches) {
      for (const id of b.members) {
        const f = by.get(id) || {}
        rows.push([pass, b.id, id, String(f.pr ?? ''), String(f.priority ?? ''), String(f.category ?? '')])
      }
    }
  }
  emit('gate1', plan.gate1)
  emit('consequence', plan.consequence)
  emit('category', plan.categories)
  return rows
}
