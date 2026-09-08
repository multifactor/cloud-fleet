// `fleet status [--json]` (contract §7) — the fleet table the launcher reads at the top of every
// turn, and the only place an operator is told what the whole run is doing.
//
// Identity comes from the REGISTRY (`<stateDir>/sessions/*.json`), never from searching process
// command lines: list, send and kill each grew their own grep once, and the three disagreed — one
// reported a session that had died an hour earlier, another could not find a session whose window was
// open. Liveness is then asked of the BACKEND by the `backendRef` the registry recorded.
//
// ⛔ Nothing here is fatal. A backend that cannot answer, a transcript directory that has vanished, a
// torn flag: each degrades to a null cell and a note, because a status command that throws leaves the
// launcher with no picture of a fleet that is still running — and the launcher's next move is decided
// from this table.
//
// ⛔ The refusals are shown every run. A ticket refused at intake is work the operator ASKED for and
// did not get; a silently shrinking queue reads as "there was no work".

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { envelope } from '../../cli.mjs'
import { selectBackend } from '../../backends/index.mjs'
import { listSessions } from '../../core/fleet.mjs'
import { stateLayout } from '../../config/paths.mjs'
import { readRefusals, refusedPath } from '../../watchers/autowave.mjs'
import { newestFileMtime, readStateFile, verdict as sessionsVerdict } from '../../supervisor/checks/sessions.mjs'
import { readStatus } from '../../supervisor/loop.mjs'

export const name = 'status'
export const usage = 'fleet status [--json]'
export const needsConfig = true
// ⛔ FALSE on purpose, and the backend is probed below inside a try. `fleet status` is what the
// operator runs when something is wrong — including "the terminal backend is gone after a reboot" —
// and a status command that refuses to start on a broken machine cannot report the breakage.
export const needsBackend = false

/** `done-<label>.json` / `blocked-<label>.json` (contract §5), and nothing else in the directory. */
const FLAG_RE = /^(done|blocked)-(.+)\.json$/

/**
 * PURE-ish. Every flag in the flags directory, parsed. A flag that will not parse is REPORTED rather
 * than skipped: a flag nobody can read is a session nobody reclaims, and dropping it here is how one
 * stays open forever.
 * @returns {Array<{kind: 'done'|'blocked', label: string, file: string, flag: object|null, error: string|null}>}
 */
export function readFlags(stateDir, platform = process.platform) {
  const dir = stateLayout(stateDir, platform).flags
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return [] // a fleet that has never flagged
    throw e
  }
  const out = []
  for (const nameOnDisk of names) {
    const m = FLAG_RE.exec(nameOnDisk)
    if (!m) continue // the one-line .txt twin is for tailing, not for parsing
    const file = path.join(dir, nameOnDisk)
    let flag = null
    let error = null
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) flag = parsed
      else error = 'is not a JSON object'
    } catch (e) {
      error = e.code === 'ENOENT' ? 'vanished while being read' : `is unreadable: ${e.message}`
    }
    out.push({ kind: m[1], label: m[2], file, flag, error })
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind.localeCompare(b.kind)))
}

/** PURE. The table row for one session: its descriptor joined to the liveness check's verdict. */
export function rowFor(descriptor, found) {
  return {
    label: String(descriptor.label),
    role: descriptor.role,
    issue: descriptor.issue || null,
    branch: descriptor.branch || null,
    worktree: descriptor.worktree || null,
    // ⛔ Two different questions, kept apart exactly as contract §4 keeps them: `state` is what the
    // agent says it is doing (the hook-written state file) and `alive` is whether the process exists.
    // Folded into one field, the reconciler and the status hook overwrite each other's answer.
    state: found ? found.state : null,
    alive: found ? found.alive : null,
    idleMinutes: found ? found.idleMinutes : null,
    stalled: found ? found.stalled : false,
    slot: descriptor.slot ?? null,
    url: descriptor.testingUrl || null,
    liveness: descriptor.liveness || null,
  }
}

const cell = v => (v === null || v === undefined || v === '' ? '—' : String(v))

