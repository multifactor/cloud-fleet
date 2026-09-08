// Dispatching a throwaway cloud sandbox — a capture worker, or a `/fleet-check` slice — and
// harvesting what it pushed back. `fleet cloud dispatch --bundle <dir> --ref <branch> [--slice f]`
// (contract §7) is the only sanctioned way a session reaches the cloud CLI.
//
// Every rule here is a run that went wrong, and each is stated where it is enforced:
//
//   * the cloud CLI refuses a non-TTY shell, and a session's tool shell is not one — so on POSIX the
//     worker is started inside a scratch tmux window on the fleet's own socket (the terminal IS the
//     pty) and on Windows in a hidden console behind a detached shell; a session that called the CLI
//     directly got an instant refusal it then misfiled as `cloud-env`;
//   * the runbook NEVER rides on a command line. An unescaped runbook once truncated at the first
//     backtick (the shell read it as a command substitution) and the worker improvised the missing
//     steps — it skipped the migration entirely and shot an app with no schema. The prompt is written
//     to a file whose copy is verified whole, and the argv carries only the quoted path;
//   * the dispatch targets a PUSHED REF through a tiny blobless stub, never the worktree: the CLI
//     uploads its working directory, and a checkout of a monorepo dies with a misleading "too large";
//   * the ramp is gated on branches DELIVERED, never on sessions created — eight sessions "running"
//     once produced zero deliveries — and the stages are staggered, because prompts cluster at boot;
//   * a worker quiet for more than 25 minutes with no branch is presumed stuck, not slow: an install
//     retry-looped ~30k times over 21 minutes against a blocked host without ever erroring;
//   * exit 137 is a per-container OOM kill — the slice is split, never retried as it was;
//   * the results poll CHECKS THE EXIT CODE of `git ls-remote`: a network failure prints nothing and
//     reads exactly like "branch absent", which sent a caller to re-dispatch onto a force-pushed ref —
//     and a fresh worker does not reliably see a force-push, so it re-shot the previous commit. A ref
//     that was dispatched once is never dispatched again: the re-dispatch goes on `<ref>-v2`;
//   * a 401 from a private registry in a host probe means REACHED (an auth challenge is a network
//     success) plus a separate credential question — reading it as "still blocked" sent the operator
//     to fix the allowlist while the token was the problem, and cost a whole cycle;
//   * a worker's sensitive-path read raises a permission prompt nobody answers, and the worker parks
//     forever with no failure artefact — so the brief forbids those reads outright.
//
// Split like the rest of the plugin: the decisions (buildRunbookPrompt, launchPlan, rampPlan,
// stallVerdict, dispatchGate, parseLsRemote, parseFailedMd, harvestResult, sessionInfoFrom …) are
// PURE over injected data, and dispatch()/pollResults()/harvest() are thin wrappers whose runner,
// clock, sleep and transcript reader are injected — so every trap above is a test, not a comment.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { run as execRun } from '../sys/exec.mjs'
import { stateLayout, transcriptSlug } from '../config/paths.mjs'

// ---- constants -----------------------------------------------------------------------------------

/** The probe wave: never more than this in flight until the FIRST branch has landed. */
export const FIRST_WAVE = 3
/** The second stage: once one delivery has proven the environment, up to this many in flight. */
export const SECOND_WAVE = 10
/** Stages are separated by at least this, because prompts cluster at boot. */
export const STAGGER_MS = 2 * 60_000
/** Quiet for longer than this with no branch is a stuck worker, not a slow one. */
export const STALL_MS = 25 * 60_000
/** The per-container out-of-memory kill. Split the slice; never retry it as it was. */
export const OOM_EXIT = 137

/** The runbook copy inside the stub — the file the prompt is read from, verified whole. */
export const RUNBOOK_FILE = 'RUNBOOK.md'
/** What a worker delivers; the names are exact (`capture-manifest.json` does not count). */
export const MANIFEST_FILE = 'manifest.json'
export const FAILED_FILE = 'FAILED.md'
/** Where a checker worker's op-13 entries live on its results branch. */
export const OUTBOX_DIR = 'outbox'
/** `<stateDir>/logs/cloud-dispatch.log` — the record of every ref ever dispatched (JSON lines). */
export const DISPATCH_LOG = 'cloud-dispatch.log'
/** The last line of every prompt; its absence at the worker's end means the runbook was cut. */
export const END_SENTINEL = '— END OF RUNBOOK — if this line is missing, the runbook you received was truncated: write FAILED.md with reason `runbook truncated` and push it.'

/** The reason tokens FAILED.md's first line may start with (playbooks/cloud-capture.md §FAILURE). */
export const FAILURE_REASONS = Object.freeze([
  'missing', 'runbook truncated', 'ref mismatch', 'blocked host', 'install failed', 'stack not ready',
  'spec failed', 'needs sensitive path', 'other',
])
export const PHASES = Object.freeze(['boot', 'before', 'after', 'deliver'])

/** Every PowerShell invocation: no profile (one that prints corrupts the pid line), never a prompt. */
export const PS_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
/** The fleet's tmux server config, so a scratch window never inherits the operator's bindings. */
export const DEFAULT_TMUX_CONFIG = fileURLToPath(new URL('../../tmux.conf', import.meta.url))
/** `#{window_id} #{pane_id} #{pane_pid}` — the ids `new-window -P -F` prints back. */
export const TMUX_SPAWN_FORMAT = '#{window_id} #{pane_id} #{pane_pid}'

// ---- refs and names --------------------------------------------------------------------------------

/**
 * A ref name is an argv token AND a path under refs/heads: the subset of `git check-ref-format`
 * that matters is enforced here so a bad name fails at the door rather than as git prose mid-run.
 */
export function assertRefName(ref, what = 'ref') {
  const s = typeof ref === 'string' ? ref : ''
  const bad =
    !s || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(s) || s.includes('..') || s.includes('@{') || s.startsWith('-') ||
    s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock') || s.split('/').some(seg => seg === '' || seg.startsWith('.'))
  if (bad) throw new Error(`${what} ${JSON.stringify(ref)} is not a valid git ref name`)
  return s
}

/**
 * The name a re-dispatch goes on: `capture/ABC-1234` → `capture/ABC-1234-v2` → `-v3`. A force-push
 * of the existing name is not reliably seen by a fresh worker; a brand-new name cannot collide with
 * cached state.
 */
export function nextRef(ref) {
  const s = assertRefName(ref)
  const m = /^(.*)-v(\d+)$/.exec(s)
  return m ? `${m[1]}-v${Number(m[2]) + 1}` : `${s}-v2`
}

/**
 * An env NAME, and only a name. `NAME=value` is refused outright: the prompt is read by the worker,
 * by the dispatching session and by whoever reviews the run, so a value that reaches it is published.
 */
export function assertEnvName(name) {
  const s = typeof name === 'string' ? name : ''
  // The refusal names only the part before `=`: the whole point is that the value must not reach a
  // transcript, and an error message is read by exactly the same people as the prompt.
  if (s.includes('=')) throw new Error(`capture.requiredEnv entry ${JSON.stringify(s.split('=')[0] + '=…')} carries a value — names only; a value in the prompt is a value in every transcript`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`capture.requiredEnv entry ${JSON.stringify(name)} is not an environment variable name`)
  return s
}

