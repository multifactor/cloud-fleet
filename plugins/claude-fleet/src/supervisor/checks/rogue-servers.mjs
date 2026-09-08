// Rogue servers: a dev server running inside a WORKING session's worktree.
//
// ⛔ Working sessions are serverless. A dozen sessions each starting a full dev stack "just for a
// screenshot" is what hard-powered-off a machine; captures go through a borrowed testing slot or a
// cloud sandbox, never a session's own server. This check is what turns that sentence from a request
// a model can skip into a rule: any process matching the DERIVED `devServer.serverProcessPattern`
// inside a `working` worktree is tree-killed, every pass.
//
// Two traps shape the match:
//   * "inside" is a path BOUNDARY on the worktree — `app-testing` never claims `app-testing-2` — or
//     descent from that session's own shim (a server started with the worktree as its cwd carries no
//     path in its argv at all);
//   * the pattern is DERIVED and can be wrong: derived from `npm run dev` with no resolvable script it
//     becomes `npm`, which matches an install. A false positive here tree-kills the session's own
//     work, so the agent, the shim and anything carrying a session marker are never candidates
//     however well they match, and `fleet doctor` echoes the pattern on every run for the same reason.
//   * the pattern names an ENTRY FILE (`dev-server\.mjs`), so it is matched against each argv token's
//     basename, whole — never as a substring of the command line. Unanchored, `node vitest
//     test/dev-server.mjs.test.js` and `node scripts/check-dev-server.mjs` inside a working worktree
//     are "servers", and the session's own test run is tree-killed by the matcher itself.
//
// Only worktrees of role `working` are policed: a `testing` slot's server is the whole point of the
// slot, and a `checker` runs no server. Everything else is left alone.

import { inDirectory, protectedSet, descendants, sessionLabelOf, ancestors, tokenize } from '../../sys/proc.mjs'

export const NAME = 'rogue-servers'

/** The agent processes a false-positive pattern must never reach. */
const AGENT_NAMES = /^(claude|codex)(\.exe)?$/i

/**
 * Compile `devServer.serverProcessPattern` into a whole-token matcher, or null when it does not
 * compile. PURE.
 *
 * The derived pattern is an escaped file basename, so it is anchored (`^(?:…)$`) and tested against
 * the BASENAME of every argv token — a quoted shell string (`sh -c "node dev-server.mjs"`) is
 * unquoted and split again first, so a server started through the platform shell is still found.
 * @returns {((cmd: string) => boolean) | null}
 */
export function serverPatternMatcher(pattern) {
  if (!pattern) return null
  let re
  try {
    const src = pattern instanceof RegExp ? pattern.source : String(pattern)
    re = new RegExp(`^(?:${src})$`)
  } catch {
    return null
  }
  return cmd => {
    for (const raw of tokenize(cmd)) {
      const unquoted = String(raw).replace(/^["']|["']$/g, '')
      for (const part of unquoted.split(/\s+/)) {
        if (!part) continue
        const base = part.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()
        if (re.test(base)) return true
      }
    }
    return false
  }
}

/** The pids carrying `--fleet-session=<label>` for one label. */
export function shimPidsOf(snapshot, label) {
  const want = String(label)
  return [...snapshot.values()].filter(p => sessionLabelOf(p.cmd) === want).map(p => p.pid)
}

/** The topmost of a set of pids: those with no ancestor in the set. */
function rootsOf(snapshot, pids) {
  const set = new Set(pids)
  return [...set].filter(pid => !ancestors(snapshot, pid).some(a => set.has(a))).sort((a, b) => a - b)
}

/**
 * @param {{snapshot: Map, registry: Array, pattern: string|RegExp|null, selfPid?: number, protect?: number[]}} input
 *   `pattern` is `devServer.serverProcessPattern` (null when nothing file-like could be derived).
 * @returns {{ok: boolean, found: Array, repairs: Array, notes: string[]}}
 */
export function verdict({ snapshot, registry = [], pattern = null, selfPid = process.pid, protect = [] }) {
  if (!snapshot || snapshot.size === 0) {
    return { ok: false, found: [], repairs: [], notes: ['the process snapshot is empty — a failed snapshot, never an idle machine; nothing judged'] }
  }
  if (!pattern) {
    // Silent would mean "no rogue servers" to a reader of the status file; the truth is "cannot tell".
    return { ok: true, found: [], repairs: [], notes: ['devServer.serverProcessPattern is not derived (no file-like token in commands.devServer); rogue servers cannot be recognised'] }
  }
  const matches = serverPatternMatcher(pattern)
  if (!matches) {
    return { ok: false, found: [], repairs: [], notes: [`devServer.serverProcessPattern does not compile: ${String(pattern)}`] }
  }
  const prot = protectedSet(snapshot, selfPid, protect)
  const found = []
  const seen = new Set()
  for (const d of registry) {
    if (!d || d.role !== 'working' || !d.worktree) continue
    const candidates = new Map()
    for (const p of inDirectory(snapshot, d.worktree)) candidates.set(p.pid, p)
    for (const shim of shimPidsOf(snapshot, d.label)) {
      for (const pid of descendants(snapshot, shim)) {
        const p = snapshot.get(pid)
        if (p) candidates.set(pid, p)
      }
    }
    for (const p of candidates.values()) {
      if (seen.has(p.pid) || prot.has(p.pid)) continue
      if (!matches(p.cmd || '')) continue
      // A pattern that matches the agent or the shim is a false positive, not a rogue server.
      if (AGENT_NAMES.test(p.name || '') || sessionLabelOf(p.cmd) !== null) continue
      seen.add(p.pid)
      found.push({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: p.cmd, label: String(d.label), worktree: d.worktree })
    }
  }
  const byPid = new Map(found.map(f => [f.pid, f]))
  const repairs = rootsOf(snapshot, [...byPid.keys()]).map(pid => {
    const f = byPid.get(pid)
    return { kind: 'kill-tree', root: pid, label: f.label, worktree: f.worktree, cmd: f.cmd }
  })
  const notes = found.length ? [`${found.length} dev-server process(es) inside working worktree(s): ${[...new Set(found.map(f => f.label))].join(', ')}`] : []
  return { ok: found.length === 0, found, repairs, notes }
}

/** Same contract as orphans.apply: `io.killTree(root)` → `{killed, survivors}`; survivors fail the repair. */
export function apply(repairs, io) {
  const repaired = []
  const failed = []
  for (const r of repairs) {
    if (r.kind !== 'kill-tree') continue
    try {
      const k = io.killTree(r.root)
      const survivors = (k && k.survivors) || []
      if (survivors.length) failed.push({ ...r, killed: k.killed || [], survivors, error: `${survivors.length} process(es) survived the kill` })
      else repaired.push({ ...r, killed: (k && k.killed) || [] })
    } catch (e) {
      failed.push({ ...r, error: e.message })
    }
  }
  return { repaired, failed }
}
