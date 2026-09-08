import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  parseJsonl, lastAssistantEntry, isApiError, classifyEntry, classify, stallKey, nudgePlan,
  credentialsFileFor, accountSignalFile, accountSwitchStep, initialAccountState, createAccountSwitchDetector,
  listTranscripts, transcriptCarriesCwd, transcriptDirFor, lastAssistantEntryOf,
  nudgePointer, nudgeMessage, writeNudgeFile, handleOf, sendNudge,
  scanSession, cacheTranscriptDir, stallScan, accountTick, createStallWatcher, initialStallState, heartbeatDue,
  DEFAULT_IDLE_THRESHOLD_MS, ALIVE_WITHIN_MS, DEFAULT_COOLDOWN_MS, DEFAULT_SETTLE_MS, DEFAULT_ACCOUNT_TICK_MS, DEFAULT_SCAN_INTERVAL_MS,
  HEARTBEAT_EVERY_SCANS, MESSAGES_DIR,
} from '../src/watchers/stalls.mjs'
import { createFakeBackend, injectFault } from '../src/backends/fake.mjs'
import { writeSession, readSession } from '../src/core/fleet.mjs'
import { transcriptSlug } from '../src/config/paths.mjs'

const T0 = Date.parse('2026-03-14T10:00:00Z')
const MIN = 60_000

/** A temp root that goes away with the test, however the test ends. */
function tmpRoot(t, prefix = 'fleet-stalls-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

// ---- transcript fixtures, shaped like the host writes them ---------------------------------------

const userEntry = (content, over = {}) => ({ type: 'user', isSidechain: false, userType: 'external', message: { role: 'user', content }, timestamp: new Date(T0).toISOString(), ...over })
const assistantEntry = (text, over = {}) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text }] }, timestamp: new Date(T0).toISOString(), ...over })
const toolUse = (over = {}) => assistantEntry('', { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/app/README.md' } }] }, ...over })
const toolResult = (text, over = {}) => userEntry([{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }], over)
/** A transient API error, exactly as the host records one: the structured flag plus the message. */
const apiError = (text = 'API Error: 529 Overloaded', over = {}) => assistantEntry(text, { isApiErrorMessage: true, apiErrorStatus: 529, error: 'overloaded', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }, ...over })
/** A usage limit, as the host records one: a 429, `error: rate_limit`, a rejected quota, the limit message. */
const usageLimit = (text = "You've hit your session limit · resets 6pm", over = {}) => apiError(text, { apiErrorStatus: 429, error: 'rate_limit', quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1773500400 }, ...over })

const jsonl = (...entries) => entries.map(e => JSON.stringify(e)).join('\n') + '\n'

/** Write a transcript for `worktree` under the transcript root, at the slug the host uses, with an explicit mtime. */
function writeTranscript(transcriptsDir, worktree, entries, { mtimeMs, name = 'session-1.jsonl', dir = null } = {}) {
  const d = dir || path.join(transcriptsDir, transcriptSlug(worktree))
  fs.mkdirSync(d, { recursive: true })
  const file = path.join(d, name)
  fs.writeFileSync(file, jsonl(...entries.map(e => ({ cwd: worktree, ...e }))))
  const at = new Date(mtimeMs)
  fs.utimesSync(file, at, at)
  return file
}

/** A fleet: a state dir, a transcript root, a fake backend, and N registered working sessions with worktrees. */
function fleet(t, labels = ['3']) {
  const root = tmpRoot(t)
  const stateDir = path.join(root, 'state')
  const transcriptsDir = path.join(root, 'projects')
  fs.mkdirSync(transcriptsDir, { recursive: true })
  const backend = createFakeBackend({ clock: () => T0 })
  const sessions = {}
  for (const label of labels) {
    const worktree = path.join(root, `app-session-${label}`)
    fs.mkdirSync(worktree, { recursive: true })
    const handle = backend.spawn({ id: label, role: 'working', title: `fleet ${label}`, cwd: worktree, env: [], command: 'node', args: ['shim.mjs', `--fleet-session=${label}`] })
    const descriptor = {
      id: label, label, role: 'working', worktree, branch: `ada/abc-${label}`, issue: 'ABC-1234',
      backendRef: handle.backendRef, shimPid: handle.shimPid, createdAt: new Date(T0 - 60 * MIN).toISOString(),
      transcriptDir: path.join(transcriptsDir, transcriptSlug(worktree)),
    }
    writeSession(descriptor, { stateDir })
    sessions[label] = { worktree, handle, descriptor }
  }
  return { root, stateDir, transcriptsDir, backend, sessions, registry: () => labels.map(l => readSession(l, { stateDir })) }
}

// ---- classification ------------------------------------------------------------------------------

test('an API-error last entry past the idle threshold is a stall, keyed on the error text', () => {
  // The incident: a session sat 26 minutes behind a green "ready" tab after its turn died on an API
  // error, having swallowed two injected messages; nothing in the fleet timed it out.
  const v = classify(apiError('API Error: Connection lost mid-response.'), { idleMs: 26 * MIN })
  assert.equal(v.stalled, true)
  assert.equal(v.kind, 'api-error')
  assert.equal(v.key, 'API Error: Connection lost mid-response.')
  assert.equal(v.text, 'API Error: Connection lost mid-response.')
  assert.equal(v.idleMs, 26 * MIN)
})

