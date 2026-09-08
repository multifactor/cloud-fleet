// Every path claude-fleet derives, as pure functions of injected facts (platform, env, homedir,
// repo root). No process.* access here — that is what makes them testable on every OS at once.

import path from 'node:path'
import { createHash } from 'node:crypto'

const P = (platform) => (platform === 'win32' ? path.win32 : path.posix)

/**
 * Normalise a git remote to the repo key `host/owner/name` (lowercase, `.git` stripped, scp form
 * and ssh:// normalised, credentials dropped). Extra path segments (GitLab subgroups) are kept.
 * Returns null when the URL cannot be parsed.
 */
export function normalizeRemote(url) {
  if (!url || typeof url !== 'string') return null
  let s = url.trim()

  // ⛔ A LOCAL PATH IS NOT A REMOTE URL, and on Windows it looks exactly like one: `C:/repos/app.git`
  // parses as the scp form `host:path` with `C` as the host, yielding the repo key `c/repos/app`.
  // Two commands then disagree about the key — one resolves the remote, another falls back to the
  // local form — and they read two different state directories, so a running fleet is invisible to
  // its own `status` and `down`. A path-style remote (a bare clone, a network share, a submodule
  // mirror) has no host at all: it is not a `<host>/<owner>/<name>` identity, so it must fall
  // through to the local key rather than inventing one.
  if (/^[a-zA-Z]:[\\/]/.test(s)) return null // C:\repos\app.git, C:/repos/app.git
  if (/^[\\/]/.test(s)) return null // /srv/git/app.git, \\server\share\app.git
  if (/^(?:file|ftp|ftps):\/\//i.test(s)) return null // file:///srv/git/app.git

  // scp-like: [user@]host:path — a single-letter "host" is a drive letter, never a hostname.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(s)
  let host, p
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scp[1]
    p = scp[2]
  } else {
    try {
      const u = new URL(s)
      host = u.hostname
      p = u.pathname
    } catch {
      return null
    }
  }
  p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!host || !p) return null
  return `${host}/${p}`.toLowerCase()
}

/** The user-config key for a repo: its normalised origin, else `local:<name>@<sha1(commonDir)[0:8]>`. */
export function repoKeyFor({ remoteUrl, gitCommonDir, name }) {
  const k = normalizeRemote(remoteUrl)
  if (k) return k
  const h = createHash('sha1').update(String(gitCommonDir || name || '')).digest('hex').slice(0, 8)
  return `local:${name || 'repo'}@${h}`
}

/** Filesystem-safe slug of a repo key: `github.com/acme/app` → `github.com-acme-app`. */
export function repoSlug(repoKey) {
  return String(repoKey).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Claude Code's transcript directory name for a working directory: every non-alphanumeric
 * character becomes `-`. Verified against real directories: `C:\work\app` → `C--work-app`; a
 * POSIX path yields a leading `-` (`/home/ada/app` → `-home-ada-app`).
 */
export function transcriptSlug(worktreePath) {
  return String(worktreePath).replace(/[^a-zA-Z0-9]/g, '-')
}

/** `~/.claude/projects`, honouring CLAUDE_CONFIG_DIR. */
export function claudeProjectsDir({ platform, env, homedir }) {
  const p = P(platform)
  const base = env.CLAUDE_CONFIG_DIR || p.join(homedir, '.claude')
  return p.join(base, 'projects')
}

/** Per-OS user config directory (override FLEET_CONFIG_HOME). */
export function userConfigDir({ platform, env, homedir }) {
  const p = P(platform)
  if (env.FLEET_CONFIG_HOME) return env.FLEET_CONFIG_HOME
  if (platform === 'win32') return p.join(env.APPDATA || p.join(homedir, 'AppData', 'Roaming'), 'claude-fleet')
  return p.join(env.XDG_CONFIG_HOME || p.join(homedir, '.config'), 'claude-fleet')
}

/** Per-OS, per-repo state directory. NEVER the temp dir: on macOS TMPDIR differs per process context. */
export function stateDirFor({ platform, env, homedir, repoKey }) {
  const p = P(platform)
  const slug = repoSlug(repoKey)
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(homedir, 'AppData', 'Local'), 'claude-fleet', slug)
  return p.join(env.XDG_STATE_HOME || p.join(homedir, '.local', 'state'), 'claude-fleet', slug)
}

