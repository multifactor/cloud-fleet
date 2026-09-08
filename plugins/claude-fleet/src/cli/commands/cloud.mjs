// `fleet cloud dispatch` — declared in contract §7, not wired in this build.
//
// This module exists so the command REFUSES rather than reaching "unknown command". The contract is
// the specification the modules are written against, and `playbooks/cloud-capture.md` tells an
// operator to run this; being told the verb does not exist, while the reference says it does, sends
// them to look for a typo in their own invocation.
//
// What is missing is only the command layer. `src/cloud/dispatch.mjs` is written and tested — the
// runbook builder with its end sentinel, the ramp plan, the stall verdict, the dispatch gate, the
// results poll, the harvest and its manifest reconciliation, and the pty launch plan for both
// platforms. What is not written is the loop that drives them: dispatch a wave, watch it, harvest,
// drain the outbox.
//
// ⛔ It is a refusal with a reason, never a stub that does part of the job. A dispatch that launched
//    sandboxes and then failed to harvest them would leave work on a results branch nobody reads,
//    which is worse than not dispatching.

import { CliError } from '../args.mjs'

export const name = 'cloud'
export const usage = 'fleet cloud dispatch --bundle <dir> --ref <branch> [--slice f]'
export const needsConfig = true
export const needsBackend = false

export async function run(ctx, args) {
  const sub = args.sub
  if (sub && sub !== 'dispatch') {
    throw new CliError('cloud.verb', `unknown verb "fleet cloud ${sub}"`, 'the only verb contract §7 defines is `dispatch`')
  }
  throw new CliError(
    'cloud.not-implemented',
    '`fleet cloud dispatch` is defined in contract §7 but is not wired in this build: the dispatch loop (send a wave, watch it, harvest, drain) over src/cloud/dispatch.mjs',
    'the pieces it would drive are built and tested — buildRunbookPrompt, rampPlan, stallVerdict, dispatchGate, pollResults, harvest, launchPlan. Until the loop exists, run the sweep in `--mode local` or `--mode sessions`; `fleet check harvest <sweepId>` pulls back a run dispatched by other means.',
    1,
  )
}
