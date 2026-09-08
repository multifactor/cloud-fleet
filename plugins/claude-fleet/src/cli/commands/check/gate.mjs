// `fleet check gate apply|status`, `fleet check promote`, and the two small checks the audit leans on
// (`enum check`, `blast-radius`).
//
// The gate is what stands between "a sweep filed some tickets" and "a fleet session may work one".
// Its rules live in src/check/gate.mjs and are pure; what this file adds is the reading of
// `audit/verdicts.tsv` and the queueing of the ops that follow from it.
//
//   ⛔ The evidence comment goes FIRST, and the cancellation second. gate.applyPlan already orders
//      them that way; this layer must enqueue them in the order it is given, because an outbox drain
//      that cancels before it explains leaves a reader a closed ticket with no reason on it.
//   ⛔ `waived` is human-only. The audit never writes it, and neither does `gate apply` — only an
//      operator's explicit `fleet check promote --waive`.

import { CliError, intFlag, listFlag, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { readRows, column, distinct } from '../../../sys/tsv.mjs'
import { parseVerdicts, decideCorpus, applyPlan, promotionPlan, assertVerdictCoverage, GATE } from '../../../check/gate.mjs'
import { blastRadius } from '../../../check/reconcile.mjs'
import { run as exec } from '../../../sys/exec.mjs'
import { enqueue } from '../../../trackers/outbox.mjs'
import { requireSweep, positional, filedRows } from './sweep.mjs'
import { readFindings } from './ledger.mjs'

const verdictsFile = (layout, flags) => stringFlag(flags, 'verdicts', null) || `${layout.audit}/verdicts.tsv`

function readVerdicts(ctx, layout, args) {
  const file = verdictsFile(layout, args.flags)
  const rows = readRows(file)
  if (!rows.length) {
    throw new CliError('check.no-verdicts', `${file} is empty or absent — there is no audit to apply`, 'the audit writes it; `fleet check audit plan <sweepId>` is not wired in this build, so produce it by following playbooks/check-audit.md and pass it with --verdicts', 1)
  }
  return { file, verdicts: parseVerdicts(rows) }
}

export function gateCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'apply' && verb !== 'status') {
    throw new CliError('check.gate-verb', `fleet check gate: ${verb ? `no verb "${verb}"` : 'no verb given'}`, 'one of apply, status')
  }
  const sweepId = positional(args, 2, { verb: `gate ${verb}`, what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: `gate ${verb}` })
  const { file, verdicts } = readVerdicts(ctx, layout, args)
  const decided = decideCorpus(verdicts)
  const coverage = assertVerdictCoverage(filedRows(layout).map(r => r.fid), verdicts)

  const body = {
    sweepId,
    verdicts: file,
    rows: decided.rows.length,
    counts: decided.counts,
    complete: decided.complete,
    untested: decided.untested,
    coverage,
  }

  if (verb === 'status') {
    if (ctx.jsonMode) ctx.json(envelope(true, body))
    else {
      for (const g of GATE) ctx.log(`${g.padEnd(10)} ${decided.counts[g]}`)
      if (!decided.complete) ctx.log(`INCOMPLETE: ${decided.untested.length} row(s) never scored — ${decided.untested.slice(0, 10).join(' ')}`)
      if (!coverage.ok) ctx.log(`COVERAGE: ${coverage.missing.length} filed finding(s) have no verdict, ${coverage.extra.length} verdict(s) match no filed finding, ${coverage.duplicates.length} duplicate(s)`)
    }
    return decided.complete && coverage.ok ? 0 : 1
  }

  // ⛔ Refuse to apply a gate that is not finished. A partly-scored corpus applied to the tracker
  // labels every unscored row `pending` and reads, to the next person, as "the audit says wait" —
  // when what actually happened is that the audit never looked.
  if (!decided.complete) {
    throw new CliError('check.gate-incomplete', `${decided.untested.length} row(s) have no fix-axis score, so this corpus is not gated: ${decided.untested.slice(0, 10).join(' ')}`, 'score every `real` finding\'s prescribed fix (verified | defective | no_op | absent) and re-run; `fleet check gate status` lists them', 1)
  }
  if (!coverage.ok) {
    throw new CliError('check.gate-coverage', `the verdicts do not cover the filed set: ${coverage.missing.length} filed without a verdict, ${coverage.extra.length} verdicts with nothing filed, ${coverage.duplicates.length} duplicated`, 'every filed finding gets exactly one verdict row — including the ones the audit itself filed, which extend its own denominator', 1)
  }

  const ops = applyPlan(decided, ctx.config, sweepId)
  const at = new Date(ctx.now()).toISOString()
  const enqueued = []
  // In the order applyPlan gave them: the evidence comment precedes the cancellation it explains.
  for (const op of ops) {
    const e = enqueue({ stateDir: ctx.config.paths.stateDir, op: op.op, key: op.key, args: op.args, verbatim: !!op.verbatim, requestedBy: `check-${sweepId}`, at, note: op.note })
    enqueued.push({ id: e.id ?? null, op: op.op, key: op.key })
  }
  if (ctx.jsonMode) ctx.json(envelope(true, { ...body, enqueued }))
  else ctx.log(`${enqueued.length} op(s) queued for ${decided.rows.length} verdict(s); drain them with \`fleet outbox list\``)
  return 0
}

