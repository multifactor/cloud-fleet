// Argv → {command, sub, positionals, flags}. PURE, and deliberately strict.
//
// ⛔ An unknown flag is an ERROR, never an ignored token. A parser that shrugs at what it does not
// recognise is how a typo'd `--dryrun` once ran a fan-out for real: the operator read their own
// command line back, saw the flag they meant, and believed nothing had been created. The cost of
// strictness is having to declare every flag here; the cost of leniency is a fleet nobody asked for.
//
// The flag table is therefore GLOBAL rather than per command, and it is the whole of contract §7.
// Arity has to be known before parsing (`--testing 2` takes its neighbour, `--dry-run` does not), and
// a table only some commands contributed to cannot answer that for the others.

/**
 * A failure with an operator-facing shape: a stable `code`, a sentence, and an actionable `hint`.
 * `exitCode` defaults to 2 — a usage error the caller fixes by retyping — so it is distinguishable
 * from 1, which every runtime failure uses: retrying a 2 unchanged can only fail again.
 */
export class CliError extends Error {
  constructor(code, message, hint = null, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.hint = hint
    this.exitCode = exitCode
  }
}

/**
 * Every flag contract §7 defines, and nothing else. `boolean` takes no value; `value` takes the next
 * token (or `--name=value`), and a repeated `value` flag collects into an array.
 *
 * Kept as ONE table keyed by the flag's own spelling — kebab-case, exactly as it is typed — because a
 * camelCase translation layer is a second name for every flag and the two spellings drift: a command
 * reading `flags.dryRun` against a parser that wrote `flags['dry-run']` fails silently open.
 */
export const FLAGS = Object.freeze({
  // universal
  json: 'boolean',
  help: 'boolean',
  version: 'boolean',
  // fleet up / add
  testing: 'value',
  issues: 'value',
  add: 'value',
  role: 'value',
  'sweep-id': 'value',
  'dry-run': 'boolean',
  'no-wizard': 'boolean',
  // fleet send / flag / session env
  file: 'value',
  label: 'value',
  all: 'boolean',
  // fleet doctor
  repair: 'boolean',
  'verify-primary': 'boolean',
  // fleet config
  'from-json': 'value',
  scope: 'value',
  // fleet ticket
  issue: 'value',
  // fleet outbox
  op: 'value',
  key: 'value',
  args: 'value',
  verbatim: 'boolean',
  result: 'value',
  // fleet pool
  slot: 'value',
  wait: 'value',
  once: 'boolean',
  // fleet flag done | blocked
  outcome: 'value',
  'pr-url': 'value',
  reason: 'value',
  evidence: 'value',
  prescription: 'value',
  'body-patched': 'boolean',
  category: 'value',
  observation: 'value',
  'evidence-url': 'value',
  // fleet assets / cloud
  branch: 'value',
  bundle: 'value',
  ref: 'value',
  slice: 'value',
  // fleet check
  mode: 'value',
  project: 'value',
  width: 'value',
  resume: 'value',
  'from-file': 'value',
  auto: 'boolean',
  audit: 'boolean',
  'items-json': 'value',
  from: 'value', // `fleet check ledger reconcile --from findings`
  keys: 'value',
  note: 'value',
  count: 'value',
  pages: 'value',
  lock: 'boolean',
  col: 'value',
  domain: 'value',
  corpus: 'value',
  since: 'value',
  verdicts: 'value',
  fid: 'value',
  'min-priority': 'value',
  waive: 'boolean',
})

const isFlagToken = t => t.startsWith('--') && t !== '--'

/**
 * Parse an argv (already stripped of `node` and the script path).
 *
 * @param {string[]} argv
 * @param {{flags?: Record<string,'boolean'|'value'>}} [opts]
 * @returns {{command: string|null, sub: string|null, positionals: string[], flags: object}}
 *   `positionals` is everything after the command, and `sub` is an alias for its first entry —
 *   purely lexical. Whether that word is a subcommand or an argument is the registry's decision, not
 *   this parser's: `fleet up 4` and `fleet config status` are the same shape here, and a parser that
 *   guessed would need every command's grammar to tell `4` from `status`.
 * @throws {CliError} on an unknown flag, a value flag with no value, or a switch given one
 */
