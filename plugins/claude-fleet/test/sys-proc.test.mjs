import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  snapshotFrom, descendants, ancestors, depths, protectedSet, killPlan, hasSessionMarker,
  sessionLabelOf, tokenize, findByCommand, inDirectory, rssOf,
} from '../src/sys/proc.mjs'
import { killTree } from '../src/sys/kill.mjs'
import { parseWindowsJson, escapeControlBytes } from '../src/sys/proc-windows.mjs'
import { parseLinuxStat, parsePsOutput } from '../src/sys/proc-posix.mjs'

// A fixture that reproduces the kill-by-exclusion incident: the operator's own hour-old agent
// (pid 900) sits beside the fleet under the same terminal (pid 1) and must never be touched.
function fixture() {
  return snapshotFrom([
    { pid: 1, ppid: 0, name: 'terminal', cmd: 'WindowsTerminal.exe' },
    { pid: 10, ppid: 1, name: 'node', cmd: 'node shim.mjs --fleet-session=7 /s/sessions/7.json', startedAt: 100 },
    { pid: 11, ppid: 10, name: 'claude', cmd: 'claude --model opus', startedAt: 101 },
    { pid: 12, ppid: 11, name: 'node', cmd: 'node dev-hosts.mjs', startedAt: 102 },
    { pid: 13, ppid: 12, name: 'node', cmd: 'next dev', startedAt: 103 },
    { pid: 20, ppid: 1, name: 'node', cmd: 'node shim.mjs --fleet-session=70 /s/sessions/70.json', startedAt: 100 },
    { pid: 21, ppid: 20, name: 'claude', cmd: 'claude --model opus', startedAt: 101 },
    { pid: 900, ppid: 1, name: 'claude', cmd: 'claude weekly-demo', startedAt: 50 },
    { pid: 500, ppid: 1, name: 'powershell', cmd: 'powershell -Command Get-CimInstance Win32_Process | where CommandLine -like *fleet-session*' },
    { pid: 501, ppid: 500, name: 'node', cmd: 'node cli.mjs kill 7' },
  ])
}

test('descendants / ancestors / depths', () => {
  const s = fixture()
  assert.deepEqual(descendants(s, 10).sort((a, b) => a - b), [11, 12, 13])
  assert.deepEqual(ancestors(s, 13), [12, 11, 10, 1])
  const d = depths(s, 10)
  assert.equal(d.get(10), 0)
  assert.equal(d.get(13), 3)
})

test('descendants ignores a "child" whose start time precedes its parent (pid reuse)', () => {
  const s = snapshotFrom([
    { pid: 1, ppid: 0, cmd: 'init', startedAt: 10 },
    { pid: 5, ppid: 1, cmd: 'parent', startedAt: 200 },
    { pid: 6, ppid: 5, cmd: 'stale-child-of-a-reused-pid', startedAt: 150 },
    { pid: 7, ppid: 5, cmd: 'real-child', startedAt: 201 },
  ])
  assert.deepEqual(descendants(s, 5), [7])
})

test('killPlan: deepest first, only positively identified descendants, never self or ancestors', () => {
  const s = fixture()
  const { order, skippedProtected } = killPlan(s, 10, { selfPid: 501 })
  assert.deepEqual(order, [13, 12, 11, 10])
  assert.deepEqual(skippedProtected, [])
  // the sibling session, the operator's agent and the querying shell are untouched
  for (const p of [20, 21, 900, 500, 501, 1]) assert.ok(!order.includes(p), `pid ${p} must not be in the plan`)
})

test('killPlan: killing the terminal root from inside the fleet protects self + ancestors and reports them', () => {
  const s = fixture()
  const { order, skippedProtected } = killPlan(s, 1, { selfPid: 501 })
  assert.ok(!order.includes(501) && !order.includes(500) && !order.includes(1))
  assert.deepEqual(skippedProtected.sort((a, b) => a - b), [1, 500, 501])
  // the operator's session IS a descendant of the terminal — a root that broad is the caller's mistake,
  // which is why callers root at the shim pid, never the terminal
  assert.ok(order.includes(900))
})

test('protectedSet includes explicit extras', () => {
  const s = fixture()
  const p = protectedSet(s, 501, [900])
  assert.ok(p.has(900) && p.has(501) && p.has(500) && p.has(1))
})

test('session marker: exact token match, never substring — session 7 does not match 70', () => {
  const s = fixture()
  assert.ok(hasSessionMarker(s.get(10).cmd, 7))
  assert.ok(!hasSessionMarker(s.get(20).cmd, 7))
  assert.ok(hasSessionMarker(s.get(20).cmd, 70))
  assert.equal(sessionLabelOf(s.get(20).cmd), '70')
  assert.equal(sessionLabelOf('claude --model opus'), null)
  assert.ok(hasSessionMarker('node "shim.mjs" "--fleet-session=3"', 3))
  assert.deepEqual(tokenize('a "b c" d'), ['a', '"b c"', 'd'])
})

