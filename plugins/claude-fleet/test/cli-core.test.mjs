import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run } from '../src/sys/exec.mjs'
import { main } from '../src/cli.mjs'
import { parseArgs, CliError, intFlag, listFlag, FLAGS } from '../src/cli/args.mjs'
import { buildPlan, firstFreeLabel, testingLabel } from '../src/cli/plan.mjs'
import { checkCommand, findCommand, loadCommands } from '../src/cli/registry.mjs'
import { planOptions } from '../src/cli/commands/up.mjs'
import { readAnswers, targetFileFor, unifiedDiff, rankScripts, coerceValue } from '../src/cli/commands/config.mjs'
import { nodeFloor, insideAny } from '../src/cli/commands/doctor.mjs'
import { createFakeBackend } from '../src/backends/fake.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { takenLabels } from '../src/core/fleet.mjs'
import { STATUSES } from '../src/config/load.mjs'

// ---- harness -------------------------------------------------------------------------------------

// realpath, because on macOS os.tmpdir() is /var/… while git answers /private/var/…, and on a Windows
// runner the temp dir arrives as an 8.3 short name — comparing either directly fails a correct
// implementation for the wrong reason.
function tmpRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-')))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* a shell may still hold a cwd inside it; the temp dir is not the test's subject */ }
  })
  return dir
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function git(cwd, args) {
  const r = run('git', ['-C', cwd, ...args], { timeoutMs: 60_000 })
  assert.ok(r.ok, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/**
 * A real repository with one commit, an origin and a package.json — plus an ISOLATED user-config
 * home and state dir.
 *
 * ⛔ The env is built here rather than inherited: without FLEET_CONFIG_HOME the user layer resolves
 * to the machine's real `claude-fleet/config.json`, so the suite would read (and `init` would WRITE)
 * the config of whoever is running it, and pass or fail differently on every machine.
 */
function makeRepo(t, { name = 'app', config = null, pkg = {}, origin = 'https://github.com/acme/app.git' } = {}) {
  const parent = tmpRoot(t)
  const repo = path.join(parent, name)
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  if (origin) git(repo, ['remote', 'add', 'origin', origin])
  writeJson(path.join(repo, 'package.json'), { name, scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' }, ...pkg })
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  if (config) writeJson(path.join(repo, '.fleet', 'config.json'), config)
  const userHome = path.join(parent, 'user-config')
  const stateRoot = path.join(parent, 'state')
  return {
    parent,
    repo,
    userFile: path.join(userHome, 'config.json'),
    projectFile: path.join(repo, '.fleet', 'config.json'),
    // Both variables, so the same fixture isolates the state dir on Windows and on POSIX.
    env: { FLEET_CONFIG_HOME: userHome, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  }
}

/** A project config that reaches status `ok`: both required commands, a tracker and its ready state. */
const OK_CONFIG = Object.freeze({
  version: 1,
  commands: { bootstrap: 'npm run worktree-setup', devServer: 'npm run dev' },
  tracker: { id: 'github', scope: 'acme/app' },
  checker: { ready: { state: 'Todo' } },
})

/**
 * Drive main() with captured streams. Each write is kept separate so "exactly one object" is
 * checkable. `cwd` defaults to the fixture's repo — never the process cwd, which is the plugin's own
 * checkout and carries a real `.fleet/` a test would otherwise read and write.
 */
async function cli(argv, { repo, cwd = repo, env, backend = createFakeBackend() } = {}) {
  const outChunks = []
  const errChunks = []
  const code = await main(argv, {
    stdout: s => outChunks.push(s),
    stderr: s => errChunks.push(s),
    cwd,
    env,
    backend,
  })
  const stdout = outChunks.join('')
  let payload = null
  if (argv.includes('--json') && stdout.trim()) payload = JSON.parse(stdout)
  return { code, stdout, stderr: errChunks.join(''), outChunks, payload }
}

// ---- the JSON envelope ---------------------------------------------------------------------------

test('every command answers with one {"ok", "v": 1} object and puts nothing else on stdout', async t => {
  // The launcher parses stdout. One stray progress line makes the payload unparseable, and a healthy
  // fleet then reads as a broken tool — so the human half of every command goes to stderr instead.
  const f = makeRepo(t, { config: OK_CONFIG })
  const invocations = [
    ['config', 'status'], ['config', 'detect'], ['config', 'resolve'], ['config', 'sources'],
    ['config', 'validate'], ['config', 'migrate'], ['config', 'get', 'paths.stateDir'], ['doctor'],
  ]
  for (const argv of invocations) {
    const r = await cli([...argv, '--json'], f)
    assert.equal(r.outChunks.length, 1, `${argv.join(' ')} wrote ${r.outChunks.length} chunks to stdout`)
    const payload = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(payload).slice(0, 2), ['ok', 'v'], `${argv.join(' ')}: the envelope must start {ok, v}`)
    assert.equal(payload.v, 1)
    assert.equal(typeof payload.ok, 'boolean')
    assert.ok(r.stderr.length > 0, `${argv.join(' ')} should still speak to a human on stderr`)
  }
})

test('without --json the payload is never printed at a human', async t => {
  // The other half of the same rule: an operator reading a wall of JSON stops reading the sentence
  // above it, which is the sentence that says what to do.
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['config', 'status'], f)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /config status: ok/)
  assert.doesNotMatch(r.stdout, /"v":\s*1/)
})

test('an error is {"ok": false, "v": 1, error: {code, message, hint}} with a non-zero exit', async t => {
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['config', 'get', 'no.such.key', '--json'], f)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.v, 1)
  assert.equal(r.payload.error.code, 'config.unknown-key')
  assert.ok(r.payload.error.hint, 'an error without a hint is a dead end')
  assert.notEqual(r.code, 0)
})

// ---- status --------------------------------------------------------------------------------------

