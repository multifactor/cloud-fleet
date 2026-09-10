import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run as exec } from '../src/sys/exec.mjs'
import { main } from '../src/cli.mjs'
import { loadCommands } from '../src/cli/registry.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import { parseWorktreeList } from '../src/core/worktree.mjs'
import { listSessions, readSession, sessionPath, writeSession } from '../src/core/fleet.mjs'
import { parseArgv } from '../src/session/shim.mjs'
import { shellQuote } from '../src/cli/commands/attach.mjs'
import { snapshotFrom } from '../src/sys/proc.mjs'
import { argvInFleet, buildSpawnSpec, isUpArgv, markedSessions, otherLaunchers, stampBackendRef } from '../src/cli/commands/up.mjs'
import { readFlags } from '../src/cli/commands/status.mjs'
import { markerSurvivors, STALE_FIELDS } from '../src/cli/commands/relaunch.mjs'
import { liveSupervisors, survivingSessions } from '../src/cli/commands/down.mjs'

// ---- harness ---------------------------------------------------------------------------------------

// Every command under test is dispatched through the real `main()`, so the command table must list
// them — `src/cli/registry.MODULE_FILES` is that table, and this assertion is what makes a module
// that was written but never registered fail here rather than at 3am on the one invocation that
// reaches it.
const COMMANDS = ['up', 'add', 'status', 'down', 'relaunch', 'attach', 'watch']
{
  const registered = (await loadCommands()).map(c => c.name)
  for (const c of COMMANDS) assert.ok(registered.includes(c), `fleet ${c} is not in src/cli/registry.MODULE_FILES, so nothing can dispatch it`)
}

// realpath, because on macOS os.tmpdir() is /var/… while git answers /private/var/…, and on a Windows
// runner the temp dir arrives as an 8.3 short name — comparing either directly fails a correct
// implementation for the wrong reason.
function tmpRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-life-')))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* a shell may still hold a cwd inside it; the temp dir is not the test's subject */ }
  })
  return dir
}

function git(cwd, args) {
  const r = exec('git', ['-C', cwd, ...args], { timeoutMs: 60_000 })
  assert.ok(r.ok, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/**
 * A bootstrap that really installs something, so the install proof has a tree to pass or fail on.
 * ESM, because it is written to a `.mjs` file: `require` is not defined there, so a CommonJS body
 * would throw and exit non-zero over an empty node_modules — which is what the proof would report.
 */
const INSTALLER = [
  "import fs from 'node:fs'",
  "fs.mkdirSync('node_modules/dep', { recursive: true })",
  "fs.writeFileSync('node_modules/dep/index.js', 'export default 1')",
  "fs.writeFileSync('node_modules/dep/package.json', JSON.stringify({ name: 'dep' }))",
  '',
].join('\n')

/** Reaches status `ok` with no tracker: contract §7's trackerless path, and no dev server to probe. */
const PROJECT_CONFIG = Object.freeze({
  version: 1,
  commands: { bootstrap: 'node fleet-install.mjs' },
  tracker: { mode: 'none' },
  testing: { count: 0 },
  // `exists` needs no snapshot of the primary, which in a fixture has no node_modules of its own —
  // and an empty reference would certify every tree, which is the one thing the proof must not do.
  install: { proof: { mode: 'exists' }, perInstallGb: 0.1 },
})

// The pacing knobs are user-scope (contract §3), so they belong in the USER file: in a project file
// they would be ignored with `config.scope.leak` and the suite would sleep 30 s between install waves.
const USER_CONFIG = Object.freeze({
  version: 1,
  defaults: { install: { settleSec: 0, spawnStaggerSec: 0, holdPollSec: 0, maxHoldSec: 0, reservePhysicalGb: 0 } },
})

/**
 * A real repository with a real `origin` — a bare repo it has pushed to — so that
 * `<repo.remote>/<repo.baseBranch>` actually resolves: a worktree created detached at a ref that does
 * not exist is the first thing `fleet up` refuses.
 */
function makeRepo(t, { config = PROJECT_CONFIG, user = USER_CONFIG, name = 'app' } = {}) {
  const parent = tmpRoot(t)
  const repo = path.join(parent, name)
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeJson(path.join(repo, 'package.json'), { name, scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' } })
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  fs.writeFileSync(path.join(repo, 'fleet-install.mjs'), INSTALLER)
  // Ignored so an installed worktree still reads CLEAN: a dirty worktree is a different test.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.fleet-ready\n')
  // ⛔ COMMITTED, like the real thing (contract §3: the project layer travels with the branch). Left
  // untracked it makes `git status --porcelain` non-empty for ever, and `fleet down` — which refuses
  // on a dirty primary — could then never run at all.
  if (config) writeJson(path.join(repo, '.fleet', 'config.json'), config)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])

  const origin = path.join(parent, 'origin.git')
  assert.ok(exec('git', ['init', '--bare', '-q', origin], { timeoutMs: 60_000 }).ok)
  git(repo, ['remote', 'add', 'origin', origin.replace(/\\/g, '/')])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])

  const userHome = path.join(parent, 'user-config')
  if (user) writeJson(path.join(userHome, 'config.json'), user)
  const stateRoot = path.join(parent, 'state')
  return {
    parent,
    repo,
    origin,
    baseSha: git(repo, ['rev-parse', 'HEAD']),
    env: {
      FLEET_CONFIG_HOME: userHome,
      // Both, so one fixture isolates the state dir on Windows and on POSIX.
      LOCALAPPDATA: stateRoot,
      XDG_STATE_HOME: stateRoot,
      // The transcript root, so the stall watcher reads this fixture and never the machine's own.
      CLAUDE_CONFIG_DIR: path.join(parent, 'claude-home'),
    },
  }
}

