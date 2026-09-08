// The impure edge of the config system: read the layers off disk, ask probe.mjs what is true here,
// then hand both to the pure halves (resolve → derive → validate) and say where the operator stands.
//
// ⛔ Nothing in this file writes. `fleet config status` exits 0 on a repo that has never seen this
// tool and must be safe to run anywhere; a status command that creates its own state directory turns
// "let me check" into a change to someone else's machine. Every writer is a separate command.
//
// The decisions are pure and exported on their own — statusFor(), machineBlockers(), cliLayer(),
// matchRepoEntry(), matchCheckout() — so the traps they encode are testable without a filesystem.

import { SCHEMA_BY_KEY } from './schema.mjs'
import { resolveConfig } from './resolve.mjs'
import { deriveConfig } from './derive.mjs'
import { validateConfig } from './validate.mjs'
import { envLayer, coerceEnv } from './env.mjs'
import { configPaths, stateLayout } from './paths.mjs'
import { gatherFacts, readJson, realPath } from './probe.mjs'

/** The config format this build understands (contract §3: `version`). */
export const CURRENT_VERSION = SCHEMA_BY_KEY.get('version').default

/**
 * Contract §7's status enum, in the contract's own order — this array is the vocabulary, not the
 * ladder. The order the operator must fix things in lives in statusFor's doc block and in its code.
 */
export const STATUSES = ['ok', 'needs-init', 'needs-machine', 'needs-tracker', 'needs-checker', 'invalid', 'unmigrated']

/**
 * A checkout path is one key in the user config, and the same checkout must match itself however it
 * was written down: a trailing separator, forward slashes on Windows, or a drive letter in the other
 * case are all the same directory, and a miss silently drops that machine's overrides.
 */
export function normalizePathKey(p, platform = process.platform) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}

export function matchCheckout(checkouts, checkoutPath, platform = process.platform, canonical = p => p) {
  if (!checkouts || typeof checkouts !== 'object' || Array.isArray(checkouts) || !checkoutPath) return null
  const want = normalizePathKey(canonical(checkoutPath), platform)
  for (const [k, v] of Object.entries(checkouts)) {
    // Two passes per key, cheapest first. The literal comparison is what a hand-written key normally
    // needs; the canonical one is for the Windows 8.3 alias, where the key and the checkout name the
    // same directory in two spellings that share no characters (probe.realPath). `canonical`
    // touches the disk, so it is injected: the traps this function encodes stay testable without one.
    if (normalizePathKey(k, platform) === want) return v
    if (normalizePathKey(canonical(k), platform) === want) return v
  }
  return null
}

/**
 * repoKeyFor() lowercases the origin, so a hand-written `github.com/Acme/App` in the user config would
 * never match its own repository and the operator's overrides would vanish without a word.
 */
export function matchRepoEntry(repos, repoKey) {
  if (!repos || typeof repos !== 'object' || Array.isArray(repos) || !repoKey) return null
  const want = String(repoKey).toLowerCase()
  for (const [k, v] of Object.entries(repos)) {
    if (String(k).toLowerCase() === want) return v
  }
  return null
}

/** The subcommands contract §7 gives `--testing` to. `fleet add` takes a count, not a slot flag. */
const TESTING_FLAG_VERBS = new Set(['up'])

/** The subcommand an argv names: its first bare word, before any `--` terminator. */
export function verbOf(argv = []) {
  for (const t of argv.map(String)) {
    if (t === '--') return null
    if (!t.startsWith('-')) return t
  }
  return null
}

/**
 * The CLI flags that carry a CONFIG value, and only those (contract §7). Subcommand parsing belongs
 * to src/cli/args.mjs; anything it has already parsed arrives as the `cli` data object instead, so no
 * flag is ever invented here to reach a key.
 *
 * ⛔ A flag is only read on the verb that owns it, and never past a `--`. Scanning the whole argv let
 * `fleet send 3 rerun with --testing 2` resize the testing pool out of a message someone was quoting.
 * @param {string[]} argv  the full argv, subcommand first
 * @param {string|null} verb  the parsed subcommand, when the caller already knows it
 * @returns {{data: object, warnings: Array}}
 */
