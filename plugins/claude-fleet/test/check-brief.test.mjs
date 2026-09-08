import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderBrief, briefChecklist, permissions, sliceLayout, MODES, BRIEF_SECTIONS } from '../src/check/brief.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { readPatterns, readHashes, hashToken, tokensOf } from './helpers/prose.mjs'

/** A resolved config with a tracker, sensitive paths and routing — every placeholder from contract §1. */
const cfg = (over = {}) => {
  const c = defaultsFor()
  setPath(c, 'repo.name', 'app')
  setPath(c, 'repo.baseBranch', 'main')
  setPath(c, 'tracker.id', 'example-tracker')
  setPath(c, 'tracker.mode', 'mcp')
  setPath(c, 'vcs.sensitivePaths', ['**/.env*', 'example/secrets/**'])
  setPath(c, 'checker.routing', [{ paths: ['example/app/**'], assignee: 'ada@example.com' }])
  setPath(c, 'capture.requiredEnv', ['EXAMPLE_TOKEN'])
  setPath(c, 'paths.stateDir', '/state/app')
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}

const CAPS = { subIssues: true, attachLink: true, relations: true, labels: true, createIssue: true }
const SWEEP = { sweepId: 'ABC-1234', slice: 'a01', prs: [1240] }
const STATE = '/state/app'
const PLAYBOOK = '/plugin/playbooks/check.md'
const ADAPTER = '/plugin/trackers/example-tracker.md'

const brief = (mode, over = {}) => renderBrief({
  mode, capabilities: CAPS, config: cfg(), sweep: SWEEP, stateDir: STATE, adapterPath: ADAPTER, playbookPath: PLAYBOOK, platform: 'linux', ...over,
})

const section = (text, heading) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `section "${heading}" missing`)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^#{1,2} /m)
  return rest.slice(0, next === -1 ? rest.length : next)
}

// ---- completeness ------------------------------------------------------------------------------

// The brief is handed over verbatim, and every section in it is a rule that was once skipped when
// it lived only in a playbook. Each mode must carry all of them, in BRIEF_SECTIONS order (`present`
// is pushed in BRIEF_SECTIONS order whatever the text's order, so `ordered` alone carries that claim).
test('every required section is present, in order, in every mode', () => {
  for (const mode of MODES) {
    const b = brief(mode)
    const c = briefChecklist(b)
    assert.deepEqual(c.missing, [], `${mode}: ${JSON.stringify(c.sections)}`)
    assert.equal(c.present.length, BRIEF_SECTIONS.length, mode)
    assert.equal(c.ordered, true, mode)
    assert.equal(c.ok, true, mode)
  }
})

// Workers once returned raw diffs, forge output and image bytes; the bulk that should have died
// inside the worker took the orchestrator down. So the return shape is the FIRST section read.
test('the compact-report contract comes first and forbids diffs, tool output and image bytes', () => {
  const b = brief('local')
  const report = b.indexOf('## Return ONLY this')
  assert.ok(report >= 0 && report < b.indexOf('## You MAY / you MAY NOT'))
  const s = section(b, '## Return ONLY this')
  assert.match(s, /outcome: filed \| clean \| skipped \| failed/)
  assert.match(s, /- filed: \[\{fid, key, url, priority, a11y\}\]/)
  assert.match(s, /- dropped: .*the PR that already addressed each/)
  assert.match(s, /- screenshots: \{attached: N, noUi: N, noShot: N\}/)
  assert.match(s, /"no source files touched"/)
  assert.match(s, /No raw diffs\. No tool output\. No image bytes\./)
  // a cloud worker has no key or url to report — the orchestrator creates the issue on drain
  assert.match(section(brief('cloud'), '## Return ONLY this'), /- filed: \[\{fid, outbox: <entry file>, priority, a11y\}\]/)
})

// ---- MAY / MAY NOT -----------------------------------------------------------------------------

