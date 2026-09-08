// The CLI entry point: parse, load what the command declares it needs, dispatch, and print exactly
// one thing.
//
// ⛔ `main()` RETURNS an exit code and never calls `process.exit`. The launcher runs these commands
// in-process in tests and out of process in life, and a module that exits takes the test runner —
// and any caller that wanted to read the payload — down with it. `bin/claude-fleet.mjs` is the only
// file allowed to turn the returned number into an exit.
//
// ⛔ Under `--json`, stdout carries EXACTLY ONE object and nothing else. The launcher parses stdout;
// one stray progress line makes the payload unparseable and a working fleet reads as a broken tool.
// Every human line therefore goes to stderr in JSON mode, and `ctx.log()` is the only way to write
// one — a command that reaches for `console.log` breaks the contract silently.
//
// Everything the process can touch arrives through `io`, so the whole surface is testable: a fake
// terminal backend, a temp cwd, a captured stdout, an injected clock.

import fs from 'node:fs'
import process from 'node:process'

import { parseArgs, CliError } from './cli/args.mjs'
import { loadCommands, findCommand, commandNames, usageLines } from './cli/registry.mjs'
import { loadConfig } from './config/load.mjs'
import { selectBackend } from './backends/index.mjs'
import { loadAdapter } from './trackers/registry.mjs'

export { CliError }

/** The payload version every `--json` object carries (contract §7). */
export const PAYLOAD_VERSION = 1

/**
 * A sink may be a stream (the real process) or a plain function (a test collecting lines). Accepting
 * both is what lets the same code path be asserted on without a subprocess — and a subprocess is
 * exactly where a stray stdout line hides.
 */
function writerFor(sink, what) {
  if (typeof sink === 'function') return sink
  if (sink && typeof sink.write === 'function') return s => { sink.write(s) }
  throw new TypeError(`io.${what} must be a writable stream or a function`)
}

/**
 * The seam between the tracker registry and the config system.
 *
 * ⛔ The registry answers with the parsed RECORD (`{id, file, front, body, sections}`) while
 * config/derive.mjs and config/validate.mjs read the front matter directly (`adapter.states`,
 * `adapter.scope`, `adapter.config`). Handing the record straight through leaves every
 * `tracker.states.*` underived, so a fully configured repo reports `needs-tracker` forever and the
 * launcher re-runs the wizard on every launch. The flattening belongs here, at the one seam, rather
 * than in either module.
 */
function adapterLoader(id, ctx) {
  const parsed = loadAdapter(id, { projectDir: ctx.projectTrackersDir })
  if (!parsed) return null
  return { ...parsed.front, id: parsed.front.id || id, file: parsed.file, sections: parsed.sections, front: parsed.front }
}

/** The plugin's own version, for `--version`. */
function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * `{"ok": …, "v": 1, …}` — in that order, because the contract states the first two keys and a
 * launcher reading a prefix must find them where it was promised.
 */
export function envelope(ok, body = {}) {
  return { ok: !!ok, v: PAYLOAD_VERSION, ...body }
}

/** The one error shape (contract §7): `{ok:false, v:1, error:{code, message, hint}}`. */
export function errorPayload(code, message, hint = null, extra = {}) {
  return envelope(false, { ...extra, error: { code, message, hint } })
}

/**
 * Run one command.
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{stdout?, stderr?, env?: object, cwd?: string, backend?: object|null, now?: () => number}} io
 * @returns {Promise<number>} the exit code — 0 success, 1 runtime failure, 2 usage error
 */
