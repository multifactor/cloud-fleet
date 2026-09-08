// `fleet trackers list|show <id>` — the adapters this installation can offer.
//
// The first-run wizard is the caller that matters. It is the conversational half of `/fleet`, it
// never writes config itself, and it cannot see the adapter files — so "which trackers do you
// support, and what does this one need from you?" has to be a command. `playbooks/launcher.md` names
// both verbs, and `mcp.install` rendered verbatim from `show` is how adding a tracker adds its own
// connection instructions without anyone editing the wizard.
//
// ⛔ `needsConfig: false`. The wizard runs this BEFORE a repo is configured — that is the whole
//    point — and a listing that required a valid config could never answer the question that leads
//    to one.

import fs from 'node:fs'
import path from 'node:path'

import { CliError, stringFlag } from '../args.mjs'
import { envelope } from '../../cli.mjs'
import { listAdapters, loadAdapter, validateAdapter, OP_COUNT } from '../../trackers/registry.mjs'

export const name = 'trackers'
export const usage = 'fleet trackers list | show <id>'
export const needsConfig = false
export const needsBackend = false

/**
 * A project overlay at `.fleet/trackers/` shadows a bundled adapter of the same id.
 *
 * ⛔ Found by walking up from the cwd, NOT from `ctx.paths` — which is null here, because this
 *    command declares `needsConfig: false`. Reading the overlay out of the resolved config would mean
 *    a project adapter is invisible to the wizard until the repo is configured, and configuring
 *    against that adapter is precisely what the wizard is trying to do.
 */
function dirs(ctx) {
  if (ctx.paths && ctx.paths.projectTrackersDir) return { projectDir: ctx.paths.projectTrackersDir }
  let dir = path.resolve(ctx.cwd)
  for (;;) {
    const candidate = path.join(dir, '.fleet', 'trackers')
    if (fs.existsSync(candidate)) return { projectDir: candidate }
    // Stop at the repo root, then at the filesystem root: an overlay above the repo belongs to
    // another repo, and picking it up would offer one project's adapters inside another.
    if (fs.existsSync(path.join(dir, '.git'))) return {}
    const up = path.dirname(dir)
    if (up === dir) return {}
    dir = up
  }
}

/** The front-matter fields a chooser needs — never the whole body, which is a thousand lines of prose. */
function summarise(a) {
  const f = a.front || {}
  return {
    id: a.id,
    name: f.name || a.id,
    file: a.file,
    modes: f.mcp && Array.isArray(f.mcp.toolPrefixes) ? f.mcp.toolPrefixes : [],
    scope: f.scope ? { label: f.scope.label || null, required: !!f.scope.required } : null,
    issueKey: f.issueKey ? { pattern: f.issueKey.pattern, example: f.issueKey.example || null } : null,
    capabilities: f.capabilities || {},
  }
}

export async function run(ctx, args) {
  const sub = args.sub
  if (sub !== 'list' && sub !== 'show') {
    throw new CliError('trackers.verb', sub ? `unknown verb "fleet trackers ${sub}"` : 'fleet trackers takes a verb', 'one of list, show <id>')
  }

  if (sub === 'list') {
    const rows = []
    for (const id of listAdapters(dirs(ctx))) {
      // A malformed community adapter is LISTED with its error, not omitted. Omitting it answers
      // "that tracker is not supported" to someone who is looking at the file they just wrote.
      try {
        const loaded = loadAdapter(id, dirs(ctx))
        if (!loaded) { rows.push({ id, name: id, file: null, ok: false, problems: ['the file disappeared between listing and reading'] }); continue }
        const v = validateAdapter(loaded, { expectedId: id })
        rows.push({ ...summarise(loaded), ok: v.ok, problems: v.errors, warnings: v.warnings })
      } catch (e) {
        rows.push({ id, name: id, file: null, ok: false, problems: [e.message] })
      }
    }
    if (ctx.jsonMode) ctx.json(envelope(true, { trackers: rows, ops: OP_COUNT }))
    else for (const r of rows) ctx.log(`${r.id.padEnd(10)} ${r.ok ? '  ' : 'x '}${r.name}${r.problems && r.problems.length ? `  — ${r.problems[0]}` : ''}`)
    return 0
  }

  const id = args.positionals[1] || stringFlag(args.flags, 'label', null)
  if (!id) throw new CliError('trackers.no-id', 'fleet trackers show takes the adapter id', 'the ids are listed by `fleet trackers list`')
  let loaded
  try {
    loaded = loadAdapter(id, dirs(ctx))
  } catch (e) {
    throw new CliError('trackers.unreadable', `adapter "${id}": ${e.message}`, 'run `fleet trackers list`; a project adapter goes in .fleet/trackers/<id>.md', 1)
  }
  if (!loaded) {
    throw new CliError('trackers.unknown', `no adapter "${id}"`, 'run `fleet trackers list`; a project adapter goes in .fleet/trackers/<id>.md', 1)
  }
  const v = validateAdapter(loaded, { expectedId: id })
  const problems = v.errors
  const front = loaded.front || {}
  const body = {
    ...summarise(loaded),
    ok: v.ok,
    problems,
    warnings: v.warnings,
    // Rendered verbatim by the wizard: adding a tracker adds its own connection instructions, and a
    // paraphrase of them is a paraphrase of somebody's install docs.
    install: (front.mcp && front.mcp.install) || [],
    states: front.states || {},
    config: front.config || [],
    docs: front.docs || null,
    sections: Object.keys(loaded.sections || {}),
  }
  if (ctx.jsonMode) ctx.json(envelope(v.ok, problems.length ? { ...body, error: { code: 'trackers.invalid', message: problems.join('; '), hint: 'a malformed adapter fails CI, not someone\'s fleet — fix it before configuring against it' } } : body))
  else {
    ctx.log(`${body.id}  ${body.name}${body.ok ? '' : '  (INVALID)'}`)
    ctx.log(`  ${body.file}`)
    if (body.issueKey) ctx.log(`  issue key: ${body.issueKey.pattern}${body.issueKey.example ? ` (e.g. ${body.issueKey.example})` : ''}`)
    if (body.scope) ctx.log(`  scope: ${body.scope.label || '(none)'}${body.scope.required ? ' — required' : ''}`)
    if (body.install.length) {
      ctx.log('  to connect:')
      // An install step is `{label, command?, instructions?}` — printed as its parts, never
      // stringified: `[object Object]` in a wizard's own instructions is worse than no instructions.
      for (const step of body.install) {
        ctx.log(`    ${step.label || '(step)'}`)
        if (step.command) ctx.log(`      $ ${step.command}`)
        if (step.instructions) ctx.log(`      ${step.instructions}`)
      }
    }
    if (body.docs) ctx.log(`  docs: ${body.docs}`)
    for (const p of problems) ctx.log(`  PROBLEM: ${p}`)
  }
  return problems.length ? 1 : 0
}
