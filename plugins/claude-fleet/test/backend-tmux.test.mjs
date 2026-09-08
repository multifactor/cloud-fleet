import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  createTmuxBackend, TMUX_CAPABILITIES, MIN_TMUX_VERSION, SEND_INLINE_LIMIT, LIST_FORMAT, SPAWN_FORMAT,
  DEFAULT_CONFIG_FILE, parseTmuxVersion, versionAtLeast, installHint, shQuote, paneCommand, fmtEscape,
  escapeTrailingSemicolon, spawnArgs, tagArgs, parseSpawnOutput, parseListPanes, handlesFrom, sendPlan,
  resolveRef, attachPlan, isNoServer, isNoSessions,
} from '../src/backends/tmux.mjs'
import { validateBackend, validateResultShape, CAPABILITY_NAMES, STATUS } from '../src/backends/types.mjs'
import { snapshotFrom } from '../src/sys/proc.mjs'
import { run, which } from '../src/sys/exec.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { defaultsFor } from '../src/config/defaults.mjs'

const CONFIG = defaultsFor()
const IDS = { socket: CONFIG.terminal.tmux.socket, session: CONFIG.terminal.tmux.session }

// Every scratch directory this file mints, removed together at the end — one per backend plus the
// explicit ones in the send tests, which otherwise pile up in the OS temp dir run after run.
const TMP_DIRS = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tmux-'))
  TMP_DIRS.push(dir)
  return dir
}
after(() => {
  for (const dir of TMP_DIRS) fs.rmSync(dir, { recursive: true, force: true })
})

/** A spawn spec exactly as the launcher builds one — same shape the fake's test feeds its backend. */
const spec = (label, over = {}) => {
  const { role = 'working', session = {}, ...rest } = over
  return {
    id: String(label),
    role,
    title: `session ${label}`,
    cwd: `/w/app session-${label}`, // a space, because that is what breaks shell quoting
    command: 'node',
    args: ['shim.mjs', `--fleet-session=${label}`, `/state/my fleet/sessions/${label}.json`],
    env: buildSessionEnv(CONFIG, { label: String(label), role, file: `/s/${label}.json`, stateFile: `/s/${label}.json`, stateDir: '/s', ...session }),
    ...rest,
  }
}

// ---- a scripted tmux server ----------------------------------------------------------------------
//
// A small model of the object tree the backend drives — sessions, windows, panes, window options,
// paste buffers — behind an `exec` that parses the SAME argv the real tmux would receive and renders
// the SAME `-F` formats. Canned stdout strings would let an argv drift (a missing `-t`, a wrong id)
// pass unnoticed; here a wrong argv fails the way it would on a real server.
function fakeTmux({ version = 'tmux 3.3a', socket = IDS.socket } = {}) {
  const st = { running: false, lostServer: false, sessions: new Map(), nextWindow: 0, nextPane: 0, nextPid: 4000, calls: [], seq: [], buffers: new Map(), typed: new Map(), selected: null, fail: new Set() }

  // tmux expands `-c` and `-n` as FORMATS: `##` is one literal `#`, `#{…}` a variable, `#(…)` a shell
  // command it RUNS. Rendered visibly here so a value that reached tmux unescaped shows up as text.
  const expand = s => String(s).replace(/##|#\{[^}]*\}|#\([^)]*\)/g, m => (m === '##' ? '#' : m.startsWith('#{') ? `<expanded ${m.slice(2, -1)}>` : `<ran ${m.slice(2, -1)}>`))

  const panes = () => {
    const out = []
    for (const s of st.sessions.values()) for (const w of s.windows) out.push({ s, w, p: w.pane })
    return out
  }
  const byWindow = id => panes().find(x => x.w.id === id) || null
  const byPane = id => panes().find(x => x.p.id === id) || null
  const render = (fmt, x) => fmt.replace(/#\{(@?[a-z_]+)\}/g, (m, k) => {
    if (k === 'session_name') return x.s.name
    if (k === 'window_id') return x.w.id
    if (k === 'pane_id') return x.p.id
    if (k === 'pane_pid') return String(x.p.pid)
    if (k === 'pane_dead') return x.p.dead ? '1' : '0'
    if (k.startsWith('@')) return x.w.options[k] ?? ''
    return ''
  })
  const ok = stdout => ({ ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false })
  const fail = stderr => ({ ok: false, code: 1, signal: null, stdout: '', stderr: `${stderr}\n`, timedOut: false })
  const target = t => {
    const s = String(t)
    if (s.startsWith('=')) {
      const name = s.slice(1).replace(/:$/, '')
      return { session: st.sessions.get(name) || null, exact: true }
    }
    if (s.startsWith('@')) return { window: byWindow(s) }
    if (s.startsWith('%')) return { pane: byPane(s) }
    // an unprefixed name is a PREFIX match — the very ambiguity `=` exists to remove
    const hit = [...st.sessions.keys()].find(k => k.startsWith(s))
    return { session: hit ? st.sessions.get(hit) : null, exact: false }
  }
  const opts = (args, taking) => {
    const o = {}
    const rest = []
    for (let i = 0; i < args.length; i++) {
      if (taking.includes(args[i])) o[args[i]] = args[++i]
      else if (/^-[a-zA-Z]$/.test(args[i])) o[args[i]] = true
      else rest.push(args[i])
    }
    return { o, rest }
  }
  const addWindow = (s, name, cwd, cmd) => {
    const w = { id: `@${st.nextWindow++}`, name, cwd, cmd, options: {}, pane: { id: `%${st.nextPane++}`, pid: st.nextPid++, dead: false } }
    s.windows.push(w)
    return { s, w, p: w.pane }
  }

  function dispatch(args) {
    const verb = args[0]
    st.seq.push(`tmux ${verb}`)
    if (st.fail.has(verb)) return fail(`injected failure for ${verb}`)
    if (verb === '-V') return ok(`${version}\n`)
    // exit-empty: the first client to connect while the server is still shutting down after its last
    // window closed is answered "lost server", not "no server running"
    if (st.lostServer) {
      st.lostServer = false
      return fail('lost server')
    }
    if (!st.running && verb !== 'new-session' && verb !== 'start-server') return fail(`no server running on /tmp/tmux-1000/${socket}`)
    const { o, rest } = opts(args.slice(1), ['-t', '-s', '-n', '-c', '-F', '-b'])
    switch (verb) {
      case 'has-session': {
        const t = target(o['-t'])
        return t.session ? ok('') : fail(`can't find session: ${o['-t']}`)
      }
      // Starts the server and creates nothing. The backend calls it before every spawn so that
      // `new-session` is never what starts the server — a server forked from a `new-session` client
      // keeps that client's argv, marker and all, for as long as it lives.
      case 'start-server': {
        st.running = true
        return ok('')
      }
      case 'new-session': {
        if (st.sessions.has(o['-s'])) return fail(`duplicate session: ${o['-s']}`)
        const s = { name: o['-s'], windows: [] }
        st.sessions.set(s.name, s)
        st.running = true
        const x = addWindow(s, expand(o['-n']), expand(o['-c']), rest[0])
        return ok(o['-P'] ? render(o['-F'], x) + '\n' : '')
      }
      case 'new-window': {
        const t = target(o['-t'])
        if (!t.session) return fail(`can't find session: ${o['-t']}`)
        const x = addWindow(t.session, expand(o['-n']), expand(o['-c']), rest[0])
        return ok(o['-P'] ? render(o['-F'], x) + '\n' : '')
      }
      case 'set-option': {
        const w = args.includes('-w') ? target(o['-t']).window : null
        if (!w) return fail(`can't find window: ${o['-t']}`)
        w.w.options[rest[0]] = rest[1]
        return ok('')
      }
      case 'list-panes':
        // ⛔ Real tmux resolves list-panes' target through the CURRENT SESSION even with `-a`, so a
        // running server holding no sessions fails with "no current target" instead of printing
        // nothing. `exit-empty off` keeps the fleet's server alive between a relaunch's kill and its
        // respawn, which makes that state ordinary — so the fake has to produce it, or the backend's
        // handling of it is untested and `list` throws on an empty fleet.
        if (!st.sessions.size) return fail('no current target')
        return ok(panes().map(x => render(o['-F'], x)).join('\n') + '\n')
      case 'send-keys': {
        const x = target(o['-t']).pane
        if (!x || x.p.dead) return fail(`can't find pane: ${o['-t']}`)
        const typed = st.typed.get(x.p.id) || []
        typed.push(o['-l'] ? rest[0] : rest[0] === 'Enter' ? '\r' : rest.join(' '))
        st.typed.set(x.p.id, typed)
        return ok('')
      }
      case 'load-buffer':
        st.buffers.set(o['-b'], fs.readFileSync(rest[0], 'utf8'))
        return ok('')
      case 'paste-buffer': {
        const x = target(o['-t']).pane
        if (!x) return fail(`can't find pane: ${o['-t']}`)
        if (!st.buffers.has(o['-b'])) return fail(`no buffer ${o['-b']}`)
        const typed = st.typed.get(x.p.id) || []
        typed.push(st.buffers.get(o['-b']))
        st.typed.set(x.p.id, typed)
        if (o['-d']) st.buffers.delete(o['-b'])
        return ok('')
      }
      case 'delete-buffer':
        if (!st.buffers.has(o['-b'])) return fail(`no buffer ${o['-b']}`)
        st.buffers.delete(o['-b'])
        return ok('')
      case 'kill-window': {
        const x = target(o['-t']).window
        if (!x) return fail(`can't find window: ${o['-t']}`)
        x.s.windows = x.s.windows.filter(w => w !== x.w)
        if (!x.s.windows.length) st.sessions.delete(x.s.name)
        if (!st.sessions.size) {
          // exit-empty: the server goes with its last session, and the next client catches it mid-exit
          st.running = false
          st.lostServer = true
        }
        return ok('')
      }
      case 'select-window': {
        const x = target(o['-t']).window
        if (!x) return fail(`can't find window: ${o['-t']}`)
        st.selected = x.w.id
        return ok('')
      }
      case 'kill-server':
        st.sessions.clear()
        st.running = false
        return ok('')
      default:
        return fail(`unknown command: ${verb}`)
    }
  }

  const exec = (command, args) => {
    assert.equal(command, 'tmux', 'every call is an explicit tmux argv')
    st.calls.push(args.slice())
    if (args[0] === '-V') return dispatch(['-V'])
    assert.equal(args[0], '-L', 'every call names the dedicated socket')
    assert.equal(args[1], socket)
    assert.equal(args[2], '-f', 'every call names the dedicated config')
    // tmux's argv parser: an argument ENDING in `;` closes the command (the `;` is dropped, so a bare
    // `;` token is a separator and `title;` is `title` plus a second command); a trailing `\;` is one
    // literal `;`. Modelled exactly, because a title or a path that ends in `;` is where this bites.
    const groups = [[]]
    for (const a of args.slice(4)) {
      const cur = groups[groups.length - 1]
      if (!a.endsWith(';')) cur.push(a)
      else if (a.endsWith('\\;')) cur.push(`${a.slice(0, -2)};`)
      else {
        if (a.length > 1) cur.push(a.slice(0, -1))
        groups.push([])
      }
    }
    let last = ok('')
    for (const g of groups) {
      last = dispatch(g)
      if (!last.ok) return last
    }
    return last
  }

  return {
    exec,
    st,
    verbs: () => st.calls.map(a => (a[0] === '-V' ? '-V' : a[4])),
    typed: paneId => (st.typed.get(paneId) || []).slice(),
    windowOptions: windowId => ({ ...(byWindow(windowId)?.w.options || {}) }),
    window: windowId => byWindow(windowId)?.w || null,
    die: paneId => { byPane(paneId).p.dead = true },
    dieByPid: pid => { panes().find(x => x.p.pid === pid).p.dead = true },
    /** The process table sys/kill reasons over: every live pane process. */
    snapshot: () => snapshotFrom([
      { pid: 1, ppid: 0, name: 'init', cmd: 'init' },
      ...panes().filter(x => !x.p.dead).map(x => ({ pid: x.p.pid, ppid: 1, pgid: x.p.pid, name: 'node', cmd: x.w.cmd })),
    ]),
    /** `fleet down` then a new fleet: the server restarts and every id counter restarts with it. */
    restart: () => { st.sessions.clear(); st.running = false; st.nextWindow = 0; st.nextPane = 0 },
  }
}

