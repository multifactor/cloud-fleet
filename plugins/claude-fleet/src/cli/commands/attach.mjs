// `fleet attach` (contract §7) — get the operator back to the fleet's terminal session.
//
// On tmux the fleet OUTLIVES the terminal it was launched from: it runs on its own socket
// (`terminal.tmux.socket`) with its own server, so closing the window or dropping an ssh connection
// leaves every session running with nothing attached to it. This command is how you get back.
//
// ⛔ The command is PRINTED, not spawned. Attaching takes over the terminal, and the one sanctioned
// spawn helper (src/sys/exec.mjs) captures stdio rather than inheriting it — a tmux client started
// that way dies with "open terminal failed: not a terminal" and takes the operator's shell nowhere.
// So the exact argv is emitted, together with the variables that must be unset first: `$TMUX` is
// present inside another tmux and tmux refuses to nest while it is (it tests for PRESENCE, so
// blanking it is not enough).
//
// ⛔ A backend that cannot do this says so in one line. There is no silent no-op: a fleet of separate
// desktop windows has nothing to re-attach to, and an operator who typed `fleet attach` and got a
// clean exit would go looking for a session that never existed.

import { envelope } from '../../cli.mjs'
import { degradationNotice } from '../../backends/types.mjs'

/**
 * PURE. One argv token, safe to paste into a POSIX shell.
 *
 * ⛔ This is not cosmetic. tmux's exact-match prefix is `=`, so the attach target is `=fleet` — and
 * in ZSH, THE DEFAULT MACOS SHELL, a word starting with `=` is EQUALS EXPANSION: zsh resolves
 * `=fleet` to the path of a command called `fleet`, finds none, and the whole line dies with
 * "zsh: fleet not found" before tmux is ever executed. The command this help printed was therefore
 * impossible to run on a stock Mac, and the failure names a command the operator never typed, which
 * sends them looking for a broken install instead of a quoting bug. Quoting also carries a
 * worktree parent or plugin path that contains a space.
 */
export function shellQuote(token) {
  const s = String(token)
  // The unreserved set: no expansion, no splitting, no history, no equals expansion.
  if (s.length > 0 && /^[A-Za-z0-9_@%+:,./-]+$/.test(s)) return s
  return `'${s.replaceAll("'", `'\\''`)}'`
}

export const name = 'attach'
export const usage = 'fleet attach'
export const needsConfig = true
export const needsBackend = true

export async function run(ctx, args) {
  const backend = ctx.backend
  const caps = backend.capabilities()
  const probed = backend.probe()
  const backendName = backend.name || probed.name || 'unknown'

  if (typeof backend.attachCommand !== 'function') {
    // The capability, not the backend name, is what decides: a backend whose sessions die with the
    // launcher has nothing detached to attach TO, and that is the sentence to print.
    const notice = degradationNotice(caps, 'detachSurvivesLauncher', 'fleet attach')
      || `fleet attach: the ${backendName} backend has no attachable session — its windows are already on this desktop`
    ctx.json(envelope(true, { backend: backendName, attachable: false, command: null, args: [], unsetEnv: [], notice }))
    ctx.log(notice)
    // 0, not a failure: nothing is wrong with the fleet, and this backend simply has no such door.
    return 0
  }

  // Ask whether the fleet session is really there before handing over a command that would otherwise
  // fail with tmux's own prose. `sessionExists` is exact-match (`=name`), never a prefix.
  const exists = typeof backend.sessionExists === 'function' ? backend.sessionExists() : null
  const plan = backend.attachCommand()
  const line = [...plan.unsetEnv.map(v => `unset ${v}`), [plan.command, ...plan.args].map(shellQuote).join(' ')].join(' && ')

  if (exists === false) {
    ctx.json(envelope(true, { backend: backendName, attachable: false, sessionExists: false, command: plan.command, args: plan.args, unsetEnv: plan.unsetEnv, run: line, notice: 'no fleet session is running on this backend' }))
    ctx.log(`fleet attach: no fleet session is running on the ${backendName} backend — start one with \`fleet up\``)
    return 0
  }

  ctx.json(envelope(true, { backend: backendName, attachable: true, sessionExists: exists, command: plan.command, args: plan.args, unsetEnv: plan.unsetEnv, run: line }))
  ctx.log('fleet attach: run this in the terminal you want the fleet in (attaching takes the terminal over, so it cannot be done for you):')
  ctx.log(`  ${line}`)
  return 0
}