export async function main(argv = [], io = {}) {
  const out = writerFor(io.stdout ?? process.stdout, 'stdout')
  const err = writerFor(io.stderr ?? process.stderr, 'stderr')
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()
  const now = io.now ?? Date.now

  // Read before parsing: a payload has to be emitted for a command line that failed to parse too,
  // and `--json` is exactly the token the caller typed whether or not the rest of it was valid.
  //
  // ⛔ The scan stops at `--`, exactly as parseArgs does. Everything after the terminator is DATA — a
  // ticket title, a message, an op-11 comment — and a scan that read it as a flag would flip stdout
  // into machine mode because somebody's sentence contained the word, breaking the one-object
  // contract from the other direction.
  const tokens = argv.map(String)
  const cut = tokens.indexOf('--')
  const flagTokens = cut === -1 ? tokens : tokens.slice(0, cut)
  const jsonMode = flagTokens.some(a => a === '--json' || a.startsWith('--json='))
  let emitted = false

  const emit = payload => {
    if (emitted) throw new Error('cli: a command emitted two payloads — stdout must carry exactly one object')
    emitted = true
    // The payload is written ONLY under --json. Without the flag a human is reading, and a wall of
    // JSON on their terminal is what makes an operator stop reading the sentence above it.
    if (jsonMode) out(JSON.stringify(payload) + '\n')
  }
  const human = msg => { (jsonMode ? err : out)(String(msg) + '\n') }

  const failWith = (code, message, hint, exitCode) => {
    if (jsonMode) {
      if (!emitted) emit(errorPayload(code, message, hint))
    } else {
      err(`fleet: ${message}\n`)
      if (hint) err(`  hint: ${hint}\n`)
    }
    return exitCode
  }

  try {
    const args = parseArgs(argv)
    const commands = await loadCommands()

    // ⛔ Before the empty-command fallback: `fleet --version` carries no command, so a `!args.command`
    // branch tested first answers every version question with the help envelope — and a `--json`
    // caller asking for the version gets a command listing with no `version` key in it.
    if (args.flags.version) {
      const version = pluginVersion()
      if (jsonMode) emit(envelope(true, { version }))
      else human(version)
      return 0
    }
    if (!args.command || args.flags.help) return help(args, { commands, emit, human, jsonMode })

    const mod = findCommand(commands, args.command, args.sub)
    if (!mod) {
      throw new CliError(
        'cli.unknown-command',
        `unknown command "${args.command}${args.sub ? ' ' + args.sub : ''}"`,
        `known commands: ${commandNames(commands).join(', ')} — run "fleet --help" for their usage`,
      )
    }

    let loaded = null
    if (mod.needsConfig) {
      // The raw argv goes in so config/load.cliLayer can read the config-carrying flags it owns
      // (`--testing` on `up`, and only there). The tracker registry is injected rather than imported
      // by the config system, which must stay free of adapter parsing.
      loaded = loadConfig({ cwd, argv, env, loadAdapter: adapterLoader })
    }

    let backend = io.backend ?? null
    if (mod.needsBackend) {
      // Selection throws when no backend is available on this machine, and that IS the right answer
      // for a command that is about to spawn windows. `fleet doctor` declares needsBackend: false and
      // probes for itself, because a doctor that cannot run on a broken machine is no use at all.
      //
      // ⛔ `needsBackend` without `needsConfig` is a permitted pairing, so there may be no config to
      // read `terminal.backend` from — and selectBackend dereferences it. Handing it the schema
      // default (`auto`, which resolves per platform) is what keeps that combination a backend
      // selection rather than a bare TypeError reported as `cli.failed` with a stack.
      const chosen = await selectBackend({
        config: loaded ? loaded.config : { terminal: { backend: 'auto' } },
        override: io.backend,
        log: human,
      })
      backend = chosen.backend
    }

    const ctx = {
      config: loaded ? loaded.config : null,
      sources: loaded ? loaded.sources : null,
      facts: loaded ? loaded.facts : null,
      paths: loaded ? loaded.paths : null,
      adapter: loaded ? loaded.adapter : null,
      status: loaded ? loaded.status : null,
      warnings: loaded ? loaded.warnings : [],
      errors: loaded ? loaded.errors : [],
      slots: loaded ? loaded.slots : [],
      files: loaded ? loaded.files : [],
      backend,
      stdout: out,
      stderr: err,
      env,
      cwd,
      now,
      json: payload => emit(payload),
      log: human,
      /** Throws — so a command that forgets to `return` its failure still fails. */
      fail: (code, message, hint = null) => { throw new CliError(code, message, hint, 1) },
      jsonMode,
    }

    const code = await mod.run(ctx, args)
    // A JSON caller must always get an object: stdout that is empty cannot be told apart from a
    // command that crashed before it wrote, and the launcher would abort a healthy run over it.
    if (jsonMode && !emitted) emit(envelope(code === 0 || code === undefined))
    return typeof code === 'number' ? code : 0
  } catch (e) {
    if (e instanceof CliError) return failWith(e.code, e.message, e.hint, e.exitCode)
    // An unexpected throw is still a payload: a launcher parsing stdout gets an object it can report,
    // and the stack goes to stderr where a human can read it.
    err(`${e && e.stack ? e.stack : e}\n`)
    return failWith('cli.failed', e && e.message ? e.message : String(e), null, 1)
  }
}

/** `fleet --help` — usage for every registered command. */
function help(args, { commands, emit, human, jsonMode }) {
  const lines = usageLines(commands)
  if (jsonMode) {
    emit(envelope(true, { commands: lines }))
    return 0
  }
  human('fleet — parallel agent sessions over git worktrees')
  human('')
  for (const l of lines) human(`  ${l.usage}`)
  human('')
  human('Every command takes --json: stdout then carries exactly one {"ok": …, "v": 1, …} object.')
  return 0
}