test('config status exits 0 for every value in the status enum — including the unconfigured ones', async t => {
  // ⛔ A non-zero exit here makes the launcher read "this repo has never been set up" as a tool
  // failure and abort the very first run, before the wizard it was about to open.
  const seen = new Set()

  const cases = [
    ['needs-init', makeRepo(t, { config: null })],
    ['needs-tracker', makeRepo(t, { config: { ...OK_CONFIG, tracker: {} } })],
    ['needs-checker', makeRepo(t, { config: { ...OK_CONFIG, checker: {} } })],
    ['invalid', makeRepo(t, { config: { ...OK_CONFIG, testing: { count: 'many' } } })],
    ['unmigrated', makeRepo(t, { config: { ...OK_CONFIG, version: 0 } })],
    ['ok', makeRepo(t, { config: OK_CONFIG })],
  ]
  for (const [want, f] of cases) {
    const r = await cli(['config', 'status', '--json'], f)
    assert.equal(r.code, 0, `${want} must still exit 0`)
    assert.equal(r.payload.status, want)
    assert.equal(r.payload.ok, true, 'ok answers "did the command run", never "is the repo configured"')
    assert.ok(r.payload.hint && r.payload.nextAction, `${want} must carry a hint and a nextAction`)
    seen.add(r.payload.status)
  }

  // needs-machine is the one status that is about the shell rather than the files: a directory that
  // is not inside a checkout at all. GIT_CEILING_DIRECTORIES stops git's upward walk, so this holds
  // even when the machine's temp dir happens to live inside somebody's repository.
  const f = makeRepo(t, { config: OK_CONFIG })
  const outside = path.join(f.parent, 'not-a-checkout')
  fs.mkdirSync(outside)
  const before = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = f.parent
  t.after(() => {
    if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = before
  })
  const r = await cli(['config', 'status', '--json'], { ...f, cwd: outside })
  assert.equal(r.code, 0)
  assert.equal(r.payload.status, 'needs-machine')
  assert.ok(r.payload.missing.includes('repo.worktreeParent'), 'needs-machine names what is unresolved here')
  seen.add(r.payload.status)

  assert.deepEqual([...seen].sort(), [...STATUSES].sort(), 'every status in the contract enum must be reachable')
})

test('config status never writes, so it is safe to run in a repo that has never seen this tool', async t => {
  const f = makeRepo(t, { config: null })
  const r = await cli(['config', 'status', '--json'], f)
  assert.equal(r.code, 0)
  assert.equal(fs.existsSync(path.join(f.repo, '.fleet')), false, 'status must not create the project directory')
  assert.equal(fs.existsSync(f.userFile), false, 'status must not create the user config')
  assert.equal(fs.existsSync(r.payload.machine.stateDir), false, 'status must not create the state dir')
})

// ---- flags ---------------------------------------------------------------------------------------

test('an unknown flag is refused rather than ignored — an ignored --dry-run is not a dry run', async t => {
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['config', 'status', '--dryrun', '--json'], f)
  assert.equal(r.code, 2, 'a usage error is a 2: retrying it unchanged can only fail again')
  assert.equal(r.payload.error.code, 'cli.unknown-flag')
  assert.match(r.payload.error.message, /--dryrun/)
})

test('parseArgs: value flags, switches, repeats, -- and the arity traps', () => {
  const a = parseArgs(['up', '4', '--testing', '2', '--issues=ABC-1234,ABC-1240', '--dry-run'])
  assert.equal(a.command, 'up')
  assert.deepEqual(a.positionals, ['4'])
  assert.equal(a.flags.testing, '2')
  assert.equal(a.flags.issues, 'ABC-1234,ABC-1240')
  assert.equal(a.flags['dry-run'], true)

  // Repeats collect: `--evidence a --evidence b` is two pieces of evidence, and last-one-wins
  // silently discards the first every time.
  assert.deepEqual(listFlag(parseArgs(['flag', 'done', '--evidence', 'a.mjs:1', '--evidence', 'b.mjs:2']).flags, 'evidence'), ['a.mjs:1', 'b.mjs:2'])

  // `--` ends flag parsing so a message that starts with a dash is still data.
  assert.deepEqual(parseArgs(['send', '3', '--', '--not-a-flag']).positionals, ['3', '--not-a-flag'])

  // A single dash IS a value (`--from-json -` is stdin); two dashes never are.
  assert.equal(parseArgs(['config', 'init', '--from-json', '-']).flags['from-json'], '-')
  assert.throws(() => parseArgs(['config', 'init', '--from-json', '--dry-run']), /--from-json needs a value/)
  assert.throws(() => parseArgs(['doctor', '--repair=yes']), /takes no value/)
  assert.throws(() => parseArgs(['up', '--nope']), e => e instanceof CliError && e.code === 'cli.unknown-flag')

  // A slot count that silently became 0 reads as "the operator asked for no local pool".
  assert.throws(() => intFlag({ testing: '' }, 'testing'), /whole number/)
  assert.equal(intFlag({ testing: '2' }, 'testing'), 2)
})

