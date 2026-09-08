// `fleet intake check <KEY…>` (contract §7) — which of these tickets may be worked, and why not.
//
// This is the consumer-side half of the audit gate: a human moving an ungated checker ticket into
// the ready state does NOT get it worked, and the refusal says which gate stopped it.
//
//   ⛔ A refusal is RECORDED (`intake-refused.jsonl`) and printed, never silent. A silently
//      shrinking queue reads as "there was no work", and the operator never learns that a whole
//      sweep's findings were refused for the same missing label.
//   ⛔ A key with no cached ticket FAILS CLOSED. The gate cannot be judged without the ticket, so
//      the answer is "refused: no-ticket-cache" rather than a session launched on a finding the
//      audit may never have passed. A cache that IS there and cannot be read is the same condition
//      under another name and is refused too — never read as "absent", which would be a miss.
//   ⛔ A ticket nobody's checker filed is ordinary human work and is admitted unconditionally — the
//      gate exists for machine-generated findings, not for the team's own backlog.
//   ⛔ The ticket is read through trackers/tickets.readTicket, which keeps `labels: null` ("the
//      feeder supplied none") distinct from `[]` ("the issue has none"). Contract §6 op-2 carries NO
//      labels, and the launcher caches from op-2 (playbooks/launcher.md 5b), so collapsing the two
//      would make EVERY checker-filed ticket look unfiled and admit it with no gate and no word
//      said. With no labels: a ticket whose BODY shows the checker pipeline (`**Gate:**`, or the
//      `**Filed by:**` line the label-less adapters write instead of a label) is judged as
//      checker-filed anyway, and anything else is admitted with a WARNING — never silently. It is
//      not refused, because refusing every op-2-fed key would refuse the launcher's own flow.

import { admit } from '../../core/intake.mjs'
import { readTicket } from '../../trackers/tickets.mjs'
import { appendRefusal, refusedPath, REFUSAL_NO_CACHE } from '../../watchers/autowave.mjs'
import { envelope } from '../../cli.mjs'
import { CliError } from '../args.mjs'

export const name = 'intake'
export const usage = 'fleet intake check <KEY…>'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['check']

/** A cached ticket that is on disk and cannot be read: the same "cannot be judged" as no cache at all. */
const REFUSAL_UNREADABLE = 'ticket-cache-unreadable'

/** An admission the gate could not really judge, because the cache carries no label list. */
const WARN_NO_LABELS = 'intake.labels-not-supplied'

/** What each refusal means, in one line an operator can act on. */
const WHY = Object.freeze({
  [REFUSAL_NO_CACHE]: 'no cached ticket, so the gate cannot be judged — run `fleet ticket cache --issue <KEY> --from-json -` first',
  [REFUSAL_UNREADABLE]: 'the cached ticket is on disk but unreadable (or the key is not a filename), so the gate cannot be judged — re-cache it with `fleet ticket cache --issue <KEY> --from-json -`',
  ungated: 'filed by a checker but carrying no gate label — an audit has not passed it yet',
  'gate-failed': 'the audit failed this finding: it is not a defect as filed',
  'gate-disputed': 'a session refuted the diagnosis; working it would re-litigate that',
  'gate-uncertain': 'the audit could not decide — a human waives it (gate:waived) or re-audits it',
})

/** What each warning means. An admission nobody explains is one nobody can act on either. */
const WHY_WARN = Object.freeze({
  [WARN_NO_LABELS]: 'the cache carries no label list (op-2 has none), so the provenance and gate labels could not be read — pass labels[] to `fleet ticket cache` for the gate to mean anything for this key',
})

/**
 * PURE. Does this ticket show the checker pipeline in its BODY, when its labels cannot say?
 *
 * The `**Gate:**` line is written by every sweep (src/check/findings.mjs) and is the fallback
 * core/intake.gateStatusOf already reads; `**Filed by:** <checker.provenanceLabel>` is the line the
 * label-less adapters (trackers/jira.md, trackers/trello.md) write instead of the provenance label.
 * Either one is proof enough to judge the ticket as checker-filed — without it a `**Gate:** failed`
 * finding whose labels were never supplied is admitted as ordinary human work.
 */
