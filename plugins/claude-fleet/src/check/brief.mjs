// The per-PR worker brief (`fleet check brief`), rendered as markdown. PURE: every input is
// injected (the state dir and the platform included), and the only paths in the output are the ones
// sliceLayout() derives from them (contract §4) or the ones the CLI passes in `paths`.
//
// The brief exists because the rules in it were once instructions a worker could skip, and each
// one was skipped at least once:
//   * workers returned raw diffs, forge output and image bytes to the orchestrator, and the bulk
//     that should have died inside the worker took the orchestrator down with it;
//   * a worker opened a path the permission layer treats as sensitive, got a prompt nobody was
//     there to answer, and parked forever — no failure artifact, no branch, no timeout — while four
//     siblings did the same;
//   * several workers each slept 20+ minutes on a per-workspace link rate limit, treating
//     contention as a transient worth retrying;
//   * a cloud sandbox that tried the tracker (which it does not have) hung rather than failed.
//
// ⛔ The brief is handed to the worker VERBATIM. A compressed paraphrase drops the qualifier that
// made a rule survivable, which is why briefChecklist() asserts the load-bearing phrases and not
// only the headings — `fleet check brief --json` reports the same checklist.
//
// ⛔ A cloud worker is handed NO adapter path rather than an adapter plus a prohibition: a worker
// told where the tool mapping lives will eventually reach for it.

import path from 'node:path'

import { PRIORITIES, normalisePriority } from './findings.mjs'
import { LEDGER_STATUSES } from './ledger.mjs'
import { MODES, sweepLayout } from './manifest.mjs'

// One enum, owned by the manifest — a second copy here would drift from it.
export { MODES }

const P = platform => (platform === 'win32' ? path.win32 : path.posix)

/**
 * The manifest's sweepLayout() (contract §4 — every key keeps its meaning there: `filed` and
 * `findings` are the directories) plus the per-slice files and the bundle indexes one worker needs.
 * `platform` is injected, never read from the host: the rendered paths must not depend on where the
 * CLI happens to run.
 */
export function sliceLayout(stateDir, sweepId, slice, platform) {
  if (!stateDir) throw new Error('sliceLayout: the state dir is required')
  if (!slice) throw new Error('sliceLayout: the slice is required')
  if (!platform) throw new Error('sliceLayout: platform is required — the rendered paths must not depend on the host the CLI runs on')
  const p = P(platform)
  const layout = sweepLayout(stateDir, sweepId, platform)
  return {
    ...layout,
    filedSlice: p.join(layout.filed, `${slice}.tsv`),
    findingsSlice: p.join(layout.findings, `${slice}.jsonl`),
    prs: p.join(layout.sweep, 'prs'),
    gate2Index: p.join(layout.sweep, 'gate2-index.tsv'),
    openIndex: p.join(layout.sweep, 'open-index.tsv'),
  }
}

/**
 * The MAY / MAY NOT rows, derived from the mode. The line is SHARED STATE, not the tracker itself:
 * creating distinct issues parallelises cleanly (thirteen local workers once filed over a hundred
 * with zero duplicates), while two writers on one description overwrite each other — so the
 * description, the umbrella and any issue another agent created are orchestrator-only everywhere.
 * @returns {Array<{id: string, operation: string, may: boolean, note: string}>}
 */
