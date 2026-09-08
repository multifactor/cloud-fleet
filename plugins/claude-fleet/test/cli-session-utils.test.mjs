// The commands a SESSION runs: pool, flag, outbox, ticket, session env, slots, intake, send, kill,
// assets. Every case below is a behaviour a session or the launcher depends on, or a trap one of
// them fell into — named in the comment above it.
//
// Real repositories in a temp dir, the FAKE terminal backend, an isolated state dir and config home.
// Nothing here touches the network, the machine's own config, or a real fleet.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run } from '../src/sys/exec.mjs'
import { main } from '../src/cli.mjs'
import { MODULE_FILES } from '../src/cli/registry.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { writeSession } from '../src/core/fleet.mjs'
import { poolDirName, poolNameFromDir, testingSlotCount, resolveSlot } from '../src/cli/commands/pool.mjs'
import { twinLine, CATEGORIES } from '../src/cli/commands/flag.mjs'
import { splitTargets } from '../src/cli/commands/send.mjs'
import { webBaseFor, rawUrlFor } from '../src/cli/commands/assets.mjs'

// Every command this file drives must be IN the table `src/cli.mjs` dispatches against: a module
// that exists but is unlisted is a command the CLI answers `unknown command` for, and no test that
// injected it by hand would ever notice.
const MINE = [
  './commands/pool.mjs', './commands/flag.mjs', './commands/outbox.mjs', './commands/ticket.mjs',
  './commands/session.mjs', './commands/slots.mjs', './commands/intake.mjs', './commands/send.mjs',
  './commands/kill.mjs', './commands/assets.mjs',
]
test('the command table lists every module these tests drive', () => {
  for (const file of MINE) assert.ok(MODULE_FILES.includes(file), `${file} is missing from src/cli/registry.mjs MODULE_FILES`)
})

// ---- harness -------------------------------------------------------------------------------------

// realpath, because on macOS os.tmpdir() is /var/… while git answers /private/var/…, and on a Windows
// runner the temp dir arrives as an 8.3 short name — comparing either directly fails a correct
// implementation for the wrong reason.
function tmpRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sess-')))
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

const CONFIG = Object.freeze({
  version: 1,
  commands: { bootstrap: 'npm run worktree-setup', devServer: 'npm run dev' },
  tracker: { id: 'github', scope: 'acme/app' },
  checker: { ready: { state: 'Todo' } },
  testing: { count: 2 },
})

/**
 * A real repository with one commit and an origin, plus an ISOLATED user-config home and state dir.
 *
 * ⛔ The env is built here rather than inherited: without FLEET_CONFIG_HOME the user layer resolves
 * to the machine's real `claude-fleet/config.json`, so the suite would read the config of whoever is
 * running it and pass or fail differently on every machine.
 */
function makeRepo(t, { config = CONFIG, origin = 'https://github.com/acme/app.git' } = {}) {
  const parent = tmpRoot(t)
  const repo = path.join(parent, 'app')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  if (origin) git(repo, ['remote', 'add', 'origin', origin])
  writeJson(path.join(repo, 'package.json'), { name: 'app', scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' } })
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  if (config) writeJson(path.join(repo, '.fleet', 'config.json'), config)
  const stateRoot = path.join(parent, 'state')
  return {
    parent,
    repo,
    // Both variables, so the same fixture isolates the state dir on Windows and on POSIX.
    env: { FLEET_CONFIG_HOME: path.join(parent, 'user-config'), LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  }
}

/** Drive main() with captured streams. Each write is kept separate so "exactly one object" is checkable. */
async function cli(argv, { repo, cwd = repo, env, label = null, backend = createFakeBackend() } = {}) {
  const outChunks = []
  const errChunks = []
  const code = await main(argv, {
    stdout: s => outChunks.push(s),
    stderr: s => errChunks.push(s),
    cwd,
    env: label === null ? env : { ...env, FLEET_LABEL: String(label) },
    backend,
  })
  const stdout = outChunks.join('')
  return {
    code,
    stdout,
    stderr: errChunks.join(''),
    outChunks,
    payload: argv.includes('--json') && stdout.trim() ? JSON.parse(stdout) : null,
  }
}

/** The state dir the CLI resolved for this fixture — the one the commands really wrote into. */
async function stateDirOf(f) {
  const r = await cli(['config', 'resolve', '--json'], f)
  return r.payload.config.paths.stateDir
}

/** Spawn a session on the fake backend and register its descriptor, exactly as `fleet up` would. */
function register(backend, stateDir, { label, role = 'working', slot = null, issue = null }) {
  const worktree = path.join(path.dirname(stateDir), `app-session-${label}`)
  const session = {
    label: String(label),
    role,
    file: path.join(stateDir, 'sessions', `${label}.json`),
    stateFile: path.join(stateDir, 'sessions', `${label}.state`),
    stateDir,
    testingUrl: '',
    testingUrls: [],
    ...(role === 'testing' ? { slot, branch: slot === 1 ? 'testing' : `testing-${slot}`, port: 3000 + (slot - 1) } : {}),
  }
  const handle = backend.spawn({
    id: String(label),
    role,
    title: `session ${label}`,
    cwd: worktree,
    command: 'node',
    args: ['shim.mjs', `--fleet-session=${label}`],
    env: buildSessionEnv({ tracker: { mode: 'mcp' } }, session),
  })
  const descriptor = {
    ...session,
    id: String(label),
    worktree,
    issue,
    backendRef: handle.backendRef,
    shimPid: handle.shimPid,
    pgid: handle.pgid,
    paths: { stateDir, flagsDir: path.join(stateDir, 'flags'), outboxDir: path.join(stateDir, 'tracker-outbox'), artifactsDir: path.join(stateDir, 'dev-pages') },
  }
  writeSession(descriptor, { stateDir })
  return { handle, descriptor }
}

// ---- pool ----------------------------------------------------------------------------------------

test('two sessions acquire two different testing slots, and a release hands the slot back', async t => {
  // The pool's whole job: a slot is held by ONE session at a time, and the caller must use the slot
  // it was GIVEN — a session that assumed slot 1 would drive another session's dev server.
  const f = makeRepo(t)
  const three = await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '3' })
  assert.equal(three.code, 0)
  assert.equal(three.payload.slot, 'testing')
  assert.equal(three.payload.owner, '3')
  assert.match(three.stderr, /slot=testing/)
  assert.match(three.stderr, /url=http:\/\/localhost:3000/)

  const four = await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '4' })
  assert.equal(four.code, 0)
  assert.equal(four.payload.slot, 'testing-2', 'the second session must not be handed the slot the first holds')
  assert.equal(four.payload.url, 'http://localhost:3001')

  const back = await cli(['pool', 'release', 'testing', 'testing', '--json'], { ...f, label: '3' })
  assert.equal(back.code, 0)
  assert.equal(back.payload.released, true)

  const five = await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '5' })
  assert.equal(five.payload.slot, 'testing', 'a released slot is free again')
})

