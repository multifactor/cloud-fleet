// Memory probing, per OS.
//
// ⛔ `os.freemem()` is the right number on Windows and WRONG on both POSIX platforms, and the failure
// is asymmetric — it under-reports, so a naive gate reads "tight" on a healthy machine and serialises
// every install forever.
//   Linux : os.freemem() is MemFree, which excludes reclaimable page cache. Use MemAvailable, and
//           take CommitLimit/Committed_AS from the same file — Linux has a direct analogue of the
//           Windows commit gate.
//   macOS : os.freemem() is free_count * page_size, a few hundred MB on a healthy 32 GB machine. The
//           compressor makes "free bytes" close to meaningless, so gate on memory PRESSURE instead.
//   Windows: os.freemem() already is ullAvailPhys. Commit headroom comes from one Win32_OperatingSystem
//           read (~260ms) rather than two Get-Counter calls (~1.7s) — this runs before every install.
//
// What actually runs out is PHYSICAL memory; commit is a bookkeeping ceiling. A freeze once happened
// with 49 GB of commit free and 2.8 GB of physical free, so the physical number is the gate and the
// commit number is a secondary guard.

import os from 'node:os'
import fs from 'node:fs'
import { run } from './exec.mjs'

const GB = 1024 ** 3

/** Parse /proc/meminfo into bytes. Exported for tests with a fixture. */
export function parseMeminfo(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) out[m[1]] = Number(m[2]) * 1024
  }
  return out
}

/** Parse `vm_stat` output into bytes, given its page size. Exported for tests. */
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] || 4096)
  const val = name => {
    const m = new RegExp(`${name}:\\s+(\\d+)`).exec(text)
    return m ? Number(m[1]) * pageSize : 0
  }
  const free = val('Pages free') + val('Pages inactive') + val('Pages speculative') + val('Pages purgeable')
  return { freeBytes: free, compressed: val('Pages occupied by compressor') }
}

/** Map a macOS pressure level to our three-value scale. Exported for tests. */
export function pressureFromLevel(level) {
  const n = Number(level)
  if (n >= 4) return 'critical'
  if (n >= 2) return 'warn'
  return 'normal'
}

function probeLinux() {
  const info = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'))
  const freeBytes = info.MemAvailable ?? info.MemFree ?? 0
  const headroomBytes = info.CommitLimit && info.Committed_AS ? info.CommitLimit - info.Committed_AS : null
  const totalBytes = info.MemTotal ?? os.totalmem()
  const ratio = totalBytes ? freeBytes / totalBytes : 1
  return { freeBytes, headroomBytes, totalBytes, pressure: ratio < 0.05 ? 'critical' : ratio < 0.12 ? 'warn' : 'normal' }
}

function probeMac() {
  const vm = run('vm_stat', [], { timeoutMs: 5000 })
  const freeBytes = vm.ok ? parseVmStat(vm.stdout).freeBytes : os.freemem()
  const level = run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 5000 })
  const pressure = level.ok ? pressureFromLevel(level.stdout.trim()) : 'normal'
  return { freeBytes, headroomBytes: null, totalBytes: os.totalmem(), pressure }
}

const PS_MEM = [
  '$ErrorActionPreference="Stop"',
  '$o = Get-CimInstance Win32_OperatingSystem',
  'ConvertTo-Json -Compress -InputObject @{ freeKb = $o.FreePhysicalMemory; totalKb = $o.TotalVisibleMemorySize; freeVirtualKb = $o.FreeVirtualMemory; totalVirtualKb = $o.TotalVirtualMemorySize }',
].join('; ')

function probeWindows() {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_MEM], { timeoutMs: 15_000 })
  if (!r.ok) return { freeBytes: os.freemem(), headroomBytes: null, totalBytes: os.totalmem(), pressure: 'normal', degraded: true }
  const j = JSON.parse(r.stdout)
  const freeBytes = Number(j.freeKb) * 1024
  const headroomBytes = Number(j.freeVirtualKb) * 1024
  const totalBytes = Number(j.totalKb) * 1024
  const ratio = totalBytes ? freeBytes / totalBytes : 1
  return { freeBytes, headroomBytes, totalBytes, pressure: ratio < 0.05 ? 'critical' : ratio < 0.12 ? 'warn' : 'normal' }
}

/**
 * @returns {{freeBytes: number, headroomBytes: number|null, totalBytes: number, pressure: 'normal'|'warn'|'critical', degraded?: boolean}}
 * A failed probe must read TIGHT, never roomy: the cost of pausing an install is a delay, the cost of
 * starting four is a machine that stops responding.
 */
export function probeMemory({ platform = process.platform } = {}) {
  try {
    if (platform === 'linux') return probeLinux()
    if (platform === 'darwin') return probeMac()
    if (platform === 'win32') return probeWindows()
    return { freeBytes: os.freemem(), headroomBytes: null, totalBytes: os.totalmem(), pressure: 'normal' }
  } catch {
    return { freeBytes: 0, headroomBytes: 0, totalBytes: os.totalmem(), pressure: 'critical', degraded: true }
  }
}

export const bytesToGb = b => b / GB
export const gbToBytes = g => g * GB
