// Derivations: values the wizard never asks for because the repo or the machine already knows them.
// Pure — takes the resolved config and a `facts` object (see probe.mjs for its shape) and returns a
// completed config plus the materialised slot table and workspace links. Removing a config key in
// favour of a derivation is always preferred over defaulting it.
//
// facts = {
//   git: { toplevel, primary, parent, remoteUrl, userName, userEmail, commonDir, worktrees: [path] },
//   pkg: { name, workspaces: [glob], scripts: {name: cmd}, engines },
//   workspacePackages: [{ name, dir }],
//   lockfileHash, packageManager,
//   machine: { platform, cpus, totalRamGb, homedir, env },
//   compose: { file, services: [{name, image, ports}] } | null,
//   installReference: {...} | null,
// }

import path from 'node:path'
import { getPath, setPath } from './defaults.mjs'
import { stateDirFor, claudeProjectsDir } from './paths.mjs'

export const INSTALL_HARD_CAP = 4

/** `{branch}`-style template rendering; unknown tokens are left untouched. */
export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{([a-zA-Z0-9_-]+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m)
}

/** Slot n branch: n == 1 → base, else `${base}-${n}`. */
export function slotBranch(base, n) {
  return n === 1 ? base : `${base}-${n}`
}

/** The materialised slot table — the ONE source that used to be triplicated. */
export function buildSlots(config) {
  const base = config.testing.base
  const max = config.testing.maxSlots
  const out = []
  for (let n = 1; n <= max; n++) {
    const branch = slotBranch(base, n)
    const port = config.devServer.portBase + (n - 1) * config.devServer.portStride
    out.push({
      n,
      branch,
      suffix: `-${branch}`,
      port,
      url: renderTemplate(config.devServer.urlTemplate, { branch, slot: n, port, repo: config.repo.name || '' }),
    })
  }
  return out
}

/** Lowercase, non-alphanumerics to `-`, trimmed. */
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Branch prefix from a git user name: first word, slugified (`Ada Lovelace` → `ada`). */
export function branchPrefixFor(userName) {
  const first = String(userName || '').trim().split(/\s+/)[0]
  return slugify(first) || slugify(userName) || null
}

/** Forge kind from the origin URL. */
export function hostFromRemote(remoteUrl) {
  const s = String(remoteUrl || '').toLowerCase()
  if (!s) return 'other'
  if (s.includes('github.com')) return 'github'
  if (s.includes('gitlab')) return 'gitlab'
  return 'other'
}

const RUNNERS = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:--\S+\s+)*([^\s]+)/

/**
 * Resolve a dev-server command through package.json scripts (up to 4 hops) and produce a regex
 * string that identifies its process by its entry file — the pattern the supervisor uses to
 * tree-kill a rogue server, so it must be precise. Returns null when nothing file-like is found.
 */
