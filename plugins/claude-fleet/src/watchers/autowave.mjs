// Autowave: keeps the fleet topped up from `<stateDir>/queue.txt` (contract §4) without a token.
//
// Every rule here is a run that went wrong, and each is stated where it is enforced:
//
//   * capacity comes from `git worktree list`, NEVER from a folder count — twenty folders sat on disk
//     while seven worktrees were real (a forced removal deregisters and then fails to unlink), and a
//     folder-counting gate saw a full fleet and refused every top-up for hours; a registration is a
//     session worktree by NAME AND PARENT, and a `prunable` one (directory gone) holds no session;
//   * nothing launches while a launcher is running — two launchers read the same worktree list and
//     each skips the worktrees the other just created, and a skipped slot silently drops its issue;
//   * the queue is rewritten from code that truncates on empty — an empty remainder piped through a
//     shell writer left the file UNCHANGED, and the same two keys were relaunched six times, twelve
//     sessions on two tickets; and it is written fsync'd, because a hard freeze once brought files
//     mid-write back as NULs and a NUL queue is a silently dropped work list;
//   * the wave POPS its keys and plans from what it popped — the launcher fills `queue.txt` too, so
//     a plan made from a peek can name keys the file no longer hands out;
//   * every key passes core/intake.admit against the ticket cache, and a refusal is LOGGED — a queue
//     that silently shrinks reads as "there was no work" — and REPLACED from the queue, so a wave is
//     never short by its refusals; an admission with a warning is logged too;
//   * the wave aims PAST the target by an overshoot margin, under `fleet.hardCeiling` — a launcher run
//     is install-paced and sessions finish during it, so launching exactly `target − live` lands short
//     every time and the fleet asymptotes below its target;
//   * at most one refill wave per interval, and the arithmetic is logged as
//     `live/target/overshoot/ceiling → launching N`, so a short wave is visible instead of looking like a
//     stalled autowave.
//
// Split like the rest of the plugin: capacity(), waveGate(), refillPlan(), downTransition() and
// stopPlan() are PURE over injected data; nextKeys()/admitKeys() are the queue and cache halves with
// their I/O kept thin; autowavePass() joins them with the launcher spawn injected as `runFleet`.

import fs from 'node:fs'
import path from 'node:path'

import { listWorktrees, templatePattern, samePath, canonicalPath } from '../core/worktree.mjs'
import { admit } from '../core/intake.mjs'
import { stateLayout } from '../config/paths.mjs'
import { writeTextAtomic } from './guardian.mjs'

/** One refill wave per this many ms unless the caller says otherwise (no contract key exists yet). */
export const DEFAULT_INTERVAL_MS = 5 * 60_000

/**
 * The refusal reason for a queued key with no `tickets/<KEY>.json`. The gate cannot be judged
 * without the cached ticket, and a gate that cannot be judged FAILS CLOSED — the same direction the
 * reclaim gate fails in: refuse what cannot be verified, and say so, rather than launching a session
 * on a ticket the audit may not have passed.
 */
export const REFUSAL_NO_CACHE = 'no-ticket-cache'

// ---- capacity ----------------------------------------------------------------------------------

/** Basename of a path however git or Node spelt it (forward or back slashes, trailing separator). */
function basenameOf(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()
}

/**
 * PURE. The registrations that are WORKING-session worktrees, prunable ones included — told apart by
 * NAME, the anchored `repo.sessionDirTemplate` pattern (a testing slot or a checker tree is
 * registered too and must not count against the working target), AND by PARENT when
 * `repo.worktreeParent` is configured — the same positive identification reclaim.isFleetFolder makes
 * before it deletes. A registered checkout that merely happens to be named `<repo>-session-1` under
 * some other directory is the operator's, not fleet capacity, and counting it runs the fleet one
 * short for as long as it exists. Never a bare repository.
 */
function sessionShaped(registered, config) {
  const re = templatePattern(config.repo.sessionDirTemplate, { repo: config.repo.name })
  const parent = config.repo.worktreeParent ? canonicalPath(config.repo.worktreeParent) : null
  return (registered || []).filter(w => w && !w.bare && re.test(basenameOf(w.path))
    && (!parent || samePath(canonicalPath(path.dirname(String(w.path))), parent)))
}

