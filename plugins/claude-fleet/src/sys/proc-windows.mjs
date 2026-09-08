// Windows process snapshot via ONE PowerShell round-trip per call. Measured ~450 ms for ~460
// processes — cache the snapshot for a whole scan pass; the old scanner made 3–6 round-trips.
//
// Two traps this file encodes:
//   * `@(...) | ConvertTo-Json` still collapses a single result to a bare object because the
//     pipeline unrolls the array — use `ConvertTo-Json -InputObject @(...)`.
//   * never `wmic` — removed in Windows 11 24H2+.
// The querying PowerShell itself appears in the result with this script in its CommandLine; callers
// exclude self + ancestors (proc.mjs protectedSet) rather than trying to filter it here.

import { spawnSync } from 'node:child_process'
import { snapshotFrom } from './proc.mjs'

// ⛔ CommandLine is stripped of control characters IN POWERSHELL, before it is ever serialised.
// `ConvertTo-Json` emits a raw newline, tab or escape byte inside the string instead of escaping it,
// so `JSON.parse` then fails with "Bad control character in string literal" — and it fails for the
// WHOLE snapshot, because one unlucky process poisons the single document every other process is in.
// Any process on the machine can carry one (a multi-line command, an editor, an installer), so the
// fleet would lose every process-based operation at once for a reason that has nothing to do with
// the fleet. `-replace` takes a regex, and `\p{C}` is every Unicode control/format code point.
const PS_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  '$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,' +
    '@{n="CommandLine";e={ if ($_.CommandLine) { $_.CommandLine -replace "\\p{C}", " " } else { $null } }},' +
    'WorkingSetSize,@{n="Created";e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null } }}',
  'ConvertTo-Json -Compress -Depth 2 -InputObject @($rows)',
].join('; ')

/** U+0000–U+001F: exactly the bytes JSON forbids unescaped inside a string. */
const CONTROL_BYTES = new RegExp('[\\u0000-\\u001F]', 'g')

/**
 * Repair a JSON document that carries raw control bytes INSIDE ITS STRINGS, by escaping them.
 *
 * ⛔ Only inside strings. A newline between tokens is legal, meaningless whitespace; escaping it
 * turns `{"a":1,\n"b":2}` into `{"a":1,\\u000a"b":2}`, which is a syntax error where there was none
 * — a "repair" that breaks every document it touches, including the ones that never needed it. So
 * this walks the text tracking whether it is inside a string literal (honouring backslash escapes)
 * and rewrites only the bytes that are actually illegal.
 *
 * Exported so a test can prove the repair on the exact shape PowerShell produces.
 */
export function escapeControlBytes(text) {
  const s = String(text)
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += c
        continue
      }
      if (c === '\\') {
        escaped = true
        out += c
        continue
      }
      if (c === '"') {
        inString = false
        out += c
        continue
      }
      out += c.charCodeAt(0) <= 0x1f ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c
      continue
    }
    if (c === '"') inString = true
    out += c
  }
  return out
}

/**
 * Parse the JSON PowerShell returns into ProcInfo[]. Exported for tests with a fixture.
 *
 * The strip in PS_SCRIPT is the first line of defence; this is the second. A snapshot is read by
 * kill planning and by every liveness check, so a parse failure must never be able to blind the
 * whole fleet: a document that only violates JSON's control-character rule is repaired and parsed
 * again, and only a document that is not JSON at all is an error.
 */
export function parseWindowsJson(json) {
  let arr
  try {
    arr = JSON.parse(json)
  } catch (e) {
    if (!/control character/i.test(e.message)) throw e
    arr = JSON.parse(escapeControlBytes(json))
  }
  const list = Array.isArray(arr) ? arr : [arr]
  return list.map(r => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: r.Name || '',
    cmd: r.CommandLine || '',
    rssBytes: Number(r.WorkingSetSize) || 0,
    startedAt: r.Created ? Date.parse(r.Created) : undefined,
  }))
}

export function snapshotWindows({ powershell = 'powershell.exe', timeoutMs = 20000 } = {}) {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`process snapshot failed (${r.status}): ${(r.stderr || '').slice(0, 500)}`)
  return snapshotWindowsFrom(r.stdout)
}

/** The pure half of snapshotWindows, so a fixture can drive it. */
export function snapshotWindowsFrom(stdout) {
  return snapshotFrom(parseWindowsJson(stdout))
}
