// Slots: is each testing slot's dev server really up — and when it is really GONE, restart it.
//
// Every rule here is a slot that was misjudged on a real run:
//
//   ⛔ A dead slot answers 404, not 502. When a server never registered its route, a per-branch-host
//      proxy serves ITS OWN 404 for that host, indistinguishable from an app 404 by status code. So
//      only 2xx/3xx counts as up (`devServer.probes[].expectStatus`), and a probe waits 45 s
//      (`timeoutSec`) because a shorter one false-alarms while the frontend recompiles after a merge.
//   ⛔ A slot with LIVE server processes and failing probes is COMPILING and is left alone. A
//      probe-only watchdog restarted a slot that was thirty seconds from serving, on every tick.
//   ⛔ A restart needs `devServer.softFaultStrikes` CONSECUTIVE soft faults — two strikes once killed
//      a healthy server that was still compiling — and happens only when the worktree has NO server
//      process at all, and (when a route list exists) its host is missing from the proxy's routes.
//   ⛔ Never before the worktree's ready flag: a slot with no dependency tree cannot be restarted
//      into health, and "restarting" it every tick during a big install is a net negative.
//   ⛔ The slot branch is re-checked before a restart: a server started off-branch takes the shared
//      host, and working sessions then capture against whichever slot answered.
//   ⛔ A server the supervisor ITSELF started is invisible to every other rule: it runs with the
//      worktree as its cwd (no path in its argv) and descends from the supervisor, not the slot's
//      shim. So the pids a restart produced are carried per slot in `watch.status.json`
//      (`startedPids`, with their trees adopted each pass) and count as the slot's server — or the
//      next pass, while the new server still compiles and the probes still fail, reads "no process,
//      strikes at threshold" and starts a SECOND server on the same host and port.
//   ⛔ A restart RESETS the strike clock (and is counted): a slot whose command exits at once (bad
//      env, missing binary, port taken) is otherwise respawned on every pass forever while the status
//      reads "repaired" each time. Now it takes `softFaultStrikes` more passes, and the second and
//      later consecutive restarts are an ATTENTION note.
//
// The restart runs `commands.devServer` DETACHED in the slot worktree with FLEET_SLOT,
// FLEET_SLOT_BRANCH and FLEET_PORT set (contract §4) — a fixed-port project cannot start a second
// slot without its own port — with `paths.pathPrepend` and `paths.nodeBinDirs` in front of PATH
// exactly as every session window gets them (session/shim.prependPath), and both output streams
// redirected to a file under `<stateDir>/logs/`, because a helper that inherits a dying parent's
// console dies on its next write.
//
// Strike counts, started pids and the restart counter live in `watch.status.json` between passes
// (the loop hands the previous pass's values in as `strikes`, `started`, `restarts`), so a
// supervisor restart does not reset the clock on a slot mid-fault — nor forget the server it started.
//
// PURE verdict over the snapshot, the slot table, the registry and an `observed` reading; the HTTP
// probe, the route listing, the ready-flag read and the restart are thin and injected.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

import { inDirectory, descendants } from '../../sys/proc.mjs'
import { shellCommand, spawnDetached, git } from '../../sys/exec.mjs'
import { observeWorktree, readyState } from '../../core/install.mjs'
import { escapeRegex } from '../../config/derive.mjs'
import { stateLayout } from '../../config/paths.mjs'
import { STRIPPED_ENV, prependPath } from '../../session/shim.mjs'
import { shimPidsOf, serverPatternMatcher } from './rogue-servers.mjs'

export const NAME = 'slots'

/** The probe timeout the schema defaults to: a recompile after a merge takes this long. */
export const PROBE_TIMEOUT_SEC = 45

/** How long the route-list command may take before its reading is discarded as unknown. */
export const ROUTE_LIST_TIMEOUT_MS = 30_000

/** The states a supervised slot can be in. */
export const STATES = Object.freeze(['up', 'compiling', 'down', 'installing', 'unregistered', 'unknown'])

// ---- pure: probes -------------------------------------------------------------------------------