test('every flag contract §7 defines is in the parser table — a defined invocation must be typeable', () => {
  // The table is global and an unknown flag is a hard error, so a flag the contract defines but the
  // table omits makes that invocation impossible to type and impossible for any one command module to
  // repair locally. `fleet check ledger reconcile --from findings` was exactly that.
  const md = fs.readFileSync(new URL('../docs/reference/contract.md', import.meta.url), 'utf8')
  const section = md.split(/^## /m).find(s => s.startsWith('7. CLI'))
  assert.ok(section, 'contract §7 must exist for the parser to be checked against it')
  const block = section.match(/```[a-z]*\n([\s\S]*?)```/)[1]
  const defined = [...new Set([...block.matchAll(/--([a-z][a-z0-9-]*)/g)].map(m => m[1]))].sort()
  assert.ok(defined.length > 20, `§7 should define the whole flag surface, found ${defined.length}`)
  const missing = defined.filter(f => !Object.prototype.hasOwnProperty.call(FLAGS, f))
  assert.deepEqual(missing, [], `contract §7 defines flags the parser refuses: ${missing.join(', ')}`)
  assert.equal(parseArgs(['check', 'ledger', 'reconcile', '--from', 'findings']).flags.from, 'findings')
})

test('every flag a command advertises is on that command own line in contract §7', async () => {
  // The reverse direction of the test above, and the one that catches the drift that direction
  // cannot: `fleet watch --once` shipped, parsed and was used by the lifecycle suite for a whole
  // release while §7's `fleet watch` listed no flags — because `--once` was in the table already
  // (`fleet pool` declares it), so a flag-level check over the whole block saw nothing wrong. The
  // contract calls itself the place the grammar is defined once, and the parser's own unknown-flag
  // hint sends the operator there, so a flag missing from ITS OWN line is a documented lie.
  const md = fs.readFileSync(new URL('../docs/reference/contract.md', import.meta.url), 'utf8')
  const block = md.split(/^## /m).find(s => s.startsWith('7. CLI')).match(/```[a-z]*\n([\s\S]*?)```/)[1]
  const byCmd = new Map()
  let current = null
  for (const line of block.split(/\n/)) {
    for (const seg of line.split('·').map(x => x.trim()).filter(Boolean)) {
      const m = /^fleet\s+([a-z][a-z-]*)/.exec(seg)
      // A segment that does not open with `fleet <name>` is a continuation or a gloss of the command
      // above it — `--slot`/`--once` under `fleet pool`, the second line of `fleet check plan`. Those
      // flags belong to that command; dropping them made this test blind to exactly the drift it is
      // here to catch.
      if (m) current = m[1]
      if (!current) continue
      const set = byCmd.get(current) || new Set()
      for (const f of seg.matchAll(/--([a-z][a-z0-9-]*)/g)) set.add(f[1])
      byCmd.set(current, set)
    }
  }
  const drift = []
  const known = new Set()
  for (const c of await loadCommands()) {
    known.add(c.name)
    const have = byCmd.get(c.name)
    if (!have) { drift.push(`${c.name}: no §7 line at all`); continue }
    // `--json` is granted to every command by the sentence under the block, not per line.
    const missing = [...new Set([...c.usage.matchAll(/--([a-z][a-z0-9-]*)/g)].map(m => m[1]))]
      .filter(f => f !== 'json' && !have.has(f))
    if (missing.length) drift.push(`${c.name}: §7 omits ${missing.map(f => '--' + f).join(', ')}`)
  }
  // And the other direction: a command §7 defines with NO module reaches `unknown command`, which is
  // worse than a refusal — the operator is told the verb does not exist while the contract says it
  // does. `fleet cloud dispatch` was exactly that.
  for (const name of byCmd.keys()) {
    if (!known.has(name)) drift.push(`${name}: contract §7 defines it and no module handles it`)
  }
  assert.deepEqual(drift, [], `a command advertises flags its contract line does not: ${drift.join('; ')}`)
})

test('--version answers with the version, not the command listing', async t => {
  // `fleet --version` carries no command, so a `!args.command` branch tested first swallows it: a
  // --json caller asking for the version would get a help envelope with no version key in it.
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['--version', '--json'], f)
  assert.equal(r.code, 0)
  assert.match(String(r.payload.version), /^\d+\.\d+\.\d+/)
  assert.equal(r.payload.commands, undefined, 'a version question is not answered with a command listing')

  const human = await cli(['--version'], f)
  assert.equal(human.code, 0)
  assert.match(human.stdout.trim(), /^\d+\.\d+\.\d+/)

  // `fleet` alone is still the help listing.
  const bare = await cli(['--json'], f)
  assert.ok(Array.isArray(bare.payload.commands))
})

test('a --json after -- is data, not a mode switch', async t => {
  // Everything past the terminator is text the operator passed — a ticket title, a message, a
  // comment — and the parser already treats it that way. A raw argv scan that disagreed would flip
  // stdout into machine mode because somebody's sentence contained the word, which is the
  // "exactly one object" contract broken from the other side.
  const f = makeRepo(t, { config: OK_CONFIG })
  const outChunks = []
  const errChunks = []
  const code = await main(['config', 'status', '--', '--json'], {
    stdout: s => outChunks.push(s),
    stderr: s => errChunks.push(s),
    cwd: f.repo,
    env: f.env,
    backend: createFakeBackend(),
  })
  assert.equal(code, 0)
  assert.match(outChunks.join(''), /config status: ok/)
  assert.doesNotMatch(outChunks.join(''), /"v":\s*1/, 'the human read a sentence, not a payload')
  assert.deepEqual(parseArgs(['config', 'status', '--', '--json']).positionals, ['status', '--json'])
})

// ---- dispatch ------------------------------------------------------------------------------------

test('an unknown command exits 2 and the hint names the commands that do exist', async t => {
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['frobnicate', '--json'], f)
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'cli.unknown-command')
  assert.match(r.payload.error.hint, /config/)
  assert.match(r.payload.error.hint, /doctor/)
})

test('the registry refuses a module that does not satisfy the command contract, at load', async () => {
  // A half-written command must fail here rather than at 3am on the one invocation that reaches it.
  assert.deepEqual(checkCommand({ name: 'x', usage: 'x', needsConfig: false, needsBackend: false, run: () => 0 }, 'x.mjs'), [])
  assert.ok(checkCommand({ name: 'x' }, 'x.mjs').length >= 3)

  // A module declaring `sub` wins over the generic one: `check ledger append` and `check plan` are
  // separate modules under one name, and first-match would hand every sub to whichever was listed first.
  const generic = { name: 'check', usage: '', needsConfig: false, needsBackend: false, run: () => 0 }
  const specific = { ...generic, sub: 'plan' }
  assert.equal(findCommand([generic, specific], 'check', 'plan'), specific)
  assert.equal(findCommand([generic, specific], 'check', 'ledger'), generic)
  assert.equal(findCommand(await loadCommands(), 'config', 'status').name, 'config')

  // ⛔ The warm cache is keyed by the file list. A cache that answered any `files` with whatever the
  // first call loaded would hand this caller the real command table and report success — so the
  // refusal above would be unreachable in every process that has already dispatched one command.
  await assert.rejects(
    () => loadCommands({ files: ['./args.mjs'] }),
    e => e.code === 'cli.bad-command-module',
  )
  assert.equal(findCommand(await loadCommands(), 'doctor').name, 'doctor', 'the real table survives a rejected list')
})

