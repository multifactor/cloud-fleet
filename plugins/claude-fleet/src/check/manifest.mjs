// The sweep manifest and the sweep-dir layout (contract §4).
//
// The manifest is the sweep's truth. Everything a filing needs — the group, the umbrella, the
// assignee, the label ids, the triage state, the capture strategy — is resolved ONCE at plan time
// and referenced BY ID from here on. Names get renamed and contain apostrophes; a group pointer that
// lived in a session's memory instead of the manifest drifted a sweep behind more than once.
//
// Rules encoded here, each from a real failure:
//   * a resume keeps the existing tracker ids, umbrella, slices, counts, snapshot AND mode — mode
//     decides who files (cloud workers emit outbox entries, local workers file directly), so a re-run
//     that flipped it would leave half the worklist in outbox entries; only status / updatedAt /
//     width / gate.autoPromote take the fresh run's values, because width is the per-run pacing knob
//     (a sweep that OOM'd must resume narrower) and `--auto` is per run. Re-resolving the location
//     mid-sweep is how the pointer drifted;
//   * the manifest and RESUME.md are written atomically (temp + rename in the SAME directory) so a
//     fresh session never reads a half-written one, and a failed write leaves no temp file behind;
//   * RESUME.md is written once and never overwritten — `fleet check finish` marks it finished, and
//     a resume that rewrote it would erase that mark; a 0-byte one is a crashed write, not written;
//   * a manifest that LOST a key is damaged, never "resolved to null": every by-id field must be
//     present, so a resume can name what is missing instead of filing nowhere;
//   * counts are checked against the worklist so a retried PR counted twice cannot report more done
//     than exists;
//   * a damaged manifest THROWS rather than reading as "no sweep here" — silently re-planning over a
//     sweep dir is the manifest's version of "a done of 0 means the ledger did not load".
//
// Pure decision logic is exported separately (emptyManifest, validateManifest, mergeOnResume,
// sweepLayout, renderResumeMd); the filesystem half is thin.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { stateLayout } from '../config/paths.mjs'
import { clone } from '../config/defaults.mjs'
import { ENUMS } from '../trackers/registry.mjs'

export const MANIFEST_V = 1
// planning (manifest written, worklist not yet) → running → complete (`fleet check finish`). Nothing
// writes any other state; a killed sweep is a running one that resumes.
export const SWEEP_STATUSES = ['planning', 'running', 'complete']
export const INPUT_KINDS = ['tracker-issue', 'prs', 'file']
export const MODES = ['local', 'sessions', 'cloud']
export const TRACKER_MODES = ['mcp', 'manual', 'none']
export const AUTO_PROMOTE = ['never', 'after-audit']
export const CAPTURE_MODES = ['local', 'cloud', 'none']
// The ADAPTER's strategy vocabulary (the op-22 `Strategy:` line), which is what chooseStrategy()
// resolves to at plan time — never the config's `checker.attachStrategy` spelling, and never `auto`:
// a manifest carrying the config value hands a worker the choice, and a worker that chooses
// improvises — the one thing the playbook forbids for op-22.
export const ATTACH_STRATEGIES = ENUMS.strategy
export const AUDIT_STATUSES = ['pending', 'running', 'complete']
// The playbook's finish counts (check.md §8.5): no-UI skips and no-screenshot failures are counted
// SEPARATELY (§7.5), so one "unattached" number cannot stand in for both.
export const COUNT_KEYS = ['worklist', 'filed', 'clean', 'skipped', 'failed', 'noUi', 'noScreenshot', 'a11yForcedLow']
/** The ledger outcomes — the four counts whose sum is bounded by the worklist. */
const RESOLVED_KEYS = ['filed', 'clean', 'skipped', 'failed']

// A sweepId is a directory name under <stateDir>/sweeps/. The deterministic forms (`<KEY>`,
// `prs-<sha1>`, `file-<sha1>`) all fit this; anything with a separator would escape the sweeps dir.
const SAFE_SWEEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertSweepId(id) {
  const s = String(id ?? '')
  if (!SAFE_SWEEP_ID.test(s)) {
    throw new Error(`sweepId "${s}" must be a plain directory name (a tracker key, prs-<sha1> or file-<sha1>)`)
  }
  return s
}