/**
 * Does one probe's status satisfy its expectation? 0 (no connection, timeout) never does.
 *
 * `expectNotStatus` ("anything but 500 is fine") exists for a route that exists but does not serve
 * GET: it answers 404 by design on every healthy slot, and only a 500 means the worker is broken.
 */
export function statusOk(status, probe = {}) {
  const s = Number(status) || 0
  if (s <= 0) return false
  if (Array.isArray(probe.expectNotStatus) && probe.expectNotStatus.length) return !probe.expectNotStatus.map(Number).includes(s)
  const classes = String(probe.expectStatus || '2xx,3xx').split(',').map(c => c.trim()).filter(Boolean)
  return classes.some(c => {
    const m = /^(\d)xx$/i.exec(c)
    return m ? Math.floor(s / 100) === Number(m[1]) : String(s) === c
  })
}

/**
 * Judge every probe of a slot. `results[i]` is `{path, status}` for `probes[i]`; a probe whose
 * `dependsOnPrevious` predecessor failed is SKIPPED (status null), not counted as its own fault —
 * an API probe behind a dead page probe would otherwise double-count one outage.
 * @returns {{up: boolean|null, results: Array<{path, status, ok, skipped}>}}  `up` is null with no probes
 */
export function probeVerdict(probes = [], results = []) {
  const out = []
  let up = true
  let prevOk = true
  probes.forEach((p, i) => {
    if (p.dependsOnPrevious && !prevOk) {
      out.push({ path: p.path, status: null, ok: null, skipped: true })
      return
    }
    const r = results[i] || {}
    const status = r.status === null || r.status === undefined ? 0 : Number(r.status) || 0
    const ok = statusOk(status, p)
    out.push({ path: p.path, status, ok, skipped: false })
    if (!ok) up = false
    prevOk = ok
  })
  return { up: probes.length ? up : null, results: out }
}

// ---- pure: processes ----------------------------------------------------------------------------

/**
 * The supervisor-started processes of a slot that are still in the snapshot, with their descendants
 * adopted. An entry is `{pid, startedAt}`; `startedAt` is whatever the snapshot reported when the pid
 * was first seen (null until then, as the restart records it), and a pid whose startedAt has since
 * CHANGED is a recycled pid — another process wearing the number — and is dropped. Adopting the
 * descendants each pass is what keeps the server counted when its shell wrapper exits first. PURE.
 * @returns {Array<{pid: number, startedAt: number|null}>}
 */
export function startedAlive(snapshot, started = []) {
  const out = new Map()
  for (const e of started || []) {
    const pid = Number(e && typeof e === 'object' ? e.pid : e)
    if (!Number.isInteger(pid) || !snapshot || !snapshot.has(pid)) continue
    const p = snapshot.get(pid)
    const seenAt = e && typeof e === 'object' && e.startedAt !== undefined ? e.startedAt : null
    const nowAt = p.startedAt === undefined ? null : p.startedAt
    if (seenAt !== null && nowAt !== null && seenAt !== nowAt) continue
    if (!out.has(pid)) out.set(pid, { pid, startedAt: nowAt })
    for (const d of descendants(snapshot, pid)) {
      const c = snapshot.get(d)
      if (c && !out.has(d)) out.set(d, { pid: d, startedAt: c.startedAt === undefined ? null : c.startedAt })
    }
  }
  return [...out.values()].sort((a, b) => a.pid - b.pid)
}

/**
 * The server processes of one slot: inside its worktree on a path BOUNDARY (`app-testing` never
 * claims `app-testing-2`'s), descended from its own session shim (a server started with the
 * worktree as its cwd carries no path in its argv), or started by the supervisor itself (`started`,
 * carried from the previous status — see startedAlive). The first two must match the derived
 * `serverProcessPattern` on a whole argv-token basename (rogue-servers.serverPatternMatcher) or any
 * `devServer.processes[]` shape; the supervisor's own children are the server by definition. Each
 * shape is counted separately so a two-half stack (page renderer + API worker) can be reported
 * half-dead.
 * @returns {{total: number, pids: number[], shapes: Array<{name, count, min, ok, pids}>, started: Array<{pid, startedAt}>}}
 */