/** Drive main() with captured streams and an injected backend — never a subprocess, never the network. */
async function cli(argv, { repo, cwd = repo, env, backend }) {
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

/** A fixture plus the backend every command in one test shares (the registry is per fleet, not per call). */
function fleet(t, opts = {}) {
  const f = makeRepo(t, opts)
  const backend = createFakeBackend()
  return { ...f, backend, run: (...argv) => cli(argv, { ...f, backend }) }
}

/**
 * Run a launching command, and SKIP the test when the refusal is about this machine rather than about
 * the code.
 *
 * ⛔ `up` refuses while any other `fleet up` is live, and the guard is machine-wide because a
 * launcher's argv carries nothing that says which repository it is launching (contract §7 gives it no
 * such flag). On a bare clone nothing else runs one and every test below executes; on a machine where
 * a second fleet is launching, failing here would blame the code for the neighbour.
 */
async function launch(t, f, ...argv) {
  const r = await f.run(...argv)
  if (r.payload && r.payload.error && r.payload.error.code === 'up.launcher-running') {
    t.skip(`another launcher is live on this machine, and up refuses beside one by design: ${r.payload.error.message}`)
    return null
  }
  return r
}

/**
 * Run a supervisor pass, and SKIP when an OLDER supervisor on this machine owns the fleet.
 *
 * ⛔ `loop.instanceDecision` is machine-wide for the same reason `up`'s guard is: a watcher's argv
 * carries nothing that says which checkout it watches, so a developer running a real `fleet watch`
 * (this plugin's own dogfooding case) makes every pass here exit with `checks: null`. That is the
 * guard working, not the code failing.
 */
async function watchOnce(t, f, ...argv) {
  const r = await f.run('watch', '--once', ...argv)
  if (r.payload && r.payload.exited) {
    t.skip('an older supervisor owns this machine, and a second one exits by design: loop.instanceDecision')
    return null
  }
  return r
}

const worktreesOf = repo => parseWorktreeList(git(repo, ['worktree', 'list', '--porcelain']))

async function stateDirOf(f) {
  const r = await f.run('config', 'status', '--json')
  return r.payload.machine.stateDir
}

// ---- up: the launch --------------------------------------------------------------------------------

test('up creates a worktree per session DETACHED at the base ref, writes a descriptor for each, and spawns each with the exact marker token', async t => {
  const f = fleet(t)
  const r = await launch(t, f, 'up', '2', '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.payload.ok, true)

  const trees = worktreesOf(f.repo)
  const sessions = trees.filter(w => /app-session-\d+$/.test(w.path.replace(/\\/g, '/')))
  assert.equal(sessions.length, 2, 'one worktree per planned session')
  for (const w of sessions) {
    // ⛔ Detached at <remote>/<baseBranch>: a session that never starts must leave no branch behind,
    // and the branch it will make renders from a ticket slug it has not resolved yet.
    assert.equal(w.detached, true, `${w.path} must be detached`)
    assert.equal(w.branch, null)
    assert.equal(w.head, f.baseSha, `${w.path} must sit at origin/main`)
  }

  const stateDir = await stateDirOf(f)
  const registry = listSessions({ stateDir })
  assert.deepEqual(registry.map(d => d.label), ['1', '2'])
  assert.deepEqual(registry.map(d => d.role), ['working', 'working'])

  const spawns = f.backend.spawned()
  assert.equal(spawns.length, 2, 'one window per new session')
  for (const s of spawns) {
    // Token-exact, and its own argv element: a marker that split across two tokens (a label with a
    // space, an unquoted path) is a session the reconciler can never find again.
    assert.ok(s.args.includes(`--fleet-session=${s.id}`), `${s.id}: the marker must be one whole argv token`)
    assert.equal(s.args.filter(a => a.startsWith('--fleet-session=')).length, 1)
    // ⛔ The model is on every command line: with none, the agent CLI picks its own default, which
    // once moved a whole running fleet onto another model with nothing on screen to say so.
    assert.deepEqual(s.args.slice(-2), ['--model', 'opus'])
    assert.equal(s.cwd, registry.find(d => d.label === s.id).worktree)
  }
})

test('the descriptor and resolved.json are written BEFORE the spawn — proven by a spawn that throws', async t => {
  // A spawn whose descriptor does not exist yet is a session nothing can address: not `fleet kill`,
  // not the reclaimer, not the shim, which reads its own config out of resolved.json.
  const f = fleet(t)
  injectFault(f.backend, { spawnThrows: 'the terminal host refused to spawn' })
  const r = await launch(t, f, 'up', '1', '--json')
  if (!r) return
  assert.equal(r.code, 1, 'a session that could not be opened is a failure the launcher must see')
  assert.equal(r.payload.error.code, 'up.session-failed')
  const stateDir = await stateDirOf(f)
  const resolved = JSON.parse(fs.readFileSync(path.join(stateDir, 'resolved.json'), 'utf8'))
  assert.deepEqual(Object.keys(resolved).slice(0, 2), ['v', 'inputsHash'], 'contract §4: {v, inputsHash, config, slots[], adapter}')
  assert.ok(resolved.config.repo.name, 'the shim reads its whole config from this file')
  assert.ok(Array.isArray(resolved.slots))
  const d = readSession('1', { stateDir })
  assert.ok(d, 'the descriptor survives a failed spawn, or the worktree it names is stranded')
  assert.equal(d.backendRef, null, 'nothing was spawned, so there is no spawn to point at')
})

test('the shim can read the argv up builds: marker, then descriptor, then the model', async t => {
  // ⛔ Order is load-bearing. session/shim.parseArgv takes the FIRST NON-FLAG token as the descriptor
  // path, so `--model opus` written before it makes the shim open a file called "opus" and die of
  // ENOENT before the session starts. Asserted with the shim's own parser, so the two cannot drift.
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  const stateDir = await stateDirOf(f)
  const descriptor = readSession('1', { stateDir })
  const sessionFile = sessionPath(stateDir, '1')
  const spec = buildSpawnSpec({ config: JSON.parse(fs.readFileSync(path.join(stateDir, 'resolved.json'), 'utf8')).config, descriptor, sessionFile })

  // argv[0] is the shim itself; the shim sees everything after it (process.argv.slice(2)).
  const parsed = parseArgv(spec.args.slice(1))
  assert.equal(parsed.label, '1')
  assert.equal(parsed.file, sessionFile)
  assert.equal(path.basename(spec.args[0]), 'shim.mjs')
  const env = Object.fromEntries(spec.env.map(e => [e.name, e.value]))
  assert.equal(env.FLEET_SESSION, '1')
  assert.equal(env.FLEET_SESSION_FILE, sessionFile)
  assert.equal(env.FLEET_LABEL, '1')
  assert.equal(env.FLEET_ROLE, 'working')
  assert.equal(env.FLEET_SLOT, undefined, 'a working session must not inherit a slot: it would trust another session\'s port')
})

test('a second up reuses the testing slot: no second worktree, no second window, no second install', async t => {
  // ⛔ A testing window opens on first creation only. Two agents in one worktree collide on the git
  // index, and two dev servers on one slot fight for the port — so a live descriptor means no window,
  // however many times the operator re-runs the command.
  const f = fleet(t, { config: { ...PROJECT_CONFIG, commands: { ...PROJECT_CONFIG.commands, devServer: 'node server.mjs' } } })
  const first = await launch(t, f, 'up', '0', '--testing', '1', '--json')
  if (!first) return
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(first.payload.plan.map(p => p.label), ['t1'])
  assert.equal(first.payload.installs.queued, 1)
  assert.deepEqual(first.payload.installs.ok, ['t1'], 'the install proof must pass, or no ready sentinel is written')

  const slotDir = first.payload.plan[0].worktree
  assert.ok(fs.existsSync(path.join(slotDir, '.fleet-ready')), 'the sentinel is written at the WORKTREE root')
  const treesBefore = worktreesOf(f.repo).length
  const stateDir = await stateDirOf(f)
  const before = readSession('t1', { stateDir })

  const second = await launch(t, f, 'up', '0', '--testing', '1', '--json')
  if (!second) return
  assert.equal(second.code, 0, second.stderr)
  assert.equal(f.backend.spawned().length, 1, 'the slot already has a live session: no second window')
  // ⛔ And its descriptor is not rewritten either: that file is where the shim records its pids and the
  // backend its spawn handle, and a freshly built copy would leave a running agent that `fleet kill`,
  // `fleet send` and the reclaimer can no longer address.
  assert.deepEqual(readSession('t1', { stateDir }), before, 'a live session\'s registry entry is left exactly as it was')
  assert.equal(worktreesOf(f.repo).length, treesBefore, 'the worktree is reused, never recreated')
  assert.deepEqual(second.payload.reused, ['t1'])
  // ⛔ Installs run only where the ready sentinel is absent: re-running the install over a live
  // worktree is how a half-extracted tree is created in the first place.
  assert.deepEqual(second.payload.installs.skipped, ['t1'])
  assert.equal(second.payload.installs.queued, 0)
})

test('a live slot whose lockfile MOVED is not reinstalled underneath its agent — it is reported instead', async t => {
  // ⛔ A testing slot's tree is a mashup of many sessions' branches, so its lockfile hash moves
  // constantly and readyState calls it `stale-lockfile` on almost every re-run. Queuing the install
  // anyway clears that live slot's ready sentinel and runs `commands.bootstrap` inside the worktree
  // underneath its running dev server, with no restart of that server and no word to the session.
  const f = fleet(t, { config: { ...PROJECT_CONFIG, commands: { ...PROJECT_CONFIG.commands, devServer: 'node server.mjs' } } })
  const first = await launch(t, f, 'up', '0', '--testing', '1', '--json')
  if (!first) return
  assert.equal(first.code, 0, first.stderr)
  const slotDir = first.payload.plan[0].worktree
  const sentinel = path.join(slotDir, '.fleet-ready')
  assert.ok(fs.existsSync(sentinel))
  const sentinelBefore = fs.readFileSync(sentinel, 'utf8')
  const dep = path.join(slotDir, 'node_modules', 'dep', 'index.js')
  fs.writeFileSync(dep, 'export default "installed by the FIRST run"')

  // The slot merged a branch that moved the lockfile: the sentinel now certifies a different tree.
  fs.writeFileSync(path.join(slotDir, 'package-lock.json'), '{"lockfileVersion":3,"moved":true}\n')

  const second = await launch(t, f, 'up', '0', '--testing', '1', '--json')
  if (!second) return
  assert.equal(second.code, 0, second.stderr)
  assert.equal(f.backend.spawned().length, 1, 'the live slot keeps its one window')
  assert.equal(second.payload.installs.queued, 0, 'nothing is bootstrapped under a live agent')
  assert.deepEqual(second.payload.installs.skipped, ['t1'], 'and the skip is reported, not silent')
  assert.ok(
    second.payload.installs.warnings.some(w => /LIVE session/.test(w)),
    'the launcher is told the dependencies need installing, so it can tell the session',
  )
  assert.equal(fs.readFileSync(sentinel, 'utf8'), sentinelBefore, 'the live slot\'s ready sentinel is left exactly as it was')
  assert.equal(fs.readFileSync(dep, 'utf8'), 'export default "installed by the FIRST run"', 'and its node_modules is untouched')
})

test('a working session gets a slot URL to capture against, and the slot itself is on the slot branch', async t => {
  const f = fleet(t, { config: { ...PROJECT_CONFIG, commands: { ...PROJECT_CONFIG.commands, devServer: 'node server.mjs' }, testing: { count: 1 } } })
  const r = await launch(t, f, 'up', '1', '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  const stateDir = await stateDirOf(f)
  const slot = readSession('t1', { stateDir })
  const working = readSession('1', { stateDir })
  // ⛔ The slot's branch comes from the slot table: a session serving one branch while reporting
  // another slot's URL stays invisible until every capture turns out to be of the wrong code.
  assert.equal(slot.branch, 'testing')
  assert.equal(slot.slot, 1)
  assert.equal(slot.testingUrl, 'http://localhost:3000')
  assert.deepEqual(working.testingUrls, ['http://localhost:3000'])
  const slotEnv = Object.fromEntries(f.backend.record('t1').env.map(e => [e.name, e.value]))
  // Without these a fixed-port project cannot start a second slot at all: {port} is otherwise only a
  // URL placeholder, and the dev-server command needs its own port.
  assert.equal(slotEnv.FLEET_SLOT, '1')
  assert.equal(slotEnv.FLEET_PORT, '3000')
  assert.equal(slotEnv.FLEET_SLOT_BRANCH, 'testing')
})

test('the seeded prompt is delivered, and a SHORT WRITE is reported instead of read as delivery', async t => {
  // A console input buffer takes what fits and submits the fragment: a ~700-character message once
  // arrived as 62 characters plus Enter, and the session acted on the fragment while looking healthy.
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  const buffer = f.backend.buffer('1').join('')
  assert.match(buffer, /claude-fleet session 1/)
  assert.match(buffer, /session\.md/, 'the playbook is injected by PATH, never pasted: a relaunch must read the copy on disk')

  const g = fleet(t)
  injectFault(g.backend, { sendLimit: 20 })
  const r = await launch(t, g, 'up', '1', '--json')
  if (!r) return
  assert.equal(r.code, 0, 'a truncated prompt is not a failed launch, but it must be said out loud')
  assert.match(r.stderr + r.stdout, /delivered as 20 of \d+ characters/)
})

test('up --dry-run prints the plan and touches nothing at all', async t => {
  const f = fleet(t)
  const r = await f.run('up', '3', '--dry-run', '--json')
  assert.equal(r.code, 0)
  assert.equal(r.payload.dryRun, true)
  assert.deepEqual(r.payload.plan.map(p => p.label), ['1', '2', '3'])
  assert.equal(f.backend.spawned().length, 0)
  assert.equal(worktreesOf(f.repo).length, 1, 'only the primary checkout exists')
  const stateDir = await stateDirOf(f)
  assert.equal(fs.existsSync(stateDir), false, 'a dry run must not even create the state directory')
})

test('--no-wizard refuses an unconfigured repo with {status, missing, hint} and writes nothing', async t => {
  // Nobody is there to answer the wizard, so the launcher needs the refusal as data — and a launch
  // that half-happened would leave worktrees nothing is registered to.
  const f = fleet(t, { config: null })
  const r = await f.run('up', '2', '--no-wizard', '--json')
  assert.equal(r.code, 1)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.status, 'needs-init')
  assert.ok(Array.isArray(r.payload.missing))
  assert.ok(r.payload.error.hint, 'a refusal with no hint is a dead end')
  assert.equal(worktreesOf(f.repo).length, 1)
  assert.equal(fs.existsSync(await stateDirOf(f)), false)
})

test('a second launcher is refused: two of them each skip what the other just created', async t => {
  // PURE, over a scripted process table — the real guard reads the same shape from sys/snapshot.
  const table = snapshotFrom([
    { pid: 1, ppid: 0, name: 'sh', cmd: 'sh' },
    { pid: 2, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs up 4 --testing 1' },
    { pid: 3, ppid: 1, name: 'node', cmd: 'npx claude-fleet.mjs status --json' },
    { pid: 4, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs watch' },
    // ⛔ The pair contract §1 actually names: the launcher's `node …/src/cli.mjs up` beside an
    // operator's `npx claude-fleet up`. npm links the bin without its extension on POSIX, so the
    // installed spelling carries no `.mjs` at all — and a guard that knew only the `.mjs` spellings
    // let exactly these two run side by side, each skipping the worktrees the other just created.
    { pid: 5, ppid: 1, name: 'node', cmd: 'node /usr/local/lib/node_modules/claude-fleet/bin/claude-fleet.mjs up 2' },
    { pid: 6, ppid: 1, name: 'node', cmd: 'node /usr/local/bin/claude-fleet add 1' },
    // A flag may stand between the entry file and the subcommand: parseArgs collects bare tokens in
    // any position, so this one really does launch a fleet.
    { pid: 7, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs --json up 4' },
    { pid: 9, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs up 2' },
  ])
  const seen = otherLaunchers(table, { selfPid: 9 })
  assert.deepEqual(seen.others.map(o => o.pid), [2, 5, 6, 7], 'self is excluded, and `status` and `watch` are not launchers')
  assert.equal(seen.degraded, false)

  // ⛔ An empty snapshot is a FAILED listing, never proof of being alone: refusing every launch over
  // a hiccup in the process listing would stop a fleet for a reason nobody could see.
  const empty = otherLaunchers(snapshotFrom([]), { selfPid: 9 })
  assert.deepEqual(empty, { degraded: true, others: [] })

  assert.equal(isUpArgv('node /plugin/src/cli.mjs up'), true)
  assert.equal(isUpArgv('node /plugin/src/cli.mjs upgrade'), false, 'token-exact: `upgrade` is not `up`')
  assert.equal(isUpArgv('node /plugin/src/cli.mjs config status'), false)
  assert.equal(isUpArgv('node /usr/local/bin/claude-fleet up 4'), true, 'the installed bin carries no .mjs')
  assert.equal(isUpArgv('node /usr/local/bin/claude-fleet status'), false)
  assert.equal(isUpArgv('node /plugin/src/cli.mjs --json up 4'), true, 'a flag may stand before the subcommand')
  assert.equal(isUpArgv('node "C:\\p q\\bin\\claude-fleet.mjs" add 2'), true)
  // A value flag written before the subcommand takes its NEIGHBOUR, exactly as args.parseArgs reads
  // it — so the word after it is a value, not the command.
  assert.equal(isUpArgv('node /plugin/src/cli.mjs --issues ABC-1234 up'), true)
  assert.equal(isUpArgv('node /plugin/src/cli.mjs --file up'), false, '"up" here is the value of --file')
})

test('the backendRef is merged onto a fresh read, so the shim\'s own writes are not clobbered', async t => {
  // The shim read-modify-writes this same file (shimPid, agentPid, startedAt) the instant it starts,
  // with no lock between us — a replace built from the pre-spawn copy silently drops all of it, and a
  // live session's pids are then unknown to `fleet kill`.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stamp-'))
  const base = { label: '3', role: 'working', worktree: '/w/app-session-3', shimPid: null, pgid: null, backendRef: null }
  writeSession(base, { stateDir })
  writeSession({ ...base, shimPid: 4242, agentPid: 4243, startedAt: '2026-03-14T10:00:00Z' }, { stateDir })

  const after = stampBackendRef('3', { backendRef: { ref: 'fake:abc' }, shimPid: 77 }, { stateDir, base })
  assert.deepEqual(after.backendRef, { ref: 'fake:abc' })
  assert.equal(after.shimPid, 4242, 'the shim\'s pid survives the stamp')
  assert.equal(after.agentPid, 4243)
  assert.equal(readSession('3', { stateDir }).startedAt, '2026-03-14T10:00:00Z')
})

// ---- add -------------------------------------------------------------------------------------------

test('add numbers PAST a leftover folder, never into it', async t => {
  // ⛔ One past the highest taken, never the first hole: `git worktree remove` routinely deregisters a
  // tree and then fails to delete it, and numbering into that folder hands the new session a
  // half-installed dependency tree that every cheap check calls healthy.
  const f = fleet(t)
  const leftover = path.join(f.parent, 'app-session-3')
  fs.mkdirSync(path.join(leftover, 'node_modules', 'dep'), { recursive: true })

  const r = await launch(t, f, 'add', '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(r.payload.plan.map(p => p.label), ['4'])
  assert.equal(fs.existsSync(path.join(leftover, 'node_modules', 'dep')), true, 'the leftover is left exactly as it was')

  const two = await launch(t, f, 'add', '2', '--json')
  if (!two) return
  assert.deepEqual(two.payload.plan.map(p => p.label), ['5', '6'])
})

test('add refuses --testing: adding sessions never resizes the slot pool', async t => {
  // The config layer reads --testing only on `up`, so honouring it here would resize the plan while
  // the config disagreed — and the slot would come up with no port or URL of its own.
  const f = fleet(t)
  const r = await f.run('add', '1', '--testing', '1', '--json')
  assert.equal(r.code, 2, 'a usage error is a 2: retrying it unchanged can only fail again')
  assert.equal(r.payload.error.code, 'add.testing-flag')
  assert.equal(f.backend.spawned().length, 0)
})

test('up AND add refuse a bare count that disagrees with --add rather than silently preferring one', async t => {
  const f = fleet(t)
  const r = await f.run('up', '4', '--add', '2', '--json')
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'up.count-and-add')
  assert.equal(worktreesOf(f.repo).length, 1)

  // ⛔ The same sentence under the other spelling. `fleet add` never reaches buildPlan's own
  // `plan.count-conflict` (it passes only `add`), so a guard that lived on the `up` branch alone let
  // `fleet add 4 --add 2` open two sessions after the operator typed four, with nothing on screen to
  // say which number won.
  const added = await f.run('add', '4', '--add', '2', '--json')
  assert.equal(added.code, 2)
  assert.equal(added.payload.error.code, 'up.count-and-add')
  assert.match(added.payload.error.message, /fleet add 4 --add 2/)
  assert.equal(worktreesOf(f.repo).length, 1)
  assert.equal(f.backend.spawned().length, 0)
})

test('add --issues derives the count from the keys, exactly as up does', async t => {
  // The operator named no count at all. A default of 1 applied before the keys were consulted made
  // buildPlan answer "1 session(s) were asked for but 2 issue key(s) were given" — telling them they
  // asked for a count they never typed.
  const f = fleet(t)
  const r = await launch(t, f, 'add', '--issues', 'ABC-1234,ABC-1240', '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(r.payload.plan.map(p => p.issue), ['ABC-1234', 'ABC-1240'])
  // ⛔ And the testing pool is still left exactly as it is: `add` passes an explicit `testing: 0`, so
  // dropping the count default must not let `testing.count` back into the plan.
  assert.deepEqual(r.payload.plan.map(p => p.role), ['working', 'working'])
})

// ---- status ----------------------------------------------------------------------------------------

test('status renders the fleet table, and its --json carries every session, flag and intake refusal', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '2', '--json')) return
  const stateDir = await stateDirOf(f)
  fs.mkdirSync(path.join(stateDir, 'flags'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'flags', 'done-1.json'), JSON.stringify({ v: 1, session: '1', issue: 'ABC-1234', outcome: 'pr-pushed', at: '2026-03-14T10:00:00Z' }))
  fs.writeFileSync(path.join(stateDir, 'flags', 'blocked-2.json'), JSON.stringify({ v: 1, session: '2', category: 'dev-server', observation: 'the slot answers 404', at: '2026-03-14T10:05:00Z' }))
  // ⛔ Refusals are listed, never silent: a silently shrinking queue reads as "there was no work".
  fs.writeFileSync(path.join(stateDir, 'intake-refused.jsonl'), `${JSON.stringify({ v: 1, key: 'ABC-1240', reason: 'ungated', at: '2026-03-14T10:00:00Z' })}\n`)

  const r = await f.run('status', '--json')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.payload.ok, true)
  assert.deepEqual(r.payload.sessions.map(s => s.label), ['1', '2'])
  assert.deepEqual(r.payload.sessions.map(s => s.alive), [true, true], 'liveness comes from the backend, by the backendRef the registry recorded')
  assert.deepEqual(r.payload.sessions.map(s => s.state), [null, null], 'no hook has written a state file yet, and that is not "unknown alive"')
  assert.deepEqual(r.payload.flags.done.map(x => [x.label, x.outcome]), [['1', 'pr-pushed']])
  assert.deepEqual(r.payload.flags.blocked.map(x => [x.label, x.category]), [['2', 'dev-server']])
  assert.equal(r.payload.intakeRefused.count, 1)
  assert.equal(r.payload.intakeRefused.entries[0].key, 'ABC-1240')

  const human = await f.run('status')
  assert.match(human.stdout, /\| 1 \| working \|/)
  assert.doesNotMatch(human.stdout, /"v":\s*1/, 'a human reading a wall of JSON stops reading the sentence above it')
})

test('status survives a backendRef this backend never minted, and a torn flag', async t => {
  // One bad row must not blind the table: a stale ref from a previous fleet throws inside the backend,
  // and a flag nobody can read is a session nobody reclaims — both are reported, neither is fatal.
  const f = fleet(t)
  if (!await launch(t, f, 'up', '2', '--json')) return
  const stateDir = await stateDirOf(f)
  const d = readSession('2', { stateDir })
  writeSession({ ...d, backendRef: { ref: 'fake:from-another-fleet' } }, { stateDir })
  fs.mkdirSync(path.join(stateDir, 'flags'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'flags', 'done-9.json'), '{"outcome":')

  const r = await f.run('status', '--json')
  assert.equal(r.code, 0)
  assert.equal(r.payload.sessions.length, 2)
  assert.equal(r.payload.sessions.find(s => s.label === '2').alive, null, 'unknown is not the same answer as dead')
  assert.equal(r.payload.sessions.find(s => s.label === '1').alive, true)
  assert.ok(r.payload.flags.done.find(x => x.label === '9').error, 'the unreadable flag is reported, never dropped')
})

test('readFlags reads both flag kinds and ignores the one-line .txt twin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-flags-'))
  fs.mkdirSync(path.join(dir, 'flags'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'flags', 'done-1.json'), '{"outcome":"cancelled"}')
  fs.writeFileSync(path.join(dir, 'flags', 'done-1.txt'), 'cancelled')
  fs.writeFileSync(path.join(dir, 'flags', 'blocked-t1.json'), '{"category":"testing-slot"}')
  const flags = readFlags(dir)
  assert.deepEqual(flags.map(f => `${f.kind}-${f.label}`), ['blocked-t1', 'done-1'])
  assert.equal(readFlags(path.join(dir, 'nowhere')).length, 0, 'a fleet that has never flagged is not an error')
})