/** A ref as a directory name: `capture/ABC-1234` → `capture-ABC-1234`. */
export function refSlug(ref) {
  return String(ref).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

// ---- the prompt ----------------------------------------------------------------------------------

/** One `<name>: value` line. Non-strings are JSON so a probe list or a null is exact, never prose. */
function paramLine(name, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value)
  return `- \`<${name}>\`: ${v}`
}

/**
 * The parameter block appended to the runbook: every `<name>` the runbook's parameter table names,
 * resolved by the dispatcher. PURE.
 */
export function renderParameterBlock(params) {
  const lines = ['## Parameters — resolved by the dispatcher', '', 'Every value below is the project\'s resolved fleet config. These are prompt parameters, not environment variables, and the only source of a path, a branch, a URL or a command in this run.', '']
  for (const [name, value] of Object.entries(params)) lines.push(paramLine(name, value))
  return lines.join('\n')
}

/**
 * The worker's whole prompt: the cloud-capture runbook INLINED VERBATIM, then the parameter block,
 * then the five rules a worker must not be able to miss, then the end sentinel. PURE.
 *
 * ⛔ The runbook text is not escaped, re-flowed or trimmed — its fenced shell snippets are what the
 * worker runs, and an "escaped" backtick would corrupt them. Escaping is the TRANSPORT's job
 * (launchPlan): the prompt travels as a file and only the file's quoted path reaches a shell.
 *
 * @param {object} o
 * @param {string} o.playbookText     playbooks/cloud-capture.md (or the project overlay), read from disk
 * @param {string} o.ref              `vcs.captureRefTemplate` rendered — what the worker checks out
 * @param {string} o.resultsBranch    `vcs.assetsBranchTemplate` rendered — the ONLY branch it pushes
 * @param {string|null} o.bootstrapScript  `capture.bootstrapScript`
 * @param {string|null} o.captureSpec `vcs.captureDirTemplate` rendered — the spec directory
 * @param {string[]} o.requiredEnv    `capture.requiredEnv` — NAMES only
 * @param {string[]} o.sensitivePaths `vcs.sensitivePaths`
 * @param {string|null} o.expectedSha the tip of `ref` as pushed
 * @param {object} o.params           every other `<name>` from the runbook's table (key, remote, …)
 * @returns {string}
 */
export function buildRunbookPrompt({ playbookText, ref, resultsBranch, bootstrapScript = null, captureSpec = null, requiredEnv = [], sensitivePaths = [], expectedSha = null, params = {} }) {
  if (typeof playbookText !== 'string' || !playbookText.trim()) throw new Error('buildRunbookPrompt: playbookText is empty — a worker handed no runbook improvises one')
  assertRefName(ref, 'capture ref')
  assertRefName(resultsBranch, 'results branch')
  if (ref === resultsBranch) throw new Error(`buildRunbookPrompt: the capture ref and the results branch are both ${JSON.stringify(ref)} — a worker would push its results over the ref it captures`)
  const env = (requiredEnv || []).map(assertEnvName)
  const sensitive = (sensitivePaths || []).map(g => {
    if (typeof g !== 'string' || !g.trim()) throw new Error(`buildRunbookPrompt: vcs.sensitivePaths carries an empty glob ${JSON.stringify(g)}`)
    return g
  })
  if (expectedSha !== null && !/^[0-9a-f]{7,64}$/i.test(String(expectedSha))) throw new Error(`buildRunbookPrompt: expectedSha ${JSON.stringify(expectedSha)} is not a commit sha`)

  const block = renderParameterBlock({
    ...params,
    captureRef: ref,
    expectedSha,
    assetsBranch: resultsBranch,
    captureDir: captureSpec,
    bootstrapScript,
    requiredEnv: env,
    sensitivePaths: sensitive,
  })

  const rules = [
    '## Dispatcher rules — these override anything above that disagrees',
    '',
    `1. Bring the stack up ONLY with the project-supplied bootstrap${bootstrapScript ? ` (\`<bootstrapScript>\` = \`${bootstrapScript}\`)` : ''} and \`<bootstrap>\`; never an install or start command of your own.`,
    `2. Before installing, assert every name in \`<requiredEnv>\`${env.length ? ` (${env.join(', ')})` : ''} is set and non-empty — presence only. ⛔ Never print a value, never dump the environment; a missing name is FAILED.md with reason \`missing <NAME>\`.`,
    `3. ⛔ Never read, grep, cat, dump or edit any path matched by \`<sensitivePaths>\`${sensitive.length ? ` (${sensitive.join(', ')})` : ''}. A permission prompt parks you forever with nothing pushed — if a step seems to need one, it is FAILED.md with reason \`needs sensitive path <glob>\`.`,
    `4. Push your results ONCE, in one commit, to \`<assetsBranch>\` (\`${resultsBranch}\`) — never force-push it, never push any other branch, never open a pull request.`,
    '5. On ANY failure write `FAILED.md` (reason first, then phase, blocked hosts, per-host probe results, the exact failing command and its last lines, a re-run recipe) beside a `"status": "failed"` manifest, push once, and end the session. Never ask a question; nobody is reading.',
  ].join('\n')

  return [playbookText.replace(/\s+$/, ''), '', block, '', rules, '', END_SENTINEL, ''].join('\n')
}

/**
 * Is `copyText` the runbook `sourceText` was assembled into, whole? PURE.
 * ⛔ At least the source's size, starting with the source byte-for-byte, and ending with the sentinel
 * — a copy retyped or echoed through a shell once arrived cut off mid-command.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyRunbookCopy({ sourceText, copyText }) {
  const src = String(sourceText ?? '').replace(/\s+$/, '')
  const copy = String(copyText ?? '')
  if (!src) return { ok: false, reason: 'the source runbook is empty' }
  if (copy.length < src.length) return { ok: false, reason: `the copy is ${copy.length} characters, the source ${src.length} — it was truncated` }
  if (!copy.startsWith(src)) return { ok: false, reason: 'the copy does not begin with the source runbook byte-for-byte' }
  if (!copy.trimEnd().endsWith(END_SENTINEL)) return { ok: false, reason: 'the copy does not end with the end sentinel — the parameter block or the rules were cut' }
  return { ok: true, reason: null }
}

// ---- the launch: where a pty exists ------------------------------------------------------------

/** Quote one token for POSIX `sh -c`: single quotes, an embedded quote spelled `'\''`. Backticks and `$` inside are data. */
export function posixQuote(token) {
  return `'${String(token).replace(/'/g, `'\\''`)}'`
}

/** A PowerShell single-quoted literal: the only escape is a doubled quote, so backticks and `$` inside are data. */
export function psLiteral(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`
}

/**
 * Quote one token for a Windows command line the way the C runtime parses it back: doubled
 * backslashes before an inner quote, the quote escaped. `Start-Process -ArgumentList` quotes nothing.
 */
