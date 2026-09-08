// Shared plumbing for the `fleet check` verbs: finding a sweep, reading its manifest, listing them.
//
// ⛔ Every verb takes its sweep from HERE, never by joining a path of its own. The sweep dir is
//    `<stateDir>/sweeps/<sweepId>/` and `sweepId` arrives from an operator's command line, so a verb
//    that joins it itself is a verb that will one day accept `../` and write outside the tree.
//    sweepLayout() asserts the id; this module is the only place the CLI calls it.

import fs from 'node:fs'
import path from 'node:path'

import { CliError } from '../../args.mjs'
import { sweepLayout, readManifest, assertSweepId } from '../../../check/manifest.mjs'
import { stateLayout } from '../../../config/paths.mjs'
import { readRows } from '../../../sys/tsv.mjs'

/** The platform whose separator this machine's paths use. */
export const platformOf = ctx => (ctx.facts && ctx.facts.machine && ctx.facts.machine.platform) || process.platform

/** The state dir, refused rather than defaulted: a sweep written to the wrong tree is invisible. */
export function stateDirOf(ctx) {
  const dir = ctx.config.paths.stateDir
  if (!dir) {
    throw new CliError('check.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is nowhere to keep a sweep', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  return dir
}

/** The layout of one sweep, with the id validated. Does not require the sweep to exist. */
export function layoutFor(ctx, sweepId) {
  try {
    return sweepLayout(stateDirOf(ctx), assertSweepId(sweepId), platformOf(ctx))
  } catch (e) {
    if (e instanceof CliError) throw e
    throw new CliError('check.bad-sweep-id', e.message, 'the sweep ids on this machine are listed by `fleet check status --json`')
  }
}

/**
 * The sweep an operator named, with its manifest. Refuses an id that has no manifest: every verb
 * downstream of `plan` reads resolved ids out of it, and a verb that invents an empty one would run
 * a second createProject against a sweep that already has a group.
 */
export function requireSweep(ctx, sweepId, { verb }) {
  const layout = layoutFor(ctx, sweepId)
  const manifest = readManifest(layout.dir)
  if (!manifest) {
    throw new CliError('check.no-such-sweep', `no sweep "${sweepId}" — ${layout.manifest} does not exist`, `\`fleet check status --json\` lists the sweeps on this machine; \`fleet check plan\` starts one. \`fleet check ${verb}\` never creates a sweep dir.`, 1)
  }
  return { layout, manifest }
}

/** The positional a verb requires, as a usage error rather than an undefined read three frames down. */
export function positional(args, index, { verb, what }) {
  const v = args.positionals[index]
  if (!v) throw new CliError(`check.${verb}-needs-${what}`, `fleet check ${verb} takes the ${what} to act on`, `for example \`fleet check ${verb} <${what}>\``)
  return String(v)
}

/**
 * Every sweep on this machine, newest first, as `status` reports them.
 *
 * A directory with no readable manifest is listed as damaged rather than skipped: a sweep whose
 * manifest failed to parse is exactly the one an operator is looking for when they run `status`.
 */
export function listSweeps(ctx) {
  const dir = stateLayout(stateDirOf(ctx), platformOf(ctx)).sweeps
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const id of names.sort()) {
    const layout = sweepLayout(stateDirOf(ctx), id, platformOf(ctx))
    try {
      const m = readManifest(layout.dir)
      if (!m) continue
      out.push({ sweepId: id, status: m.status, mode: m.mode, input: m.input, counts: m.counts, audit: m.audit, updatedAt: m.updatedAt || m.createdAt, dir: layout.dir, damaged: null })
    } catch (e) {
      out.push({ sweepId: id, status: null, mode: null, input: null, counts: null, audit: null, updatedAt: null, dir: layout.dir, damaged: e.message })
    }
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

/**
 * The `filed/<slice>.tsv` rows, grouped by slice. `fid → key → url → pr → priority → a11y`.
 *
 * ⛔ ONE reader. Three verbs join on these columns (the four counts, the gate's coverage check, the
 *    tracker reconcile) and three copies of the column order is how two of them end up joining on
 *    different fields and agreeing anyway.
 */
export function filedBySlice(layout) {
  let files
  try {
    files = fs.readdirSync(layout.filed).filter(f => f.endsWith('.tsv')).sort()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return []
  }
  return files.map(f => ({
    slice: f.replace(/\.tsv$/, ''),
    rows: readRows(path.join(layout.filed, f)).map(r => ({ fid: r[0], key: r[1], url: r[2], pr: r[3], priority: r[4], a11y: r[5] })),
  }))
}

/** Every filed row of the sweep, flattened. */
export function filedRows(layout) {
  return filedBySlice(layout).flatMap(s => s.rows)
}