// A sandbox has neither the tracker connection nor the forge CLI, and a worker that tries either
// HANGS rather than fails. It is handed no adapter path at all — not an adapter plus a prohibition.
test('cloud workers get no tracker access: every tracker row is MAY NOT, no adapter path, outbox entries instead', () => {
  const rows = Object.fromEntries(permissions('cloud').map(r => [r.id, r]))
  for (const id of ['create', 'editOwn', 'reconcile', 'forge']) assert.equal(rows[id].may, false, id)
  assert.match(rows.create.note, /createIssue outbox entry/)
  const b = brief('cloud')
  assert.ok(!b.includes(ADAPTER), 'the adapter path must not reach a cloud worker')
  assert.match(section(b, '## Inputs (read, never re-resolve)'), /- adapter: none — a sandbox has neither the tracker connection nor the forge CLI/)
  assert.match(section(b, '## You MAY / you MAY NOT'), /op-13 createIssue for a finding of THIS PR \| MAY NOT — emit a createIssue outbox entry/)
  assert.match(section(b, '## Your fid range and private ledgers'), /- outbox: `\/state\/app\/sweeps\/ABC-1234\/outbox`/)
  assert.match(b, /fleet check harvest ABC-1234/)
  // cloud workers assert required env by NAME only — a printed value is read by everyone
  assert.match(section(b, '## Sensitive paths'), /`EXAMPLE_TOKEN` — assert presence only/)
  assert.ok(!section(brief('local'), '## Sensitive paths').includes('EXAMPLE_TOKEN'))
})

// The old blanket rule "workers never touch the tracker" over-generalised from one incident about
// concurrent edits to a single description; distinct creates parallelise cleanly. The line is
// SHARED STATE, and that stays orchestrator-only in every mode.
test('local and sessions workers may create and edit their own issues; shared-state ops are orchestrator-only everywhere', () => {
  for (const mode of ['local', 'sessions']) {
    const rows = Object.fromEntries(permissions(mode).map(r => [r.id, r]))
    for (const id of ['create', 'editOwn', 'reconcile', 'forge']) assert.equal(rows[id].may, true, `${mode} ${id}`)
  }
  for (const mode of MODES) {
    const rows = Object.fromEntries(permissions(mode).map(r => [r.id, r]))
    for (const id of ['shared', 'recurse', 'edit', 'sensitive']) assert.equal(rows[id].may, false, `${mode} ${id}`)
    // the one thing every worker owns: its own findings, its own rows, its report
    assert.equal(rows.deliver.may, true, `${mode} deliver`)
    assert.match(rows.shared.operation, /op-27 tickWorkItem/)
    assert.match(rows.shared.operation, /a11y umbrella/)
    assert.match(rows.shared.operation, /op-15 patchBody on an issue another agent created/)
    assert.match(rows.shared.operation, /op-21 createProject · op-18 ensureLabel/)
    assert.match(rows.shared.note, /orchestrator only, in every mode/)
    const t = section(brief(mode), '## You MAY / you MAY NOT')
    assert.match(t, /\| spawn another per-PR layer \| MAY NOT/)
  }
  assert.throws(() => permissions('remote'), /unknown mode/)
})

