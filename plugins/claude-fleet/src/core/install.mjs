// Installing a fresh worktree, in load-gated waves.
//
// ⛔ THE RULE THIS FILE EXISTS FOR: an interrupted install leaves HALF-EXTRACTED PACKAGE
// DIRECTORIES, and a re-run will NOT repair them — the package manager sees the directory and calls
// that package installed, so it never re-extracts it. Every cheap signal therefore lies: the install
// exits 0, the ready sentinel gets written, the dependency listing is clean, unit tests and lint
// pass. The damage surfaces much later as a missing module, or as a baffling type error when a
// nested workspace package's missing type declaration makes the compiler fall back to a DIFFERENT
// MAJOR VERSION of a dependency and blame a file nowhere near the session's diff.
//
// The only detector that has ever caught it is a per-package FILE COUNT diff against a reference
// tree (a snapshot of the intact primary checkout), and the scan must cover the NESTED
// `node_modules` inside workspace packages — a root-only scan misses exactly the trees that break.
//
// Repair is deleting the damaged package directories and installing again. Never the clean-install
// variant that wipes the whole tree (that turns a three-package repair into a full rebuild), and
// never a recursive delete that follows a workspace link: those links point back at the primary
// checkout, and following one has emptied a primary before.
//
// Pure decisions (verdictFromCounts, readyState, repairPlan) are kept separate from the filesystem
// and process wrappers, which is what makes the traps above unit tests instead of comments.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { decide, holdDecision } from './pacing.mjs'
import { probeMemory } from '../sys/memory.mjs'
import { shellCommand } from '../sys/exec.mjs'
import { stateLayout } from '../config/paths.mjs'

/** The reference snapshot, cached per lockfile hash under the state directory.
 *
 *  The name is declared in contract §4 and in stateLayout() (src/config/paths.mjs, which mirrors that
 *  section key for key); this constant exists so a test can name the file without re-spelling it. */
export const REFERENCE_FILE = 'install-reference.json'

/** Lockfiles, most authoritative first. The first one present keys the reference. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']

// ---- pure: the verdict ---------------------------------------------------------------------------

const toMap = (v) => {
  if (v instanceof Map) return v
  if (v && typeof v === 'object' && v.packages) return toMap(v.packages)
  return new Map(Object.entries(v || {}))
}

/**
 * Compare per-package file counts against the reference tree. PURE.
 *
 * ⛔ The gate is PER PACKAGE, never the aggregate. One package extracted to an empty directory
 * changes a 276,000-file total by a fraction of a percent, so an aggregate ratio sails past any
 * sane tolerance while the tree is unusable. The aggregate is reported because it reads well in a
 * log; it decides nothing.
 *
 * A package present in the worktree but absent from the reference is IGNORED: a live primary and a
 * fresh checkout legitimately differ in what caches and generated files they carry, and treating
 * that as damage would fail every healthy tree.
 *
 * @param {Map<string,number>|object} actual     packageKey → file count, from scanTree()
 * @param {Map<string,number>|object} reference  the same shape, or a whole reference record
 * @param {number} tolerance                     install.proof.tolerance
 */
