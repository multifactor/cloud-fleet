// The bare-console fallback for a Windows machine without Windows Terminal.
//
// One `Start-Process powershell -NoExit -File ps-launcher.ps1 <title> <cwd> <command> <args…>` per
// session: a free-floating console window whose launcher sets the title and runs the shim in the
// foreground. Everything else — list, isAlive, send, setStatus, kill, focus, layout — is the same
// registry-first machinery as the Windows Terminal backend (registry-first.mjs), because a bare
// console has even less of a query API than wt does.
//
// The whole shim argv, marker included, rides on the window's own powershell.exe command line, so the
// host window is a marked pid too: kill roots at it and takes the window down with the tree, and the
// injector targets the pid the shim wrote into its descriptor rather than the first marked one.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { NO_CAPABILITIES, assertSpawnSpec } from './types.mjs'
import { run as sysRun, which as sysWhich } from '../sys/exec.mjs'
import { readSession, reconcilePlan } from '../core/fleet.mjs'
import {
  createSnapshotSource, mintRef, assertRef, assertStatus, assertNotRunning, spawnState, listHandles, killSpawn,
  sendViaInjector, writeStatus, planLayout,
} from './registry-first.mjs'
import { PS_ARGS, injectorArgv, parseInjectorResult, focusScript, parseFocusResult, encodeUtf16, titleOf } from './windows-terminal.mjs'

export const BACKEND_NAME = 'powershell'

/** The per-window launcher (see its header for why it has no param() block). */
export const PS_LAUNCHER = fileURLToPath(new URL('./ps-launcher.ps1', import.meta.url))

/** Separate OS windows that outlive the launcher; nothing else is queryable, tileable or observable. */
export const POWERSHELL_CAPABILITIES = Object.freeze({ ...NO_CAPABILITIES, freeFloatingWindows: true, detachSurvivesLauncher: true })

// --- pure ---------------------------------------------------------------------------------------

/**
 * Quote one token for the child's command line the way the C runtime will parse it back: only when
 * needed, doubling backslashes before an inner quote and escaping the quote. Start-Process joins its
 * -ArgumentList with spaces and quotes NOTHING, so a worktree path with a space in it would otherwise
 * reach the launcher as two arguments and every positional after it would shift by one.
 */
export function quoteArg(s) {
  const t = String(s ?? '')
  if (t !== '' && !/[\s"]/.test(t)) return t
  return `"${t.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** A PowerShell single-quoted literal: the only escape is a doubled quote, so nothing else is syntax. */
export function psLiteral(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`
}

/**
 * The script the launcher process runs to open ONE window. It is passed with -EncodedCommand, so the
 * only quoting that exists is the two layers built here (a PS literal around a CRT-quoted token) and
 * both are tested. The new window's pid comes back on stdout.
 */
export function launchScript(spec, { launcher = PS_LAUNCHER, title = titleOf(spec) } = {}) {
  const inner = ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, title, spec.cwd, spec.command, ...spec.args]
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'powershell.exe' -WorkingDirectory ${psLiteral(spec.cwd)} -ArgumentList @(${inner.map(a => psLiteral(quoteArg(a))).join(', ')}) -PassThru`,
    '[Console]::Out.WriteLine($p.Id)',
  ].join('\n')
}

/** The host window's pid the launch script printed, or null when it printed none. */
export function parseHostPid(r) {
  if (!r || !r.ok) return null
  const m = /(\d+)\s*$/.exec(String(r.stdout || '').trim())
  return m ? Number(m[1]) : null
}

// --- the backend --------------------------------------------------------------------------------

/** Same seams as createWindowsTerminalBackend; `launcher` overrides the launcher script path for tests. */
export function createPowerShellBackend({
  config,
  platform = process.platform,
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
  launcher = PS_LAUNCHER,
} = {}) {
  const stateDir = (config && config.paths && config.paths.stateDir) || null
  const source = createSnapshotSource({ take: takeSnapshot, platform, maxAgeMs: snapshotMaxAgeMs, now })
  const caps = Object.freeze({ ...POWERSHELL_CAPABILITIES, pixelLayout: typeof placeWindows === 'function' })
  const doInject = inject || ((pid, text, opts) => parseInjectorResult(run('powershell.exe', injectorArgv(pid, text, opts), { timeoutMs: 30_000 })))
  const doFocus = focusWindow || (token => parseFocusResult(run('powershell.exe', [...PS_ARGS, '-EncodedCommand', encodeUtf16(focusScript(token))], { timeoutMs: 15_000 })))
  const descriptorOf = label => (stateDir ? readSession(label, { stateDir }) : null)
  // Liveness with the reconciler's birth grace (see windows-terminal.mjs): a registered session too
  // young for the cached snapshot to be evidence about is `pending`, and pending counts as alive, so
  // isAlive/send/setStatus/focus judge a newborn exactly as list() does.
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
      if (platform !== 'win32') return { available: false, name: BACKEND_NAME, reason: 'a PowerShell console window exists only on Windows' }
      if (!which('powershell.exe')) return { available: false, name: BACKEND_NAME, reason: 'powershell.exe is not on PATH' }
      return { available: true, name: BACKEND_NAME, reason: null }
    },

    capabilities() {
      return caps
    },

    spawn(spec) {
      assertSpawnSpec(spec)
      if (!stateDir) throw new Error('spawn: paths.stateDir is not resolved — a registry-first backend has nowhere to look a session up')
      const label = String(spec.id)
      descriptorOf(label)
      assertNotRunning(label, source.cached().snap)
      const title = titleOf(spec)
      const r = run('powershell.exe', [...PS_ARGS, '-EncodedCommand', encodeUtf16(launchScript(spec, { launcher, title }))], { timeoutMs: 30_000 })
      if (!r.ok) throw new Error(`spawn: Start-Process powershell for session "${label}" — ${r.timedOut ? 'timed out' : `exit ${r.code}`}\n${String(r.stderr || r.stdout).slice(0, 500)}`)
      const backendRef = mintRef(BACKEND_NAME, label, { hostPid: parseHostPid(r), title, spawnedAt: new Date(now()).toISOString() })
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

    layout(handles, mode = 'windows') {
      return planLayout(handles, mode, caps, { placeWindows })
    },
  }
}