const isStr = v => typeof v === 'string' && v.length > 0
// null = unresolved, a non-empty string = resolved. "" is neither: plan.mjs's have() (`!= null`) would
// read it as resolved and never re-emit the op, and a worker would pass group: "" to op-13.
const isStrOrNull = v => v === null || isStr(v)
// The ISO shape WITH a zone, not merely "Date.parse accepts it": Date.parse('12') is a finite date,
// and a zone-less '2026-03-14T10:00' is a different instant on every machine that reads the manifest.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const isIso = v => typeof v === 'string' && ISO_TS.test(v) && Number.isFinite(Date.parse(v))
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = v => Number.isInteger(v) && v >= 0
// The worklist stores PR numbers as digit strings. String(null) is "null" — a non-empty string that
// once got minted into a fid.
const isPr = v => typeof v === 'string' && /^\d+$/.test(v)

/**
 * PURE. A fresh manifest in the planning state. `input` is stored exactly as the planner's
 * classifyInput shapes it — `{kind, ref}` for a tracker issue or a file, `{kind, prs, urls?}` for a PR
 * set (the sweepId is derived from that list, and a resumed PR-set sweep has nothing else to run over;
 * `urls` maps the PRs that were given as URLs to those URLs).
 * `at` is the planner's clock (`facts.now`), injected — never read here. `tracker`, `gate` and
 * `capture` are optional partial blocks the planner fills from the resolved config; everything else
 * resolves later, by id. Throws when the result would not validate, so a plan can never write an
 * invalid manifest.
 */
export function emptyManifest({ sweepId, input, mode, width = 'auto', repoKey = null, baseBranch, snapshotSha = null, at, tracker = {}, gate = {}, capture = {} }) {
  const id = assertSweepId(sweepId)
  const kind = input && input.kind
  const ref = input && input.ref !== undefined && input.ref !== null ? String(input.ref) : null
  const inputBlock = kind === 'prs'
    ? {
        kind,
        prs: input && Array.isArray(input.prs) ? [...input.prs] : input && input.prs,
        // classifyInput adds `urls` for PR-URL arguments; the block IS the classified input, so a
        // manifest that dropped it would hand a resumed sweep the bare numbers.
        ...(input && isObj(input.urls) ? { urls: { ...input.urls } } : {}),
      }
    : { kind, ref }
  const m = {
    v: MANIFEST_V,
    sweepId: id,
    status: 'planning',
    createdAt: at,
    updatedAt: at,
    input: inputBlock,
    repo: { key: repoKey, baseBranch, snapshotSha },
    mode,
    width,
    tracker: {
      id: null,
      mode: 'none',
      group: null,
      // The `<KEY>` input IS the mirror target: every resolved PR is ticked back onto it (op-27).
      // Deriving it here means a tracker-issue sweep cannot forget where its ticks are owed.
      workItems: kind === 'tracker-issue' ? ref : null,
      umbrella: null,
      provenanceLabel: null,
      assignee: null,
      ...tracker,
      // The nested blocks merge one level deeper: a partial `triage: {state}` must keep `label`, or
      // the manifest the planner just wrote reads as one that lost a key.
      triage: { state: null, label: null, ...(tracker.triage || {}) },
      ready: { state: null, label: null, ...(tracker.ready || {}) },
      labels: { ...(tracker.labels || {}) },
    },
    gate: { autoPromote: 'never', promotedAt: null, promotedKeys: [], ...gate },
    capture: { mode: 'local', pool: null, attachStrategy: null, assetsBranch: null, ...capture },
    slices: [],
    counts: Object.fromEntries(COUNT_KEYS.map(k => [k, 0])),
    audit: { status: 'pending', runs: [] },
  }
  const v = validateManifest(m)
  if (!v.ok) throw new Error(`emptyManifest: ${v.errors.join('; ')}`)
  return m
}