test('--once exits non-zero the moment every slot is held, instead of queueing', async t => {
  // ⛔ A patient retry loop is a queue, and a queue on three slots is how a fleet stops working while
  // looking busy. The payload names who holds what so the caller can say "busy" rather than "broken".
  const f = makeRepo(t)
  await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '3' })
  await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '4' })

  const started = Date.now()
  const r = await cli(['pool', 'acquire', 'testing', '--once', '--json'], { ...f, label: '5' })
  assert.notEqual(r.code, 0)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.error.code, 'pool.busy')
  assert.deepEqual(r.payload.slots.map(s => s.owner), ['3', '4'])
  assert.ok(Date.now() - started < 5_000, '--once must not wait at all')
})

test('--wait and --once contradict each other, and a negative wait is refused', async t => {
  // Contract §7 writes them as alternatives (`[--wait <s> | --once]`). Honouring one silently would
  // give a caller that asked NOT to queue exactly the queue it refused — and a refused acquire must
  // leave no lock behind, or the pool loses a slot to a command line nobody accepted.
  const f = makeRepo(t)
  const both = await cli(['pool', 'acquire', 'testing', '--wait', '5', '--once', '--json'], { ...f, label: '3' })
  assert.equal(both.code, 2)
  assert.equal(both.payload.error.code, 'pool.wait-and-once')
  assert.equal(fs.existsSync(path.join(await stateDirOf(f), 'locks', 'testing')), false, 'a refused acquire creates no lock')

  const negative = await cli(['pool', 'acquire', 'testing', '--wait', '-1', '--json'], { ...f, label: '3' })
  assert.equal(negative.code, 2)
  assert.equal(negative.payload.error.code, 'pool.bad-wait')
})

test('--slot demands exactly that slot: it is never substituted, and it is never stolen from its holder', async t => {
  // ⛔ A testing session merges into ITS OWN worktree, so being handed whatever is free would merge
  // its branch under another session's slot — and the capture that follows is of the wrong code.
  const f = makeRepo(t)
  const demanded = await cli(['pool', 'acquire', 'testing', '--slot', 'testing-2', '--json'], { ...f, label: '4' })
  assert.equal(demanded.payload.slot, 'testing-2', 'slot 1 was free, but slot 2 was the one demanded')

  const refused = await cli(['pool', 'acquire', 'testing', '--slot', '2', '--once', '--json'], { ...f, label: '5' })
  assert.notEqual(refused.code, 0, 'the free slot 1 must NOT be handed out as a substitute')
  assert.equal(refused.payload.error.code, 'pool.busy')

  // `--slot 2` is the number a testing session reads out of FLEET_SLOT, so it must resolve to the
  // same slot as its branch name does.
  assert.match(refused.payload.error.message, /testing-2/)

  const missing = await cli(['pool', 'acquire', 'testing', '--slot', 'testing-9', '--json'], { ...f, label: '6' })
  assert.equal(missing.code, 2)
  assert.equal(missing.payload.error.code, 'pool.no-such-slot')
})

test('a slot is released only by the session that holds it', async t => {
  // sys/lock never removes another owner's lock, and the CLI must not paper over the refusal: a
  // release that silently did nothing would leave the caller believing the pool has a free slot.
  const f = makeRepo(t)
  await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '3' })
  const r = await cli(['pool', 'release', 'testing', 'testing', '--json'], { ...f, label: '4' })
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'pool.not-yours')
  assert.equal(r.payload.holder, '3')

  // Releasing a slot nobody holds is the state the caller wanted, not a failure: a retry, or a shim
  // giving back a lock its session already released, must not report an error.
  const free = await cli(['pool', 'release', 'testing', 'testing-2', '--json'], { ...f, label: '3' })
  assert.equal(free.code, 0)
  assert.equal(free.payload.ok, true)
  assert.equal(free.payload.alreadyFree, true)
})

test('a release naming a slot the pool does not have is refused, exactly as an acquire is', async t => {
  // ⛔ A slot name that does not resolve used to be probed as a raw lock path: nobody held
  // `<locks>/testing/testng`, so the release answered ok:true alreadyFree:true and exited 0 — while
  // the slot it meant stayed locked for the whole stale window with every other session queueing on
  // it. `acquire` refuses the same typo loudly; the two must not disagree about one argument.
  const f = makeRepo(t)
  await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '3' })

  const typo = await cli(['pool', 'release', 'testing', 'testng', '--json'], { ...f, label: '3' })
  assert.equal(typo.code, 2)
  assert.equal(typo.payload.error.code, 'pool.no-such-slot')

  const status = await cli(['pool', 'status', '--json'], f)
  const testing = status.payload.pools.find(p => p.pool === 'testing')
  assert.equal(testing.slots[0].held, true, 'the real lock is still held: nothing was released')
  assert.equal(testing.slots[0].owner, '3')
})

test('the tracker-worklist pool locks under a filename with no colon in it', async t => {
  // ⛔ `mkdir` refuses a colon on Windows (EINVAL), so `tracker-worklist:ABC-1234` cannot be a
  // directory name. A lock that cannot be created is a lock nobody holds, and two launcher drains
  // then rewrite one issue body over each other.
  const f = makeRepo(t)
  const r = await cli(['pool', 'acquire', 'tracker-worklist:ABC-1234', '--json'], { ...f, label: 'launcher' })
  assert.equal(r.code, 0)
  assert.equal(r.payload.pool, 'tracker-worklist:ABC-1234', 'the payload keeps the contract name')
  assert.equal(r.payload.slot, '1')

  const locks = path.join(await stateDirOf(f), 'locks')
  assert.deepEqual(fs.readdirSync(locks), ['tracker-worklist~ABC-1234'])
  assert.equal(poolNameFromDir(poolDirName('tracker-worklist:ABC-1234')), 'tracker-worklist:ABC-1234')

  const status = await cli(['pool', 'status', '--json'], f)
  const found = status.payload.pools.find(p => p.pool === 'tracker-worklist:ABC-1234')
  assert.equal(found.slots[0].owner, 'launcher', 'a pool created on first use is still reported by status')
})

