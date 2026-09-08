// `fleet check …` end to end, on a throwaway repo: plan → worklist → slice → brief → ledger → resume.
//
// The pure modules under src/check/ are covered one incident at a time by their own suites. What this
// file covers is the wiring — that the CLI reads the manifest back, that a re-run resumes instead of
// planning a second sweep over the same input, that the worklist is refused a second write, and that
// the counts an operator actually sees come from the files on disk.
//
// Nothing is faked but the tracker: `git init` is 50 ms and a real repo catches what a stub cannot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { run as exec } from '../src/sys/exec.mjs'
import { main } from '../src/cli.mjs'
import { readRows } from '../src/sys/tsv.mjs'

function tmpRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-check-')))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* a shell may still hold a cwd inside it; the temp dir is not the test's subject */ }
  })
  return dir
}

const git = (cwd, args) => {
  const r = exec('git', args, { cwd })
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/**
 * A repo whose config reaches status `ok` with NO tracker: the sweep spine is the same either way,
 * and tracker-less mode is the variant a contributor can actually run.
 */
function makeRepo(t) {
  const parent = tmpRoot(t)
  const repo = path.join(parent, 'app')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
  writeJson(path.join(repo, 'package.json'), { name: 'app', scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' } })
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  writeJson(path.join(repo, '.fleet', 'config.json'), {
    version: 1,
    commands: { bootstrap: 'npm run worktree-setup', devServer: 'npm run dev' },
    tracker: { mode: 'none' },
    checker: { triage: { label: 'triage' } },
  })
  const stateRoot = path.join(parent, 'state')
  return {
    repo,
    env: { FLEET_CONFIG_HOME: path.join(parent, 'user-config'), LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  }
}

async function cli(argv, fx) {
  const out = []
  const err = []
  const code = await main(argv, { stdout: s => out.push(s), stderr: s => err.push(s), cwd: fx.repo, env: fx.env })
  const stdout = out.join('')
  return { code, stdout, stderr: err.join(''), payload: argv.includes('--json') && stdout.trim() ? JSON.parse(stdout) : null }
}

test('fleet check plan writes the sweep, and re-running the same command RESUMES it', async t => {
  const fx = makeRepo(t)

  const first = await cli(['check', 'plan', '1712', '1719', '--json'], fx)
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.payload.ok, true)
  assert.match(first.payload.sweepId, /^prs-[0-9a-f]{8}$/, 'a PR set is identified by the hash of the set, so the same set is the same sweep')
  assert.equal(first.payload.created, true)
  assert.ok(fs.existsSync(first.payload.manifestFile))
  assert.ok(fs.existsSync(first.payload.resumeFile), 'RESUME.md is what a fresh session with no context reads first')

  // ⛔ The whole point of a derived sweepId: retyping the line that started a crashed sweep continues
  // it. Planning a second time must NOT mint a second sweep over the same PRs.
  const again = await cli(['check', 'plan', '1712', '1719', '--json'], fx)
  assert.equal(again.code, 0, again.stderr)
  assert.equal(again.payload.sweepId, first.payload.sweepId)
  assert.equal(again.payload.created, false)
  assert.equal(again.payload.resume, true)

  // The PR order must not change the identity either — the same set is the same sweep.
  const reordered = await cli(['check', 'plan', '1719', '1712', '--json'], fx)
  assert.equal(reordered.payload.sweepId, first.payload.sweepId)

  const listed = await cli(['check', 'status', '--json'], fx)
  assert.deepEqual(listed.payload.sweeps.map(s => s.sweepId), [first.payload.sweepId])
})

test('the worklist is written once, and every count is measured against it', async t => {
  const fx = makeRepo(t)
  const planned = await cli(['check', 'plan', '1712', '1719', '1730', '--json'], fx)
  const id = planned.payload.sweepId

  // Before there is a worklist there is no denominator, and every verb that needs one says so
  // rather than reporting 0 of 0.
  // 1, not 2: the command was typed correctly and the sweep's state refused it. A usage error (2) is
  // the operator's mistake to fix; this one is answered by running the next command.
  // A --json refusal is the payload's `error` on stdout, not stderr: a caller that parses one stream
  // must not have to watch the other to find out that the command failed.
  const early = await cli(['check', 'resume', id, '--json'], fx)
  assert.equal(early.code, 1)
  assert.match(early.payload.error.message, /no denominator yet/)

  const items = path.join(fx.repo, 'items.json')
  fs.writeFileSync(items, JSON.stringify({
    body: ['- [ ] #1712 fix the thing', '- [x] #1719 already swept', '- [ ] #1730 another'].join('\n'),
  }))
  const wrote = await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)
  assert.equal(wrote.code, 0, wrote.stderr)
  assert.equal(wrote.payload.rows, 2, 'a ticked item is already swept; re-filing it would file it twice')
  assert.equal(wrote.payload.ticked, 1)

  // ⛔ Written once. A second write is refused rather than merged: it is the denominator of every
  // count, and a sweep that re-derives it compares this wave's numerator against next wave's bottom.
  const second = await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)
  assert.equal(second.code, 1)
  assert.match(second.payload.error.message, /written once and never re-derived/)

  const counts = await cli(['check', 'resume', id, '--json'], fx)
  assert.deepEqual(
    { worklist: counts.payload.worklist, done: counts.payload.done, remaining: counts.payload.remaining },
    { worklist: 2, done: 0, remaining: 2 },
  )
})

test('a ledger line is what makes a PR done, and the slice is cut from what is LEFT', async t => {
  const fx = makeRepo(t)
  const id = (await cli(['check', 'plan', '1712', '1719', '--json'], fx)).payload.sweepId
  const items = path.join(fx.repo, 'items.json')
  fs.writeFileSync(items, JSON.stringify({ items: [{ pr: 1712, title: 'a' }, { pr: '#1719', title: 'b' }] }))
  await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)

  const before = await cli(['check', 'slice', id, '--json'], fx)
  assert.deepEqual(before.payload.next.prs, ['1712', '1719'])

  // `filed` with no keys records that something was filed without recording what.
  const noKeys = await cli(['check', 'ledger', 'append', '1712', 'filed', id, '--json'], fx)
  assert.equal(noKeys.code, 2, 'a malformed invocation is a usage error')
  assert.match(noKeys.payload.error.message, /without recording what/)

  const appended = await cli(['check', 'ledger', 'append', '1712', 'filed', id, '--keys', 'ABC-1,ABC-2', '--json'], fx)
  assert.equal(appended.code, 0, appended.stderr)
  const sweepDir = (await cli(['check', 'status', id, '--json'], fx)).payload.dir
  const ledger = readRows(path.join(sweepDir, 'ledger.tsv'))
  assert.equal(ledger.length, 1)
  assert.deepEqual(ledger[0].slice(0, 3), ['1712', 'filed', 'ABC-1,ABC-2'])

  // ⛔ Cut from what is left. A resumed sweep that re-slices the original list hands the next wave a
  // PR whose outcome is already on disk, and files it twice.
  const after = await cli(['check', 'slice', id, '--json'], fx)
  assert.deepEqual(after.payload.next.prs, ['1719'])
  assert.equal((await cli(['check', 'resume', id, '--json'], fx)).payload.done, 1)

  // The brief a worker gets names the slice it was rendered for and the PR it is about, and it comes
  // from the same slicing as the work — a brief that disagreed would send a worker to the wrong PR.
  const brief = await cli(['check', 'brief', id, '--json'], fx)
  assert.equal(brief.code, 0, brief.stderr)
  assert.deepEqual(brief.payload.prs, ['1719'])
  assert.match(brief.payload.brief, /1719/)

  // `failed` is an outcome like any other: a wave that swallows its failures reports a clean sweep
  // over a corpus it never looked at.
  assert.equal((await cli(['check', 'ledger', 'append', '1719', 'failed', id, '--note', 'gh timed out', '--json'], fx)).code, 0)
  const done = await cli(['check', 'ledger', 'resume', id, '--json'], fx)
  assert.equal(done.payload.remaining, 0)
  assert.deepEqual(done.payload.byStatus, { filed: 1, clean: 0, skipped: 0, failed: 1 })
})

