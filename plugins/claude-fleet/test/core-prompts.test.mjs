import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildPrompt, buildDescriptor, playbookPathFor, adapterPathFor, slotNumberFromBranch,
  fileExists, PLAYBOOK_BY_ROLE,
} from '../src/core/prompts.mjs'
import { assertDescriptor, buildChildSpec } from '../src/session/shim.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { buildSlots } from '../src/config/derive.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A resolved+derived config for a posix machine, so every expected path in this file is exact. */
const cfg = (over = {}) => {
  const c = defaultsFor()
  setPath(c, 'repo.name', 'app')
  setPath(c, 'commands.bootstrap', 'npm ci')
  setPath(c, 'commands.devServer', 'npm run dev')
  setPath(c, 'tracker.id', 'example-tracker')
  setPath(c, 'tracker.scope', 'core')
  setPath(c, 'tracker.states.in-progress', 'In Progress')
  setPath(c, 'tracker.states.in-review', 'In Review')
  setPath(c, 'tracker.states.cancelled', 'Cancelled')
  setPath(c, 'paths.stateDir', '/state/app')
  setPath(c, 'paths.artifactsDir', '/state/app/dev-pages')
  setPath(c, 'paths.transcriptsDir', '/home/ada/.claude/projects')
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

/** The launch-time bundle. `exists: () => false` = no project overlay unless a test writes one. */
const resolvedFor = (c, over = {}) => ({
  platform: 'linux',
  pluginRoot: '/plugin',
  repoRoot: '/w/app',
  exists: () => false,
  now: Date.parse('2026-03-14T00:00:00Z'),
  slots: buildSlots(c),
  ...over,
})

/** The same fixture on a Windows machine. Nothing here reads process.*, so both are exact on both. */
const winCfg = (over = {}) => cfg({
  'paths.stateDir': 'C:\\state\\app',
  'paths.artifactsDir': 'C:\\state\\app\\dev-pages',
  'paths.transcriptsDir': 'C:\\Users\\ada\\.claude\\projects',
  ...over,
})
const winResolvedFor = (c, over = {}) =>
  resolvedFor(c, { platform: 'win32', pluginRoot: 'C:\\plugin', repoRoot: 'C:\\w\\app', ...over })

const working = (over = {}) => ({ label: '3', role: 'working', worktree: '/w/app-session-3', ...over })
const SESSION_FILE = '/state/app/sessions/3.json'

// ---- the descriptor ----------------------------------------------------------------------------

// A session may only learn a path from this file. Each missing field is one literal a session would
// have to guess at — and a guessed state dir is how two repos end up sharing one flag file.
//
// Spelled out for BOTH platforms: every path here is built by the injected `platform`, so a win32
// join that lost a drive letter or a slug that differs per OS shows up as a diff instead of passing
// on whichever machine happens to run CI.
const DESCRIPTOR_CASES = [
  {
    platform: 'linux',
    build: () => {
      const c = cfg()
      return buildDescriptor(c, working({ issue: 'ABC-1234', ticketFile: '/state/app/tickets/ABC-1234.md' }), resolvedFor(c))
    },
    expect: {
      id: '3',
      label: '3',
      role: 'working',
      worktree: '/w/app-session-3',
      stateFile: '/state/app/sessions/3.state',
      branch: '',
      issue: 'ABC-1234',
      ticketFile: '/state/app/tickets/ABC-1234.md',
      backendRef: null,
      shimPid: null,
      agentPid: null,
      pgid: null,
      createdAt: '2026-03-14T00:00:00.000Z',
      transcriptDir: '/home/ada/.claude/projects/-w-app-session-3',
      tracker: {
        id: 'example-tracker',
        mode: 'mcp',
        adapterPath: '/plugin/trackers/example-tracker.md',
        scope: 'core',
        states: { 'in-progress': 'In Progress', 'in-review': 'In Review', cancelled: 'Cancelled' },
        assignee: 'me',
      },
      playbook: '/plugin/playbooks/session.md',
      testingUrl: 'http://localhost:3000',
      testingUrls: ['http://localhost:3000'],
      paths: {
        stateDir: '/state/app',
        flagsDir: '/state/app/flags',
        outboxDir: '/state/app/tracker-outbox',
        artifactsDir: '/state/app/dev-pages',
      },
      readyFlag: '/w/app-session-3/.fleet-ready',
      agent: 'claude',
      model: 'opus',
    },
  },
  {
    platform: 'win32',
    build: () => {
      const c = winCfg()
      const s = { label: '3', role: 'working', worktree: 'C:\\w\\app-session-3', issue: 'ABC-1234', ticketFile: 'C:\\state\\app\\tickets\\ABC-1234.md' }
      return buildDescriptor(c, s, winResolvedFor(c))
    },
    expect: {
      id: '3',
      label: '3',
      role: 'working',
      worktree: 'C:\\w\\app-session-3',
      stateFile: 'C:\\state\\app\\sessions\\3.state',
      branch: '',
      issue: 'ABC-1234',
      ticketFile: 'C:\\state\\app\\tickets\\ABC-1234.md',
      backendRef: null,
      shimPid: null,
      agentPid: null,
      pgid: null,
      createdAt: '2026-03-14T00:00:00.000Z',
      transcriptDir: 'C:\\Users\\ada\\.claude\\projects\\C--w-app-session-3',
      tracker: {
        id: 'example-tracker',
        mode: 'mcp',
        adapterPath: 'C:\\plugin\\trackers\\example-tracker.md',
        scope: 'core',
        states: { 'in-progress': 'In Progress', 'in-review': 'In Review', cancelled: 'Cancelled' },
        assignee: 'me',
      },
      playbook: 'C:\\plugin\\playbooks\\session.md',
      testingUrl: 'http://localhost:3000',
      testingUrls: ['http://localhost:3000'],
      paths: {
        stateDir: 'C:\\state\\app',
        flagsDir: 'C:\\state\\app\\flags',
        outboxDir: 'C:\\state\\app\\tracker-outbox',
        artifactsDir: 'C:\\state\\app\\dev-pages',
      },
      readyFlag: 'C:\\w\\app-session-3\\.fleet-ready',
      agent: 'claude',
      model: 'opus',
    },
  },
]

for (const kase of DESCRIPTOR_CASES) {
  test(`the descriptor carries every field the contract names on ${kase.platform}, so a session never invents a path`, () => {
    assert.deepEqual(kase.build(), kase.expect)
  })
}

test('every descriptor this module builds is one the shim accepts and can start an agent from', () => {
  // The only factory in the repo, checked against its real consumers instead of against a literal
  // transcribed from itself: a field list can be exact and still be missing the one field
  // `assertDescriptor` demands, and a session that fails there never starts at all.
  const c = cfg({ 'testing.count': 2 })
  const r = resolvedFor(c)
  const sessions = [
    working(),
    { label: 't2', role: 'testing', worktree: '/w/app-testing-2', slot: 2 },
    { label: 'c1', role: 'checker', worktree: '/w/app-check-a', slice: 'a', sweepDir: '/state/app/sweeps/s1' },
  ]
  for (const s of sessions) {
    const d = buildDescriptor(c, s, r)
    // `file` is the descriptor's own path: the launcher does not write it inside the file, the shim
    // knows it from argv. Every other mandatory field must come from the factory.
    assertDescriptor({ ...d, file: `/state/app/sessions/${d.label}.json` })
    assert.equal(d.stateFile, `/state/app/sessions/${d.label}.state`)
  }
  // A slot's dev-server command needs its own port: {port} is otherwise only a URL placeholder, so
  // an empty FLEET_PORT is a fixed-port project that cannot start a second slot at all.
  const t = buildDescriptor(c, sessions[1], r)
  const spec = buildChildSpec({ ...t, file: '/state/app/sessions/t2.json' }, c, { platform: 'linux' })
  assert.equal(spec.env.FLEET_SLOT, '2')
  assert.equal(spec.env.FLEET_PORT, '3001')
  assert.equal(spec.env.FLEET_SLOT_BRANCH, 'testing-2')
  assert.equal(spec.env.FLEET_STATE_FILE, '/state/app/sessions/t2.state')
  assert.equal(spec.env.FLEET_SESSION_FILE, '/state/app/sessions/t2.json')
})

test('the ready flag is a path inside the WORKTREE, never inside the state dir', () => {
  // It answers "is THIS checkout usable", so a worktree deleted by hand must take its own sentinel
  // with it; a state-dir sentinel outlives the checkout and claims an install that is gone.
  const c = cfg()
  const d = buildDescriptor(c, working(), resolvedFor(c))
  assert.ok(d.readyFlag.startsWith('/w/app-session-3/'))
  assert.ok(!d.readyFlag.startsWith(d.paths.stateDir))
  assert.equal(path.posix.basename(d.readyFlag), '.fleet-ready')
  // and it is the configured name, not the default spelled twice
  const c2 = cfg({ 'install.readyFlag': '.installed' })
  assert.equal(buildDescriptor(c2, working(), resolvedFor(c2)).readyFlag, '/w/app-session-3/.installed')
})

test('a testing slot is addressed by its 1-based slot NUMBER, not by array position', () => {
  // Reading slots[slot] hands slot 1 the URL of slot 2, and a session that serves one branch while
  // reporting another URL stays invisible until every capture taken against it is of the wrong code.
  const c = cfg({ 'testing.count': 2 })
  const d = buildDescriptor(c, { label: 't2', role: 'testing', worktree: '/w/app-testing-2', slot: 2 }, resolvedFor(c))
  assert.equal(d.branch, 'testing-2')
  assert.equal(d.slot, 2)
  assert.equal(d.port, 3001)
  assert.equal(d.testingUrl, 'http://localhost:3001')
  assert.deepEqual(d.testingUrls, ['http://localhost:3000', 'http://localhost:3001'])
  // the slot table wins over anything the caller passes: one slot's branch against another slot's
  // URL is exactly the invisible failure this addressing rule exists to prevent
  const mismatched = buildDescriptor(c, { label: 't2', role: 'testing', worktree: '/w/app-testing-2', slot: 2, branch: 'testing' }, resolvedFor(c))
  assert.equal(mismatched.branch, 'testing-2')
  // the other roles keep the branch they were launched on, and an empty one stays empty
  assert.equal(buildDescriptor(c, working({ branch: 'ada/abc-1234-thing' }), resolvedFor(c)).branch, 'ada/abc-1234-thing')
  assert.equal(buildDescriptor(c, working({ branch: '' }), resolvedFor(c)).branch, '')
})

test('only the slots that are actually running are listed — empty means there is no local pool', () => {
  const c = cfg({ 'testing.count': 0 })
  const r = resolvedFor(c)
  // the table itself is always testing.maxSlots long; listing all of it would send this session to
  // capture against a slot nobody ever started
  assert.equal(r.slots.length, 4)
  const d = buildDescriptor(c, working(), r)
  assert.deepEqual(d.testingUrls, [])
  assert.equal(d.testingUrl, '')
})

test('a checker session carries its sweep and slice; the other roles carry neither key at all', () => {
  const c = cfg()
  const k = buildDescriptor(c, { label: 'c1', role: 'checker', worktree: '/w/app-check-a', slice: 'a', sweepDir: '/state/app/sweeps/s1' }, resolvedFor(c))
  assert.equal(k.sweepDir, '/state/app/sweeps/s1')
  assert.equal(k.slice, 'a')
  assert.equal(k.playbook, '/plugin/playbooks/check.md')
  const w = buildDescriptor(c, working(), resolvedFor(c))
  assert.ok(!('sweepDir' in w) && !('slice' in w))
  assert.ok(!('slot' in w) && !('port' in w))
})

test('a descriptor that would strand the session is refused rather than built', () => {
  // Every one of these reaches the session as a working-looking file with one unusable value in it,
  // hours after the launch that produced it.
  const c = cfg({ 'testing.count': 2 })
  const r = resolvedFor(c)
  assert.throws(() => buildDescriptor(c, working({ role: 'launcher' }), r), /unknown role/)
  assert.throws(() => buildDescriptor(c, working({ label: '' }), r), /label is required/)
  assert.throws(() => buildDescriptor(c, working({ worktree: '' }), r), /worktree is required/)
  // nowhere to flag: the launcher reads flags and nothing else, so a session that cannot write one
  // is a session nobody can see finish
  const noState = cfg({ 'paths.stateDir': '' })
  assert.throws(() => buildDescriptor(noState, working(), resolvedFor(noState)), /paths\.stateDir is not resolved/)
  // a slot number nobody started: the table is maxSlots long and 9 is not in it
  assert.throws(
    () => buildDescriptor(c, { label: 't9', role: 'testing', worktree: '/w/app-testing-9', slot: 9 }, r),
    /slot 9 is not in the slot table/,
  )
  assert.throws(
    () => buildDescriptor(c, { label: 't1', role: 'testing', worktree: '/w/app-testing' }, r),
    /needs its slot number/,
  )
  // a checker with no slice has nothing to work and nowhere to write
  assert.throws(
    () => buildDescriptor(c, { label: 'c1', role: 'checker', worktree: '/w/app-check-a', sweepDir: '/state/app/sweeps/s1' }, r),
    /needs its slice/,
  )
  assert.throws(
    () => buildDescriptor(c, { label: 'c1', role: 'checker', worktree: '/w/app-check-a', slice: 'a' }, r),
    /needs its sweep directory/,
  )
})

// ---- locating the documents --------------------------------------------------------------------

test('each role gets its own playbook, and the bundled file that name points at really exists', () => {
  // The file names are NOT the role names (`working` reads session.md). Deriving one from the other
  // would resolve to playbooks/working.md — a path to nothing, handed to a session as its whole brief.
  const c = cfg()
  const opts = { pluginRoot: PLUGIN_ROOT, repoRoot: null, platform: process.platform }
  assert.equal(path.basename(playbookPathFor(c, 'working', opts)), 'session.md')
  for (const [role, entry] of Object.entries(PLAYBOOK_BY_ROLE)) {
    const p = playbookPathFor(c, role, opts)
    assert.equal(path.basename(p), entry.file)
    assert.ok(fileExists(p), `${role} → ${p} does not exist`)
  }
  assert.throws(() => playbookPathFor(c, 'launcher', opts), /unknown role/)
})

test('a project overlay wins over the bundled copy, and an explicit override wins over both', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-prompts-'))
  try {
    fs.mkdirSync(path.join(repo, '.fleet', 'playbooks'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.fleet', 'trackers'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.fleet', 'playbooks', 'session.md'), '# an overlay\n')
    fs.writeFileSync(path.join(repo, '.fleet', 'trackers', 'example-tracker.md'), '# an overlay\n')
    const opts = { pluginRoot: PLUGIN_ROOT, repoRoot: repo, platform: process.platform }
    assert.equal(playbookPathFor(cfg(), 'working', opts), path.join(repo, '.fleet', 'playbooks', 'session.md'))
    assert.equal(adapterPathFor(cfg(), opts), path.join(repo, '.fleet', 'trackers', 'example-tracker.md'))
    // no overlay for this one → the bundled copy, not a path that does not exist
    assert.equal(playbookPathFor(cfg(), 'testing', opts), path.join(PLUGIN_ROOT, 'playbooks', 'testing.md'))
    // a relative override is resolved against the repo, never against the plugin
    assert.equal(playbookPathFor(cfg({ 'playbooks.session': 'docs/house-rules.md' }), 'working', opts), path.join(repo, 'docs', 'house-rules.md'))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('a tracker id is a filename, so an adapter path can never leave the trackers directory', () => {
  // The adapter is a session's whole mapping from op numbers to real tool calls, and `tracker.id` is
  // free-form project-scope config: an id carrying a separator points that mapping anywhere.
  const opts = { pluginRoot: '/plugin', repoRoot: '/w/app', platform: 'linux', exists: () => false }
  for (const id of ['../../etc/adapter', 'a/b', 'a\\b', '.hidden', 'C:\\adapter']) {
    assert.throws(() => adapterPathFor(cfg({ 'tracker.id': id }), opts), /is not a filename/, `${JSON.stringify(id)} was accepted as a tracker id`)
  }
  assert.equal(adapterPathFor(cfg({ 'tracker.id': '' }), opts), null, 'no id at all is tracker-less, not an error')
  assert.equal(adapterPathFor(cfg(), opts), '/plugin/trackers/example-tracker.md')
})

test('the overlay probe answers absence only — any other failure is raised, never swallowed', () => {
  // A probe that answers "no" to a permission or symlink error launches the whole fleet against the
  // bundled document while the operator's overlay sits right there, and nothing downstream re-checks.
  assert.equal(fileExists(path.join(PLUGIN_ROOT, 'playbooks', 'no-such-playbook.md')), false)
  assert.equal(fileExists(path.join(PLUGIN_ROOT, 'playbooks', 'session.md', 'child.md')), false)
  assert.equal(fileExists(path.join(PLUGIN_ROOT, 'playbooks')), false, 'a directory is not a file')
  assert.throws(() => fileExists('\0'), /must be a string/)
})

// ---- the prompt --------------------------------------------------------------------------------

/**
 * No seed prompt may show a placeholder where an artefact belongs. A session reads this text as its
 * whole brief and has nobody to ask: "slice null of the sweep at null" is a session that works
 * nothing, and there is no window anyone is watching for it to say so in.
 */
const assertNoPlaceholders = (prompt, what) => {
  for (const artefact of ['null', 'undefined', '""', "''", '<none>']) {
    assert.ok(!prompt.includes(artefact), `${what}: the prompt shows the placeholder ${artefact}`)
  }
  assert.ok(!/\{[a-zA-Z]/.test(prompt), `${what}: an unrendered {placeholder} survived into the prompt`)
}

test('no role gets a placeholder where an artefact belongs', () => {
  const c = cfg({ 'testing.count': 2 })
  const r = resolvedFor(c)
  const cases = [
    ['a working session with an assignment', working({ issue: 'ABC-1234', ticketFile: '/state/app/tickets/ABC-1234.md' })],
    ['a working session with none', working({ issue: '' })],
    ['a testing session', { label: 't2', role: 'testing', worktree: '/w/app-testing-2', slot: 2 }],
    ['a checker session', { label: 'c1', role: 'checker', worktree: '/w/app-check-a', slice: 'a', sweepDir: '/state/app/sweeps/s1' }],
  ]
  for (const [what, session] of cases) {
    const d = buildDescriptor(c, session, r)
    assertNoPlaceholders(buildPrompt(c, d, { sessionFile: `/state/app/sessions/${d.label}.json` }), what)
  }
  // The empty cases never get this far: a checker with no slice and a testing session with no slot
  // are refused at build time ("a descriptor that would strand the session is refused rather than
  // built"), which is why no prompt can be built that has a hole in it.
})

test('the prompt POINTS at the playbook and never carries it', () => {
  // A pasted playbook is a copy frozen at launch: `fleet relaunch` spawns a fresh agent into the same
  // worktree hours later, and it would follow the document as it stood when the fleet started.
  const c = cfg()
  const d = buildDescriptor(c, working({ issue: 'ABC-1234' }), resolvedFor(c, { pluginRoot: PLUGIN_ROOT, platform: process.platform }))
  const prompt = buildPrompt(c, d, { sessionFile: SESSION_FILE })
  assert.ok(prompt.includes(d.playbook), 'the playbook path must appear in full')
  assert.ok(prompt.includes(SESSION_FILE), 'the descriptor path must appear in full')
  // sampled from the head AND the middle of the document: a partial paste of the body carries no
  // title line, so a canary that only knows the first line reads it as clean
  const lines = fs.readFileSync(d.playbook, 'utf8').split('\n')
  const body = lines.filter(l => l.trim().length > 40)
  for (const line of [lines[0], body[Math.floor(body.length / 2)]]) {
    assert.ok(!prompt.includes(line), `the playbook body leaked into the prompt: ${JSON.stringify(line)}`)
  }
  assert.ok(prompt.length < 3000, `a seed prompt is a pointer, not a payload (was ${prompt.length} chars)`)
})

test('the assigned key is interpolated everywhere it belongs, ticket cache included', () => {
  const c = cfg()
  const d = buildDescriptor(c, working({ issue: 'ABC-1234', ticketFile: '/state/app/tickets/ABC-1234.md' }), resolvedFor(c))
  const prompt = buildPrompt(c, d, { sessionFile: SESSION_FILE })
  assert.match(prompt, /Your assignment is ABC-1234\./)
  assert.match(prompt, /Do not ask which issue to work on: ABC-1234 is already yours/)
  assert.ok(prompt.includes('/state/app/tickets/ABC-1234.md'))
  assert.ok(prompt.split('ABC-1234').length - 1 >= 3)
  assert.ok(!/\{[a-zA-Z]/.test(prompt), 'an unrendered {placeholder} survived into a session prompt')
})

test('a session with no issue gets the fresh-start instruction, never an empty key', () => {
  // `issue: ""` reads as "ask" — and asking is how a session stops for good, because nobody is
  // reading its window.
  const c = cfg()
  const d = buildDescriptor(c, working({ issue: '' }), resolvedFor(c))
  assert.equal(d.issue, null)
  const prompt = buildPrompt(c, d, { sessionFile: SESSION_FILE })
  assert.match(prompt, /WITHOUT an assignment/)
  assert.match(prompt, /Do not ask what to work on/)
  assert.ok(!/assignment is\s*[.:]/.test(prompt), 'an empty key rendered as a stub assignment line')
  assertNoPlaceholders(prompt, 'a working session with no issue')
})

test('a working-session prompt names the tracker by adapter PATH only — never the product', () => {
  // Naming the tracker teaches the session to reach for tools the adapter never sanctioned, and it
  // is how a tool meant to drive any tracker acquires a favourite.
  const c = cfg()
  const d = buildDescriptor(c, working({ issue: 'ABC-1234' }), resolvedFor(c))
  const prompt = buildPrompt(c, d, { sessionFile: SESSION_FILE })
  assert.ok(prompt.includes('/plugin/trackers/example-tracker.md'))
  const withoutPath = prompt.split(d.tracker.adapterPath).join('<the adapter path>')
  assert.ok(!withoutPath.includes(c.tracker.id), 'the tracker id appears outside the adapter path')
  assert.ok(!/example[ _]tracker/i.test(withoutPath), 'a tracker brand name appears in the prompt')
  assert.ok(!prompt.includes('mcp__'), 'the prompt names a concrete tracker tool')
  assert.match(prompt, /op-2/, 'tracker work is named by op number')
})

test('a tracker-less session gets no adapter path and is told its task comes from the descriptor', () => {
  const c = cfg({ 'tracker.mode': 'none' })
  const d = buildDescriptor(c, working({ issue: 'ABC-1234' }), resolvedFor(c))
  assert.equal(d.tracker.adapterPath, null)
  assert.equal(d.tracker.id, null)
  const prompt = buildPrompt(c, d, { sessionFile: SESSION_FILE })
  assert.match(prompt, /no tracker configured/i)
  assert.match(prompt, /comes from your descriptor/)
  assert.ok(!prompt.includes('/trackers/'), 'a tracker-less prompt points at an adapter file')
  assert.ok(!/op-\d/.test(prompt), 'a tracker-less prompt talks in tracker ops')
})

test('a testing session is told its slot, and is handed no tracker at all', () => {
  // Slot 1 is the base branch, not "<base>-1" — reading the number off the branch is what the
  // testing playbook tells the session to do, so both derivations must agree.
  assert.equal(slotNumberFromBranch('testing', 'testing'), 1)
  assert.equal(slotNumberFromBranch('testing-2', 'testing'), 2)
  assert.equal(slotNumberFromBranch('release-2', 'testing'), null)

  const c = cfg({ 'testing.count': 2 })
  const d = buildDescriptor(c, { label: 't2', role: 'testing', worktree: '/w/app-testing-2', slot: 2 }, resolvedFor(c))
  const prompt = buildPrompt(c, d, { sessionFile: '/state/app/sessions/t2.json' })
  assert.match(prompt, /testing slot 2 \(branch testing-2\), serving http:\/\/localhost:3001/)
  assert.ok(prompt.includes('/plugin/playbooks/testing.md'))
  // the working session owns its ticket; a second writer produces history nobody can read back
  assert.ok(!prompt.includes('/trackers/'))
  assert.ok(!/op-\d/.test(prompt))
  // and it never gets the working session's fresh-start line: its branch is a mashup of everyone
  // else's work, so "that branch names the issue you were working" points it at a ticket that
  // belongs to somebody else
  assert.ok(!/what to work on/.test(prompt))
})

test('a checker session is told which slice of which sweep is its own', () => {
  const c = cfg()
  const d = buildDescriptor(c, { label: 'c1', role: 'checker', worktree: '/w/app-check-a', slice: 'a', sweepDir: '/state/app/sweeps/s1' }, resolvedFor(c))
  const prompt = buildPrompt(c, d, { sessionFile: '/state/app/sessions/c1.json' })
  assert.match(prompt, /slice a of the sweep at \/state\/app\/sweeps\/s1/)
  assert.ok(prompt.includes('/plugin/playbooks/check.md'))
  assert.ok(!/what to work on/.test(prompt), 'a checker works its slice, not an issue its branch names')
})

test('a prompt that would strand the session is refused rather than built', () => {
  const c = cfg()
  const d = buildDescriptor(c, working({ issue: 'ABC-1234' }), resolvedFor(c))
  // no descriptor path: the session has no identity, no worktree and nowhere to flag
  assert.throws(() => buildPrompt(c, d, {}), /sessionFile is required/)
  // a tracker configured but no adapter: a session told to speak in op numbers with no mapping file
  // does not stop — it invents tool calls
  const noAdapter = { ...d, tracker: { ...d.tracker, adapterPath: null } }
  assert.throws(() => buildPrompt(c, noAdapter, { sessionFile: SESSION_FILE }), /invents tool calls/)
  assert.throws(() => buildPrompt(c, { ...d, playbook: null }, { sessionFile: SESSION_FILE }), /no playbook path/)
})
