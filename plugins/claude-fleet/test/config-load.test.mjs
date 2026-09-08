import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run } from '../src/sys/exec.mjs'
import {
  gatherFacts, gitFacts, normalizeGitPath, parseWorktreeList, normalizeWorkspaces, expandWorkspaces, realPath,
  lockfileFacts, parseComposeServices, machineEnv, MACHINE_ENV_KEYS,
} from '../src/config/probe.mjs'
import {
  loadConfig, statusFor, cliLayer, machineBlockers, matchCheckout, matchRepoEntry, normalizePathKey,
  CURRENT_VERSION,
} from '../src/config/load.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { deriveConfig } from '../src/config/derive.mjs'

// ---- harness -----------------------------------------------------------------------------------

// realpath, because on macOS os.tmpdir() is /var/… while git answers /private/var/… — comparing the
// two directly fails a correct implementation for the wrong reason.
//
// ⛔ And `.native`, for the same reason one platform further: on Windows `os.tmpdir()` can hand back
// a path with an 8.3 component (`C:\Users\RUNNER~1\…` on the CI runners), plain `realpathSync`
// PRESERVES it, and git always expands it. Without `.native` these tests compare `RUNNER~1` against
// `runneradmin` and fail four correct implementations — while printing a git path that looks right,
// which is what made it read as a platform quirk rather than the real bug it is (probe.realPath).
function tmpRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-config-')))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  })
  return dir
}

const samePath = (a, b) => normalizePathKey(a) === normalizePathKey(b)
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function git(cwd, args) {
  const r = run('git', ['-C', cwd, ...args], { timeoutMs: 60_000 })
  assert.ok(r.ok, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** A real repository: one commit, an origin, a package.json and a lockfile. */
function makeRepo(t, { name = 'app', origin = 'https://github.com/acme/app.git', pkg = {} } = {}) {
  const parent = tmpRoot(t)
  const repo = path.join(parent, name)
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  if (origin) git(repo, ['remote', 'add', 'origin', origin])
  writeJson(path.join(repo, 'package.json'), { name, ...pkg })
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return { parent, repo }
}

// Exactly the contract §6 front-matter shape — `states` carries the three canonical transitions and
// nothing else. A fixture with an extra state would let this suite go green on an adapter no operator
// can write: none of the six shipped trackers/*.md declares one, and `ready` is a separate question
// precisely because a tracker may carry two unstarted-typed states.
const ADAPTER = {
  id: 'example-tracker',
  scope: { label: 'team', required: false },
  config: [],
  states: {
    'in-progress': { promptDefault: 'In Progress' },
    'in-review': { promptDefault: 'In Review' },
    cancelled: { promptDefault: 'Cancelled' },
  },
}
const loadAdapter = () => ADAPTER

/** Every path under `dir`, with size and mtime — enough to prove nothing was written. */
function treeSnapshot(dir) {
  const out = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        out.push(`D ${path.relative(dir, p)}`)
        walk(p)
      } else {
        const s = fs.statSync(p)
        out.push(`F ${path.relative(dir, p)} ${s.size} ${s.mtimeMs}`)
      }
    }
  }
  walk(dir)
  return out
}

// ---- probe: git --------------------------------------------------------------------------------

test('inside a linked worktree, primary is the MAIN checkout — not the worktree git reports', t => {
  // `git rev-parse --show-toplevel` answers the LINKED path. repo.worktreeParent derives from the
  // primary checkout, so trusting the toplevel makes a fleet launched from inside session 1 create
  // every new worktree as a sibling of session 1 instead of a sibling of the repo.
  const { parent, repo } = makeRepo(t)
  const wt = path.join(parent, 'app-session-1')
  git(repo, ['worktree', 'add', '-q', '-b', 'ada/abc-1234-slug', wt])

  const facts = gatherFacts({ cwd: wt, env: {} })
  assert.ok(samePath(facts.git.toplevel, wt), `toplevel ${facts.git.toplevel}`)
  assert.ok(samePath(facts.git.primary, repo), `primary ${facts.git.primary}`)
  assert.ok(samePath(facts.git.parent, parent))
  assert.equal(facts.git.worktrees.length, 2)
  assert.ok(facts.git.worktrees.some(w => samePath(w, wt)))

  const { config } = deriveConfig(defaultsFor(), facts, {})
  assert.ok(samePath(config.repo.worktreeParent, parent), 'a new worktree must land beside the repo')
  assert.equal(config.repo.name, 'app')
})

