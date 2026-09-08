// The forge-CLI edge with its truncation guards, and the offline bundle a cloud sandbox reads.
//
// Every process this module starts goes through an injected runner shaped like sys/exec.run —
// `run(command, argv, opts)` → {ok, code, stdout, stderr} — so tests script the forge's replies and
// nothing here ever needs a network. Every call is an explicit argv (see sys/exec.mjs: never a
// shell string), so a PR title or a branch name is data rather than syntax.
//
// Guards, each a failure that happened:
//   * `gh pr view --json files` returns ONE page of 100 with no marker, no error and no ellipsis —
//     a 167-file PR reported exactly 100, and the gate-2 index built on it was silently blind to
//     146 paths;
//   * `gh pr diff` exits 1 past ~20k lines and a naive redirect leaves a 0-byte file behind, which
//     a reader once accepted as "this PR changed nothing" and recorded a confident `clean`;
//   * `gh pr list` stops at its limit with no marker, so a count equal to the limit is truncated by
//     definition — and `--search` goes through the forge's search API, which stops at 1000 whatever
//     the limit says, so a count at that ceiling is truncated too;
//   * "merged after" is never answered from local `git log`: a shallow clone truncates history
//     silently and confidently answers "nothing";
//   * a bundle written json-then-diff and killed mid-diff left a complete json beside a diff cut
//     mid-hunk, and the next plan skipped the PR as "already bundled": the pair is now written
//     atomically with the json LAST, and a json that does not promise the diff's exact byte size is
//     not a bundle;
//   * every `pr` subcommand is pinned to the repo with `-R` when one is given — resolving it from the
//     cwd while the REST path names the repo explicitly mixes two repos into one bundle silently.
//   * a cloud sandbox has neither the tracker connection nor the forge CLI — a worker that tries
//     either hangs rather than fails — so everything it needs is bundled under `_sweep/` up front;
//   * the gate-2 index is ONE search anchored at the earliest bundled PR, and a worklist whose
//     earliest PR merged months ago has more than a thousand PRs merged since — so a window at the
//     search ceiling is split in two by date and each half asked, until every piece sits under it;
//   * an open target has no `mergedAt`, and an index anchored on nothing was once written as an empty
//     file a worker read as "nothing merged since" — an open PR anchors on `createdAt`, and an index
//     that was never computed is absent, never empty;
//   * the indexes are written atomically like the pairs: a plan killed mid-write left half an index
//     that nothing validated on resume and `fleet cloud dispatch --bundle` shipped as-is.

import fs from 'node:fs'
import path from 'node:path'
import { run as execRun } from '../sys/exec.mjs'
import { formatRow } from '../sys/tsv.mjs'

/** The forge's page size: a file list of exactly this length is truncated until proven otherwise. */
export const PAGE = 100
export const VIEW_FIELDS = ['number', 'title', 'body', 'url', 'files', 'state', 'createdAt', 'mergedAt', 'mergeCommit', 'changedFiles']
export const LIST_FIELDS = ['number', 'title', 'mergedAt', 'files']
export const DEFAULT_LIST_LIMIT = 200
/** How often `mergedAfter` may double its limit before giving up — a result must never equal it. */
const LIST_GROWTH_ATTEMPTS = 4
/** The forge's search API returns at most this many results whatever `--limit` asks for — no marker. */
export const SEARCH_CEILING = 1000

// ---- parsing ---------------------------------------------------------------------------------------

/** JSON from the CLI, or an error carrying the first 200 characters — never a bare SyntaxError. */
export function parseJson(text, what) {
  const s = String(text ?? '')
  try {
    return JSON.parse(s)
  } catch {
    throw new Error(`${what}: expected JSON from the forge CLI, got: ${s.trim() === '' ? '<empty>' : s.slice(0, 200)}`)
  }
}

/**
 * Every top-level JSON value in a stream: one value, `[..][..]` (what `--paginate` prints, one array
 * per page), or one value per line. A patch may legitimately contain `][`, so splitting on that text
 * would corrupt it — this scans strings and bracket depth instead. Anything but whitespace between
 * the values (a banner before the first page, an error printed after one) is the "expected JSON"
 * error, never silently dropped.
 */
