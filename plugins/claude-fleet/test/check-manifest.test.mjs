import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MANIFEST_V, COUNT_KEYS, SWEEP_DIRS, ATTACH_STRATEGIES, assertSweepId, emptyManifest, validateManifest, mergeOnResume,
  sweepLayout, renderResumeMd, readManifest, writeManifest, ensureSweepDir,
} from '../src/check/manifest.mjs'
import { classifyInput } from '../src/check/plan.mjs'
import { stateLayout } from '../src/config/paths.mjs'
import { ENUMS } from '../src/trackers/registry.mjs'

const AT = '2026-03-14T10:00:00Z'
const LATER = '2026-03-14T12:00:00Z'
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-manifest-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
// A tracker-issue sweep needs a tracker: its work-list is read with op-26.
const TRACKER = { id: 'example-tracker', mode: 'mcp' }
const fresh = (over = {}) => emptyManifest({
  sweepId: 'ABC-1234', input: { kind: 'tracker-issue', ref: 'ABC-1234' }, mode: 'local', width: 'auto',
  repoKey: 'github.com/acme/app', baseBranch: 'main', snapshotSha: 'a'.repeat(40), at: AT, tracker: TRACKER, ...over,
})
/** The PR-set input exactly as the planner classifies it — `{kind, prs}`, no `ref`. */
const PR_SET = classifyInput({ items: ['100', '101', '102'] }, null).input
const counts = (over = {}) => ({ ...Object.fromEntries(COUNT_KEYS.map(k => [k, 0])), ...over })

// ---- shape + round trip -------------------------------------------------------------------------

test('emptyManifest is the plan\'s shape, validates, and round-trips through disk byte-for-byte', t => {
  const m = fresh()
  assert.equal(m.v, MANIFEST_V)
  assert.equal(m.status, 'planning')
  assert.deepEqual(m.input, { kind: 'tracker-issue', ref: 'ABC-1234' })
  assert.deepEqual(m.repo, { key: 'github.com/acme/app', baseBranch: 'main', snapshotSha: 'a'.repeat(40) })
  assert.deepEqual([m.mode, m.width, m.createdAt, m.updatedAt], ['local', 'auto', AT, AT])
  // every id resolves later — null now, never a name
  assert.deepEqual(m.tracker, {
    id: 'example-tracker', mode: 'mcp', group: null, workItems: 'ABC-1234', umbrella: null,
    triage: { state: null, label: null }, ready: { state: null, label: null },
    provenanceLabel: null, assignee: null, labels: {},
  })
  assert.deepEqual(m.gate, { autoPromote: 'never', promotedAt: null, promotedKeys: [] })
  assert.deepEqual(m.capture, { mode: 'local', pool: null, attachStrategy: null, assetsBranch: null })
  assert.deepEqual(m.slices, [])
  assert.deepEqual(m.counts, { worklist: 0, filed: 0, clean: 0, skipped: 0, failed: 0, noUi: 0, noScreenshot: 0, a11yForcedLow: 0 })
  assert.deepEqual(m.audit, { status: 'pending', runs: [] })
  // emptyManifest already threw if it were invalid; what matters is that a mutation is caught
  assert.match(validateManifest({ ...m, status: 'done' }).errors.join('\n'), /^status: must be one of planning\|running\|complete, got "done"/m)

  const dir = path.join(tmp(t), 'sweep')
  const file = writeManifest(dir, m)
  assert.equal(file, path.join(dir, 'manifest.json'))
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(m, null, 2) + '\n', 'what was validated is what is on disk, byte for byte')
  assert.deepEqual(readManifest(dir), m)
  assert.deepEqual(fs.readdirSync(dir), ['manifest.json'], 'no temp file left after a successful write')
})