export function crtQuote(s) {
  const t = String(s ?? '')
  if (t !== '' && !/[\s"]/.test(t)) return t
  return `"${t.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** UTF-16LE base64 for `-EncodedCommand`: the only way a script with quotes survives a Windows command line unchanged. */
export function encodeUtf16(text) {
  return Buffer.from(String(text ?? ''), 'utf16le').toString('base64')
}

/**
 * The pane command that starts the worker on POSIX. PURE.
 *
 * The prompt is `"$(cat '<file>')"`: the shell substitutes the file's bytes into ONE double-quoted
 * positional, and the RESULT of a substitution is never parsed again — so a backtick or a `$var`
 * inside the runbook stays a backtick or a `$var`. Only the file PATH is on the line, single-quoted.
 * `exec` makes the pane's pid the agent's pid, so the window closes when the CLI exits.
 */
export function paneCommand({ agent, args = [], promptFile }) {
  if (!agent) throw new Error('paneCommand: agent is required')
  if (!promptFile) throw new Error('paneCommand: promptFile is required — the prompt never rides on the command line')
  return ['exec', posixQuote(agent), ...args.map(posixQuote), `"$(cat ${posixQuote(promptFile)})"`].join(' ')
}

/**
 * The tmux argv that opens the scratch window on the FLEET's socket. PURE. `-d` keeps the operator
 * where they are; `=<session>:` is an exact match (never a prefix); `-P -F` prints the ids back.
 * No `@fleet_id` is set: this window is not a fleet session, so `list()` never sees it.
 */
export function tmuxLaunchArgs({ socket, session, exists, configFile = DEFAULT_TMUX_CONFIG, title, cwd, command }) {
  const base = ['-L', socket, '-f', configFile]
  return exists
    ? [...base, 'new-window', '-d', '-t', `=${session}:`, '-n', title, '-c', cwd, '-P', '-F', TMUX_SPAWN_FORMAT, command]
    : [...base, 'new-session', '-d', '-s', session, '-n', title, '-c', cwd, '-P', '-F', TMUX_SPAWN_FORMAT, command]
}

/** `@3 %7 4242` → {windowId, paneId, panePid}; null when tmux printed something else. */
export function parseTmuxSpawn(stdout) {
  const m = /^\s*(@\d+)\s+(%\d+)\s+(\d+)\s*$/.exec(String(stdout || ''))
  return m ? { windowId: m[1], paneId: m[2], panePid: Number(m[3]) } : null
}

/**
 * The script that starts the worker on Windows: a HIDDEN console behind a detached `cmd.exe`,
 * the prompt on stdin from the file. PURE.
 *
 * ⛔ The prompt cannot ride on a Windows command line at all: the ceiling is 32,767 characters and
 * the bundled runbook alone is larger — a "quoted" prompt would not be mangled, it would be refused
 * or cut. `-RedirectStandardInput` hands the CLI the file's bytes with no quoting layer in between.
 * Stdout and stderr stay on the hidden console so the CLI still sees a terminal there.
 */
export function windowsLaunchScript({ agent, args = [], promptFile, cwd }) {
  if (!agent) throw new Error('windowsLaunchScript: agent is required')
  if (!promptFile) throw new Error('windowsLaunchScript: promptFile is required — the prompt never rides on the command line')
  const line = [agent, ...args].map(crtQuote).join(' ')
  const argList = ['/d', '/s', '/c', `"${line}"`].map(psLiteral).join(', ')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'cmd.exe' -WorkingDirectory ${psLiteral(cwd)} -ArgumentList @(${argList}) -RedirectStandardInput ${psLiteral(promptFile)} -WindowStyle Hidden -PassThru`,
    '[Console]::Out.WriteLine($p.Id)',
  ].join('\n')
}

/** The pid the Windows launch script printed, or null. */
export function parseWindowsSpawn(stdout) {
  const m = /(\d+)\s*$/.exec(String(stdout || '').trim())
  return m ? { pid: Number(m[1]) } : null
}

/**
 * How to start the worker where a terminal exists, per platform. PURE.
 *
 * @param {object} o
 * @param {string} o.platform
 * @param {string} o.agent          `fleet.agent`
 * @param {string|null} o.model     `fleet.model` — passed explicitly; an inherited default once put a fleet on the wrong model
 * @param {string} o.promptFile     the verified runbook copy
 * @param {string} o.cwd            the stub directory
 * @param {string[]} [o.extraArgs]  anything the CLI layer adds after `--cloud`
 * @param {{socket, session, exists, configFile?}} [o.tmux]  POSIX only
 * @param {string} [o.title]
 * @returns {{via: 'tmux'|'hidden-console', command: string, args: string[], transport: 'file-substitution'|'stdin', agentArgs: string[]}}
 */
export function launchPlan({ platform = process.platform, agent = 'claude', model = null, promptFile, cwd, extraArgs = [], tmux = null, title = 'fleet-cloud' }) {
  if (!promptFile) throw new Error('launchPlan: promptFile is required')
  if (!cwd) throw new Error('launchPlan: cwd (the stub directory) is required')
  const agentArgs = ['--cloud', ...(model ? ['--model', String(model)] : []), ...extraArgs.map(String)]
  if (platform === 'win32') {
    const script = windowsLaunchScript({ agent, args: agentArgs, promptFile, cwd })
    return { via: 'hidden-console', command: 'powershell.exe', args: [...PS_ARGS, '-EncodedCommand', encodeUtf16(script)], transport: 'stdin', agentArgs, script }
  }
  if (!tmux || !tmux.socket || !tmux.session) throw new Error('launchPlan: tmux {socket, session} is required on POSIX — the cloud CLI refuses a non-TTY shell, and the scratch tmux window is the pty')
  const command = paneCommand({ agent, args: agentArgs, promptFile })
  const args = tmuxLaunchArgs({ socket: tmux.socket, session: tmux.session, exists: !!tmux.exists, configFile: tmux.configFile || DEFAULT_TMUX_CONFIG, title, cwd, command })
  return { via: 'tmux', command: 'tmux', args, transport: 'file-substitution', agentArgs, paneCommand: command }
}

// ---- the ramp and the stall clock ----------------------------------------------------------------

const toMs = v => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : null
}

/**
 * How many more workers to dispatch NOW. PURE, and gated on branches DELIVERED — never on sessions
 * created: a dead worker holds its slot and looks identical to a busy one, and eight sessions
 * "running" once produced zero deliveries.
 *
 *   stage 1 (nothing delivered yet)  never more than FIRST_WAVE dispatched IN TOTAL — a failure at
 *                                     zero deliveries does not buy a new slot, because 0-of-N is the
 *                                     environment and the next worker would die the same way;
 *   stage 2 (first delivery landed)  up to SECOND_WAVE in flight;
 *   stage 3 (the probe wave landed)  the rest, bounded only by `maxInFlight` (checker.waveWidth).
 *
 * Batches are staggered by `staggerMs`, because prompts cluster at boot.
 *
 * `delivered` counts result branches that landed with an `ok` manifest; `failed` counts workers that
 * are known dead (a pushed FAILED.md, a non-zero exit, a stall verdict). A failure frees its slot
 * but proves nothing about the environment, so it never advances the stage — a FAILED.md that says
 * `blocked host` at zero deliveries is exactly the case where widening dispatches N more of the same.
 *
 * @param {object} o  {dispatched, delivered, failed?, target, now, lastDispatchAt?, staggerMs?, maxInFlight?}
 * @returns {{more: number, stage: 1|2|3, ceiling: number, inFlight: number, waitMs: number, reason: string}}
 */