export function verdictFromCounts(actual, reference, tolerance) {
  const a = toMap(actual)
  const r = toMap(reference)
  const missing = []
  const damaged = []
  let totalActual = 0
  let totalReference = 0
  const empty = { missing, damaged, checked: 0, aggregateRatio: null, worstRatio: null, totalActual: 0, totalReference: 0 }

  // A tolerance of 0 would certify a tree whose every package is an empty directory — the exact
  // shape this module exists to catch — so it is a refusal, not a permissive setting.
  if (!(Number(tolerance) > 0) || Number(tolerance) > 1) {
    return { ok: false, reason: `install.proof.tolerance must be greater than 0 and at most 1 (got ${tolerance})`, ...empty }
  }
  // An empty reference passes everything. A reference captured while the primary was mid-install (or
  // had no node_modules at all) would certify every broken worktree in the fleet.
  if (r.size === 0) {
    return { ok: false, reason: 'the reference tree is empty, so it can prove nothing', ...empty }
  }

  for (const [pkg, expected] of r) {
    totalReference += expected
    const found = a.get(pkg)
    if (found === undefined) {
      missing.push(pkg)
      continue
    }
    totalActual += found
    const ratio = expected > 0 ? found / expected : 1
    if (ratio < tolerance) damaged.push({ pkg, actual: found, expected, ratio })
  }
  damaged.sort((x, y) => x.ratio - y.ratio || x.pkg.localeCompare(y.pkg))

  const ok = missing.length === 0 && damaged.length === 0
  const worstRatio = damaged.length ? damaged[0].ratio : missing.length ? 0 : 1
  const aggregateRatio = totalReference > 0 ? totalActual / totalReference : null
  const reason = ok
    ? `${r.size} packages match the reference within ${tolerance}`
    : `${missing.length} package(s) missing, ${damaged.length} half-extracted` +
      (damaged.length ? ` (worst: ${damaged[0].pkg} ${damaged[0].actual}/${damaged[0].expected} files)` : '') +
      (missing.length ? ` (first missing: ${missing[0]})` : '')

  return { ok, reason, missing, damaged, checked: r.size, aggregateRatio, worstRatio, totalActual, totalReference }
}

/**
 * What to delete before installing again. PURE.
 *
 * ⛔ Only the damaged package directories, never the tree root: the clean-install variant wipes
 * node_modules and turns a three-package repair into a full rebuild, which on a fleet is the
 * difference between a minute and half an hour per worktree.
 */
export function repairPlan(verdict, worktree = '') {
  const keys = [...(verdict.missing || []), ...(verdict.damaged || []).map(d => d.pkg)]
  const dirs = keys.filter(k => k && k !== 'node_modules' && !k.endsWith('/node_modules'))
  return dirs.map(k => (worktree ? path.join(worktree, k) : k))
}

// ---- pure: is this worktree ready? ----------------------------------------------------------------

/**
 * Judge an OBSERVED worktree — `{path, sentinel, lockfileHash}` from observeWorktree(). PURE.
 *
 * ⛔ The sentinel is judged against the lockfile it was written for. Worktrees are reused rather
 * than recreated, so a sentinel from an earlier run outlives the tree it certified: the base branch
 * moves, the lockfile changes by one byte, and the stale sentinel makes the launcher skip the
 * install entirely while every session in that worktree builds against the wrong dependencies.
 *
 * A sentinel that cannot say what it proved is not proof — treating an unreadable one as ready is
 * exactly the "exit code with a nicer name" this module refuses to trust.
 *
 * ⛔ "This repo has no lockfile" is NOT the same answer as "this sentinel failed to record one".
 * A repo whose bootstrap is `make setup` has none of the LOCKFILES to hash, and reading its
 * deliberate `null` as unproven would make every such worktree permanently not-ready — reinstalled
 * on every pass, forever. The `lockfileless` marker is what separates the two.
 */
export function readyState(worktree, config) {
  const s = worktree && worktree.sentinel
  if (!s) return { ready: false, state: 'no-sentinel', reason: 'no ready sentinel: this worktree has not been installed' }
  const lockfileless = s.lockfileHash === null && s.lockfileless === true
  if (!s.lockfileHash && !lockfileless) return { ready: false, state: 'unproven', reason: 'the ready sentinel does not record what it proved, so it proves nothing' }
  if (worktree.lockfileHash && s.lockfileHash !== worktree.lockfileHash) {
    return {
      ready: false,
      state: 'stale-lockfile',
      reason: `the ready sentinel was written for ${s.lockfileHash ? `lockfile ${String(s.lockfileHash).slice(0, 16)}` : 'a repo with no lockfile'}, the worktree is at ${String(worktree.lockfileHash).slice(0, 16)}`,
    }
  }
  return {
    ready: true,
    state: 'ready',
    reason: `verified ${s.at || 'at an unrecorded time'} (${s.mode || 'unknown'} proof${lockfileless ? ', this repo has no lockfile' : ''})`,
    at: s.at || null,
    mode: s.mode || null,
  }
}

// ---- filesystem: scanning -------------------------------------------------------------------------

