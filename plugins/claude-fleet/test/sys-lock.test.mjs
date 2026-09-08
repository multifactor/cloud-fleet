import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { isStale, chooseSlot, tryAcquire, heartbeat, release, readHolder, ResourcePool, isHeldError, mkdirLock } from '../src/sys/lock.mjs'
import { parseTsv, formatRow, appendRow, readRows, column, distinct, countRows, writeRows } from '../src/sys/tsv.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lock-'))
const T0 = Date.parse('2026-03-14T10:00:00Z')

test('isStale: timestamp only — a dead pid with a fresh heartbeat is NOT stale', () => {
  const fresh = { owner: 'a', pid: 999999, acquiredAt: new Date(T0).toISOString(), heartbeatAt: new Date(T0).toISOString() }
  assert.equal(isStale(fresh, T0 + 60_000, 12 * 60_000), false)
  assert.equal(isStale(fresh, T0 + 13 * 60_000, 12 * 60_000), true)
  assert.equal(isStale(null, T0, 1), true)
  assert.equal(isStale({ owner: 'a', acquiredAt: 'garbage' }, T0, 1), true)
  // heartbeat extends acquire
  const hb = { owner: 'a', acquiredAt: new Date(T0).toISOString(), heartbeatAt: new Date(T0 + 10 * 60_000).toISOString() }
  assert.equal(isStale(hb, T0 + 15 * 60_000, 12 * 60_000), false)
})

test('chooseSlot picks the first free or stale slot', () => {
  const slots = [
    { name: 'a', holder: { acquiredAt: new Date(T0).toISOString() } },
    { name: 'b', holder: { acquiredAt: new Date(T0 - 60 * 60_000).toISOString() } },
    { name: 'c', holder: null },
  ]
  assert.equal(chooseSlot(slots, T0 + 1000, 12 * 60_000), 'b')
  assert.equal(chooseSlot(slots.slice(0, 1), T0 + 1000, 12 * 60_000), null)
})

test('tryAcquire / heartbeat / release on the filesystem; a foreign lock is never released', () => {
  const d = path.join(tmp(), 'lock')
  const a = tryAcquire(d, { owner: 'a', nowMs: T0, staleMs: 60_000 })
  assert.equal(a.acquired, true)
  assert.equal(readHolder(d).owner, 'a')
  const b = tryAcquire(d, { owner: 'b', nowMs: T0 + 1000, staleMs: 60_000 })
  assert.equal(b.acquired, false)
  assert.equal(b.holder.owner, 'a')
  assert.equal(release(d, 'b'), false)
  assert.equal(heartbeat(d, 'b', T0 + 2000), false)
  assert.equal(heartbeat(d, 'a', T0 + 2000), true)
  assert.equal(readHolder(d).heartbeatAt, new Date(T0 + 2000).toISOString())
  // re-entrant for the same owner
  const again = tryAcquire(d, { owner: 'a', nowMs: T0 + 3000, staleMs: 60_000 })
  assert.equal(again.acquired, true)
  assert.equal(again.reentrant, true)
  assert.equal(release(d, 'a'), true)
  assert.equal(fs.existsSync(d), false)
})

test('a lock directory with no holder file yet is HELD, not stale — the mid-acquire window', () => {
  // mkdir wins the mutex; holder.json lands a moment later. A reader landing in that window must not
  // treat the empty directory as free, or two sessions get the same slot. (Flaked on 3 of 9 runners.)
  const d = path.join(tmp(), 'lock')
  fs.mkdirSync(d)                    // exactly what a winner has done, one instruction in
  const b = tryAcquire(d, { owner: 'b', nowMs: Date.now(), staleMs: 60_000 })
  assert.equal(b.acquired, false, 'an empty but fresh lock dir must read as held')
  assert.equal(readHolder(d), null)
  // and it still ages out normally once it is genuinely old
  const later = tryAcquire(d, { owner: 'b', nowMs: Date.now() + 5 * 60_000, staleMs: 60_000 })
  assert.equal(later.acquired, true)
  assert.equal(later.stolen, true)
})

