// `fleet kill <label…> [--dry-run]` (contract §7) — end a session's process tree through the
// terminal backend, then say what survived.
//
//   ⛔ A kill that cannot fail is a kill nobody verifies. The backend reports `survivors`, and this
//      command exits non-zero when there are any: `fleet relaunch` is "kill the tree, VERIFY GONE,
//      spawn into the same worktree", and a caller that read "no exception" as "gone" would spawn a
//      second agent beside a wedged one in the same worktree — where they collide on the git index.
//   ⛔ Each label is killed on its own, addressed through its REGISTRY DESCRIPTOR (`backendRef`).
//      Killing by exclusion, or by a command line that merely mentions the worktree, once took out
//      the launcher itself: it has no fleet ancestor either.
//   ⛔ `--dry-run` prints the plan and touches nothing — including the registry.
//
// This ends the SESSION. It does not remove the worktree, save a WIP patch or delete a done flag:
// that whole gated teardown is the reclaimer's (`fleet watch`, `fleet down`), which refuses a tree
// that is dirty, unpushed or still installing. A kill here leaves the worktree exactly where it was.

import { readSession, listSessions } from '../../core/fleet.mjs'
import { envelope } from '../../cli.mjs'
import { CliError } from '../args.mjs'

export const name = 'kill'
export const usage = 'fleet kill <label…> [--dry-run]'
export const needsConfig = true
export const needsBackend = true

export async function run(ctx, args) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('kill.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is no registry to address a session through', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  // parseArgs strips the command word, so every positional here is a label.
  const labels = args.positionals.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean)
  if (!labels.length) throw new CliError('kill.no-target', 'fleet kill takes one or more session labels', 'fleet kill 3 — or `fleet down` to take the whole fleet')

  const dryRun = !!args.flags['dry-run']
  const results = labels.map(label => plan(ctx, { stateDir, label }))

  if (dryRun) {
    ctx.json(envelope(true, { dryRun: true, targets: results.length, plan: results }))
    for (const r of results) {
      ctx.log(r.addressable
        ? `would kill ${r.label} (${r.role}) — shimPid=${r.shimPid ?? 'unknown'} pgid=${r.pgid ?? 'unknown'} worktree=${r.worktree ?? 'unknown'}; the worktree is left in place`
        : `cannot kill ${r.label}: ${r.reason}`)
    }
    return 0
  }

  const done = results.map(r => (r.addressable ? kill(ctx, r) : { ...r, ok: false, killed: [], survivors: [], alreadyGone: false }))
  const failed = done.filter(r => !r.ok)

  ctx.json(envelope(!failed.length, {
    targets: done.length,
    killed: done.filter(r => r.ok).length,
    results: done,
    ...(failed.length
      ? {
        error: {
          code: done.some(r => r.survivors && r.survivors.length) ? 'kill.survivors' : 'kill.failed',
          message: `${failed.length} of ${done.length} target(s) did not end: ${failed.map(r => `${r.label} (${r.reason})`).join(', ')}`,
          hint: 'a surviving process still holds the worktree and its port — re-run, and never conclude a session is gone from a kill that reported success without a re-query',
        },
      }
      : {}),
  }))

  for (const r of done) {
    if (r.ok) ctx.log(`${r.label}: ${r.alreadyGone ? 'already gone' : `killed ${r.killed.length} process(es)`}`)
    else ctx.log(`${r.label}: FAILED — ${r.reason}${r.survivors && r.survivors.length ? ` (survivors: ${r.survivors.join(', ')})` : ''}`)
  }
  return failed.length ? 1 : 0
}

/** What would happen to one label, decided from the registry alone — no process is touched here. */
function plan(ctx, { stateDir, label }) {
  let descriptor
  try {
    descriptor = readSession(label, { stateDir })
  } catch (e) {
    return { label, addressable: false, reason: `not a session label: ${e.message}` }
  }
  if (!descriptor) {
    const known = listSessions({ stateDir }).map(d => String(d.label)).join(', ')
    return { label, addressable: false, reason: `no registry entry${known ? ` (the registry holds ${known})` : ''}` }
  }
  if (!descriptor.backendRef) {
    return { label, addressable: false, reason: 'the descriptor carries no backendRef, so a live session cannot be addressed for a kill', role: descriptor.role, worktree: descriptor.worktree }
  }
  return {
    label,
    addressable: true,
    role: descriptor.role,
    worktree: descriptor.worktree ?? null,
    shimPid: descriptor.shimPid ?? null,
    pgid: descriptor.pgid ?? null,
    handle: {
      id: String(descriptor.label),
      role: descriptor.role,
      backendRef: descriptor.backendRef,
      shimPid: descriptor.shimPid,
      pgid: descriptor.pgid,
    },
  }
}

/** One kill. Never throws: one unknown handle must not abort the loop over the other labels. */
function kill(ctx, target) {
  const { handle, ...rest } = target
  let r
  try {
    r = ctx.backend.kill(handle)
  } catch (e) {
    return { ...rest, ok: false, killed: [], survivors: [], alreadyGone: false, reason: `the backend refused the handle: ${e.message}` }
  }
  const survivors = (r && r.survivors) || []
  const ok = !!(r && r.ok !== false) && survivors.length === 0
  return {
    ...rest,
    ok,
    killed: (r && r.killed) || [],
    survivors,
    alreadyGone: !!(r && r.alreadyGone),
    reason: ok ? null : `${survivors.length} process(es) survived the kill`,
  }
}