test('fleet check refuses what it cannot do BY NAME, and never invents a sweep dir', async t => {
  const fx = makeRepo(t)

  // A verb contract §7 defines but this build does not wire says which, and what it is waiting on. A
  // CLI that accepted it and did nothing would leave a sweep looking reconciled.
  const notYet = await cli(['cloud', 'dispatch'], fx)
  assert.equal(notYet.code, 1)
  assert.match(notYet.stderr, /defined in contract §7 but is not wired/)

  const unknown = await cli(['check', 'frobnicate'], fx)
  assert.equal(unknown.code, 2, 'an unknown verb is a usage error')
  assert.match(unknown.stderr, /unknown verb/)

  // ⛔ Only `plan` creates a sweep. Every other verb refuses an id it has never seen rather than
  // making an empty one — an invented manifest would re-run the location ops against a sweep that
  // already has a group, and split one sweep across two.
  const missing = await cli(['check', 'resume', 'prs-deadbeef'], fx)
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /no sweep "prs-deadbeef"/)

  // A sweep id names a directory. One with a separator would escape the sweeps tree.
  const escape = await cli(['check', 'resume', '../../etc'], fx)
  assert.equal(escape.code, 2)
  assert.match(escape.stderr, /plain directory name/)
})

/** A sweep with its worklist, one filed slice and an audit verdict file — the gate's input. */
async function gatedSweep(t, verdictRows) {
  const fx = makeRepo(t)
  const id = (await cli(['check', 'plan', '1712', '--json'], fx)).payload.sweepId
  const items = path.join(fx.repo, 'items.json')
  fs.writeFileSync(items, JSON.stringify({ items: [{ pr: 1712, title: 'a' }] }))
  await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)
  const dir = (await cli(['check', 'status', id, '--json'], fx)).payload.dir
  // fid → key → url → pr → priority → a11y
  fs.writeFileSync(path.join(dir, 'filed', 'a01.tsv'), [
    ['a01|1712|1', 'ABC-1', 'http://x/1', '1712', '2', 'none'].join('\t'),
    ['a01|1712|2', 'ABC-2', 'http://x/2', '1712', '4', 'none'].join('\t'),
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'audit', 'verdicts.tsv'), verdictRows.map(r => r.join('\t')).join('\n') + '\n')
  return { fx, id, dir }
}

