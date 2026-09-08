import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SCHEMA, SCHEMA_BY_KEY, envNameFor, ENV_TO_KEY } from '../src/config/schema.mjs'
import { defaultsFor, getPath, setPath } from '../src/config/defaults.mjs'
import { resolveConfig, leafPaths, classifyPath, LAYER_ORDER } from '../src/config/resolve.mjs'

test('schema keys are unique, dotted, and every entry has a scope and a describe', () => {
  const seen = new Set()
  for (const e of SCHEMA) {
    assert.ok(!seen.has(e.key), `duplicate key ${e.key}`)
    seen.add(e.key)
    assert.ok(['project', 'user', 'either'].includes(e.scope), `${e.key} scope`)
    assert.ok(typeof e.describe === 'string' && e.describe.length > 0, `${e.key} describe`)
    if (e.type === 'enum') assert.ok(Array.isArray(e.enum) && e.enum.length > 0, `${e.key} enum`)
    if (e.type === 'array') assert.ok(e.items, `${e.key} items`)
  }
})

test('no schema key is a prefix of another leaf key (would make a path both leaf and container)', () => {
  for (const e of SCHEMA) {
    if (e.type === 'object' || e.type === 'array') continue
    for (const f of SCHEMA) {
      assert.ok(!f.key.startsWith(e.key + '.'), `${e.key} is a leaf but ${f.key} nests under it`)
    }
  }
})

test('the keys named by the contract exist with the contract defaults', () => {
  const d = defaultsFor()
  assert.equal(getPath(d, 'repo.baseBranch'), 'main')
  assert.equal(getPath(d, 'commands.bootstrap'), null)
  assert.equal(getPath(d, 'devServer.urlTemplate'), 'http://localhost:{port}')
  assert.equal(getPath(d, 'devServer.softFaultStrikes'), 4)
  assert.equal(getPath(d, 'testing.count'), 1)
  assert.equal(getPath(d, 'testing.maxSlots'), 4)
  assert.equal(getPath(d, 'install.proof.mode'), 'compare-primary')
  assert.equal(getPath(d, 'tracker.mode'), 'mcp')
  assert.equal(getPath(d, 'tracker.defaultAssignee'), 'me')
  assert.equal(getPath(d, 'vcs.branchTemplate'), '{prefix}/{key-lower}-{slug}')
  assert.equal(getPath(d, 'fleet.model'), 'opus')
  assert.equal(getPath(d, 'fleet.queue.requireGate'), true)
  assert.equal(getPath(d, 'checker.provenanceLabel'), 'filed-by:fleet-check')
  assert.equal(getPath(d, 'checker.autoPromote'), 'never')
  assert.equal(getPath(d, 'checker.gate.labels.waived'), 'gate:waived')
  assert.equal(getPath(d, 'checker.a11y.forcedPriority'), 4)
  assert.equal(getPath(d, 'terminal.tmux.socket'), 'fleet')
  assert.deepEqual(getPath(d, 'devServer.probes'), [{ path: '/', expectStatus: '2xx,3xx', timeoutSec: 45 }])
})

test('the only secret key is tracker.rest.tokenEnv and it is user-scope', () => {
  const secrets = SCHEMA.filter(e => e.secret)
  assert.deepEqual(secrets.map(e => e.key), ['tracker.rest.tokenEnv'])
  assert.equal(secrets[0].scope, 'user')
})

test('env names derive as FLEET_<UPPER_SNAKE>, containers have none', () => {
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('commands.devServer')), 'FLEET_COMMANDS_DEV_SERVER')
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('devServer.urlTemplate')), 'FLEET_DEV_SERVER_URL_TEMPLATE')
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('tracker.states.in-progress')), 'FLEET_TRACKER_STATES_IN_PROGRESS')
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('checker.a11y.labels.screenReader')), 'FLEET_CHECKER_A11Y_LABELS_SCREEN_READER')
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('devServer.probes')), null)
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('tracker.settings')), null)
  assert.equal(envNameFor(SCHEMA_BY_KEY.get('$pinned')), null)
  assert.equal(ENV_TO_KEY.get('FLEET_TESTING_COUNT'), 'testing.count')
  // no two keys collide on an env name
  const names = SCHEMA.map(envNameFor).filter(Boolean)
  assert.equal(new Set(names).size, names.length)
})

test('defaults: every key present, derived ones as null; setPath/getPath round-trip', () => {
  const d = defaultsFor()
  for (const e of SCHEMA) assert.notEqual(getPath(d, e.key), undefined, e.key)
  assert.equal(getPath(d, 'fleet.size'), null)
  const o = setPath({}, 'a.b.c', 1)
  assert.deepEqual(o, { a: { b: { c: 1 } } })
  assert.equal(getPath(o, 'a.b.c'), 1)
  assert.equal(getPath(o, 'a.x.c'), undefined)
})

test('leafPaths / classifyPath treat arrays as leaves and nest under containers', () => {
  assert.deepEqual(leafPaths({ a: { b: 1, c: [1, 2] }, d: null }).sort(), ['a.b', 'a.c', 'd'])
  assert.deepEqual(classifyPath('tracker.settings.cloudId'), { known: true, key: 'tracker.settings' })
  assert.deepEqual(classifyPath('devServer.probes'), { known: true, key: 'devServer.probes' })
  assert.deepEqual(classifyPath('devServer.nope'), { known: false, key: null })
})

