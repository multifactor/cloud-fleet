// `fleet session env --label <n>` (contract §7) — one session's resolved environment, as data.
//
// This is what to read before believing a session was handed the wrong URL, ticket file or state
// dir: it recomputes the ~9 `FLEET_*` scalars from the descriptor the launcher wrote (contract §4)
// through the same `buildSessionEnv` the shim uses, so what it prints is what the session got — not
// a second implementation that can drift from it.
//
// ⛔ It prints the MIRRORED SCALARS, never the whole descriptor: those are exactly the values a
// session is allowed to spell for itself. Paths a session uses come from its descriptor or its
// environment, never from a literal, and a command that printed a merged blob of both would invite
// exactly the hand-copied absolute path that breaks on the next machine.

import { buildSessionEnv } from '../../config/env.mjs'
import { sessionEnvInput } from '../../session/shim.mjs'
import { readSession, sessionPath, listSessions } from '../../core/fleet.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'session'
export const usage = 'fleet session env --label <n>'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['env']

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('session.unknown-subcommand', `fleet session takes ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('session.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is no registry to read', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }

  // A session asking about ITSELF needs no flag: it knows its label from the environment it is
  // asking about, and making it retype the value is how the wrong label gets typed.
  const label = stringFlag(args.flags, 'label', null) ?? String(ctx.env.FLEET_LABEL || '').trim()
  if (!label) {
    throw new CliError('session.no-label', '--label is required', 'fleet session env --label 3 — inside a session, FLEET_LABEL answers it for you')
  }

  let descriptor
  try {
    descriptor = readSession(label, { stateDir })
  } catch (e) {
    throw new CliError('session.bad-label', e.message, 'a label is a filename ([A-Za-z0-9._-], not starting with "."), never a path')
  }
  if (!descriptor) {
    const known = listSessions({ stateDir }).map(d => String(d.label))
    throw new CliError(
      'session.unknown',
      `no session descriptor for label ${JSON.stringify(label)}`,
      known.length ? `the registry holds ${known.join(', ')}` : 'no sessions are registered in this state dir — `fleet up` writes the descriptors',
      1,
    )
  }

  // ⛔ The descriptor's own path is a field the shim requires and buildDescriptor does not write, so
  // it is filled in from the registry layout rather than left empty: a session whose
  // FLEET_SESSION_FILE is blank cannot find the descriptor that names its worktree.
  const withFile = { ...descriptor, file: descriptor.file || sessionPath(stateDir, label) }

  let env
  try {
    env = buildSessionEnv(ctx.config, sessionEnvInput(withFile))
  } catch (e) {
    throw new CliError('session.incomplete-descriptor', e.message, 'the descriptor is missing a field the session needs — a testing session without its slot number cannot start its dev server at all', 1)
  }

  ctx.json(envelope(true, { label: String(descriptor.label), role: descriptor.role, file: withFile.file, env }))
  for (const e of env) ctx.log(`${e.name}=${e.value}`)
  return 0
}
