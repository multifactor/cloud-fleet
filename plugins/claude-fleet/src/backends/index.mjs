// Choosing a terminal backend, and the seam that lets a test inject one.
//
// `terminal.backend: auto` resolves per platform, and every fallback is ANNOUNCED: a fleet that
// silently degrades from Windows Terminal to bare consoles, or from tmux to nothing, looks like it
// worked and then behaves differently for reasons nobody can see.
//
// The `override` parameter is the whole reason this module exists. The config enum deliberately has
// no `fake` value — a test-only setting in a public schema is something a user can switch on by
// accident — so tests and `fleet doctor --dry-run` pass a backend object in instead.

import process from 'node:process'
import { validateBackend } from './types.mjs'

/** Ordered candidates per platform. First one whose probe() reports available wins. */
export const AUTO_ORDER = Object.freeze({
  win32: ['windows-terminal', 'powershell'],
  darwin: ['tmux'],
  linux: ['tmux'],
})

const LOADERS = {
  tmux: () => import('./tmux.mjs').then(m => m.createTmuxBackend),
  'windows-terminal': () => import('./windows-terminal.mjs').then(m => m.createWindowsTerminalBackend),
  powershell: () => import('./powershell.mjs').then(m => m.createPowerShellBackend),
  none: () => import('./none.mjs').then(m => m.createNoneBackend),
}

/** PURE. Which backend names to try, in order, for this config and platform. */
export function candidatesFor(config, platform = process.platform) {
  const want = config.terminal.backend
  if (want && want !== 'auto') return [want]
  return AUTO_ORDER[platform] || ['tmux']
}

/**
 * Resolve a backend.
 * @param {{config: object, override?: object, platform?: string, log?: (msg: string) => void}} opts
 * @returns {Promise<{backend: object, name: string, tried: Array<{name: string, reason: string}>}>}
 */
export async function selectBackend({ config, override = null, platform = process.platform, log = () => {} } = {}) {
  if (override) {
    const v = validateBackend(override)
    if (!v.ok) throw new Error(`injected backend is incomplete: missing ${v.missing.join(', ')}${v.badCapabilities.length ? `; ${v.badCapabilities.join('; ')}` : ''}`)
    return { backend: override, name: override.name || 'injected', tried: [] }
  }

  const tried = []
  for (const name of candidatesFor(config, platform)) {
    const load = LOADERS[name]
    if (!load) {
      tried.push({ name, reason: 'no such backend' })
      continue
    }
    let create
    try {
      create = await load()
    } catch (e) {
      tried.push({ name, reason: `could not be loaded: ${e.message}` })
      continue
    }
    const backend = create({ config, platform })
    const v = validateBackend(backend)
    if (!v.ok) {
      // A half-written backend fails HERE, at selection, rather than at 3am in the middle of a
      // fan-out with sessions already spawned.
      tried.push({ name, reason: `incomplete: missing ${v.missing.join(', ')}` })
      continue
    }
    const probe = backend.probe()
    if (probe.available) {
      if (tried.length) log(`terminal backend: using ${name} (${tried.map(t => `${t.name} ${t.reason}`).join('; ')})`)
      return { backend, name, tried }
    }
    tried.push({ name, reason: probe.reason || 'unavailable' })
  }

  const detail = tried.map(t => `  ${t.name}: ${t.reason}`).join('\n')
  throw new Error(
    `no terminal backend is available on this machine.\n${detail}\n` +
    'Install one of the candidates above, or set terminal.backend explicitly. On macOS and Linux the ' +
    'fleet uses tmux (brew install tmux / apt install tmux).',
  )
}
