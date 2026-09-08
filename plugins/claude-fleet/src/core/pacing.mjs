// How many installs may run at once, and whether to wait. PURE — the per-OS probe is injected, which
// is what lets the incident that motivated this file be a test case instead of a comment.
//
// The incident: eight installs launched at once because the gate looked at COMMIT headroom, which
// read roomy at ~49 GB free. Physical memory was 2.8 GB free. The machine thrashed to a hard hang and
// wrote 45 KB of nulls into a git config. Every rule here follows from that:
//
//   * gate on FREE PHYSICAL memory; commit is a secondary guard, never the primary one;
//   * a failed probe reads TIGHT, not roomy;
//   * waves, not a rolling pool — a barrier then a genuine idle, because a rolling pool never has a
//     quiet moment and the quiet moment is what lets writeback and the file cache drain;
//   * the hold has a run-wide budget, then proceeds with a loud warning rather than stalling a fleet
//     forever on a machine that is simply busy.

export const HARD_CAP = 4

/**
 * @param {object} reading  from probeMemory(): {freeBytes, headroomBytes, pressure, degraded}
 * @param {object} opts     {cpuCount, config: {install: {...}}, jobsRemaining}
 * @returns {{concurrency: number, hold: boolean, reason: string, byRam: number, byCpu: number}}
 */
export function decide(reading, { cpuCount = 4, config, jobsRemaining = Infinity } = {}) {
  const inst = config.install
  const reserveBytes = inst.reservePhysicalGb * 1024 ** 3
  const perInstallBytes = inst.perInstallGb * 1024 ** 3

  // A probe that failed tells us nothing, so it must not be read as "plenty".
  const free = reading.degraded ? 0 : reading.freeBytes
  const usable = Math.max(0, free - reserveBytes)
  const byRam = Math.floor(usable / perInstallBytes)
  const byCpu = Math.max(1, Math.floor(cpuCount / 4))
  const cap = Math.min(inst.concurrencyCap, HARD_CAP)

  let concurrency = Math.min(byRam, byCpu, cap, jobsRemaining)
  let reason = 'ram and cpu allow it'

  if (reading.pressure === 'critical') {
    concurrency = 0
    reason = 'memory pressure is critical'
  } else if (reading.degraded) {
    concurrency = 0
    reason = 'the memory probe failed, which reads as tight — never as roomy'
  } else if (byRam < 1) {
    concurrency = 0
    reason = `free physical memory is below the reserve plus one install (${(free / 1024 ** 3).toFixed(1)} GB free, ${inst.reservePhysicalGb} GB reserved)`
  } else if (reading.pressure === 'warn' && concurrency > 1) {
    concurrency = 1
    reason = 'memory pressure is elevated, so installs serialise'
  } else if (concurrency === byCpu && byCpu < byRam) {
    reason = 'cpu count is the binding constraint'
  } else if (concurrency === cap && cap < byRam) {
    reason = `capped at ${cap} (concurrent installs are what take a machine down)`
  }

  // Commit headroom is a secondary guard: it cannot raise the number, only lower it.
  if (reading.headroomBytes !== null && reading.headroomBytes !== undefined) {
    const byCommit = Math.floor(Math.max(0, reading.headroomBytes - reserveBytes) / perInstallBytes)
    if (byCommit < concurrency) {
      concurrency = Math.max(0, byCommit)
      reason = 'commit headroom is the binding constraint'
    }
  }

  return { concurrency: Math.max(0, concurrency), hold: concurrency < 1, reason, byRam, byCpu }
}

/**
 * Should the hold loop keep waiting, or proceed anyway?
 * A fleet that waits forever on a busy machine has failed differently from one that thrashes: it
 * looks fine and does nothing. So the budget is run-wide, and exhausting it proceeds LOUDLY.
 * @returns {{wait: boolean, proceedAnyway: boolean, message: string}}
 */
export function holdDecision({ heldMs, config }) {
  const maxMs = config.install.maxHoldSec * 1000
  if (heldMs < maxMs) {
    return { wait: true, proceedAnyway: false, message: `waiting for memory (${Math.round(heldMs / 1000)}s of ${config.install.maxHoldSec}s budget)` }
  }
  return {
    wait: false,
    proceedAnyway: true,
    message: `the ${config.install.maxHoldSec}s hold budget is exhausted; proceeding with one install anyway — a fleet that waits forever looks healthy and does nothing`,
  }
}

/** Split jobs into waves. A wave barriers, then the machine genuinely idles before the next. */
export function planWaves(jobs, concurrency) {
  if (concurrency < 1) return []
  const waves = []
  for (let i = 0; i < jobs.length; i += concurrency) waves.push(jobs.slice(i, i + concurrency))
  return waves
}