/**
 * PURE. Schema check. Every error names its field so a resume can say what is damaged.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(m) {
  const errors = []
  const err = s => errors.push(s)
  const oneOf = (field, list, v) => {
    if (!list.includes(v)) err(`${field}: must be one of ${list.join('|')}, got ${JSON.stringify(v)}`)
  }
  if (!isObj(m)) return { ok: false, errors: ['manifest: not an object'] }

  // Presence before type: a resolved-to-nothing field is null, never absent — a manifest that LOST
  // the key is damaged, and a worker records `manifest incomplete: <field>` (§7.2) from the name.
  const strOrNull = (obj, key, field, what) => {
    if (!Object.hasOwn(obj, key)) err(`${field}: missing — a field resolved to nothing is null, never absent`)
    else if (obj[key] === '') err(`${field}: "" is neither resolved nor null — a field resolved to nothing is null`)
    else if (!isStrOrNull(obj[key])) err(`${field}: must be ${what} or null`)
  }

  if (m.v !== MANIFEST_V) err(`v: expected ${MANIFEST_V}, got ${JSON.stringify(m.v)}`)
  try { assertSweepId(m.sweepId) } catch (e) { err(e.message) }
  oneOf('status', SWEEP_STATUSES, m.status)
  for (const k of ['createdAt', 'updatedAt']) if (!isIso(m[k])) err(`${k}: must be an ISO timestamp`)

  const input = isObj(m.input) ? m.input : {}
  oneOf('input.kind', INPUT_KINDS, input.kind)
  if (input.kind === 'prs') {
    // Exactly what classifyInput produces: a non-empty, de-duplicated list of digit strings.
    if (!Array.isArray(input.prs) || !input.prs.length || input.prs.some(p => !isPr(p))) err('input.prs: a PR-set sweep must list its PR numbers as digit strings (the sweepId is derived from them)')
    else if (new Set(input.prs).size !== input.prs.length) err('input.prs: must be unique — a PR named twice lands in two slices and is filed twice')
  } else if (!isStr(input.ref)) err('input.ref: required (the tracker key or the file the sweepId was derived from)')

  const repo = isObj(m.repo) ? m.repo : {}
  strOrNull(repo, 'key', 'repo.key', 'a repo key')
  if (!isStr(repo.baseBranch)) err('repo.baseBranch: required')
  strOrNull(repo, 'snapshotSha', 'repo.snapshotSha', 'a sha')
  // The frame re-check (`fleet check blast-radius --since <snapshotSha>`) runs before finish marks
  // the sweep complete; a complete sweep with no snapshot could not have run it.
  if (m.status === 'complete' && !isStr(repo.snapshotSha)) err('repo.snapshotSha: a complete sweep must record the base-branch snapshot it was verified against')

  oneOf('mode', MODES, m.mode)
  if (!(m.width === 'auto' || (Number.isInteger(m.width) && m.width >= 1))) err(`width: must be "auto" or an integer >= 1, got ${JSON.stringify(m.width)}`)

  const t = isObj(m.tracker) ? m.tracker : {}
  if (!isObj(m.tracker)) err('tracker: must be an object')
  oneOf('tracker.mode', TRACKER_MODES, t.mode)
  for (const k of ['id', 'group', 'workItems', 'umbrella', 'provenanceLabel', 'assignee']) strOrNull(t, k, `tracker.${k}`, 'a string')
  // The planner writes mode `none` whenever there is no tracker id, so mcp|manual with a null id is a
  // lost key, not a tracker-less sweep — the mode alone must not read as "has a tracker".
  if (['mcp', 'manual'].includes(t.mode) && !isStr(t.id)) err('tracker.id: required when tracker.mode is mcp|manual — a tracker-less sweep has mode none')
  for (const k of ['triage', 'ready']) {
    if (!isObj(t[k])) { err(`tracker.${k}: must be {state, label}`); continue }
    strOrNull(t[k], 'state', `tracker.${k}.state`, 'a state ref')
    strOrNull(t[k], 'label', `tracker.${k}.label`, 'a label name')
  }
  if (!isObj(t.labels)) err('tracker.labels: must be an object of label name → id')
  else for (const [name, id] of Object.entries(t.labels)) if (!isStr(id)) err(`tracker.labels["${name}"]: must be a label id`)
  // A `<KEY>` sweep reads its work-list with op-26 and ticks it with op-27: there is no tracker-less
  // form of it (the planner refuses one as plan.key-without-tracker).
  if (input.kind === 'tracker-issue' && t.mode === 'none') err('tracker.mode: a tracker-issue sweep needs a tracker (mcp|manual) — its work-list is read with op-26 and ticked with op-27')
  // A `<KEY>` sweep owes its ticks to that key; a manifest that lost the pointer never ticks, and
  // the operator watching the mirror concludes the run is dead.
  if (input.kind === 'tracker-issue' && isStr(input.ref) && t.workItems !== input.ref) {
    err(`tracker.workItems: a tracker-issue sweep must mirror onto its input key "${input.ref}", got ${JSON.stringify(t.workItems)}`)
  }

  const g = isObj(m.gate) ? m.gate : {}
  if (!isObj(m.gate)) err('gate: must be an object')
  oneOf('gate.autoPromote', AUTO_PROMOTE, g.autoPromote)
  if (!Object.hasOwn(g, 'promotedAt')) err('gate.promotedAt: missing — a field resolved to nothing is null, never absent')
  else if (!(g.promotedAt === null || isIso(g.promotedAt))) err('gate.promotedAt: must be an ISO timestamp or null')
  if (!Array.isArray(g.promotedKeys) || g.promotedKeys.some(k => !isStr(k))) err('gate.promotedKeys: must be a list of issue keys')

  const c = isObj(m.capture) ? m.capture : {}
  if (!isObj(m.capture)) err('capture: must be an object')
  oneOf('capture.mode', CAPTURE_MODES, c.mode)
  // The planner refuses `--mode cloud` without cloud capture (plan.cloud-needs-cloud-capture): a
  // sandbox has no local slot to screenshot from, so the combination is one it can never have written.
  if (m.mode === 'cloud' && CAPTURE_MODES.includes(c.mode) && c.mode !== 'cloud') err(`capture.mode: a cloud sweep captures in the sandbox — must be cloud, got ${JSON.stringify(c.mode)}`)
  if (!Object.hasOwn(c, 'attachStrategy')) err('capture.attachStrategy: missing — a field resolved to nothing is null, never absent')
  else if (c.attachStrategy === 'auto') err('capture.attachStrategy: "auto" is a config value — the planner resolves it to one of ' + ATTACH_STRATEGIES.join('|') + ' before a worker reads the manifest')
  else if (c.attachStrategy === null) {
    // chooseStrategy runs once, at plan time; past planning a null is a lost key, and a worker that
    // reads it is left to choose — the one thing the vocabulary exists to prevent.
    if (SWEEP_STATUSES.includes(m.status) && m.status !== 'planning') err(`capture.attachStrategy: resolved at plan time — null on a ${m.status} sweep is a lost key, never "the worker chooses"`)
  } else if (!ATTACH_STRATEGIES.includes(c.attachStrategy)) err(`capture.attachStrategy: must be one of ${ATTACH_STRATEGIES.join('|')} or null, got ${JSON.stringify(c.attachStrategy)}`)
  strOrNull(c, 'pool', 'capture.pool', 'a pool name')
  strOrNull(c, 'assetsBranch', 'capture.assetsBranch', 'a branch name')

  let slicedTotal = 0   // every PR the slices hold — the work-list bounds it (below)
  if (!Array.isArray(m.slices)) err('slices: must be a list')
  else {
    const names = new Set()
    const sliceOf = new Map()   // pr → the slice that holds it
    // A PR-set sweep is sliced from its input at plan time: a PR outside it was never asked for.
    const listed = input.kind === 'prs' && Array.isArray(input.prs) ? new Set(input.prs) : null
    for (const [i, s] of m.slices.entries()) {
      if (!isObj(s) || !isStr(s.slice)) { err(`slices[${i}]: must be {slice, prs[]}`); continue }
      // `|` is the fid separator (`<slice>|<pr>|<index>`); a slice containing it breaks every fid.
      if (s.slice.includes('|')) err(`slices[${i}].slice: "${s.slice}" must not contain "|"`)
      // A slice is a file segment (filed/<slice>.tsv, findings/<slice>.jsonl), a branch segment
      // (vcs.checkerBranchTemplate) and an env value (FLEET_SLICE): the sweepId's shape, for the same
      // reason — `../x` would escape the sweep dir.
      else if (!SAFE_SWEEP_ID.test(s.slice)) err(`slices[${i}].slice: "${s.slice}" must be a plain file-name segment (letters, digits, . _ -) — it names filed/<slice>.tsv and a checker branch`)
      // Slices are disjoint by construction (§5): two slices with one name share a fid range and a
      // filed/ file, and a PR in two slices is filed twice.
      if (names.has(s.slice)) err(`slices[${i}].slice: "${s.slice}" is already a slice — two slices with one name share a fid range`)
      names.add(s.slice)
      if (!Array.isArray(s.prs) || s.prs.some(p => !isPr(p))) { err(`slices[${i}].prs: must be a list of PR numbers (digit strings)`); continue }
      slicedTotal += s.prs.length
      for (const pr of s.prs) {
        if (sliceOf.has(pr)) err(`slices[${i}].prs: PR ${pr} is already in slice "${sliceOf.get(pr)}" — a PR in two slices is filed twice`)
        else sliceOf.set(pr, s.slice)
        if (listed && !listed.has(pr)) err(`slices[${i}].prs: PR ${pr} is not in input.prs — a PR-set sweep slices exactly the PRs it was given`)
      }
    }
  }

  const counts = isObj(m.counts) ? m.counts : {}
  if (!isObj(m.counts)) err('counts: must be an object')
  for (const k of COUNT_KEYS) if (!isCount(counts[k])) err(`counts.${k}: must be a non-negative integer`)
  if (COUNT_KEYS.every(k => isCount(counts[k]))) {
    const resolved = RESOLVED_KEYS.reduce((n, k) => n + counts[k], 0)
    // The ledger counts the LAST entry per PR; a retried PR counted twice makes "remaining" negative
    // and finish reports more done than exists.
    if (resolved > counts.worklist) err(`counts: filed+clean+skipped+failed (${resolved}) exceeds worklist (${counts.worklist}) — a PR was counted twice`)
    if (m.status === 'complete' && resolved !== counts.worklist) err(`counts: a complete sweep must have resolved every PR (${resolved} of ${counts.worklist})`)
    // counts.worklist is 0 until the work-list is written (the planner's "worklistWritten" signal);
    // from there the slices partition it, and a PR-set sweep's work-list is exactly its input — a
    // self-reported number that disagrees with either is not "checked against the worklist".
    if (counts.worklist > 0) {
      if (slicedTotal > counts.worklist) err(`counts.worklist: ${counts.worklist}, but the slices hold ${slicedTotal} PRs — the slices partition the work-list`)
      if (input.kind === 'prs' && Array.isArray(input.prs) && counts.worklist !== input.prs.length) err(`counts.worklist: ${counts.worklist}, but input.prs lists ${input.prs.length} PRs — a PR-set sweep's work-list is its input`)
    }
  }

  const a = isObj(m.audit) ? m.audit : {}
  if (!isObj(m.audit)) err('audit: must be an object')
  oneOf('audit.status', AUDIT_STATUSES, a.status)
  // The audit runs on the FINISHED corpus (`fleet check finish` chains `audit plan`); an audit on a
  // sweep still filing would judge a corpus that is still growing.
  if (AUDIT_STATUSES.includes(a.status) && a.status !== 'pending' && m.status !== 'complete') err(`audit.status: ${a.status} on a ${JSON.stringify(m.status)} sweep — the audit runs on the finished corpus, after fleet check finish`)
  if (!Array.isArray(a.runs)) err('audit.runs: must be a list')
  else {
    const ids = new Set()
    for (const [i, r] of a.runs.entries()) {
      if (!isObj(r) || !isStr(r.auditRunId)) { err(`audit.runs[${i}]: must carry an auditRunId`); continue }
      // One entry per run: a duplicated id is two records of one audit, or a second `audit plan`
      // over the same corpus — the thing the playbook says never to do.
      if (ids.has(r.auditRunId)) err(`audit.runs[${i}].auditRunId: "${r.auditRunId}" is already a run — one entry per audit run`)
      ids.add(r.auditRunId)
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * PURE. A resume keeps everything the existing sweep resolved — tracker ids, umbrella, slices,
 * counts, snapshot — and its MODE: mode decides who files (cloud workers emit createIssue outbox
 * entries, local workers file directly), so a re-run in another mode is kept in the sweep's mode.
 * The `plan.mode-ignored` warning for that is planSweep's alone: it decides the mode from the existing
 * manifest BEFORE building the fresh one, so a mismatch here is never reported a second time. Only
 * status, updatedAt, width (the per-run pacing knob — a sweep that OOM'd resumes narrower) and
 * gate.autoPromote (`--auto` is per run) take the fresh run's values. A complete sweep stays
 * complete: re-running the command after finish is not "mid-way", and the audit follows it. Returns
 * a copy; the caller's objects are never aliased. `warnings` is the merge's own list, drained by the
 * planner alongside its own; nothing fills it today.
 * @returns {{manifest: object, warnings: Array<{code: string, message: string}>}}
 */