/**
 * `fleet check promote <sweepId> [--all | --fid … | --min-priority N] [--waive]`.
 *
 * The default is that a HUMAN promotes: the sweep files into triage, the audit decides, and someone
 * moves the survivors. `--waive` is the one way a row that did not pass moves anyway, and it is
 * human-only by construction — nothing else in the pipeline can write it.
 */
export function promoteCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'promote', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'promote' })
  const { verdicts } = readVerdicts(ctx, layout, args)
  const decided = decideCorpus(verdicts)

  const waive = !!args.flags.waive
  const fids = listFlag(args.flags, 'fid')
  const minPriority = intFlag(args.flags, 'min-priority', null)
  const all = !!args.flags.all
  if (!all && !fids.length && minPriority === null) {
    throw new CliError('check.promote-needs-selection', 'fleet check promote takes --all, --fid … or --min-priority N', 'promoting is a decision about which tickets a fleet session may pick up; there is no default selection')
  }

  const priorityOf = new Map(filedRows(layout).map(r => [r.fid, Number(r.priority)]))
  const selected = decided.rows.filter(r => {
    if (fids.length) return fids.includes(r.fid)
    if (minPriority !== null) {
      const p = priorityOf.get(r.fid)
      // Priority 1 is Urgent: "at least this important" is a NUMERICALLY SMALLER band.
      return Number.isFinite(p) && p <= minPriority
    }
    return true
  })
  const eligible = selected.filter(r => r.gate.status === 'passed' || (waive && r.gate.status !== 'failed'))
  const refused = selected.filter(r => !eligible.includes(r)).map(r => ({ fid: r.fid, key: r.key, gate: r.gate.status, requires: r.gate.requires }))

  const ops = promotionPlan({ ...decided, rows: eligible.map(r => (waive && r.gate.status !== 'passed' ? { ...r, gate: { ...r.gate, status: 'passed' } } : r)) }, ctx.config, { auto: true })
  const at = new Date(ctx.now()).toISOString()
  const enqueued = []
  for (const op of ops) {
    const e = enqueue({ stateDir: ctx.config.paths.stateDir, op: op.op, key: op.key, args: op.args, requestedBy: `check-${sweepId}`, at, note: waive ? `${op.note} (waived by the operator)` : op.note })
    enqueued.push({ id: e.id ?? null, key: op.key })
  }
  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, selected: selected.length, promoted: enqueued.length, waived: waive, refused, enqueued }))
  else {
    ctx.log(`${enqueued.length} of ${selected.length} selected ticket(s) queued for promotion${waive ? ' (waived)' : ''}`)
    for (const r of refused) ctx.log(`  held back ${r.key || r.fid}: ${r.gate}${r.requires.length ? ` — ${r.requires[0]}` : ''}`)
  }
  return 0
}

