// Shared helpers for the prose gates. Not a test file: importing a *.test.mjs from another test
// runs its cases twice.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REPO = path.resolve(ROOT, '..', '..')
export const FIXTURES = path.join(ROOT, 'test', 'fixtures')

export const hashToken = s => createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 16)

export function readHashes(file) {
  return new Set(
    fs.readFileSync(path.join(FIXTURES, file), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')),
  )
}

export function readPatterns() {
  return fs.readFileSync(path.join(FIXTURES, 'redaction-patterns.txt'), 'utf8')
    .split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const [flags, pattern, why] = l.split('\t')
      return { source: pattern, flags: flags || '', why }
    })
}

/** Strings that are allowed verbatim even though they contain a denied token. */
export function readAllowed() {
  const f = path.join(FIXTURES, 'redaction-allow.txt')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}

/** Files the redaction gate covers. `docs/reference/contract.md` is included like any other. */
export function proseFiles() {
  const out = []
  const walk = dir => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(md|txt)$/.test(e.name)) out.push(p)
    }
  }
  for (const d of ['playbooks', 'docs', 'commands', 'trackers']) walk(path.join(ROOT, d))
  // The repository's own prose is published too, and so is anything under blog/ — a post is the
  // most widely read thing here and the least reviewed, so it is scanned like everything else.
  walk(path.join(REPO, 'blog'))
  for (const f of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    const p = path.join(REPO, f)
    if (fs.existsSync(p)) out.push(p)
  }
  return out
}

export const rel = file => path.relative(REPO, file).replace(/\\/g, '/')

/** Blank fenced ```example blocks, keeping line numbers stable. */
export function stripExampleBlocks(text) {
  return text.replace(/^```example\b[\s\S]*?^```/gm, m => m.split('\n').map(() => '').join('\n'))
}

/** Blank every allowed string, keeping length (so offsets and line numbers stay correct). */
export function stripAllowed(text, allowed) {
  let out = text
  for (const a of allowed) {
    if (!a) continue
    out = out.split(a).join(' '.repeat(a.length))
  }
  return out
}

export function tokensOf(text) {
  return text.match(/[A-Za-z][A-Za-z0-9]*/g) || []
}

export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

export const isAdapter = file => /[\\/]trackers[\\/][^\\/]+\.md$/.test(file)