export function parseJsonStream(text, what = 'gh api') {
  const s = String(text ?? '')
  if (s.trim() === '') return []
  try {
    return [JSON.parse(s)]
  } catch {
    // fall through to the scanner
  }
  const bad = () => new Error(`${what}: expected JSON from the forge CLI, got: ${s.slice(0, 200)}`)
  const out = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (depth === 0) {
      if (c === '{' || c === '[') { start = i; depth = 1; continue }
      if (/\s/.test(c)) continue
      throw bad()
    }
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        out.push(parseJson(s.slice(start, i + 1), what))
        start = -1
      }
    }
  }
  if (depth !== 0 || out.length === 0) throw bad()
  return out
}

/** Flatten paginated output: pages of arrays (`--paginate`) or an array of pages (`--slurp`). */
function flattenPages(values) {
  const out = []
  for (const v of values) {
    if (!Array.isArray(v)) { out.push(v); continue }
    for (const item of v) {
      if (Array.isArray(item)) out.push(...item)
      else out.push(item)
    }
  }
  return out
}

// ---- remote ----------------------------------------------------------------------------------------

/**
 * {owner, repo} from an origin URL in https, ssh or scp form (`git@host:owner/repo.git`). The API
 * path is built from this, and an scp-form remote is not a URL — a URL parser reads it as a scheme.
 */
export function repoFromRemote(url) {
  const s = String(url || '').trim()
  let rest = null
  const scp = /^[^@\s/]+@[^:/\s]+:(.+)$/.exec(s)
  if (scp) rest = scp[1]
  else {
    const u = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/\s]+\/(.+)$/i.exec(s)
    if (u) rest = u[1]
  }
  if (rest === null) throw new Error(`repoFromRemote: cannot read owner/repo from "${s}"`)
  const parts = rest.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length < 2) throw new Error(`repoFromRemote: cannot read owner/repo from "${s}"`)
  const repo = parts[parts.length - 1].replace(/\.git$/i, '')
  const owner = parts[parts.length - 2]
  if (!owner || !repo) throw new Error(`repoFromRemote: cannot read owner/repo from "${s}"`)
  return { owner, repo }
}

// ---- runner plumbing -------------------------------------------------------------------------------

/** A `pr` subcommand is pinned to `opts.repo` with `-R` when one is given; an `api` call names it in its path. */
function gh(run, args, opts) {
  const argv = opts.repo && args[0] === 'pr' ? [...args, '-R', `${opts.repo.owner}/${opts.repo.repo}`] : args
  return run('gh', argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 })
}

function failure(what, r) {
  const why = r.timedOut ? 'timed out' : `exit ${r.code}`
  const detail = String(r.stderr || r.stdout || '').trim().slice(0, 200)
  return new Error(`${what}: ${why}${detail ? ` — ${detail}` : ''}`)
}

/** `repos/{owner}/{repo}` — gh itself resolves the braces from the checkout's origin when none is given. */
function repoPath(repo) {
  return repo ? `repos/${repo.owner}/${repo.repo}` : 'repos/{owner}/{repo}'
}

const filePath = f => f.path ?? f.filename

/** The paths of a `--json files` list; an entry with no path is an error, never a silently shorter list. */
function viewFiles(list, what) {
  return (Array.isArray(list) ? list : []).map(f => {
    if (!f || typeof f !== 'object' || !filePath(f)) throw new Error(`${what}: an entry has no filename: ${JSON.stringify(f).slice(0, 200)}`)
    return filePath(f)
  })
}

/**
 * The COMPLETE file list of a PR through the paginated REST endpoint — the only source that is not
 * capped at one page. Entries carry `patch` (absent for binary or oversized files), which is what
 * prDiff rebuilds from.
 * @returns {Array<{path: string, status: string|null, previousPath: string|null, patch: string|null}>}
 */
