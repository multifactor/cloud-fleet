// `fleet config status|detect|init|set|get|resolve|sources|validate|migrate` (contract §7).
//
// This is the only file in the plugin that WRITES a config file, and the two rules it enforces are
// what keep a published config person- and machine-independent:
//
//   ⛔ a `user`-scope key is REFUSED in the committed project file (a worktree parent, a fleet size,
//      a branch prefix that is somebody's name), and a `secret` key is refused there outright;
//   ⛔ every write is a temp file renamed over the target IN THE SAME DIRECTORY — a rename across
//      filesystems is a copy, which is the half-written config this exists to prevent, and a
//      half-written `.fleet/config.json` runs the whole team's fleet on built-in defaults.
//
// ⛔ `status` EXITS 0 EVEN WHEN UNCONFIGURED. The state is the payload's `status` field; a non-zero
// exit makes the launcher read "this repo has never been set up" as a tool failure and abort a first
// run before the wizard it was about to open.

import fs from 'node:fs'
import path from 'node:path'

import { SCHEMA_BY_KEY, isContainerType } from '../../config/schema.mjs'
import { getPath, setPath } from '../../config/defaults.mjs'
import { leafPaths, classifyPath, LAYER_ORDER } from '../../config/resolve.mjs'
import { coerceEnv } from '../../config/env.mjs'
import { readJson } from '../../config/probe.mjs'
import { fleetSizeFor } from '../../config/derive.mjs'
import { machineBlockers, statusFor, CURRENT_VERSION, STATUSES } from '../../config/load.mjs'
import { listAdapters } from '../../trackers/registry.mjs'
import { selectBackend } from '../../backends/index.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'config'
export const usage = 'fleet config status|detect|init --from-json <f|->|set <k> <v> [--scope project|user]|get <k>|resolve|sources|validate|migrate'
export const needsConfig = true
// Only `detect` wants a terminal backend, and only to fill one proposal row; asking the dispatcher
// for one would make `fleet config status` fail on a machine with no terminal — the exact machine
// whose status the operator is trying to read.
export const needsBackend = false

const SUBS = ['status', 'detect', 'init', 'set', 'get', 'resolve', 'sources', 'validate', 'migrate']

/** What the launcher should run next for each status (playbooks/launcher.md, Step 0). */
const NEXT_ACTION = Object.freeze({
  ok: 'fleet doctor --json, then fleet up',
  'needs-init': 'fleet config detect --json, then fleet config init --from-json -',
  'needs-machine': 'fleet config detect --json, then fleet config init --from-json - (machine rows only)',
  'needs-tracker': 'connect the tracker, or set tracker.mode to manual or none',
  'needs-checker': 'fleet config set <key> <value> for each missing key',
  invalid: 'fleet config set <key> <value> to fix each error below',
  unmigrated: 'fleet config migrate',
})