export function permissions(mode, { trackerless = false, sensitivePaths = [] } = {}) {
  if (!MODES.includes(mode)) throw new Error(`brief: unknown mode "${mode}" (expected ${MODES.join('|')})`)
  const cloud = mode === 'cloud'
  const noTracker = cloud || trackerless
  const trackerNote = cloud
    ? 'a sandbox has neither the tracker connection nor the forge CLI, and a call hangs rather than fails'
    : 'no tracker configured (tracker.mode: none) — the record in findings/<slice>.jsonl is the filing'
  const globs = sensitivePaths.length ? sensitivePaths.map(g => `\`${g}\``).join(', ') : 'none configured'
  return [
    {
      id: 'create',
      operation: 'op-13 createIssue for a finding of THIS PR',
      may: !noTracker,
      note: cloud ? `emit a createIssue outbox entry instead — ${trackerNote}` : noTracker ? trackerNote : 'distinct issues share no mutable state and parallelise cleanly',
    },
    {
      id: 'editOwn',
      operation: 'op-14 / op-15 / op-22 on an issue YOU created',
      may: !noTracker,
      note: noTracker ? trackerNote : 'you are its only writer',
    },
    {
      id: 'reconcile',
      operation: 'op-16 findIssues to reconcile before filing',
      may: !noTracker,
      note: cloud ? "use the bundle's filed index only" : noTracker ? trackerNote : 'banded by priority, joined on the `**PR:** #<n>` line — never a title',
    },
    {
      id: 'deliver',
      operation: cloud
        ? 'read the bundle · write findings/<slice>.jsonl · write your createIssue outbox entries and PNGs on the results branch · return the report'
        : 'read the bundle and the manifest · write findings/<slice>.jsonl and your own filed/<slice>.tsv rows · return the report',
      may: true,
      note: 'these are yours and nobody else\'s — the only state a worker owns',
    },
    {
      id: 'shared',
      operation: 'op-27 tickWorkItem (the tracker description) · the a11y umbrella (op-23 setParent onto it) · op-15 patchBody on an issue another agent created · op-21 createProject · op-18 ensureLabel',
      may: false,
      note: 'orchestrator only, in every mode — parallel writers to one description overwrite each other',
    },
    {
      id: 'forge',
      operation: 'forge CLI queries for gate 2 / gate 3',
      may: !cloud,
      note: cloud ? 'the indexes are in the bundle; the CLI is not there, and a call hangs rather than fails' : 'the gate-2 and open-PR indexes in the bundle first; never local `git log` — a shallow clone truncates history silently',
    },
    {
      id: 'recurse',
      operation: 'spawn another per-PR layer',
      may: false,
      note: 'no recursion — within this PR the independent work (later-PR checks, per-issue file + screenshot) may still fan out',
    },
    {
      id: 'edit',
      operation: 'edit any source, test or config file',
      may: false,
      note: 'findings-only — the only artefacts you produce are issues, screenshots and the sweep dir\'s own state',
    },
    {
      id: 'sensitive',
      operation: `read, grep, cat or edit any path matching vcs.sensitivePaths: ${globs}`,
      may: false,
      note: 'a permission prompt hangs you forever with no failure marker (next section)',
    },
  ]
}

const cell = s => String(s).replace(/\|/g, '\\|')

function renderPermissions(rows) {
  const out = ['| operation | you |', '| --- | --- |']
  for (const r of rows) out.push(`| ${cell(r.operation)} | ${r.may ? 'MAY' : 'MAY NOT'} — ${cell(r.note)} |`)
  return out
}