const keyOf = (root, dir) => path.relative(root, dir).split(path.sep).join('/')

function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // a directory that vanished mid-scan is not a scan failure; the counts report the rest
  }
}

/**
 * Files inside one package directory, recursively.
 *
 * A symlink counts as ONE entry and is never followed: a workspace link inside node_modules points
 * back at the primary checkout, and a walk that follows it charges that whole source tree to one
 * package's count (the same mistake in a delete has emptied a primary).
 *
 * A nested `node_modules` is skipped here because it is scanned as its own packages — otherwise
 * every nested file would be counted twice and a gutted nested tree would hide inside its parent's
 * total, which is the one place this check must not be blind.
 */
export function countFiles(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of dirEntries(cur)) {
      if (e.isSymbolicLink()) { n++; continue }
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') stack.push(path.join(cur, e.name))
        continue
      }
      n++
    }
  }
  return n
}

/**
 * Per-package file counts for a whole checkout: `node_modules/<pkg>` → count, INCLUDING every
 * nested `node_modules` (`packages/pkg-a/node_modules/<pkg>`), which is where the damage that breaks
 * a build usually lives.
 *
 * Dot-entries inside a node_modules are skipped except `.bin`: a live primary accumulates cache
 * directories a fresh worktree will never have, and counting those as packages would report every
 * healthy fresh tree as missing half of them. `.bin` is kept because an empty shim directory is a
 * real corrupt shape — one signal among thousands here, never a check on its own.
 *
 * ⛔ Skipped means NOT WALKED, not merely not counted. A cache holding a vendored tree
 * (`node_modules/.cache/x/node_modules/dep`) would otherwise enter the counts under its own key, so
 * the reference would carry packages no fresh worktree can ever have and every one of them would be
 * reported missing forever — and the walk would pay for a full recursive scan of every cache on a
 * tree this module sizes at ~276,000 files.
 */
export function scanTree(root) {
  const counts = new Map()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    const inNodeModules = path.basename(dir) === 'node_modules'
    for (const e of dirEntries(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      if (e.name === '.git') continue
      const child = path.join(dir, e.name)
      if (inNodeModules) {
        if (e.name === '.bin') {
          counts.set(keyOf(root, child), countFiles(child))
          continue
        }
        if (e.name.startsWith('.')) continue // neither counted nor walked: see the note above
        if (e.name.startsWith('@')) {
          // scoped packages sit one level deeper; each still needs walking for its own nested tree
          for (const s of dirEntries(child)) {
            if (!s.isDirectory() || s.isSymbolicLink()) continue
            const scoped = path.join(child, s.name)
            counts.set(keyOf(root, scoped), countFiles(scoped))
            stack.push(scoped)
          }
          continue
        }
        counts.set(keyOf(root, child), countFiles(child))
      }
      stack.push(child)
    }
  }
  return counts
}

/** sha256 of the first lockfile present, prefixed by its name. null when the repo has none. */
export function lockfileHashOf(dir) {
  for (const name of LOCKFILES) {
    let buf
    try {
      buf = fs.readFileSync(path.join(dir, name)) // a Buffer, never utf8: one of these lockfiles is binary
    } catch {
      continue
    }
    return `${name}:${createHash('sha256').update(buf).digest('hex').slice(0, 32)}`
  }
  return null
}

/** Sizes of the configured probe files, or null where one is absent. */
function sizesOf(root, files) {
  const out = {}
  for (const rel of files || []) {
    try {
      const st = fs.statSync(path.join(root, rel))
      out[rel] = st.isFile() ? st.size : null
    } catch {
      out[rel] = null
    }
  }
  return out
}

// ---- filesystem: the reference --------------------------------------------------------------------