function bodyShowsCheckerFiled(issue, cfg) {
  const body = String((issue && (issue.body ?? issue.description)) || '')
  if (/^\s*\*\*Gate:\*\*/im.test(body)) return true
  const m = /^\s*\*\*Filed by:\*\*\s*(.+?)\s*$/im.exec(body)
  return !!m && m[1] === String(cfg.checker.provenanceLabel)
}

/**
 * One cached ticket as `{record}` (null when it was never cached) or `{error}`. readTicket THROWS for
 * a cache that is on disk and damaged, and for a key that is not a filename — both are "the gate
 * cannot be judged", so they become a refusal rather than an exception that ends the whole check.
 */
function readCached(stateDir, key) {
  try {
    return { record: readTicket(key, { stateDir }) }
  } catch (e) {
    return { error: e.message }
  }
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('intake.unknown-subcommand', `fleet intake takes ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('intake.no-state-dir', 'paths.stateDir is unresolved on this machine, so the ticket cache cannot be read', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }

  // Comma-joined or space-separated, because both spellings arrive: the launcher flattens a parent's
  // children into one list and an operator types them by hand.
  const keys = args.positionals.slice(1).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean)
  if (!keys.length) throw new CliError('intake.no-keys', 'fleet intake check takes one or more issue keys', 'fleet intake check ABC-1234 ABC-1240')

  const at = new Date(ctx.now()).toISOString()
  const file = refusedPath(stateDir)
  const admitted = []
  const refused = []
  const warnings = []

  for (const key of keys) {
    const cached = readCached(stateDir, key)
    const record = cached.record ?? null
    // "The feeder supplied no labels" while the gate is on: the provenance label cannot be seen, so
    // the body is asked instead, and the admission that follows carries a warning either way.
    const blind = !!record && record.labels === null && ctx.config.fleet.queue.requireGate
    const issue = blind && bodyShowsCheckerFiled(record, ctx.config)
      ? { ...record, labels: [ctx.config.checker.provenanceLabel] }
      : record
    const verdict = record
      ? admit(issue, ctx.config)
      : { admit: false, reason: cached.error ? REFUSAL_UNREADABLE : REFUSAL_NO_CACHE, gate: null, warn: null }
    if (verdict.admit) {
      admitted.push({ key, gate: verdict.gate ?? null })
      // The one trace that an unaudited ticket was launched anyway (gate disabled, waived by a
      // human, or judged with no labels to judge on): it belongs in the report, not only in the code
      // path that allowed it.
      if (verdict.warn) warnings.push({ key, warn: verdict.warn, gate: verdict.gate ?? null })
      if (blind) warnings.push({ key, warn: WARN_NO_LABELS, gate: verdict.gate ?? null })
      continue
    }
    const entry = { v: 1, key, reason: verdict.reason, gate: verdict.gate ?? null, source: 'intake-check', at }
    appendRefusal(file, entry)
    refused.push(entry)
  }

  ctx.json(envelope(true, {
    admitted: admitted.map(a => a.key),
    admittedDetail: admitted,
    refused,
    warnings,
    refusedFile: file,
    counts: { checked: keys.length, admitted: admitted.length, refused: refused.length },
  }))

  for (const a of admitted) ctx.log(`admit  ${a.key}${a.gate ? `  gate=${a.gate}` : ''}`)
  for (const r of refused) ctx.log(`REFUSE ${r.key}  ${r.reason}${r.gate ? ` (gate=${r.gate})` : ''} — ${WHY[r.reason] || 'refused at intake'}`)
  for (const w of warnings) ctx.log(`note   ${w.key} was admitted with ${w.warn}${w.gate ? ` (gate=${w.gate})` : ''}${WHY_WARN[w.warn] ? ` — ${WHY_WARN[w.warn]}` : ''}`)
  if (refused.length) ctx.log(`${refused.length} refusal(s) recorded in ${file} — tell the operator which keys they were; a shrinking queue that says nothing reads as "there was no work"`)
  // Exit 0 whatever the verdicts: a refusal is an ANSWER, and a non-zero exit would make the
  // launcher treat a correctly gated queue as a broken tool and abort the run.
  return 0
}
