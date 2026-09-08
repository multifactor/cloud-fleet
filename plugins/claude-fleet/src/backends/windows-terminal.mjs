// The Windows Terminal backend.
//
//   wt.exe -w fleet new-tab --title <title> -d <cwd> -- node <shim> --fleet-session=<id> <descriptor.json>
//
// `-w fleet` groups every session into ONE named window, so the fleet is a row of tabs the operator
// can find and a second `fleet up` joins it instead of opening another window. Windows Terminal
// cannot pass an environment to the tab it opens — that is exactly why the shim reads a JSON
// descriptor (contract §4) and rebuilds the FLEET_* scalars itself, and why `spec.env` is NOT
// forwarded here: there is nowhere to forward it to.
//
// There is NO query API. wt cannot list its tabs, name a tab's process, or say whether text arrived.
// So list() is registry-first (core/fleet) reconciled against ONE cached snapshot, send() is
// console-input injection whose returned count is honoured, setStatus() is write-only, focus() is
// best-effort by title token, and every capability that would claim otherwise is declared false.
// The shared machinery is registry-first.mjs; this file is the wt-specific argv and the two
// PowerShell helpers it drives.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { NO_CAPABILITIES, assertSpawnSpec } from './types.mjs'
import { run as sysRun, which as sysWhich } from '../sys/exec.mjs'
import { readSession, reconcilePlan } from '../core/fleet.mjs'
import {
  createSnapshotSource, mintRef, assertRef, assertStatus, assertNotRunning, spawnState, listHandles, killSpawn,
  sendViaInjector, writeStatus, planLayout,
} from './registry-first.mjs'

export const BACKEND_NAME = 'windows-terminal'

/** The window every session tab is opened in (`wt -w <name>`). */
export const DEFAULT_WINDOW = 'fleet'

/** The console-input injector this backend drives (see the file's header for the protocol). */
export const WT_INJECT = fileURLToPath(new URL('./wt-inject.ps1', import.meta.url))

/** Every helper invocation: no profile (a profile that prints would corrupt the count), never a prompt, and the script policy is ours. */
export const PS_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])

/**
 * Declared honestly. Nothing about a wt tab is queryable, sends can come up short, a status can only
 * be written not read, tabs are not free-floating windows and there is no tiling API. What IS true:
 * the window outlives the launcher, so a running fleet survives the process that spawned it.
 * pixelLayout is added per instance when the extras/windows placement hook is supplied.
 */
export const WT_CAPABILITIES = Object.freeze({ ...NO_CAPABILITIES, detachSurvivesLauncher: true })

// --- pure ---------------------------------------------------------------------------------------

/** The tab's initial title — the token focus() will look for. The status hook may repaint around it later. */
export function titleOf(spec) {
  return String(spec.title || spec.id)
}

/** The wt.exe argv for one session. `--` ends wt's own options so the shim's flags are never read as wt's. */
export function wtArgv(spec, { window = DEFAULT_WINDOW } = {}) {
  return ['-w', window, 'new-tab', '--title', titleOf(spec), '-d', spec.cwd, '--', spec.command, ...spec.args]
}

/** UTF-16LE base64, the only way text with quotes, spaces or non-ASCII survives a Windows command line unchanged. */
export function encodeUtf16(text) {
  return Buffer.from(String(text ?? ''), 'utf16le').toString('base64')
}

/** The helper argv for ONE write: a chunk, or the Enter that submits — never both in one call. */
export function injectorArgv(pid, text, { enter = false } = {}) {
  const argv = [...PS_ARGS, '-File', WT_INJECT, '-TargetPid', String(pid)]
  if (text) argv.push('-TextBase64', encodeUtf16(text))
  if (enter) argv.push('-Enter')
  return argv
}

/**
 * The count the helper printed, or a reason. A helper that failed (AttachConsole refused: the pid is
 * gone or is not a console process) or printed nothing delivered NOTHING — the loop in
 * registry-first.deliverChunks treats a missing count as a short write, never as success.
 * @returns {{written: number, reason: string|null}}
 */