test('the planner\'s partial blocks overlay the defaults; a PR-set sweep keeps its PR list and has no work-items key', () => {
  assert.deepEqual(PR_SET, { kind: 'prs', prs: ['100', '101', '102'] }, 'the fixture is what classifyInput produces')
  const m = emptyManifest({
    sweepId: 'prs-0a1b2c3d', input: PR_SET, mode: 'cloud', width: 8,
    baseBranch: 'main', at: AT,
    tracker: { id: 'example-tracker', mode: 'mcp', provenanceLabel: 'filed-by:fleet-check', assignee: 'me', triage: { state: 'st_triage' } },
    gate: { autoPromote: 'after-audit' },
    capture: { mode: 'cloud', attachStrategy: 'assets-branch', assetsBranch: 'assets-prs-0a1b2c3d' },
  })
  assert.deepEqual(m.input, PR_SET, 'the input block is the classified input — a resumed PR-set sweep still knows its PRs')
  assert.notEqual(m.input.prs, PR_SET.prs, 'a copy, never the caller\'s array')
  // a PR given as a URL: classifyInput adds `urls`, and the block is the classified input INCLUDING it
  const PR_URLS = classifyInput({ items: ['https://github.com/acme/app/pull/100', '#101'] }, null, { repoKey: 'github.com/acme/app' }).input
  assert.deepEqual(PR_URLS, { kind: 'prs', prs: ['100', '101'], urls: { 100: 'https://github.com/acme/app/pull/100' } }, 'the fixture is what classifyInput produces for a URL argument')
  const u = emptyManifest({ sweepId: 'prs-0a1b2c3d', input: PR_URLS, mode: 'local', baseBranch: 'main', at: AT })
  assert.deepEqual(u.input, PR_URLS, 'the URLs survive — a manifest that dropped them would hand a resumed sweep the bare numbers')
  assert.notEqual(u.input.urls, PR_URLS.urls, 'a copy, never the caller\'s object')
  assert.equal(Object.hasOwn(m.input, 'urls'), false, 'no `urls` key is minted for a sweep that had none — the block is the input, not a template')
  assert.equal(m.tracker.workItems, null)
  assert.equal(m.tracker.id, 'example-tracker')
  assert.equal(m.tracker.umbrella, null, 'an overlay never pre-fills an id the planner has not resolved')
  assert.deepEqual(m.tracker.triage, { state: 'st_triage', label: null }, 'a partial nested block keeps its sibling key — a dropped `label` would read as damage')
  assert.deepEqual(m.tracker.ready, { state: null, label: null })
  assert.equal(m.gate.autoPromote, 'after-audit')
  assert.equal(m.capture.attachStrategy, 'assets-branch')
  assert.equal(m.repo.key, null)
  // a plan cannot mint an invalid manifest
  assert.throws(() => fresh({ mode: 'remote' }), /mode: must be one of local\|sessions\|cloud/)
  const prSweep = over => emptyManifest({ sweepId: 'prs-0a1b2c3d', mode: 'local', baseBranch: 'main', at: AT, ...over })
  assert.throws(() => prSweep({ input: { kind: 'prs' } }), /input\.prs: a PR-set sweep must list its PR numbers/)
  assert.throws(() => prSweep({ input: { kind: 'prs', prs: [100, '101'] } }), /input\.prs: a PR-set sweep must list its PR numbers as digit strings/)
  assert.throws(() => prSweep({ input: { kind: 'prs', prs: ['100', '100'] } }), /input\.prs: must be unique/)
  assert.throws(() => prSweep({ input: { kind: 'file' } }), /input\.ref: required/)
  // a tracker-issue sweep cannot run tracker-less: the planner refuses it, and so does the manifest
  assert.throws(() => fresh({ tracker: {} }), /tracker\.mode: a tracker-issue sweep needs a tracker/)
})

// ---- validation --------------------------------------------------------------------------------

test('validateManifest names the field for every enum and type it rejects', () => {
  const bad = fresh()
  bad.v = 2
  bad.status = 'done'
  bad.input = { kind: 'branch', ref: '' }
  bad.repo = { key: 'github.com/acme/app', baseBranch: '', snapshotSha: 7 }
  bad.width = 0
  bad.tracker.mode = 'rest'
  bad.tracker.labels = { triage: 42 }
  bad.gate.autoPromote = 'immediate'
  bad.gate.promotedAt = '12'   // Date.parse('12') is a finite date; it is not a timestamp
  bad.gate.promotedKeys = 'ABC-1'
  bad.capture.mode = 'remote'
  bad.audit.status = 'skipped'
  bad.audit.runs = [{ at: AT }]
  bad.createdAt = '1'
  bad.updatedAt = 'yesterday'
  const { ok, errors } = validateManifest(bad)
  assert.equal(ok, false)
  const fields = errors.map(e => e.split(':')[0])
  for (const f of ['v', 'status', 'input.kind', 'input.ref', 'repo.baseBranch', 'repo.snapshotSha', 'width', 'tracker.mode', 'tracker.labels["triage"]', 'gate.autoPromote', 'gate.promotedAt', 'gate.promotedKeys', 'capture.mode', 'audit.status', 'audit.runs[0]', 'createdAt', 'updatedAt']) {
    assert.ok(fields.includes(f), `expected an error on ${f}; got ${JSON.stringify(fields)}`)
  }
  assert.deepEqual(validateManifest(null), { ok: false, errors: ['manifest: not an object'] })
})

