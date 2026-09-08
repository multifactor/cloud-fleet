import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run, git as gitExec } from '../src/sys/exec.mjs'
import { snapshotFrom } from '../src/sys/proc.mjs'
import { ensureWorktree, listWorktrees, findWorktree, samePath } from '../src/core/worktree.mjs'
import { writeSession, readSession, listSessions } from '../src/core/fleet.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { stateLayout } from '../src/config/paths.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import {
  OUTCOMES, STRIKES_TO_ARM, NEVER_BRANCHED_IDLE_MS, INFER_KEY,
  reclaimPlan, inferFinished, strike, newReclaimState, pruneState, parseReflog, closeOutMove, isSessionBranch,
  sessionBranchPattern, secondProcesses, isFleetFolder, parseDoneFlag, listDoneFlags, doneFlagPaths, pendingOutboxKeys,
  wipDir, wipPatchPath, saveWipPatch, sweepFolder, observeWorktree, listRemoteBranches, baseRefsOf, reclaimOnce,
} from '../src/watchers/reclaim.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reclaim-'))
const T0 = Date.parse('2026-03-14T10:00:00Z')
const HOUR = 3_600_000
const KEY = 'ABC-1234'
const BRANCH = 'ada/abc-1234-fix-thing'

/** A resolved-enough config: the schema defaults plus the derived keys this module reads. */
function cfg(root, over = {}) {
  const c = defaultsFor()
  c.repo.name = 'app'
  c.repo.worktreeParent = root
  c.vcs.branchPrefix = 'ada'
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

const G = (cwd, ...args) => {
  const r = run('git', args, { cwd })
  if (!r.ok) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/**
 * A real repository with a real (bare) remote in a temp dir — git is never mocked; half the traps
 * here are git's own behaviour (a reflog subject, an ls-remote failure mode, a remove that
 * deregisters and fails to delete).
 */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reclaim-repo-'))
  const remote = path.join(root, 'remote.git')
  G(root, 'init', '-q', '--bare', remote)
  const primary = path.join(root, 'app')
  fs.mkdirSync(primary)
  if (!run('git', ['init', '-q', '-b', 'main'], { cwd: primary }).ok) {
    G(primary, 'init', '-q')
    G(primary, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  }
  G(primary, 'config', 'user.email', 'ada@example.com')
  G(primary, 'config', 'user.name', 'ada')
  G(primary, 'config', 'commit.gpgsign', 'false')
  G(primary, 'config', 'core.autocrlf', 'false') // a diff that flips line endings is not the session's work
  fs.writeFileSync(path.join(primary, 'README.md'), '# app\n')
  fs.writeFileSync(path.join(primary, '.gitignore'), 'node_modules/\n') // as every Node repo does; the shims are not the session's work
  G(primary, 'add', '-A')
  G(primary, 'commit', '-q', '-m', 'first')
  G(primary, 'remote', 'add', 'origin', remote)
  G(primary, 'push', '-q', '-u', 'origin', 'main')
  G(primary, 'fetch', '-q', 'origin')
  const stateDir = path.join(root, 'state')
  const backend = createFakeBackend({ clock: () => T0 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { root, remote, primary, stateDir, backend, config: cfg(root), logs: [], state: newReclaimState() }
}

/**
 * One working session as the launcher and the session between them leave it: a detached worktree at
 * `origin/main`, optionally a session branch with a commit (`push`ed or not), optionally the close-out
 * move back to the base, plus the ready sentinel, a shim directory, a fake-backend process and a
 * registry descriptor. `descriptorBranch` is what the launcher recorded — '' by default, because the
 * launcher creates the tree DETACHED and only the session ever names its branch.
 */
function makeSession(fx, label, {
  branch = null, push = false, closeOut = false, ready = true, shims = 3,
  dirty = false, untracked = false, descriptorBranch = '', role = 'working', worktree: wt = null, extra = {},
} = {}) {
  const worktree = wt || path.join(fx.root, `app-session-${label}`)
  ensureWorktree({ repo: fx.primary, path: worktree, baseBranch: 'origin/main' })
  if (branch) {
    G(worktree, 'checkout', '-q', '-b', branch)
    fs.writeFileSync(path.join(worktree, 'fix.txt'), 'the fix\n')
    G(worktree, 'add', 'fix.txt')
    G(worktree, 'commit', '-q', '-m', `fix ${KEY}`)
    if (push) G(worktree, 'push', '-q', 'origin', branch)
    if (closeOut) G(worktree, 'checkout', '-q', '--detach', 'origin/main')
  }
  if (ready) fs.writeFileSync(path.join(worktree, fx.config.install.readyFlag), '{"v":1}\n')
  if (shims !== null) {
    fs.mkdirSync(path.join(worktree, 'node_modules', '.bin'), { recursive: true })
    for (let i = 0; i < shims; i++) fs.writeFileSync(path.join(worktree, 'node_modules', '.bin', `tool-${i}`), '#!/bin/sh\n')
  }
  if (dirty) fs.writeFileSync(path.join(worktree, 'README.md'), '# app\n\nedited but never committed\n')
  if (untracked) fs.writeFileSync(path.join(worktree, 'notes.md'), 'an hour of notes\n')
  const handle = fx.backend.spawn({
    id: String(label), role, title: `session ${label}`, cwd: worktree, env: [],
    command: 'node', args: ['shim.mjs', `--fleet-session=${label}`],
  })
  writeSession({
    label: String(label), role, worktree, branch: descriptorBranch, issue: KEY,
    backendRef: handle.backendRef, shimPid: handle.shimPid,
    createdAt: new Date(T0 - HOUR).toISOString(),
    ...extra,
  }, { stateDir: fx.stateDir })
  return { label: String(label), worktree, handle }
}

/** The done flag as `fleet flag done` writes it: the JSON plus its one-line .txt twin (contract §4). */
function writeDone(fx, label, flag) {
  const { json, txt } = doneFlagPaths(fx.stateDir, label)
  fs.mkdirSync(path.dirname(json), { recursive: true })
  const body = { v: 1, session: String(label), issue: KEY, outcome: 'pr-pushed', prUrl: 'https://github.com/acme/app/pull/1', reason: '', evidence: [], prescription: 'followed', bodyPatched: false, at: '2026-03-14T10:00:00Z', ...flag }
  fs.writeFileSync(json, JSON.stringify(body, null, 2) + '\n')
  fs.writeFileSync(txt, `${body.outcome} ${body.issue}\n`)
  return { json, txt }
}

/** One reclaim pass over the fixture, with the snapshot taken ONCE from the fake backend's process table. */
function pass(fx, over = {}) {
  const r = reclaimOnce({
    stateDir: fx.stateDir, backend: fx.backend, config: fx.config, primary: fx.primary,
    snapshot: fx.backend.processes(), resnapshot: () => fx.backend.processes(),
    nowMs: T0, selfPid: 999_999, log: line => fx.logs.push(line), state: fx.state,
    ...over,
  })
  fx.state = r.state
  return r
}

const registered = (fx, worktree) => !!findWorktree(listWorktrees(fx.primary), worktree)
const flagExists = (fx, label) => fs.existsSync(doneFlagPaths(fx.stateDir, label).json)
const byLabel = (r, label) => r.results.find(x => x.label === String(label))
const codes = x => (x.refusals || []).map(f => f.code)

/** A worktree reading as reclaimPlan expects it, defaulting to "finished and clean". */
const wt = (over = {}) => ({ label: '3', detached: true, clean: true, changes: [], currentBranch: null, sessionBranch: BRANCH, ...over })
const flag = (over = {}) => ({ v: 1, session: '3', issue: KEY, outcome: 'pr-pushed', prescription: 'followed', bodyPatched: false, ...over })

// ---- reclaimPlan: the four preconditions, pure -------------------------------------------------

test('reclaimPlan: a worktree still on a branch is not finished, whatever the flag says', () => {
  // A finished session detaches at the base as its close-out; a checked-out branch means the session
  // wrote its flag before that step — or never did it — and the tree is not done.
  const p = reclaimPlan({ flag: flag(), worktreeState: wt({ detached: false, currentBranch: BRANCH }), remoteBranches: [BRANCH] })
  assert.equal(p.proceed, false)
  assert.deepEqual(codes(p), ['not-detached'])
  assert.match(p.refusals[0].reason, /on branch "ada\/abc-1234-fix-thing"/)
  // an unreadable HEAD state is not "detached" either
  assert.deepEqual(codes(reclaimPlan({ flag: flag(), worktreeState: wt({ detached: null }), remoteBranches: [BRANCH] })), ['not-detached'])
})

test('reclaimPlan: uncommitted work refuses pr-pushed, but is saved as a patch for the no-code outcomes', () => {
  // A session that flagged pr-pushed over uncommitted work is not done. For cancelled / duplicate /
  // no-code-change the same dirt is ABANDONED work: two gates once contradicted each other on one
  // session ("cancelled, nothing to preserve" accepted; "a tracked file is modified" refused) and
  // because both were permanent the watcher retried every fifteen seconds for hours. A gate that can
  // never be satisfied resolves its blocker — save the diff, proceed — instead of looping.
  const dirty = wt({ clean: false, changes: [' M README.md', '?? notes.md'] })
  const pushed = reclaimPlan({ flag: flag(), worktreeState: dirty, remoteBranches: [BRANCH] })
  assert.deepEqual(codes(pushed), ['dirty'])
  assert.equal(pushed.savePatch, false)
  assert.match(pushed.refusals[0].reason, /2 local change\(s\) \( M README\.md, \?\? notes\.md\)/)

  for (const outcome of ['cancelled', 'duplicate', 'no-code-change']) {
    const p = reclaimPlan({ flag: flag({ outcome }), worktreeState: dirty })
    assert.equal(p.proceed, true, `${outcome} proceeds over local changes`)
    assert.equal(p.savePatch, true, `${outcome} saves the patch first`)
  }
  // check-complete is a checker's slice: uncommitted work there is a slice not written out, so it refuses
  assert.deepEqual(codes(reclaimPlan({ flag: flag({ outcome: 'check-complete' }), worktreeState: dirty })), ['dirty'])
  // cleanliness that could not be READ is not cleanliness — the gate fails in the direction that loses nothing
  const unknown = reclaimPlan({ flag: flag({ outcome: 'cancelled' }), worktreeState: wt({ clean: null }) })
  assert.deepEqual(codes(unknown), ['dirty'])
  assert.equal(unknown.savePatch, false)
})

test('reclaimPlan: an outcome outside contract §5 is refused, never guessed at', () => {
  assert.deepEqual(OUTCOMES, ['pr-pushed', 'cancelled', 'duplicate', 'no-code-change', 'check-complete'])
  for (const bad of ['done', 'PR-PUSHED', '', null, undefined, 7]) {
    const p = reclaimPlan({ flag: flag({ outcome: bad }), worktreeState: wt() })
    assert.deepEqual(codes(p), ['bad-outcome'], `outcome ${JSON.stringify(bad)} must be refused`)
  }
  assert.deepEqual(codes(reclaimPlan({ flag: null, worktreeState: wt() })), ['no-flag'])
  for (const good of OUTCOMES) {
    assert.equal(reclaimPlan({ flag: flag({ outcome: good }), worktreeState: wt(), remoteBranches: [BRANCH] }).proceed, true, good)
  }
})

test('reclaimPlan: pr-pushed is verified against the REMOTE, and a failed lookup refuses rather than passes', () => {
  // The ledger of record is the remote, not the flag — a flag once said "pushed" for a push that had
  // failed. And the lookup itself can fail (it once did forever, run from a deregistered tree): a null
  // list is "could not verify", which refuses, so nothing is lost while the check is broken.
  assert.deepEqual(codes(reclaimPlan({ flag: flag(), worktreeState: wt(), remoteBranches: ['main', 'ada/abc-1240-other'] })), ['branch-not-on-remote'])
  assert.deepEqual(codes(reclaimPlan({ flag: flag(), worktreeState: wt(), remoteBranches: null })), ['remote-unverified'])
  assert.deepEqual(codes(reclaimPlan({ flag: flag(), worktreeState: wt(), remoteBranches: undefined })), ['remote-unverified'])
  // no branch name from anywhere (descriptor or reflog): the push cannot be verified
  assert.deepEqual(codes(reclaimPlan({ flag: flag(), worktreeState: wt({ sessionBranch: null }), remoteBranches: [BRANCH] })), ['no-branch'])
  // the other outcomes never consult the remote at all — a cancelled session legitimately has no branch
  assert.equal(reclaimPlan({ flag: flag({ outcome: 'cancelled' }), worktreeState: wt({ sessionBranch: null }), remoteBranches: null }).proceed, true)
  const ok = reclaimPlan({ flag: flag(), worktreeState: wt(), remoteBranches: ['main', BRANCH] })
  assert.equal(ok.proceed, true)
  assert.equal(ok.branch, BRANCH)
})

test('reclaimPlan: an amended prescription must be patched, or its op-15 must be queued, before the session is gone', () => {
  // The correction must be on its way to where it is read: once the worktree is gone there is nobody
  // left to ask for it, and the next reader of the ticket acts on the wrong prescription.
  const amended = flag({ outcome: 'cancelled', prescription: 'amended', bodyPatched: false })
  assert.deepEqual(codes(reclaimPlan({ flag: amended, worktreeState: wt(), outboxKeys: [] })), ['amended-unpatched'])
  assert.deepEqual(codes(reclaimPlan({ flag: amended, worktreeState: wt(), outboxKeys: ['ABC-9999'] })), ['amended-unpatched'], 'another key\'s patch does not count')
  assert.equal(reclaimPlan({ flag: amended, worktreeState: wt(), outboxKeys: [KEY] }).proceed, true, 'a queued op-15 for this key is the correction on its way')
  assert.equal(reclaimPlan({ flag: { ...amended, bodyPatched: true }, worktreeState: wt() }).proceed, true, 'a patched body needs no outbox')
  // followed and refuted do not gate on the body: refuted's patch is the launcher's outbox drain, not a reclaim precondition
  for (const prescription of ['followed', 'refuted']) {
    assert.equal(reclaimPlan({ flag: flag({ outcome: 'cancelled', prescription }), worktreeState: wt() }).proceed, true, prescription)
  }
})

test('reclaimPlan: a second live process in the worktree refuses — reclaiming would delete the tree under it', () => {
  // A relaunch that spawned beside a wedged agent left two in one tree; killing one and removing the
  // worktree pulled the tree out from under the other.
  const p = reclaimPlan({ flag: flag(), worktreeState: wt(), remoteBranches: [BRANCH], liveInWorktree: [{ pid: 4242, label: '7' }, { pid: 4243, label: null }] })
  assert.deepEqual(codes(p), ['second-process'])
  assert.match(p.refusals[0].reason, /4242 \(session 7\), 4243/)
  // every refusal is reported at once, so the operator reads one line per problem rather than one per pass
  const many = reclaimPlan({ flag: flag({ outcome: 'nope' }), worktreeState: wt({ detached: false, clean: false }), liveInWorktree: [{ pid: 1 }] })
  assert.deepEqual(codes(many), ['bad-outcome', 'not-detached', 'dirty', 'second-process'])
})

test('reclaimPlan: the flag FILENAME is the identity — a body naming another session is refused, a body naming none is not', () => {
  // A flag written under label 3 that says session 7 would reclaim 3's worktree on 7's say-so.
  assert.deepEqual(codes(reclaimPlan({ flag: flag({ session: '7' }), worktreeState: wt(), remoteBranches: [BRANCH] })), ['flag-session-mismatch'])
  assert.equal(reclaimPlan({ flag: flag({ session: 3 }), worktreeState: wt(), remoteBranches: [BRANCH] }).proceed, true, 'a numeric session is the same label')
  const nameless = flag()
  delete nameless.session
  assert.equal(reclaimPlan({ flag: nameless, worktreeState: wt(), remoteBranches: [BRANCH] }).proceed, true)
})

// ---- inference, pure ---------------------------------------------------------------------------

const installed = (over = {}) => ({ registered: true, readyFlag: true, binShims: 40, detached: true, clean: true, changes: [], moves: 2, closeOut: { from: BRANCH, to: 'origin/main' }, ...over })

test('inferFinished: NEVER while installing — a fresh worktree is detached, clean and branch-less until its install finishes', () => {
  // Under wave pacing that install may not have STARTED for most of an hour; by git state alone the
  // tree is identical to a finished one. The ready flag missing, or an empty shim directory, is the
  // tree saying so.
  const noFlag = inferFinished({ worktreeState: installed({ readyFlag: false, moves: 0, closeOut: null }), alive: false, idleMs: 3 * HOUR })
  assert.equal(noFlag.finished, false)
  assert.match(noFlag.reason, /still installing: the ready flag is absent/)
  const noShims = inferFinished({ worktreeState: installed({ binShims: 0 }), alive: false })
  assert.equal(noShims.finished, false)
  assert.match(noShims.reason, /still installing: node_modules has no shims/)
  // a tree with no node_modules at all is not a Node project, not an install in progress
  assert.equal(inferFinished({ worktreeState: installed({ binShims: null }), alive: false }).finished, true)
  assert.equal(inferFinished({ worktreeState: installed({ registered: false }), alive: false }).finished, false)
})

test('inferFinished: never on a live session, and never on a PR lookup', () => {
  // A relaunched agent reading its ticket in a reused tree is detached and clean too, with an old
  // close-out move still in the reflog. And a finished session may legitimately have NO PR and no
  // branch; a PR list filtered on an empty branch name once returned every PR there was.
  assert.match(inferFinished({ worktreeState: installed(), alive: true }).reason, /the session is alive/)
  assert.match(inferFinished({ worktreeState: installed(), alive: null }).reason, /liveness is unknown/)
  for (const k of ['pr', 'prs', 'prUrl']) {
    assert.throws(() => inferFinished({ worktreeState: installed(), alive: false, [k]: [] }), /PR lookup .* is not evidence/, k)
  }
})

test('inferFinished: the reflog arm fires on the close-out move; the never-branched arm needs a long dead idle', () => {
  const closed = inferFinished({ worktreeState: installed(), alive: false })
  assert.deepEqual([closed.finished, closed.arm], [true, 'reflog'])
  assert.match(closed.reason, /close-out move from ada\/abc-1234-fix-thing to origin\/main/)
  // checkouts that never came back to the base: a session mid-work, or one that crashed on its branch
  assert.match(inferFinished({ worktreeState: installed({ closeOut: null, moves: 1 }), alive: false }).reason, /no move from a session branch back to the base/)
  // never branched: only a LONG silence from a dead session separates it from a freshly installed tree
  const fresh = installed({ closeOut: null, moves: 0 })
  assert.match(inferFinished({ worktreeState: fresh, alive: false, idleMs: 5 * 60_000 }).reason, /never branched and idle 5 min \(needs 30 min/)
  assert.match(inferFinished({ worktreeState: fresh, alive: false, idleMs: null }).reason, /idle time unknown/)
  const idle = inferFinished({ worktreeState: fresh, alive: false, idleMs: NEVER_BRANCHED_IDLE_MS })
  assert.deepEqual([idle.finished, idle.arm], [true, 'never-branched'])
  // dirty or on a branch: not finished on either arm
  assert.match(inferFinished({ worktreeState: installed({ clean: false, changes: ['x'] }), alive: false }).reason, /1 local change/)
  assert.match(inferFinished({ worktreeState: installed({ detached: false, currentBranch: BRANCH }), alive: false }).reason, /on branch/)
})

test('strike: the inference arms need two consecutive passes, and a lapse or a changed arm resets the count', () => {
  // The done flag needs no delay; a verdict read from git state alone gets a second look, because
  // one pass detached-and-clean followed by one pass on a branch is a session at work, not two strikes.
  assert.equal(STRIKES_TO_ARM, 2)
  const yes = { finished: true, arm: 'reflog' }
  let s = strike({}, '3', yes, T0)
  assert.deepEqual([s.armed, s.count], [false, 1])
  s = strike(s.strikes, '3', yes, T0 + 15_000)
  assert.deepEqual([s.armed, s.count], [true, 2])
  s = strike(s.strikes, '3', { finished: false }, T0 + 30_000)
  assert.deepEqual([s.armed, s.count, s.strikes], [false, 0, {}])
  s = strike(strike({}, '3', yes, T0).strikes, '3', { finished: true, arm: 'never-branched' }, T0 + 15_000)
  assert.deepEqual([s.armed, s.count], [false, 1], 'a different arm starts over')
})

test('parseReflog + closeOutMove: the NEWEST checkout from a session branch to any spelling of the base', () => {
  // The reflog is the signal — not a notes file the session may or may not have deleted, not a PR lookup.
  const subjects = [
    'checkout: moving from ada/abc-1234-fix-thing to origin/main',
    'commit: fix ABC-1234',
    'checkout: moving from e186aed1efc7f56fb1d2b0659a229ecdc367f331 to ada/abc-1234-fix-thing',
    'reset: moving to origin/main',
  ]
  const moves = parseReflog(subjects)
  assert.deepEqual(moves, [
    { from: BRANCH, to: 'origin/main' },
    { from: 'e186aed1efc7f56fb1d2b0659a229ecdc367f331', to: BRANCH },
  ])
  const rule = { pattern: sessionBranchPattern(cfg('/w')), remote: 'origin', baseBranch: 'main' }
  const bases = ['origin/main', 'main', 'e186aed1efc7f56fb1d2b0659a229ecdc367f331']
  assert.deepEqual(closeOutMove(moves, { baseRefs: bases, ...rule }), { from: BRANCH, to: 'origin/main' })
  // a detach at the sha counts as a return to the base too
  assert.deepEqual(closeOutMove(parseReflog([`checkout: moving from ${BRANCH} to e186aed1efc7f56fb1d2b0659a229ecdc367f331`]), { baseRefs: bases, ...rule }).from, BRANCH)
  // the move INTO the branch is not a close-out, and neither is a move from a branch that is not a session's
  assert.equal(closeOutMove(moves.slice(1), { baseRefs: bases, ...rule }), null)
  assert.equal(closeOutMove(parseReflog(['checkout: moving from testing to origin/main']), { baseRefs: bases, ...rule }), null)
  assert.equal(closeOutMove(parseReflog(['checkout: moving from main to origin/main']), { baseRefs: bases, ...rule }), null)
  // the descriptor's own branch is a session branch whatever the template says
  assert.equal(isSessionBranch('hotfix', rule), false)
  assert.equal(isSessionBranch('hotfix', { ...rule, descriptorBranch: 'hotfix' }), true)
  assert.equal(isSessionBranch('origin/ada/abc-1-x', rule), false)
})

test('pruneState: a label whose flag file is GONE is forgotten at once, so a reused number can flag again', () => {
  // A watcher that remembered handled flags by label silently ignored the next session to wear that
  // number. Strikes live while the label is registered and unflagged; inference refusals are
  // remembered under their own key so a later flag for the same label is judged fresh.
  const s = { strikes: { 3: { count: 1 }, 4: { count: 1 }, 9: { count: 2 } }, reported: { 3: 'dirty', 5: 'dirty', [`${INFER_KEY}4`]: 'locked', [`${INFER_KEY}8`]: 'locked' } }
  const p = pruneState(s, { flagLabels: ['3'], registryLabels: ['3', '4', '8'] })
  assert.deepEqual(p.reported, { 3: 'dirty', [`${INFER_KEY}4`]: 'locked', [`${INFER_KEY}8`]: 'locked' })
  assert.deepEqual(p.strikes, { 4: { count: 1 } }, 'a flagged label and an unregistered one lose their strikes')
  assert.deepEqual(pruneState(null, {}), newReclaimState())
})

test('secondProcesses: boundary-safe path matching, own descendants excluded, an empty snapshot is unknown', () => {
  // `app-session-1` is a prefix of `app-session-10`, and a bare substring once killed sessions 10
  // through 19 while clearing session 1. An empty snapshot is a FAILED listing, never an idle machine.
  const wt1 = path.resolve('/w/app-session-1')
  const snap = snapshotFrom([
    { pid: 1, ppid: 0, name: 'host', cmd: 'host' },
    { pid: 10, ppid: 1, name: 'node', cmd: 'node shim.mjs --fleet-session=1' },
    { pid: 11, ppid: 10, name: 'node', cmd: `node agent.mjs --cwd ${wt1}` },
    { pid: 20, ppid: 1, name: 'node', cmd: `node server.mjs ${wt1}0/src/server` },   // session 10's, not ours
    { pid: 30, ppid: 1, name: 'node', cmd: `node stray.mjs ${wt1}${path.sep}scripts` }, // a stray inside OUR tree
    { pid: 40, ppid: 1, name: 'node', cmd: 'node shim.mjs --fleet-session=7' },        // session 7, registered on the same path
    { pid: 50, ppid: 1, name: 'node', cmd: `node me.mjs ${wt1}` },                    // the caller itself
  ])
  const registry = [{ label: '1', worktree: wt1 }, { label: '7', worktree: wt1 }, { label: '10', worktree: `${wt1}0` }]
  const live = secondProcesses({ snapshot: snap, worktree: wt1, label: '1', registry, selfPid: 50 })
  assert.deepEqual(live.map(p => [p.pid, p.label, p.why]), [[30, null, 'inside-worktree'], [40, '7', 'registered-session']])
  assert.equal(secondProcesses({ snapshot: new Map(), worktree: wt1, label: '1', registry }), null)
  // …and the boundary hands session 10's stray to session 10, where it IS a second process
  assert.deepEqual(secondProcesses({ snapshot: snap, worktree: `${wt1}0`, label: '10', registry, selfPid: 50 }).map(p => [p.pid, p.why]), [[20, 'inside-worktree']])
})

test('isFleetFolder: a folder is positively identified by anchored name AND parent before anything deletes it', () => {
  const c = cfg(path.resolve('/w'))
  assert.equal(isFleetFolder(path.resolve('/w/app-session-3'), c), true)
  assert.equal(isFleetFolder(path.resolve('/w/app-check-ui'), c), true)
  assert.equal(isFleetFolder(path.resolve('/w/app-session-3-backup'), c), false)
  assert.equal(isFleetFolder(path.resolve('/w/app-testing'), c), false, 'a slot is fleet down\'s, not the reclaimer\'s')
  assert.equal(isFleetFolder(path.resolve('/elsewhere/app-session-3'), c), false, 'right name, wrong parent')
  assert.equal(isFleetFolder('app-session-3', c), false, 'relative paths are never deleted')
})

// ---- flags and the outbox on disk --------------------------------------------------------------

test('listDoneFlags reads only done-<label>.json, reports an unreadable one, and pendingOutboxKeys reads only op-15', () => {
  const stateDir = tmp()
  const layout = stateLayout(stateDir, process.platform)
  fs.mkdirSync(layout.flags, { recursive: true })
  fs.mkdirSync(layout.outbox, { recursive: true })
  fs.writeFileSync(path.join(layout.flags, 'done-3.json'), JSON.stringify({ v: 1, session: '3', outcome: 'cancelled' }))
  fs.writeFileSync(path.join(layout.flags, 'done-3.txt'), 'cancelled\n')
  fs.writeFileSync(path.join(layout.flags, 'done-4.json'), '{"v":1,"session":"4"')
  fs.writeFileSync(path.join(layout.flags, 'blocked-5.json'), JSON.stringify({ v: 1, session: '5', category: 'install' }))
  fs.writeFileSync(path.join(layout.flags, 'done-..json'), '{}')
  const flags = listDoneFlags(stateDir)
  assert.deepEqual(flags.map(f => [f.label, f.flag && f.flag.outcome, f.error]), [['3', 'cancelled', null], ['4', null, 'is not valid JSON']])
  assert.deepEqual(parseDoneFlag('[1]'), { error: 'is not a JSON object' })
  assert.deepEqual(listDoneFlags(path.join(stateDir, 'absent')), [])

  fs.writeFileSync(path.join(layout.outbox, 'a.json'), JSON.stringify({ n: 15, key: KEY }))
  fs.writeFileSync(path.join(layout.outbox, 'b.json'), JSON.stringify({ n: 11, key: 'ABC-9999' }))
  fs.writeFileSync(path.join(layout.outbox, 'c.json'), '{broken')
  assert.deepEqual(pendingOutboxKeys(stateDir), [KEY])
  assert.deepEqual(pendingOutboxKeys(path.join(stateDir, 'absent')), [])
})

// ---- the happy path on a real repository --------------------------------------------------------

test('a pr-pushed flag reclaims: kill verified, worktree deregistered and verified, folder swept, registry entry gone, flag deleted', t => {
  const fx = makeRepo(t)
  // The launcher created the tree detached; the SESSION named its branch — so the branch the remote is
  // checked for comes from the reflog's close-out move, not from a descriptor field nobody wrote.
  const s = makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: true })
  const { json, txt } = writeDone(fx, 1, { outcome: 'pr-pushed' })
  assert.equal(registered(fx, s.worktree), true)
  assert.equal(fx.backend.isAlive(s.handle), true)

  const r = pass(fx)
  const x = byLabel(r, 1)
  assert.equal(x.action, 'reclaimed', JSON.stringify(x))
  assert.equal(x.outcome, 'pr-pushed')
  assert.equal(x.kill.ok, true)
  assert.deepEqual(x.kill.survivors, [])
  assert.equal(x.removal.deregistered, true)
  assert.equal(x.folderRemains, false)

  assert.equal(fx.backend.isAlive(s.handle), false, 'the session was killed through the backend')
  assert.equal(registered(fx, s.worktree), false, 'verified against git worktree list, not the exit code')
  assert.equal(fs.existsSync(s.worktree), false, 'the folder is gone from disk')
  assert.equal(readSession('1', { stateDir: fx.stateDir }), null, 'the registry entry is gone')
  assert.equal(fs.existsSync(json), false, 'the flag is gone')
  assert.equal(fs.existsSync(txt), false, 'and so is its .txt twin')
  assert.deepEqual([fx.state.strikes, fx.state.reported], [{}, {}], 'the label is forgotten so a reused number can flag again')
  assert.ok(fx.logs.some(l => /reclaim: 1: reclaimed \(pr-pushed\)/.test(l)), fx.logs.join('\n'))
  // the primary checkout and the remote are untouched
  assert.equal(G(fx.primary, 'status', '--porcelain'), '')
  assert.ok(listRemoteBranches({ config: fx.config, primary: fx.primary }).includes(BRANCH))
})

test('observeWorktree reads a real tree: detached, clean despite the ready sentinel, and the close-out move from the reflog', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 2, { branch: BRANCH, closeOut: true })
  const entry = findWorktree(listWorktrees(fx.primary), s.worktree)
  const baseRefs = baseRefsOf({ config: fx.config, primary: fx.primary })
  assert.equal(baseRefs.length, 3, 'remote/base, base, and the commit it resolves to')
  const o = observeWorktree({ worktree: s.worktree, label: '2', descriptor: { branch: '' }, config: fx.config, entry, baseRefs })
  assert.equal(o.error, null)
  assert.equal(o.detached, true)
  assert.equal(o.clean, true, 'the ready sentinel is the launcher\'s file, not the session\'s work')
  assert.equal(o.readyFlag, true)
  assert.equal(o.binShims, 3)
  assert.equal(o.moves, 2)
  assert.deepEqual(o.closeOut, { from: BRANCH, to: 'origin/main' })
  assert.equal(o.sessionBranch, BRANCH, 'the reflog names the branch the descriptor never had')

  fs.writeFileSync(path.join(s.worktree, 'README.md'), 'edited\n')
  const dirty = observeWorktree({ worktree: s.worktree, label: '2', config: fx.config, entry, baseRefs })
  assert.deepEqual([dirty.clean, dirty.changes], [false, [' M README.md']])
})

// ---- each precondition refuses on a real repository --------------------------------------------

test('a flag over uncommitted work is refused on a real tree, and nothing is touched', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: true, dirty: true })
  writeDone(fx, 1, { outcome: 'pr-pushed' })
  const r = pass(fx)
  const x = byLabel(r, 1)
  assert.equal(x.action, 'refused')
  assert.deepEqual(codes(x), ['dirty'])
  assert.deepEqual(x.observed.changes, [' M README.md'])
  assert.equal(registered(fx, s.worktree), true)
  assert.equal(fx.backend.isAlive(s.handle), true)
  assert.equal(flagExists(fx, 1), true)
  assert.ok(fx.logs.some(l => /reclaim: 1: refused \(dirty\)/.test(l)))
})