// ---- config init ---------------------------------------------------------------------------------

test('init REFUSES a user-scope key in the committed project file, and writes neither file', async t => {
  // That refusal is what keeps a published config company- and machine-independent: a worktree parent
  // or a branch prefix committed to the shared file takes effect for everyone who clones the repo.
  const f = makeRepo(t, { config: OK_CONFIG })
  const answers = path.join(f.parent, 'answers.json')
  writeJson(answers, { answers: { 'repo.worktreeParent': '/somebody/elses/machine' }, scope: { 'repo.worktreeParent': 'project' } })
  const projectBefore = fs.readFileSync(f.projectFile, 'utf8')

  const r = await cli(['config', 'init', '--from-json', answers, '--json'], f)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.error.code, 'config.scope.refused')
  assert.notEqual(r.code, 0)
  assert.equal(fs.readFileSync(f.projectFile, 'utf8'), projectBefore, 'a refusal writes nothing at all')
  assert.equal(fs.existsSync(f.userFile), false)

  // A secret in the committed file is refused the same way — the project file holds the NAME of an
  // env var, never a value.
  assert.throws(() => targetFileFor('tracker.rest.tokenEnv', 'project'), e => e.code === 'config.secret.committed')
  // Unasked, the same key routes itself to the machine's file rather than failing.
  assert.equal(targetFileFor('repo.worktreeParent', null), 'user')
  assert.equal(targetFileFor('commands.bootstrap', null), 'project')
  assert.equal(targetFileFor('testing.count', 'user'), 'user', '"either" goes wherever the operator asks')
})

test('init splits answers by scope, writes atomically, and --dry-run shows the same plan without writing', async t => {
  const f = makeRepo(t, { config: null })
  const answers = path.join(f.parent, 'answers.json')
  writeJson(answers, {
    answers: {
      'commands.bootstrap': 'npm run worktree-setup',
      'commands.devServer': 'npm run dev',
      'repo.worktreeParent': f.parent,
      'fleet.size': 6,
    },
  })

  const dry = await cli(['config', 'init', '--from-json', answers, '--dry-run', '--json'], f)
  assert.equal(dry.code, 0)
  assert.equal(dry.payload.dryRun, true)
  assert.deepEqual(dry.payload.written, [], '--dry-run writes nothing')
  assert.equal(fs.existsSync(f.projectFile), false)
  assert.equal(fs.existsSync(f.userFile), false)
  const project = dry.payload.files.find(x => x.scope === 'project')
  const user = dry.payload.files.find(x => x.scope === 'user')
  // [...] before sort: sorting in place would mutate the payload the next assertion compares against
  assert.deepEqual([...project.keys].sort(), ['commands.bootstrap', 'commands.devServer'])
  assert.deepEqual([...user.keys].sort(), ['fleet.size', 'repo.worktreeParent'])
  assert.match(project.diff, /^--- /, 'the operator sees a diff of both files before anything is written')
  assert.match(project.diff, /\+.*worktree-setup/)

  const wrote = await cli(['config', 'init', '--from-json', answers, '--json'], f)
  assert.equal(wrote.code, 0)
  // The same payload either way, so the rehearsal and the real write can be compared rather than trusted.
  assert.deepEqual(wrote.payload.files.map(x => x.keys), dry.payload.files.map(x => x.keys))
  const written = JSON.parse(fs.readFileSync(f.projectFile, 'utf8'))
  assert.equal(written.commands.bootstrap, 'npm run worktree-setup')
  assert.equal(written.version, 1)
  assert.equal(written.repo, undefined, 'the machine answer never reaches the committed file')
  const userDoc = JSON.parse(fs.readFileSync(f.userFile, 'utf8'))
  assert.equal(userDoc.repos['github.com/acme/app'].fleet.size, 6)
  // No temp file survives: nothing in the plugin ever sweeps one, so a leak sits there forever.
  assert.deepEqual(fs.readdirSync(path.dirname(f.projectFile)), ['config.json'])
})

test('init refuses a payload that is not answers at all, rather than writing an empty config', async t => {
  const f = makeRepo(t, { config: null })
  const answers = path.join(f.parent, 'answers.json')
  writeJson(answers, { answers: { 'commands.bootstrp': 'npm ci' } })
  const r = await cli(['config', 'init', '--from-json', answers, '--json'], f)
  assert.equal(r.payload.error.code, 'config.unknown-key')
  assert.equal(fs.existsSync(f.projectFile), false)

  // A nested object and a flat dotted map are the same answers; a typo in either is still refused.
  assert.deepEqual([...readAnswers({ commands: { bootstrap: 'npm ci' } }).answers], [['commands.bootstrap', 'npm ci']])
  assert.deepEqual([...readAnswers({ 'commands.bootstrap': 'npm ci' }).answers], [['commands.bootstrap', 'npm ci']])
  assert.throws(() => readAnswers({ scope: { 'testing.count': 'somewhere' } }), /must be "project" or "user"/)
})

// ---- config set / get / detect ---------------------------------------------------------------------

