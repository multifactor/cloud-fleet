// The seeded prompt a spawned session receives, and the descriptor it reads. PURE, except for one
// thin filesystem wrapper that answers "does a project overlay exist?".
//
// A session is a brand-new agent in an empty worktree: this prompt plus the descriptor are the whole
// of what it knows. So everything here is a POINTER, never a payload.
//
// ⛔ The playbook is injected BY ABSOLUTE PATH and is never pasted in. It is tens of thousands of
// words, and — worse — a pasted copy is frozen at launch: `fleet relaunch` spawns a fresh agent into
// the same worktree hours later, and that agent would follow the document as it stood when the fleet
// started rather than the one on disk (a project overlay edited mid-run would never take effect).
// The same reasoning covers the tracker adapter and the cached ticket text.
//
// ⛔ No tracker is ever NAMED in a prompt. Sessions speak in op numbers (op-2, op-11, …) and the
// mapping to real tool calls lives in the adapter file the descriptor points at — the adapter is
// identified by path and by nothing else. A prompt that names the product invites the session to
// reach for tools the adapter never sanctioned, and it is how a tool meant to drive any tracker
// quietly acquires a favourite.

import path from 'node:path'
import fs from 'node:fs'

import { getPath } from '../config/defaults.mjs'
import { stateLayout, transcriptSlug } from '../config/paths.mjs'

export const ROLES = ['working', 'testing', 'checker']

// Role → the bundled playbook file, and the config key that overrides it.
//
// The file names deliberately do NOT match the role names (`working` reads `session.md`), so this
// table is the only place the mapping exists: deriving the file name from the role would look for
// `playbooks/working.md`, which does not exist, and the session would be launched with a path to
// nothing at all.
export const PLAYBOOK_BY_ROLE = Object.freeze({
  working: Object.freeze({ file: 'session.md', configKey: 'playbooks.session' }),
  testing: Object.freeze({ file: 'testing.md', configKey: 'playbooks.testing' }),
  checker: Object.freeze({ file: 'check.md', configKey: 'playbooks.check' }),
})

const P = platform => (platform === 'win32' ? path.win32 : path.posix)

/**
 * The one filesystem call in this module. Injected as `exists` everywhere, so the rest stays pure.
 *
 * ⛔ Absence is the only answer this may swallow. A permission or symlink error on a path the
 * operator configured means the overlay may well BE there — and a false "no" here launches the whole
 * fleet against the bundled document instead, silently: the prompt is only a pointer, so nothing
 * downstream ever re-checks and the operator's only symptom is a project overlay that is ignored.
 */
export function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false
    throw e
  }
}

/**
 * A tracker id is a FILENAME, never a path: it is concatenated into `<id>.md` and joined onto the
 * plugin root or `<repo>/.fleet/trackers/`. `tracker.id` is free-form project-scope config, and an
 * id carrying a separator or `..` resolves outside that directory — then hands the result to a
 * session as the authoritative mapping from op numbers to tool calls. Same shape the adapter front
 * matter declares (`id: example-tracker`).
 */
export const TRACKER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Absolute path of the playbook a role must read. Precedence: an explicit `playbooks.*` config
 * override → the project overlay at `<repo>/.fleet/playbooks/<name>.md` → the bundled copy.
 */
export function playbookPathFor(config, role, { pluginRoot, repoRoot = null, platform = process.platform, exists = fileExists } = {}) {
  const entry = PLAYBOOK_BY_ROLE[role]
  if (!entry) throw new Error(`prompts: unknown role "${role}"`)
  if (!pluginRoot) throw new Error('prompts: pluginRoot is required to locate a playbook')
  const p = P(platform)
  const override = getPath(config, entry.configKey)
  if (override) return p.isAbsolute(override) || !repoRoot ? override : p.join(repoRoot, override)
  const overlay = repoRoot ? p.join(repoRoot, '.fleet', 'playbooks', entry.file) : null
  if (overlay && exists(overlay)) return overlay
  return p.join(pluginRoot, 'playbooks', entry.file)
}

