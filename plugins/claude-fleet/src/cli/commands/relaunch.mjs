// `fleet relaunch <label>` (contract §7) — kill this session's process tree, VERIFY it is gone, and
// spawn a fresh agent into the SAME worktree.
//
// It is its own command because of the worktree. A session whose turn died on a transient API error
// never runs again and never flags; the process is disposable but its worktree is not — the branch,
// the commits and the untracked helper files it made all live there, and a new worktree would abandon
// them. So nothing here creates, moves or cleans a worktree.
//
// ⛔ KILL FIRST, AND PROVE IT. Two agents in one worktree collide on the git index (`.git/index.lock`
// exists, `git add` fails, and the second agent's turn dies in a way that looks like the first one's
// bug). The backend's own kill result is checked AND a fresh process snapshot is searched for the
// exact argv token `--fleet-session=<label>`, because a pane can close while the process it started
// keeps running.
//
// ⛔ The previous run's `exit` record and death mark are dropped from the descriptor. Left in place
// they describe a finished session, and the reclaimer would remove the worktree out from under the
// agent that just replaced it.

import fs from 'node:fs'

import { envelope, errorPayload } from '../../cli.mjs'
import { CliError } from '../args.mjs'
import { buildSpawnSpec, markedSessions, safeSnapshot, stampBackendRef } from './up.mjs'
import { readSession, sessionPath } from '../../core/fleet.mjs'
import { buildPrompt } from '../../core/prompts.mjs'

export const name = 'relaunch'
export const usage = 'fleet relaunch <label>'
export const needsConfig = true
export const needsBackend = true

/** The fields a previous run left behind that must not survive into the new one. */
export const STALE_FIELDS = Object.freeze(['exit', 'deadAt', 'liveness', 'shimPid', 'agentPid', 'pgid', 'startedAt'])

/**
 * Every pid still carrying `--fleet-session=<label>`, from a FRESH snapshot (never the cached one:
 * the kill just happened, and a reading from before it proves nothing).
 *
 * ⛔ Scoped to THIS fleet by `stateDir` (up.markedSessions). Labels are bare numbers and contract §3
 * gives every repo on a machine its own state dir, so a second checkout routinely has a session
 * labelled "1": a machine-wide match makes `fleet relaunch 1` here refuse over a pid belonging to
 * another fleet — one the operator cannot kill without stopping unrelated work. Marked processes that
 * name no path under this state dir come back as `foreign`, to be reported rather than acted on.
 * @returns {{degraded: boolean, pids: number[], foreign: number[]}}
 */
export function markerSurvivors(label, { snapshot = null, stateDir = null } = {}) {
  const snap = snapshot || safeSnapshot().snapshot
  // ⛔ A listing that is empty — or that failed outright — is never an empty machine. It cannot prove
  // the old session is gone, so it is reported as degraded and the caller decides; here, by refusing
  // to spawn beside a process it could not rule out.
  const r = markedSessions(snap, { stateDir, labels: [String(label)] })
  const sorted = list => list.map(x => x.pid).sort((a, b) => a - b)
  if (r.degraded) return { degraded: true, pids: [], foreign: [] }
  return { degraded: false, pids: sorted(r.survivors), foreign: sorted(r.foreign) }
}

