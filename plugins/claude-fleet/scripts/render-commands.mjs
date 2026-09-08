#!/usr/bin/env node
// Render commands/fleet.md and commands/fleet-check.md from the `command:` front matter of their
// playbooks.
//
// Why generated: the private original kept its slash-command doc by hand, and it drifted until it
// contradicted the playbook it launched in two places — it told the session to ask a question the
// playbook forbade, and it hardcoded a default the playbook said to derive. Two copies of one
// contract is how that happens. The playbook is the source; this file is a projection of it; the
// golden test fails CI if the committed projection is stale.
//
// Both playbooks are tolerated in either front-matter shape (a usage block string or a list; flags
// as {flag, help} or {name, values, default, description}).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontMatter } from '../src/sys/yaml.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

export const COMMANDS = [
  { playbook: 'playbooks/launcher.md', out: 'commands/fleet.md' },
  { playbook: 'playbooks/check.md', out: 'commands/fleet-check.md' },
]

const asList = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v : String(v).split('\n').map(s => s.replace(/\s+$/, '')).filter(Boolean))

/** PURE. Normalise either front-matter shape into one. */
export function normalizeCommand(cmd, playbookRel) {
  if (!cmd || !cmd.name) throw new Error(`${playbookRel}: front matter has no command.name`)
  const flags = (cmd.flags || []).map(f => ({
    flag: f.flag || (f.values ? `${f.name} ${f.values}` : f.name),
    help: [f.help || f.description, f.default ? `Default: ${f.default}` : null].filter(Boolean).join(' '),
  }))
  const args = Array.isArray(cmd.args)
    ? cmd.args.map(a => ({ name: a.name, help: a.description || a.help || '' }))
    : cmd.args ? [{ name: String(cmd.args), help: '' }] : []
  const preflight = typeof cmd.preflight === 'string'
    ? cmd.preflight
    : cmd.preflight ? [cmd.preflight.run ? `Run \`${cmd.preflight.run}\` first.` : null, cmd.preflight.onNotOk].filter(Boolean).join(' ') : null
  return {
    name: cmd.name,
    description: cmd.description || null,
    usage: asList(cmd.usage),
    args,
    flags,
    preflight,
    noArgs: cmd.noArgs || null,
    neverAsk: cmd.neverAsk === true,
    playbook: playbookRel,
  }
}

/** PURE. The slash-command markdown. */
export function renderCommand(c) {
  const lines = []
  lines.push('---')
  lines.push(`description: ${JSON.stringify(c.description || `Run the ${c.name} playbook.`)}`)
  lines.push('---')
  lines.push('')
  lines.push(`<!-- GENERATED from ${c.playbook} by scripts/render-commands.mjs — edit the playbook's \`command:\` front matter, then run \`npm run commands:render\`. A hand edit here is overwritten and fails test/generated-files.test.mjs. -->`)
  lines.push('')
  lines.push(`# /${c.name}`)
  lines.push('')
  if (c.preflight) {
    lines.push(`**Before anything else:** ${c.preflight}`)
    lines.push('')
  }
  if (c.neverAsk) {
    lines.push('**Never ask the operator a question.** Decide, act, and say what you chose in the final report. A question does not pause a run politely — it stops it dead for however long it takes someone to look.')
    lines.push('')
  }
  if (c.usage.length) {
    lines.push('## Usage')
    lines.push('')
    lines.push('```')
    for (const u of c.usage) lines.push(u)
    lines.push('```')
    lines.push('')
  }
  if (c.args.length) {
    lines.push('## Arguments')
    lines.push('')
    for (const a of c.args) lines.push(`- \`${a.name}\`${a.help ? ` — ${a.help}` : ''}`)
    lines.push('')
  }
  if (c.flags.length) {
    lines.push('## Flags')
    lines.push('')
    for (const f of c.flags) lines.push(`- \`${f.flag}\` — ${f.help}`)
    lines.push('')
  }
  if (c.noArgs) {
    lines.push('## With no arguments')
    lines.push('')
    lines.push(c.noArgs)
    lines.push('')
  }
  lines.push('## Then')
  lines.push('')
  lines.push(`Read \`\${CLAUDE_PLUGIN_ROOT}/${c.playbook}\` **in full** and follow it exactly as your operating playbook. The arguments the operator typed are: $ARGUMENTS`)
  lines.push('')
  return lines.join('\n')
}

export function renderAll(root = ROOT) {
  return COMMANDS.map(({ playbook, out }) => {
    const md = fs.readFileSync(path.join(root, playbook), 'utf8')
    const { data } = parseFrontMatter(md)
    if (!data || !data.command) throw new Error(`${playbook}: no \`command:\` front matter`)
    return { out, text: renderCommand(normalizeCommand(data.command, playbook)) }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { out, text } of renderAll()) {
    const file = path.join(ROOT, out)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    console.log(`wrote ${out}`)
  }
}