test('status degrades a state dir it cannot read into notes, instead of a stack', async t => {
  // ⛔ Nothing here is fatal, and that has to hold for the reads. `listSessions`, `readFlags` and
  // `readRefusals` each re-throw anything that is not ENOENT — and an unreadable state dir is
  // precisely the broken machine an operator runs `fleet status` to diagnose, so a command that
  // threw would leave the launcher with no picture of a fleet that is still running.
  // ENOTDIR/EISDIR stand in for the EACCES/EPERM/EBUSY of a real one: a permission fault is not
  // reproducible the same way on both platforms this ships on, and the handling is the same.
  const f = fleet(t)
  const stateDir = await stateDirOf(f)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'sessions'), 'not a directory')
  fs.writeFileSync(path.join(stateDir, 'flags'), 'not a directory either')
  fs.mkdirSync(path.join(stateDir, 'intake-refused.jsonl'))

  const r = await f.run('status', '--json')
  assert.equal(r.code, 0, 'a status command that throws cannot report the breakage it was run to find')
  assert.equal(r.payload.ok, true)
  assert.deepEqual(r.payload.sessions, [])
  assert.deepEqual(r.payload.flags.done, [])
  assert.deepEqual(r.payload.flags.blocked, [])
  assert.equal(r.payload.intakeRefused.count, 0)
  for (const what of ['the session registry', 'the flags', 'the intake refusals']) {
    assert.ok(r.payload.notes.some(n => n.startsWith(`${what} could not be read from `)), `"${what}" must degrade to a note naming its path and errno, got ${JSON.stringify(r.payload.notes)}`)
  }
  assert.match(r.stderr, /note: the session registry could not be read/)
})

