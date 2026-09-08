// `fleet doctor [--repair] [--verify-primary] [--json]` (contract §7) — everything about this
// machine that has to be true before a session is spawned, probed once and reported as a flat list.
//
// The launcher runs this BEFORE every launch and after every reboot, so two shapes matter:
//
//   ⛔ It must run on a broken machine. `needsBackend` is false and the terminal backend is probed
//      here, inside a try: a doctor that refuses to start because there is no terminal cannot tell
//      the operator that there is no terminal.
//   ⛔ It ECHOES `devServer.serverProcessPattern` verbatim, every run. That pattern is what lets the
//      watcher tree-kill a dev server it finds inside a working worktree, and a false positive
//      matching a test runner or a build kills the session's own work — so a human reads the line.
//
// Every repair runs a user-configured command STRING, which means sys/exec.shellCommand and nothing
// else: that is the one sanctioned shell path in the plugin.

import fs from 'node:fs'
import path from 'node:path'

import { which } from '../../sys/exec.mjs'
import { selectBackend } from '../../backends/index.mjs'
import { loadAdapter, validateAdapter } from '../../trackers/registry.mjs'
import { observe, verdict as servicesVerdict, apply as applyRepairs } from '../../supervisor/checks/services.mjs'
import { snapshotReference } from '../../core/install.mjs'
import { insideAny } from '../../config/paths.mjs'
import { envelope } from '../../cli.mjs'

export const name = 'doctor'
export const usage = 'fleet doctor [--repair] [--verify-primary] [--json]'
export const needsConfig = true
export const needsBackend = false

/** One probe result (contract §7 `fleet doctor`). `hint` is null when there is nothing to do. */
const probe = (probeName, ok, detail, hint = null) => ({ name: probeName, ok: !!ok, detail, hint: ok ? null : hint })

/**
 * PURE. Does this Node satisfy the repo's `engines.node`?
 *
 * Deliberately only a MAJOR-version floor: a full range parser is a dependency this tool does not
 * take, and the failure that matters is a fleet spawned on a Node older than the repo builds on.
 * A range it cannot read is reported as unknown rather than as a failure — refusing to launch over
 * an unparsed caret is worse than launching.
 */
export function nodeFloor(range) {
  if (!range || typeof range !== 'string') return null
  let floor = null
  // ⛔ Only a LOWER bound is a floor. Reading every number in the range as one inverts `<21` into a
  // minimum of 21, and the probe below then fails Node 20 — the only major `>=18 <21` actually
  // allows — so doctor exits 1 and the launcher refuses a healthy machine. A range that names no
  // lower bound at all (`<21`) is therefore unknown, not a floor.
  for (const m of range.matchAll(/(<=|<|>=|>|\^|~|=)?\s*(\d+)(?:\.\d+)*/g)) {
    if (m[1] && m[1].startsWith('<')) continue
    const major = Number(m[2])
    if (Number.isFinite(major)) floor = floor === null ? major : Math.max(floor, major)
  }
  return floor
}

/**
 * Re-exported so `fleet doctor`'s probe and `validateConfig` answer this question with the SAME
 * function: while there were two copies they disagreed about case folding, and the pair contradicted
 * each other on one machine (see the ⛔ on the definition).
 */
export { insideAny }

/** Can the state dir actually be written? Nothing else in the fleet can flag, lock or register if not. */
function stateDirWritable(stateDir) {
  if (!stateDir) return { ok: false, detail: 'paths.stateDir is unresolved' }
  const file = path.join(stateDir, `.fleet-doctor-${process.pid}.tmp`)
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(file, 'ok')
    fs.rmSync(file, { force: true })
    return { ok: true, detail: stateDir }
  } catch (e) {
    return { ok: false, detail: `${stateDir}: ${e.code || e.message}` }
  }
}