/**
 * PURE. The LIVE working-session worktrees: session-shaped (name and parent, above) and not
 * `prunable` — `git worktree list` marks a registration whose directory is gone (hand-deleted, or a
 * removal that unlinked and failed to deregister), and no session lives in a directory that is not
 * there. Counting one runs the fleet permanently one short per stale registration until someone
 * prunes: the mirror image of the folder-count trap.
 */
export function sessionWorktrees(registered, config) {
  return sessionShaped(registered, config).filter(w => !w.prunable)
}

/**
 * PURE. Free working slots, from a `git worktree list` reading (core/worktree.listWorktrees) and the
 * config — never from a directory listing.
 *
 * `free` is what reaching the target needs; `headroom` is what `fleet.hardCeiling` still allows. Both
 * are clamped at zero: a fleet over its ceiling (the operator raised nothing, a wave overshot) is a
 * fleet that launches nothing, not a negative number that a later `Math.min` turns into a launch.
 * `prunable` counts the session-shaped registrations whose directory is gone, so the pass can say so.
 * @param {{registered: Array<{path: string, bare?: boolean, prunable?: boolean}>, config: object}} o
 * @returns {{live: number, target: number, ceiling: number, free: number, headroom: number, prunable: number}}
 */
export function capacity({ registered, config }) {
  const target = config.fleet.size
  if (!Number.isInteger(target) || target < 0) {
    throw new Error(`capacity: fleet.size is not resolved (${JSON.stringify(target)}) — derive the config before running the autowave`)
  }
  // fleet.hardCeiling: contract §3 gives the key and its default (`size+2`) and nothing more; "never
  // exceeded by auto-refill" is the schema's own describe text (src/config/schema.mjs), enforced here.
  const ceiling = Number.isInteger(config.fleet.hardCeiling) ? config.fleet.hardCeiling : target + 2
  const shaped = sessionShaped(registered, config)
  const live = shaped.filter(w => !w.prunable).length
  return {
    live,
    target,
    ceiling,
    free: Math.max(0, Math.min(target, ceiling) - live),
    headroom: Math.max(0, ceiling - live),
    prunable: shaped.length - live,
  }
}

/**
 * The thin half: take the worktree list from the PRIMARY checkout and judge it purely. A failed
 * listing THROWS out of listWorktrees rather than reading as an empty fleet — an empty list is what
 * would make this launch a full fleet on top of a live one.
 */
export function measureCapacity({ primary, config }) {
  return capacity({ registered: listWorktrees(primary), config })
}

// ---- the queue ---------------------------------------------------------------------------------

/** `<stateDir>/queue.txt` — the layout itself lives in config/paths.mjs. */
export function queuePath(stateDir) {
  return stateLayout(stateDir, process.platform).queue
}

/** `<stateDir>/intake-refused.jsonl`. */
export function refusedPath(stateDir) {
  return stateLayout(stateDir, process.platform).intakeRefused
}

/**
 * PURE. Parse queue text: one key per line, priority-sorted, blank lines ignored, CRLF tolerated,
 * and a key that appears twice kept ONCE — two sessions on one ticket is exactly the collision the
 * queue bug produced, so a duplicate line is never handed out twice.
 */