test('a quoted "529" or "API Error" anywhere but a structured error flag does NOT stall', () => {
  // The seeded prompt quotes those strings, tool results carry line numbers 528/529 and base64 blobs
  // contain any three digits — a substring grep matched EVERY session. Only the structure counts.
  const quotedInToolResult = [toolUse(), toolResult('528\tretry on "API Error: 529 Overloaded"\n529\tthrow e')]
  assert.equal(classify(lastAssistantEntry(quotedInToolResult), { idleMs: 30 * MIN }).stalled, false)

  const modelQuotesThePlaybook = assistantEntry('The playbook says: on "API Error: 529" or "session limit", relaunch. I will keep going.')
  assert.equal(classify(modelQuotesThePlaybook, { idleMs: 30 * MIN }).stalled, false)
  assert.equal(classifyEntry(modelQuotesThePlaybook).kind, 'none')

  const base64 = [toolUse(), userEntry([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAA529AAAB' } }])]
  assert.equal(classify(lastAssistantEntry(base64), { idleMs: 30 * MIN }).stalled, false)

  // a healthy entry that carries the field as null/false is healthy
  assert.equal(isApiError(assistantEntry('fine', { error: null, isApiErrorMessage: false })), false)
})

test('an earlier, since-recovered error in the tail is not a stall — only the LAST assistant entry is', () => {
  // A tail grep for the limit phrase once marked five healthy sessions dead: the window still held
  // an older error the session had already recovered from.
  const entries = [apiError('API Error: 529 Overloaded'), userEntry('continue'), assistantEntry('Resuming from my notes.'), toolUse(), toolResult('ok')]
  const last = lastAssistantEntry(entries)
  assert.equal(last.message.content[0].type, 'tool_use')
  assert.equal(classify(last, { idleMs: 30 * MIN }).stalled, false)
})

test('a usage limit is classified as usage-limit, by the rejected quota or by the entry\'s own wording', () => {
  // Two lookalikes handled oppositely: a transient error is nudged, a limit is account-level and
  // nothing bypasses it — relaunching hits the same wall.
  assert.equal(classifyEntry(usageLimit()).kind, 'usage-limit')
  // a host that recorded no quota object: the error entry's OWN text decides (never the transcript's)
  assert.equal(classifyEntry(apiError("You've hit your usage limit · resets 6pm", { apiErrorStatus: 429, error: 'rate_limit' })).kind, 'usage-limit')
  // a plain 429 with neither is a transient rate limit
  assert.equal(classifyEntry(apiError('API Error: 429 Too Many Requests', { apiErrorStatus: 429, error: 'rate_limit' })).kind, 'api-error')
  // a message that IS an error object, with no host flag at all
  assert.equal(classifyEntry({ type: 'assistant', message: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }).kind, 'api-error')
  assert.equal(classifyEntry({ type: 'assistant', message: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }).text, 'Overloaded')
})

test('the host\'s own error shapes, as observed on disk, classify by structure — and the entries that merely MENTION the flag do not', () => {
  // Verified against real transcripts (keys only): a usage limit is `isApiErrorMessage: true`,
  // `apiErrorStatus: 429`, `error: "rate_limit"`, `quotaLimits.status: "rejected"`, model `<synthetic>`;
  // a transient error is `isApiErrorMessage: true`, `error: "server_error"` and NO apiErrorStatus at
  // all. The same transcripts held a `user` entry and a `queue-operation` entry whose CONTENT carried
  // the string "isApiErrorMessage" — a grep for the flag name would have stalled a healthy session.
  const limit = {
    type: 'assistant', isSidechain: false, isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit',
    quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1773500400, isUsingOverage: false },
    message: { type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 2pm" }], stop_reason: 'end_turn' },
  }
  const transient = {
    type: 'assistant', isSidechain: false, isApiErrorMessage: true, error: 'server_error',
    message: { type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection lost mid-response.' }], stop_reason: 'end_turn' },
  }
  assert.deepEqual(classifyEntry(limit), { kind: 'usage-limit', text: "You've hit your session limit · resets 2pm" })
  assert.deepEqual(classifyEntry(transient), { kind: 'api-error', text: 'API Error: Connection lost mid-response.' })
  assert.equal(classify(transient, { idleMs: 26 * MIN }).key, 'API Error: Connection lost mid-response.', 'no status to key on: the text is the key')
  // the two lookalikes that only mention the flag
  const mentions = [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'grep the transcript for isApiErrorMessage and apiErrorStatus' } },
    { type: 'queue-operation', operation: 'enqueue', content: '{"isApiErrorMessage":true}' },
  ]
  assert.equal(lastAssistantEntry(mentions), null)
  assert.equal(classify(lastAssistantEntry([transient, ...mentions]), { idleMs: 26 * MIN }).stalled, true, 'trailing non-assistant entries do not hide the verdict')
  assert.equal(classify(lastAssistantEntry([...mentions, assistantEntry('carrying on')]), { idleMs: 26 * MIN }).stalled, false)
})

test('the dedup key is the error text only — the idle minutes never enter it', () => {
  // Folding the idle minutes into the key re-fired the alarm on every poll.
  const e = apiError('API Error: 529 Overloaded')
  const a = classify(e, { idleMs: 3 * MIN })
  const b = classify(e, { idleMs: 30 * MIN })
  const c = classify(e, { idleMs: 300 * MIN })
  assert.equal(a.key, b.key)
  assert.equal(b.key, c.key)
  assert.equal(a.key, 'API Error: 529 Overloaded')
  assert.notEqual(classify(apiError('API Error: 500 Internal server error'), { idleMs: 3 * MIN }).key, a.key)
  // an entry with no text still keys on something stable
  assert.equal(stallKey('api-error', '', { apiErrorStatus: 529 }), 'api-error:529')
  assert.equal(stallKey('api-error', '', { error: 'overloaded' }), 'api-error:overloaded')
  assert.equal(stallKey('api-error', '  API   Error  '), 'API   Error')
})

test('a transcript written within ~45 s is alive whatever its tail says, and the threshold has that floor', () => {
  const e = apiError()
  assert.equal(classify(e, { idleMs: 20_000 }).stalled, false)
  assert.equal(classify(e, { idleMs: 20_000, thresholdMs: 0 }).stalled, false, 'a threshold below the floor is raised to it')
  assert.equal(classify(e, { idleMs: ALIVE_WITHIN_MS + 1, thresholdMs: 0 }).stalled, true)
  assert.equal(classify(e, { idleMs: DEFAULT_IDLE_THRESHOLD_MS - 1 }).stalled, false)
  assert.equal(classify(e, { idleMs: DEFAULT_IDLE_THRESHOLD_MS }).stalled, true)
  assert.equal(classify(e, { idleMs: null }).stalled, false, 'unknown idle time is not a stall')
  assert.equal(classify(null, { idleMs: 30 * MIN }).stalled, false)
})

test('a sidechain (subagent) assistant entry is never the session\'s verdict', () => {
  // A subagent's error reaches the main session as a tool result it then acts on.
  const entries = [assistantEntry('Delegating.'), apiError('API Error: 529 Overloaded', { isSidechain: true })]
  assert.equal(lastAssistantEntry(entries).message.content[0].text, 'Delegating.')
  assert.equal(classify(lastAssistantEntry(entries), { idleMs: 30 * MIN }).stalled, false)
})

test('parseJsonl tolerates a torn last line and foreign lines', () => {
  // A live session is mid-write on the last line; one torn line must not hide the entries before it.
  const text = jsonl(assistantEntry('a'), apiError()) + '{"type":"assistant","mess'
  const entries = parseJsonl(text)
  assert.equal(entries.length, 2)
  assert.equal(classifyEntry(lastAssistantEntry(entries)).kind, 'api-error')
  assert.deepEqual(parseJsonl('not json\n[1,2]\n\n'), [])
})

// ---- nudge planning ------------------------------------------------------------------------------

test('a usage-limit stall is parked, never nudged; a transient stall is nudged once per cooldown', () => {
  const stalls = [
    { label: '3', stalled: true, kind: 'api-error', key: 'API Error: 529 Overloaded', text: 'API Error: 529 Overloaded', idleMs: 5 * MIN },
    { label: '4', stalled: true, kind: 'usage-limit', key: "You've hit your session limit", text: "You've hit your session limit", idleMs: 5 * MIN },
    { label: '5', stalled: false, kind: 'none', key: null, text: '', idleMs: 1 * MIN },
  ]
  const first = nudgePlan(stalls, {}, T0)
  assert.deepEqual(first.nudge.map(s => s.label), ['3'])
  assert.deepEqual(first.park.map(s => s.label), ['4'])
  assert.deepEqual(first.cooling, [])
  assert.equal(first.nudge[0].fresh, true)

  const cooldowns = { 3: { at: T0, key: 'API Error: 529 Overloaded', mtimeMs: null } }
  const reported = { ['3\u0000API Error: 529 Overloaded']: T0 }
  const soon = nudgePlan(stalls, cooldowns, T0 + 3 * MIN, { reported })
  assert.deepEqual(soon.nudge, [])
  assert.deepEqual(soon.cooling.map(s => s.label), ['3'])
  assert.equal(soon.cooling[0].fresh, false, 'the same (label, text) is not announced again')
  assert.equal(soon.cooling[0].retryInMs, DEFAULT_COOLDOWN_MS - 3 * MIN)
  assert.deepEqual(soon.park.map(s => s.label), ['4'], 'a usage limit is parked on every pass, never nudged')

  const later = nudgePlan(stalls, cooldowns, T0 + DEFAULT_COOLDOWN_MS, { reported })
  assert.deepEqual(later.nudge.map(s => s.label), ['3'])
  assert.deepEqual(nudgePlan(stalls, cooldowns, T0 + 3 * MIN, { cooldownMs: 2 * MIN }).nudge.map(s => s.label), ['3'], 'the cooldown is configurable')
})

// ---- the account switch --------------------------------------------------------------------------

test('the credentials file sits beside the transcripts and honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(credentialsFileFor({ platform: 'linux', env: {}, homedir: '/home/ada' }), '/home/ada/.claude/.credentials.json')
  assert.equal(credentialsFileFor({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ada' }), 'C:\\Users\\ada\\.claude\\.credentials.json')
  assert.equal(credentialsFileFor({ platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/opt/cfg' }, homedir: '/home/ada' }), '/opt/cfg/.credentials.json')
})

test('the signal is the ACCOUNT RECORD, not the credentials file — the credentials move on every token refresh', () => {
  // The credentials file is rewritten whenever the host or any MCP server refreshes an access token,
  // with no login anywhere: a watcher keyed on its mtime nudges every live session, mid-turn
  // included, on a routine refresh. The account record changes only on a login, a switch or a
  // logout — and unlike the keychain it is a real file on macOS too, so one signal serves everywhere.
  assert.deepEqual(accountSignalFile({ accountRecordFile: '/c/.claude.json' }), { file: '/c/.claude.json', source: 'account-record', reason: null })
  const off = accountSignalFile({})
  assert.equal(off.file, null)
  assert.match(off.reason, /no account record file/)
  const d = createAccountSwitchDetector({ accountRecordFile: null })
  const tick = d.tick(T0)
  assert.equal(tick.disabled, true, 'a detector with no file says so rather than pretending to watch')
  assert.equal(tick.event, null)
  assert.match(tick.reason, /no account record file/)
})

test('the first observation is a baseline, a change arms the settle, a change during the settle restarts it, and settling fires once', () => {
  // A watcher that read its first observation as a change would nudge the whole fleet on every
  // restart; a login rewrites the file more than once, so the settle restarts on each rewrite.
  let s = initialAccountState()
  let r = accountSwitchStep(s, 1000, T0)
  assert.equal(r.event, null, 'the baseline is not an event')
  s = r.state
  r = accountSwitchStep(s, 1000, T0 + 15_000)
  assert.equal(r.event, null)
  s = r.state
  r = accountSwitchStep(s, 2000, T0 + 30_000)
  assert.equal(r.event, 'switched')
  s = r.state
  assert.equal(s.pendingSince, T0 + 30_000)
  r = accountSwitchStep(s, 3000, T0 + 45_000) // a second rewrite of the same login
  assert.equal(r.event, 'switched')
  s = r.state
  assert.equal(s.pendingSince, T0 + 45_000, 'the settle restarted')
  r = accountSwitchStep(s, 3000, T0 + 55_000)
  assert.equal(r.event, null, 'not settled yet')
  s = r.state
  r = accountSwitchStep(s, 3000, T0 + 45_000 + DEFAULT_SETTLE_MS)
  assert.equal(r.event, 'settled')
  s = r.state
  assert.equal(s.pendingSince, null)
  r = accountSwitchStep(s, 3000, T0 + 120_000)
  assert.equal(r.event, null, 'settled fires once')
  assert.equal(s.switches, 2)

  // a logout removes the file: nothing to resume on, and a pending settle is dropped
  r = accountSwitchStep(accountSwitchStep(s, 4000, T0 + 130_000).state, null, T0 + 135_000)
  assert.equal(r.event, 'removed')
  assert.equal(r.state.pendingSince, null)
  assert.equal(accountSwitchStep(r.state, null, T0 + 200_000).event, null)
  // …and the next login is a switch again (null → mtime)
  assert.equal(accountSwitchStep(r.state, 5000, T0 + 210_000).event, 'switched')
  // a baseline of "absent" followed by a first login is a switch too
  const fromAbsent = accountSwitchStep(accountSwitchStep(initialAccountState(), null, T0).state, 7000, T0 + 15_000)
  assert.equal(fromAbsent.event, 'switched')
})

test('the account tick on a real file: a rewrite settles into a whole-fleet nudge that clears every cooldown', t => {
  // Twenty sessions sat frozen for an hour after a login: the file was rewritten, nothing typed into
  // any session, and the nudger kept nudging on cooldown into the exhausted account.
  const f = fleet(t, ['3', '4', '5'])
  // The ACCOUNT RECORD, not the credentials file: the credentials move on every token refresh.
  const accountFile = path.join(f.root, '.claude.json')
  fs.writeFileSync(accountFile, '{"oauthAccount":{"accountUuid":"a-1","organizationName":"acme","emailAddress":"ada@example.com"}}')
  fs.utimesSync(accountFile, new Date(T0 - 60 * MIN), new Date(T0 - 60 * MIN))
  const detector = createAccountSwitchDetector({ accountFile, settleMs: DEFAULT_SETTLE_MS })
  // session 5 is dead: the reclaimer's business, never nudged
  writeSession({ ...f.sessions['5'].descriptor, liveness: 'dead' }, { stateDir: f.stateDir })
  const notified = []
  const notify = (event, message) => notified.push({ event, message })
  let state = { ...initialStallState(), cooldowns: { 3: { at: T0 - MIN, key: 'API Error: 529 Overloaded', mtimeMs: 1 }, 4: { at: T0 - MIN, key: 'x', mtimeMs: 1 } } }

  const base = { detector, registry: f.registry(), stateDir: f.stateDir, backend: f.backend, notify }
  let r = accountTick({ ...base, nowMs: T0, state })
  assert.equal(r.event, null)
  assert.deepEqual(r.nudged, [])
  state = r.state
  r = accountTick({ ...base, nowMs: T0 + 15_000, state })
  assert.equal(r.event, null)

  // a different account signed in: a new identity, not merely a new token
  fs.writeFileSync(accountFile, '{"oauthAccount":{"accountUuid":"a-2","organizationName":"acme","emailAddress":"bo@example.com"}}')
  fs.utimesSync(accountFile, new Date(T0 + 20_000), new Date(T0 + 20_000))
  r = accountTick({ ...base, nowMs: T0 + 30_000, state })
  assert.equal(r.event, 'switched')
  assert.deepEqual(r.nudged, [], 'nothing is sent before the settle')
  assert.deepEqual(Object.keys(r.state.cooldowns), ['3', '4'], 'cooldowns survive until the nudge actually goes out')
  state = r.state
  r = accountTick({ ...base, nowMs: T0 + 40_000, state })
  assert.equal(r.event, null)
  assert.deepEqual(f.backend.buffer('3'), [])

  r = accountTick({ ...base, nowMs: T0 + 30_000 + DEFAULT_SETTLE_MS, state })
  assert.equal(r.event, 'settled')
  assert.deepEqual(r.nudged.map(n => n.label), ['3', '4'], 'the WHOLE live fleet, stalled or not; the dead session excluded')
  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.status, { kind: 'account-switch' })
  // Every prior cooldown is REPLACED by the switch nudge's own record: the old ones referred to a
  // stall just handled wholesale, and the new one is what stops an immediate re-nudge.
  assert.deepEqual(Object.keys(r.state.cooldowns).sort(), ['3', '4'])
  for (const label of ['3', '4']) assert.equal(r.state.cooldowns[label].key, 'account-switch')
  assert.equal(r.state.parked, false)
  for (const label of ['3', '4']) {
    const buf = f.backend.buffer(label)
    assert.equal(buf.length, 1)
    assert.match(buf[0], /^Read .+ now$/, 'the injected line is the short pointer, never prose')
    const file = buf[0].slice('Read '.length, -' now'.length)
    assert.ok(file.startsWith(path.join(f.stateDir, MESSAGES_DIR)), 'the message lives under the state dir')
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^continue\n/)
    assert.match(text, /account behind this fleet changed/)
  }
  assert.deepEqual(f.backend.buffer('5'), [])
  assert.deepEqual(notified.map(n => n.event), ['account-switch'])

  // the tick after that is quiet again
  assert.equal(accountTick({ ...base, nowMs: T0 + 120_000, state: r.state }).event, null)
})

// ---- transcripts on disk -------------------------------------------------------------------------

test('transcriptDirFor: the slug is verified, and a host that changed its rule is found by the cwd scan', t => {
  // The slug rule is the host's, not a contract's; after a host upgrade changed it the watcher read
  // the wrong directory. The `cwd` scan is authoritative and version-proof.
  const root = tmpRoot(t)
  const transcriptsDir = path.join(root, 'projects')
  const worktree = path.join(root, 'app-session-3')
  const other = path.join(root, 'app-session-30')

  assert.equal(transcriptDirFor(worktree, { transcriptsDir: null }).reason, 'paths.transcriptsDir is not resolved')
  assert.match(transcriptDirFor(worktree, { transcriptsDir }).reason, /does not exist/)
  fs.mkdirSync(transcriptsDir, { recursive: true })
  assert.match(transcriptDirFor(worktree, { transcriptsDir }).reason, /no transcript carries this worktree/)

  // the host used some other slug rule: the newest file carrying our cwd wins, a sibling's does not
  const foreignDir = path.join(transcriptsDir, 'some-other-slug-rule')
  const newest = writeTranscript(transcriptsDir, worktree, [userEntry('hi'), assistantEntry('hello')], { mtimeMs: T0 - 5 * MIN, dir: foreignDir, name: 'b.jsonl' })
  writeTranscript(transcriptsDir, worktree, [userEntry('hi'), assistantEntry('hello')], { mtimeMs: T0 - 50 * MIN, dir: foreignDir, name: 'a.jsonl' })
  writeTranscript(transcriptsDir, other, [userEntry('hi'), assistantEntry('hello')], { mtimeMs: T0 - MIN, dir: path.join(transcriptsDir, 'sibling-slug'), name: 'c.jsonl' })
  const scanned = transcriptDirFor(worktree, { transcriptsDir })
  assert.equal(scanned.dir, foreignDir)
  assert.equal(scanned.file, newest)
  assert.equal(scanned.source, 'scan')
  assert.equal(scanned.reason, null)
  assert.equal(typeof scanned.mtimeMs, 'number', 'the reader reports the mtime it read, so the caller need not stat again')

  // the slug directory, once it holds a transcript, is verified and preferred
  const slugFile = writeTranscript(transcriptsDir, worktree, [userEntry('hi')], { mtimeMs: T0 - 90 * MIN })
  const bySlug = transcriptDirFor(worktree, { transcriptsDir })
  assert.equal(bySlug.source, 'slug')
  assert.equal(bySlug.file, slugFile)

  // a cached hint is tried first; a stale hint with nothing in it falls through
  assert.equal(transcriptDirFor(worktree, { transcriptsDir, hint: foreignDir }).source, 'cached')
  assert.equal(transcriptDirFor(worktree, { transcriptsDir, hint: path.join(root, 'nowhere') }).source, 'slug')

  // subagent transcripts in a subdirectory are never the session's
  fs.mkdirSync(path.join(foreignDir, 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(foreignDir, 'subagents', 'agent-1.jsonl'), jsonl(apiError()))
  assert.deepEqual(listTranscripts(foreignDir).map(x => path.basename(x.file)), ['b.jsonl', 'a.jsonl'])
  assert.deepEqual(listTranscripts(path.join(root, 'absent')), [])
})

test('the cwd comparison is whole-path, separator- and case-blind on Windows', () => {
  const text = jsonl({ type: 'user', cwd: 'C:\\w\\app-session-3' })
  assert.equal(transcriptCarriesCwd(text, 'C:/w/app-session-3', 'win32'), true)
  assert.equal(transcriptCarriesCwd(text, 'c:/W/APP-SESSION-3/', 'win32'), true)
  assert.equal(transcriptCarriesCwd(text, 'C:/w/app-session-30', 'win32'), false, 'session 3 never claims session 30')
  assert.equal(transcriptCarriesCwd(text, 'C:/w/app-session', 'win32'), false)
  assert.equal(transcriptCarriesCwd(jsonl({ type: 'user', cwd: '/w/app' }), '/w/App', 'linux'), false, 'case matters on POSIX')
  assert.equal(transcriptCarriesCwd(text, '', 'win32'), false)
})

test('lastAssistantEntryOf reads from the end and widens past a huge trailing tool result, tolerating a torn last line', t => {
  // A fixed tail window answered "no assistant entry" for a session whose last turn ended in one
  // enormous tool result, and the stall behind it went unseen.
  const root = tmpRoot(t)
  const file = path.join(root, 'big.jsonl')
  const huge = 'x'.repeat(600 * 1024)
  fs.writeFileSync(file, jsonl(assistantEntry('early'), apiError('API Error: 529 Overloaded'), toolResult(huge)) + '{"type":"assistant","torn":tru')
  const found = lastAssistantEntryOf(file, { initialBytes: 4096 })
  assert.equal(found.isApiErrorMessage, true)
  assert.equal(classifyEntry(found).kind, 'api-error')
  // a window that starts mid-file discards its cut first line rather than parsing garbage
  assert.equal(lastAssistantEntryOf(file, { initialBytes: 300 * 1024 }).isApiErrorMessage, true)
  fs.writeFileSync(path.join(root, 'empty.jsonl'), '')
  assert.equal(lastAssistantEntryOf(path.join(root, 'empty.jsonl')), null)
  fs.writeFileSync(path.join(root, 'users-only.jsonl'), jsonl(userEntry('hi'), toolResult('x')))
  assert.equal(lastAssistantEntryOf(path.join(root, 'users-only.jsonl')), null)
})

// ---- the scan pass -------------------------------------------------------------------------------

test('a stalled session is nudged through the backend by file + pointer, a healthy one is left alone, and the nudge is not repeated inside the cooldown', t => {
  const f = fleet(t, ['3', '4'])
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError('API Error: 529 Overloaded')], { mtimeMs: T0 - 5 * MIN })
  writeTranscript(f.transcriptsDir, f.sessions['4'].worktree, [userEntry('go'), assistantEntry('working'), toolUse()], { mtimeMs: T0 - 20 * MIN })
  const logged = []
  const args = { registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, log: m => logged.push(m) }

  const first = stallScan({ ...args, nowMs: T0 })
  assert.deepEqual(first.stalls.map(s => s.label), ['3'])
  assert.deepEqual(first.nudged.map(s => s.label), ['3'])
  assert.deepEqual(first.failed, [])
  assert.equal(first.status, null)
  assert.equal(first.state.cooldowns['3'].key, 'API Error: 529 Overloaded')
  assert.equal(first.state.cooldowns['3'].at, T0)
  const buf = f.backend.buffer('3')
  assert.equal(buf.length, 1)
  assert.equal(buf[0], nudgePointer(first.nudged[0].file))
  assert.match(buf[0], /^Read .+ now$/)
  const text = fs.readFileSync(first.nudged[0].file, 'utf8')
  assert.match(text, /^continue\n/)
  assert.match(text, /API Error: 529 Overloaded/)
  assert.deepEqual(f.backend.buffer('4'), [], 'a healthy session receives nothing')
  const healthy = first.sessions.find(s => s.label === '4')
  assert.equal(healthy.verdict.stalled, false)
  // The fixture's descriptor already carries transcriptDir, so the reader answers from the cache —
  // which is the cache doing its job. What matters is that it found the right directory.
  assert.ok(['cached', 'slug'].includes(healthy.source))

  // three minutes later: still stalled, still cooling, NOT nudged again — and announced only once
  const second = stallScan({ ...args, nowMs: T0 + 3 * MIN, state: first.state })
  assert.deepEqual(second.nudged, [])
  assert.deepEqual(second.cooling.map(s => s.label), ['3'])
  assert.equal(second.cooling[0].fresh, false)
  assert.equal(f.backend.buffer('3').length, 1)
  assert.equal(logged.filter(l => /nudged \(Read/.test(l)).length, 1)

  // after the cooldown the same stall is nudged again
  const third = stallScan({ ...args, nowMs: T0 + DEFAULT_COOLDOWN_MS, state: second.state })
  assert.deepEqual(third.nudged.map(s => s.label), ['3'])
  assert.equal(f.backend.buffer('3').length, 2)
  assert.equal(third.state.scans, 3)
})

test('a nudge whose transcript never moved is reported as unacknowledged — the launcher\'s cue to relaunch', t => {
  // The written count proves delivery to the buffer, never consumption: twenty-two sessions each
  // returned a perfect "ok" for a nudge no transcript ever recorded. The transcript mtime is the proof.
  const f = fleet(t, ['3'])
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 5 * MIN })
  const args = { registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend }
  const first = stallScan({ ...args, nowMs: T0 })
  assert.deepEqual(first.unacknowledged, [])
  const second = stallScan({ ...args, nowMs: T0 + 3 * MIN, state: first.state })
  assert.deepEqual(second.unacknowledged.map(s => s.label), ['3'])
  assert.equal(second.unacknowledged[0].nudgedAt, new Date(T0).toISOString())

  // …and one whose transcript advanced past the nudge (the session acted, then errored again) is not
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError(), userEntry('Read x now'), assistantEntry('back'), apiError()], { mtimeMs: T0 + MIN })
  const third = stallScan({ ...args, nowMs: T0 + 4 * MIN, state: second.state })
  assert.deepEqual(third.cooling.map(s => s.label), ['3'])
  assert.deepEqual(third.unacknowledged, [])
})

test('a usage-limit stall parks the fleet: reported for status and the guardian, never nudged, notified once', t => {
  const f = fleet(t, ['3', '4'])
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), usageLimit()], { mtimeMs: T0 - 5 * MIN })
  writeTranscript(f.transcriptsDir, f.sessions['4'].worktree, [userEntry('go'), usageLimit()], { mtimeMs: T0 - 6 * MIN })
  const notified = []
  const args = { registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, notify: (e, m) => notified.push(e) }
  const r = stallScan({ ...args, nowMs: T0 })
  assert.deepEqual(r.parked.map(s => s.label), ['3', '4'])
  assert.deepEqual(r.nudged, [])
  assert.deepEqual(f.backend.buffer('3'), [])
  assert.deepEqual(f.backend.buffer('4'), [])
  assert.equal(r.status.kind, 'usage-limit')
  assert.deepEqual(r.status.labels, ['3', '4'])
  assert.match(r.status.text, /session limit/)
  assert.equal(r.state.parked, true)
  assert.deepEqual(notified, ['usage-limit'])
  const again = stallScan({ ...args, nowMs: T0 + 3 * MIN, state: r.state })
  assert.deepEqual(notified, ['usage-limit'], 'parked is notified on the transition, not on every poll')
  assert.equal(again.parked.every(s => s.fresh === false), true)
  assert.deepEqual(again.log.filter(l => /USAGE LIMIT/.test(l)), [], 'announced once per (label, text)')
})