// A tracker-less sweep (tracker.mode: none) has no ops at all: the findings record is the filing.
test('a tracker-less sweep hands out no adapter and no tracker ops', () => {
  const b = brief('local', { config: cfg({ 'tracker.mode': 'none', 'tracker.id': null }), adapterPath: null, capabilities: null })
  assert.match(section(b, '## Inputs (read, never re-resolve)'), /- adapter: none — no tracker configured/)
  assert.match(section(b, '## You MAY / you MAY NOT'), /op-13 createIssue for a finding of THIS PR \| MAY NOT — no tracker configured/)
  assert.equal(briefChecklist(b).ok, true)
  // labels, the umbrella and routing are tracker operations: with no tracker there is no adapter to
  // lack sub-issues, no op-23 fallback and no label to apply — only the a11yClass on the record
  const a11y = section(b, '## a11yClass')
  assert.match(a11y, /Ask WHO IS HARMED/)
  assert.match(a11y, /- labels: none apply — no tracker configured \(`tracker\.mode: none`\)/)
  assert.match(a11y, /- umbrella: none — there is no tracker to parent onto; leave `parent` unset/)
  assert.match(a11y, /- routing: none — there is no tracker to assign in/)
  assert.doesNotMatch(a11y, /a11y: keyboard|adapter has no sub-issues|op-23|checker\.assignee` \(/)
})

// ---- sensitive paths ---------------------------------------------------------------------------

// Four workers once burned 30–45 minutes each on a permission prompt that nothing answers; the
// prohibition must name the actual globs, and an empty list must still state the rule.
test('sensitive paths are rendered from vcs.sensitivePaths with the reason a prompt is fatal', () => {
  const s = section(brief('local'), '## Sensitive paths')
  assert.match(s, /- `\*\*\/\.env\*`/)
  assert.match(s, /- `example\/secrets\/\*\*`/)
  assert.match(s, /park forever with no failure artifact/)
  assert.match(s, /Probe a secret by its LENGTH/)
  assert.match(s, /needs sensitive path <glob>/)
  // the MAY NOT table names them too
  assert.match(section(brief('local'), '## You MAY / you MAY NOT'), /vcs\.sensitivePaths: `\*\*\/\.env\*`, `example\/secrets\/\*\*` \| MAY NOT/)
  const none = section(brief('local', { config: cfg({ 'vcs.sensitivePaths': [] }) }), '## Sensitive paths')
  assert.match(none, /none configured — the rule still stands/)
})

// ---- retryable failures ------------------------------------------------------------------------

// Several workers once slept 20+ minutes each on a per-workspace link rate limit. Left unsaid, a
// conscientious worker burns unbounded wall-clock on a cosmetic field.
test('a per-workspace rate limit is contention — deferred, never retried, never slept on', () => {
  const s = section(brief('local'), '## Retryable failures')
  assert.match(s, /- blocking \(report `outcome: failed` with a note, stop this PR\): op-13 create failing for a reason that is not a write echo · bundle missing or a 0-byte diff · the filed-ledger append failing/)
  assert.match(s, /- cosmetic .*op-8 attachLink · op-22 attachImage · a label add · op-25 relate between sibling findings of this PR · ANY per-workspace rate limit/)
  assert.match(s, /rate limit is contention, not a transient: defer it to the orchestrator, never retry, never sleep on it/)
  assert.match(s, /write echo .*the write usually APPLIED — re-fetch via op-16/)
  // an op the adapter lacks is a skip, not a cosmetic failure to report
  const lacking = section(brief('local', { capabilities: { ...CAPS, relations: false, attachLink: false } }), '## Retryable failures')
  assert.match(lacking, /op-8 attachLink \(adapter lacks it — skip, not a failure\)/)
  assert.match(lacking, /op-25 relate between sibling findings of this PR \(adapter lacks it — skip, not a failure\)/)
  // a cloud worker has no tracker ops to fail, but the rate-limit rule is still stated
  const cloud = section(brief('cloud'), '## Retryable failures')
  assert.doesNotMatch(cloud, /op-8 attachLink/)
  assert.match(cloud, /rate limit is contention, not a transient/)
})

// ---- fid range and ledgers ---------------------------------------------------------------------

// Title similarity mis-scored a quarter of one corpus; the opaque fid is the join key, and its
// range and the private ledger paths come from the state dir (contract §4) — joined per platform,
// never typed.
test('the fid range and private ledger paths are derived from the state dir per platform', () => {
  const b = brief('local')
  assert.match(b, /^# fleet-check worker — PR #1240 · sweep ABC-1234 · slice a01 · fid range a01\|1240\|1\.\.N$/m)
  const s = section(b, '## Your fid range and private ledgers')
  assert.match(s, /fleet check fid mint a01 --count N/)
  assert.match(s, /- filed ledger \(private\): `\/state\/app\/sweeps\/ABC-1234\/filed\/a01\.tsv` — one row `fid → key → url → pr → priority → a11y` immediately after each successful create, never batched/)
  assert.match(s, /- findings: `\/state\/app\/sweeps\/ABC-1234\/findings\/a01\.jsonl`/)
  assert.match(s, /- shots: `\/state\/app\/sweeps\/ABC-1234\/shots\/<fid>\.png`/)
  assert.match(s, /fleet check reconcile filed --json/)

  const win = brief('local', { stateDir: 'C:\\state\\app', platform: 'win32' })
  assert.ok(win.includes('`C:\\state\\app\\sweeps\\ABC-1234\\filed\\a01.tsv`'))
  assert.ok(win.includes('`C:\\state\\app\\sweeps\\ABC-1234\\shots\\<fid>.png`'))
  assert.ok(win.includes('`C:\\state\\app\\sweeps\\ABC-1234\\manifest.json`'))
  assert.ok(win.includes('`C:\\state\\app\\sweeps\\ABC-1234\\_sweep\\prs\\<n>.json`'))
  assert.ok(!win.includes('ABC-1234/'), 'a win32 brief joins no sweep path with a posix separator')

  // a two-PR slice brief owns one range per PR
  const pair = brief('sessions', { sweep: { ...SWEEP, prs: [1240, 1241] } })
  assert.match(pair, /PRs #1240, #1241 · sweep ABC-1234 · slice a01 · fid range a01\|1240\|1\.\.N, a01\|1241\|1\.\.N/)

  // an explicit path from the CLI wins over the derived layout
  const over = brief('local', { paths: { filedSlice: '/elsewhere/filed/a01.tsv' } })
  assert.ok(over.includes('`/elsewhere/filed/a01.tsv`'))
})

// sliceLayout is manifest.sweepLayout() plus what one worker needs: every §4 key keeps its meaning
// there (`filed` and `findings` stay the directories), the per-slice files sit inside them, and the
// bundle names are the ones gh.mjs bundleLayout() writes.
test('sliceLayout keeps the §4 directories and adds the per-slice files and the bundle indexes, per platform', () => {
  const l = sliceLayout('/state/app', 'ABC-1234', 'a01', 'linux')
  assert.equal(l.dir, '/state/app/sweeps/ABC-1234')
  assert.equal(l.filed, '/state/app/sweeps/ABC-1234/filed')
  assert.equal(l.findings, '/state/app/sweeps/ABC-1234/findings')
  assert.equal(l.filedSlice, '/state/app/sweeps/ABC-1234/filed/a01.tsv')
  assert.equal(l.findingsSlice, '/state/app/sweeps/ABC-1234/findings/a01.jsonl')
  assert.equal(l.prs, '/state/app/sweeps/ABC-1234/_sweep/prs')
  assert.equal(l.gate2Index, '/state/app/sweeps/ABC-1234/_sweep/gate2-index.tsv')
  assert.equal(l.openIndex, '/state/app/sweeps/ABC-1234/_sweep/open-index.tsv')
  const w = sliceLayout('C:\\state\\app', 'ABC-1234', 'a01', 'win32')
  assert.equal(w.filedSlice, 'C:\\state\\app\\sweeps\\ABC-1234\\filed\\a01.tsv')
  assert.equal(w.findingsSlice, 'C:\\state\\app\\sweeps\\ABC-1234\\findings\\a01.jsonl')
  assert.equal(w.prs, 'C:\\state\\app\\sweeps\\ABC-1234\\_sweep\\prs')
  assert.equal(w.gate2Index, 'C:\\state\\app\\sweeps\\ABC-1234\\_sweep\\gate2-index.tsv')
  assert.equal(w.openIndex, 'C:\\state\\app\\sweeps\\ABC-1234\\_sweep\\open-index.tsv')
  assert.throws(() => sliceLayout('', 'ABC-1234', 'a01', 'linux'), /state dir is required/)
  assert.throws(() => sliceLayout('/state/app', 'ABC-1234', '', 'linux'), /slice is required/)
  assert.throws(() => sliceLayout('/state/app', 'ABC-1234', 'a01'), /platform is required/)
  // the sweepId rule is the manifest's, not re-implemented here
  assert.throws(() => sliceLayout('/state/app', 'a/b', 'a01', 'linux'), /must be a plain directory name/)
})

// A 120 s tool timeout once silently dropped three appends; a missing line reads as "never
// attempted". The rule is stated with its enum and its owner, so no worker writes it by hand.
test('the ledger rule: report at once, failed is mandatory, the CLI owns the append', () => {
  const s = section(brief('local'), '## The sweep ledger')
  assert.match(s, /`\/state\/app\/sweeps\/ABC-1234\/ledger\.tsv` is the sweep's truth/)
  assert.match(s, /status exactly one of filed · clean · skipped · failed/)
  assert.match(s, /fleet check ledger append <pr> <status> \[--keys k,k\] \[--note …\]/)
  assert.match(s, /A PR is not done until its outcome is on disk/)
  assert.match(s, /`failed` is mandatory/)
  assert.match(s, /never batch a report/)
  assert.match(s, /the CLI owns the append/)
  assert.match(s, /Bind the line to the OUTCOME/)
  // in sessions mode "the orchestrator" is the checker session that owns the slice's ledger
  assert.match(brief('sessions'), /"the orchestrator" below is that session, which owns the shared ledger for its slice/)
})

// ---- a11y, routing, screenshots ----------------------------------------------------------------

// The brief states routing and the forced priority so a worker never re-reads config mid-sweep
// (the manifest is the sweep's truth); mislabelling now costs visibility, not just queue position.
test('a11y class, forced priority and the routing table are rendered from config', () => {
  const s = section(brief('local'), '## a11yClass, forced priority and routing')
  assert.match(s, /Ask WHO IS HARMED/)
  assert.match(s, /keyboard → `a11y: keyboard` · screen reader → `a11y: screen reader`/)
  assert.match(s, /- forced priority for every labelled finding: 4 \(Low\), unconditional/)
  assert.match(s, /- umbrella: pass the manifest's umbrella key as `parent` on op-13/)
  assert.match(s, /- routing \(`checker\.routing`, matched on the defect's `\*\*Where:\*\*` path/)
  assert.match(s, /  - `example\/app\/\*\*` → ada@example\.com/)
  // the umbrella is shared state: sessions and cloud leave parenting to the orchestrator
  assert.match(section(brief('sessions'), '## a11yClass'), /leave `parent` unset .* the orchestrator applies op-23 setParent/)
  // an adapter without sub-issues falls back to op-23's documented degradation
  assert.match(section(brief('local', { capabilities: { ...CAPS, subIssues: false } }), '## a11yClass'), /adapter has no sub-issues .* `If unsupported:` fallback/)
  // no forced priority, no routing → the assessed priority and checker.assignee stand
  const free = section(brief('local', { config: cfg({ 'checker.a11y.forcedPriority': null, 'checker.routing': [] }) }), '## a11yClass')
  assert.match(free, /- forced priority: none configured/)
  assert.match(free, /- routing: none configured — every finding is assigned to `checker\.assignee` \(`me`, the current user\)/)
})

// A prior run filed 15 issues with zero screenshots; the policy and where the slot comes from are
// stated per configuration so "the app was down" never becomes a silent skip.
test('the screenshot section follows checker.screenshots, capture.mode and testing.count', () => {
  const local = section(brief('local'), '## Screenshots')
  assert.match(local, /Policy `checker\.screenshots: always`/)
  assert.match(local, /fleet pool acquire testing --wait <s> --json/)
  assert.match(local, /fleet pool release testing <slot>` — always, including on failure/)
  assert.match(local, /fleet doctor --repair/)
  assert.match(local, /store the BARE url/)
  assert.match(section(brief('local', { config: cfg({ 'checker.screenshots': 'never' }) }), '## Screenshots'), /_No screenshot attached: disabled by config_/)
  assert.match(section(brief('local', { config: cfg({ 'checker.screenshots': 'when-ui' }) }), '## Screenshots'), /skip the capture attempt only for a finding you have already judged/)
  assert.match(section(brief('local', { config: cfg({ 'capture.mode': 'none' }) }), '## Screenshots'), /_No screenshot attached: capture disabled_/)
  assert.match(section(brief('local', { config: cfg({ 'capture.mode': 'cloud' }) }), '## Screenshots'), /_No screenshot attached: no capture slot_/)
  // an empty pool names the setting that emptied it — the operator looks at the key they actually set
  assert.match(section(brief('local', { config: cfg({ 'testing.count': 0 }) }), '## Screenshots'), /^`testing\.count: 0` — no local pool was booted, so there is no slot to acquire: write `_No screenshot attached: no capture slot_`/m)
  assert.match(section(brief('local', { config: cfg({ 'testing.enabled': false }) }), '## Screenshots'), /^`testing\.enabled: false` — no local pool was booted/m)
  assert.doesNotMatch(section(brief('local', { config: cfg({ 'testing.enabled': false }) }), '## Screenshots'), /testing\.count: 0/)
  const cloud = section(brief('cloud'), '## Screenshots')
  assert.match(cloud, /Capture inside the sandbox/)
  assert.match(cloud, /The orchestrator uploads it \(op-22\) when it drains — never you/)
  assert.doesNotMatch(cloud, /fleet pool acquire/)
})