export function referenceFile(config) {
  // `config.paths.state` is the layout loadConfig already resolved; a hand-built config in a test may
  // carry only `stateDir`, so derive it rather than requiring every caller to pass the whole layout.
  const state = config.paths.state || stateLayout(config.paths.stateDir, process.platform)
  return state.installReference
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Write through a temp file: a reader landing mid-write sees the old file or none, never half of one. */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * Snapshot the primary checkout's per-package counts, keyed by lockfile hash and cached at
 * `<stateDir>/install-reference.json`.
 *
 * The cache key is the lockfile hash and nothing else: one byte of lockfile change reshapes the
 * tree, and a reference from the previous shape reports healthy worktrees as damaged and damaged
 * ones as healthy in the same pass.
 *
 * An empty scan is NEVER cached and never returned as usable proof — capturing while the primary is
 * mid-install (or before it has any node_modules) yields an empty reference, and an empty reference
 * certifies every broken tree in the fleet.
 */
export function snapshotReference(primary, config, { refresh = false, now = Date.now } = {}) {
  const file = referenceFile(config)
  const lockfileHash = lockfileHashOf(primary)
  if (!refresh) {
    const cached = readJson(file)
    if (cached && cached.lockfileHash === lockfileHash && cached.packages && Object.keys(cached.packages).length) {
      return { ...cached, fromCache: true, usable: true }
    }
  }
  const counts = scanTree(primary)
  const ref = {
    v: 1,
    primary,
    lockfileHash,
    capturedAt: new Date(now()).toISOString(),
    packageCount: counts.size,
    totalFiles: [...counts.values()].reduce((n, c) => n + c, 0),
    probeFiles: sizesOf(primary, config.install.proof.probeFiles),
    packages: Object.fromEntries([...counts].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))),
  }
  if (!counts.size) {
    return { ...ref, fromCache: false, usable: false, reason: `no packages found in ${primary}: the primary checkout is not installed, so there is nothing to compare against` }
  }
  writeJsonAtomic(file, ref)
  return { ...ref, fromCache: false, usable: true }
}

// ---- filesystem: verification ---------------------------------------------------------------------

const probeReason = p =>
  p.bytes === null ? `probe file ${p.path} is missing` : `probe file ${p.path} is ${p.bytes} bytes, the reference has ${p.expected}`

function checkProbeFiles(worktree, reference, config) {
  const tolerance = config.install.proof.tolerance
  return (config.install.proof.probeFiles || []).map(rel => {
    let bytes = null
    try {
      const st = fs.statSync(path.join(worktree, rel))
      bytes = st.isFile() ? st.size : null
    } catch { /* absent */ }
    const expected = (reference && reference.probeFiles && reference.probeFiles[rel] !== undefined) ? reference.probeFiles[rel] : null
    // Size, not existence: one corrupt tree carried the compiler's main file truncated to a quarter
    // of its size, with the package count and the shim count both perfect.
    const ok = bytes !== null && bytes > 0 && (expected === null || bytes >= Math.floor(expected * tolerance))
    return { path: rel, bytes, expected, ok }
  })
}

/**
 * Prove a worktree's dependency tree, per `install.proof.mode`. The filesystem wrapper around
 * verdictFromCounts().
 * @returns {{ok: boolean, mode: string, reason: string, verdict: object|null, probeFiles: Array}}
 */