/**
 * Absolute path of the tracker adapter, or null when the fleet is tracker-less. Same overlay rule:
 * `<repo>/.fleet/trackers/<id>.md` wins over the bundled `trackers/<id>.md`.
 */
export function adapterPathFor(config, { pluginRoot, repoRoot = null, platform = process.platform, exists = fileExists } = {}) {
  if (config.tracker.mode === 'none' || !config.tracker.id) return null
  if (!pluginRoot) throw new Error('prompts: pluginRoot is required to locate a tracker adapter')
  if (!TRACKER_ID_RE.test(config.tracker.id)) {
    throw new Error(`prompts: tracker id ${JSON.stringify(config.tracker.id)} is not a filename — an adapter path must stay inside the trackers directory`)
  }
  const p = P(platform)
  const file = `${config.tracker.id}.md`
  const overlay = repoRoot ? p.join(repoRoot, '.fleet', 'trackers', file) : null
  if (overlay && exists(overlay)) return overlay
  return p.join(pluginRoot, 'trackers', file)
}

/**
 * Build one session descriptor — the file written to `<stateDir>/sessions/<label>.json` and the only
 * place a session is allowed to learn a path from (contract §4 and §8 rule 4).
 *
 * @param {object} config    resolved + derived config
 * @param {object} session   what the launcher knows about this session:
 *                           `{label, id?, role, worktree, branch?, issue?, ticketFile?, backendRef?,
 *                             shimPid?, agentPid?, pgid?, createdAt?}`, plus `slot` for a `testing`
 *                             session and `sweepDir` + `slice` for a `checker` one — each required,
 *                             because the role cannot be served without it.
 * @param {object} resolved  the launch-time resolution bundle: `{slots, platform, pluginRoot,
 *                           repoRoot, exists?, now?}` — `slots` is the table from `resolved.json`.
 * @returns {object} the descriptor
 */