test('findByCommand excludes the querying shell and its ancestors (the self-match trap)', () => {
  const s = fixture()
  const naive = [...s.values()].filter(p => /fleet-session/.test(p.cmd)).map(p => p.pid)
  assert.ok(naive.includes(500), 'the naive filter self-matches the querying powershell')
  const safe = findByCommand(s, /fleet-session/, { selfPid: 501 }).map(p => p.pid).sort((a, b) => a - b)
  assert.deepEqual(safe, [10, 20])
})

test('inDirectory is boundary-safe: app-testing does not claim app-testing-2', () => {
  const s = snapshotFrom([
    { pid: 1, ppid: 0, cmd: 'node C:\\w\\app-testing\\node_modules\\.bin\\next dev' },
    { pid: 2, ppid: 0, cmd: 'node C:\\w\\app-testing-2\\node_modules\\.bin\\next dev' },
    { pid: 3, ppid: 0, cmd: 'node C:/w/app-testing/scripts/x.js' },
  ])
  assert.deepEqual(inDirectory(s, 'C:\\w\\app-testing').map(p => p.pid), [1, 3])
  assert.deepEqual(inDirectory(s, 'C:/w/app-testing-2').map(p => p.pid), [2])
})

test('rssOf sums', () => {
  const s = snapshotFrom([{ pid: 1, ppid: 0, cmd: '', rssBytes: 10 }, { pid: 2, ppid: 1, cmd: '', rssBytes: 5 }])
  assert.equal(rssOf(s, [1, 2, 99]), 15)
})

test('killTree dry-run returns the plan and touches nothing', () => {
  const s = fixture()
  const r = killTree(s, 10, { selfPid: 501, dryRun: true })
  assert.deepEqual(r.planned, [13, 12, 11, 10])
  assert.deepEqual(r.killed, [])
})

test('killTree reports survivors from the re-snapshot, never from the kill exit code', () => {
  const s = fixture()
  // pretend nothing died: the re-snapshot is identical
  const r = killTree(s, 10, { selfPid: 501, graceMs: 0, platform: 'linux', resnapshot: () => fixture() })
  // process.kill on nonexistent pids is ESRCH → treated as gone by the signal step, but the
  // re-snapshot still shows them → survivors is the truth
  assert.deepEqual(r.survivors.sort((a, b) => a - b), [10, 11, 12, 13])
})

test('a raw control byte in one command line does not blind the whole snapshot', () => {
  // ConvertTo-Json emits a raw newline/tab/escape inside a string instead of escaping it, so
  // JSON.parse rejects the WHOLE document — one unlucky process (a multi-line command, an editor,
  // an installer) would take every other process with it, and with them every kill plan and every
  // liveness check on the machine.
  const NL = String.fromCharCode(10)
  const raw = '[{"ProcessId":7,"ParentProcessId":1,"Name":"x.exe","CommandLine":"a' + NL + 'b","WorkingSetSize":5}]'
  assert.throws(() => JSON.parse(raw), /control character/i, 'the fixture reproduces the real failure')
  const list = parseWindowsJson(raw)
  assert.equal(list.length, 1)
  assert.equal(list[0].pid, 7)
  assert.equal(list[0].cmd, 'a' + NL + 'b', 'the command line survives, escaped rather than dropped')
  // A document that is not JSON at all is still an error — the repair must not swallow real
  // breakage, or a PowerShell that printed a stack trace would read as "no processes are running",
  // which every liveness check would believe.
  assert.throws(() => parseWindowsJson('At line:1 char:1 + Get-CimInstance : Access denied'), Error)
  assert.throws(() => parseWindowsJson('{"unterminated": '), Error)
  // escapeControlBytes emits the six-character JSON escape, which JSON.parse turns back into the
  // byte — so a command line is preserved exactly, never lost and never truncated at the byte.
  assert.equal(escapeControlBytes('"a' + NL + 'b"'), '"a' + String.fromCharCode(92) + 'u000ab"', 'a control byte inside a string is escaped')
  // ⛔ and a newline BETWEEN tokens is legal whitespace: escaping it turns a valid document into a
  // syntax error, so the repair must break nothing it touches.
  const pretty = '{' + NL + '  "a": 1,' + NL + '  "b": 2' + NL + '}'
  assert.equal(escapeControlBytes(pretty), pretty, 'whitespace between tokens is left alone')
  assert.deepEqual(JSON.parse(escapeControlBytes(pretty)), { a: 1, b: 2 })
  // A bare fragment is not a document: with no quote to open a string, the byte is not inside one,
  // so it is left exactly as it was. The repair reads JSON, it does not guess at intent.
  assert.equal(escapeControlBytes('a' + NL + 'b'), 'a' + NL + 'b')
})