// ---- relaunch --------------------------------------------------------------------------------------

test('relaunch kills the old session and spawns a fresh one into the SAME worktree, dropping the previous run\'s exit record', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  const stateDir = await stateDirOf(f)
  const before = readSession('1', { stateDir })
  const firstRef = before.backendRef.ref

  // ⛔ The descriptor is put into the state a CRASHED session leaves behind first, or the drop list is
  // untested: nothing else in this fixture ever writes an `exit`, a `liveness` or a `deadAt`, so
  // asserting they are absent afterwards would hold with `drop: STALE_FIELDS` deleted. Left in place
  // they describe a finished session, and the reclaimer takes the worktree out from under the agent
  // that just replaced it.
  writeSession({
    ...before,
    exit: { code: 1, at: '2026-03-14T10:00:00Z' },
    liveness: 'dead',
    deadAt: '2026-03-14T10:00:00Z',
    reconciledAt: '2026-03-14T10:01:00Z',
    shimPid: 4242,
    agentPid: 4243,
    pgid: 4242,
    startedAt: '2026-03-14T09:00:00Z',
  }, { stateDir })

  const r = await f.run('relaunch', '1', '--json')
  assert.equal(r.code, 0, r.stderr)
  const spawns = f.backend.spawned().filter(s => s.id === '1')
  assert.equal(spawns.length, 2, 'the label is spawned again, once the first is gone')
  // The worktree is the whole point: its branch, commits and untracked helpers must survive.
  assert.equal(spawns[1].cwd, spawns[0].cwd)
  assert.equal(spawns[1].cwd, before.worktree)
  const after = readSession('1', { stateDir })
  assert.notEqual(after.backendRef.ref, firstRef, 'the ref identifies the SPAWN, so a nudge cannot land in the session it replaced')
  // The reclaimer's death mark and the previous run's exit record are simply gone.
  for (const field of STALE_FIELDS) {
    // shimPid and pgid come straight back — from the NEW spawn's handle, which is the point: a fresh
    // agent must be addressable by `fleet kill` before its own shim's first write.
    if (field === 'shimPid' || field === 'pgid') continue
    assert.equal(after[field], undefined, `${field} is a previous run's, and relaunch must drop it (relaunch.STALE_FIELDS)`)
  }
  assert.notEqual(after.shimPid, 4242, 'the stale pid is gone, so a kill cannot walk the tree from a dead root')
  assert.equal(after.shimPid, f.backend.record('1').pid, 'and what replaced it is THIS spawn\'s pid')
  assert.match(f.backend.buffer('1').join(''), /claude-fleet session 1/, 'the fresh agent is seeded again: it knows nothing')
})

