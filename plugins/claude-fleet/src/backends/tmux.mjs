// The tmux terminal backend (macOS / Linux).
//
// The fleet gets its OWN tmux server: a dedicated socket (`-L <terminal.tmux.socket>`) and a
// dedicated config (`-f <plugin>/tmux.conf`). It never shares the operator's server, never inherits
// their prefix or bindings, and `kill-server` on that socket tears down exactly the fleet and nothing
// else — a shared server is how `fleet down` once took an operator's own hour-old session with it.
//
// One WINDOW per session, never panes: twenty tiled panes are unreadable, and a window is the unit
// tmux can carry user options on at the 3.0 floor (pane options arrive in 3.1). Identity is written
// INTO the window at spawn — `@fleet_id`, `@fleet_role` — and `@fleet_state` is the status the
// status bar renders. `list()` is one `list-panes -a -F` call that reads all of them back:
// authoritative, from tmux itself, with no process snapshot and no command-line matching.
//
// Nothing is ever looked up by name. `new-window -P -F` prints the ids of the object it just
// created, and those ids (plus the pane's pid) are the `backendRef` the registry records. A handle
// resolves only when window id, pane id AND pane pid all still match: pane ids restart at %0 on a
// fresh server, so without the pid a stale handle from before `fleet down` would re-bind to whatever
// the next fleet spawned first.
//
// Every tmux call is `sys/exec.run('tmux', argv)` with an explicit argv. The pure decisions (argv
// builders, list parsing, version parsing, the short/long send split, ref resolution) are exported
// on their own so the traps they encode are unit tests rather than comments.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { NO_CAPABILITIES, STATUS, assertSpawnSpec, degradationNotice, fullDelivery } from './types.mjs'
import { run, which as whichOnPath } from '../sys/exec.mjs'
import { killTree as killTreeReal } from '../sys/kill.mjs'
import { snapshot as takeSnapshot } from '../sys/snapshot.mjs'
import { parseTsv } from '../sys/tsv.mjs'

/**
 * Declared honestly. `pixelLayout`, `multiMonitor` and `freeFloatingWindows` are what a multiplexer
 * cannot do — windows live inside one terminal — and saying so is what makes a caller's degradation
 * branch run. `gridLayout` is not claimed either: a session IS a window here, and `select-layout`
 * only arranges the panes inside one window, so no tmux call tiles sessions beside each other.
 * `detachSurvivesLauncher` is the one this backend has that Windows Terminal lacks: the server is a
 * daemon, so closing the launcher's terminal (or dropping an SSH connection) leaves the fleet running
 * and `fleet attach` finds it again.
 */
export const TMUX_CAPABILITIES = Object.freeze({
  ...NO_CAPABILITIES,
  authoritativeList: true,
  reliableSend: true,
  observableStatus: true,
  detachSurvivesLauncher: true,
  focusById: true,
})

/** `new-window -P -F` (3.0) and window user options need this; `-e` would need 3.2, so env rides the pane's shell line instead (paneCommand). */
export const MIN_TMUX_VERSION = Object.freeze({ major: 3, minor: 0 })

/**
 * Above this, text goes through the paste buffer rather than `send-keys -l`. tmux itself has no
 * truncation class either way; the split exists because a one-argument command line is the wrong
 * carrier for a document, and 500 keeps a nudge on the fast path.
 */
export const SEND_INLINE_LIMIT = 500

/** What `new-session -P -F` / `new-window -P -F` print: the ids nothing is ever looked up by name for. */
export const SPAWN_FORMAT = '#{window_id} #{pane_id} #{pane_pid}'

/**
 * One line per pane, tab-separated, parsed by sys/tsv. `#{@fleet_id}` resolves through the pane's
 * window, so a window option reads back from a pane listing on 3.0 without pane options existing.
 */
export const LIST_FORMAT = ['#{session_name}', '#{window_id}', '#{pane_id}', '#{pane_pid}', '#{pane_dead}', '#{@fleet_id}', '#{@fleet_role}', '#{@fleet_state}'].join('\t')

/** `<plugin>/tmux.conf` — the fleet server's whole configuration, and the reason the operator's never applies. */
export const DEFAULT_CONFIG_FILE = fileURLToPath(new URL('../../tmux.conf', import.meta.url))

// ---- the viewer: how a detached tmux window reaches a screen -------------------------------------
//
// tmux is a MULTIPLEXER, not a terminal: `new-window -d` creates a window nothing is looking at. On
// Windows the backend opens a real tab per session and the operator watches the fleet work; on macOS
// the same fleet ran entirely invisibly, and `terminal.layout`'s documented "one tab/window per
// session" was true of one platform only. The viewer closes that gap WITHOUT touching the session
// model: the tmux window stays the session (addressable, killable, capturable exactly as before) and
// a GUI terminal is attached to it in a GROUPED session, so what the operator closes is a view and
// never the work.