test('a send the backend refuses or fails is reported per session and never aborts the fan-out', t => {
  const f = fleet(t, ['3', '4', '5'])
  for (const l of ['3', '4', '5']) writeTranscript(f.transcriptsDir, f.sessions[l].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 5 * MIN })
  // 3 carries a ref the backend never minted; 4 has no ref at all; 5 is fine
  writeSession({ ...f.sessions['3'].descriptor, backendRef: { ref: 'fake:not-minted' } }, { stateDir: f.stateDir })
  writeSession({ ...f.sessions['4'].descriptor, backendRef: null }, { stateDir: f.stateDir })
  const r = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 })
  assert.deepEqual(r.nudged.map(s => s.label), ['5'])
  assert.deepEqual(r.failed.map(s => s.label), ['3', '4'])
  assert.match(r.failed[0].error, /unknown backendRef/)
  assert.match(r.failed[1].error, /no backendRef/)
  assert.deepEqual(Object.keys(r.state.cooldowns), ['5'], 'a failed send is not a nudge, so no cooldown is recorded for it')

  // a short write is a failure the backend reports, and it is honoured
  injectFault(f.backend, { sendLimit: 10 })
  const s = sendNudge({ backend: f.backend, descriptor: f.sessions['5'].descriptor, stateDir: f.stateDir, text: 'continue', nowMs: T0 + 1 })
  assert.equal(s.ok, false)
  assert.equal(s.result.truncated, true)
  assert.equal(handleOf({ label: '9', role: 'working' }), null)
})

