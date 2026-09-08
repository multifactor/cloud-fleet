// Stall detection and nudging for an unattended fleet. Token-free on purpose: it must keep working
// at the usage limit, which is exactly when API errors cluster.
//
// The flag watcher sees only the files a session CHOOSES to write. A session whose turn died on an
// API error never runs again and never writes a flag — one sat idle 26 minutes behind a green
// "ready" indicator and swallowed two injected messages — so this watcher reads TRANSCRIPTS: the
// newest `.jsonl` in each session's transcript directory, classified by its LAST ASSISTANT ENTRY.
// Every rule here is a run that went wrong, and each is stated where it is enforced:
//
//   * an entry is an API error by a STRUCTURED field, never by a substring grep for "API Error",
//     "529" or the limit phrase across the transcript — the seeded prompt quotes those strings, tool
//     results carry line numbers, a base64 image contains any three digits, and a tail window still
//     holding an EARLIER, since-recovered error once marked five healthy sessions dead;
//   * a transcript written within ~45 s is alive whatever its tail says, so the idle threshold has
//     a floor;
//   * the dedup key is the ERROR TEXT only — folding the idle minutes into it re-fires the alarm on
//     every poll;
//   * a transient API error is nudged (a nudge is non-destructive, so the flag alone gates it, on a
//     per-session cooldown); a usage limit is NEVER nudged — it is account-level, nothing bypasses
//     it, and relaunching hits the same wall — it is reported so the fleet parks;
//   * an account switch nudges the WHOLE fleet after a short settle and replaces every cooldown with
//     the switch nudge's own record — a login does not resume a parked fleet on its own: twenty
//     sessions sat frozen for an hour after one, while the nudger kept nudging into an exhausted
//     account;
//   * the switch signal is the ACCOUNT, never a write: the host's account record
//     (`<CLAUDE_CONFIG_DIR or ~>/.claude.json`, its `oauthAccount` block) changes only on a login, a
//     switch or a logout, and it is a file on every platform, macOS included. The credentials file
//     is NOT the signal — the host rewrites it on every access-token refresh (its own and every MCP
//     server's) with no login anywhere, and a watcher keyed on that mtime would nudge every live
//     session, mid-turn included, on a routine refresh. The record's mtime is only the cheap
//     "something changed, now compare" trigger, polled on its OWN fast tick — riding it on the
//     transcript scan cost two and a half minutes of a twenty-session freeze;
//   * a nudge is proven by the transcript mtime ADVANCING, never by the send's return code — so
//     every nudge, the fleet-wide one included, records the mtime it saw, and a session still on
//     the same error at that mtime is reported as a dead turn (the relaunch cue), never nudged
//     again as if fresh and never parked again as if quota had just run out;
//   * a nudge travels as a FILE plus the short pointer `Read <path> now`, never as prose — console
//     injection writes what fits in the input buffer and submits the fragment.
//
// Split like the rest of the plugin: parseJsonl, lastAssistantEntry, classifyEntry, classify,
// nudgePlan, accountRecordFileFor, accountIdentityOf and accountSwitchStep are PURE over injected
// data; the file readers, the per-pass transcript index and the sends are thin wrappers whose side
// effects are injected.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { transcriptSlug } from '../config/paths.mjs'
import { listSessions, readSession, writeSession } from '../core/fleet.mjs'

/** The transcript scan: ~20 files read per tick, so a few minutes (no contract key exists yet). */
export const DEFAULT_SCAN_INTERVAL_MS = 180_000

/** The account-record tick: one stat, on its own timer — a slow signal cost minutes of a freeze. */
export const DEFAULT_ACCOUNT_TICK_MS = 15_000

/** How long after the account changes before the fleet is nudged: a login writes more than one file. */
export const DEFAULT_SETTLE_MS = 20_000

/** Idle time past which an API-error last entry counts as a stall — "a couple of idle minutes". */
export const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60_000

/** A transcript written within this is alive whatever its tail says; the threshold never goes below it. */
export const ALIVE_WITHIN_MS = 45_000

/** A session is re-nudged no oftener than this (no contract key exists yet). */
export const DEFAULT_COOLDOWN_MS = 10 * 60_000

/** A clean scan logs nothing, which reads identically to a dead watcher — so every Nth one heartbeats. */
export const HEARTBEAT_EVERY_SCANS = 10

/**
 * `<stateDir>/messages/` — where a pointed-at nudge is written. Not in contract §4's layout table
 * (a recorded gap): src/backends/registry-first.mjs spells the same folder for its own pointed-at
 * messages, and the one constant belongs in config/paths.stateLayout once §4 lists it.
 */
export const MESSAGES_DIR = 'messages'

/** The cooldown key the fleet-wide account-switch nudge is recorded under (a stall nudge keys on its error text). */
export const ACCOUNT_SWITCH_KEY = 'account-switch'

// ---- pure: the transcript --------------------------------------------------------------------------

/**
 * Parse JSONL text into entries. A line that does not parse is skipped, not fatal: the last line is
 * routinely torn (the session is writing it right now, or a byte window cut it), and one torn line
 * must not hide the entries before it.
 */
export function parseJsonl(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const j = JSON.parse(s)
      if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j)
    } catch {
      // torn or foreign line
    }
  }
  return out
}

/**
 * The session's OWN assistant entries. A sidechain entry belongs to a subagent, whose error reaches
 * the main session as a tool result it then acts on — judging the main session by a subagent's
 * last words would stall a session that is busy handling exactly that.
 */
export function isAssistantEntry(entry) {
  return !!entry && typeof entry === 'object' && entry.type === 'assistant' && entry.isSidechain !== true
}

/** The last assistant entry, or null. Everything after it (tool results, progress lines) is not a verdict. */
export function lastAssistantEntry(entries) {
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    if (isAssistantEntry(entries[i])) return entries[i]
  }
  return null
}

/**
 * Is this entry an API error? By STRUCTURE only: the host's `isApiErrorMessage` flag, an HTTP status
 * it recorded, an error code it recorded, or a message that IS an error object. The text of the
 * entry decides nothing here — an assistant that merely quotes "API Error: 529" (the seeded prompt
 * does) is working, not stalled.
 */
export function isApiError(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.isApiErrorMessage === true) return true
  if (Number.isInteger(entry.apiErrorStatus)) return true
  if (typeof entry.error === 'string' && entry.error.trim() !== '') return true
  const m = entry.message
  if (!m || typeof m !== 'object') return false
  return m.type === 'error' || (m.error !== null && typeof m.error === 'object')
}

