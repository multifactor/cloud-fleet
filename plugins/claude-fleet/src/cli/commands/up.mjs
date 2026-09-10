// `fleet up [n] [--testing k] [--issues A,B] [--add k] [--role working|checker] [--dry-run]
// [--no-wizard]` (contract §7) — the launch path, and the whole of `fleet add`.
//
// The order below is the file's entire thesis, and every step is a failure somebody had to debug:
//
//   1. refuse when another launcher is live — two launchers each skip the worktrees the other just
//      created, so one issue is silently never opened;
//   2. write `resolved.json` BEFORE anything is spawned — the shim reads its config from that file
//      (session/shim.readResolvedConfig), so a session spawned before it exists dies at startup;
//   3. create the worktree, DETACHED at `<repo.remote>/<repo.baseBranch>` for a working session —
//      a session that never starts then leaves no branch behind to explain;
//   4. write the descriptor BEFORE the spawn — a spawn whose descriptor does not exist yet is a
//      session nothing can address: not `fleet kill`, not the reclaimer, not the shim itself;
//   5. spawn, then MERGE the backendRef onto a fresh read of the descriptor — the shim is patching
//      that same file with no lock between us;
//   6. install only what is not already proven ready, in load-gated waves.
//
// ⛔ A window opens only where no LIVE descriptor already answers to the label (`plan.isNew`).
// Worktrees persist and terminals do not, so a reused worktree whose session is gone still gets one;
// a reused worktree whose session is alive never does, because two agents in one worktree collide on
// the git index. Replacing a live session is `fleet relaunch`, which kills first and verifies.

import fs from 'node:fs'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { envelope, errorPayload } from '../../cli.mjs'
import { CliError, FLAGS, listFlag, stringFlag } from '../args.mjs'
import { buildPlan } from '../plan.mjs'
import { missingFor } from './config.mjs'
import { stateLayout } from '../../config/paths.mjs'
import { assertSweepId } from '../../check/manifest.mjs'
import { buildSessionEnv } from '../../config/env.mjs'
import { buildDescriptor, buildPrompt } from '../../core/prompts.mjs'
import { listSessions, readSession, takenLabels, writeSession } from '../../core/fleet.mjs'
import { ensureWorktree } from '../../core/worktree.mjs'
import { observeWorktree, readyState, runInstalls, snapshotReference } from '../../core/install.mjs'
import { readTicket } from '../../trackers/tickets.mjs'
import { writeTextAtomic } from '../../watchers/guardian.mjs'
import { WATCH_ENTRY_FILES } from '../../supervisor/loop.mjs'
import { findByCommand, sessionLabelOf, tokenize } from '../../sys/proc.mjs'
import { snapshot as takeSnapshot } from '../../sys/snapshot.mjs'
import { spawn as spawnProcess } from 'node:child_process'
import { WATCH_PATTERN, isWatchArgv } from '../../supervisor/loop.mjs'

export const name = 'up'
export const usage = 'fleet up [n] [--testing k] [--issues A,B] [--add k] [--role working|checker] [--sweep-id s] [--dry-run] [--no-wizard] [--no-watch]'
export const needsConfig = true
// A command that opens windows has no answer without a terminal, so selection failing here IS the
// right answer — including under --dry-run, whose plan would otherwise promise windows this machine
// cannot open.
export const needsBackend = true

/** The shim every session window runs: `node shim.mjs --fleet-session=<label> <descriptor.json>`. */
export const SHIM = fileURLToPath(new URL('../../session/shim.mjs', import.meta.url))

/** The CLI entry the supervisor is spawned from — the same file this command is served by. */
export const CLI_ENTRY = fileURLToPath(new URL('../../cli.mjs', import.meta.url))

/** The statuses that make a launch impossible, as opposed to the two the wizard is still walking. */
const BLOCKING_STATUS = Object.freeze(['needs-init', 'needs-machine', 'invalid', 'unmigrated'])

/**
 * Coarse pre-filter for the launcher guard; isUpArgv() confirms each hit token by token.
 *
 * It has to admit the same three spellings isUpArgv accepts — the extensionless installed bin, and a
 * flag standing between the entry file and the subcommand — or the token-exact check is never reached
 * for them and the guard is blind to exactly the launcher it exists to catch.
 */
export const UP_PATTERN = /(?:cli\.mjs|claude-fleet(?:\.mjs)?)["']?\s+(?:\S+\s+){0,8}?["']?(?:up|add)(?:["']|\s|$)/

/**
 * The entry files a launcher's argv can be spelt with: the supervisor's own two, plus the
 * EXTENSIONLESS installed bin.
 *
 * ⛔ contract §1 gives `npx claude-fleet <cmd>` as the human spelling, and npm links `bin/claude-fleet.mjs`
 * as a suffix-less `claude-fleet` on POSIX — so an installed or npx'd launcher's command line reads
 * `node /usr/local/bin/claude-fleet up 4` and carries no `.mjs` at all. A guard that knew only the
 * `.mjs` spellings would let that one run beside `node …/src/cli.mjs up`, which is the pair contract
 * §1 names and the commonest second launcher there is.
 */
export const UP_ENTRY_FILES = Object.freeze([...WATCH_ENTRY_FILES, 'claude-fleet'])

