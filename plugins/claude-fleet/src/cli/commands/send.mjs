// `fleet send <label…> <text|--file p>` (contract §7) — the launcher's one way to speak to a running
// session.
//
//   ⛔ A SHORT WRITE IS A FAILURE, loudly, per target. Console-input injection writes only what fits
//      in the target's input buffer and then submits the fragment: a ~700-character nudge once
//      arrived as 62 characters and the session acted on those. The backend returns what it
//      delivered; this command believes that count and nothing else — a half-delivered instruction
//      is worse than none.
//   ⛔ A session is addressed through its REGISTRY DESCRIPTOR (`backendRef`), never by searching
//      command lines. When list, send and kill each resolved their own set, a nudge once landed in
//      the wrong tab.
//   ⛔ One dead label must not abort the fan-out: every target is attempted, every result reported,
//      and the exit code is non-zero if any of them fell short.
//
// Long or multi-line text is the backend's business (it writes the message to a file and injects a
// pointer), because only the backend knows its own buffer — but `--file` is the form that cannot
// truncate on ANY backend, which is why the launcher's blocked-flag reply uses it.

import fs from 'node:fs'
import path from 'node:path'

import { readSession, listSessions } from '../../core/fleet.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'send'
export const usage = 'fleet send <label…> <text|--file p>'
export const needsConfig = true
export const needsBackend = true

/**
 * PURE. Split the positionals into targets and the message.
 *
 * ⛔ With no `--file`, the LAST positional is the text and everything before it is a label. It is a
 * positional rule rather than a guess about which words look like labels: a message that happens to
 * read like a label would otherwise become a target nobody meant to nudge.
 *
 * `positionals` is what parseArgs returns: everything AFTER the command word, so `fleet send 3 4 x`
 * arrives as `['3', '4', 'x']` and the first token is a LABEL, not a subcommand.
 * @returns {{labels: string[], text: string|null}}
 */
export function splitTargets(positionals, hasFile) {
  const rest = positionals.slice()
  if (hasFile) return { labels: rest, text: null }
  if (rest.length < 2) return { labels: rest, text: null }
  return { labels: rest.slice(0, -1), text: rest[rest.length - 1] }
}

export async function run(ctx, args) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('send.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is no registry to address a session through', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }

  const filePath = stringFlag(args.flags, 'file', null)
  const { labels, text: inline } = splitTargets(args.positionals, filePath !== null)
  if (!labels.length) {
    throw new CliError('send.no-target', 'fleet send takes one or more session labels', filePath ? 'fleet send 3 4 --file <path>' : 'fleet send 3 "the slot is free now, retry" — the last argument is the message')
  }

  let text = inline
  if (filePath !== null) {
    try {
      text = fs.readFileSync(path.resolve(ctx.cwd, filePath), 'utf8')
    } catch (e) {
      throw new CliError('send.file-unreadable', `--file ${filePath}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`, 'write the message to a file under the state dir first (`fleet config resolve --json` prints paths.stateDir)')
    }
  }
  if (text === null || text === '') {
    throw new CliError('send.no-message', 'there is no message to send', 'pass the text as the last argument, or --file <path>; an empty nudge wakes a session with nothing to act on')
  }

  const results = []
  for (const label of labels) {
    results.push(sendOne(ctx, { stateDir, label: String(label), text }))
  }

  const sent = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)
  ctx.json(envelope(sent === results.length, {
    targets: results.length,
    sent,
    results,
    ...(failed.length
      ? {
        error: {
          code: failed.some(f => f.truncated) ? 'send.short-write' : 'send.failed',
          message: `${failed.length} of ${results.length} target(s) did not receive the message: ${failed.map(f => `${f.label} (${f.reason})`).join(', ')}`,
          hint: 'a delivery that came up short was NOT read — write the message to a file and `fleet send <label> --file <path>`, then confirm the session moved (its state flips to working) before believing it landed',
        },
      }
      : {}),
  }))

  for (const r of results) {
    ctx.log(r.ok
      ? `${r.label}: delivered ${r.deliveredChars}/${r.requestedChars} chars`
      : `${r.label}: FAILED (${r.reason}) — delivered ${r.deliveredChars}/${r.requestedChars} chars`)
  }
  if (!failed.length) {
    // The bytes were written; that is not the same as read. The proof is the session moving.
    ctx.log('delivery is bytes written, never bytes read — confirm the session flips to working within a minute, or its turn is dead and it needs `fleet relaunch`')
  }
  return failed.length ? 1 : 0
}

/** One target. Never throws: a fan-out that aborted on the first dead label left the rest unspoken to. */
function sendOne(ctx, { stateDir, label, text }) {
  const requestedChars = String(text).length
  const miss = (reason, hint = null) => ({ label, ok: false, requestedChars, deliveredChars: 0, truncated: false, reason, hint })

  let descriptor
  try {
    descriptor = readSession(label, { stateDir })
  } catch (e) {
    return miss(`not a session label: ${e.message}`)
  }
  if (!descriptor) {
    const known = listSessions({ stateDir }).map(d => String(d.label)).join(', ')
    return miss('no registry entry', known ? `the registry holds ${known}` : 'no sessions are registered in this state dir')
  }
  if (!descriptor.backendRef) {
    // A handle built from a label is addressing-by-label wearing a handle's clothes, and it is
    // exactly how a nudge meant for a dead session reaches its relaunched namesake.
    return miss('the descriptor carries no backendRef, so this session cannot be addressed', 'it was never spawned by a terminal backend, or the registry entry predates the spawn')
  }

  const handle = {
    id: String(descriptor.label),
    role: descriptor.role,
    backendRef: descriptor.backendRef,
    shimPid: descriptor.shimPid,
    pgid: descriptor.pgid,
  }
  let r
  try {
    r = ctx.backend.send(handle, text)
  } catch (e) {
    return miss(`the backend refused the handle: ${e.message}`)
  }
  const delivered = Number(r && r.delivered) || 0
  return {
    label,
    // ⛔ `ok` is the backend's own verdict AND a full count: a caller that read "no exception" as
    // delivery is the bug this whole file exists to prevent.
    ok: !!(r && r.ok) && !r.truncated && delivered === requestedChars,
    requestedChars,
    deliveredChars: delivered,
    truncated: !!(r && r.truncated),
    reason: r && r.ok && delivered === requestedChars ? null : (r && r.reason) || 'short-write',
    via: r && r.via ? r.via : null,
    file: r && r.file ? r.file : null,
  }
}
