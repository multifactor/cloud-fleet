// `fleet ticket cache|show|list` (contract §7) — the offline ticket cache, written by the launcher
// from an op-2 `getIssue` result BEFORE a session is spawned and named in the session descriptor as
// `ticketFile`.
//
// It exists because tracker tools can race a fleet-launch burst and never register in a session, and
// a session that cannot read its own ticket stalls on its first turn. So:
//
//   ⛔ The cache is written HERE or nowhere, and a cache that is wrong is worse than none — the
//      description is stored byte for byte, because a session works from that text as its
//      specification and a refuted prescription patched into the body must reach the next session
//      exactly as written.
//   ⛔ `--issue` is the authority on the key. A payload whose own `key` disagrees is refused rather
//      than reconciled: a cache written under the other spelling is a ticket no session ever finds,
//      and the session flags `tracker` over a file the launcher can see on disk.
//   ⛔ Labels travel with the ticket. `fleet intake check` gates on them, and op-2 carries none — so
//      a feeder that has them must pass them, and one that does not leaves `labels: null` ("not
//      supplied"), never `[]` ("the issue has none").

import fs from 'node:fs'
import path from 'node:path'

import { cacheTicket, readTicket, listTickets } from '../../trackers/tickets.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'ticket'
export const usage = 'fleet ticket cache --issue <KEY> --from-json <f|-> | show <KEY> | list'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['cache', 'show', 'list']

function stateDirOf(ctx) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('ticket.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is nowhere to cache a ticket', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  return stateDir
}

/** Read the `--from-json` payload from a file, or from stdin when it is `-` (the launcher pipes op-2). */
function readFromJson(ctx, where) {
  let text
  if (where === '-') {
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (e) {
      throw new CliError('ticket.stdin-unreadable', `--from-json - could not read stdin: ${e.message}`, 'pipe the op-2 result in, or pass a file path instead of -')
    }
  } else {
    try {
      text = fs.readFileSync(path.resolve(ctx.cwd, where), 'utf8')
    } catch (e) {
      throw new CliError('ticket.payload-unreadable', `--from-json ${where}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`, 'pass a readable JSON file, or - to read it from stdin')
    }
  }
  try {
    // The BOM a PowerShell redirect adds is stripped: JSON.parse refuses it, and the operator sees
    // "unexpected token" for a file that looks perfectly correct in an editor.
    return JSON.parse(String(text).replace(/^﻿/, ''))
  } catch (e) {
    throw new CliError('ticket.payload-invalid', `the --from-json payload is not valid JSON: ${e.message}`, 'it is one op-2 getIssue result: {key, id, title, description, url, status, priority, parentId, suggestedBranch?} plus labels[] when the feeder has them')
  }
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('ticket.unknown-subcommand', `fleet ticket takes one of ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  if (sub === 'cache') return cache(ctx, args)
  if (sub === 'show') return show(ctx, args)
  return list(ctx)
}

// ---- cache -----------------------------------------------------------------------------------

function cache(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const key = stringFlag(args.flags, 'issue', null)
  const from = stringFlag(args.flags, 'from-json', null)
  if (!key) throw new CliError('ticket.issue-required', '--issue is required', 'fleet ticket cache --issue ABC-1234 --from-json -')
  if (!from) throw new CliError('ticket.from-json-required', '--from-json is required', 'pipe the op-2 getIssue result: fleet ticket cache --issue ABC-1234 --from-json -')

  const payload = readFromJson(ctx, from)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CliError('ticket.payload-not-an-object', 'the --from-json payload must be a JSON object — one op-2 getIssue result', 'for example {"key":"ABC-1234","title":"…","description":"…"}')
  }
  // The envelope a `fleet … --json` payload arrives in is unwrapped, so an operator can pipe one
  // command's output straight into this one without hand-editing the object out of it.
  const body = payload.issue && typeof payload.issue === 'object' && !Array.isArray(payload.issue) ? payload.issue : payload
  if (body.key !== undefined && body.key !== null && String(body.key) !== key) {
    throw new CliError(
      'ticket.key-mismatch',
      `--issue ${key} but the payload carries key ${JSON.stringify(body.key)}`,
      'the file is named after the key, and a cache under the wrong name is a ticket the session never finds — pass the key the payload is really about',
    )
  }

  let record
  try {
    // ⛔ The caller's own values are pinned AFTER the payload, never before it: cacheTicket
    // destructures `stateDir` out of this one object, so a payload carrying a `stateDir` field —
    // and the payload is whatever the tracker tool returned — would redirect both writes out of the
    // state directory, and the session would find nothing where its descriptor points. Every other
    // field is filtered by ticketRecord's own destructuring; these three are the ones this command
    // is the authority on.
    record = cacheTicket({ ...body, stateDir, key, at: ctx.now() })
  } catch (e) {
    throw new CliError('ticket.rejected', e.message, 'the record is what a session works from: it needs a key that is a plain filename, a title, and a description that is a string', 1)
  }

  ctx.json(envelope(true, { ticket: record, file: record.file, mdFile: record.mdFile }))
  ctx.log(`cached ${record.key} → ${record.file}`)
  if (record.labels === null) {
    ctx.log('note: the payload carried no labels, so this cache cannot answer the intake gate (op-2 carries none) — pass labels[] when the feeder has them')
  }
  return 0
}

// ---- show ------------------------------------------------------------------------------------

function show(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const key = args.positionals[1]
  if (!key) throw new CliError('ticket.show-needs-key', 'fleet ticket show takes the issue key', 'fleet ticket show ABC-1234')

  let record
  try {
    record = readTicket(String(key), { stateDir })
  } catch (e) {
    // The module throws only for a cache that IS on disk and cannot be read — which is not "absent",
    // and must not send a session off to flag `tracker` over a file the launcher can see.
    throw new CliError('ticket.corrupt', e.message, 'the cache is damaged: re-run `fleet ticket cache --issue <KEY> --from-json -` for this key', 1)
  }
  if (!record) {
    ctx.json(envelope(false, { key: String(key), ticket: null, error: { code: 'ticket.not-cached', message: `no cached ticket for ${key}`, hint: 'the launcher caches every assigned issue before spawning; read the tracker directly, or ask for it to be cached' } }))
    ctx.log(`no cached ticket for ${key}`)
    return 1
  }

  let markdown = null
  try {
    markdown = fs.readFileSync(record.mdFile, 'utf8')
  } catch { /* the readable twin is a convenience; the record itself is the cache */ }

  ctx.json(envelope(true, { ticket: record, markdown }))
  ctx.log(markdown || `${record.key} — ${record.title}\n\n${record.description}`)
  return 0
}

// ---- list ------------------------------------------------------------------------------------

function list(ctx) {
  const stateDir = stateDirOf(ctx)
  const r = listTickets({ stateDir })
  ctx.json(envelope(true, { tickets: r.tickets, unreadable: r.unreadable, counts: { tickets: r.tickets.length, unreadable: r.unreadable.length } }))
  for (const t of r.tickets) ctx.log(`${t.key}  ${t.title}${t.status ? `  [${t.status}]` : ''}${t.labels && t.labels.length ? `  labels: ${t.labels.join(', ')}` : ''}`)
  // Reported, never skipped: a launcher that believes a ticket is cached spawns a session that finds
  // nothing to read.
  for (const u of r.unreadable) ctx.log(`UNREADABLE ${u.key}: ${u.error} (${u.file})`)
  if (!r.tickets.length && !r.unreadable.length) ctx.log('no tickets cached')
  return 0
}