test('relaunch refuses to spawn beside a survivor — two agents in one worktree collide on the git index', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  // A pane can close while the dev server the session started keeps holding its port: that process is
  // what a survivor IS, so the session needs a child before the fault can mean anything. The child is
  // hung off the session's PID — a bare label would be read as a pid and land on the terminal host,
  // where no session kill would ever have reached it.
  f.backend.addChild(f.backend.record('1').pid, { name: 'node', cmd: 'node server.mjs' })
  injectFault(f.backend, { killLeaves: '1' })

  const r = await f.run('relaunch', '1', '--json')
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'relaunch.still-alive')
  assert.ok(r.payload.survivors.length, 'the survivors are named, because the operator has to kill them')
  assert.equal(f.backend.spawned().filter(s => s.id === '1').length, 1, 'NOTHING may be spawned until the kill is proven')
})

test('relaunch refuses a label the registry does not know, and a worktree that is gone', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  const missing = await f.run('relaunch', '9', '--json')
  assert.equal(missing.code, 1)
  assert.equal(missing.payload.error.code, 'relaunch.no-session')

  const stateDir = await stateDirOf(f)
  fs.rmSync(readSession('1', { stateDir }).worktree, { recursive: true, force: true })
  const gone = await f.run('relaunch', '1', '--json')
  assert.equal(gone.code, 1)
  assert.equal(gone.payload.error.code, 'relaunch.no-worktree')
})

