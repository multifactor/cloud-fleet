// The command table: ONE array, one line per command module.
//
// It is a list of FILES rather than a list of imports because commands land here from several
// authors at once, and a table that also needed an import line at the top is a table two people
// conflict on for one command. Adding `fleet frobnicate` is adding its path below and nothing else.
//
// Every module is loaded up front, not on dispatch: `--help` and the unknown-command hint both have
// to name every command, and a module that fails to satisfy the contract must fail at startup rather
// than at 3am on the one invocation that happens to reach it.

import { CliError } from './args.mjs'

/** One line per command module, resolved relative to this file. */
export const MODULE_FILES = Object.freeze([
  './commands/config.mjs',
  './commands/doctor.mjs',
  './commands/trackers.mjs',
  // the fleet lifecycle
  './commands/up.mjs',
  './commands/add.mjs',
  './commands/status.mjs',
  './commands/down.mjs',
  './commands/relaunch.mjs',
  './commands/attach.mjs',
  './commands/watch.mjs',
  // what a session calls
  './commands/pool.mjs',
  './commands/flag.mjs',
  './commands/outbox.mjs',
  './commands/ticket.mjs',
  './commands/session.mjs',
  './commands/slots.mjs',
  './commands/intake.mjs',
  './commands/send.mjs',
  './commands/kill.mjs',
  './commands/assets.mjs',
  // the sweep half — one module for the whole `check` namespace, like `config`
  './commands/check.mjs',
  './commands/cloud.mjs',
])

/** The shape src/cli.mjs dispatches against (contract §7 + the CLI's dispatch contract). */
const REQUIRED = Object.freeze({
  name: 'string',
  usage: 'string',
  needsConfig: 'boolean',
  needsBackend: 'boolean',
  run: 'function',
})

/**
 * PURE. Does this module satisfy the command contract?
 * @returns {string[]} the problems, empty when it is fine
 */
export function checkCommand(mod, file = '<module>') {
  const problems = []
  for (const [field, type] of Object.entries(REQUIRED)) {
    if (typeof mod?.[field] !== type) problems.push(`${file}: ${field} must be a ${type}, got ${typeof mod?.[field]}`)
  }
  if (mod?.sub !== undefined && typeof mod.sub !== 'string') problems.push(`${file}: sub must be a string when present, got ${typeof mod.sub}`)
  return problems
}

/**
 * The one warm cache, keyed by the file list it was built from.
 *
 * ⛔ Keyed, not bare. A cache that answers any `files` with whatever the first call loaded hands a
 * caller passing its own list somebody else's modules — so the `cli.bad-command-module` refusal below
 * becomes unreachable the moment any command has been dispatched in this process, which is every
 * process except a test that got there first.
 */
let cached = null

const cacheKey = files => JSON.stringify(files)

/**
 * Load every command module once per process.
 * @param {{files?: string[], reload?: boolean}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function loadCommands({ files = MODULE_FILES, reload = false } = {}) {
  const key = cacheKey(files)
  if (cached && !reload && cached.key === key) return cached.loaded
  const loaded = []
  const problems = []
  for (const file of files) {
    const mod = await import(new URL(file, import.meta.url).href)
    const bad = checkCommand(mod, file)
    if (bad.length) {
      problems.push(...bad)
      continue
    }
    loaded.push(mod)
  }
  if (problems.length) {
    throw new CliError('cli.bad-command-module', `a command module does not satisfy the command contract:\n  ${problems.join('\n  ')}`, 'a command module exports {name, sub?, usage, needsConfig, needsBackend, run}', 1)
  }
  cached = { key, loaded }
  return loaded
}

/**
 * PURE. The module that handles `command sub`.
 *
 * ⛔ A module declaring `sub` wins over the one that does not. `fleet check ledger append` and
 * `fleet check plan` are separate modules under one command name, and a first-match lookup would give
 * every one of them to whichever generic `check` module happened to be listed first.
 */
export function findCommand(commands, command, sub = null) {
  if (!command) return null
  const named = commands.filter(c => c.name === command)
  if (!named.length) return null
  return named.find(c => c.sub !== undefined && c.sub === sub) || named.find(c => c.sub === undefined) || null
}

/** PURE. Command names, deduplicated and sorted — what an unknown-command hint lists. */
export function commandNames(commands) {
  return [...new Set(commands.map(c => c.name))].sort()
}

/** PURE. One usage line per module, for `fleet --help`. */
export function usageLines(commands) {
  return commands
    .map(c => ({ name: c.name, sub: c.sub ?? null, usage: c.usage }))
    .sort((a, b) => (a.name === b.name ? String(a.sub).localeCompare(String(b.sub)) : a.name.localeCompare(b.name)))
}
