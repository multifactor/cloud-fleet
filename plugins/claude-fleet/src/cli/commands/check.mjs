// `fleet check …` — the sweep half of the pipeline, the CLI half of `/fleet-check`.
//
// One module owns the whole `check` namespace and dispatches internally, the way `fleet config` does.
// The registry supports a module per sub, but the check grammar is ~20 verbs over a dozen pure
// modules, and a file per verb would be twenty copies of the same five-line command contract to hold
// four lines of wiring each.
//
// The division of labour, which is the whole design:
//
//   * `src/check/*` decides. Every one of those modules is pure — the planner will not read a clock
//     or a git head even when it needs one, it throws instead — which is why the arithmetic that
//     used to be model instructions can be tested at all.
//   * this layer does I/O and nothing else: read the manifest, stat the worklist, append a row,
//     enqueue an outbox entry.
//   * the model does everything that talks to a tracker, by executing the adapter's `Call:` line.
//     No verb here ever calls a tracker tool; what the CLI wants the tracker to do becomes an outbox
//     entry the launcher drains.
//
// ⛔ Every verb contract §7 defines under `check` is wired. When one is not, it must refuse BY NAME
//    with what it is waiting on — a CLI that accepts a verb and quietly does nothing is worse than one
//    that refuses, because the sweep would look like it had reconciled.

import { CliError } from '../args.mjs'
import { planCmd } from './check/plan.mjs'
import { worklistCmd, resumeCmd, sliceCmd } from './check/worklist.mjs'
import { ledgerCmd, fidCmd, reconcileCmd } from './check/ledger.mjs'
import { briefCmd, statusCmd } from './check/brief.mjs'
import { gateCmd, promoteCmd, enumCmd, blastRadiusCmd } from './check/gate.mjs'
import { finishCmd, markCmd } from './check/finish.mjs'
import { ghCmd, tickCmd } from './check/gh.mjs'
import { verifyCitationsCmd, verifyPathsCmd } from './check/verify.mjs'
import { frameCmd } from './check/frame.mjs'
import { dupsCmd } from './check/dups.mjs'
import { harvestCmd } from './check/harvest.mjs'
import { auditCmd } from './check/audit.mjs'

export const name = 'check'
export const usage = 'fleet check plan <input> [--mode m] [--project p] [--width n] [--auto] [--resume id] [--from-file f] [--dry-run] | worklist write | resume | slice | brief | ledger | fid | reconcile | gate [--verdicts f] | promote [--all|--fid f|--min-priority n] [--waive] | enum check [--col n] [--domain d] | blast-radius [--since sha] | finish [--dry-run] | mark | gh bundle | tick plan [--items-json f] | verify-citations [--corpus f] [--ref r] | verify-paths | frame derive|check [--pages f] | dups cluster [--count n] | harvest --ref b | audit plan | status'
export const needsConfig = true
// No terminal: every verb here reads and writes files. `--mode sessions` spawns its workers through
// `fleet up --role checker --sweep-id <id>`, which is where a backend is actually needed.
export const needsBackend = false

/** verb → handler. */
const VERBS = {
  plan: planCmd,
  worklist: worklistCmd,
  resume: resumeCmd,
  slice: sliceCmd,
  brief: briefCmd,
  ledger: ledgerCmd,
  fid: fidCmd,
  reconcile: reconcileCmd,
  status: statusCmd,
  gate: gateCmd,
  promote: promoteCmd,
  enum: enumCmd,
  'blast-radius': blastRadiusCmd,
  finish: finishCmd,
  mark: markCmd,
  gh: ghCmd,
  tick: tickCmd,
  'verify-citations': verifyCitationsCmd,
  'verify-paths': verifyPathsCmd,
  frame: frameCmd,
  dups: dupsCmd,
  harvest: harvestCmd,
  audit: auditCmd,
}

export async function run(ctx, args) {
  const verb = args.sub
  const handler = VERBS[verb]
  if (handler) return handler(ctx, args)

  throw new CliError(
    'check.unknown-verb',
    verb ? `unknown verb "fleet check ${verb}"` : 'fleet check takes a verb',
    `one of ${Object.keys(VERBS).sort().join(', ')} — run \`fleet check status\` to see the sweeps on this machine`,
  )
}
