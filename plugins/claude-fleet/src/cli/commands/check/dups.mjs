// `fleet check dups cluster` — the structural dedup pass.
//
// The decision is `src/check/dups.mjs` (pure). This file reads the findings and writes the clusters
// where contract §4 declares them.

import { CliError, intFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { writeRows } from '../../../sys/tsv.mjs'
import { cluster, clusterRows, DEFAULT_WINDOW } from '../../../check/dups.mjs'
import { requireSweep, positional } from './sweep.mjs'
import { readFindings } from './ledger.mjs'

/** The question a worker answers over each cluster, carried WITH the data so it is not paraphrased. */
const QUESTION = 'for each cluster: is one of these the other’s `else`? Adjacency inside one control-flow construct is a stronger root-fix signal than any amount of shared vocabulary — do not re-run a similarity check here, that is the pass this one complements.'

export function dupsCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'cluster') {
    throw new CliError('check.dups-verb', `fleet check dups: the only verb is \`cluster\`${verb ? `, not "${verb}"` : ''}`, `fleet check dups cluster <sweepId> [--count N] — N is the line window, default ${DEFAULT_WINDOW}`)
  }
  const sweepId = positional(args, 2, { verb: 'dups cluster', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'dups cluster' })
  const window = intFlag(args.flags, 'count', DEFAULT_WINDOW)

  const findings = readFindings(layout)
  if (!findings.length) {
    throw new CliError('check.no-findings', `sweep ${sweepId} has no findings to cluster`, 'the workers write findings/<slice>.jsonl; a zero here would read as "no root-fix pairs" over a corpus nothing ever looked at', 1)
  }
  const r = cluster(findings, { window })

  // ⛔ `dups.tsv` at the sweep root, which is where contract §4 declares it. The audit playbook says
  //    "under audit/"; the contract wins over a playbook by its own stated rule, and one declared
  //    location beats two plausible ones.
  writeRows(layout.dups, clusterRows(r.clusters))

  const body = {
    sweepId,
    window,
    findings: findings.length,
    sited: r.sited,
    unsited: r.unsited,
    files: r.files,
    clusters: r.clusters.length,
    file: layout.dups,
    pairs: r.clusters.map(c => ({ path: c.path, span: `${c.first}-${c.last}`, members: c.members.map(m => m.fid || m.key) })),
    question: QUESTION,
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else {
    ctx.log(`${r.clusters.length} cluster(s) over ${r.files} file(s), window ${window} lines — ${layout.dups}`)
    for (const c of r.clusters) ctx.log(`  ${c.path}:${c.first}-${c.last}  ${c.members.map(m => m.fid || m.key).join(' ')}`)
    if (r.unsited.length) ctx.log(`  ${r.unsited.length} finding(s) carry no usable where[] and were not covered by this pass`)
  }
  return 0
}
