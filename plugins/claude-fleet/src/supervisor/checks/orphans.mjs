// Orphans: node and agent processes still running inside a worktree the fleet no longer knows about.
//
// A reclaimed worktree is deregistered and its folder deleted — but `git worktree remove` routinely
// does the first and fails the second because a shell or an agent still holds files inside it. The
// folder then sits on disk for the rest of the run, gigabytes each, while its processes keep the
// machine busy and hold the name a new session would be numbered into.
//
// ⛔ Only what is POSITIVELY identified is killed. An earlier teardown killed by exclusion — every
// agent with no fleet ancestor was "an orphan" — and destroyed the operator's own hand-started agent
// an hour into unrelated work, because the launcher and any human-started agent also have no fleet
// ancestor. Here a process is an orphan only when ALL of these hold:
//   * its command line (or cwd, where the snapshot carries one) names a fleet-shaped folder git no
//     longer registers — on a path BOUNDARY, so `app-session-1` never claims `app-session-10`;
//   * it is a node or agent process — the launcher's own `git worktree remove <that folder>` is not;
//   * it is neither the supervisor, one of its ancestors, nor a descendant of a REGISTERED session's
//     shim — a live session reading a file out of a leftover is that session's helper, not an orphan.
// Everything unrecognised is left alone, and kills go deepest-first through sys/kill so removing
// orphans never creates new ones.
//
// PURE verdict over an injected snapshot + leftover list; apply() is the thin half with the kill injected.

import { inDirectory, protectedSet, ancestors, descendants, sessionLabelOf } from '../../sys/proc.mjs'

export const NAME = 'orphans'

/** The process names an orphan can have. Anything else inside a leftover is somebody's tool, not ours. */
export const ORPHAN_PROCESS_NAMES = /^(node|claude|codex)(\.exe)?$/i

/** Pids of every process carrying a session marker, plus their whole trees: a registered session. */
export function sessionTrees(snapshot) {
  const out = new Set()
  for (const p of snapshot.values()) {
    if (sessionLabelOf(p.cmd) === null) continue
    out.add(p.pid)
    for (const d of descendants(snapshot, p.pid)) out.add(d)
  }
  return out
}

/**
 * Processes whose command line or cwd is inside `dir`, boundary-safe on both fields.
 * The snapshot providers do not record a cwd today, so the cwd match is a no-op until one does —
 * but a provider that adds it must not have to touch every check.
 */
export function insideDirectory(snapshot, dir) {
  const seen = new Map()
  for (const p of inDirectory(snapshot, dir)) seen.set(p.pid, p)
  for (const p of inDirectory(snapshot, dir, { field: 'cwd' })) seen.set(p.pid, p)
  return [...seen.values()]
}

/** The topmost of a set of pids: those with no ancestor in the set. Killing these deepest-first covers the rest. */
export function rootsOf(snapshot, pids) {
  const set = new Set(pids.map(Number))
  return [...set].filter(pid => !ancestors(snapshot, pid).some(a => set.has(a))).sort((a, b) => a - b)
}

/**
 * @param {{snapshot: Map, leftovers: Array<{path: string}>, selfPid?: number, protect?: number[]}} input
 *   `leftovers` are the fleet-shaped folders git no longer registers (core/worktree.sweepLeftovers).
 * @returns {{ok: boolean, found: Array, repairs: Array, notes: string[]}}
 */
export function verdict({ snapshot, leftovers = [], selfPid = process.pid, protect = [] }) {
  const notes = []
  if (!snapshot || snapshot.size === 0) {
    // The cheap process listing degrades to empty output on a loaded box; an empty snapshot is a
    // FAILED snapshot, never an empty machine, and nothing is judged from it.
    return { ok: false, found: [], repairs: [], notes: ['the process snapshot is empty — a failed snapshot, never an idle machine; nothing judged'] }
  }
  const prot = protectedSet(snapshot, selfPid, protect)
  const owned = sessionTrees(snapshot)
  const found = []
  const seen = new Set()
  for (const leftover of leftovers) {
    const dir = typeof leftover === 'string' ? leftover : leftover.path
    if (!dir) continue
    for (const p of insideDirectory(snapshot, dir)) {
      if (seen.has(p.pid)) continue
      if (!ORPHAN_PROCESS_NAMES.test(p.name || '')) continue
      if (prot.has(p.pid)) continue
      if (owned.has(p.pid)) continue
      seen.add(p.pid)
      found.push({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: p.cmd, worktree: dir })
    }
  }
  const byPid = new Map(found.map(f => [f.pid, f]))
  const repairs = rootsOf(snapshot, [...byPid.keys()]).map(pid => {
    const f = byPid.get(pid)
    return { kind: 'kill-tree', root: pid, worktree: f.worktree, cmd: f.cmd }
  })
  if (found.length) notes.push(`${found.length} orphan process(es) inside ${new Set(found.map(f => f.worktree)).size} unregistered worktree folder(s)`)
  return { ok: found.length === 0, found, repairs, notes }
}

/**
 * Apply kill-tree repairs. `io.killTree(root)` must be sys/kill.killTree bound to a fresh re-snapshot
 * and return its `{killed, survivors}`; a survivor is a FAILED repair, whatever the kill call said.
 * @returns {{repaired: Array, failed: Array}}
 */
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
