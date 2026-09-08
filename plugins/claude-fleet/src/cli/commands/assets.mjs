// `fleet assets add <file…> --branch <name>` (contract §7) — put screenshots on an orphan assets
// branch and print the raw URLs a PR body or a tracker comment embeds.
//
//   ⛔ The branch is written with PLUMBING and is never checked out. Checking out an orphan branch
//      in a session's worktree untracks every file the session is working on; a session that did it
//      by hand lost its diff. `hash-object` → `mktree` → `commit-tree` → `update-ref` touches the
//      index and the working tree not at all.
//   ⛔ The PNGs must never enter the PR's diff — that is the whole reason this branch exists — so
//      nothing here stages anything.
//   ⛔ A push that failed is reported as a FAILURE even though the local branch now exists: the
//      URLs this command prints would 404, and a review page full of broken images reads as work
//      that was never done.
//   ⛔ Blobs are written with `--no-filters`. A repository whose `.gitattributes` claims a PNG is
//      text would otherwise have its line endings "normalised" into a corrupt image, and the
//      corruption is only visible to the reviewer.

import fs from 'node:fs'
import path from 'node:path'

import { run as sysRun } from '../../sys/exec.mjs'
import { envelope } from '../../cli.mjs'
import { CliError, stringFlag } from '../args.mjs'

export const name = 'assets'
export const usage = 'fleet assets add <file…> --branch <name>'
export const needsConfig = true
export const needsBackend = false

const SUBS = ['add']

/** Forges whose blob URLs serve a file hot-linkably; anything else cannot host an assets branch. */
const RAW_URL = Object.freeze({
  github: (base, branch, file) => `${base}/blob/${branch}/${file}?raw=true`,
  gitlab: (base, branch, file) => `${base}/-/raw/${branch}/${file}`,
})

/**
 * PURE. The web base of a remote — `https://<host>/<owner>/<name>`, credentials and `.git` dropped,
 * scp form (`git@host:owner/name.git`) normalised.
 *
 * CASE IS PRESERVED, unlike the repo key: that one is lowercased so a config lookup is stable, and a
 * URL built from it 404s on any forge whose paths are case-sensitive.
 */
export function webBaseFor(remoteUrl) {
  const s = String(remoteUrl || '').trim()
  if (!s) return null
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s)
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
  return host && p ? `https://${host}/${p}` : null
}

/** PURE. The hot-linkable URL of one file on the assets branch, or null when the forge cannot serve one. */
export function rawUrlFor({ host, base, branch, file }) {
  const make = RAW_URL[host]
  if (!make || !base) return null
  return make(base, encodeURIComponent(branch), file.split('/').map(encodeURIComponent).join('/'))
}

/**
 * PURE. One `git mktree -z` record. The mode is a regular file: this branch holds evidence, not code.
 *
 * ⛔ NUL-terminated, to match the `ls-tree -z` the existing entries were read with: names are then
 * LITERAL on both sides. Plain `ls-tree` C-quotes anything non-ASCII (`core.quotePath` defaults to
 * true), so `écran.png` would come back as `"\303\251cran.png"`, be keyed under that spelling, and a
 * later add of the same file would put a SECOND entry of the same name in the tree — a malformed
 * tree object (`git fsck`: duplicateEntries) that loses the shot the PR body already links to.
 */
function treeLine(entry) {
  return `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`
}

function gitOrFail(repo, argv, what, opts = {}) {
  const r = sysRun('git', ['-C', repo, ...argv], { timeoutMs: 120_000, ...opts })
  if (!r.ok) {
    throw new CliError('assets.git-failed', `${what} failed: ${(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `git exit ${r.code}`}`, `the command was: git ${argv.join(' ')}`, 1)
  }
  return r.stdout.trim()
}