export function parseInjectorResult(r) {
  const firstLine = s => String(s || '').trim().split(/\r?\n/)[0] || ''
  if (!r || !r.ok) return { written: 0, reason: `injector failed (${r && r.timedOut ? 'timed out' : `exit ${r ? r.code : 'unknown'}`}): ${firstLine(r && (r.stderr || r.stdout)) || 'no output'}` }
  const m = /(\d+)\s*$/.exec(String(r.stdout || '').trim())
  if (!m) return { written: 0, reason: 'injector printed no count' }
  return { written: Number(m[1]), reason: null }
}

/**
 * Best-effort focus: activate every top-level window whose title contains the token. A wt window's
 * title is its ACTIVE tab's, so this finds the fleet window only while that tab is in front; a
 * PowerShell window carries the token itself. The token is wildcard-escaped and single-quoted, so a
 * title with `[`, `*` or `'` in it is data, not pattern or syntax.
 */
export function focusScript(token) {
  const literal = `'${String(token).replace(/'/g, "''")}'`
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape(${literal}) + '*'`,
    '$n = 0',
    'foreach ($p in Get-Process) {',
    '  if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -like $pattern) {',
    '    try { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id); $n++ } catch { }',
    '  }',
    '}',
    '[Console]::Out.WriteLine($n)',
  ].join('\n')
}

/** The activated-window count the focus script printed; anything else is a miss. */
export function parseFocusResult(r) {
  if (!r || !r.ok) return false
  const m = /(\d+)\s*$/.exec(String(r.stdout || '').trim())
  return !!m && Number(m[1]) > 0
}

// --- the backend --------------------------------------------------------------------------------

/**
 * @param {object} opts
 *   config          the resolved config; paths.stateDir is where the registry lives
 *   window          the wt window name (default `fleet`)
 *   run, which      sys/exec seams
 *   takeSnapshot    sys/snapshot seam; snapshotMaxAgeMs its cache window for list/isAlive/send
 *   killTree        sys/kill seam
 *   inject          (pid, text, {enter}) => number|{written, reason} — the console injector
 *   focusWindow     (token) => boolean — the window activator
 *   placeWindows    (handles) => number — the extras/windows pixel-grid hook; its presence is what
 *                   makes this instance claim pixelLayout
 */
export function createWindowsTerminalBackend({
  config,
  platform = process.platform,
  window = DEFAULT_WINDOW,
  run = sysRun,
  which = sysWhich,
  takeSnapshot,
  snapshotMaxAgeMs,
  killTree,
  selfPid = process.pid,
  now = Date.now,
  inject = null,
  focusWindow = null,
  placeWindows = null,
} = {}) {
  const stateDir = (config && config.paths && config.paths.stateDir) || null
  const source = createSnapshotSource({ take: takeSnapshot, platform, maxAgeMs: snapshotMaxAgeMs, now })
  const caps = Object.freeze({ ...WT_CAPABILITIES, pixelLayout: typeof placeWindows === 'function' })
  const doInject = inject || ((pid, text, opts) => parseInjectorResult(run('powershell.exe', injectorArgv(pid, text, opts), { timeoutMs: 30_000 })))
  const doFocus = focusWindow || (token => parseFocusResult(run('powershell.exe', [...PS_ARGS, '-EncodedCommand', encodeUtf16(focusScript(token))], { timeoutMs: 15_000 })))
  const descriptorOf = label => (stateDir ? readSession(label, { stateDir }) : null)
  // Liveness with the reconciler's birth grace, so isAlive/send/setStatus/focus judge a newborn exactly
  // as list() does: a registered session too young for the cached snapshot to be evidence about is
  // `pending`, and pending counts as alive — a session list() shows that isAlive() calls dead is the
  // "different sets" disagreement this file's header forbids. spawnState has no clock; the rule is
  // reconcilePlan's, applied to this one descriptor.
  const stateOf = ref => {
    const { snap, takenMs } = source.cached()
    const descriptor = descriptorOf(ref.label)
    const st = spawnState(ref, snap, descriptor)
    const pending = !st.alive && !st.replaced && !!descriptor && reconcilePlan([descriptor], snap, { nowMs: now(), snapshotTakenMs: takenMs }).pending.length > 0
    return { ...st, descriptor, pending, alive: st.alive || pending }
  }

  return {
    name: BACKEND_NAME,

    probe() {
      if (platform !== 'win32') return { available: false, name: BACKEND_NAME, reason: 'Windows Terminal exists only on Windows' }
      if (!which('wt.exe')) {
        return { available: false, name: BACKEND_NAME, reason: 'wt.exe is not on PATH: install Windows Terminal (winget install Microsoft.WindowsTerminal), or set terminal.backend to powershell' }
      }
      return { available: true, name: BACKEND_NAME, reason: null }
    },

    capabilities() {
      return caps
    },

    /**
     * Opens the tab and returns the handle. Nothing is recorded anywhere on a failed wt call, so a
     * refused spawn leaves no half-created session for the next status read to invent. The
     * descriptor is read first because that is also the label check: a label that is not a plain
     * filename throws here, before a tab exists for it.
     */
    spawn(spec) {
      assertSpawnSpec(spec)
      if (!stateDir) throw new Error('spawn: paths.stateDir is not resolved — a registry-first backend has nowhere to look a session up')
      const label = String(spec.id)
      descriptorOf(label)
      assertNotRunning(label, source.cached().snap)
      const argv = wtArgv(spec, { window })
      const r = run('wt.exe', argv, { timeoutMs: 30_000 })
      if (!r.ok) {
        throw new Error(`spawn: wt.exe ${argv.join(' ')} — ${r.timedOut ? 'timed out' : `exit ${r.code}`}\n${String(r.stderr || r.stdout).slice(0, 500)}`)
      }
      const backendRef = mintRef(BACKEND_NAME, label, { window, title: titleOf(spec), spawnedAt: new Date(now()).toISOString() })
      return Object.freeze({ id: label, role: spec.role, backendRef })
    },

    list() {
      return listHandles({ backend: BACKEND_NAME, stateDir, source, nowMs: now() })
    },

    isAlive(handle) {
      return stateOf(assertRef(handle, BACKEND_NAME)).alive
    },

    /** A newborn has no console pid to inject into yet: `session-pending`, never `session-gone` — the caller retries rather than gives up. */
    send(handle, text) {
      const ref = assertRef(handle, BACKEND_NAME)
      const st = stateOf(ref)
      if (st.pending) return { ok: false, requested: String(text ?? '').length, delivered: 0, truncated: false, reason: 'session-pending' }
      return sendViaInjector({ ref, stateDir, source, descriptor: st.descriptor, inject: doInject, text })
    },

    setStatus(handle, status) {
      assertStatus(status)
      const st = stateOf(assertRef(handle, BACKEND_NAME))
      if (!st.alive) return false
      return writeStatus(st.descriptor, status, now())
    },

    kill(handle) {
      const ref = assertRef(handle, BACKEND_NAME)
      return killSpawn(ref, { source, killTree, selfPid, platform, descriptor: descriptorOf(ref.label) })
    },

    focus(handle) {
      const ref = assertRef(handle, BACKEND_NAME)
      if (!stateOf(ref).alive) return false
      return !!doFocus(ref.title || ref.label)
    },

    /**
     * Sessions are TABS in one window (freeFloatingWindows: false), so the `windows` arrangement does not
     * exist here and nothing is placed — announced, like every other degradation, never a silent
     * `placed: N`. The PowerShell backend, whose sessions are separate windows, keeps the plain plan.
     */
    layout(handles, mode = 'windows') {
      const plan = planLayout(handles, mode, caps, { placeWindows })
      if (plan.notice || mode !== 'windows') return plan
      return { mode, placed: 0, notice: 'windows layout: sessions are tabs in one window on this terminal backend (no freeFloatingWindows)' }
    },
  }
}
