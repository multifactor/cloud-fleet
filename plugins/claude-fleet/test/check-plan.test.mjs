import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  planSweep, classifyInput, parsePrArg, prUrlRepoKey, widthFor, sliceWorklist, writeSweepDir, DEFAULT_HARNESS_MAX,
} from '../src/check/plan.mjs'
import { MODES, SWEEP_DIRS, validateManifest, readManifest, renderResumeMd, sweepLayout } from '../src/check/manifest.mjs'
import { parseFid } from '../src/check/fid.mjs'
import { enqueue, pending } from '../src/trackers/outbox.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'

const FACTS = {
  date: '2026-03-14', now: '2026-03-14T10:00:00Z', snapshotSha: 'abc123', harnessMax: 12, platform: 'linux',
  cwd: '/work/app', repoKey: 'github.com/acme/app', hasRestToken: false,
}
/** The facts of a resume: the CLI has stat'ed worklist.tsv (the planner never does). */
const RESUMED = { ...FACTS, worklistWritten: true }

function cfg(over = {}) {
  const c = defaultsFor()
  setPath(c, 'tracker.id', 'example-tracker')
  setPath(c, 'tracker.scope', 'ABC')
  setPath(c, 'paths.stateDir', '/state/app')
  setPath(c, 'checker.ready.state', 'Todo')
  setPath(c, 'vcs.host', 'github')   // a derived key; resolved in every real run
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

/** A full-capability adapter front matter (project grouping, labels, sub-issues, body work items). */
function adapter(caps = {}) {
  return {
    front: {
      id: 'example-tracker',
      issueKey: { pattern: '[A-Z][A-Z0-9]+-[0-9]+', caseInsensitive: false, example: 'ABC-1234' },
      capabilities: { createIssue: true, labels: true, subIssues: true, grouping: 'project', workItems: 'body', ...caps },
    },
  }
}

const plan = (args, over = {}, caps = {}, extra = {}) => planSweep({ args, config: cfg(over), adapter: adapter(caps), facts: FACTS, ...extra })

/** Every planned manifest must be one manifest.mjs reads back — the schema split is the bug this catches. */
const valid = p => {
  const v = validateManifest(p.manifest)
  assert.deepEqual(v, { ok: true, errors: [] })
  return p
}

// ---- input + sweepId -----------------------------------------------------------------------------

test('parsePrArg accepts a number, #number and a PR URL (kept) — anything else is not a PR', () => {
  assert.deepEqual(parsePrArg('1240'), { number: '1240', url: null })
  assert.deepEqual(parsePrArg('#1240'), { number: '1240', url: null })
  assert.deepEqual(parsePrArg('https://github.com/acme/app/pull/1240'), { number: '1240', url: 'https://github.com/acme/app/pull/1240' })
  assert.equal(parsePrArg('https://example.com/acme/app/-/merge_requests/7').number, '7')
  assert.equal(parsePrArg('ABC-1234'), null)
  assert.equal(parsePrArg('https://github.com/acme/app/issues/12'), null)
  // the URL copied from any PR tab, not only "Conversation": the tail goes, the canonical …/pull/<n> stays
  for (const tail of ['/files', '?diff=split', '#issuecomment-1', '/']) {
    assert.deepEqual(parsePrArg(`https://github.com/acme/app/pull/1240${tail}`), { number: '1240', url: 'https://github.com/acme/app/pull/1240' }, tail)
  }
  assert.equal(parsePrArg('https://github.com/acme/app/pull/1240abc'), null)
  // leading zeros are spelling, not identity
  assert.deepEqual(parsePrArg('#007'), { number: '7', url: null })
  assert.deepEqual(parsePrArg('0007'), { number: '7', url: null })
  // the repository a URL names, in facts.repoKey form
  assert.equal(prUrlRepoKey('https://github.com/Acme/App/pull/1240'), 'github.com/acme/app')
  assert.equal(prUrlRepoKey('https://example.com/grp/sub/app/-/merge_requests/7'), 'example.com/grp/sub/app')
  assert.equal(prUrlRepoKey('https://bitbucket.org/acme/app/pull-requests/3/'), 'bitbucket.org/acme/app')
})

test('sweepId is deterministic from the input, so re-running the same command IS the resume', () => {
  const a = valid(plan({ items: ['1240', '#1238', 'https://github.com/acme/app/pull/1239'] }))
  const b = plan({ items: ['1239', '1240', '1238'] })
  assert.equal(a.ok, true)
  assert.equal(a.sweepId, b.sweepId)
  assert.match(a.sweepId, /^prs-[0-9a-f]{8}$/)
  assert.deepEqual(a.input, { kind: 'prs', prs: ['1240', '1238', '1239'], urls: { 1239: 'https://github.com/acme/app/pull/1239' } })
  assert.deepEqual(a.manifest.input, a.input, 'the manifest holds the classified input, so a resumed PR-set sweep still knows its PRs')
  assert.notEqual(a.manifest.input.prs, a.input.prs, 'a copy, never an alias')
  assert.equal(a.sweepDir, `/state/app/sweeps/${a.sweepId}`)
  assert.equal(a.stateDir, '/state/app')
  // a tracker issue IS its sweepId
  assert.equal(valid(plan({ items: ['ABC-1234'] })).sweepId, 'ABC-1234')
  // a file hashes its RESOLVED path: the same file from another cwd (or spelled differently) is the same sweep
  const f = valid(plan({ fromFile: 'prs.txt' }))
  assert.match(f.sweepId, /^file-[0-9a-f]{8}$/)
  assert.deepEqual(f.input, { kind: 'file', ref: '/work/app/prs.txt' })
  assert.equal(plan({ fromFile: './prs.txt' }).sweepId, f.sweepId)
  assert.equal(plan({ fromFile: '/work/app/prs.txt' }).sweepId, f.sweepId)
  assert.equal(planSweep({ args: { fromFile: 'prs.txt' }, config: cfg(), adapter: adapter(), facts: { ...FACTS, cwd: '/elsewhere' } }).sweepId === f.sweepId, false)
  assert.throws(() => planSweep({ args: { fromFile: 'prs.txt' }, config: cfg(), adapter: adapter(), facts: { ...FACTS, cwd: undefined } }), /facts\.cwd/)
  // a relative cwd would make p.resolve read the process cwd — the one thing a pure planner never does
  assert.throws(() => planSweep({ args: { fromFile: 'prs.txt' }, config: cfg(), adapter: adapter(), facts: { ...FACTS, cwd: 'work/app' } }), /facts\.cwd/)
  // on win32 the filesystem is case-insensitive: the spelling of the path is not the identity of the file
  const win = spelling => planSweep({ args: { fromFile: spelling }, config: cfg(), adapter: adapter(), facts: { ...FACTS, platform: 'win32', cwd: 'C:\\Work' } })
  assert.deepEqual(win('prs.txt').input, { kind: 'file', ref: 'c:\\work\\prs.txt' })
  assert.equal(win('c:/work/PRS.TXT').sweepId, win('prs.txt').sweepId)
  assert.equal(win('C:\\Work\\prs.txt').sweepId, win('prs.txt').sweepId)
  // a PR named twice is collapsed (it would otherwise land in two slices and be filed twice)
  const dup = plan({ items: ['1240', '1240', '1241'] })
  assert.deepEqual(dup.input.prs, ['1240', '1241'])
  assert.ok(dup.warnings.some(w => w.code === 'plan.duplicate-prs'))
  // `7`, `#007` and `0007` are one PR: collapsed, and the same sweep as `7` alone
  const zeros = plan({ items: ['7', '#007', '0007'] })
  assert.deepEqual(zeros.input.prs, ['7'])
  assert.ok(zeros.warnings.some(w => w.code === 'plan.duplicate-prs'))
  assert.equal(zeros.sweepId, plan({ items: ['7'] }).sweepId)
})

test('the three input forms never mix, and a bare word is refused with a hint rather than guessed', () => {
  const front = adapter().front
  assert.equal(classifyInput({ items: ['1240', 'ABC-1234'] }, front).refused.code, 'plan.mixed-input')
  assert.equal(classifyInput({ items: ['ABC-1234', 'ABC-1235'] }, front).refused.code, 'plan.mixed-input')
  assert.equal(classifyInput({ items: ['1240'], fromFile: 'example/prs.txt' }, front).refused.code, 'plan.mixed-input')
  assert.equal(classifyInput({ items: [] }, front).refused.code, 'plan.no-input')
  const bad = classifyInput({ items: ['fix-the-import-flow'] }, front)
  assert.equal(bad.refused.code, 'plan.bad-input')
  assert.match(bad.refused.hint, /ABC-1234/)
  // tracker-less: a key-shaped argument cannot be read, so say why instead of treating it as a PR
  assert.equal(classifyInput({ items: ['ABC-1234'] }, null).refused.code, 'plan.bad-input')
})

test('a tracker whose keys are bare digits: the key form stays reachable, and #N is always a PR', () => {
  const gid = { front: { id: 'gid-tracker', issueKey: { pattern: '(?<![0-9A-Za-z])[0-9]{12,20}(?![0-9A-Za-z])', caseInsensitive: false, example: '1201234567890123' }, capabilities: { createIssue: true, labels: true, subIssues: true, grouping: 'project', workItems: 'children' } } }
  const key = planSweep({ args: { items: ['1201234567890123'] }, config: cfg(), adapter: gid, facts: FACTS })
  assert.deepEqual(key.input, { kind: 'tracker-issue', ref: '1201234567890123' })
  assert.equal(key.locationOps[0].op, 'readWorkItems')
  const pr = planSweep({ args: { items: ['#1201234567890123', '1240'] }, config: cfg(), adapter: gid, facts: FACTS })
  assert.deepEqual(pr.input, { kind: 'prs', prs: ['1201234567890123', '1240'] })
})

test('a PR URL on another repository is refused; without a repo key to check against it is warned about', () => {
  const foreign = plan({ items: ['1240', 'https://github.com/other/repo/pull/5'] })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.refused.code, 'plan.foreign-pr-url')
  assert.match(foreign.refused.message, /github\.com\/acme\/app/)
  assert.match(foreign.refused.message, /other\/repo\/pull\/5/)
  assert.equal(plan({ items: ['https://github.com/acme/app/pull/5'] }).ok, true)
  const unchecked = planSweep({ args: { items: ['https://github.com/other/repo/pull/5'] }, config: cfg(), adapter: adapter(), facts: { ...FACTS, repoKey: undefined } })
  assert.equal(unchecked.ok, true)
  assert.ok(unchecked.warnings.some(w => w.code === 'plan.pr-url-unchecked'))
  assert.deepEqual(unchecked.manifest.input.urls, { 5: 'https://github.com/other/repo/pull/5' })
})