test('a flag while the session branch is still checked out is refused', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: false })
  writeDone(fx, 1, { outcome: 'pr-pushed' })
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, codes(x)], ['refused', ['not-detached']])
  assert.match(x.refusals[0].reason, /on branch "ada\/abc-1234-fix-thing"/)
  assert.equal(x.observed.sessionBranch, BRANCH, 'the checked-out branch names the session branch, so no second refusal is invented')
  assert.equal(registered(fx, s.worktree), true)
})

test('pr-pushed with a branch the remote never received is refused by the remote, not by the flag', t => {
  // The flag says pushed; `git ls-remote --heads` from the primary says otherwise, and the remote wins.
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { branch: BRANCH, push: false, closeOut: true })
  writeDone(fx, 1, { outcome: 'pr-pushed' })
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, codes(x)], ['refused', ['branch-not-on-remote']])
  assert.equal(registered(fx, s.worktree), true)
  // …push it, and the same pass reclaims
  G(s.worktree, 'push', '-q', 'origin', BRANCH)
  assert.equal(byLabel(pass(fx), 1).action, 'reclaimed')
  assert.equal(registered(fx, s.worktree), false)
})

test('a remote lookup that FAILS refuses rather than deletes — and it runs from the primary, never from the worktree', t => {
  // A gate once read "ls-remote failed" as "branch not pushed" and refused forever; another shape of
  // the same bug would read it as "nothing to check" and delete. Neither: an unverifiable push is a
  // refusal with a reason, and the tree stays.
  const fx = makeRepo(t)
  fx.config.repo.remote = 'nowhere'
  const s = makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: true, descriptorBranch: BRANCH })
  writeDone(fx, 1, { outcome: 'pr-pushed' })
  const dirs = []
  const x = byLabel(pass(fx, { git: (dir, args, opts) => { dirs.push({ dir, args }); return gitExec(dir, args, opts) } }), 1)
  assert.deepEqual([x.action, codes(x)], ['refused', ['remote-unverified']])
  const lookup = dirs.find(c => c.args[0] === 'ls-remote')
  assert.ok(lookup, 'the remote was consulted')
  assert.ok(samePath(lookup.dir, fx.primary), 'from the primary checkout')
  assert.equal(registered(fx, s.worktree), true)
  assert.equal(listRemoteBranches({ config: fx.config, primary: fx.primary }), null)
})