export function paginatedFiles(n, { run = execRun, repo = null, cwd, timeoutMs } = {}) {
  const what = `gh api pulls/${n}/files`
  const r = gh(run, ['api', `${repoPath(repo)}/pulls/${n}/files?per_page=${PAGE}`, '--paginate'], { cwd, timeoutMs })
  if (!r.ok) throw failure(what, r)
  const items = flattenPages(parseJsonStream(r.stdout, what))
  return items.map(f => {
    if (!f || typeof f !== 'object' || !filePath(f)) throw new Error(`${what}: an entry has no filename: ${JSON.stringify(f).slice(0, 200)}`)
    return { path: filePath(f), status: f.status ?? null, previousPath: f.previous_filename ?? null, patch: typeof f.patch === 'string' ? f.patch : null }
  })
}

// ---- pr view ---------------------------------------------------------------------------------------

/**
 * One PR's metadata with a file list that is complete or an error — never silently short. The
 * one-page list is paginated whenever it COULD be short (exactly PAGE entries, or fewer than the
 * PR's own `changedFiles` count), and the paginated list is accepted only when its length equals
 * `changedFiles` (or the PR does not report one). Nothing here returns a 100-entry list as the truth.
 */
export function prView(n, { run = execRun, repo = null, cwd, timeoutMs } = {}) {
  const what = `gh pr view ${n}`
  const r = gh(run, ['pr', 'view', String(n), '--json', VIEW_FIELDS.join(',')], { repo, cwd, timeoutMs })
  if (!r.ok) throw failure(what, r)
  const j = parseJson(r.stdout, what)
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${what}: expected a JSON object, got: ${String(r.stdout).slice(0, 200)}`)
  let files = viewFiles(j.files, what)
  const changedFiles = Number.isInteger(j.changedFiles) ? j.changedFiles : null
  if (files.length === PAGE || (changedFiles !== null && files.length < changedFiles)) {
    const all = paginatedFiles(n, { run, repo, cwd, timeoutMs })
    if (changedFiles !== null && all.length !== changedFiles) {
      throw new Error(`${what}: the paginated file list has ${all.length} entries but the PR reports ${changedFiles} changed files — the list is still incomplete`)
    }
    files = all.map(f => f.path)
  }
  const mergeCommit = j.mergeCommit && typeof j.mergeCommit === 'object' ? (j.mergeCommit.oid ?? null) : (typeof j.mergeCommit === 'string' ? j.mergeCommit : null)
  return {
    number: Number.isInteger(j.number) ? j.number : Number(n),
    title: j.title ?? '',
    body: j.body ?? '',
    url: j.url ?? '',
    files,
    state: j.state ?? null,
    createdAt: j.createdAt ?? null,
    mergedAt: j.mergedAt ?? null,
    mergeCommit,
    changedFiles,
  }
}

// ---- pr diff ---------------------------------------------------------------------------------------

/** A unified diff rebuilt from per-file patches, marked so a consumer knows it is reconstructed. */
export function reconstructDiff(n, files, reason) {
  const omitted = files.filter(f => f.patch === null).map(f => f.path)
  const lines = [`# reconstructed from per-file patches — gh pr diff #${n} failed: ${String(reason || 'unknown').split(/\r?\n/)[0]}`]
  if (omitted.length) lines.push(`# ${omitted.length} file(s) without a patch (binary or too large): ${omitted.join(', ')}`)
  for (const f of files) {
    const from = f.previousPath || f.path
    lines.push(`diff --git a/${from} b/${f.path}`)
    if (f.patch === null) { lines.push(`# no patch for ${f.path}`); continue }
    lines.push(f.status === 'added' ? '--- /dev/null' : `--- a/${from}`)
    lines.push(f.status === 'removed' ? '+++ /dev/null' : `+++ b/${f.path}`)
    lines.push(f.patch.replace(/\n$/, ''))
  }
  return { diff: lines.join('\n') + '\n', omitted }
}

/**
 * The PR's diff — the forge's own when it delivers one, otherwise rebuilt from the paginated
 * patches with `reconstructed: true`. Throws rather than ever returning an empty diff: a 0-byte diff
 * reads as "no changes" and produces the one ledger status nobody re-checks.
 * @returns {{diff: string, reconstructed: boolean, omitted: string[]}}
 */