/** A backend over the scripted server, with kill's process work injected and logged into `seq`. */
function backendOver(fake, { platform = 'linux', killResult = null, config = CONFIG, ...rest } = {}) {
  const killTree = (snap, root, o) => {
    fake.st.seq.push('killTree')
    assert.ok(snap instanceof Map, 'killTree receives the snapshot it must plan from')
    assert.equal(o.pgid, root, 'the pane pid is the group signalled first')
    assert.equal(typeof o.resnapshot, 'function', 'survivors are found by re-snapshotting')
    if (killResult) return killResult(snap, root, o)
    fake.dieByPid(root) // the group is gone: tmux marks the pane dead
    return { planned: [root], killed: [root], survivors: [], skippedProtected: [] }
  }
  return createTmuxBackend({
    config,
    platform,
    exec: fake.exec,
    which: () => '/usr/bin/tmux',
    snapshot: () => { fake.st.seq.push('snapshot'); return fake.snapshot() },
    killTree,
    configFile: '/plugin/tmux.conf',
    tmpDir: tmp(),
    env: {},
    ...rest,
  })
}

// ---- pure: versions and argv -----------------------------------------------------------------------

test('the version probe reads release, patch-letter and next- builds, and refuses what it cannot read', () => {
  // `new-window -P -F` and window user options are 3.0 features; guessing a version is how the flags
  // fail silently in the middle of a fan-out, so an unreadable version is unavailable, not assumed.
  assert.deepEqual(parseTmuxVersion('tmux 3.3a\n'), { major: 3, minor: 3, raw: '3.3a' })
  assert.deepEqual(parseTmuxVersion('tmux 3.0'), { major: 3, minor: 0, raw: '3.0' })
  assert.deepEqual(parseTmuxVersion('tmux next-3.5'), { major: 3, minor: 5, raw: 'next-3.5' })
  assert.deepEqual(parseTmuxVersion('tmux 2.9a'), { major: 2, minor: 9, raw: '2.9a' })
  assert.equal(parseTmuxVersion('tmux master'), null)
  assert.equal(parseTmuxVersion(''), null)
  assert.equal(versionAtLeast(parseTmuxVersion('tmux 3.0')), true)
  assert.equal(versionAtLeast(parseTmuxVersion('tmux 10.1')), true)
  assert.equal(versionAtLeast(parseTmuxVersion('tmux 2.9a')), false)
  assert.equal(versionAtLeast(null), false)
  assert.deepEqual(MIN_TMUX_VERSION, { major: 3, minor: 0 })
  assert.match(installHint('darwin'), /brew install tmux/)
  assert.match(installHint('linux'), /apt install tmux/)
})

test('the pane command quotes every token as data, carries the env as `exec env NAME=value …`, and execs the shim so pane_pid is the shim', () => {
  // tmux runs the pane command through `sh -c`: a worktree path with a space, or a quote in an
  // argument, must reach the shim as ONE argv token. The FLEET_* scalars ride the same line — `-e`
  // needs tmux 3.2, the floor is 3.0 — as env(1) assignments, quoted like everything else. `exec`
  // makes pane_pid the shim's own pid (env execs the shim in turn), which tmux also makes the
  // process-group leader — the pid kill() signals is the pid the registry records.
  assert.equal(shQuote('plain'), "'plain'")
  assert.equal(shQuote("it's"), `'it'\\''s'`)
  assert.equal(shQuote(''), "''")
  const cmd = paneCommand('node', ['shim.mjs', '--fleet-session=3', "/state/my fleet/sessions/it's.json"])
  assert.equal(cmd, `exec 'node' 'shim.mjs' '--fleet-session=3' '/state/my fleet/sessions/it'\\''s.json'`, 'no env, no env(1)')
  const withEnv = paneCommand('node', ['shim.mjs'], [{ name: 'FLEET_SESSION', value: '1' }, { name: 'FLEET_STATE_DIR', value: "/s/it's here" }, { name: 'FLEET_TESTING_URL', value: '' }])
  assert.equal(withEnv, `exec 'env' 'FLEET_SESSION=1' 'FLEET_STATE_DIR=/s/it'\\''s here' 'FLEET_TESTING_URL=' 'node' 'shim.mjs'`)
  // env(1) reads a leading `-` as one of its own options: a name it cannot set is refused, not passed
  assert.throws(() => paneCommand('node', [], [{ name: '-i', value: 'x' }]), /not a variable name env\(1\) can set/)
  assert.throws(() => paneCommand('node', [], [{ name: 'A B', value: 'x' }]), /not a variable name/)
})