function renderScreenshots({ mode, config, layout, sep }) {
  const policy = config.checker.screenshots
  const captureMode = config.capture.mode
  const enabled = Boolean(config.testing.enabled)
  const slots = enabled ? Math.max(0, Number(config.testing.count) || 0) : 0
  const out = []
  if (policy === 'never') {
    out.push('Policy `checker.screenshots: never` — replace the `![screenshot]` line with `_No screenshot attached: disabled by config_` on every issue. Still file; a missing shot is never a reason to skip a finding.')
    out.push('`_No UI surface — <reason>._` and `_No screenshot attached: <reason>_` stay distinct lines: they are counted separately in the report.')
    return out
  }
  out.push(policy === 'when-ui'
    ? 'Policy `checker.screenshots: when-ui` — every issue gets one; skip the capture attempt only for a finding you have already judged `_No UI surface — <reason>._` (truly no screen). `_No screenshot attached: <reason>_` when the repair failed — a different line, counted separately.'
    : 'Policy `checker.screenshots: always` — every issue gets one, even when the edge case cannot be reproduced: capture the affected screen in its normal state and caption it `_Area affected (context, not a repro): <screen/component>._`. `_No UI surface — <reason>._` only when there is truly no screen; `_No screenshot attached: <reason>_` when the repair failed — counted separately.')
  if (captureMode === 'none') {
    out.push('`capture.mode: none` — the repo has opted out: the line is `_No screenshot attached: capture disabled_`, and it is never a reason to skip filing.')
    return out
  }
  if (mode === 'cloud') {
    out.push(`Capture inside the sandbox, against the app \`capture.bootstrapScript\` brought up: sign in via \`capture.loginUrlTemplate\` (\`{base}\` = the sandbox URL, \`{account}\` = one of \`capture.accounts\`), run \`capture.runner\` against \`{url}\`, save the PNG as \`shots/<fid>.png\` beside your outbox entries on the results branch. The orchestrator uploads it (op-22) when it drains — never you.`)
    return out
  }
  if (captureMode === 'cloud') {
    out.push('`capture.mode: cloud` — there is no local slot to acquire: the capture belongs to the cloud sandbox that reviewed the PR and arrives with its results branch; if none is available, write `_No screenshot attached: no capture slot_` and count it under `noShot`.')
    return out
  }
  if (slots === 0) {
    // Name the setting that applied: an operator reading `testing.count: 0` looks at the wrong key
    // when it was `testing.enabled: false` that emptied the pool.
    out.push(`\`${enabled ? 'testing.count: 0' : 'testing.enabled: false'}\` — no local pool was booted, so there is no slot to acquire: write \`_No screenshot attached: no capture slot_\` and count it under \`noShot\`. Never start a server of your own.`)
    return out
  }
  out.push(`Capture: \`fleet pool acquire testing --wait <s> --json\` → you hold one of ${slots} slot(s) and its URL → sign in via \`capture.loginUrlTemplate\` (\`{base}\` = the slot URL, \`{account}\` = one of \`capture.accounts\`, so parallel captures never share a session) → \`capture.runner\` against \`{url}\` → save \`${layout.shots}${sep}<fid>.png\` → \`fleet pool release testing <slot>\` — always, including on failure. Serialize onto the small pool; never the full wave.`)
  out.push('If the app is unreachable: `fleet doctor --repair`, then retry. Only after a genuine repair attempt fails do you write `_No screenshot attached: <reason>_`, `fleet flag blocked --category dev-server|services|testing-slot --observation <what broke and what you tried>`, and continue with the rest of the PR. Never skip a shot because the app was down.')
  out.push('Embed: create → upload → embed. `op-22 attachImage` with the strategy the manifest records (never improvise one), store the BARE url (a stored signed url rots), then `op-15 patchBody` replaces the `![screenshot]` placeholder. One upload per screenshot — sibling findings that share a screen inline the same url; a cosmetic upload failure is `_No screenshot attached: <reason>_`, never a silently missing line.')
  return out
}