test('an amended prescription is refused until the op-15 body patch is queued, then reclaimed', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 1)
  writeDone(fx, 1, { outcome: 'cancelled', reason: 'already fixed on the base branch', evidence: ['src/app.mjs:12'], prescription: 'amended', bodyPatched: false })
  const first = byLabel(pass(fx), 1)
  assert.deepEqual([first.action, codes(first)], ['refused', ['amended-unpatched']])
  assert.equal(registered(fx, s.worktree), true)

  // the session (or the launcher) queues the correction: `fleet outbox add --op op-15 --key ABC-1234 …`
  const outbox = stateLayout(fx.stateDir, process.platform).outbox
  fs.mkdirSync(outbox, { recursive: true })
  fs.writeFileSync(path.join(outbox, '20260314T100000000Z-1-000001.json'), JSON.stringify({ v: 1, n: 15, op: 'patchBody', key: KEY, args: { edits: [{ find: 'a', replace: 'b' }] } }))
  const second = byLabel(pass(fx), 1)
  assert.equal(second.action, 'reclaimed', JSON.stringify(second))
  assert.equal(registered(fx, s.worktree), false)
  assert.equal(flagExists(fx, 1), false)
})

test('a second session registered on the same worktree, or a stray process inside it, refuses the reclaim', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 1)
  // a relaunch that spawned beside the old agent: label 7, same tree
  makeSession(fx, 7, { worktree: s.worktree })
  writeDone(fx, 1, { outcome: 'cancelled', reason: 'already fixed', evidence: ['README.md:1'] })
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, codes(x)], ['refused', ['second-process']])
  assert.match(x.refusals[0].reason, /session 7/)
  assert.equal(registered(fx, s.worktree), true)
  assert.equal(fx.backend.isAlive(s.handle), true, 'nothing was killed')

  // …and with the sibling gone, a stray process whose command line names the tree still refuses
  fx.backend.kill(fx.backend.record('7').handle)
  fs.unlinkSync(path.join(stateLayout(fx.stateDir, process.platform).sessions, '7.json'))
  const stray = fx.backend.addChild(1, { cmd: `node build.mjs ${path.join(s.worktree, 'src', 'server')}` })
  const y = byLabel(pass(fx), 1)
  assert.deepEqual(codes(y), ['second-process'])
  assert.match(y.refusals[0].reason, new RegExp(`${stray}`))
  assert.equal(registered(fx, s.worktree), true)
})