/** The error entry's own text, whitespace-collapsed. Empty when the entry carries none. */
export function errorTextOf(entry) {
  const m = entry && typeof entry === 'object' ? entry.message : null
  let text = ''
  if (m && typeof m === 'object') {
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) {
      text = m.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
    }
    if (!text.trim() && m.error && typeof m.error === 'object' && typeof m.error.message === 'string') text = m.error.message
  }
  if (!text.trim() && entry && typeof entry.error === 'string') text = entry.error
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * The limit wording, applied ONLY to an entry already known to be an API error by structure. A
 * host that records `quotaLimits.status: "rejected"` needs no wording at all; the pattern is the
 * fallback for a host that recorded nothing but the message.
 *
 * ⛔ Every alternative names a QUOTA: "limit reached" on its own also reads "Rate limit reached",
 * "Context window limit reached" and "the model output limit reached" — transient errors a nudge
 * recovers — and a 429 worded that way through a proxy would have parked the whole fleet.
 */
export const USAGE_LIMIT_TEXT = /\b(?:session|usage|weekly|daily|monthly|plan|spending|\d+-hour)\s+limit\b|\bhit your\b[^.]*\blimit\b|\bout of (?:extra )?usage\b/i

/**
 * PURE. `api-error` (transient: overloaded, timeout, connection lost — the turn is dead, a nudge or
 * a relaunch recovers it), `usage-limit` (account-level: nothing bypasses it), or `none`. The
 * host's own quota verdict is read first; the wording decides only when the host recorded none.
 * @returns {{kind: 'api-error'|'usage-limit'|'none', text: string}}
 */
export function classifyEntry(entry) {
  if (!isApiError(entry)) return { kind: 'none', text: '' }
  const text = errorTextOf(entry)
  const quota = entry.quotaLimits
  if (quota && typeof quota === 'object' && quota.status === 'rejected') return { kind: 'usage-limit', text }
  if (USAGE_LIMIT_TEXT.test(text)) return { kind: 'usage-limit', text }
  return { kind: 'api-error', text }
}

/**
 * The dedup key: the ERROR TEXT, and nothing that changes between polls. ⛔ Folding the idle
 * minutes in made the alarm re-fire on every poll. An entry with no text keys on its status or
 * code, which are equally stable.
 */
export function stallKey(kind, text, entry = null) {
  const t = String(text || '').trim()
  if (t) return t
  const e = entry && typeof entry === 'object' ? entry : {}
  return `${kind}:${Number.isInteger(e.apiErrorStatus) ? e.apiErrorStatus : typeof e.error === 'string' && e.error ? e.error : 'unknown'}`
}

/** The per-session dedup identity of a stall report. */
export function dedupKey(label, key) {
  return `${label}\u0000${key}`
}

/**
 * PURE. Is this session stalled? Iff its LAST assistant entry is an API error AND its transcript
 * has been idle past the threshold. The threshold never drops below ALIVE_WITHIN_MS: a session
 * writing within ~45 s is alive whatever its tail says.
 * @param {object|null} entry  the last assistant entry (lastAssistantEntry / lastAssistantEntryOf)
 * @param {{idleMs: number|null, thresholdMs?: number}} o  idle time since the transcript's last write
 * @returns {{stalled: boolean, kind: string, key: string|null, text: string, idleMs: number|null, reason: string}}
 */
export function classify(entry, { idleMs = null, thresholdMs = DEFAULT_IDLE_THRESHOLD_MS } = {}) {
  const { kind, text } = classifyEntry(entry)
  if (kind === 'none') {
    return { stalled: false, kind, key: null, text: '', idleMs: finiteOrNull(idleMs), reason: entry ? 'the last assistant entry is not an API error' : 'no assistant entry' }
  }
  const key = stallKey(kind, text, entry)
  const idle = finiteOrNull(idleMs)
  const floor = Math.max(Number(thresholdMs) || 0, ALIVE_WITHIN_MS)
  if (idle === null) return { stalled: false, kind, key, text, idleMs: null, reason: 'the transcript\'s idle time is unknown' }
  if (idle < floor) {
    return { stalled: false, kind, key, text, idleMs: idle, reason: `the transcript was written ${Math.round(idle / 1000)}s ago — alive whatever its tail says (threshold ${Math.round(floor / 1000)}s)` }
  }
  return { stalled: true, kind, key, text, idleMs: idle, reason: `${kind} on the last assistant entry, idle ${Math.round(idle / 60_000)} min` }
}

function finiteOrNull(n) {
  return Number.isFinite(n) ? Number(n) : null
}

// ---- pure: who to nudge ----------------------------------------------------------------------------

/**
 * PURE. Sort stalls into nudge / park / cooling / unacknowledged.
 *
 * ⛔ A usage-limit stall is never nudged: the limit is account-level and nothing bypasses it, so a
 * nudge into it is consumed and lost while reporting motion. It is PARKED — reported for `fleet
 * status` and the guardian — and resumed only by the account-switch nudge.
 *
 * A transient stall is nudged unless this session was nudged within `cooldownMs` — the fleet-wide
 * account-switch nudge counts, it is a nudge. `fresh` says whether this (label, error text) has been
 * reported before, so a stall is announced once and not on every poll.
 *
 * A stall still on the same error, with the transcript mtime it had when it was last nudged (by a
 * stall nudge on that error, or by the account-switch nudge), was never woken by that nudge: the
 * turn is dead and only `fleet relaunch` recovers it — `unacknowledged`, the launcher's cue. A
 * transient one is still cooled or re-nudged as usual (a nudge is non-destructive). ⛔ A usage-limit
 * one is NOT parked again: its limit entry predates the switch that nudged it, and re-parking it
 * would announce "the fleet is parked until quota returns" on the scan right after quota returned —
 * and keep the fleet parked, on one dead turn, forever.
 * @param {Array<{label, stalled, kind, key, text, idleMs, mtimeMs?}>} stalls
 * @param {{[label: string]: {at: number, key: string, mtimeMs?: number|null}}} cooldowns
 * @returns {{nudge: Array, park: Array, cooling: Array, unacknowledged: Array}}
 */
