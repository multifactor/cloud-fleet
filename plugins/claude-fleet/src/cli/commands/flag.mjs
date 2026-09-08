// `fleet flag done|blocked|clear` (contract §5 + §7) — the only way a session tells the launcher
// anything. It writes a file and returns; nobody is reading the session's window.
//
//   ⛔ The flag is the SIGNAL, and the launcher acts on it with no waiting period, so it is written
//      whole or not at all: temp file in the same directory, then renamed over the target. A reader
//      that catches a half-written flag either sees nothing (and polls again) or sees a complete
//      one — never an outcome without its reason.
//   ⛔ The one-line `.txt` twin is written FIRST. The watcher acts on the `.json`, and a twin that
//      lands after it is a tail that is missing the very flag the fleet just reclaimed on.
//   ⛔ The enums are validated HERE. A flag carrying an outcome the reclaimer does not know is
//      refused by the reclaimer — silently, from the session's point of view, hours later, with the
//      session already gone and its worktree still holding 4 GB.
//   ⛔ `clear` retires an ANSWERED blocked flag. Without it an answered flag reads as an open one
//      forever, and the launcher diffuses the same block on every turn of its monitor loop.

import fs from 'node:fs'
import path from 'node:path'

import { flagsDir, doneFlagPaths, OUTCOMES } from '../../watchers/reclaim.mjs'
import { readSession } from '../../core/fleet.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag, listFlag } from '../args.mjs'

export const name = 'flag'
export const usage = 'fleet flag done --outcome <o> [--pr-url u] [--reason r] [--evidence p:l…] [--prescription followed|amended|refuted] [--body-patched] | blocked --category <c> --observation <t> [--evidence-url u] | clear [--label n] [--all]'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['done', 'blocked', 'clear']

/**
 * Contract §7's category list — the one to validate against.
 *
 * §5's shorter list predates `capture-spec`, `usage-limit` and `merge`, and a session refused for
 * naming a category the CLI's own help offers would flag `other` instead, which is the bucket the
 * launcher cannot triage.
 */
export const CATEGORIES = Object.freeze([
  'dev-server', 'testing-slot', 'services', 'emulator', 'tracker', 'cloud-env', 'install',
  'capture-spec', 'usage-limit', 'merge', 'other',
])

/** Contract §5: what happened to a checker ticket's prescribed fix. */
export const PRESCRIPTIONS = Object.freeze(['followed', 'amended', 'refuted'])

/** An outcome whose whole report is its `reason` (and `evidence`), so a flag without one says nothing. */
const REASON_REQUIRED = Object.freeze(['cancelled', 'duplicate', 'no-code-change'])

// A label is a FILENAME: `done-<label>.json` is joined onto the flags directory, and a label that
// reached here from FLEET_LABEL or --label could otherwise write a file outside the state dir.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const BLOCKED_RE = /^blocked-([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/

function assertLabel(label, where) {
  const s = typeof label === 'number' ? String(label) : label
  if (typeof s !== 'string' || !LABEL_RE.test(s)) {
    throw new CliError('flag.bad-label', `${where} ${JSON.stringify(label)} is not a session label ([A-Za-z0-9._-], not starting with ".")`, 'a label is a filename, never a path')
  }
  return s
}

/** `blocked-<label>.json` and its one-line `.txt` twin — the shape reclaim.doneFlagPaths has for done. */
export function blockedFlagPaths(stateDir, label) {
  const dir = flagsDir(stateDir)
  const id = assertLabel(label, 'label')
  return { json: path.join(dir, `blocked-${id}.json`), txt: path.join(dir, `blocked-${id}.txt`) }
}

let tmpCounter = 0

/**
 * Temp file IN THE SAME DIRECTORY, flushed, renamed over the target, then the DIRECTORY flushed: a
 * rename is atomic only within one filesystem, and the launcher reads this file the moment it
 * appears. A failure removes the temp file, because nothing else ever sweeps
 * `.<name>.<pid>.<n>.tmp` out of the flags directory.
 *
 * ⛔ The fsyncs are the reboot case, and this flag is the one signal the whole reclaim loop is built
 * on: a hard freeze brings files that were mid-write back as NULs, and a rename that reached disk
 * ahead of its contents leaves a zero-length `done-<label>.json` — which the reclaimer reports as
 * unreadable, so the finished session's worktree is never reclaimed. Same sequence as
 * core/fleet.mjs and trackers/tickets.mjs, for the same reason.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpCounter++}.tmp`)
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
  fsyncDir(dir)
  return file
}

/**
 * Flush the directory entry the rename just created. Best effort by design: Windows cannot open a
 * directory for fsync at all, and a platform that refuses the flush is never a reason to fail a
 * write that has already landed.
 */
