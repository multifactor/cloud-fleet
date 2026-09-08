// Memory: is free PHYSICAL memory below the reserve, and if so, who is eating it?
//
// Physical RAM is what runs out; commit is a bookkeeping ceiling. A box once froze at 2.8 GB
// physical free with 49 GB of commit headroom, so this check reads sys/memory's per-OS probe and
// gates on `freeBytes` against `install.reservePhysicalGb`. A failed probe reads TIGHT, never roomy.
//
// When it is tight the note names the biggest NON-fleet consumers, aggregated by process name: the
// real hogs are usually the browser and the design tools, not the fleet — a per-session cost derived
// by subtraction once blamed every worker for the file cache, the compressor and forty browser
// processes. Fleet trees (anything under a session marker, and the supervisor's own tree) are
// excluded so what remains is what the operator can actually close.
//
// This check REPORTS. It never kills anything: nothing it can see is positively identified as ours.

import { descendants, sessionLabelOf } from '../../sys/proc.mjs'
import { gbToBytes, bytesToGb } from '../../sys/memory.mjs'

export const NAME = 'memory'

/** How many names to report when tight. */
export const TOP_CONSUMERS = 5

/** Every pid that belongs to the fleet: session trees and the supervisor's own tree. PURE. */
export function fleetPids(snapshot, selfPid) {
  const out = new Set()
  for (const p of snapshot.values()) {
    if (sessionLabelOf(p.cmd) === null) continue
    out.add(p.pid)
    for (const d of descendants(snapshot, p.pid)) out.add(d)
  }
  if (selfPid !== undefined && selfPid !== null) {
    out.add(Number(selfPid))
    for (const d of descendants(snapshot, selfPid)) out.add(d)
  }
  return out
}

/** RSS summed by process NAME over the non-fleet set, biggest first. PURE. */
export function topConsumers(snapshot, { selfPid, top = TOP_CONSUMERS } = {}) {
  const fleet = fleetPids(snapshot, selfPid)
  const byName = new Map()
  for (const p of snapshot.values()) {
    if (fleet.has(p.pid)) continue
    const name = String(p.name || '(unnamed)').toLowerCase()
    const cur = byName.get(name) || { name, rssBytes: 0, count: 0 }
    cur.rssBytes += p.rssBytes || 0
    cur.count += 1
    byName.set(name, cur)
  }
  return [...byName.values()]
    .filter(c => c.rssBytes > 0)
    .sort((a, b) => b.rssBytes - a.rssBytes || a.name.localeCompare(b.name))
    .slice(0, top)
    .map(c => ({ ...c, gb: Number(bytesToGb(c.rssBytes).toFixed(2)) }))
}

/**
 * @param {{reading: object, snapshot: Map, config: object, selfPid?: number, top?: number}} input
 *   `reading` is sys/memory.probeMemory()'s `{freeBytes, totalBytes, pressure, degraded?}`.
 * @returns {{ok: boolean, found: Array, repairs: [], notes: string[]}}
 */
export function verdict({ reading, snapshot, config, selfPid = process.pid, top = TOP_CONSUMERS }) {
  const reserveBytes = gbToBytes(config.install.reservePhysicalGb)
  const degraded = !reading || reading.degraded === true
  const freeBytes = degraded ? 0 : Number(reading.freeBytes) || 0
  const tight = degraded || freeBytes < reserveBytes || (reading && reading.pressure === 'critical')
  const notes = []
  if (!tight) {
    notes.push(`${bytesToGb(freeBytes).toFixed(1)} GB physical free (reserve ${config.install.reservePhysicalGb} GB)`)
    return { ok: true, found: [], repairs: [], notes }
  }
  const found = snapshot && snapshot.size ? topConsumers(snapshot, { selfPid, top }) : []
  const why = degraded
    ? 'the memory probe failed, which reads as tight — never as roomy'
    : `${bytesToGb(freeBytes).toFixed(1)} GB physical free is below the ${config.install.reservePhysicalGb} GB reserve${reading.pressure === 'critical' ? ' (pressure critical)' : ''}`
  const who = found.length
    ? ` — biggest non-fleet consumers: ${found.map(c => `${c.name} ${c.gb} GB (${c.count})`).join(', ')}`
    : (snapshot && snapshot.size ? '' : ' — no process snapshot to name the consumers')
  notes.push(`ATTENTION: ${why}${who}`)
  return { ok: false, found, repairs: [], notes }
}

/** Nothing to apply: this check only reports. */
export function apply() {
  return { repaired: [], failed: [] }
}
