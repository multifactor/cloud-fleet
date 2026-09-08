// What `fleet up` (and `fleet add`) would create, decided from data alone. PURE — no git, no
// filesystem, no clock — so every numbering and slot trap below is a unit test rather than a comment.
//
// The caller supplies what it read from the world: `existing.taken` is `core/fleet.takenLabels()` and
// `existing.sessions` is the registry listing. Keeping the reads out here is what lets the same plan
// be printed by `--dry-run` and executed by the launch path without either re-deriving it.

import path from 'node:path'

import { buildSlots, renderTemplate } from '../config/derive.mjs'
import { CliError } from './args.mjs'

export const ROLES = Object.freeze(['working', 'checker'])

const P = platform => (platform === 'win32' ? path.win32 : path.posix)

/** A testing slot's label. Named, not numbered — contract §4 labels are filenames, and a slot must
 *  never consume a working session's number (core/fleet.nextLabel ignores non-numeric labels). */
export function testingLabel(slot) {
  return `t${slot}`
}

/**
 * The first working number a new session may take.
 *
 * ⛔ One PAST the highest taken, never the first hole. `existing.taken` counts leftover FOLDERS as
 * well as live descriptors (a `git worktree remove` routinely deregisters a tree and then fails to
 * delete its directory), and filling a hole hands the new session a folder that already holds a
 * half-installed dependency tree — which every cheap check then calls healthy.
 */
export function firstFreeLabel(taken = []) {
  let highest = 0
  for (const t of taken) {
    const raw = t && typeof t === 'object' ? t.label : t
    const s = String(raw ?? '').trim()
    if (!/^\d+$/.test(s)) continue // a named label (a testing slot) occupies no number
    highest = Math.max(highest, Number(s))
  }
  return highest + 1
}

/** Issue keys as the operator gave them: `--issues A,B`, an array, or a single key. */
function normalizeIssues(issues) {
  if (issues === undefined || issues === null) return []
  const many = Array.isArray(issues) ? issues : [issues]
  return many.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean)
}

/**
 * A worktree folder name must stay a NAME. A template that rendered empty, or that carries a
 * separator because a slot branch is `release/2`, would put the worktree somewhere other than
 * `repo.worktreeParent` — and teardown, numbering and the leftover sweep all only look there.
 */
function assertFolderName(name, template) {
  if (!name || /[\\/]/.test(name)) {
    throw new CliError(
      'plan.bad-folder-template',
      `the folder template "${template}" rendered to ${JSON.stringify(name)}, which is not a plain directory name`,
      'a worktree folder lives directly under repo.worktreeParent; remove the separator from the template (or from the branch name it renders)',
    )
  }
  return name
}

/**
 * The session plan for one `fleet up` / `fleet add` invocation.
 *
 * @param {object} input
 * @param {object} input.options  `{n?, add?, testing?, issues?, role?, sweepId?, slices?}` — the
 *        parsed flags. `n` is the count of NEW working sessions (contract §7: testing slots are on
 *        top of it); `add` is the same number under its own flag, defaulting to 1.
 * @param {object} input.existing `{taken?: string[], sessions?: object[]}` — takenLabels() and the
 *        registry listing.
 * @param {object} input.config   resolved + derived config
 * @param {object} input.facts    probe facts (only `machine.platform` is read)
 * @returns {Array<{label, role, worktree, branch, issue, slot?, port?, url?, isNew}>}
 *          testing slots first, then the working (or checker) sessions — the order `fleet up` prints
 *          them in, because a slot has to be up before a session can capture against it.
 */