export function prDiff(n, { run = execRun, repo = null, cwd, timeoutMs } = {}) {
  const what = `gh pr diff ${n}`
  const r = gh(run, ['pr', 'diff', String(n)], { repo, cwd, timeoutMs })
  if (r.ok && String(r.stdout).trim() !== '') return { diff: r.stdout, reconstructed: false, omitted: [] }
  const reason = r.ok ? 'exit 0 with a 0-byte diff' : `${r.timedOut ? 'timed out' : `exit ${r.code}`} ${String(r.stderr || '').trim()}`.trim()
  const files = paginatedFiles(n, { run, repo, cwd, timeoutMs })
  if (files.length === 0) {
    throw new Error(`${what}: ${reason}; the paginated file list is empty too — refusing to record a 0-byte diff as "no changes"`)
  }
  const { diff, omitted } = reconstructDiff(n, files, reason)
  return { diff, reconstructed: true, omitted }
}

// ---- indexes ---------------------------------------------------------------------------------------

/** path → sorted PR numbers, from PRs carrying `files: string[]`. */
export function pathIndex(prs) {
  const index = new Map()
  for (const p of prs) {
    for (const f of p.files || []) {
      if (!index.has(f)) index.set(f, [])
      const list = index.get(f)
      if (!list.includes(p.number)) list.push(p.number)
    }
  }
  for (const list of index.values()) list.sort((a, b) => a - b)
  return new Map([...index.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

/**
 * A date for the search qualifier. A bare `YYYY-MM-DD` passes through; anything else is normalised
 * to `YYYY-MM-DDTHH:MM:SS+00:00` — the forge's search syntax takes `+00:00`, not a trailing `Z`,
 * and fractional seconds (what `Date#toISOString` yields) mis-parse the qualifier with no error, so
 * the window is silently wrong. A timestamp with no zone is read as UTC, as the forge reads it.
 */
function searchDate(date) {
  const s = String(date ?? '').trim()
  if (!s) throw new Error('mergedAfter: a date is required')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`)
  if (Number.isNaN(t.getTime())) throw new Error(`mergedAfter: not a date: "${s}"`)
  return t.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/** The search form of an epoch millisecond count, at whole seconds — the forge's own resolution. */
const stamp = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00')

/**
 * PRs merged into `base` after `date`, with the paths each touched — the gate-2 index. Asked of the
 * forge, never of local history. A count equal to the limit is truncated by definition, so the limit
 * doubles until the count sits under it. A count at the search API's own ceiling (SEARCH_CEILING) is
 * truncated whatever the limit says, so that window is split in two by date (`merged:A..B`) and each
 * half asked, recursively, until every piece sits under the ceiling — the far edge is `until`
 * (default: now) — and the pieces are unioned by PR number. The `..` form is inclusive at both ends,
 * so a split window may list a PR merged in the very second the range starts (the target itself, at
 * the earliest edge); over-inclusion costs a worker one diff read, under-inclusion files a fixed bug.
 * A window one second wide still at the ceiling cannot be split further and is an error. A PR whose
 * file list is exactly one page is paginated like any other (repairing three such PRs once took an
 * index from 811 rows to 957).
 * @returns {{since: string, base: string, prs: Array<{number, title, mergedAt, files: string[]}>, index: Map<string, number[]>, count: number, limit: number}}
 *   `limit` is the widest limit any window needed.
 */
export function mergedAfter(date, { run = execRun, base = 'main', limit = DEFAULT_LIST_LIMIT, repo = null, cwd, timeoutMs, until = null } = {}) {
  const since = searchDate(date)
  /** One window's list with the limit that held it, or null when it sits at the search ceiling. */
  const ask = qualifier => {
    let used = limit
    for (let attempt = 0; attempt < LIST_GROWTH_ATTEMPTS; attempt++) {
      const what = `gh pr list --state merged --limit ${used}`
      const r = gh(run, ['pr', 'list', '--state', 'merged', '--base', base, '--search', qualifier, '--json', LIST_FIELDS.join(','), '--limit', String(used)], { repo, cwd, timeoutMs })
      if (!r.ok) throw failure(what, r)
      const j = parseJson(r.stdout, what)
      if (!Array.isArray(j)) throw new Error(`${what}: expected a JSON array, got: ${String(r.stdout).slice(0, 200)}`)
      if (j.length >= SEARCH_CEILING) return null
      if (j.length < used) return { list: j, used }
      used *= 2
    }
    throw new Error(`mergedAfter: the merged-PR list still equals its limit at ${used / 2} — the result is truncated by definition; raise limit or narrow the date`)
  }
  const byNumber = new Map()
  let widest = limit
  const collect = (qualifier, fromMs, toMs) => {
    const got = ask(qualifier)
    if (got) {
      widest = Math.max(widest, got.used)
      for (const p of got.list) byNumber.set(Number(p.number), p)
      return
    }
    const end = toMs ?? (until === null ? Date.now() : Date.parse(searchDate(until)))
    if (end - fromMs < 2000) {
      throw new Error(`mergedAfter: ${SEARCH_CEILING} or more PRs merged in the second at ${stamp(fromMs)} — the forge search API returns at most ${SEARCH_CEILING} whatever the limit, and a one-second window cannot be split further`)
    }
    const mid = fromMs + Math.floor((end - fromMs) / 2000) * 1000
    collect(`merged:${stamp(fromMs)}..${stamp(mid)}`, fromMs, mid)
    collect(`merged:${stamp(mid)}..${stamp(end)}`, mid, end)
  }
  collect(`merged:>${since}`, Date.parse(since), null)
  const prs = [...byNumber.values()].sort((a, b) => Number(a.number) - Number(b.number)).map(p => {
    const number = Number(p.number)
    let files = viewFiles(p.files, `gh pr list (#${number})`)
    if (files.length === PAGE) files = paginatedFiles(number, { run, repo, cwd, timeoutMs }).map(f => f.path)
    return { number, title: p.title ?? '', mergedAt: p.mergedAt ?? null, files }
  })
  return { since, base, prs, index: pathIndex(prs), count: prs.length, limit: widest }
}

/** path → open PR numbers, from bundled PRs — the gate-3 index. Only PRs whose state is open count. */
export function openIndex(prs) {
  return pathIndex(prs.filter(p => String(p.state || '').toUpperCase() === 'OPEN'))
}

// ---- bundle ----------------------------------------------------------------------------------------

const rowsFor = (index, byNumber, extra) => {
  const rows = []
  for (const [p, numbers] of index) for (const n of numbers) rows.push([p, String(n), ...extra(byNumber.get(n) || {})])
  return rows
}

/** The bundle's paths under one sweep dir (contract §4 `_sweep/`) — the one place these names are spelled. */
export function bundleLayout(sweepDir) {
  const dir = path.join(sweepDir, '_sweep')
  return { dir, prs: path.join(dir, 'prs'), gate2Index: path.join(dir, 'gate2-index.tsv'), openIndex: path.join(dir, 'open-index.tsv') }
}

/** Write `text` so a reader never sees a half-written file: a temp file beside it, renamed over it. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * The record of a PR already bundled, or null when anything about it is short: no json, a json that
 * does not parse (a run killed mid-write), or a diff whose size on disk is not the `diffBytes` the
 * record promised — a diff cut mid-hunk carries no marker of its own. Null means "ask the forge".
 */
function readBundle(prsDir, n) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(prsDir, `${n}.json`), 'utf8'))
    const size = fs.statSync(path.join(prsDir, `${n}.diff`)).size
    return record && typeof record === 'object' && size > 0 && record.diffBytes === size ? record : null
  } catch {
    return null
  }
}