export async function run(ctx, args) {
  const config = ctx.config
  const facts = ctx.facts
  const probes = []

  // ---- git -------------------------------------------------------------------------------------
  const gitBin = which('git')
  probes.push(probe('git', !!gitBin, gitBin || 'git is not on PATH', 'install git, or add its directory to paths.pathPrepend'))
  probes.push(probe(
    'repo',
    !!(facts.git && facts.git.primary),
    facts.git && facts.git.primary ? `primary checkout ${facts.git.primary}` : `${ctx.cwd} is not inside a git checkout`,
    'run the fleet from inside the repository you want worktrees of',
  ))

  // ---- node ------------------------------------------------------------------------------------
  const range = facts.pkg && facts.pkg.engines ? facts.pkg.engines.node : null
  const floor = nodeFloor(range)
  const major = Number(process.versions.node.split('.')[0])
  probes.push(probe(
    'node',
    floor === null || major >= floor,
    range ? `node ${process.versions.node} against engines.node "${range}"` : `node ${process.versions.node} (the repo declares no engines.node)`,
    `every session inherits this Node; install one that satisfies "${range}" and put it in paths.nodeBinDirs`,
  ))

  // ---- terminal backend ------------------------------------------------------------------------
  try {
    const chosen = await selectBackend({ config, override: ctx.backend, log: () => {} })
    // Both names: an injected backend is selected as "injected" while its own probe says what it
    // really is, and an operator reading "injected" alone cannot tell which terminal they are on.
    const p = chosen.backend.probe()
    const named = p.name && p.name !== chosen.name ? `${chosen.name} (${p.name})` : chosen.name
    probes.push(probe('terminal-backend', true, `${named}${p.reason ? `: ${p.reason}` : ''}${chosen.tried.length ? ` — after ${chosen.tried.map(t => `${t.name}: ${t.reason}`).join('; ')}` : ''}`))
  } catch (e) {
    probes.push(probe('terminal-backend', false, e.message.split('\n')[0], 'install one of the candidates, or set terminal.backend explicitly'))
  }

  // ---- tracker adapter ---------------------------------------------------------------------------
  probes.push(trackerProbe(ctx))

  // ---- the rogue-server pattern ------------------------------------------------------------------
  const pattern = config.devServer.serverProcessPattern
  probes.push(probe(
    'dev-server-pattern',
    // Not having one is not a failure — a repo with no dev server has nothing to match — but an
    // unreadable one is, because the operator cannot check what it would kill.
    true,
    pattern === null
      ? 'devServer.serverProcessPattern is unset (no commands.devServer, so no rogue-server sweep)'
      : `devServer.serverProcessPattern = ${pattern}   ← read this: it is what tree-kills a dev server found inside a working worktree, so a match on a test runner or a build kills the session's own work`,
  ))

  // ---- state dir + artifacts ----------------------------------------------------------------------
  const writable = stateDirWritable(config.paths.stateDir)
  probes.push(probe('state-dir', writable.ok, writable.detail, 'the registry, the locks and the flags all live here; point paths.stateDir somewhere writable'))

  const worktrees = (facts.git && facts.git.worktrees) || []
  const artifacts = config.paths.artifactsDir
  const artifactsOk = !artifacts || !worktrees.length || !insideAny(artifacts, worktrees, (facts.machine && facts.machine.platform) || process.platform)
  probes.push(probe(
    'artifacts-dir',
    artifactsOk,
    `${artifacts} (${worktrees.length} worktree(s) checked)`,
    'a review page must outlive the session that made it, and teardown removes worktrees whole — move paths.artifactsDir outside every worktree',
  ))

  // ---- services ----------------------------------------------------------------------------------
  const observed = await observe(config)
  const services = servicesVerdict({ config, observed })
  probes.push(probe(
    'services',
    services.ok,
    services.notes.join('; ') || 'every declared service is up',
    'run `fleet doctor --repair`; after a reboot the container engine does not auto-start, so the database is down while / still answers 200 and it reads as an app bug',
  ))

  // ---- optional work -----------------------------------------------------------------------------
  const payload = { probes, repaired: null, reference: null }

  if (args.flags.repair) {
    const applied = applyRepairs(services.repairs)
    payload.repaired = applied
    for (const f of applied.failed) probes.push(probe(`repair:${f.name}`, false, f.error || `exit ${f.code}`, 'start it by hand, then re-run `fleet doctor`'))
    for (const r of applied.repaired) ctx.log(`repaired ${r.name}`)
    if (!services.repairs.length) ctx.log('doctor --repair: nothing declared a startCommand, so there was nothing to repair')
  }

  if (args.flags['verify-primary']) {
    // The install proof compares every worktree against this tree, so a damaged REFERENCE certifies
    // the damage everywhere: an empty or half-installed primary must fail loudly here.
    const ref = snapshotReference(facts.git.primary || ctx.cwd, config, { refresh: true })
    payload.reference = { usable: ref.usable, packageCount: ref.packageCount ?? 0, lockfileHash: ref.lockfileHash, reason: ref.reason ?? null }
    probes.push(probe(
      'install-reference',
      !!ref.usable,
      ref.usable ? `${ref.packageCount} packages snapshotted from ${ref.primary}` : ref.reason || 'the primary checkout could not be snapshotted',
      'install the primary checkout before launching: every worktree is proven against it, so an empty reference passes every broken tree',
    ))
  }

  const ok = probes.every(p => p.ok)
  const failed = probes.filter(p => !p.ok)
  ctx.json(ok
    ? envelope(true, payload)
    : envelope(false, {
      ...payload,
      error: {
        code: 'doctor.failed',
        message: `${failed.length} probe(s) failed: ${failed.map(p => p.name).join(', ')}`,
        hint: failed.map(p => p.hint).filter(Boolean)[0] || 'fix each failing probe before launching',
      },
    }))
  for (const p of probes) ctx.log(`${p.ok ? 'ok  ' : 'FAIL'} ${p.name}: ${p.detail}`)
  return ok ? 0 : 1
}

/** The adapter file has to parse AND validate, or a session reading it invents its own tool calls. */
function trackerProbe(ctx) {
  const config = ctx.config
  if (config.tracker.mode === 'none' || !config.tracker.id) {
    return probe('tracker-adapter', true, config.tracker.mode === 'none' ? 'tracker-less (tracker.mode: none)' : 'no tracker.id set yet')
  }
  let parsed
  try {
    parsed = loadAdapter(config.tracker.id, { projectDir: ctx.paths.projectTrackersDir })
  } catch (e) {
    return probe('tracker-adapter', false, `${config.tracker.id}: ${e.message}`, 'fix the adapter file, or set tracker.id to a bundled adapter')
  }
  if (!parsed) {
    return probe('tracker-adapter', false, `no adapter file for tracker.id "${config.tracker.id}"`, `add ${ctx.paths.projectTrackersDir}/${config.tracker.id}.md, or set tracker.id to a bundled adapter`)
  }
  const v = validateAdapter(parsed, { expectedId: config.tracker.id, config })
  return probe(
    'tracker-adapter',
    v.ok,
    v.ok ? `${parsed.file} parses and validates${v.warnings.length ? ` (${v.warnings.length} warning(s))` : ''}` : `${parsed.file}: ${v.errors.slice(0, 3).join('; ')}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ''}`,
    'every op a playbook names is executed from this file; a section it is missing is an op no session can perform',
  )
}
