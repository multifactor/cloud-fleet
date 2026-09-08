// `fleet check frame derive|check` and `fleet check reconcile tracker --pages <json>`.
//
// All three answer one question: what is the DENOMINATOR the audit's tally is out of? Every one of
// them takes op-16 pages the model fetched, because the CLI never calls a tracker — and every one of
// them runs `assertComplete` first.
//
//   ⛔ A PAGE RETURNING EXACTLY ITS LIMIT, WITH NO EXPLICIT COMPLETENESS SIGNAL, IS TRUNCATED BY
//      DEFINITION. That is not a heuristic: it is the only safe reading, and the incident it comes
//      from is a phantom band — an "Urgent" tally computed against a page that had silently stopped
//      at its limit, so the audit reported a frame it had never seen the end of.
//   ⛔ An empty-but-complete set is reported with a warning, never as a clean zero. A zero and a
//      broken query (a drifted group id, a renamed provenance label) look identical from here, and
//      against an empty filed set every candidate reads as unfiled and the whole batch is re-filed.

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { readRows } from '../../../sys/tsv.mjs'
import { assertComplete, frameCheck, joinFiledToPrs, PRIORITY_BANDS } from '../../../check/reconcile.mjs'
import { parseVerdicts } from '../../../check/gate.mjs'
import { requireSweep, positional, filedRows } from './sweep.mjs'
import { readJsonArg } from './payload.mjs'

/** The op-16 pages, and the completeness verdict over them. */
function completePages(ctx, args, { adapterFindComplete }) {
  const where = stringFlag(args.flags, 'pages', null)
  if (!where) {
    throw new CliError('check.no-pages', `fleet check ${args.sub} needs --pages <json>`, 'run op-16 findIssues once per priority band and hand the pages in: `--pages -` reads them from stdin. The CLI never calls a tracker; it judges what you fetched.')
  }
  const payload = readJsonArg(ctx, where, { flag: '--pages' })
  const pages = Array.isArray(payload) ? payload : payload && Array.isArray(payload.pages) ? payload.pages : null
  if (!pages) {
    throw new CliError('check.pages-shape', '--pages carried neither an array of pages nor an object with a `pages` array', 'each page is `{issues: [...], limit, complete, priority?}` — one per op-16 call')
  }
  // Every band, always. Three of four combined into "the filed set" is a denominator missing a
  // quarter of itself, and nothing downstream can tell — so there is no flag to opt out.
  return { pages, verdict: assertComplete(pages, { findComplete: adapterFindComplete, priorities: PRIORITY_BANDS }) }
}

function findCompleteOf(ctx) {
  const caps = (ctx.adapter && (ctx.adapter.capabilities || (ctx.adapter.front && ctx.adapter.front.capabilities))) || {}
  const v = caps.findComplete
  if (!v) {
    throw new CliError('check.no-find-complete', `the ${ctx.config.tracker.id || 'configured'} adapter declares no capabilities.findComplete, so there is no rule for reading a page as finished`, 'every bundled adapter declares one (`count`, `flag`, `cursor` or `none`); a project adapter under .fleet/trackers/ must too', 1)
  }
  return v
}

function refuseIncomplete(ctx, verdict, body) {
  const err = {
    code: 'check.pages-incomplete',
    message: `the op-16 pages are not a complete set: ${verdict.reason}`,
    hint: 'a page returning exactly its limit with no completeness signal is truncated by definition — re-query with a higher limit or follow the cursor, and query EVERY band. A subtraction cannot tell you a side was short.',
  }
  if (ctx.jsonMode) ctx.json(envelope(false, { ...body, error: err }))
  else ctx.log(`INCOMPLETE: ${verdict.reason}`)
  return 1
}