const unquote = t => String(t).replace(/^["']|["']$/g, '')
const basenameOf = p => String(p).replace(/\\/g, '/').split('/').pop()

/**
 * PURE. Is this command line `… cli.mjs up …` (or `add`, which is the same launcher)?
 *
 * Token-exact, over UP_ENTRY_FILES: an operator running `npx claude-fleet up` beside the launcher's
 * `node …/src/cli.mjs up` is the commonest second launcher, and a guard that knew one spelling would
 * let exactly that pair run side by side.
 *
 * ⛔ The subcommand is the first token after the entry file that `parseArgs` would read as the
 * command — not literally the next one. `parseArgs` collects bare tokens in ANY position and `main()`
 * scans for `--json` anywhere, so `node cli.mjs --json up 4` really does launch a fleet; a guard that
 * demanded `up` immediately would let it run beside another launcher. The flag table it skips by is
 * `args.FLAGS`, the same one the parser uses, so a value flag written before the subcommand
 * (`--issues A,B up`) consumes its neighbour here exactly as it does there.
 */
export function isUpArgv(cmd) {
  const t = tokenize(cmd).map(unquote)
  for (let i = 0; i < t.length; i++) {
    if (!UP_ENTRY_FILES.includes(basenameOf(t[i]))) continue
    for (let j = i + 1; j < t.length; j++) {
      const tok = t[j]
      if (tok.startsWith('-') && tok !== '-') {
        const name = tok.slice(2).split('=')[0]
        if (tok.startsWith('--') && FLAGS[name] === 'value' && !tok.includes('=')) j++ // `--issues A,B`
        continue
      }
      return tok === 'up' || tok === 'add'
    }
    return false
  }
  return false
}

/**
 * PURE. Other live launchers, from a process snapshot.
 *
 * `findByCommand` excludes self AND every ancestor of self, because the shell that started this
 * check carries the same argv text and would self-match — the phantom instance that made a
 * supervisor count flip between 5 and 0 across three reads.
 *
 * ⛔ An EMPTY snapshot is a failed listing, never proof of being alone. It reports `degraded` and the
 * caller launches anyway: refusing every launch whenever the process listing hiccups would stop a
 * fleet for a reason nobody could see.
 * @returns {{degraded: boolean, others: Array<{pid: number, startedAt: number|undefined, cmd: string}>}}
 */
export function otherLaunchers(snapshot, { selfPid = process.pid } = {}) {
  if (!snapshot || snapshot.size === 0) return { degraded: true, others: [] }
  const others = findByCommand(snapshot, UP_PATTERN, { selfPid })
    .filter(p => isUpArgv(p.cmd))
    .map(p => ({ pid: Number(p.pid), startedAt: p.startedAt, cmd: p.cmd }))
  return { degraded: false, others }
}

/**
 * The process snapshot, or the reason there is none.
 *
 * ⛔ A snapshot that THROWS is a failed listing, exactly like an empty one — the platform scanner
 * shells out, and one unlucky process (or a truncated document) poisons the whole reading. Letting it
 * escape would abort `fleet up`, `fleet down` and `fleet relaunch` over a fault that has nothing to do
 * with the fleet, so every caller here decides what a missing reading means for ITS job instead.
 * @returns {{snapshot: Map|null, error: string|null}}
 */
export function safeSnapshot() {
  try {
    return { snapshot: takeSnapshot({ maxAgeMs: 0 }), error: null }
  } catch (e) {
    return { snapshot: null, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * PURE. Does this command line belong to the fleet whose state lives in `stateDir`?
 *
 * ⛔ A label is a bare number ("1", "2") and contract §3 gives every repo on a machine its own state
 * dir, so a second checkout routinely has a session labelled "1" too. The shim's argv always carries
 * its descriptor path (`<stateDir>/sessions/<label>.json` — buildSpawnSpec puts it there, and
 * session/shim.parseArgv reads it back), so the state dir IS in the command line to match on. Without
 * this, `fleet relaunch 1` in one checkout refuses over a pid the operator cannot kill without
 * stopping unrelated work, and `fleet down` there can never complete while the other fleet runs.
 */
export function argvInFleet(cmd, stateDir, { platform = process.platform } = {}) {
  if (!stateDir) return true
  const norm = s => {
    const t = String(s || '').replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? t.toLowerCase() : t
  }
  return norm(cmd).includes(`${norm(stateDir)}/`)
}

/**
 * PURE. Every process carrying the argv token `--fleet-session=<label>` (contract §4), split into the
 * ones this fleet owns and the ones whose argv names no path under its state dir.
 *
 * The `foreign` half is REPORTED rather than dropped silently: it is how an operator sees a marked
 * process this fleet cannot speak for, instead of a refusal naming a pid from another checkout.
 * @returns {{degraded: boolean, survivors: Array<{label: string, pid: number}>, foreign: Array<{label: string, pid: number}>}}
 */
export function markedSessions(snapshot, { stateDir = null, labels = null } = {}) {
  // ⛔ An EMPTY snapshot is a failed listing, never an empty machine — the same rule otherLaunchers
  // above follows, and the caller decides what a missing reading means for its own job.
  if (!snapshot || snapshot.size === 0) return { degraded: true, survivors: [], foreign: [] }
  const want = labels ? new Set(labels.map(String)) : null
  const survivors = []
  const foreign = []
  for (const p of snapshot.values()) {
    const label = sessionLabelOf(p.cmd)
    if (label === null || (want && !want.has(label))) continue
    ;(argvInFleet(p.cmd, stateDir) ? survivors : foreign).push({ label, pid: Number(p.pid) })
  }
  return { degraded: false, survivors, foreign }
}

/** A whole number from a positional or a flag — never `Number(x)`, where `""` is 0 and `"2 slots"` is NaN. */
function wholeNumber(raw, what) {
  if (raw === undefined || raw === null) return undefined
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new CliError('up.bad-count', `${what} must be a whole number ≥ 0, got ${JSON.stringify(String(raw))}`, 'for example `fleet up 4`; issue keys go in --issues A,B')
  }
  return parseInt(String(raw).trim(), 10)
}

/**
 * PURE. The buildPlan options for one invocation.
 *
 * ⛔ `fleet add` passes `testing: 0` and refuses `--testing`. Adding sessions leaves the pool exactly
 * as it is (playbooks/launcher.md), and config/load.cliLayer deliberately reads `--testing` only on
 * `up` — so honouring it here would resize the pool in the plan while the config disagreed, and the
 * slot would come up with no port or URL of its own.
 */
export function planOptions(args, { verb = 'up' } = {}) {
  const flags = args.flags
  const positional = args.positionals[0]
  const count = wholeNumber(positional, verb === 'add' ? 'the session count' : 'the session count')
  const add = wholeNumber(flags.add, '--add')
  const issues = listFlag(flags, 'issues')

  // ⛔ Checked BEFORE the verbs split, because `fleet add 4 --add 2` is the same sentence as
  // `fleet up 4 --add 2` under a second spelling. Silent precedence on either reads as "4 sessions
  // were asked for and 2 were opened", with nothing on screen to say which number won — and on `add`
  // buildPlan never sees the bare count at all, so its own `plan.count-conflict` cannot catch it.
  if (count !== undefined && add !== undefined && count !== add) {
    throw new CliError('up.count-and-add', `\`fleet ${verb} ${count} --add ${add}\` asks for two different counts`, 'pass either a bare count (a whole fleet) or --add k (that many more), never both')
  }

  if (verb === 'add') {
    if (flags.testing !== undefined) {
      throw new CliError(
        'add.testing-flag',
        '`fleet add` does not take --testing: it adds working sessions and leaves the testing pool exactly as it is',
        'boot a slot with `fleet up --add 0 --testing 1`, which is the invocation the config layer also reads the flag on',
      )
    }
    // `--add k` and a bare count are the same number under two spellings; the flag wins only when the
    // count is absent.
    //
    // ⛔ The default of 1 is for an invocation that named NO count and NO keys. With `--issues A,B`
    // the count comes from the resolved keys exactly as it does on `up`: defaulting to 1 here made
    // buildPlan refuse `fleet add --issues ABC-1234,ABC-1240` with "1 session(s) were asked for but 2
    // issue key(s) were given", telling an operator who asked for no count that they asked for one.
    return { add: add ?? count ?? (issues.length ? undefined : 1), testing: 0, issues, role: stringFlag(flags, 'role', 'working'), sweepId: sweepIdFlag(flags) }
  }

  return {
    n: count,
    add,
    testing: flags.testing === undefined ? undefined : wholeNumber(flags.testing, '--testing'),
    issues,
    role: stringFlag(flags, 'role', 'working'),
    // `--sweep-id` is what makes `--role checker` launchable: `vcs.checkerBranchTemplate` renders
    // `{sweepId}`, so without one buildPlan refuses rather than putting a session on a branch whose
    // `{sweepId}` never rendered — which is not a branch name at all. Passing it here is the whole
    // difference between a documented role and an unreachable one.
    //
    // ⛔ Still no `--slice`: contract §7 gives that flag to `fleet cloud dispatch` and `fleet check`
    // alone, so the launch path does not read it — buildPlan takes its slices from the caller that
    // has a sweep to name them against.
    sweepId: sweepIdFlag(flags),
  }
}

/**
 * `--sweep-id`, validated as the directory name it becomes. It is rendered into
 * `vcs.checkerBranchTemplate` and it names `<stateDir>/sweeps/<sweepId>/`, so a value carrying a
 * separator would both name a branch nobody meant and point the session at a directory outside the
 * sweeps tree. Refused here, at the boundary that reads the flag, so buildPlan stays pure.
 */
function sweepIdFlag(flags) {
  const raw = stringFlag(flags, 'sweep-id', null)
  if (raw === null) return null
  try {
    return assertSweepId(raw)
  } catch (e) {
    throw new CliError('up.bad-sweep-id', e.message, 'pass the sweep id `fleet check plan` printed — a plain directory name, no slashes')
  }
}

/**
 * The `resolved.json` body (contract §4): `{v, inputsHash, config, slots[], adapter}`.
 *
 * ⛔ The adapter is recorded by PATH and id, never inlined. A session must read the adapter file on
 * disk (core/prompts.mjs: it is identified by path and by nothing else), and a pasted copy would
 * freeze at launch — so an overlay edited mid-run would never take effect while `resolved.json`
 * claimed otherwise.
 */
export function resolvedRecord(ctx) {
  const adapter = ctx.adapter ? { id: ctx.adapter.id, file: ctx.adapter.file } : null
  const body = { v: 1, config: ctx.config, slots: ctx.slots || [], adapter }
  // The hash is over exactly what the file carries, so a reader (the shim, a watcher, the next
  // launcher) can tell "the launcher re-resolved" from "the file was rewritten unchanged" without
  // diffing a whole config.
  const inputsHash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
  return { v: 1, inputsHash, config: body.config, slots: body.slots, adapter }
}

/** Write `<stateDir>/resolved.json`. Atomic + fsync'd: a session that reads half of it cannot start. */
export function writeResolved(ctx) {
  const file = stateLayout(ctx.config.paths.stateDir, process.platform).resolved
  const record = resolvedRecord(ctx)
  writeTextAtomic(file, JSON.stringify(record, null, 2) + '\n')
  return { file, record }
}

// ---- getting the seed prompt actually SUBMITTED --------------------------------------------------
//
// ⛔ The failure this exists for: `spawn` returns the instant tmux has a window, but the agent CLI
// inside it is still booting and may open a MODAL first — a workspace-trust dialog on a worktree
// path it has never seen, an MCP-server approval for the repo's .mcp.json. The seed prompt was sent
// into whatever was on screen, and the Enter that should have submitted it was swallowed by that
// dialog. Every layer then reported success: tmux accepted the keystrokes, so `send` returned
// ok — tmux can only report delivery of a KEYSTROKE, never of the intent — and the session sat at
// `ready`/`alive: yes` with its whole instruction sitting unsent in the input line. On `fleet status`
// that is indistinguishable from a session with nothing to do, so a fleet that started nothing
// looked exactly like a fleet that had finished.
//
// So: wait for the modal to clear, send, then PROVE the text left the input line.

/** Dialogs an unattended session cannot answer by itself, and the words each is recognised by. */
export const GATE_PATTERNS = Object.freeze([
  { name: 'a workspace-trust dialog', re: /trust this folder|Is this a project you (created or )?trust/i },
  { name: 'an MCP-server approval dialog', re: /MCP servers may execute code/i },
  { name: 'a theme or onboarding prompt', re: /Choose the text style|Let's get started/i },
])

/** PURE. The gate a pane is showing, or null. */
export function gateShowing(text) {
  const s = String(text ?? '')
  for (const g of GATE_PATTERNS) if (g.re.test(s)) return g.name
  return null
}

/**
 * PURE. Is the seed prompt still sitting in the input line rather than submitted?
 *
 * Compared with whitespace collapsed, because a TUI wraps the input line at the pane width and a
 * literal substring test would miss its own text. The TAIL of the prompt is the needle: the head of
 * a long prompt scrolls out of an input box, the end of it does not.
 *
 * ⛔ ONLY THE BOTTOM OF THE PANE COUNTS. An agent that accepts a prompt ECHOES IT into the
 * transcript, so the same text is still on screen after a perfectly successful submit — just above
 * the input box instead of inside it. Searching the whole capture therefore reported every started
 * session as stuck, pressed Enter into it several more times, and failed the launch of a fleet that
 * was already working. An unsent prompt is by definition at the bottom, where the cursor is.
 */
export function stillUnsent(paneText, prompt, { tailLines = 12 } = {}) {
  const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  const tail = String(paneText ?? '').split(/\r?\n/).slice(-tailLines).join('\n')
  const hay = flat(tail)
  const needle = flat(prompt).slice(-60)
  return needle.length > 0 && hay.includes(needle)
}

/**
 * Wait out any gate, send the seed prompt, then confirm it was submitted — re-pressing Enter when it
 * was not. Backends without `readText` skip the gate and the proof rather than fail: the check is an
 * improvement where it is available, never a new requirement.
 */
export async function deliverSeedPrompt(backend, handle, prompt, {
  label,
  log = () => {},
  sleep: nap = sleep,
  gateMs = 300_000,
  pollMs = 1000,
  attempts = 3,
  now = () => Date.now(),
} = {}) {
  const canRead = typeof backend.readText === 'function'
  if (canRead) {
    const deadline = now() + gateMs
    let announced = null
    for (;;) {
      const gate = gateShowing(backend.readText(handle))
      if (!gate) break
      if (gate !== announced) {
        announced = gate
        log(`${label}: waiting on ${gate} in its window — answer it there and the session starts on its own`)
      }
      if (now() >= deadline) {
        return { ok: false, requested: prompt.length, delivered: 0, truncated: false, gate, reason: `${gate} was still open after ${Math.round(gateMs / 1000)}s, so the seed prompt was never sent` }
      }
      await nap(pollMs)
    }
  }

  const sent = backend.send(handle, prompt)
  if (!sent.ok || !canRead || typeof backend.submit !== 'function') return sent

  for (let i = 0; i <= attempts; i++) {
    await nap(pollMs)
    const text = backend.readText(handle)
    // A pane that cannot be read proves nothing either way; treat the send as it reported itself.
    if (text === null || !stillUnsent(text, prompt)) return sent
    if (i === attempts) {
      return { ...sent, ok: false, reason: `the seed prompt reached the input line but was never submitted, after ${attempts} attempts to press Enter` }
    }
    backend.submit(handle)
  }
  return sent
}

/**
 * PURE. The SpawnSpec for one session (backends/types.mjs).
 *
 * ⛔ Argument ORDER is load-bearing. `session/shim.parseArgv` takes the first NON-FLAG token as the
 * descriptor path, so `--model opus` written before it would make the shim open a file called
 * "opus" and die of ENOENT before the session ever started. Marker, descriptor, then the model.
 *
 * ⛔ The model is passed explicitly on every command line (contract §4): with none in the host's
 * settings the agent CLI picks its own default, which once moved a whole running fleet onto another
 * model with nothing on screen to say so.
 */
export function buildSpawnSpec({ config, descriptor, sessionFile, shim = SHIM, node = process.execPath }) {
  const label = String(descriptor.label)
  const model = descriptor.model || config.fleet.model
  if (!model) {
    throw new CliError('up.no-model', 'fleet.model is unset, so the agent would inherit whatever model the host settings carry', 'set fleet.model (contract §3 defaults it to "opus"); an inherited default once put a whole fleet on the wrong model mid-run')
  }
  const env = buildSessionEnv(config, {
    label,
    role: descriptor.role,
    file: sessionFile,
    stateFile: descriptor.stateFile,
    stateDir: descriptor.paths.stateDir,
    testingUrl: descriptor.testingUrl,
    testingUrls: descriptor.testingUrls,
    sweepDir: descriptor.sweepDir,
    slice: descriptor.slice,
    slot: descriptor.slot,
    branch: descriptor.branch,
    port: descriptor.port,
  })
  return {
    id: label,
    role: descriptor.role,
    title: titleFor(descriptor),
    cwd: descriptor.worktree,
    env,
    command: node,
    args: [shim, `--fleet-session=${label}`, sessionFile, '--model', String(model)],
  }
}

/** What the tab says until the status hook takes it over. */
function titleFor(d) {
  if (d.role === 'testing') return `testing slot ${d.slot}`
  if (d.role === 'checker') return `check ${d.slice}`
  return `session ${d.label}${d.issue ? ` ${d.issue}` : ''}`
}

/**
 * Record the spawn's `backendRef` on the descriptor.
 *
 * ⛔ MERGE onto a fresh read, never a replace built from the copy we spawned with. The shim
 * read-modify-writes this same file (shimPid, agentPid, startedAt) the moment it starts, with no lock
 * between us — and a full replace silently drops whatever it recorded, leaving a live session whose
 * pids nothing knows.
 * @returns {object} the descriptor as written
 */
export function stampBackendRef(label, handle, { stateDir, base = null, drop = [] }) {
  const fresh = readSession(label, { stateDir }) || base
  if (!fresh) throw new Error(`up: session ${label} has no descriptor to stamp — it was removed between the write and the spawn`)
  const next = { ...fresh, backendRef: handle.backendRef ?? null }
  // `drop` is how a relaunch clears the PREVIOUS run's exit record and death mark: left in place they
  // describe a finished session, and the reclaimer would take the worktree out from under the fresh
  // agent that just replaced it.
  for (const k of drop) delete next[k]
  // The backend may already know the process it started; the shim overwrites both with its own the
  // moment it runs. Recorded here so a spawn that dies before the shim's first write is still
  // addressable by `fleet kill`.
  // Read from `next`, never from `fresh`: on a relaunch the stale pids have just been dropped, and a
  // condition that looked at the pre-drop copy would leave the fresh spawn unaddressable until its
  // shim's first write — the window in which a kill has nothing to walk from.
  if (handle.shimPid !== undefined && (next.shimPid === null || next.shimPid === undefined)) next.shimPid = handle.shimPid
  if (handle.pgid !== undefined && (next.pgid === null || next.pgid === undefined)) next.pgid = handle.pgid
  writeSession(next, { stateDir })
  return next
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The offline ticket the launcher cached, or null — never fatal. */
function ticketFileFor(issue, stateDir, log) {
  if (!issue) return null
  try {
    const t = readTicket(issue, { stateDir })
    return t ? t.file : null
  } catch (e) {
    // A cache that is present but corrupt costs this session its offline degradation path, and
    // nothing else: refusing the launch over it would strand the ticket entirely.
    log(`up: the cached ticket for ${issue} could not be read (${e.message}); the session starts without a ticketFile`)
    return null
  }
}

/** One row of the table the launcher prints (playbooks/launcher.md, step 5d). */
function planRow(entry) {
  return {
    label: entry.label,
    role: entry.role,
    worktree: entry.worktree,
    branch: entry.branch || (entry.role === 'working' ? 'detached → will branch' : ''),
    issue: entry.issue || null,
    slot: entry.slot ?? null,
    url: entry.url || null,
    isNew: entry.isNew,
  }
}

function printTable(rows, log) {
  log('| label | role    | worktree | branch / slot | issue | url |')
  for (const r of rows) {
    log(`| ${r.label} | ${r.role} | ${r.worktree} | ${r.branch || '—'} | ${r.issue || '—'} | ${r.url || '—'} |`)
  }
}

export async function run(ctx, args) {
  return runUp(ctx, args, { verb: 'up' })
}

/**
 * The whole launch, shared with `fleet add` (which is `up --add k` with the testing pool untouched).
 * @param {object} ctx   the CLI context (config, facts, backend, json, log, fail)
 * @param {object} args  parsed argv
 * @param {{verb?: 'up'|'add'}} opts
 * @returns {Promise<number>} the exit code
 */
export async function runUp(ctx, args, { verb = 'up' } = {}) {
  const { config, facts, backend } = ctx
  const dryRun = !!args.flags['dry-run']
  const noWizard = !!args.flags['no-wizard']
  const stateDir = config.paths.stateDir

  // ---- the status gate ---------------------------------------------------------------------------
  // ⛔ With --no-wizard nobody is there to answer, so ANY non-ok status exits non-zero with
  // {status, missing[], hint} and writes nothing. Without it, only the statuses that actually block a
  // launch refuse: `needs-tracker` and `needs-checker` are wizard steps the fleet can run without
  // (the same judgement `fleet config status` prints), and refusing them would make a tracker-less
  // repo unlaunchable.
  const blocked = noWizard ? ctx.status !== 'ok' : BLOCKING_STATUS.includes(ctx.status)
  if (blocked) {
    const missing = missingFor(ctx.status, ctx)
    const hint = noWizard
      ? 'run `fleet config status --json`, answer what it names, then launch again — --no-wizard means nobody is here to be asked'
      : 'run `fleet config detect --json`, then `fleet config init --from-json -`'
    ctx.json(errorPayload('up.not-configured', `the config status is "${ctx.status}", so nothing was launched`, hint, { status: ctx.status, missing }))
    ctx.log(`fleet ${verb}: config status ${ctx.status}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
    ctx.log(`  hint: ${hint}`)
    return 1
  }
  if (ctx.status !== 'ok') ctx.log(`fleet ${verb}: launching with config status "${ctx.status}" — the fleet runs, but ${missingFor(ctx.status, ctx).join(', ') || 'a wizard step'} is unanswered`)

  const primary = facts.git && facts.git.primary
  if (!primary) ctx.fail('up.no-checkout', `${ctx.cwd} is not inside a git checkout, so there is no repository to make worktrees of`, 'run the fleet from inside the repository you want worktrees of')

  // ---- the command line ---------------------------------------------------------------------------
  // Read and validated BEFORE anything about the machine is consulted: a malformed command line is
  // a usage error whatever else is running, and answering it with "another launcher is live" sends
  // the operator to look at the wrong thing entirely.
  const options = planOptions(args, { verb })

  // ---- one launcher at a time --------------------------------------------------------------------
  const reading = safeSnapshot()
  const guard = otherLaunchers(reading.snapshot, { selfPid: process.pid })
  if (guard.others.length) {
    const who = guard.others.map(o => `pid ${o.pid}`).join(', ')
    const message = `another launcher is running (${who}), so nothing was launched`
    const hint = 'wait for it to finish, or kill it — two launchers read the same worktree list and each skips what the other just created, which silently drops a session\'s issue'
    if (!dryRun) {
      ctx.json(errorPayload('up.launcher-running', message, hint, { others: guard.others.map(o => o.pid) }))
      ctx.log(`fleet ${verb}: ${message}`)
      return 1
    }
    // A dry run writes nothing, so it is allowed through — but its numbering is already stale.
    ctx.log(`fleet ${verb}: ${message.replace(', so nothing was launched', '')}; this plan may already be out of date`)
  } else if (guard.degraded) {
    ctx.log(`fleet ${verb}: the process listing failed${reading.error ? ` (${reading.error})` : ' (it came back empty)'}, so a second launcher could not be ruled out — a failed listing is never proof of being alone, and it is not a reason to refuse a launch either`)
  }

  // ---- the plan ----------------------------------------------------------------------------------
  const template = options.role === 'checker' ? config.repo.checkerDirTemplate : config.repo.sessionDirTemplate
  const existing = {
    // Leftover FOLDERS count as taken, not just descriptors: `git worktree remove` routinely
    // deregisters a tree and then fails to delete it, and numbering into one hands the new session a
    // half-installed dependency tree that every cheap check calls healthy.
    taken: takenLabels({ stateDir, worktreeParent: config.repo.worktreeParent, repoName: config.repo.name, template }),
    sessions: listSessions({ stateDir }),
  }
  const plan = buildPlan({ options, existing, config, facts })
  const rows = plan.map(planRow)

  if (dryRun) {
    ctx.json(envelope(true, { dryRun: true, plan: rows, resolved: null, spawned: [], installs: null }))
    ctx.log(`fleet ${verb} --dry-run: ${plan.length} session(s) planned; nothing was created`)
    printTable(rows, ctx.log)
    return 0
  }

  // ---- resolved.json, before any spawn -----------------------------------------------------------
  // Contract §4: written on EVERY `fleet up`, including one that launches nothing. A session reads its
  // whole config from this file, and an invocation that resized the pool to zero must still leave the
  // sessions that remain a current copy rather than a previous run's.
  fs.mkdirSync(stateDir, { recursive: true })
  const resolved = writeResolved(ctx)

  if (!plan.length) {
    ctx.json(envelope(true, { dryRun: false, plan: [], resolved: resolved.file, spawned: [], installs: null }))
    ctx.log(`fleet ${verb}: nothing to launch (0 sessions asked for)`)
    return 0
  }

  // ---- worktrees, descriptors, windows -----------------------------------------------------------
  const baseRef = `${config.repo.remote}/${config.repo.baseBranch}`
  const created = []
  const spawned = []
  const reused = []
  const failures = []
  // Only worktrees that really exist are installed: running `commands.bootstrap` in a directory the
  // creation failed on reports an install failure for a tree that was never there.
  const installable = []
  const staggerMs = Math.max(0, Number(config.install.spawnStaggerSec) || 0) * 1000
  let opened = 0

  for (const entry of plan) {
    try {
      const w = ensureWorktree({
        repo: primary,
        path: entry.worktree,
        // ⛔ A working worktree is created DETACHED at <remote>/<baseBranch> (plan.mjs): its branch
        // renders from vcs.branchTemplate once the session has resolved its ticket slug, and a
        // session that never starts must leave no branch behind to explain.
        branch: entry.branch || null,
        baseBranch: baseRef,
        detached: !entry.branch,
      })
      ;(w.created ? created : reused).push(entry.label)
      // ⛔ `live` is carried, not filtered out here, so installWorktrees can still SAY what it did
      // not do. A live slot's install is skipped rather than run (see there), and a skip nobody
      // reports is indistinguishable from an install that happened.
      installable.push({ label: entry.label, worktree: w.path, live: !entry.isNew })

      if (!entry.isNew) {
        // ⛔ A LIVE session is left completely alone — no window, and no descriptor rewrite either.
        // Its registry entry is where the shim recorded its pids and the backend its spawn handle, and
        // replacing it with a freshly built copy would leave a running agent that nothing can address:
        // not `fleet kill`, not `fleet send`, not the reclaimer. Replacing a live session is
        // `fleet relaunch`, which kills it first and proves it gone. Its worktree was still ensured
        // above — that much is about the checkout — but its INSTALL is not run underneath it.
        ctx.log(`fleet ${verb}: ${entry.label} already has a live session; its worktree was reused, and nothing about the session was touched (use \`fleet relaunch ${entry.label}\` to replace it)`)
        continue
      }

      const descriptor = buildDescriptor(config, {
        label: entry.label,
        role: entry.role,
        worktree: w.path,
        branch: entry.branch || null,
        issue: entry.issue,
        ticketFile: ticketFileFor(entry.issue, stateDir, ctx.log),
        slot: entry.slot,
        slice: entry.slice,
        sweepDir: entry.sweepDir,
      }, {
        slots: ctx.slots || [],
        platform: process.platform,
        pluginRoot: fileURLToPath(new URL('../../..', import.meta.url)),
        repoRoot: (facts.git && facts.git.toplevel) || primary,
        now: ctx.now(),
      })
      // ⛔ The descriptor is written BEFORE the spawn. A window whose descriptor does not exist yet is
      // a session nothing can address — `fleet kill` cannot find it, the reclaimer cannot see its
      // worktree, and the shim itself has nothing to read.
      const sessionFile = writeSession(descriptor, { stateDir })

      const spec = buildSpawnSpec({ config, descriptor, sessionFile })
      const handle = backend.spawn(spec)
      const stamped = stampBackendRef(entry.label, handle, { stateDir, base: descriptor })
      spawned.push({ label: entry.label, role: entry.role, backendRef: stamped.backendRef, marker: `--fleet-session=${entry.label}` })

      // The seed prompt (core/prompts.buildPrompt) is a POINTER to the descriptor and the playbook,
      // never a payload: it is typed into the session rather than pasted onto a command line, and a
      // SHORT WRITE is reported instead of being read as delivery — a console input buffer takes what
      // fits and submits the fragment, and a session acting on half its instructions looks healthy.
      const prompt = buildPrompt(config, stamped, { sessionFile })
      const sent = await deliverSeedPrompt(backend, handle, prompt, {
        label: `fleet ${verb}: ${entry.label}`,
        log: line => ctx.log(line),
      })
      if (!sent.ok) {
        ctx.log(`fleet ${verb}: ${entry.label}: the seed prompt was delivered as ${sent.delivered} of ${sent.requested} characters (${sent.reason || 'short write'}) — send it again with \`fleet send ${entry.label} --file <path>\` before trusting the session`)
      }
      if (handle && handle.viewer && handle.viewer.opened === false && handle.viewer.reason) {
        ctx.log(`fleet ${verb}: ${entry.label}: no window was opened for this session (${handle.viewer.reason}) — it is running headless; \`fleet attach\` still reaches it`)
      }

      opened++
      // Windows open staggered: a wave that opens every terminal in the same instant is the burst that
      // takes the machine down before a single install has started.
      if (staggerMs && opened < plan.length) await sleep(staggerMs)
    } catch (e) {
      // One bad worktree must not abandon the rest of the wave: nine healthy sessions waiting on one
      // stranded folder is how a fleet stops working while looking busy.
      failures.push({ label: entry.label, error: e && e.message ? e.message : String(e) })
      ctx.log(`fleet ${verb}: ${entry.label} failed: ${e && e.message ? e.message : e}`)
    }
  }

  // Retile from the LIVE set, recomputed: arranging once with the handles of this wave alone leaves
  // each refilled wave stacked on top of the fleet it joined.
  let layoutNotice = null
  try {
    const placed = backend.layout(backend.list(), config.terminal.layout)
    layoutNotice = placed && placed.notice ? placed.notice : null
    if (layoutNotice) ctx.log(`fleet ${verb}: ${layoutNotice}`)
  } catch (e) {
    // A backend that cannot place windows has still opened them: the sessions are running, so this is
    // a line to read, never a failed launch.
    layoutNotice = e && e.message ? e.message : String(e)
    ctx.log(`fleet ${verb}: the windows could not be arranged: ${layoutNotice}`)
  }

  // ---- installs ----------------------------------------------------------------------------------
  const installs = await installWorktrees({ ctx, worktrees: installable, primary, verb })

  const ok = failures.length === 0
  ctx.json(ok
    ? envelope(true, { dryRun: false, plan: rows, resolved: resolved.file, spawned, created, reused, installs, layoutNotice })
    : envelope(false, {
      dryRun: false,
      plan: rows,
      resolved: resolved.file,
      spawned,
      created,
      reused,
      installs,
      layoutNotice,
      failed: failures,
      error: {
        code: 'up.session-failed',
        message: `${failures.length} of ${plan.length} session(s) could not be launched: ${failures.map(f => f.label).join(', ')}`,
        hint: failures[0].error,
      },
    }))
  printTable(rows, ctx.log)
  if (installs) ctx.log(`fleet ${verb}: ${installs.queued} install(s) in ${installs.waves} wave(s); ${installs.failed.length} failed`)
  if (!args.flags['no-watch']) {
    const sup = startSupervisor(ctx)
    if (sup.started) ctx.log(`fleet ${verb}: supervisor started (pid ${sup.pid}) — it reclaims a session as soon as it flags done`)
    else if (sup.pid) ctx.log(`fleet ${verb}: supervisor already running (pid ${sup.pid})`)
    else ctx.log(`fleet ${verb}: no supervisor could be started (${sup.reason}) — finished sessions will stay open until you run \`fleet watch\``)
  }
  return ok ? 0 : 1
}

/**
 * Start the supervisor, unless one is already running.
 *
 * ⛔ THE SUPERVISOR IS WHAT CLOSES A FINISHED SESSION. It reclaims a `done` flag — kills the window,
 * verifies zero survivors, removes the worktree — and it also reaps stale locks, restarts a dead
 * testing server and tree-kills rogue dev servers. The playbook told the OPERATOR to start it
 * ("right after `fleet up`"), which means every launch that forgets leaves finished sessions sitting
 * open for ever, each one reading on `fleet status` as a healthy idle session. Forgetting a
 * documented manual step is not an operator failure; it is a launcher that should have done it.
 *
 * Detached and stdio-ignored on purpose: it must outlive this process, which exits as soon as the
 * fleet is up. A supervisor that is already running is left alone — loop.instanceDecision resolves
 * duplicates by age anyway, but not spawning one is cheaper than racing it.
 */
export function startSupervisor(ctx, { spawn = spawnProcess, snapshot = null, node = process.execPath, entry = CLI_ENTRY } = {}) {
  const snap = snapshot || safeSnapshot()
  const running = snap && snap.size
    ? findByCommand(snap, WATCH_PATTERN, { selfPid: process.pid }).filter(p => isWatchArgv(p.cmd))
    : []
  if (running.length) return { started: false, pid: running[0].pid, reason: 'a supervisor is already running' }
  try {
    const child = spawn(node, [entry, 'watch'], { cwd: ctx.cwd, detached: true, stdio: 'ignore' })
    child.unref()
    return { started: true, pid: child.pid, reason: null }
  } catch (e) {
    // Never fatal: a fleet with no supervisor still works, it just does not tidy up after itself.
    return { started: false, pid: null, reason: e && e.message ? e.message : String(e) }
  }
}

/**
 * Install every planned worktree that is not already proven ready, in load-gated waves.
 *
 * ⛔ Readiness is the SENTINEL judged against the worktree's own lockfile, never "node_modules is
 * there": worktrees are reused, so a sentinel from an earlier run outlives the tree it certified, and
 * a stale one makes the launcher skip the install while every session builds against the wrong
 * dependencies.
 *
 * ⛔ And NEVER under a live agent. A reused testing slot's tree is a mashup of many sessions'
 * branches, so its lockfile hash moves constantly and `readyState` calls it not-ready on almost every
 * re-run — which would clear that slot's ready sentinel and run `commands.bootstrap` inside the
 * worktree underneath its running dev server, with no restart of that server and no word to the
 * session. It is reported as a skip with the reason instead, so the launcher can tell the session.
 * @returns {Promise<{queued: number, waves: number, ok: string[], failed: Array, warnings: string[], skipped: string[]}|null>}
 */
async function installWorktrees({ ctx, worktrees, primary, verb }) {
  const config = ctx.config
  const jobs = []
  const skipped = []
  const notes = []
  for (const entry of worktrees) {
    const state = readyState(observeWorktree(entry.worktree, config), config)
    if (entry.live) {
      skipped.push(entry.label)
      if (!state.ready) notes.push(`${entry.label}: its dependencies need installing (${state.reason}), but it holds a LIVE session — nothing was run under it; free it with \`fleet relaunch ${entry.label}\`, or install by hand and restart its dev server, which a changed dependency tree always needs`)
      continue
    }
    if (state.ready) {
      skipped.push(entry.label)
      continue
    }
    jobs.push({ label: entry.label, worktree: entry.worktree, reason: state.reason })
  }
  for (const n of notes) ctx.log(`fleet ${verb}: ${n}`)
  if (!jobs.length) return { queued: 0, waves: 0, ok: [], failed: [], warnings: notes, skipped }

  // The proof compares each worktree against a snapshot of the PRIMARY checkout, so it is taken here
  // — once — rather than per install: a reference captured while the primary is mid-install is empty,
  // and an empty reference certifies every broken tree in the fleet.
  let reference = null
  try {
    reference = snapshotReference(primary, config)
    if (reference && reference.usable === false) ctx.log(`fleet ${verb}: ${reference.reason} — the install proof will fail until the primary checkout is installed`)
  } catch (e) {
    ctx.log(`fleet ${verb}: the install reference could not be captured (${e.message}); installs run and their proof will say so`)
  }

  const r = await runInstalls(jobs, { config, reference, onWave: w => ctx.log(`fleet ${verb}: install wave ${w.index + 1}: ${w.jobs.map(j => j.label).join(', ')} (${w.decision.reason})`) })
  // The exit code is reported beside the proof's verdict, never instead of it: an interrupted
  // install exits 0 over a tree it never finished writing, and a bootstrap that threw exits non-zero
  // over an empty one — a reader needs both to tell those apart.
  const failed = r.results.filter(x => !x.ok).map(x => ({ label: x.label, reason: x.reason, code: x.code ?? null, exitOk: x.exitOk ?? null }))
  for (const w of r.warnings) ctx.log(`fleet ${verb}: ${w}`)
  for (const f of failed) ctx.log(`fleet ${verb}: install ${f.label} FAILED: ${f.reason}${f.exitOk === false ? ` (the bootstrap itself exited ${f.code})` : ''}`)
  return {
    queued: jobs.length,
    waves: r.waves,
    ok: r.results.filter(x => x.ok).map(x => x.label),
    failed,
    warnings: [...notes, ...r.warnings],
    skipped,
  }
}
