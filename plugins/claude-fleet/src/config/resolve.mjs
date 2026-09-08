// Layer resolution: defaults → project → project-local → user-defaults → user-repo → user-checkout
// → env → cli, with scope enforcement and `$pinned`. Pure: takes parsed layer data, returns data.
//
// Two guards make the published tool person- and company-independent:
//   * a `user`-scope key found in a project-scope layer is IGNORED with warning `config.scope.leak`
//     (a machine path in a committed file can never take effect), and a `secret` key there is an
//     ERROR (`config.secret.committed`);
//   * `$pinned` lets a project declare keys the user layers may not override (a per-machine slot
//     branch name would desynchronise that machine's worktrees from everyone else's); env and CLI
//     still win, loudly, because you must be able to debug.

import { SCHEMA, SCHEMA_BY_KEY, isContainerType } from './schema.mjs'
import { defaultsFor, getPath, setPath, clone } from './defaults.mjs'

export const LAYER_ORDER = ['defaults', 'project', 'project-local', 'user-defaults', 'user-repo', 'user-checkout', 'env', 'cli']
export const PROJECT_LAYERS = new Set(['project', 'project-local'])
export const USER_LAYERS = new Set(['user-defaults', 'user-repo', 'user-checkout'])
export const OVERRIDE_LAYERS = new Set(['env', 'cli'])

/** Every dotted leaf path in a nested plain object (arrays are leaves). */
export function leafPaths(obj, prefix = '') {
  const out = []
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : []
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p))
    else out.push(p)
  }
  return out
}

/** Is `path` a schema key, or nested under a container-typed schema key? */
export function classifyPath(path, schemaByKey = SCHEMA_BY_KEY) {
  if (schemaByKey.has(path)) return { known: true, key: path }
  const parts = path.split('.')
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.')
    const e = schemaByKey.get(prefix)
    if (e && isContainerType(e.type)) return { known: true, key: prefix }
  }
  return { known: false, key: null }
}

/**
 * Resolve layers into one config.
 * @param {{layers: Array<{name: string, data: object}>, schema?: Array}} input
 *   `layers` may be in any order and may omit layers; they are applied in LAYER_ORDER. Unknown
 *   layer names throw.
 * @returns {{config: object, sources: Record<string,string>, pinned: string[], warnings: Array, errors: Array}}
 */
export function resolveConfig({ layers, schema = SCHEMA }) {
  const byKey = schema === SCHEMA ? SCHEMA_BY_KEY : new Map(schema.map(e => [e.key, e]))
  const byName = new Map()
  for (const l of layers || []) {
    if (!LAYER_ORDER.includes(l.name)) throw new Error(`unknown config layer "${l.name}"`)
    byName.set(l.name, l.data || {})
  }
  const config = defaultsFor(schema)
  const sources = {}
  for (const e of schema) sources[e.key] = 'defaults'
  const warnings = []
  const errors = []

  const projectData = byName.get('project') || {}
  const pinnedRaw = Array.isArray(projectData.$pinned) ? projectData.$pinned : []
  const pinned = pinnedRaw.filter(p => typeof p === 'string')
  for (const p of pinned) {
    if (!byKey.has(p)) warnings.push({ code: 'config.pinned.unknown', key: p, layer: 'project', message: `$pinned names an unknown key "${p}"` })
  }
  for (const p of pinned) {
    const e = byKey.get(p)
    if (e && e.scope === 'user') warnings.push({ code: 'config.pinned.user-scope', key: p, layer: 'project', message: `$pinned cannot pin the user-scope key "${p}"` })
  }

  for (const name of LAYER_ORDER) {
    if (name === 'defaults') continue
    const data = byName.get(name)
    if (!data) continue
    const seenKeys = new Set()
    for (const path of leafPaths(data)) {
      const { known, key } = classifyPath(path, byKey)
      if (!known) {
        warnings.push({ code: 'config.unknown-key', key: path, layer: name, message: `unknown key "${path}" in ${name} layer` })
        continue
      }
      if (seenKeys.has(key)) continue // container key already applied whole
      seenKeys.add(key)
      const e = byKey.get(key)
      const value = getPath(data, key)
      if (value === undefined) continue

      if (PROJECT_LAYERS.has(name)) {
        if (e.secret) {
          errors.push({ code: 'config.secret.committed', key, layer: name, message: `secret key "${key}" must never appear in a project-scope file` })
          continue
        }
        if (e.scope === 'user') {
          warnings.push({ code: 'config.scope.leak', key, layer: name, message: `user-scope key "${key}" in ${name} layer is ignored` })
          continue
        }
      }
      if (USER_LAYERS.has(name) && pinned.includes(key)) {
        warnings.push({ code: 'config.pinned.ignored', key, layer: name, message: `"${key}" is $pinned by the project; the ${name} value is ignored` })
        continue
      }
      if (OVERRIDE_LAYERS.has(name) && pinned.includes(key)) {
        warnings.push({ code: 'config.pinned.overridden', key, layer: name, message: `"${key}" is $pinned by the project but overridden by ${name}` })
      }
      if (USER_LAYERS.has(name) && e.scope === 'project') {
        warnings.push({ code: 'config.local-divergence', key, layer: name, message: `project-scope key "${key}" is set in the ${name} layer (local divergence)` })
      }
      setPath(config, key, clone(value))
      sources[key] = name
    }
  }

  return { config, sources, pinned, warnings, errors }
}