test('a dead session and a relaunched session whose transcript predates it are not stalls', t => {
  const f = fleet(t, ['3', '4'])
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 5 * MIN })
  writeTranscript(f.transcriptsDir, f.sessions['4'].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 5 * MIN })
  writeSession({ ...f.sessions['3'].descriptor, liveness: 'dead' }, { stateDir: f.stateDir })
  // 4 was relaunched two minutes ago into the same worktree and has not written yet: its
  // predecessor's last words are not its verdict
  writeSession({ ...f.sessions['4'].descriptor, startedAt: new Date(T0 - 2 * MIN).toISOString() }, { stateDir: f.stateDir })
  const r = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 })
  assert.deepEqual(r.stalls, [])
  assert.equal(r.sessions.find(s => s.label === '3').skipped, 'dead')
  assert.match(r.sessions.find(s => s.label === '4').reason, /predates this session/)
  assert.deepEqual(f.backend.buffer('3'), [])
  assert.deepEqual(f.backend.buffer('4'), [])
})

test('a transcript found by the cwd scan is cached in the descriptor, merged onto a fresh read', t => {
  // The scan reads the head of every transcript under the root; cached, it runs once, not every tick.
  const f = fleet(t, ['3'])
  const foreign = path.join(f.transcriptsDir, 'a-different-slug-rule')
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 5 * MIN, dir: foreign })
  // something else touched the descriptor in between (the shim writes its pids)
  writeSession({ ...f.sessions['3'].descriptor, agentPid: 4242 }, { stateDir: f.stateDir })
  const stale = [f.sessions['3'].descriptor] // the copy this pass was handed predates that write
  const r = stallScan({ registry: stale, stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 })
  assert.equal(r.sessions[0].source, 'scan')
  assert.equal(r.sessions[0].cacheDir, foreign)
  const after = readSession('3', { stateDir: f.stateDir })
  assert.equal(after.transcriptDir, foreign)
  assert.equal(after.agentPid, 4242, 'the concurrent write survived the merge')
  assert.deepEqual(r.nudged.map(s => s.label), ['3'])
  assert.equal(cacheTranscriptDir(f.stateDir, '3', foreign), false, 'already cached: nothing rewritten')
  assert.equal(cacheTranscriptDir(f.stateDir, '9', foreign), false, 'no such descriptor: nothing written')
  // the next pass uses the cache and does not scan
  const next = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 + MIN, state: r.state })
  assert.equal(next.sessions[0].source, 'cached')
  assert.equal(next.sessions[0].cacheDir, null)
})