export function cliLayer(argv = [], verb = verbOf(argv)) {
  const data = {}
  const warnings = []
  if (!TESTING_FLAG_VERBS.has(verb)) return { data, warnings }
  const a = argv.map(String)
  const entry = SCHEMA_BY_KEY.get('testing.count')
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--') break
    const eq = a[i].indexOf('=')
    const flag = eq === -1 ? a[i] : a[i].slice(0, eq)
    if (flag !== '--testing') continue
    // The next token is only the count when it IS one: swallowing `--dry-run` here would report a
    // coercion failure for a flag the operator never meant to give to --testing, and drop it too.
    const next = a[i + 1]
    const takesNext = next !== undefined && next !== '--' && !next.startsWith('-')
    const raw = eq === -1 ? (takesNext ? a[++i] : undefined) : a[i].slice(eq + 1)
    if (raw === undefined) {
      warnings.push({ code: 'config.cli.invalid', key: entry.key, message: '--testing needs a slot count' })
      continue
    }
    const r = coerceEnv(entry, raw)
    if (r.error) warnings.push({ code: 'config.cli.invalid', key: entry.key, message: `--testing: ${r.error}` })
    else data.testing = { ...(data.testing || {}), count: r.value }
  }
  return { data, warnings }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Everything a user config file is read for (contract §3). Anything else contributes nothing. */
const USER_TOP_LEVEL = new Set(['version', 'defaults', 'repos', '$schema'])

/**
 * Read every config layer that exists on disk plus the env and CLI layers.
 * @param {{paths: object, env?: object, argv?: string[], cli?: object|null, repoKey?: string|null,
 *          checkout?: string|null, platform?: string}} input
 *   `paths` is a configPaths() result; `checkout` is the PRIMARY checkout the user layer is keyed by
 *   (see loadConfig — a linked worktree is never a key an operator could have written down).
 * @returns {{layers: Array<{name, data}>, files: Array, versions: Array, warnings: Array, errors: Array}}
 */
export function readLayers({ paths, env = {}, argv = [], cli = null, repoKey = null, checkout = null, platform = process.platform }) {
  const layers = []
  const files = []
  const versions = []
  const warnings = []
  const errors = []

  const add = (name, data) => {
    if (isPlainObject(data) && Object.keys(data).length) layers.push({ name, data })
  }

  const readFile = (layer, file) => {
    const r = readJson(file)
    files.push({ layer, file, exists: r.exists, error: r.error })
    if (r.error) {
      // ⛔ An unreadable config file is an ERROR, not a warning that falls back to defaults. A syntax
      // error in a committed .fleet/config.json would otherwise run the whole team's fleet on built-in
      // defaults — a different repo, a different branch prefix — while reporting itself as healthy.
      errors.push({ code: 'config.file.unreadable', key: null, layer, file, message: r.error })
      return null
    }
    if (r.exists && !isPlainObject(r.data)) {
      errors.push({ code: 'config.file.not-an-object', key: null, layer, file, message: `${file}: a config file must be a JSON object` })
      return null
    }
    return r.data
  }

  const noteVersion = (layer, file, data) => {
    const v = Number.isInteger(data.version) ? data.version : CURRENT_VERSION
    versions.push({ layer, file, version: v })
    if (v > CURRENT_VERSION) {
      errors.push({ code: 'config.version.future', key: 'version', layer, file, message: `${file} declares version ${v}; this build understands ${CURRENT_VERSION}` })
    }
  }

  const project = readFile('project', paths.projectFile)
  if (project) {
    noteVersion('project', paths.projectFile, project)
    add('project', project)
  }

  const local = readFile('project-local', paths.projectLocalFile)
  if (local) {
    noteVersion('project-local', paths.projectLocalFile, local)
    add('project-local', local)
  }

  const user = readFile('user', paths.userFile)
  if (user) {
    noteVersion('user', paths.userFile, user)
    // ⛔ Only `defaults`, `repos` and a repo entry's `checkouts` are ever read here, so a top-level
    // typo (`default:`, `repo:`) or a flat file contributes NOTHING — and it never reaches
    // resolveConfig, so `config.unknown-key` cannot fire for it either. Every way of missing has to
    // be loud: the operator is looking at a file they can plainly see being ignored.
    for (const k of Object.keys(user)) {
      if (USER_TOP_LEVEL.has(k)) continue
      warnings.push({ code: 'config.user.unrecognised', key: k, layer: 'user', file: paths.userFile, message: `${paths.userFile}: top-level "${k}" is not read (the user file holds ${[...USER_TOP_LEVEL].join(', ')})` })
    }
    add('user-defaults', user.defaults)
    const entry = matchRepoEntry(user.repos, repoKey)
    if (isPlainObject(entry)) {
      const { checkouts, ...repoScoped } = entry
      add('user-repo', repoScoped)
      const forCheckout = matchCheckout(checkouts, checkout, platform, realPath)
      add('user-checkout', forCheckout)
      if (!forCheckout && isPlainObject(checkouts) && Object.keys(checkouts).length) {
        warnings.push({ code: 'config.user.checkout-unmatched', key: null, layer: 'user', file: paths.userFile, message: `no checkout under "${repoKey}" matches ${checkout} (present: ${Object.keys(checkouts).join(', ')})` })
      }
    } else if (isPlainObject(user.repos) && Object.keys(user.repos).length) {
      warnings.push({ code: 'config.user.repo-unmatched', key: null, layer: 'user', file: paths.userFile, message: `no entry in repos matches "${repoKey}" (present: ${Object.keys(user.repos).join(', ')})` })
    }
  }

  const e = envLayer(env)
  warnings.push(...e.warnings)
  add('env', e.data)

  const c = cliLayer(argv)
  warnings.push(...c.warnings)
  add('cli', mergeDeep(c.data, isPlainObject(cli) ? cli : {}))

  return { layers, files, versions, warnings, errors }
}

