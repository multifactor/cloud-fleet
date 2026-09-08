// `fleet check plan` — start (or resume) a sweep: the sweep dir, the manifest, and the tracker ops
// the launcher must run before any worker files anything.
//
// The whole decision is `src/check/plan.mjs planSweep()`, which is pure. This file does three impure
// things and nothing else: it gathers facts, it reads back an existing manifest so a re-run RESUMES
// instead of starting a second sweep over the same input, and it enqueues the location ops.
//
//   ⛔ Re-running the same command must resume. The sweepId is derived from the input (`<KEY>`,
//      `prs-<sha1>`, `file-<sha1>`) exactly so that it can, and an operator who re-runs after a crash
//      is the common case, not the exceptional one. That is why the plan is computed twice: the first
//      pass only tells us WHICH sweep this input is, and the second is made knowing what that sweep
//      already resolved. Planning once and writing blind would run a second createProject against a
//      sweep that already has a group, and split one sweep across two.

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { planSweep, writeSweepDir } from '../../../check/plan.mjs'
import { readManifest } from '../../../check/manifest.mjs'
import { enqueue } from '../../../trackers/outbox.mjs'
import { checkFacts } from './facts.mjs'
import { layoutFor, stateDirOf } from './sweep.mjs'

/** The `args` object planSweep reads, from the parsed command line. */
function planArgs(ctx, args) {
  return {
    items: args.positionals.slice(1),
    fromFile: stringFlag(args.flags, 'from-file', null),
    project: stringFlag(args.flags, 'project', null),
    mode: stringFlag(args.flags, 'mode', null),
    width: stringFlag(args.flags, 'width', null),
    resume: stringFlag(args.flags, 'resume', null),
    auto: !!args.flags.auto,
    dryRun: !!args.flags['dry-run'],
  }
}

/** A planner refusal is the operator's error, not a crash: same shape as every other CLI failure. */
function refused(plan) {
  const r = plan.refused
  throw new CliError(r.code, r.message, r.hint, 1)
}

export function planCmd(ctx, args) {
  const a = planArgs(ctx, args)
  if (!a.items.length && !a.fromFile && !a.resume) {
    throw new CliError('check.plan-needs-input', 'fleet check plan takes the PRs, the tracker key or --from-file to sweep', 'for example `fleet check plan 1712 1719`, `fleet check plan ABC-1234`, or `fleet check plan --from-file prs.txt`')
  }
  const adapter = ctx.adapter

  // Pass 1: which sweep is this input? The planner refuses a bad input here, before anything exists.
  const first = planSweep({ args: a, config: ctx.config, adapter, facts: checkFacts(ctx) })
  if (!first.ok) refused(first)

  // Pass 2: made knowing what that sweep already resolved.
  const existing = readManifest(layoutFor(ctx, first.sweepId).dir)
  const plan = existing
    ? planSweep({
      args: { ...a, resume: first.sweepId },
      config: ctx.config,
      adapter,
      facts: checkFacts(ctx, { sweepId: first.sweepId }),
      existingManifest: existing,
    })
    : first
  if (!plan.ok) refused(plan)

  const body = {
    sweepId: plan.sweepId,
    sweepDir: plan.sweepDir,
    mode: plan.mode,
    width: plan.width,
    widthReason: plan.widthReason,
    input: plan.input,
    resume: !!existing,
    slices: plan.slices,
    auto: plan.auto,
    locationOps: plan.locationOps,
    warnings: plan.warnings,
  }

  if (a.dryRun) {
    if (ctx.jsonMode) ctx.json(envelope(true, { ...body, dryRun: true, wrote: false }))
    else {
      ctx.log(`${existing ? 'would resume' : 'would plan'} sweep ${plan.sweepId} (${plan.mode}, width ${plan.width} — ${plan.widthReason})`)
      ctx.log(`  ${plan.sweepDir}`)
      for (const op of plan.locationOps) ctx.log(`  op ${op.op} ${op.key}`)
    }
    return 0
  }

  const written = writeSweepDir(plan)

  // The location ops go into the SAME outbox the launcher already drains — a second queue would be a
  // second drain loop, and the one that is not being watched is the one that silently stops.
  const stateDir = stateDirOf(ctx)
  const at = new Date(ctx.now()).toISOString()
  const enqueued = []
  for (const op of plan.locationOps) {
    const e = enqueue({ stateDir, op: op.op, key: op.key, args: op.args, requestedBy: `check-${plan.sweepId}`, at, note: op.note })
    enqueued.push({ id: e.id ?? e.name ?? null, op: op.op, key: op.key })
  }

  if (ctx.jsonMode) ctx.json(envelope(true, { ...body, wrote: true, created: written.created, manifestFile: written.manifestFile, resumeFile: written.resumeFile, enqueued }))
  else {
    ctx.log(`${written.created ? 'planned' : 'resumed'} sweep ${plan.sweepId} (${plan.mode}, width ${plan.width} — ${plan.widthReason})`)
    ctx.log(`  ${written.sweepDir}`)
    ctx.log(`  read ${written.resumeFile} first — it names the three files and the three counts`)
    if (enqueued.length) ctx.log(`  ${enqueued.length} tracker op(s) queued; drain them with \`fleet outbox list\``)
    for (const w of plan.warnings) ctx.log(`  warning: ${w.message}`)
  }
  return 0
}