// ---- location ops per adapter capability ----------------------------------------------------------

test('full-capability adapter: the location plan is ORDERED and every result has a manifest LEAF home', () => {
  const p = valid(plan({ items: ['1240', '1241'] }))
  assert.deepEqual(p.locationOps.map(o => o.op), [
    'createProject', 'resolveUser', 'resolveUser', 'listLabels', 'ensureLabel', 'ensureLabel', 'ensureLabel', 'listStates', 'createIssue',
  ])
  // contract §6 numbers travel with the names — sections are keyed by number, never by name
  assert.deepEqual(p.locationOps.slice(0, 4).map(o => o.n), [21, 3, 3, 17])
  assert.equal(p.locationOps.find(o => o.op === 'ensureLabel').n, 18)
  assert.equal(p.locationOps.find(o => o.op === 'listStates').n, 19)
  assert.equal(p.locationOps.find(o => o.op === 'createIssue').n, 13)
  // every entry is what outbox.enqueue takes: a non-blank key that is data — the sweepId, the umbrella `<sweepId>:umbrella`
  assert.deepEqual(p.locationOps.map(o => o.key), [...Array(8).fill(p.sweepId), `${p.sweepId}:umbrella`])
  // the routing rides in args.$manifest — the one field enqueue persists — and names its own entry
  for (const o of p.locationOps) assert.equal(o.args.$manifest.id, o.id, o.op)
  // no checker.project → a per-sweep group named from the template with the injected date; its ID lands at tracker.group
  assert.deepEqual(p.locationOps[0], {
    id: 'loc-createProject', op: 'createProject', n: 21, key: p.sweepId,
    args: { name: 'Edge-case sweep 2026-03-14', $manifest: { id: 'loc-createProject', into: 'tracker.group', pick: 'id' } },
  })
  // the current user (the umbrella's owner, §7.4) and the default assignee for findings — both "me" unless config routes
  assert.deepEqual(p.locationOps[1], { id: 'loc-resolveUser-currentUser', op: 'resolveUser', n: 3, key: p.sweepId, args: { ref: 'me', $manifest: { id: 'loc-resolveUser-currentUser', into: 'tracker.currentUser' } } })
  assert.deepEqual(p.locationOps[2], { id: 'loc-resolveUser-assignee', op: 'resolveUser', n: 3, key: p.sweepId, args: { ref: 'me', $manifest: { id: 'loc-resolveUser-assignee', into: 'tracker.assignee' } } })
  // exactly the three labels the playbook lets the sweep create (§2, §7.4): never a verdict label, never gate:waived
  const ensured = p.locationOps.filter(o => o.op === 'ensureLabel')
  assert.deepEqual(ensured.map(o => o.args.name), ['filed-by:fleet-check', 'triage', 'gate:pending'])
  assert.deepEqual(ensured.map(o => o.id), ['loc-ensureLabel-filed-by:fleet-check', 'loc-ensureLabel-triage', 'loc-ensureLabel-gate:pending'])
  assert.deepEqual(ensured.map(o => o.args.$manifest.into), ['tracker.labels.filed-by:fleet-check', 'tracker.labels.triage', 'tracker.labels.gate:pending'])
  assert.ok(ensured.every(o => o.args.$manifest.pick === 'id'))
  assert.equal(p.locationOps.some(o => o.op === 'ensureLabel' && /^gate:(passed|failed|uncertain|disputed|waived)$/.test(o.args.name)), false)
  assert.deepEqual(p.locationOps.find(o => o.op === 'listLabels').args, { scope: 'ABC', $manifest: { id: 'loc-listLabels', into: 'tracker.labelList' } })
  const states = p.locationOps.find(o => o.op === 'listStates')
  assert.deepEqual(states.args.$manifest, { id: 'loc-listStates', into: 'tracker.stateList' })
  assert.match(states.note, /tracker\.triage\.state/)
  // ids derive from the op and what distinguishes it, never from position: unique here, identical on a resume (see below)
  assert.equal(new Set(p.locationOps.map(o => o.id)).size, p.locationOps.length)
  assert.equal(p.locationOps.some(o => /\d\d-/.test(o.id)), false, 'no positional counter in an id')
  // the manifest is manifest.mjs's shape: ids null until acked, names where names belong
  const t = p.manifest.tracker
  assert.deepEqual([t.id, t.mode, t.scope, t.markers, t.grouping], ['example-tracker', 'mcp', 'ABC', 'labels', 'project'])
  assert.deepEqual([t.group, t.currentUser, t.assignee, t.umbrella, t.labelList, t.stateList], [null, null, null, null, null, null])
  assert.deepEqual(t.labels, {})
  assert.deepEqual([t.triage, t.ready, t.provenanceLabel], [{ state: null, label: 'triage' }, { state: null, label: null }, 'filed-by:fleet-check'])
  assert.equal(p.manifest.status, 'planning')
  assert.deepEqual([p.manifest.createdAt, p.manifest.updatedAt], ['2026-03-14T10:00:00Z', '2026-03-14T10:00:00Z'])
  assert.deepEqual(p.manifest.repo, { key: 'github.com/acme/app', baseBranch: 'main', snapshotSha: 'abc123' })
  assert.equal(p.manifest.gate.pendingLine, `**Gate:** pending (${p.sweepId})`)
  assert.equal(p.manifest.gate.labels.waived, 'gate:waived')
  assert.equal(p.manifest.gate.autoPromote, 'never')
  assert.equal(p.manifest.checker.triage.label, 'triage', 'the frozen config view travels with the sweep')
  // a label name is one manifest path segment
  assert.equal(plan({ items: ['1240'] }, { 'checker.triage.label': 'v2.0' }).refused.code, 'plan.bad-label-name')
})