export function nudgePlan(stalls, cooldowns = {}, nowMs = Date.now(), { cooldownMs = DEFAULT_COOLDOWN_MS, reported = {} } = {}) {
  const nudge = []
  const park = []
  const cooling = []
  const unacknowledged = []
  for (const s of stalls || []) {
    if (!s || !s.stalled) continue
    const label = String(s.label)
    const item = { ...s, label, fresh: reported[dedupKey(label, s.key)] === undefined }
    const cd = cooldowns && cooldowns[label]
    const at = cd ? Number(cd.at) : NaN
    const sameNudge = !!cd && (cd.key === s.key || cd.key === ACCOUNT_SWITCH_KEY) && Number.isFinite(cd.mtimeMs) && Number.isFinite(s.mtimeMs) && cd.mtimeMs === s.mtimeMs
    if (sameNudge) {
      unacknowledged.push({ ...item, nudgedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, nudge: cd.key === ACCOUNT_SWITCH_KEY ? 'account-switch' : 'stall' })
    }
    if (s.kind === 'usage-limit') {
      if (!sameNudge) park.push(item)
      continue
    }
    if (Number.isFinite(at) && nowMs - at < cooldownMs) {
      cooling.push({ ...item, retryInMs: cooldownMs - (nowMs - at) })
      continue
    }
    nudge.push(item)
  }
  return { nudge, park, cooling, unacknowledged }
}

// ---- pure: the account switch ----------------------------------------------------------------------

/**
 * The host's account record: `<CLAUDE_CONFIG_DIR or ~>/.claude.json`. Its `oauthAccount` block names
 * the logged-in account and is rewritten by a login, a switch or a logout — and by nothing else,
 * which is what makes it the signal. The credentials file beside the transcripts is NOT: the host
 * rewrites it on every access-token refresh. PURE — platform, env and homedir injected, like
 * config/paths.mjs. Not a contract §3 key (recorded as a gap).
 */
export function accountRecordFileFor({ platform = process.platform, env = {}, homedir = '' } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = env.CLAUDE_CONFIG_DIR || homedir
  // With neither a config dir nor a home, `join` would yield the bare relative name `.claude.json`,
  // and the watcher would then stat whatever file happens to sit in its working directory — a
  // detector pointed at the wrong file is worse than one that says it is off.
  if (!base) return null
  return p.join(base, '.claude.json')
}

/**
 * PURE. The credentials file — kept only so a caller can NAME it, never to watch it.
 *
 * ⛔ This is NOT the account-switch signal, and watching it is the trap this module exists to avoid:
 * the host rewrites it on every access-token refresh, its own and every MCP server's, with no login
 * anywhere. A watcher keyed on that mtime nudges every live session — mid-turn included — on a
 * routine refresh. `accountRecordFileFor()` is the signal; it changes only on a login, a switch or a
 * logout, and it is a real file on every platform, macOS included.
 */
export function credentialsFileFor({ platform = process.platform, env = {}, homedir = '' } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const base = env.CLAUDE_CONFIG_DIR || p.join(homedir, '.claude')
  return p.join(base, '.credentials.json')
}

/**
 * PURE. Which file actually signals an account switch: the account RECORD, on every platform.
 *
 * An earlier design watched the credentials file and fell back to a SessionStart marker on macOS,
 * where the credentials live in the keychain. The record supersedes both — it is a plain file
 * everywhere, and unlike the credentials it does not move on a token refresh.
 *
 * @returns {{file: string|null, source: 'account-record'|null, reason: string|null}}
 */
export function accountSignalFile({ accountRecordFile = null } = {}) {
  if (accountRecordFile) return { file: accountRecordFile, source: 'account-record', reason: null }
  return { file: null, source: null, reason: 'no account record file was given — account switches cannot be detected' }
}

/**
 * PURE. The account identity the record's text carries: `oauthAccount`'s account, organisation and
 * email, joined — a different organisation on the same login is a different quota. `null` is "no
 * account" (a record with no oauthAccount block: logged out). `undefined` is "not an observation":
 * the text is not a JSON object, which is what a read mid-write returns — the caller keeps its last
 * reading and asks again next tick, rather than treating a torn write as a logout.
 * @returns {string|null|undefined}
 */
export function accountIdentityOf(text) {
  let j
  try {
    j = JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const a = j.oauthAccount
  if (!a || typeof a !== 'object') return null
  const parts = ['accountUuid', 'organizationUuid', 'emailAddress'].map(k => (typeof a[k] === 'string' ? a[k].trim() : '')).filter(Boolean)
  return parts.length ? parts.join('|') : null
}

export function initialAccountState() {
  return { observed: false, identity: null, pendingSince: null, switches: 0, lastSwitchAt: null }
}

/**
 * PURE. One observation of the account identity (null = no account; undefined = no observation).
 *
 * The first observation is the baseline and never an event: a watcher that treated its first
 * reading as a change would nudge the whole fleet on every restart. A later change of IDENTITY arms
 * a settle (`switched`) — a rewrite that carries the same account (a token refresh, a config save,
 * a re-login on the same account, which restores no quota) is nothing; a change during the settle
 * restarts it, because a login writes more than one file; once the settle has elapsed the event is
 * `settled` — the caller's cue to nudge the whole fleet. An account that disappears is a logout
 * (`removed`): nothing to resume on, and a pending settle is dropped rather than nudging into no
 * account at all.
 * @returns {{state: object, event: null|'switched'|'settled'|'removed'}}
 */
export function accountSwitchStep(state, identity, nowMs, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  const next = { ...(state || initialAccountState()) }
  let event = null
  if (identity !== undefined) {
    const cur = identity === null ? null : String(identity)
    if (!next.observed) {
      next.observed = true
      next.identity = cur
    } else if (cur !== next.identity) {
      next.identity = cur
      if (cur === null) {
        next.pendingSince = null
        event = 'removed'
      } else {
        next.pendingSince = nowMs
        next.switches += 1
        next.lastSwitchAt = nowMs
        event = 'switched'
      }
    }
  }
  if (event === null && next.pendingSince !== null && nowMs - next.pendingSince >= settleMs) {
    next.pendingSince = null
    event = 'settled'
  }
  return { state: next, event }
}

// ---- thin: files -----------------------------------------------------------------------------------

/** mtime in ms, or null when the file is absent (or unreadable — a stat that fails is "no signal"). */
export function mtimeOf(file) {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false })
    return st ? st.mtimeMs : null
  } catch {
    return null
  }
}