test('a pool name the contract does not declare is refused rather than created', async t => {
  // A typo'd pool would create its own lock directory and hand every caller a free slot — two
  // sessions each holding "their own" pool looks exactly like a working one.
  const f = makeRepo(t)
  const r = await cli(['pool', 'acquire', 'testng', '--json'], { ...f, label: '3' })
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'pool.unknown')
  assert.equal(fs.existsSync(path.join(await stateDirOf(f), 'locks', 'testng')), false)
})

test('a pool with no slots says so instead of blocking, and never as a testing-slot flag', async t => {
  // "No pool configured" is not a busy pool: it means the resource does not exist here, and a
  // session that read it as contention would retry for fifteen minutes and then flag.
  const f = makeRepo(t, { config: { ...CONFIG, testing: { count: 0 } } })
  const r = await cli(['pool', 'acquire', 'testing', '--json'], { ...f, label: '3' })
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'pool.not-configured')
  assert.match(r.payload.error.hint, /not a blocked flag/)
})

test('the testing pool is never smaller than the slots that are actually running', () => {
  // ⛔ `fleet up --testing 2` carries the count on one command line and nothing persists it, so a
  // later acquire reading testing.count alone would offer ONE slot while two dev servers run — every
  // session queueing on slot 1 while slot 2 sits idle.
  const config = { testing: { enabled: true, count: 1, maxSlots: 4 } }
  assert.equal(testingSlotCount(config, []), 1)
  assert.equal(testingSlotCount(config, [{ role: 'testing', label: 't2', slot: 2 }]), 2)
  assert.equal(testingSlotCount(config, [{ role: 'testing', label: 't2', slot: 2, liveness: 'dead' }]), 1)
  assert.equal(testingSlotCount(config, [{ role: 'testing', slot: 9 }]), 4, 'never past testing.maxSlots: there is no URL for a fifth row')
  assert.equal(testingSlotCount({ testing: { enabled: false, count: 2, maxSlots: 4 } }, []), 0)
})

test('resolveSlot accepts the slot name and the slot number, and nothing else', () => {
  // FLEET_SLOT is an integer and `acquire` prints a branch name; both spellings have to reach the
  // same lock, or a testing session cannot demand its own slot at all.
  const spec = { slots: [{ name: 'testing', n: 1 }, { name: 'testing-2', n: 2 }] }
  assert.equal(resolveSlot(spec, 'testing-2').n, 2)
  assert.equal(resolveSlot(spec, '2').name, 'testing-2')
  assert.equal(resolveSlot(spec, 'testing-3'), null)
})

// ---- flag ----------------------------------------------------------------------------------------

test('a done flag is contract §5, with its one-line twin beside it', async t => {
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3', issue: 'ABC-1234' })

  const r = await cli([
    'flag', 'done', '--outcome', 'pr-pushed', '--pr-url', 'https://github.com/acme/app/pull/7',
    '--evidence', 'src/thing.tsx:42', '--evidence', 'src/thing.test.ts:88',
    '--prescription', 'amended', '--body-patched', '--json',
  ], { ...f, label: '3', backend })
  assert.equal(r.code, 0)

  const flag = JSON.parse(fs.readFileSync(path.join(stateDir, 'flags', 'done-3.json'), 'utf8'))
  assert.deepEqual(Object.keys(flag), ['v', 'session', 'issue', 'outcome', 'prUrl', 'reason', 'evidence', 'prescription', 'bodyPatched', 'at'])
  assert.equal(flag.v, 1)
  assert.equal(flag.session, '3')
  // The issue comes from the session's own descriptor: a flag the launcher cannot tie to a ticket is
  // one it cannot verify with op-2.
  assert.equal(flag.issue, 'ABC-1234')
  assert.deepEqual(flag.evidence, ['src/thing.tsx:42', 'src/thing.test.ts:88'])
  assert.equal(flag.bodyPatched, true)
  assert.ok(Date.parse(flag.at), 'at is an instant')

  const twin = fs.readFileSync(path.join(stateDir, 'flags', 'done-3.txt'), 'utf8')
  assert.equal(twin.split('\n').length, 2, 'the twin is exactly one line, for tailing')
  assert.match(twin, /outcome=pr-pushed/)
})

test('an outcome, a category or a prescription outside the contract enum is refused and nothing is written', async t => {
  // ⛔ The reclaimer refuses a flag whose outcome it does not know — silently, hours later, with the
  // session already gone and its worktree still holding several gigabytes.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)

  const bad = await cli(['flag', 'done', '--outcome', 'shipped', '--json'], { ...f, label: '3' })
  assert.equal(bad.code, 2)
  assert.equal(bad.payload.error.code, 'flag.bad-outcome')
  assert.equal(fs.existsSync(path.join(stateDir, 'flags', 'done-3.json')), false, 'a refused flag must leave no file')

  const badCategory = await cli(['flag', 'blocked', '--category', 'vibes', '--observation', 'x', '--json'], { ...f, label: '3' })
  assert.equal(badCategory.payload.error.code, 'flag.bad-category')

  const badPrescription = await cli(['flag', 'done', '--outcome', 'check-complete', '--prescription', 'ignored', '--json'], { ...f, label: '3' })
  assert.equal(badPrescription.payload.error.code, 'flag.bad-prescription')

  // The three categories §5's shorter list is missing are real values a session may name.
  for (const c of ['capture-spec', 'usage-limit', 'merge']) assert.ok(CATEGORIES.includes(c), `${c} must be an accepted category`)
})