test('the a11y umbrella: forced priority, both a11y labels, filled from the acked current user, group and triage ref', () => {
  const p = valid(plan({ items: ['1240'] }))
  const u = p.locationOps.find(o => o.op === 'createIssue')
  assert.equal(u.kind, undefined, 'the umbrella kind lives in the manifest, not on the outbox entry')
  assert.equal(u.args.title, 'a11y')
  assert.equal(u.args.priority, 4)
  assert.deepEqual(u.args.labels, ['a11y: keyboard', 'a11y: screen reader', 'filed-by:fleet-check', 'triage', 'gate:pending'])
  assert.equal('state' in u.args, false, 'no triage state configured → none sent')
  // no issue key yet: the op-13 convention is an opaque key that is data, never a path
  assert.equal(u.key, `${p.sweepId}:umbrella`)
  assert.deepEqual(u.args.$manifest, {
    id: 'loc-createIssue-umbrella', into: 'tracker.umbrella', pick: 'key',
    fill: { assignee: 'tracker.currentUser', group: 'tracker.group' }, needs: ['tracker.currentUser', 'tracker.group'],
  })
  assert.ok(u.args.body.includes(`**Gate:** pending (${p.sweepId})`))
  assert.equal(p.manifest.tracker.umbrellaKind, 'sub-issues')
  assert.equal(p.manifest.tracker.umbrella, null)
  // a configured triage state is sent as the REF the launcher resolves from the state list, never its name
  const triaged = plan({ items: ['1240'] }, { 'checker.triage.state': 'Triage' })
  const tu = triaged.locationOps.find(o => o.op === 'createIssue')
  assert.equal(tu.args.state, null)
  assert.equal(tu.args.$manifest.fill.state, 'tracker.triage.state')
  assert.ok(tu.args.$manifest.needs.includes('tracker.triage.state'))
  assert.equal(triaged.manifest.tracker.triage.state, null)
  assert.equal(triaged.manifest.checker.triage.state, 'Triage')
  // a routed checker.assignee is the default for FINDINGS; the umbrella stays the current user's (§7.4)
  const named = plan({ items: ['1240'] }, { 'checker.assignee': 'ada@example.com' })
  const users = named.locationOps.filter(o => o.op === 'resolveUser')
  assert.deepEqual(users.map(o => [o.args.ref, o.args.$manifest.into]), [['me', 'tracker.currentUser'], ['ada@example.com', 'tracker.assignee']])
  const nu = named.locationOps.find(o => o.op === 'createIssue')
  assert.equal(nu.args.$manifest.fill.assignee, 'tracker.currentUser')
  assert.equal(users.find(o => o.args.$manifest.into === nu.args.$manifest.fill.assignee).args.ref, 'me', 'the umbrella is filled from resolveUser("me"), not from the routed assignee')
  // umbrella off → no createIssue at plan time
  const off = plan({ items: ['1240'] }, { 'checker.a11y.umbrella': false })
  assert.equal(off.locationOps.some(o => o.op === 'createIssue'), false)
  assert.equal(off.manifest.tracker.umbrellaKind, null)
})