test('a session with no transcript yet, or no transcript root, is reported and not stalled', t => {
  const f = fleet(t, ['3'])
  const r = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 })
  assert.equal(r.sessions[0].verdict.stalled, false)
  assert.match(r.sessions[0].reason, /no transcript carries/)
  const none = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: null, backend: f.backend, nowMs: T0 })
  assert.match(none.sessions[0].reason, /transcriptsDir is not resolved/)
  assert.equal(scanSession({ label: '7', role: 'working', worktree: null }, { transcriptsDir: f.transcriptsDir, nowMs: T0 }).reason, 'the descriptor names no worktree')
})

test('a clean scan heartbeats every Nth pass, so a quiet log is distinguishable from a dead watcher', t => {
  const f = fleet(t, ['3'])
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), assistantEntry('fine')], { mtimeMs: T0 - 30 * MIN })
  assert.equal(heartbeatDue(0), false)
  assert.equal(heartbeatDue(HEARTBEAT_EVERY_SCANS), true)
  assert.equal(heartbeatDue(HEARTBEAT_EVERY_SCANS + 1), false)
  assert.equal(heartbeatDue(3, 3), true)
  let state = initialStallState()
  const beats = []
  for (let i = 1; i <= 2 * HEARTBEAT_EVERY_SCANS; i++) {
    const r = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 + i * MIN, state })
    state = r.state
    if (r.heartbeat) beats.push(i)
    assert.equal(r.log.some(l => /heartbeat/.test(l)), r.heartbeat)
  }
  assert.deepEqual(beats, [HEARTBEAT_EVERY_SCANS, 2 * HEARTBEAT_EVERY_SCANS])
  assert.equal(state.lastHeartbeatAt, T0 + 2 * HEARTBEAT_EVERY_SCANS * MIN)
  // a stall resets the clean count
  writeTranscript(f.transcriptsDir, f.sessions['3'].worktree, [userEntry('go'), apiError()], { mtimeMs: T0 - 30 * MIN })
  state = stallScan({ registry: f.registry(), stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, nowMs: T0 + 30 * MIN, state }).state
  assert.equal(state.cleanScans, 0)
})