test('a manifest that LOST a key is damaged, not "resolved to null" — every deleted field is named', () => {
  const m = fresh()
  delete m.tracker.umbrella
  delete m.tracker.assignee
  delete m.tracker.triage.label
  delete m.repo.key
  delete m.capture.attachStrategy
  delete m.gate.promotedAt
  const { ok, errors } = validateManifest(m)
  assert.equal(ok, false)
  for (const f of ['tracker.umbrella', 'tracker.assignee', 'tracker.triage.label', 'repo.key', 'capture.attachStrategy', 'gate.promotedAt']) {
    assert.ok(errors.some(e => e.startsWith(`${f}: missing`)), `expected "${f}: missing"; got ${JSON.stringify(errors)}`)
  }
  assert.equal(errors.length, 6, 'nothing else is reported for a key that is merely missing')

  // "" is a fourth state the header's "null = unresolved, absent = damaged" model does not have: the
  // planner's have() (!= null) would read it as resolved and never re-emit the op, and a worker
  // would pass group: "" to op-13. Every by-id field refuses it, not just the label ids.
  const e = fresh()
  e.tracker.group = ''
  e.tracker.umbrella = ''
  e.tracker.assignee = ''
  e.tracker.triage.state = ''
  e.repo.key = ''
  e.capture.pool = ''
  const empties = validateManifest(e)
  assert.equal(empties.ok, false)
  for (const f of ['tracker.group', 'tracker.umbrella', 'tracker.assignee', 'tracker.triage.state', 'repo.key', 'capture.pool']) {
    assert.ok(empties.errors.some(x => x.startsWith(`${f}: "" is neither resolved nor null`)), `expected "${f}" to refuse ""; got ${JSON.stringify(empties.errors)}`)
  }
  assert.equal(empties.errors.length, 6)
})

test('"auto" is a config value, not a strategy — a manifest carrying it makes the worker improvise', () => {
  const m = fresh()
  m.capture.attachStrategy = 'auto'
  assert.match(validateManifest(m).errors.join('\n'), /capture\.attachStrategy: "auto" is a config value/)
  // the manifest holds what chooseStrategy() resolved — the adapter's op-22 vocabulary, which is what
  // a worker executes; the config's short spelling ("native", "attachment") is not a resolved strategy
  for (const s of ['native-upload', 'assets-branch', 'attachment-only', 'none', null]) {
    m.capture.attachStrategy = s
    assert.equal(validateManifest(m).ok, true, String(s))
  }
  for (const s of ['native', 'attachment']) {
    m.capture.attachStrategy = s
    assert.match(validateManifest(m).errors.join('\n'), /capture\.attachStrategy: must be one of native-upload\|assets-branch\|attachment-only\|none or null/, s)
  }
  // the manifest's vocabulary IS the adapter's (registry ENUMS.strategy) — a drift would only show as a golden string otherwise
  assert.deepEqual(ATTACH_STRATEGIES, ENUMS.strategy)
  assert.deepEqual(ATTACH_STRATEGIES, ['native-upload', 'assets-branch', 'attachment-only', 'none'])
  // null is "not yet chosen" — a state only a planning sweep can be in: chooseStrategy runs once, at
  // plan time, and a running sweep carrying null hands the worker the choice
  m.capture.attachStrategy = null
  for (const s of ['running', 'complete']) {
    m.status = s
    assert.match(validateManifest(m).errors.join('\n'), new RegExp(`capture\\.attachStrategy: resolved at plan time — null on a ${s} sweep is a lost key`), s)
  }
  m.capture.attachStrategy = 'none'
  m.status = 'running'
  assert.equal(validateManifest(m).ok, true)
  // a cloud sweep captures in the sandbox: the planner refuses the other combination, so a manifest carrying it is damage
  m.mode = 'cloud'
  assert.match(validateManifest(m).errors.join('\n'), /capture\.mode: a cloud sweep captures in the sandbox — must be cloud, got "local"/)
  m.capture.mode = 'cloud'
  assert.equal(validateManifest(m).ok, true)
  m.capture.mode = 'remote'
  assert.equal(validateManifest(m).errors.filter(e => e.startsWith('capture.mode')).length, 1, 'an unknown capture mode is one error, not two')
})

