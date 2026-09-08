// `fleet check ledger append|resume|reconcile`, `fleet check fid mint`, `fleet check reconcile filed`.
//
// These exist as CLI verbs rather than playbook prose for one reason: the field notes prove they are
// the operations a model gets wrong by hand. A ledger line written with a shell redirect loses its
// trailing newline and the next `wc -l` reports N-1; a fid minted in prose collides across slices;
// "all four counts agree" done by eye agrees right up until it does not.
//
//   ⛔ A PR IS NOT DONE UNTIL ITS OUTCOME IS ON DISK. `append` is how it gets there, it is
//      append-only, and `failed` is a status like any other — a wave that swallows its failures
//      reports a clean sweep over a corpus it never looked at.

import fs from 'node:fs'

import { CliError, intFlag, listFlag, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { appendRow, readRows } from '../../../sys/tsv.mjs'
import { LEDGER_STATUSES, ledgerRow, parseLedger, reconcileFromFindings, resumeCounts, statusCounts } from '../../../check/ledger.mjs'
import { parseWorklistRows } from '../../../check/worklist.mjs'
import { mintFids, fourCounts } from '../../../check/fid.mjs'
import { enqueue } from '../../../trackers/outbox.mjs'
import { requireSweep, positional } from './sweep.mjs'
import { reconcileTrackerCmd } from './frame.mjs'

/** Every findings row the workers wrote, from the per-slice files and the consolidated one. */
export function readFindings(layout) {
  const files = []
  try {
    files.push(...fs.readdirSync(layout.findings).filter(f => f.endsWith('.jsonl')).map(f => `${layout.findings}/${f}`))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  files.push(layout.findingsJsonl)
  const out = []
  const seen = new Set()
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        // A torn last line is what a killed worker leaves; it is not a reason to lose the rest.
        continue
      }
      // The consolidated file repeats the per-slice rows, and a finding counted twice inflates the
      // reconcile it is used to check.
      const id = row.fid || JSON.stringify(row)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(row)
    }
  }
  return out
}

function appendCmd(ctx, args, { layout, manifest, sweepId }) {
  const pr = positional(args, 2, { verb: 'ledger append', what: 'pr' })
  const status = positional(args, 3, { verb: 'ledger append', what: 'status' })
  if (!/^\d+$/.test(pr)) throw new CliError('check.ledger-bad-pr', `"${pr}" is not a PR number`, 'fleet check ledger append <pr> <filed|clean|skipped|failed>')
  if (!LEDGER_STATUSES.includes(status)) {
    throw new CliError('check.ledger-bad-status', `"${status}" is not a ledger status`, `one of ${LEDGER_STATUSES.join(', ')} — \`failed\` is a real outcome and must be recorded, not swallowed`)
  }
  const keys = listFlag(args.flags, 'keys')
  if (status === 'filed' && !keys.length) {
    throw new CliError('check.ledger-filed-no-keys', 'a `filed` row with no --keys records that something was filed without recording what', 'pass --keys ABC-1,ABC-2 — the reconcile joins the ledger to the tracker on them')
  }
  const at = new Date(ctx.now()).toISOString()
  const row = ledgerRow({ pr, status, keys, at, note: stringFlag(args.flags, 'note', '') || '' })
  const line = appendRow(layout.ledger, row)

  // The tracker's checklist is a MIRROR of this file, so the tick is queued the moment the ledger
  // line lands — not when the wave ends, which is the point at which a crash loses it.
  let queued = null
  if (manifest.input.kind === 'tracker-issue' && ctx.config.tracker.mode !== 'none') {
    const e = enqueue({
      stateDir: ctx.config.paths.stateDir,
      op: 'tickWorkItem',
      key: manifest.input.ref,
      args: { pr, status, keys },
      requestedBy: `check-${sweepId}`,
      at,
      note: 'batch these with the other ticks of this wave: N edits, one call, under the tracker-worklist lock',
    })
    queued = e.id ?? null
  }

  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, pr, status, keys, ledger: layout.ledger, queuedTick: queued }))
  else ctx.log(`${layout.ledger}: ${line.trimEnd()}`)
  return 0
}