test('pr-pushed needs its PR URL, and a no-code outcome needs its reason', async t => {
  // A finished session may legitimately have NO PR, so the launcher must never fall back to a PR
  // lookup — a PR list filtered on an empty branch name returns every PR there is. And a
  // cancellation rationale is evidence: it is posted verbatim, so a missing one is a mystery.
  const f = makeRepo(t)
  const noUrl = await cli(['flag', 'done', '--outcome', 'pr-pushed', '--json'], { ...f, label: '3' })
  assert.equal(noUrl.payload.error.code, 'flag.pr-url-required')

  const noReason = await cli(['flag', 'done', '--outcome', 'cancelled', '--json'], { ...f, label: '3' })
  assert.equal(noReason.payload.error.code, 'flag.reason-required')

  const ok = await cli(['flag', 'done', '--outcome', 'cancelled', '--reason', 'fixed on base at src/thing.tsx:42', '--evidence', 'src/thing.tsx:42', '--json'], { ...f, label: '3' })
  assert.equal(ok.code, 0)
  assert.equal(ok.payload.flag.reason, 'fixed on base at src/thing.tsx:42')
})

test('a blocked flag is cleared once it is answered — and the done flag beside it is left alone', async t => {
  // Without `clear`, an answered flag reads as an open one forever and the launcher diffuses the same
  // block on every turn. The done flag is the reclaimer's authorisation and is never swept up with it.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)
  const blocked = await cli(['flag', 'blocked', '--category', 'testing-slot', '--observation', 'acquire has been busy for 20 minutes', '--json'], { ...f, label: '3' })
  assert.equal(blocked.code, 0)
  assert.equal(blocked.payload.flag.category, 'testing-slot')
  assert.ok(fs.existsSync(path.join(stateDir, 'flags', 'blocked-3.json')))

  await cli(['flag', 'done', '--outcome', 'check-complete', '--json'], { ...f, label: '3' })
  const cleared = await cli(['flag', 'clear', '--json'], { ...f, label: '3' })
  assert.equal(cleared.code, 0)
  assert.deepEqual(cleared.payload.cleared.map(c => c.label), ['3'])
  assert.equal(fs.existsSync(path.join(stateDir, 'flags', 'blocked-3.json')), false)
  assert.equal(fs.existsSync(path.join(stateDir, 'flags', 'blocked-3.txt')), false)
  assert.equal(fs.existsSync(path.join(stateDir, 'flags', 'done-3.json')), true, 'clear must never take the reclaim authorisation with it')
  assert.deepEqual(cleared.payload.doneFlagsLeft, ['3'])

  // Idempotent: clearing an already-cleared flag reports nothing cleared rather than inventing one.
  const again = await cli(['flag', 'clear', '--label', '3', '--json'], { ...f, label: '3' })
  assert.deepEqual(again.payload.cleared, [])

  // --all is the launcher's sweep after it has replied to everyone; it needs no label of its own,
  // and it still touches only the blocked flags.
  await cli(['flag', 'blocked', '--category', 'services', '--observation', 'the database container is down', '--json'], { ...f, label: '4' })
  await cli(['flag', 'blocked', '--category', 'install', '--observation', 'the bootstrap command exited 1', '--json'], { ...f, label: '5' })
  const all = await cli(['flag', 'clear', '--all', '--json'], { ...f, env: f.env })
  assert.deepEqual(all.payload.cleared.map(c => c.label), ['4', '5'])
  assert.equal(fs.existsSync(path.join(stateDir, 'flags', 'done-3.json')), true)
})

test('the twin line folds newlines instead of cutting the text at an offset', () => {
  // ⛔ Text truncated at a character offset is what this project's rules forbid: the twin is a whole
  // sentence or a misleading one.
  const line = twinLine({ at: '2026-03-14T10:00:00.000Z', session: '3', issue: 'ABC-1234', category: 'dev-server', observation: 'probe returned 500\nafter 45s' })
  assert.equal(line.split('\n').length, 2)
  assert.match(line, /observation=probe returned 500 after 45s/)
})

// ---- outbox --------------------------------------------------------------------------------------

test('an outbox entry survives add → list → ack, and the ack MOVES it to applied/', async t => {
  // Nothing here ever deletes an entry: the applied record is the only evidence that an issue changed
  // state for a reason.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)

  const added = await cli(['outbox', 'add', '--op', 'op-11', '--key', 'ABC-1234', '--args', '{"text":"the fix is on branch ada/abc-1234"}', '--json'], { ...f, label: '3' })
  assert.equal(added.code, 0)
  assert.equal(added.payload.entry.n, 11)
  assert.equal(added.payload.entry.requestedBy, '3')
  // op-11 is verbatim BY DEFINITION — a session that forgot the flag must not have its comment tidied.
  assert.equal(added.payload.entry.verbatim, true)
  const id = added.payload.entry.id

  const listed = await cli(['outbox', 'list', '--json'], f)
  assert.deepEqual(listed.payload.entries.map(e => e.id), [id])
  assert.equal(listed.payload.entries[0].args.text, 'the fix is on branch ada/abc-1234')

  const acked = await cli(['outbox', 'ack', id, '--result', '{"url":"https://github.com/acme/app/issues/7#comment"}', '--json'], f)
  assert.equal(acked.code, 0)
  assert.equal(fs.existsSync(path.join(stateDir, 'tracker-outbox', `${id}.json`)), false, 'the pending file is gone')
  const applied = JSON.parse(fs.readFileSync(path.join(stateDir, 'tracker-outbox', 'applied', `${id}.json`), 'utf8'))
  assert.equal(applied.result.url, 'https://github.com/acme/app/issues/7#comment')
  assert.ok(applied.appliedAt)

  const empty = await cli(['outbox', 'list', '--json'], f)
  assert.deepEqual(empty.payload.entries, [])

  // A second ack would mean the op was applied twice.
  const twice = await cli(['outbox', 'ack', id, '--json'], f)
  assert.equal(twice.code, 1)
  assert.equal(twice.payload.error.code, 'outbox.ack-failed')
})

test('an op or an --args payload the contract does not allow is refused at the door, as a sentence', async t => {
  // A refusal here reaches the session that knows what the op meant; a refusal at drain time reaches
  // nobody, because that session was reclaimed hours ago.
  const f = makeRepo(t)
  const badOp = await cli(['outbox', 'add', '--op', 'op-99', '--key', 'ABC-1234', '--json'], { ...f, label: '3' })
  assert.equal(badOp.code, 1)
  assert.equal(badOp.payload.error.code, 'outbox.rejected')
  assert.match(badOp.payload.error.message, /not a tracker op/)

  const quoted = await cli(['outbox', 'add', '--op', 'op-5', '--key', 'ABC-1234', '--args', '"in-progress"', '--json'], { ...f, label: '3' })
  assert.equal(quoted.payload.error.code, 'outbox.rejected')
  assert.match(quoted.payload.error.message, /must be a JSON object/)

  const notJson = await cli(['outbox', 'add', '--op', 'op-5', '--key', 'ABC-1234', '--args', '{state: in-progress}', '--json'], { ...f, label: '3' })
  assert.equal(notJson.code, 2)
  assert.equal(notJson.payload.error.code, 'outbox.bad-json')

  const noText = await cli(['outbox', 'add', '--op', 'op-11', '--key', 'ABC-1234', '--args', '{}', '--json'], { ...f, label: '3' })
  assert.match(noText.payload.error.message, /carries no text/)
})

