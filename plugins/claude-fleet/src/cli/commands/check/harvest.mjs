// `fleet check harvest <sweepId> --ref <results-branch>` — pull a cloud run back into its sweep dir.
//
// A sandbox has neither the tracker MCP nor `gh`, so a cloud worker NEVER files. It pushes its
// findings, its screenshots and its `outbox/*.json` entries to a results branch, and this is the step
// that brings them home: the PNGs land under `shots/`, the outbox entries land in the launcher's
// outbox where the drain already runs, and the findings land under `findings/`.
//
//   ⛔ A FAILED FETCH IS NOT "NOTHING DELIVERED". `dispatch.harvest` throws rather than returning an
//      empty result for exactly this reason — a network error read as an empty results branch marks
//      a sandbox's whole slice as producing nothing, and the slice is then re-run from zero.
//   ⛔ The outbox entries are copied VERBATIM. A cloud worker's `createIssue` carries the body a
//      human will read; re-serialising it here would be this process editing evidence it did not
//      gather.

import path from 'node:path'

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { harvest } from '../../../cloud/dispatch.mjs'
import { enqueue } from '../../../trackers/outbox.mjs'
import { requireSweep, positional, stateDirOf } from './sweep.mjs'

export function harvestCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'harvest', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'harvest' })
  const ref = stringFlag(args.flags, 'ref', null)
  if (!ref) {
    throw new CliError('check.harvest-needs-ref', 'fleet check harvest needs --ref <results-branch>', 'the branch the sandbox pushed to — `fleet cloud dispatch` names it, and the dispatch log records it')
  }
  if (manifest.mode !== 'cloud') {
    // Not refused: a sweep can be re-run in another mode, and harvesting a branch that exists is
    // never destructive. But saying so is better than silently mixing two runs' outputs.
    ctx.log(`note: sweep ${sweepId} is in ${manifest.mode} mode, not cloud — harvesting ${ref} into it anyway`)
  }

  let result
  try {
    result = harvest({
      branch: ref,
      into: ctx.cwd,
      remote: 'origin',
      expectedSha: manifest.repo.snapshotSha || null,
      extractTo: layout.shots,
    })
  } catch (e) {
    // The git error travels: it is the explanation for the zero that would otherwise be reported.
    throw new CliError('check.harvest-failed', e.message, 'a failed fetch is not "nothing delivered" — do not re-run the slice until this is understood', 1)
  }

  // The findings the worker produced, into the sweep's own findings dir.
  const findings = []
  for (const f of result.files) {
    if (!/(^|\/)findings\/[^/]+\.jsonl$/.test(f)) continue
    findings.push(path.basename(f))
  }

  // The outbox entries, into the launcher's outbox — the drain that already runs, not a second one.
  const at = new Date(ctx.now()).toISOString()
  const enqueued = []
  const rejected = []
  for (const e of result.outboxEntries || []) {
    if (e.error) { rejected.push({ file: e.file, error: e.error }); continue }
    const entry = e.entry || {}
    try {
      const q = enqueue({
        stateDir: stateDirOf(ctx),
        op: entry.op,
        key: entry.key,
        args: entry.args || {},
        verbatim: !!entry.verbatim,
        requestedBy: `check-${sweepId}`,
        at,
        note: entry.note,
      })
      enqueued.push({ id: q.id ?? null, op: entry.op, key: entry.key, from: e.file })
    } catch (err) {
      // One malformed entry must not lose the rest of a sandbox's work.
      rejected.push({ file: e.file, error: err.message })
    }
  }

  const body = {
    sweepId,
    ref,
    sha: result.sha,
    files: result.files.length,
    shots: (result.shots || []).length,
    extracted: (result.extracted || []).length,
    shotsDir: layout.shots,
    findings,
    enqueued,
    rejected,
    verdict: result.verdict ?? null,
    failed: result.failed ?? null,
    blockedHosts: result.blockedHosts ?? [],
  }
  const ok = rejected.length === 0 && !result.failed
  if (ctx.jsonMode) {
    ctx.json(envelope(ok, ok ? body : { ...body, error: { code: 'check.harvest-incomplete', message: result.failed ? `the sandbox reported failure: ${result.failed.reason || 'see FAILED.md'}` : `${rejected.length} outbox entr(ies) could not be queued`, hint: 'a failed sandbox run is a slice to re-dispatch, not a slice with nothing in it' } }))
  } else {
    ctx.log(`${result.files.length} file(s) at ${String(result.sha).slice(0, 12)}; ${body.extracted} screenshot(s) into ${layout.shots}`)
    ctx.log(`  ${enqueued.length} outbox entr(ies) queued${rejected.length ? `, ${rejected.length} rejected` : ''}`)
    for (const r of rejected) ctx.log(`  REJECTED ${r.file}: ${r.error}`)
    if (result.failed) ctx.log(`  FAILED.md: ${result.failed.reason || '(no reason given)'}`)
    for (const h of body.blockedHosts) ctx.log(`  blocked host: ${h}`)
  }
  return ok ? 0 : 1
}