test('config set coerces by the schema type and lands in the scope-correct file', async t => {
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['config', 'set', 'testing.count', '2', '--json'], f)
  assert.equal(r.code, 0)
  assert.equal(r.payload.scope, 'project')
  assert.equal(JSON.parse(fs.readFileSync(f.projectFile, 'utf8')).testing.count, 2, 'a count is written as a number, not as "2"')

  const machine = await cli(['config', 'set', 'fleet.size', '9', '--json'], f)
  assert.equal(machine.payload.scope, 'user')
  assert.equal(JSON.parse(fs.readFileSync(f.userFile, 'utf8')).repos['github.com/acme/app'].fleet.size, 9)

  const refused = await cli(['config', 'set', 'fleet.size', '9', '--scope', 'project', '--json'], f)
  assert.equal(refused.payload.error.code, 'config.scope.refused')

  assert.equal(coerceValue('testing.count', '2'), 2)
  assert.equal(coerceValue('vcs.pr.draft', 'no'), false)
  assert.deepEqual(coerceValue('capture.accounts', 'a,b'), ['a', 'b'])
  assert.throws(() => coerceValue('testing.count', 'many'), /expected an integer/)
  assert.throws(() => coerceValue('terminal.layout', 'diagonal'), /windows \| tiled-panes \| pixel-grid/)
})

test('config get answers with the value AND the layer it came from', async t => {
  // "Why is it doing that" is answered by the payload; guessing which file wins is how an operator
  // edits the file that is being overridden.
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['config', 'get', 'commands.bootstrap', '--json'], { ...f, env: { ...f.env, FLEET_COMMANDS_BOOTSTRAP: 'npm ci --ignore-scripts' } })
  assert.equal(r.payload.value, 'npm ci --ignore-scripts')
  assert.equal(r.payload.source, 'env')
  assert.equal(r.payload.scope, 'project')
})

test('config detect proposes with a source for every row, and writes nothing', async t => {
  const f = makeRepo(t, { config: null })
  const r = await cli(['config', 'detect', '--json'], f)
  assert.equal(r.code, 0)
  assert.equal(r.payload.writes, false)
  assert.equal(fs.existsSync(path.join(f.repo, '.fleet')), false)
  const by = Object.fromEntries(r.payload.proposal.map(x => [x.key, x]))
  assert.equal(by['commands.bootstrap'].proposed, 'npm run worktree-setup')
  assert.match(by['commands.bootstrap'].source, /score/)
  assert.equal(by['commands.devServer'].proposed, 'npm run dev')
  // The arithmetic, not only the number: an operator who cannot see why 6 is 6 cannot raise it.
  assert.match(by['fleet.size'].source, /floor\(\(\d+ - \d+\) \/ \d+\)/)
  assert.equal(by['vcs.branchPrefix'].proposed, 'ada')
  assert.equal(by['tracker.defaultAssignee'].proposed, 'me', 'the assignee is the sentinel, never a name or an email')
  assert.equal(by['repo.worktreeParent'].scope, 'user')
  assert.equal(by['commands.bootstrap'].scope, 'project')
  for (const p of r.payload.proposal) assert.ok(p.source, `${p.key} must say where it came from`)
})

test('rankScripts scores by script NAME, and two close candidates are a question rather than a proposal', () => {
  // Scoring a script's BODY once ranked the release pipeline above the dev server: "build" and "test"
  // appear in almost every script.
  const ranked = rankScripts({ 'worktree-setup': 'npm ci', test: 'vitest', bootstrap: 'npm ci' }, [[/worktree/i, 0.95], [/bootstrap/i, 0.92]])
  assert.deepEqual(ranked.map(r => r.name), ['worktree-setup', 'bootstrap'])
  assert.equal(rankScripts({ test: 'vitest' }, [[/worktree/i, 0.95]]).length, 0)
})

// ---- validate / migrate ----------------------------------------------------------------------------

test('config validate fails loudly on a broken value, and migrate stamps an old file forward', async t => {
  const bad = makeRepo(t, { config: { ...OK_CONFIG, testing: { count: 'many' } } })
  const v = await cli(['config', 'validate', '--json'], bad)
  assert.equal(v.code, 1)
  assert.equal(v.payload.ok, false)
  assert.equal(v.payload.error.code, 'config.invalid')
  assert.ok(v.payload.errors.some(e => e.key === 'testing.count'))

  const old = makeRepo(t, { config: { ...OK_CONFIG, version: 0 } })
  const before = await cli(['config', 'status', '--json'], old)
  assert.equal(before.payload.status, 'unmigrated')
  const m = await cli(['config', 'migrate', '--json'], old)
  assert.equal(m.code, 0)
  assert.deepEqual(m.payload.migrated.map(x => x.from), [0])
  assert.equal(JSON.parse(fs.readFileSync(old.projectFile, 'utf8')).version, 1)
  const after = await cli(['config', 'status', '--json'], old)
  assert.equal(after.payload.status, 'ok')
})

test('config migrate reports the status it LEAVES, not the one it found', async t => {
  // ⛔ Launcher Step 0 for `unmigrated` is "`fleet config migrate`, then ask only for whatever
  // missing[] it reports". Reporting the pre-write status means reporting `unmigrated`, whose
  // missing[] is empty by definition — so the launcher asks for nothing and launches a repo with no
  // bootstrap command.
  const f = makeRepo(t, { config: { version: 0, tracker: { id: 'github', scope: 'acme/app' }, checker: { ready: { state: 'Todo' } } } })
  const before = await cli(['config', 'status', '--json'], f)
  assert.equal(before.payload.status, 'unmigrated')

  const m = await cli(['config', 'migrate', '--json'], f)
  assert.equal(m.code, 0)
  assert.deepEqual(m.payload.migrated.map(x => x.from), [0])
  assert.notEqual(m.payload.status, 'unmigrated', 'the file it just wrote is current')

  // The very next status read must agree with what migrate said, key for key.
  const next = await cli(['config', 'status', '--json'], f)
  assert.equal(m.payload.status, next.payload.status)
  assert.deepEqual([...m.payload.missing].sort(), [...next.payload.missing].sort())
  assert.equal(m.payload.status, 'needs-init')
  assert.ok(m.payload.missing.includes('commands.bootstrap'), `migrate must name what is still missing: ${JSON.stringify(m.payload.missing)}`)
})

