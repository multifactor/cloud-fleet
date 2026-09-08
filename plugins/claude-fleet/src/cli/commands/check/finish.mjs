// `fleet check finish <sweepId>` — the wrap-up, which is where a sweep is either shown to be complete
// or shown not to be.
//
// It is deliberately a set of REFUSALS rather than a report. The failure mode this guards is not a
// sweep that crashes; it is a sweep that finishes looking clean over a corpus it never fully read.
// Every step below is one that has silently passed in the field:
//
//   1. the three counts — a `remaining` that is not 0 means the sweep is not finished, whatever the
//      wave reports said;
//   2. the ledger against the findings — a findings row proves an outcome, a missing ledger line only
//      proves a missed write, so the ledger is repaired FROM the findings and never the other way;
//   3. the four counts per slice — rows, unique fids, unique keys, slice total;
//   4. the frame — has the base branch moved under the sweep since its snapshot?
//
// ⛔ It does not mark the audit done, and it never promotes on its own. `checker.autoPromote` decides
//    whether promotion is even permitted, and the audit that gates it is still `fleet check gate
//    apply` with verdicts a human (or the audit playbook) produced. A `finish` that quietly called a
//    sweep gated would defeat the one control the whole pipeline is built around.

import fs from 'node:fs'

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { appendRow, readRows } from '../../../sys/tsv.mjs'
import { parseWorklistRows } from '../../../check/worklist.mjs'
import { parseLedger, reconcileFromFindings, resumeCounts, statusCounts } from '../../../check/ledger.mjs'
import { fourCounts } from '../../../check/fid.mjs'
import { shotCounts } from '../../../check/attach.mjs'
import { writeManifest } from '../../../check/manifest.mjs'
import { run as exec } from '../../../sys/exec.mjs'
import { requireSweep, positional, filedBySlice } from './sweep.mjs'
import { readFindings } from './ledger.mjs'

/** The per-slice findings, consolidated into `findings.jsonl` — written once, at the wrap-up. */
function consolidate(layout, findings) {
  fs.writeFileSync(layout.findingsJsonl, findings.map(f => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''))
  return findings.length
}