export function rampPlan({ dispatched = 0, delivered = 0, failed = 0, target = 0, now, lastDispatchAt = null, staggerMs = STAGGER_MS, maxInFlight = Infinity }) {
  const d = Math.max(0, Number(dispatched) || 0)
  const ok = Math.max(0, Number(delivered) || 0)
  const bad = Math.max(0, Number(failed) || 0)
  const want = Math.max(0, Number(target) || 0)
  const inFlight = Math.max(0, d - ok - bad)
  const remaining = Math.max(0, want - d)

  let stage
  let ceiling
  let more
  let reason
  if (ok === 0) {
    stage = 1
    ceiling = FIRST_WAVE
    more = Math.max(0, Math.min(FIRST_WAVE, want) - d)
    reason = more > 0 ? 'probe wave: nothing delivered yet' : d >= FIRST_WAVE ? `nothing delivered from ${d} dispatched — the probe wave is out; diagnose the environment before widening` : 'target reached'
  } else if (ok < FIRST_WAVE) {
    stage = 2
    ceiling = Math.min(SECOND_WAVE, maxInFlight)
    more = Math.max(0, Math.min(ceiling - inFlight, remaining))
    reason = more > 0 ? `${ok} delivered: widening to ${ceiling} in flight` : inFlight >= ceiling ? `${inFlight} in flight is the stage-2 ceiling` : 'target reached'
  } else {
    stage = 3
    ceiling = maxInFlight
    more = Math.max(0, Math.min(ceiling - inFlight, remaining))
    reason = more > 0 ? `${ok} delivered: the environment is proven, dispatching the rest` : inFlight >= ceiling ? `${inFlight} in flight is the width ceiling` : 'target reached'
  }

  const t = toMs(now)
  const last = toMs(lastDispatchAt)
  let waitMs = 0
  if (more > 0 && t !== null && last !== null && t - last < staggerMs) {
    waitMs = staggerMs - (t - last)
    more = 0
    reason = `staggered: ${Math.ceil(waitMs / 1000)}s until the next batch (prompts cluster at boot)`
  }
  return { more, stage, ceiling, inFlight, waitMs, reason }
}

/**
 * One worker's state from one reading. PURE.
 *
 * @param {object} o  {dispatchedAt, now, delivered?, failed?, exitCode?, stallMs?}
 * @returns {{verdict: 'delivered'|'oom'|'failed'|'stuck'|'running', action: string, retryAsIs: boolean, quietMs: number|null, remainingMs: number|null, reason: string}}
 */
export function stallVerdict({ dispatchedAt, now, delivered = false, failed = false, exitCode = null, stallMs = STALL_MS }) {
  const start = toMs(dispatchedAt)
  const t = toMs(now)
  const quietMs = start !== null && t !== null ? Math.max(0, t - start) : null
  if (delivered) return { verdict: 'delivered', action: 'harvest', retryAsIs: false, quietMs, remainingMs: 0, reason: 'a results branch landed' }
  if (exitCode === OOM_EXIT) {
    return { verdict: 'oom', action: 'split', retryAsIs: false, quietMs, remainingMs: 0, reason: `exit ${OOM_EXIT} is the per-container out-of-memory kill: the slice was too large for the box — split it and dispatch the halves; the same slice dies the same way` }
  }
  if (failed || (Number.isInteger(exitCode) && exitCode !== 0)) {
    return { verdict: 'failed', action: 'read-failed-md', retryAsIs: false, quietMs, remainingMs: 0, reason: failed ? 'the worker pushed FAILED.md' : `the worker exited ${exitCode}` }
  }
  if (quietMs === null) return { verdict: 'running', action: 'wait', retryAsIs: false, quietMs: null, remainingMs: null, reason: 'no clock: cannot judge quiet time' }
  if (quietMs > stallMs) {
    return { verdict: 'stuck', action: 'redispatch-new-ref', retryAsIs: false, quietMs, remainingMs: 0, reason: `quiet ${Math.round(quietMs / 60_000)} min with no branch: presumed stuck (an install retry-loops against a blocked host for twenty minutes without erroring) — record it failed and re-dispatch on a new ref` }
  }
  return { verdict: 'running', action: 'wait', retryAsIs: false, quietMs, remainingMs: stallMs - quietMs, reason: `quiet ${Math.round(quietMs / 60_000)} min; ${Math.ceil((stallMs - quietMs) / 60_000)} min before it is presumed stuck` }
}

// ---- the results poll ----------------------------------------------------------------------------

/** The sha `git ls-remote --heads` printed for `refs/heads/<branch>`, or null when the branch is absent. PURE. */
export function parseLsRemote(stdout, branch) {
  const want = `refs/heads/${branch}`
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [sha, ref] = line.split('\t')
    if (ref === want && /^[0-9a-f]{40,64}$/.test(sha || '')) return sha
  }
  return null
}

/**
 * May this ref be dispatched? PURE. A ref in the dispatch log is refused whatever its tip is now —
 * a force-pushed ref is not reliably seen by a fresh worker, so the correction goes on a NEW name.
 * @returns {{ok: boolean, reason: string|null, suggestedRef: string|null, previous: object|null}}
 */
export function dispatchGate({ ref, previous = [] }) {
  assertRefName(ref, 'capture ref')
  const seen = (previous || []).filter(p => p && p.ref === ref)
  if (!seen.length) return { ok: true, reason: null, suggestedRef: null, previous: null }
  const last = seen[seen.length - 1]
  return {
    ok: false,
    reason: `${ref} was already dispatched at ${last.at || 'an earlier time'} (sha ${last.sha || 'unknown'}) — never re-dispatch onto an existing ref: a fresh worker can still see the pre-force-push commit`,
    suggestedRef: nextRef(ref),
    previous: last,
  }
}

/**
 * Is the results branch there, and has its tip moved since `before`?
 *
 * ⛔ The exit code decides whether there is an answer at all. `git ls-remote` prints NOTHING for an
 * absent branch and exits 0, and prints NOTHING for a dead network and exits 128; a caller that read
 * empty output as "absent" re-dispatched onto a force-pushed ref. A failed listing is `ok: false`
 * with `present: null` — not a delivery verdict of any kind.
 *
 * @param {object} o  {remote, branch, run?, cwd?, before?}  `before` is the tip snapshotted before
 *                    dispatch (null when the branch did not exist); with it, delivered means CHANGED.
 * @returns {{ok: boolean, present: boolean|null, sha: string|null, changed: boolean|null, delivered: boolean, error: string|null}}
 */
