// Playbooks must speak only in canonical operation names. A tracker vendor named in a playbook is
// how "tracker-agnostic" quietly stops being true: the next edit reaches for that vendor's field
// names, and a year later the playbook only works for one tracker.
//
// Adapters are the ONLY place a vendor or a tool may be named, and only on a Call:/Transport: line.
// This test is what keeps the abstraction honest over time rather than only on ship day.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, stripExampleBlocks } from './helpers/prose.mjs'

const VENDORS = /\b(Linear|Jira|Atlassian|Asana|Trello|GitHub Issues)\b/
const MAX_OP = 27

const read = p => fs.readFileSync(p, 'utf8')
const listMd = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)) : [])
const lineAt = (text, index) => text.slice(0, index).split('\n').length

test('no playbook names a tracker vendor outside an example block', () => {
  const bad = []
  for (const file of listMd(path.join(ROOT, 'playbooks'))) {
    const text = stripExampleBlocks(read(file))
    const rx = new RegExp(VENDORS.source, 'g')
    let m
    while ((m = rx.exec(text))) bad.push(`${path.basename(file)}:${lineAt(text, m.index)} names "${m[1]}" — playbooks call ops, adapters name vendors`)
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('no playbook names an MCP tool identifier', () => {
  const bad = []
  for (const file of listMd(path.join(ROOT, 'playbooks'))) {
    const text = stripExampleBlocks(read(file))
    const rx = /\bmcp__[A-Za-z0-9_]+/g
    let m
    while ((m = rx.exec(text))) bad.push(`${path.basename(file)}:${lineAt(text, m.index)} names the tool ${m[0]}`)
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('every op a playbook or adapter cites exists (1..27) — no invented operations', () => {
  const bad = []
  for (const file of [...listMd(path.join(ROOT, 'playbooks')), ...listMd(path.join(ROOT, 'trackers'))]) {
    const rx = /\bop-(\d+)\b/g
    const text = read(file)
    let m
    while ((m = rx.exec(text))) {
      const n = Number(m[1])
      if (n < 1 || n > MAX_OP) bad.push(`${path.basename(file)}:${lineAt(text, m.index)} cites op-${n}, which does not exist`)
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('an adapter covers every op, with a Call: and an If unsupported: line', () => {
  const files = listMd(path.join(ROOT, 'trackers')).filter(f => !f.endsWith('_template.md'))
  if (!files.length) return // adapters land with the tracker phase
  const bad = []
  for (const file of files) {
    const name = path.basename(file)
    const body = read(file).replace(/^---[\s\S]*?^---/m, '')

    const sections = [...body.matchAll(/^##\s+op-(\d+)\b/gm)].map(m => Number(m[1]))
    for (let n = 1; n <= MAX_OP; n++) if (!sections.includes(n)) bad.push(`${name}: no "## op-${n}" section`)
    const dupes = [...new Set(sections.filter((n, i) => sections.indexOf(n) !== i))]
    if (dupes.length) bad.push(`${name}: duplicate op sections ${dupes.join(', ')}`)

    for (const c of body.split(/^##\s+/m).filter(x => /^op-\d+/.test(x))) {
      const n = /^op-(\d+)/.exec(c)[1]
      if (!/^\s*(?:[-*]\s*)?(?:\*\*)?Call\b/m.test(c)) bad.push(`${name}: op-${n} has no Call: line`)
      if (!/If unsupported/i.test(c)) bad.push(`${name}: op-${n} has no "If unsupported:" line`)
      if (n === '22' && !/Strategy/i.test(c)) bad.push(`${name}: op-22 has no Strategy: line`)
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test("an adapter's front matter is self-consistent: id, key pattern, and no branch collision", () => {
  const files = listMd(path.join(ROOT, 'trackers')).filter(f => !f.endsWith('_template.md'))
  if (!files.length) return
  const bad = []
  for (const file of files) {
    const name = path.basename(file)
    const text = read(file)
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(text)
    if (!fm) { bad.push(`${name}: no YAML front matter`); continue }
    // strip trailing YAML comments so `id: linear   # == filename` yields "linear"
    const front = fm[1].split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')

    const id = /^id:\s*(.+)$/m.exec(front)
    if (!id) bad.push(`${name}: front matter has no id`)
    else if (id[1].trim() !== path.basename(file, '.md')) bad.push(`${name}: id "${id[1].trim()}" does not equal the filename`)

    const pat = /pattern:\s*["']?(.+?)["']?\s*$/m.exec(front)
    const ex = /example:\s*["']?(.+?)["']?\s*$/m.exec(front)
    if (pat && ex) {
      let re
      try {
        re = new RegExp('^(?:' + pat[1].trim() + ')$', /caseInsensitive:\s*true/.test(front) ? 'i' : '')
      } catch {
        bad.push(`${name}: issueKey.pattern does not compile`)
        continue
      }
      if (!re.test(ex[1].trim())) bad.push(`${name}: issueKey.pattern does not match issueKey.example "${ex[1].trim()}"`)
      for (const branch of ['main', 'develop', 'release-2']) {
        if (re.test(branch)) bad.push(`${name}: issueKey.pattern also matches the branch name "${branch}"`)
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('an adapter body names a tool only on a Call:, Transport: or Strategy line', () => {
  // The front matter is structured data (toolPrefixes, listOp, and install instructions written for
  // a human), so the placement rule applies to the BODY — the part a model reads and acts on.
  const allowed = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Call|Transport|Strategy)\b|listOp|^\s*#|^\s*>/
  const bad = []
  for (const file of listMd(path.join(ROOT, 'trackers'))) {
    const text = read(file)
    const fm = /^---\r?\n[\s\S]*?\r?\n---/m.exec(text)
    const offset = fm ? fm[0].split('\n').length : 0
    const body = fm ? text.slice(fm[0].length) : text
    body.split(/\r?\n/).forEach((line, i) => {
      if (!/mcp__/.test(line)) return
      if (allowed.test(line)) return
      bad.push(`${path.basename(file)}:${offset + i + 1} names a tool outside a Call:/Transport:/Strategy line`)
    })
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

test('the adapter template documents every op so a contributor has a complete contract', () => {
  const tpl = path.join(ROOT, 'trackers', '_template.md')
  if (!fs.existsSync(tpl)) return
  const text = read(tpl)
  const missing = []
  for (let n = 1; n <= MAX_OP; n++) if (!new RegExp(`^##\\s+op-${n}\\b`, 'm').test(text)) missing.push(`op-${n}`)
  assert.deepEqual(missing, [], `_template.md is missing: ${missing.join(', ')}`)
})