test('a steal in progress blocks a second stealer — stealing is serialised', () => {
  const d = path.join(tmp(), 'lock')
  tryAcquire(d, { owner: 'a', nowMs: T0, staleMs: 60_000 })
  fs.mkdirSync(d + '.steal')         // another process is mid-steal
  const c = tryAcquire(d, { owner: 'c', nowMs: T0 + 5 * 60_000, staleMs: 60_000 })
  assert.equal(c.acquired, false)
  assert.equal(c.stealInProgress, true)
  fs.rmSync(d + '.steal', { recursive: true })
  assert.equal(tryAcquire(d, { owner: 'c', nowMs: T0 + 5 * 60_000, staleMs: 60_000 }).acquired, true)
})

test('a stale lock is stolen and the previous holder is recorded', () => {
  const d = path.join(tmp(), 'lock')
  tryAcquire(d, { owner: 'a', nowMs: T0, staleMs: 60_000 })
  const b = tryAcquire(d, { owner: 'b', nowMs: T0 + 5 * 60_000, staleMs: 60_000 })
  assert.equal(b.acquired, true)
  assert.equal(b.stolen, true)
  assert.equal(readHolder(d).owner, 'b')
  assert.equal(readHolder(d).stolenFrom.owner, 'a')
})

test('ResourcePool: k slots, status, heldBy, prefer', () => {
  const locksDir = tmp()
  const p = new ResourcePool({ locksDir, name: 'testing', slots: ['testing', 'testing-2'], staleMs: 60_000 })
  const a = p.acquire('s1', { nowMs: T0 })
  assert.equal(a.slot, 'testing')
  const b = p.acquire('s2', { nowMs: T0 })
  assert.equal(b.slot, 'testing-2')
  assert.equal(p.acquire('s3', { nowMs: T0 }), null)
  assert.deepEqual(p.heldBy('s1'), ['testing'])
  assert.equal(p.status(T0).filter(s => s.holder).length, 2)
  assert.equal(p.release('s1', 'testing'), true)
  const c = p.acquire('s3', { nowMs: T0, prefer: 'testing-2' })
  assert.equal(c.slot, 'testing') // preferred slot is held; falls through
  assert.throws(() => new ResourcePool({ locksDir, name: 'x', slots: [], staleMs: 1 }))
})

test('8 real processes racing a 2-slot pool → exactly 2 winners, no double grant', async () => {
  const locksDir = tmp()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const lockMod = path.join(here, '..', 'src', 'sys', 'lock.mjs').replace(/\\/g, '/')
  // `node -e <script> a b` puts a at argv[1] and b at argv[2] — there is no script path to occupy
  // argv[1]. Reading argv[2]/argv[3] gave every child its own locksDir, so all 8 "won".
  const script = `
    import { ResourcePool } from 'file:///${lockMod}';
    const p = new ResourcePool({ locksDir: process.argv[1], name: 'race', slots: ['a','b'], staleMs: 60000 });
    const r = p.acquire('owner-' + process.argv[2]);
    process.stdout.write(JSON.stringify(r ? { slot: r.slot, owner: r.holder.owner } : null));
  `
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, locksDir, String(i)], { encoding: 'utf8' })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.on('error', reject)
    child.on('close', () => resolve(JSON.parse(out || 'null')))
  }))
  const results = await Promise.all(runs)
  const winners = results.filter(Boolean)
  assert.equal(winners.length, 2, JSON.stringify(results))
  assert.deepEqual(winners.map(w => w.slot).sort(), ['a', 'b'])
  // and the two slots really are held by two DIFFERENT owners on disk — no double grant
  const p = new ResourcePool({ locksDir, name: 'race', slots: ['a', 'b'], staleMs: 60_000 })
  const held = p.status().filter(s => s.holder)
  assert.equal(held.length, 2)
  assert.equal(new Set(held.map(s => s.holder.owner)).size, 2)
  assert.deepEqual(held.map(s => s.holder.owner).sort(), winners.map(w => w.owner).sort())
})