test('a title or a path is escaped against tmux format expansion and the trailing-`;` command separator', () => {
  // `-c` and `-n` are FORMATS to tmux: `#{pane_current_path}` is substituted, `#(id)` RUNS id. And an
  // argument ending in `;` ends the command, so `-c … -P -F …` becomes a second, unknown command.
  assert.equal(fmtEscape('/w/app#1'), '/w/app##1')
  assert.equal(fmtEscape('#{pane_current_path} #(id) #S'), '##{pane_current_path} ##(id) ##S')
  assert.equal(fmtEscape('plain'), 'plain')
  assert.equal(escapeTrailingSemicolon('fix the tests;'), 'fix the tests\\;')
  assert.equal(escapeTrailingSemicolon('a; b'), 'a; b', 'only a TRAILING `;` is a separator')
  assert.equal(escapeTrailingSemicolon('ends in \\;'), 'ends in \\\\;', 'tmux strips one `;` then turns the `\\` back into `;` — the literal survives')
  assert.equal(escapeTrailingSemicolon(''), '')

  const argv = spawnArgs({ session: 'fleet', exists: true, title: 'ABC-1234 fix #{pane_current_path};', cwd: '/w/repo #(id)', command: 'node', args: ['shim.mjs'] })
  assert.equal(argv[argv.indexOf('-n') + 1], 'ABC-1234 fix ##{pane_current_path}\\;')
  assert.equal(argv[argv.indexOf('-c') + 1], '/w/repo ##(id)')
  assert.ok(argv.every(a => !/(^|[^\\]);$/.test(a)), 'no token ends in an unescaped `;` that would end the command early')
})

test('the first spawn is new-session -d, every later one new-window -d into the EXACT session, both -P -F', () => {
  // `-t fleet` prefix-matches `fleet-old`; `=fleet` does not. `-P -F` prints the created ids so
  // nothing is ever looked up by name afterwards; `-d` keeps an attached operator where they are.
  const first = spawnArgs({ session: 'fleet', exists: false, title: 'session 1', cwd: '/w/a', command: 'node', args: ['shim.mjs'] })
  assert.deepEqual(first, ['new-session', '-d', '-s', 'fleet', '-n', 'session 1', '-c', '/w/a', '-P', '-F', SPAWN_FORMAT, "exec 'node' 'shim.mjs'"])
  const next = spawnArgs({ session: 'fleet', exists: true, title: 'session 2', cwd: '/w/b', command: 'node', args: ['shim.mjs'] })
  assert.deepEqual(next, ['new-window', '-d', '-t', '=fleet:', '-n', 'session 2', '-c', '/w/b', '-P', '-F', SPAWN_FORMAT, "exec 'node' 'shim.mjs'"])
  assert.equal(SPAWN_FORMAT, '#{window_id} #{pane_id} #{pane_pid}')
  assert.deepEqual(parseSpawnOutput('@3 %7 4242\n'), { windowId: '@3', paneId: '%7', panePid: 4242 })
  assert.equal(parseSpawnOutput('can\'t find session'), null)
  assert.equal(parseSpawnOutput(''), null)

  // the identity goes onto the WINDOW in one command sequence, remain-on-exit with it
  const tag = tagArgs('@3', '7', 'working')
  assert.deepEqual(tag.filter(t => t === ';').length, 2)
  assert.deepEqual(tag.slice(0, 6), ['set-option', '-w', '-t', '@3', '@fleet_id', '7'])
  assert.ok(tag.join(' ').includes('@fleet_role working'))
  assert.ok(tag.join(' ').includes('remain-on-exit on'))
})

// ---- pure: listing -----------------------------------------------------------------------------------

test('list-panes rows parse by field; other sessions, untagged windows and dead panes are not sessions', () => {
  // `-a` lists every pane on the socket: a window the operator opened by hand carries no @fleet_id
  // and must never be sent to or killed; a dead pane (remain-on-exit) is a crashed session's
  // scrollback, not a live one; and a freed window INDEX is reused while the id is not, so spawn
  // order comes from the id.
  const text = [
    ['fleet', '@0', '%0', '4000', '0', '1', 'working', 'ready'].join('\t'),
    ['fleet', '@5', '%5', '4005', '0', '3', 'testing', ''].join('\t'),
    ['fleet', '@2', '%2', '4002', '0', '2', 'working', 'working'].join('\t'),
    ['fleet', '@3', '%3', '4003', '1', '4', 'working', 'blocked'].join('\t'), // crashed, remain-on-exit
    ['fleet', '@4', '%4', '4004', '0', '', '', ''].join('\t'),                // the operator's own window
    ['other', '@9', '%9', '4009', '0', '9', 'working', ''].join('\t'),        // another session on the socket
    'garbage line',
  ].join('\n') + '\n'
  const rows = parseListPanes(text, { session: 'fleet' })
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[3], { sessionName: 'fleet', windowId: '@3', paneId: '%3', panePid: 4003, dead: true, fleetId: '4', fleetRole: 'working', fleetState: 'blocked' })
  assert.equal(parseListPanes(text).length, 6, 'unrestricted, the other session is still a row')

  const handles = handlesFrom(rows, IDS)
  assert.deepEqual(handles.map(h => h.id), ['1', '2', '3'], 'spawn order by window id, dead and untagged dropped')
  // `spawn` names THIS spawn (contract §4) in one field: the triple resolveRef() requires to agree, joined
  assert.deepEqual(handles[1], { id: '2', role: 'working', backendRef: { socket: 'fleet', session: 'fleet', windowId: '@2', paneId: '%2', panePid: 4002, spawn: '@2/%2/4002' }, shimPid: 4002, pgid: 4002 })
  assert.ok(Object.isFrozen(handles[1]) && Object.isFrozen(handles[1].backendRef))
  assert.ok(LIST_FORMAT.split('\t').length === 8 && LIST_FORMAT.includes('#{@fleet_id}') && LIST_FORMAT.includes('#{pane_dead}'))
})

test('"no server" is an empty fleet; any other listing failure is a failure', () => {
  // An empty answer to a BROKEN tmux would let teardown report a clean machine.
  assert.equal(isNoServer('no server running on /tmp/tmux-1000/fleet'), true)
  assert.equal(isNoServer('error connecting to /tmp/tmux-1000/fleet (No such file or directory)'), true)
  // exit-empty: a client that connects while the server is going away after its last window closed
  assert.equal(isNoServer('lost server'), true)
  assert.equal(isNoServer('server exited unexpectedly'), true)
  assert.equal(isNoServer('unknown command: list-panes'), false)
  assert.equal(isNoServer(''), false)
})

// ---- pure: send and addressing ---------------------------------------------------------------------

test('send-keys -l carries only a short single line; everything else takes the paste buffer', () => {
  // Each buffer reason is a way `-l` CORRUPTS a message, not a limit it hits: a newline is sent as
  // Enter (the session acts on the first line), a trailing `;` is a command separator to tmux's
  // argv parser (the last byte is lost and a second command runs), a leading `-` is a flag.
  assert.deepEqual(sendPlan('status please'), { mode: 'keys', reason: null })
  assert.deepEqual(sendPlan('x'.repeat(SEND_INLINE_LIMIT)), { mode: 'keys', reason: null })
  assert.deepEqual(sendPlan('x'.repeat(SEND_INLINE_LIMIT + 1)), { mode: 'buffer', reason: 'long' })
  assert.deepEqual(sendPlan('two\nlines'), { mode: 'buffer', reason: 'multi-line' })
  assert.deepEqual(sendPlan('crlf\r\n'), { mode: 'buffer', reason: 'multi-line' })
  assert.deepEqual(sendPlan('rerun the tests;'), { mode: 'buffer', reason: 'semicolon' })
  assert.deepEqual(sendPlan('a; b'), { mode: 'buffer', reason: 'semicolon' })
  assert.deepEqual(sendPlan('--file /s/nudge.txt'), { mode: 'buffer', reason: 'leading-dash' })
  assert.deepEqual(sendPlan(''), { mode: 'keys', reason: null })
  assert.equal(SEND_INLINE_LIMIT, 500)
})