/** `frame derive` — the frame itself, plus what it attributes to which PR. */
export function frameCmd(ctx, args) {
  const verb = args.positionals[1]
  if (verb !== 'derive' && verb !== 'check') {
    throw new CliError('check.frame-verb', `fleet check frame: ${verb ? `no verb "${verb}"` : 'no verb given'}`, 'one of derive, check')
  }
  const sweepId = positional(args, 2, { verb: `frame ${verb}`, what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: `frame ${verb}` })
  const { pages, verdict } = completePages(ctx, args, { adapterFindComplete: findCompleteOf(ctx) })
  const provenance = stringFlag(args.flags, 'note', null) || `${pages.length} op-16 page(s)`

  const base = { sweepId, pages: pages.length, bands: verdict.bands, complete: verdict.complete, warn: verdict.warn }
  if (!verdict.complete) return refuseIncomplete(ctx, verdict, base)

  const derivedKeys = verdict.issues.map(i => String(i.key ?? i.id)).filter(Boolean)

  if (verb === 'derive') {
    const join = joinFiledToPrs(verdict.issues)
    const body = { ...base, derived: derivedKeys.length, keys: derivedKeys, byPr: join.byPr, unattributed: join.unattributed, provenance }
    if (ctx.jsonMode) ctx.json(envelope(true, body))
    else {
      if (verdict.warn) ctx.log(`WARNING: ${verdict.warn}`)
      ctx.log(`${derivedKeys.length} issue(s) in the frame, over ${Object.keys(join.byPr).length} PR(s); ${join.unattributed.length} unattributed`)
      for (const u of join.unattributed) ctx.log(`  ${u.key}: ${u.reason}`)
    }
    return 0
  }

  // `check`: the frame against what the gate actually judged.
  const verdictsFile = stringFlag(args.flags, 'verdicts', null) || `${layout.audit}/verdicts.tsv`
  const rows = readRows(verdictsFile)
  if (!rows.length) {
    throw new CliError('check.no-verdicts', `${verdictsFile} is empty or absent — there is nothing to check the frame against`, 'the audit writes it; pass another with --verdicts', 1)
  }
  const judged = parseVerdicts(rows)
  const result = frameCheck({
    derived: derivedKeys,
    gated: judged.map(v => v.key).filter(Boolean),
    // The audit is the one step that cancels, so its own cancellations legitimately sit outside the
    // frame — counting them as stray judgements would make every complete audit look broken.
    cancelled: judged.filter(v => v.gate === 'failed').map(v => v.key).filter(Boolean),
    provenance,
  })
  const body = { ...base, ...result, verdicts: verdictsFile }
  if (ctx.jsonMode) ctx.json(envelope(result.ok, result.ok ? body : { ...body, error: { code: 'check.frame-mismatch', message: result.summary, hint: '`missing` were never gated; `extra` are live rows judged outside the frame. Re-derive the frame and re-run — do not adjust the tally.' } }))
  else {
    if (result.warn) ctx.log(`WARNING: ${result.warn}`)
    ctx.log(result.summary)
    if (result.missing.length) ctx.log(`  never gated: ${result.missing.join(' ')}`)
    if (result.extra.length) ctx.log(`  live, judged outside the frame: ${result.extra.join(' ')}`)
  }
  return result.ok ? 0 : 1
}

/**
 * `fleet check reconcile tracker --pages <json>` — the filed set as the TRACKER sees it, against the
 * `filed/<slice>.tsv` rows the sweep wrote.
 *
 * The two disagreeing is the interesting case: a key on disk that the tracker does not return was
 * filed and then cancelled or moved out of the query, and a key the tracker returns that is on no
 * filed row was filed by something other than this sweep.
 */
export function reconcileTrackerCmd(ctx, args) {
  const sweepId = positional(args, 2, { verb: 'reconcile tracker', what: 'sweepId' })
  const { layout } = requireSweep(ctx, sweepId, { verb: 'reconcile tracker' })
  const { pages, verdict } = completePages(ctx, args, { adapterFindComplete: findCompleteOf(ctx) })
  const base = { sweepId, pages: pages.length, bands: verdict.bands, complete: verdict.complete, warn: verdict.warn }
  if (!verdict.complete) return refuseIncomplete(ctx, verdict, base)

  const onDisk = filedRows(layout)
  const diskKeys = new Set(onDisk.map(r => r.key).filter(Boolean))
  const trackerKeys = new Set(verdict.issues.map(i => String(i.key ?? i.id)).filter(Boolean))
  const missingFromTracker = [...diskKeys].filter(k => !trackerKeys.has(k))
  const notOnDisk = [...trackerKeys].filter(k => !diskKeys.has(k))
  const ok = missingFromTracker.length === 0 && notOnDisk.length === 0

  const body = {
    ...base,
    filed: diskKeys.size,
    inTracker: trackerKeys.size,
    missingFromTracker,
    notOnDisk,
    ok,
  }
  if (ctx.jsonMode) ctx.json(envelope(ok, ok ? body : { ...body, error: { code: 'check.tracker-mismatch', message: `${missingFromTracker.length} filed key(s) the query does not return, ${notOnDisk.length} returned key(s) on no filed row`, hint: 'a filed key the query misses was cancelled or moved out of it; a returned key on no filed row was filed by something other than this sweep. Neither is fixed by adjusting the count.' } }))
  else {
    if (verdict.warn) ctx.log(`WARNING: ${verdict.warn}`)
    ctx.log(`${diskKeys.size} filed on disk, ${trackerKeys.size} in the tracker`)
    if (missingFromTracker.length) ctx.log(`  the query does not return: ${missingFromTracker.join(' ')}`)
    if (notOnDisk.length) ctx.log(`  on no filed row: ${notOnDisk.join(' ')}`)
  }
  return ok ? 0 : 1
}