/** A file's text, or '' when unreadable — which accountIdentityOf reads as "not an observation". */
export function readTextOf(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The top-level `.jsonl` files of one transcript directory, newest first. Top-level only: the
 * host keeps subagent transcripts in a subdirectory, and a subagent's file is never the session's
 * verdict. A missing directory is an empty list — a session that has not written yet has none.
 * @returns {Array<{file: string, mtimeMs: number}>}
 */
export function listTranscripts(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
    throw e
  }
  const out = []
  for (const e of entries) {
    if (!e.name.endsWith('.jsonl') || e.isDirectory()) continue
    const file = path.join(dir, e.name)
    const m = mtimeOf(file)
    if (m !== null) out.push({ file, mtimeMs: m })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** The newest transcript in `dir`, or null. */
export function newestTranscript(dir) {
  return listTranscripts(dir)[0] || null
}

/** The first `bytes` of a file as text; '' when unreadable. */
function readHead(file, bytes) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const n = Math.min(size, bytes)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, 0)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/**
 * One pass's view of the transcript root, built LAZILY and at most once: every top-level `.jsonl`
 * under every project directory, newest first, and each file's head read once. ⛔ Per pass, never
 * per session: at launch every session is transcript-less, and a root sweep per session per pass
 * was N readdir-and-stat passes over the directory that holds every transcript on the machine,
 * every three minutes.
 */
export function createTranscriptIndex(transcriptsDir) {
  let files
  const heads = new Map()
  return {
    /** Every transcript under the root, newest first; null when the root does not exist. */
    files() {
      if (files !== undefined) return files
      let projects
      try {
        projects = fs.readdirSync(transcriptsDir, { withFileTypes: true })
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return (files = null)
        throw e
      }
      const out = []
      for (const e of projects) {
        if (e.isDirectory()) out.push(...listTranscripts(path.join(transcriptsDir, e.name)))
      }
      return (files = out.sort((a, b) => b.mtimeMs - a.mtimeMs))
    },
    /** The first `bytes` of `file`, read once per pass. */
    head(file, bytes) {
      if (!heads.has(file)) heads.set(file, readHead(file, bytes))
      return heads.get(file)
    },
  }
}

/** Separator-blind; case-blind where the default filesystem is (Windows, and APFS on macOS). */
function normPath(p, platform) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/(?!^)\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
}

/**
 * The path as the filesystem spells it (symlinks and junctions resolved), or the path as given when
 * it cannot be resolved. The host records `process.cwd()`, which on POSIX is the REAL path: a
 * worktree under `/tmp` is recorded under `/private/tmp` on macOS, and any symlinked worktree
 * parent differs the same way — so the descriptor's spelling alone never matched.
 */
export function canonicalPath(p) {
  try {
    return fs.realpathSync.native(String(p))
  } catch {
    return String(p)
  }
}

/** The descriptor's spelling of the worktree and the filesystem's, deduplicated, descriptor first. */
function spellingsOf(worktree) {
  const raw = String(worktree)
  const real = canonicalPath(raw)
  return real === raw ? [raw] : [raw, real]
}

/**
 * PURE. Do these transcript entries carry `worktree` (one spelling, or any of several) as their
 * `cwd`? Whole-path, separator-blind, and case-blind on Windows and macOS — the host records
 * `C:\\w\\app` where Node builds `C:/w/app`.
 */
export function transcriptCarriesCwd(text, worktree, platform = process.platform) {
  const want = new Set((Array.isArray(worktree) ? worktree : [worktree]).map(w => normPath(w, platform)).filter(Boolean))
  if (!want.size) return false
  return parseJsonl(text).some(e => typeof e.cwd === 'string' && want.has(normPath(e.cwd, platform)))
}

/**
 * Where this worktree's transcripts are, and the newest one.
 *
 * The slug rule (config/paths.transcriptSlug) is the host's and not part of any contract, so it is
 * VERIFIED — a directory that holds a transcript of THIS session — and otherwise the transcript
 * root is scanned for the newest `.jsonl` whose entries carry the worktree as `cwd`, which is
 * authoritative and version-proof. A cached answer (`hint`, the descriptor's or the watcher's) is
 * tried first. Both spellings of the worktree are tried, the descriptor's and the filesystem's.
 *
 * ⛔ `startedAt` bounds every candidate: a transcript older than the session's own start is its
 * PREDECESSOR's (a relaunched agent into the same worktree that has not written yet) and a
 * directory holding only those is "nothing here", so a stale hint falls through to the scan instead
 * of answering for the rest of the run; and the scan reads no head older than the session, which is
 * what keeps a miss cheap on a machine with thousands of transcripts.
 * @param {{transcriptsDir, platform?, hint?, headBytes?, startedAt?: number|null, index?}} o
 *   `index` is the pass's createTranscriptIndex — one per pass, shared across sessions.
 * @returns {{dir: string|null, file: string|null, mtimeMs: number|null, source: 'cached'|'slug'|'scan'|null, reason: string|null}}
 */
export function transcriptDirFor(worktree, { transcriptsDir, platform = process.platform, hint = null, headBytes = 64 * 1024, startedAt = null, index = null } = {}) {
  if (!transcriptsDir) return { dir: null, file: null, mtimeMs: null, source: null, reason: 'paths.transcriptsDir is not resolved' }
  if (!worktree) return { dir: null, file: null, mtimeMs: null, source: null, reason: 'the descriptor names no worktree' }
  const started = finiteOrNull(startedAt)
  const ofThisSession = t => started === null || t.mtimeMs >= started
  const spellings = spellingsOf(worktree)

  const tried = []
  const seen = new Set()
  const consider = (dir, source) => {
    const k = normPath(dir, platform)
    if (seen.has(k)) return
    seen.add(k)
    tried.push({ dir, source })
  }
  if (hint) consider(hint, 'cached')
  for (const s of spellings) consider(path.join(transcriptsDir, transcriptSlug(s)), 'slug')
  let predecessor = false
  for (const t of tried) {
    const newest = newestTranscript(t.dir)
    if (!newest) continue
    if (ofThisSession(newest)) return { dir: t.dir, file: newest.file, mtimeMs: newest.mtimeMs, source: t.source, reason: null }
    predecessor = true
  }

  const idx = index || createTranscriptIndex(transcriptsDir)
  const candidates = idx.files()
  if (candidates === null) return { dir: null, file: null, mtimeMs: null, source: null, reason: `${transcriptsDir} does not exist` }
  for (const c of candidates) {
    if (!ofThisSession(c)) break // newest first: everything after this predates the session too
    if (transcriptCarriesCwd(idx.head(c.file, headBytes), spellings, platform)) {
      return { dir: path.dirname(c.file), file: c.file, mtimeMs: c.mtimeMs, source: 'scan', reason: null }
    }
  }
  return {
    dir: null, file: null, mtimeMs: null, source: null,
    reason: predecessor ? 'the newest transcript predates this session — a relaunched agent that has not written yet' : 'no transcript carries this worktree as cwd yet',
  }
}