test('the marker search is scoped to THIS fleet: a neighbouring checkout\'s session 1 is not this one\'s survivor', () => {
  // PURE, over a scripted process table. ⛔ Labels are bare numbers and contract §3 gives every repo
  // on a machine its own state dir, so a second checkout routinely has a session labelled "1" as
  // well. Machine-wide, `fleet relaunch 1` here refused over a pid the operator cannot kill without
  // stopping unrelated work, and `fleet down` pushed that label into killFailed, marked its worktree
  // stuck and exited 1 — a teardown that could never complete while the other fleet ran.
  const mine = '/state/claude-fleet/app'
  const theirs = '/state/claude-fleet/other-app'
  const shim = (label, dir) => `node /plugin/src/session/shim.mjs --fleet-session=${label} ${dir}/sessions/${label}.json --model opus`
  const table = snapshotFrom([
    { pid: 1, ppid: 0, name: 'sh', cmd: 'sh' },
    { pid: 11, ppid: 1, name: 'node', cmd: shim('1', mine) },
    { pid: 12, ppid: 1, name: 'node', cmd: shim('1', theirs) },
    { pid: 13, ppid: 1, name: 'node', cmd: shim('2', mine) },
  ])

  const seen = markedSessions(table, { stateDir: mine, labels: ['1'] })
  assert.deepEqual(seen.survivors, [{ label: '1', pid: 11 }])
  assert.deepEqual(seen.foreign, [{ label: '1', pid: 12 }], 'the other fleet\'s pid is reported, never acted on')

  // The two callers, each through its own injectable snapshot.
  assert.deepEqual(markerSurvivors('1', { snapshot: table, stateDir: mine }), { degraded: false, pids: [11], foreign: [12] })
  const proof = survivingSessions(['1', '2'], { stateDir: mine, snapshot: table })
  assert.deepEqual(proof.survivors.map(s => s.pid), [11, 13])
  assert.deepEqual(proof.foreign.map(s => s.pid), [12])

  // ⛔ An empty snapshot is a FAILED listing on both paths, never an empty machine.
  assert.equal(markerSurvivors('1', { snapshot: snapshotFrom([]), stateDir: mine }).degraded, true)
  assert.equal(survivingSessions(['1'], { stateDir: mine, snapshot: snapshotFrom([]) }).degraded, true)

  // ⛔ Whole-segment, never a prefix: `<state>/app` must not claim `<state>/app-2`'s sessions, the
  // same trap samePath() exists for.
  assert.equal(argvInFleet(shim('1', mine), mine, { platform: 'linux' }), true)
  assert.equal(argvInFleet(shim('1', `${mine}-2`), mine, { platform: 'linux' }), false)
  // Windows spells the same path with backslashes and in whatever case the operator typed.
  assert.equal(argvInFleet('node shim.mjs --fleet-session=1 C:\\State\\App\\sessions\\1.json', 'c:/state/app', { platform: 'win32' }), true)
})