// ---- the checklist ---------------------------------------------------------------------------

// "Do not paraphrase it": a compressed paraphrase drops the qualifier that made a rule survivable.
// The checklist has to catch a brief whose headings survived and whose qualifiers did not.
test('briefChecklist catches a paraphrase that drops a qualifier, and a reordered brief', () => {
  const b = brief('local')
  const paraphrased = b.replace(/^- ⛔ A per-workspace rate limit is contention.*$/m, '- rate limits: retry with backoff')
  const c = briefChecklist(paraphrased)
  assert.equal(c.ok, false)
  assert.deepEqual(c.missing, ['failures'])
  assert.equal(c.sections.failures.headingFound, true)
  assert.deepEqual(c.sections.failures.missingPhrases, ['/rate limit is contention, not a transient/', '/never retry, never sleep/'])

  const report = section(b, '## Return ONLY this')
  const reordered = b.replace('## Return ONLY this' + report, '') + '## Return ONLY this' + report
  const r = briefChecklist(reordered)
  assert.deepEqual(r.missing, [])
  assert.equal(r.ordered, false)
  assert.equal(r.ok, false)

  const empty = briefChecklist('')
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.present, [])
  assert.equal(empty.sections.report.headingFound, false)
})

// ---- inputs and validation ---------------------------------------------------------------------

