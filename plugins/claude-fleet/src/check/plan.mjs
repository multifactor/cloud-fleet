// Planning a sweep: input → sweepId → sweep dir, the mode and width decisions, the ORDERED location
// plan the launcher drains before any worker starts, and the disjoint slices workers take.
//
// PURE except for the thin sweep-dir wrapper at the bottom, which is manifest.mjs's filesystem half
// (ensureSweepDir + writeManifest) called once. The manifest SHAPE is manifest.mjs's — built with
// emptyManifest, merged with mergeOnResume, checked by validateManifest — so what this module plans is
// exactly what readManifest accepts back. Every rule here is a hand error that happened while this was
// prose:
//   * the sweepId is deterministic from the input, so re-running the command IS the resume — a sweep
//     that minted a fresh id per run lost its ledger the moment the session died; a `--from-file` id
//     hashes the RESOLVED path, so the same file named from another cwd is the same sweep;
//   * the sweepId is a plain directory name (assertSweepId): `--resume ../x` is refused, never joined;
//   * the location (group, assignee, labels, states, umbrella) is resolved ONCE, up front, and lives
//     in the manifest BY ID — a project pointer held in memory as a name drifted a sweep behind more
//     than once, and names carry apostrophes and get renamed;
//   * on resume, an already-resolved location op is NOT re-emitted and the slices are kept — a second
//     createProject splits one sweep across two groups and a second umbrella orphans half the
//     accessibility findings; width is this run's pacing knob (manifest.mjs mergeOnResume: a sweep
//     that OOM'd resumes narrower) and `--auto` is per run;
//   * readWorkItems is the FIRST entry: a createProject that succeeds before a readWorkItems that
//     fails leaves an empty group behind, and the work-list is the sweep's truth before anything else;
//   * exactly THREE labels are ensured at plan time (provenance, triage, gate:pending — playbook §2,
//     §7.4); the verdict labels belong to `fleet check gate apply`, and gate:waived is human-only;
//   * the screenshot strategy is chosen here, once, by chooseStrategy — a worker that chooses improvises;
//   * `--auto` is refused when no gate exists to collapse, and `--mode cloud` is refused without cloud
//     capture — a sweep never asks, it fails fast with a hint or runs to completion;
//   * slices are disjoint by construction and a slice name never contains the fid separator.
//
// Outbox entry shape: the core `{op, key, args, verbatim?, note?}` is what `fleet outbox add` (contract
// §7) and gate.mjs emit, and outbox.enqueue persists EXACTLY that core plus the id, seq and instant it
// mints itself — so a location entry is enqueue-able as it stands (`enqueue({stateDir, ...entry})`):
//   * `key` is the sweepId (the umbrella `<sweepId>:umbrella`, readWorkItems its input key) — enqueue
//     refuses a blank key, and a sweep-level op has no issue key; the key is data, never a path;
//   * the routing rides INSIDE `args.$manifest`, the one place enqueue keeps it — the launcher strips
//     `$manifest` before the adapter call and reads it back at ack. It carries `id`, `into` (the dotted
//     manifest LEAF path `fleet outbox ack --result` writes to; the ack REPLACES the value at that path;
//     null for readWorkItems, whose result goes to `worklist write`), `pick` (the field of the op result
//     that is written there; the whole result when absent), `fill` (args the launcher copies from
//     already-acked manifest paths at drain time — an entry whose fill source is still null waits) and
//     `needs` (the manifest paths it therefore depends on);
//   * top-level, for the plan's readers: `id` and `n`. The id derives from the op and what distinguishes
//     it (`loc-ensureLabel-<name>`), never from its position — a resume that owes fewer ops names each
//     one the same, so the launcher can dedupe against entries a dead run queued but never acked. `n`
//     is the contract §6 number — sections are keyed by number, never by name.
// A label name is one path segment of `tracker.labels.<name>`, so a configured label name may not
// contain `.`. resolveUser("me") lands at tracker.currentUser and the umbrella's assignee is filled from
// it (playbook §7.4: the umbrella is the current user's); tracker.assignee is the routed default for
// findings (checker.assignee). With the default "me" the two ops resolve the same user — one redundant
// op-3 per sweep is cheaper than a second shape of `into`.

import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { sweepIdFor } from './worklist.mjs'
import { makeFid } from './fid.mjs'
import { chooseStrategy, assetsBranchName } from './attach.mjs'
import { MODES, assertSweepId, emptyManifest, mergeOnResume, sweepLayout, ensureSweepDir, writeManifest } from './manifest.mjs'
import { renderTemplate } from '../config/derive.mjs'
import { getPath, clone } from '../config/defaults.mjs'
import { normalizeRemote } from '../config/paths.mjs'
import { OP_NAMES, canonicalKey } from '../trackers/registry.mjs'

