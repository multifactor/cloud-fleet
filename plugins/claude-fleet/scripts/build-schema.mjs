#!/usr/bin/env node
// Generate schema/fleet.config.schema.json from src/config/schema.mjs.
//
// The JSON Schema is GENERATED and committed: editors get autocomplete and validation from the
// committed file, and test/schema-parity.test.mjs asserts it byte-matches a fresh generation, so the
// two cannot drift. Edit src/config/schema.mjs, run `npm run schema:build`, commit both.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMA } from '../src/config/schema.mjs'

const TYPE = {
  string: { type: ['string', 'null'] },
  path: { type: ['string', 'null'] },
  int: { type: ['integer', 'null'] },
  number: { type: ['number', 'null'] },
  bool: { type: 'boolean' },
  'string[]': { type: ['array', 'null'], items: { type: 'string' } },
  object: { type: 'object' },
}

/** PURE. Build the JSON Schema document from the schema array. */
export function buildJsonSchema(schema = SCHEMA) {
  const root = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/multifactor-apps/claude-qa-skills/main/plugins/claude-fleet/schema/fleet.config.schema.json',
    title: 'claude-fleet configuration',
    description: 'Project layer: <repo>/.fleet/config.json. User layer: per-machine claude-fleet/config.json. Every key declares a scope; a user-scope key in a committed file is ignored, a secret one is an error.',
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
  for (const e of schema) {
    const node = leaf(e)
    place(root, e.key.split('.'), node)
  }
  return root
}

function leaf(e) {
  let node
  if (e.type === 'enum') node = { type: e.default === null ? ['string', 'null'] : 'string', enum: e.default === null ? [...e.enum, null] : e.enum }
  else if (e.type === 'array') node = { type: 'array', items: e.items }
  else node = { ...TYPE[e.type] }
  node.description = e.describe
  if (e.default !== null && e.default !== undefined) node.default = e.default
  if (e.min !== undefined) node.minimum = e.min
  if (e.max !== undefined) node.maximum = e.max
  node['x-scope'] = e.scope
  if (e.secret) node['x-secret'] = true
  if (e.derived) node['x-derived'] = e.derived
  if (e.required) node['x-required'] = true
  return node
}

function place(parent, parts, node) {
  const [head, ...rest] = parts
  if (!rest.length) {
    parent.properties[head] = node
    return
  }
  if (!parent.properties[head]) parent.properties[head] = { type: 'object', additionalProperties: false, properties: {} }
  place(parent.properties[head], rest, node)
}

export function schemaText() {
  return JSON.stringify(buildJsonSchema(), null, 2) + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'fleet.config.schema.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, schemaText())
  console.log(`wrote ${path.relative(process.cwd(), out)}`)
}