test('a handle resolves only through a well-formed backendRef minted for THIS socket and session', () => {
  // The fake's rule, kept: a ref built from a label, or another fleet's handle, is not "a session
  // that has ended" — answering that reports a successful teardown of something never owned.
  const good = { id: '3', role: 'working', backendRef: { socket: 'fleet', session: 'fleet', windowId: '@3', paneId: '%3', panePid: 4003 } }
  assert.deepEqual(resolveRef(good, IDS), { socket: 'fleet', session: 'fleet', windowId: '@3', paneId: '%3', panePid: 4003 })
  for (const bad of [
    { id: '3' }, '3', null, { id: '3', backendRef: 'fleet:@3' },
    { id: '3', backendRef: { socket: 'fleet', session: 'fleet', windowId: '3', paneId: '%3', panePid: 4003 } },
    { id: '3', backendRef: { socket: 'fleet', session: 'fleet', windowId: '@3', paneId: '%3', panePid: 0 } },
    { id: '3', backendRef: { socket: 'fleet', session: 'fleet', windowId: '@3', paneId: '%3' } },
    { id: '3', backendRef: { socket: 'other', session: 'fleet', windowId: '@3', paneId: '%3', panePid: 4003 } },
    { id: '3', backendRef: { socket: 'fleet', session: 'fleet-old', windowId: '@3', paneId: '%3', panePid: 4003 } },
  ]) {
    assert.throws(() => resolveRef(bad, IDS), TypeError, `must refuse ${JSON.stringify(bad)}`)
  }
  assert.throws(() => resolveRef({ id: '3', backendRef: { socket: 'other', session: 'fleet', windowId: '@3', paneId: '%3', panePid: 4003 } }, IDS), /another fleet's handle/)
})

test('attach switches a client already on the fleet server, and attaches (nested, TMUX removed) from anywhere else', () => {
  // switch-client only reaches a session on the client's OWN server; from the operator's own tmux
  // the fleet is a different server, and tmux refuses a nested attach while $TMUX is set — set to
  // anything, including empty, so the variable must be deleted rather than blanked.
  assert.deepEqual(attachPlan({ socket: 'fleet', tmuxEnv: null }), { verb: 'attach-session', unsetEnv: [] })
  assert.deepEqual(attachPlan({ socket: 'fleet', tmuxEnv: '/tmp/tmux-501/fleet,1234,0' }), { verb: 'switch-client', unsetEnv: [] })
  assert.deepEqual(attachPlan({ socket: 'fleet', tmuxEnv: '/tmp/tmux-501/default,1234,0' }), { verb: 'attach-session', unsetEnv: ['TMUX'] })
  assert.deepEqual(attachPlan({ socket: 'fleet', tmuxEnv: '/tmp/tmux-501/fleet-old,1234,0' }), { verb: 'attach-session', unsetEnv: ['TMUX'] }, 'a prefix is not the socket')
})

// ---- the backend over the scripted server ---------------------------------------------------------

test('the tmux backend implements the whole interface and declares its capabilities honestly', () => {
  // A backend that quietly claims a capability it lacks means the caller's degradation branch is
  // never taken by any test and ships unexecuted.
  const b = backendOver(fakeTmux())
  assert.deepEqual(validateBackend(b), { ok: true, missing: [], badCapabilities: [] })
  assert.deepEqual(Object.keys(TMUX_CAPABILITIES).sort(), [...CAPABILITY_NAMES].sort())
  const caps = b.capabilities()
  for (const on of ['authoritativeList', 'reliableSend', 'observableStatus', 'detachSurvivesLauncher', 'focusById']) assert.equal(caps[on], true, on)
  // a session IS a window: nothing tiles sessions beside each other, so gridLayout is not claimed either
  for (const off of ['gridLayout', 'pixelLayout', 'multiMonitor', 'freeFloatingWindows']) assert.equal(caps[off], false, off)
  assert.equal(b.name, 'tmux')
})

test('the socket and session names are validated at construction — a "." or ":" makes every -t target unaddressable', () => {
  const bad = (socket, session) => ({ ...CONFIG, terminal: { ...CONFIG.terminal, tmux: { socket, session } } })
  assert.throws(() => createTmuxBackend({ config: bad('fleet', 'my.fleet') }), /terminal\.tmux\.session/)
  assert.throws(() => createTmuxBackend({ config: bad('fleet', 'a:b') }), /terminal\.tmux\.session/)
  assert.throws(() => createTmuxBackend({ config: bad('../x', 'fleet') }), /terminal\.tmux\.socket/)
  assert.throws(() => createTmuxBackend({ config: bad('', 'fleet') }), /terminal\.tmux\.socket/)
  assert.throws(() => createTmuxBackend({ config: {} }), /terminal\.tmux\.socket/)
})

test('probe answers with an actionable reason: missing, too old, unreadable, or the wrong platform', () => {
  // The contract wants a reason a user can act on; "unavailable" is not one.
  const okProbe = backendOver(fakeTmux({ version: 'tmux 3.0' })).probe()
  assert.deepEqual(okProbe, { available: true, name: 'tmux', reason: null })
  assert.ok(validateResultShape('probe', okProbe).ok)

  const missing = createTmuxBackend({ config: CONFIG, platform: 'darwin', exec: () => { throw new Error('must not run tmux when it is absent') }, which: () => null }).probe()
  assert.equal(missing.available, false)
  assert.match(missing.reason, /not installed: brew install tmux/)

  const old = backendOver(fakeTmux({ version: 'tmux 2.9a' }), { platform: 'linux' }).probe()
  assert.equal(old.available, false)
  assert.match(old.reason, /2\.9a is older than 3\.0.*apt install tmux/)

  const odd = backendOver(fakeTmux({ version: 'tmux master' })).probe()
  assert.equal(odd.available, false)
  assert.match(odd.reason, /could not read a version from "tmux master"/)

  // Windows has no process groups, and group signalling is the whole teardown guarantee here.
  const win = backendOver(fakeTmux(), { platform: 'win32' }).probe()
  assert.equal(win.available, false)
  assert.match(win.reason, /windows-terminal/)
  // …but it is the ONLY platform without them: index.mjs falls back to tmux on any other, and a BSD
  // with tmux on PATH must not be refused with a reason written for Windows
  assert.deepEqual(backendOver(fakeTmux(), { platform: 'freebsd' }).probe(), { available: true, name: 'tmux', reason: null })

  // `tmux -V` never touches a server, so it carries no socket or config flags
  const f = fakeTmux()
  backendOver(f).probe()
  assert.deepEqual(f.st.calls[0], ['-V'])
})

test('spawn creates the session on the first call and a window on the next, tags both, and carries the env on the pane\'s shell line', () => {
  // The ids come from -P -F, never from a lookup by name; the identity lives in window options so
  // list() can read it back; `spec.env` (the contract §4 scalars, from buildSessionEnv) reaches the
  // agent as `exec env NAME=value …` on the shell line — never as `-e`, which needs tmux 3.2.
  const f = fakeTmux()
  const b = backendOver(f)
  const s1 = spec(1)
  const s2 = spec(2, { role: 'testing', session: { slot: 1, branch: 'testing', port: 3000 } })
  const h1 = b.spawn(s1)
  const h2 = b.spawn(s2)

  assert.deepEqual(h1, { id: '1', role: 'working', backendRef: { socket: 'fleet', session: 'fleet', windowId: '@0', paneId: '%0', panePid: 4000, spawn: '@0/%0/4000' }, shimPid: 4000, pgid: 4000 })
  assert.equal(h2.backendRef.windowId, '@1')
  assert.equal(h2.role, 'testing')
  assert.ok(validateResultShape('spawn', h1).ok)

  const verbs = f.verbs()
  // ⛔ The server is started by `start-server`, NEVER as a side effect of `new-session`. A tmux server
  // forked from a `new-session` client keeps that client's whole argv for as long as it lives — pane
  // command, `--fleet-session=<label>` marker and all — so every machine-wide marker scan would find
  // two processes for session 1: its agent, and a server that outlives it. core/fleet.reconcile would
  // then call a dead session alive after a crash and bind its shimPid to the SERVER, and the next
  // `fleet kill` on that label would walk the tree from the tmux server and take the whole fleet down.
  assert.ok(verbs.includes('start-server'), 'the server is brought up by a call with nothing on its argv')
  assert.ok(verbs.indexOf('start-server') < verbs.indexOf('new-session'), 'and that call precedes the first session')
  assert.deepEqual(verbs.filter(v => v === 'new-session'), ['new-session'], 'the server is started exactly once')
  assert.deepEqual(verbs.filter(v => v === 'new-window'), ['new-window'])
  const created = f.st.calls.find(a => a[4] === 'new-session')
  assert.deepEqual(created.slice(4, 12), ['new-session', '-d', '-s', 'fleet', '-n', 'session 1', '-c', '/w/app session-1'])
  assert.deepEqual(created.slice(12, 14), ['-P', '-F'])
  assert.equal(created[14], SPAWN_FORMAT)
  assert.ok(created[15].startsWith(`exec 'env' 'FLEET_SESSION=1' `), created[15])
  assert.ok(created[15].endsWith(` 'node' 'shim.mjs' '--fleet-session=1' '/state/my fleet/sessions/1.json'`), created[15])
  for (const { name, value } of s1.env) assert.ok(created[15].includes(` ${shQuote(`${name}=${value}`)} `), `${name} rides the shell line as one quoted token`)
  assert.ok(!created.includes('-e'), 'never -e: it needs tmux 3.2')
  assert.equal(created.length, 16, 'and no env token is a separate argv entry')
  const window = f.st.calls.find(a => a[4] === 'new-window')
  assert.deepEqual(window.slice(4, 8), ['new-window', '-d', '-t', '=fleet:'])
  for (const name of ['FLEET_SLOT=1', 'FLEET_SLOT_BRANCH=testing', 'FLEET_PORT=3000']) assert.ok(window.at(-1).includes(shQuote(name)), `${name} reaches the testing session`)

  assert.deepEqual(f.windowOptions('@0'), { '@fleet_id': '1', '@fleet_role': 'working', 'remain-on-exit': 'on' })
  assert.deepEqual(f.windowOptions('@1'), { '@fleet_id': '2', '@fleet_role': 'testing', 'remain-on-exit': 'on' })
  assert.equal(f.window('@1').name, 'session 2')
  assert.equal(f.window('@1').cwd, '/w/app session-2')
})

test('a ticket title ending in `;` or a path carrying a format reaches tmux escaped, and lands verbatim', () => {
  // The fake parses argv the way tmux does: an unescaped trailing `;` would split new-window mid-argv
  // (`-c … -P -F …` becomes a second, unknown command) and `#{…}` / `#(…)` in -n / -c would be
  // expanded — or run. Both are asserted on what the window ended up with, not on the escape alone.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1, { title: 'ABC-1234: rerun the tests;', cwd: '/w/app #{pane_current_path} #(id) #1' }))
  assert.equal(f.window(h.backendRef.windowId).name, 'ABC-1234: rerun the tests;')
  assert.equal(f.window(h.backendRef.windowId).cwd, '/w/app #{pane_current_path} #(id) #1')
  const created = f.st.calls.find(a => a[4] === 'new-session')
  assert.equal(created[created.indexOf('-n') + 1], 'ABC-1234: rerun the tests\\;')
  assert.equal(created[created.indexOf('-c') + 1], '/w/app ##{pane_current_path} ##(id) ##1')
  assert.deepEqual(b.list(), [h], 'one window, tagged — nothing half-created by a split command')
  assert.deepEqual(f.windowOptions(h.backendRef.windowId), { '@fleet_id': '1', '@fleet_role': 'working', 'remain-on-exit': 'on' })
})

test('spawn refuses a half-built spec, a label tmux cannot carry, and a label that is already live', () => {
  const f = fakeTmux()
  const b = backendOver(f)
  assert.throws(() => b.spawn(spec(1, { role: 'reviewer' })), /unknown role "reviewer"/)
  assert.throws(() => b.spawn(spec(1, { env: [{ name: 'FLEET_LABEL' }] })), /env entries must be/)
  assert.throws(() => b.spawn(spec('3;', {})), /cannot be a tmux option value/)
  assert.deepEqual(b.list(), [], 'a refused spec leaves nothing behind')
  b.spawn(spec(3))
  // Two agents in one worktree collide on the git index; a relaunch kills first, never spawns beside.
  assert.throws(() => b.spawn(spec(3)), /already running/)
  assert.equal(b.list().length, 1)
})

test('a spawn whose tagging fails closes the window it made and throws — no half-created session', () => {
  // A window that exists but carries no identity is a session nothing can list, send to or kill;
  // the next status read would show a window the registry cannot address.
  const f = fakeTmux()
  const b = backendOver(f)
  b.spawn(spec(1))
  f.st.fail.add('set-option')
  assert.throws(() => b.spawn(spec(2)), /could not tag tmux window @1.*closed again/)
  assert.deepEqual(b.list().map(h => h.id), ['1'])
  assert.equal(f.window('@1'), null, 'the untagged window is gone')
  const seq = f.st.seq
  assert.ok(seq.indexOf('tmux kill-window') > seq.lastIndexOf('tmux set-option'), 'closed AFTER the tag failed')
})

test('list is authoritative: one list-panes call, from tmux, no process snapshot', () => {
  const f = fakeTmux()
  const b = backendOver(f)
  assert.deepEqual(b.list(), [], 'no server yet is an empty fleet, not an error')
  const h1 = b.spawn(spec(1))
  const h2 = b.spawn(spec(2))
  f.st.seq.length = 0
  const listed = b.list()
  assert.deepEqual(listed, [h1, h2])
  assert.deepEqual(f.st.seq, ['tmux list-panes'], 'exactly one call, and never `snapshot`')
  assert.equal(f.st.calls.at(-1)[7], LIST_FORMAT)
  assert.deepEqual(f.st.calls.at(-1).slice(4, 7), ['list-panes', '-a', '-F'])

  // a session whose process exited keeps its window (remain-on-exit) but is no longer a live session
  f.die(h1.backendRef.paneId)
  assert.deepEqual(b.list(), [h2])
  assert.equal(b.isAlive(h1), false)
  assert.equal(b.isAlive(h2), true)
})

test('a BROKEN tmux is a failure, never an empty fleet: list, isAlive and kill throw, and killServer reports it', () => {
  // The trap isNoServer() exists for, exercised through the backend: a listing that fails for any
  // reason but "no server" answering [] would let `fleet down` report a clean machine, and kill()
  // answering alreadyGone would report a teardown that never happened.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  f.st.fail.add('list-panes')
  assert.throws(() => b.list(), /tmux list-panes failed: injected failure for list-panes/)
  assert.throws(() => b.isAlive(h), /tmux list-panes failed/)
  assert.throws(() => b.kill(h), /tmux list-panes failed/)
  assert.throws(() => b.layout([h], 'windows'), /tmux list-panes failed/)
  assert.ok(!f.st.seq.includes('killTree') && !f.st.seq.includes('tmux kill-window'), 'nothing was signalled or closed on an unknown state')
  f.st.fail.delete('list-panes')
  assert.deepEqual(b.list(), [h], 'the session was there all along')

  f.st.fail.add('kill-server')
  assert.deepEqual(b.killServer(), { ok: false, hadServer: true, reason: 'injected failure for kill-server' })
  f.st.fail.delete('kill-server')
  assert.deepEqual(b.killServer(), { ok: true, hadServer: true })
})

test('a RUNNING server with no sessions is an empty fleet, not a broken one', () => {
  // ⛔ tmux.conf sets `exit-empty off` so the fleet's server survives between a `fleet relaunch`'s
  // kill and its respawn. That makes "server up, zero sessions" an ordinary state — and `list-panes`
  // resolves its target through the current session even with `-a`, so it fails there with "no
  // current target" rather than printing nothing. Read as a broken tmux, `list`, `isAlive` and `kill`
  // would throw for a fleet whose last session was simply killed, and `fleet status` would report a
  // failure where the honest answer is "no sessions".
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  assert.deepEqual(b.list(), [h])

  assert.equal(b.kill(h).ok, true)
  f.st.sessions.clear() // the last window closed, and with exit-empty off the server stays up
  assert.deepEqual(b.list(), [], 'an empty fleet lists nothing instead of throwing')
  assert.equal(b.isAlive(h), false, 'and the killed session reads as gone, not as unknowable')
  assert.equal(b.kill(h).alreadyGone, true, 'a teardown over an empty fleet is a no-op, not an error')

  // The distinction is kept: a listing that fails for any OTHER reason is still a broken tmux, or
  // `fleet down` would report a clean machine it never verified.
  f.st.fail.add('list-panes')
  assert.throws(() => b.list(), /tmux list-panes failed/)
  f.st.fail.delete('list-panes')

  // And "empty" never means "no server": a spawn into it must not try to start a second one.
  assert.equal(isNoSessions('no current target'), true)
  assert.equal(isNoServer('no current target'), false)
  assert.equal(isNoSessions('no server running on /tmp/tmux-1000/fleet'), false)
})

test('a handle from before a server restart never re-binds to the namesake spawned after it', () => {
  // Pane and window ids restart at %0 / @0 on a fresh server. `fleet down`, then `fleet up`, hands
  // the new session 1 the same ids the old one had; only the pid tells them apart, and a nudge or a
  // kill sent through the old handle must not land in the new session.
  const f = fakeTmux()
  const b = backendOver(f)
  const stale = b.spawn(spec(1))
  f.restart()
  const fresh = b.spawn(spec(1))
  assert.equal(fresh.backendRef.paneId, stale.backendRef.paneId, 'the ids really are reused')
  assert.notEqual(fresh.backendRef.panePid, stale.backendRef.panePid)

  assert.equal(b.isAlive(stale), false)
  assert.equal(b.isAlive(fresh), true)
  assert.equal(b.send(stale, 'are you there').reason, 'session-gone')
  assert.equal(b.setStatus(stale, 'ready'), false)
  assert.equal(b.focus(stale), false)
  assert.deepEqual(b.kill(stale), { ok: true, killed: [], alreadyGone: true, survivors: [] })
  assert.deepEqual(b.list(), [fresh], 'and no stale address ended the live session')
  assert.deepEqual(f.typed(fresh.backendRef.paneId), [])
})

test('every interface method refuses a handle that is not a registry handle', () => {
  const b = backendOver(fakeTmux())
  const h = b.spawn(spec(3))
  for (const bad of [{ id: '3' }, '3', null, { id: '3', backendRef: { socket: 'other', session: 'fleet', windowId: '@0', paneId: '%0', panePid: 4000 } }]) {
    assert.throws(() => b.send(bad, 'hello'), TypeError)
    assert.throws(() => b.isAlive(bad), TypeError)
    assert.throws(() => b.kill(bad), TypeError)
    assert.throws(() => b.setStatus(bad, 'ready'), TypeError)
    assert.throws(() => b.focus(bad), TypeError)
    // layout skips a null entry (an empty slot in a caller's list), like the fake; a forgery still throws
    if (bad !== null) assert.throws(() => b.layout([bad]), TypeError)
  }
  assert.equal(b.isAlive(h), true, 'the handle the registry recorded is the only one that resolves')
})

// ---- send ----------------------------------------------------------------------------------------

test('a short message is send-keys -l then Enter, delivered whole', () => {
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  f.st.calls.length = 0
  const r = b.send(h, 'status please')
  assert.deepEqual(r, { ok: true, requested: 13, delivered: 13, truncated: false, reason: null })
  assert.ok(validateResultShape('send', r).ok)
  assert.deepEqual(f.typed(h.backendRef.paneId), ['status please', '\r'])
  const argv = f.st.calls.map(a => a.slice(4))
  assert.deepEqual(argv.filter(a => a[0] === 'send-keys'), [
    ['send-keys', '-t', '%0', '-l', 'status please'],
    ['send-keys', '-t', '%0', 'Enter'],
  ])
  assert.ok(!argv.some(a => a[0] === 'load-buffer'), 'the paste path is not used for a short line')
})

test('a long or multi-line message goes by file into a named buffer and is pasted bracketed — exact bytes, no truncation', () => {
  // The incident this backend is free of: a ~700-character message arriving as 62 characters plus
  // Enter. Here the bytes travel by file and paste buffer, so the whole document lands, newlines
  // included; the buffer is NAMED so two concurrent sends cannot paste each other's text; and the
  // file is removed afterwards because it can hold ticket text.
  const f = fakeTmux()
  const dir = tmp()
  const b = backendOver(f, { tmpDir: dir })
  const h = b.spawn(spec(1))
  const message = 'read this whole thing:\n' + 'x'.repeat(700) + "\nand don't stop; keep going"
  f.st.calls.length = 0

  const r = b.send(h, message)
  assert.deepEqual(r, { ok: true, requested: message.length, delivered: message.length, truncated: false, reason: null })
  assert.deepEqual(f.typed(h.backendRef.paneId), [message, '\r'])
  const argv = f.st.calls.map(a => a.slice(4))
  const load = argv.find(a => a[0] === 'load-buffer')
  const paste = argv.find(a => a[0] === 'paste-buffer')
  assert.deepEqual(load.slice(0, 3), ['load-buffer', '-b', `fleet-0-${process.pid}-1`])
  assert.ok(load[3].startsWith(dir), 'the paste file lives in the injected temp dir')
  assert.deepEqual(paste, ['paste-buffer', '-p', '-d', '-b', `fleet-0-${process.pid}-1`, '-t', '%0'])
  assert.deepEqual(argv.at(-1), ['send-keys', '-t', '%0', 'Enter'])
  assert.ok(!argv.some(a => a[0] === 'send-keys' && a.includes('-l')), 'no fragment ever went through -l')
  assert.deepEqual(fs.readdirSync(dir), [], 'the paste file is removed once pasted')
  assert.equal(f.st.buffers.size, 0, '-d dropped the buffer')

  // the semicolon-only case takes the same path — `-l` would lose the trailing byte to tmux's parser
  b.send(h, 'rerun the tests;')
  assert.equal(f.typed(h.backendRef.paneId).at(-2), 'rerun the tests;')
  assert.equal(f.st.calls.map(a => a[4]).filter(v => v === 'load-buffer').length, 2)
})

test('a send to a session that has gone, or a tmux call that fails, is reported per target — never thrown at the loop', () => {
  // "Send to 1, 2, 3" once reached nobody with a single error while the listing showed them all.
  const f = fakeTmux()
  const dir = tmp()
  const b = backendOver(f, { tmpDir: dir })
  const handles = [1, 2, 3].map(n => b.spawn(spec(n)))
  f.die(handles[1].backendRef.paneId)

  const results = handles.map(h => b.send(h, 'status please'))
  assert.deepEqual(results.map(r => r.ok), [true, false, true])
  assert.deepEqual(results[1], { ok: false, requested: 13, delivered: 0, truncated: false, reason: 'session-gone' })
  assert.deepEqual(f.typed(handles[1].backendRef.paneId), [])

  // the pane vanishes between the liveness check and the write: reported, the paste file is still
  // removed, AND the loaded buffer is dropped — `-d` was on the paste that failed, so without an
  // explicit delete-buffer the ticket text would sit in the server for the life of the fleet
  f.st.fail.add('paste-buffer')
  const failed = b.send(handles[0], 'x'.repeat(600))
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /paste-buffer: injected failure/)
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.equal(f.st.buffers.size, 0, 'the named buffer does not outlive the failed paste')
  assert.deepEqual(f.st.calls.at(-1).slice(4), ['delete-buffer', '-b', `fleet-0-${process.pid}-1`])
  f.st.fail.delete('paste-buffer')

  // text landed but Enter did not: not delivery, and the count says what is sitting in the input line
  f.st.fail.add('send-keys')
  const noEnter = b.send(handles[2], 'x'.repeat(600))
  assert.deepEqual([noEnter.ok, noEnter.delivered, noEnter.requested], [false, 600, 600])
  assert.match(noEnter.reason, /^enter: /)
})