function renderA11yAndRouting({ mode, config, capabilities, trackerless }) {
  const a = config.checker.a11y
  const forced = a.forcedPriority == null ? null : normalisePriority(a.forcedPriority)
  const subIssues = capabilities ? capabilities.subIssues !== false : false
  const out = []
  out.push('Set `a11yClass` to `keyboard` / `screen_reader` only when the defect is genuinely about those users; a functional bug with an incidental focus side-effect is `none`. Ask WHO IS HARMED if this is never fixed: only keyboard or screen-reader users → label it; everyone, with an a11y dimension as well → no a11y label, file it at true severity and describe the dimension in the body (labelling it buries a real bug and hides it from the group view).')
  // The classification lives in the findings record and applies everywhere; labels, the umbrella
  // and routing are tracker operations, and a tracker-less sweep has no tracker to apply them in.
  out.push(trackerless
    ? '- labels: none apply — no tracker configured (`tracker.mode: none`): the `a11yClass` field on the findings record is the a11y filing, and it is what "labelled" means below'
    : `- labels: keyboard → \`${a.labels.keyboard}\` · screen reader → \`${a.labels.screenReader}\` · both → both`)
  out.push(forced === null
    ? '- forced priority: none configured — the assessed priority stands on a11y-labelled findings too'
    : `- forced priority for every labelled finding: ${forced} (${PRIORITIES[forced]}), unconditional. Set the field AND the \`**Priority:**\` body line to ${PRIORITIES[forced]}, say "filed ${PRIORITIES[forced]} per the standing a11y rule; assessed <X> because …", and list it under \`a11yAssessedHigherThanFiled\` — the body line is the escalation channel, the field is not.`)
  if (trackerless) {
    out.push('- umbrella: none — there is no tracker to parent onto; leave `parent` unset')
    out.push('- routing: none — there is no tracker to assign in; `checker.routing` and `checker.assignee` do not apply')
    return out
  }
  if (!a.umbrella) out.push('- umbrella: `checker.a11y.umbrella` is off — no parenting; labels and the forced priority still apply')
  else if (!subIssues) out.push('- umbrella: the adapter has no sub-issues — leave `parent` unset; the orchestrator applies op-23\'s `If unsupported:` fallback (an index body)')
  else if (mode === 'local') out.push('- umbrella: pass the manifest\'s umbrella key as `parent` on op-13 for every labelled finding — never op-23 on the umbrella yourself, it is shared state')
  else out.push('- umbrella: leave `parent` unset and set `a11yClass`; the orchestrator applies op-23 setParent onto the umbrella (shared state)')
  const routing = Array.isArray(config.checker.routing) ? config.checker.routing : []
  const fallback = config.checker.assignee || 'me'
  if (!routing.length) out.push(`- routing: none configured — every finding is assigned to \`checker.assignee\` (\`${fallback}\`${fallback === 'me' ? ', the current user' : ''}), resolved through the manifest`)
  else {
    out.push(`- routing (\`checker.routing\`, matched on the defect's \`**Where:**\` path — not the PR's — first hit wins; no hit → \`checker.assignee\` \`${fallback}\`):`)
    for (const r of routing) out.push(`  - ${(r.paths || []).map(g => `\`${g}\``).join(', ')} → ${r.assignee}`)
  }
  return out
}

function renderFailures({ mode, capabilities, trackerless }) {
  const cloud = mode === 'cloud'
  const noTracker = cloud || trackerless
  const lacks = name => capabilities && capabilities[name] === false ? ' (adapter lacks it — skip, not a failure)' : ''
  const out = []
  out.push(noTracker
    ? '- blocking (report `outcome: failed` with a note, stop this PR): bundle missing or a 0-byte diff · a required id missing from the manifest (`manifest incomplete: <field>`) · the findings or outbox write failing'
    : '- blocking (report `outcome: failed` with a note, stop this PR): op-13 create failing for a reason that is not a write echo · bundle missing or a 0-byte diff · the filed-ledger append failing · a required id missing from the manifest (`manifest incomplete: <field>`)')
  out.push(noTracker
    ? '- cosmetic (record it under `cosmeticFailures`, move on): a PNG that could not be captured after a repair attempt — `_No screenshot attached: <reason>_` on the entry, counted under `noShot`'
    : `- cosmetic (record key + missing piece under \`cosmeticFailures\`, move on — the orchestrator sweeps them at the end, when waiting is free): op-8 attachLink${lacks('attachLink')} · op-22 attachImage · a label add${lacks('labels')} · op-25 relate between sibling findings of this PR${lacks('relations')} · ANY per-workspace rate limit`)
  out.push('- ⛔ A per-workspace rate limit is contention, not a transient: defer it to the orchestrator, never retry, never sleep on it — several workers once slept 20+ minutes each on one link-attachment limit.')
  if (!noTracker) out.push('- write echo ("result exceeds maximum … saved to <file>"): the write usually APPLIED — re-fetch via op-16 on the `**PR:** #<n>` line (or op-2 if you hold the key) before any retry, or you file a duplicate.')
  return out
}