export function serverProcessPattern(command, scripts = {}) {
  let cmd = String(command || '').trim()
  for (let hop = 0; hop < 4 && cmd; hop++) {
    const m = RUNNERS.exec(cmd)
    if (!m) break
    const next = scripts[m[1]]
    if (!next || next === cmd) break
    cmd = next.trim()
  }
  if (!cmd) return null
  const file = cmd.split(/\s+/).find(t => /\.(mjs|cjs|js|ts|mts)$/.test(t) && !t.startsWith('-'))
  const token = file ? path.posix.basename(file.replace(/\\/g, '/')) : cmd.split(/\s+/)[0]
  if (!token) return null
  return escapeRegex(token)
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Workspace links from the resolved package list: `{link: <package name>, target: <dir>}`. */
export function junctionsFromWorkspaces(workspacePackages = []) {
  return workspacePackages
    .filter(w => w && w.name && w.dir)
    .map(w => ({ link: w.name, target: w.dir.replace(/\\/g, '/') }))
}

/** Default fleet size: clamp(1, floor((ram - reserve) / perInstall), cpus). */
export function fleetSizeFor({ totalRamGb, cpus }, { reservePhysicalGb, perInstallGb }) {
  const byRam = Math.floor((Number(totalRamGb) - Number(reservePhysicalGb)) / Number(perInstallGb))
  const cap = Math.max(1, Number(cpus) || 1)
  return Math.max(1, Math.min(byRam, cap))
}

/**
 * Fill every derived (null) key. `adapter` is the parsed tracker adapter front matter, if any.
 * @returns {{config: object, slots: Array, junctions: Array, warnings: Array}}
 */
export function deriveConfig(config, facts, { adapter = null, sources = {} } = {}) {
  const c = JSON.parse(JSON.stringify(config))
  const warnings = []
  const fill = (key, value) => {
    if (getPath(c, key) === null || getPath(c, key) === undefined) setPath(c, key, value)
  }
  const machine = facts.machine || {}
  const git = facts.git || {}
  const platform = machine.platform || 'linux'
  const homedir = machine.homedir || ''
  const env = machine.env || {}

  fill('repo.name', git.primary ? path.basename(git.primary) : (facts.pkg && facts.pkg.name) || null)
  fill('repo.worktreeParent', git.primary ? path.dirname(git.primary) : null)
  fill('vcs.branchPrefix', branchPrefixFor(git.userName))
  fill('vcs.host', hostFromRemote(git.remoteUrl))
  fill('devServer.serverProcessPattern', c.commands.devServer ? serverProcessPattern(c.commands.devServer, (facts.pkg && facts.pkg.scripts) || {}) : null)

  const repoKey = facts.repoKey || null
  if (repoKey) fill('paths.stateDir', stateDirFor({ platform, env, homedir, repoKey }))
  if (c.paths.stateDir) {
    const p = platform === 'win32' ? path.win32 : path.posix
    fill('paths.artifactsDir', p.join(c.paths.stateDir, 'dev-pages'))
    fill('install.donor.path', p.join(c.paths.stateDir, 'nm-donor'))
  }
  fill('paths.transcriptsDir', claudeProjectsDir({ platform, env, homedir }))

  if (machine.totalRamGb && machine.cpus) {
    fill('fleet.size', fleetSizeFor(machine, { reservePhysicalGb: c.install.reservePhysicalGb, perInstallGb: c.install.perInstallGb }))
  }
  if (c.fleet.size !== null) fill('fleet.hardCeiling', c.fleet.size + 2)

  const slots = buildSlots(c)
  fill('testing.branches', slots.map(s => s.branch))

  if (adapter && adapter.states) {
    for (const s of ['in-progress', 'in-review', 'cancelled']) {
      const d = adapter.states[s] && adapter.states[s].promptDefault
      if (d) fill(`tracker.states.${s}`, d)
    }
  }
  if (adapter && adapter.states && adapter.states.unstarted && adapter.states.unstarted.promptDefault) {
    fill('checker.ready.state', adapter.states.unstarted.promptDefault)
  }
  fill('fleet.queue.selector.state', c.checker.ready.state)
  if (c.fleet.queue.selector.excludeLabels === null) {
    setPath(c, 'fleet.queue.selector.excludeLabels', c.checker.triage.label ? [c.checker.triage.label] : [])
  }

  if (c.install.concurrencyCap > INSTALL_HARD_CAP) {
    warnings.push({ code: 'config.install.cap-clamped', key: 'install.concurrencyCap', message: `install.concurrencyCap ${c.install.concurrencyCap} exceeds the hard cap ${INSTALL_HARD_CAP}; clamped (concurrent installs are what freeze a machine)` })
    c.install.concurrencyCap = INSTALL_HARD_CAP
  }

  let junctions = []
  if (c.install.junctions.mode === 'auto') junctions = junctionsFromWorkspaces(facts.workspacePackages)
  if (c.install.junctions.mode !== 'none') junctions = junctions.concat(c.install.junctions.extra || [])

  return { config: c, slots, junctions, warnings }
}