test('the gate refuses to apply a corpus it has not finished scoring', async t => {
  // fid, key, diagnosis, severity, fixAxis, gate, auditRunId, evidence
  const { fx, id } = await gatedSweep(t, [
    ['a01|1712|1', 'ABC-1', 'real', 'confirmed', 'verified', 'pending', 'run-1', ''],
    ['a01|1712|2', 'ABC-2', 'real', 'confirmed', 'untested', 'pending', 'run-1', ''],
  ])

  // ⛔ A partly-scored corpus applied to the tracker labels every unscored row `pending`, which reads
  // to the next person as "the audit says wait" when the audit never looked.
  const applied = await cli(['check', 'gate', 'apply', id, '--json'], fx)
  assert.equal(applied.code, 1)
  assert.match(applied.payload.error.message, /have no fix-axis score/)
  assert.match(applied.payload.error.message, /a01\|1712\|2/)

  const status = await cli(['check', 'gate', 'status', id, '--json'], fx)
  assert.equal(status.code, 1, 'status exits non-zero while the gate is incomplete, so a script can branch on it')
  assert.equal(status.payload.complete, false)
  assert.deepEqual(status.payload.untested, ['a01|1712|2'])
})

test('the gate explains before it cancels, and promotion is a decision with no default', async t => {
  const { fx, id } = await gatedSweep(t, [
    ['a01|1712|1', 'ABC-1', 'real', 'confirmed', 'verified', 'pending', 'run-1', ''],
    ['a01|1712|2', 'ABC-2', 'false_positive', 'n/a', 'absent', 'pending', 'run-1', 'the guard is three lines above'],
  ])
  const applied = await cli(['check', 'gate', 'apply', id, '--json'], fx)
  assert.equal(applied.code, 0, JSON.stringify(applied.payload && applied.payload.error))
  assert.deepEqual(applied.payload.counts.passed, 1)
  assert.deepEqual(applied.payload.counts.failed, 1)

  // ⛔ The evidence comment precedes the cancellation it explains: a drain that cancelled first would
  // leave a reader a closed ticket with no reason on it.
  const forFailed = applied.payload.enqueued.filter(e => e.key === 'ABC-2').map(e => e.op)
  assert.deepEqual(forFailed, ['comment', 'updateIssue', 'cancel'])

  // Promoting is a decision about which tickets a fleet session may pick up, so there is no default.
  const noSelection = await cli(['check', 'promote', id, '--json'], fx)
  assert.equal(noSelection.code, 2)
  assert.match(noSelection.payload.error.message, /--all, --fid … or --min-priority N/)

  const promoted = await cli(['check', 'promote', id, '--all', '--json'], fx)
  assert.equal(promoted.code, 0)
  assert.equal(promoted.payload.promoted, 1, 'only the row that passed moves')
  assert.deepEqual(promoted.payload.refused.map(r => r.key), ['ABC-2'])

  // Priority 1 is Urgent, so "at least this important" is a numerically SMALLER band: ABC-1 is a 2.
  const byBand = await cli(['check', 'promote', id, '--min-priority', '1', '--json'], fx)
  assert.equal(byBand.payload.selected, 0, 'a High (2) is not selected by --min-priority 1')
  assert.equal((await cli(['check', 'promote', id, '--min-priority', '2', '--json'], fx)).payload.promoted, 1)
})

