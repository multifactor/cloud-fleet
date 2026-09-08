// `fleet slots` (contract §7) — the derived testing slot table with each lock's status: which
// branch, which worktree, which URL, and who holds it right now.
//
// It answers "which slot is which" in one place, because that question used to be answered three
// times — by the branch list, by the port arithmetic and by the lock directory — and the answers
// disagreed. The table comes from `config/derive.buildSlots` and nowhere else.
//
// ⛔ It shows the slots that EXIST (the whole `testing.maxSlots` table) and marks which are in the
// pool, rather than hiding the rest: an operator asking why a session cannot get slot 3 needs to see
// that slot 3 has no session and is not being offered, not an empty line.

import path from 'node:path'

import { buildSlots, renderTemplate } from '../../config/derive.mjs'
import { isStale, readHolder } from '../../sys/lock.mjs'
import { staleMsFor } from '../../supervisor/checks/stale-locks.mjs'
import { listSessions } from '../../core/fleet.mjs'
import { poolDirName, testingSlotCount } from './pool.mjs'
import { envelope } from '../../cli.mjs'
import { CliError } from '../args.mjs'

export const name = 'slots'
export const usage = 'fleet slots [--json]'
export const needsConfig = true
export const needsBackend = false

export async function run(ctx) {
  const config = ctx.config
  const stateDir = config.paths.stateDir
  if (!stateDir) {
    throw new CliError('slots.no-state-dir', 'paths.stateDir is unresolved on this machine, so the slot locks cannot be read', 'run `fleet config status --json`; a needs-machine status is answered by `fleet config init`', 1)
  }
  const platform = (ctx.facts.machine && ctx.facts.machine.platform) || process.platform
  const p = platform === 'win32' ? path.win32 : path.posix

  const sessions = listSessions({ stateDir })
  const bySlot = new Map(sessions.filter(s => s && s.role === 'testing').map(s => [Number(s.slot), s]))
  const inPool = testingSlotCount(config, sessions)
  const staleMs = staleMsFor('testing', config)
  const locksDir = p.join(stateDir, 'locks', poolDirName('testing'))
  const nowMs = ctx.now()

  const slots = buildSlots(config).map(s => {
    const session = bySlot.get(s.n) || null
    const folder = renderTemplate(config.repo.slotDirTemplate, { repo: config.repo.name || '', branch: s.branch, slot: s.n, n: s.n })
    // Through sys/lock: null is "free, or the holder file has not landed yet" — mkdir wins the
    // mutex and holder.json is written a moment later.
    const holder = readHolder(p.join(locksDir, s.branch))
    return {
      n: s.n,
      slot: s.branch,
      branch: s.branch,
      port: s.port,
      url: s.url,
      // The session's own worktree wins over the re-rendered template: a changed
      // repo.slotDirTemplate would otherwise print a path the running slot is not in.
      worktree: session && session.worktree ? session.worktree : (config.repo.worktreeParent ? p.join(config.repo.worktreeParent, folder) : null),
      inPool: s.n <= inPool,
      session: session ? { label: String(session.label), liveness: session.liveness ?? null } : null,
      lock: {
        held: !!holder,
        owner: holder ? holder.owner : null,
        since: holder ? (holder.acquiredAt ?? null) : null,
        heartbeatAt: holder ? (holder.heartbeatAt ?? null) : null,
        stale: holder ? isStale(holder, nowMs, staleMs) : false,
      },
    }
  })

  ctx.json(envelope(true, {
    slots,
    pool: { name: 'testing', slots: inPool, maxSlots: config.testing.maxSlots, enabled: config.testing.enabled, staleMinutes: staleMs / 60_000 },
    urlTemplate: config.devServer.urlTemplate,
  }))

  if (!inPool) ctx.log('there is no local testing pool on this machine (testing.count is 0, or testing.enabled is false)')
  for (const s of slots) {
    ctx.log([
      `slot=${s.slot}`,
      `n=${s.n}`,
      `url=${s.url}`,
      `worktree=${s.worktree ?? '(repo.worktreeParent is unresolved)'}`,
      s.inPool ? (s.session ? `session=${s.session.label}` : 'session=none') : 'not-in-pool',
      s.lock.held ? `held-by=${s.lock.owner}${s.lock.stale ? ' STALE' : ''}` : 'free',
    ].join('  '))
  }
  return 0
}