export async function run(ctx, args) {
  const config = ctx.config
  const stateDir = config.paths.stateDir
  const notes = []

  // The injected backend wins (tests, `fleet doctor --dry-run`); otherwise probe, and a machine with
  // no terminal still gets its table — with `alive` null and one note saying why.
  let backend = ctx.backend
  let backendName = backend ? backend.name || 'injected' : null
  if (!backend) {
    try {
      const chosen = await selectBackend({ config, log: () => {} })
      backend = chosen.backend
      backendName = chosen.name
    } catch (e) {
      notes.push(`no terminal backend on this machine, so liveness is unknown: ${e.message.split('\n')[0]}`)
    }
  }

  // ⛔ Nothing here is fatal, and that has to hold for the READS too. `listSessions`, `readFlags` and
  // `readRefusals` each re-throw anything that is not ENOENT, and an EACCES/EPERM/EBUSY on the state
  // dir is commonplace on Windows — and is precisely the broken machine an operator runs `fleet
  // status` to diagnose. Each degrades to an empty list plus a note naming the path and the errno,
  // exactly as the backend-selection failure above does, rather than coming back as a `cli.failed`
  // payload and a stack.
  const degrade = (what, where, read, fallback) => {
    try {
      return read()
    } catch (e) {
      notes.push(`${what} could not be read from ${where} (${e.code || 'error'}: ${e.message}), so the table is missing that column rather than missing entirely`)
      return fallback
    }
  }

  const layout = stateLayout(stateDir, process.platform)
  const registry = degrade('the session registry', layout.sessions, () => listSessions({ stateDir }), [])
  // The supervisor's own check builds these rows, so `fleet status` and `fleet watch` can never
  // disagree about who is alive, idle or stalled — two answers to that question is the disagreement
  // this whole registry exists to end.
  const v = sessionsVerdict({
    registry,
    backend,
    nowMs: ctx.now(),
    newestMtime: d => newestFileMtime(d.transcriptDir),
    readState: d => readStateFile(d.stateFile),
  })
  const byLabel = new Map(v.found.map(f => [f.label, f]))
  const sessions = registry.map(d => rowFor(d, byLabel.get(String(d.label))))
  notes.push(...v.notes)

  const flags = degrade('the flags', layout.flags, () => readFlags(stateDir), [])
  const refused = degrade('the intake refusals', refusedPath(stateDir), () => readRefusals(refusedPath(stateDir)), [])
  // `readStatus` already swallows everything and answers null, so a missing supervisor pass is a null
  // cell by construction.
  const watch = readStatus(stateDir)

  const unreadableFlags = flags.filter(f => f.error)
  for (const f of unreadableFlags) notes.push(`flag ${path.basename(f.file)} ${f.error}`)

  ctx.json(envelope(true, {
    stateDir,
    backend: backendName,
    sessions,
    flags: {
      done: flags.filter(f => f.kind === 'done').map(f => ({ label: f.label, outcome: f.flag ? f.flag.outcome ?? null : null, issue: f.flag ? f.flag.issue ?? null : null, error: f.error })),
      blocked: flags.filter(f => f.kind === 'blocked').map(f => ({ label: f.label, category: f.flag ? f.flag.category ?? null : null, observation: f.flag ? f.flag.observation ?? null : null, error: f.error })),
    },
    intakeRefused: {
      count: refused.length,
      entries: refused.map(r => ({ key: r.key ?? null, reason: r.reason ?? null, gate: r.gate ?? null, at: r.at ?? null })),
    },
    // The supervisor's last pass, when one has run: `fleet watch` does most of the monitor loop, and
    // its verdict is what tells the launcher whether it must do that work by hand this turn.
    watch: watch ? { at: watch.at, pass: watch.pass, checks: Object.fromEntries(Object.entries(watch.checks).map(([k, c]) => [k, { ok: c.ok, found: c.found.length, repaired: c.repaired.length }])) } : null,
    notes,
  }))

  ctx.log('| label | role    | issue | branch / slot | state | alive | idle (min) | url |')
  for (const s of sessions) {
    ctx.log(`| ${s.label} | ${s.role} | ${cell(s.issue)} | ${cell(s.slot === null ? s.branch : `slot ${s.slot}`)} | ${cell(s.state)} | ${s.alive === null ? '?' : s.alive ? 'yes' : 'no'} | ${cell(s.idleMinutes)} | ${cell(s.url)} |`)
  }
  if (!sessions.length) ctx.log('no sessions in the registry')
  for (const f of flags) ctx.log(`flag: ${f.kind} ${f.label}${f.flag && f.flag.outcome ? ` (${f.flag.outcome})` : ''}${f.flag && f.flag.category ? ` (${f.flag.category})` : ''}${f.error ? ` — ${f.error}` : ''}`)
  if (refused.length) ctx.log(`${refused.length} ticket(s) refused at intake: ${refused.map(r => `${r.key} (${r.reason})`).join(', ')}`)
  for (const n of notes) ctx.log(`note: ${n}`)
  return 0
}