/**
 * Write the offline bundle under `<sweepDir>/_sweep/` (see bundleLayout): `prs/<n>.json`,
 * `prs/<n>.diff`, `gate2-index.tsv` (`path  pr  mergedAt  title`) and `open-index.tsv`
 * (`path  pr  title`). One PR's failure is recorded, not thrown — a plan over hundreds of PRs must
 * not die on one — and a failed PR leaves NO diff file behind, so a worker finds "bundle missing"
 * rather than a 0-byte diff. Each pair is written atomically, diff first and json last, and the json
 * records `diffBytes`: a PR is skipped as already bundled only when its json parses and the diff on
 * disk is exactly that long. Re-running the plan is the resume path and must not re-ask the forge
 * for what is on disk — nor trust a residue of a killed run.
 *
 * The gate-2 window opens at `since`, else at the earliest anchor among the bundled PRs: a merged
 * PR's `mergedAt`, an open PR's `createdAt` (playbook §7.3 — an open target is compared against what
 * is merged on the base branch, and nothing merged before it existed can have fixed it later). With
 * no anchor at all the index is NOT written: an absent index reads as "never computed", an empty one
 * as "nothing merged since", and a worker reads only the disk.
 * @param {Array<number|string>} prs
 * @param {string} sweepDir
 * @returns {{ok: boolean, dir: string, written: number[], skipped: number[], errors: Array<{pr: number|string|null, error: string}>, gate2: {since: string|null, count: number, rows: number, limit: number|null}, open: {count: number, rows: number}}}
 *   `errors[].pr` is the PR number; the raw input when it was not a PR number; null for the one
 *   sweep-level failure, the gate-2 index.
 */