function fsyncDir(dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // EPERM/EISDIR/EACCES on Windows and some network filesystems: nothing to do here.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * PURE. The one-line twin, for `tail -f flags/*.txt`.
 *
 * Newlines are folded to spaces and NOTHING is cut: the twin is a whole sentence or it is a
 * misleading one, and text truncated at a character offset is what this project's rules forbid.
 */
export function twinLine(flag) {
  const one = v => String(v ?? '').replace(/\s+/g, ' ').trim()
  const parts = [flag.at, flag.outcome ? 'done' : 'blocked', `label=${flag.session}`, `issue=${flag.issue ?? '-'}`]
  if (flag.outcome) {
    parts.push(`outcome=${flag.outcome}`)
    if (flag.prUrl) parts.push(`pr=${flag.prUrl}`)
    if (flag.prescription) parts.push(`prescription=${flag.prescription}${flag.bodyPatched ? '+body-patched' : ''}`)
    if (flag.reason) parts.push(`reason=${one(flag.reason)}`)
  } else {
    parts.push(`category=${flag.category}`)
    if (flag.evidenceUrl) parts.push(`evidence=${flag.evidenceUrl}`)
    parts.push(`observation=${one(flag.observation)}`)
  }
  return parts.join(' ') + '\n'
}

function stateDirOf(ctx) {
  const stateDir = ctx.config.paths.stateDir
  if (!stateDir) {
    throw new CliError('flag.no-state-dir', 'paths.stateDir is unresolved on this machine, so there is nowhere to write a flag', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  return stateDir
}

/** The label this flag is about: `--label` where the contract allows it, else the session's own. */
function labelOf(ctx, args, { allowFlag = false } = {}) {
  const given = allowFlag ? stringFlag(args.flags, 'label', null) : null
  const label = given ?? String(ctx.env.FLEET_LABEL || '').trim()
  if (!label) {
    throw new CliError(
      'flag.no-label',
      'this command must know which session it speaks for, and FLEET_LABEL is unset',
      allowFlag ? 'run it inside a fleet session, or pass --label <n>' : 'a done/blocked flag is written by the session it is about; run it inside one',
      1,
    )
  }
  return assertLabel(label, given === null ? 'FLEET_LABEL' : '--label')
}

/** The issue this session was given, from its own descriptor — never guessed from a branch name. */
function issueOf(ctx, stateDir, label) {
  const d = readSession(label, { stateDir })
  return d && d.issue ? String(d.issue) : null
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('flag.unknown-subcommand', `fleet flag takes one of ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  if (sub === 'done') return done(ctx, args)
  if (sub === 'blocked') return blocked(ctx, args)
  return clear(ctx, args)
}

// ---- done ------------------------------------------------------------------------------------

function done(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const label = labelOf(ctx, args)
  const outcome = stringFlag(args.flags, 'outcome', null)
  if (!outcome || !OUTCOMES.includes(outcome)) {
    throw new CliError(
      'flag.bad-outcome',
      outcome ? `outcome "${outcome}" is not one of ${OUTCOMES.join(' | ')} (contract §5)` : '--outcome is required',
      'pr-pushed (a draft PR is open) · cancelled (already fixed on the base branch) · duplicate (another session shipped it) · no-code-change · check-complete',
    )
  }
  const prUrl = stringFlag(args.flags, 'pr-url', null)
  const reason = stringFlag(args.flags, 'reason', null)
  const prescription = stringFlag(args.flags, 'prescription', null)
  if (prescription !== null && !PRESCRIPTIONS.includes(prescription)) {
    throw new CliError('flag.bad-prescription', `prescription "${prescription}" is not one of ${PRESCRIPTIONS.join(' | ')}`, 'followed = implemented as written; amended = the diagnosis held, the fix did not; refuted = the mechanism does not exist')
  }
  // ⛔ `pr-pushed` with no URL leaves the launcher with nothing to verify, and it must NOT fall back
  // to a PR lookup: a finished session may legitimately have no PR at all, and a PR list filtered on
  // an empty branch name returns every PR there is — the first row being an unrelated one.
  if (outcome === 'pr-pushed' && !prUrl) {
    throw new CliError('flag.pr-url-required', 'outcome pr-pushed needs --pr-url', 'the launcher verifies the PR is linked to the issue; without the URL it would have to guess from a PR list, which is how an unrelated PR gets reported as this session\'s work')
  }
  if (REASON_REQUIRED.includes(outcome) && !reason) {
    throw new CliError('flag.reason-required', `outcome ${outcome} needs --reason`, 'the reason IS the report — it is posted to the tracker verbatim, and a cancellation nobody can explain is one nobody can trust')
  }

  const flag = {
    v: 1,
    session: label,
    issue: issueOf(ctx, stateDir, label),
    outcome,
    prUrl,
    reason,
    evidence: listFlag(args.flags, 'evidence'),
    prescription,
    bodyPatched: !!args.flags['body-patched'],
    at: new Date(ctx.now()).toISOString(),
  }

  const p = doneFlagPaths(stateDir, label)
  writeAtomic(p.txt, twinLine(flag))
  writeAtomic(p.json, JSON.stringify(flag, null, 2) + '\n')

  ctx.json(envelope(true, { flag, file: p.json, txt: p.txt }))
  ctx.log(`flagged done: ${label} ${outcome}${prUrl ? ` ${prUrl}` : ''} → ${p.json}`)
  // Both values, because both mean the ticket BODY still needs the correction: `amended` is the one
  // watchers/reclaim.mjs refuses on, and `refuted` is the one playbooks/launcher.md names — and
  // refuted ("the mechanism does not exist") is the case that most needs the ⛔ note where the next
  // reader acts. A note on only one of them is a note the other case never gets.
  if ((prescription === 'amended' || prescription === 'refuted') && !flag.bodyPatched) {
    ctx.log(`note: a ${prescription} prescription with no --body-patched means the op-15 patchBody is still in the outbox — the launcher drains it before reclaiming, so leave it queued`)
  }
  return 0
}

// ---- blocked ---------------------------------------------------------------------------------

function blocked(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const label = labelOf(ctx, args)
  const category = stringFlag(args.flags, 'category', null)
  if (!category || !CATEGORIES.includes(category)) {
    throw new CliError(
      'flag.bad-category',
      category ? `category "${category}" is not one of ${CATEGORIES.join(' | ')}` : '--category is required',
      'the category routes the launcher\'s diagnosis: dev-server and testing-slot are probed against the whole machine, capture-spec means your own spec is wrong rather than the environment, and usage-limit stops the whole fleet',
    )
  }
  const observation = stringFlag(args.flags, 'observation', null)
  if (!observation || !observation.trim()) {
    throw new CliError('flag.observation-required', '--observation is required', 'say what you OBSERVED just now — the probe you ran and what came back; a flag citing a ticket or somebody else\'s report is sent back, because tickets stay open long after their cause is gone')
  }

  const flag = {
    v: 1,
    session: label,
    issue: issueOf(ctx, stateDir, label),
    category,
    observation,
    evidenceUrl: stringFlag(args.flags, 'evidence-url', null),
    at: new Date(ctx.now()).toISOString(),
  }

  const p = blockedFlagPaths(stateDir, label)
  writeAtomic(p.txt, twinLine(flag))
  writeAtomic(p.json, JSON.stringify(flag, null, 2) + '\n')

  ctx.json(envelope(true, { flag, file: p.json, txt: p.txt }))
  ctx.log(`flagged blocked: ${label} ${category} → ${p.json}`)
  ctx.log('keep working on everything that does not need the blocked resource; the launcher answers with `fleet send`, and you clear the flag with `fleet flag clear` once you are unblocked')
  return 0
}

// ---- clear -----------------------------------------------------------------------------------

/** Every `blocked-<label>.json` currently in the flags directory. A missing directory is none. */
function blockedLabels(stateDir) {
  let names
  try {
    names = fs.readdirSync(flagsDir(stateDir))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return names.map(n => BLOCKED_RE.exec(n)).filter(Boolean).map(m => m[1]).sort()
}

function clear(ctx, args) {
  const stateDir = stateDirOf(ctx)
  const all = !!args.flags.all
  const given = stringFlag(args.flags, 'label', null)
  if (all && given) throw new CliError('flag.clear-all-and-label', '--all and --label contradict each other', 'clear one session\'s flag with --label <n>, or every answered one with --all')

  const labels = all ? blockedLabels(stateDir) : [labelOf(ctx, args, { allowFlag: true })]
  const cleared = []
  for (const label of labels) {
    const p = blockedFlagPaths(stateDir, label)
    // Removed only if it was there: "cleared 1 flag" when there was none reads as an answered block.
    const existed = fs.existsSync(p.json) || fs.existsSync(p.txt)
    fs.rmSync(p.json, { force: true })
    fs.rmSync(p.txt, { force: true })
    if (existed) cleared.push({ label, file: p.json })
  }

  // ⛔ A done flag is NEVER cleared here. It is the authorisation the reclaimer acts on, and deleting
  // it leaves a finished session holding its worktree with nothing left to say so.
  const doneLeft = labels.filter(l => fs.existsSync(doneFlagPaths(stateDir, l).json))

  ctx.json(envelope(true, { cleared, doneFlagsLeft: doneLeft, scanned: labels }))
  ctx.log(cleared.length ? `cleared ${cleared.length} blocked flag(s): ${cleared.map(c => c.label).join(', ')}` : 'no blocked flag to clear')
  for (const l of doneLeft) ctx.log(`note: ${l} also has a done flag — left in place; it is the authorisation the reclaimer acts on`)
  return 0
}