test('outside a git checkout gatherFacts still answers, with a warning and a stable local repoKey', t => {
  // `fleet config status` is run in any directory at all and must never throw; the operator learns
  // what is wrong from a warning, not from a stack trace.
  const dir = tmpRoot(t)
  if (run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 30_000 }).ok) {
    t.skip('the temp directory is itself inside a git checkout on this machine')
    return
  }
  writeJson(path.join(dir, 'package.json'), { name: 'app' })

  const facts = gatherFacts({ cwd: dir, env: {} })
  assert.equal(facts.git.toplevel, null)
  assert.deepEqual(facts.git.worktrees, [])
  assert.ok(facts.warnings.some(w => w.code === 'probe.not-a-git-repo'))
  assert.match(facts.repoKey, /^local:app@[0-9a-f]{8}$/)
  assert.ok(facts.machine.cpus >= 1 && facts.machine.totalRamGb > 0)
})

test('a remote that is not called origin still identifies the repo', t => {
  // Otherwise the same checkout gets a `local:` key — and therefore a second state directory, a second
  // lock pool and two sessions holding one testing slot — purely because of how it was cloned.
  const { repo } = makeRepo(t, { origin: null })
  git(repo, ['remote', 'add', 'upstream', 'git@github.com:acme/app.git'])
  assert.equal(gatherFacts({ cwd: repo, env: {} }).repoKey, 'github.com/acme/app')
})

test("git's POSIX separators are normalised before any path is compared", () => {
  // git prints `C:/w/app` on Windows; comparing that against a cwd or a user-config checkout key
  // never matches, and the fleet quietly behaves as if it were in a different repository.
  assert.equal(normalizeGitPath('C:/w/app', 'win32'), 'C:\\w\\app')
  assert.equal(normalizeGitPath('/w/app', 'linux'), '/w/app')
  assert.equal(normalizeGitPath('  ', 'linux'), null)
  assert.deepEqual(parseWorktreeList('worktree /w/app\nHEAD abc\n\nworktree /w/app-session-1\n', 'linux'), ['/w/app', '/w/app-session-1'])
})

// ---- probe: package.json, workspaces, lockfile ---------------------------------------------------

test('workspace expansion never walks node_modules', t => {
  // A glob that descends into node_modules turns a 200 ms probe into a 40 s one AND reports vendored
  // copies as workspace packages, which the donor-clone step then recreates as junctions.
  const { repo } = makeRepo(t)
  writeJson(path.join(repo, 'apps', 'web', 'package.json'), { name: 'web' })
  writeJson(path.join(repo, 'apps', 'api', 'package.json'), { name: 'api' })
  writeJson(path.join(repo, 'apps', 'web', 'node_modules', 'vendored', 'package.json'), { name: 'vendored' })
  fs.mkdirSync(path.join(repo, 'apps', 'docs'), { recursive: true }) // no package.json: not a package

  const found = expandWorkspaces(repo, ['apps/**']).map(w => w.name).sort()
  assert.deepEqual(found, ['api', 'web'])
  assert.deepEqual(expandWorkspaces(repo, ['apps/*']).find(w => w.name === 'web').dir, 'apps/web')
  // yarn v1 writes the object form, and a negation is not a directory to walk
  assert.deepEqual(normalizeWorkspaces({ packages: ['apps/*', '!apps/legacy'] }), ['apps/*'])
  assert.deepEqual(normalizeWorkspaces(undefined), [])
})

test('the lockfile hash is of the CONTENT', t => {
  // Install proof is keyed by this hash: a hash of the lockfile's path never changes, so every
  // worktree installed against an older dependency tree would pass the proof.
  const { repo } = makeRepo(t)
  const before = lockfileFacts(repo)
  assert.equal(before.packageManager, 'npm')
  fs.appendFileSync(path.join(repo, 'package-lock.json'), '\n')
  assert.notEqual(lockfileFacts(repo).lockfileHash, before.lockfileHash)
  assert.deepEqual(lockfileFacts(path.join(repo, 'apps')), { lockfile: null, packageManager: null, lockfileHash: null })
})