test('unifiedDiff hunks an absent file from line 0, not line 1', () => {
  // `@@ -1,0` is what a patch tool rejects; the operator's whole reason to run --dry-run is to read
  // this before anything is written.
  const d = unifiedDiff(null, 'a\nb\n', '/dev/null', 'config.json')
  assert.match(d, /^--- \/dev\/null\n\+\+\+ config\.json\n@@ -0,0 \+1,3 @@/)
  assert.equal(unifiedDiff('same\n', 'same\n'), '')
  assert.match(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n'), /- b\n\+ B/)
})

// ---- doctor ----------------------------------------------------------------------------------------

test('doctor reports every probe, and ECHOES the derived rogue-server pattern for a human to read', async t => {
  // A false positive in that pattern is what tree-kills a working session's own build or test run, so
  // the line has to be in front of the operator every single run rather than in a config file.
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['doctor', '--json'], f)
  const by = Object.fromEntries(r.payload.probes.map(p => [p.name, p]))
  // `capture` is here because a fleet whose capture is unconfigured used to say NOTHING: capture.mode
  // defaults to local, capture.runner to null, and every review page came out reading
  // "No screenshots." with no error anywhere to explain it.
  assert.deepEqual(Object.keys(by).sort(), ['artifacts-dir', 'capture', 'dev-server-pattern', 'git', 'node', 'repo', 'services', 'state-dir', 'terminal-backend', 'tracker-adapter'].sort())
  assert.match(by['capture'].detail, /capture\.mode = local/)
  assert.match(by['capture'].detail, /bundled runner/, 'an unset capture.runner names what will be used instead')
  for (const p of r.payload.probes) assert.equal(typeof p.detail, 'string', `${p.name} must carry a detail`)
  assert.match(by['dev-server-pattern'].detail, /devServer\.serverProcessPattern = server\\\.mjs/)
  assert.equal(by['terminal-backend'].ok, true, 'the injected backend is what doctor probes')
  assert.match(by['terminal-backend'].detail, /fake/)
  assert.equal(by['artifacts-dir'].ok, true)
  assert.equal(by['state-dir'].ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.payload.ok, true)
})

test('doctor calls out a local capture with no slot to capture against', async t => {
  // ⛔ The silent combination that shipped PRs with no evidence: capture.mode local (the default)
  // with testing.count 0 means there is no dev server anywhere to point a browser at, so every
  // session skips capture entirely and says so nowhere. It is a FAILED probe, not a note.
  const f = makeRepo(t, { config: { ...OK_CONFIG, testing: { count: 0 } } })
  const r = await cli(['doctor', '--json'], f)
  const by = Object.fromEntries(r.payload.probes.map(p => [p.name, p]))
  assert.equal(by['capture-slot'].ok, false)
  assert.match(by['capture-slot'].detail, /testing\.count is 0/)
  assert.match(by['capture-slot'].hint, /silently takes no screenshots/)
})

test('doctor says nothing about capture when the repo has opted out', async t => {
  // capture.mode none is a deliberate answer — nagging about it would train operators to ignore the probe.
  const f = makeRepo(t, { config: { ...OK_CONFIG, capture: { mode: 'none' } } })
  const r = await cli(['doctor', '--json'], f)
  const names = r.payload.probes.map(p => p.name)
  assert.ok(!names.includes('capture'), 'no capture probe')
  assert.ok(!names.includes('capture-slot'), 'and no slot probe')
})

test('doctor answers on a machine with no terminal backend instead of refusing to run', async t => {
  // A doctor that cannot start because the machine is broken cannot tell the operator the machine is
  // broken — so it declares needsBackend: false and probes for itself.
  //
  // The configured backend is the one that CANNOT exist on this platform whatever is installed: tmux
  // tears a session down by signalling a POSIX process group, which win32 has not got, and Windows
  // Terminal exists only on win32. Asking for "tmux" everywhere and then asserting only `if the probe
  // failed` deletes this whole test on any machine that happens to have tmux.
  //
  // It arrives through the environment because `terminal.backend` is a user-scope key: written into
  // the committed project file it is IGNORED with a `config.scope.leak` warning, so a fixture that
  // asks for it there is really testing whatever this machine resolves `auto` to.
  const impossible = process.platform === 'win32' ? 'tmux' : 'windows-terminal'
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['doctor', '--json'], { ...f, env: { ...f.env, FLEET_TERMINAL_BACKEND: impossible }, backend: null })
  const by = Object.fromEntries(r.payload.probes.map(p => [p.name, p]))
  assert.ok(by['terminal-backend'], 'the probe still ran')
  assert.equal(typeof by['terminal-backend'].detail, 'string')
  assert.equal(by['terminal-backend'].ok, false)
  assert.ok(by['terminal-backend'].hint, 'a failed probe carries what to do about it')
  assert.equal(r.code, 1)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.error.code, 'doctor.failed')
  // …and it is an ANSWER: every other probe still ran and is in the payload.
  assert.ok(by['git'] && by['state-dir'] && by['dev-server-pattern'])
})

test('doctor --verify-primary refuses an empty install reference', async t => {
  // An empty reference passes every broken worktree in the fleet: the proof compares per-package file
  // counts against this tree, so "nothing to compare" must never read as "everything matches".
  const f = makeRepo(t, { config: OK_CONFIG })
  const r = await cli(['doctor', '--verify-primary', '--json'], f)
  const by = Object.fromEntries(r.payload.probes.map(p => [p.name, p]))
  assert.equal(by['install-reference'].ok, false)
  assert.match(by['install-reference'].detail, /not installed|no packages/)
  assert.equal(r.code, 1)
  assert.equal(r.payload.reference.usable, false)
})

