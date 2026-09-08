import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, holdDecision, planWaves, HARD_CAP } from '../src/core/pacing.mjs'
import { parseMeminfo, parseVmStat, pressureFromLevel, probeMemory } from '../src/sys/memory.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'
import { validateBackend, assertSpawnSpec, degradationNotice, NO_CAPABILITIES, CAPABILITY_NAMES, BACKEND_METHODS } from '../src/backends/types.mjs'

const GB = 1024 ** 3
const cfg = (over = {}) => {
  const c = defaultsFor()
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}
const reading = (freeGb, extra = {}) => ({ freeBytes: freeGb * GB, headroomBytes: null, totalBytes: 64 * GB, pressure: 'normal', ...extra })

// ---- pacing ------------------------------------------------------------------------------------

test('the 2026-08-03 freeze: roomy commit, 2.8 GB physical → serialise, not eight at once', () => {
  // What the old gate saw: 49 GB of commit headroom. What actually mattered: 2.8 GB of physical.
  const r = decide({ freeBytes: 2.8 * GB, headroomBytes: 49 * GB, totalBytes: 64 * GB, pressure: 'normal' }, { cpuCount: 16, config: cfg() })
  assert.equal(r.concurrency, 0)
  assert.equal(r.hold, true)
  assert.match(r.reason, /free physical memory is below the reserve/)
})

test('a healthy machine gets a wave, capped by the hard cap', () => {
  const r = decide(reading(40), { cpuCount: 16, config: cfg() })
  assert.equal(r.byRam, 8)          // (40 - 8) / 4
  assert.equal(r.byCpu, 4)          // 16 / 4
  assert.equal(r.concurrency, 4)    // capped
  assert.equal(r.hold, false)
})

test('the cap can be lowered but never raised past the hard cap', () => {
  assert.equal(decide(reading(40), { cpuCount: 64, config: cfg({ 'install.concurrencyCap': 2 }) }).concurrency, 2)
  assert.equal(decide(reading(200), { cpuCount: 64, config: cfg({ 'install.concurrencyCap': 99 }) }).concurrency, HARD_CAP)
})

test('a failed probe reads TIGHT — never as roomy', () => {
  const r = decide({ freeBytes: 999 * GB, headroomBytes: null, pressure: 'normal', degraded: true }, { cpuCount: 16, config: cfg() })
  assert.equal(r.concurrency, 0)
  assert.match(r.reason, /probe failed/)
})

test('memory pressure overrides an apparently roomy free-bytes number', () => {
  assert.equal(decide(reading(40, { pressure: 'critical' }), { cpuCount: 16, config: cfg() }).concurrency, 0)
  assert.equal(decide(reading(40, { pressure: 'warn' }), { cpuCount: 16, config: cfg() }).concurrency, 1)
})

test('commit headroom can only lower the number, never raise it', () => {
  const tight = decide(reading(40, { headroomBytes: 10 * GB }), { cpuCount: 16, config: cfg() })
  assert.equal(tight.concurrency, 0) // (10 - 8) / 4 = 0
  assert.match(tight.reason, /commit headroom/)
  const roomy = decide(reading(20, { headroomBytes: 500 * GB }), { cpuCount: 16, config: cfg() })
  assert.equal(roomy.concurrency, 3) // still bounded by physical: (20 - 8) / 4
})

test('concurrency never exceeds the work remaining', () => {
  assert.equal(decide(reading(40), { cpuCount: 16, config: cfg(), jobsRemaining: 2 }).concurrency, 2)
})

test('the hold budget is run-wide and exhausting it proceeds LOUDLY', () => {
  const c = cfg()
  const early = holdDecision({ heldMs: 60_000, config: c })
  assert.deepEqual([early.wait, early.proceedAnyway], [true, false])
  const spent = holdDecision({ heldMs: 601_000, config: c })
  assert.deepEqual([spent.wait, spent.proceedAnyway], [false, true])
  assert.match(spent.message, /waits forever looks healthy and does nothing/)
})

