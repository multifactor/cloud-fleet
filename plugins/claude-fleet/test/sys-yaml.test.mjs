import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { parseYaml, parseFrontMatter } from '../src/sys/yaml.mjs'
import { ROOT } from './helpers/prose.mjs'

test('mappings, nesting, scalars, comments', () => {
  const v = parseYaml(`
# a comment
id: linear   # trailing comment
name: "Linear"
count: 3
ratio: 0.5
on: true
off: false
nothing: null
tilde: ~
nested:
  deep:
    key: value
quoted: 'it''s'
url: https://example.com/a#b
`)
  assert.deepEqual(v, {
    id: 'linear', name: 'Linear', count: 3, ratio: 0.5, on: true, off: false, nothing: null, tilde: null,
    nested: { deep: { key: 'value' } }, quoted: "it's", url: 'https://example.com/a#b',
  })
})

test('sequences of scalars and of mappings (first key on the dash line)', () => {
  const v = parseYaml(`
items:
  - one
  - "two"
  - 3
flags:
  - flag: "--x"
    help: "does x"
  - flag: "--y"
    help: "does y"
    extra:
      - a
      - b
`)
  assert.deepEqual(v.items, ['one', 'two', 3])
  assert.deepEqual(v.flags, [{ flag: '--x', help: 'does x' }, { flag: '--y', help: 'does y', extra: ['a', 'b'] }])
})

test('block scalars: literal keeps newlines, folded joins, strip drops the final newline', () => {
  const v = parseYaml(`
lit: |
  line one
  line two

  after blank
fold: >
  a b
  c d

  e
strip: |-
  no trailing
next: 1
`)
  assert.equal(v.lit, 'line one\nline two\n\nafter blank\n')
  assert.equal(v.fold, 'a b c d\ne\n')
  assert.equal(v.strip, 'no trailing')
  assert.equal(v.next, 1)
})

test('flow sequences and mappings, including quoted commas and colons', () => {
  const v = parseYaml(`
prefixes: ["mcp__linear__", "mcp__claude_ai_Linear__"]
key: {pattern: "[A-Z][A-Z0-9]+-[0-9]+", caseInsensitive: false, example: "ABC-1234", derive: null}
odd: ["a, b", 'c: d', 5, true]
`)
  assert.deepEqual(v.prefixes, ['mcp__linear__', 'mcp__claude_ai_Linear__'])
  assert.deepEqual(v.key, { pattern: '[A-Z][A-Z0-9]+-[0-9]+', caseInsensitive: false, example: 'ABC-1234', derive: null })
  assert.deepEqual(v.odd, ['a, b', 'c: d', 5, true])
})

test('errors carry the line number', () => {
  assert.throws(() => parseYaml('a: "unterminated\nb: 1'), /line 1: unterminated double-quoted/)
  assert.throws(() => parseYaml('a:\n  b: 1\n   c: 2'), /line 3: unexpected indentation/)
})

test('front matter is split from the body and absent front matter is null', () => {
  const { data, body } = parseFrontMatter('---\nid: x\n---\n# Title\nbody')
  assert.deepEqual(data, { id: 'x' })
  assert.equal(body, '# Title\nbody')
  assert.deepEqual(parseFrontMatter('# no front matter'), { data: null, body: '# no front matter', raw: null })
})

test('the real playbook and adapter front matters parse into the shapes the renderer and registry expect', () => {
  const launcher = parseFrontMatter(fs.readFileSync(path.join(ROOT, 'playbooks', 'launcher.md'), 'utf8')).data
  assert.equal(launcher.command.name, 'fleet')
  assert.ok(typeof launcher.command.usage === 'string' && launcher.command.usage.includes('/fleet'))
  assert.ok(Array.isArray(launcher.command.flags) && launcher.command.flags[0].flag)

  const check = parseFrontMatter(fs.readFileSync(path.join(ROOT, 'playbooks', 'check.md'), 'utf8')).data
  assert.equal(check.command.name, 'fleet-check')
  assert.ok(Array.isArray(check.command.usage))
  assert.equal(check.command.neverAsk, true)
  assert.ok(check.command.flags.some(f => f.name === '--auto'))

  for (const f of fs.readdirSync(path.join(ROOT, 'trackers')).filter(f => f.endsWith('.md'))) {
    const fm = parseFrontMatter(fs.readFileSync(path.join(ROOT, 'trackers', f), 'utf8')).data
    assert.ok(fm && fm.id, `${f}: front matter parses and has an id`)
    assert.ok(Array.isArray(fm.mcp?.toolPrefixes) || fm.mcp?.toolPrefixes === null, `${f}: mcp.toolPrefixes`)
    assert.ok(fm.capabilities && typeof fm.capabilities === 'object', `${f}: capabilities`)
  }
})