test('enum check names the values outside the domain, and refuses to pass over no rows', async t => {
  const fx = makeRepo(t)
  const file = path.join(fx.repo, 'verdicts.tsv')

  // ⛔ An empty corpus passes every check vacuously, which is the one answer that must never read as
  // a pass — a mistyped path would otherwise certify a file nobody looked at.
  fs.writeFileSync(file, '')
  const empty = await cli(['check', 'enum', 'check', file, '--col', '3', '--domain', 'real,uncertain', '--json'], fx)
  assert.equal(empty.code, 1)
  assert.match(empty.payload.error.message, /is empty or absent/)

  fs.writeFileSync(file, ['a\tABC-1\treal', 'b\tABC-2\tReal', 'c\tABC-3\tuncertain'].join('\n') + '\n')
  const bad = await cli(['check', 'enum', 'check', file, '--col', '3', '--domain', 'real,uncertain', '--json'], fx)
  assert.equal(bad.code, 1)
  assert.deepEqual(bad.payload.bad, ['Real'], 'a single misspelled value drops a row out of every band and the tally still adds up')

  fs.writeFileSync(file, ['a\tABC-1\treal', 'c\tABC-3\tuncertain'].join('\n') + '\n')
  assert.equal((await cli(['check', 'enum', 'check', file, '--col', '3', '--domain', 'real,uncertain', '--json'], fx)).code, 0)
})

test('finish refuses a sweep with a PR that has no outcome, and repairs the ledger FROM the findings', async t => {
  const fx = makeRepo(t)
  const id = (await cli(['check', 'plan', '1712', '1719', '--json'], fx)).payload.sweepId
  const items = path.join(fx.repo, 'items.json')
  fs.writeFileSync(items, JSON.stringify({ items: [{ pr: 1712 }, { pr: 1719 }] }))
  await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)
  const dir = (await cli(['check', 'status', id, '--json'], fx)).payload.dir

  // Neither PR has a ledger line: one is genuinely unswept, the other filed but its write was lost.
  fs.writeFileSync(path.join(dir, 'findings', 'a01.jsonl'), JSON.stringify({ fid: 'a01|1712|1', key: 'ABC-1', pr: '1712', slice: 'a01' }) + '\n')
  fs.writeFileSync(path.join(dir, 'filed', 'a01.tsv'), ['a01|1712|1', 'ABC-1', 'http://x/1', '1712', '2', 'none'].join('\t') + '\n')

  const first = await cli(['check', 'finish', id, '--json'], fx)
  assert.equal(first.code, 1, 'a PR with no outcome on disk means the sweep is not finished')
  // ⛔ The ledger is repaired FROM the findings, never the other way: a findings row proves an
  // outcome, while a missing ledger line only proves a missed write.
  assert.equal(first.payload.repairedFromFindings, 1)
  // The repair moved 1712 to done; 1719 is genuinely unswept and is what holds the sweep open.
  assert.equal(first.payload.done, 1)
  assert.equal(first.payload.remaining, 1)
  assert.match(first.payload.error.message, /1719/)

  // Finishing the last PR finishes the sweep — and it says the audit is still owed rather than
  // reporting "done", because the audit ALWAYS follows a sweep.
  await cli(['check', 'ledger', 'append', '1719', 'clean', id, '--json'], fx)
  const done = await cli(['check', 'finish', id, '--json'], fx)
  assert.equal(done.code, 0, JSON.stringify(done.payload && done.payload.error))
  assert.equal(done.payload.remaining, 0)
  assert.deepEqual(done.payload.byStatus, { filed: 1, clean: 1, skipped: 0, failed: 0 })
  assert.equal(done.payload.auditOwed, true)
  assert.match(done.payload.next, /audit always follows/)

  // The manifest carries the outcome, and the per-slice findings are consolidated once, at the end.
  const status = await cli(['check', 'status', id, '--json'], fx)
  assert.equal(status.payload.status, 'complete')
  assert.equal(status.payload.counts.filed, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8').trim().split('\n').length, 1)
})