export function mergeOnResume(existing, fresh) {
  if (!existing || existing.sweepId !== fresh.sweepId) {
    throw new Error(`mergeOnResume: sweepId mismatch (${existing && existing.sweepId} vs ${fresh.sweepId})`)
  }
  const manifest = clone(existing)
  manifest.status = existing.status === 'complete' ? 'complete' : 'running'
  manifest.updatedAt = fresh.updatedAt
  manifest.width = fresh.width
  manifest.gate.autoPromote = fresh.gate.autoPromote
  return { manifest, warnings: [] }
}

/**
 * PURE. Every path of contract §4 under `<stateDir>/sweeps/<sweepId>/`. `platform` is injected,
 * never read from the process — that is what makes the layout testable on every OS at once.
 */
export function sweepLayout(stateDir, sweepId, platform) {
  const id = assertSweepId(sweepId)
  if (!platform) throw new Error('sweepLayout: platform is required (win32 | linux | darwin) — it decides the separator')
  const p = platform === 'win32' ? path.win32 : path.posix
  const dir = p.join(stateLayout(stateDir, platform).sweeps, id)
  return {
    dir,
    manifest: p.join(dir, 'manifest.json'),
    worklist: p.join(dir, 'worklist.tsv'),
    ledger: p.join(dir, 'ledger.tsv'),
    slices: p.join(dir, 'slices'),
    filed: p.join(dir, 'filed'),
    findings: p.join(dir, 'findings'),
    findingsJsonl: p.join(dir, 'findings.jsonl'),
    dups: p.join(dir, 'dups.tsv'),
    xref: p.join(dir, 'xref.tsv'),
    shots: p.join(dir, 'shots'),
    sweep: p.join(dir, '_sweep'),
    outbox: p.join(dir, 'outbox'),
    audit: p.join(dir, 'audit'),
    resume: p.join(dir, 'RESUME.md'),
  }
}