test('doctor: the node floor is a LOWER bound, and an unreadable range never blocks a launch', () => {
  assert.equal(nodeFloor('>=20'), 20)
  // ⛔ `<23` is a ceiling, not a floor. Reading it as one fails the probe on 20 and 22 — the majors
  // the range actually permits — and doctor then exits 1 with `doctor.failed` on a healthy machine,
  // which the launcher playbook answers by refusing to launch at all.
  assert.equal(nodeFloor('>=20.11.0 <23'), 20)
  assert.equal(nodeFloor('>=18 <21'), 18)
  assert.equal(nodeFloor('<21'), null, 'a range naming no lower bound has no floor to check')
  assert.equal(nodeFloor(null), null)
  assert.equal(nodeFloor('lts/*'), null, 'a range this cannot read is unknown, never a refusal')
  // A prefix test would call `<parent>-notes` a child of `<parent>`.
  assert.equal(insideAny('/w/app-session-1/x', ['/w/app-session-1']), true)
  assert.equal(insideAny('/w/app-session-10', ['/w/app-session-1']), false)
  // Case folding follows the FILESYSTEM: one directory on Windows, two on Linux. Folding
  // unconditionally fails the artifacts-dir probe over a false positive and blocks a launch.
  assert.equal(insideAny('C:\\w\\App\\dev-pages', ['C:/w/app'], 'win32'), true)
  assert.equal(insideAny('/w/App/dev-pages', ['/w/app'], 'linux'), false)
  assert.equal(insideAny('/w/app/dev-pages', ['/w/app'], 'linux'), true)
})

test('doctor passes the node probe for a range whose upper bound this Node is under', async t => {
  // The end-to-end half of the floor rule: a repo declaring a range this Node satisfies must not be
  // told to install another one, because the playbook does not launch on a red probe.
  const f = makeRepo(t, { config: OK_CONFIG, pkg: { engines: { node: '>=18 <99' } } })
  const r = await cli(['doctor', '--json'], f)
  const by = Object.fromEntries(r.payload.probes.map(p => [p.name, p]))
  assert.equal(by.node.ok, true, `node ${process.versions.node} satisfies ">=18 <99": ${by.node.detail}`)
  assert.equal(r.code, 0)
})

// ---- the plan ---------------------------------------------------------------------------------------

/** A resolved-shaped config for the pure planner: defaults plus the two machine facts it needs. */
function planConfig(over = {}) {
  const c = defaultsFor()
  setPath(c, 'repo.name', 'app')
  setPath(c, 'repo.worktreeParent', '/w')
  setPath(c, 'fleet.size', 3)
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}
const FACTS = { machine: { platform: 'linux' } }

test('buildPlan numbers past every taken label — a leftover FOLDER counts as taken', t => {
  // `git worktree remove --force` routinely deregisters a tree and then fails to delete its
  // directory, so numbering from the registry alone hands out a number whose folder already holds a
  // half-installed dependency tree — which every cheap check then calls healthy.
  const parent = tmpRoot(t)
  fs.mkdirSync(path.join(parent, 'app-session-3'))
  fs.mkdirSync(path.join(parent, 'app-session-1'))
  const taken = takenLabels({ worktreeParent: parent, repoName: 'app' })
  assert.deepEqual(taken, ['1', '3'])

  const plan = buildPlan({ options: { n: 2, testing: 0 }, existing: { taken }, config: planConfig(), facts: FACTS })
  assert.deepEqual(plan.map(p => p.label), ['4', '5'], 'the free hole at 2 is NOT reused')
  assert.deepEqual(plan.map(p => p.worktree), ['/w/app-session-4', '/w/app-session-5'])
  assert.deepEqual(plan.map(p => p.branch), [null, null], 'a working worktree is created detached; the branch needs a ticket slug it has not got yet')
  assert.equal(firstFreeLabel(['1', '3', 't1', { label: '7' }]), 8)
})

test('buildPlan: testing slots come first, carry slot/port/url, and never consume a session number', () => {
  const plan = buildPlan({ options: { n: 2, testing: 2 }, existing: { taken: ['1'] }, config: planConfig(), facts: FACTS })
  assert.deepEqual(plan.map(p => p.label), ['t1', 't2', '2', '3'])
  const [t1, t2] = plan
  assert.equal(t1.role, 'testing')
  assert.deepEqual([t1.branch, t2.branch], ['testing', 'testing-2'])
  assert.deepEqual([t1.port, t2.port], [3000, 3001])
  assert.deepEqual([t1.worktree, t2.worktree], ['/w/app-testing', '/w/app-testing-2'])
  assert.equal(t1.url, 'http://localhost:3000')
  assert.equal(testingLabel(1), 't1')
  // A slot whose agent is still in the registry is not re-spawned: two dev servers on one port is
  // what "a testing window opens only on first creation" exists to prevent.
  const reused = buildPlan({ options: { n: 0, testing: 1 }, existing: { taken: [], sessions: [{ label: 't1', liveness: 'alive' }] }, config: planConfig(), facts: FACTS })
  assert.equal(reused[0].isNew, false)
  const dead = buildPlan({ options: { n: 0, testing: 1 }, existing: { taken: [], sessions: [{ label: 't1', liveness: 'dead' }] }, config: planConfig(), facts: FACTS })
  assert.equal(dead[0].isNew, true)
})

test('buildPlan: --issues is one session per key, and a count that disagrees is refused', () => {
  const plan = buildPlan({ options: { issues: 'ABC-1234,ABC-1240', testing: 0 }, existing: {}, config: planConfig(), facts: FACTS })
  assert.deepEqual(plan.map(p => p.issue), ['ABC-1234', 'ABC-1240'])
  assert.deepEqual(plan.map(p => p.label), ['1', '2'])
  // Opening a session with no issue leaves an agent with nothing to work; dropping a key launches
  // fewer sessions than were asked for and never says which one was lost.
  assert.throws(
    () => buildPlan({ options: { add: 3, issues: ['ABC-1234'], testing: 0 }, existing: {}, config: planConfig(), facts: FACTS }),
    e => e.code === 'plan.count-mismatch',
  )
  // Two counts that disagree are the same silent drop: `fleet up 6 --add 2` planning 2 loses four
  // sessions the operator typed and never says which number was lost.
  assert.throws(
    () => buildPlan({ options: { n: 6, add: 2, testing: 0 }, existing: {}, config: planConfig(), facts: FACTS }),
    e => e.code === 'plan.count-conflict',
  )
  // The same number under both spellings is not a disagreement.
  assert.equal(buildPlan({ options: { n: 2, add: 2, testing: 0 }, existing: {}, config: planConfig(), facts: FACTS }).length, 2)
})

