// `fleet add [k]` (contract §7) — `fleet up --add k`, and deliberately nothing more.
//
// It is a separate command because it is a separate SENTENCE the operator says ("add two more"), not
// because it is a separate behaviour: the numbering, the descriptors, the windows and the paced
// installs are all `up`'s, and a second implementation of any of them would drift from it.
//
// ⛔ The testing pool is left exactly as it is (`testing: 0` in the plan, and `--testing` refused —
// see up.planOptions). Adding a working session must never resize the slot table: the slots that are
// up are serving branches sessions are capturing against, and a re-plan that dropped one would take a
// dev server out from under a session mid-capture.

import { runUp } from './up.mjs'

export const name = 'add'
export const usage = 'fleet add [k]'
export const needsConfig = true
// Same reason as `up`: this command opens windows, so a machine with no terminal backend must fail
// here rather than half-way through a wave with worktrees already created.
export const needsBackend = true

export async function run(ctx, args) {
  return runUp(ctx, args, { verb: 'add' })
}