export function pollResults({ remote, branch, run = execRun, cwd = null, before = undefined, timeoutMs = 60_000 }) {
  assertRefName(branch, 'results branch')
  if (!remote) throw new Error('pollResults: remote is required')
  const args = cwd ? ['-C', cwd] : []
  const r = run('git', [...args, 'ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeoutMs })
  if (!r.ok) {
    const why = r.timedOut ? 'timed out' : `exit ${r.code}`
    return { ok: false, present: null, sha: null, changed: null, delivered: false, error: `git ls-remote ${remote} ${branch}: ${why}${(r.stderr || '').trim() ? ` — ${String(r.stderr).trim().slice(0, 300)}` : ''}` }
  }
  const sha = parseLsRemote(r.stdout, branch)
  const present = sha !== null
  const changed = before === undefined ? null : sha !== (before ?? null)
  return { ok: true, present, sha, changed, delivered: present && (before === undefined ? true : changed), error: null }
}

// ---- what the worker pushed ----------------------------------------------------------------------

const HOST_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?)\b/i

/**
 * One host probe line → a verdict. PURE.
 *
 *   reached      any HTTP status from the origin — 200, 301, 404, and ⛔ 401/403 FROM THE ORIGIN too:
 *                an auth challenge is a network success; the credential is a separate question
 *                (`credentialRefused`), with a separate owner;
 *   blocked      the tunnel was refused — 403 on the CONNECT, connect_rejected, a refused connection;
 *   dns-failure  ENOTFOUND — neither an allowlist problem nor a credential one.
 */
export function probeVerdict(host, text) {
  const s = String(text ?? '')
  const status = (() => {
    const m = /\b(?:status\s*)?([1-5]\d{2})\b/.exec(s)
    return m ? Number(m[1]) : null
  })()
  const tunnelRefused = /CONNECT|connect_rejected|tunnel|refused|ECONNREFUSED|blocked/i.test(s)
  let verdict
  if (/\breached\b/i.test(s)) verdict = 'reached'
  // DNS is judged BEFORE the tunnel words: the runbook's probe one-liner prints `<host> blocked ENOTFOUND`
  // for a name that does not resolve, and a verdict that stopped at the word "blocked" filed a DNS
  // failure under the allowlist — which is neither its owner nor its fix.
  else if (/ENOTFOUND|EAI_AGAIN|\bdns\b/i.test(s)) verdict = 'dns-failure'
  else if (tunnelRefused) verdict = 'blocked'
  else if (status !== null) verdict = 'reached'
  else verdict = 'unknown'
  const credentialRefused = verdict === 'reached' && (status === 401 || status === 403)
  return { host, verdict, status: verdict === 'reached' ? status : null, credentialRefused, raw: s.trim() }
}

/**
 * `<label>: <rest>`, `<label> — <rest>`, or a bare `**label**` header with its value on the next line —
 * after an optional list marker. Returns null for anything else. PURE.
 *
 * The runbook's FAILURE list is numbered and bold and its labels carry hyphens and brackets
 * ("a re-run recipe", "blockedHosts[]"), so the separator is a colon or a SPACED dash: a lazy match
 * that accepted any hyphen once split "a re-run recipe — add …" at "re-" and dropped the recipe.
 */
function labelOf(line) {
  // A bullet or a number is a marker only with whitespace after it: `**reason**` starts with `*` too,
  // and stripping that as a bullet left a bare bold header unrecognised.
  const s = String(line).replace(/^\s*(?:[-*]\s+)?(?:\d+\.\s+)?/, '').trim()
  let label
  let rest
  const bold = /^\*\*([A-Za-z][A-Za-z[\] -]*)\*\*\s*(.*)$/.exec(s)
  const plain = bold ? null : /^([A-Za-z][A-Za-z[\] -]*?)(?::|\s+[—–-]\s+)(.*)$/.exec(s)
  if (bold) [label, rest] = [bold[1], bold[2]]
  else if (plain) [label, rest] = [plain[1], plain[2]]
  else if (/^[A-Za-z][A-Za-z[\] -]*$/.test(s)) [label, rest] = [s, '']
  else return null
  return { label: label.toLowerCase().replace(/[^a-z]/g, ''), rest: rest.replace(/^\s*[:—–-]\s*/, '').trim() }
}

/** The machine-greppable reason id from a FAILED.md reason line. PURE. */
export function reasonToken(line) {
  const s = String(line || '').trim().toLowerCase()
  for (const token of FAILURE_REASONS) if (s.startsWith(token)) return token.replace(/\s+/g, '-')
  return 'unknown'
}

/**
 * FAILED.md → its parts. PURE and tolerant: the file is prose a worker wrote under pressure, so
 * every part is best-effort and the raw text is kept.
 * @returns {{reason: string|null, reasonToken: string, phase: string|null, blockedHosts: string[], probes: object[], command: string|null, recipe: string|null, raw: string}}
 */
export function parseFailedMd(text) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  let reason = null
  let phase = null
  let recipe = null
  const blockedHosts = []
  const probes = []
  const fences = []
  let section = null
  let fence = null
  let fenceAfterCommand = null
  let sawCommand = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence === null) { fence = []; continue }
      fences.push(fence.join('\n'))
      if (sawCommand && fenceAfterCommand === null) fenceAfterCommand = fence.join('\n')
      fence = null
      continue
    }
    if (fence !== null) { fence.push(line); continue }
    const lab = labelOf(line)
    const label = lab ? lab.label : null
    const rest = lab ? lab.rest : ''
    if (label === 'reason' && reason === null) { if (rest) reason = rest; else section = 'reason'; continue }
    if (label === 'phase') {
      const p = /\b(boot|before|after|deliver)\b/i.exec(rest)
      if (p) { phase = p[1].toLowerCase(); section = null } else section = rest ? null : 'phase'
      continue
    }
    if (label === 'blockedhosts' || label === 'blockedhost') {
      section = 'blocked'
      for (const h of rest.split(/[\s,]+/)) { const hm = HOST_RE.exec(h); if (hm) blockedHosts.push(hm[1]) }
      continue
    }
    if (label === 'probes' || label === 'proberesults' || label === 'proberesultsperhost' || label === 'hostprobe' || label === 'hostprobes') { section = 'probes'; continue }
    if (label === 'command' || label === 'failedcommand' || label === 'theexactcommandthatfailed') { sawCommand = true; section = null; if (rest) fences.unshift(rest); continue }
    if (label === 'recipe' || label === 'rerunrecipe' || label === 'rerun' || label === 'arerunrecipe') { recipe = rest || null; section = 'recipe'; continue }

    const hostLine = /^\s*(?:[-*]\s*)?`?([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)`?\s*[:—-]?\s+(.+)$/i.exec(line)
    if (hostLine && /reached|blocked|dns|status|\b[1-5]\d{2}\b|ENOTFOUND|refused|CONNECT/i.test(hostLine[2])) {
      probes.push(probeVerdict(hostLine[1].toLowerCase(), hostLine[2]))
      continue
    }
    if (section === 'blocked') {
      const hm = HOST_RE.exec(line)
      if (hm) blockedHosts.push(hm[1].toLowerCase())
      else if (line.trim()) section = null
      continue
    }
    if (section === 'reason' && line.trim()) { reason = line.trim(); section = null; continue }
    if (section === 'phase' && line.trim()) {
      const p = /\b(boot|before|after|deliver)\b/i.exec(line)
      if (p) phase = p[1].toLowerCase()
      section = null
      continue
    }
    if (section === 'recipe' && line.trim()) { recipe = recipe ? `${recipe}\n${line.trim()}` : line.trim(); continue }
    if (reason === null && line.trim() && !/^\s*#/.test(line)) reason = line.trim()
  }
  for (const p of probes) if (p.verdict === 'blocked') blockedHosts.push(p.host)
  return {
    reason,
    reasonToken: reasonToken(reason),
    phase,
    blockedHosts: [...new Set(blockedHosts.map(h => h.toLowerCase()))],
    probes,
    command: fenceAfterCommand ?? fences[0] ?? null,
    recipe,
    raw,
  }
}

/** `manifest.json` text → {manifest, error}. PURE. A file that is not a JSON object is an error, never "no manifest". */
export function parseManifest(text) {
  if (text === null || text === undefined) return { manifest: null, error: null }
  try {
    const m = JSON.parse(String(text))
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { manifest: null, error: 'manifest.json is not a JSON object' }
    return { manifest: m, error: null }
  } catch (e) {
    return { manifest: null, error: `manifest.json does not parse: ${e.message}` }
  }
}

