// PURE. Structural dedup: grouping findings by FILE and windowing by LINE.
//
// Textual similarity finds re-filings of the same observation. It systematically misses the more
// valuable case — two findings with one root cause, written by different reviewers who each saw a
// different arm of it.
//
// Measured: two tickets turned out to be the then- and else-branches of a single `if`, at :102-105
// and :117-119 of one file. One root fix closes both; fixing either alone leaves the other open. A
// dedicated duplicate-detection pass had already run over that corpus and did not surface the pair at
// all, because they share a file and almost no words — one describes the condition-true arm in its
// own vocabulary, the other the condition-false arm in its own.
//
//   ⛔ LOW TEXTUAL SIMILARITY IS THE EXPECTED SIGNAL HERE, NOT A COUNTER-INDICATION. The two branches
//      of an `if` describe opposite conditions by construction. So this pass reads no text at all: it
//      groups by file, sorts by line, and hands a worker every pair sitting within a window. The
//      question a worker answers is not "do these say the same thing?" but "is one of these the
//      other's `else`?"
//   ⚖️ The inverse is equally real, which is why neither pass replaces the other: in the same sweep,
//      one ticket's three "shares the fix with…" claims were all false — the siblings lived in
//      different apps and shared no fix. Textual similarity over-groups ACROSS files and under-groups
//      WITHIN one.

import { normalise } from './citations.mjs'

/** Adjacency inside one control-flow construct — wide enough for an if/else, tight enough to read. */
export const DEFAULT_WINDOW = 30

/**
 * The `where` entries of one finding that name a file and a line.
 * A `where` with no line cannot be windowed and is skipped: placing it at line 0 would cluster every
 * such finding with whatever happens to sit at the top of the file.
 */
function sites(finding) {
  const where = Array.isArray(finding.where) ? finding.where : []
  const out = []
  for (const w of where) {
    const path = normalise(w && w.path)
    const line = Number(w && w.line)
    if (!path || !Number.isFinite(line) || line < 1) continue
    out.push({ path, line })
  }
  return out
}

/**
 * Cluster findings by file and line proximity.
 *
 * @param {Array<{fid?: string, key?: string, title?: string, where?: Array<{path: string, line: number}>}>} findings
 * @param {{window?: number}} [opts]
 * @returns {{clusters: Array<{path: string, first: number, last: number, members: Array<{fid, key, title, line}>}>,
 *            files: number, sited: number, unsited: Array<{fid, key}>}}
 *   `unsited` are findings with no usable `where` — reported, never silently dropped: a finding this
 *   pass could not place is one the structural pass did not cover, and a zero-cluster result over a
 *   corpus of unsited findings would read as "no root-fix pairs".
 */
export function cluster(findings, { window = DEFAULT_WINDOW } = {}) {
  if (!Number.isInteger(window) || window < 1) throw new Error(`cluster: window must be a positive integer, got ${window}`)
  const byPath = new Map()
  const unsited = []
  let sited = 0
  for (const f of findings || []) {
    const where = sites(f)
    if (!where.length) { unsited.push({ fid: f.fid ?? null, key: f.key ?? null }); continue }
    sited++
    for (const w of where) {
      if (!byPath.has(w.path)) byPath.set(w.path, [])
      byPath.get(w.path).push({ fid: f.fid ?? null, key: f.key ?? null, title: f.title ?? '', line: w.line })
    }
  }

  const clusters = []
  for (const [path, entries] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.line - b.line || String(a.fid).localeCompare(String(b.fid)))
    let run = [entries[0]]
    const flush = () => {
      // ⛔ Distinct FINDINGS, not distinct sites. One finding citing two nearby lines of one file is
      // one finding, and pairing it with itself would hand a worker a cluster to read that has no
      // second ticket in it.
      const ids = new Set(run.map(e => e.fid ?? e.key))
      if (ids.size < 2) return
      clusters.push({ path, first: run[0].line, last: run[run.length - 1].line, members: run.slice() })
    }
    for (const e of entries.slice(1)) {
      // Windowed against the PREVIOUS site, so a chain of nearby findings stays one cluster rather
      // than being cut wherever the first one happened to start.
      if (e.line - run[run.length - 1].line <= window) run.push(e)
      else { flush(); run = [e] }
    }
    flush()
  }
  return { clusters, files: byPath.size, sited, unsited }
}

/** One row per cluster member: `path  first-last  fid  key  line  title`. */
export function clusterRows(clusters) {
  const rows = []
  for (const c of clusters) {
    for (const m of c.members) rows.push([c.path, `${c.first}-${c.last}`, m.fid || '', m.key || '', String(m.line), m.title || ''])
  }
  return rows
}