const HINT = Object.freeze({
  ok: 'both layers are present and valid; skip the wizard.',
  'needs-init': 'this repo has no .fleet/config.json yet — run the wizard; nothing has been written.',
  'needs-machine': 'the project config is committed but this machine has no entry for it; only the machine rows are missing.',
  'needs-tracker': 'tracker.mode is mcp but no adapter resolved — connect the tracker, or run in manual/none mode; the fleet can still launch.',
  'needs-checker': 'the /fleet-check keys are incomplete; the fleet itself can launch without them.',
  invalid: 'a config value is wrong; fix it through fleet config set rather than by hand-editing.',
  unmigrated: 'a config file declares an older format version than this build understands.',
})

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('config.unknown-subcommand', `fleet config takes one of ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  const rest = args.positionals.slice(1)
  switch (sub) {
    case 'status': return status(ctx)
    case 'detect': return detect(ctx)
    case 'init': return init(ctx, args)
    case 'set': return set(ctx, args, rest)
    case 'get': return get(ctx, rest)
    case 'resolve': return resolve(ctx)
    case 'sources': return sources(ctx)
    case 'validate': return validate(ctx)
    case 'migrate': return migrate(ctx)
    default: return 2
  }
}

// ---- status --------------------------------------------------------------------------------------

/** The keys each non-ok status is waiting on, taken from the validation errors rather than guessed. */
export function missingFor(status, { errors = [], config = null, facts = {} } = {}) {
  const missing = errors.filter(e => e.code === 'config.missing-required').map(e => e.key)
  if (status === 'needs-machine') return machineBlockers(config, facts)
  if (status === 'needs-init') return missing.filter(k => k === 'commands.bootstrap' || k === 'commands.devServer')
  if (status === 'needs-tracker') return [...new Set(missing.filter(k => k.startsWith('tracker.')).concat(config && !config.tracker.id ? ['tracker.id'] : []))]
  if (status === 'needs-checker') {
    const keys = missing.filter(k => k.startsWith('checker.'))
    if (config && !config.checker.ready.state) keys.push('checker.ready.state')
    return [...new Set(keys)]
  }
  if (status === 'unmigrated') return []
  return missing
}

function status(ctx) {
  const projectFile = (ctx.files || []).find(f => f.layer === 'project')
  const st = ctx.status
  ctx.json(envelope(true, {
    // ⛔ `ok` answers "did this command run", never "is the repo configured". The launcher branches
    // on `status`, and both a false `ok` and a non-zero exit here would turn "not set up yet" into
    // "the tool is broken" on somebody's very first run.
    status: st,
    statuses: STATUSES,
    repoKey: ctx.facts.repoKey,
    project: { file: ctx.paths.projectFile, exists: !!(projectFile && projectFile.exists) },
    user: { file: ctx.paths.userFile, exists: !!(ctx.files || []).find(f => f.layer === 'user' && f.exists) },
    machine: { blockers: machineBlockers(ctx.config, ctx.facts), stateDir: ctx.config.paths.stateDir },
    tracker: { id: ctx.config.tracker.id, mode: ctx.config.tracker.mode, adapter: ctx.adapter ? ctx.adapter.file : null },
    missing: missingFor(st, ctx),
    nextAction: NEXT_ACTION[st] || null,
    hint: HINT[st] || null,
    errors: ctx.errors,
    warnings: ctx.warnings,
  }))
  ctx.log(`config status: ${st}${HINT[st] ? ` — ${HINT[st]}` : ''}`)
  return 0
}

// ---- detect --------------------------------------------------------------------------------------

// Script name → how strongly it looks like the job. Names only: a `scripts` body is a shell string
// whose words ("build", "test") appear in almost every script, and scoring on it once ranked the
// release pipeline above the dev server.
const BOOTSTRAP_HINTS = [[/worktree/i, 0.95], [/bootstrap/i, 0.92], [/^(setup|prepare)$/i, 0.85], [/^(setup|prepare)[:-]/i, 0.8], [/install/i, 0.6]]
const DEV_HINTS = [[/^dev$/i, 0.95], [/^dev[:-]/i, 0.85], [/^start$/i, 0.7], [/serve/i, 0.65]]

/** PURE. Rank package.json scripts against a hint table, best first. */
export function rankScripts(scripts = {}, hints) {
  const out = []
  for (const [scriptName, command] of Object.entries(scripts)) {
    let score = 0
    for (const [re, s] of hints) if (re.test(scriptName)) score = Math.max(score, s)
    if (score > 0) out.push({ name: scriptName, command, score })
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/**
 * PURE. One proposal row. `source` is half the point of the table: an operator accepts a row they can
 * see the provenance of, and re-derives one they cannot.
 */
const row = (key, proposed, source, extra = {}) => ({
  key,
  proposed,
  source,
  scope: SCHEMA_BY_KEY.get(key) ? SCHEMA_BY_KEY.get(key).scope : 'project',
  ...extra,
})

/** PURE. Two candidates within 0.15 of each other are a question, not a proposal (launcher Step 2). */
export function ambiguityOf(ranked) {
  if (ranked.length < 2) return null
  return ranked[0].score - ranked[1].score < 0.15 ? ranked.slice(0, 2).map(r => `${r.name} (${r.score})`) : null
}

async function detect(ctx) {
  const facts = ctx.facts
  const scripts = (facts.pkg && facts.pkg.scripts) || {}
  const proposal = []

  const bootstrap = rankScripts(scripts, BOOTSTRAP_HINTS)
  const dev = rankScripts(scripts, DEV_HINTS)
  const pm = facts.packageManager || 'npm'

  proposal.push(row('repo.name', ctx.config.repo.name, facts.git.primary ? 'basename of the primary checkout' : 'package.json name'))
  proposal.push(row('repo.worktreeParent', ctx.config.repo.worktreeParent, 'dirname of the primary checkout'))
  proposal.push(row('repo.baseBranch', ctx.config.repo.baseBranch, 'default'))
  proposal.push(row(
    'commands.bootstrap',
    bootstrap.length ? `${pm} run ${bootstrap[0].name}` : `${pm} install`,
    bootstrap.length ? `package.json script (score ${bootstrap[0].score})` : 'no matching script — the package manager default',
    { alternatives: bootstrap.slice(1, 4), ambiguous: ambiguityOf(bootstrap) },
  ))
  proposal.push(row(
    'commands.devServer',
    dev.length ? `${pm} run ${dev[0].name}` : null,
    dev.length ? `package.json script (score ${dev[0].score})` : 'no script looks like a dev server — needs your answer',
    { alternatives: dev.slice(1, 4), ambiguous: ambiguityOf(dev) },
  ))
  proposal.push(row('devServer.urlTemplate', ctx.config.devServer.urlTemplate, 'default (fixed port)'))
  proposal.push(row('devServer.probes', ctx.config.devServer.probes, 'default — only 2xx/3xx counts as up; point one probe at an API route, because a / that answers 200 proves only the frontend half is alive'))
  proposal.push(row('devServer.serverProcessPattern', ctx.config.devServer.serverProcessPattern, 'derived from commands.devServer through the package scripts'))

  const containers = ((facts.compose && facts.compose.services) || []).map(s => ({
    name: s.name,
    startCommand: null,
    healthHost: '127.0.0.1',
    healthPort: firstHostPort(s.ports),
  }))
  proposal.push(row('services.containers', containers, facts.compose ? `compose file ${facts.compose.file}` : 'no compose file found'))
  proposal.push(row('emulator.slots', ctx.config.emulator.slots, 'not probed — a second AVD costs RAM the box usually has not got; enable the pool by hand'))

  // ⛔ CAPTURE MUST APPEAR IN THE TABLE. It never used to, so `capture.mode` sat at its `local`
  // default with `capture.runner` null and no renderer checked — and the operator was never asked a
  // single question about screenshots. The result is a fleet that believes it captures, review pages
  // that read "No screenshots.", and PRs with no evidence, with nothing anywhere reporting a fault.
  // Proposing the rows is what turns a silent default into a decision.
  const primaryDir = facts.git.primary || ctx.cwd
  const hasPlaywright = !!primaryDir && fs.existsSync(path.join(primaryDir, 'node_modules', 'playwright'))
  proposal.push(row(
    'capture.mode',
    ctx.config.capture.mode,
    hasPlaywright
      ? 'default — this repo has Playwright, so the bundled runner can screenshot a testing slot'
      : 'default — no Playwright found here; `local` still works through a system Chrome, and `none` is the honest setting for a repo with no UI',
  ))
  proposal.push(row(
    'capture.runner',
    ctx.config.capture.runner,
    'unset uses the bundled runner (capture/screenshot.mjs: one URL in, one PNG out) — point this at your own command only when a capture needs to sign in, seed data or drive a flow',
  ))
  proposal.push(row(
    'capture.reviewPdf',
    ctx.config.capture.reviewPdf,
    'default — the scratch review page is rendered to a one-page PDF and attached to the PR on the assets branch',
  ))

  const m = facts.machine || {}
  const sizeSource = m.totalRamGb && m.cpus
    ? `this machine: floor((${Math.round(m.totalRamGb)} - ${ctx.config.install.reservePhysicalGb}) / ${ctx.config.install.perInstallGb}) = ${fleetSizeFor(m, ctx.config.install)}, capped at ${m.cpus} cpus`
    : 'this machine could not be measured'
  proposal.push(row('fleet.size', ctx.config.fleet.size, sizeSource))
  proposal.push(row('testing.count', ctx.config.testing.count, 'default'))
  proposal.push(row('vcs.branchPrefix', ctx.config.vcs.branchPrefix, facts.git.userName ? 'git config user.name, slugged' : 'git config user.name is unset — needs your answer'))
  proposal.push(row('vcs.host', ctx.config.vcs.host, 'the origin URL'))
  // Stored as the sentinel "me" — the authenticated tracker user — never a name or an email, so a
  // committed config cannot become somebody's org chart.
  proposal.push(row('tracker.defaultAssignee', ctx.config.tracker.defaultAssignee, 'the sentinel "me" (the authenticated tracker user)'))
  proposal.push(row('tracker.id', ctx.config.tracker.id, `match your own visible MCP tool prefixes against each adapter's mcp.toolPrefixes — this CLI cannot see the launcher's tool list (bundled adapters: ${listAdapters().join(', ')})`))
  proposal.push(row('tracker.scope', ctx.config.tracker.scope, ctx.adapter && ctx.adapter.front.scope ? `needs your answer (${ctx.adapter.front.scope.label})` : 'needs your answer once tracker.id is settled'))

  let backendRow = row('terminal.backend', ctx.config.terminal.backend, 'not probed')
  try {
    const chosen = await selectBackend({ config: ctx.config, override: ctx.backend, log: () => {} })
    backendRow = row('terminal.backend', ctx.config.terminal.backend, `probe: ${ctx.config.terminal.backend} resolves to ${chosen.name}`)
  } catch (e) {
    backendRow = row('terminal.backend', null, `probe found no backend on this machine: ${e.message.split('\n')[0]}`)
  }
  proposal.push(backendRow)

  ctx.json(envelope(true, {
    status: ctx.status,
    repoKey: ctx.facts.repoKey,
    primary: facts.git.primary,
    proposal,
    // Detection never writes: this payload is a proposal the operator accepts, and `init` is the
    // only writer.
    writes: false,
    warnings: ctx.warnings,
  }))
  ctx.log(`config detect: ${proposal.length} proposed rows (nothing written)`)
  return 0
}

/** `"5432:5432"` / `"127.0.0.1:5432:5432"` → the host port a health probe should connect to. */
function firstHostPort(ports = []) {
  for (const p of ports) {
    const parts = String(p).split(':')
    const host = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    const n = parseInt(String(host).replace(/[^0-9].*$/, ''), 10)
    if (Number.isInteger(n)) return n
  }
  return null
}

// ---- init ----------------------------------------------------------------------------------------

/** PURE. Every leaf of a plain object as `[dottedPath, value]`; arrays and nulls are leaves. */
function* flatten(obj, prefix = '') {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) yield* flatten(v, p)
    else yield [p, v]
  }
}

/**
 * PURE. Normalise the wizard's answers into `{answers, scope}` keyed by SCHEMA keys.
 * Accepts a flat map of dotted keys, a nested object, or `{answers, scope}` carrying either.
 */
export function readAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliError('config.answers-not-an-object', 'the --from-json payload must be a JSON object of answers', 'for example {"answers": {"commands.bootstrap": "npm ci"}, "scope": {"testing.count": "project"}}')
  }
  const wrapped = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
  // `scope` and `v` are envelope fields, and no config key is named either — but a bare payload that
  // carried them would otherwise be read as answers called "scope.testing.count", and the operator
  // would be told their scope map is an unknown key.
  const body = wrapped ? input.answers : Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'scope' && k !== 'v'))
  const requested = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope) ? input.scope : {}

  // ⛔ Re-nest first. The wizard writes `{"commands.bootstrap": "…"}` and a hand-written file writes
  // `{"commands": {"bootstrap": "…"}}`, and both mean the same key — but reading a dotted property
  // off the flat form with a nested walker yields `undefined`, which writes the key with no value and
  // reports success. setPath understands both because it splits on the dot either way.
  const nested = {}
  for (const [leaf, value] of flatten(body)) setPath(nested, leaf, value)

  const answers = new Map()
  for (const leaf of leafPaths(nested)) {
    const { known, key } = classifyPath(leaf)
    if (!known) {
      throw new CliError('config.unknown-key', `"${leaf}" is not a config key`, 'every key is listed in contract §3 and in src/config/schema.mjs; `fleet config get <key>` proves one exists')
    }
    if (answers.has(key)) continue // a container key is taken whole, not leaf by leaf
    answers.set(key, getPath(nested, key))
  }
  const scope = {}
  for (const [k, v] of Object.entries(requested)) {
    if (v !== 'project' && v !== 'user') throw new CliError('config.bad-scope', `scope for "${k}" must be "project" or "user", got ${JSON.stringify(v)}`, 'a user-scope key can only be written to the user file')
    scope[k] = v
  }
  return { answers, scope }
}

/**
 * PURE. Which file a key's answer belongs in — and the refusal that keeps the committed file
 * company- and machine-independent.
 */
export function targetFileFor(key, requested = null) {
  const entry = SCHEMA_BY_KEY.get(key)
  if (!entry) throw new CliError('config.unknown-key', `"${key}" is not a config key`, 'contract §3 lists every key')
  if (requested === 'project' && entry.secret) {
    throw new CliError(
      'config.secret.committed',
      `"${key}" is a secret and must never appear in the committed project file`,
      'write it to the user layer (--scope user); the project file holds the NAME of an env var, never a value',
    )
  }
  if (requested === 'project' && entry.scope === 'user') {
    throw new CliError(
      'config.scope.refused',
      `"${key}" is a user-scope key and cannot be written to the committed project file`,
      'it describes this machine (a path, a size, a person), and a committed copy would take effect for everyone who clones the repo — write it with --scope user',
    )
  }
  if (entry.secret || entry.scope === 'user') return 'user'
  if (entry.scope === 'project') return requested === 'user' ? 'user' : 'project'
  return requested || 'project' // "either": the operator's answer, defaulting to the shared file
}

/**
 * ⛔ Temp file IN THE SAME DIRECTORY, then rename. A temp file elsewhere turns the rename into a
 * copy, which is exactly the half-written config this avoids — and a syntactically broken
 * `.fleet/config.json` silently runs a whole team's fleet on built-in defaults.
 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return file
}

const renderJson = data => JSON.stringify(data, null, 2) + '\n'

/** Longest common subsequence of two line arrays — the backbone of the unified diff below. */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++ }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push(['-', a[i]]); i++ }
    else { ops.push(['+', b[j]]); j++ }
  }
  while (i < n) ops.push(['-', a[i++]])
  while (j < m) ops.push(['+', b[j++]])
  return ops
}

/**
 * A unified diff of two texts. `--dry-run` shows the operator exactly which keys land in the
 * committed file and which on their machine BEFORE anything is written — the whole point of running
 * it first, and the reason this is a diff rather than a list of keys.
 */
export function unifiedDiff(before, after, aName = 'a', bName = 'b', context = 3) {
  if (before === after) return ''
  const a = before === null || before === undefined ? [] : String(before).split('\n')
  const b = String(after).split('\n')
  const ops = lcsOps(a, b)
  const hunks = []
  let cur = null
  let ai = 0
  let bi = 0
  const pending = []
  for (const [kind, line] of ops) {
    if (kind === ' ') {
      if (cur) {
        if (cur.trailing < context) { cur.lines.push(`  ${line}`); cur.aLen++; cur.bLen++; cur.trailing++ }
        else { hunks.push(cur); cur = null; pending.length = 0 }
      }
      if (!cur) {
        pending.push({ line, ai, bi })
        if (pending.length > context) pending.shift()
      }
      ai++; bi++
      continue
    }
    if (!cur) {
      const head = pending[0] || { ai, bi }
      cur = { aStart: head.ai + 1, bStart: head.bi + 1, aLen: pending.length, bLen: pending.length, lines: pending.map(x => `  ${x.line}`), trailing: 0 }
      pending.length = 0
    }
    cur.trailing = 0
    if (kind === '-') { cur.lines.push(`- ${line}`); cur.aLen++; ai++ }
    else { cur.lines.push(`+ ${line}`); cur.bLen++; bi++ }
  }
  if (cur) hunks.push(cur)
  const head = `--- ${aName}\n+++ ${bName}\n`
  // A hunk against an absent file starts at line 0, not line 1: `@@ -1,0` is what a patch tool rejects.
  return head + hunks.map(h => `@@ -${h.aLen ? h.aStart : 0},${h.aLen} +${h.bLen ? h.bStart : 0},${h.bLen} @@\n${h.lines.join('\n')}`).join('\n') + '\n'
}

/** Read the `--from-json` payload from a file, or from stdin when it is `-`. */
function readFromJson(ctx, where) {
  let text
  if (where === '-') {
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (e) {
      throw new CliError('config.stdin-unreadable', `--from-json - could not read stdin: ${e.message}`, 'pipe the JSON in, or pass a file path instead of -')
    }
  } else {
    const r = readJson(path.resolve(ctx.cwd, where))
    if (r.error) throw new CliError('config.answers-unreadable', r.error, 'the payload must be a readable JSON file, or - for stdin')
    if (!r.exists) throw new CliError('config.answers-missing', `${where} does not exist`, 'pass a readable file, or - to read the JSON from stdin')
    return r.data
  }
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''))
  } catch (e) {
    throw new CliError('config.answers-invalid', `the --from-json payload is not valid JSON: ${e.message}`, 'the wizard pipes one JSON object of answers')
  }
}

/** The user file's shape (contract §3), with this repo's entry ready to receive machine answers. */
function userDocumentFor(existing, repoKey) {
  const doc = existing && typeof existing === 'object' && !Array.isArray(existing) ? JSON.parse(JSON.stringify(existing)) : {}
  doc.version = CURRENT_VERSION
  if (!doc.repos || typeof doc.repos !== 'object' || Array.isArray(doc.repos)) doc.repos = {}
  if (!doc.repos[repoKey] || typeof doc.repos[repoKey] !== 'object' || Array.isArray(doc.repos[repoKey])) doc.repos[repoKey] = {}
  return doc
}

function applyAnswers(ctx, answers, requestedScope) {
  const repoKey = ctx.facts.repoKey
  const projectBefore = readJson(ctx.paths.projectFile)
  const userBefore = readJson(ctx.paths.userFile)
  if (projectBefore.error) throw new CliError('config.file.unreadable', projectBefore.error, 'fix or delete the file, then re-run')
  if (userBefore.error) throw new CliError('config.file.unreadable', userBefore.error, 'fix or delete the file, then re-run')

  const projectDoc = projectBefore.data && typeof projectBefore.data === 'object' ? JSON.parse(JSON.stringify(projectBefore.data)) : {}
  projectDoc.version = CURRENT_VERSION
  const userDoc = userDocumentFor(userBefore.data, repoKey)

  const wrote = { project: [], user: [] }
  const warnings = []
  for (const [key, value] of answers) {
    const target = targetFileFor(key, requestedScope[key] || null)
    const entry = SCHEMA_BY_KEY.get(key)
    if (target === 'user' && entry.scope === 'project') {
      // Allowed but noisy: resolve.mjs reports it as `config.local-divergence`, because a
      // project-scope value set per machine desynchronises that machine from everyone else's.
      warnings.push({ code: 'config.local-divergence', key, message: `project-scope key "${key}" is being written to the user layer (local divergence)` })
    }
    if (target === 'project') { setPath(projectDoc, key, value); wrote.project.push(key) }
    else { setPath(userDoc.repos[repoKey], key, value); wrote.user.push(key) }
  }

  return {
    repoKey,
    warnings,
    files: [
      { scope: 'project', file: ctx.paths.projectFile, before: projectBefore.exists ? renderJson(projectBefore.data) : null, after: renderJson(projectDoc), doc: projectDoc, keys: wrote.project },
      { scope: 'user', file: ctx.paths.userFile, before: userBefore.exists ? renderJson(userBefore.data) : null, after: renderJson(userDoc), doc: userDoc, keys: wrote.user },
    ],
  }
}

function init(ctx, args) {
  const where = stringFlag(args.flags, 'from-json')
  if (!where) throw new CliError('config.init-needs-json', 'fleet config init needs --from-json <file|->', 'the wizard builds the accepted answers as JSON and pipes them in')
  const dryRun = !!args.flags['dry-run']
  const { answers, scope } = readAnswers(readFromJson(ctx, where))
  if (!answers.size) throw new CliError('config.no-answers', 'the --from-json payload contained no config keys', 'the payload is an object of dotted keys, or {"answers": {...}}')

  const plan = applyAnswers(ctx, answers, scope)
  const files = plan.files.map(f => ({
    scope: f.scope,
    file: f.file,
    keys: f.keys,
    // A file that received no answers is not created just to stamp a version into it: an empty
    // .fleet/config.json reads as "this repo is configured" to every later status check.
    changed: (f.keys.length > 0 || f.before !== null) && f.before !== f.after,
    diff: unifiedDiff(f.before, f.after, f.before === null ? '/dev/null' : f.file, f.file),
  }))

  if (!dryRun) {
    for (const f of plan.files) {
      if (files.find(x => x.file === f.file).changed) writeJsonAtomic(f.file, f.doc)
    }
  }

  ctx.json(envelope(true, {
    dryRun,
    repoKey: plan.repoKey,
    files,
    // The same payload either way, so a --dry-run rehearsal and the real write can be compared
    // line for line rather than trusted.
    written: dryRun ? [] : files.filter(f => f.changed).map(f => f.file),
    warnings: [...plan.warnings, ...ctx.warnings],
  }))
  ctx.log(`config init${dryRun ? ' --dry-run' : ''}: ${files.filter(f => f.changed).map(f => `${f.scope} (${f.keys.length} key${f.keys.length === 1 ? '' : 's'})`).join(', ') || 'nothing to change'}`)
  return 0
}

// ---- set / get -----------------------------------------------------------------------------------

/** PURE. Coerce a command-line string to the key's declared type. */
export function coerceValue(key, raw) {
  const entry = SCHEMA_BY_KEY.get(key)
  if (!entry) throw new CliError('config.unknown-key', `"${key}" is not a config key`, 'contract §3 lists every key')
  if (isContainerType(entry.type)) {
    try {
      return JSON.parse(raw)
    } catch (e) {
      throw new CliError('config.value-invalid', `${key} is a ${entry.type} and needs JSON: ${e.message}`, `for example: fleet config set ${key} '[]'`)
    }
  }
  const r = coerceEnv(entry, raw)
  if (r.error) throw new CliError('config.value-invalid', `${key}: ${r.error}`, entry.enum ? `one of ${entry.enum.join(' | ')}` : `expected ${entry.type}`)
  // coerceEnv does not police an enum — validateConfig does, one layer later. Writing the file first
  // and reporting the value on the NEXT run would leave the operator's own edit sitting in a
  // committed file, so the refusal happens here, before anything is written.
  if (entry.type === 'enum' && !entry.enum.includes(r.value)) {
    throw new CliError('config.value-invalid', `${key} must be one of ${entry.enum.join(' | ')}, got "${r.value}"`, `for example: fleet config set ${key} ${entry.enum[0]}`)
  }
  return r.value
}

function set(ctx, args, rest) {
  const [key, ...valueParts] = rest
  if (!key || !valueParts.length) throw new CliError('config.set-needs-args', 'fleet config set takes a key and a value', 'fleet config set commands.bootstrap "npm ci" [--scope project|user]')
  const requested = stringFlag(args.flags, 'scope')
  if (requested && requested !== 'project' && requested !== 'user') throw new CliError('config.bad-scope', `--scope takes project or user, got "${requested}"`, 'a user-scope key can only go in the user file')
  const value = coerceValue(key, valueParts.join(' '))
  const target = targetFileFor(key, requested)

  const answers = new Map([[key, value]])
  const plan = applyAnswers(ctx, answers, requested ? { [key]: requested } : {})
  const file = plan.files.find(f => f.scope === target)
  if (file.before !== file.after) writeJsonAtomic(file.file, file.doc)

  ctx.json(envelope(true, {
    key,
    value,
    scope: target,
    file: file.file,
    changed: file.before !== file.after,
    diff: unifiedDiff(file.before, file.after, file.before === null ? '/dev/null' : file.file, file.file),
    warnings: plan.warnings,
  }))
  ctx.log(`config set ${key} → ${target} (${file.file})`)
  return 0
}

function get(ctx, rest) {
  const key = rest[0]
  if (!key) throw new CliError('config.get-needs-key', 'fleet config get takes a key', 'fleet config get paths.stateDir')
  const entry = SCHEMA_BY_KEY.get(key)
  if (!entry) throw new CliError('config.unknown-key', `"${key}" is not a config key`, 'contract §3 lists every key; `fleet config resolve --json` prints them all')
  const value = getPath(ctx.config, key)
  ctx.json(envelope(true, {
    key,
    value,
    // The layer the value came from, so "why is it doing that" is answered by the payload rather
    // than by guessing which file wins.
    source: ctx.sources[key] || 'defaults',
    scope: entry.scope,
    type: entry.type,
    describe: entry.describe || null,
  }))
  ctx.log(`${key} = ${JSON.stringify(value)} (from ${ctx.sources[key] || 'defaults'})`)
  return 0
}

// ---- resolve / sources / validate / migrate ------------------------------------------------------

function resolve(ctx) {
  ctx.json(envelope(true, {
    status: ctx.status,
    repoKey: ctx.facts.repoKey,
    config: ctx.config,
    paths: ctx.paths,
    slots: ctx.slots,
    adapter: ctx.adapter ? { id: ctx.adapter.id, file: ctx.adapter.file } : null,
    warnings: ctx.warnings,
    errors: ctx.errors,
  }))
  ctx.log(`config resolve: stateDir ${ctx.config.paths.stateDir}`)
  return 0
}

function sources(ctx) {
  const bySource = {}
  for (const [key, layer] of Object.entries(ctx.sources)) {
    if (!bySource[layer]) bySource[layer] = []
    bySource[layer].push(key)
  }
  ctx.json(envelope(true, {
    precedence: LAYER_ORDER,
    layers: bySource,
    sources: ctx.sources,
    files: ctx.files,
    warnings: ctx.warnings,
  }))
  ctx.log(`config sources: ${LAYER_ORDER.filter(l => bySource[l]).map(l => `${l} (${bySource[l].length})`).join(' → ')}`)
  return 0
}

function validate(ctx) {
  const ok = ctx.errors.length === 0
  ctx.json(ok
    ? envelope(true, { status: ctx.status, errors: [], warnings: ctx.warnings })
    : envelope(false, {
      status: ctx.status,
      errors: ctx.errors,
      warnings: ctx.warnings,
      error: { code: 'config.invalid', message: `${ctx.errors.length} configuration error(s)`, hint: 'fix each key with `fleet config set`; hand-editing is how a file becomes unreadable and the fleet silently runs on defaults' },
    }))
  ctx.log(ok ? 'config validate: ok' : ctx.errors.map(e => `${e.key || e.code}: ${e.message}`).join('\n'))
  return ok ? 0 : 1
}

function migrate(ctx) {
  const migrated = []
  const alreadyCurrent = []
  for (const layer of ['project', 'project-local', 'user']) {
    const file = layer === 'project' ? ctx.paths.projectFile : layer === 'project-local' ? ctx.paths.projectLocalFile : ctx.paths.userFile
    const r = readJson(file)
    if (!r.exists) continue
    if (r.error) throw new CliError('config.file.unreadable', r.error, 'fix or delete the file, then re-run')
    const version = Number.isInteger(r.data.version) ? r.data.version : CURRENT_VERSION
    if (version >= CURRENT_VERSION) { alreadyCurrent.push(file); continue }
    writeJsonAtomic(file, { ...r.data, version: CURRENT_VERSION })
    migrated.push({ file, from: version, to: CURRENT_VERSION })
  }

  // ⛔ Re-resolved AFTER the write, never `ctx.status`. That one was computed at dispatch time and is
  // still `unmigrated`, whose `missing` is hard-coded empty — so a stale report tells the launcher
  // (Step 0: "then ask only for whatever missing[] it reports") that a repo needing
  // `commands.bootstrap` needs nothing, and it launches an unconfigured repo. Migration stamps the
  // version and touches no other key, so the errors and files already read still describe the file
  // on disk; only the version rows moved, and every one of them is now current.
  const status = statusFor({ config: ctx.config, errors: ctx.errors, files: ctx.files, versions: [], facts: ctx.facts, adapter: ctx.adapter })

  ctx.json(envelope(true, {
    migrated,
    alreadyCurrent,
    version: CURRENT_VERSION,
    // Migration only moves the format forward; whatever a newer format requires is still missing
    // afterwards, and the launcher asks for exactly these and nothing more.
    missing: missingFor(status, ctx),
    status,
  }))
  ctx.log(migrated.length ? `config migrate: ${migrated.length} file(s) to version ${CURRENT_VERSION}` : 'config migrate: every config file is already current')
  return 0
}