test('no sub-issues → the umbrella degrades to an index issue and says so; no createIssue → no umbrella', () => {
  const idx = valid(plan({ items: ['1240'] }, {}, { subIssues: false }))
  const u = idx.locationOps.find(o => o.op === 'createIssue')
  assert.match(u.args.body, /INDEX/)
  assert.equal(idx.manifest.tracker.umbrellaKind, 'index')
  assert.ok(idx.warnings.some(w => w.code === 'plan.umbrella-index'))
  const none = plan({ items: ['1240'] }, {}, { createIssue: false })
  assert.equal(none.locationOps.some(o => o.op === 'createIssue'), false)
  assert.ok(none.warnings.some(w => w.code === 'plan.umbrella-unsupported'))
})

test('grouping none → provenance-label-only, no group op, and --project is ignored loudly', () => {
  const p = valid(plan({ items: ['1240'], project: 'Sweeps' }, { 'checker.project': 'Sweeps' }, { grouping: 'none' }))
  assert.equal(p.locationOps.some(o => o.op === 'resolveProject' || o.op === 'createProject'), false)
  assert.deepEqual([p.manifest.tracker.group, p.manifest.tracker.grouping], [null, 'none'])
  assert.ok(p.warnings.some(w => w.code === 'plan.project-ignored'))
  // the umbrella then has no group to fill
  assert.deepEqual(p.locationOps.find(o => o.op === 'createIssue').args.$manifest.fill, { assignee: 'tracker.currentUser' })
})

test('checker.project resolves by ref; --project new or projectPerSweep forces a fresh group anyway', () => {
  const existing = plan({ items: ['1240'] }, { 'checker.project': 'proj_123' })
  assert.deepEqual(existing.locationOps[0], {
    id: 'loc-resolveProject', op: 'resolveProject', n: 20, key: existing.sweepId,
    args: { ref: 'proj_123', $manifest: { id: 'loc-resolveProject', into: 'tracker.group', pick: 'id' } },
  })
  assert.equal(plan({ items: ['1240'], project: 'Other' }, { 'checker.project': 'proj_123' }).locationOps[0].args.ref, 'Other')
  assert.equal(plan({ items: ['1240'], project: 'new' }, { 'checker.project': 'proj_123' }).locationOps[0].op, 'createProject')
  const per = plan({ items: ['1240'] }, { 'checker.project': 'proj_123', 'checker.projectPerSweep': true, 'checker.projectNameTemplate': 'Sweep {sweepId} {date}' })
  assert.equal(per.locationOps[0].op, 'createProject')
  assert.equal(per.locationOps[0].args.name, `Sweep ${per.sweepId} 2026-03-14`)
  // naming a per-sweep group needs the date injected — a pure planner never reads the clock
  assert.throws(() => planSweep({ args: { items: ['1240'] }, config: cfg(), adapter: adapter(), facts: { ...FACTS, date: undefined } }), /facts.date/)
})

test('a tracker without labels: no listLabels/ensureLabel, markers move to body lines, umbrella carries no labels', () => {
  const p = valid(plan({ items: ['1240'] }, {}, { labels: false }))
  assert.equal(p.locationOps.some(o => o.op === 'listLabels' || o.op === 'ensureLabel'), false)
  assert.equal(p.manifest.tracker.markers, 'body')
  assert.ok(p.warnings.some(w => w.code === 'plan.labels-unsupported'))
  const u = p.locationOps.find(o => o.op === 'createIssue')
  assert.deepEqual(u.args.labels, [])
  assert.match(u.args.body, /\*\*Labels:\*\* a11y: keyboard, a11y: screen reader, filed-by:fleet-check, triage, gate:pending/)
})

test('a tracker-issue input reads the work items FIRST — nothing is created before the work-list exists', () => {
  const p = valid(plan({ items: ['ABC-1234'] }))
  assert.equal(p.sweepId, 'ABC-1234')
  assert.equal(p.locationOps[0].op, 'readWorkItems')
  assert.equal(p.locationOps[0].n, 26)
  assert.equal(p.locationOps[0].id, 'loc-readWorkItems-ABC-1234')
  assert.equal(p.locationOps[0].key, 'ABC-1234')
  // its result goes to `worklist write`, not to a manifest leaf
  assert.deepEqual(p.locationOps[0].args, { key: 'ABC-1234', $manifest: { id: 'loc-readWorkItems-ABC-1234', into: null } })
  assert.match(p.locationOps[0].note, /worklist write --items-json/)
  // the manifest mirrors its ticks onto the input key; slices wait for the work-list
  assert.equal(p.manifest.tracker.workItems, 'ABC-1234')
  assert.deepEqual(p.manifest.slices, [])
  // a tracker that cannot hold a work-list cannot be the input
  const r = plan({ items: ['ABC-1234'] }, {}, { workItems: 'none' })
  assert.equal(r.ok, false)
  assert.equal(r.refused.code, 'plan.no-work-items')
})

test('tracker-less: no location ops, no tracker-shaped warnings or fields, no date needed, and a key-shaped input is refused', () => {
  const p = valid(planSweep({ args: { items: ['1240', '1241'] }, config: cfg({ 'tracker.mode': 'none' }), adapter: null, facts: { ...FACTS, date: undefined } }))
  assert.equal(p.ok, true)
  assert.deepEqual(p.locationOps, [])
  assert.deepEqual(p.warnings.map(w => w.code), ['plan.tracker-less'])
  const t = p.manifest.tracker
  assert.deepEqual([t.id, t.mode, t.umbrella, t.umbrellaKind, t.markers, t.grouping, t.group], [null, 'none', null, null, null, null, null])
  assert.equal(planSweep({ args: { items: ['ABC-1234'] }, config: cfg({ 'tracker.mode': 'none' }), adapter: null, facts: FACTS }).refused.code, 'plan.bad-input')
  // a configured tracker with no adapter handed in is a programmer error, not a silent tracker-less run
  assert.throws(() => planSweep({ args: { items: ['1240'] }, config: cfg(), adapter: null, facts: FACTS }), /no adapter/)
})