function reconcileFromFindingsCmd(ctx, args, { layout, sweepId }) {
  const from = stringFlag(args.flags, 'from', null)
  if (from !== 'findings') {
    throw new CliError('check.ledger-reconcile-source', `fleet check ledger reconcile --from ${from ? `"${from}"` : '<source>'}`, 'the only source is `findings`: a findings row proves an outcome, while a missing ledger line only proves a missed write')
  }
  const worklist = parseWorklistRows(readRows(layout.worklist))
  const entries = parseLedger(readRows(layout.ledger))
  const rows = reconcileFromFindings({
    worklistPrs: worklist.map(w => w.pr),
    ledgerEntries: entries,
    findings: readFindings(layout),
    at: new Date(ctx.now()).toISOString(),
  })
  for (const r of rows) appendRow(layout.ledger, r)
  // A row is `[pr, status, keys, at, note]` — field 0 is the PR.
  const prs = rows.map(r => r[0])
  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, appended: rows.length, prs }))
  else if (!rows.length) ctx.log('ledger and findings already agree — nothing to reconcile')
  else ctx.log(`appended ${rows.length} row(s) the sweep produced but never wrote: ${prs.join(' ')}`)
  return 0
}

export function ledgerCmd(ctx, args) {
  const verb = args.positionals[1]
  const VERBS = ['append', 'resume', 'reconcile']
  if (!VERBS.includes(verb)) {
    throw new CliError('check.ledger-verb', `fleet check ledger: ${verb ? `no verb "${verb}"` : 'no verb given'}`, `one of ${VERBS.join(', ')}`)
  }
  // `append` takes its sweep from --sweep-id so the two positionals stay the PR and its status; the
  // read-only verbs take it positionally, like every other read-only verb.
  const sweepId = verb === 'append'
    ? (stringFlag(args.flags, 'sweep-id', null) || positional(args, 4, { verb: 'ledger append', what: 'sweepId' }))
    : positional(args, 2, { verb: `ledger ${verb}`, what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: `ledger ${verb}` })

  if (verb === 'append') return appendCmd(ctx, args, { layout, manifest, sweepId })
  if (verb === 'reconcile') return reconcileFromFindingsCmd(ctx, args, { layout, sweepId })

  const worklist = parseWorklistRows(readRows(layout.worklist))
  const rows = readRows(layout.ledger)
  const entries = parseLedger(rows)
  const counts = resumeCounts({ worklistPrs: worklist.map(w => w.pr), ledgerEntries: entries, ledgerFileNonEmpty: rows.length > 0 })
  const body = { sweepId, worklist: counts.worklist, done: counts.done, remaining: counts.remaining, remainingPrs: counts.remainingPrs, byStatus: statusCounts(entries) }
  if (counts.error) {
    if (ctx.jsonMode) ctx.json(envelope(false, { ...body, error: { code: 'check.ledger-did-not-load', message: counts.error, hint: 'do not re-run the sweep; find why the ledger rows do not match the worklist' } }))
    else ctx.log(`STOP: ${counts.error}`)
    return 1
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else ctx.log(`worklist=${counts.worklist} done=${counts.done} remaining=${counts.remaining}`)
  return 0
}

/**
 * `fleet check fid mint <slice> --count N` — the ids a worker files under.
 *
 * Minted here rather than in the worker because a fid is what the four counts join on: two workers
 * inventing their own numbering produce a filed set that reconciles perfectly against itself and not
 * at all against the sweep.
 */
export function fidCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'mint') throw new CliError('check.fid-verb', `fleet check fid: the only verb is \`mint\`${verb ? `, not "${verb}"` : ''}`, 'fleet check fid mint <slice> <pr> --count N')
  const slice = positional(args, 2, { verb: 'fid mint', what: 'slice' })
  const count = intFlag(args.flags, 'count', null)
  if (!Number.isInteger(count) || count < 1) throw new CliError('check.fid-count', 'fleet check fid mint needs --count N (a positive integer)', 'mint exactly as many as the worker is about to file — a spare fid reads as a finding that vanished')
  const pr = positional(args, 3, { verb: 'fid mint', what: 'pr' })
  if (!/^\d+$/.test(pr)) throw new CliError('check.fid-bad-pr', `"${pr}" is not a PR number`, 'fleet check fid mint <slice> <pr> --count N')
  const fids = mintFids(slice, pr, count)
  if (ctx.jsonMode) ctx.json(envelope(true, { slice, pr, count, fids }))
  else for (const f of fids) ctx.log(f)
  return 0
}