test('a send whose liveness read fails, or whose paste file cannot be written, is reported per target too', () => {
  // The liveness check is a list-panes call and rows() THROWS on a broken tmux (rightly, for list and
  // kill); inside send() that throw would abort the caller's fan-out on the first target. So would a
  // paste directory that cannot be created. Both come back as this target's failure.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  f.st.fail.add('list-panes')
  const unread = b.send(h, 'status please')
  assert.deepEqual([unread.ok, unread.delivered, unread.requested], [false, 0, 13])
  assert.match(unread.reason, /tmux list-panes failed: injected failure for list-panes/)
  assert.ok(validateResultShape('send', unread).ok)
  f.st.fail.delete('list-panes')
  assert.deepEqual(f.typed(h.backendRef.paneId), [], 'nothing was typed at a session whose liveness is unknown')

  // a regular file where the paste directory should be: mkdir fails, and the send says so
  const blocked = path.join(tmp(), 'not-a-dir')
  fs.writeFileSync(blocked, '')
  const unwritten = backendOver(f, { tmpDir: blocked }).send(h, 'x'.repeat(600))
  assert.equal(unwritten.ok, false)
  assert.match(unwritten.reason, /^paste-file: /)
  assert.equal(f.st.buffers.size, 0, 'no buffer was loaded from a file that was never written')
  assert.deepEqual(f.typed(h.backendRef.paneId), [])
})

