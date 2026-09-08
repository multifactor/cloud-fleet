// The sweep work-list: parsing a tracker checklist into PR rows, and the write-once file.
//
// ⛔ The work-list is written ONCE at the start of a sweep and never re-derived. Re-deriving it
// mid-sweep is the main source of forge flakiness and makes "what is left" unanswerable.
//
// Parsing rules, each from a real mis-parse:
//   * only lines that BEGIN a list item are work items — a `#4321` mentioned inside another line's
//     title is prose, not an item;
//   * `- [x]` / `- [X]` are done and are skipped (that skip is what makes a sweep resumable);
//   * a PR URL is as valid an item as `#123`;
//   * the `#` is REQUIRED for a bare number — an optional one once read `- [ ] 2026-03-14 release
//     notes` as PR 2026.

const ITEM = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/
const PR_HASH = /^#(\d+)\b/
const PR_URL = /(?:https?:\/\/[^\s)]+?\/(?:pull|pull-requests|merge_requests|-\/merge_requests)\/(\d+))/

/** Parse one checklist line into {pr, done, keys, raw, title} or null. */
export function parseItem(line) {
  const m = ITEM.exec(line)
  if (!m) return null
  const done = m[1].toLowerCase() === 'x'
  const rest = m[2].trim()
  let pr = null
  const h = PR_HASH.exec(rest)
  if (h) pr = h[1]
  if (!pr) {
    const u = PR_URL.exec(rest)
    if (u) pr = u[1]
  }
  if (!pr) return null
  const keys = [...rest.matchAll(/`([A-Za-z][A-Za-z0-9]*-\d+)`/g)].map(x => x[1])
  const title = rest.replace(PR_HASH, '').replace(/^\s*[-–—:]\s*/, '').trim()
  return { pr, done, keys, title, raw: line }
}

/** Parse a whole checklist body. Returns every item, done or not, in order. */
export function parseWorkItems(body) {
  const out = []
  for (const line of String(body || '').split(/\r?\n/)) {
    const item = parseItem(line)
    if (item) out.push(item)
  }
  return out
}

/** The unchecked items — the actual work of a sweep. */
export function pendingItems(body) {
  return parseWorkItems(body).filter(i => !i.done)
}

/** Rows for worklist.tsv: `<pr>\t<merged_at|open>\t<title>`. */
export function worklistRows(items) {
  return items.map(i => [String(i.pr), i.mergedAt || 'open', i.title || ''])
}

/** Parse worklist.tsv rows back into objects. */
export function parseWorklistRows(rows) {
  return rows.map(r => ({ pr: r[0], mergedAt: r[1] === 'open' ? null : r[1], open: r[1] === 'open', title: r[2] || '' }))
}

/** Deterministic sweep id: a tracker key, or a hash of the PR set / source file. */
export function sweepIdFor(input, sha1) {
  if (input.kind === 'tracker-issue') return input.ref
  if (input.kind === 'prs') return 'prs-' + sha1([...input.prs].map(String).sort((a, b) => Number(a) - Number(b)).join(',')).slice(0, 8)
  if (input.kind === 'file') return 'file-' + sha1(String(input.ref)).slice(0, 8)
  throw new Error(`sweepIdFor: unknown input kind "${input.kind}"`)
}