export function verifyInstall(worktree, reference, config) {
  const mode = config.install.proof.mode
  const tolerance = Number(config.install.proof.tolerance)
  // ⛔ Refused for EVERY mode, not only the count path. checkProbeFiles() multiplies the same value
  // into `Math.floor(expected * tolerance)`, so a tolerance of 0 certifies a compiler truncated to
  // one byte as a full-size file — a false green whose message asserts the opposite of the truth —
  // and `explicit` never reaches verdictFromCounts(), where the refusal used to live alone.
  if (!(tolerance > 0) || tolerance > 1) {
    return { ok: false, mode, reason: `install.proof.tolerance must be greater than 0 and at most 1 (got ${config.install.proof.tolerance})`, verdict: null, probeFiles: [] }
  }
  const probeFiles = checkProbeFiles(worktree, reference, config)
  const badProbe = probeFiles.find(p => !p.ok)

  if (mode === 'exists') {
    const counts = scanTree(worktree)
    const ok = counts.size > 0
    return {
      ok,
      mode,
      reason: ok
        ? `${counts.size} packages present (existence only: this proves an install ran, not that the tree is complete)`
        : 'no packages found in the worktree',
      verdict: null,
      probeFiles,
    }
  }

  if (mode === 'explicit') {
    // Naming no probe files and calling the mode "explicit" would pass every tree, including one
    // whose node_modules is an empty directory.
    if (!probeFiles.length) return { ok: false, mode, reason: 'install.proof.mode is "explicit" but install.proof.probeFiles is empty, so nothing is proven', verdict: null, probeFiles }
    if (badProbe) return { ok: false, mode, reason: probeReason(badProbe), verdict: null, probeFiles }
    // "at full size" was a lie whenever the reference had no size for a probe: the check that
    // passed was `bytes > 0`, and saying so is the difference between a proof and a slogan.
    const unsized = probeFiles.filter(p => p.expected === null).length
    const reason = unsized === probeFiles.length
      ? `${probeFiles.length} probe file(s) present (no reference size to compare)`
      : `${probeFiles.length} probe file(s) at or above ${tolerance} of the reference size` + (unsized ? ` (${unsized} with no reference size)` : '')
    return { ok: true, mode, reason, verdict: null, probeFiles }
  }

  if (!reference || reference.usable === false || !reference.packages || !Object.keys(reference.packages).length) {
    return { ok: false, mode, reason: 'no usable reference snapshot of the primary checkout; capture one before proving a worktree', verdict: null, probeFiles }
  }
  // ⛔ The reference proves nothing about a tree built from a DIFFERENT lockfile — the same rule
  // snapshotReference() applies to its own cache, enforced here against the tree being judged. A
  // session branch that adds or drops a dependency legitimately has its own lockfile, and comparing
  // it against the primary's reference reports healthy packages as missing and hands the operator a
  // repair plan naming directories that are not supposed to exist, forever.
  const worktreeHash = lockfileHashOf(worktree)
  if (reference.lockfileHash !== worktreeHash) {
    // ⛔ A lockfile hash is `<name>:<32 hex>` (lockfileHashOf), and the old `slice(0, 16)` cut
    // INSIDE THE NAME: both sides of a real mismatch printed "package-lock.jso", so the sentence
    // named two identical values and called them different. An operator reading that looks for a
    // bug in the tool, not for the branch their worktree was cut from. Keep the name whole and
    // shorten only the digest, which is the half that actually differs.
    const at = h => {
      if (!h) return 'no lockfile'
      const s = String(h)
      const cut = s.indexOf(':')
      return cut === -1 ? s : `${s.slice(0, cut)}@${s.slice(cut + 1, cut + 13)}`
    }
    // ⛔ A DIFFERENT LOCKFILE IS THE NORMAL CASE, NOT AN ERROR. Worktrees are cut from the BASE
    // branch while the primary checkout sits on whatever the operator was last working on — so the
    // moment they are on a branch that touched the lockfile, every session's reference disagrees.
    // Failing the proof there fails the INSTALL, no sentinel is written, and every session in the
    // fleet blocks on "dependencies not ready" with a healthy node_modules sitting beside it. The
    // reference genuinely cannot judge this tree, so say so and fall back to what can still be
    // proven — existence — rather than refusing to answer at all. Loud, never silent: the reason
    // records both hashes and what was given up.
    const counts = scanTree(worktree)
    if (counts.size > 0) {
      return {
        ok: true,
        mode,
        degradedFrom: mode,
        reason: `the reference was captured for ${at(reference.lockfileHash)} and this worktree is at ${at(worktreeHash)}, so the reference cannot judge it; fell back to an existence proof — ${counts.size} packages present (this proves an install ran, not that the tree is complete). Refresh the reference against this worktree's lockfile for a full comparison.`,
        verdict: null,
        probeFiles,
      }
    }
    return {
      ok: false,
      mode,
      reason: `the reference was captured for ${at(reference.lockfileHash)}, this worktree is at ${at(worktreeHash)} — refresh the reference against this worktree's lockfile, or prove it with install.proof.mode "exists"`,
      verdict: null,
      probeFiles,
    }
  }
  const verdict = verdictFromCounts(scanTree(worktree), reference.packages, tolerance)
  if (!verdict.ok) return { ok: false, mode, reason: verdict.reason, verdict, probeFiles }
  if (badProbe) return { ok: false, mode, reason: probeReason(badProbe), verdict, probeFiles }
  return { ok: true, mode, reason: verdict.reason, verdict, probeFiles }
}

