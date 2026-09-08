// PURE. Machine-checking the evidence an audit's conclusions rest on.
//
// Every conclusion in a delegated run is built on line numbers written by subagents, and citations
// have a falsifiable part that needs no judgement: does the file exist on the base branch, and is the
// cited line inside it? This module is the falsifiable part; the CLI verb supplies the tree.
//
// Two rules here are incidents, not preferences:
//
//   ⛔ BUILD NO REGEX FROM A FILENAME. Index by basename and join. An escaping step that a shell
//      reduced to a single character once turned every pattern into garbage, and the audit reported
//      EVERY citation in its corpus as a phantom — while the control in place proved only that the
//      file list had loaded, never that the matcher worked.
//   ⛔ AN AMBIGUOUS BASENAME IS NOT A MISS. `page.tsx` matches 134 files, `index.ts` 52. A basename
//      with more than one home cannot be resolved to a length, so it is reported as untestable and
//      excluded from the denominator — counting it as a failure would bury the real ones.

/** `path/to/file.ext:123` or a bare `file.ext:123`, as they appear inside prose. */
const CITATION = /\b([A-Za-z0-9_.\-/\\]+\.[A-Za-z0-9]+):(\d+)(?:[-–:]\d+)?\b/g

/** A path-shaped token: at least one separator and an extension, so prose words are not paths. */
const PATH_TOKEN = /\b([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]+)\b/g

/** Separator-blind, and `./` stripped — the same normalisation reconcile.mjs applies. */
export function normalise(p) {
  let s = String(p || '').trim().replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

export const basenameOf = p => normalise(p).split('/').pop()

/**
 * Every `file.ext:NNN` in the text, de-duplicated, in first-seen order.
 * @returns {Array<{raw: string, path: string, line: number}>}
 */
export function extractCitations(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(CITATION)) {
    const path = normalise(m[1])
    const line = Number(m[2])
    const raw = `${path}:${line}`
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push({ raw, path, line })
  }
  return out
}

/** Every path-shaped token in the text, de-duplicated, in first-seen order. */
export function extractPaths(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(PATH_TOKEN)) {
    const p = normalise(m[1])
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Group a tree listing by basename. A basename with one entry is resolvable; one with several is
 * ambiguous and one with none is absent.
 * @param {string[]} treePaths  `git ls-tree -r --name-only <ref>`
 */
export function basenameIndex(treePaths) {
  const index = new Map()
  for (const raw of treePaths) {
    const p = normalise(raw)
    if (!p) continue
    const base = basenameOf(p)
    if (!index.has(base)) index.set(base, [])
    index.get(base).push(p)
  }
  return index
}

/**
 * Resolve one cited path against the tree.
 *   `exact`     — the full path is in the tree (the only answer a first mention should ever need)
 *   `basename`  — the path is not, but its basename has exactly one home
 *   `ambiguous` — its basename has several homes, so nothing can be asserted about a line number
 *   `absent`    — neither
 */
export function resolvePath(path, tree, index) {
  const p = normalise(path)
  if (tree.has(p)) return { how: 'exact', path: p }
  const homes = index.get(basenameOf(p)) || []
  if (homes.length === 1) return { how: 'basename', path: homes[0] }
  if (homes.length > 1) return { how: 'ambiguous', path: null, homes }
  return { how: 'absent', path: null }
}

/**
 * Check every citation whose file could be resolved to exactly one path.
 * @param {Array<{raw, path, line}>} citations
 * @param {string[]} treePaths
 * @param {(path: string) => number|null} lengthOf  lines in that file on the ref; null when unreadable
 * @returns {{total, testable, ok, failures, ambiguous, absent, unreadable, rate}}
 */
export function verifyCitations(citations, treePaths, lengthOf) {
  const tree = new Set(treePaths.map(normalise))
  const index = basenameIndex(treePaths)
  const failures = []
  const ambiguous = []
  const absent = []
  const unreadable = []
  let testable = 0
  let ok = 0
  for (const c of citations) {
    const r = resolvePath(c.path, tree, index)
    if (r.how === 'ambiguous') { ambiguous.push({ ...c, homes: r.homes.length }); continue }
    if (r.how === 'absent') { absent.push(c); continue }
    const len = lengthOf(r.path)
    if (len === null || len === undefined) { unreadable.push({ ...c, resolved: r.path }); continue }
    testable++
    if (c.line >= 1 && c.line <= len) ok++
    else failures.push({ ...c, resolved: r.path, length: len })
  }
  return {
    total: citations.length,
    testable,
    ok,
    failures,
    ambiguous,
    absent,
    unreadable,
    rate: testable ? ok / testable : null,
  }
}

/**
 * The control the playbook requires in the SAME command, in all three directions: a known-good
 * citation passes, a known-bad one is flagged, and a path that cannot exist stays untestable — on
 * this very tree, through this very matcher.
 *
 * ⛔ Not "the file list loaded". That control passed while the matcher was garbage and the audit
 *    reported every citation in the corpus as a phantom. A control must cover the failure direction
 *    you are NOT expecting, which is why all three are asserted and not just the first.
 */
export function matcherControl(treePaths, lengthOf) {
  const first = treePaths.map(normalise).find(p => p && (lengthOf(p) || 0) > 0)
  if (!first) return { ok: false, reason: 'no readable file on the ref — the tree listing is empty or every file is unreadable, so nothing below was actually tested' }
  const len = lengthOf(first)
  const good = verifyCitations([{ raw: `${first}:1`, path: first, line: 1 }], treePaths, lengthOf)
  const bad = verifyCitations([{ raw: `${first}:${len + 1000}`, path: first, line: len + 1000 }], treePaths, lengthOf)
  // The third direction: a path that cannot be in any tree must come back untestable. Without it, a
  // resolver that answers "yes" to everything passes both cases above — and would silently resolve a
  // PR-branch file to an unrelated one with the same basename.
  const phantom = 'zz-not-a-real-directory/zz-not-a-real-file.zzz'
  const absent = verifyCitations([{ raw: `${phantom}:1`, path: phantom, line: 1 }], treePaths, lengthOf)
  const goodPassed = good.ok === 1 && good.failures.length === 0
  const badFlagged = bad.ok === 0 && bad.failures.length === 1
  const phantomAbsent = absent.absent.length === 1 && absent.testable === 0
  const ok = goodPassed && badFlagged && phantomAbsent
  return {
    ok,
    file: first,
    length: len,
    goodPassed,
    badFlagged,
    phantomAbsent,
    reason: ok ? null : 'the matcher does not answer correctly on a file that is definitely in the tree, or resolves one that cannot be — every count below is meaningless',
  }
}

/**
 * Set-difference the cited paths against the tree.
 *
 * Triage before reporting: in a PR sweep most non-resolving paths are legitimately PR-branch files,
 * so the raw miss count is not an error count (measured: 21 misses of 148 cited, 1 a real defect).
 */
export function verifyPaths(paths, treePaths) {
  const tree = new Set(treePaths.map(normalise))
  const index = basenameIndex(treePaths)
  const exact = []
  const byBasename = []
  const ambiguous = []
  const missing = []
  for (const p of paths) {
    const r = resolvePath(p, tree, index)
    if (r.how === 'exact') exact.push(p)
    else if (r.how === 'basename') byBasename.push({ cited: p, resolved: r.path })
    else if (r.how === 'ambiguous') ambiguous.push({ cited: p, homes: r.homes.length })
    else missing.push(p)
  }
  return { total: paths.length, exact: exact.length, byBasename, ambiguous, missing }
}