export function buildDescriptor(config, session, resolved = {}) {
  const { slots = [], platform = process.platform, pluginRoot, repoRoot = null, exists = fileExists, now = Date.now() } = resolved
  const role = session.role
  if (!ROLES.includes(role)) throw new Error(`buildDescriptor: unknown role "${role}"`)
  if (session.label === undefined || session.label === null || session.label === '') throw new Error('buildDescriptor: label is required')
  if (!session.worktree) throw new Error('buildDescriptor: worktree is required')
  const stateDir = config.paths.stateDir
  if (!stateDir) throw new Error('buildDescriptor: paths.stateDir is not resolved — a session with no state dir cannot flag')

  const p = P(platform)
  const layout = stateLayout(stateDir, platform)
  const docs = { pluginRoot, repoRoot, platform, exists }

  // Only the first `testing.count` rows of the slot table are actually running; the table itself is
  // `testing.maxSlots` rows long. Handing a working session every row sends it to capture against a
  // slot nobody ever started, and "empty means there is no local pool" stops meaning anything.
  const live = config.testing.enabled ? Math.max(0, config.testing.count) : 0
  const testingUrls = slots.slice(0, live).map(s => s.url)

  // A slot is addressed by its 1-based slot NUMBER, never by array position: `slots[slot]` hands
  // slot 1 the URL of slot 2, and a testing session that serves one branch while reporting another
  // URL stays invisible until every capture taken against it turns out to be of the wrong code.
  let own = null
  if (role === 'testing') {
    const n = Number(session.slot)
    if (!Number.isInteger(n) || n < 1) throw new Error('buildDescriptor: a testing session needs its slot number')
    own = slots.find(s => Number(s.n) === n) || null
    if (!own) throw new Error(`buildDescriptor: slot ${n} is not in the slot table`)
  }

  // A checker is addressed by both halves of `sweeps/<sweepId>/slices/<slice>`: with either missing
  // it has nothing to work and nowhere to write, and the seed prompt tells it — in words — that it
  // owns "slice null of the sweep at null". Refused here, the way a missing slot number is.
  if (role === 'checker') {
    if (!session.slice) throw new Error('buildDescriptor: a checker session needs its slice')
    if (!session.sweepDir) throw new Error('buildDescriptor: a checker session needs its sweep directory')
  }

  const label = String(session.label)
  const descriptor = {
    id: String(session.id ?? label),
    label,
    role,
    worktree: session.worktree,
    // The hook-written state file the shim polls for this session's status, mirrored as
    // FLEET_STATE_FILE. It is a field of the descriptor and not a literal a session may spell for
    // itself: `assertDescriptor` refuses a descriptor without it, so a session built without one
    // cannot start at all.
    stateFile: p.join(layout.sessions, `${label}.state`),
    // ⛔ A testing session's branch is the slot table's, never the caller's: a session that serves
    // one slot's branch while reporting another slot's URL stays invisible until every capture taken
    // against it turns out to be of the wrong code.
    branch: own ? own.branch : session.branch || '',
    issue: session.issue || null,
    ticketFile: session.ticketFile || null,
    backendRef: session.backendRef ?? null,
    shimPid: session.shimPid ?? null,
    agentPid: session.agentPid ?? null,
    pgid: session.pgid ?? null,
    createdAt: session.createdAt || new Date(now).toISOString(),
    transcriptDir: config.paths.transcriptsDir ? p.join(config.paths.transcriptsDir, transcriptSlug(session.worktree)) : null,
    tracker: {
      id: config.tracker.mode === 'none' ? null : config.tracker.id,
      mode: config.tracker.mode,
      adapterPath: adapterPathFor(config, docs),
      scope: config.tracker.scope,
      states: { ...config.tracker.states },
      assignee: config.tracker.defaultAssignee,
    },
    playbook: playbookPathFor(config, role, docs),
    testingUrl: own ? own.url : testingUrls[0] || '',
    testingUrls,
    paths: {
      stateDir,
      flagsDir: layout.flags,
      outboxDir: layout.outbox,
      artifactsDir: config.paths.artifactsDir,
    },
    // The ready flag lives at the WORKTREE ROOT, not in the state dir: it answers "is THIS checkout
    // usable", so a worktree deleted by hand takes its own sentinel with it instead of leaving a
    // state-dir file that claims an install which no longer exists.
    readyFlag: p.join(session.worktree, config.install.readyFlag),
    agent: config.fleet.agent,
    model: config.fleet.model,
  }
  if (role === 'testing') {
    // The slot's own scalars. The shim mirrors FLEET_SLOT · FLEET_SLOT_BRANCH · FLEET_PORT out of
    // THIS file and from nowhere else, and a slot's dev-server command needs its own port —
    // `{port}` is otherwise only a URL placeholder, so without these a fixed-port project cannot
    // start a second slot at all.
    descriptor.slot = own.n
    descriptor.port = own.port
  }
  if (role === 'checker') {
    descriptor.sweepDir = session.sweepDir
    descriptor.slice = session.slice
  }
  return descriptor
}

/**
 * Build the prompt the agent is seeded with.
 *
 * @param {object} config   resolved + derived config (the authority on whether a tracker exists)
 * @param {object} session  the DESCRIPTOR from buildDescriptor — the prompt only ever points at it
 * @param {object} paths    `{sessionFile}` — where that descriptor was written. The descriptor has
 *                          no self-reference field, so its own path has to be handed in.
 * @returns {string}
 */