test('slices: no fid separator in a name, digit-string PRs only, names unique, and a PR in ONE slice', () => {
  const m = fresh()
  m.slices = [{ slice: 'a01', prs: ['100', '101'] }, { slice: 'a|02', prs: ['102'] }, { prs: [] }]
  const errors = validateManifest(m).errors
  assert.match(errors.join('\n'), /slices\[1\]\.slice: "a\|02" must not contain "\|"/)
  assert.match(errors.join('\n'), /slices\[2\]: must be \{slice, prs\[\]\}/)
  assert.equal(errors.length, 2)
  // junk elements: String(null) is "null", a non-empty string — the check has to look at the element
  for (const junk of [null, undefined, {}, [], 42, true, -1, 'x y', '', '#100']) {
    m.slices = [{ slice: 'a01', prs: [junk] }]
    assert.match(validateManifest(m).errors.join('\n'), /slices\[0\]\.prs: must be a list of PR numbers \(digit strings\)/, String(junk))
  }
  // a slice is a file segment (filed/<slice>.tsv), a branch segment (check/{sweepId}/{slice}) and an
  // env value (FLEET_SLICE): the sweepId's shape, or `../x` escapes the sweep dir the same way
  for (const bad of ['../x', '..', 'a/b', 'a\\b', 'a b', '.hidden', 'a:b']) {
    m.slices = [{ slice: bad, prs: ['100'] }]
    const errors = validateManifest(m).errors
    assert.match(errors.join('\n'), /slices\[0\]\.slice: ".*" must be a plain file-name segment/, bad)
    assert.equal(errors.length, 1, bad)
  }
  for (const ok of ['a01', 'b', 'slice_1.2', 'A-9']) {
    m.slices = [{ slice: ok, prs: ['100'] }]
    assert.equal(validateManifest(m).ok, true, ok)
  }
  m.slices = [{ slice: 'a01', prs: ['100'] }, { slice: 'a01', prs: ['101'] }]
  assert.match(validateManifest(m).errors.join('\n'), /slices\[1\]\.slice: "a01" is already a slice/)
  m.slices = [{ slice: 'a01', prs: ['100', '101'] }, { slice: 'a02', prs: ['101', '102'] }]
  assert.match(validateManifest(m).errors.join('\n'), /slices\[1\]\.prs: PR 101 is already in slice "a01" — a PR in two slices is filed twice/)
  m.slices = [{ slice: 'a01', prs: ['100', '101'] }, { slice: 'a02', prs: ['102'] }]
  assert.equal(validateManifest(m).ok, true)
})