/** All config-related paths for one repo on one machine. */
export function configPaths({ platform, env, homedir, repoRoot, repoKey }) {
  const p = P(platform)
  const projectDir = p.join(repoRoot, '.fleet')
  const userDir = userConfigDir({ platform, env, homedir })
  return {
    projectDir,
    projectFile: p.join(projectDir, 'config.json'),
    projectLocalFile: p.join(projectDir, 'config.local.json'),
    projectTrackersDir: p.join(projectDir, 'trackers'),
    projectPlaybooksDir: p.join(projectDir, 'playbooks'),
    userDir,
    userFile: p.join(userDir, 'config.json'),
    stateDir: stateDirFor({ platform, env, homedir, repoKey }),
    transcriptsDir: claudeProjectsDir({ platform, env, homedir }),
  }
}

/** Sub-paths of the state dir (contract §4). */
export function stateLayout(stateDir, platform) {
  const p = P(platform)
  return {
    resolved: p.join(stateDir, 'resolved.json'),
    sessions: p.join(stateDir, 'sessions'),
    locks: p.join(stateDir, 'locks'),
    flags: p.join(stateDir, 'flags'),
    tickets: p.join(stateDir, 'tickets'),
    outbox: p.join(stateDir, 'tracker-outbox'),
    queue: p.join(stateDir, 'queue.txt'),
    intakeRefused: p.join(stateDir, 'intake-refused.jsonl'),
    sweeps: p.join(stateDir, 'sweeps'),
    donor: p.join(stateDir, 'nm-donor'),
    devPages: p.join(stateDir, 'dev-pages'),
    // The install proof: the primary checkout's per-package file counts, cached per lockfile hash.
    // Declared here and in contract §4 because `fleet up` and `fleet doctor --verify-primary` both
    // write it in normal operation — a state file no layout knows about is one no teardown clears.
    installReference: p.join(stateDir, 'install-reference.json'),
    logs: p.join(stateDir, 'logs'),
  }
}

/** Worktree folder of working session n: `<parent>/<repo>-session-<n>` by default. */
export function sessionFolder({ platform, worktreeParent, repoName, template, n }) {
  const p = P(platform)
  const name = template.replace('{repo}', repoName).replace('{n}', String(n))
  return p.join(worktreeParent, name)
}

/** Worktree folder of testing slot: `<parent>/<repo>-<slotBranch>`. */
export function slotFolder({ platform, worktreeParent, repoName, slotBranch }) {
  return P(platform).join(worktreeParent, `${repoName}-${slotBranch}`)
}

/**
 * PURE. Is `child` inside any of `parents`? Separator-blind, whole segments only, and case-blind
 * ONLY where the filesystem is: on Linux `/w/App/dev-pages` and `/w/app` are two different
 * directories, and folding them together fails the `artifacts-dir` probe over a false positive —
 * which blocks a launch on a machine that is fine.
 *
 * ⛔ It lives HERE, not beside either caller. `fleet doctor` and `validateConfig` both answer the
 * same question about the same key (`paths.artifactsDir` inside a worktree), and while there were
 * two copies they disagreed: doctor's folded by platform, validate's folded always, so a case-only
 * path difference passed the probe and was refused by the validator on the same machine.
 */
export function insideAny(child, parents = [], platform = 'linux') {
  const fold = s => (platform === 'win32' ? s.toLowerCase() : s)
  const norm = p => fold(String(p).replace(/\\/g, '/').replace(/\/+$/, ''))
  const c = norm(child)
  return parents.some(p => {
    const q = norm(p)
    // Whole-path or a real boundary: a prefix test would call `<parent>-notes` a child of `<parent>`.
    return c === q || c.startsWith(q + '/')
  })
}
