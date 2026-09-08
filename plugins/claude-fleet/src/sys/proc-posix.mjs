// POSIX process snapshots.
//   Linux: read /proc directly — no subprocess, ~5 ms. stat field 4 = ppid, field 5 = pgid, and
//          cmdline is NUL-separated.
//   macOS: `ps -Awwo pid=,ppid=,pgid=,rss=,state=,args=` — `-ww` matters: without it args are
//          truncated and command-line matching silently misses.

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { snapshotFrom } from './proc.mjs'

export function snapshotLinux(procRoot = '/proc') {
  const list = []
  let names = []
  try { names = fs.readdirSync(procRoot) } catch { return snapshotFrom([]) }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const pid = Number(n)
    let stat, cmdline
    try {
      stat = fs.readFileSync(`${procRoot}/${n}/stat`, 'utf8')
      cmdline = fs.readFileSync(`${procRoot}/${n}/cmdline`, 'utf8')
    } catch { continue }
    const parsed = parseLinuxStat(stat)
    if (!parsed) continue
    list.push({
      pid,
      ppid: parsed.ppid,
      pgid: parsed.pgid,
      name: parsed.comm,
      cmd: cmdline.split('\0').filter(Boolean).join(' ') || parsed.comm,
      rssBytes: parsed.rssPages * 4096,
      startedAt: parsed.startTicks,
      state: parsed.state,
      zombie: parsed.state === 'Z',
    })
  }
  return snapshotFrom(list)
}

/** Parse /proc/<pid>/stat. comm may contain spaces/parens, so split around the LAST ')'. */
export function parseLinuxStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < 0) return null
  const comm = text.slice(open + 1, close)
  const rest = text.slice(close + 2).trim().split(/\s+/)
  // rest[0]=state rest[1]=ppid rest[2]=pgrp ... rest[19]=starttime rest[21]=rss
  return { comm, state: rest[0] || '', ppid: Number(rest[1]), pgid: Number(rest[2]), startTicks: Number(rest[19]), rssPages: Number(rest[21]) || 0 }
}

/**
 * Parse `ps -Awwo pid=,ppid=,pgid=,rss=,state=,args=` output (rss in KB).
 *
 * ⛔ `state` is read so a ZOMBIE can be told from a live process. A zombie is an exit status nobody
 * has collected yet: it runs no code, holds nothing, and cannot be killed again — but it is still a
 * row in `ps`, so a re-snapshot that only asks "is the pid present" reports a process that is
 * genuinely gone as a survivor. See sys/kill.killTree.
 */
export function parsePsOutput(text) {
  const list = []
  for (const line of String(text).split('\n')) {
    // The state column is non-numeric and may carry flags (`S`, `Ss`, `R+`, `Z`), so it is the one
    // field matched as \S+ rather than digits; the args run to the end of the line as before.
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[6].trim()
    const state = m[5]
    list.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), name: cmd.split(/\s+/)[0].split('/').pop(), cmd, rssBytes: Number(m[4]) * 1024, state, zombie: state.startsWith('Z') })
  }
  return list
}

export function snapshotMac({ timeoutMs = 20000 } = {}) {
  const r = spawnSync('ps', ['-Awwo', 'pid=,ppid=,pgid=,rss=,state=,args='], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`ps failed (${r.status}): ${(r.stderr || '').slice(0, 500)}`)
  return snapshotFrom(parsePsOutput(r.stdout))
}