test('paste files default to <paths.stateDir>/tmp — the fleet\'s own scratch, never os.tmpdir() — and are removed once pasted', () => {
  // Contract §4: the state dir is per repo, per machine, and NEVER os.tmpdir(); a paste file holds a
  // nudge or a ticket's text. selectBackend constructs the backend with {config, platform} alone, so
  // the default is what production runs with. Only a config with no stateDir at all falls back.
  const stateDir = tmp()
  const f = fakeTmux()
  const b = backendOver(f, { config: { ...CONFIG, paths: { ...CONFIG.paths, stateDir } }, tmpDir: undefined })
  const h = b.spawn(spec(1))
  const r = b.send(h, 'x'.repeat(600))
  assert.equal(r.ok, true)
  const load = f.st.calls.map(a => a.slice(4)).find(a => a[0] === 'load-buffer')
  assert.equal(path.dirname(load[3]), path.join(stateDir, 'tmp'), 'written under the state dir')
  assert.ok(fs.statSync(path.join(stateDir, 'tmp')).isDirectory(), 'created on demand')
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'tmp')), [], 'and removed once pasted')

  const fb = fakeTmux()
  const nb = backendOver(fb, { config: { ...CONFIG, paths: { ...CONFIG.paths, stateDir: null } }, tmpDir: undefined })
  assert.equal(nb.send(nb.spawn(spec(1)), 'x'.repeat(600)).ok, true)
  const fallback = fb.st.calls.map(a => a.slice(4)).find(a => a[0] === 'load-buffer')
  assert.equal(path.dirname(fallback[3]), os.tmpdir(), 'no stateDir in the config: the OS temp dir is the only place left')
})