export function processCounts(snapshot, descriptor, config, { started = [] } = {}) {
  const inside = new Map()
  if (descriptor && descriptor.worktree) for (const p of inDirectory(snapshot, descriptor.worktree)) inside.set(p.pid, p)
  if (descriptor && descriptor.label !== undefined && descriptor.label !== null) {
    for (const shim of shimPidsOf(snapshot, descriptor.label)) {
      for (const pid of descendants(snapshot, shim)) {
        const p = snapshot.get(pid)
        if (p) inside.set(pid, p)
      }
    }
  }
  const ours = startedAlive(snapshot, started)
  for (const s of ours) {
    const p = snapshot.get(s.pid)
    if (p) inside.set(s.pid, p)
  }
  const candidates = [...inside.values()]
  const server = new Set(ours.map(s => s.pid))
  const matches = serverPatternMatcher(config.devServer.serverProcessPattern)
  if (matches) for (const p of candidates) if (matches(p.cmd || '')) server.add(p.pid)
  const shapes = (config.devServer.processes || []).map(e => {
    const re = safeRegex(e.match)
    const not = e.notMatch ? safeRegex(e.notMatch) : null
    const pids = re ? candidates.filter(p => re.test(p.cmd || '') && !(not && not.test(p.cmd || ''))).map(p => p.pid) : []
    for (const pid of pids) server.add(pid)
    const min = Number.isInteger(e.min) ? e.min : 1
    return { name: e.name, count: pids.length, min, ok: pids.length >= min, pids }
  })
  return { total: server.size, pids: [...server].sort((a, b) => a - b), shapes, started: ours }
}

function safeRegex(src) {
  try {
    return src instanceof RegExp ? src : new RegExp(src)
  } catch {
    return null
  }
}

// ---- pure: routes -------------------------------------------------------------------------------

/** The token a route list would carry for a slot URL: its hostname, plus the port when explicit. */
export function routeToken(url) {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return String(url || '')
  }
}

/**
 * Is the slot's host in the proxy's route list? null when there is no list (no
 * `devServer.routeListCommand`, or it failed). Matched on a boundary: `testing.dev.localhost` is not
 * claimed by `x-testing.dev.localhost`, and `localhost:3000` is not claimed by `localhost:30001`.
 */
export function routeRegistered(routes, url) {
  if (routes === null || routes === undefined) return null
  const token = routeToken(url)
  if (!token) return null
  const re = new RegExp(`(?:^|[^A-Za-z0-9.-])${escapeRegex(token)}(?![A-Za-z0-9.-])`)
  const lines = Array.isArray(routes) ? routes : String(routes).split(/\r?\n/)
  return lines.some(l => re.test(String(l)))
}

// ---- pure: the slot table -----------------------------------------------------------------------

/** The slots that are actually meant to be running: the first `testing.count` rows of the table. */
export function liveSlots(slots, config) {
  const t = config.testing || {}
  if (t.enabled === false) return []
  const n = Math.max(0, Number(t.count) || 0)
  return (slots || []).filter(s => Number(s.n) >= 1 && Number(s.n) <= n)
}

/** The testing session registered for a slot: by slot NUMBER first, by slot branch as the fallback. */
export function descriptorFor(registry, slot) {
  const list = (registry || []).filter(d => d && d.role === 'testing')
  return list.find(d => Number(d.slot) === Number(slot.n)) || list.find(d => (d.slot === undefined || d.slot === null) && d.branch === slot.branch) || null
}

// ---- pure: the verdict --------------------------------------------------------------------------

/**
 * Judge one slot.
 * @param {{slot, descriptor, observed: {ready, routes, probes, routesError?}, snapshot, config, strikes}} o
 */
