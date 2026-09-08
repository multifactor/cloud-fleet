// Environment ↔ config. Pure.
//
//   envLayer(processEnv)            FLEET_* variables → the nested data of the "env" layer, coerced
//                                   by schema type. A blank value is UNSET, not zero — a stray
//                                   `FLEET_INSTALL_SETTLE_SEC=` once meant "0 seconds".
//   buildSessionEnv(config, session) the ~9 FLEET_* scalars mirrored into every spawned session
//                                   (the full descriptor lives in the session file), as DATA the
//                                   terminal backend renders for its shell.

import { SCHEMA, envNameFor } from './schema.mjs'
import { setPath } from './defaults.mjs'

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

/** Coerce one raw env string by schema type. Returns {value} or {error}. */
export function coerceEnv(entry, raw) {
  const s = String(raw).trim()
  switch (entry.type) {
    case 'int': {
      if (!/^-?\d+$/.test(s)) return { error: `expected an integer, got "${raw}"` }
      return { value: parseInt(s, 10) }
    }
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) return { error: `expected a number, got "${raw}"` }
      return { value: n }
    }
    case 'bool': {
      const l = s.toLowerCase()
      if (TRUE.has(l)) return { value: true }
      if (FALSE.has(l)) return { value: false }
      return { error: `expected a boolean (true/false/1/0/yes/no/on/off), got "${raw}"` }
    }
    case 'string[]':
      return { value: s.split(',').map(x => x.trim()).filter(Boolean) }
    case 'string':
    case 'path':
    case 'enum':
      return { value: s }
    default:
      return { error: `type ${entry.type} cannot be set from the environment` }
  }
}

/**
 * Build the "env" layer from process.env.
 * @returns {{data: object, warnings: Array<{code:string,key:string,env:string,message:string}>}}
 */
export function envLayer(processEnv, schema = SCHEMA) {
  const data = {}
  const warnings = []
  for (const e of schema) {
    const name = envNameFor(e)
    if (!name) continue
    const raw = processEnv[name]
    if (raw === undefined || raw === null) continue
    if (String(raw).trim() === '') continue // blank = unset
    const r = coerceEnv(e, raw)
    if (r.error) {
      warnings.push({ code: 'config.env.invalid', key: e.key, env: name, message: `${name}: ${r.error}` })
      continue
    }
    setPath(data, e.key, r.value)
  }
  return { data, warnings }
}

/**
 * The env scalars every session receives (contract §4). `session` is the descriptor the launcher
 * wrote: {label, role, file, stateFile, stateDir, testingUrl, testingUrls, sweepDir, slice}.
 * @returns {Array<{name: string, value: string}>}
 */
export function buildSessionEnv(config, session) {
  const urls = Array.isArray(session.testingUrls) ? session.testingUrls : []
  const out = [
    ['FLEET_SESSION', '1'],
    ['FLEET_SESSION_FILE', session.file],
    ['FLEET_LABEL', String(session.label)],
    ['FLEET_ROLE', session.role],
    ['FLEET_STATE_FILE', session.stateFile],
    ['FLEET_STATE_DIR', session.stateDir],
    ['FLEET_TESTING_URL', session.testingUrl || urls[0] || ''],
    ['FLEET_TESTING_URLS', urls.join(',')],
    ['FLEET_TRACKER_MODE', config.tracker.mode],
  ]
  if (session.role === 'checker') {
    out.push(['FLEET_SWEEP_DIR', session.sweepDir || ''])
    out.push(['FLEET_SLICE', session.slice || ''])
  }
  if (session.role === 'testing') {
    // A slot's dev-server command needs its own port: {port} is otherwise only a URL placeholder, so
    // without these a fixed-port project cannot start a second slot at all.
    if (session.slot === undefined || session.slot === null) throw new Error('buildSessionEnv: a testing session needs a slot number')
    out.push(['FLEET_SLOT', session.slot])
    out.push(['FLEET_SLOT_BRANCH', session.branch || ''])
    out.push(['FLEET_PORT', session.port === undefined || session.port === null ? '' : session.port])
  }
  for (const [name, value] of out) {
    if (value === undefined || value === null) throw new Error(`buildSessionEnv: ${name} is missing from the session descriptor`)
  }
  return out.map(([name, value]) => ({ name, value: String(value) }))
}