test('the watcher runs the credentials tick on its OWN fast interval, apart from the transcript scan', t => {
  // Riding the credentials check on the 180 s scan cost two and a half minutes of a twenty-session
  // freeze: the signal is one stat and belongs on a 15 s timer of its own.
  const f = fleet(t, ['3'])
  const timers = []
  const cleared = []
  let nextId = 1
  const setInterval = (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id }
  const clearInterval = id => cleared.push(id)
  const w = createStallWatcher({ stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, platform: 'linux', credentialsFile: path.join(f.root, '.credentials.json'), registry: f.registry, now: () => T0 })
  const h = w.start({ setInterval, clearInterval })
  assert.deepEqual(timers.map(x => x.ms).sort((a, b) => a - b), [DEFAULT_ACCOUNT_TICK_MS, DEFAULT_SCAN_INTERVAL_MS])
  assert.ok(DEFAULT_ACCOUNT_TICK_MS < DEFAULT_SCAN_INTERVAL_MS / 10)
  assert.deepEqual(h.intervals, { scanMs: DEFAULT_SCAN_INTERVAL_MS, accountMs: DEFAULT_ACCOUNT_TICK_MS })
  // both ticks run through the shared state
  for (const x of timers) x.fn()
  assert.equal(w.state.scans, 1)
  assert.equal(w.detector.state.observed, true)
  h.stop()
  assert.deepEqual(cleared.sort(), timers.map(x => x.id).sort())
  assert.throws(() => createStallWatcher({ transcriptsDir: f.transcriptsDir }), /stateDir is required/)
})