export function judgeSlot({ slot, descriptor, observed, snapshot, config, strikes = 0 }) {
  const base = {
    slot: Number(slot.n),
    branch: slot.branch,
    url: slot.url,
    port: slot.port,
    label: descriptor ? String(descriptor.label) : null,
    worktree: descriptor ? descriptor.worktree : null,
  }
  const idle = { ready: null, processes: 0, shapes: [], route: null, probes: [], fault: false, restart: false }
  if (!descriptor) {
    return { ...base, ...idle, state: 'unregistered', strikes: 0, reason: 'no testing session is registered for this slot; not supervised' }
  }
  const o = observed || {}
  if (o.ready !== true) {
    // Standing down is the rule, not a gap: "restarting" a slot with no dependency tree can never
    // succeed, and the strike count is dropped so the install phase never pre-loads a restart.
    return { ...base, ...idle, ready: false, state: 'installing', strikes: 0, reason: 'the worktree has no ready flag (still installing); the watchdog stands down' }
  }

  const procs = processCounts(snapshot, descriptor, config)
  const route = routeRegistered(o.routes, slot.url)
  const pv = probeVerdict(config.devServer.probes || [], o.probes || [])
  const short = procs.shapes.filter(s => !s.ok)
  const fault = pv.up === false || short.length > 0
  const next = fault ? Number(strikes || 0) + 1 : 0
  const threshold = Math.max(1, Number(config.devServer.softFaultStrikes) || 1)

  let state
  let reason
  if (!fault) {
    state = 'up'
    reason = pv.up === null && !procs.shapes.length
      ? 'no probes and no process shapes are configured, so there is nothing to judge by'
      : `probes answer 2xx/3xx${procs.total ? ` (${procs.total} server process(es))` : ''}`
  } else if (procs.total > 0) {
    // Live processes mean compiling. The strike still counts: if the processes vanish while the
    // probes keep failing, the slot is dead and the clock has already run.
    state = 'compiling'
    reason = `${procs.total} server process(es) alive with ${describeFault(pv, short)} — compiling, left alone (strike ${next}/${threshold})`
  } else {
    state = 'down'
    const routeNote = route === true ? ', but the proxy still lists its route' : route === false ? ' and no route registered' : ''
    reason = `no server process in the worktree${routeNote}; ${describeFault(pv, short)} (strike ${next}/${threshold})`
  }
  const restart = state === 'down' && next >= threshold && route !== true
  if (state === 'down' && next >= threshold && route === true) reason += ' — not restarted while the proxy still routes to it'

  return {
    ...base,
    ready: true,
    state,
    processes: procs.total,
    shapes: procs.shapes.map(({ pids, ...s }) => s),
    route,
    probes: pv.results,
    strikes: next,
    fault,
    restart,
    reason,
  }
}

function describeFault(pv, short) {
  const parts = []
  if (pv.up === false) parts.push(`probe(s) failing: ${pv.results.filter(r => r.ok === false).map(r => `${r.path}→${r.status}`).join(', ')}`)
  if (short.length) parts.push(`process shape(s) below min: ${short.map(s => `${s.name} ${s.count}/${s.min}`).join(', ')}`)
  return parts.join('; ') || 'no fault'
}

/**
 * @param {{slots: Array, registry: Array, config: object, snapshot: Map,
 *          observed: Object<number, {ready, routes, probes, routesError?}>, strikes: Object<number, number>}} input
 *   `slots` is the slot table (config/derive.buildSlots / resolved.json); `strikes` the previous
 *   pass's counts per slot number; `observed` what observeSlots() read this pass.
 * @returns {{ok: boolean, found: Array, repairs: Array, notes: string[]}}
 */