/**
 * `fleet check enum check <tsv> --col N --domain a,b,c`.
 *
 * A one-line check that exists because the alternative is eyeballing a column: a single misspelled
 * enum value in `verdicts.tsv` silently drops a row out of every band it should have been counted in,
 * and the tally still adds up.
 */
export function enumCmd(ctx, args) {
  if (args.positionals[1] !== 'check') {
    throw new CliError('check.enum-verb', 'fleet check enum: the only verb is `check`', 'fleet check enum check <tsv> --col N --domain a,b,c')
  }
  const file = positional(args, 2, { verb: 'enum check', what: 'file' })
  const col = intFlag(args.flags, 'col', null)
  const domain = listFlag(args.flags, 'domain')
  if (col === null || col < 1) throw new CliError('check.enum-col', 'fleet check enum check needs --col N (1-based, as the playbooks count columns)', 'for example --col 3 for the diagnosis column of verdicts.tsv')
  if (!domain.length) throw new CliError('check.enum-domain', 'fleet check enum check needs --domain a,b,c', 'the permitted values, comma-separated')
  const rows = readRows(file)
  if (!rows.length) throw new CliError('check.enum-empty', `${file} is empty or absent`, 'a check over no rows passes vacuously, which is the one answer that must never be reported as a pass', 1)
  const values = column(rows, col - 1)
  const bad = distinct(values.filter(v => !domain.includes(v)))
  const body = { file, col, domain, rows: rows.length, distinct: distinct(values), bad }
  if (bad.length) {
    if (ctx.jsonMode) ctx.json(envelope(false, { ...body, error: { code: 'check.enum-out-of-domain', message: `column ${col} carries ${bad.length} value(s) outside the domain: ${bad.join(', ')}`, hint: 'fix the rows; a value outside the domain is counted in no band and the tally still adds up' } }))
    else ctx.log(`FAIL ${file} col ${col}: ${bad.join(', ')}`)
    return 1
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else ctx.log(`ok ${rows.length} row(s), ${body.distinct.length} distinct value(s) all in domain`)
  return 0
}

/**
 * `fleet check blast-radius <sweepId> --since <sha>` — which findings sit on paths that have changed
 * since the sweep's snapshot.
 *
 * ⛔ Matched on the FULL path, by `reconcile.blastRadius`. A basename match once claimed 66 findings
 *    where the truth was 24 (`page.tsx` exists in 134 places), so a bare filename in `where` never
 *    matches — that is the audit's "unverifiable" rule, not a gap here.
 */
export function blastRadiusCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'blast-radius', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'blast-radius' })
  const since = stringFlag(args.flags, 'since', null) || manifest.snapshotSha
  if (!since) {
    throw new CliError('check.no-snapshot', `sweep ${sweepId} recorded no snapshot commit, so there is nothing to measure the change from`, 'pass --since <sha>; the manifest records null when the base branch could not be resolved at plan time, and measuring from nowhere is worse than not measuring', 1)
  }
  const base = `origin/${ctx.config.repo.baseBranch}`
  const r = exec('git', ['diff', '--name-only', `${since}..${base}`], { cwd: ctx.cwd, timeoutMs: 30_000 })
  if (!r.ok) {
    throw new CliError('check.blast-radius-failed', `git diff --name-only ${since}..${base} failed: ${(r.stderr || '').trim().slice(0, 300)}`, `fetch first (\`git fetch origin ${ctx.config.repo.baseBranch}\`); a snapshot the local clone has never seen cannot be diffed against`, 1)
  }
  const changedPaths = String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const radius = blastRadius(changedPaths, readFindings(layout))
  const body = { sweepId, since, base, changed: radius.changed, matched: radius.matched, hits: radius.hits }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else if (!changedPaths.length) ctx.log(`nothing has landed on ${base} since ${since.slice(0, 12)} — the frame is unchanged`)
  else ctx.log(`${radius.changed} changed path(s) since ${since.slice(0, 12)}; ${radius.matched} finding(s) sit on one${radius.matched ? ':' : ''}${radius.hits.map(h => `\n  ${h.key || h.fid}  ${h.paths.join(' ')}`).join('')}`)
  return 0
}