test('precedence: later layers win, sources record the winner', () => {
  const { config, sources, warnings, errors } = resolveConfig({
    layers: [
      { name: 'project', data: { repo: { baseBranch: 'develop' }, testing: { count: 2 } } },
      { name: 'user-repo', data: { testing: { count: 3 } } },
      { name: 'env', data: { testing: { count: 0 } } },
    ],
  })
  assert.equal(config.repo.baseBranch, 'develop')
  assert.equal(config.testing.count, 0)
  assert.equal(sources['repo.baseBranch'], 'project')
  assert.equal(sources['testing.count'], 'env')
  assert.equal(sources['repo.remote'], 'defaults')
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('layers may arrive in any order and are still applied in LAYER_ORDER', () => {
  const { config } = resolveConfig({
    layers: [
      { name: 'cli', data: { fleet: { model: 'from-cli' } } },
      { name: 'project', data: { fleet: { model: 'from-project' } } },
    ],
  })
  assert.equal(config.fleet.model, 'from-cli')
  assert.deepEqual(LAYER_ORDER.slice(0, 2), ['defaults', 'project'])
})

test('a user-scope key in a committed file is ignored with config.scope.leak', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { paths: { stateDir: 'D:\\somewhere' }, fleet: { size: 40 } } }],
  })
  assert.equal(config.paths.stateDir, null)
  assert.equal(config.fleet.size, null)
  const leaks = warnings.filter(w => w.code === 'config.scope.leak').map(w => w.key).sort()
  assert.deepEqual(leaks, ['fleet.size', 'paths.stateDir'])
})

test('a secret key in a committed file is an ERROR and is not applied', () => {
  const { config, errors } = resolveConfig({
    layers: [{ name: 'project-local', data: { tracker: { rest: { tokenEnv: 'JIRA_TOKEN' } } } }],
  })
  assert.equal(config.tracker.rest.tokenEnv, null)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'config.secret.committed')
  assert.equal(errors[0].key, 'tracker.rest.tokenEnv')
})

test('the same secret key in the user layer is fine', () => {
  const { config, errors } = resolveConfig({
    layers: [{ name: 'user-repo', data: { tracker: { rest: { tokenEnv: 'JIRA_TOKEN' } } } }],
  })
  assert.equal(config.tracker.rest.tokenEnv, 'JIRA_TOKEN')
  assert.deepEqual(errors, [])
})

test('$pinned blocks the user layers, env still wins with a warning', () => {
  const { config, warnings, pinned } = resolveConfig({
    layers: [
      { name: 'project', data: { $pinned: ['testing.base', 'devServer.urlTemplate'], testing: { base: 'shared' } } },
      { name: 'user-repo', data: { testing: { base: 'mine' } } },
      { name: 'env', data: { testing: { base: 'from-env' } } },
    ],
  })
  assert.deepEqual(pinned, ['testing.base', 'devServer.urlTemplate'])
  assert.equal(config.testing.base, 'from-env')
  assert.ok(warnings.some(w => w.code === 'config.pinned.ignored' && w.key === 'testing.base' && w.layer === 'user-repo'))
  assert.ok(warnings.some(w => w.code === 'config.pinned.overridden' && w.key === 'testing.base' && w.layer === 'env'))
})

test('without env, a pinned project value beats the user layer', () => {
  const { config } = resolveConfig({
    layers: [
      { name: 'project', data: { $pinned: ['testing.base'], testing: { base: 'shared' } } },
      { name: 'user-checkout', data: { testing: { base: 'mine' } } },
    ],
  })
  assert.equal(config.testing.base, 'shared')
})

test('$pinned naming an unknown or user-scope key warns instead of throwing', () => {
  const { warnings } = resolveConfig({
    layers: [{ name: 'project', data: { $pinned: ['nope.key', 'fleet.size'] } }],
  })
  assert.ok(warnings.some(w => w.code === 'config.pinned.unknown' && w.key === 'nope.key'))
  assert.ok(warnings.some(w => w.code === 'config.pinned.user-scope' && w.key === 'fleet.size'))
})

test('unknown keys warn; keys nested under a container are accepted whole', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { tracker: { settings: { cloudId: 'abc', other: 1 }, bogus: true }, nope: 1 } }],
  })
  assert.deepEqual(config.tracker.settings, { cloudId: 'abc', other: 1 })
  const unknown = warnings.filter(w => w.code === 'config.unknown-key').map(w => w.key).sort()
  assert.deepEqual(unknown, ['nope', 'tracker.bogus'])
})

test('arrays are replaced by a later layer, never merged element-wise', () => {
  const { config } = resolveConfig({
    layers: [
      { name: 'project', data: { devServer: { probes: [{ path: '/a' }, { path: '/b' }] } } },
      { name: 'user-repo', data: { devServer: { probes: [{ path: '/only' }] } } },
    ],
  })
  assert.deepEqual(config.devServer.probes, [{ path: '/only' }])
})

test('a project-scope key set in a user layer is applied but flagged as local divergence', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'user-repo', data: { commands: { devServer: 'npm run dev' } } }],
  })
  assert.equal(config.commands.devServer, 'npm run dev')
  assert.ok(warnings.some(w => w.code === 'config.local-divergence' && w.key === 'commands.devServer'))
})

test('resolved values are copies — mutating the result does not touch the layer data', () => {
  const data = { devServer: { probes: [{ path: '/x' }] } }
  const { config } = resolveConfig({ layers: [{ name: 'project', data }] })
  config.devServer.probes[0].path = '/mutated'
  assert.equal(data.devServer.probes[0].path, '/x')
})

test('an unknown layer name throws', () => {
  assert.throws(() => resolveConfig({ layers: [{ name: 'global', data: {} }] }), /unknown config layer/)
})