// ---- resume ---------------------------------------------------------------------------------------

test('resume: an already-resolved location op is NOT re-emitted, and the manifest keeps its width and slices', () => {
  const first = valid(plan({ items: ['1240', '1241'] }))
  const resolved = JSON.parse(JSON.stringify(first.manifest))
  resolved.status = 'running'
  resolved.tracker.group = 'proj_1'
  resolved.tracker.currentUser = 'usr_1'
  resolved.tracker.assignee = 'usr_1'
  resolved.tracker.labelList = [{ id: 'l1', name: 'triage' }]
  resolved.tracker.labels = { 'filed-by:fleet-check': 'l2', triage: 'l1' }
  resolved.tracker.stateList = [{ id: 's1', name: 'Todo', type: 'unstarted' }]
  resolved.tracker.umbrella = 'ABC-2000'
  resolved.counts.worklist = 2
  assert.equal(validateManifest(resolved).ok, true)

  const again = valid(plan({ items: ['1241', '1240'], project: 'new', mode: 'sessions', width: '3', auto: true }, {}, {}, { existingManifest: resolved, facts: RESUMED }))
  assert.equal(again.ok, true)
  assert.equal(again.resume, true)
  assert.equal(again.sweepId, first.sweepId)
  // only the one label nobody acked yet is still owed
  assert.deepEqual(again.locationOps.map(o => [o.op, o.args.name]), [['ensureLabel', 'gate:pending']])
  // …under the SAME id as the first run gave it: an entry a dead run queued but never acked and this
  // run's re-emission are one entry, so the launcher can dedupe them
  assert.equal(again.locationOps[0].id, first.locationOps.find(o => o.op === 'ensureLabel' && o.args.name === 'gate:pending').id)
  assert.equal(again.locationOps[0].id, 'loc-ensureLabel-gate:pending')
  assert.equal(again.locationOps[0].key, first.sweepId)
  // the manifest is the sweep's truth: mode, ids and slices stay; --project new is refused a second group
  assert.equal(again.mode, 'local')
  assert.equal(again.manifest.mode, 'local')
  assert.ok(again.warnings.some(w => w.code === 'plan.mode-ignored'))
  assert.match(again.warnings.find(w => w.code === 'plan.project-ignored').message, /--project new/)
  // any --project value on a resume with a group is ignored LOUDLY, not only `new`
  const other = plan({ items: ['1241', '1240'], project: 'Other' }, {}, {}, { existingManifest: resolved, facts: RESUMED })
  assert.equal(other.locationOps.some(o => o.op === 'resolveProject' || o.op === 'createProject'), false)
  assert.match(other.warnings.find(w => w.code === 'plan.project-ignored').message, /--project Other/)
  assert.deepEqual(again.manifest.slices, first.manifest.slices)
  assert.deepEqual(again.slices, first.manifest.slices)
  assert.equal(again.manifest.tracker.umbrella, 'ABC-2000')
  assert.equal(again.manifest.tracker.group, 'proj_1')
  assert.deepEqual(again.manifest.tracker.labels, resolved.tracker.labels)
  assert.equal(again.manifest.createdAt, first.manifest.createdAt)
  assert.equal(again.manifest.status, 'running')
  // width is this run's pacing knob (manifest.mjs mergeOnResume: a sweep that OOM'd resumes narrower)
  // and --auto is per run — both land in the manifest, where slice and finish read them
  assert.equal(again.width, 3)
  assert.equal(again.manifest.width, 3)
  assert.equal(again.auto, true)
  assert.equal(again.manifest.gate.autoPromote, 'after-audit')
  const plain = plan({ items: ['1241', '1240'] }, {}, {}, { existingManifest: { ...resolved, gate: { ...resolved.gate, autoPromote: 'after-audit' } }, facts: RESUMED })
  assert.deepEqual([plain.auto, plain.manifest.gate.autoPromote, plain.manifest.width], [false, 'never', 12])

  // a manifest whose work-list was never written still owes the readWorkItems — and whether it was
  // written is a FACT the CLI stats, never inferred from counts.worklist (an empty checklist writes an
  // empty file and leaves the count at 0)
  const keyed = plan({ items: ['ABC-1234'] })
  const noList = JSON.parse(JSON.stringify(keyed.manifest))
  assert.equal(plan({ items: ['ABC-1234'] }, {}, {}, { existingManifest: noList, facts: { ...FACTS, worklistWritten: false } }).locationOps[0].op, 'readWorkItems')
  assert.equal(plan({ items: ['ABC-1234'] }, {}, {}, { existingManifest: noList, facts: RESUMED }).locationOps.some(o => o.op === 'readWorkItems'), false, 'the file exists with 0 rows: nothing to re-read')
  assert.throws(() => plan({ items: ['ABC-1234'] }, {}, {}, { existingManifest: noList }), /facts\.worklistWritten/)

  // --resume takes the input from the manifest and refuses an unknown sweep; input given beside it is
  // dropped LOUDLY (the usage line allows both, so the operator must be told which one ran)
  const explicit = plan({ resume: first.sweepId }, {}, {}, { existingManifest: resolved, facts: RESUMED })
  assert.deepEqual(explicit.input, first.input)
  assert.equal(explicit.warnings.some(w => w.code === 'plan.input-ignored'), false)
  const mixed = plan({ resume: first.sweepId, items: ['9999'] }, {}, {}, { existingManifest: resolved, facts: RESUMED })
  assert.deepEqual(mixed.input, first.input)
  assert.match(mixed.warnings.find(w => w.code === 'plan.input-ignored').message, /9999/)
  const mixedFile = plan({ resume: first.sweepId, fromFile: 'prs.txt' }, {}, {}, { existingManifest: resolved, facts: RESUMED })
  assert.match(mixedFile.warnings.find(w => w.code === 'plan.input-ignored').message, /--from-file prs\.txt/)
  assert.equal(plan({ resume: 'prs-deadbeef' }).refused.code, 'plan.resume-missing')
  // a manifest for another sweep handed in is a programmer error
  assert.throws(() => plan({ items: ['9'] }, {}, {}, { existingManifest: resolved, facts: RESUMED }), /manifest is for sweep/)
})