/** The layout keys that are directories (created by ensureSweepDir). */
export const SWEEP_DIRS = ['slices', 'filed', 'findings', 'shots', 'sweep', 'outbox', 'audit']

/**
 * PURE. The protocol pointer a fresh session with no context reads first. It names the three
 * files, the three counts, and the one reading of them that is a stop rather than a start.
 */
export function renderResumeMd(sweepId) {
  const id = assertSweepId(sweepId)
  return [
    `# Resume protocol — sweep ${id}`,
    '',
    'A fresh session with no context resumes this sweep from disk. This directory is the sweep dir',
    '(`FLEET_SWEEP_DIR` in a checker session; otherwise the path `fleet check plan --json` printed).',
    'Read these three files first, in this order, before touching the tracker or a worker:',
    '',
    '1. `manifest.json` — the sweep\'s truth: input, mode, base-branch snapshot sha, the tracker ids',
    '   (group, umbrella, assignee, labels, triage state), gate, capture strategy, slices, counts,',
    '   audit status. Reference everything by id from here; never re-resolve it.',
    '2. `worklist.tsv` — `<pr>\\t<merged_at|open>\\t<title>`, written once at the start, never edited.',
    '3. `ledger.tsv` — `<pr>\\t<status>\\t<issue_keys_or_->\\t<iso_ts>\\t<note>`, appended the moment each',
    '   PR resolves; `status` is exactly one of filed · clean · skipped · failed.',
    '',
    'Then run `fleet check ledger resume --json` and read all three counts: `worklist=`, `done=`,',
    '`remaining=`.',
    '',
    '⛔ A `done` of 0 on a non-empty ledger means the ledger did not load — not that no work was done.',
    'Stop and investigate rather than re-running the whole sweep.',
    '',
    'Then re-check the last `filed` line: a session can die between creating the issue and appending',
    'its line, so run op-16 findIssues for that PR\'s header line (`**PR:** #<n>`, within the sweep\'s',
    'group and provenance label) before filing it again.',
    '',
    'Resume = re-run the same command. Finished PRs are on the ledger and skipped. A PR is not done',
    'until its outcome is on disk; never write the ledger by hand — `fleet check ledger append` owns it.',
    '',
  ].join('\n')
}