export function finishCmd(ctx, args) {
  const sweepId = positional(args, 1, { verb: 'finish', what: 'sweepId' })
  const { layout, manifest } = requireSweep(ctx, sweepId, { verb: 'finish' })
  const problems = []

  // ---- 1. the ledger, repaired from the findings before it is measured ---------------------------
  const worklist = parseWorklistRows(readRows(layout.worklist))
  if (!worklist.length) {
    throw new CliError('check.no-worklist', `${layout.worklist} is empty or absent — a sweep with no denominator cannot be finished`, 'run `fleet check worklist write <sweepId> --items-json -` first', 1)
  }
  const findings = readFindings(layout)
  const at = new Date(ctx.now()).toISOString()
  const repaired = reconcileFromFindings({
    worklistPrs: worklist.map(w => w.pr),
    ledgerEntries: parseLedger(readRows(layout.ledger)),
    findings,
    at,
  })
  for (const r of repaired) appendRow(layout.ledger, r)

  const rows = readRows(layout.ledger)
  const entries = parseLedger(rows)
  const counts = resumeCounts({ worklistPrs: worklist.map(w => w.pr), ledgerEntries: entries, ledgerFileNonEmpty: rows.length > 0 })
  if (counts.error) problems.push(counts.error)
  if (counts.remaining > 0) {
    problems.push(`${counts.remaining} PR(s) have no outcome on disk: ${counts.remainingPrs.slice(0, 10).join(' ')}${counts.remainingPrs.length > 10 ? ' …' : ''}`)
  }

  // ---- 2. the four counts, per slice --------------------------------------------------------------
  const findingsBySlice = new Map()
  for (const f of findings) {
    const slice = f.slice || (typeof f.fid === 'string' ? f.fid.split('|')[0] : null)
    if (slice) findingsBySlice.set(slice, (findingsBySlice.get(slice) || 0) + 1)
  }
  const perSlice = []
  for (const { slice, rows: filed } of filedBySlice(layout)) {
    const v = fourCounts(filed, findingsBySlice.get(slice) ?? filed.length)
    perSlice.push({ slice, ok: v.ok, ...v.counts, diverged: v.diverged })
    if (!v.ok) problems.push(`${slice}: ${v.diverged.map(d => `${d} ${v.counts[d]} vs rows ${v.counts.rows}`).join(', ')}`)
  }

  // ---- 3. the frame — has the base moved under the sweep? -----------------------------------------
  let frame = { since: manifest.repo.snapshotSha, commits: null, checked: false, note: null }
  if (!frame.since) {
    frame.note = 'the sweep recorded no snapshot commit, so nothing can be measured from it'
  } else {
    const base = `origin/${ctx.config.repo.baseBranch}`
    const r = exec('git', ['rev-list', '--count', `${frame.since}..${base}`], { cwd: ctx.cwd, timeoutMs: 30_000 })
    if (!r.ok) frame.note = `git rev-list ${frame.since}..${base} failed: ${(r.stderr || '').trim().slice(0, 200)}`
    else {
      frame.checked = true
      frame.commits = Number(String(r.stdout).trim()) || 0
      // 0 commits means there is nothing to re-derive; anything else is a pointer, not a failure —
      // `fleet check blast-radius` is what says whether any of it touched a finding.
      if (frame.commits > 0) frame.note = `${frame.commits} commit(s) landed on ${base} since the snapshot — run \`fleet check blast-radius ${sweepId}\` before trusting the frame`
    }
  }

  // ---- 4. record it -------------------------------------------------------------------------------
  const byStatus = statusCounts(entries)
  const shots = shotCounts(findings.map(f => f.body || '').filter(Boolean))
  const updated = {
    ...manifest,
    updatedAt: at,
    status: problems.length ? manifest.status : 'complete',
    counts: {
      ...manifest.counts,
      worklist: counts.worklist,
      filed: byStatus.filed,
      clean: byStatus.clean,
      skipped: byStatus.skipped,
      failed: byStatus.failed,
      noUi: shots.noUi ?? manifest.counts.noUi,
      noScreenshot: shots.noScreenshot ?? manifest.counts.noScreenshot,
    },
  }
  const dryRun = !!args.flags['dry-run']
  if (!dryRun) {
    consolidate(layout, findings)
    writeManifest(layout.dir, updated)
  }

  const body = {
    sweepId,
    ok: problems.length === 0,
    dryRun,
    worklist: counts.worklist,
    done: counts.done,
    remaining: counts.remaining,
    repairedFromFindings: repaired.length,
    byStatus,
    findings: findings.length,
    perSlice,
    frame,
    problems,
    // ⛔ Named, not implied. The audit ALWAYS follows a sweep, and `fleet check audit plan` is not
    // wired in this build — so a finish that said nothing here would read as "done".
    auditOwed: updated.audit.status !== 'complete',
    next: updated.audit.status !== 'complete'
      ? 'the audit always follows the sweep: produce audit/verdicts.tsv per playbooks/check-audit.md, then `fleet check gate apply`'
      : 'the audit is complete; promote with `fleet check promote`',
  }

  if (ctx.jsonMode) {
    if (problems.length) ctx.json(envelope(false, { ...body, error: { code: 'check.finish-incomplete', message: problems.join('; '), hint: 'the sweep is not finished; each problem names the file to look at' } }))
    else ctx.json(envelope(true, body))
  } else {
    ctx.log(`worklist=${counts.worklist} done=${counts.done} remaining=${counts.remaining}  filed=${byStatus.filed} clean=${byStatus.clean} skipped=${byStatus.skipped} failed=${byStatus.failed}`)
    if (repaired.length) ctx.log(`  repaired ${repaired.length} ledger row(s) from the findings`)
    for (const s of perSlice) ctx.log(`  ${s.slice}: rows=${s.rows} uniqueFids=${s.uniqueFids} uniqueKeys=${s.uniqueKeys} sliceTotal=${s.sliceTotal}${s.ok ? '' : '  DIVERGED: ' + s.diverged.join(', ')}`)
    if (frame.note) ctx.log(`  frame: ${frame.note}`)
    for (const p of problems) ctx.log(`  PROBLEM: ${p}`)
    ctx.log(problems.length ? 'NOT finished' : `finished — ${body.next}`)
  }
  return problems.length ? 1 : 0
}

/** `fleet check mark <localId> done` — the tracker-less reflection of a session's done-flag. */
export function markCmd(ctx, args) {
  const localId = positional(args, 1, { verb: 'mark', what: 'localId' })
  const state = positional(args, 2, { verb: 'mark', what: 'state' })
  if (state !== 'done') throw new CliError('check.mark-state', `fleet check mark: the only state is \`done\`, not "${state}"`, 'fleet check mark <localId> done')
  const sweepId = stringFlag(args.flags, 'sweep-id', null) || String(localId).replace(/^CHK-/, '').split('-').slice(0, -1).join('-')
  const { layout } = requireSweep(ctx, sweepId, { verb: 'mark' })
  const file = `${layout.dir}/marks.tsv`
  appendRow(file, [localId, 'done', new Date(ctx.now()).toISOString()])
  if (ctx.jsonMode) ctx.json(envelope(true, { sweepId, localId, state, file }))
  else ctx.log(`${file}: ${localId} done`)
  return 0
}