test('a sweepId is a plain directory name: --resume ../x is refused before any path is joined', () => {
  const r = plan({ resume: '../../etc' }, {}, {}, { existingManifest: { sweepId: '../../etc', mode: 'local', input: { kind: 'prs', ref: '1' } } })
  assert.equal(r.ok, false)
  assert.equal(r.refused.code, 'plan.bad-sweep-id')
  assert.equal(plan({ resume: 'a\\b' }).refused.code, 'plan.bad-sweep-id')
  // a custom adapter whose key pattern admits a separator gets the same refusal for the key form
  const slashy = { front: { id: 'slashy', issueKey: { pattern: '[A-Z]+/[0-9]+', caseInsensitive: false, example: 'ABC/12' }, capabilities: { createIssue: true, labels: true, subIssues: true, grouping: 'project', workItems: 'body' } } }
  assert.equal(planSweep({ args: { items: ['ABC/12'] }, config: cfg(), adapter: slashy, facts: FACTS }).refused.code, 'plan.bad-sweep-id')
})

// ---- width ----------------------------------------------------------------------------------------

test('widthFor: auto = the harness limit, throttled to 1 under memory pressure; explicit N is a cap, not a floor', () => {
  const c = cfg()
  assert.equal(widthFor({ config: c, harnessMax: 12 }).width, 12)
  assert.equal(widthFor({ config: c, harnessMax: null }).width, DEFAULT_HARNESS_MAX)
  const warn = widthFor({ config: c, harnessMax: 12, memory: { pressure: 'warn' } })
  assert.equal(warn.width, 1)
  assert.match(warn.reason, /memory pressure is warn/)
  assert.equal(widthFor({ config: c, harnessMax: 12, memory: { pressure: 'critical' } }).width, 1)
  // an explicit width is capped by what the harness can actually run, and is still throttled
  assert.equal(widthFor({ config: c, harnessMax: 12, requested: '6' }).width, 6)
  assert.equal(widthFor({ config: c, harnessMax: 12, requested: 40 }).width, 12)
  assert.equal(widthFor({ config: c, harnessMax: 12, requested: 6, memory: { pressure: 'warn' } }).width, 1)
  assert.equal(widthFor({ config: cfg({ 'checker.waveWidth': '4' }), harnessMax: 12 }).source, 'checker.waveWidth')
  // sessions are whole worktrees with dev servers: fleet.size bounds them
  assert.equal(widthFor({ config: cfg({ 'fleet.size': 3 }), mode: 'sessions', harnessMax: 12 }).width, 3)
  // cloud workers do not run on this machine, so local memory pressure does not throttle them
  assert.equal(widthFor({ config: c, mode: 'cloud', harnessMax: 12, memory: { pressure: 'warn' } }).width, 12)
  // a malformed width is a programmer error here — planSweep refuses operator input before it arrives
  assert.throws(() => widthFor({ config: c, requested: '0' }), /positive integer/)
  assert.throws(() => widthFor({ config: c, requested: 'lots' }), /positive integer/)
})

test('planSweep hands the machine facts to widthFor: memory pressure serialises the wave, fleet.size bounds sessions', () => {
  const warn = valid(planSweep({ args: { items: ['1', '2', '3'] }, config: cfg(), adapter: adapter(), facts: { ...FACTS, memory: { pressure: 'warn' } } }))
  assert.equal(warn.width, 1)
  assert.match(warn.widthReason, /memory pressure is warn/)
  assert.deepEqual(warn.manifest.slices.map(s => s.prs), [['1'], ['2'], ['3']])
  const sessions = valid(plan({ items: ['1', '2', '3', '4'], mode: 'sessions' }, { 'fleet.size': 2 }))
  assert.equal(sessions.width, 2)
  assert.match(sessions.widthReason, /fleet\.size 2/)
  assert.deepEqual(sessions.manifest.slices.map(s => s.prs), [['1', '2'], ['3', '4']])
})

test('a bad --width or checker.waveWidth is refused with a hint, never thrown at the operator', () => {
  // digits or "auto" only: Number() would also read a hex, an exponent and a decimal spelling
  for (const width of ['lots', '0', '-2', '1.5', '0x10', '1e1', '5.0']) {
    const r = plan({ items: ['1'], width })
    assert.equal(r.ok, false, width)
    assert.equal(r.refused.code, 'plan.bad-width')
    assert.match(r.refused.hint, /--width N\|auto/)
  }
  const c = plan({ items: ['1'] }, { 'checker.waveWidth': 'lots' })
  assert.equal(c.refused.code, 'plan.bad-width')
  assert.match(c.refused.message, /checker\.waveWidth/)
  assert.equal(plan({ items: ['1'], width: 'AUTO' }).width, 12)
  assert.equal(plan({ items: ['1'], width: 3 }).width, 3)
})

// ---- slicing --------------------------------------------------------------------------------------

test('slices are disjoint, cover every PR, carry fid ranges, and a PR-list plan records them in the manifest', () => {
  const prs = Array.from({ length: 23 }, (_, i) => String(1000 + i))
  const slices = sliceWorklist(prs, { width: 10, mode: 'local' })
  assert.deepEqual(slices.map(s => s.slice), ['a01', 'a02', 'a03'])
  assert.deepEqual(slices.map(s => s.prs.length), [10, 10, 3])
  const all = slices.flatMap(s => s.prs)
  assert.deepEqual([...all].sort(), [...prs].sort())
  assert.equal(new Set(all).size, prs.length, 'no PR appears in two slices')
  assert.equal(slices[1].fidRanges[0].first, 'a02|1010|1')
  assert.deepEqual(parseFid(slices[2].fidRanges[2].first), { slice: 'a03', pr: '1022', index: 1 })
  for (const s of slices) assert.equal(s.slice.includes('|'), false)
  // sessions: `width` sessions, each with a contiguous share
  const sessions = sliceWorklist(prs, { width: 4, mode: 'sessions' })
  assert.deepEqual(sessions.map(s => s.prs.length), [6, 6, 6, 5])
  assert.deepEqual(sliceWorklist(['1', '2'], { width: 4, mode: 'sessions' }).map(s => s.prs), [['1'], ['2']])
  // deterministic: the same input slices the same way on a resume
  assert.deepEqual(sliceWorklist(prs, { width: 10 }), slices)
  // many slices widen the padding so names still sort
  const many = sliceWorklist(Array.from({ length: 101 }, (_, i) => String(i)), { width: 1 })
  assert.deepEqual([many[0].slice, many[99].slice, many[100].slice], ['a001', 'a100', 'a101'])
  assert.deepEqual(sliceWorklist([], { width: 3 }), [])
  assert.throws(() => sliceWorklist(['1', '1'], { width: 3 }), /duplicate PRs 1/)
  assert.throws(() => sliceWorklist(['1'], { width: 0 }), /positive integer/)
  assert.throws(() => sliceWorklist(['1'], { width: 1, mode: 'remote' }), /unknown mode/)
  // every member of the mode vocabulary plans (cloud needs cloud capture); a non-member is refused
  for (const mode of MODES) assert.equal(plan({ items: ['1'], mode }, mode === 'cloud' ? { 'capture.mode': 'cloud' } : {}).mode, mode)
  for (const mode of ['remote', 'auto']) assert.equal(plan({ items: ['1'], mode }).refused.code, 'plan.bad-mode')
  // a PR list is sliced at plan time, in the shape manifest.mjs validates, and the slices are the plan's
  const p = valid(plan({ items: ['1240', '1241', '1242'], width: '2' }))
  assert.deepEqual(p.manifest.slices.map(s => s.prs), [['1240', '1241'], ['1242']])
  assert.deepEqual(p.manifest.slices.map(s => s.slice), ['a01', 'a02'])
  assert.deepEqual(p.slices, p.manifest.slices)
  assert.deepEqual(plan({ items: ['1240', '1241', '1242'], width: '2', mode: 'sessions' }).manifest.slices.map(s => s.prs), [['1240', '1241'], ['1242']])
})

