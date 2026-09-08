// `fleet check brief` — the worker brief, and `fleet check status` — what sweeps exist.
//
// The brief is rendered, never hand-written. A worker's whole procedure is in it (what it may write,
// what only the orchestrator may write, which failures are blocking and which are cosmetic), and the
// mode decides half of that — so a brief typed out per wave is a brief that drifts from the mode it
// claims to describe by the third wave.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { renderBrief } from '../../../check/brief.mjs'
import { readRows } from '../../../sys/tsv.mjs'
import { parseWorklistRows } from '../../../check/worklist.mjs'
import { parseLedger, resumeCounts } from '../../../check/ledger.mjs'
import { sliceWorklist } from '../../../check/plan.mjs'
import { requireSweep, positional, platformOf, listSweeps } from './sweep.mjs'

/** The bundled playbook, with a project overlay at `.fleet/playbooks/` when the repo ships one. */
export function playbookPathFor(ctx, name) {
  const bundled = fileURLToPath(new URL(`../../../../playbooks/${name}`, import.meta.url))
  const root = ctx.facts && ctx.facts.git && (ctx.facts.git.primary || ctx.facts.git.toplevel)
  if (!root) return bundled
  const overlay = path.join(root, '.fleet', 'playbooks', name)
  return ctx.config.paths && ctx.config.paths.projectPlaybooksDir ? overlay : bundled
}

export function briefCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'brief', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'brief' })
  const platform = platformOf(ctx)

  // The slice is named, or it is the next one there is work for — the same slice `fleet check slice`
  // would hand out, so the brief and the work cannot disagree about which PRs a worker has.
  let slice = stringFlag(args.flags, 'slice', null)
  let prs
  const worklist = parseWorklistRows(readRows(layout.worklist))
  if (!worklist.length) {
    throw new CliError('check.no-worklist', `${layout.worklist} is empty or absent — there is no work to brief a worker on`, 'run `fleet check worklist write <sweepId> --items-json -` first', 1)
  }
  const counts = resumeCounts({ worklistPrs: worklist.map(w => w.pr), ledgerEntries: parseLedger(readRows(layout.ledger)) })
  const slices = sliceWorklist(counts.remainingPrs, { width: manifest.width, mode: manifest.mode })
  if (slice) {
    const found = slices.find(s => s.slice === slice)
    if (!found) {
      throw new CliError('check.no-such-slice', `slice "${slice}" has no PRs left in sweep ${sweepId}`, `the slices with work left are ${slices.map(s => s.slice).join(', ') || '(none — the sweep is done)'}`, 1)
    }
    prs = found.prs
  } else {
    const next = slices[0]
    if (!next) {
      throw new CliError('check.nothing-to-brief', `sweep ${sweepId} has nothing left: worklist=${counts.worklist} done=${counts.done} remaining=0`, 'run `fleet check finish <sweepId>` instead', 1)
    }
    slice = next.slice
    prs = next.prs
  }

  const markdown = renderBrief({
    mode: manifest.mode,
    capabilities: ctx.adapter && ctx.adapter.front ? ctx.adapter.front.capabilities : (ctx.adapter && ctx.adapter.capabilities) || null,
    config: ctx.config,
    sweep: { sweepId, slice, prs },
    stateDir: ctx.config.paths.stateDir,
    adapterPath: ctx.adapter ? ctx.adapter.file : null,
    playbookPath: playbookPathFor(ctx, 'check.md'),
    platform,
  })

  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, slice, prs, mode: manifest.mode, brief: markdown }))
  else ctx.log(markdown)
  return 0
}

/**
 * `fleet check status` — every sweep on this machine, or one in detail.
 *
 * ⛔ Read-only, and it never plans. It is what an operator (or a fresh session with no context) runs
 *    first, so it must answer on a half-written sweep dir and on a damaged manifest rather than
 *    throwing: the damaged one is exactly what they are looking for.
 */
export function statusCmd(ctx, args) {
  const only = args.positionals[1] || null
  if (!only) {
    const sweeps = listSweeps(ctx)
    if (ctx.jsonMode) ctx.json(envelope(true, { sweeps }))
    else if (!sweeps.length) ctx.log('no sweeps on this machine')
    else for (const s of sweeps) ctx.log(s.damaged ? `${s.sweepId}  DAMAGED — ${s.damaged}` : `${s.sweepId}  ${s.status}  ${s.mode}  audit=${s.audit ? s.audit.status : 'none'}  ${s.updatedAt || ''}`)
    return 0
  }
  const { layout, manifest } = requireSweep(ctx, only, { verb: 'status' })
  const worklist = parseWorklistRows(readRows(layout.worklist))
  const rows = readRows(layout.ledger)
  const counts = worklist.length
    ? resumeCounts({ worklistPrs: worklist.map(w => w.pr), ledgerEntries: parseLedger(rows), ledgerFileNonEmpty: rows.length > 0 })
    : { worklist: 0, done: 0, remaining: 0, remainingPrs: [], lastFiled: null, error: null }
  const body = {
    sweepId: only,
    dir: layout.dir,
    status: manifest.status,
    mode: manifest.mode,
    width: manifest.width,
    input: manifest.input,
    audit: manifest.audit,
    counts: manifest.counts,
    tracker: manifest.tracker,
    worklistWritten: worklist.length > 0,
    progress: { worklist: counts.worklist, done: counts.done, remaining: counts.remaining },
    ledgerDidNotLoad: counts.error || null,
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else {
    ctx.log(`${only}  ${manifest.status}  ${manifest.mode}  width ${manifest.width}`)
    ctx.log(`  ${layout.dir}`)
    ctx.log(`  worklist=${counts.worklist} done=${counts.done} remaining=${counts.remaining}`)
    ctx.log(`  audit: ${manifest.audit ? manifest.audit.status : 'none'}`)
    if (counts.error) ctx.log(`  STOP: ${counts.error}`)
  }
  return 0
}