export function verdict({ slots = [], registry = [], config, snapshot, observed = {}, strikes = {} }) {
  const live = liveSlots(slots, config)
  const notes = []
  if (!live.length) return { ok: true, found: [], repairs: [], notes: ['no local testing pool (testing.count is 0)'] }
  if (!snapshot || snapshot.size === 0) {
    // The counts are carried, not reset: a failed snapshot is not evidence that a faulting slot
    // recovered, and dropping them would hand a dead slot a fresh clock on every degraded pass.
    const found = live.map(s => ({ slot: Number(s.n), branch: s.branch, url: s.url, state: 'unknown', strikes: Number(strikes[s.n] || 0), fault: false, restart: false, reason: 'no process snapshot' }))
    return { ok: false, found, repairs: [], notes: ['the process snapshot is empty — a failed snapshot, never an idle machine; nothing judged'] }
  }
  const found = []
  const repairs = []
  for (const s of live) {
    const descriptor = descriptorFor(registry, s)
    const o = observed[s.n] || observed[String(s.n)] || null
    const entry = judgeSlot({ slot: s, descriptor, observed: o, snapshot, config, strikes: Number(strikes[s.n] || 0) })
    found.push(entry)
    if (o && o.routesError) notes.push(`slot ${entry.slot}: the route list could not be read (${o.routesError}); judged without it`)
    if (!entry.restart) continue
    if (!config.commands.devServer) {
      notes.push(`slot ${entry.slot}: down for ${entry.strikes} strike(s) but commands.devServer is unset — it cannot be restarted from here`)
      continue
    }
    repairs.push({
      kind: 'restart-slot',
      slot: entry.slot,
      label: entry.label,
      branch: entry.branch,
      worktree: entry.worktree,
      port: entry.port,
      url: entry.url,
      command: config.commands.devServer,
      env: { FLEET_SLOT: String(entry.slot), FLEET_SLOT_BRANCH: String(entry.branch), FLEET_PORT: entry.port === null || entry.port === undefined ? '' : String(entry.port) },
    })
  }
  for (const f of found) notes.push(`slot ${f.slot} (${f.branch}): ${f.state}${f.fault ? ` — ${f.reason}` : ''}`)
  return { ok: found.every(f => !f.fault), found, repairs, notes }
}

// ---- apply --------------------------------------------------------------------------------------

/** The argv that runs a user command string through the platform shell, detached. PURE. */
export function shellArgv(command, platform = process.platform) {
  // Mirrors sys/exec.shellCommand's split: `commands.devServer` is a shell string by definition, and
  // exec.mjs has no detached variant of that path (recorded as a gap), so the same argv is built here.
  return platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]]
}

/** The branch a worktree is on: '' for a detached HEAD, null when git cannot answer. Thin. */
export function currentBranch(worktree) {
  const r = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 15_000 })
  if (!r.ok) return null
  const b = r.stdout.trim()
  return b === 'HEAD' ? '' : b
}

/**
 * Start one slot's server detached, both streams to `<stateDir>/logs/slot-<n>.log`. Thin.
 * @returns {{pid: number|null, log: string|null}}
 */
