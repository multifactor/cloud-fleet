import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { resolveConfig } from '../src/config/resolve.mjs'
import {
  buildSlots, slotBranch, renderTemplate, slugify, branchPrefixFor, hostFromRemote,
  serverProcessPattern, junctionsFromWorkspaces, fleetSizeFor, deriveConfig, INSTALL_HARD_CAP,
} from '../src/config/derive.mjs'
import {
  normalizeRemote, repoKeyFor, repoSlug, transcriptSlug, configPaths, stateDirFor, stateLayout,
  sessionFolder, slotFolder, claudeProjectsDir,
} from '../src/config/paths.mjs'
import { envLayer, coerceEnv, buildSessionEnv } from '../src/config/env.mjs'
import { validateConfig } from '../src/config/validate.mjs'
import { SCHEMA_BY_KEY } from '../src/config/schema.mjs'

const FACTS = {
  repoKey: 'github.com/acme/app',
  git: { toplevel: '/w/app', primary: '/w/app', parent: '/w', remoteUrl: 'git@github.com:acme/app.git', userName: 'Ada Lovelace', userEmail: 'ada@example.com', commonDir: '/w/app/.git', worktrees: ['/w/app', '/w/app-session-1'] },
  pkg: { name: 'app', workspaces: ['apps/*', 'packages/*'], scripts: { 'dev:hosts': 'node scripts/dev-hosts.mjs', dev: 'npm run dev:hosts -- --open', test: 'jest' } },
  workspacePackages: [{ name: 'web', dir: 'apps/web' }, { name: '@acme/db', dir: 'packages/db' }],
  machine: { platform: 'linux', cpus: 16, totalRamGb: 64, homedir: '/home/ada', env: {} },
}

function cfg(overrides = {}) {
  const c = defaultsFor()
  for (const [k, v] of Object.entries(overrides)) setPath(c, k, v)
  return c
}

// ---- paths -------------------------------------------------------------------------------------

test('normalizeRemote: https, scp, ssh://, credentials, .git, case, subgroups', () => {
  assert.equal(normalizeRemote('https://github.com/Acme/App.git'), 'github.com/acme/app')
  assert.equal(normalizeRemote('git@github.com:acme/app.git'), 'github.com/acme/app')
  assert.equal(normalizeRemote('ssh://git@github.com/acme/app'), 'github.com/acme/app')
  assert.equal(normalizeRemote('https://user:tok@gitlab.example.com/group/sub/app.git'), 'gitlab.example.com/group/sub/app')
  assert.equal(normalizeRemote('https://github.com/acme/app/'), 'github.com/acme/app')
  assert.equal(normalizeRemote(''), null)
  assert.equal(normalizeRemote('not a url'), null)
})

test('a LOCAL path remote is not a repo identity — it falls through to the local key', () => {
  // On Windows `C:/repos/app.git` parses as the scp form host:path, so the drive letter became the
  // "host" and the key became `c/repos/app`. One command resolved the remote and another fell back
  // to the local form, so the two read different state directories and a running fleet was
  // invisible to its own `status` and `down`.
  for (const local of ['C:/repos/app.git', 'C:\repos\app.git', '/srv/git/app.git', 'file:///srv/git/app.git', '//server/share/app.git']) {
    assert.equal(normalizeRemote(local), null, local)
  }
  // and a path remote therefore yields the stable local key, not a bogus host one
  const k = repoKeyFor({ remoteUrl: 'C:/repos/app.git', gitCommonDir: '/w/app/.git', name: 'app' })
  assert.match(k, /^local:app@[0-9a-f]{8}$/)
  // a real remote still resolves, including subgroups
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com/group/sub/app.git'), 'gitlab.example.com/group/sub/app')
})

test('repoKeyFor falls back to a stable local key; repoSlug is filesystem-safe', () => {
  assert.equal(repoKeyFor({ remoteUrl: 'git@github.com:acme/app.git' }), 'github.com/acme/app')
  const a = repoKeyFor({ remoteUrl: null, gitCommonDir: '/w/app/.git', name: 'app' })
  const b = repoKeyFor({ remoteUrl: null, gitCommonDir: '/w/app/.git', name: 'app' })
  assert.equal(a, b)
  assert.match(a, /^local:app@[0-9a-f]{8}$/)
  assert.equal(repoSlug('github.com/acme/app'), 'github.com-acme-app')
  assert.equal(repoSlug('local:app@1234abcd'), 'local-app-1234abcd')
})