test('parseWindowsJson accepts an array or a single collapsed object', () => {
  const one = parseWindowsJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'x.exe', CommandLine: 'x', WorkingSetSize: 100, Created: '2026-03-14T00:00:00Z' }))
  assert.equal(one.length, 1)
  assert.equal(one[0].pid, 5)
  assert.equal(one[0].startedAt, Date.parse('2026-03-14T00:00:00Z'))
  const many = parseWindowsJson(JSON.stringify([{ ProcessId: 5, ParentProcessId: 1 }, { ProcessId: 6, ParentProcessId: 5, CommandLine: null }]))
  assert.equal(many.length, 2)
  assert.equal(many[1].cmd, '')
})

test('parseLinuxStat splits around the LAST ")" so a comm with spaces/parens survives', () => {
  const p = parseLinuxStat('123 (my (weird) proc) S 100 123 123 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 98765 4096000 250 18446744073709551615')
  assert.equal(p.comm, 'my (weird) proc')
  assert.equal(p.ppid, 100)
  assert.equal(p.pgid, 123)
  assert.equal(p.startTicks, 98765)
  assert.equal(p.rssPages, 250)
})

test('parsePsOutput handles -ww wide args, and reads the state column', () => {
  const list = parsePsOutput('  100   1  100  2048 Ss   /usr/bin/node shim.mjs --fleet-session=3 /s/3.json\n  101 100  100  1024 Z    claude --model opus\n')
  assert.equal(list.length, 2)
  assert.equal(list[0].pgid, 100)
  assert.equal(list[0].rssBytes, 2048 * 1024)
  assert.equal(list[0].name, 'node')
  assert.ok(hasSessionMarker(list[0].cmd, 3))
  // The state column tells a live process from an exit status nobody has collected. It is the only
  // non-numeric field and it carries flags (`Ss`, `R+`), so it must not eat the args either.
  assert.equal(list[0].zombie, false)
  assert.equal(list[1].zombie, true)
  assert.equal(list[1].cmd, 'claude --model opus')
})

test('a zombie is GONE, not a survivor: a reaped-late pid must not fail a kill that worked', () => {
  // ⛔ The real incident, on both POSIX runners:
  //   kill reported failure: {"ok":false,"killed":[2744,2735],"survivors":[2735]}
  // 2735 was signalled, died, and was still in the next snapshot as a zombie because its parent had
  // not reaped it yet. Under load — and with tmux's `remain-on-exit on` holding dead panes — that is
  // ordinary, not exotic. A zombie runs no code and holds no port or lock, so reporting it as a
  // survivor makes `fleet kill` fail for a session that is genuinely gone, and `fleet down` then
  // refuses to remove a worktree nothing is using: a fleet that cannot be torn down because
  // everything worked.
  const live = () => snapshotFrom([
    { pid: 1, ppid: 0, cmd: 'init' },
    { pid: 10, ppid: 1, cmd: 'node shim.mjs --fleet-session=1 /s/1.json', startedAt: 100 },
    { pid: 11, ppid: 10, cmd: 'claude --model opus', startedAt: 101 },
  ])
  const reaped = () => snapshotFrom([{ pid: 1, ppid: 0, cmd: 'init' }])
  const zombies = () => snapshotFrom([
    { pid: 1, ppid: 0, cmd: 'init' },
    { pid: 10, ppid: 1, cmd: 'node shim.mjs --fleet-session=1 /s/1.json', startedAt: 100, state: 'Z', zombie: true },
    { pid: 11, ppid: 10, cmd: 'claude --model opus', startedAt: 101, state: 'Z', zombie: true },
  ])

  assert.deepEqual(killTree(live(), 10, { selfPid: 999, graceMs: 0, platform: 'linux', resnapshot: reaped }).survivors, [],
    'a pid that left the table entirely is gone')
  assert.deepEqual(killTree(live(), 10, { selfPid: 999, graceMs: 0, platform: 'linux', resnapshot: zombies }).survivors, [],
    'and so is one still listed as a zombie')
  // The rule still bites where it should — this must never become "assume the kill worked".
  const alive = killTree(live(), 10, { selfPid: 999, graceMs: 0, platform: 'linux', resnapshot: live })
  assert.deepEqual(alive.survivors.sort((a, b) => a - b), [10, 11])
})