/**
 * `fleet check reconcile filed` — the four counts, over `filed/<slice>.tsv`.
 *
 * ⛔ The failure names the diverging count. "They do not agree" sends an operator to read four files;
 *    "unique fids 134 vs rows 136" sends them to the two duplicated rows.
 */
export function reconcileCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb === 'tracker') return reconcileTrackerCmd(ctx, args)
  if (verb !== 'filed') {
    throw new CliError('check.reconcile-verb', `fleet check reconcile: ${verb ? `no verb "${verb}"` : 'no verb given'}`, 'one of filed (the four counts over what was written) and tracker (--pages, the filed set as the tracker returns it)')
  }
  const sweepId = positional(args, 2, { verb: 'reconcile filed', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'reconcile filed' })
  let files
  try {
    files = fs.readdirSync(layout.filed).filter(f => f.endsWith('.tsv')).sort()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    files = []
  }
  // One finding is one row, so the denominator is the findings file, not the filed file being checked.
  const sliceTotals = new Map()
  for (const f of readFindings(layout)) {
    const slice = f.slice || (typeof f.fid === 'string' ? f.fid.split('|')[0] : null)
    if (slice) sliceTotals.set(slice, (sliceTotals.get(slice) || 0) + 1)
  }
  const perSlice = []
  const problems = []
  for (const f of files) {
    const slice = f.replace(/\.tsv$/, '')
    const rows = readRows(`${layout.filed}/${f}`).map(r => ({ fid: r[0], key: r[1], url: r[2], pr: r[3], priority: r[4], a11y: r[5] }))
    // The slice total is how many findings the slice was supposed to file: one row per finding, so
    // the filed file's own length is not it — the findings the workers wrote are.
    const total = sliceTotals.get(slice) ?? rows.length
    const v = fourCounts(rows, total)
    perSlice.push({ slice, ok: v.ok, ...v.counts, diverged: v.diverged, duplicateFids: v.duplicateFids, duplicateKeys: v.duplicateKeys, missingFid: v.missingFid, missingKey: v.missingKey })
    if (!v.ok) {
      problems.push(`${slice}: ${v.diverged.map(d => `${d} ${v.counts[d]} vs rows ${v.counts.rows}`).join(', ')}${v.duplicateFids.length ? ` (duplicate fids ${v.duplicateFids.join(', ')})` : ''}${v.duplicateKeys.length ? ` (duplicate keys ${v.duplicateKeys.join(', ')})` : ''}`)
    }
  }
  if (problems.length) {
    if (ctx.jsonMode) ctx.json(envelope(false, { sweepId, perSlice, error: { code: 'check.four-counts', message: problems.join('; '), hint: 'the named count is the one to look at; the others agree' } }))
    else for (const p of problems) ctx.log(`FAIL ${p}`)
    return 1
  }
  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, slices: perSlice.length, perSlice }))
  else for (const s of perSlice) ctx.log(`${s.slice}: rows=${s.rows} uniqueFids=${s.uniqueFids} uniqueKeys=${s.uniqueKeys} sliceTotal=${s.sliceTotal}`)
  return 0
}