// ---- refusals -------------------------------------------------------------------------------------

test('--auto is refused with a hint when there is no gate to collapse', () => {
  const r = plan({ items: ['1240'], auto: true }, { 'checker.triage.label': null, 'checker.ready.state': null })
  assert.equal(r.ok, false)
  assert.equal(r.refused.code, 'plan.auto-without-gate')
  assert.match(r.refused.hint, /checker.triage.label/)
  // either one is a gate
  assert.equal(plan({ items: ['1240'], auto: true }, { 'checker.ready.state': null }).ok, true)
  const ok = valid(plan({ items: ['1240'], auto: true }, { 'checker.triage.label': null }))
  assert.equal(ok.ok, true)
  assert.equal(ok.auto, true)
  assert.equal(ok.manifest.gate.autoPromote, 'after-audit')
  // the same promotion path runs from config (§9: "after-audit (or --auto on this run)"), so the same refusal — naming the key
  const fromConfig = plan({ items: ['1240'] }, { 'checker.autoPromote': 'after-audit', 'checker.triage.label': null, 'checker.ready.state': null })
  assert.equal(fromConfig.ok, false)
  assert.equal(fromConfig.refused.code, 'plan.auto-without-gate')
  assert.match(fromConfig.refused.message, /checker\.autoPromote = after-audit/)
  assert.match(fromConfig.refused.hint, /checker\.autoPromote never/)
  const cfgAuto = valid(plan({ items: ['1240'] }, { 'checker.autoPromote': 'after-audit' }))
  assert.deepEqual([cfgAuto.auto, cfgAuto.manifest.gate.autoPromote], [true, 'after-audit'])
})

test('--mode cloud is refused unless capture.mode is cloud; an unknown mode is refused, not defaulted', () => {
  const r = plan({ items: ['1240'], mode: 'cloud' })
  assert.equal(r.ok, false)
  assert.equal(r.refused.code, 'plan.cloud-needs-cloud-capture')
  assert.match(r.refused.hint, /capture.mode/)
  assert.equal(valid(plan({ items: ['1240'], mode: 'cloud' }, { 'capture.mode': 'cloud' })).mode, 'cloud')
  assert.equal(plan({ items: ['1240'], mode: 'remote' }).refused.code, 'plan.bad-mode')
  assert.equal(plan({ items: ['1240'] }, { 'checker.defaultMode': 'sessions' }).mode, 'sessions')
})

test('the screenshot strategy is chosen ONCE at plan time and recorded where every worker reads it', () => {
  // the example adapter neither uploads nor shows an image → none, resolved (never null, never "auto")
  const none = valid(plan({ items: ['1240'] }))
  assert.deepEqual([none.manifest.capture.attachStrategy, none.manifest.capture.assetsBranch], ['none', null])
  const native = valid(plan({ items: ['1240'] }, {}, { imageUpload: 'mcp', imageEmbed: 'inline' }))
  assert.deepEqual([native.manifest.capture.attachStrategy, native.manifest.capture.assetsBranch], ['native-upload', null])
  // a REST upload needs the token the CLI injects as a fact; without it the forge takes over and the assets branch is named now
  const rest = planSweep({ args: { items: ['1240'] }, config: cfg(), adapter: adapter({ imageUpload: 'rest', imageEmbed: 'inline' }), facts: { ...FACTS, hasRestToken: true } })
  assert.equal(rest.manifest.capture.attachStrategy, 'native-upload')
  const assets = valid(plan({ items: ['1240'] }, {}, { imageUpload: 'rest', imageEmbed: 'inline' }))
  assert.equal(assets.manifest.capture.attachStrategy, 'assets-branch')
  assert.equal(assets.manifest.capture.assetsBranch, `assets-check-${assets.sweepId}`)
  // when the forge alone decides the route and vcs.host is unresolved, the plan refuses rather than guessing
  const unresolved = plan({ items: ['1240'] }, { 'vcs.host': null }, { imageUpload: 'rest', imageEmbed: 'inline' })
  assert.equal(unresolved.ok, false)
  assert.equal(unresolved.refused.code, 'plan.vcs-host-unresolved')
  assert.match(unresolved.refused.hint, /vcs\.host/)
  assert.equal(plan({ items: ['1240'] }, { 'vcs.host': 'other' }, { imageUpload: 'rest', imageEmbed: 'inline' }).manifest.capture.attachStrategy, 'none')
  // a forced route the tracker cannot serve is refused at plan time, not on the three-hundredth issue
  const forced = plan({ items: ['1240'] }, { 'checker.attachStrategy': 'native' })
  assert.equal(forced.ok, false)
  assert.equal(forced.refused.code, 'plan.attach-strategy-unsupported')
  assert.match(forced.refused.message, /cannot be honoured/)
  assert.match(forced.refused.hint, /auto/)
  assert.equal(plan({ items: ['1240'] }, { 'checker.attachStrategy': 'native' }, { imageUpload: 'mcp', imageEmbed: 'inline' }).manifest.capture.attachStrategy, 'native-upload')
  // a tracker-less sweep renders local markdown (an inline image, nothing to upload to): the forge carries it, or none
  assert.equal(planSweep({ args: { items: ['1'] }, config: cfg({ 'tracker.mode': 'none', 'vcs.host': 'gitlab' }), adapter: null, facts: FACTS }).manifest.capture.attachStrategy, 'assets-branch')
  assert.equal(planSweep({ args: { items: ['1'] }, config: cfg({ 'tracker.mode': 'none', 'vcs.host': 'other' }), adapter: null, facts: FACTS }).manifest.capture.attachStrategy, 'none')
})