test('counts are the playbook\'s §8.5 names, and a retried PR counted twice cannot report more done than the worklist holds', () => {
  // no-UI skips and no-screenshot failures are counted SEPARATELY (§7.5) — one "unattached" cannot stand in for both
  assert.deepEqual(COUNT_KEYS, ['worklist', 'filed', 'clean', 'skipped', 'failed', 'noUi', 'noScreenshot', 'a11yForcedLow'])
  const m = fresh()
  m.counts = counts({ worklist: 3, filed: 2, clean: 1, failed: 1, noUi: 1 })
  assert.match(validateManifest(m).errors.join('\n'), /filed\+clean\+skipped\+failed \(4\) exceeds worklist \(3\)/)
  m.counts.failed = 0
  assert.equal(validateManifest(m).ok, true)
  m.counts.noScreenshot = -1
  assert.match(validateManifest(m).errors.join('\n'), /counts\.noScreenshot: must be a non-negative integer/)
  delete m.counts.noScreenshot
  assert.match(validateManifest(m).errors.join('\n'), /counts\.noScreenshot: must be a non-negative integer/)

  // "checked against the worklist" means the REAL one: for a PR set the input list, and for every
  // kind the slices — a self-reported counts.worklist that agrees with neither is not a check
  const p = emptyManifest({ sweepId: 'prs-0a1b2c3d', input: { kind: 'prs', prs: ['100', '101'] }, mode: 'local', baseBranch: 'main', at: AT })
  p.slices = [{ slice: 'a01', prs: ['100', '101', '102'] }]
  p.counts = counts({ worklist: 1, filed: 1 })
  const errors = validateManifest(p).errors
  assert.match(errors.join('\n'), /slices\[0\]\.prs: PR 102 is not in input\.prs — a PR-set sweep slices exactly the PRs it was given/)
  assert.match(errors.join('\n'), /counts\.worklist: 1, but the slices hold 3 PRs — the slices partition the work-list/)
  assert.match(errors.join('\n'), /counts\.worklist: 1, but input\.prs lists 2 PRs — a PR-set sweep's work-list is its input/)
  assert.equal(errors.length, 3)
  // the planner slices a PR set before the work-list is written: slices with worklist 0 are a plan, not a lie
  p.slices = [{ slice: 'a01', prs: ['100', '101'] }]
  p.counts = counts()
  assert.equal(validateManifest(p).ok, true)
  p.counts = counts({ worklist: 2, filed: 2 })
  assert.equal(validateManifest(p).ok, true)
  // a tracker-issue sweep has no input list to check against, but its slices still cannot outgrow the work-list
  m.counts = counts({ worklist: 2 })
  m.slices = [{ slice: 'a01', prs: ['100', '101'] }, { slice: 'a02', prs: ['102'] }]
  assert.match(validateManifest(m).errors.join('\n'), /counts\.worklist: 2, but the slices hold 3 PRs/)
  m.counts.worklist = 3
  assert.equal(validateManifest(m).ok, true)
})

test('a complete sweep has resolved every PR and records the snapshot it was verified against', () => {
  const m = fresh({ capture: { attachStrategy: 'native-upload' } })
  m.status = 'complete'
  m.counts = counts({ worklist: 3, filed: 2, noScreenshot: 1 })
  m.repo.snapshotSha = null
  const errors = validateManifest(m).errors
  assert.match(errors.join('\n'), /counts: a complete sweep must have resolved every PR \(2 of 3\)/)
  assert.match(errors.join('\n'), /repo\.snapshotSha: a complete sweep must record the base-branch snapshot/)
  m.counts.clean = 1
  m.repo.snapshotSha = 'b'.repeat(40)
  assert.equal(validateManifest(m).ok, true)
  // a running sweep with nothing resolved yet is fine — as long as it left planning with its strategy chosen
  assert.equal(validateManifest({ ...fresh({ capture: { attachStrategy: 'none' } }), status: 'running' }).ok, true)
})

test('a tracker-issue sweep must mirror onto its input key — a lost pointer never ticks', () => {
  const m = fresh()
  m.tracker.workItems = null
  assert.match(validateManifest(m).errors.join('\n'), /tracker\.workItems: a tracker-issue sweep must mirror onto its input key "ABC-1234", got null/)
  m.tracker.workItems = 'ABC-1234'
  assert.equal(validateManifest(m).ok, true)
})

test('tracker.mode mcp|manual with no tracker.id is a lost key — the planner writes mode none whenever there is no id', () => {
  const m = fresh()
  for (const mode of ['mcp', 'manual']) {
    m.tracker.mode = mode
    m.tracker.id = null
    assert.match(validateManifest(m).errors.join('\n'), /tracker\.id: required when tracker\.mode is mcp\|manual — a tracker-less sweep has mode none/, mode)
    m.tracker.id = 'example-tracker'
    assert.equal(validateManifest(m).ok, true, mode)
  }
  // a tracker-less PR-set sweep is the legitimate null: mode none, no id
  const none = emptyManifest({ sweepId: 'prs-0a1b2c3d', input: PR_SET, mode: 'local', baseBranch: 'main', at: AT })
  assert.deepEqual([none.tracker.mode, none.tracker.id], ['none', null])
  // an unknown mode is one error, not one plus a missing-id complaint
  m.tracker.mode = 'rest'
  m.tracker.id = null
  assert.equal(validateManifest(m).errors.filter(e => e.startsWith('tracker.')).length, 1)
})

test('cross-field: the audit follows finish, one entry per auditRunId, and a timestamp has the ISO shape WITH a zone', () => {
  const m = fresh({ capture: { attachStrategy: 'native-upload' } })
  m.audit.status = 'running'
  assert.match(validateManifest(m).errors.join('\n'), /audit\.status: running on a "planning" sweep — the audit runs on the finished corpus/)
  m.status = 'complete'
  assert.equal(validateManifest(m).ok, true)
  m.audit.runs = [{ auditRunId: 'aud_1' }, { auditRunId: 'aud_1' }]
  assert.match(validateManifest(m).errors.join('\n'), /audit\.runs\[1\]\.auditRunId: "aud_1" is already a run/)
  m.audit.runs = [{ auditRunId: 'aud_1' }, { auditRunId: 'aud_2' }]
  assert.equal(validateManifest(m).ok, true)
  // Date.parse accepts '1' and '12', and resolves a zone-less '2026-03-14T10:00' as LOCAL time — an
  // instant that depends on the machine reading the manifest; a timestamp is the zoned ISO shape or nothing
  for (const bad of ['1', '12', '2026-03-14', 'yesterday', 20260314, '2026-03-14T10:00', '2026-03-14T10:00:00', '2026-03-14T10:00:00.000', '2026-13-45T10:00:00Z']) {
    m.updatedAt = bad
    assert.match(validateManifest(m).errors.join('\n'), /updatedAt: must be an ISO timestamp/, String(bad))
  }
  for (const ok of ['2026-03-14T12:00:00.000Z', '2026-03-14T12:00Z', '2026-03-14T12:00:00+02:00', '2026-03-14T12:00:00-05:00']) {
    m.updatedAt = ok
    assert.equal(validateManifest(m).ok, true, ok)
  }
})

// ---- resume ------------------------------------------------------------------------------------

test('mergeOnResume keeps the resolved ids, umbrella, slices, counts, snapshot AND mode; status, updatedAt, width and autoPromote move', () => {
  const existing = fresh()
  existing.status = 'running'
  existing.width = 12
  existing.tracker = {
    ...existing.tracker,
    group: 'grp_01', umbrella: 'ABC-1300', assignee: 'usr_ada',
    triage: { state: 'st_triage', label: 'triage' }, ready: { state: 'st_todo', label: null },
    provenanceLabel: 'filed-by:fleet-check', labels: { 'filed-by:fleet-check': 'lbl_1', triage: 'lbl_2', 'gate:pending': 'lbl_3' },
  }
  existing.capture = { mode: 'local', pool: 'testing', attachStrategy: 'native-upload', assetsBranch: null }
  existing.slices = [{ slice: 'a01', prs: ['100', '101'] }]
  existing.counts = counts({ worklist: 2, filed: 1, noUi: 1 })
  existing.repo.snapshotSha = 'c'.repeat(40)

  // the re-run resolved nothing and arrives narrower, with --auto, in a different mode, with a different snapshot
  const rerun = fresh({ mode: 'sessions', width: 4, at: LATER, snapshotSha: 'd'.repeat(40), gate: { autoPromote: 'after-audit' } })
  const { manifest: merged, warnings } = mergeOnResume(existing, rerun)
  assert.deepEqual([merged.status, merged.updatedAt, merged.createdAt], ['running', LATER, AT])
  assert.equal(merged.mode, 'local', 'mode decides who files — flipped mid-sweep, half the worklist sits in outbox entries')
  // the plan.mode-ignored warning is planSweep's alone: it decides the mode from the existing manifest
  // BEFORE building the fresh one, so the merge keeps the mode silently rather than reporting it twice
  assert.deepEqual(warnings, [], 'one owner per warning code')
  assert.equal(merged.width, 4, 'width is the per-run pacing knob — a sweep that OOM\'d resumes narrower')
  assert.equal(merged.gate.autoPromote, 'after-audit', '--auto is for THIS run')
  assert.deepEqual(merged.tracker, existing.tracker, 'the group pointer is never re-resolved mid-sweep')
  assert.deepEqual(merged.capture, existing.capture)
  assert.deepEqual(merged.slices, existing.slices)
  assert.deepEqual(merged.counts, existing.counts)
  assert.equal(merged.repo.snapshotSha, 'c'.repeat(40), 'the snapshot the findings were judged against stays')
  assert.equal(validateManifest(merged).ok, true)
  assert.deepEqual(mergeOnResume(existing, fresh({ at: LATER })).warnings, [], 'the same mode is not a mismatch')

  // a copy, never an alias
  merged.tracker.group = 'grp_99'
  assert.equal(existing.tracker.group, 'grp_01')

  // planning resumes into running; complete stays complete (there is no other state — nothing writes one)
  assert.equal(mergeOnResume({ ...existing, status: 'planning' }, rerun).manifest.status, 'running')
  const done = { ...existing, status: 'complete', counts: { ...existing.counts, clean: 1 } }
  assert.equal(mergeOnResume(done, rerun).manifest.status, 'complete')

  assert.throws(() => mergeOnResume(existing, { ...rerun, sweepId: 'ABC-9' }), /sweepId mismatch/)
  assert.throws(() => mergeOnResume(null, rerun), /sweepId mismatch/)
})

// ---- layout ------------------------------------------------------------------------------------

test('sweepLayout returns every path of contract §4 under <stateDir>/sweeps/<sweepId>', () => {
  const L = sweepLayout('/state', 'ABC-1234', 'linux')
  assert.equal(L.dir, path.posix.join(stateLayout('/state', 'linux').sweeps, 'ABC-1234'))
  const expected = {
    manifest: 'manifest.json', worklist: 'worklist.tsv', ledger: 'ledger.tsv', slices: 'slices', filed: 'filed',
    findings: 'findings', findingsJsonl: 'findings.jsonl', dups: 'dups.tsv', xref: 'xref.tsv', shots: 'shots',
    sweep: '_sweep', outbox: 'outbox', audit: 'audit', resume: 'RESUME.md',
  }
  for (const [k, name] of Object.entries(expected)) assert.equal(L[k], path.posix.join(L.dir, name), k)
  assert.deepEqual(Object.keys(L).sort(), ['dir', ...Object.keys(expected)].sort())
  for (const k of SWEEP_DIRS) assert.ok(L[k], k)
  // platform-correct separators
  const W = sweepLayout('C:\\state', 'prs-0a1b2c3d', 'win32')
  assert.equal(W.manifest, 'C:\\state\\sweeps\\prs-0a1b2c3d\\manifest.json')
  // PURE: the platform is injected, never read from the process — the expected value must not change with the CI runner
  assert.throws(() => sweepLayout('/state', 'ABC-1234'), /platform is required/)
  assert.throws(() => fresh({ at: undefined }), /createdAt: must be an ISO timestamp/, 'the clock is injected too')
})

test('a sweepId is a plain directory name — a separator would escape the sweeps dir', () => {
  for (const ok of ['ABC-1234', 'prs-0a1b2c3d', 'file-9f8e7d6c', 'ABC_1.2']) assert.equal(assertSweepId(ok), ok)
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '', null, 'ABC 1']) {
    assert.throws(() => sweepLayout('/state', bad, 'linux'), /must be a plain directory name/, String(bad))
  }
  assert.throws(() => fresh({ sweepId: 'ABC/1234' }), /must be a plain directory name/)
})