test('a cancelled flag over local changes saves a patch FIRST, then reclaims — abandoned work is never deleted unsaved', t => {
  // That once preserved an hour of work a session had abandoned; and the alternative (refusing) was a
  // gate no finished session could ever satisfy. The patch is `git apply`-able: tracked diff plus a
  // creation hunk per untracked file, because a list of names would not bring the files back.
  const fx = makeRepo(t)
  const s = makeSession(fx, 3, { dirty: true, untracked: true })
  writeDone(fx, 3, { outcome: 'cancelled', reason: 'already fixed on the base branch', evidence: ['README.md:1'] })
  const x = byLabel(pass(fx), 3)
  assert.equal(x.action, 'reclaimed', JSON.stringify(x))
  assert.ok(x.patch, 'a patch was written')
  assert.equal(x.patch.file, wipPatchPath(fx.stateDir, '3', T0))
  assert.equal(path.dirname(x.patch.file), wipDir(fx.stateDir))
  assert.equal(x.patch.tracked, true)
  assert.deepEqual(x.patch.untracked, ['notes.md'], 'the ready sentinel is the launcher\'s file and is left out')
  const text = fs.readFileSync(x.patch.file, 'utf8')
  assert.match(text, /^# label: 3$/m)
  assert.match(text, /^# outcome: cancelled$/m)
  assert.match(text, /^\+edited but never committed$/m)
  assert.match(text, /^\+an hour of notes$/m)
  assert.match(text, /^--- \/dev\/null\n\+\+\+ b\/notes\.md$/m)
  // it applies onto the base the session started from
  const check = run('git', ['apply', '--check', x.patch.file], { cwd: fx.primary })
  assert.equal(check.ok, true, check.stderr)
  assert.equal(registered(fx, s.worktree), false)
  assert.equal(fs.existsSync(s.worktree), false)
  assert.ok(fx.logs.some(l => /saved \d+ bytes of uncommitted work/.test(l)))
  // a `pr-pushed` flag over the same dirt would have refused instead (asserted purely above); here the
  // patch is never written on a clean tree
  const clean = makeSession(fx, 4)
  writeDone(fx, 4, { outcome: 'duplicate', reason: 'shipped as https://github.com/acme/app/pull/1' })
  const y = byLabel(pass(fx), 4)
  assert.deepEqual([y.action, y.patch], ['reclaimed', null])
  assert.equal(fs.existsSync(clean.worktree), false)
})

test('saveWipPatch never touches refs/stash, and refuses a tree it cannot diff', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 5, { dirty: true })
  saveWipPatch({ stateDir: fx.stateDir, label: '5', worktree: s.worktree, config: fx.config, nowMs: T0 })
  assert.equal(run('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd: fx.primary }).ok, false, 'refs/stash is shared by every worktree; the patch is the tool')
  assert.equal(run('git', ['status', '--porcelain', '--', 'README.md'], { cwd: s.worktree }).stdout.trimEnd(), ' M README.md', 'read-only: the work is still in the tree')
  assert.throws(() => saveWipPatch({ stateDir: fx.stateDir, label: '5', worktree: path.join(fx.root, 'not-a-repo'), config: fx.config, nowMs: T0 }), /git diff failed/)
})

test('a kill that leaves a survivor FAILS the reclaim at the kill stage and keeps the flag, the tree and the registry entry', t => {
  // A kill aimed at a collection once reported success while doing nothing, and left a wedged agent
  // beside a fresh one in one tree. Survivors are re-queried, and a survivor is a failure — the
  // worktree is not removed under a process that is still in it.
  const fx = makeRepo(t)
  const s = makeSession(fx, 1)
  const child = fx.backend.addChild(s.handle, { cmd: `node dev-server.mjs ${s.worktree}` })
  injectFault(fx.backend, { killLeaves: s.handle })
  writeDone(fx, 1, { outcome: 'cancelled', reason: 'already fixed', evidence: ['README.md:1'] })
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, x.stage], ['failed', 'kill'], JSON.stringify(x))
  assert.deepEqual(x.kill.survivors, [child])
  assert.match(x.error, /1 process\(es\) survived the kill/)
  assert.equal(registered(fx, s.worktree), true, 'the worktree is not removed under a survivor')
  assert.equal(readSession('1', { stateDir: fx.stateDir }) !== null, true)
  assert.equal(flagExists(fx, 1), true, 'the flag is deleted LAST, so a failed teardown retries from the top')
  assert.ok(fx.logs.some(l => /FAILED at kill/.test(l)))
})