// ---- down ------------------------------------------------------------------------------------------

test('down refuses while the PRIMARY checkout is dirty, and tears down nothing', async t => {
  // ⛔ That is the operator's own work in the main checkout, not session scratch, and losing it is far
  // worse than leaving a few servers up.
  const f = fleet(t)
  if (!await launch(t, f, 'up', '2', '--json')) return
  fs.writeFileSync(path.join(f.repo, 'notes.md'), 'half a day of work\n')

  const r = await f.run('down', '--json')
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'down.primary-dirty')
  assert.ok(r.payload.dirty.some(l => l.includes('notes.md')))
  assert.equal(worktreesOf(f.repo).length, 3, 'nothing was removed')
  assert.equal(f.backend.list().length, 2, 'and nothing was killed')
})

test('down kills every session, removes every worktree, sweeps the leftovers and clears the flags and locks', async t => {
  const f = fleet(t, { config: { ...PROJECT_CONFIG, commands: { ...PROJECT_CONFIG.commands, devServer: 'node server.mjs' } } })
  if (!await launch(t, f, 'up', '2', '--testing', '1', '--json')) return
  const stateDir = await stateDirOf(f)
  const worktrees = listSessions({ stateDir }).map(d => d.worktree)
  assert.equal(worktrees.length, 3)

  // A leftover folder git no longer knows about, a stale lock and a flag: teardown owns all three.
  const leftover = path.join(f.parent, 'app-session-9')
  fs.mkdirSync(path.join(leftover, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(stateDir, 'locks', 'testing', 'testing'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'locks', 'testing', 'testing', 'holder.json'), '{"owner":"t1"}')
  fs.mkdirSync(path.join(stateDir, 'flags'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'flags', 'done-1.json'), '{"v":1,"outcome":"pr-pushed"}')

  // ⛔ A review page, in the resolved artifacts dir. It must outlive the fleet — review starts after
  // the fleet is gone — and the primary-checkout assertion below never touched that invariant.
  const resolved = await f.run('config', 'resolve', '--json')
  const artifactsDir = resolved.payload.config.paths.artifactsDir
  assert.ok(artifactsDir, 'paths.artifactsDir is derived, never unset')
  fs.mkdirSync(artifactsDir, { recursive: true })
  const devPage = path.join(artifactsDir, 'ABC-1234.html')
  fs.writeFileSync(devPage, '<h1>the evidence for ABC-1234</h1>')

  const dry = await f.run('down', '--dry-run', '--json')
  assert.equal(dry.code, 0)
  assert.equal(dry.payload.worktrees.length, 3)
  assert.deepEqual(dry.payload.leftovers.map(p => path.basename(p)), ['app-session-9'])
  assert.ok(Array.isArray(dry.payload.supervisor), 'a dry run lists the `fleet watch` it would stop')
  assert.equal(worktreesOf(f.repo).length, 4, 'a dry run touches nothing')

  const r = await f.run('down', '--json')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(f.backend.list().length, 0, 'every session is killed, and the kill is proven')
  assert.deepEqual(worktreesOf(f.repo).map(w => path.basename(w.path)), ['app'], 'only the primary is left registered')
  for (const w of worktrees) assert.equal(fs.existsSync(w), false, `${w} must be gone from the disk, not merely deregistered`)
  assert.equal(fs.existsSync(leftover), false, 'the leftover folder is swept too')
  // The supervisor is this teardown's business too — reported every run, so "nothing was running" is
  // an answer rather than a silence. This fleet never started one, and a `fleet watch` that belongs
  // to another checkout (no recent watch.status.json here) is named and left alone, never signalled.
  assert.deepEqual(r.payload.supervisor.stopped, [])
  assert.deepEqual(r.payload.supervisor.survivors, [])
  assert.equal(listSessions({ stateDir }).length, 0)
  assert.equal(fs.existsSync(path.join(stateDir, 'flags')), false)
  assert.equal(fs.existsSync(path.join(stateDir, 'locks')), false)
  // ⛔ `paths.artifactsDir` is never touched: a review page must outlive the session that made it,
  // because review starts after the fleet is gone.
  assert.equal(fs.existsSync(devPage), true, 'the dev page survives the teardown that made its session')
  assert.equal(fs.readFileSync(devPage, 'utf8'), '<h1>the evidence for ABC-1234</h1>')
  // And the primary checkout itself is never a target, however it was reached.
  assert.equal(fs.existsSync(f.repo), true)
})

test('down reports a session that survived its kill instead of removing the worktree under it', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  // The dev server the session started, still holding its port after the pane closed.
  f.backend.addChild(f.backend.record('1').pid, { name: 'node', cmd: 'node server.mjs' })
  injectFault(f.backend, { killLeaves: '1' })
  const stateDir = await stateDirOf(f)
  const worktree = readSession('1', { stateDir }).worktree

  const r = await f.run('down', '--json')
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'down.incomplete')
  assert.deepEqual(r.payload.killFailed.map(k => k.label), ['1'])
  assert.equal(fs.existsSync(worktree), true, 'a live agent\'s worktree is never removed under it')
  assert.ok(readSession('1', { stateDir }), 'the descriptor is the only record of where the stranded tree is')
})