export function parseQueue(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const key = raw.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Read the queue; [] when the file is absent (a first run has no queue yet). */
export function readQueue(queueFile) {
  try {
    return parseQueue(fs.readFileSync(queueFile, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

/**
 * Write the whole queue. ⛔ An EMPTY list writes an EMPTY file. The queue writer that piped its
 * remainder through a shell never ran for an empty remainder, left the old keys in place, and the
 * fleet relaunched the same two tickets six times — this function is the replacement, and the empty
 * case is what test/ covers first. Written through guardian.writeTextAtomic (temp file beside the
 * target, fsync'd, renamed): the queue is the fleet's whole work list and exists for unattended and
 * reboot operation, and a rename that reached disk before its contents is an empty queue that reads
 * as "there was no work".
 */
export function writeQueue(queueFile, keys) {
  const lines = parseQueue((keys || []).join('\n'))
  writeTextAtomic(queueFile, lines.length ? lines.join('\n') + '\n' : '')
}

/**
 * Pop the first `n` keys off the queue and rewrite it in one atomic replace.
 * @returns {{keys: string[], remaining: number, existed: boolean}}
 */
export function nextKeys({ queueFile, n }) {
  const existed = fs.existsSync(queueFile)
  const all = readQueue(queueFile)
  const take = Math.max(0, Math.floor(Number(n) || 0))
  if (!take || !all.length) return { keys: [], remaining: all.length, existed }
  const keys = all.slice(0, take)
  const rest = all.slice(take)
  writeQueue(queueFile, rest)
  return { keys, remaining: rest.length, existed }
}

/**
 * Put keys BACK at the head of the queue, in their original order. Used when a wave was popped but the
 * launcher could not be started: a popped key that never launched is a dropped ticket, and a dropped
 * ticket is the failure the autowave exists to prevent.
 */
export function pushFront({ queueFile, keys }) {
  writeQueue(queueFile, [...(keys || []), ...readQueue(queueFile)])
}

// ---- intake ------------------------------------------------------------------------------------

/**
 * The offline ticket cache `fleet ticket cache` writes (`tickets/<KEY>.json`), shaped for
 * core/intake.admit: `labels` and a `body` (op-2 says `description`; the gate line lives in either).
 * Returns null when there is no readable cache for the key. A key is a FILENAME here, so anything
 * that could climb out of the tickets directory is treated as uncached rather than joined.
 */
export function readCachedTicket(stateDir, key) {
  const k = String(key || '')
  if (!k || /[\\/]/.test(k) || k === '.' || k === '..') return null
  const file = path.join(stateLayout(stateDir, process.platform).tickets, `${k}.json`)
  let j
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  return { ...j, key: j.key || k, labels: Array.isArray(j.labels) ? j.labels : [], body: j.body ?? j.description ?? '' }
}

/** Append one refusal line. Its own newline, synchronously — never a pipeline (see sys/tsv.mjs). */
export function appendRefusal(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

/** Every refusal recorded so far, for `fleet status`; [] when none. */
export function readRefusals(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn last line (the process died mid-append) must not hide every earlier refusal.
    }
  }
  return out
}

/**
 * Screen popped keys through core/intake.admit against the ticket cache. Refusals are appended to
 * `intake-refused.jsonl` and returned — ⛔ never dropped silently, because the launcher lists them in
 * `fleet status` and the operator must be told which keys were refused and why. An admission that
 * carries intake's `warn` (`intake.gate-disabled`, `intake.waived`, `intake.mismatch`) is returned in
 * `warnings` for the same reason: it is the one trace that an unaudited ticket was launched.
 * @returns {{admitted: string[], refused: Array<{key, reason, gate}>, warnings: Array<{key, warn, gate}>}}
 */
export function admitKeys({ keys, stateDir, config, nowMs = Date.now(), readTicket = key => readCachedTicket(stateDir, key) }) {
  const admitted = []
  const refused = []
  const warnings = []
  const at = new Date(nowMs).toISOString()
  const file = refusedPath(stateDir)
  for (const key of keys || []) {
    const issue = readTicket(key)
    let verdict
    if (!issue) verdict = { admit: false, reason: REFUSAL_NO_CACHE, gate: null }
    else verdict = admit(issue, config)
    if (verdict.admit) {
      admitted.push(key)
      if (verdict.warn) warnings.push({ key, warn: verdict.warn, gate: verdict.gate ?? null })
      continue
    }
    const entry = { v: 1, key, reason: verdict.reason, gate: verdict.gate ?? null, source: 'autowave', at }
    appendRefusal(file, entry)
    refused.push(entry)
  }
  return { admitted, refused, warnings }
}

// ---- the plan ----------------------------------------------------------------------------------

/** The `fleet up` argv for a top-up: new sessions ABOVE the current highest label, one per key. */
export function upArgv(keys) {
  // `--no-wizard` because nobody is there to answer: a watcher that prompts hangs the whole loop.
  return ['up', '--add', String(keys.length), '--issues', keys.join(','), '--no-wizard']
}

/**
 * PURE. The gates a wave must pass BEFORE the queue is touched, and how many sessions it wants.
 *
 * `overshoot` defaults to `ceiling − target`: the ceiling defaults to `size + 2` (contract §3), so by
 * default the wave aims two past the target — the attrition of one install-paced launcher run — and
 * never past the ceiling, so a lull in completions cannot compound into a memory problem.
 *
 * Gates, in order: a busy launcher (safety), the pacing interval, a full fleet. None of them reads
 * the queue, so a held tick never consumes — or even opens — a key.
 * @returns {{want: number, hold: string|null, log: string|null, arithmetic: string}}
 */
export function waveGate({ capacity: cap, launcherBusy = false, overshoot = null, lastWaveAt = null, nowMs = Date.now(), intervalMs = DEFAULT_INTERVAL_MS }) {
  const over = overshoot === null || overshoot === undefined ? Math.max(0, cap.ceiling - cap.target) : Math.max(0, Math.floor(Number(overshoot) || 0))
  const aim = Math.min(cap.target + over, cap.ceiling)
  const want = Math.max(0, aim - cap.live)
  const arithmetic = `live=${cap.live} target=${cap.target} +overshoot=${over} (ceiling ${cap.ceiling})`
  const held = (hold, why) => ({ want, hold, log: `autowave: ${arithmetic} → ${why}`, arithmetic })

  if (launcherBusy) return held('launcher-busy', 'holding: a launcher is running (two launchers each skip the other\'s new worktrees and silently drop issues)')
  if (lastWaveAt !== null && lastWaveAt !== undefined && nowMs - lastWaveAt < intervalMs) {
    const left = Math.ceil((intervalMs - (nowMs - lastWaveAt)) / 1000)
    return held('paced', `holding: last wave was ${Math.round((nowMs - lastWaveAt) / 1000)}s ago, next in ${left}s`)
  }
  if (want === 0) return held('full', 'nothing to launch')
  return { want, hold: null, log: null, arithmetic }
}

const queueEmptyLine = arithmetic => `autowave: QUEUE EMPTY — ${arithmetic}, idling (an empty queue is a task: plan the next source)`

/**
 * PURE. Decide a wave over `keys` — the keys POPPED for it (autowavePass) or any candidate list: the
 * gates of waveGate, then an empty queue, and only then a wave of at most `want` keys.
 * @returns {{argv: string[]|null, launch: string[], want: number, hold: string|null, log: string}}
 */
export function refillPlan({ capacity: cap, keys = [], ...gates }) {
  const g = waveGate({ capacity: cap, ...gates })
  if (g.hold) return { argv: null, launch: [], want: g.want, hold: g.hold, log: g.log }
  const queue = keys || []
  if (!queue.length) return { argv: null, launch: [], want: g.want, hold: 'queue-empty', log: queueEmptyLine(g.arithmetic) }
  const launch = queue.slice(0, g.want)
  return { argv: upArgv(launch), launch, want: g.want, hold: null, log: `autowave: ${g.arithmetic} → launching ${launch.length}` }
}

/**
 * PURE. Should the autowave trigger `fleet down` now? ⛔ On the TRANSITION to zero, never on the
 * state: zero working sessions stays true forever once true, so an unguarded rule re-runs the full
 * teardown every tick. And only while something fleet-related is still up — once nothing is left,
 * idle quietly. The other three of `fleet down`'s checks (flags, the primary's cleanliness) are its own.
 */
export function downTransition({ prevLive, live, resourcesRemain }) {
  return Number(prevLive) > 0 && Number(live) === 0 && !!resourcesRemain
}

/**
 * PURE. May the autowave stop right now? ⛔ Not while a launcher it started is busy: a tree-kill aimed
 * at the autowave once took the in-flight installer with it and stranded thirteen worktrees with no
 * dependencies. The stop waits for the launcher to go idle, and says so.
 */
export function stopPlan({ launcherBusy }) {
  return launcherBusy
    ? { stopNow: false, reason: 'a launcher is running — stopping now would kill its installs mid-extract; wait for it to go idle' }
    : { stopNow: true, reason: null }
}

// ---- one pass ----------------------------------------------------------------------------------

/**
 * One autowave tick. Every side effect is injected: the worktree listing, the launcher spawn and the
 * ticket reader — so the incident behind each gate is a test, not a comment.
 *
 * @param {object} o
 * @param {object} o.config          resolved + derived config
 * @param {string} o.stateDir        contract §4 state directory
 * @param {string} o.primary         the PRIMARY checkout (never a worktree that may be deregistered)
 * @param {boolean} o.launcherBusy   is a `fleet up` running? (from the supervisor's process snapshot)
 * @param {number|null} o.lastWaveAt when the previous wave launched, for pacing
 * @param {(argv: string[]) => any} o.runFleet  spawns `fleet <argv>`; must not return until the launcher is STARTED
 * @returns {{capacity, hold, argv, launch, admitted, refused, warnings, ran, lastWaveAt, log: string[]}}
 */
export function autowavePass({
  config, stateDir, primary, nowMs = Date.now(), launcherBusy = false, lastWaveAt = null, overshoot = null,
  intervalMs = DEFAULT_INTERVAL_MS, listWorktrees: list = listWorktrees, runFleet, log = () => {}, readTicket = undefined,
}) {
  if (typeof runFleet !== 'function') throw new Error('autowavePass: runFleet is required')
  const lines = []
  const say = m => { lines.push(m); log(m) }

  // Capacity FIRST. A listing that throws ends the pass here, before the queue is opened, so a failed
  // `git worktree list` launches nothing and pops nothing.
  const cap = capacity({ registered: list(primary), config })
  if (cap.prunable) say(`autowave: ${cap.prunable} registered session worktree(s) whose directory is gone are not counted as live (git worktree prune from the primary clears them)`)
  const gate = waveGate({ capacity: cap, launcherBusy, overshoot, lastWaveAt, nowMs, intervalMs })
  const base = { capacity: cap, hold: gate.hold, argv: null, launch: [], admitted: [], refused: [], warnings: [], ran: false, lastWaveAt, log: lines }
  if (gate.hold) {
    say(gate.log)
    return base
  }

  // POP, then plan from what was popped. ⛔ Never peek-then-pop: `queue.txt` has TWO writers — the
  // launcher fills it (op-12 listQueue, the checker's findings; playbooks/launcher.md §Autowave) and
  // this pass drains it — with no lock between them, so a plan made from a peek can name keys a
  // re-filled or re-sorted file no longer hands out, and the keys reported as launched would differ
  // from the keys actually popped. A key refused at intake is REPLACED from the queue until the wave is
  // full or the queue is dry: a wave short by its refusals would still reset the pacing clock and land
  // the fleet under its target for a whole interval — the asymptote the overshoot exists to prevent.
  // (The pop itself is one unlocked read-modify-write; a mutex helps only if the launcher's filler
  // takes the same one, so the launcher APPENDS to the file and never rewrites it.)
  const queueFile = queuePath(stateDir)
  const launch = []
  const admitted = []
  const refused = []
  const warnings = []
  let remaining = 0
  while (admitted.length < gate.want) {
    const popped = nextKeys({ queueFile, n: gate.want - admitted.length })
    remaining = popped.remaining
    if (!popped.keys.length) break
    launch.push(...popped.keys)
    const r = admitKeys({ keys: popped.keys, stateDir, config, nowMs, ...(readTicket ? { readTicket } : {}) })
    admitted.push(...r.admitted)
    refused.push(...r.refused)
    warnings.push(...r.warnings)
    for (const x of r.refused) say(`autowave: refused ${x.key} at intake (${x.reason}) — recorded in intake-refused.jsonl`)
    for (const w of r.warnings) say(`autowave: admitted ${w.key} with a warning (${w.warn}${w.gate ? `, gate ${w.gate}` : ''}) — a ticket the audit did not clear is being launched`)
  }
  if (!launch.length) {
    say(queueEmptyLine(gate.arithmetic))
    return { ...base, hold: 'queue-empty' }
  }
  if (!admitted.length) {
    say(`autowave: every popped key was refused; nothing launched (${remaining} left in the queue)`)
    return { ...base, hold: 'all-refused', launch, admitted, refused, warnings }
  }
  const short = gate.want - admitted.length
  say(`autowave: ${gate.arithmetic} → launching ${admitted.length}${refused.length ? `, ${refused.length} refused key(s) replaced from the queue` : ''}${short ? ` — short by ${short}: the queue ran dry` : ''}`)

  const argv = upArgv(admitted)
  let result
  try {
    result = runFleet(argv)
  } catch (e) {
    // The keys are already off the queue: put them back BEFORE rethrowing, or a launcher that failed
    // to start has dropped a wave's tickets as surely as a second launcher would have.
    pushFront({ queueFile, keys: admitted })
    say(`autowave: fleet ${argv.join(' ')} could not be started (${e.message}); ${admitted.length} key(s) returned to the queue`)
    throw e
  }
  say(`autowave: started fleet ${argv.join(' ')}`)
  return { ...base, argv, launch, admitted, refused, warnings, ran: true, lastWaveAt: nowMs, result }
}