test('the inputs section points at the manifest, the bundle, the playbook and the adapter — never a payload', () => {
  const s = section(brief('local'), '## Inputs (read, never re-resolve)')
  assert.match(s, /- manifest: `\/state\/app\/sweeps\/ABC-1234\/manifest\.json` — the group id, the assignee ref, the umbrella key/)
  assert.match(s, /manifest incomplete: <field>/)
  assert.match(s, /- bundle: `\/state\/app\/sweeps\/ABC-1234\/_sweep\/prs\/<n>\.json` · `<n>\.diff` · the gate-2 index `\/state\/app\/sweeps\/ABC-1234\/_sweep\/gate2-index\.tsv` · the open-PR index `\/state\/app\/sweeps\/ABC-1234\/_sweep\/open-index\.tsv`/)
  assert.match(s, /- review lens: riskProfile `default` · emphasis none · overlay `\.fleet\/lenses\.md`/)
  assert.match(s, /- playbook: `\/plugin\/playbooks\/check\.md` — section 7 is the procedure; run 7\.1–7\.6 for this PR only/)
  assert.match(s, /- adapter: `\/plugin\/trackers\/example-tracker\.md` — tracker work is named by op number only/)
  const lens = section(brief('local', { config: cfg({ 'review.riskProfile': 'security-critical', 'review.emphasis': ['failed-read'], 'review.securitySkill': 'example-security' }) }), '## Inputs')
  assert.match(lens, /riskProfile `security-critical` · emphasis `failed-read` .* · securitySkill `example-security`/)
})