export function buildPlan({ options = {}, existing = {}, config, facts = {} } = {}) {
  if (!config) throw new CliError('plan.no-config', 'buildPlan needs a resolved config', 'run `fleet config status --json` first')
  const platform = (facts.machine && facts.machine.platform) || process.platform
  const p = P(platform)

  const repoName = config.repo.name
  const worktreeParent = config.repo.worktreeParent
  if (!repoName || !worktreeParent) {
    // These are exactly the values `needs-machine` means, and a plan built without them writes
    // worktrees beside the process's cwd — which on a launcher session is the primary checkout.
    throw new CliError(
      'plan.machine-unresolved',
      'repo.name and repo.worktreeParent are unresolved on this machine, so there is nowhere to put a worktree',
      'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`',
    )
  }

  const role = options.role || 'working'
  if (!ROLES.includes(role)) {
    throw new CliError('plan.unknown-role', `unknown role "${role}"`, `--role takes ${ROLES.join(' or ')}; a testing slot is asked for with --testing k`)
  }

  const issues = normalizeIssues(options.issues)
  const isAdd = options.add !== undefined && options.add !== null
  const hasN = options.n !== undefined && options.n !== null
  // ⛔ Two counts that disagree are refused, never silently reconciled — the same rule the issue-key
  // guard below applies: `fleet up 6 --add 2` planning 2 sessions drops four the operator typed and
  // never says which number was lost. `fleet add k` is the only spelling that carries `add`.
  if (isAdd && hasN && Number(options.n) !== Number(options.add)) {
    throw new CliError(
      'plan.count-conflict',
      `two different session counts were given: ${options.n} as a positional and ${options.add} as --add`,
      'pass the count once — `fleet up 6` or `fleet add 2`, never both',
    )
  }
  const asked = isAdd ? Number(options.add) : options.n
  let count
  if (issues.length) {
    // ⛔ A count that disagrees with the key list is refused rather than reconciled: opening a
    // session with no issue leaves an agent with nothing to work, and dropping a key silently
    // launches fewer sessions than the operator asked for and never says which one was lost.
    if (asked !== undefined && asked !== null && Number(asked) !== issues.length) {
      throw new CliError(
        'plan.count-mismatch',
        `${asked} session(s) were asked for but ${issues.length} issue key(s) were given (${issues.join(', ')})`,
        'with --issues the count must equal the number of resolved keys, or be left out entirely',
      )
    }
    count = issues.length
  } else if (isAdd) {
    count = Number(options.add)
  } else if (hasN) {
    count = Number(options.n)
  } else {
    count = config.fleet.size ?? 1
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new CliError('plan.bad-count', `the session count must be a whole number ≥ 0, got ${JSON.stringify(count)}`, 'for example `fleet up 4`')
  }

  // A label whose descriptor is alive already has a window; the caller uses `isNew` to decide whether
  // to spawn one. `liveness: "dead"` is the reconciler's verdict, and a dead slot is respawnable.
  const live = new Set(
    (existing.sessions || [])
      .filter(s => s && s.label !== undefined && s.liveness !== 'dead')
      .map(s => String(s.label)),
  )

  const plan = []

  // ---- testing slots -----------------------------------------------------------------------------
  // ⛔ An `add` leaves the testing pool EXACTLY as it is (contract §7: "Existing sessions and the
  // testing pool are left as they are"), so an unasked-for `--testing` defaults to 0 there rather
  // than to `testing.count`. Planning a slot behind an operator who typed `fleet add 2` creates a
  // worktree, a window and a port they did not ask for — and on a machine whose slot is running but
  // whose descriptor was reclaimed, `isNew` is true and that is a second dev server on slot 1's port.
  // `--add 0 --testing 1` still boots the on-demand slot, because there `options.testing` is explicit.
  const wantTesting = options.testing === undefined || options.testing === null
    ? (isAdd ? 0 : config.testing.count)
    : Number(options.testing)
  if (!Number.isInteger(wantTesting) || wantTesting < 0) {
    throw new CliError('plan.bad-testing-count', `--testing expects a whole number ≥ 0, got ${JSON.stringify(options.testing)}`, `0 means no local pool; the maximum is testing.maxSlots (${config.testing.maxSlots})`)
  }
  if (wantTesting > config.testing.maxSlots) {
    // The slot table is `testing.maxSlots` rows long: branch names, ports and URLs exist for those
    // rows and for no others, so an extra slot would be a session with no URL to serve.
    throw new CliError(
      'plan.too-many-slots',
      `--testing ${wantTesting} exceeds testing.maxSlots (${config.testing.maxSlots})`,
      'raise testing.maxSlots in the project config if the machine can really serve that many dev servers, then retry',
    )
  }
  if (wantTesting > 0 && !config.testing.enabled) {
    throw new CliError('plan.testing-disabled', `--testing ${wantTesting} was asked for but testing.enabled is false`, 'set testing.enabled true, or capture through capture.mode: cloud')
  }

  const slots = buildSlots(config)
  for (const slot of slots.slice(0, wantTesting)) {
    const folder = assertFolderName(
      renderTemplate(config.repo.slotDirTemplate, { repo: repoName, branch: slot.branch, slot: slot.n, n: slot.n }),
      config.repo.slotDirTemplate,
    )
    const label = testingLabel(slot.n)
    plan.push({
      label,
      role: 'testing',
      worktree: p.join(worktreeParent, folder),
      // ⛔ The slot's branch comes from the slot table and nowhere else: a session serving one
      // branch while reporting another slot's URL stays invisible until every capture taken against
      // it turns out to be of the wrong code.
      branch: slot.branch,
      issue: null,
      slot: slot.n,
      port: slot.port,
      url: slot.url,
      // A testing window opens on first creation, or on reuse once that slot's agent is verifiably
      // gone from the registry — never beside a live one, which would put two dev servers on one port.
      isNew: !live.has(label),
    })
  }

  // ---- working / checker sessions ---------------------------------------------------------------
  const slices = normalizeIssues(options.slices)
  if (role === 'checker' && !options.sweepId) {
    throw new CliError(
      'plan.checker-needs-sweep',
      'a checker session needs the sweep it belongs to (vcs.checkerBranchTemplate renders {sweepId}/{slice})',
      'pass the sweep id from `fleet check plan`; a checker branch with an unrendered {sweepId} is not a branch name',
    )
  }

  const start = firstFreeLabel(existing.taken)
  for (let i = 0; i < count; i++) {
    const label = String(start + i)
    const issue = issues[i] ?? null
    if (role === 'checker') {
      const slice = slices[i] ?? label
      const folder = assertFolderName(renderTemplate(config.repo.checkerDirTemplate, { repo: repoName, slice, n: label }), config.repo.checkerDirTemplate)
      plan.push({
        label,
        role: 'checker',
        worktree: p.join(worktreeParent, folder),
        branch: renderTemplate(config.vcs.checkerBranchTemplate, { sweepId: options.sweepId, slice }),
        issue,
        slice,
        isNew: !live.has(label),
      })
      continue
    }
    // ⛔ Rendered and asserted exactly like the other two roles. `sessionFolder()` is a bare
    // `String.replace` — which substitutes only the FIRST occurrence, leaves an unknown token's
    // literal braces in the name, and checks nothing — so a `sessions/{repo}-{n}` template put the
    // worktree outside `repo.worktreeParent`, where takenLabels(), the leftover sweep and teardown
    // all fail to see it and the next run re-issues its label onto a half-installed tree.
    const folder = assertFolderName(
      renderTemplate(config.repo.sessionDirTemplate, { repo: repoName, n: label }),
      config.repo.sessionDirTemplate,
    )
    plan.push({
      label,
      role: 'working',
      worktree: p.join(worktreeParent, folder),
      // ⛔ A working worktree is created DETACHED at <remote>/<baseBranch>, so `branch` is null here
      // by design: the branch name renders from vcs.branchTemplate and needs the ticket slug the
      // session itself resolves, and a session that never starts must leave no branch to explain.
      branch: null,
      issue,
      isNew: !live.has(label),
    })
  }

  return plan
}