test('an add leaves the testing pool exactly as it is', () => {
  // Contract §7 and launcher Step 5c: `--add k` adds working sessions "with the testing pool left
  // exactly as it is". A slot planned behind an operator who typed `fleet add 2` is a worktree, a
  // dev-server window and a port nobody asked for — and where a slot is running but its descriptor
  // was reclaimed, `isNew` is true and that is a second dev server on slot 1's port.
  const added = buildPlan({ options: { add: 2 }, existing: { taken: ['1', '2'] }, config: planConfig(), facts: FACTS })
  assert.deepEqual(added.map(p => p.label), ['3', '4'])
  assert.equal(added.some(p => p.role === 'testing'), false, 'an add plans no slot of its own')

  // `--add 0 --testing 1` is still the playbook's on-demand slot: there the operator said so.
  const onDemand = buildPlan({ options: { add: 0, testing: 1 }, existing: {}, config: planConfig(), facts: FACTS })
  assert.deepEqual(onDemand.map(p => p.label), ['t1'])

  // A bare `fleet up` still gets the configured pool — the default belongs to `up` alone.
  const up = buildPlan({ options: { n: 1 }, existing: {}, config: planConfig(), facts: FACTS })
  assert.deepEqual(up.map(p => p.role), ['testing', 'working'])
})

test('buildPlan refuses more slots than the slot table has rows, and a disabled pool', () => {
  // The slot table is testing.maxSlots rows long: branch names, ports and URLs exist for those rows
  // and no others, so an extra slot would be a session with no URL to serve.
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 5 }, existing: {}, config: planConfig(), facts: FACTS }),
    e => e.code === 'plan.too-many-slots',
  )
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 1 }, existing: {}, config: planConfig({ 'testing.enabled': false }), facts: FACTS }),
    e => e.code === 'plan.testing-disabled',
  )
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 0 }, existing: {}, config: planConfig({ 'repo.worktreeParent': null }), facts: FACTS }),
    e => e.code === 'plan.machine-unresolved',
  )
  // A checker branch with an unrendered {sweepId} is not a branch name.
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 0, role: 'checker' }, existing: {}, config: planConfig(), facts: FACTS }),
    e => e.code === 'plan.checker-needs-sweep',
  )
  const checkers = buildPlan({ options: { n: 1, testing: 0, role: 'checker', sweepId: '2026-03-14-a', slices: ['a01'] }, existing: {}, config: planConfig(), facts: FACTS })
  assert.equal(checkers[0].branch, 'check/2026-03-14-a/a01')
  assert.equal(checkers[0].worktree, '/w/app-check-a01')
})

test('`fleet up --role checker` can be typed: --sweep-id carries the id buildPlan requires', () => {
  // The guard above is right, but for a release nothing could satisfy it: `fleet up` accepted --role
  // and passed no sweepId, and the parser refused --sweep-id as unknown — so the documented checker
  // role threw `plan.checker-needs-sweep` on every invocation, and the hint pointed at `fleet check
  // plan`, a command that does not exist yet either.
  const opts = planOptions(parseArgs(['up', '--role', 'checker', '--sweep-id', 'ABC-1234']))
  assert.equal(opts.role, 'checker')
  assert.equal(opts.sweepId, 'ABC-1234')
  const plan = buildPlan({ options: { ...opts, n: 1, testing: 0, slices: ['a01'] }, existing: {}, config: planConfig(), facts: FACTS })
  assert.equal(plan[0].branch, 'check/ABC-1234/a01')

  // `fleet add --role checker` takes it too — adding to a checker fleet is the same launch.
  assert.equal(planOptions(parseArgs(['add', '--role', 'checker', '--sweep-id', 'ABC-1234']), { verb: 'add' }).sweepId, 'ABC-1234')

  // It names <stateDir>/sweeps/<id>/ as well as the branch, so a separator is refused at the flag
  // rather than rendered into a branch nobody meant and a directory outside the sweeps tree.
  assert.throws(() => planOptions(parseArgs(['up', '--role', 'checker', '--sweep-id', '../escape'])), e => e.code === 'up.bad-sweep-id')
  assert.equal(planOptions(parseArgs(['up'])).sweepId, null)
})

test('buildPlan refuses a folder template that would put a worktree outside the worktree parent', () => {
  // Teardown, numbering and the leftover sweep all only look under repo.worktreeParent; a rendered
  // separator puts the tree where none of them will ever find it.
  assert.throws(
    () => buildPlan({ options: { n: 0, testing: 1 }, existing: {}, config: planConfig({ 'testing.base': 'release/2' }), facts: FACTS }),
    e => e.code === 'plan.bad-folder-template',
  )
  // ⛔ The working role too — it was the one that skipped the assertion, so `sessions/{repo}-{n}`
  // planned /w/sessions/app-1 and takenLabels(), the leftover sweep and teardown all looked for it
  // in vain, while the next run re-issued its label onto a half-installed tree.
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 0 }, existing: {}, config: planConfig({ 'repo.sessionDirTemplate': 'sessions/{repo}-{n}' }), facts: FACTS }),
    e => e.code === 'plan.bad-folder-template',
  )
  assert.throws(
    () => buildPlan({ options: { n: 1, testing: 0, role: 'checker', sweepId: 's', slices: ['a/b'] }, existing: {}, config: planConfig(), facts: FACTS }),
    e => e.code === 'plan.bad-folder-template',
  )
  // And every placeholder renders every time: a bare String.replace with a string pattern substitutes
  // only the FIRST occurrence, and leaves an unknown token's braces in the directory name.
  const twice = buildPlan({ options: { n: 1, testing: 0 }, existing: {}, config: planConfig({ 'repo.sessionDirTemplate': '{repo}-{repo}-{n}' }), facts: FACTS })
  assert.equal(twice[0].worktree, '/w/app-app-1')
})