test('planWaves batches by concurrency, and zero concurrency plans nothing', () => {
  assert.deepEqual(planWaves([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(planWaves([1, 2], 0), [])
})

// ---- memory probes -----------------------------------------------------------------------------

test('Linux uses MemAvailable, not MemFree — MemFree would read tight on a healthy box', () => {
  const info = parseMeminfo(`MemTotal:       65735776 kB
MemFree:         2104856 kB
MemAvailable:   41203344 kB
CommitLimit:    49000000 kB
Committed_AS:   20000000 kB`)
  assert.equal(info.MemFree, 2104856 * 1024)
  assert.equal(info.MemAvailable, 41203344 * 1024)
  // the distinction is the whole point: MemFree here would serialise every install
  assert.ok(info.MemAvailable > info.MemFree * 15)
  assert.equal(info.CommitLimit - info.Committed_AS, 29000000 * 1024)
})

test('macOS free bytes sum the reclaimable page classes, not just free_count', () => {
  const vm = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages inactive:                          100000.
Pages speculative:                        30000.
Pages purgeable:                          10000.
Pages occupied by compressor:            250000.`)
  assert.equal(vm.freeBytes, (20000 + 100000 + 30000 + 10000) * 16384)
  assert.equal(vm.compressed, 250000 * 16384)
  assert.equal(pressureFromLevel('1'), 'normal')
  assert.equal(pressureFromLevel('2'), 'warn')
  assert.equal(pressureFromLevel('4'), 'critical')
})

test('probeMemory returns the documented shape on this machine and never throws', () => {
  const r = probeMemory()
  assert.equal(typeof r.freeBytes, 'number')
  assert.ok(['normal', 'warn', 'critical'].includes(r.pressure))
  assert.ok(r.headroomBytes === null || typeof r.headroomBytes === 'number')
  const unknown = probeMemory({ platform: 'sunos' })
  assert.equal(typeof unknown.freeBytes, 'number')
})

// ---- backend contract --------------------------------------------------------------------------

test('validateBackend names every missing method and every bad capability', () => {
  const good = { capabilities: () => ({ ...NO_CAPABILITIES, authoritativeList: true }) }
  for (const m of BACKEND_METHODS) if (!good[m]) good[m] = () => {}
  assert.deepEqual(validateBackend(good), { ok: true, missing: [], badCapabilities: [] })

  const bad = validateBackend({ capabilities: () => ({ authoritativeList: 'yes', nonsense: true }) })
  assert.equal(bad.ok, false)
  assert.ok(bad.missing.includes('spawn') && bad.missing.includes('kill'))
  assert.ok(bad.badCapabilities.some(x => x.includes('nonsense')))
  assert.ok(bad.badCapabilities.some(x => x.includes('not a boolean')))
  assert.equal(CAPABILITY_NAMES.length, Object.keys(NO_CAPABILITIES).length)
})

test('assertSpawnSpec rejects a spec that would spawn something unaddressable', () => {
  const ok = { id: '3', role: 'working', cwd: '/w/app-session-3', command: 'claude', args: ['--fleet-session=3'], env: [{ name: 'A', value: 'b' }] }
  assert.equal(assertSpawnSpec(ok), ok)
  assert.throws(() => assertSpawnSpec({ ...ok, id: '' }), /id is required/)
  assert.throws(() => assertSpawnSpec({ ...ok, role: 'boss' }), /unknown role/)
  assert.throws(() => assertSpawnSpec({ ...ok, args: '--x' }), /args must be an array/)
  assert.throws(() => assertSpawnSpec({ ...ok, env: [{ name: 'A', value: 3 }] }), /env entries must be/)
})

test('a degradation is announced, never silent', () => {
  const caps = { ...NO_CAPABILITIES, gridLayout: true }
  assert.equal(degradationNotice(caps, 'gridLayout', 'tiling'), null)
  assert.match(degradationNotice(caps, 'pixelLayout', 'pixel tiling'), /unavailable on this terminal backend \(no pixelLayout\)/)
})