// ---- atomic write ------------------------------------------------------------------------------

test('writeManifest is atomic: a failed rename leaves no temp file behind and the error propagates', t => {
  const dir = path.join(tmp(t), 'sweep')
  // rename() cannot replace a non-empty directory on any platform (EISDIR / EPERM) — the temp file
  // was already written by then, which is exactly the leak the cleanup must remove
  fs.mkdirSync(path.join(dir, 'manifest.json'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json', 'occupied'), '')
  assert.throws(() => writeManifest(dir, fresh()), e => ['EISDIR', 'EPERM', 'EEXIST', 'ENOTEMPTY'].includes(e.code))
  assert.deepEqual(fs.readdirSync(dir), ['manifest.json'])
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
})

test('writeManifest refuses an invalid manifest before touching the disk', t => {
  const dir = path.join(tmp(t), 'sweep')
  const m = fresh()
  m.status = 'done'
  assert.throws(() => writeManifest(dir, m), /refusing to write an invalid manifest — status: must be one of/)
  assert.equal(fs.existsSync(dir), false)
})

test('a rewrite replaces the file in place and a reader never sees the old temp names', t => {
  const dir = path.join(tmp(t), 'sweep')
  const m = fresh()
  writeManifest(dir, m)
  const next = { ...m, status: 'running', updatedAt: LATER, capture: { ...m.capture, attachStrategy: 'native-upload' } }
  writeManifest(dir, next)
  assert.deepEqual(readManifest(dir), next)
  assert.deepEqual(fs.readdirSync(dir), ['manifest.json'])
})

// ---- read --------------------------------------------------------------------------------------

test('readManifest: absent is null (a fresh sweep); damaged or invalid THROWS — never "no sweep here"', t => {
  const dir = path.join(tmp(t), 'sweep')
  assert.equal(readManifest(dir), null)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"v": 1, "sweepId": "ABC-12')   // a crash mid-write of a naive writer
  assert.throws(() => readManifest(dir), /not valid JSON .* do not re-plan over it/)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...fresh(), v: 0 }))
  assert.throws(() => readManifest(dir), /invalid manifest — v: expected 1/)
  fs.writeFileSync(path.join(dir, 'manifest.json'), '')   // the crash landed before the first byte
  assert.throws(() => readManifest(dir), /not valid JSON .* do not re-plan over it/)
  // valid JSON that is not an object is invalid, not "no sweep here"
  for (const text of ['null', '[]', '"x"', '42']) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), text)
    assert.throws(() => readManifest(dir), /invalid manifest — manifest: not an object/, text)
  }
  fs.rmSync(path.join(dir, 'manifest.json'))
  // a leaked temp file beside a MISSING manifest.json is a write that never landed: the manifest was
  // never there, so this is a fresh sweep — the leak is noise, not a manifest
  fs.writeFileSync(path.join(dir, `.manifest.json.${process.pid}.0.tmp`), JSON.stringify(fresh()))
  assert.equal(readManifest(dir), null)
  fs.rmSync(path.join(dir, `.manifest.json.${process.pid}.0.tmp`))
  fs.mkdirSync(path.join(dir, 'manifest.json'))   // something else took the name
  assert.throws(() => readManifest(dir), e => e.code === 'EISDIR')
})