test('a worktree already deregistered resumes from the sweep — no git command runs inside the dead tree', t => {
  // `git worktree remove --force` routinely deregisters and then fails to delete; a retry says "is not a
  // working tree". And a remote-dependent git command inside a deregistered tree fails with "the remote
  // does not appear to be a git repository" — a gate once read that as "not pushed" and refused forever.
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: true })
  writeDone(fx, 1, { outcome: 'pr-pushed' })
  G(fx.primary, 'worktree', 'remove', '--force', s.worktree)
  fs.mkdirSync(path.join(s.worktree, 'node_modules', 'left-behind'), { recursive: true })
  fs.writeFileSync(path.join(s.worktree, 'node_modules', 'left-behind', 'index.js'), 'x')
  assert.equal(registered(fx, s.worktree), false)

  const dirs = []
  const x = byLabel(pass(fx, { git: (dir, args, opts) => { dirs.push(dir); return gitExec(dir, args, opts) } }), 1)
  assert.equal(x.action, 'reclaimed', JSON.stringify(x))
  assert.equal(x.removal, null, 'nothing to deregister')
  assert.equal(dirs.some(d => samePath(d, s.worktree)), false, 'no git inside the deregistered tree')
  assert.equal(fs.existsSync(s.worktree), false, 'the leftover folder was swept')
  assert.equal(readSession('1', { stateDir: fx.stateDir }), null)
  assert.equal(flagExists(fx, 1), false)
  assert.ok(fx.logs.some(l => /resuming from the sweep/.test(l)))
})