// ---- filesystem: the sentinel ---------------------------------------------------------------------

/**
 * Absolute path of the ready sentinel — at the WORKTREE ROOT, never in the state directory: it
 * answers "is THIS checkout usable", so a worktree removed by hand must take its own answer with it
 * (contract §3).
 */
export function readyFlagPath(worktree, config) {
  const root = path.resolve(worktree)
  const p = path.resolve(root, config.install.readyFlag)
  const rel = path.relative(root, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`install.readyFlag must name a file inside the worktree (got ${JSON.stringify(config.install.readyFlag)})`)
  }
  return p
}

/**
 * Write the sentinel — ONLY after the proof passed.
 *
 * ⛔ The throw is the point: a sentinel written on an install's exit code is an exit code with a
 * nicer name, and every session in the fleet reads it as permission to build. It records the
 * lockfile hash it was verified at so a reused worktree cannot inherit an earlier run's answer, and
 * it is renamed into place so a session polling for it never opens a half-written file.
 */
export function writeReadySentinel(worktree, config, { lockfileHash = null, proof = null, now = Date.now } = {}) {
  if (proof && proof.ok === false) throw new Error(`refusing to write the ready sentinel: the install proof failed (${proof.reason})`)
  const file = readyFlagPath(worktree, config)
  const hash = lockfileHash === null ? lockfileHashOf(worktree) : lockfileHash
  const body = {
    v: 1,
    at: new Date(now()).toISOString(),
    lockfileHash: hash,
    // A repo with none of the LOCKFILES has nothing to hash. Recording that deliberately is what
    // lets readyState() tell it apart from a sentinel that simply failed to say what it proved.
    lockfileless: hash === null,
    mode: proof ? proof.mode : config.install.proof.mode,
    tolerance: config.install.proof.tolerance,
    packages: proof && proof.verdict ? proof.verdict.checked : null,
    worstRatio: proof && proof.verdict ? proof.verdict.worstRatio : null,
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return file
}

/** Remove the sentinel. Returns whether one was there — a worktree about to be reinstalled must
 *  stop claiming to be ready BEFORE the installer touches it, not after. */
export function clearReadySentinel(worktree, config) {
  const file = readyFlagPath(worktree, config)
  const existed = fs.existsSync(file)
  fs.rmSync(file, { force: true })
  return existed
}

/** Read the sentinel: null when absent, `{unparsable: true}` when present but unreadable. */
export function readSentinel(worktree, config) {
  let raw
  try {
    raw = fs.readFileSync(readyFlagPath(worktree, config), 'utf8')
  } catch {
    return null
  }
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : { unparsable: true }
  } catch {
    return { unparsable: true }
  }
}

/** The thin I/O half of readyState(): observe a worktree, then judge the observation purely. */
export function observeWorktree(worktree, config) {
  return { path: worktree, sentinel: readSentinel(worktree, config), lockfileHash: lockfileHashOf(worktree) }
}

// ---- running the installs -------------------------------------------------------------------------

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A large monorepo's install measured ~26 minutes for a wave of two under fleet load, so the default
// command timeout would kill installs that were merely slow — and a killed install is precisely the
// half-extracted tree at the top of this file.
export const BOOTSTRAP_TIMEOUT_MS = 60 * 60_000

// ⛔ Still SYNCHRONOUS: shellCommand() is spawnSync, which blocks the event loop, so with this
// default a wave of two installs runs strictly one after the other and every barrier below paces a
// queue of one. installOne() awaits `run`, so an async runner interleaves as designed; closing the
// gap for real needs a promise-based `shellCommandAsync()` in src/sys/exec.mjs — the one place this
// tool is allowed to spawn a process — which is outside this change.
const defaultBootstrap = (job, config) => shellCommand(config.commands.bootstrap, { cwd: job.worktree, timeoutMs: BOOTSTRAP_TIMEOUT_MS })