// ---- status --------------------------------------------------------------------------------------

test('setStatus writes @fleet_state on the window, reads back through list-panes, and refuses an unknown status', () => {
  // observableStatus is what makes the red/green testable: a typo'd status that silently no-ops
  // loses the fleet's colour, and a status the backend cannot read back cannot be asserted.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  assert.equal(b.statusOf(h), null)
  assert.equal(b.setStatus(h, 'working'), true)
  assert.equal(b.statusOf(h), 'working')
  assert.equal(b.setStatus(h, 'blocked'), true)
  assert.equal(b.statusOf(h), 'blocked')
  assert.equal(f.windowOptions(h.backendRef.windowId)['@fleet_state'], 'blocked')
  assert.deepEqual(f.st.calls.at(-2).slice(4), ['set-option', '-w', '-t', '@0', '@fleet_state', 'blocked'])
  assert.throws(() => b.setStatus(h, 'busy'), /unknown status "busy"/)
  assert.deepEqual([...STATUS], ['working', 'ready', 'blocked'])
  f.die(h.backendRef.paneId)
  assert.equal(b.setStatus(h, 'ready'), false)
  assert.equal(b.statusOf(h), null, 'a dead session has no live status')
})

// ---- kill ----------------------------------------------------------------------------------------

test('kill signals the process group FIRST and closes the window only after the tree is gone', () => {
  // The reverse order SIGHUPs the pane and reparents grandchildren (a dev server) to init — the
  // orphan class the supervisor hunts. The order is asserted on the call log, not inferred.
  const f = fakeTmux()
  const b = backendOver(f)
  const one = b.spawn(spec(1))
  const two = b.spawn(spec(2))
  f.st.seq.length = 0

  const r = b.kill(one)
  assert.deepEqual(r, { ok: true, killed: [one.backendRef.panePid], alreadyGone: false, survivors: [] })
  assert.ok(validateResultShape('kill', r).ok)
  assert.deepEqual(f.st.seq, ['tmux list-panes', 'snapshot', 'killTree', 'tmux kill-window', 'tmux list-panes'])
  const closed = f.st.calls.find(a => a[4] === 'kill-window')
  assert.deepEqual(closed.slice(4), ['kill-window', '-t', '@0'])
  assert.deepEqual(b.list(), [two], 'the neighbouring session is untouched')
  assert.equal(b.isAlive(one), false)
})