export async function run(ctx, args) {
  const sub = args.sub
  if (!sub || !SUBS.includes(sub)) {
    throw new CliError('assets.unknown-subcommand', `fleet assets takes ${SUBS.join(' | ')}${sub ? `, not "${sub}"` : ''}`, usage)
  }
  const repo = ctx.facts.git && (ctx.facts.git.toplevel || ctx.facts.git.primary)
  if (!repo) throw new CliError('assets.no-repo', `${ctx.cwd} is not inside a git checkout`, 'run this from your session worktree; the branch is written into the repository you are in', 1)

  const branch = stringFlag(args.flags, 'branch', null)
  if (!branch) throw new CliError('assets.branch-required', '--branch is required', 'render vcs.assetsBranchTemplate for this ticket, e.g. --branch assets-ABC-1234')
  // A literal `{key}` was once pushed as a branch name and every embed pointed at it.
  const placeholder = /\{[a-zA-Z0-9_-]+\}/.exec(branch)
  if (placeholder) throw new CliError('assets.branch-unrendered', `the branch name "${branch}" still carries the placeholder ${placeholder[0]}`, 'render vcs.assetsBranchTemplate before passing it')
  if (!sysRun('git', ['-C', repo, 'check-ref-format', '--branch', branch], { timeoutMs: 30_000 }).ok) {
    throw new CliError('assets.bad-branch', `"${branch}" is not a valid git branch name`, 'git check-ref-format --branch rejected it')
  }

  const files = collectFiles(ctx, args.positionals.slice(1))
  const remote = ctx.config.repo.remote
  const host = ctx.config.vcs.host

  // Everything already on the branch stays: a second `assets add` for the same ticket (an after-shot
  // taken an hour later) must not drop the before-shot the PR body already links to.
  const existing = readBranchTree(ctx, { repo, remote, branch })
  const entries = new Map(existing.entries.map(e => [e.name, e]))
  for (const f of files) {
    const sha = gitOrFail(repo, ['hash-object', '-w', '--no-filters', '--', f.abs], `hashing ${f.name}`)
    entries.set(f.name, { mode: '100644', type: 'blob', sha, name: f.name })
  }

  const tree = gitOrFail(repo, ['mktree', '-z'], 'writing the tree', { input: [...entries.values()].map(treeLine).join('') })
  const commitArgv = ['commit-tree', tree, '-m', `assets: ${files.map(f => f.name).join(', ')}`]
  if (existing.head) commitArgv.splice(2, 0, '-p', existing.head)
  const commit = gitOrFail(repo, commitArgv, 'writing the commit')
  // The old value is passed so a concurrent `assets add` on the same branch fails loudly instead of
  // dropping the other session's files.
  gitOrFail(repo, ['update-ref', `refs/heads/${branch}`, commit, existing.head || ''], `moving refs/heads/${branch}`)

  const push = sysRun('git', ['-C', repo, 'push', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 300_000 })
  const base = webBaseFor(gitRemoteUrl(repo, remote))
  const urls = files.map(f => ({ file: f.name, url: rawUrlFor({ host, base, branch, file: f.name }) }))

  const payload = {
    branch,
    commit,
    parent: existing.head,
    remote,
    pushed: push.ok,
    files: urls,
    // A forge that cannot hot-link is not a failure of this command: the files are on the branch and
    // the caller embeds them another way (checker.attachStrategy names which).
    host,
  }
  if (!push.ok) {
    ctx.json(envelope(false, {
      ...payload,
      error: {
        code: 'assets.push-failed',
        message: `the branch was written locally (${commit.slice(0, 12)}) but pushing it to ${remote} failed: ${(push.stderr || push.stdout || '').trim().split(/\r?\n/)[0]}`,
        hint: 'every URL below would 404 until the push lands — retry the push before embedding them',
      },
    }))
    ctx.log(`assets: ${branch} committed locally as ${commit} but NOT pushed`)
    return 1
  }

  ctx.json(envelope(true, payload))
  ctx.log(`assets: ${files.length} file(s) on ${branch} at ${commit} (pushed to ${remote}; the branch was never checked out)`)
  for (const u of urls) ctx.log(u.url ? `${u.file}: ${u.url}` : `${u.file}: on the branch, but vcs.host ${host} cannot serve a raw-content URL for it`)
  ctx.log(`record the commit: ${commit} — a PR embed pinned to a branch name moves when the branch does`)
  return 0
}

