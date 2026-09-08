// The generated files must never drift from their sources. Edit the source, regenerate, commit both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './helpers/prose.mjs'
import { schemaText, buildJsonSchema } from '../scripts/build-schema.mjs'
import { renderAll, normalizeCommand, renderCommand } from '../scripts/render-commands.mjs'
import { SCHEMA } from '../src/config/schema.mjs'

test('schema/fleet.config.schema.json byte-matches a fresh generation (run `npm run schema:build`)', () => {
  const file = path.join(ROOT, 'schema', 'fleet.config.schema.json')
  assert.ok(fs.existsSync(file), 'schema file missing — run npm run schema:build')
  assert.equal(fs.readFileSync(file, 'utf8'), schemaText())
})

test('the JSON schema carries every key, its scope, and marks the secret one', () => {
  const js = buildJsonSchema()
  const get = key => key.split('.').reduce((n, p) => n && n.properties && n.properties[p], js)
  for (const e of SCHEMA) {
    const node = get(e.key)
    assert.ok(node, `missing ${e.key}`)
    assert.equal(node['x-scope'], e.scope, e.key)
  }
  assert.equal(get('tracker.rest.tokenEnv')['x-secret'], true)
  assert.deepEqual(get('capture.mode').enum, ['local', 'cloud', 'none'])
  assert.equal(js.properties.testing.additionalProperties, false)
})

test('commands/*.md byte-match a fresh render (run `npm run commands:render`)', () => {
  for (const { out, text } of renderAll()) {
    const file = path.join(ROOT, out)
    assert.ok(fs.existsSync(file), `${out} missing — run npm run commands:render`)
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${out} is stale`)
  }
})

test('the renderer normalises both front-matter shapes and never lets a command ask', () => {
  const a = normalizeCommand({ name: 'x', usage: 'line1\nline2', flags: [{ flag: '--a', help: 'A' }], preflight: 'P', noArgs: 'N' }, 'p.md')
  assert.deepEqual(a.usage, ['line1', 'line2'])
  assert.deepEqual(a.flags, [{ flag: '--a', help: 'A' }])
  const b = normalizeCommand({ name: 'y', usage: ['u'], flags: [{ name: '--m', values: 'a|b', default: 'c', description: 'D' }], args: [{ name: 'K', description: 'k' }], preflight: { run: 'cmd', onNotOk: 'exit' }, neverAsk: true }, 'q.md')
  assert.deepEqual(b.flags, [{ flag: '--m a|b', help: 'D Default: c' }])
  assert.deepEqual(b.args, [{ name: 'K', help: 'k' }])
  assert.equal(b.preflight, 'Run `cmd` first. exit')
  const md = renderCommand(b)
  assert.ok(md.includes('**Never ask the operator a question.**'))
  assert.ok(md.includes('GENERATED from q.md'))
  assert.ok(md.includes('$ARGUMENTS'))
  assert.throws(() => normalizeCommand({}, 'z.md'), /command.name/)
})