/**
 * The last assistant entry of a transcript, reading from the END. A transcript can be tens of
 * megabytes, so the tail is read in a window that WIDENS until an assistant entry is found or the
 * whole file has been read — a fixed window would answer "no entry" for a session whose last turn
 * ended in one huge tool result. When the window starts mid-file its first line is discarded (it is
 * cut), and the torn last line a live session is writing is skipped by parseJsonl.
 */
export function lastAssistantEntryOf(file, { initialBytes = 256 * 1024 } = {}) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let window = Math.min(size, Math.max(1024, Math.floor(initialBytes)))
    for (;;) {
      const buf = Buffer.alloc(window)
      if (window > 0) fs.readSync(fd, buf, 0, window, size - window)
      let text = buf.toString('utf8')
      if (window < size) {
        const nl = text.indexOf('\n')
        text = nl === -1 ? '' : text.slice(nl + 1)
      }
      const found = lastAssistantEntry(parseJsonl(text))
      if (found) return found
      if (window >= size) return null
      window = Math.min(size, window * 4)
    }
  } finally {
    fs.closeSync(fd)
  }
}

// ---- thin: the nudge -------------------------------------------------------------------------------

/** The one line that is injected. Everything else is in the file it names. */
export function nudgePointer(file) {
  return `Read ${file} now`
}

/**
 * PURE. The message a nudged session reads. Short, and it says what happened and what to do — a
 * bare "continue" once made a session ask what to continue, which is a session that has stopped.
 */
export function nudgeMessage({ kind, text = '', at, idleMs = null }) {
  const when = at ? ` at ${at}` : ''
  if (kind === 'account-switch') {
    return [
      'continue',
      '',
      `The account behind this fleet changed${when} (a re-login or a switch), so quota is back — the fleet's stall watcher sent this.`,
      'If your last turn ended on a usage limit, pick up from your worktree and your notes exactly where you stopped; if you were mid-turn, carry on. Do not restart the ticket.',
      '',
    ].join('\n')
  }
  const idle = idleMs !== null && Number.isFinite(idleMs) ? ` and nothing has run for ${Math.round(idleMs / 60_000)} min` : ''
  const why = text ? ` (${text})` : ''
  return [
    'continue',
    '',
    `Your last turn ended on an API error${why}${idle} — the fleet's stall watcher sent this${when}.`,
    'Nothing is lost: pick up from your worktree and your notes exactly where you stopped. Do not restart the ticket.',
    '',
  ].join('\n')
}

/** A filesystem-safe timestamp (colons are illegal in Windows names). */
function stampOf(nowMs) {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-')
}

/**
 * Write the nudge to `<stateDir>/messages/nudge-<label>-<stamp>[-n].md`. `wx`: a name is never
 * reused, so a file a session may be reading is never overwritten under it.
 */