export function startSlotServer(repair, { stateDir = null, platform = process.platform } = {}) {
  const [file, args] = shellArgv(repair.command, platform)
  let stdio = 'ignore'
  let log = null
  let fd = null
  if (stateDir) {
    const logs = stateLayout(stateDir, platform).logs
    fs.mkdirSync(logs, { recursive: true })
    log = path.join(logs, `slot-${repair.slot}.log`)
    fd = fs.openSync(log, 'a')
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} restart by fleet watch: ${repair.command}\n`)
    stdio = ['ignore', fd, fd]
  }
  try {
    const { pid } = spawnDetached(file, args, { cwd: repair.worktree, env: repair.env, stdio })
    return { pid: pid ?? null, log }
  } finally {
    // The child holds its own handle; keeping ours open leaks one descriptor per restart.
    if (fd !== null) fs.closeSync(fd)
  }
}

/**
 * Apply restart repairs. `io.currentBranch(worktree)` (default: git) is asked FIRST and a mismatch is
 * a failed repair, never a start; `io.start(repair)` (default: startSlotServer) spawns detached.
 * @returns {{repaired: Array, failed: Array}}
 */
export function apply(repairs, io = {}) {
  const branchOf = io.currentBranch || currentBranch
  const start = io.start || (r => startSlotServer(r, { stateDir: io.stateDir, platform: io.platform }))
  const repaired = []
  const failed = []
  for (const r of repairs) {
    if (r.kind !== 'restart-slot') continue
    try {
      const branch = branchOf(r.worktree)
      if (branch !== r.branch) {
        const now = branch === null ? 'git cannot report its branch' : branch === '' ? 'is on a detached HEAD' : `is on branch "${branch}"`
        failed.push({ ...r, error: `worktree ${now}, not the slot branch "${r.branch}" — a server started off-branch takes the shared host; not restarted` })
        continue
      }
      const started = start(r) || {}
      repaired.push({ ...r, pid: started.pid ?? null, log: started.log ?? null })
    } catch (e) {
      failed.push({ ...r, error: e.message })
    }
  }
  return { repaired, failed }
}

// ---- thin probes --------------------------------------------------------------------------------

/**
 * One GET; resolves the status code, or 0 on refusal, error or timeout — 0 and 502 both read as
 * "still compiling" upstream. The TLS check is off because a per-branch-host proxy mints its own
 * certificates and this is a liveness question, not a trust one.
 */
export function httpProbe(url, { timeoutMs = PROBE_TIMEOUT_SEC * 1000 } = {}) {
  return new Promise(resolve => {
    let u
    try {
      u = new URL(url)
    } catch {
      return resolve(0)
    }
    let done = false
    let timer = null
    const finish = s => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(s)
    }
    const mod = u.protocol === 'https:' ? https : http
    let req
    try {
      req = mod.request(u, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false, headers: { 'user-agent': 'claude-fleet-watch' } }, res => {
        finish(res.statusCode || 0)
        res.resume()
      })
    } catch {
      return finish(0)
    }
    // The socket timeout covers inactivity; this one caps the whole request, headers or not.
    timer = setTimeout(() => { req.destroy(); finish(0) }, timeoutMs)
    req.on('timeout', () => { req.destroy(); finish(0) })
    req.on('error', () => finish(0))
    req.end()
  })
}

/** `<slot url>` + `<probe path>`. */
export function probeUrl(base, probePath) {
  try {
    return new URL(String(probePath || '/'), String(base).endsWith('/') ? base : `${base}/`).toString()
  } catch {
    return `${base}${probePath || ''}`
  }
}

/** Is this worktree installed? The ready flag judged by core/install (lockfile-aware), never by existence alone. */
export function readyOf(worktree, config) {
  try {
    return readyState(observeWorktree(worktree, config), config).ready === true
  } catch {
    return false
  }
}

/**
 * Read what the verdict needs for every live slot: the ready flag, the route list (ONE command per
 * pass, shared by every slot) and the probes (sequential within a slot, honouring
 * `dependsOnPrevious`; slots in parallel). A slot with no ready flag is not probed — nothing there
 * can answer, and 45 s per uninstalled slot would stall the pass.
 * @returns {Promise<Object<number, {ready: boolean|null, routes: string[]|null, probes: Array<{path, status}>, routesError: string|null}>>}
 */
export async function observeSlots({ slots, registry, config, shellCommand: sh = shellCommand, httpProbe: hp = httpProbe, ready = readyOf }) {
  const live = liveSlots(slots, config)
  let routes = null
  let routesError = null
  if (config.devServer.routeListCommand) {
    try {
      const r = sh(config.devServer.routeListCommand, { timeoutMs: ROUTE_LIST_TIMEOUT_MS })
      if (r && r.ok) routes = String(r.stdout || '').split(/\r?\n/)
      else routesError = r && r.timedOut ? 'timed out' : `exit ${r ? r.code : '?'}`
    } catch (e) {
      routesError = e.message
    }
  }
  const out = {}
  await Promise.all(live.map(async s => {
    const d = descriptorFor(registry, s)
    if (!d) {
      out[s.n] = { ready: null, routes, probes: [], routesError }
      return
    }
    const isReady = ready(d.worktree, config)
    const probes = []
    if (isReady) {
      let prevOk = true
      for (const p of config.devServer.probes || []) {
        if (p.dependsOnPrevious && !prevOk) {
          probes.push({ path: p.path, status: null })
          continue
        }
        const timeoutMs = (Number(p.timeoutSec) > 0 ? Number(p.timeoutSec) : PROBE_TIMEOUT_SEC) * 1000
        const status = await hp(probeUrl(s.url, p.path), { timeoutMs })
        probes.push({ path: p.path, status })
        prevOk = statusOk(status, p)
      }
    }
    out[s.n] = { ready: isReady, routes, probes, routesError }
  }))
  return out
}