/**
 * Install one worktree and prove it.
 *
 * ⛔ `ok` comes from the PROOF, never from the exit code — an interrupted install exits 0 over a
 * tree it never finished writing. The exit code is still reported, because it is what a log tail
 * needs, but on its own it decides nothing in either direction: a transient network failure rolls
 * the whole tree back and leaves wreckage identical to two writers in one tree, and only one of
 * those two is fixable by retrying.
 */
export async function installOne(job, { config, reference = null, run = defaultBootstrap, now = Date.now } = {}) {
  // ⛔ The sentinel goes FIRST, before the installer touches anything. A worktree being reinstalled
  // must stop claiming to be ready immediately: if this install fails, the previous run's green
  // sentinel would otherwise survive on top of a half-extracted tree and readyState() would report
  // it ready — the exact failure this file exists to prevent, and the one the lockfile-staleness
  // guard cannot see, because an interrupted install does not change the lockfile. Nothing writes a
  // sentinel between here and the proof, so the failure path below needs no second clear.
  clearReadySentinel(job.worktree, config)
  const r = await run(job, config)
  const proof = verifyInstall(job.worktree, reference, config)
  const base = { label: job.label, worktree: job.worktree, exitOk: !!r.ok, code: r.code === undefined ? null : r.code, proof }
  if (!proof.ok) return { ...base, ok: false, sentinel: null, reason: proof.reason }
  return { ...base, ok: true, sentinel: writeReadySentinel(job.worktree, config, { proof, now }), reason: proof.reason }
}

/**
 * Run every job in load-gated waves.
 *
 * A wave BARRIERS: nothing in the next wave starts until every install in this one has finished, and
 * then the machine genuinely idles for `install.settleSec`. A rolling pool would hold the same
 * average concurrency and still take the box down, because it never has the quiet moment that lets
 * writeback and the file cache drain.
 *
 * One failing install never stops the run: nine healthy worktrees waiting on one bad tree is how a
 * fleet stops working while looking busy. Failures come back in the results for the launcher to
 * report.
 *
 * `probe`, `sleep`, `runJob` and `cpuCount` are injected so this loop is testable without a real
 * machine, a real installer, or a real 30-second wait.
 */
export async function runInstalls(jobs, {
  config,
  probe = probeMemory,
  onWave = null,
  reference = null,
  runJob = installOne,
  sleep = realSleep,
  cpuCount = os.cpus().length,
} = {}) {
  const pending = [...jobs]
  const results = []
  const warnings = []
  let heldMs = 0
  let index = 0

  // ⛔ This installer runs `commands.bootstrap` and nothing else. The donor clone and the workspace
  // junctions the config offers are not implemented here, and a configured donor that silently does
  // nothing is worse than one that is refused: the operator sees a fleet installing from scratch and
  // believes it is cloning a warm tree.
  if (config.install.donor && config.install.donor.enabled) {
    warnings.push('install.donor.enabled is set, but this installer only runs commands.bootstrap: the donor is ignored and every worktree gets a full install')
  }

  while (pending.length) {
    const reading = probe()
    const decision = decide(reading, { cpuCount, config, jobsRemaining: pending.length })
    let width = decision.concurrency

    if (decision.hold) {
      // The hold budget is RUN-WIDE and never reset per wave: a machine that is simply busy must
      // still finish the fleet, loudly, rather than idle forever while looking healthy.
      const hold = holdDecision({ heldMs, config })
      if (hold.wait) {
        await sleep(config.install.holdPollSec * 1000, 'hold')
        heldMs += config.install.holdPollSec * 1000
        continue
      }
      warnings.push(hold.message)
      width = 1
    }

    const wave = pending.splice(0, width)
    if (onWave) onWave({ index, jobs: wave, decision, reading, heldMs, remaining: pending.length })
    const settled = await Promise.all(wave.map(async job => {
      try {
        return await runJob(job, { config, reference })
      } catch (e) {
        return { label: job.label, worktree: job.worktree, ok: false, sentinel: null, reason: `the install threw: ${e.message}` }
      }
    }))
    results.push(...settled)
    index++
    if (pending.length) await sleep(config.install.settleSec * 1000, 'settle')
  }

  return { results, waves: index, heldMs, warnings }
}