// ---- ticket --------------------------------------------------------------------------------------

test('a cached ticket round-trips through cache → show → list, description byte for byte', async t => {
  // A session works from this text as its specification: the cache is written here or nowhere, and a
  // cache that is wrong is worse than none.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)
  const payload = path.join(f.parent, 'issue.json')
  const description = 'Line one.\n\n⛔ Do NOT widen the container.\n\n  indented, trailing spaces   \n'
  writeJson(payload, { key: 'ABC-1234', title: 'The chip row truncates', description, url: 'https://github.com/acme/app/issues/7', status: 'Todo', priority: 2, labels: ['filed-by:fleet-check', 'gate:passed'] })

  const cached = await cli(['ticket', 'cache', '--issue', 'ABC-1234', '--from-json', payload, '--json'], f)
  assert.equal(cached.code, 0)
  assert.equal(cached.payload.ticket.description, description)
  assert.ok(fs.existsSync(path.join(stateDir, 'tickets', 'ABC-1234.md')), 'the readable twin a descriptor points at')

  const shown = await cli(['ticket', 'show', 'ABC-1234', '--json'], f)
  assert.equal(shown.payload.ticket.title, 'The chip row truncates')
  assert.equal(shown.payload.ticket.description, description)
  assert.deepEqual(shown.payload.ticket.labels, ['filed-by:fleet-check', 'gate:passed'])
  assert.match(shown.payload.markdown, /# ABC-1234 — The chip row truncates/)

  const listed = await cli(['ticket', 'list', '--json'], f)
  assert.deepEqual(listed.payload.tickets.map(x => x.key), ['ABC-1234'])

  const missing = await cli(['ticket', 'show', 'ABC-9999', '--json'], f)
  assert.equal(missing.code, 1)
  assert.equal(missing.payload.error.code, 'ticket.not-cached')
})

test('a payload whose key disagrees with --issue is refused, never reconciled', async t => {
  // The file is named after the key, and a cache under the other spelling is a ticket no session ever
  // finds — so the session flags `tracker` over a file the launcher can see on disk.
  const f = makeRepo(t)
  const payload = path.join(f.parent, 'issue.json')
  writeJson(payload, { key: 'ABC-9999', title: 'Something else' })
  const r = await cli(['ticket', 'cache', '--issue', 'ABC-1234', '--from-json', payload, '--json'], f)
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'ticket.key-mismatch')
  assert.equal(fs.existsSync(path.join(await stateDirOf(f), 'tickets', 'ABC-1234.json')), false)
})

test('a payload field named stateDir cannot redirect the cache out of the state directory', async t => {
  // The payload is whatever the tracker tool returned. Every other field is filtered by the record's
  // own destructuring; `stateDir` is the one that shares a name with the caller's own argument — and
  // a cache written elsewhere is a ticket the session's descriptor points at and never finds.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)
  const elsewhere = path.join(f.parent, 'elsewhere')
  const payload = path.join(f.parent, 'issue.json')
  writeJson(payload, { key: 'ABC-1234', title: 'The chip row truncates', description: 'x', stateDir: elsewhere })

  const r = await cli(['ticket', 'cache', '--issue', 'ABC-1234', '--from-json', payload, '--json'], f)
  assert.equal(r.code, 0)
  assert.equal(r.payload.file, path.join(stateDir, 'tickets', 'ABC-1234.json'))
  assert.equal(fs.existsSync(elsewhere), false, 'nothing was written outside the state dir')
})

// ---- intake --------------------------------------------------------------------------------------