test('transcriptSlug matches the observed Claude Code directory names', () => {
  assert.equal(transcriptSlug('C:\\projects\\monorepo'), 'C--projects-monorepo')
  assert.equal(transcriptSlug('C:\\projects\\monorepo-session-7'), 'C--projects-monorepo-session-7')
  assert.equal(transcriptSlug('C:\\projects\\app.example.com'), 'C--projects-app-example-com')
  assert.equal(transcriptSlug('/Users/ada/code/app'), '-Users-ada-code-app')
})

test('configPaths / stateDir per platform, honouring overrides', () => {
  const win = configPaths({ platform: 'win32', env: { APPDATA: 'C:\\U\\ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\U\\ada\\AppData\\Local' }, homedir: 'C:\\U\\ada', repoRoot: 'C:\\w\\app', repoKey: 'github.com/acme/app' })
  assert.equal(win.projectFile, 'C:\\w\\app\\.fleet\\config.json')
  assert.equal(win.userFile, 'C:\\U\\ada\\AppData\\Roaming\\claude-fleet\\config.json')
  assert.equal(win.stateDir, 'C:\\U\\ada\\AppData\\Local\\claude-fleet\\github.com-acme-app')
  const nix = configPaths({ platform: 'linux', env: {}, homedir: '/home/ada', repoRoot: '/w/app', repoKey: 'github.com/acme/app' })
  assert.equal(nix.userFile, '/home/ada/.config/claude-fleet/config.json')
  assert.equal(nix.stateDir, '/home/ada/.local/state/claude-fleet/github.com-acme-app')
  const xdg = configPaths({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state', FLEET_CONFIG_HOME: '/override' }, homedir: '/Users/ada', repoRoot: '/w/app', repoKey: 'k' })
  assert.equal(xdg.userDir, '/override')
  assert.equal(xdg.stateDir, '/x/state/claude-fleet/k')
  assert.equal(claudeProjectsDir({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/cc' }, homedir: '/h' }), '/cc/projects')
  assert.ok(!stateDirFor({ platform: 'darwin', env: {}, homedir: '/Users/ada', repoKey: 'k' }).includes('/var/folders'))
})

test('stateLayout, sessionFolder, slotFolder', () => {
  const l = stateLayout('/s', 'linux')
  assert.equal(l.sessions, '/s/sessions')
  assert.equal(l.outbox, '/s/tracker-outbox')
  assert.equal(l.queue, '/s/queue.txt')
  // `fleet up` and `fleet doctor --verify-primary` both write it, so a layout that does not know it
  // is a state file nothing enumerates — teardown included.
  assert.equal(l.installReference, '/s/install-reference.json')
  assert.equal(sessionFolder({ platform: 'linux', worktreeParent: '/w', repoName: 'app', template: '{repo}-session-{n}', n: 3 }), '/w/app-session-3')
  assert.equal(slotFolder({ platform: 'win32', worktreeParent: 'C:\\w', repoName: 'app', slotBranch: 'testing-2' }), 'C:\\w\\app-testing-2')
})

// ---- derive ------------------------------------------------------------------------------------

test('buildSlots reproduces the slot table: testing / testing-2 … and the matching suffixes', () => {
  const slots = buildSlots(cfg({ 'repo.name': 'app', 'devServer.urlTemplate': 'https://{branch}.dev.localhost' }))
  assert.deepEqual(slots.map(s => s.branch), ['testing', 'testing-2', 'testing-3', 'testing-4'])
  assert.deepEqual(slots.map(s => s.suffix), ['-testing', '-testing-2', '-testing-3', '-testing-4'])
  assert.equal(slots[1].url, 'https://testing-2.dev.localhost')
  assert.equal(slotBranch('testing', 1), 'testing')
})

test('buildSlots with the fixed-port template derives ports by stride', () => {
  const slots = buildSlots(cfg({ 'devServer.portBase': 3000, 'devServer.portStride': 10, 'testing.maxSlots': 2 }))
  assert.deepEqual(slots.map(s => [s.port, s.url]), [[3000, 'http://localhost:3000'], [3010, 'http://localhost:3010']])
})

test('renderTemplate leaves unknown tokens and renders {slot} {repo}', () => {
  assert.equal(renderTemplate('{repo}-{slot}-{nope}', { repo: 'app', slot: 2 }), 'app-2-{nope}')
})

test('slugify / branchPrefixFor / hostFromRemote', () => {
  assert.equal(slugify('Ada Lovelace!'), 'ada-lovelace')
  assert.equal(branchPrefixFor('Ada Lovelace'), 'ada')
  assert.equal(branchPrefixFor('  jean-luc  picard'), 'jean-luc')
  assert.equal(branchPrefixFor(''), null)
  assert.equal(hostFromRemote('git@github.com:acme/app.git'), 'github')
  assert.equal(hostFromRemote('https://gitlab.example.com/g/app'), 'gitlab')
  assert.equal(hostFromRemote('https://bitbucket.org/x/y'), 'other')
})

test('serverProcessPattern resolves npm-run chains to the entry file and escapes it', () => {
  assert.equal(serverProcessPattern('npm run dev', FACTS.pkg.scripts), 'dev-hosts\\.mjs')
  assert.equal(serverProcessPattern('npm run dev:hosts', FACTS.pkg.scripts), 'dev-hosts\\.mjs')
  assert.equal(serverProcessPattern('pnpm dev', { dev: 'node ./server/index.js --port 3000' }), 'index\\.js')
  assert.equal(serverProcessPattern('next dev', {}), 'next')
  assert.equal(serverProcessPattern('', {}), null)
  // a self-referencing script does not loop forever
  assert.equal(serverProcessPattern('npm run dev', { dev: 'npm run dev' }), 'npm')
})

test('junctionsFromWorkspaces and fleetSizeFor', () => {
  assert.deepEqual(junctionsFromWorkspaces(FACTS.workspacePackages), [{ link: 'web', target: 'apps/web' }, { link: '@acme/db', target: 'packages/db' }])
  assert.equal(fleetSizeFor({ totalRamGb: 64, cpus: 16 }, { reservePhysicalGb: 8, perInstallGb: 4 }), 14)
  assert.equal(fleetSizeFor({ totalRamGb: 64, cpus: 8 }, { reservePhysicalGb: 8, perInstallGb: 4 }), 8)
  assert.equal(fleetSizeFor({ totalRamGb: 8, cpus: 4 }, { reservePhysicalGb: 8, perInstallGb: 4 }), 1)
})

test('deriveConfig fills every derived key from facts and leaves set values alone', () => {
  const { config, slots, junctions, warnings } = deriveConfig(cfg({ 'commands.devServer': 'npm run dev', 'checker.triage.label': 'triage' }), FACTS)
  assert.equal(config.repo.name, 'app')
  assert.equal(config.repo.worktreeParent, '/w')
  assert.equal(config.vcs.branchPrefix, 'ada')
  assert.equal(config.vcs.host, 'github')
  assert.equal(config.devServer.serverProcessPattern, 'dev-hosts\\.mjs')
  assert.equal(config.paths.stateDir, '/home/ada/.local/state/claude-fleet/github.com-acme-app')
  assert.equal(config.paths.artifactsDir, '/home/ada/.local/state/claude-fleet/github.com-acme-app/dev-pages')
  assert.equal(config.install.donor.path, '/home/ada/.local/state/claude-fleet/github.com-acme-app/nm-donor')
  assert.equal(config.paths.transcriptsDir, '/home/ada/.claude/projects')
  assert.equal(config.fleet.size, 14)
  assert.equal(config.fleet.hardCeiling, 16)
  assert.deepEqual(config.testing.branches, ['testing', 'testing-2', 'testing-3', 'testing-4'])
  assert.deepEqual(config.fleet.queue.selector.excludeLabels, ['triage'])
  assert.equal(slots.length, 4)
  assert.equal(junctions.length, 2)
  assert.deepEqual(warnings, [])
  // explicit values survive
  const { config: c2 } = deriveConfig(cfg({ 'vcs.branchPrefix': 'team', 'fleet.size': 3 }), FACTS)
  assert.equal(c2.vcs.branchPrefix, 'team')
  assert.equal(c2.fleet.size, 3)
  assert.equal(c2.fleet.hardCeiling, 5)
})

test('deriveConfig takes tracker states and the ready state from the adapter', () => {
  const adapter = { states: { 'in-progress': { promptDefault: 'In Progress' }, 'in-review': { promptDefault: 'In Review' }, cancelled: { promptDefault: 'Canceled' }, unstarted: { promptDefault: 'Todo' } } }
  const { config } = deriveConfig(cfg(), FACTS, { adapter })
  assert.equal(config.tracker.states['in-progress'], 'In Progress')
  assert.equal(config.tracker.states.cancelled, 'Canceled')
  assert.equal(config.checker.ready.state, 'Todo')
  assert.equal(config.fleet.queue.selector.state, 'Todo')
})

test('deriveConfig clamps install.concurrencyCap to the hard cap with a warning (the install burst is what freezes a box)', () => {
  const { config, warnings } = deriveConfig(cfg({ 'install.concurrencyCap': 8 }), FACTS)
  assert.equal(config.install.concurrencyCap, INSTALL_HARD_CAP)
  assert.equal(warnings[0].code, 'config.install.cap-clamped')
})

test('junctions.mode none yields no links even with extras; explicit yields only extras', () => {
  assert.deepEqual(deriveConfig(cfg({ 'install.junctions.mode': 'none', 'install.junctions.extra': [{ link: 'x', target: 'y' }] }), FACTS).junctions, [])
  assert.deepEqual(deriveConfig(cfg({ 'install.junctions.mode': 'explicit', 'install.junctions.extra': [{ link: 'x', target: 'y' }] }), FACTS).junctions, [{ link: 'x', target: 'y' }])
})

// ---- env ---------------------------------------------------------------------------------------

test('coerceEnv by type; blank is unset in envLayer; bad values warn and are skipped', () => {
  assert.deepEqual(coerceEnv(SCHEMA_BY_KEY.get('testing.count'), '2'), { value: 2 })
  assert.ok(coerceEnv(SCHEMA_BY_KEY.get('testing.count'), '2.5').error)
  assert.deepEqual(coerceEnv(SCHEMA_BY_KEY.get('install.donor.enabled'), 'YES'), { value: true })
  assert.ok(coerceEnv(SCHEMA_BY_KEY.get('install.donor.enabled'), 'maybe').error)
  assert.deepEqual(coerceEnv(SCHEMA_BY_KEY.get('capture.requiredEnv'), ' A, B ,,C '), { value: ['A', 'B', 'C'] })
  const { data, warnings } = envLayer({ FLEET_TESTING_COUNT: '0', FLEET_INSTALL_SETTLE_SEC: '   ', FLEET_FLEET_MODEL: 'opus', FLEET_INSTALL_HOLD_POLL_SEC: 'soon', UNRELATED: 'x' })
  assert.deepEqual(data, { testing: { count: 0 }, fleet: { model: 'opus' } })
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].key, 'install.holdPollSec')
})

test('the env layer feeds resolveConfig and wins over the project layer', () => {
  const { data } = envLayer({ FLEET_TESTING_COUNT: '0' })
  const { config, sources } = resolveConfig({ layers: [{ name: 'project', data: { testing: { count: 3 } } }, { name: 'env', data }] })
  assert.equal(config.testing.count, 0)
  assert.equal(sources['testing.count'], 'env')
})

test('buildSessionEnv mirrors the contract scalars and adds the checker extras', () => {
  const c = cfg({ 'tracker.mode': 'manual' })
  const base = { label: 3, role: 'working', file: '/s/sessions/3.json', stateFile: '/s/sessions/3.state', stateDir: '/s', testingUrls: ['https://testing.dev.localhost', 'https://testing-2.dev.localhost'] }
  const env = Object.fromEntries(buildSessionEnv(c, base).map(e => [e.name, e.value]))
  assert.equal(env.FLEET_SESSION, '1')
  assert.equal(env.FLEET_LABEL, '3')
  assert.equal(env.FLEET_ROLE, 'working')
  assert.equal(env.FLEET_TESTING_URL, 'https://testing.dev.localhost')
  assert.equal(env.FLEET_TESTING_URLS, 'https://testing.dev.localhost,https://testing-2.dev.localhost')
  assert.equal(env.FLEET_TRACKER_MODE, 'manual')
  assert.equal(env.FLEET_SWEEP_DIR, undefined)
  const chk = Object.fromEntries(buildSessionEnv(c, { ...base, role: 'checker', sweepDir: '/s/sweeps/ABC-1', slice: 'a01' }).map(e => [e.name, e.value]))
  assert.equal(chk.FLEET_SWEEP_DIR, '/s/sweeps/ABC-1')
  assert.equal(chk.FLEET_SLICE, 'a01')
  assert.throws(() => buildSessionEnv(c, { ...base, stateDir: undefined }), /FLEET_STATE_DIR/)
})

// ---- validate ----------------------------------------------------------------------------------

test('validateConfig: required bootstrap, devServer when slots > 0, count range, enums', () => {
  const { errors } = validateConfig(cfg())
  const codes = errors.map(e => e.key).sort()
  assert.ok(codes.includes('commands.bootstrap'))
  assert.ok(codes.includes('commands.devServer'))
  assert.ok(codes.includes('tracker.id'))
  const ok = validateConfig(cfg({ 'commands.bootstrap': 'npm ci', 'testing.count': 0, 'tracker.mode': 'none' }))
  assert.deepEqual(ok.errors, [])
  const range = validateConfig(cfg({ 'commands.bootstrap': 'npm ci', 'commands.devServer': 'npm run dev', 'testing.count': 9, 'tracker.mode': 'none' }))
  assert.ok(range.errors.some(e => e.key === 'testing.count' && e.code === 'config.range'))
  const en = validateConfig(cfg({ 'commands.bootstrap': 'npm ci', 'testing.count': 0, 'tracker.mode': 'none', 'capture.mode': 'sometimes' }))
  assert.ok(en.errors.some(e => e.key === 'capture.mode' && e.code === 'config.type'))
})

test('validateConfig: tracker states must be set once a tracker is configured; adapter scope and settings', () => {
  const base = cfg({ 'commands.bootstrap': 'npm ci', 'testing.count': 0, 'tracker.id': 'jira' })
  const noStates = validateConfig(base)
  assert.ok(noStates.errors.some(e => e.key === 'tracker.states.in-progress'))
  const adapter = { id: 'jira', scope: { label: 'project', required: true }, config: [{ key: 'cloudId', required: true }] }
  const { config } = deriveConfig(base, FACTS, { adapter: { ...adapter, states: { 'in-progress': { promptDefault: 'In Progress' }, 'in-review': { promptDefault: 'In Review' }, cancelled: { promptDefault: "Won't Do" } } } })
  const r = validateConfig(config, { adapter })
  assert.ok(r.errors.some(e => e.key === 'tracker.scope'))
  assert.ok(r.errors.some(e => e.key === 'tracker.settings.cloudId'))
  setPath(config, 'tracker.scope', 'PROJ')
  setPath(config, 'tracker.settings', { cloudId: 'abc' })
  assert.deepEqual(validateConfig(config, { adapter }).errors, [])
})

test('validateConfig: artifactsDir inside a worktree is an error; routing emails in a committed file warn', () => {
  const c = cfg({ 'commands.bootstrap': 'npm ci', 'testing.count': 0, 'tracker.mode': 'none', 'paths.artifactsDir': '/w/app-session-1/dev-pages', 'checker.routing': [{ paths: ['apps/**'], assignee: 'ada@example.com' }] })
  const r = validateConfig(c, { facts: FACTS, sources: { 'checker.routing': 'project' } })
  assert.ok(r.errors.some(e => e.code === 'config.artifacts-inside-worktree'))
  assert.ok(r.warnings.some(w => w.code === 'config.routing.email-in-project'))
  const r2 = validateConfig({ ...c, paths: { ...c.paths, artifactsDir: '/state/dev-pages' } }, { facts: FACTS, sources: { 'checker.routing': 'user-repo' } })
  assert.ok(!r2.errors.some(e => e.code === 'config.artifacts-inside-worktree'))
  assert.ok(!r2.warnings.some(w => w.code === 'config.routing.email-in-project'))
})

test('validateConfig folds path case ONLY where the filesystem does', () => {
  // Two copies of insideAny disagreed: `fleet doctor` folded by platform, validateConfig folded
  // always. On Linux `/w/App-session-1` and `/w/app-session-1` are two different directories, so the
  // unconditional fold refused a correct config with `config.artifacts-inside-worktree` — a BLOCKING
  // error (`statusFor` → invalid → `fleet up` exits 1) on a machine that was fine, while doctor's own
  // probe on the same machine passed. One function now, and it takes the platform.
  const c = cfg({ 'commands.bootstrap': 'npm ci', 'testing.count': 0, 'tracker.mode': 'none', 'paths.artifactsDir': '/w/App-session-1/dev-pages' })
  const inside = r => r.errors.some(e => e.code === 'config.artifacts-inside-worktree')

  assert.equal(inside(validateConfig(c, { facts: FACTS })), false, 'case-only difference is a different directory on a case-sensitive filesystem')
  assert.equal(inside(validateConfig(c, { facts: { ...FACTS, machine: { ...FACTS.machine, platform: 'win32' } } })), true, 'on Windows it is the same directory, and teardown would remove it')

  // The real containment still fails on both, so the fix did not simply switch the check off.
  const real = { ...c, paths: { ...c.paths, artifactsDir: '/w/app-session-1/dev-pages' } }
  assert.equal(inside(validateConfig(real, { facts: FACTS })), true)
  assert.equal(inside(validateConfig(real, { facts: { ...FACTS, machine: { ...FACTS.machine, platform: 'win32' } } })), true)
})