/** Read `<dir>/manifest.json`. Absent → null (a fresh sweep); damaged or invalid → throws. */
export function readManifest(dir) {
  const file = path.join(dir, 'manifest.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let m
  try {
    m = JSON.parse(text)
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message}) — the sweep dir is damaged; do not re-plan over it`)
  }
  const v = validateManifest(m)
  if (!v.ok) throw new Error(`${file}: invalid manifest — ${v.errors.join('; ')}`)
  return m
}

let tmpCounter = 0

/**
 * Write `<dir>/<name>` so a reader never sees a half-written file: a temp file IN THE SAME
 * DIRECTORY (rename is atomic only within one filesystem), flushed, then renamed over the target.
 * A failure removes the temp file — nothing else ever does, and a leaked `.<name>.*.tmp` sits in
 * the sweep dir forever.
 */
function writeAtomic(dir, name, text) {
  const file = path.join(dir, name)
  const tmp = path.join(dir, `.${name}.${process.pid}.${tmpCounter++}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return file
}

/** Write `<dir>/manifest.json` atomically. An invalid manifest is refused before the disk is touched. */
export function writeManifest(dir, m) {
  const v = validateManifest(m)
  if (!v.ok) throw new Error(`manifest: refusing to write an invalid manifest — ${v.errors.join('; ')}`)
  fs.mkdirSync(dir, { recursive: true })
  return writeAtomic(dir, 'manifest.json', JSON.stringify(m, null, 2) + '\n')
}

