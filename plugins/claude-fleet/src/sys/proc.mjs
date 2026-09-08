// Process-tree reasoning, PURE. Takes a snapshot (Map<pid, ProcInfo>) and answers questions about
// it; never touches the OS. The per-OS snapshot providers live in proc-windows.mjs / proc-posix.mjs
// and killTree in kill.mjs. Keeping this pure is what lets the kill-safety rule be unit-tested with
// a fake table instead of a live fleet.
//
// ProcInfo = { pid, ppid, pgid?, name, cmd, rssBytes?, startedAt? }
//
// The rule this module exists to enforce (learned by killing an operator's unrelated hour-old
// session): NEVER kill by exclusion. Only processes positively identified as descendants of a known
// root are killable; self and every ancestor of self are protected; kill deepest-first so nothing is
// orphaned; then re-query and report survivors.

/** The exact argv marker a fleet session shim carries: `--fleet-session=<label>`. */
export const SESSION_MARKER = '--fleet-session='

/** Build a Map<pid, ProcInfo> from an array. */
export function snapshotFrom(list) {
  const m = new Map()
  for (const p of list) m.set(Number(p.pid), { ...p, pid: Number(p.pid), ppid: Number(p.ppid) })
  return m
}

/** Children index: Map<ppid, pid[]>. */
export function childrenIndex(snap) {
  const idx = new Map()
  for (const p of snap.values()) {
    if (!idx.has(p.ppid)) idx.set(p.ppid, [])
    idx.get(p.ppid).push(p.pid)
  }
  return idx
}

/** All descendants of `root` (excluding root), breadth-first. PID reuse guard: a child whose
 *  startedAt precedes its parent's is not a real child. */
export function descendants(snap, root, idx = childrenIndex(snap)) {
  const out = []
  const seen = new Set([Number(root)])
  const queue = [Number(root)]
  while (queue.length) {
    const cur = queue.shift()
    const parent = snap.get(cur)
    for (const c of idx.get(cur) || []) {
      if (seen.has(c)) continue
      const child = snap.get(c)
      if (parent && child && parent.startedAt && child.startedAt && child.startedAt < parent.startedAt) continue
      seen.add(c)
      out.push(c)
      queue.push(c)
    }
  }
  return out
}

/** Ancestors of `pid` (excluding pid), nearest first. Cycle-safe. */
export function ancestors(snap, pid) {
  const out = []
  const seen = new Set([Number(pid)])
  let cur = snap.get(Number(pid))
  while (cur && cur.ppid && !seen.has(cur.ppid) && snap.has(cur.ppid)) {
    out.push(cur.ppid)
    seen.add(cur.ppid)
    cur = snap.get(cur.ppid)
  }
  return out
}

/** Depth of each pid under root (root = 0). */
export function depths(snap, root, idx = childrenIndex(snap)) {
  const d = new Map([[Number(root), 0]])
  const queue = [Number(root)]
  while (queue.length) {
    const cur = queue.shift()
    for (const c of idx.get(cur) || []) {
      if (d.has(c)) continue
      d.set(c, d.get(cur) + 1)
      queue.push(c)
    }
  }
  return d
}

/** The set a kill must never touch: self, every ancestor of self, and any explicitly protected pids. */
export function protectedSet(snap, selfPid, extra = []) {
  const s = new Set([Number(selfPid), ...ancestors(snap, selfPid), ...extra.map(Number)])
  return s
}

/**
 * Plan a tree kill. Returns pids ordered DEEPEST FIRST, minus the protected set. Never includes
 * anything that is not a positively identified descendant of `root` (or root itself).
 * @returns {{order: number[], skippedProtected: number[]}}
 */
export function killPlan(snap, root, { selfPid, protect = [], includeRoot = true } = {}) {
  const prot = protectedSet(snap, selfPid ?? -1, protect)
  const idx = childrenIndex(snap)
  const desc = descendants(snap, root, idx)
  const d = depths(snap, root, idx)
  const candidates = includeRoot ? [...desc, Number(root)] : desc
  const skippedProtected = candidates.filter(p => prot.has(p))
  const order = candidates.filter(p => !prot.has(p)).sort((a, b) => (d.get(b) ?? 0) - (d.get(a) ?? 0) || a - b)
  return { order, skippedProtected }
}

/** Does this argv carry the exact session marker for `label`? Token match, never substring. */
export function hasSessionMarker(cmd, label) {
  const want = SESSION_MARKER + String(label)
  return tokenize(cmd).some(t => t === want || t === `"${want}"` || t === `'${want}'`)
}

/** Which session label (if any) does this argv carry? */
export function sessionLabelOf(cmd) {
  for (const t of tokenize(cmd)) {
    const u = t.replace(/^["']|["']$/g, '')
    if (u.startsWith(SESSION_MARKER)) return u.slice(SESSION_MARKER.length)
  }
  return null
}

/** Simple argv tokenizer honouring double/single quotes. */
export function tokenize(cmd) {
  const out = []
  const s = String(cmd || '')
  let cur = ''
  let q = null
  for (const ch of s) {
    if (q) {
      cur += ch
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = '' } ; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Find processes whose command line matches `pattern` (RegExp) — EXCLUDING self and self's
 * ancestors, because any shell running this check has the pattern text in its own command line
 * and would self-match, inventing phantom instances.
 */
export function findByCommand(snap, pattern, { selfPid, exclude = [] } = {}) {
  const prot = selfPid !== undefined ? protectedSet(snap, selfPid, exclude) : new Set(exclude.map(Number))
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
  return [...snap.values()].filter(p => !prot.has(p.pid) && re.test(p.cmd || ''))
}

/** Processes whose cwd or command line is inside `dir` — boundary-safe (`<dir>/`), so `app-testing`
 *  never claims `app-testing-2`'s processes. */
export function inDirectory(snap, dir, { field = 'cmd' } = {}) {
  const norm = s => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const d = norm(dir)
  return [...snap.values()].filter(p => {
    const v = norm(p[field])
    return v === d || v.includes(d + '/')
  })
}

/** Sum of RSS over a pid list. */
export function rssOf(snap, pids) {
  let n = 0
  for (const p of pids) n += (snap.get(Number(p)) || {}).rssBytes || 0
  return n
}