test('tsv: trailing newline, tab-safety, field extraction, row counting (109 rows are 109)', () => {
  const f = path.join(tmp(), 'ledger.tsv')
  for (let i = 1; i <= 109; i++) appendRow(f, [String(1000 + i), 'filed', `ABC-${i}`, '2026-03-14T00:00:00Z', 'note\twith\ttabs'])
  const text = fs.readFileSync(f, 'utf8')
  assert.ok(text.endsWith('\n'))
  assert.equal(countRows(text), 109)
  const rows = readRows(f)
  assert.equal(rows.length, 109)
  assert.equal(rows[0][4], 'note with tabs')
  assert.deepEqual(distinct(column(rows, 1)), ['filed'])
  assert.equal(distinct(column(rows, 2)).length, 109)
  assert.throws(() => appendRow(f, ['', '']), /empty row/)
  assert.deepEqual(readRows(path.join(tmp(), 'absent.tsv')), [])
  writeRows(f, [['a', 'b'], ['c', 'd']])
  assert.deepEqual(readRows(f), [['a', 'b'], ['c', 'd']])
  assert.equal(formatRow(['x', null, 'y\nz']), 'x\t\ty z\n')
  assert.deepEqual(parseTsv('a\tb\r\n\r\nc\td\n'), [['a', 'b'], ['c', 'd']])
})

test('a mkdir collision is not always EEXIST — Windows answers EPERM on a name pending delete', () => {
  // ⛔ The incident: `fleet check`'s outbox sequence lock threw
  // `EPERM: operation not permitted, mkdir …\locks\outbox\seq` on a Windows runner, in the test that
  // races two adds. `rmSync` returns once the delete is POSTED, not once the directory is gone, so a
  // release racing an acquire leaves the name in a pending-delete state — and Windows reports that as
  // EPERM. Every lock in the fleet is built on this call.
  const eexist = { code: 'EEXIST' }
  const eperm = { code: 'EPERM' }
  const eacces = { code: 'EACCES' }

  // EEXIST is contention everywhere.
  assert.equal(isHeldError(eexist, { exists: true, platform: 'linux' }), true)
  assert.equal(isHeldError(eexist, { exists: false, platform: 'win32' }), true)

  // EPERM is contention on Windows ONLY when the directory is actually there.
  assert.equal(isHeldError(eperm, { exists: true, platform: 'win32' }), true)
  assert.equal(isHeldError(eacces, { exists: true, platform: 'win32' }), true)

  // ⛔ And NOT otherwise. The same codes come back for a parent nobody may write to; treating that as
  // contention would make `fleet pool acquire` report "every slot is held" on a broken state dir,
  // sending an operator to look at the wrong thing entirely.
  assert.equal(isHeldError(eperm, { exists: false, platform: 'win32' }), false)
  assert.equal(isHeldError(eperm, { exists: true, platform: 'linux' }), false, 'on POSIX an EPERM from mkdir is a permission problem, full stop')
  assert.equal(isHeldError(null, { exists: true, platform: 'win32' }), false)
})

test('mkdirLock takes a free name, reports a taken one, and answers EEXIST without sleeping', () => {
  const dir = path.join(tmp(), 'lock')
  assert.equal(mkdirLock(dir), 'created')
  assert.equal(mkdirLock(dir), 'held')

  // The pending-delete window is milliseconds, so one retry usually finds the name free — and
  // "created" is a better answer than "held" when it is. Simulated by deleting during the sleep.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir)
  let slept = 0
  const platform = 'win32'
  // A real EPERM cannot be forced portably, so the retry is driven through the injected sleep: the
  // first attempt collides with a real directory, the sleep removes it, the retry succeeds.
  assert.equal(mkdirLock(dir, { platform, sleep: () => { slept++; fs.rmSync(dir, { recursive: true, force: true }) } }), 'held',
    'an EEXIST is answered immediately — the retry is for EPERM alone, and spending a sleep on every collision would slow every acquire')
  assert.equal(slept, 0)
})