/**
 * Render the brief a per-PR worker is given.
 *
 * @param {object} o
 * @param {'local'|'sessions'|'cloud'} o.mode
 * @param {object|null} o.capabilities   the adapter's `capabilities` front matter (null when tracker-less)
 * @param {object} o.config              resolved config
 * @param {{sweepId: string, slice: string, prs: Array<string|number>}} o.sweep
 * @param {string} o.stateDir            the sweep dir is `<stateDir>/sweeps/<sweepId>` (contract §4)
 * @param {object} [o.paths]             overrides for sliceLayout() entries, as the CLI resolved them
 * @param {string|null} o.adapterPath    ignored in cloud mode (see the header comment)
 * @param {string} o.playbookPath
 * @param {string} o.platform            injected, never read from the host
 * @returns {string} markdown
 */
export function renderBrief({ mode, capabilities = null, config, sweep, stateDir, paths = {}, adapterPath = null, playbookPath, platform }) {
  if (!MODES.includes(mode)) throw new Error(`brief: unknown mode "${mode}" (expected ${MODES.join('|')})`)
  if (!config) throw new Error('brief: config is required')
  if (!sweep || !sweep.sweepId || !sweep.slice) throw new Error('brief: sweep.sweepId and sweep.slice are required')
  if (!stateDir) throw new Error('brief: stateDir is required — every ledger and bundle path is derived from it')
  if (!platform) throw new Error('brief: platform is required — the rendered paths must not depend on the host the CLI runs on')
  if (!Array.isArray(sweep.prs) || !sweep.prs.length) throw new Error('brief: sweep.prs must name at least one PR')
  // The manifest's isPr rule: String(null) is "null", a non-empty string that once got minted into a fid.
  if (!sweep.prs.every(p => (typeof p === 'string' || typeof p === 'number') && /^\d+$/.test(String(p)))) {
    throw new Error('brief: sweep.prs must be PR numbers')
  }
  const prs = sweep.prs.map(String)
  if (!playbookPath) throw new Error('brief: playbookPath is required — a worker without the procedure improvises one')
  const trackerless = config.tracker.mode === 'none' || !config.tracker.id
  const cloud = mode === 'cloud'
  if (!cloud && !trackerless && !adapterPath) {
    throw new Error('brief: a tracker is configured but no adapterPath was given — a worker told to speak in op numbers with no mapping file invents tool calls')
  }

  const layout = { ...sliceLayout(stateDir, sweep.sweepId, sweep.slice, platform), ...paths }
  const base = config.repo.baseBranch || 'main'
  const sensitive = Array.isArray(config.vcs.sensitivePaths) ? config.vcs.sensitivePaths : []
  const sep = P(platform).sep
  const fidRanges = prs.map(pr => `${sweep.slice}|${pr}|1..N`)
  const prLabel = prs.length === 1 ? `PR #${prs[0]}` : `PRs ${prs.map(n => `#${n}`).join(', ')}`
  const review = config.review || {}

  const lines = []
  lines.push(`# fleet-check worker — ${prLabel} · sweep ${sweep.sweepId} · slice ${sweep.slice} · fid range ${fidRanges.join(', ')}`)
  lines.push('')
  lines.push(`You are reviewing ${prs.length === 1 ? 'ONE PR' : `${prs.length} PRs, one at a time,`} for edge cases that are still open on ${base}. Findings-only: never edit code, tests or config. NEVER ask a question — decide, act, and report what you chose. Mode: ${mode} — ${
    cloud ? 'you are a disposable sandbox working from the offline bundle; your only deliverable is the results branch.'
      : mode === 'sessions' ? 'you are a subagent of a checker session; "the orchestrator" below is that session, which owns the shared ledger for its slice.'
        : 'you are a subagent of the /fleet-check session; "the orchestrator" below is that session.'}`)
  lines.push('')

  // 1. The compact-report contract comes FIRST: the bulk a worker is tempted to return is what once
  //    took the orchestrator down, so the shape of the return value is the first thing it reads.
  lines.push('## Return ONLY this')
  lines.push(`- outcome: ${LEDGER_STATUSES.join(' | ')} — with the note when failed (the orchestrator writes your ledger line from this; a missing outcome reads as "never attempted")`)
  lines.push(cloud
    ? '- filed: [{fid, outbox: <entry file>, priority, a11y}] — no key or url: the orchestrator creates the issue when it drains your entries'
    : '- filed: [{fid, key, url, priority, a11y}]')
  lines.push('- dropped: [{candidate, gate, by: "#<n>" | "target PR" | "open #<n>"}] — the PR that already addressed each')
  lines.push('- screenshots: {attached: N, noUi: N, noShot: N}')
  lines.push('- cosmeticFailures: [{key, op, detail}]')
  lines.push('- a11yAssessedHigherThanFiled: [{key, assessed, why}]')
  lines.push('- "no source files touched"')
  lines.push('No raw diffs. No tool output. No image bytes. That bulk dies inside you; the orchestrator only ever sees this report.')
  lines.push('')

  // 2. MAY / MAY NOT, derived from the mode.
  lines.push('## You MAY / you MAY NOT')
  lines.push(...renderPermissions(permissions(mode, { trackerless, sensitivePaths: sensitive })))
  lines.push('')

  // 3. Sensitive paths — rendered from config so the prohibition names the actual globs.
  lines.push('## Sensitive paths — never read, grep, cat or edit them')
  if (sensitive.length) {
    lines.push('Globs (`vcs.sensitivePaths`):')
    for (const g of sensitive) lines.push(`- \`${g}\``)
  } else {
    lines.push('Globs (`vcs.sensitivePaths`): none configured — the rule still stands for any command that raises a permission prompt.')
  }
  lines.push('⛔ Opening one raises a permission prompt, and nobody is there to answer it: you park forever with no failure artifact, no branch and no timeout — indistinguishable from a crash. Treat a glob match as a wall. Probe a secret by its LENGTH, never by reading the file that holds it. If a step seems to need one, report `outcome: failed` with note `needs sensitive path <glob>` — never a read.')
  if (cloud && Array.isArray(config.capture.requiredEnv) && config.capture.requiredEnv.length) {
    lines.push(`Required env names (\`capture.requiredEnv\`): ${config.capture.requiredEnv.map(n => `\`${n}\``).join(', ')} — assert presence only, before installing; never print a value, never dump the environment.`)
  }
  lines.push('')

  // 4. Blocking vs cosmetic.
  lines.push('## Retryable failures — how long to care')
  lines.push(...renderFailures({ mode, capabilities, trackerless }))
  lines.push('')

  // 5. a11y class, forced priority, routing — stated here so the worker never re-reads config.
  lines.push('## a11yClass, forced priority and routing')
  lines.push(...renderA11yAndRouting({ mode, config, capabilities, trackerless }))
  lines.push('')

  // 6. Screenshots.
  lines.push('## Screenshots')
  lines.push(...renderScreenshots({ mode, config, layout, sep }))
  lines.push('')

  // 7. The fid range and the private ledgers.
  lines.push('## Your fid range and private ledgers')
  lines.push(`- fid range: ${fidRanges.join(', ')} — mint with \`fleet check fid mint ${sweep.slice} --count N\` BEFORE filing, one fid per candidate you are about to file. Never a fid you made up, never a title join: title similarity mis-scored a quarter of one corpus, an opaque key cannot drift.`)
  lines.push(cloud
    ? `- filed ledger: \`${layout.filedSlice}\` is written by the orchestrator when it drains your outbox entries — leave \`filed/\` alone`
    : `- filed ledger (private): \`${layout.filedSlice}\` — one row \`fid → key → url → pr → priority → a11y\` immediately after each successful create, never batched; a single synchronous append that writes its own newline, never a shell pipeline (an append fed empty input is a silent no-op in every shell)`)
  lines.push(`- findings: \`${layout.findingsSlice}\` — one record per candidate, filed AND dropped, with \`where: [{path, line, symbol}]\` (repo-root-relative path, never a bare filename) and a terminal \`state\``)
  lines.push(cloud
    ? `- outbox: \`${layout.outbox}\` — one createIssue entry per finding (the op-13 args as JSON, every id from the manifest), delivered with the PNGs on your results branch; \`fleet check harvest ${sweep.sweepId}\` pulls them back`
    : `- shots: \`${layout.shots}${sep}<fid>.png\``)
  lines.push('`fleet check reconcile filed --json` asserts rows == unique fids == unique keys == the slice total. A row you skipped is a count that will not agree; four numbers agreeing is what makes "0 failed" a fact rather than a claim.')
  lines.push('')

  // 8. The sweep ledger and the append rule.
  lines.push('## The sweep ledger')
  lines.push(`\`${layout.ledger}\` is the sweep's truth — \`<pr> <status> <keys|-> <iso> <note>\`, status exactly one of ${LEDGER_STATUSES.join(' · ')} — and the orchestrator appends your line the moment your report lands, with \`fleet check ledger append <pr> <status> [--keys k,k] [--note …]\`.`)
  lines.push('- ⛔ A PR is not done until its outcome is on disk. Nothing in your context or return value counts until that line exists, so report the moment the PR resolves and never batch a report with the next PR\'s — a 120 s tool timeout once silently dropped three appends.')
  lines.push('- ⛔ `failed` is mandatory: report it, with the note. A missing line means "never attempted", which is worse and less recoverable than "attempted and failed"; a worker that dies before reporting is recorded `failed` by the orchestrator, with the note saying so.')
  lines.push('- ⛔ Never write the ledger yourself, by hand or through a shell pipeline — the CLI owns the append, and a pipeline fed empty input is a silent no-op in every shell.')
  lines.push('- Bind the line to the OUTCOME (an issue exists / the PR is clean), never to the transport (a tool call returned).')
  lines.push('')

  // 9. Inputs: pointers, never payloads — the copy on disk is the current one.
  lines.push('## Inputs (read, never re-resolve)')
  lines.push(`- manifest: \`${layout.manifest}\` — the group id, the assignee ref, the umbrella key, the label ids (provenance, triage, gate:pending, a11y, security), the triage state, the attach strategy and the base-branch snapshot sha. Read them; never re-resolve. A required id missing → \`outcome: failed\`, note \`manifest incomplete: <field>\` — do not go looking.`)
  lines.push(`- bundle: \`${layout.prs}${sep}<n>.json\` · \`<n>.diff\` · the gate-2 index \`${layout.gate2Index}\` · the open-PR index \`${layout.openIndex}\`${cloud ? ' — the bundle is all you have; there is no forge to ask' : ` (\`fleet check gh bundle <n> --json\` only when a bundle is missing; a 0-byte diff is never "this PR changed nothing")`}`)
  lines.push(`- review lens: riskProfile \`${review.riskProfile || 'default'}\` · emphasis ${Array.isArray(review.emphasis) && review.emphasis.length ? review.emphasis.map(e => `\`${e}\``).join(', ') : 'none'} · overlay \`${review.lensOverlay || '.fleet/lenses.md'}\` (read it if it exists)${review.securitySkill ? ` · securitySkill \`${review.securitySkill}\`` : ''}${review.testingSkill ? ` · testingSkill \`${review.testingSkill}\`` : ''}`)
  lines.push(`- playbook: \`${playbookPath}\` — section 7 is the procedure; run 7.1–7.6 for this PR only. Read the file itself: it is not pasted here on purpose, the copy on disk is the current one.`)
  lines.push(cloud
    ? '- adapter: none — a sandbox has neither the tracker connection nor the forge CLI; a worker that tries either hangs rather than fails. Your tracker ops are outbox entries, nothing else.'
    : trackerless
      ? '- adapter: none — no tracker configured (`tracker.mode: none`); the finding record in `findings/<slice>.jsonl` is the filing, and there is no op that applies.'
      : `- adapter: \`${adapterPath}\` — tracker work is named by op number only (op-13, op-16, …); the mapping from an op to a real tool call lives in this file and nowhere else.`)
  lines.push('')
  return lines.join('\n')
}