export function buildPrompt(config, session, paths = {}) {
  const sessionFile = paths.sessionFile
  if (!sessionFile) throw new Error('buildPrompt: paths.sessionFile is required — a session that cannot find its descriptor has no identity, no worktree and nowhere to flag')
  if (!session.playbook) throw new Error('buildPrompt: the descriptor carries no playbook path')
  if (!ROLES.includes(session.role)) throw new Error(`buildPrompt: unknown role "${session.role}"`)

  const role = session.role
  // A testing session ⛔ never touches the tracker — the working session owns its ticket and a second
  // writer produces contradictory history nobody can read back — so it is handed no adapter at all
  // rather than an adapter plus a prohibition.
  const usesTracker = role !== 'testing'
  const trackerConfigured = config.tracker.mode !== 'none' && !!config.tracker.id
  const adapterPath = session.tracker ? session.tracker.adapterPath : null
  if (usesTracker && trackerConfigured && !adapterPath) {
    throw new Error('buildPrompt: a tracker is configured but the descriptor carries no tracker.adapterPath — a session told to speak in op numbers with no mapping file invents tool calls')
  }

  const steps = []

  steps.push(
    `Read your session descriptor FIRST. It names your worktree, your branch, your assignment and every path you may write to:\n   ${sessionFile}\n   ⛔ Never substitute a literal path for one of its values — the state, flag, outbox and scratch directories differ per repo and per machine.`,
  )

  steps.push(
    `Then read your playbook IN FULL and follow it from the top:\n   ${session.playbook}\n   Read the file itself. It is not pasted here on purpose: the copy on disk is the current one, and it is the one a relaunched agent in this worktree must also read.`,
  )

  if (usesTracker) {
    steps.push(
      trackerConfigured
        ? `Tracker work is named by operation number only (op-2, op-11, …). The mapping from an op to a real tool call lives in your adapter file and nowhere else:\n   ${adapterPath}`
        : 'There is no tracker configured for this repo. Your task, and everything known about it, comes from your descriptor (its `issue` and `ticketFile` fields) and from what the launcher sends you — there is no ticket to fetch, no status to move and no tracker op that applies.',
    )
  }

  if (session.issue) {
    const ticket = session.ticketFile
      ? `\n   The launcher cached the ticket text offline at ${session.ticketFile} — read that if the tracker is unreachable, instead of stalling.`
      : ''
    steps.push(
      `Your assignment is ${session.issue}. ⛔ Do not ask which issue to work on: ${session.issue} is already yours, and it alone — never its parent, never a sibling.${ticket}`,
    )
  } else if (role === 'working') {
    // Not an empty key: a session handed `issue: ""` reads it as "ask", and asking is how a session
    // stops for good. It gets the resume / fresh-start entry point instead.
    //
    // Only a working session gets this. A testing session's branch is a mashup of everyone's work
    // and a checker's is a sweep slice, so "the branch names the issue you were working" would send
    // either of them to work a ticket that belongs to somebody else.
    steps.push(
      'You were launched WITHOUT an assignment. ⛔ Do not ask what to work on. If your worktree is already on a branch, that branch names the issue you were working — resume it from where it stopped. If HEAD is detached you are a fresh start: read the repo and its conventions while you wait, and act on the assignment the launcher sends you when it arrives.',
    )
  }

  if (role === 'testing') {
    // The number comes off the descriptor's own `slot`. The branch is only the fallback, read
    // exactly as the testing playbook tells the session to read it, so a descriptor that carries a
    // slot branch and no slot number still names the right slot rather than none.
    const n = Number.isInteger(session.slot) ? session.slot : slotNumberFromBranch(session.branch, config.testing.base)
    const which = n === null ? `the testing slot on branch ${session.branch}` : `testing slot ${n} (branch ${session.branch})`
    steps.push(
      `You own ${which}, serving ${session.testingUrl}. That URL and that worktree are yours; the other slots belong to sibling sessions and you never touch them.`,
    )
  }
  if (role === 'checker') {
    steps.push(
      `You own slice ${session.slice} of the sweep at ${session.sweepDir}. Work your slice and only your slice — the sweep's other slices belong to sibling sessions.`,
    )
  }

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n')
  return [
    `You are claude-fleet session ${session.label} — role ${role}.`,
    '',
    numbered,
    '',
    'Start now, and keep going. Nobody is reading this window: the launcher reads your flags (your playbook gives the exact done / blocked commands), so a question typed here is a session that has stopped for no reason.',
  ].join('\n')
}

/**
 * Slot number from a slot branch, read the way the testing playbook tells a session to read it:
 * `testing.base` → 1, `<base>-<n>` → n. The inverse of `slotBranch()` in config/derive.mjs.
 * Returns null when the branch is not a slot branch at all.
 */
export function slotNumberFromBranch(branch, base) {
  const b = String(branch || '')
  if (!base || !b) return null
  if (b === base) return 1
  if (!b.startsWith(`${base}-`)) return null
  const n = Number(b.slice(base.length + 1))
  return Number.isInteger(n) && n >= 1 ? n : null
}