test('intake admits a passed ticket, refuses an ungated one and an uncached one, and records both', async t => {
  // ⛔ A refusal is recorded and printed, never silent: a silently shrinking queue reads as "there was
  // no work". A key with no cached ticket FAILS CLOSED, because the gate cannot be judged without it.
  const f = makeRepo(t)
  const stateDir = await stateDirOf(f)
  const cache = async (key, labels) => {
    const file = path.join(f.parent, `${key}.json`)
    writeJson(file, { key, title: `ticket ${key}`, description: '', labels })
    const r = await cli(['ticket', 'cache', '--issue', key, '--from-json', file, '--json'], f)
    assert.equal(r.code, 0)
  }
  await cache('ABC-1', ['filed-by:fleet-check', 'gate:passed'])
  await cache('ABC-2', ['filed-by:fleet-check'])
  await cache('ABC-3', [])

  const r = await cli(['intake', 'check', 'ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', '--json'], f)
  // Exit 0 whatever the verdicts: a refusal is an answer, and a non-zero exit would make the launcher
  // treat a correctly gated queue as a broken tool.
  assert.equal(r.code, 0)
  assert.deepEqual(r.payload.admitted, ['ABC-1', 'ABC-3'], 'a ticket nobody\'s checker filed is ordinary human work')
  assert.deepEqual(r.payload.refused.map(x => [x.key, x.reason]), [['ABC-2', 'ungated'], ['ABC-4', 'no-ticket-cache']])
  assert.match(r.stderr, /REFUSE ABC-2/)

  const recorded = fs.readFileSync(path.join(stateDir, 'intake-refused.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(recorded.map(x => x.key), ['ABC-2', 'ABC-4'])
  assert.equal(recorded[0].source, 'intake-check')
})

test('a cache with no labels is judged by its body, and a blind admission is WARNED about', async t => {
  // ⛔ Contract §6 op-2 carries NO labels and the launcher caches straight from op-2, so "the feeder
  // supplied none" is the DEFAULT shape of this cache. Reading that as "the issue has none" made
  // every checker-filed ticket look unfiled and admitted it unconditionally — the gate refusing
  // nothing at all, silently. The body still shows the pipeline, and an admission the gate could not
  // really judge says so.
  const f = makeRepo(t)
  const cacheOp2 = async (key, description) => {
    const file = path.join(f.parent, `${key}.json`)
    // No labels[] at all: exactly what an op-2 getIssue result carries.
    writeJson(file, { key, title: `ticket ${key}`, description })
    assert.equal((await cli(['ticket', 'cache', '--issue', key, '--from-json', file, '--json'], f)).code, 0)
  }
  await cacheOp2('ABC-5', '**Gate:** failed — diagnosis wrong (audit)\n')
  await cacheOp2('ABC-6', 'The chip row truncates on a narrow viewport.\n')

  const r = await cli(['intake', 'check', 'ABC-5', 'ABC-6', '--json'], f)
  assert.equal(r.code, 0)
  assert.deepEqual(r.payload.refused.map(x => [x.key, x.reason]), [['ABC-5', 'gate-failed']], 'a body that shows the checker pipeline is judged by its gate line')
  assert.deepEqual(r.payload.admitted, ['ABC-6'], 'a ticket with nothing to gate on is still ordinary human work')
  assert.deepEqual(r.payload.warnings.map(w => [w.key, w.warn]), [['ABC-6', 'intake.labels-not-supplied']])
  assert.match(r.stderr, /note   ABC-6 was admitted with intake\.labels-not-supplied/)
})

// ---- session env + slots ---------------------------------------------------------------------------

test('session env prints the mirrored scalars a testing session cannot start without', async t => {
  // ⛔ A slot's dev-server command needs its own port: `{port}` is otherwise only a URL placeholder,
  // so without FLEET_SLOT/FLEET_PORT a fixed-port project cannot start a second slot at all.
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: 't2', role: 'testing', slot: 2 })

  const r = await cli(['session', 'env', '--label', 't2', '--json'], { ...f, backend })
  assert.equal(r.code, 0)
  const env = Object.fromEntries(r.payload.env.map(e => [e.name, e.value]))
  assert.equal(env.FLEET_SESSION, '1')
  assert.equal(env.FLEET_LABEL, 't2')
  assert.equal(env.FLEET_ROLE, 'testing')
  assert.equal(env.FLEET_SLOT, '2')
  assert.equal(env.FLEET_SLOT_BRANCH, 'testing-2')
  assert.equal(env.FLEET_PORT, '3001')
  assert.equal(env.FLEET_STATE_DIR, stateDir)
  assert.match(r.stderr, /^FLEET_SESSION=1$/m, 'a human gets KEY=value lines')

  const unknown = await cli(['session', 'env', '--label', '9', '--json'], { ...f, backend })
  assert.equal(unknown.code, 1)
  assert.equal(unknown.payload.error.code, 'session.unknown')
})

test('fleet slots shows the whole table, which rows are in the pool, and who holds each lock', async t => {
  // "Which slot is which" used to be answered three times — by the branch list, the port arithmetic
  // and the lock directory — and the answers disagreed.
  const f = makeRepo(t)
  await cli(['pool', 'acquire', 'testing', '--slot', 'testing-2', '--json'], { ...f, label: '4' })

  const r = await cli(['slots', '--json'], f)
  assert.equal(r.code, 0)
  assert.equal(r.payload.slots.length, 4, 'every row of testing.maxSlots is shown')
  assert.deepEqual(r.payload.slots.map(s => s.inPool), [true, true, false, false])
  assert.deepEqual(r.payload.slots.map(s => s.port), [3000, 3001, 3002, 3003])
  assert.equal(r.payload.slots[1].lock.held, true)
  assert.equal(r.payload.slots[1].lock.owner, '4')
  assert.equal(r.payload.slots[0].lock.held, false)
  assert.match(r.payload.slots[0].worktree, /app-testing$/)
  assert.match(r.payload.slots[1].worktree, /app-testing-2$/)
})

// ---- send ----------------------------------------------------------------------------------------

test('send reports delivered against requested for every target it was given', async t => {
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3' })
  register(backend, stateDir, { label: '4' })

  const text = 'slot 1 is session 18\'s mid-capture; keep retrying, it frees in a few minutes'
  const r = await cli(['send', '3', '4', text, '--json'], { ...f, backend })
  assert.equal(r.code, 0)
  assert.equal(r.payload.targets, 2)
  assert.equal(r.payload.sent, 2)
  for (const one of r.payload.results) assert.equal(one.deliveredChars, one.requestedChars)
  assert.deepEqual(backend.buffer('3'), [text])
  assert.deepEqual(backend.buffer('4'), [text])
})

test('a short write FAILS LOUDLY — the count is believed, not the absence of an exception', async t => {
  // ⛔ Console injection writes only what fits in the target's input buffer and then submits the
  // fragment: a ~700-character nudge once arrived as 62 characters and the session acted on those.
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3' })
  injectFault(backend, { sendLimit: 6 })

  const r = await cli(['send', '3', 'the testing slot is free again, retry your acquire', '--json'], { ...f, backend })
  assert.equal(r.code, 1, 'a half-delivered instruction is worse than none')
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.sent, 0)
  assert.equal(r.payload.error.code, 'send.short-write')
  assert.equal(r.payload.results[0].truncated, true)
  assert.equal(r.payload.results[0].deliveredChars, 6)
  assert.match(r.payload.error.hint, /--file/)
  assert.deepEqual(backend.buffer('3'), ['the te'], 'the fragment is what really landed')
})

test('one unknown label does not abort the fan-out over the others', async t => {
  // A send that threw on the first dead label left every other session unspoken to, and the launcher
  // could not tell "attempted" from "never tried".
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3' })

  const r = await cli(['send', '9', '3', 'retry now', '--json'], { ...f, backend })
  assert.equal(r.code, 1)
  assert.equal(r.payload.sent, 1)
  assert.equal(r.payload.results[0].ok, false)
  assert.match(r.payload.results[0].reason, /no registry entry/)
  assert.equal(r.payload.results[1].ok, true)
  assert.deepEqual(backend.buffer('3'), ['retry now'])
})

test('--file is the message, and the labels are everything before the text', async t => {
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3' })
  const file = path.join(f.parent, 'reply.md')
  fs.writeFileSync(file, 'The container is fixed at the primary checkout too.\nRetry your acquire.\n')

  const r = await cli(['send', '3', '--file', file, '--json'], { ...f, backend })
  assert.equal(r.code, 0)
  assert.equal(backend.buffer('3')[0], fs.readFileSync(file, 'utf8'))

  // PURE: the last positional is the text unless --file said otherwise. A rule about position, not a
  // guess about which words look like labels.
  assert.deepEqual(splitTargets(['3', '4', 'hello'], false), { labels: ['3', '4'], text: 'hello' })
  assert.deepEqual(splitTargets(['3', '4'], true), { labels: ['3', '4'], text: null })
})