test('kill is idempotent, and a crashed session (dead pane) is closed without a kill', () => {
  // Teardown after a crash kills sessions that are already gone and must not throw; a pane that
  // remain-on-exit kept has no process to signal, only scrollback to close.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  b.spawn(spec(2))
  f.die(h.backendRef.paneId)
  f.st.seq.length = 0
  const r = b.kill(h)
  assert.deepEqual(r, { ok: true, killed: [], alreadyGone: true, survivors: [] })
  assert.ok(!f.st.seq.includes('killTree'), 'nothing to signal')
  assert.ok(f.st.seq.includes('tmux kill-window'), 'the dead window is closed')
  assert.deepEqual(b.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
  assert.deepEqual(b.list().map(x => x.id), ['2'])
})

test('killing the LAST session rides out the server\'s exit-empty shutdown', () => {
  // Closing the last window makes the server exit; the re-read that follows can connect while it is
  // going and be answered "lost server" — which is the empty fleet the kill just produced, not a
  // broken tmux, and must not throw out of a kill that succeeded.
  const f = fakeTmux()
  const b = backendOver(f)
  const h = b.spawn(spec(1))
  const r = b.kill(h)
  assert.deepEqual(r, { ok: true, killed: [h.backendRef.panePid], alreadyGone: false, survivors: [] })
  assert.equal(f.st.running, false, 'the server went with its last window')
  assert.deepEqual(b.list(), [])
  assert.equal(b.isAlive(h), false)
  assert.deepEqual(b.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
})

test('a kill with survivors leaves the window in place and reports them — relaunch is kill, VERIFY GONE, then spawn', () => {
  // Closing the window over a survivor reparents it to init, turning a reported failure into a
  // silent orphan that still holds the slot's port.
  const f = fakeTmux()
  const b = backendOver(f, { killResult: (snap, root) => ({ planned: [root + 1, root], killed: [root], survivors: [root + 1], skippedProtected: [] }) })
  const h = b.spawn(spec(1))
  const r = b.kill(h)
  assert.equal(r.ok, false)
  assert.deepEqual(r.survivors, [h.backendRef.panePid + 1])
  assert.deepEqual(r.killed, [h.backendRef.panePid])
  assert.ok(!f.st.seq.includes('tmux kill-window'), 'the window stays for the operator to see')
  assert.equal(f.window(h.backendRef.windowId) !== null, true)
})

test('a kill from inside the session\'s own tree is refused, not half-done', () => {
  // `fleet kill 3` typed in session 3's own window: sys/kill protects self and its ancestors, skips
  // the group signal, and closing the window would then SIGHUP the very shell running the command.
  const f = fakeTmux()
  const b = backendOver(f, { killResult: (snap, root) => ({ planned: [], killed: [], survivors: [], skippedProtected: [root] }) })
  const h = b.spawn(spec(1))
  const r = b.kill(h)
  assert.equal(r.ok, false)
  assert.match(r.reason, /inside this session's own process tree/)
  assert.ok(!f.st.seq.includes('tmux kill-window'))
  assert.equal(b.isAlive(h), true)
})

// ---- focus, layout, attach, server ------------------------------------------------------------------

test('focus is exact and reports a miss', () => {
  const f = fakeTmux()
  const b = backendOver(f)
  const one = b.spawn(spec(1))
  const two = b.spawn(spec(2))
  assert.equal(b.focus(two), true)
  assert.equal(f.st.selected, two.backendRef.windowId)
  assert.deepEqual(f.st.calls.at(-1).slice(4), ['select-window', '-t', '@1'])
  b.kill(one)
  assert.equal(b.focus(one), false)
  assert.equal(f.st.selected, two.backendRef.windowId, 'a failed focus must not move the focus')
})

test('layout places windows without a tmux call, and announces tiled-panes and pixel-grid as unavailable with nothing placed', () => {
  // On tmux a session IS a window: `select-layout tiled` would arrange the panes inside one, never
  // the sessions beside each other, so "placed 3" would read as a grid that never appeared. Neither
  // gridLayout nor pixelLayout is claimed, and both modes place 0 with the degradation announced.
  const f = fakeTmux()
  const b = backendOver(f)
  const handles = [1, 2, 3].map(n => b.spawn(spec(n)))
  f.st.seq.length = 0

  const windows = b.layout(handles, 'windows')
  assert.deepEqual([windows.mode, windows.placed, windows.notice, windows.stale], ['windows', 3, null, []])
  assert.ok(validateResultShape('layout', windows).ok)
  assert.deepEqual(f.st.seq, ['tmux list-panes'], 'liveness only; nothing to arrange')

  const tiled = b.layout(handles, 'tiled-panes')
  assert.equal(tiled.placed, 0)
  assert.match(tiled.notice, /tiled-panes: unavailable on this terminal backend \(no gridLayout\)/)
  assert.match(tiled.notice, /every session is its own window/)
  assert.ok(!f.st.seq.includes('tmux select-layout'), 'no select-layout: it would tile nothing the operator can see')

  const pixel = b.layout(handles, 'pixel-grid')
  assert.equal(pixel.placed, 0)
  assert.match(pixel.notice, /unavailable on this terminal backend \(no pixelLayout\)/)
  assert.match(b.layout(handles, 'diagonal').notice, /unknown mode "diagonal"/)

  // a stale list is not a recomputed one
  b.kill(handles[0])
  const stale = b.layout(handles, 'windows')
  assert.deepEqual([stale.placed, stale.requested, stale.stale], [2, 3, ['1']])
  assert.match(stale.notice, /1 of 3 handles are no longer live \(1\)/)
  assert.deepEqual(b.layout(b.list(), 'windows').stale, [])
})

test('attachCommand and killServer address the dedicated socket, and a missing server is not a failed teardown', () => {
  const f = fakeTmux()
  const b = backendOver(f, { env: { TMUX: '/tmp/tmux-501/default,99,0' } })
  assert.deepEqual(b.attachCommand(), { command: 'tmux', args: ['-L', 'fleet', '-f', '/plugin/tmux.conf', 'attach-session', '-t', '=fleet'], unsetEnv: ['TMUX'] })
  assert.deepEqual(b.attachCommand({ tmuxEnv: '/tmp/tmux-501/fleet,99,0' }).args.slice(4), ['switch-client', '-t', '=fleet'])
  assert.deepEqual(b.attachCommand({ tmuxEnv: null }).unsetEnv, [])

  assert.equal(b.sessionExists(), false)
  assert.deepEqual(b.killServer(), { ok: true, hadServer: false })
  b.spawn(spec(1))
  assert.equal(b.sessionExists(), true)
  assert.deepEqual(f.st.calls.at(-1).slice(4), ['has-session', '-t', '=fleet'])
  assert.deepEqual(b.killServer(), { ok: true, hadServer: true })
  assert.deepEqual(b.list(), [])
})

test('the bundled tmux.conf exists, keeps crashed panes, and renders @fleet_state in the status bar', () => {
  // The backend passes it with -f on every call; a missing file makes every tmux call fail at once.
  assert.equal(path.basename(DEFAULT_CONFIG_FILE), 'tmux.conf')
  const text = fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')
  assert.match(text, /^set -g remain-on-exit on$/m)
  assert.match(text, /@fleet_state/)
  assert.match(text, /window-status-format/)
  // a comma inside a #{?...} conditional splits it: styles in the conditionals use spaces only
  for (const line of text.split('\n').filter(l => l.startsWith('setw -g window-status'))) {
    for (const style of line.match(/#\[[^\]]*\]/g) || []) assert.ok(!style.includes(','), `style ${style} would split the conditional`)
  }
})

// ---- integration: a real tmux ------------------------------------------------------------------------
//
// Guarded by FLEET_TEST_INTEGRATION and a tmux on PATH; skipped with a PRINTED reason otherwise.
// A unique socket (`-L fleet-test-<pid>`) and `-f /dev/null` keep it off any operator's server and
// off the plugin's own config; the "agent" is a node one-liner that copies its stdin to a file in
// raw mode, so the bytes asserted are exactly what an application in the pane receives.

// The env flag is read first: a unit run already knows it skips, and must not spawn a `which` subprocess to find out.
const integrationSkip = !process.env.FLEET_TEST_INTEGRATION
  ? 'set FLEET_TEST_INTEGRATION=1 to run the real-tmux block'
  : process.platform === 'win32' || !which('tmux') ? 'tmux is not on PATH (macOS: brew install tmux; Linux: apt install tmux)' : false

describe('tmux integration (real server)', { skip: integrationSkip }, () => {
  const socket = `fleet-test-${process.pid}`
  const session = 'fleet-test'
  const config = { ...CONFIG, terminal: { ...CONFIG.terminal, tmux: { socket, session } } }
  const dir = tmp()
  const backend = createTmuxBackend({ config, configFile: '/dev/null', tmpDir: dir })
  const AGENT = 'process.stdin.setRawMode(true);process.stdin.pipe(require("fs").createWriteStream(process.argv[2]))'
  const raw = args => run('tmux', ['-L', socket, '-f', '/dev/null', ...args], { timeoutMs: 15_000 })

  after(() => {
    backend.killServer()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function waitFor(fn, what, { timeoutMs = 15_000, everyMs = 50 } = {}) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(everyMs)
    }
  }
  const fileIs = (file, expected) => () => {
    try {
      return fs.readFileSync(file, 'utf8') === expected ? expected : false
    } catch {
      return false
    }
  }
  const gone = pid => {
    try {
      process.kill(pid, 0)
      return false
    } catch (e) {
      return e.code === 'ESRCH'
    }
  }

  test('spawn, send exact bytes short and long, read the status back, kill with zero survivors', async () => {
    assert.deepEqual(backend.probe(), { available: true, name: 'tmux', reason: null })
    const out = path.join(dir, 'agent-1.bytes')
    const h = backend.spawn({
      id: '1', role: 'working', title: 'session 1', cwd: dir, command: process.execPath,
      args: ['-e', AGENT, '--', '--fleet-session=1', out],
      env: buildSessionEnv(CONFIG, { label: '1', role: 'working', file: '/s/1.json', stateFile: '/s/1.json', stateDir: '/s' }),
    })
    assert.equal(h.backendRef.socket, socket)
    assert.match(h.backendRef.paneId, /^%\d+$/)
    assert.deepEqual(backend.list(), [h], 'list() is tmux\'s own answer')
    assert.equal(backend.isAlive(h), true)
    await waitFor(() => fs.existsSync(out), 'the agent to open its output file')

    // send-keys -l delivers the literal bytes and Enter is a carriage return
    const short = 'hello from the launcher'
    assert.deepEqual(backend.send(h, short), { ok: true, requested: short.length, delivered: short.length, truncated: false, reason: null })
    await waitFor(fileIs(out, `${short}\r`), 'the short message to arrive byte for byte')

    // the paste path: whole document, no truncation class; paste-buffer turns LF into CR (what a
    // terminal sends for a newline) and no bracket codes appear because the agent never asked for them
    const long = 'x'.repeat(3000) + '\nsecond line; with a semicolon\n' + 'y'.repeat(1500)
    assert.deepEqual(backend.send(h, long), { ok: true, requested: long.length, delivered: long.length, truncated: false, reason: null })
    const expected = `${short}\r${long.replace(/\n/g, '\r')}\r`
    await waitFor(fileIs(out, expected), 'the long message to arrive whole')
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('fleet-paste-')), [], 'the paste file is gone')

    // status is a window option and reads back through list-panes
    assert.equal(backend.setStatus(h, 'ready'), true)
    assert.equal(backend.statusOf(h), 'ready')
    assert.equal(backend.setStatus(h, 'blocked'), true)
    assert.equal(backend.statusOf(h), 'blocked')

    // kill: the group first, then the window; nothing survives and the pid is really gone
    const r = backend.kill(h)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.survivors, [])
    assert.equal(r.alreadyGone, false)
    assert.ok(r.killed.includes(h.backendRef.panePid))
    assert.equal(backend.isAlive(h), false)
    assert.deepEqual(backend.list(), [])
    await waitFor(() => gone(h.backendRef.panePid), 'the agent pid to disappear')
    assert.deepEqual(backend.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
  })

  test('a crashed agent keeps its pane (remain-on-exit), drops out of list(), and kill closes it as already gone', async () => {
    const h = backend.spawn({
      id: '2', role: 'working', title: 'session 2', cwd: dir, command: process.execPath,
      args: ['-e', 'process.exit(3)', '--', '--fleet-session=2'],
      env: buildSessionEnv(CONFIG, { label: '2', role: 'working', file: '/s/2.json', stateFile: '/s/2.json', stateDir: '/s' }),
    })
    await waitFor(() => !backend.isAlive(h), 'the agent to exit')
    const panes = raw(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}'])
    assert.ok(panes.ok, panes.stderr)
    assert.match(panes.stdout, new RegExp(`^${h.backendRef.paneId}\t1$`, 'm'), 'the dead pane is still there, scrollback and all')
    assert.deepEqual(backend.list().map(x => x.id), [])
    assert.deepEqual(backend.kill(h), { ok: true, killed: [], alreadyGone: true, survivors: [] })
    assert.ok(!raw(['list-panes', '-a', '-F', '#{pane_id}']).stdout.includes(h.backendRef.paneId))
  })

  test('killServer tears down the dedicated socket and only that', async () => {
    backend.spawn({
      id: '3', role: 'working', title: 'session 3', cwd: dir, command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)', '--', '--fleet-session=3'],
      env: buildSessionEnv(CONFIG, { label: '3', role: 'working', file: '/s/3.json', stateFile: '/s/3.json', stateDir: '/s' }),
    })
    assert.equal(backend.sessionExists(), true)
    assert.deepEqual(backend.killServer(), { ok: true, hadServer: true })
    await waitFor(() => !backend.sessionExists(), 'the server to go')
    assert.deepEqual(backend.list(), [])
    assert.deepEqual(backend.killServer(), { ok: true, hadServer: false })
  })
})