/**
 * The collection hard-fail list (playbooks/cloud-capture.md §How the dispatching session consumes
 * your output). PURE. A MISSING status is not "ok"; a differently named file is not a manifest; the
 * after-commit must equal the sha that was pushed; a blocked host the screen needs invalidates the
 * shots.
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function collectVerdict({ manifest, manifestError = null, failed = null, expectedSha = null, neededHosts = [], blockedHosts = [] }) {
  const reasons = []
  if (failed) reasons.push(`FAILED.md present: ${failed.reason || 'no reason line'}`)
  if (manifestError) reasons.push(manifestError)
  if (!manifest) reasons.push(`${MANIFEST_FILE} is missing (a differently named file does not count)`)
  else {
    if (manifest.status === undefined || manifest.status === null || manifest.status === '') reasons.push('manifest status is missing — a missing status is not "ok"')
    else if (manifest.status !== 'ok') reasons.push(`manifest status is ${JSON.stringify(manifest.status)}`)
    if (expectedSha) {
      const after = String(manifest.after_commit ?? manifest.afterCommit ?? '')
      if (!after) reasons.push(`manifest after_commit is missing; expected ${expectedSha}`)
      else if (!(after === expectedSha || after.startsWith(expectedSha) || expectedSha.startsWith(after))) reasons.push(`manifest after_commit ${after} is not the pushed sha ${expectedSha} — the worker photographed a different revision`)
    }
  }
  const need = new Set((neededHosts || []).map(h => String(h).toLowerCase()))
  for (const h of blockedHosts) if (need.has(String(h).toLowerCase())) reasons.push(`blocked host ${h} is one the screen needs`)
  return { ok: reasons.length === 0, reasons }
}

/**
 * Everything harvested from one results-branch tip, from its file texts. PURE.
 *
 * @param {object} o  {sha, files: string[], manifestText, failedText, outboxTexts: {[file]: text}, expectedSha?, neededHosts?}
 * @returns {{status, sha, blockedHosts: string[], probes: object[], shots: string[], outboxEntries: object[], manifest, failed, verdict}}
 */
export function harvestResult({ sha = null, files = [], manifestText = null, failedText = null, outboxTexts = {}, expectedSha = null, neededHosts = [] }) {
  const { manifest, error: manifestError } = parseManifest(manifestText)
  const failed = failedText === null || failedText === undefined ? null : parseFailedMd(failedText)

  const byHost = new Map()
  const probeSrc = manifest && manifest.hostProbe && typeof manifest.hostProbe === 'object' ? manifest.hostProbe : {}
  for (const [host, text] of Object.entries(probeSrc)) byHost.set(String(host).toLowerCase(), probeVerdict(String(host).toLowerCase(), text))
  for (const p of failed ? failed.probes : []) byHost.set(p.host, p) // the failure's own reading wins for a host both name
  const probes = [...byHost.values()]

  const blocked = new Set()
  for (const h of Array.isArray(manifest?.blockedHosts) ? manifest.blockedHosts : []) blocked.add(String(h).toLowerCase())
  for (const h of failed ? failed.blockedHosts : []) blocked.add(h)
  for (const p of probes) if (p.verdict === 'blocked') blocked.add(p.host)
  const blockedHosts = [...blocked]

  const shots = (files || []).filter(f => /\.png$/i.test(f)).sort()
  const outboxEntries = Object.entries(outboxTexts || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, text]) => {
    try {
      const entry = JSON.parse(String(text))
      return { file, entry, error: null }
    } catch (e) {
      return { file, entry: null, error: `does not parse: ${e.message}` }
    }
  })

  let status
  if (manifest) status = manifest.status === undefined || manifest.status === null || manifest.status === '' ? 'missing-status' : String(manifest.status)
  else if (failed) status = 'failed'
  else status = 'missing-manifest'

  const verdict = collectVerdict({ manifest, manifestError, failed, expectedSha, neededHosts, blockedHosts })
  return { status, sha, blockedHosts, probes, shots, outboxEntries, manifest, failed, verdict }
}

// ---- the transcript ------------------------------------------------------------------------------

const URL_RE = /https:\/\/[^\s"'<>)\]]+/g

/**
 * The created session's id and viewer URL, from its transcript (JSON lines). PURE and tolerant —
 * the transcript format is the host's and changes between releases, so this reads field NAMES loosely
 * and never a fixed record shape: the id from any `sessionId`-like field, the URL from any `*url*`
 * field, else the first https URL that mentions the id.
 * @returns {{sessionId: string|null, viewUrl: string|null}}
 */
export function sessionInfoFrom(text) {
  let sessionId = null
  let viewUrl = null
  const urlsSeen = []
  const visit = (v, key = '') => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') {
      if (!sessionId && /^(session_?id|remote_?session_?id|cloud_?session_?id)$/i.test(key) && v.trim()) sessionId = v.trim()
      if (/url/i.test(key) && /^https:\/\//.test(v.trim())) { if (!viewUrl) viewUrl = v.trim() }
      else for (const u of v.match(URL_RE) || []) urlsSeen.push(u)
      return
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k)
  }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    visit(entry)
  }
  if (!viewUrl && sessionId) viewUrl = urlsSeen.find(u => u.includes(sessionId)) || null
  return { sessionId, viewUrl }
}

/**
 * The newest transcript written for `cwd` since `sinceMs`, as text, or null. The one filesystem
 * reader dispatch() needs; injected as `readTranscript` everywhere else.
 */
export function readNewestTranscript({ transcriptsDir, cwd, sinceMs = 0 }) {
  if (!transcriptsDir || !cwd) return null
  const dir = path.join(transcriptsDir, transcriptSlug(cwd))
  let best = null
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      const st = fs.statSync(file)
      if (st.mtimeMs + 5_000 < sinceMs) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs }
    }
    return best ? fs.readFileSync(best.file, 'utf8') : null
  } catch {
    return null
  }
}

// ---- the stub, the runbook file, the dispatch log ------------------------------------------------

const gitIn = (run, dir, args, opts = {}) => run('git', ['-C', dir, ...args], { timeoutMs: 120_000, ...opts })
// String(): a `git show` run with `encoding: 'buffer'` answers with Buffers, and a Buffer has no trim().
const failureOf = r => String(r.stderr || r.stdout || '').trim().slice(0, 500) || (r.timedOut ? 'timed out' : `exit ${r.code}`)

/**
 * Write the runbook into the stub and VERIFY the copy: at least the source's size, the source
 * byte-for-byte at its head, the sentinel at its tail. Returns the file path.
 */
export function writeRunbook({ dir, text, sourceText }) {
  const file = path.join(dir, RUNBOOK_FILE)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, text)
  const back = fs.readFileSync(file, 'utf8')
  const v = verifyRunbookCopy({ sourceText, copyText: back })
  if (!v.ok) throw new Error(`writeRunbook: the runbook copy at ${file} is not whole — ${v.reason}`)
  return file
}

/**
 * A tiny blobless stub pinned to `ref`: `git init`, the remote, a depth-1 blobless fetch of the ref,
 * a LOCAL branch of the same name with HEAD on it. The cloud CLI uploads this directory, and the
 * sandbox checks the real tree out server-side (the runbook's Boot step 6 fetches `<remote>/<ref>`
 * itself and verifies the sha, precisely because the stub's local branch is not the truth).
 * @returns {{sha: string, head: string}}
 */