export async function run(ctx, args) {
  const label = args.positionals[0]
  if (!label) throw new CliError('relaunch.no-label', 'fleet relaunch needs the label of the session to replace', usage)

  const config = ctx.config
  const stateDir = config.paths.stateDir
  const descriptor = readSession(label, { stateDir })
  if (!descriptor) {
    // Without a descriptor there is no worktree, no role and no handle — and guessing any of them is
    // how a relaunch lands on another session's tree.
    ctx.json(errorPayload('relaunch.no-session', `no session "${label}" is in the registry, so there is nothing to relaunch`, 'run `fleet status` for the labels this fleet knows; a session that was never registered is started with `fleet up`'))
    ctx.log(`fleet relaunch: no session "${label}" in the registry`)
    return 1
  }
  if (!fs.existsSync(descriptor.worktree)) {
    // The whole point of this command is the worktree; without it, a fresh session belongs on a fresh
    // label rather than on this one's branchless, contentless remains.
    ctx.json(errorPayload('relaunch.no-worktree', `session ${label}'s worktree ${descriptor.worktree} is gone, so there is nothing to relaunch into`, 'launch a new session with `fleet up --add 1`; a relaunch exists to keep a worktree\'s branch and untracked files, and there are none left here'))
    ctx.log(`fleet relaunch: ${descriptor.worktree} is gone`)
    return 1
  }

  // ---- kill, then prove ---------------------------------------------------------------------------
  let killResult = { ok: true, killed: [], alreadyGone: true, survivors: [] }
  let killError = null
  if (descriptor.backendRef) {
    try {
      killResult = ctx.backend.kill({ id: String(label), role: descriptor.role, backendRef: descriptor.backendRef })
    } catch (e) {
      // A ref this backend never minted (another fleet's, or a previous generation's) is not "already
      // gone": it is a session this command cannot speak for, and spawning beside it is the collision.
      killError = e && e.message ? e.message : String(e)
    }
  }
  const proof = markerSurvivors(label, { stateDir })
  const survivors = [...new Set([...(killResult.survivors || []), ...proof.pids])]
  // Named, never acted on: another checkout's session can carry this label too, and refusing over its
  // pid would send the operator to kill work that has nothing to do with this fleet.
  if (proof.foreign.length) ctx.log(`fleet relaunch: ${label}: pid(s) ${proof.foreign.join(', ')} carry --fleet-session=${label} for a different state directory, so they are another fleet's and were ignored here`)

  if (killError || survivors.length || proof.degraded) {
    const why = killError
      ? `the backend could not kill it: ${killError}`
      : proof.degraded
        ? 'the process snapshot came back empty, so the old session could not be proven gone — a failed listing is never proof that nothing is running'
        : `${survivors.length} process(es) still carry --fleet-session=${label} (pids ${survivors.join(', ')})`
    ctx.json(errorPayload('relaunch.still-alive', `session ${label} was not verifiably gone, so no second agent was started: ${why}`, 'kill the remaining pids yourself and run `fleet relaunch` again — two agents in one worktree collide on the git index, and the damage looks like the first agent\'s bug', { survivors, killed: killResult.killed || [] }))
    ctx.log(`fleet relaunch: ${label}: ${why}`)
    return 1
  }

  // ---- spawn into the SAME worktree ---------------------------------------------------------------
  const sessionFile = sessionPath(stateDir, label)
  const spec = buildSpawnSpec({ config, descriptor, sessionFile })
  const handle = ctx.backend.spawn(spec)
  const stamped = stampBackendRef(label, handle, { stateDir, base: descriptor, drop: STALE_FIELDS })

  // The seed prompt again: a fresh agent in this worktree knows nothing, and its playbook is read from
  // disk rather than pasted, so the copy it follows is the current one.
  const prompt = buildPrompt(config, stamped, { sessionFile })
  const sent = ctx.backend.send(handle, prompt)
  if (!sent.ok) ctx.log(`fleet relaunch: ${label}: the seed prompt was delivered as ${sent.delivered} of ${sent.requested} characters (${sent.reason || 'short write'}) — send it again before trusting the session`)

  ctx.json(envelope(true, {
    label: String(label),
    worktree: stamped.worktree,
    branch: stamped.branch || null,
    issue: stamped.issue || null,
    killed: killResult.killed || [],
    alreadyGone: !!killResult.alreadyGone,
    backendRef: stamped.backendRef,
    marker: `--fleet-session=${label}`,
    promptDelivered: sent.ok,
  }))
  ctx.log(`fleet relaunch: ${label} replaced in ${stamped.worktree}${stamped.branch ? ` (branch ${stamped.branch})` : ''}`)
  return 0
}