test('a malformed package.json is a warning, not a throw', t => {
  const { repo } = makeRepo(t)
  fs.writeFileSync(path.join(repo, 'package.json'), '{ "name": ')
  const facts = gatherFacts({ cwd: repo, env: {} })
  assert.ok(facts.warnings.some(w => w.code === 'probe.package-json-unreadable'))
  assert.equal(facts.pkg.name, null)
  assert.deepEqual(facts.pkg.scripts, {}) // derive.mjs indexes into scripts unconditionally
})

test('facts carry only the handful of environment variables a derivation needs', () => {
  // Facts are printed by --json, pasted into bug reports and dumped into logs; the whole environment
  // of a fleet machine holds every token its operator owns.
  const env = machineEnv({ LOCALAPPDATA: 'C:\\U\\ada\\AppData\\Local', GITHUB_TOKEN: 'ghp_secret', PATH: '/usr/bin' })
  assert.deepEqual(Object.keys(env), ['LOCALAPPDATA'])
  assert.ok(!MACHINE_ENV_KEYS.some(k => /TOKEN|SECRET|KEY$/i.test(k)))
})

test('compose services stop at the next top-level block', () => {
  // Reading on past `services:` turns a `volumes:` section's keys into containers the supervisor then
  // tries to start and health-check forever.
  const services = parseComposeServices(`version: "3"
services:
  app-postgres:
    image: postgres:16
    ports:
      - "5432:5432"
  cache:
    image: redis
    ports: ["6379:6379"]
volumes:
  pgdata:
    driver: local
`)
  assert.deepEqual(services.map(s => s.name), ['app-postgres', 'cache'])
  assert.equal(services[0].image, 'postgres:16')
  assert.deepEqual(services[0].ports, ['5432:5432'])
  assert.deepEqual(services[1].ports, ['6379:6379'])
})

// ---- load: layers ------------------------------------------------------------------------------

test('a corrupt project config is an ERROR — never a silent fall back to defaults', t => {
  // A syntax error in a committed .fleet/config.json would otherwise run the whole team's fleet on
  // built-in defaults (a different base branch, a different branch prefix) while reporting itself ok.
  const { repo } = makeRepo(t)
  fs.mkdirSync(path.join(repo, '.fleet'))
  fs.writeFileSync(path.join(repo, '.fleet', 'config.json'), '{ "commands": { "bootstrap": "npm ci", } }')

  const r = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(r.status, 'invalid')
  const err = r.errors.find(e => e.code === 'config.file.unreadable')
  assert.ok(err && err.file.endsWith(path.join('.fleet', 'config.json')), 'the error names the file')
})

test('a config file this build cannot understand is an error, not a best effort', t => {
  // A file from a newer format read as if it were current is exactly what contract §3's `version`
  // exists to prevent, and a JSON array is not a config however valid its JSON is.
  const { repo } = makeRepo(t)
  const file = path.join(repo, '.fleet', 'config.json')
  writeJson(file, { version: CURRENT_VERSION + 1, commands: { bootstrap: 'npm ci' } })

  const future = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(future.status, 'invalid')
  const v = future.errors.find(e => e.code === 'config.version.future')
  assert.ok(v && v.key === 'version' && v.message.includes(String(CURRENT_VERSION + 1)), JSON.stringify(future.errors))

  fs.writeFileSync(file, JSON.stringify([{ commands: { bootstrap: 'npm ci' } }]))
  const arr = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(arr.status, 'invalid')
  assert.ok(arr.errors.some(e => e.code === 'config.file.not-an-object'), JSON.stringify(arr.errors))
  assert.equal(arr.config.commands.bootstrap, null, 'nothing was salvaged from it')
})

test('a config file written with a UTF-8 BOM still loads', t => {
  // Windows editors add one by default, and JSON.parse rejects it — the file looks perfect in the
  // editor that just corrupted it.
  const { repo } = makeRepo(t)
  fs.mkdirSync(path.join(repo, '.fleet'))
  fs.writeFileSync(path.join(repo, '.fleet', 'config.json'), '\uFEFF' + JSON.stringify({ commands: { bootstrap: 'npm ci' } }))

  const r = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(r.config.commands.bootstrap, 'npm ci')
  assert.equal(r.sources['commands.bootstrap'], 'project')
  assert.ok(!r.errors.some(e => e.code === 'config.file.unreadable'), JSON.stringify(r.errors))
})