/** Session names tmux will take: it splits targets on ":" and ".", so neither can survive here. */
export function viewerSessionName(label) {
  return `view-${String(label).replace(/[^A-Za-z0-9_-]/g, '-')}`
}

/** PURE. One token, safe inside an AppleScript double-quoted literal. */
export function osaQuote(token) {
  return `"${String(token).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * PURE. Which viewer to open. `auto` is the only value that reads the machine.
 *
 * ⛔ `none` under CI and over a plain SSH login. Opening a GUI window on a headless runner either
 * fails per session — turning a working fleet into a wall of red — or, worse, blocks on an
 * osascript that has no window server to talk to.
 */
export function viewerKind({ configured = 'auto', platform = process.platform, env = process.env } = {}) {
  if (configured && configured !== 'auto') return configured
  if (platform !== 'darwin') return 'none'
  if (env.CI) return 'none'
  if (env.SSH_CONNECTION && !env.TERM_PROGRAM) return 'none'
  return env.TERM_PROGRAM === 'iTerm.app' ? 'iterm2' : 'terminal-app'
}

/**
 * PURE. The /bin/sh script a GUI terminal runs to show ONE session's window.
 *
 * `new-session -A -t` joins the fleet's session GROUP: the viewer shares the fleet's windows but
 * carries its own current-window, which is what lets two Terminal windows show two different
 * sessions off one server. `-A` makes a relaunch idempotent rather than piling up view sessions.
 *
 * ⛔ `unset TMUX` first. A viewer opened from inside a tmux pane would otherwise refuse with
 * "sessions should be nested with care" and the operator would see an error where a session should
 * be.
 */
export function viewerScriptText({ tmuxBin = 'tmux', socket, configFile, session, windowId, label }) {
  const argv = [
    tmuxBin, '-L', socket, '-f', configFile,
    'new-session', '-A', '-s', viewerSessionName(label), '-t', `=${session}`,
  ].map(shQuote).join(' ')
  return [
    '#!/bin/sh',
    '# Generated by claude-fleet: a VIEW onto one fleet session. Closing this window closes the view,',
    '# never the session — the agent keeps working on the fleet server.',
    'unset TMUX',
    `exec ${argv} \\; select-window -t ${shQuote(windowId)}`,
    '',
  ].join('\n')
}

/** PURE. The osascript argv that opens `script` in a new window of the chosen terminal. */
export function viewerOpenArgs(kind, script) {
  if (kind === 'iterm2') {
    return ['-e', `tell application "iTerm" to create window with default profile command ${osaQuote(script)}`]
  }
  return [
    '-e', 'tell application "Terminal" to activate',
    '-e', `tell application "Terminal" to do script ${osaQuote(script)}`,
  ]
}

// A session label becomes a window option VALUE on the tmux command line, and tmux's argv parser
// treats an argument ending in `;` as a command separator — the same rule that shapes send() below.
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// `-L` names a socket FILE under tmux's own temp dir; `-t <session>` is split on `:` and `.`, so a
// session name carrying either is unaddressable by every command that follows.
const SOCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
// env(1) reads a leading `-` as one of its own options, so a name it can set is a plain identifier.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// ---- pure ----------------------------------------------------------------------------------------

/** `tmux 3.3a` / `tmux next-3.5` → {major, minor, raw}; null when no version can be read. */
export function parseTmuxVersion(text) {
  const s = String(text || '').trim()
  const m = /(\d+)\.(\d+)/.exec(s)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), raw: s.replace(/^tmux\s+/i, '') }
}

export function versionAtLeast(v, min = MIN_TMUX_VERSION) {
  if (!v) return false
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor)
}

/** The words a user can act on when tmux is missing or too old — contract: a probe reason is actionable. */
export function installHint(platform) {
  if (platform === 'darwin') return 'brew install tmux'
  return "apt install tmux (or your distribution's package manager)"
}

/** Quote one token for POSIX `sh -c`: single quotes, with an embedded quote spelled `'\''`. */
export function shQuote(token) {
  return `'${String(token).replace(/'/g, `'\\''`)}'`
}

/**
 * The pane's shell command. tmux runs it through `default-shell -c`, so every token is quoted as
 * data — a worktree path with a space or a ticket title with a quote in the argv must not become
 * syntax. The FLEET_* scalars (contract §4) ride the same line as `env NAME=value …`: `-e` needs
 * tmux 3.2 and the floor is 3.0, but the shell line works on both. `exec` replaces the shell with
 * env(1), and env(1) execs the shim in turn, so `pane_pid` IS the shim's pid and, because tmux
 * setsid()s every pane child, also the process group `kill()` signals: the pid, the pgid and the
 * shimPid the descriptor records are one number.
 */
export function paneCommand(command, args = [], env = []) {
  const assignments = env.map(({ name, value }) => {
    if (!ENV_NAME_RE.test(String(name))) throw new Error(`paneCommand: ${JSON.stringify(name)} is not a variable name env(1) can set`)
    return `${name}=${value}`
  })
  const words = assignments.length ? ['env', ...assignments, command, ...args] : [command, ...args]
  return ['exec', ...words.map(shQuote)].join(' ')
}