test('a degraded (empty) process snapshot refuses every flag and touches nothing', t => {
  // The cheap process listing returns nothing on a loaded box; acting on it would pass the
  // second-process check for every session at once.
  const fx = makeRepo(t)
  const s = makeSession(fx, 1)
  writeDone(fx, 1, { outcome: 'cancelled', reason: 'already fixed', evidence: ['README.md:1'] })
  const r = pass(fx, { snapshot: new Map() })
  assert.equal(r.degraded, true)
  assert.deepEqual(codes(byLabel(r, 1)), ['snapshot-degraded'])
  assert.equal(registered(fx, s.worktree), true)
  assert.equal(fx.backend.isAlive(s.handle), true)
  assert.equal(flagExists(fx, 1), true)
  assert.equal(r.results.filter(x => x.action === 'watching').length, 0, 'inference does not run blind either')
})

test('a testing slot is never reclaimed by the flag path, and a flag with no descriptor or a foreign worktree is refused', t => {
  const fx = makeRepo(t)
  const slot = makeSession(fx, 'testing', { role: 'testing', worktree: path.join(fx.root, 'app-testing') })
  writeDone(fx, 'testing', { outcome: 'pr-pushed' })
  writeDone(fx, 9, { outcome: 'cancelled' })
  // a descriptor pointing outside the worktree parent: right name, wrong place
  const foreign = makeSession(fx, 8, { worktree: path.join(fx.root, 'elsewhere', 'app-session-8') })
  writeDone(fx, 8, { outcome: 'cancelled' })
  const r = pass(fx)
  assert.deepEqual(codes(byLabel(r, 'testing')), ['testing-role'])
  assert.deepEqual(codes(byLabel(r, 9)), ['no-descriptor'])
  assert.deepEqual(codes(byLabel(r, 8)), ['bad-worktree'])
  assert.equal(registered(fx, slot.worktree), true)
  assert.equal(registered(fx, foreign.worktree), true)
  assert.equal(fx.backend.isAlive(slot.handle), true)
  // an unreadable flag is reported, not skipped: a flag nobody can read is a session nobody reclaims
  fs.writeFileSync(doneFlagPaths(fx.stateDir, 2).json, '{"v":1,')
  assert.deepEqual(codes(byLabel(pass(fx), 2)), ['unreadable-flag'])
})