test('user layers: checkout beats repo beats defaults, whatever case or trailing slash they are written in', t => {
  // repoKeyFor lowercases the origin and a checkout can be written with a trailing separator; a
  // key-for-key comparison silently drops that machine's overrides and the operator sees the fleet
  // ignore a file it can plainly see.
  const { repo } = makeRepo(t)
  const userHome = path.join(tmpRoot(t), 'user-config')
  writeJson(path.join(userHome, 'config.json'), {
    version: CURRENT_VERSION,
    defaults: { fleet: { model: 'sonnet' }, install: { reservePhysicalGb: 6 } },
    repos: {
      'GitHub.com/Acme/App': {
        fleet: { model: 'haiku' },
        checkouts: { [repo + path.sep]: { fleet: { size: 3 } } },
      },
    },
  })

  const r = loadConfig({ cwd: repo, env: { FLEET_CONFIG_HOME: userHome }, loadAdapter })
  assert.equal(r.config.install.reservePhysicalGb, 6)
  assert.equal(r.config.fleet.model, 'haiku', 'the repo entry beats the user defaults')
  assert.equal(r.config.fleet.size, 3, 'the checkout entry applies despite the trailing separator')
  assert.equal(r.sources['fleet.size'], 'user-checkout')
  assert.equal(matchRepoEntry({ 'github.com/acme/app': 1 }, 'GitHub.com/Acme/App'), 1)
  assert.equal(matchCheckout({ '/w/app/': 1 }, '/w/app', 'linux'), 1)
})

test('a checkout key survives the OTHER spelling of the same directory — the Windows 8.3 alias', t => {
  // ⛔ `C:\Users\RUNNER~1\app` and `C:\Users\runneradmin\app` are one directory written two ways, and
  // they share almost no characters, so no amount of case-folding or slash-normalising brings them
  // together. git always prints the long form; `os.tmpdir()` and a shortcut's target often carry the
  // short one. Without canonicalisation the operator's whole `checkouts` entry is dropped for a file
  // they can plainly see — and worse, a session can derive a different paths.stateDir from its
  // launcher, which is two private lock pools over one fleet.
  const canonical = p => String(p).replace(/RUNNER~1/i, 'runneradmin')
  const short = String.raw`C:\Users\RUNNER~1\app`
  const long = String.raw`C:\Users\runneradmin\app`

  assert.equal(matchCheckout({ [short]: 1 }, long, 'win32', canonical), 1, 'key short, checkout long')
  assert.equal(matchCheckout({ [long]: 2 }, short, 'win32', canonical), 2, 'key long, checkout short')
  // The bug itself, so the test fails for the right reason if the canonicaliser is dropped.
  assert.equal(matchCheckout({ [short]: 1 }, long, 'win32'), null)
  // A canonicaliser that throws (an unreadable or absent path) must not take the match down with it:
  // a key naming another machine's checkout is ordinary, not an error.
  const throwing = () => { throw new Error('ENOENT') }
  assert.equal(matchCheckout({ [long]: 3 }, long, 'win32', p => (p === long ? p : throwing())), 3)
})