/**
 * tmux expands `-c` and `-n` as FORMATS (`new-window -c '#{pane_current_path}'` is the idiom), so a
 * worktree path or a ticket title carrying `#{…}` would be substituted and `#(…)` would RUN a shell
 * command with the operator's data. `##` is the format for one literal `#`.
 */
export function fmtEscape(value) {
  return String(value).replace(/#/g, '##')
}

/**
 * tmux's argv parser ends a command at any argument that ENDS in `;` — the rule LABEL_RE and
 * sendPlan() guard against — and reads a trailing `\;` as one literal `;`. Escaped that way even when
 * the value already ends in `\;`: the parser strips one `;`, then turns the `\` before it back into `;`.
 */
export function escapeTrailingSemicolon(value) {
  const s = String(value)
  return s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s
}

/** One free-text argv token (a title, a path) made safe against both rules above. */
const tmuxArg = value => escapeTrailingSemicolon(fmtEscape(value))

/**
 * The argv that creates a session's window. The first session on a fresh server is `new-session -d`
 * (which also starts the server); every later one is `new-window` into that session.
 *
 * `=<session>` forces an EXACT session match: without it `-t fleet` prefix-matches `fleet-old`, and a
 * window lands in whichever session tmux found first. `-d` on new-window keeps the operator's
 * current window where it is; without it every spawn in a wave yanks an attached client to the new
 * window. `-P -F` is the whole point — the created ids come back on stdout. Title and cwd are the
 * two free-text tokens and go through tmuxArg(); the label is validated instead (LABEL_RE), and the
 * pane command always ends in a quote.
 */
export function spawnArgs({ session, exists, title, cwd, command, args, env = [] }) {
  const cmd = paneCommand(command, args, env)
  return exists
    ? ['new-window', '-d', '-t', `=${session}:`, '-n', tmuxArg(title), '-c', tmuxArg(cwd), '-P', '-F', SPAWN_FORMAT, cmd]
    : ['new-session', '-d', '-s', session, '-n', tmuxArg(title), '-c', tmuxArg(cwd), '-P', '-F', SPAWN_FORMAT, cmd]
}

/**
 * Tag the window with its identity, in ONE tmux invocation (`;` separates commands in a sequence).
 * `remain-on-exit on` is set on the window itself rather than trusted to tmux.conf: a crashed agent
 * must leave its scrollback behind whatever config the server was started with, because that
 * scrollback is the only evidence of why it died.
 */
export function tagArgs(windowId, id, role) {
  return [
    'set-option', '-w', '-t', windowId, '@fleet_id', String(id), ';',
    'set-option', '-w', '-t', windowId, '@fleet_role', String(role), ';',
    'set-option', '-w', '-t', windowId, 'remain-on-exit', 'on',
  ]
}

/** `@3 %7 4242` → {windowId, paneId, panePid}; null when tmux printed something else. */
export function parseSpawnOutput(stdout) {
  const m = /^\s*(@\d+)\s+(%\d+)\s+(\d+)\s*$/.exec(String(stdout || ''))
  if (!m) return null
  return { windowId: m[1], paneId: m[2], panePid: Number(m[3]) }
}

/**
 * Rows of `list-panes -a -F LIST_FORMAT`, restricted to `session` when given. A pane with
 * `pane_dead` set is a session whose process has exited and whose window `remain-on-exit` kept —
 * reported here with `dead: true`, so `list()` can drop it while `kill()` can still close the window.
 */
export function parseListPanes(text, { session } = {}) {
  const rows = []
  for (const f of parseTsv(text)) {
    if (f.length < 8) continue
    const row = {
      sessionName: f[0],
      windowId: f[1],
      paneId: f[2],
      panePid: Number(f[3]),
      dead: f[4] === '1',
      fleetId: f[5],
      fleetRole: f[6],
      fleetState: f[7],
    }
    if (session !== undefined && row.sessionName !== session) continue
    rows.push(row)
  }
  return rows
}

/**
 * The live, fleet-tagged panes as handles, in spawn order.
 *
 * Only a window carrying `@fleet_id` is a session: a window the operator opened by hand inside the
 * fleet's tmux session has none and must not be listed, sent to or killed. Ordered by window id,
 * not window index — tmux hands a freed index out again, while `@N` only ever counts up.
 */
export function handlesFrom(rows, { socket, session }) {
  return rows
    .filter(r => !r.dead && r.fleetId)
    .sort((a, b) => Number(a.windowId.slice(1)) - Number(b.windowId.slice(1)))
    .map(r => handleOf(r, { socket, session }))
}

/**
 * `spawn` is the one key that names THIS spawn (contract §4: a backendRef identifies the spawn, not
 * the label) — the same triple resolveRef() requires to agree, joined, so a caller comparing handles
 * across backends reads one field rather than three.
 */
function handleOf(r, { socket, session }) {
  return Object.freeze({
    id: r.fleetId,
    role: r.fleetRole,
    backendRef: Object.freeze({ socket, session, windowId: r.windowId, paneId: r.paneId, panePid: r.panePid, spawn: `${r.windowId}/${r.paneId}/${r.panePid}` }),
    shimPid: r.panePid,
    pgid: r.panePid,
  })
}

/**
 * Which carrier a message takes. `send-keys -l` for a short single line; the paste buffer for
 * everything else. Each buffer reason is a way the fast path corrupts a message rather than a
 * limit it hits:
 *   long          a document is not a command-line argument (no argv limit applies to a file);
 *   multi-line    `-l` sends a newline as the Enter key, so the session acts on the first line and
 *                 receives the rest as a second, separate message;
 *   semicolon     tmux's argv parser turns a trailing `;` into a command separator, so a message
 *                 ending in one loses its last byte and splits into two commands;
 *   leading-dash  a message starting with `-` parses as a flag.
 * @returns {{mode: 'keys'|'buffer', reason: string|null}}
 */
export function sendPlan(text, limit = SEND_INLINE_LIMIT) {
  const s = String(text ?? '')
  if (s.length > limit) return { mode: 'buffer', reason: 'long' }
  if (/[\r\n]/.test(s)) return { mode: 'buffer', reason: 'multi-line' }
  if (s.includes(';')) return { mode: 'buffer', reason: 'semicolon' }
  if (s.startsWith('-')) return { mode: 'buffer', reason: 'leading-dash' }
  return { mode: 'keys', reason: null }
}

/**
 * The registry handle's backendRef, checked. STRICT, like the fake: a handle built from a label, or
 * one minted for another socket or session, throws rather than being answered "already gone" — that
 * answer would report a successful teardown of a session this backend never owned.
 * @returns {{socket, session, windowId, paneId, panePid}}
 */
export function resolveRef(handle, { socket, session }) {
  const ref = handle && typeof handle === 'object' ? handle.backendRef : null
  if (!ref || typeof ref !== 'object') {
    throw new TypeError('tmux backend: a session is addressed by its registry handle (backendRef), never by label — searching for a session is how list, send and kill came to resolve three different sets')
  }
  const windowId = String(ref.windowId ?? '')
  const paneId = String(ref.paneId ?? '')
  const panePid = Number(ref.panePid)
  if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId) || !Number.isInteger(panePid) || panePid < 1) {
    throw new TypeError(`tmux backend: malformed backendRef ${JSON.stringify(ref)} — a tmux handle carries {socket, session, windowId "@n", paneId "%n", panePid}`)
  }
  if (ref.socket !== socket || ref.session !== session) {
    throw new TypeError(`tmux backend: backendRef names session "${ref.session}" on socket "${ref.socket}", this backend drives "${session}" on "${socket}" — another fleet's handle is not a session that has ended`)
  }
  return { socket, session, windowId, paneId, panePid }
}