export function buildStub({ run = execRun, into, remoteUrl, remoteName = 'origin', ref }) {
  assertRefName(ref, 'capture ref')
  if (!into || !remoteUrl) throw new Error('buildStub: into and remoteUrl are required')
  if (fs.existsSync(into) && fs.readdirSync(into).length) throw new Error(`buildStub: ${into} already exists and is not empty`)
  fs.mkdirSync(into, { recursive: true })
  const step = (what, r) => { if (!r.ok) throw new Error(`buildStub: ${what} failed — ${failureOf(r)}`) }
  step('git init', gitIn(run, into, ['init', '-q']))
  step('git remote add', gitIn(run, into, ['remote', 'add', remoteName, remoteUrl]))
  step(`git fetch ${remoteName} ${ref}`, gitIn(run, into, ['fetch', '-q', '--depth', '1', '--filter=blob:none', remoteName, ref], { timeoutMs: 10 * 60_000 }))
  const rev = gitIn(run, into, ['rev-parse', 'FETCH_HEAD'])
  step('git rev-parse FETCH_HEAD', rev)
  const sha = rev.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`buildStub: FETCH_HEAD is ${JSON.stringify(sha)}, not a sha`)
  step('git update-ref', gitIn(run, into, ['update-ref', `refs/heads/${ref}`, sha]))
  step('git symbolic-ref HEAD', gitIn(run, into, ['symbolic-ref', 'HEAD', `refs/heads/${ref}`]))
  return { sha, head: ref }
}

/** `<stateDir>/logs/cloud-dispatch.log`. */
export function dispatchLogPath(stateDir, platform = process.platform) {
  return path.join(stateLayout(stateDir, platform).logs, DISPATCH_LOG)
}

/** Every dispatch ever recorded, in order; [] when there is no log. A damaged line is skipped, never fatal. */
export function readDispatchLog(stateDir, platform = process.platform) {
  let text
  try {
    text = fs.readFileSync(dispatchLogPath(stateDir, platform), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a half-written line from a killed dispatch */ }
  }
  return out
}

/** Append one dispatch record — one JSON line, its newline included, synchronously; never a pipeline. */
export function appendDispatchLog(stateDir, entry, platform = process.platform) {
  const file = dispatchLogPath(stateDir, platform)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ v: 1, ...entry }) + '\n')
  return file
}

// ---- dispatch ------------------------------------------------------------------------------------

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Dispatch one worker. Impure, with every side effect injected.
 *
 * Order, each step a gate the next depends on:
 *   1. the ref name, the results branch name, and the dispatch log (never twice on one ref);
 *   2. the ref's tip on the remote — it must be PUSHED already, and a listing that fails is a
 *      failure, never "absent";
 *   3. the results branch's tip BEFORE dispatching, returned as `resultsTipBefore` so the caller
 *      polls for a DIFFERENT tip (existence returns instantly on any re-dispatch);
 *   4. the blobless stub, the bundle copied in, the runbook written and verified whole;
 *   5. the launch where a pty exists (launchPlan), through the injected runner;
 *   6. the session's id and viewer URL harvested from its transcript, polled with the injected sleep;
 *   7. the dispatch log entry — written LAST, so a dispatch that died before launching leaves no
 *      record that would refuse the retry.
 *
 * @param {object} o
 * @param {string} o.ref               the pushed capture ref
 * @param {string} o.resultsBranch     the branch the worker pushes to
 * @param {string} o.remoteUrl         `repo.remote`'s URL
 * @param {string} [o.remoteName]      `repo.remote` (default origin)
 * @param {string} o.prompt            buildRunbookPrompt()'s text
 * @param {string} o.playbookText      the runbook the prompt was built from (for the copy check)
 * @param {string} [o.bundleDir]       `--bundle`; copied into the stub under its basename
 * @param {string|null} [o.slice]      `--slice`
 * @param {string} o.stateDir          `paths.stateDir`
 * @param {string} [o.stubParent]      default `<stateDir>/cloud`
 * @param {string} [o.agent]           `fleet.agent`
 * @param {string|null} [o.model]      `fleet.model`
 * @param {string[]} [o.extraArgs]
 * @param {string} [o.platform]
 * @param {{socket, session, configFile?}} [o.tmux]   `terminal.tmux.*` (POSIX)
 * @param {string} [o.transcriptsDir]  `paths.transcriptsDir`
 * @param {Function} [o.run]           sys/exec.run
 * @param {Function} [o.readTranscript] ({cwd, sinceMs}) => text|null
 * @param {Function} [o.sleep]         ms => Promise
 * @param {Function} [o.clock]         () => ms
 * @param {number} [o.harvestTimeoutMs]  how long to wait for the transcript to name the session
 * @param {number} [o.pollMs]
 * @returns {Promise<{viewUrl, sessionId, ref, sha, resultsBranch, resultsTipBefore, stub, promptFile, via, launch, launchedAt, warnings: string[]}>}
 */