test('realPath expands an 8.3 component, which is what makes the match above reachable', t => {
  // The unit above injects the canonicaliser; this proves the real one does that job on this machine.
  if (process.platform !== 'win32') return t.skip('8.3 aliases are a Windows filesystem feature')
  const dir = tmpRoot(t)
  const nested = path.join(dir, 'a-directory-name-far-past-eight-three')
  fs.mkdirSync(nested)
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${JSON.stringify(nested)}).ShortPath`], { timeoutMs: 30_000 })
  const short = r.ok ? r.stdout.trim() : ''
  if (!short || !short.includes('~')) return t.skip('8.3 name generation is disabled on this volume')
  assert.notEqual(normalizePathKey(short, 'win32'), normalizePathKey(nested, 'win32'), 'the fixture really is a different spelling')
  assert.equal(normalizePathKey(realPath(short), 'win32'), normalizePathKey(nested, 'win32'))
})

test('the user checkout layer is keyed by the PRIMARY checkout, so a session sees it too', t => {
  // Session, slot and checker worktrees are created and destroyed by the fleet itself, so the only
  // path an operator can write down is the primary. Keyed by the toplevel, a session inside a linked
  // worktree resolves a DIFFERENT paths.stateDir from its launcher — two private lock pools, and the
  // same testing slot handed to two sessions.
  const { parent, repo } = makeRepo(t)
  const wt = path.join(parent, 'app-session-1')
  git(repo, ['worktree', 'add', '-q', '-b', 'ada/abc-1234-slug', wt])
  const moved = path.join(tmpRoot(t), 'elsewhere')
  const userHome = path.join(tmpRoot(t), 'user-config')
  writeJson(path.join(userHome, 'config.json'), {
    version: CURRENT_VERSION,
    repos: { 'github.com/acme/app': { checkouts: { [repo]: { paths: { stateDir: moved }, fleet: { size: 3 } } } } },
  })

  const env = { FLEET_CONFIG_HOME: userHome }
  const launcher = loadConfig({ cwd: repo, env, loadAdapter })
  const session = loadConfig({ cwd: wt, env, loadAdapter })

  assert.equal(launcher.paths.stateDir, moved)
  assert.equal(session.paths.stateDir, moved, 'a session resolves its launcher state dir')
  assert.equal(session.paths.state.locks, launcher.paths.state.locks, 'one lock pool, not two')
  assert.equal(session.config.fleet.size, 3)
  assert.equal(session.sources['fleet.size'], 'user-checkout')
  assert.ok(!session.warnings.some(w => w.code === 'config.user.checkout-unmatched'), JSON.stringify(session.warnings))
})

test('a user file that reaches nothing says so, instead of being ignored in silence', t => {
  // The file is only mined through `defaults`, `repos[repoKey]` and that entry's `checkouts`, so a
  // typo there never reaches resolveConfig and `config.unknown-key` cannot fire for it.
  const { repo } = makeRepo(t)
  const typoHome = path.join(tmpRoot(t), 'user-config-typo')
  writeJson(path.join(typoHome, 'config.json'), {
    version: CURRENT_VERSION,
    default: { fleet: { model: 'sonnet' } }, // a typo for `defaults`: read by nothing
    repos: { 'github.com/acme/other': { fleet: { model: 'haiku' } } },
  })

  const r = loadConfig({ cwd: repo, env: { FLEET_CONFIG_HOME: typoHome }, loadAdapter })
  assert.equal(r.config.fleet.model, 'opus', 'nothing in the file took effect')
  const unrecognised = r.warnings.find(w => w.code === 'config.user.unrecognised')
  assert.ok(unrecognised && unrecognised.key === 'default', JSON.stringify(r.warnings))
  const unmatched = r.warnings.find(w => w.code === 'config.user.repo-unmatched')
  assert.ok(unmatched && unmatched.message.includes('github.com/acme/other'), 'the keys that WERE present are named')

  const strayHome = path.join(tmpRoot(t), 'user-config-stray')
  writeJson(path.join(strayHome, 'config.json'), {
    version: CURRENT_VERSION,
    repos: { 'github.com/acme/app': { checkouts: { '/w/some-other-clone': { fleet: { size: 9 } } } } },
  })
  const stray = loadConfig({ cwd: repo, env: { FLEET_CONFIG_HOME: strayHome }, loadAdapter })
  const miss = stray.warnings.find(w => w.code === 'config.user.checkout-unmatched')
  assert.ok(miss && miss.message.includes('/w/some-other-clone'), JSON.stringify(stray.warnings))
  assert.notEqual(stray.config.fleet.size, 9)
})

test('the whole precedence chain: cli beats env beats project-local beats project', t => {
  // The flag exists to run one wave differently without editing a committed file (contract §7), and
  // the env layer sits between them — asserted here end to end, because resolveConfig only ever sees
  // layers someone else assembled.
  const { repo } = makeRepo(t)
  writeJson(path.join(repo, '.fleet', 'config.json'), { commands: { bootstrap: 'npm ci', devServer: 'npm run dev' }, testing: { count: 0 } })
  writeJson(path.join(repo, '.fleet', 'config.local.json'), { testing: { count: 3 } })
  const env = { FLEET_TESTING_COUNT: '1' }

  const r = loadConfig({ cwd: repo, argv: ['up', '3', '--testing', '2'], env, loadAdapter })
  assert.equal(r.config.testing.count, 2)
  assert.equal(r.sources['testing.count'], 'cli')

  const noFlag = loadConfig({ cwd: repo, argv: ['up', '3'], env, loadAdapter })
  assert.equal(noFlag.config.testing.count, 1, 'the env layer beats both file layers')
  assert.equal(noFlag.sources['testing.count'], 'env')

  const filesOnly = loadConfig({ cwd: repo, argv: ['up', '3'], env: {}, loadAdapter })
  assert.equal(filesOnly.config.testing.count, 3, 'the gitignored local file beats the committed one')
  assert.equal(filesOnly.sources['testing.count'], 'project-local')
  assert.ok(filesOnly.layers.includes('project-local'), filesOnly.layers.join(','))
})

test('.fleet/config.local.json is a layer that is really read from disk', t => {
  // Nothing else loads one: paths.projectLocalFile could be misspelled (`config-local.json`) and the
  // suite would stay green while a contract §3 layer silently stopped applying.
  const { repo } = makeRepo(t)
  writeJson(path.join(repo, '.fleet', 'config.json'), { commands: { bootstrap: 'npm ci' }, repo: { baseBranch: 'develop' } })
  writeJson(path.join(repo, '.fleet', 'config.local.json'), { repo: { baseBranch: 'trunk' } })

  const r = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(r.config.repo.baseBranch, 'trunk')
  assert.equal(r.sources['repo.baseBranch'], 'project-local')
  assert.ok(r.files.some(f => f.layer === 'project-local' && f.exists), JSON.stringify(r.files))
})

test('--testing is read on `fleet up` alone, and never past a `--`', t => {
  // A whole-argv scan let `fleet send 3 rerun with --testing 2` resize the pool out of a message
  // someone was quoting, and swallowed the next flag whole while failing to coerce it.
  assert.deepEqual(cliLayer(['up', '--testing=4']).data, { testing: { count: 4 } })
  assert.equal(cliLayer(['up', '--testing', 'lots']).warnings[0].code, 'config.cli.invalid')
  assert.deepEqual(cliLayer(['up', '--dry-run', '--json']).data, {}, 'no flag is invented to reach a key')

  assert.deepEqual(cliLayer(['send', '3', 'rerun', 'with', '--testing', '2']).data, {}, 'send owns no config flag')
  assert.deepEqual(cliLayer(['check', 'plan', '--testing', '2']).data, {})
  assert.deepEqual(cliLayer(['up', '--', '--testing', '2']).data, {}, 'a `--` ends the flags')
  assert.deepEqual(cliLayer(['--testing', '2']).data, {}, 'a verb-less argv reaches no key')
  assert.deepEqual(cliLayer(['send', '--testing', '2'], 'up').data, { testing: { count: 2 } }, 'the parsed verb wins')

  const dangling = cliLayer(['up', '--testing', '--dry-run'])
  assert.deepEqual(dangling.data, {}, '--dry-run is not a slot count and is not consumed as one')
  assert.equal(dangling.warnings[0].message, '--testing needs a slot count')
})

test('the resolved state dir owns the lock and flag layout', t => {
  // If the layout kept pointing at the derived default, an operator who moves paths.stateDir would
  // leave the launcher and its sessions with a private pool each — and one testing slot held twice.
  const { repo } = makeRepo(t)
  const moved = path.join(tmpRoot(t), 'elsewhere')
  const userHome = path.join(tmpRoot(t), 'user-config')
  writeJson(path.join(userHome, 'config.json'), { version: CURRENT_VERSION, defaults: { paths: { stateDir: moved } } })

  const r = loadConfig({ cwd: repo, env: { FLEET_CONFIG_HOME: userHome }, loadAdapter })
  assert.equal(r.paths.stateDir, moved)
  assert.equal(r.paths.state.locks, path.join(moved, 'locks'))
  assert.equal(r.config.paths.artifactsDir, path.join(moved, 'dev-pages'))
})

test('loading writes nothing at all', t => {
  // `fleet config status` runs in repositories that have never seen this tool. A status command that
  // creates its own state directory turns "let me check" into a change to someone else's machine.
  const { parent, repo } = makeRepo(t)
  const userHome = path.join(parent, 'user-config-never-created')
  const before = treeSnapshot(parent)

  const r = loadConfig({ cwd: repo, env: { FLEET_CONFIG_HOME: userHome }, loadAdapter })
  assert.ok(r.status, 'it still answers')
  assert.deepEqual(treeSnapshot(parent), before)
  assert.equal(fs.existsSync(r.paths.stateDir), false)
  assert.equal(fs.existsSync(r.paths.projectDir), false)
  assert.equal(fs.existsSync(userHome), false)
})

// ---- status ------------------------------------------------------------------------------------

test('the status ladder answers the FIRST question the operator has to settle', () => {
  // A status that reported "invalid" for every repository that simply has not been set up yet would
  // train the operator to ignore it, so an unanswered wizard question is never an invalid config.
  const config = defaultsFor()
  for (const [k, v] of Object.entries({
    'repo.name': 'app',
    'repo.worktreeParent': '/w',
    'paths.stateDir': '/s',
    'fleet.size': 4,
    'commands.bootstrap': 'npm ci',
    'tracker.id': 'example-tracker',
    'checker.ready.state': 'Todo',
  })) setPath(config, k, v)
  const base = { config, errors: [], files: [{ layer: 'project', exists: true }], versions: [], facts: { git: { toplevel: '/w/app' } }, adapter: ADAPTER }

  assert.equal(statusFor(base), 'ok')
  assert.equal(statusFor({ ...base, versions: [{ version: 0 }], errors: [{ code: 'config.type', key: 'testing.count' }] }), 'unmigrated', 'nothing below can be trusted before a migration')
  assert.equal(statusFor({ ...base, errors: [{ code: 'config.type', key: 'testing.count' }] }), 'invalid')
  assert.equal(statusFor({ ...base, facts: {} }), 'needs-machine', 'init cannot help a shell that is not in a checkout')
  assert.equal(statusFor({ ...base, files: [{ layer: 'project', exists: false }] }), 'needs-init')
  assert.equal(statusFor({ ...base, errors: [{ code: 'config.missing-required', key: 'commands.devServer' }] }), 'needs-init')
  assert.equal(statusFor({ ...base, adapter: null }), 'needs-tracker', 'the registry could not answer for the configured tracker')
  assert.equal(statusFor({ ...base, config: withKey(config, 'checker.ready.state', null) }), 'needs-checker')
  assert.equal(statusFor({ ...base, config: withKey(config, 'tracker.mode', 'none'), adapter: null }), 'ok', 'a tracker-less fleet is complete without one')
  assert.deepEqual(machineBlockers(config, {}), ['repo'])
})

const withKey = (config, key, value) => setPath(JSON.parse(JSON.stringify(config)), key, value)

test('a fresh repository needs init, and says so without inventing an answer', t => {
  const { parent, repo } = makeRepo(t)
  const r = loadConfig({ cwd: repo, env: {}, loadAdapter })

  assert.equal(r.status, 'needs-init')
  assert.equal(r.config.commands.bootstrap, null, 'the one required key stays unanswered')
  assert.ok(r.errors.some(e => e.code === 'config.missing-required' && e.key === 'commands.bootstrap'))
  assert.equal(r.facts.repoKey, 'github.com/acme/app')
  assert.ok(samePath(r.config.repo.worktreeParent, parent))
  assert.equal(r.config.vcs.branchPrefix, 'ada')
  assert.equal(r.config.vcs.host, 'github')
  assert.equal(r.sources['repo.baseBranch'], 'defaults')
})

test('a config complete but for the ready state stops at needs-checker, and is ok once it is answered', t => {
  // ⛔ The adapter supplies the three canonical transitions and NOT the ready state: contract §6
  // declares `ready` separately because a tracker may carry two unstarted-typed states (a backlog and
  // a to-do) and /fleet-check must not guess which one a passed ticket is promoted to.
  const { repo } = makeRepo(t, { pkg: { scripts: { dev: 'node scripts/dev-hosts.mjs' } } })
  const file = path.join(repo, '.fleet', 'config.json')
  const project = {
    version: CURRENT_VERSION,
    commands: { bootstrap: 'npm ci', devServer: 'npm run dev' },
    tracker: { id: 'example-tracker', mode: 'mcp' },
  }
  writeJson(file, project)

  const r = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(r.status, 'needs-checker', JSON.stringify(r.errors))
  assert.equal(r.config.checker.ready.state, null, 'no adapter default invents one')
  assert.equal(r.config.tracker.states['in-review'], 'In Review')
  assert.deepEqual(r.config.fleet.queue.selector.excludeLabels, ['triage'])
  assert.equal(r.slots.length, r.config.testing.maxSlots)
  assert.equal(r.slots[1].branch, 'testing-2')
  // the dev-server pattern is resolved through package.json scripts, not stored as the npm wrapper
  assert.equal(r.config.devServer.serverProcessPattern, 'dev-hosts\\.mjs')

  writeJson(file, { ...project, checker: { ready: { state: 'Todo' } } })
  const answered = loadConfig({ cwd: repo, env: {}, loadAdapter })
  assert.equal(answered.status, 'ok', JSON.stringify(answered.errors))
  assert.equal(answered.config.checker.ready.state, 'Todo')
  assert.equal(answered.config.fleet.queue.selector.state, 'Todo', 'the queue asks for the ready state')
})

test('without a tracker registry the adapter is missing loudly, never assumed', t => {
  // Silently defaulting the tracker states would make a session move a ticket into a state that does
  // not exist on the operator's board, and the failure would surface one ticket at a time.
  const { repo } = makeRepo(t)
  writeJson(path.join(repo, '.fleet', 'config.json'), {
    commands: { bootstrap: 'npm ci', devServer: 'npm run dev' },
    tracker: { id: 'example-tracker', mode: 'mcp' },
  })

  const r = loadConfig({ cwd: repo, env: {} })
  assert.equal(r.adapter, null)
  assert.ok(r.warnings.some(w => w.code === 'config.adapter.unavailable'))
  assert.equal(r.status, 'needs-tracker')
})

test('an adapter file that cannot be parsed names the tracker, and is never defaulted around', t => {
  // The registry answering with a throw is a different failure from having no registry at all: the
  // configured tracker exists and its file is broken, which the operator has to fix before any state
  // name can be trusted.
  const { repo } = makeRepo(t)
  writeJson(path.join(repo, '.fleet', 'config.json'), {
    commands: { bootstrap: 'npm ci', devServer: 'npm run dev' },
    tracker: { id: 'example-tracker', mode: 'mcp' },
  })

  const r = loadConfig({ cwd: repo, env: {}, loadAdapter: () => { throw new Error('front matter is not valid YAML') } })
  assert.equal(r.adapter, null)
  const e = r.errors.find(x => x.code === 'config.adapter.unreadable')
  assert.ok(e && e.key === 'tracker.id', JSON.stringify(r.errors))
  assert.ok(e.message.includes('example-tracker') && e.message.includes('front matter'), e && e.message)
  assert.equal(r.status, 'invalid', 'a broken adapter file is a broken config, not an unanswered question')
  assert.equal(r.config.tracker.states['in-review'], null, 'no state name is assumed')
})

test('facts that describe no machine ask for the machine first, and name every blocker', t => {
  // `fleet config status` runs in a shell that is not inside a checkout at all; the wizard cannot help
  // there, so the status must say so and list what is unresolved rather than inventing a state dir.
  const dir = tmpRoot(t)
  const facts = { git: {}, machine: {}, pkg: { name: null, scripts: {} }, repoKey: null, warnings: [] }

  const r = loadConfig({ cwd: dir, env: {}, facts, loadAdapter })
  assert.equal(r.status, 'needs-machine')
  assert.deepEqual(machineBlockers(r.config, r.facts), ['repo', 'repo.name', 'repo.worktreeParent', 'paths.stateDir', 'fleet.size'])
  const w = r.warnings.find(x => x.code === 'config.machine.unresolved')
  assert.ok(w && w.message.includes('paths.stateDir') && w.message.includes('fleet.size'), JSON.stringify(r.warnings))
  assert.equal(r.config.paths.stateDir, null, 'no state directory is invented for a machine with no repo key')
})

test('gitFacts reports a missing git identity rather than deriving a branch prefix from nothing', t => {
  // An empty prefix renders branches as "/abc-1234-slug", which git accepts and nobody can find.
  const { repo } = makeRepo(t)
  git(repo, ['config', '--unset', 'user.name'])
  const { git: g, warnings } = gitFacts({ cwd: repo })
  assert.equal(g.userName, null)
  assert.ok(warnings.some(w => w.code === 'probe.no-git-user'))
  assert.equal(deriveConfig(defaultsFor(), { git: g, machine: {} }, {}).config.vcs.branchPrefix, null)
})