// ---- the thin sweep-dir wrapper -------------------------------------------------------------------

const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-plan-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('writeSweepDir lays out the sweep dir, writes a manifest readManifest accepts, and RESUME.md is manifest.mjs\'s protocol', t => {
  const root = tmp(t)
  const config = cfg({ 'paths.stateDir': root })
  const facts = { ...FACTS, platform: process.platform }
  const p = planSweep({ args: { items: ['1240', '1241'] }, config, adapter: adapter(), facts })
  assert.equal(readManifest(p.sweepDir), null)
  const w = writeSweepDir(p)
  assert.equal(w.created, true)
  const L = sweepLayout(root, p.sweepId, process.platform)
  assert.deepEqual(w, { sweepDir: L.dir, manifestFile: L.manifest, resumeFile: L.resume, created: true })
  for (const k of SWEEP_DIRS) assert.ok(fs.statSync(L[k]).isDirectory(), k)
  assert.equal(fs.readdirSync(L.dir).filter(f => f.endsWith('.tmp')).length, 0)
  const m = readManifest(p.sweepDir)
  assert.deepEqual(m, p.manifest)
  assert.deepEqual(m.input, { kind: 'prs', prs: ['1240', '1241'] })
  const resume = fs.readFileSync(w.resumeFile, 'utf8')
  assert.match(resume, /fleet check ledger resume --json/)
  assert.equal(resume, renderResumeMd(p.sweepId))

  // a resume writes the MERGED manifest: the ids it resolved survive, status moves, RESUME.md is never
  // rewritten because `fleet check finish` marks that file finished and a regenerated one erases the mark
  m.tracker.group = 'proj_1'
  fs.writeFileSync(L.manifest, JSON.stringify(m))
  fs.appendFileSync(w.resumeFile, '\n**Finished** 2026-03-14\n')
  const again = planSweep({ args: { items: ['1241', '1240'], auto: true }, config, adapter: adapter(), facts: { ...facts, now: '2026-03-14T12:00:00Z', worklistWritten: false }, existingManifest: readManifest(p.sweepDir) })
  assert.equal(again.resume, true)
  assert.equal(writeSweepDir(again).created, false)
  const back = readManifest(p.sweepDir)
  assert.equal(back.tracker.group, 'proj_1')
  assert.deepEqual([back.status, back.updatedAt, back.createdAt, back.gate.autoPromote], ['running', '2026-03-14T12:00:00Z', '2026-03-14T10:00:00Z', 'after-audit'])
  assert.match(fs.readFileSync(w.resumeFile, 'utf8'), /\*\*Finished\*\* 2026-03-14/)
  assert.throws(() => writeSweepDir({ ok: false, refused: {} }), /refused plan/)

  // a fresh plan over an existing sweep is the split-group trap: refused, and the manifest on disk is untouched
  const fresh = planSweep({ args: { items: ['1240', '1241'] }, config, adapter: adapter(), facts })
  assert.equal(fresh.resume, false)
  assert.throws(() => writeSweepDir(fresh), /already exists for sweep .* re-plan with existingManifest/)
  assert.deepEqual(readManifest(p.sweepDir), back)

  // a damaged manifest throws from the reader the planner is handed — never "no sweep here"
  fs.writeFileSync(L.manifest, '{"v": 1, "sweepId": "prs-')
  assert.throws(() => readManifest(p.sweepDir), /not valid JSON .* do not re-plan over it/)
})

// ---- parity with the outbox ---------------------------------------------------------------------

test('every location entry enqueues into the outbox AS IT STANDS and reads back with its key, op, n, args, routing and note', t => {
  const root = tmp(t)
  // a PR-set sweep with a triage state (the umbrella then fills three paths) and a <KEY> sweep (readWorkItems first)
  for (const p of [valid(plan({ items: ['1240'] }, { 'checker.triage.state': 'Triage' })), valid(plan({ items: ['ABC-1234'] }))]) {
    const stateDir = path.join(root, p.sweepId)
    for (const e of p.locationOps) enqueue({ stateDir, ...e })
    const { entries, unreadable } = pending({ stateDir })
    assert.deepEqual(unreadable, [])
    assert.equal(entries.length, p.locationOps.length)
    // drain order is plan order, and nothing the entry carries is lost on the way through the file
    assert.deepEqual(entries.map(e => [e.n, e.op, e.key]), p.locationOps.map(e => [e.n, e.op, e.key]))
    assert.deepEqual(entries.map(e => e.args), p.locationOps.map(e => e.args), 'the routing survives inside args.$manifest')
    assert.deepEqual(entries.map(e => e.args.$manifest.id), p.locationOps.map(e => e.id))
    assert.deepEqual(entries.map(e => e.note), p.locationOps.map(e => e.note ?? null))
    // the outbox mints the FILE id; the plan's id is what an ack correlates on
    for (const e of entries) assert.match(e.id, /^\d{8}T\d{9}Z-launcher-\d{6}$/)
  }
})

test('writeSweepDir writes where THIS process can, even when the plan was laid out for the other platform', t => {
  const root = tmp(t)
  const other = process.platform === 'win32' ? 'linux' : 'win32'
  const p = planSweep({ args: { items: ['1240'] }, config: cfg({ 'paths.stateDir': root }), adapter: adapter(), facts: { ...FACTS, platform: other } })
  assert.equal(p.sweepDir, sweepLayout(root, p.sweepId, other).dir)
  const w = writeSweepDir(p)
  // one separator throughout, and the files are really there
  assert.equal(w.manifestFile, path.join(w.sweepDir, 'manifest.json'))
  assert.equal(w.resumeFile, path.join(w.sweepDir, 'RESUME.md'))
  assert.ok(fs.existsSync(w.manifestFile))
  assert.ok(fs.existsSync(w.resumeFile))
  assert.deepEqual(readManifest(w.sweepDir), p.manifest)
})