export async function dispatch({
  ref, resultsBranch, remoteUrl, remoteName = 'origin', prompt, playbookText, bundleDir = null, slice = null,
  stateDir, stubParent = null, agent = 'claude', model = null, extraArgs = [], platform = process.platform, tmux = null,
  transcriptsDir = null, run = execRun, readTranscript = null, sleep = defaultSleep, clock = Date.now,
  harvestTimeoutMs = 120_000, pollMs = 2_000,
}) {
  assertRefName(ref, 'capture ref')
  assertRefName(resultsBranch, 'results branch')
  if (ref === resultsBranch) throw new Error(`dispatch: the capture ref and the results branch are both ${JSON.stringify(ref)}`)
  if (!remoteUrl) throw new Error('dispatch: remoteUrl is required')
  if (!stateDir) throw new Error('dispatch: stateDir is required (paths.stateDir)')
  if (typeof prompt !== 'string' || !prompt) throw new Error('dispatch: prompt is required — build it with buildRunbookPrompt')
  if (typeof playbookText !== 'string' || !playbookText) throw new Error('dispatch: playbookText is required — the runbook copy is verified against it')
  if (bundleDir && !fs.existsSync(bundleDir)) throw new Error(`dispatch: bundle ${bundleDir} does not exist`)

  // 1. never twice on one ref
  const gate = dispatchGate({ ref, previous: readDispatchLog(stateDir, platform) })
  if (!gate.ok) throw new Error(`dispatch: ${gate.reason}; dispatch on ${gate.suggestedRef} instead`)

  // 2. the ref must be pushed, and a failed listing is a failure
  const tip = pollResults({ remote: remoteUrl, branch: ref, run })
  if (!tip.ok) throw new Error(`dispatch: cannot read ${ref} on the remote — ${tip.error}`)
  if (!tip.present) throw new Error(`dispatch: ${ref} is not on the remote — push it first (git push <remote> HEAD:${ref}); the dispatch targets the ref, never the worktree`)
  const sha = tip.sha

  // 3. the results tip before dispatching, so the caller polls for a DIFFERENT one
  const results = pollResults({ remote: remoteUrl, branch: resultsBranch, run })
  if (!results.ok) throw new Error(`dispatch: cannot snapshot ${resultsBranch} before dispatching — ${results.error}; without that snapshot a poll cannot tell this run's delivery from the last one's`)
  const resultsTipBefore = results.sha

  // 4. the stub, the bundle, the verified runbook
  const parent = stubParent || path.join(stateDir, 'cloud')
  fs.mkdirSync(parent, { recursive: true })
  // A dispatch that died before recording itself is retried within seconds on the SAME ref, and
  // its half-built stub is still there: the name is made unique rather than the retry refused.
  const stamp = `${refSlug(ref)}-${new Date(clock()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}`
  let stub = path.join(parent, stamp)
  for (let n = 2; fs.existsSync(stub); n++) stub = path.join(parent, `${stamp}-${n}`)
  buildStub({ run, into: stub, remoteUrl, remoteName, ref })
  if (bundleDir) fs.cpSync(bundleDir, path.join(stub, path.basename(bundleDir)), { recursive: true })
  const promptFile = writeRunbook({ dir: stub, text: prompt, sourceText: playbookText })

  // 5. launch where a pty exists
  let tmuxOpts = null
  if (platform !== 'win32') {
    if (!tmux || !tmux.socket || !tmux.session) throw new Error('dispatch: terminal.tmux.socket and terminal.tmux.session are required on POSIX')
    const base = ['-L', tmux.socket, '-f', tmux.configFile || DEFAULT_TMUX_CONFIG]
    const exists = run('tmux', [...base, 'has-session', '-t', `=${tmux.session}`], { timeoutMs: 15_000 }).ok
    tmuxOpts = { ...tmux, exists }
  }
  const plan = launchPlan({ platform, agent, model, promptFile, cwd: stub, extraArgs, tmux: tmuxOpts, title: `cloud-${refSlug(ref)}` })
  const launchedAt = clock()
  const r = run(plan.command, plan.args, { timeoutMs: 30_000 })
  if (!r.ok) throw new Error(`dispatch: ${plan.via} launch failed — ${failureOf(r)}`)
  const launch = plan.via === 'tmux' ? parseTmuxSpawn(r.stdout) : parseWindowsSpawn(r.stdout)
  if (!launch) throw new Error(`dispatch: ${plan.via} launch printed ${JSON.stringify(String(r.stdout).trim())} — the worker's window cannot be identified`)
  if (plan.via === 'tmux') {
    // A crashed CLI must leave its scrollback behind: that is the only evidence of why the dispatch died.
    run('tmux', ['-L', tmuxOpts.socket, '-f', tmuxOpts.configFile || DEFAULT_TMUX_CONFIG, 'set-option', '-w', '-t', launch.windowId, 'remain-on-exit', 'on'], { timeoutMs: 15_000 })
  }

  // 6. the session's id and URL, from its transcript
  const reader = readTranscript || (({ cwd, sinceMs }) => readNewestTranscript({ transcriptsDir, cwd, sinceMs }))
  let info = { sessionId: null, viewUrl: null }
  const deadline = launchedAt + harvestTimeoutMs
  for (;;) {
    const text = reader({ cwd: stub, sinceMs: launchedAt })
    if (text) info = sessionInfoFrom(text)
    if (info.sessionId && info.viewUrl) break
    if (clock() >= deadline) break
    await sleep(pollMs)
  }
  const warnings = []
  if (!info.sessionId && !info.viewUrl) {
    throw new Error(`dispatch: the worker launched (${plan.via} ${JSON.stringify(launch)}) but no transcript named a session within ${Math.round(harvestTimeoutMs / 1000)}s — open the window and read what the CLI printed; nothing was recorded, so a retry on ${ref} is allowed`)
  }
  if (!info.viewUrl) warnings.push('the transcript names a session id but no viewer URL — record the id as the worker handle')
  if (!info.sessionId) warnings.push('the transcript carries a URL but no session id')

  // 7. recorded LAST, so a dispatch that died above leaves no record that would refuse the retry
  const entry = { at: new Date(launchedAt).toISOString(), ref, sha, resultsBranch, resultsTipBefore, slice, viewUrl: info.viewUrl, sessionId: info.sessionId, stub, promptFile, via: plan.via, launch }
  appendDispatchLog(stateDir, entry, platform)

  return { ...info, ref, sha, resultsBranch, resultsTipBefore, stub, promptFile, via: plan.via, launch, launchedAt, warnings }
}

// ---- harvest -------------------------------------------------------------------------------------

/**
 * Fetch the results branch and read what the worker pushed at its tip. The sha is PINNED (a worker
 * can push again after you collect — one landed seconds before a PR opened), and every file is read
 * `git show <sha>:<path>`, never from a checkout.
 *
 * @param {object} o
 * @param {string} o.branch           the results branch
 * @param {string} o.into             the repository directory to fetch into (the PRIMARY checkout or
 *                                    a scratch clone — never a worktree that may be deregistered)
 * @param {string} [o.remote]         `repo.remote`
 * @param {Function} [o.run]
 * @param {string|null} [o.expectedSha]  the capture ref's tip — the manifest's after_commit must equal it
 * @param {string[]} [o.neededHosts]  hosts the screen needs (`capture.allowlistHosts`)
 * @param {string|null} [o.extractTo] write every PNG here, byte-exact, via `git show` with a buffer
 * @returns {{status, sha, blockedHosts, probes, shots, outboxEntries, manifest, failed, verdict, files, extracted: string[]}}
 */
export function harvest({ branch, into, remote = 'origin', run = execRun, expectedSha = null, neededHosts = [], extractTo = null, timeoutMs = 120_000 }) {
  assertRefName(branch, 'results branch')
  if (!into) throw new Error('harvest: into (a repository directory) is required')
  const fetched = gitIn(run, into, ['fetch', '-q', remote, branch], { timeoutMs })
  if (!fetched.ok) throw new Error(`harvest: git fetch ${remote} ${branch} failed — ${failureOf(fetched)}; a failed fetch is not "nothing delivered"`)
  const rev = gitIn(run, into, ['rev-parse', 'FETCH_HEAD'])
  if (!rev.ok) throw new Error(`harvest: git rev-parse FETCH_HEAD failed — ${failureOf(rev)}`)
  const sha = rev.stdout.trim()
  const tree = gitIn(run, into, ['ls-tree', '-r', '--name-only', sha])
  if (!tree.ok) throw new Error(`harvest: git ls-tree ${sha} failed — ${failureOf(tree)}`)
  const files = tree.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const show = p => {
    const r = gitIn(run, into, ['show', `${sha}:${p}`])
    return r.ok ? r.stdout : null
  }
  const manifestText = files.includes(MANIFEST_FILE) ? show(MANIFEST_FILE) : null
  const failedText = files.includes(FAILED_FILE) ? show(FAILED_FILE) : null
  const outboxTexts = {}
  for (const f of files) {
    if (/(^|\/)outbox\/[^/]+\.json$/.test(f)) outboxTexts[f] = show(f) ?? ''
  }
  const result = harvestResult({ sha, files, manifestText, failedText, outboxTexts, expectedSha, neededHosts })
  const extracted = []
  if (extractTo) {
    fs.mkdirSync(extractTo, { recursive: true })
    for (const shot of result.shots) {
      const r = gitIn(run, into, ['show', `${sha}:${shot}`], { encoding: 'buffer' })
      if (!r.ok) throw new Error(`harvest: git show ${sha}:${shot} failed — ${failureOf(r)}`)
      const dest = path.join(extractTo, shot)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, r.stdout)
      extracted.push(dest)
    }
  }
  return { ...result, files, extracted }
}
