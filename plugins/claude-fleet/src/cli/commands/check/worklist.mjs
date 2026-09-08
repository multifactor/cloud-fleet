// `fleet check worklist write --items-json <f|->`, and the two verbs that read it back.
//
// ⛔ THE WORKLIST IS WRITTEN ONCE AND NEVER RE-DERIVED. It is the denominator of every count the
//    sweep reports, and a sweep that re-derives it mid-run compares this wave's numerator against
//    next wave's denominator — which is how `remaining=231` was once reported against a true 148. So
//    a second write is refused, loudly, rather than merged: if the input really changed, that is a
//    new sweep with a new id, not this one with a different bottom.

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { readRows, writeRows } from '../../../sys/tsv.mjs'
import { parseWorklistRows, worklistRows } from '../../../check/worklist.mjs'
import { parseLedger, resumeCounts } from '../../../check/ledger.mjs'
import { sliceWorklist } from '../../../check/plan.mjs'
import { requireSweep, positional } from './sweep.mjs'
import { workItemsArg } from './payload.mjs'

export function worklistCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'write') {
    throw new CliError('check.worklist-verb', `fleet check worklist: the only verb is \`write\`${verb ? `, not "${verb}"` : ''}`, 'fleet check worklist write <sweepId> --items-json <f|->')
  }
  const sweepId = positional(args, 2, { verb: 'worklist write', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'worklist write' })

  const existing = readRows(layout.worklist)
  if (existing.length) {
    throw new CliError(
      'check.worklist-exists',
      `${layout.worklist} already holds ${existing.length} row(s) — the worklist is written once and never re-derived`,
      'it is the denominator of every count this sweep reports; if the input genuinely changed, that is a new sweep with a new id. `fleet check resume` reports what is left of this one.',
      1,
    )
  }

  const where = stringFlag(args.flags, 'items-json', null)
  if (!where) throw new CliError('check.worklist-needs-items', 'fleet check worklist write needs --items-json', 'hand it the op-26 readWorkItems result verbatim; `--items-json -` reads it from stdin')
  const items = workItemsArg(ctx, where)
  // The UNCHECKED items are the work. A mirror that already carries ticks is a resumed sweep whose
  // ledger was lost, and re-filing what is ticked would file it twice.
  const pending = items.filter(i => !i.done)
  if (!pending.length) {
    throw new CliError('check.worklist-empty', `--items-json carried ${items.length} item(s), none of them unchecked`, 'every item is already ticked, so there is nothing to sweep', 1)
  }
  writeRows(layout.worklist, worklistRows(pending))

  const ticked = items.length - pending.length
  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, worklist: layout.worklist, rows: pending.length, ticked }))
  else ctx.log(`${layout.worklist}: ${pending.length} row(s)${ticked ? ` (${ticked} already ticked, skipped)` : ''}`)
  return 0
}

/** The three counts. `done == 0` against a non-empty ledger is a STOP, not a start. */
export function resumeCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'resume', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'resume' })
  const worklist = parseWorklistRows(readRows(layout.worklist))
  if (!worklist.length) {
    throw new CliError('check.no-worklist', `${layout.worklist} is empty or absent — the sweep has no denominator yet`, 'run `fleet check worklist write <sweepId> --items-json -` with the op-26 result first', 1)
  }
  const rows = readRows(layout.ledger)
  const counts = resumeCounts({
    worklistPrs: worklist.map(w => w.pr),
    ledgerEntries: parseLedger(rows),
    ledgerFileNonEmpty: rows.length > 0,
  })
  const body = {
    sweepId,
    worklist: counts.worklist,
    done: counts.done,
    remaining: counts.remaining,
    remainingPrs: counts.remainingPrs,
    lastFiled: counts.lastFiled,
  }
  if (counts.error) {
    // Non-zero, and never the happy shape: this reading means STOP, and a caller that only looks at
    // `remaining` would read "231 to do" and cheerfully re-sweep a finished corpus.
    if (ctx.jsonMode) ctx.json(envelope(false, { ...body, error: { code: 'check.ledger-did-not-load', message: counts.error, hint: 'do not re-run the sweep; find why the ledger rows do not match the worklist' } }))
    else ctx.log(`STOP: ${counts.error}`)
    return 1
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else ctx.log(`worklist=${counts.worklist} done=${counts.done} remaining=${counts.remaining}`)
  return 0
}

/** The next slice of work, cut from what the ledger says is LEFT. */
export function sliceCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'slice', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'slice' })
  const worklist = parseWorklistRows(readRows(layout.worklist))
  if (!worklist.length) {
    throw new CliError('check.no-worklist', `${layout.worklist} is empty or absent — there is nothing to slice`, 'run `fleet check worklist write <sweepId> --items-json -` first', 1)
  }
  const counts = resumeCounts({ worklistPrs: worklist.map(w => w.pr), ledgerEntries: parseLedger(readRows(layout.ledger)) })
  // ⛔ Cut from what is LEFT, not from the whole worklist. A resumed sweep that re-slices the original
  // list hands the next wave PRs whose outcomes are already on disk, and files them a second time.
  const slices = sliceWorklist(counts.remainingPrs, { width: manifest.width, mode: manifest.mode })
  const next = slices[0] || null
  const byPr = new Map(worklist.map(w => [w.pr, w]))
  const body = {
    sweepId,
    mode: manifest.mode,
    width: manifest.width,
    remaining: counts.remaining,
    slices: slices.map(s => ({ slice: s.slice, prs: s.prs })),
    next: next && {
      slice: next.slice,
      prs: next.prs,
      items: next.prs.map(pr => byPr.get(pr) || { pr }),
      fidRanges: next.fidRanges,
    },
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else if (!next) ctx.log(`nothing left to slice — worklist=${counts.worklist} done=${counts.done} remaining=0`)
  else ctx.log(`${next.slice}: ${next.prs.length} PR(s) — ${next.prs.join(' ')}`)
  return 0
}
