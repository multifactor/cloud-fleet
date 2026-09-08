// `fleet outbox add|list|ack` (contract §7) — the queue of tracker operations a session could not
// perform: its tools were down, it runs in `tracker.mode: manual`, or the op is launcher-only
// (op-18 ensureLabel, op-27 tickWorkItem). The launcher drains it every turn.
//
//   ⛔ Everything is validated at ENQUEUE, by src/trackers/outbox.mjs, and a rejection is reported
//      as a SENTENCE rather than a stack: the session that knows what the op meant is reading this
//      output right now, and at drain time it is gone.
//   ⛔ `ack` MOVES the entry to `applied/`; nothing here deletes one. The applied record is the only
//      evidence that an issue changed state for a reason.
//   ⛔ `--args` is JSON. A string or an array is a quoting accident (`--args '"text"'`), and an
//      adapter handed one would call its tracker tool with no arguments at all.

import fs from 'node:fs'

import { enqueue, list as listEntries, ack as ackEntry } from '../../trackers/outbox.mjs'
import { OP_NAMES } from '../../trackers/registry.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'outbox'
export const usage = 'fleet outbox add --op <op> --key <KEY> --args <json> [--verbatim] | list | ack <id> [--result <json>]'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['add', 'list', 'ack']

function stateDirOf(ctx) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('outbox.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is no outbox to queue into', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  return stateDir
}

/** The session that is queueing. The launcher has no label of its own and queues as "launcher". */
function requestedBy(env) {
  const label = String(env.FLEET_LABEL || '').trim()
  return label || 'launcher'
}

/**
 * Parse a JSON flag. `-` reads stdin, so a comment too long for one command line (or carrying a
 * quote the shell would eat) can still be queued VERBATIM — which is the whole point of op-11.
 */
function jsonFlag(ctx, args, flag, fallback) {
  const raw = stringFlag(args.flags, flag, null)
  if (raw === null) return fallback
  let text = raw
  if (raw === '-') {
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (e) {
      throw new CliError('outbox.stdin-unreadable', `--${flag} - could not read stdin: ${e.message}`, `pipe the JSON in, or pass it inline as --${flag} '{"…": "…"}'`)
    }
  }
  try {
    // The BOM a PowerShell redirect adds is stripped: JSON.parse refuses it, and the operator sees
    // "unexpected token" for a file that looks perfectly correct in an editor.
    return JSON.parse(String(text).replace(/^﻿/, ''))
  } catch (e) {
    throw new CliError('outbox.bad-json', `--${flag} is not valid JSON: ${e.message}`, `contract §6 gives each op's arguments, e.g. --${flag} '{"text":"…"}'`)
  }
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('outbox.unknown-subcommand', `fleet outbox takes one of ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  if (sub === 'add') return add(ctx, args)
  if (sub === 'list') return list(ctx)
  return ack(ctx, args)
}

// ---- add -------------------------------------------------------------------------------------

function add(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const op = stringFlag(args.flags, 'op', null)
  const key = stringFlag(args.flags, 'key', null)
  if (!op) throw new CliError('outbox.op-required', '--op is required', `an op number or name, e.g. --op op-11 or --op comment (contract §6 lists all ${OP_NAMES.length - 1})`)
  if (!key) throw new CliError('outbox.key-required', '--key is required', 'the issue key the op acts on — or, for an op-13 createIssue that has no key yet, the finding\'s fid')

  // Parsed BEFORE the guard below: unreadable JSON is a usage error the caller fixes by retyping
  // (exit 2), while an op the contract refuses is a runtime failure (exit 1) — and a caller that
  // cannot tell them apart retries the one that can only fail again.
  const opArgs = jsonFlag(ctx, args, 'args', {})
  let entry
  try {
    entry = enqueue({
      stateDir,
      op,
      key,
      args: opArgs,
      verbatim: !!args.flags.verbatim,
      requestedBy: requestedBy(ctx.env),
      at: ctx.now(),
    })
  } catch (e) {
    // The module's messages are already written for the person who typed the command; a stack here
    // would bury the sentence that says which field is wrong.
    throw new CliError('outbox.rejected', e.message, 'contract §6 names every op and its arguments; a verbatim op needs the text it posts', 1)
  }

  ctx.json(envelope(true, { entry }))
  ctx.log(`queued ${entry.id}: op-${entry.n} ${entry.op} on ${entry.key}${entry.verbatim ? ' (verbatim)' : ''}`)
  if (entry.verbatim) ctx.log('the launcher posts this text unchanged — not tidied, not summarised; the session\'s exact words are the record')
  return 0
}

// ---- list ------------------------------------------------------------------------------------

function list(ctx) {
  const stateDir = stateDirOf(ctx)
  const r = listEntries({ stateDir })

  ctx.json(envelope(true, { entries: r.entries, alreadyApplied: r.alreadyApplied, unreadable: r.unreadable, counts: { pending: r.entries.length, alreadyApplied: r.alreadyApplied.length, unreadable: r.unreadable.length } }))
  for (const e of r.entries) {
    ctx.log(`${e.id}  op-${e.n} ${e.op}  ${e.key}  by=${e.requestedBy}${e.verbatim ? '  verbatim' : ''}${e.refetchBeforeRetry ? '  REFETCH-FIRST (an earlier attempt failed)' : ''}`)
  }
  // An interrupted ack wrote the applied record and died before removing the pending file. The op
  // LANDED; handing it out as pending again is how a comment gets posted twice.
  for (const e of r.alreadyApplied) ctx.log(`${e.id}  already applied at ${e.appliedAt || 'an unrecorded time'} — ack it, do not re-apply`)
  for (const u of r.unreadable) ctx.log(`UNREADABLE ${u.id}: ${u.error} (${u.file}) — an entry nobody can read is a tracker op nobody applies`)
  if (!r.entries.length && !r.alreadyApplied.length && !r.unreadable.length) ctx.log('outbox is empty')
  return 0
}

// ---- ack -------------------------------------------------------------------------------------

function ack(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const id = args.positionals[1]
  if (!id) throw new CliError('outbox.ack-needs-id', 'fleet outbox ack takes the entry id', 'the id `fleet outbox list` printed, e.g. 20260314T100000123Z-3-000001')

  const result = jsonFlag(ctx, args, 'result', undefined)
  let record
  try {
    record = ackEntry(id, { stateDir, result, at: ctx.now() })
  } catch (e) {
    throw new CliError('outbox.ack-failed', e.message, 'ack only after re-reading the issue and seeing the change — a tracker write can fail quietly, and an ack is a claim that it landed. A failed apply stays queued instead.', 1)
  }

  ctx.json(envelope(true, { entry: record }))
  ctx.log(`acknowledged ${record.id}: op-${record.n} ${record.op} on ${record.key} → ${record.file || 'applied/'}`)
  return 0
}