test('a refusal is logged once, not every pass — and once the flag goes the label is forgotten, so a new flag is judged fresh', t => {
  // The reclaim log once showed the same three lines every fifteen seconds for hours; nobody reads a
  // log that repeats. But a watcher that remembered handled flags by label silently ignored the next
  // session to wear that number — so the memory lives exactly as long as the flag file.
  const fx = makeRepo(t)
  makeSession(fx, 1, { branch: BRANCH, push: true, closeOut: true, dirty: true })
  const { json, txt } = writeDone(fx, 1, { outcome: 'pr-pushed' })
  pass(fx)
  const after1 = fx.logs.filter(l => /refused \(dirty\)/.test(l)).length
  assert.equal(after1, 1)
  pass(fx)
  pass(fx)
  assert.equal(fx.logs.filter(l => /refused \(dirty\)/.test(l)).length, 1, 'the same refusal is not re-logged')
  assert.equal(fx.state.reported['1'], 'dirty')

  fs.unlinkSync(json)
  fs.unlinkSync(txt)
  pass(fx)
  assert.equal(fx.state.reported['1'], undefined, 'the flag is gone, so its label is forgotten')

  writeDone(fx, 1, { outcome: 'pr-pushed' })
  pass(fx)
  assert.equal(fx.logs.filter(l => /refused \(dirty\)/.test(l)).length, 2, 'the new flag is judged, and logged, afresh')
})