/**
 * Present, a FILE, and non-empty: a 0-byte file is a crashed write, not a written one. A directory
 * under the name throws — it reports a size (4096 on ext4/APFS, 0 on Windows), so "size > 0" would
 * either keep it as written or rename a file onto it (EPERM); neither is "regenerate atomically".
 */
function hasContent(file) {
  let s
  try {
    s = fs.statSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
  if (s.isDirectory()) throw new Error(`${file}: is a directory — something else took the name; the sweep dir is damaged`)
  return s.isFile() && s.size > 0
}

/**
 * Create the contract §4 tree and write RESUME.md — once. A resume must not rewrite it:
 * `fleet check finish` marks it finished, and rewriting would erase that mark. A 0-byte RESUME.md is
 * absent, not written: it is the one file a context-less session reads first, so "exists" has to
 * mean "has the protocol in it". A directory under that name is damage and throws. Returns the layout.
 */
export function ensureSweepDir(stateDir, sweepId) {
  const layout = sweepLayout(stateDir, sweepId, process.platform)
  fs.mkdirSync(layout.dir, { recursive: true })
  for (const k of SWEEP_DIRS) fs.mkdirSync(layout[k], { recursive: true })
  if (!hasContent(layout.resume)) writeAtomic(layout.dir, 'RESUME.md', renderResumeMd(sweepId))
  return layout
}
