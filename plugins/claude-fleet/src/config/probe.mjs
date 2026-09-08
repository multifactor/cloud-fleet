// What is true in THIS checkout, on THIS machine — the one impure module of the config system.
// It answers with the `facts` object derive.mjs and validate.mjs consume, and load.mjs hands around.
//
// ⛔ It only ever READS. `fleet config status` runs it inside repositories that have never seen this
// tool, and a status command that creates a directory — or makes git take a lock — as a side effect is
// one nobody can safely run in someone else's checkout.
//
// Every probe degrades to a null field plus a warning rather than a throw: no git on PATH, not a git
// repository, no package.json, a file the user cannot read. The status command must ALWAYS answer.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { run } from '../sys/exec.mjs'
import { repoKeyFor } from './paths.mjs'

const GB = 1024 ** 3

/**
 * The environment variables a derivation actually needs.
 *
 * ⛔ Never copy the whole environment into `facts`: facts are printed by `--json`, pasted into bug
 * reports and dumped into logs, and a fleet machine's environment holds every token its operator owns.
 */
export const MACHINE_ENV_KEYS = [
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR', 'FLEET_CONFIG_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
]

export function machineEnv(env = {}) {
  const out = {}
  for (const k of MACHINE_ENV_KEYS) if (env[k]) out[k] = String(env[k])
  return out
}

/**
 * Read and parse a JSON file.
 * @returns {{exists: boolean, data: object|null, error: string|null}} — a missing file is not an
 *   error (an unconfigured repo is the normal state); an unreadable or malformed one is.
 */
export function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return { exists: false, data: null, error: null }
    return { exists: true, data: null, error: `${e.code}: ${file} could not be read` }
  }
  try {
    // A Windows editor writes a UTF-8 BOM by default and JSON.parse rejects it — the config file
    // looked perfectly fine in the editor that had just corrupted it.
    return { exists: true, data: JSON.parse(text.replace(/^\uFEFF/, '')), error: null }
  } catch (e) {
    return { exists: true, data: null, error: `${file}: invalid JSON (${e.message})` }
  }
}

/**
 * git prints POSIX separators on every platform, so `rev-parse --show-toplevel` in `C:\w\app` answers
 * `C:/w/app`. Comparing that against a cwd, a worktree list or a user-config checkout key never
 * matches, and the fleet silently behaves as if it were in a different repository.
 */
export function normalizeGitPath(p, platform = process.platform) {
  if (p === null || p === undefined) return null
  const s = String(p).trim()
  if (!s) return null
  return platform === 'win32' ? path.win32.normalize(s.replace(/\//g, '\\')) : s
}

/** `git worktree list --porcelain` → paths. The FIRST entry is always the main worktree. */
export function parseWorktreeList(text, platform = process.platform) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^worktree (.+)$/.exec(line.replace(/\r$/, ''))
    if (m) {
      const p = normalizeGitPath(m[1], platform)
      if (p) out.push(p)
    }
  }
  return out
}

/** One git call that can never take the process down. */
function tryGit(dir, args, timeoutMs = 10_000) {
  try {
    const r = run('git', ['-C', dir, ...args], { timeoutMs })
    return { ok: r.ok, out: (r.stdout || '').trim() }
  } catch {
    // git absent from PATH makes spawnSync throw ENOENT, and `fleet config status` still has to answer.
    return { ok: false, out: '' }
  }
}

/**
 * @returns {{git: object, warnings: Array}} — `git.primary` is the MAIN checkout even when `cwd` is a
 * linked worktree, which is the field every worktree path in the fleet hangs off.
 */
export function gitFacts({ cwd, remote = 'origin' }) {
  const warnings = []
  const empty = { toplevel: null, primary: null, parent: null, remoteUrl: null, userName: null, userEmail: null, commonDir: null, worktrees: [] }

  const top = tryGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.out) {
    warnings.push({ code: 'probe.not-a-git-repo', key: 'repo', message: `${cwd} is not inside a git checkout (or git is unavailable)` })
    return { git: empty, warnings }
  }
  const toplevel = normalizeGitPath(top.out)

  const wl = tryGit(toplevel, ['worktree', 'list', '--porcelain'])
  const worktrees = wl.ok ? parseWorktreeList(wl.out) : [toplevel]

  const cd = tryGit(toplevel, ['rev-parse', '--git-common-dir'])
  let commonDir = null
  if (cd.ok && cd.out) {
    const raw = normalizeGitPath(cd.out)
    commonDir = path.isAbsolute(raw) ? raw : path.resolve(toplevel, raw)
  }

  // ⛔ `--show-toplevel` inside a linked worktree answers the LINKED path. repo.worktreeParent derives
  // from the primary checkout, so trusting the toplevel here makes a fleet launched from inside
  // session 1 create every new worktree as a sibling of session 1 instead of a sibling of the repo.
  let primary = worktrees[0] || toplevel
  if (!wl.ok && commonDir && path.basename(commonDir) === '.git') primary = path.dirname(commonDir)

  let remoteUrl = null
  const direct = tryGit(toplevel, ['remote', 'get-url', remote])
  if (direct.ok && direct.out) remoteUrl = direct.out.split(/\r?\n/)[0].trim()
  else {
    // A checkout whose only remote is called something else still has an identity. Falling straight to
    // the local: key would give one repository two state directories depending on how it was cloned.
    const list = tryGit(toplevel, ['remote'])
    const first = list.ok ? list.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] : null
    if (first) {
      const u = tryGit(toplevel, ['remote', 'get-url', first])
      if (u.ok && u.out) remoteUrl = u.out.split(/\r?\n/)[0].trim()
    }
  }

  const name = tryGit(toplevel, ['config', '--get', 'user.name'])
  const email = tryGit(toplevel, ['config', '--get', 'user.email'])
  if (!name.ok || !name.out) warnings.push({ code: 'probe.no-git-user', key: 'vcs.branchPrefix', message: 'git config user.name is unset, so a branch prefix cannot be derived' })

  return {
    git: {
      toplevel,
      primary,
      parent: primary ? path.dirname(primary) : null,
      remoteUrl,
      userName: name.ok && name.out ? name.out : null,
      userEmail: email.ok && email.out ? email.out : null,
      commonDir,
      worktrees,
    },
    warnings,
  }
}