// ---- ensureSweepDir + RESUME.md ----------------------------------------------------------------

test('ensureSweepDir creates the contract tree and writes RESUME.md ONCE — a resume never erases the finished mark', t => {
  const stateDir = tmp(t)
  const L = ensureSweepDir(stateDir, 'ABC-1234')
  assert.equal(L.dir, path.join(stateDir, 'sweeps', 'ABC-1234'))
  assert.equal(L.manifest, path.join(stateDir, 'sweeps', 'ABC-1234', 'manifest.json'))
  assert.equal(L.resume, path.join(stateDir, 'sweeps', 'ABC-1234', 'RESUME.md'))
  for (const k of SWEEP_DIRS) assert.ok(fs.statSync(L[k]).isDirectory(), k)
  assert.deepEqual(fs.readdirSync(L.dir).sort(), ['RESUME.md', '_sweep', 'audit', 'filed', 'findings', 'outbox', 'shots', 'slices'])
  // no manifest yet: the planner writes it; the tree existing is not "a resume"
  assert.equal(readManifest(L.dir), null)

  const text = fs.readFileSync(L.resume, 'utf8')
  assert.equal(text, renderResumeMd('ABC-1234'))
  // the three files, in order
  const order = ['`manifest.json`', '`worklist.tsv`', '`ledger.tsv`'].map(s => text.indexOf(s))
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], 'the three files, in reading order')
  // the three counts, and the one reading that is a stop
  for (const s of ['`worklist=`', '`done=`', '`remaining=`']) assert.ok(text.includes(s), s)
  assert.match(text, /⛔ A `done` of 0 on a non-empty ledger means the ledger did not load — not that no work was done/)
  assert.match(text, /fleet check ledger resume --json/)
  assert.match(text, /op-16 findIssues/)
  assert.match(text, /never write the ledger by hand/)
  // it speaks in the contract's vocabulary: no literal paths, only the env / payload pointer
  assert.match(text, /FLEET_SWEEP_DIR/)
  assert.doesNotMatch(text, /[A-Z]:\\|\/tmp\//)

  fs.appendFileSync(L.resume, '\n## Finished 2026-03-14\n')
  ensureSweepDir(stateDir, 'ABC-1234')
  assert.match(fs.readFileSync(L.resume, 'utf8'), /## Finished 2026-03-14/)
})