/**
 * The sections a complete brief carries, in order, each with the phrases a paraphrase would drop.
 * `heading` is matched against the brief; `must` against that section's own text.
 */
export const BRIEF_SECTIONS = Object.freeze([
  { id: 'header', heading: /^# fleet-check worker — /m, must: [/sweep \S+/, /slice \S+/, /fid range /] },
  // The outcome enum is the ledger's, spelled once there — a hard-coded copy here would drift from it.
  { id: 'report', heading: /^## Return ONLY this$/m, must: [new RegExp(`outcome: ${LEDGER_STATUSES.join(' \\| ')}`), /No raw diffs\. No tool output\. No image bytes\./] },
  { id: 'permissions', heading: /^## You MAY \/ you MAY NOT$/m, must: [/\| MAY — /, /\| MAY NOT — /, /orchestrator only, in every mode/] },
  { id: 'sensitive', heading: /^## Sensitive paths — never read, grep, cat or edit them$/m, must: [/vcs\.sensitivePaths/, /permission prompt/, /by its LENGTH/] },
  { id: 'failures', heading: /^## Retryable failures — how long to care$/m, must: [/- blocking/, /- cosmetic/, /rate limit is contention, not a transient/, /never retry, never sleep/] },
  { id: 'a11y', heading: /^## a11yClass, forced priority and routing$/m, must: [/WHO IS HARMED/, /- forced priority/, /- routing/] },
  { id: 'screenshots', heading: /^## Screenshots$/m, must: [/_No UI surface — <reason>\._/, /_No screenshot attached: /] },
  { id: 'fid', heading: /^## Your fid range and private ledgers$/m, must: [/fleet check fid mint/, /- filed ledger/, /- findings: /] },
  { id: 'ledger', heading: /^## The sweep ledger$/m, must: [/outcome is on disk/, /`failed` is mandatory/, /never batch/, /the CLI owns the append/] },
  { id: 'inputs', heading: /^## Inputs \(read, never re-resolve\)$/m, must: [/- manifest: /, /- playbook: /, /- adapter: /] },
])

/**
 * Which required sections a brief carries — heading present AND every load-bearing phrase inside
 * it — and whether they are in BRIEF_SECTIONS order.
 * @returns {{ok: boolean, ordered: boolean, present: string[], missing: string[], sections: Record<string, {headingFound: boolean, present: boolean, missingPhrases: string[]}>}}
 */
export function briefChecklist(brief) {
  const text = String(brief || '')
  const headings = [...text.matchAll(/^#{1,2} .*$/gm)].map(m => m.index)
  const sections = {}
  const present = []
  const missing = []
  const order = []
  for (const s of BRIEF_SECTIONS) {
    const m = s.heading.exec(text)
    const headingFound = !!m
    let missingPhrases = s.must.map(String)
    if (headingFound) {
      const next = headings.find(i => i > m.index)
      const body = text.slice(m.index, next === undefined ? text.length : next)
      missingPhrases = s.must.filter(rx => !rx.test(body)).map(String)
      order.push(m.index)
    }
    const ok = headingFound && missingPhrases.length === 0
    sections[s.id] = { headingFound, present: ok, missingPhrases }
    ;(ok ? present : missing).push(s.id)
  }
  const ordered = order.every((i, n) => n === 0 || i > order[n - 1])
  return { ok: missing.length === 0 && ordered, ordered, present, missing, sections }
}