export function parseArgs(argv = [], { flags: table = FLAGS } = {}) {
  const flags = {}
  const bare = []
  const tokens = argv.map(String)
  let terminated = false

  const setFlag = (name, value) => {
    // Repeats collect rather than overwrite: `--evidence a --evidence b` is two pieces of evidence,
    // and a last-one-wins parser silently discards the first every time.
    if (!Object.prototype.hasOwnProperty.call(flags, name)) {
      flags[name] = value
      return
    }
    if (table[name] === 'boolean') return
    flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value]
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (terminated) {
      bare.push(t)
      continue
    }
    // `--` ends flag parsing so a ticket title, a message or a path that starts with a dash can still
    // be passed as data.
    if (t === '--') {
      terminated = true
      continue
    }
    if (!isFlagToken(t)) {
      bare.push(t)
      continue
    }
    const eq = t.indexOf('=')
    const name = (eq === -1 ? t : t.slice(0, eq)).slice(2)
    const kind = table[name]
    if (!kind) {
      throw new CliError(
        'cli.unknown-flag',
        `unknown flag --${name}`,
        'every flag this CLI understands is in contract §7; run "fleet --help" for a command\'s usage. An unrecognised flag is refused rather than ignored, because an ignored --dry-run is not a dry run.',
      )
    }
    if (kind === 'boolean') {
      if (eq !== -1) throw new CliError('cli.flag-takes-no-value', `--${name} is a switch and takes no value`, `write --${name} on its own`)
      setFlag(name, true)
      continue
    }
    if (eq !== -1) {
      setFlag(name, t.slice(eq + 1))
      continue
    }
    const next = tokens[i + 1]
    // A value may legitimately start with ONE dash (`--from-json -` means stdin) but never with two:
    // swallowing `--dry-run` as the value of `--issues` would both lose the switch and launch a fleet
    // against an issue key nobody typed.
    if (next === undefined || isFlagToken(next) || next === '--') {
      throw new CliError('cli.flag-needs-value', `--${name} needs a value`, `write --${name} <value> or --${name}=<value>`)
    }
    setFlag(name, next)
    i++
  }

  const [command = null, ...rest] = bare
  return { command, sub: rest[0] ?? null, positionals: rest, flags }
}

/**
 * Read a flag that must be a whole number. Returns `fallback` when absent.
 *
 * ⛔ Not `Number(x)`: `Number("")` is 0 and `Number("2 slots")` is NaN, and a slot count that
 * silently became 0 reads as "the operator asked for no local pool".
 */
export function intFlag(flags, name, fallback = null) {
  const raw = flags[name]
  if (raw === undefined) return fallback
  if (Array.isArray(raw)) throw new CliError('cli.flag-repeated', `--${name} was given more than once`, `pass a single --${name} value`)
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new CliError('cli.flag-not-a-number', `--${name} expects a whole number, got "${raw}"`, `for example --${name} 2`)
  }
  return parseInt(String(raw).trim(), 10)
}

/** Read a flag that must be a single string (never a repeat). Returns `fallback` when absent. */
export function stringFlag(flags, name, fallback = null) {
  const raw = flags[name]
  if (raw === undefined) return fallback
  if (Array.isArray(raw)) throw new CliError('cli.flag-repeated', `--${name} was given more than once`, `pass a single --${name} value`)
  return String(raw)
}

/** Read a repeatable flag as a list, whether it was given once, many times, or comma-joined. */
export function listFlag(flags, name) {
  const raw = flags[name]
  if (raw === undefined) return []
  const many = Array.isArray(raw) ? raw : [raw]
  return many.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean)
}
