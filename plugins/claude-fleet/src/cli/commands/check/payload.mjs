// Reading an adapter result off the command line: `--items-json <f|->`.
//
// One implementation, because two verbs consume the same op-26 payload — `worklist write` to build
// the denominator and `tick plan` to learn which boxes are already ticked. Two readers would
// eventually disagree about a shape, and the disagreement would show up as a mis-count nobody could
// place: the worklist would say 109 and the ticks would be planned against 108.

import fs from 'node:fs'
import path from 'node:path'

import { CliError } from '../../args.mjs'
import { parseWorkItems } from '../../../check/worklist.mjs'

/** Read a JSON argument from a file, or from stdin when it is `-`. */
export function readJsonArg(ctx, where, { flag = '--items-json' } = {}) {
  let text
  try {
    text = where === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(ctx.cwd, where), 'utf8')
  } catch (e) {
    throw new CliError('check.items-unreadable', `${flag} ${where}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`, `pipe the adapter result in with ${flag} -, or pass a readable JSON file`)
  }
  try {
    // The BOM a PowerShell redirect adds is stripped: JSON.parse refuses it, and the file looks
    // perfectly correct in an editor.
    return JSON.parse(String(text).replace(/^﻿/, ''))
  } catch (e) {
    throw new CliError('check.items-not-json', `${flag} ${where}: ${e.message}`, 'pass the adapter result unchanged — an object with a `body`, or an `items` array')
  }
}

/**
 * The work items in an op-26 payload. Two shapes are accepted because two adapters answer in two
 * ways: a body to parse (Linear, GitHub — a markdown checklist) and an item array (Jira subtasks,
 * Trello checklist items). Anything else returns null and is refused by the caller rather than
 * guessed at, because a guess here mis-counts every wave of the sweep.
 */
export function itemsFromPayload(payload) {
  if (payload && typeof payload.body === 'string') return parseWorkItems(payload.body)
  const arr = Array.isArray(payload) ? payload : payload && Array.isArray(payload.items) ? payload.items : null
  if (!arr) return null
  return arr
    .map(i => ({
      pr: String(i.pr ?? i.number ?? '').replace(/^#/, ''),
      title: String(i.title ?? i.name ?? ''),
      mergedAt: i.mergedAt ?? i.merged_at ?? null,
      done: !!(i.done ?? i.checked ?? i.completed),
      // planTicks anchors a tick on the item's own line, so a payload that carries one keeps it.
      raw: typeof i.raw === 'string' ? i.raw : undefined,
    }))
    .filter(i => /^\d+$/.test(i.pr))
}

/** Read and shape in one step, refusing a payload that is neither known shape. */
export function workItemsArg(ctx, where, { flag = '--items-json' } = {}) {
  const items = itemsFromPayload(readJsonArg(ctx, where, { flag }))
  if (items === null) {
    throw new CliError('check.items-shape', `${flag} carried neither a \`body\` to parse nor an \`items\` array`, 'pass the op-26 result unchanged — adapters answer with one shape or the other')
  }
  return items
}
