// Validation of a resolved + derived config. Pure. Errors block a run; warnings are reported.

import { SCHEMA } from './schema.mjs'
import { getPath } from './defaults.mjs'
import { insideAny } from './paths.mjs'

function typeOk(entry, v) {
  if (v === null || v === undefined) return true
  switch (entry.type) {
    case 'int': return Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'bool': return typeof v === 'boolean'
    case 'string': case 'path': return typeof v === 'string'
    case 'enum': return typeof v === 'string' && entry.enum.includes(v)
    case 'string[]': return Array.isArray(v) && v.every(x => typeof x === 'string')
    case 'array': return Array.isArray(v)
    case 'object': return typeof v === 'object' && !Array.isArray(v)
    default: return true
  }
}

/**
 * @param {object} config  resolved + derived
 * @param {{adapter?: object|null, facts?: object, sources?: Record<string,string>}} ctx
 * @returns {{errors: Array, warnings: Array}}
 */
export function validateConfig(config, { adapter = null, facts = {}, sources = {} } = {}) {
  const errors = []
  const warnings = []
  const err = (code, key, message) => errors.push({ code, key, message })
  const warn = (code, key, message) => warnings.push({ code, key, message })

  for (const e of SCHEMA) {
    const v = getPath(config, e.key)
    if (!typeOk(e, v)) {
      err('config.type', e.key, `${e.key}: expected ${e.type === 'enum' ? 'one of ' + e.enum.join('|') : e.type}, got ${JSON.stringify(v)}`)
      continue
    }
    if (e.required && (v === null || v === undefined || v === '')) err('config.missing-required', e.key, `${e.key} is required`)
    if (typeof e.min === 'number' && v !== null && v < e.min) err('config.range', e.key, `${e.key} must be >= ${e.min}`)
    if (typeof e.max === 'number' && v !== null && v > e.max) err('config.range', e.key, `${e.key} must be <= ${e.max}`)
  }

  const t = config.testing
  if (t.enabled && (t.count < 0 || t.count > t.maxSlots)) err('config.range', 'testing.count', `testing.count must be between 0 and testing.maxSlots (${t.maxSlots})`)
  if (t.enabled && t.count > 0 && !config.commands.devServer) err('config.missing-required', 'commands.devServer', 'commands.devServer is required when testing.count > 0')

  if (config.tracker.mode !== 'none' && !config.tracker.id) err('config.missing-required', 'tracker.id', 'tracker.id is required unless tracker.mode is "none"')
  if (config.tracker.mode !== 'none' && config.tracker.id) {
    for (const s of ['in-progress', 'in-review', 'cancelled']) {
      if (!config.tracker.states[s]) err('config.missing-required', `tracker.states.${s}`, `tracker.states.${s} is not set and the adapter has no default`)
    }
  }
  if (adapter) {
    if (adapter.scope && adapter.scope.required && !config.tracker.scope) err('config.missing-required', 'tracker.scope', `tracker.scope (${adapter.scope.label}) is required by the ${adapter.id} adapter`)
    for (const c of adapter.config || []) {
      if (c.required && (config.tracker.settings[c.key] === undefined || config.tracker.settings[c.key] === null || config.tracker.settings[c.key] === '')) {
        err('config.missing-required', `tracker.settings.${c.key}`, `tracker.settings.${c.key} is required by the ${adapter.id} adapter`)
      }
    }
  }

  const worktrees = (facts.git && facts.git.worktrees) || []
  if (config.paths.artifactsDir && worktrees.length && insideAny(config.paths.artifactsDir, worktrees, (facts.machine && facts.machine.platform) || 'linux')) {
    err('config.artifacts-inside-worktree', 'paths.artifactsDir', 'paths.artifactsDir must not be inside any worktree (teardown removes worktrees)')
  }

  if (Array.isArray(config.checker.routing) && sources['checker.routing'] && ['project', 'project-local'].includes(sources['checker.routing'])) {
    if (config.checker.routing.some(r => typeof r.assignee === 'string' && r.assignee.includes('@'))) {
      warn('config.routing.email-in-project', 'checker.routing', 'checker.routing assigns by email in a committed file — that is an org chart; move it to the user layer')
    }
  }

  if (config.fleet.queue.requireGate && !config.checker.gate.labels.passed) err('config.missing-required', 'checker.gate.labels.passed', 'requireGate needs checker.gate.labels.passed')
  if (config.checker.autoPromote === 'after-audit' && !config.checker.triage.label && !config.checker.ready.state) {
    warn('config.gate.nothing-to-collapse', 'checker.autoPromote', 'autoPromote is after-audit but neither checker.triage.label nor checker.ready.state is set — there is no gate to collapse')
  }

  return { errors, warnings }
}
