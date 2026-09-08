// `fleet check gh bundle` — the offline PR bundle — and `fleet check tick plan` — the ticks the
// tracker's mirror is owed.
//
// `plan` already builds the bundle for a whole sweep. This verb exists for the one PR whose fetch
// failed or whose diff came back cut mid-hunk: `src/check/gh.mjs` records a per-PR failure rather
// than throwing (a plan over hundreds of PRs must not die on one), so re-asking for one PR has to be
// something an operator can type.

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { bundle } from '../../../check/gh.mjs'
import { readRows } from '../../../sys/tsv.mjs'
import { parseWorklistRows } from '../../../check/worklist.mjs'
import { parseLedger } from '../../../check/ledger.mjs'
import { planTicks, batchEdits, chunk, MAX_EDITS_PER_CALL } from '../../../check/checklist.mjs'
import { WORKLIST_PREFIX } from '../pool.mjs'
import { requireSweep, positional } from './sweep.mjs'
import { workItemsArg } from './payload.mjs'

export function ghCmd(ctx, args) {
  if (args.positionals[1] !== 'bundle') {
    throw new CliError('check.gh-verb', 'fleet check gh: the only verb is `bundle`', 'fleet check gh bundle <sweepId> [<pr>…] — with no PRs it re-bundles whatever the sweep is missing')
  }
  const sweepId = positional(args, 2, { verb: 'gh bundle', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'gh bundle' })

  // Named PRs, else the whole worklist. Re-bundling the whole worklist is cheap: gh.bundle skips a
  // PR whose json parses AND whose diff on disk is exactly the length that json promised, so a
  // re-run asks the forge only for what is missing or was cut mid-hunk.
  const named = args.positionals.slice(3).map(String)
  const prs = named.length ? named : parseWorklistRows(readRows(layout.worklist)).map(w => w.pr)
  if (!prs.length) {
    throw new CliError('check.gh-no-prs', `sweep ${sweepId} has no worklist and no PRs were named`, 'run `fleet check worklist write <sweepId> --items-json -` first, or name them: `fleet check gh bundle <sweepId> 1712 1719`', 1)
  }

  const result = bundle(prs, layout.dir, {
    base: ctx.config.repo.baseBranch,
    since: stringFlag(args.flags, 'since', null),
    cwd: ctx.cwd,
  })
  const body = { sweepId, mode: manifest.mode, asked: prs.length, written: result.written, skipped: result.skipped, errors: result.errors, gate2: result.gate2, open: result.open }
  if (ctx.jsonMode) {
    // The failures are named rather than collapsed into `ok: false`: the bundle as a whole did run,
    // and a caller needs to know WHICH PRs to re-ask for. The exit code still says something failed.
    ctx.json(envelope(true, body))
  } else {
    ctx.log(`${result.written.length} bundled, ${result.skipped.length} already on disk${result.errors.length ? `, ${result.errors.length} failed` : ''}`)
    for (const e of result.errors) ctx.log(`  FAILED ${e.pr ?? '(sweep)'}: ${e.error}`)
  }
  return result.errors.length ? 1 : 0
}

/**
 * `fleet check tick plan <sweepId> --items-json <f|->` — what the tracker's checklist is owed, as
 * whole op-15 calls.
 *
 * ⛔ `worklist.tsv` is the truth; the tracker holds a human-visible MIRROR. So what to tick is derived
 *    from the LEDGER, never from the tracker, and the rows that do not line up (an item the ledger has
 *    never heard of, a PR listed twice) are reported rather than guessed at — last-row-wins would flip
 *    an outcome with row order, and on the atomic-patch path an anchor matching twice rejects the
 *    whole call.
 */
export function tickCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'plan') {
    throw new CliError('check.tick-verb', `fleet check tick: the only verb is \`plan\`${verb ? `, not "${verb}"` : ''}`, 'fleet check tick plan <sweepId> --items-json <f|->')
  }
  const sweepId = positional(args, 2, { verb: 'tick plan', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'tick plan' })
  const key = manifest.input.ref

  if (manifest.input.kind !== 'tracker-issue') {
    throw new CliError('check.tick-no-mirror', `sweep ${sweepId} was not driven from a tracker issue (${manifest.input.kind}), so there is no checklist to mirror`, 'ticks are owed only when the sweep\'s input IS the work-list issue; `fleet check resume` is the progress report for every other input', 1)
  }

  // ⛔ `--lock` is refused rather than honoured. The lock exists to cover a READ-MODIFY-WRITE that the
  // model performs through the adapter after this process has exited, and a lock acquired and
  // released inside one CLI invocation protects nothing while looking like it does — which is the
  // exact shape of no-op this codebase refuses elsewhere.
  if (args.flags.lock) {
    throw new CliError(
      'check.tick-lock-not-here',
      '`fleet check tick plan --lock` would acquire a lock and release it before the tick is applied, which protects nothing',
      `hold it around the apply instead: \`fleet pool acquire ${WORKLIST_PREFIX}${key} --once\`, run the op-15 call, then \`fleet pool release\`. The mirror is a read-modify-write on adapters without atomic patch, so two waves ticking at once write each other away.`,
    )
  }

  const items = workItemsArg(ctx, requireItemsFlag(args))
  const plan = planTicks(parseLedger(readRows(layout.ledger)), items)
  // The adapter's `issueKey` front-matter block, not the sweep's key: tickEdit validates each key it
  // appends against that pattern, because a TRUNCATED key on a checklist line autolinks to an
  // unrelated issue.
  const issueKey = ctx.adapter && (ctx.adapter.issueKey || (ctx.adapter.front && ctx.adapter.front.issueKey))
  if (!issueKey || !issueKey.pattern) {
    throw new CliError('check.tick-no-issue-key', `the ${ctx.config.tracker.id || 'configured'} adapter declares no issueKey.pattern, so a key appended to a checklist line cannot be checked`, 'every bundled adapter declares one; a project adapter under .fleet/trackers/ must too', 1)
  }
  const calls = chunk(batchEdits(plan.items, { issueKey }), MAX_EDITS_PER_CALL)

  const body = {
    sweepId,
    key,
    owed: plan.items.length,
    mirrored: plan.mirrored,
    unmatched: plan.unmatched,
    duplicated: plan.duplicated,
    lock: `${WORKLIST_PREFIX}${key}`,
    calls: calls.map(edits => ({ op: 'tickWorkItem', key, args: { edits } })),
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else {
    ctx.log(`${plan.items.length} tick(s) owed in ${calls.length} call(s); ${plan.mirrored.length} already ticked`)
    if (plan.unmatched.length) ctx.log(`  not on the list: ${plan.unmatched.join(' ')}`)
    if (plan.duplicated.length) ctx.log(`  listed twice, never ticked: ${plan.duplicated.join(' ')}`)
  }
  return 0
}

function requireItemsFlag(args) {
  const where = stringFlag(args.flags, 'items-json', null)
  if (!where) {
    throw new CliError('check.tick-needs-items', 'fleet check tick plan needs --items-json: the current state of the mirror', 'run op-26 readWorkItems and pipe the result in with `--items-json -`; a plan that does not know which boxes are already ticked re-ticks them')
  }
  return where
}