/**
 * How to bring the operator to the fleet. `switch-client` moves a client that is ALREADY on this
 * server; a client inside some other tmux (their own) cannot switch to ours and must attach — nested,
 * which tmux refuses while `$TMUX` is set, so that variable has to be removed (not blanked: tmux
 * checks for presence, and an empty value is present). `$TMUX` is `<socket path>,<pid>,<index>`.
 * @returns {{verb: 'attach-session'|'switch-client', unsetEnv: string[]}}
 */
export function attachPlan({ socket, tmuxEnv = null }) {
  if (!tmuxEnv) return { verb: 'attach-session', unsetEnv: [] }
  const socketPath = String(tmuxEnv).split(',')[0]
  if (path.basename(socketPath) === socket) return { verb: 'switch-client', unsetEnv: [] }
  return { verb: 'attach-session', unsetEnv: ['TMUX'] }
}

/**
 * "No server on this socket" — an EMPTY fleet, as opposed to a failed listing. The two must be told
 * apart because an empty answer to a broken tmux would let teardown report a clean machine. "lost
 * server" / "server exited unexpectedly" is the answer a client gets while the server is shutting
 * down (exit-empty, right after its last window closed) — the same empty fleet, caught mid-exit.
 */
export function isNoServer(stderr) {
  return /no server running|error connecting to|No such file or directory|lost server|server exited/i.test(String(stderr || ''))
}

/**
 * A RUNNING server that holds no sessions — an empty fleet, not a broken one.
 *
 * ⛔ `list-panes -a` resolves its target through the current session even with `-a`, so on a server
 * with no sessions at all it fails with "no current target" rather than printing nothing. That state
 * is reachable exactly because tmux.conf sets `exit-empty off` to keep the fleet's server alive
 * between a `fleet relaunch`'s kill and its respawn: the server is up, correct, and answering — it
 * simply has nothing to list yet. Read as a broken tmux it makes `list`, `isAlive` and `kill` throw
 * for the ordinary case of a fleet whose last session was just killed, and `fleet status` report a
 * failure where the honest answer is "no sessions".
 *
 * Kept separate from isNoServer(): "the server is gone" and "the server is empty" are different
 * facts, and only one of them means a spawn has to start a server.
 */