/**
 * The files, resolved and checked. Names are BASENAMES at the branch root, so two files that share
 * one is refused rather than silently overwritten: a before.png quietly replaced by another
 * directory's before.png is evidence nobody can tell is wrong.
 */
function collectFiles(ctx, given) {
  if (!given.length) throw new CliError('assets.no-files', 'fleet assets add takes one or more files', 'fleet assets add before.png after.png --branch assets-ABC-1234')
  const out = []
  const seen = new Map()
  for (const g of given) {
    const abs = path.resolve(ctx.cwd, g)
    let st
    try {
      st = fs.statSync(abs)
    } catch (e) {
      throw new CliError('assets.file-unreadable', `${g}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`, 'the captures must exist on disk before they can be pushed')
    }
    if (!st.isFile()) throw new CliError('assets.not-a-file', `${g} is not a file`, 'pass the capture files themselves, not a directory')
    const nameOf = path.basename(abs)
    if (seen.has(nameOf)) throw new CliError('assets.duplicate-name', `two files would land on the branch as "${nameOf}": ${seen.get(nameOf)} and ${g}`, 'the branch is flat, so rename one — a silently overwritten capture is evidence of the wrong thing')
    seen.set(nameOf, g)
    out.push({ abs, name: nameOf })
  }
  return out
}

/** The remote's URL, or null when there is no such remote (a local-only repo still gets its branch). */
function gitRemoteUrl(repo, remote) {
  const r = sysRun('git', ['-C', repo, 'remote', 'get-url', remote], { timeoutMs: 30_000 })
  return r.ok ? r.stdout.trim() : null
}

/**
 * The branch's current tip and tree entries — fetching the remote's copy first when this checkout
 * has never seen it. Another session (or the same ticket's earlier run) may already have pushed
 * files there, and building an orphan commit over them would delete evidence a PR already links to.
 * @returns {{head: string|null, entries: Array<{mode, type, sha, name}>}}
 */
function readBranchTree(ctx, { repo, remote, branch }) {
  const ref = `refs/heads/${branch}`
  let head = null
  const local = sysRun('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { timeoutMs: 30_000 })
  if (local.ok && local.stdout.trim()) head = local.stdout.trim()

  if (!head) {
    const remoteHas = sysRun('git', ['-C', repo, 'ls-remote', '--exit-code', remote, ref], { timeoutMs: 60_000 })
    if (remoteHas.ok) {
      // Fetched into the local branch ref directly: the branch is never checked out, so nothing can
      // be holding it, and the next commit is built on what is really published.
      const fetched = sysRun('git', ['-C', repo, 'fetch', remote, `+${ref}:${ref}`], { timeoutMs: 300_000 })
      if (!fetched.ok) {
        throw new CliError('assets.fetch-failed', `${remote} already has ${branch} but it could not be fetched: ${(fetched.stderr || fetched.stdout).trim().split(/\r?\n/)[0]}`, 'pushing over it would drop the files already there; fix the fetch first', 1)
      }
      const after = sysRun('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { timeoutMs: 30_000 })
      head = after.ok ? after.stdout.trim() : null
      if (head) ctx.log(`assets: ${branch} already exists on ${remote}; adding to it rather than replacing it`)
    }
    // ls-remote failing is "not published, or the remote is unreachable" — the push at the end is
    // what reports the second case, and it reports it loudly.
  }

  if (!head) return { head: null, entries: [] }
  // ⛔ `-z`, split on NUL: plain `ls-tree` C-quotes a name with any non-ASCII byte in it, and an
  // entry keyed under `"\303\251cran.png"` collides with nothing when the same file is added again —
  // the tree then carries two entries of one name and git calls it malformed. `-z` names are literal
  // and unquoted, which is exactly the form `mktree -z` takes back.
  const listed = gitOrFail(repo, ['ls-tree', '-z', head], `reading ${branch}`)
  const entries = []
  for (const record of listed.split('\0')) {
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record)
    if (m) entries.push({ mode: m[1], type: m[2], sha: m[3], name: m[4] })
  }
  return { head, entries }
}