/** npm/pnpm take an array, yarn v1 takes `{packages: []}`; a negation is not a directory. */
export function normalizeWorkspaces(ws) {
  const list = Array.isArray(ws) ? ws : ws && Array.isArray(ws.packages) ? ws.packages : []
  return list.filter(x => typeof x === 'string' && x && !x.startsWith('!'))
}

// A workspace glob that walks node_modules turns a 200 ms probe into a 40 s one AND reports vendored
// copies as workspace packages, which the donor-clone step would then recreate as junctions.
const SKIP_DIRS = new Set(['node_modules', '.git'])
const MAX_GLOB_DEPTH = 8

function* walkPattern(base, segs, i, depth) {
  if (depth > MAX_GLOB_DEPTH) return
  if (i >= segs.length) {
    yield base
    return
  }
  const seg = segs[i]
  if (seg === '*' || seg === '**') {
    let entries
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const child = path.join(base, e.name)
      yield* walkPattern(child, segs, i + 1, depth + 1)
      if (seg === '**') yield* walkPattern(child, segs, i, depth + 1)
    }
    return
  }
  const next = path.join(base, seg)
  try {
    if (!fs.statSync(next).isDirectory()) return
  } catch {
    return
  }
  yield* walkPattern(next, segs, i + 1, depth + 1)
}

/** Resolve workspace globs to `[{name, dir}]`, dirs relative to the repo root and posix-separated. */
export function expandWorkspaces(root, patterns, { max = 500 } = {}) {
  const out = []
  const seen = new Set()
  for (const pattern of patterns) {
    const segs = String(pattern).replace(/\\/g, '/').split('/').filter(s => s && s !== '.')
    for (const dir of walkPattern(root, segs, 0, 0)) {
      if (out.length >= max) return out
      const rel = path.relative(root, dir).replace(/\\/g, '/')
      if (!rel || seen.has(rel)) continue
      const { data } = readJson(path.join(dir, 'package.json'))
      if (!data || !data.name) continue
      seen.add(rel)
      out.push({ name: data.name, dir: rel })
    }
  }
  return out
}

export const LOCKFILES = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

/**
 * The install proof is keyed by this hash, so it hashes CONTENT: a hash of the lockfile's path never
 * changes, and every worktree installed against an older dependency tree would pass the proof.
 */
export function lockfileFacts(root) {
  for (const [name, pm] of LOCKFILES) {
    let buf
    try {
      buf = fs.readFileSync(path.join(root, name)) // a Buffer, never utf8 — bun.lockb is binary
    } catch {
      continue
    }
    return { lockfile: name, packageManager: pm, lockfileHash: createHash('sha1').update(buf).digest('hex').slice(0, 12) }
  }
  return { lockfile: null, packageManager: null, lockfileHash: null }
}

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