test('a failing tick is logged and does not end the watcher', t => {
  const f = fleet(t, ['3'])
  const logged = []
  const w = createStallWatcher({
    stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, platform: 'linux', credentialsFile: path.join(f.root, '.credentials.json'),
    registry: () => { throw new Error('registry unreadable') }, now: () => T0, log: m => logged.push(m),
  })
  const fns = []
  w.start({ setInterval: fn => { fns.push(fn); return 1 }, clearInterval: () => {} })
  for (const fn of fns) fn()
  assert.equal(logged.filter(l => /tick failed: registry unreadable/.test(l)).length, 2)
})

test('a watcher with no account record announces that switch detection is off, once, at creation', t => {
  // The record is a plain file on every platform, macOS included — so detection is off only when
  // no record path is known at all, never merely because of the platform.
  const f = fleet(t, ['3'])
  const logged = []
  // accountFile defaults to the account record, so "off" means no record path resolves at all —
  // an empty home with no CLAUDE_CONFIG_DIR, which is what a stripped CI container looks like.
  const w = createStallWatcher({ stateDir: f.stateDir, transcriptsDir: f.transcriptsDir, backend: f.backend, accountFile: null, env: {}, homedir: '', log: m => logged.push(m), now: () => T0 })
  assert.equal(logged.length, 1)
  assert.match(logged[0], /detection is OFF/)
  assert.equal(w.accountTick(T0).disabled, true)
})

// ---- the nudge file ------------------------------------------------------------------------------

test('nudge files are never overwritten, and the message is short, actionable and starts with "continue"', t => {
  const root = tmpRoot(t)
  const a = writeNudgeFile(root, '3', 'one', T0)
  const b = writeNudgeFile(root, '3', 'two', T0)
  assert.notEqual(a, b)
  assert.equal(fs.readFileSync(a, 'utf8'), 'one')
  assert.equal(fs.readFileSync(b, 'utf8'), 'two')
  assert.ok(!path.basename(a).includes(':'), 'a filesystem-safe name on every platform')
  assert.equal(nudgePointer(a), `Read ${a} now`)
  const m = nudgeMessage({ kind: 'api-error', text: 'API Error: 529 Overloaded', at: '2026-03-14T10:00:00.000Z', idleMs: 5 * MIN })
  assert.match(m, /^continue\n\n/)
  assert.match(m, /API Error: 529 Overloaded/)
  assert.match(m, /5 min/)
  assert.match(m, /Do not restart the ticket/)
  assert.match(nudgeMessage({ kind: 'account-switch', at: '2026-03-14T10:00:00.000Z' }), /^continue\n\n.*account behind this fleet changed at 2026-03-14T10:00:00.000Z/)
})