// ---- inference on a real repository ------------------------------------------------------------

test('inference: a crashed session that closed out is reclaimed after two strikes — from the reflog, never from a PR lookup', t => {
  const fx = makeRepo(t)
  // a real close-out that was never followed by a flag: the branch is not even pushed, and that is
  // fine — a finished session may have no PR; the reflog move is the signal
  const s = makeSession(fx, 1, { branch: BRANCH, push: false, closeOut: true })
  injectFault(fx.backend, { dies: s.handle })
  const calls = []
  const spy = { git: (dir, args, opts) => { calls.push(args[0]); return gitExec(dir, args, opts) } }

  const first = byLabel(pass(fx, spy), 1)
  assert.deepEqual([first.action, first.finished, first.arm, first.strikes], ['watching', true, 'reflog', 1], JSON.stringify(first))
  assert.equal(registered(fx, s.worktree), true, 'one strike does nothing')
  assert.ok(fx.logs.some(l => /looks finished by inference \(reflog: .*\) — strike 1 of 2/.test(l)))

  const second = byLabel(pass(fx, spy), 1)
  assert.deepEqual([second.action, second.arm], ['reclaimed', 'reflog'], JSON.stringify(second))
  assert.equal(second.kill.alreadyGone, true, 'a dead session has nothing to kill')
  assert.equal(registered(fx, s.worktree), false)
  assert.equal(fs.existsSync(s.worktree), false)
  assert.equal(readSession('1', { stateDir: fx.stateDir }), null)
  assert.equal(calls.includes('ls-remote'), false, 'inference never consults the remote or a PR list')
  assert.deepEqual(fx.state.strikes, {})
})

test('inference: never reclaims a worktree that is still installing, however long it has been dead', t => {
  // A fresh worktree is detached, clean and branch-less until its install finishes — by git state
  // alone identical to a finished one — and under wave pacing that install may not have STARTED for
  // most of an hour.
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { ready: false, shims: 0, extra: { deadAt: new Date(T0 - 3 * HOUR).toISOString() } })
  injectFault(fx.backend, { dies: s.handle })
  for (let i = 0; i < 3; i++) {
    const x = byLabel(pass(fx), 1)
    assert.deepEqual([x.action, x.finished], ['watching', false])
    assert.match(x.reason, /still installing: the ready flag is absent/)
  }
  // the ready flag lands but the shim directory is still empty: the install is not finished either
  fs.writeFileSync(path.join(s.worktree, fx.config.install.readyFlag), '{"v":1}\n')
  const x = byLabel(pass(fx), 1)
  assert.match(x.reason, /still installing: node_modules has no shims/)
  assert.equal(registered(fx, s.worktree), true)
  assert.deepEqual(fx.state.strikes, {}, 'no strike accumulates while installing')
})

test('inference: never fires on a live session, and the never-branched arm needs a long dead idle', t => {
  const fx = makeRepo(t)
  const live = makeSession(fx, 1, { branch: BRANCH, closeOut: true })
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, x.finished], ['watching', false])
  assert.match(x.reason, /the session is alive/)
  assert.equal(registered(fx, live.worktree), true)

  // a session cancelled before it ever branched: installed, dead, but only recently
  const idle = makeSession(fx, 2, { extra: { deadAt: new Date(T0 - 5 * 60_000).toISOString() } })
  injectFault(fx.backend, { dies: idle.handle })
  const recent = byLabel(pass(fx), 2)
  assert.match(recent.reason, /never branched and idle 5 min/)
  // …and once it has sat dead past the idle, two strikes reclaim it
  writeSession({ ...readSession('2', { stateDir: fx.stateDir }), deadAt: new Date(T0 - 45 * 60_000).toISOString() }, { stateDir: fx.stateDir })
  assert.deepEqual([byLabel(pass(fx), 2).finished, byLabel(pass(fx), 2).action], [true, 'reclaimed'])
  assert.equal(registered(fx, idle.worktree), false)
  assert.equal(registered(fx, live.worktree), true, 'the live sibling is untouched')
})

test('inference refuses a second process in the tree even when the arms agree, and remembers that under its own key', t => {
  const fx = makeRepo(t)
  const s = makeSession(fx, 1, { branch: BRANCH, closeOut: true })
  injectFault(fx.backend, { dies: s.handle })
  // a path INSIDE the tree: sys/proc.inDirectory matches `<dir>/…` (boundary-safe), so a command line
  // naming the bare root as an argument is not "inside" it — see the notes
  fx.backend.addChild(1, { cmd: `node build.mjs ${path.join(s.worktree, 'src', 'server')}` })
  pass(fx)
  const x = byLabel(pass(fx), 1)
  assert.deepEqual([x.action, codes(x), x.arm], ['refused', ['second-process'], 'reflog'])
  assert.equal(fx.state.reported[`${INFER_KEY}1`], 'second-process')
  assert.equal(fx.state.reported['1'], undefined, 'a later done flag for label 1 is judged fresh')
  assert.equal(registered(fx, s.worktree), true)
})

test('sweepFolder reports the filesystem, never the absence of an error', t => {
  const root = tmp()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'app-session-1')
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
  // a link inside the tree is unlinked, never followed into its target
  const target = path.join(root, 'primary-package')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.js'), 'the primary\'s file')
  let linked = true
  try {
    fs.symlinkSync(target, path.join(dir, 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    linked = false
  }
  assert.deepEqual(sweepFolder(dir), { existed: true, remains: false, empty: true, error: null })
  assert.equal(fs.existsSync(path.join(target, 'keep.js')), true, linked ? 'the junction target survives' : '(no link could be made)')
  assert.deepEqual(sweepFolder(dir), { existed: false, remains: false, empty: true, error: null })
})

test('reclaimOnce refuses to run without its inputs — a missing snapshot or backend is an error, not an empty pass', t => {
  const fx = makeRepo(t)
  const base = { stateDir: fx.stateDir, backend: fx.backend, config: fx.config, primary: fx.primary, snapshot: fx.backend.processes() }
  assert.throws(() => reclaimOnce({ ...base, snapshot: undefined }), /process snapshot .* take it once per pass/)
  assert.throws(() => reclaimOnce({ ...base, backend: {} }), /backend with kill\(\)/)
  assert.throws(() => reclaimOnce({ ...base, stateDir: '' }), /stateDir is required/)
  assert.throws(() => reclaimOnce({ ...base, primary: '' }), /primary is required/)
  assert.deepEqual(reclaimOnce(base).results, [], 'an empty fleet is an empty pass')
  assert.equal(listSessions({ stateDir: fx.stateDir }).length, 0)
})