test('tick plan derives the ticks from the LEDGER, and refuses a lock it could not hold', async t => {
  const parent = tmpRoot(t)
  const repo = path.join(parent, 'app')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
  writeJson(path.join(repo, 'package.json'), { name: 'app', scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' } })
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  writeJson(path.join(repo, '.fleet', 'config.json'), {
    version: 1,
    commands: { bootstrap: 'npm run worktree-setup', devServer: 'npm run dev' },
    tracker: { id: 'linear', scope: 'ABC', states: { 'in-progress': 'In Progress', 'in-review': 'In Review', cancelled: 'Canceled' } },
    checker: { ready: { state: 'Todo' }, triage: { label: 'triage' } },
  })
  const stateRoot = path.join(parent, 'state')
  const fx = { repo, env: { FLEET_CONFIG_HOME: path.join(parent, 'user-config'), LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot } }

  // A tracker-issue sweep: the work-list issue IS the mirror target.
  const planned = await cli(['check', 'plan', 'ABC-1234', '--json'], fx)
  assert.equal(planned.code, 0, JSON.stringify(planned.payload && planned.payload.error))
  assert.equal(planned.payload.sweepId, 'ABC-1234')

  const items = path.join(repo, 'items.json')
  const body = ['- [ ] #1712 fix the thing', '- [ ] #1719 another'].join('\n')
  fs.writeFileSync(items, JSON.stringify({ body }))
  await cli(['check', 'worklist', 'write', 'ABC-1234', '--items-json', items, '--json'], fx)
  await cli(['check', 'ledger', 'append', '1712', 'filed', 'ABC-1234', '--keys', 'ABC-9', '--json'], fx)

  const plan = await cli(['check', 'tick', 'plan', 'ABC-1234', '--items-json', items, '--json'], fx)
  assert.equal(plan.code, 0, JSON.stringify(plan.payload && plan.payload.error))
  // ⛔ Derived from the ledger, not from the tracker: 1712 has an outcome on disk and 1719 does not.
  assert.equal(plan.payload.owed, 1)
  assert.equal(plan.payload.calls.length, 1)
  assert.equal(plan.payload.calls[0].args.edits.length, 1)
  assert.deepEqual(plan.payload.mirrored, [])

  // ⛔ A lock taken and released inside one CLI invocation protects nothing, because the tick is
  // applied by the model AFTER this process exits. Refused, with the invocation that does work.
  const locked = await cli(['check', 'tick', 'plan', 'ABC-1234', '--items-json', items, '--lock', '--json'], fx)
  assert.equal(locked.code, 2)
  assert.match(locked.payload.error.message, /release it before the tick is applied/)
  assert.match(locked.payload.error.hint, /fleet pool acquire tracker-worklist:ABC-1234 --once/)

  // A PR-set sweep has no checklist to mirror at all, and says so rather than planning empty ticks.
  const prSweep = (await cli(['check', 'plan', '2001', '--json'], fx)).payload.sweepId
  const noMirror = await cli(['check', 'tick', 'plan', prSweep, '--items-json', items, '--json'], fx)
  assert.equal(noMirror.code, 1)
  assert.match(noMirror.payload.error.message, /no checklist to mirror/)
})

test('verify-citations checks an audit against a real ref, and leads with its control', async t => {
  const fx = makeRepo(t)
  fs.mkdirSync(path.join(fx.repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(fx.repo, 'src', 'thing.mjs'), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n')
  git(fx.repo, ['add', '-A'])
  git(fx.repo, ['commit', '-q', '-m', 'add thing'])
  // No remote to fetch, so the check runs against the local base branch by name.
  const corpus = path.join(fx.repo, 'verdicts.tsv')
  fs.writeFileSync(corpus, [
    'a\tABC-1\treal\tconfirmed\tverified\tpending\trun-1\tthe guard is at src/thing.mjs:4',
    'b\tABC-2\treal\tconfirmed\tverified\tpending\trun-1\tand the other at src/thing.mjs:900',
    'c\tABC-3\treal\tconfirmed\tverified\tpending\trun-1\tsee also src/gone.mjs:1',
  ].join('\n') + '\n')

  const r = await cli(['check', 'verify-citations', '--corpus', corpus, '--ref', 'main', '--json'], fx)
  assert.equal(r.code, 1, 'a citation past the end of the file is a citation to nothing')
  // ⛔ The control leads, and it covers all three directions on this very tree.
  assert.equal(r.payload.control.ok, true)
  assert.equal(r.payload.control.goodPassed, true)
  assert.equal(r.payload.control.badFlagged, true)
  assert.equal(r.payload.control.phantomAbsent, true)

  assert.equal(r.payload.citations, 3)
  assert.equal(r.payload.testable, 2, 'src/gone.mjs is not in the tree, so nothing can be asserted about it')
  assert.equal(r.payload.resolved, 1)
  assert.deepEqual(r.payload.failures.map(f => f.raw), ['src/thing.mjs:900'])
  assert.equal(r.payload.absent, 1)

  // verify-paths reports misses without failing: on a PR sweep most are legitimately branch files.
  const paths = await cli(['check', 'verify-paths', '--corpus', corpus, '--ref', 'main', '--json'], fx)
  assert.equal(paths.code, 0)
  assert.equal(paths.payload.exact, 1)
  assert.deepEqual(paths.payload.missing, ['src/gone.mjs'])

  // ⛔ A ref the clone has never seen must refuse, not report zero: an empty tree would call every
  // citation in the corpus a phantom.
  const badRef = await cli(['check', 'verify-citations', '--corpus', corpus, '--ref', 'origin/nope', '--json'], fx)
  assert.equal(badRef.code, 1)
  assert.match(badRef.payload.error.message, /git ls-tree/)
})

test('the frame refuses a page set that is short, before anything is subtracted from it', async t => {
  const parent = tmpRoot(t)
  const repo = path.join(parent, 'app')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
  writeJson(path.join(repo, 'package.json'), { name: 'app', scripts: { dev: 'node server.mjs', 'worktree-setup': 'npm ci' } })
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  writeJson(path.join(repo, '.fleet', 'config.json'), {
    version: 1,
    commands: { bootstrap: 'npm run worktree-setup', devServer: 'npm run dev' },
    tracker: { id: 'linear', scope: 'ABC', states: { 'in-progress': 'In Progress', 'in-review': 'In Review', cancelled: 'Canceled' } },
    checker: { ready: { state: 'Todo' }, triage: { label: 'triage' } },
  })
  const stateRoot = path.join(parent, 'state')
  const fx = { repo, env: { FLEET_CONFIG_HOME: path.join(parent, 'user-config'), LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot } }
  const id = (await cli(['check', 'plan', 'ABC-1234', '--json'], fx)).payload.sweepId
  const dir = (await cli(['check', 'status', id, '--json'], fx)).payload.dir
  const pages = path.join(repo, 'pages.json')
  const page = (priority, issues, limit, complete) => ({ priority, limit, complete, issues })

  // ⛔ A page returning exactly its limit with no completeness signal is truncated BY DEFINITION.
  // The incident is a phantom band: an "Urgent" tally computed against a page that had silently
  // stopped at its limit, so the audit reported a frame it had never seen the end of.
  fs.writeFileSync(pages, JSON.stringify([
    page(1, [{ key: 'ABC-1', description: '**PR:** #1712' }, { key: 'ABC-2', description: '**PR:** #1712' }], 2, undefined),
    page(2, [], 50, true), page(3, [], 50, true), page(4, [], 50, true),
  ]))
  const short = await cli(['check', 'frame', 'derive', id, '--pages', pages, '--json'], fx)
  assert.equal(short.code, 1)
  assert.match(short.payload.error.message, /not a complete set/)

  // A band that was never queried is as absent from the filed set as a truncated one.
  fs.writeFileSync(pages, JSON.stringify([page(1, [{ key: 'ABC-1', description: '**PR:** #1712' }], 50, true)]))
  const missingBand = await cli(['check', 'frame', 'derive', id, '--pages', pages, '--json'], fx)
  assert.equal(missingBand.code, 1)
  assert.match(missingBand.payload.error.message, /never queried/)

  // A complete set derives, and attributes each issue to its PR on the header line — never the title.
  fs.writeFileSync(pages, JSON.stringify([
    page(1, [{ key: 'ABC-1', description: '**PR:** #1712' }], 50, true),
    page(2, [{ key: 'ABC-2', description: '**PR:** #1719' }, { key: 'ABC-3', description: 'no header line here' }], 50, true),
    page(3, [], 50, true), page(4, [], 50, true),
  ]))
  const derived = await cli(['check', 'frame', 'derive', id, '--pages', pages, '--json'], fx)
  assert.equal(derived.code, 0, JSON.stringify(derived.payload && derived.payload.error))
  assert.equal(derived.payload.derived, 3)
  assert.deepEqual(derived.payload.byPr, { 1712: ['ABC-1'], 1719: ['ABC-2'] })
  assert.deepEqual(derived.payload.unattributed.map(u => u.key), ['ABC-3'])

  // `frame check` subtracts what was judged from the frame: ABC-3 was never gated.
  fs.writeFileSync(path.join(dir, 'audit', 'verdicts.tsv'), [
    ['a', 'ABC-1', 'real', 'confirmed', 'verified', 'passed', 'run-1', ''].join('\t'),
    ['b', 'ABC-2', 'real', 'confirmed', 'verified', 'passed', 'run-1', ''].join('\t'),
  ].join('\n') + '\n')
  const checked = await cli(['check', 'frame', 'check', id, '--pages', pages, '--json'], fx)
  assert.equal(checked.code, 1)
  assert.deepEqual(checked.payload.missing, ['ABC-3'])
  assert.deepEqual(checked.payload.extra, [])
})

test('fleet trackers answers before a repo is configured, and lists a broken adapter with its error', async t => {
  const parent = tmpRoot(t)
  const repo = path.join(parent, 'app')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'Ada Lovelace'])
  git(repo, ['config', 'user.email', 'ada@example.com'])
  const fx = { repo, env: { FLEET_CONFIG_HOME: path.join(parent, 'user-config'), LOCALAPPDATA: path.join(parent, 'state'), XDG_STATE_HOME: path.join(parent, 'state') } }

  // ⛔ No .fleet/config.json at all. The wizard runs this BEFORE a repo is configured — that is the
  // whole point — so a listing that needed a valid config could never answer the question that leads
  // to one.
  const list = await cli(['trackers', 'list', '--json'], fx)
  assert.equal(list.code, 0, list.stderr)
  const ids = list.payload.trackers.map(t => t.id)
  assert.deepEqual(ids, ['asana', 'github', 'jira', 'linear', 'trello'])
  assert.ok(list.payload.trackers.every(t => t.ok), 'every bundled adapter must validate')

  // `show` carries the connection instructions verbatim: adding a tracker adds its own, and the
  // wizard renders them without anyone editing the wizard.
  const show = await cli(['trackers', 'show', 'linear', '--json'], fx)
  assert.equal(show.code, 0)
  assert.equal(show.payload.issueKey.pattern, '[A-Z][A-Z0-9]+-[0-9]+')
  assert.ok(show.payload.install.length >= 1)
  assert.ok(show.payload.install[0].label, 'an install step is {label, command?, instructions?} — never stringified into the output')

  assert.equal((await cli(['trackers', 'show', 'nope'], fx)).code, 1)
  assert.equal((await cli(['trackers'], fx)).code, 2, 'no verb is a usage error')

  // ⛔ A malformed project adapter is LISTED with its error, not omitted. Omitting it answers "that
  // tracker is not supported" to someone who is looking at the file they just wrote — and the
  // overlay is found by walking up from the cwd, because there is no config to read it out of yet.
  writeJson(path.join(repo, 'package.json'), { name: 'app' })
  fs.mkdirSync(path.join(repo, '.fleet', 'trackers'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.fleet', 'trackers', 'homegrown.md'), ['---', 'id: homegrown', '---', '', '# nothing else', ''].join('\n'))
  const withOverlay = await cli(['trackers', 'list', '--json'], fx)
  const mine = withOverlay.payload.trackers.find(t => t.id === 'homegrown')
  assert.ok(mine, 'a project adapter must be visible before the repo is configured')
  assert.equal(mine.ok, false)
  assert.ok(mine.problems.length, 'and it must carry the reason it is not usable')
})

test('fleet cloud dispatch refuses by name instead of reaching "unknown command"', async t => {
  const fx = makeRepo(t)
  const r = await cli(['cloud', 'dispatch', '--json'], fx)
  assert.equal(r.code, 1)
  // Being told the verb does not exist, while the reference says it does, sends an operator looking
  // for a typo in their own invocation.
  assert.match(r.payload.error.message, /defined in contract §7 but is not wired/)
  assert.match(r.payload.error.hint, /mode local/)
})

test('audit plan runs only on a FINISHED corpus, and refuses a second run over it', async t => {
  const fx = makeRepo(t)
  const id = (await cli(['check', 'plan', '1712', '--json'], fx)).payload.sweepId
  const items = path.join(fx.repo, 'items.json')
  fs.writeFileSync(items, JSON.stringify({ items: [{ pr: 1712 }] }))
  await cli(['check', 'worklist', 'write', id, '--items-json', items, '--json'], fx)
  const dir = (await cli(['check', 'status', id, '--json'], fx)).payload.dir
  fs.writeFileSync(path.join(dir, 'findings', 'a01.jsonl'), [
    JSON.stringify({ fid: 'a01|1712|1', pr: '1712', slice: 'a01', category: 'aria' }),
    JSON.stringify({ fid: 'a01|1712|2', pr: '1712', slice: 'a01' }),
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'filed', 'a01.tsv'), [
    ['a01|1712|1', 'ABC-1', 'http://x/1', '1712', '1', 'none'].join('\t'),
    ['a01|1712|2', 'ABC-2', 'http://x/2', '1712', '3', 'none'].join('\t'),
  ].join('\n') + '\n')

  // ⛔ An audit over a sweep still filing judges a corpus that is still growing, so its own tally is
  // out of a denominator that changes underneath it.
  const early = await cli(['check', 'audit', 'plan', id, '--json'], fx)
  assert.equal(early.code, 1)
  assert.match(early.payload.error.message, /not complete/)

  await cli(['check', 'ledger', 'append', '1712', 'filed', id, '--keys', 'ABC-1,ABC-2', '--json'], fx)
  assert.equal((await cli(['check', 'finish', id, '--json'], fx)).code, 0)

  const planned = await cli(['check', 'audit', 'plan', id, '--label', 'run-1', '--json'], fx)
  assert.equal(planned.code, 0, JSON.stringify(planned.payload && planned.payload.error))
  assert.equal(planned.payload.counts.gate1Batches, 1)
  // The filed row is the authority on priority, so the Urgent lands in the consequence pass.
  assert.equal(planned.payload.counts.consequenceFindings, 1)
  // One finding carries a category and one does not — reported as a gap, never papered over.
  assert.equal(planned.payload.counts.categories, 1)
  assert.ok(planned.payload.gaps.some(g => /record no `category`/.test(g)))
  assert.ok(fs.existsSync(path.join(dir, 'audit', 'batches.tsv')))

  // ⛔ One entry per run. A second audit over one corpus produces a second set of verdicts over the
  // same findings, and nothing downstream can tell which one a gate label came from.
  const again = await cli(['check', 'audit', 'plan', id, '--label', 'run-1', '--json'], fx)
  assert.equal(again.code, 1)
  assert.match(again.payload.error.message, /already records an audit run/)
  assert.equal((await cli(['check', 'audit', 'plan', id, '--label', 'run-2', '--json'], fx)).code, 0)

  const st = await cli(['check', 'status', id, '--json'], fx)
  assert.equal(st.payload.audit.status, 'running')
  assert.deepEqual(st.payload.audit.runs.map(r => r.auditRunId), ['run-1', 'run-2'])
})
