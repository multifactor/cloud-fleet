// The one place that picks a snapshot provider per platform, with a short cache so one scan pass
// reuses one snapshot instead of paying the ~450 ms Windows round-trip several times.

import { snapshotWindows } from './proc-windows.mjs'
import { snapshotLinux, snapshotMac } from './proc-posix.mjs'

let cached = null
let cachedAt = 0

export function snapshot({ platform = process.platform, maxAgeMs = 0 } = {}) {
  const now = Date.now()
  if (cached && maxAgeMs > 0 && now - cachedAt < maxAgeMs) return cached
  let s
  if (platform === 'win32') s = snapshotWindows()
  else if (platform === 'darwin') s = snapshotMac()
  else s = snapshotLinux()
  cached = s
  cachedAt = now
  return s
}

export function invalidateSnapshot() {
  cached = null
  cachedAt = 0
}