// A worker told to speak in op numbers with no mapping file invents tool calls; a worker with no
// procedure improvises one. Each missing input is refused up front, never rendered as "null".
test('an unknown mode, a missing playbook, an empty PR list or a configured tracker with no adapter throws', () => {
  assert.throws(() => brief('remote'), /unknown mode/)
  assert.throws(() => brief('local', { playbookPath: null }), /playbookPath is required/)
  assert.throws(() => brief('local', { sweep: { ...SWEEP, prs: [] } }), /at least one PR/)
  // String(null) is "null" — a non-empty string that once got minted into a fid (manifest.mjs isPr)
  assert.throws(() => brief('local', { sweep: { ...SWEEP, prs: [null] } }), /sweep\.prs must be PR numbers/)
  assert.throws(() => brief('local', { sweep: { ...SWEEP, prs: ['abc'] } }), /sweep\.prs must be PR numbers/)
  assert.throws(() => brief('local', { sweep: { ...SWEEP, prs: [1240, undefined] } }), /sweep\.prs must be PR numbers/)
  assert.doesNotThrow(() => brief('local', { sweep: { ...SWEEP, prs: ['1240'] } }), 'the worklist stores digit strings')
  assert.throws(() => brief('local', { sweep: { ...SWEEP, slice: '' } }), /sweep\.slice/)
  assert.throws(() => brief('local', { stateDir: undefined }), /stateDir is required/)
  // PURE: the platform is injected, never read from the host — a default would render a layout that
  // depends on where the CLI happens to run
  assert.throws(() => brief('local', { platform: undefined }), /platform is required/)
  assert.throws(() => brief('local', { adapterPath: null }), /no adapterPath was given/)
  // cloud never needs one — it is handed none by design
  assert.doesNotThrow(() => brief('cloud', { adapterPath: null }))
  for (const mode of MODES) {
    const b = brief(mode)
    assert.ok(!b.includes('null'), `${mode}: a null leaked into the brief`)
    assert.ok(!b.includes('undefined'), `${mode}: an undefined leaked into the brief`)
  }
})