/** Merge b over a, one level per nested object. Only used to fold pre-parsed CLI data over flags. */
function mergeDeep(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : v
  }
  return out
}

/**
 * Values that must be resolved on THIS machine before anything else can run. These are what
 * `needs-machine` means: the fleet does not know where to put worktrees or state here.
 * `repo.worktreeParent`, `paths.stateDir` and `fleet.size` are user-scope (contract §3), so no
 * committed file may answer them; `repo.name` is project-scope but is derived from the primary
 * checkout, so it is unanswered exactly when there is no checkout here to derive it from.
 */
export function machineBlockers(config, facts = {}) {
  const out = []
  if (!(facts.git && facts.git.toplevel)) out.push('repo')
  if (!config.repo.name) out.push('repo.name')
  if (!config.repo.worktreeParent) out.push('repo.worktreeParent')
  if (!config.paths.stateDir) out.push('paths.stateDir')
  if (config.fleet.size === null || config.fleet.size === undefined) out.push('fleet.size')
  return out
}

// The keys whose absence is a question the init wizard asks, not a broken config.
const INIT_KEYS = new Set(['commands.bootstrap', 'commands.devServer'])
const MISSING = 'config.missing-required'

/**
 * Which of the seven states this config is in (contract §7). Pure.
 *
 * The order is the order the operator must fix things in, and it is deliberate:
 *   unmigrated  — nothing below can be trusted until the file is migrated;
 *   invalid     — a config that is wrong (a type, a secret in a committed file) must be fixed before
 *                 any wizard question makes sense. Absent answers are NOT invalid: they are bucketed
 *                 to the step that asks them, or `fleet config status` would say "invalid" to every
 *                 repo that simply has not been set up yet;
 *   needs-machine — asked before needs-init because `fleet config init` cannot help a shell that is
 *                 not inside a checkout at all;
 *   needs-init → needs-tracker → needs-checker — the wizard's own order.
 * @returns {string} one of STATUSES
 */
export function statusFor({ config, errors = [], files = [], versions = [], facts = {}, adapter = null }) {
  if (versions.some(v => Number.isInteger(v.version) && v.version < CURRENT_VERSION)) return 'unmigrated'

  const init = []
  const tracker = []
  const checker = []
  let other = 0
  for (const e of errors) {
    const key = e.key || ''
    if (e.code === MISSING && INIT_KEYS.has(key)) init.push(key)
    else if (e.code === MISSING && key.startsWith('tracker.')) tracker.push(key)
    else if (e.code === MISSING && key.startsWith('checker.')) checker.push(key)
    else other++
  }
  if (other) return 'invalid'

  if (machineBlockers(config, facts).length) return 'needs-machine'

  const projectFile = files.find(f => f.layer === 'project')
  if (!projectFile || !projectFile.exists || init.length) return 'needs-init'

  const trackerless = config.tracker.mode === 'none'
  if (!trackerless && (!config.tracker.id || !adapter || tracker.length)) return 'needs-tracker'

  // A tracker with two unstarted-typed states (a backlog and a to-do) cannot be guessed between, so
  // /fleet-check has nowhere to promote a passed ticket to until checker.ready.state is settled.
  if (checker.length || (!trackerless && !config.checker.ready.state)) return 'needs-checker'

  return 'ok'
}