test('down finds the supervisor to stop — the one process that outlives the sessions and restarts the services', () => {
  // PURE, over a scripted process table. The launcher playbook says teardown "reclaims everything the
  // per-session teardown cannot (… the reaper, the watcher …)", and a supervisor left running past
  // the teardown re-runs services.docker.startCommand on its next tick — the services check has no
  // registry precondition — and puts back the infrastructure `fleet down` just took down.
  const table = snapshotFrom([
    { pid: 1, ppid: 0, name: 'sh', cmd: 'sh' },
    { pid: 2, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs watch' },
    { pid: 3, ppid: 1, name: 'node', cmd: 'node /usr/local/bin/claude-fleet status --json' },
    { pid: 4, ppid: 2, name: 'node', cmd: 'node server.mjs' },
    { pid: 9, ppid: 1, name: 'node', cmd: 'node /plugin/src/cli.mjs down' },
  ])
  const seen = liveSupervisors(table, { selfPid: 9 })
  // ⛔ The supervisor's own pid, and NOT its children: `fleet watch` starts the container engine and
  // the dev servers as its own children, so a tree-kill on it takes the database down with it.
  assert.deepEqual(seen.found.map(s => s.pid), [2])
  assert.equal(seen.degraded, false)
  // ⛔ An empty snapshot is a failed listing: nothing is signalled on the strength of it.
  assert.deepEqual(liveSupervisors(snapshotFrom([]), { selfPid: 9 }), { degraded: true, found: [] })
})

// ---- attach ----------------------------------------------------------------------------------------

test('attach announces the degradation on a backend with nothing to attach to', async t => {
  // There are no silent no-ops: an operator who typed `fleet attach` and got a clean exit would go
  // looking for a session that never existed.
  const f = fleet(t)
  const r = await f.run('attach', '--json')
  assert.equal(r.code, 0)
  assert.equal(r.payload.attachable, false)
  assert.match(r.payload.notice, /detachSurvivesLauncher|no attachable session/)
  assert.match(r.stderr, /attach/)
})

test('attach hands back the exact argv (and what to unset) when the backend has a detached session', async t => {
  // ⛔ Printed, not spawned: attaching takes over the terminal, and the one sanctioned spawn helper
  // captures stdio rather than inheriting it, so a spawned client dies with "not a terminal".
  const f = makeRepo(t)
  const backend = createFakeBackend()
  backend.attachCommand = () => ({ command: 'tmux', args: ['-L', 'fleet', 'attach-session', '-t', '=fleet'], unsetEnv: ['TMUX'] })
  backend.sessionExists = () => true
  const r = await cli(['attach', '--json'], { ...f, backend })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.payload.attachable, true)
  assert.equal(r.payload.command, 'tmux')
  assert.deepEqual(r.payload.unsetEnv, ['TMUX'])
  // ⛔ `=fleet` MUST be quoted. zsh is the default macOS shell and treats a leading `=` as equals
  // expansion, so the unquoted line died with "zsh: fleet not found" before tmux ever ran — a
  // failure naming a command the operator never typed. The argv stays exact; only the printed line
  // is quoted.
  assert.deepEqual(r.payload.args, ['-L', 'fleet', 'attach-session', '-t', '=fleet'])
  assert.match(r.payload.run, /^unset TMUX && tmux -L fleet attach-session -t '=fleet'$/)
})

test('the printed attach line survives zsh: no equals expansion, and a path with a space stays one token', () => {
  assert.equal(shellQuote('=fleet'), `'=fleet'`)
  assert.equal(shellQuote('/Users/a b/tmux.conf'), `'/Users/a b/tmux.conf'`)
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  // Ordinary tokens are left alone, so the common line stays readable and copy-pasteable.
  assert.equal(shellQuote('attach-session'), 'attach-session')
  assert.equal(shellQuote('-L'), '-L')
})

// ---- watch -----------------------------------------------------------------------------------------

test('watch --once runs one composed pass and writes the supervisor status and the fleet manifest', async t => {
  // One pass, one process snapshot, every watcher reasoning over it: two watchers reading two
  // snapshots disagree about which processes exist, which is how a reclaimer once removed a worktree
  // a live agent was working in.
  const f = fleet(t)
  if (!await launch(t, f, 'up', '1', '--json')) return
  const stateDir = await stateDirOf(f)

  const r = await watchOnce(t, f, '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(r.payload.faults, [])
  assert.equal(r.payload.once, true)
  assert.ok(r.payload.checks.sessions, 'the supervisor checks ran')
  assert.equal(r.payload.guardian.parked, false)
  const status = JSON.parse(fs.readFileSync(path.join(stateDir, 'watch.status.json'), 'utf8'))
  assert.equal(status.pass, 1)
  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'fleet-manifest.json'), 'utf8'))
  assert.deepEqual(manifest.sessions.map(s => s.label), ['1'], 'a fleet must be rebuildable from a file, not from memory')
  assert.equal(fs.existsSync(path.join(stateDir, 'logs', 'watch.log')), true)
})

test('watch --once reclaims a session that flagged done, and leaves one that did not', async t => {
  const f = fleet(t)
  if (!await launch(t, f, 'up', '2', '--json')) return
  const stateDir = await stateDirOf(f)
  const one = readSession('1', { stateDir })
  const two = readSession('2', { stateDir })
  fs.mkdirSync(path.join(stateDir, 'flags'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'flags', 'done-1.json'), JSON.stringify({ v: 1, session: '1', outcome: 'no-code-change', reason: 'already fixed on the base branch', at: '2026-03-14T10:00:00Z' }))

  const r = await watchOnce(t, f, '--json')
  if (!r) return
  assert.equal(r.code, 0, r.stderr)
  const acted = r.payload.reclaimed.find(x => x.label === '1')
  assert.ok(acted, 'the flag authorises teardown, and the reclaimer must have acted on it')
  assert.equal(fs.existsSync(one.worktree), false, 'the flagged session\'s worktree is reclaimed')
  assert.equal(fs.existsSync(two.worktree), true, 'a session that has not flagged is never touched')
  assert.equal(f.backend.list().map(h => h.id).includes('1'), false)
})