// ---- kill ----------------------------------------------------------------------------------------

test('kill --dry-run prints the plan and kills nothing', async t => {
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  const { handle } = register(backend, stateDir, { label: '3' })

  const dry = await cli(['kill', '3', '--dry-run', '--json'], { ...f, backend })
  assert.equal(dry.code, 0)
  assert.equal(dry.payload.dryRun, true)
  assert.equal(dry.payload.plan[0].addressable, true)
  assert.match(dry.stderr, /would kill 3/)
  assert.equal(backend.isAlive(handle), true, 'a dry run that killed anything is not a dry run')

  const real = await cli(['kill', '3', '--json'], { ...f, backend })
  assert.equal(real.code, 0)
  assert.equal(real.payload.results[0].ok, true)
  assert.deepEqual(real.payload.results[0].survivors, [])
  assert.equal(backend.isAlive(handle), false)
  assert.equal(fs.existsSync(path.join(stateDir, 'sessions', '3.json')), true, 'the registry entry and the worktree are the reclaimer\'s to remove, not this command\'s')
})

test('a kill that leaves a process behind is a FAILURE, with the survivors named', async t => {
  // ⛔ `fleet relaunch` is "kill the tree, VERIFY GONE, spawn into the same worktree": a caller that
  // read "no exception" as "gone" would spawn a second agent beside a wedged one in one worktree,
  // where they collide on the git index.
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  const { handle } = register(backend, stateDir, { label: '3' })
  const devServer = backend.addChild(handle, { name: 'node', cmd: 'node dev-server.mjs' })
  injectFault(backend, { killLeaves: '3' })

  const r = await cli(['kill', '3', '--json'], { ...f, backend })
  assert.equal(r.code, 1)
  assert.equal(r.payload.error.code, 'kill.survivors')
  assert.deepEqual(r.payload.results[0].survivors, [devServer])
})

test('a label with no registry entry is refused rather than guessed at', async t => {
  // Identity comes from the registry. Killing by a command line that merely mentions the worktree
  // once took out the launcher itself, which has no fleet ancestor either.
  const f = makeRepo(t)
  const r = await cli(['kill', '9', '--json'], { ...f, backend: createFakeBackend() })
  assert.equal(r.code, 1)
  assert.equal(r.payload.results[0].ok, false)
  assert.match(r.payload.results[0].reason, /no registry entry/)
})

// ---- assets --------------------------------------------------------------------------------------

test('assets add writes an orphan branch with plumbing and never checks it out', async t => {
  // ⛔ Checking out an orphan assets branch in a session's worktree untracks every file the session
  // is working on. The captures must also never enter the PR's diff — that is why the branch exists.
  const f = makeRepo(t, { origin: null })
  const bare = path.join(f.parent, 'origin.git')
  fs.mkdirSync(bare)
  assert.ok(run('git', ['init', '--bare', '-q', bare], { timeoutMs: 60_000 }).ok)
  git(f.repo, ['remote', 'add', 'origin', bare])

  const before = path.join(f.parent, 'before.png')
  const after = path.join(f.parent, 'after.png')
  fs.writeFileSync(before, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
  fs.writeFileSync(after, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]))
  const headBefore = git(f.repo, ['rev-parse', 'HEAD'])
  const statusBefore = git(f.repo, ['status', '--porcelain'])

  const r = await cli(['assets', 'add', before, after, '--branch', 'assets-ABC-1234', '--json'], f)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.payload.pushed, true)
  assert.deepEqual(r.payload.files.map(x => x.file), ['before.png', 'after.png'])

  // The worktree is untouched: same HEAD, same branch, nothing staged, nothing added.
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(f.repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  assert.equal(git(f.repo, ['status', '--porcelain']), statusBefore, 'nothing was staged, added or checked out')

  // The files really are on the pushed branch, byte for byte.
  const listed = run('git', ['-C', bare, 'ls-tree', '--name-only', 'assets-ABC-1234'], { timeoutMs: 60_000 })
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/).sort(), ['after.png', 'before.png'])
  const blob = run('git', ['-C', bare, 'cat-file', 'blob', 'assets-ABC-1234:before.png'], { timeoutMs: 60_000, encoding: 'buffer' })
  assert.deepEqual(Buffer.from(blob.stdout), fs.readFileSync(before))

  // A second add keeps what is already there: the PR body already links to the first shot.
  const third = path.join(f.parent, 'a11y-tree.png')
  fs.writeFileSync(third, Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]))
  const again = await cli(['assets', 'add', third, '--branch', 'assets-ABC-1234', '--json'], f)
  assert.equal(again.code, 0, again.stderr)
  assert.equal(again.payload.parent, r.payload.commit, 'the second commit builds on the first, rather than orphaning it')
  const listed2 = run('git', ['-C', bare, 'ls-tree', '--name-only', 'assets-ABC-1234'], { timeoutMs: 60_000 })
  assert.deepEqual(listed2.stdout.trim().split(/\r?\n/).sort(), ['a11y-tree.png', 'after.png', 'before.png'])
})

test('a push that fails is a FAILURE, even though the local branch now exists', async t => {
  // ⛔ The URLs this command prints would 404 until the push lands, and a review page full of broken
  // images reads as work that was never done — so "the commit was written" is not success. The local
  // commit is named in the payload, because the fix is to retry the push, not to re-capture.
  const f = makeRepo(t, { origin: null })
  // A remote that cannot accept anything — and is not on the network either.
  git(f.repo, ['remote', 'add', 'origin', path.join(f.parent, 'no-such-remote.git')])
  const shot = path.join(f.parent, 'before.png')
  fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))

  const r = await cli(['assets', 'add', shot, '--branch', 'assets-ABC-1234', '--json'], f)
  assert.equal(r.code, 1)
  assert.equal(r.payload.ok, false)
  assert.equal(r.payload.pushed, false)
  assert.equal(r.payload.error.code, 'assets.push-failed')
  assert.equal(git(f.repo, ['rev-parse', 'refs/heads/assets-ABC-1234']), r.payload.commit, 'the commit the caller must retry the push for')
  assert.match(r.stderr, /committed locally .* but NOT pushed/)
})

