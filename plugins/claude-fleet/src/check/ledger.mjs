// The sweep ledger: one append-only line per resolved PR, and the resume arithmetic.
//
// ⛔ A PR is not done until its outcome is on disk. Nothing in context, in a plan, or in a tracker
// query counts as progress.
//
// Rules encoded here, each a bug that happened:
//   * append after EVERY PR, never batched (a tool timeout silently dropped three appends);
//   * `failed` lines are MANDATORY — a missing line means "never attempted", which is worse and less
//     recoverable than "attempted and failed";
//   * one machine-readable format only;
//   * resume prints all three counts, and `done == 0` against a non-empty ledger file means the
//     ledger did not load — not that no work was done;
//   * bind the ledger line to the OUTCOME, never to the delivery path: a resume once reported 231
//     remaining when the truth was 148 because the write hung off the harvest step.

export const LEDGER_STATUSES = ['filed', 'clean', 'skipped', 'failed']

/** Build one ledger row: `<pr>\t<status>\t<keys|->\t<iso>\t<note>`. */
export function ledgerRow({ pr, status, keys = [], at, note = '' }) {
  if (!LEDGER_STATUSES.includes(status)) {
    throw new Error(`ledger: status must be one of ${LEDGER_STATUSES.join('|')}, got "${status}"`)
  }
  if (pr === undefined || pr === null || String(pr) === '') throw new Error('ledger: pr is required')
  if (!at) throw new Error('ledger: a timestamp is required')
  return [String(pr), status, keys.length ? keys.join(',') : '-', at, note]
}

/** Parse ledger.tsv rows. */
export function parseLedger(rows) {
  return rows.map(r => ({
    pr: r[0],
    status: r[1],
    keys: r[2] && r[2] !== '-' ? r[2].split(',').filter(Boolean) : [],
    at: r[3] || '',
    note: r[4] || '',
  }))
}

/** Last entry per PR (a PR may be retried; the last outcome wins). */
export function latestByPr(entries) {
  const m = new Map()
  for (const e of entries) m.set(String(e.pr), e)
  return m
}

/**
 * Resume arithmetic: set-difference of the worklist against the ledger, on the PR column.
 * @returns {{worklist: number, done: number, remaining: number, remainingPrs: string[], lastFiled: object|null, error: string|null}}
 */
export function resumeCounts({ worklistPrs, ledgerEntries, ledgerFileNonEmpty = false }) {
  const latest = latestByPr(ledgerEntries)
  const done = worklistPrs.filter(pr => latest.has(String(pr)))
  const remainingPrs = worklistPrs.filter(pr => !latest.has(String(pr))).map(String)
  const filed = ledgerEntries.filter(e => e.status === 'filed')
  const lastFiled = filed.length ? filed[filed.length - 1] : null
  let error = null
  if (done.length === 0 && ledgerFileNonEmpty) {
    error = 'the ledger file is non-empty but no PR matched the worklist — the ledger did not load; stop and investigate rather than re-running the whole sweep'
  }
  return { worklist: worklistPrs.length, done: done.length, remaining: remainingPrs.length, remainingPrs, lastFiled, error }
}

/**
 * Rebuild ledger lines the sweep failed to write, from the findings it actually produced.
 * A findings row proves an outcome; the absence of a ledger line only proves a missed write.
 * @returns {Array<object>} rows to append, in PR order
 */
export function reconcileFromFindings({ worklistPrs, ledgerEntries, findings, at, note = 'reconciled from findings' }) {
  const latest = latestByPr(ledgerEntries)
  const byPr = new Map()
  for (const f of findings) {
    const pr = String(f.pr)
    if (!byPr.has(pr)) byPr.set(pr, [])
    byPr.get(pr).push(f)
  }
  const out = []
  for (const pr of worklistPrs.map(String)) {
    if (latest.has(pr)) continue
    const rows = byPr.get(pr)
    if (!rows || !rows.length) continue
    const keys = rows.map(r => r.key).filter(Boolean)
    out.push(ledgerRow({ pr, status: keys.length ? 'filed' : 'clean', keys, at, note }))
  }
  return out
}

/** Counts by status, for the final report. */
export function statusCounts(entries) {
  const out = Object.fromEntries(LEDGER_STATUSES.map(s => [s, 0]))
  for (const e of latestByPr(entries).values()) if (out[e.status] !== undefined) out[e.status]++
  return out
}