/**
 * Everything a command needs to know before it does anything: the resolved config, where each value
 * came from, the facts it was derived from, the paths, the tracker adapter and the status.
 *
 * @param {{cwd?: string, argv?: string[], env?: object, cli?: object|null, facts?: object|null,
 *          loadAdapter?: ((id: string, ctx: object) => object|null)|null}} input
 *   `facts` and `loadAdapter` are injection seams: tests supply facts to describe another machine,
 *   and the CLI supplies the tracker registry (this module must not parse adapter files itself).
 * @returns {{config, sources, facts, paths, adapter, slots, junctions, layers, files, warnings, errors, status}}
 */
export function loadConfig({ cwd = process.cwd(), argv = [], env = process.env, cli = null, facts: injected = null, loadAdapter = null } = {}) {
  const facts = injected || gatherFacts({ cwd, env })
  const warnings = [...(facts.warnings || [])]
  const errors = []

  const platform = (facts.machine && facts.machine.platform) || process.platform
  const machine = facts.machine || {}
  // `.fleet/…` belongs to the checkout you are actually in — deliberately: the project file is
  // committed and travels with the branch, so a session working on a branch that edits it must read
  // its OWN copy. The price is that `.fleet/config.local.json` is gitignored and therefore absent
  // from a fresh worktree, so a project-local override is the launcher's alone; anything a session
  // must also see belongs in the committed file or in the user layer.
  const repoRoot = (facts.git && (facts.git.toplevel || facts.git.primary)) || cwd
  // ⛔ The user layer's `checkouts` map is keyed by the PRIMARY checkout, never the toplevel. Session,
  // slot and checker worktrees are created and destroyed by the fleet itself, so no path an operator
  // could have written down would ever match from inside one: the launcher would resolve a moved
  // paths.stateDir and its sessions the default, and each would then hold a private lock pool that
  // hands the same testing slot to two sessions (see the stateDir note further down).
  const primaryCheckout = (facts.git && (facts.git.primary || facts.git.toplevel)) || cwd
  const paths0 = configPaths({
    platform,
    // The path derivations read only the handful of variables probe.mjs carried over; the facts win
    // over the live environment so injected facts really do describe another machine.
    env: { ...pickPathEnv(env), ...(machine.env || {}) },
    homedir: machine.homedir || '',
    repoRoot,
    repoKey: facts.repoKey,
  })

  const read = readLayers({ paths: paths0, env, argv, cli, repoKey: facts.repoKey, checkout: primaryCheckout, platform })
  warnings.push(...read.warnings)
  errors.push(...read.errors)

  const resolved = resolveConfig({ layers: read.layers })
  warnings.push(...resolved.warnings)
  errors.push(...resolved.errors)

  let adapter = null
  if (resolved.config.tracker.id) {
    if (typeof loadAdapter === 'function') {
      try {
        adapter = loadAdapter(resolved.config.tracker.id, { projectTrackersDir: paths0.projectTrackersDir, facts }) || null
      } catch (e) {
        errors.push({ code: 'config.adapter.unreadable', key: 'tracker.id', message: `tracker adapter "${resolved.config.tracker.id}": ${e.message}` })
      }
    } else {
      warnings.push({ code: 'config.adapter.unavailable', key: 'tracker.id', message: `no tracker registry was supplied, so the "${resolved.config.tracker.id}" adapter's defaults are unavailable` })
    }
  }

  const derived = deriveConfig(resolved.config, facts, { adapter, sources: resolved.sources })
  warnings.push(...derived.warnings)

  const checked = validateConfig(derived.config, { adapter, facts, sources: resolved.sources })
  errors.push(...checked.errors)
  warnings.push(...checked.warnings)

  const config = derived.config
  // The RESOLVED state dir owns the layout, not the derived default: an operator who moves
  // paths.stateDir must move the locks and flags with it, or the launcher and its sessions each hold
  // a private pool and hand the same testing slot to two sessions.
  const stateDir = config.paths.stateDir || paths0.stateDir
  const paths = { ...paths0, stateDir, state: stateLayout(stateDir, platform) }

  const status = statusFor({ config, errors, files: read.files, versions: read.versions, facts, adapter })
  if (status === 'needs-machine') {
    warnings.push({ code: 'config.machine.unresolved', key: null, message: `unresolved on this machine: ${machineBlockers(config, facts).join(', ')}` })
  }

  return {
    config,
    sources: resolved.sources,
    facts,
    paths,
    adapter,
    slots: derived.slots,
    junctions: derived.junctions,
    layers: read.layers.map(l => l.name),
    files: read.files,
    warnings,
    errors,
    status,
  }
}

const PATH_ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'FLEET_CONFIG_HOME']

function pickPathEnv(env = {}) {
  const out = {}
  for (const k of PATH_ENV_KEYS) if (env[k]) out[k] = String(env[k])
  return out
}