export function writeNudgeFile(stateDir, label, text, nowMs = Date.now()) {
  const dir = path.join(stateDir, MESSAGES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const base = `nudge-${label}-${stampOf(nowMs)}`
  for (let n = 0; ; n++) {
    const file = path.join(dir, n === 0 ? `${base}.md` : `${base}-${n}.md`)
    try {
      fs.writeFileSync(file, String(text ?? ''), { flag: 'wx' })
      return file
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/**
 * The interface handle for a descriptor: addressed by the registry's `backendRef`, never by label.
 * Null when the descriptor carries no ref — such a session cannot be addressed and is reported so.
 */
export function handleOf(descriptor) {
  if (!descriptor || !descriptor.backendRef) return null
  const h = { id: String(descriptor.label), role: descriptor.role, backendRef: descriptor.backendRef }
  if (Number.isInteger(descriptor.shimPid)) h.shimPid = descriptor.shimPid
  if (Number.isInteger(descriptor.pgid)) h.pgid = descriptor.pgid
  return Object.freeze(h)
}

/**
 * One nudge: the file, then the pointer through `backend.send`. A send that fails or THROWS is
 * reported per target, never propagated — one dead label, or a handle a backend refuses, must not
 * abort the fan-out over the others (twenty-one sessions once went un-nudged behind one that had
 * gone). `ok` is the backend's own verdict: a short write is a failure, not a nudge.
 * @returns {{label: string, ok: boolean, file: string|null, pointer: string|null, result: object|null, error: string|null}}
 */
export function sendNudge({ backend, descriptor, stateDir, text, nowMs = Date.now(), handleFor = handleOf }) {
  const label = String(descriptor.label)
  const handle = handleFor(descriptor)
  if (!handle) return { label, ok: false, file: null, pointer: null, result: null, error: 'the descriptor carries no backendRef, so the session cannot be addressed' }
  if (!backend || typeof backend.send !== 'function') return { label, ok: false, file: null, pointer: null, result: null, error: 'no backend to send through' }
  let file
  try {
    file = writeNudgeFile(stateDir, label, text, nowMs)
  } catch (e) {
    return { label, ok: false, file: null, pointer: null, result: null, error: `could not write the nudge file: ${e.message}` }
  }
  const pointer = nudgePointer(file)
  try {
    const result = backend.send(handle, pointer)
    const ok = !!result && result.ok === true
    return { label, ok, file, pointer, result, error: ok ? null : (result && result.reason) || 'the backend reported the send as not delivered' }
  } catch (e) {
    return { label, ok: false, file, pointer, result: null, error: e.message }
  }
}

// ---- the scan tick ---------------------------------------------------------------------------------

/**
 * Remember a transcript directory that was found by SCANNING, so the next pass reads it straight
 * from the descriptor instead of scanning every directory again.
 *
 * ⛔ Read-merge-WRITE, never write-the-copy-you-were-handed. The registry entry this pass was given
 * was read at the top of the pass, and the shim writes its own pids into the same descriptor as it
 * starts — so writing back the stale copy silently erases whatever landed in between, and a session
 * loses the pid that `fleet kill` addresses it by.
 *
 * @returns {boolean} whether anything was written (false = already cached, or no such descriptor)
 */
export function cacheTranscriptDir(stateDir, label, dir) {
  if (!dir) return false
  const current = readSession(label, { stateDir })
  if (!current) return false // the session ended while this pass ran: nothing to remember it on
  if (current.transcriptDir === dir) return false
  writeSession({ ...current, transcriptDir: dir }, { stateDir })
  return true
}

export function initialStallState() {
  return { cooldowns: {}, reported: {}, transcriptDirs: {}, scans: 0, cleanScans: 0, lastHeartbeatAt: null, parked: false }
}

/** PURE. Every Nth consecutive clean scan heartbeats, so a quiet log is distinguishable from a dead watcher. */
export function heartbeatDue(cleanScans, every = HEARTBEAT_EVERY_SCANS) {
  return cleanScans > 0 && every > 0 && cleanScans % every === 0
}

/** The session's own start (the shim's `startedAt`, else the launcher's `createdAt`) in ms, or null. */
function startedAtOf(descriptor) {
  return finiteOrNull(Date.parse(descriptor.startedAt ?? descriptor.createdAt ?? ''))
}

/**
 * A caller-supplied side effect — `notifications.command` is a shell command, and a logger can
 * fail too — that must never take the pass's state with it: a throw out of `notify` AFTER the nudges
 * went out would lose the cooldowns recorded for them, and the same sessions would be nudged again
 * on the next pass, every pass, for as long as the notifier kept failing. One failed side effect is
 * one line in the returned log, and nothing else.
 */
function guarded(fn, onError = () => {}) {
  return (...args) => {
    try {
      fn(...args)
    } catch (e) {
      onError(e)
    }
  }
}

/**
 * Judge one session from its transcript. Never sends anything.
 *
 * A dead session is not stalled — it is dead, and that is the reclaimer's business. A transcript
 * older than the session's own start is its PREDECESSOR's and is never its verdict (transcriptDirFor
 * bounds every candidate by `startedAt`).
 * @param {{transcriptsDir, nowMs?, thresholdMs?, platform?, readEntry?, index?, hint?}} o
 *   `hint` is the transcript dir to try first (the watcher's cache, else the descriptor's);
 *   `index` is the pass's createTranscriptIndex.
 * @returns {{label, skipped: string|null, transcriptDir, file, source, mtimeMs, idleMs, verdict, cacheDir: string|null, reason: string|null}}
 *   `cacheDir` is set when the transcript dir found differs from the hint — worth remembering.
 */
export function scanSession(descriptor, {
  transcriptsDir, nowMs = Date.now(), thresholdMs = DEFAULT_IDLE_THRESHOLD_MS, platform = process.platform,
  readEntry = lastAssistantEntryOf, index = null, hint = descriptor.transcriptDir || null,
} = {}) {
  const label = String(descriptor.label)
  const none = (reason, extra = {}) => ({
    label, skipped: null, transcriptDir: null, file: null, source: null, mtimeMs: null, idleMs: null,
    verdict: { stalled: false, kind: 'none', key: null, text: '', idleMs: null, reason }, cacheDir: null, reason, ...extra,
  })
  if (descriptor.liveness === 'dead') return { ...none('the session is dead (the reclaimer\'s business, not a stall)'), skipped: 'dead' }

  const t = transcriptDirFor(descriptor.worktree, { transcriptsDir, platform, hint, startedAt: startedAtOf(descriptor), index })
  if (!t.file) return none(t.reason, { transcriptDir: t.dir, source: t.source })
  const cacheDir = normPath(t.dir, platform) !== normPath(hint, platform) ? t.dir : null

  let entry = null
  try {
    entry = readEntry(t.file)
  } catch (e) {
    return none(`the transcript could not be read: ${e.message}`, { transcriptDir: t.dir, file: t.file, source: t.source, mtimeMs: t.mtimeMs, cacheDir })
  }
  const idleMs = Math.max(0, nowMs - t.mtimeMs)
  const verdict = classify(entry, { idleMs, thresholdMs })
  return { label, skipped: null, transcriptDir: t.dir, file: t.file, source: t.source, mtimeMs: t.mtimeMs, idleMs, verdict, cacheDir, reason: verdict.reason }
}

/**
 * One transcript scan over the registry. Every side effect is injected — the backend, the entry
 * reader, the clock — so the incident behind each rule is a test, not a comment.
 *
 * The transcript dir a scan finds is remembered in the WATCHER's state, never written into the
 * descriptor: contract §4 names the descriptor's writers (launcher, shim, reconciler) and this
 * watcher is not one of them.
 *
 * @param {object} o
 * @param {Array|null} o.registry      descriptors; read from `stateDir` when omitted
 * @param {string} o.stateDir          contract §4 state directory (nudge files)
 * @param {string|null} o.transcriptsDir  `paths.transcriptsDir`
 * @param {object} o.backend           the terminal backend; nudges go through `send`
 * @param {object} o.state             from initialStallState() or a previous pass (returned updated)
 * @returns {{state, sessions, stalls, nudged, parked, cooling, unacknowledged, failed, status, heartbeat, log: string[]}}
 */
export function stallScan({
  registry = null, stateDir, transcriptsDir, backend = null, nowMs = Date.now(), thresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS, heartbeatEvery = HEARTBEAT_EVERY_SCANS, state = initialStallState(), platform = process.platform,
  handleFor = handleOf, readEntry = lastAssistantEntryOf, log = () => {}, notify = () => {},
} = {}) {
  const lines = []
  const safeLog = guarded(log)
  const say = m => { lines.push(m); safeLog(m) }
  const tell = guarded(notify, e => say(`stalls: the notifier failed: ${e && e.message ? e.message : e}`))
  const at = new Date(nowMs).toISOString()
  const descriptors = registry || (stateDir ? listSessions({ stateDir }) : [])
  const index = createTranscriptIndex(transcriptsDir)

  const sessions = []
  const byLabel = new Map()
  const transcriptDirs = { ...(state.transcriptDirs || {}) }
  for (const d of descriptors) {
    if (!d || d.label === undefined || d.label === null) continue
    const label = String(d.label)
    const r = scanSession(d, { transcriptsDir, nowMs, thresholdMs, platform, readEntry, index, hint: transcriptDirs[label] || d.transcriptDir || null })
    if (r.transcriptDir) {
      if (r.cacheDir) {
        cacheTranscriptDir(stateDir, label, r.cacheDir)
        say(`stalls: ${label}: transcript dir found by ${r.source} (${r.cacheDir}) — remembered for the next pass`)
      }
      transcriptDirs[label] = r.transcriptDir
    }
    sessions.push(r)
    byLabel.set(r.label, d)
  }

  const stalls = sessions.filter(s => s.verdict.stalled).map(s => ({ label: s.label, ...s.verdict, mtimeMs: s.mtimeMs, file: s.file }))
  const plan = nudgePlan(stalls, state.cooldowns, nowMs, { cooldownMs, reported: state.reported })

  const cooldowns = { ...state.cooldowns }
  const nudged = []
  const failed = []
  for (const s of plan.nudge) {
    const text = nudgeMessage({ kind: s.kind, text: s.text, at, idleMs: s.idleMs })
    const r = sendNudge({ backend, descriptor: byLabel.get(s.label), stateDir, text, nowMs, handleFor })
    if (r.ok) {
      // The transcript mtime at the nudge is what proves it later: the only evidence a nudge was
      // ACTED ON is that mtime advancing, never the send's own return code.
      cooldowns[s.label] = { at: nowMs, key: s.key, mtimeMs: s.mtimeMs ?? null }
      nudged.push({ ...s, file: r.file, pointer: r.pointer })
      say(`stalls: ${s.label}: ${s.kind} idle ${Math.round(s.idleMs / 60_000)} min — nudged (${r.pointer})`)
    } else {
      failed.push({ label: s.label, kind: s.kind, error: r.error })
      say(`stalls: ${s.label}: ${s.kind} idle ${Math.round(s.idleMs / 60_000)} min — nudge NOT delivered: ${r.error}`)
    }
  }

  // A stall still on the same error, with the same transcript mtime as when it was nudged — by a
  // stall nudge or by the fleet-wide account-switch nudge — was never woken by it: the turn is dead,
  // and only `fleet relaunch` recovers it. Reported, never acted on — a relaunch kills a process and
  // is the launcher's decision.
  const unacknowledged = plan.unacknowledged
  for (const s of unacknowledged) {
    say(`stalls: ${s.label}: still ${s.kind} and the transcript has not moved since the ${s.nudge === 'account-switch' ? 'account-switch nudge' : 'nudge'} at ${s.nudgedAt} — the turn is dead; fleet relaunch ${s.label} is the recovery`)
  }

  // Announce a stall ONCE per (label, error text): the alarm is keyed on the text alone, so an idle
  // count that grows every poll does not make the same stall look new. A session that recovers and
  // later stalls on the same text is announced again, because its entry is dropped when it recovers
  // — and so is a dead-turn limit session's, so that if it acts on the switch nudge and hits the
  // limit again on the new account, that is announced as the fresh parking it is.
  const reported = {}
  for (const s of [...plan.nudge, ...plan.park, ...plan.cooling]) {
    const k = dedupKey(s.label, s.key)
    reported[k] = state.reported[k] ?? nowMs
  }
  for (const s of plan.park) {
    if (s.fresh) say(`stalls: ${s.label}: USAGE LIMIT — parked, not nudged (nothing bypasses an account-level limit): ${s.text || s.key}`)
  }

  const parked = plan.park.length > 0
  const status = parked ? { kind: 'usage-limit', text: plan.park[0].text || plan.park[0].key, labels: plan.park.map(s => s.label) } : null
  if (parked && !state.parked) tell('usage-limit', `stalls: ${plan.park.length} session(s) hit the usage limit — the fleet is parked until quota returns: ${status.text}`)

  const scans = state.scans + 1
  const cleanScans = stalls.length ? 0 : state.cleanScans + 1
  const heartbeat = heartbeatDue(cleanScans, heartbeatEvery)
  if (heartbeat) say(`stalls: heartbeat — ${cleanScans} clean scans in a row, ${sessions.length} session(s) read at ${at}`)

  return {
    state: { cooldowns, reported, transcriptDirs, scans, cleanScans, lastHeartbeatAt: heartbeat ? nowMs : state.lastHeartbeatAt, parked },
    sessions, stalls, nudged, parked: plan.park, cooling: plan.cooling, unacknowledged, failed, status, heartbeat, log: lines,
  }
}

// ---- the account tick ------------------------------------------------------------------------------

/**
 * The account-record watcher. One `fs.stat` per tick — the whole reason this runs on its own fast
 * tick — and the record is READ only when its mtime moved, then compared by IDENTITY: the mtime says
 * "something was written", the oauthAccount block says whether the account changed. `statMtime` and
 * `readText` are injected so the step is testable against a scripted clock. A detector given no file
 * is DISABLED with a reason, never silently.
 */
export function createAccountSwitchDetector({ accountFile = null, settleMs = DEFAULT_SETTLE_MS, statMtime = mtimeOf, readText = readTextOf } = {}) {
  const signal = accountFile
    ? { file: String(accountFile), reason: null }
    : { file: null, reason: 'no account record file was given — account switches cannot be detected' }
  let state = initialAccountState()
  let readAt = NaN // the record's mtime when `state.identity` was read; NaN until the first read
  return {
    signal,
    get state() {
      return state
    },
    /** @returns {{event: null|'switched'|'settled'|'removed', disabled: boolean, reason: string|null, file: string|null, mtimeMs: number|null, identity: string|null, settleInMs: number|null}} */
    tick(nowMs = Date.now()) {
      if (!signal.file) return { event: null, disabled: true, reason: signal.reason, file: null, mtimeMs: null, identity: null, settleInMs: null }
      const m = statMtime(signal.file)
      let identity
      if (m === null) identity = null // absent: logged out, or never logged in
      else if (m === readAt) identity = state.identity // untouched since the last read: nothing to parse
      else identity = accountIdentityOf(readText(signal.file)) // rewritten: read it (undefined = torn, ask again)
      if (identity !== undefined) readAt = m
      const r = accountSwitchStep(state, identity, nowMs, { settleMs })
      state = r.state
      const settleInMs = state.pendingSince === null ? null : Math.max(0, settleMs - (nowMs - state.pendingSince))
      return { event: r.event, disabled: false, reason: null, file: signal.file, mtimeMs: m, identity: state.identity, settleInMs }
    },
  }
}

/**
 * One fast tick. On `settled`, nudge the WHOLE fleet — every live, addressable session, stalled or
 * not — and replace every cooldown with this nudge's own record: the old ones refer to a stall just
 * handled wholesale, and the new one carries the transcript mtime at the nudge, which is what later
 * tells a session that acted on it from one whose turn was already dead.
 * @param {{transcriptsDir?: string|null}} o  `paths.transcriptsDir`, for the mtime each nudge is proven by
 * @returns {{event, disabled, reason, nudged: Array, failed: Array, status: {kind: 'account-switch'}|null, state, log: string[]}}
 */
export function accountTick({
  detector, registry = null, stateDir, transcriptsDir = null, platform = process.platform, backend = null, nowMs = Date.now(),
  state = initialStallState(), handleFor = handleOf, log = () => {}, notify = () => {},
} = {}) {
  if (!detector || typeof detector.tick !== 'function') throw new Error('accountTick: a detector from createAccountSwitchDetector is required')
  const lines = []
  const safeLog = guarded(log)
  const say = m => { lines.push(m); safeLog(m) }
  const tell = guarded(notify, e => say(`stalls: the notifier failed: ${e && e.message ? e.message : e}`))
  const r = detector.tick(nowMs)
  const base = { event: r.event, disabled: r.disabled, reason: r.reason, nudged: [], failed: [], status: null, state, log: lines }
  if (r.disabled) return base
  if (r.event === 'switched') say(`stalls: the account behind ${r.file} changed — settling ${Math.round((r.settleInMs ?? 0) / 1000)}s before nudging the fleet`)
  if (r.event === 'removed') say(`stalls: ${r.file} names no account any more — logged out; nothing to resume on`)
  if (r.event !== 'settled') return base

  const at = new Date(nowMs).toISOString()
  const text = nudgeMessage({ kind: 'account-switch', at })
  const descriptors = registry || (stateDir ? listSessions({ stateDir }) : [])
  const index = transcriptsDir ? createTranscriptIndex(transcriptsDir) : null
  const transcriptDirs = state.transcriptDirs || {}
  const cooldowns = {}
  const nudged = []
  const failed = []
  for (const d of descriptors) {
    if (!d || d.label === undefined || d.label === null || d.liveness === 'dead') continue
    const s = sendNudge({ backend, descriptor: d, stateDir, text, nowMs, handleFor })
    if (!s.ok) {
      failed.push({ label: s.label, error: s.error })
      continue
    }
    // The transcript mtime at the nudge, like a stall nudge records: the proof, later, that the
    // session acted on it — or the evidence that its turn was already dead.
    const t = index
      ? transcriptDirFor(d.worktree, { transcriptsDir, platform, hint: transcriptDirs[s.label] || d.transcriptDir || null, startedAt: startedAtOf(d), index })
      : { mtimeMs: null }
    cooldowns[s.label] = { at: nowMs, key: ACCOUNT_SWITCH_KEY, mtimeMs: t.mtimeMs ?? null }
    nudged.push({ label: s.label, file: s.file, pointer: s.pointer, mtimeMs: t.mtimeMs ?? null })
  }
  say(`stalls: ACCOUNT SWITCH at ${at} — nudged ${nudged.length} session(s)${failed.length ? `, ${failed.length} not delivered (${failed.map(f => `${f.label}: ${f.error}`).join('; ')})` : ''}; every cooldown replaced by this nudge's record`)
  tell('account-switch', `stalls: the account changed; ${nudged.length} session(s) nudged to continue`)
  return { ...base, nudged, failed, status: { kind: 'account-switch' }, state: { ...state, cooldowns, parked: false } }
}

// ---- the watcher -----------------------------------------------------------------------------------

/**
 * Both ticks over one shared state, with the timers injected.
 *
 * `start()` schedules the account tick and the transcript scan on SEPARATE intervals — the fast one
 * is one stat, the slow one reads every transcript, and a signal that waited for the slow tick once
 * cost two and a half minutes of a twenty-session freeze.
 *
 * The account record is derived (accountRecordFileFor, from `env` and `homedir`) when none is
 * given: a caller that forgot it would otherwise get switch detection silently OFF.
 */
export function createStallWatcher({
  stateDir, transcriptsDir, backend = null, platform = process.platform, env = process.env, homedir = os.homedir(), accountFile = null,
  thresholdMs = DEFAULT_IDLE_THRESHOLD_MS, cooldownMs = DEFAULT_COOLDOWN_MS, settleMs = DEFAULT_SETTLE_MS,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS, accountTickMs = DEFAULT_ACCOUNT_TICK_MS, heartbeatEvery = HEARTBEAT_EVERY_SCANS,
  now = Date.now, registry = null, handleFor = handleOf, readEntry = lastAssistantEntryOf, statMtime = mtimeOf, readText = readTextOf, log = () => {}, notify = () => {},
} = {}) {
  if (!stateDir) throw new Error('createStallWatcher: stateDir is required (nudge files live there)')
  let state = initialStallState()
  const safeLog = guarded(log)
  const detector = createAccountSwitchDetector({ accountFile: accountFile || accountRecordFileFor({ platform, env, homedir }), settleMs, statMtime, readText })
  const reg = () => (typeof registry === 'function' ? registry() : registry)

  // ⛔ Announce a detector that cannot fire, ONCE, at creation. A watcher with no account record
  // silently never reports a switch, and the fleet then sits parked on a usage limit forever behind
  // a component that looks alive: the ticks run, nothing is wrong, nothing happens. The one thing
  // worse than a missing feature is a missing feature that reports success.
  if (!detector.signal.file) safeLog(`stalls: account-switch detection is OFF — ${detector.signal.reason}`)

  // The methods close over `watcher`, never `this`: a caller that hands `watcher.start` (or a tick)
  // to a timer or an event emitter detaches it, and a detached `this` would make both timers throw
  // on their first fire — inside the guard below, so the log would say "tick failed" every 15 s
  // while the fleet stayed unwatched.
  const watcher = {
    detector,
    get state() {
      return state
    },
    scan(nowMs = now()) {
      const r = stallScan({ registry: reg(), stateDir, transcriptsDir, backend, nowMs, thresholdMs, cooldownMs, heartbeatEvery, state, platform, handleFor, readEntry, log: safeLog, notify })
      state = r.state
      return r
    },
    accountTick(nowMs = now()) {
      const r = accountTick({ detector, registry: reg(), stateDir, transcriptsDir, platform, backend, nowMs, state, handleFor, log: safeLog, notify })
      state = r.state
      return r
    },
    /** @returns {{stop: () => void, intervals: {scanMs: number, accountMs: number}}} */
    start({ setInterval: every = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval } = {}) {
      const guard = (name, fn) => () => {
        try {
          fn()
        } catch (e) {
          // One failed tick must not end the watcher: the guardian would restart it, but the fleet
          // is blind in between, and a thrown tick leaves the other timer running alone.
          safeLog(`stalls: ${name} tick failed: ${e && e.message ? e.message : e}`)
        }
      }
      const a = every(guard('account', () => watcher.accountTick()), accountTickMs)
      const s = every(guard('scan', () => watcher.scan()), scanIntervalMs)
      return { stop: () => { cancel(a); cancel(s) }, intervals: { scanMs: scanIntervalMs, accountMs: accountTickMs } }
    },
  }
  return watcher
}