test('a 0-byte RESUME.md is a crashed write, not a written one — it is regenerated atomically; a finished one is left alone; a directory is damage', t => {
  const stateDir = tmp(t)
  const L = ensureSweepDir(stateDir, 'ABC-1234')
  fs.writeFileSync(L.resume, '')
  ensureSweepDir(stateDir, 'ABC-1234')
  assert.equal(fs.readFileSync(L.resume, 'utf8'), renderResumeMd('ABC-1234'), 'the one file a context-less session reads first cannot stay empty')
  assert.deepEqual(fs.readdirSync(L.dir).filter(f => f.endsWith('.tmp')), [], 'temp + rename: no temp file left behind')
  fs.appendFileSync(L.resume, '\n## Finished 2026-03-14\n')
  ensureSweepDir(stateDir, 'ABC-1234')
  assert.match(fs.readFileSync(L.resume, 'utf8'), /## Finished 2026-03-14/)
  // a directory under the name reports a size (4096 on ext4/APFS, 0 on Windows): neither "written"
  // nor "regenerate over it" is right, so it is named as damage — and no temp file is left behind
  fs.rmSync(L.resume)
  fs.mkdirSync(L.resume)
  fs.writeFileSync(path.join(L.resume, 'occupied'), '')
  assert.throws(() => ensureSweepDir(stateDir, 'ABC-1234'), /RESUME\.md: is a directory — something else took the name/)
  assert.ok(fs.statSync(L.resume).isDirectory(), 'left as found')
  assert.deepEqual(fs.readdirSync(L.dir).filter(f => f.endsWith('.tmp')), [])
})