/** What "as many as the harness runs concurrently" means when the harness limit is not known. */
export const DEFAULT_HARNESS_MAX = 10

const sha1 = s => createHash('sha1').update(s).digest('hex')

const refuse = (code, message, hint) => ({ ok: false, refused: { code, message, hint } })

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix)

// The same URL shapes worklist.mjs accepts inside a checklist line, anchored to a whole argument. A
// tail after the number (`/files`, `?diff=split`, `#issuecomment-1`) is the URL copied from any PR tab
// but "Conversation"; group 1 is the canonical `…/pull/<n>` URL.
const PR_URL = /^(https?:\/\/[^\s)]+?\/(?:pull|pull-requests|merge_requests|-\/merge_requests)\/(\d+))(?:[/?#].*)?$/
const PR_NUMBER = /^#?(\d+)$/
const PR_URL_TAIL = /\/(?:-\/)?(?:pull|pull-requests|merge_requests)\/\d+\/?$/

// `7`, `#007` and `0007` are one PR: the number is compared and hashed, so it is canonical here. A
// string strip, not Number(): a bare-digit tracker key can exceed 2^53.
const canonicalNumber = digits => digits.replace(/^0+(?=\d)/, '')

/** A PR argument (`123`, `#123`, or a PR URL) → `{number, url}` (url null for a bare number, canonical `…/pull/<n>` otherwise), else null. */
export function parsePrArg(item) {
  const s = String(item ?? '').trim()
  const n = PR_NUMBER.exec(s)
  if (n) return { number: canonicalNumber(n[1]), url: null }
  const u = PR_URL.exec(s)
  return u ? { number: canonicalNumber(u[2]), url: u[1] } : null
}

/** The `host/owner/name` a PR URL points at, in the form of facts.repoKey (paths.normalizeRemote). */
export function prUrlRepoKey(url) {
  return normalizeRemote(String(url).replace(PR_URL_TAIL, ''))
}

/**
 * Classify the command's arguments into ONE of the three input forms.
 * @param {{items?: string[], fromFile?: string|null}} args
 * @param {object|null} front  the adapter front matter (issueKey) — null when tracker-less
 * @param {{repoKey?: string|null, cwd?: string|null, platform?: string}} facts
 *   repoKey: the configured remote as `host/owner/name` — a PR URL on another repository is refused;
 *   cwd + platform: resolve a relative `--from-file` path, so the sweepId hashes the same file once.
 * @returns {{ok: true, input: object, warnings: object[]} | {ok: false, refused: object}}
 */
export function classifyInput({ items = [], fromFile = null } = {}, front = null, { repoKey = null, cwd = null, platform = 'linux' } = {}) {
  const warnings = []
  const list = (items || []).map(s => String(s).trim()).filter(Boolean)
  if (fromFile) {
    if (list.length) return refuse('plan.mixed-input', '--from-file cannot be combined with PR or key arguments', 'pass the PRs on the command line OR in the file, not both')
    const p = pathFor(platform)
    const raw = String(fromFile)
    // An absolute cwd, not merely a cwd: p.resolve falls back to process.cwd() for a relative one, and
    // a planner that reads the process cwd hashes a different sweepId per launch directory.
    if (!p.isAbsolute(raw) && !(cwd && p.isAbsolute(String(cwd)))) throw new Error('classifyInput: facts.cwd (absolute) is required to resolve a relative --from-file path — the sweepId hashes the resolved path, so the same file from another cwd is the same sweep')
    const resolved = p.isAbsolute(raw) ? p.normalize(raw) : p.resolve(cwd, raw)
    // A Windows filesystem is case-insensitive: `C:\Work\prs.txt` and `c:/work/prs.txt` are one file, so one sweep.
    return { ok: true, input: { kind: 'file', ref: platform === 'win32' ? resolved.toLowerCase() : resolved }, warnings }
  }
  if (!list.length) return refuse('plan.no-input', 'nothing to check', 'usage: /fleet-check <PR…|<KEY>|--from-file p>')

  const prs = []
  const keys = []
  const bad = []
  for (const item of list) {
    const pr = parsePrArg(item)
    // A URL or `#N` is a PR whatever the tracker's keys look like. A bare token is tried as a KEY
    // first: a tracker whose keys are bare digits (a task gid) would otherwise never be reachable by
    // key, because every run of digits reads as a PR number.
    if (pr && (pr.url || item.startsWith('#'))) { prs.push(pr); continue }
    const key = front ? canonicalKey(front, item) : null
    if (key) { keys.push(key); continue }
    if (pr) { prs.push(pr); continue }
    bad.push(item)
  }
  if (bad.length) {
    return refuse('plan.bad-input', `not a PR number, PR URL${front ? ' or issue key' : ''}: ${bad.join(', ')}`,
      front ? `a PR is "123", "#123" or its URL; a tracker issue looks like ${front.issueKey && front.issueKey.example ? front.issueKey.example : 'ABC-1234'}` : 'tracker.mode is none, so only PR numbers or URLs are accepted (or --from-file)')
  }
  if (keys.length && prs.length) return refuse('plan.mixed-input', 'PRs and a tracker issue were both given', 'a sweep takes PR arguments OR one tracker issue whose work items list the PRs')
  if (keys.length > 1) return refuse('plan.mixed-input', `more than one tracker issue given: ${keys.join(', ')}`, 'a sweep reads ONE issue\'s work items; run one sweep per issue')
  if (keys.length === 1) return { ok: true, input: { kind: 'tracker-issue', ref: keys[0] }, warnings }

  // A URL names a repository; the sweepId hashes only the number, so a foreign URL would silently
  // review the wrong PR AND collide with a sweep over the same local number.
  const urls = prs.filter(p => p.url)
  if (repoKey) {
    const foreign = urls.filter(p => prUrlRepoKey(p.url) !== repoKey)
    if (foreign.length) {
      return refuse('plan.foreign-pr-url', `not on the configured remote (${repoKey}): ${foreign.map(p => p.url).join(', ')}`,
        'a sweep reviews this repository\'s PRs only; a PR URL must point at the configured remote')
    }
  } else if (urls.length) {
    warnings.push({ code: 'plan.pr-url-unchecked', message: `the repository of ${urls.map(p => p.url).join(', ')} could not be checked against the configured remote (facts.repoKey is unknown); the number is used on the configured remote` })
  }

  // A PR named twice would land in two slices and be filed twice; dedupe, keep the first order, say so.
  const seen = new Set()
  const unique = []
  const dupes = []
  for (const pr of prs) {
    if (seen.has(pr.number)) dupes.push(pr.number)
    else { seen.add(pr.number); unique.push(pr) }
  }
  if (dupes.length) warnings.push({ code: 'plan.duplicate-prs', message: `duplicate PR arguments were collapsed: ${dupes.join(', ')}` })
  const input = { kind: 'prs', prs: unique.map(p => p.number) }
  if (urls.length) input.urls = Object.fromEntries(urls.map(p => [p.number, p.url]))
  return { ok: true, input, warnings }
}

/** `auto` | a positive integer | null when the value is neither. Digits only: Number() also reads `0x10`, `1e1` and `5.0`. */
const parseWidth = raw => {
  const s = String(raw).trim().toLowerCase()
  if (s === 'auto') return 'auto'
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * Workers per wave.
 * `auto` = as many as the harness runs concurrently; an explicit N is a CAP, never a floor. Memory
 * pressure throttles the wave to 1 (a wave that keeps its width on a straining machine is how a box
 * freezes mid-sweep), except in cloud mode where the workers do not run on this machine. In
 * `sessions` mode each worker is a full worktree with its own dev server, so `fleet.size` bounds it.
 * Throws on a malformed width — planSweep refuses operator input before it gets here.
 * @returns {{width: number, source: string, reason: string}}
 */
export function widthFor({ config, mode = 'local', harnessMax = null, memory = null, requested = null }) {
  const raw = requested ?? config.checker.waveWidth ?? 'auto'
  const parsed = parseWidth(raw)
  if (parsed === null) throw new Error(`width: expected a positive integer or "auto", got "${raw}"`)
  let width
  let source
  let reason
  if (parsed === 'auto') {
    width = harnessMax || DEFAULT_HARNESS_MAX
    source = harnessMax ? 'harness' : 'default'
    reason = harnessMax ? `auto: the harness runs ${harnessMax} concurrently` : `auto: the harness limit is unknown, so ${DEFAULT_HARNESS_MAX}`
  } else {
    source = requested != null ? '--width' : 'checker.waveWidth'
    width = parsed
    reason = `${source} = ${parsed}`
    if (harnessMax && parsed > harnessMax) {
      width = harnessMax
      reason = `${source} = ${parsed} exceeds what the harness runs concurrently (${harnessMax}); capped`
    }
  }
  if (mode === 'sessions' && config.fleet.size && width > config.fleet.size) {
    width = config.fleet.size
    reason = `bounded by fleet.size ${config.fleet.size}: each checker session is a full worktree with its own dev server`
  }
  const pressure = memory && memory.pressure
  if (mode !== 'cloud' && pressure && pressure !== 'normal' && width > 1) {
    width = 1
    reason = `memory pressure is ${pressure}; the wave serialises until the machine recovers`
  }
  return { width, source, reason }
}

const chunk = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Disjoint slices over the WHOLE work-list, computed once and recorded in the manifest (the `{slice,
 * prs}` shape manifest.mjs validates, plus the fid ranges). local / cloud: a slice is one wave of
 * `width` PRs. sessions: `width` slices, one per checker session (`FLEET_SLICE`), contiguous so a
 * session's share is readable from the manifest. A `prs` input is sliced at plan time; a
 * tracker-issue or file input is sliced by `fleet check worklist write` once the items are known.
 * @returns {Array<{slice: string, index: number, prs: string[], fidRanges: Array<{pr: string, first: string}>}>}
 */
export function sliceWorklist(prs, { width, mode = 'local' }) {
  if (!Number.isInteger(width) || width < 1) throw new Error(`sliceWorklist: width must be a positive integer, got "${width}"`)
  if (!MODES.includes(mode)) throw new Error(`sliceWorklist: unknown mode "${mode}"`)
  const list = (prs || []).map(String)
  const dupes = list.filter((p, i) => list.indexOf(p) !== i)
  if (dupes.length) throw new Error(`sliceWorklist: duplicate PRs ${[...new Set(dupes)].join(', ')} — a PR in two slices is filed twice`)
  if (!list.length) return []
  const chunks = mode === 'sessions' ? chunk(list, Math.ceil(list.length / width)) : chunk(list, width)
  const pad = Math.max(2, String(chunks.length).length)
  return chunks.map((c, i) => {
    const slice = 'a' + String(i + 1).padStart(pad, '0')
    // makeFid throws on a separator in the name, so a bad naming scheme fails here, not in a worker.
    return { slice, index: i + 1, prs: c, fidRanges: c.map(pr => ({ pr, first: makeFid(slice, pr, 1) })) }
  })
}

/** The only labels the sweep may create (op-18, launcher-only, once per sweep): playbook §2 and §7.4. */
function ensuredLabels(config) {
  const c = config.checker
  return [c.provenanceLabel, c.triage.label, c.gate.labels && c.gate.labels.pending].filter(Boolean)
}

function umbrellaBody({ sweepId, kind, markerLabels }) {
  const lines = [`**Sweep:** ${sweepId}`]
  // Without label support the markers a label would have carried live on body lines instead.
  if (markerLabels.length) lines.push(`**Labels:** ${markerLabels.join(', ')}`)
  lines.push(`**Gate:** pending (${sweepId})`, '')
  lines.push(kind === 'sub-issues'
    ? 'Every accessibility finding of this sweep is a sub-issue of this one, at the forced priority; each body states the severity the review assessed.'
    : 'This tracker has no sub-issues, so this issue is an INDEX: the orchestrator appends one line per accessibility finding as it is filed.')
  lines.push('', '**Recurring shapes:** _filled in by the orchestrator at finish, from the findings — cite only constructs that exist on the base branch._')
  return lines.join('\n')
}

/**
 * The ordered location plan. `resolved` is the manifest's `tracker` section on a resume; an op whose
 * result already sits there is not emitted again.
 */
function locationPlan({ config, front, input, facts, sweepId, args, resolved, worklistWritten, warnings }) {
  const ops = []
  // `extra` = {pick?, fill?, needs?, note?}; everything but the note is routing and rides in args.$manifest.
  const push = (id, name, key, opArgs, into, { note = null, ...routing } = {}) => {
    const entry = { id, op: name, n: OP_NAMES.indexOf(name), key, args: { ...opArgs, $manifest: { id, into, ...routing } } }
    if (note) entry.note = note
    ops.push(entry)
  }
  const have = field => resolved != null && getPath(resolved, field) != null
  const caps = front.capabilities || {}
  const c = config.checker
  const scope = config.tracker.scope
  const markers = caps.labels === false ? 'body' : 'labels'
  const grouping = caps.grouping || null

  // 1. The work-list, before anything is created.
  if (input.kind === 'tracker-issue' && !worklistWritten) {
    push(`loc-readWorkItems-${input.ref}`, 'readWorkItems', input.ref, { key: input.ref }, null, { note: 'hand the result verbatim to `fleet check worklist write --items-json`' })
  }

  // 2. The group. Decided, never asked.
  if (grouping === 'none') {
    if (args.project) warnings.push({ code: 'plan.project-ignored', message: `--project ${args.project} ignored: this tracker has no grouping; filed issues are found by the provenance label only` })
  } else if (have('group')) {
    // Any value, not only `new`: the operator who passes one on a resume is told it did nothing.
    if (args.project) warnings.push({ code: 'plan.project-ignored', message: `--project ${args.project} ignored: the sweep already has its group (tracker.group in the manifest); a resume never re-resolves it, and a second group would split one sweep across two` })
  } else {
    const forceNew = args.project === 'new' || !!c.projectPerSweep
    const ref = args.project && args.project !== 'new' ? args.project : c.project
    if (ref && !forceNew) {
      push('loc-resolveProject', 'resolveProject', sweepId, { ref }, 'tracker.group', { pick: 'id' })
    } else {
      const tpl = c.projectNameTemplate || 'Edge-case sweep {date}'
      if (tpl.includes('{date}') && !facts.date) throw new Error('planSweep: facts.date is required to name a per-sweep group')
      push('loc-createProject', 'createProject', sweepId, { name: renderTemplate(tpl, { date: facts.date, sweepId }) }, 'tracker.group', { pick: 'id' })
    }
  }

  // 3. Users — userRefs, never names. The current user owns the umbrella (§7.4); checker.assignee is
  // the routed default for findings. Both are "me" by default, so both ops then resolve the same user.
  if (!have('currentUser')) push('loc-resolveUser-currentUser', 'resolveUser', sweepId, { ref: 'me' }, 'tracker.currentUser')
  if (!have('assignee')) push('loc-resolveUser-assignee', 'resolveUser', sweepId, { ref: c.assignee || 'me' }, 'tracker.assignee')

  // 4. Labels: the list workers pick from, and the three the sweep may create.
  if (markers === 'body') {
    warnings.push({ code: 'plan.labels-unsupported', message: 'this tracker has no labels; the provenance, triage and gate markers move to body lines' })
  } else {
    if (!have('labelList')) push('loc-listLabels', 'listLabels', sweepId, { scope }, 'tracker.labelList')
    for (const name of ensuredLabels(config)) {
      if (!have(`labels.${name}`)) push(`loc-ensureLabel-${name}`, 'ensureLabel', sweepId, { scope, name }, `tracker.labels.${name}`, { pick: 'id' })
    }
  }

  // 5. States: the triage and ready refs are picked from this list by the launcher.
  if (!have('stateList')) {
    push('loc-listStates', 'listStates', sweepId, { scope }, 'tracker.stateList', {
      note: 'resolve checker.triage.state and checker.ready.state (names, frozen under manifest.checker) against this list and write the refs to tracker.triage.state / tracker.ready.state; the umbrella entry waits on the triage ref',
    })
  }

  // 6. The a11y umbrella — one per sweep, shared state, created here and nowhere else.
  let umbrellaKind = null
  if (c.a11y.umbrella) {
    if (caps.createIssue === false) {
      warnings.push({ code: 'plan.umbrella-unsupported', message: 'this tracker cannot create issues; accessibility findings are not grouped' })
    } else {
      umbrellaKind = caps.subIssues ? 'sub-issues' : 'index'
      if (umbrellaKind === 'index') warnings.push({ code: 'plan.umbrella-index', message: 'this tracker has no sub-issues; the umbrella degrades to an index issue the orchestrator maintains (op-23 unsupported)' })
      if (!have('umbrella')) {
        const a11y = [c.a11y.labels.keyboard, c.a11y.labels.screenReader].filter(Boolean)
        const roleLabels = ensuredLabels(config)
        // The umbrella is the current user's (§7.4), whatever checker.assignee routes findings to.
        const fill = { assignee: 'tracker.currentUser' }
        if (grouping !== 'none') fill.group = 'tracker.group'
        const opArgs = {
          title: c.a11y.umbrellaTitle || 'a11y',
          body: umbrellaBody({ sweepId, kind: umbrellaKind, markerLabels: markers === 'body' ? [...a11y, ...roleLabels] : [] }),
          labels: markers === 'labels' ? [...a11y, ...roleLabels] : [],
          // The umbrella sits at the forced priority so it sorts with its children; with no forced
          // priority configured the children keep their assessed priority and the parent takes Low.
          priority: c.a11y.forcedPriority == null ? 4 : c.a11y.forcedPriority,
          assignee: null,
          group: null,
        }
        // The triage state travels as the REF the launcher resolves from the state list — never as
        // its config name, which is what "by ID" means for the one issue the plan itself creates.
        if (c.triage.state) { opArgs.state = null; fill.state = 'tracker.triage.state' }
        // No issue key yet — the outbox's op-13 convention is an opaque key that is data, never a path.
        push('loc-createIssue-umbrella', 'createIssue', `${sweepId}:umbrella`, opArgs, 'tracker.umbrella', { pick: 'key', fill, needs: Object.values(fill) })
      }
    }
  }

  return { ops, markers, grouping, umbrellaKind }
}

function buildManifest({ sweepId, input, mode, width, config, facts, args, trackerless, loc, strategy, assetsBranch, slices }) {
  const c = config.checker
  const m = emptyManifest({
    sweepId,
    input,
    mode,
    width,
    repoKey: facts.repoKey || null,
    baseBranch: config.repo.baseBranch,
    snapshotSha: facts.snapshotSha || null,
    at: facts.now,
    tracker: {
      id: trackerless ? null : config.tracker.id,
      mode: trackerless ? 'none' : config.tracker.mode,
      scope: config.tracker.scope ?? null,
      markers: loc.markers,
      grouping: loc.grouping,
      umbrellaKind: loc.umbrellaKind,
      currentUser: null,
      labelList: null,
      stateList: null,
      triage: { state: null, label: c.triage.label || null },
      ready: { state: null, label: c.ready.label || null },
      provenanceLabel: c.provenanceLabel || null,
    },
    gate: { autoPromote: args.auto ? 'after-audit' : c.autoPromote, labels: { ...c.gate.labels }, pendingLine: `**Gate:** pending (${sweepId})` },
    capture: { mode: config.capture.mode, attachStrategy: strategy, assetsBranch, accounts: (config.capture.accounts || []).length, localSlots: config.testing.count },
  })
  if (input.urls) m.input.urls = input.urls
  m.slices = slices
  // The sweep's frozen view of the config it runs against — never re-read mid-sweep.
  m.checker = clone(c)
  m.review = clone(config.review)
  m.sensitivePaths = [...(config.vcs.sensitivePaths || [])]
  return m
}

const badSweepId = id => {
  try { assertSweepId(id); return null } catch (e) {
    return refuse('plan.bad-sweep-id', e.message, 'a sweepId is the one `fleet check status --json` lists: a tracker key, prs-<sha1> or file-<sha1>')
  }
}

/**
 * Plan (or resume) a sweep. PURE.
 * @param {{args?: object, config: object, adapter?: {front: object}|null, facts: object, existingManifest?: object|null}} p
 *   args: {items[], fromFile, project, mode, auto, width, resume, dryRun} — the parsed command line
 *   facts: {platform, now, date, cwd, repoKey, snapshotSha, harnessMax, memory: {pressure}, hasRestToken, worklistWritten}
 *     — injected, never probed here; `platform` and `now` are required, and on a resume so is
 *     `worklistWritten` (whether `<sweepDir>/worklist.tsv` exists — sweepLayout().worklist — as a boolean)
 *   existingManifest: the manifest read back by manifest.mjs readManifest, when the sweep exists
 * @returns {{ok: true, sweepId, input, mode, width, widthReason, stateDir, sweepDir, locationOps, warnings, manifest, slices, resume, dryRun, auto} | {ok: false, refused: {code, message, hint}}}
 */
export function planSweep({ args = {}, config, adapter = null, facts = {}, existingManifest = null }) {
  const warnings = []
  const trackerless = !config.tracker.id || config.tracker.mode === 'none'
  const front = trackerless ? null : (adapter && adapter.front) || null
  if (!trackerless && !front) throw new Error(`planSweep: tracker.id is "${config.tracker.id}" but no adapter was given`)
  for (const k of ['platform', 'now']) if (!facts[k]) throw new Error(`planSweep: facts.${k} is required — the planner is pure and never probes it`)

  // Mode: the manifest is the sweep's truth once it exists.
  let mode
  if (existingManifest) {
    mode = existingManifest.mode
    if (args.mode && args.mode !== mode) warnings.push({ code: 'plan.mode-ignored', message: `--mode ${args.mode} ignored: this sweep runs in ${mode} mode (the manifest is the sweep's truth)` })
  } else {
    mode = args.mode || config.checker.defaultMode || 'local'
  }
  if (!MODES.includes(mode)) return refuse('plan.bad-mode', `unknown mode "${mode}"`, `--mode ${MODES.join('|')}`)
  if (mode === 'cloud' && config.capture.mode !== 'cloud') {
    return refuse('plan.cloud-needs-cloud-capture', `--mode cloud needs capture.mode cloud (it is "${config.capture.mode}"): a sandbox has no local slot to screenshot from`,
      'set capture.mode to cloud (with capture.bootstrapScript, capture.requiredEnv and capture.allowlistHosts), or run --mode local|sessions')
  }
  // The EFFECTIVE promotion setting: `--auto` on this run, or checker.autoPromote from config (§9 applies
  // the refusal to "after-audit (or --auto on this run)" — the same promotion path runs either way).
  const autoFrom = args.auto ? '--auto' : config.checker.autoPromote === 'after-audit' ? 'checker.autoPromote = after-audit' : null
  if (autoFrom && !config.checker.triage.label && !config.checker.ready.state) {
    return refuse('plan.auto-without-gate', `there is no gate to collapse (${autoFrom}): neither checker.triage.label nor checker.ready.state is set, so a promoted ticket would look exactly like a filed one`,
      `set checker.triage.label (or checker.ready.state) so promotion has somewhere to move a ticket, or ${args.auto ? 'drop --auto' : 'fleet config set checker.autoPromote never'}`)
  }
  if (args.width != null && parseWidth(args.width) === null) return refuse('plan.bad-width', `--width "${args.width}" is not a positive integer or "auto"`, '--width N|auto')
  if (config.checker.waveWidth != null && parseWidth(config.checker.waveWidth) === null) {
    return refuse('plan.bad-width', `checker.waveWidth "${config.checker.waveWidth}" is not a positive integer or "auto"`, 'fleet config set checker.waveWidth N|auto')
  }
  const dotted = ensuredLabels(config).find(name => name.includes('.'))
  if (dotted) return refuse('plan.bad-label-name', `label "${dotted}" contains "." — a label name is one segment of the manifest path tracker.labels.<name>`, 'rename checker.provenanceLabel / checker.triage.label / checker.gate.labels.pending without a dot')

  // Input.
  let input
  if (args.resume) {
    const bad = badSweepId(args.resume)
    if (bad) return bad
    if (!existingManifest) return refuse('plan.resume-missing', `no sweep "${args.resume}" to resume`, 'fleet check status --json lists the known sweeps; re-running the original command resumes without --resume')
    input = clone(existingManifest.input)
    // The usage line allows PRs or a key beside --resume; the manifest wins, and the operator who
    // passed a different list is told so rather than left believing it was checked.
    const dropped = [...(args.items || []).map(s => String(s).trim()).filter(Boolean), ...(args.fromFile ? [`--from-file ${args.fromFile}`] : [])]
    if (dropped.length) warnings.push({ code: 'plan.input-ignored', message: `--resume ${args.resume}: ${dropped.join(', ')} ignored — a resumed sweep runs over the input in its manifest` })
  } else {
    const classified = classifyInput(args, front, { repoKey: facts.repoKey || null, cwd: facts.cwd || null, platform: facts.platform })
    if (!classified.ok) return classified
    input = classified.input
    warnings.push(...classified.warnings)
  }
  if (input.kind === 'tracker-issue') {
    if (trackerless) return refuse('plan.key-without-tracker', `"${input.ref}" looks like a tracker issue but tracker.mode is none`, 'pass the PRs directly, or --from-file p')
    if (front.capabilities && front.capabilities.workItems === 'none') return refuse('plan.no-work-items', `this tracker cannot hold a work-list, so "${input.ref}" cannot be read with op-26`, 'pass the PRs directly, or --from-file p')
  }

  const sweepId = args.resume || sweepIdFor(input, sha1)
  // A custom adapter whose key pattern admits a separator would otherwise escape the sweeps dir.
  const badId = badSweepId(sweepId)
  if (badId) return badId
  if (existingManifest && existingManifest.sweepId !== sweepId) {
    throw new Error(`planSweep: the manifest is for sweep "${existingManifest.sweepId}", not "${sweepId}"`)
  }
  const stateDir = config.paths.stateDir
  if (!stateDir) throw new Error('planSweep: paths.stateDir is not resolved')
  const sweepDir = sweepLayout(stateDir, sweepId, facts.platform).dir

  // Width is per run — on a resume it paces THIS run over the slices the manifest already holds.
  const width = widthFor({ config, mode, harnessMax: facts.harnessMax, memory: facts.memory, requested: args.width })

  // The screenshot route, chosen once; a forced route the tracker cannot serve is refused here, not
  // on the three-hundredth issue. No adapter (tracker-less) is `capabilities: null` — attach.mjs reads
  // that as "local markdown: shows an inline image, uploads nowhere".
  const strategy = chooseStrategy({ capabilities: front ? front.capabilities : null, config, vcsHost: config.vcs.host, hasRestToken: !!facts.hasRestToken })
  if (!strategy.ok) {
    return strategy.forced
      ? refuse('plan.attach-strategy-unsupported', strategy.reason, `set checker.attachStrategy to auto (which would choose ${strategy.auto}) or to a route this tracker supports`)
      : refuse('plan.vcs-host-unresolved', strategy.reason, 'vcs.host is derived from the origin URL: run `fleet config resolve`, or set vcs.host to github|gitlab|other')
  }
  let assetsBranch = null
  if (strategy.strategy === 'assets-branch') {
    try { assetsBranch = assetsBranchName(config.vcs.assetsBranchTemplate, sweepId) } catch (e) {
      return refuse('plan.bad-assets-branch', e.message, 'fix vcs.assetsBranchTemplate ({key} is the only placeholder)')
    }
  }

  // Whether worklist.tsv exists is a FACT the CLI stats, never inferred from counts.worklist: a `<KEY>`
  // sweep whose checklist produced zero rows has a written (empty) work-list, and re-emitting
  // readWorkItems on every resume re-derives what the playbook writes once — and then trips
  // `worklist write`'s refuse-to-overwrite.
  if (existingManifest && typeof facts.worklistWritten !== 'boolean') {
    throw new Error('planSweep: facts.worklistWritten is required on a resume — whether <sweepDir>/worklist.tsv exists (sweepLayout().worklist); the planner is pure and never stats it')
  }

  // The location. A tracker-less sweep has none to resolve: findings go to findings.jsonl.
  let loc = { ops: [], markers: null, grouping: null, umbrellaKind: null }
  if (trackerless) {
    warnings.push({ code: 'plan.tracker-less', message: 'tracker.mode is none: findings go to findings.jsonl with CHK-<sweepId>-<n> ids; no location to resolve' })
  } else {
    loc = locationPlan({
      config, front, input, facts, sweepId, args, warnings,
      resolved: existingManifest ? existingManifest.tracker : null,
      worklistWritten: !!existingManifest && facts.worklistWritten,
    })
  }

  // Slices: a PR list is fully known now; the other inputs are sliced by `worklist write`.
  const slices = !existingManifest && input.kind === 'prs' ? sliceWorklist(input.prs, { width: width.width, mode }) : []
  const fresh = buildManifest({ sweepId, input, mode, width: width.width, config, facts, args, trackerless, loc, strategy: strategy.strategy, assetsBranch, slices })
  let manifest = fresh
  if (existingManifest) {
    const merged = mergeOnResume(existingManifest, fresh)
    manifest = merged.manifest
    warnings.push(...merged.warnings)
  }

  return {
    ok: true,
    sweepId,
    input,
    mode,
    width: width.width,
    widthReason: width.reason,
    stateDir,
    sweepDir,
    locationOps: loc.ops,
    warnings,
    manifest,
    slices: manifest.slices,
    resume: !!existingManifest,
    dryRun: !!args.dryRun,
    auto: manifest.gate.autoPromote === 'after-audit',
  }
}

// ---- the thin sweep-dir wrapper (the only I/O in this module) -----------------------------------

/**
 * Materialise a plan: the contract §4 tree and RESUME.md (manifest.mjs ensureSweepDir, both written
 * once), then `manifest.json` (writeManifest: validated, temp + rename in the same directory). A plan
 * made WITHOUT the existing manifest is refused over an existing sweep dir: its location ops would
 * run a second createProject and a second umbrella against a sweep that already has both. A resume
 * writes the merged manifest — the resolved ids and slices it kept, plus this run's status,
 * updatedAt, width and --auto.
 * @returns {{sweepDir: string, manifestFile: string, resumeFile: string, created: boolean}}
 */
export function writeSweepDir(plan) {
  if (!plan || !plan.ok) throw new Error('writeSweepDir: refusing to materialise a refused plan')
  const layout = ensureSweepDir(plan.stateDir, plan.sweepId)
  const existed = fs.existsSync(layout.manifest)
  if (existed && !plan.resume) {
    throw new Error(`writeSweepDir: a manifest already exists for sweep "${plan.sweepId}" (${layout.manifest}); re-plan with existingManifest from readManifest so the location ops resume instead of creating a second group and umbrella`)
  }
  writeManifest(layout.dir, plan.manifest)
  return { sweepDir: layout.dir, manifestFile: layout.manifest, resumeFile: layout.resume, created: !existed }
}
