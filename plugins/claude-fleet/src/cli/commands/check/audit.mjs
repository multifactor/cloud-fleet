// `fleet check audit plan <sweepId>` — lay out the audit's workers over a finished corpus.
//
// The layout is `src/check/audit.mjs` (pure). This file joins the findings to what was actually
// filed, writes the batches, and records the run on the manifest.
//
//   ⛔ THE CORPUS MUST BE FINISHED. `fleet check finish` is what makes it so, and the manifest
//      enforces it — an audit over a sweep still filing judges a corpus that is still growing, and
//      its own tally is out of a denominator that changes underneath it.
//   ⛔ ONE ENTRY PER RUN. A second `audit plan` over the same corpus is the thing the playbook says
//      never to do: it produces a second set of verdicts over the same findings, and nothing
//      downstream can tell which of the two a `gate:passed` label came from. `--auto` is not an
//      override for this; only naming a fresh run id is.

import fs from 'node:fs'
import path from 'node:path'

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { writeRows } from '../../../sys/tsv.mjs'
import { planAudit, batchRows, BATCH } from '../../../check/audit.mjs'
import { writeManifest } from '../../../check/manifest.mjs'
import { requireSweep, positional, filedRows } from './sweep.mjs'
import { readFindings } from './ledger.mjs'

/** The findings, carrying what filing learned about them: the key, and the priority actually set. */
function joined(layout) {
  const filed = new Map(filedRows(layout).map(r => [r.fid, r]))
  return readFindings(layout).map(f => {
    const row = filed.get(f.fid)
    return {
      ...f,
      key: f.key ?? (row ? row.key : null),
      // The filed row is the authority on priority: it is what the tracker was actually told, and the
      // consequence-driven pass draws its band from what a reader of the ticket would see.
      priority: row && row.priority !== '' && row.priority != null ? Number(row.priority) : f.priority,
    }
  })
}

export function auditCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'plan') {
    throw new CliError('check.audit-verb', `fleet check audit: the only verb is \`plan\`${verb ? `, not "${verb}"` : ''}`, 'fleet check audit plan <sweepId> — the gates themselves are run by workers following playbooks/check-audit.md')
  }
  const sweepId = positional(args, 2, { verb: 'audit plan', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'audit plan' })

  if (manifest.status !== 'complete') {
    throw new CliError('check.audit-corpus-unfinished', `sweep ${sweepId} is "${manifest.status}", not complete — an audit over a sweep still filing judges a corpus that is still growing`, 'run `fleet check finish <sweepId>` first; it is what establishes the denominator this audit reports out of', 1)
  }

  const runId = stringFlag(args.flags, 'label', null) || `audit-${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}`
  if ((manifest.audit.runs || []).some(r => r.auditRunId === runId)) {
    throw new CliError('check.audit-run-exists', `sweep ${sweepId} already records an audit run "${runId}"`, 'a second audit over one corpus produces a second set of verdicts over the same findings, and nothing downstream can tell which one a gate label came from. Name a fresh run with --label.', 1)
  }

  const findings = joined(layout)
  if (!findings.length) {
    throw new CliError('check.audit-no-findings', `sweep ${sweepId} has no findings to audit`, 'a plan over zero findings is a plan whose every pass reports a clean corpus nothing ever read', 1)
  }
  const plan = planAudit(findings, { securityLabel: ctx.config.checker.securityLabel || null })

  const at = new Date(ctx.now()).toISOString()
  fs.mkdirSync(layout.audit, { recursive: true })
  const batchesFile = path.join(layout.audit, 'batches.tsv')
  const planFile = path.join(layout.audit, 'plan.json')
  writeRows(batchesFile, batchRows(plan, findings))
  fs.writeFileSync(planFile, JSON.stringify({
    v: 1,
    auditRunId: runId,
    sweepId,
    at,
    batch: BATCH,
    securityLabel: ctx.config.checker.securityLabel || null,
    // The query that built the denominator travels WITH the tally, so a later reader can re-run it.
    provenance: `findings.jsonl + filed/*.tsv of sweep ${sweepId} at ${manifest.updatedAt || manifest.createdAt}`,
    counts: plan.counts,
    gaps: plan.gaps,
    gate1: plan.gate1,
    consequence: plan.consequence,
    categories: plan.categories,
    uncategorised: plan.uncategorised,
  }, null, 2) + '\n')

  writeManifest(layout.dir, {
    ...manifest,
    updatedAt: at,
    audit: {
      ...manifest.audit,
      status: 'running',
      runs: [...(manifest.audit.runs || []), { auditRunId: runId, at, batches: plan.counts.gate1Batches + plan.counts.consequenceBatches + plan.counts.categoryBatches }],
    },
  })

  const body = {
    sweepId,
    auditRunId: runId,
    planFile,
    batchesFile,
    verdicts: path.join(layout.audit, 'verdicts.tsv'),
    counts: plan.counts,
    gaps: plan.gaps,
    next: 'workers follow playbooks/check-audit.md over these batches and append to audit/verdicts.tsv; then `fleet check gate apply` and `fleet check frame check`',
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else {
    ctx.log(`${runId}: ${plan.counts.findings} finding(s)`)
    ctx.log(`  gate 1 (by PR):        ${plan.counts.gate1Batches} batch(es)`)
    ctx.log(`  consequence (Urgent+): ${plan.counts.consequenceBatches} batch(es) over ${plan.counts.consequenceFindings} finding(s)`)
    ctx.log(`  contradiction (cat):   ${plan.counts.categoryBatches} batch(es) over ${plan.counts.categories} categor(ies)`)
    ctx.log(`  ${batchesFile}`)
    // ⛔ Printed, never buried in the payload: a pass that was not laid out is a pass the corpus will
    // not get, and an operator reading "3 passes planned" would never know.
    for (const g of plan.gaps) ctx.log(`  GAP: ${g}`)
  }
  return 0
}