export function isNoSessions(stderr) {
  return /no current target|no current session|can't find session|no sessions/i.test(String(stderr || ''))
}

// ---- the backend ---------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.config      the resolved config; reads terminal.tmux.socket / terminal.tmux.session
 * @param {string} [o.platform]
 * @param {Function} [o.exec]    sys/exec.run — injected so every tmux argv is testable without tmux
 * @param {Function} [o.which]   sys/exec.which
 * @param {Function} [o.snapshot] () => Map<pid, ProcInfo>, for kill()
 * @param {Function} [o.killTree] sys/kill.killTree
 * @param {string} [o.configFile] the `-f` file; the integration test passes /dev/null
 * @param {string} [o.tmpDir]    where paste files are written (mode 0600, removed after the paste).
 *                               Default `<paths.stateDir>/tmp` — contract §4 keeps the fleet's scratch
 *                               under the state dir, never os.tmpdir(), and a paste file holds ticket
 *                               text; os.tmpdir() only when the config carries no stateDir.
 * @param {object} [o.env]       the environment `$TMUX` is read from
 */
export function createTmuxBackend({
  config,
  platform = process.platform,
  exec = run,
  which = whichOnPath,
  snapshot = null,
  killTree = killTreeReal,
  configFile = DEFAULT_CONFIG_FILE,
  tmpDir = null,
  env = process.env,
  graceMs = 2000,
  timeoutMs = 15_000,
} = {}) {
  const socket = config?.terminal?.tmux?.socket
  const session = config?.terminal?.tmux?.session
  if (typeof socket !== 'string' || !SOCKET_RE.test(socket)) {
    throw new Error(`terminal.tmux.socket must be a plain socket name ([A-Za-z0-9._-]), got ${JSON.stringify(socket)}`)
  }
  if (typeof session !== 'string' || !SESSION_RE.test(session)) {
    throw new Error(`terminal.tmux.session must be a plain name ([A-Za-z0-9_-]; tmux splits targets on ":" and "."), got ${JSON.stringify(session)}`)
  }
  const ids = { socket, session }
  const base = ['-L', socket, '-f', configFile]
  const takeSnap = snapshot || (() => takeSnapshot({ platform }))
  const stateDir = config?.paths?.stateDir
  const pasteDir = tmpDir || (typeof stateDir === 'string' && stateDir ? path.join(stateDir, 'tmp') : os.tmpdir())
  let pasteCounter = 0

  const tmux = args => exec('tmux', [...base, ...args], { timeoutMs })
  const failure = r => (r.stderr || r.stdout || '').trim() || (r.timedOut ? 'timed out' : `exit ${r.code}`)

  /** Every pane in the fleet's session, dead ones included; [] when there is no server AND when the
   *  server holds no sessions. Throws only on a tmux that is actually broken. */
  function rows() {
    const r = tmux(['list-panes', '-a', '-F', LIST_FORMAT])
    if (r.ok) return parseListPanes(r.stdout, { session })
    if (isNoServer(r.stderr) || isNoSessions(r.stderr)) return []
    throw new Error(`tmux list-panes failed: ${failure(r)}`)
  }

  /** The row a ref still addresses — window, pane AND pid must agree — or null. */
  function findPane(ref, all = rows()) {
    return all.find(r => r.windowId === ref.windowId && r.paneId === ref.paneId && r.panePid === ref.panePid) || null
  }

  const live = row => !!row && !row.dead

  /**
   * Put one session's window on a screen, and report what happened.
   *
   * ⛔ NEVER THROWS, and never fails a spawn. A machine with no window server, an osascript refused
   * by Automation permissions, a read-only state dir — none of those mean the session is broken. The
   * agent is already running in the tmux window; the viewer is how a human watches it. A failure
   * here returns a reason the launcher prints, so "I cannot see my fleet" is answered by one line
   * instead of an investigation.
   */
  function openViewer(windowId, label) {
    const kind = viewerKind({ configured: config?.terminal?.tmux?.viewer, platform, env })
    if (kind === 'none') return { opened: false, kind: 'none', reason: null }
    try {
      const script = path.join(pasteDir, `fleet-${viewerSessionName(label)}.sh`)
      fs.mkdirSync(pasteDir, { recursive: true })
      fs.writeFileSync(script, viewerScriptText({
        tmuxBin: which('tmux') || 'tmux',
        socket,
        configFile,
        session,
        windowId,
        label,
      }), { mode: 0o700 })
      const r = exec('osascript', viewerOpenArgs(kind, script), { timeoutMs })
      if (!r.ok) return { opened: false, kind, reason: failure(r) }
      return { opened: true, kind, script }
    } catch (e) {
      return { opened: false, kind, reason: e && e.message ? e.message : String(e) }
    }
  }

  const backend = {
    name: 'tmux',

    // ---- the interface -------------------------------------------------------------------------

    probe() {
      // Only Windows lacks process groups; any other platform with a tmux on PATH (the BSDs included) goes on to the version check.
      if (platform === 'win32') {
        return { available: false, name: 'tmux', reason: 'the tmux backend tears a session down by signalling its POSIX process group, which win32 does not have — on Windows use terminal.backend "windows-terminal"' }
      }
      if (!which('tmux')) {
        return { available: false, name: 'tmux', reason: `tmux is not installed: ${installHint(platform)}` }
      }
      const r = exec('tmux', ['-V'], { timeoutMs })
      if (!r.ok) return { available: false, name: 'tmux', reason: `tmux -V failed: ${failure(r)}` }
      const v = parseTmuxVersion(r.stdout)
      if (!v) return { available: false, name: 'tmux', reason: `could not read a version from "${r.stdout.trim()}": claude-fleet needs a tmux release 3.0 or newer (${installHint(platform)})` }
      if (!versionAtLeast(v)) {
        return { available: false, name: 'tmux', reason: `tmux ${v.raw} is older than 3.0, which claude-fleet needs for new-window -P -F and window user options: ${installHint(platform)}` }
      }
      return { available: true, name: 'tmux', reason: null }
    },

    capabilities() {
      return TMUX_CAPABILITIES
    },

    /**
     * `spec.env` reaches the agent through the pane's shell line (paneCommand), never through `-e`:
     * that flag needs tmux 3.2 and the floor is 3.0. The env is the contract §4 scalars a session
     * finds its descriptor, flags dir and role by, so a pane started without them reads as a session
     * that lost its identity.
     */
    spawn(spec) {
      assertSpawnSpec(spec)
      const id = String(spec.id)
      if (!LABEL_RE.test(id)) throw new Error(`spawn: session id ${JSON.stringify(id)} cannot be a tmux option value ([A-Za-z0-9._-], not starting with ".")`)
      // Two agents in one worktree collide on the git index; a relaunch kills first, never spawns beside.
      if (backend.list().some(h => h.id === id)) throw new Error(`spawn: session "${id}" is already running`)

      // ⛔ START THE SERVER BEFORE THE SESSION, ALWAYS — and never let `new-session` be what starts it.
      // A tmux server keeps the argv it was launched with for its whole life, and `new-session -d ...
      // <pane command>` starts the server, so the server would carry the first session's
      // `--fleet-session=<label>` marker for ever. Every machine-wide marker scan then finds TWO
      // processes for that label: the agent, and a tmux server that outlives it. core/fleet.reconcile
      // would report a dead session as alive after a crash, and bind its `shimPid` to the SERVER — so
      // the next `fleet kill` on that label walks the tree from the tmux server and takes the whole
      // fleet with it. That is the wrong-root kill this design exists to prevent, arriving through the
      // one door left open. `start-server` is a no-op against a server that is already up.
      const started = tmux(['start-server'])
      if (!started.ok) throw new Error(`tmux start-server failed for session "${id}": ${failure(started)}`)

      const exists = tmux(['has-session', '-t', `=${session}`]).ok
      const args = spawnArgs({ session, exists, title: spec.title ?? `session ${id}`, cwd: spec.cwd, command: spec.command, args: spec.args, env: spec.env })
      const r = tmux(args)
      if (!r.ok) throw new Error(`tmux ${args[0]} failed for session "${id}": ${failure(r)}`)
      const made = parseSpawnOutput(r.stdout)
      if (!made) throw new Error(`tmux ${args[0]} printed ${JSON.stringify(r.stdout.trim())}, not "${SPAWN_FORMAT}" — the created window cannot be addressed`)

      const tag = tmux(tagArgs(made.windowId, id, spec.role))
      if (!tag.ok) {
        // A window that exists but carries no identity is a session nothing can list, send to or
        // kill — the half-created session a failed spawn must not leave behind. Close it, then throw.
        tmux(['kill-window', '-t', made.windowId])
        throw new Error(`could not tag tmux window ${made.windowId} for session "${id}" (${failure(tag)}); the window was closed again so nothing half-created remains`)
      }
      // ⛔ PUT THE SESSION ON A SCREEN. tmux creates every window DETACHED, so without this the whole
      // fleet runs headless: `fleet up` returns having opened nothing the operator can see, and a
      // session stopped on a trust dialog looks identical to one working. The Windows backend opens a
      // real tab per session, and `terminal.layout` already promises "one tab/window per session" —
      // this is that promise kept on macOS. A viewer that cannot open is reported, never silent, and
      // never fatal: a headless fleet still works, it just cannot be watched.
      const viewed = openViewer(made.windowId, id)
      return handleOf({ ...made, fleetId: id, fleetRole: spec.role, viewer: viewed }, ids)
    },

    /**
     * The pane's visible text, or null when the pane is gone. The launcher reads this to tell a
     * session sitting at its input line from one stopped on a dialog — a distinction no tmux
     * send-keys result can make, because tmux reports delivery of the KEYSTROKE, never of the intent.
     *
     * Optional on the interface: a backend without it makes the launcher skip the readiness gate
     * rather than fail, so this stays a tmux/Windows-Terminal asymmetry and not a hard dependency.
     */
    readText(handle, { lines = 120 } = {}) {
      const ref = resolveRef(handle, ids)
      if (!live(findPane(ref))) return null
      const r = tmux(['capture-pane', '-p', '-t', ref.paneId, '-S', `-${Math.max(0, lines)}`])
      return r.ok ? r.stdout : null
    },

    /** Authoritative: what tmux has right now, from one list-panes call. */
    list() {
      return handlesFrom(rows(), ids)
    },

    isAlive(handle) {
      return live(findPane(resolveRef(handle, ids)))
    },

    /**
     * Delivery is whole or it is reported: a gone session, a tmux call that failed, a listing that
     * failed, or a paste file that could not be written comes back per target rather than thrown,
     * because one dead label must not abort the loop over the others. A forged handle still throws
     * (resolveRef): that is the caller's bug, not this target's.
     */
    /**
     * Press Enter, and nothing else — the retry for text that reached the input line but was never
     * submitted (see up.mjs deliverSeedPrompt). Kept separate from `send(handle, '')` because an
     * empty send is indistinguishable from a delivered message in the result shape, and this one
     * must be countable as what it is: a resubmit.
     */
    submit(handle) {
      const ref = resolveRef(handle, ids)
      if (!live(findPane(ref))) return { ok: false, reason: 'session-gone' }
      const r = tmux(['send-keys', '-t', ref.paneId, 'Enter'])
      return r.ok ? { ok: true, reason: null } : { ok: false, reason: failure(r) }
    },

    send(handle, text) {
      const ref = resolveRef(handle, ids)
      const s = String(text ?? '')
      const gone = (reason, delivered = 0) => ({ ok: false, requested: s.length, delivered, truncated: false, reason })
      let row
      try {
        row = findPane(ref)
      } catch (e) {
        return gone(e.message)
      }
      if (!live(row)) return gone('session-gone')

      const plan = sendPlan(s)
      if (plan.mode === 'keys') {
        if (s.length) {
          const r = tmux(['send-keys', '-t', ref.paneId, '-l', s])
          if (!r.ok) return gone(`send-keys: ${failure(r)}`)
        }
      } else {
        // Bytes travel by FILE and paste buffer: no argv, no console buffer, no truncation class.
        // `-p` brackets the paste when the application asked for bracketed paste; `-d` drops the
        // buffer once pasted; a NAMED buffer keeps two concurrent sends from pasting each other's text.
        pasteCounter += 1
        const name = `fleet-${ref.paneId.slice(1)}-${process.pid}-${pasteCounter}`
        const file = path.join(pasteDir, `fleet-paste-${process.pid}-${pasteCounter}.txt`)
        try {
          fs.mkdirSync(pasteDir, { recursive: true })
          fs.writeFileSync(file, s, { mode: 0o600 })
        } catch (e) {
          return gone(`paste-file: ${e.message}`)
        }
        try {
          const loaded = tmux(['load-buffer', '-b', name, file])
          if (!loaded.ok) return gone(`load-buffer: ${failure(loaded)}`)
          const pasted = tmux(['paste-buffer', '-p', '-d', '-b', name, '-t', ref.paneId])
          if (!pasted.ok) {
            // `-d` rode on the call that failed: drop the buffer here, or the ticket text it holds
            // stays in the server for as long as the fleet runs.
            tmux(['delete-buffer', '-b', name])
            return gone(`paste-buffer: ${failure(pasted)}`)
          }
        } finally {
          fs.rmSync(file, { force: true })
        }
      }
      const enter = tmux(['send-keys', '-t', ref.paneId, 'Enter'])
      // The text landed and Enter did not: it sits in the input line unsent, which is not delivery.
      if (!enter.ok) return gone(`enter: ${failure(enter)}`, s.length)
      return fullDelivery(s)
    },

    /** `@fleet_state` on the window; tmux.conf renders it in the status bar and list() reads it back. */
    setStatus(handle, status) {
      if (!STATUS.includes(status)) throw new Error(`setStatus: unknown status "${status}" (${STATUS.join('|')})`)
      const ref = resolveRef(handle, ids)
      if (!live(findPane(ref))) return false
      return tmux(['set-option', '-w', '-t', ref.windowId, '@fleet_state', status]).ok
    },

    /**
     * ⛔ Process group FIRST, window SECOND. `kill-window` SIGHUPs the pane's process and reparents
     * its grandchildren (a dev server, a browser) to init — the exact orphan class the supervisor
     * hunts. So the group is signalled through sys/kill (SIGTERM, grace, SIGKILL, deepest-first,
     * self and ancestors protected, re-snapshot) and only a tree that is verifiably gone has its
     * window closed. Survivors, or a caller that is itself inside the tree, leave the window in place
     * and are reported: closing it would turn a reported failure into a silent orphan.
     * Idempotent: a session already gone answers alreadyGone, and a dead pane (remain-on-exit) is
     * closed without a kill.
     */
    kill(handle) {
      const ref = resolveRef(handle, ids)
      const row = findPane(ref)
      if (!row) return { ok: true, killed: [], alreadyGone: true, survivors: [] }

      let killed = []
      if (!row.dead) {
        // pane_pid leads the group (tmux setsid()s every pane child), whatever the descriptor recorded.
        const r = killTree(takeSnap(), row.panePid, { pgid: row.panePid, resnapshot: takeSnap, graceMs, platform })
        killed = r.killed
        if (r.skippedProtected.length) {
          return { ok: false, killed, alreadyGone: false, survivors: r.skippedProtected, reason: 'the caller is inside this session\'s own process tree; kill it from another window' }
        }
        if (r.survivors.length) return { ok: false, killed, alreadyGone: false, survivors: r.survivors }
      }
      const closed = tmux(['kill-window', '-t', ref.windowId])
      const gone = findPane(ref) === null
      const result = { ok: gone, killed, alreadyGone: row.dead, survivors: [] }
      if (!gone) result.reason = `tmux kill-window: ${failure(closed)}`
      return result
    },

    focus(handle) {
      const ref = resolveRef(handle, ids)
      if (!live(findPane(ref))) return false
      return tmux(['select-window', '-t', ref.windowId]).ok
    },

    /**
     * Sessions are already windows, so `windows` places every live one with no tmux call. `pixel-grid`
     * and `tiled-panes` are announced as unavailable and place nothing: on tmux a session IS a window,
     * and `select-layout tiled` would only arrange the panes inside one of them, so reporting it as
     * "placed" would read as a grid that never appeared — the fleet is read from the status bar and
     * `fleet status`, not by position. A handle whose session has ended is not placed and is named,
     * so a caller retiling with a stale list is distinguishable from one that recomputed the live set.
     */
    layout(handles, mode = 'windows') {
      const given = (handles || []).filter(Boolean)
      const all = rows()
      const alive = []
      const stale = []
      for (const h of given) {
        const ref = resolveRef(h, ids)
        if (live(findPane(ref, all))) alive.push(ref)
        else stale.push(h.id)
      }
      let placed = 0
      let notice = null
      if (mode === 'pixel-grid') {
        notice = degradationNotice(TMUX_CAPABILITIES, 'pixelLayout', 'pixel-grid placement')
      } else if (mode === 'tiled-panes') {
        notice = `${degradationNotice(TMUX_CAPABILITIES, 'gridLayout', 'tiled-panes')}: every session is its own window, and tiling only arranges the panes inside one — read the fleet from the status bar, not by position`
      } else if (mode === 'windows') {
        placed = alive.length
      } else {
        notice = `layout: unknown mode "${mode}"`
      }
      const staleNotice = stale.length ? `layout: ${stale.length} of ${given.length} handles are no longer live (${stale.join(', ')})` : null
      return { mode, placed, notice: [notice, staleNotice].filter(Boolean).join('; ') || null, stale, requested: given.length }
    },

    // ---- beyond the interface: what the CLI needs from a detached server ---------------------------

    /** The state list() reads back for a live session, or null. */
    statusOf(handle) {
      const row = findPane(resolveRef(handle, ids))
      return live(row) && row.fleetState ? row.fleetState : null
    },

    /** Does the fleet's tmux session exist on the dedicated socket? (Exact match, never a prefix.) */
    sessionExists() {
      return tmux(['has-session', '-t', `=${session}`]).ok
    },

    /**
     * The argv the CLI runs in the FOREGROUND for `fleet attach` — a backend cannot attach on the
     * caller's behalf, because attaching takes over the terminal. `unsetEnv` names the variables the
     * CLI must delete from the child's environment first.
     */
    attachCommand({ tmuxEnv = env.TMUX } = {}) {
      const plan = attachPlan({ socket, tmuxEnv })
      return { command: 'tmux', args: [...base, plan.verb, '-t', `=${session}`], unsetEnv: plan.unsetEnv }
    },

    /**
     * Stop the dedicated server — the unambiguous last step of `fleet down`, and only safe because
     * the socket is the fleet's own. Sessions are killed by the caller first (see kill(): a server
     * exit SIGHUPs every pane and reparents grandchildren); this closes what is left.
     */
    killServer() {
      const r = tmux(['kill-server'])
      if (r.ok) return { ok: true, hadServer: true }
      if (isNoServer(r.stderr)) return { ok: true, hadServer: false }
      return { ok: false, hadServer: true, reason: failure(r) }
    },
  }

  return backend
}