test('re-adding a capture whose name is not ASCII replaces it instead of duplicating it', async t => {
  // ⛔ `git ls-tree` C-quotes any non-ASCII name (core.quotePath defaults to true), so an existing
  // `écran.png` read back as `"\303\251cran.png"` collided with nothing when the same shot was added
  // again: the tree then carried TWO entries of one name — malformed (git fsck: duplicateEntries) —
  // and the shot the PR body already links to was the one lost.
  const f = makeRepo(t, { origin: null })
  const bare = path.join(f.parent, 'origin.git')
  fs.mkdirSync(bare)
  assert.ok(run('git', ['init', '--bare', '-q', bare], { timeoutMs: 60_000 }).ok)
  git(f.repo, ['remote', 'add', 'origin', bare])

  const accented = path.join(f.parent, 'écran.png')
  fs.writeFileSync(accented, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
  assert.equal((await cli(['assets', 'add', accented, '--branch', 'assets-ABC-1234', '--json'], f)).code, 0)

  // The same capture, taken again an hour later.
  const recaptured = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])
  fs.writeFileSync(accented, recaptured)
  const again = await cli(['assets', 'add', accented, '--branch', 'assets-ABC-1234', '--json'], f)
  assert.equal(again.code, 0, again.stderr)

  const names = run('git', ['-C', bare, 'ls-tree', '-z', '--name-only', 'assets-ABC-1234'], { timeoutMs: 60_000 })
    .stdout.split('\0').filter(Boolean)
  assert.deepEqual(names, ['écran.png'], 'one entry under its own literal name, not two')
  const blob = run('git', ['-C', bare, 'cat-file', 'blob', 'assets-ABC-1234:écran.png'], { timeoutMs: 60_000, encoding: 'buffer' })
  assert.deepEqual(Buffer.from(blob.stdout), recaptured, 'the entry that survived is the new capture')
})

test('two captures that would land on the branch under one name are refused', async t => {
  // A before.png quietly replaced by another directory's before.png is evidence of the wrong thing,
  // and nothing about the PR would look wrong.
  const f = makeRepo(t)
  const one = path.join(f.parent, 'a', 'shot.png')
  const two = path.join(f.parent, 'b', 'shot.png')
  for (const p of [one, two]) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'png')
  }
  const r = await cli(['assets', 'add', one, two, '--branch', 'assets-ABC-1234', '--json'], f)
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'assets.duplicate-name')
})

test('an unrendered branch template is refused before anything is written', async t => {
  // A literal `{key}` was once pushed as a branch name, and every embed in every ticket pointed at it.
  const f = makeRepo(t)
  const shot = path.join(f.parent, 'shot.png')
  fs.writeFileSync(shot, 'png')
  const r = await cli(['assets', 'add', shot, '--branch', 'assets-{key}', '--json'], f)
  assert.equal(r.code, 2)
  assert.equal(r.payload.error.code, 'assets.branch-unrendered')
  assert.equal(run('git', ['-C', f.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/assets-{key}'], { timeoutMs: 30_000 }).ok, false)
})

test('a raw URL keeps the case of the remote path and encodes the file name', () => {
  // ⛔ The repo KEY is lowercased so a config lookup is stable; a URL built from it 404s on any forge
  // whose paths are case-sensitive, and the reviewer sees a broken image instead of the evidence.
  assert.equal(webBaseFor('git@github.com:Acme/App.git'), 'https://github.com/Acme/App')
  assert.equal(webBaseFor('https://ada@gitlab.com/acme/group/app.git'), 'https://gitlab.com/acme/group/app')
  assert.equal(
    rawUrlFor({ host: 'github', base: 'https://github.com/Acme/App', branch: 'assets-ABC-1234', file: 'before shot.png' }),
    'https://github.com/Acme/App/blob/assets-ABC-1234/before%20shot.png?raw=true',
  )
  assert.equal(
    rawUrlFor({ host: 'gitlab', base: 'https://gitlab.com/acme/app', branch: 'assets-ABC-1234', file: 'after.png' }),
    'https://gitlab.com/acme/app/-/raw/assets-ABC-1234/after.png',
  )
  // A forge that cannot hot-link is answered with null, not with a URL that will 404.
  assert.equal(rawUrlFor({ host: 'other', base: 'https://git.example.com/acme/app', branch: 'b', file: 'a.png' }), null)
})

// ---- the envelope ----------------------------------------------------------------------------------

test('every one of these commands puts exactly one {"ok", "v": 1} object on stdout', async t => {
  // The launcher parses stdout. One stray progress line makes the payload unparseable, and a healthy
  // fleet then reads as a broken tool — so the human half goes to stderr.
  const f = makeRepo(t)
  const backend = createFakeBackend()
  const stateDir = await stateDirOf(f)
  register(backend, stateDir, { label: '3', issue: 'ABC-1234' })

  const invocations = [
    ['pool', 'status'],
    ['pool', 'acquire', 'testing'],
    ['pool', 'release', 'testing', 'testing'],
    ['slots'],
    ['session', 'env', '--label', '3'],
    ['flag', 'blocked', '--category', 'other', '--observation', 'the bootstrap command exited 1'],
    ['flag', 'clear'],
    ['flag', 'done', '--outcome', 'no-code-change', '--reason', 'disputed'],
    ['outbox', 'add', '--op', 'op-8', '--key', 'ABC-1234', '--args', '{"url":"https://github.com/acme/app/pull/7","title":"PR"}'],
    ['outbox', 'list'],
    ['ticket', 'list'],
    ['intake', 'check', 'ABC-1234'],
    ['send', '3', 'carry on'],
    ['kill', '3', '--dry-run'],
  ]
  for (const argv of invocations) {
    const r = await cli([...argv, '--json'], { ...f, label: '3', backend })
    assert.equal(r.outChunks.length, 1, `${argv.join(' ')} wrote ${r.outChunks.length} chunks to stdout`)
    const payload = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(payload).slice(0, 2), ['ok', 'v'], `${argv.join(' ')}: the envelope must start {ok, v}`)
    assert.equal(payload.v, 1)
    assert.equal(typeof payload.ok, 'boolean')
    assert.ok(r.stderr.length > 0, `${argv.join(' ')} should still speak to a human on stderr`)
  }
})
