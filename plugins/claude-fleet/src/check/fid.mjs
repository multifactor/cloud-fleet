// Opaque finding ids and the four-count reconciliation.
//
// A `fid` is `<slice>|<pr>|<index>` — opaque on purpose. Joining findings to filed tickets by TITLE
// similarity mis-scored roughly a quarter of a real corpus; an opaque key cannot drift.
//
// "0 failed" is a claim until four numbers agree: rows written, unique fids, unique issue keys, and
// the slice total. fourCounts() reports WHICH number diverged, because "they disagree" is not
// actionable on its own.

export function makeFid(slice, pr, index) {
  if (String(slice).includes('|')) throw new Error('fid: slice must not contain "|"')
  return `${slice}|${pr}|${index}`
}

export function parseFid(fid) {
  const m = /^([^|]+)\|([^|]+)\|(\d+)$/.exec(String(fid))
  if (!m) return null
  return { slice: m[1], pr: m[2], index: Number(m[3]) }
}

/** Mint `count` fids for one PR in one slice, starting at `startIndex`. */
export function mintFids(slice, pr, count, startIndex = 1) {
  return Array.from({ length: count }, (_, i) => makeFid(slice, pr, startIndex + i))
}

/**
 * Reconcile a slice's filed rows.
 * @param {Array<{fid: string, key: string}>} rows  what the worker recorded
 * @param {number} sliceTotal                        how many findings the slice was supposed to file
 * @returns {{ok: boolean, counts: object, diverged: string[], duplicateFids: string[], duplicateKeys: string[], missingFid: number, missingKey: number}}
 */
export function fourCounts(rows, sliceTotal) {
  const fids = rows.map(r => r.fid).filter(Boolean)
  const keys = rows.map(r => r.key).filter(Boolean)
  const uniqFids = new Set(fids)
  const uniqKeys = new Set(keys)
  const counts = { rows: rows.length, uniqueFids: uniqFids.size, uniqueKeys: uniqKeys.size, sliceTotal }
  const seenF = new Set()
  const duplicateFids = []
  for (const f of fids) { if (seenF.has(f)) duplicateFids.push(f); seenF.add(f) }
  const seenK = new Set()
  const duplicateKeys = []
  for (const k of keys) { if (seenK.has(k)) duplicateKeys.push(k); seenK.add(k) }
  const diverged = []
  if (counts.uniqueFids !== counts.rows) diverged.push('uniqueFids')
  if (counts.uniqueKeys !== counts.rows) diverged.push('uniqueKeys')
  if (counts.sliceTotal !== counts.rows) diverged.push('sliceTotal')
  return {
    ok: diverged.length === 0,
    counts,
    diverged,
    duplicateFids,
    duplicateKeys,
    missingFid: rows.length - fids.length,
    missingKey: rows.length - keys.length,
  }
}