// ---- redaction ---------------------------------------------------------------------------------

// The brief is published prose that reaches every worker: it may name no tracker vendor, no tool
// identifier and none of the denied tokens the docs gate guards — the same four rules as a playbook
// (the vendor list mirrors playbook-brands.test.mjs, the proper-noun rule docs-redaction.test.mjs).
test('no rendered brief names a tracker vendor, a tool identifier, a denied token or a codename', () => {
  const VENDORS = /\b(Linear|Jira|Atlassian|Asana|Trello|GitHub Issues)\b/
  const EXACT = readHashes('redaction-exact.txt')
  const PROPER = readHashes('redaction-proper.txt')
  const PATTERNS = readPatterns()
  const variants = [
    ...MODES.map(m => brief(m)),
    brief('local', { config: cfg({ 'tracker.mode': 'none', 'tracker.id': null }), adapterPath: null, capabilities: null }),
    brief('local', { config: cfg({ 'checker.screenshots': 'never', 'testing.count': 0 }) }),
  ]
  for (const b of variants) {
    assert.doesNotMatch(b, VENDORS)
    assert.doesNotMatch(b, /\bmcp__/)
    for (const { source, flags, why } of PATTERNS) assert.doesNotMatch(b, new RegExp(source, flags), why)
    const leaked = tokensOf(b).filter(t => EXACT.has(hashToken(t)))
    assert.deepEqual(leaked, [], 'a denied identifier reached the brief')
    // proper-noun codenames are English words too: only a capitalised, non-sentence-initial use leaks
    const proper = []
    const rx = /(^|[^\s>#*\-|])[ \t]+([A-Z][a-z]{2,})\b/gm
    let m
    while ((m = rx.exec(b))) if (!'.!?:'.includes(m[1]) && PROPER.has(hashToken(m[2]))) proper.push(m[2])
    assert.deepEqual(proper, [], 'a codename reached the brief as a proper noun')
  }
})
