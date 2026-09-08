// Built-in defaults, as a nested object, derived from the schema. Pure.

import { SCHEMA } from './schema.mjs'

/** Set a dotted path on a nested object, creating intermediate objects. Returns the object. */
export function setPath(obj, key, value) {
  const parts = key.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

/** Read a dotted path; returns `undefined` when any segment is missing. */
export function getPath(obj, key) {
  let cur = obj
  for (const p of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined
    cur = cur[p]
  }
  return cur
}

/** Structured clone for plain JSON data. */
export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

/** The nested defaults object. Derived and required keys are present with `null`. */
export function defaultsFor(schema = SCHEMA) {
  const out = {}
  for (const e of schema) setPath(out, e.key, clone(e.default))
  return out
}