const unquote = s => String(s).trim().replace(/^["']|["']$/g, '').trim()

/**
 * Service names, images and ports from a compose file — deliberately shallow. A real YAML parser is a
 * dependency this tool does not take, and all the supervisor needs is which containers must exist.
 */
export function parseComposeServices(text) {
  const out = []
  let inServices = false
  let serviceIndent = null
  let cur = null
  let inPorts = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ').replace(/\r$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      // Any other top-level key ends the services block; without this, a `volumes:` section's keys
      // are read as containers the supervisor then tries to start.
      inServices = /^services:\s*(#.*)?$/.test(line)
      serviceIndent = null
      cur = null
      inPorts = false
      continue
    }
    if (!inServices) continue
    if (serviceIndent === null) serviceIndent = indent
    if (indent === serviceIndent) {
      const m = /^([A-Za-z0-9._-]+):/.exec(line.trim())
      cur = m ? { name: m[1], image: null, ports: [] } : null
      inPorts = false
      if (cur) out.push(cur)
      continue
    }
    if (!cur) continue
    const t = line.trim()
    const im = /^image:\s*(.+)$/.exec(t)
    if (im) {
      cur.image = unquote(im[1])
      inPorts = false
      continue
    }
    const flow = /^ports:\s*\[(.*)\]\s*$/.exec(t)
    if (flow) {
      cur.ports.push(...flow[1].split(',').map(unquote).filter(Boolean))
      inPorts = false
      continue
    }
    if (/^ports:\s*$/.test(t)) {
      inPorts = true
      continue
    }
    if (inPorts) {
      const pm = /^-\s*(.+)$/.exec(t)
      if (pm) {
        cur.ports.push(unquote(pm[1]))
        continue
      }
      inPorts = false
    }
  }
  return out
}

export function composeFacts(root) {
  for (const name of COMPOSE_FILES) {
    const file = path.join(root, name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    return { file, services: parseComposeServices(text) }
  }
  return null
}

/**
 * Everything the config system needs to know about the world.
 * @param {{cwd?: string, env?: object, remote?: string}} input
 * @returns {{repoKey, git, pkg, workspacePackages, lockfile, lockfileHash, packageManager, machine, compose, installReference, warnings}}
 */
/**
 * The long, canonical form of an existing path.
 *
 * ⛔ Windows keeps an 8.3 alias for every long name — `C:\Users\RUNNER~1\AppData\Local\Temp` is the
 * same directory as `C:\Users\runneradmin\AppData\Local\Temp` — and the two halves of this program
 * disagree about which one they mean. `fs.realpathSync` PRESERVES a short component; git and
 * `fs.realpathSync.native` always expand it. So a `cwd` that arrived short is compared against a
 * toplevel git answered long and they are not equal: the operator's whole `checkouts` entry is
 * dropped for a file they can plainly see, and a session can derive a different `paths.stateDir` from
 * its launcher — two private lock pools over one fleet, which is the very failure the pool exists to
 * prevent. It reproduces on any machine with a short-named profile directory, and on the Windows CI
 * runners, where the temp directory is handed out in its 8.3 form.
 *
 * A path that does not exist is returned unchanged: this canonicalises, it does not validate. For a
 * path that does NOT exist yet — a worktree about to be created — core/worktree.canonicalPath walks
 * up to the deepest existing parent instead; this one is for paths already on disk.
 */
export function realPath(p) {
  if (p === null || p === undefined || p === '') return p
  try {
    return fs.realpathSync.native(String(p))
  } catch {
    return p
  }
}

export function gatherFacts({ cwd = process.cwd(), env = process.env, remote = 'origin' } = {}) {
  const warnings = []
  // Canonicalised, so every path derived below is in the same form git answers in.
  const here = realPath(path.resolve(cwd))
  const { git, warnings: gitWarnings } = gitFacts({ cwd: here, remote })
  warnings.push(...gitWarnings)

  // Read the PRIMARY checkout's package.json, not a linked worktree's: a session worktree can be
  // mid-bootstrap, and every derivation taken from it (workspace junctions, the dev-server process
  // pattern) describes the repository rather than one checkout of it.
  const root = git.primary || git.toplevel || here
  const pkgRead = readJson(path.join(root, 'package.json'))
  if (pkgRead.error) warnings.push({ code: 'probe.package-json-unreadable', key: 'pkg', message: pkgRead.error })
  else if (!pkgRead.exists) warnings.push({ code: 'probe.no-package-json', key: 'pkg', message: `no package.json at ${root}` })
  const j = pkgRead.data || {}

  const pkg = {
    name: typeof j.name === 'string' ? j.name : null,
    workspaces: normalizeWorkspaces(j.workspaces),
    scripts: j.scripts && typeof j.scripts === 'object' ? j.scripts : {},
    engines: j.engines && typeof j.engines === 'object' ? j.engines : null,
  }
  const declaredPm = typeof j.packageManager === 'string' ? j.packageManager.split('@')[0] : null
  const workspacePackages = pkg.workspaces.length ? expandWorkspaces(root, pkg.workspaces) : []
  const lock = lockfileFacts(root)

  const machine = {
    platform: process.platform,
    // os.cpus() answers [] in some containers, and a cpu count of 0 clamps the whole fleet to nothing.
    cpus: (os.cpus() || []).length || 1,
    // Total RAM is a static number os.totalmem() already knows; probeMemory() would pay a PowerShell
    // round-trip on Windows, and `fleet config status` must stay cheap enough to run constantly.
    totalRamGb: os.totalmem() / GB,
    homedir: os.homedir(),
    env: machineEnv(env),
  }

  return {
    repoKey: repoKeyFor({ remoteUrl: git.remoteUrl, gitCommonDir: git.commonDir, name: pkg.name || path.basename(root) }),
    git,
    pkg,
    workspacePackages,
    lockfile: lock.lockfile,
    lockfileHash: lock.lockfileHash,
    packageManager: declaredPm || lock.packageManager,
    machine,
    compose: composeFacts(root),
    // The per-lockfile snapshot of the primary checkout that install proof compares against; the
    // install module owns it, and nothing here may create it (this module never writes).
    installReference: null,
    warnings,
  }
}