export function bundle(prs, sweepDir, { run = execRun, base = 'main', repo = null, since = null, until = null, cwd, timeoutMs } = {}) {
  const layout = bundleLayout(sweepDir)
  const { dir, prs: prsDir } = layout
  fs.mkdirSync(prsDir, { recursive: true })
  const written = []
  const skipped = []
  const errors = []
  const views = new Map()
  for (const raw of prs) {
    // digits only: Number() also reads "1e3", "0x10" and "" — a malformed worklist row must land in
    // errors[], never bundle a different PR
    const digits = String(raw).trim()
    const n = /^\d+$/.test(digits) ? Number(digits) : NaN
    if (!Number.isInteger(n) || n <= 0) { errors.push({ pr: raw, error: `not a PR number: "${raw}"` }); continue }
    const jsonFile = path.join(prsDir, `${n}.json`)
    const diffFile = path.join(prsDir, `${n}.diff`)
    const onDisk = readBundle(prsDir, n)
    if (onDisk) {
      views.set(n, onDisk)
      skipped.push(n)
      continue
    }
    try {
      const view = prView(n, { run, repo, cwd, timeoutMs })
      const d = prDiff(n, { run, repo, cwd, timeoutMs })
      const record = { ...view, reconstructed: d.reconstructed, omitted: d.omitted, diffBytes: Buffer.byteLength(d.diff) }
      // diff first, json last: the json is the marker readBundle requires, so a run killed between
      // the two leaves a PR that reads as "not bundled", never as one with a shorter diff
      writeAtomic(diffFile, d.diff)
      writeAtomic(jsonFile, JSON.stringify(record, null, 2) + '\n')
      views.set(n, record)
      written.push(n)
    } catch (e) {
      fs.rmSync(diffFile, { force: true })
      fs.rmSync(jsonFile, { force: true })
      errors.push({ pr: n, error: e.message })
    }
  }

  const bundled = [...views.values()]
  const anchors = bundled.map(v => v.mergedAt || v.createdAt).filter(Boolean).sort()
  const from = since || anchors[0] || null
  let gate2 = { since: from, count: 0, rows: 0, limit: null }
  if (from) {
    try {
      const m = mergedAfter(from, { run, base, repo, cwd, timeoutMs, until })
      const byNumber = new Map(m.prs.map(p => [p.number, p]))
      const rows = rowsFor(m.index, byNumber, p => [p.mergedAt || '', p.title || ''])
      writeAtomic(layout.gate2Index, rows.map(formatRow).join(''))
      gate2 = { since: m.since, count: m.count, rows: rows.length, limit: m.limit }
    } catch (e) {
      fs.rmSync(layout.gate2Index, { force: true })
      errors.push({ pr: null, error: `gate-2 index: ${e.message}` })
    }
  } else {
    fs.rmSync(layout.gate2Index, { force: true })
    if (bundled.length) errors.push({ pr: null, error: 'gate-2 index: nothing anchors the window — no bundled PR carries mergedAt or createdAt, and no since was given' })
  }

  const openIdx = openIndex(bundled)
  const byNumber = new Map(bundled.map(v => [v.number, v]))
  const openRows = rowsFor(openIdx, byNumber, p => [p.title || ''])
  writeAtomic(layout.openIndex, openRows.map(formatRow).join(''))

  return {
    ok: errors.length === 0,
    dir,
    written,
    skipped,
    errors,
    gate2,
    open: { count: bundled.filter(v => String(v.state || '').toUpperCase() === 'OPEN').length, rows: openRows.length },
  }
}
