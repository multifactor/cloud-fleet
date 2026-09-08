// The redaction gate. Every published prose file is scanned for the things that must never appear:
// the source project's names, people, issue keys, paths and product mechanisms.
//
// The denylist is stored as HASHES (test/fixtures/redaction-*.txt), because a published plain-text
// denylist would leak the very names it guards. Patterns that describe a SHAPE rather than a secret
// (an issue-key regex, an absolute Windows path) are stored verbatim, and a tiny allowlist covers
// the strings that genuinely must appear — the repository's own address.
//
// A contributor appending a field note gets a failing test, not a review comment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  ROOT, REPO, FIXTURES, hashToken, readHashes, readPatterns, readAllowed, proseFiles, rel,
  stripExampleBlocks, stripAllowed, tokensOf, lineOf, isAdapter,
} from './helpers/prose.mjs'

const EXACT = readHashes('redaction-exact.txt')
const PROPER = readHashes('redaction-proper.txt')
const PATTERNS = readPatterns()
const ALLOWED = readAllowed()

// Adapters name tracker tools by design; where they may do so is enforced in playbook-brands.
const ADAPTER_EXEMPT = new Set(['\\bmcp__[a-z_]+'])

test('the denylist fixtures are hashes only — the tokens themselves are never published', () => {
  for (const f of ['redaction-exact.txt', 'redaction-proper.txt']) {
    for (const line of fs.readFileSync(path.join(FIXTURES, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue
      assert.match(line.trim(), /^[0-9a-f]{16}$/, `${f}: "${line}" is not a hash`)
    }
  }
  assert.ok(EXACT.size >= 15 && PROPER.size >= 5)
  assert.ok(ALLOWED.length <= 5, 'the allowlist is a hole in the gate — keep it tiny')
})

test('no pattern contains an inert word boundary — a guard that cannot match is not a guard', () => {
  // ⛔ The incident: the approval-bot row ended with a word-boundary assertion sitting directly
  // against a literal `]`. A boundary needs a WORD character on the outside, and `]` is not one — so
  // the pattern only matched when a word character FOLLOWED the handle, never a bare one. It
  // published a third-party vendor name in the file that exists to prevent leaks, and denied nothing.
  //
  // ⛔ The check is STATIC, on the pattern source, and that is deliberate. The obvious test — "every
  // pattern must match a sample" — cannot be written here: a sample matching the dev-host row IS the
  // dev-host convention, and one matching the product-category row IS the product category. Writing
  // those samples put both denied strings into this file in plain text, which is the leak the fixture
  // exists to prevent. So the rule is checked, never exercised.
  const BS = String.fromCharCode(92)
  const isWord = c => c !== undefined && /[A-Za-z0-9_]/.test(c)
  for (const { source, flags, why } of PATTERNS) {
    assert.doesNotThrow(() => new RegExp(source, flags), `/${source}/ (${why}) does not compile`)
    for (let i = 0; i < source.length - 1; i++) {
      if (source[i] !== BS || source[i + 1] !== 'b') continue
      if (i > 0 && source[i - 1] === BS) continue // an escaped backslash, then a literal "b"
      const before = i > 0 ? source[i - 1] : undefined
      const after = source[i + 2]
      const dead = (before !== undefined && !isWord(before)) || (after !== undefined && !isWord(after))
      assert.ok(
        !dead,
        `/${source}/ (${why}): the word boundary at index ${i} sits against ${JSON.stringify(before !== undefined && !isWord(before) ? before : after)}, which is not a word character — the boundary then only holds when the SURROUNDING TEXT supplies one, which is the opposite of what this row means`,
      )
    }
  }
})

test('the publisher-name exemption is enforced, not just asserted — over EVERY tracked file', () => {
  // ⛔ contract §1 grants exactly one exemption (the publishing organisation's name, in legal and
  // package-identity metadata) and then says "It appears nowhere else". Nothing checked that. The
  // prose gate reads `.md`/`.txt` under four directories, so the two `.claude-plugin` manifests, the
  // generated schema and the build script were all outside every gate — and the claim in §1 was
  // simply untrue of the tree it describes.
  //
  // This walks what git will actually publish. A denied identifier in a file that is not on the
  // sanctioned list is a leak; the same identifier ON the list is the exemption working as designed.
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO, encoding: 'utf8',
  }).trim().split(/\r?\n/).filter(Boolean)
  assert.ok(tracked.length > 100, `expected the whole tree, got ${tracked.length} files — the listing failed`)

  // §1's list, as paths. Keep this in step with the contract: a new entry here is a change to the
  // exemption and needs the same argument the original four did.
  const SANCTIONED = new Set([
    'LICENSE',                                              // the copyright holder
    'README.md',                                            // the install command names the address
    '.claude-plugin/marketplace.json',                      // package identity
    'plugins/claude-fleet/.claude-plugin/plugin.json',      // package identity
    'plugins/claude-fleet/schema/fleet.config.schema.json', // the schema's canonical $id URL
    'plugins/claude-fleet/scripts/build-schema.mjs',        // which generates that $id
  ])
  // The fixtures hold the denylist and the allowlist; they quote what they guard by construction.
  const isFixture = f => /test\/fixtures\/redaction-[\w-]+\.txt$/.test(f)

  const leaks = []
  for (const file of tracked) {
    if (SANCTIONED.has(file) || isFixture(file)) continue
    let text
    try {
      text = fs.readFileSync(path.join(REPO, file), 'utf8')
    } catch {
      continue // binary or unreadable: not prose, nothing to read
    }
    const seen = new Set()
    for (const tok of tokensOf(stripAllowed(text, ALLOWED))) {
      if (!EXACT.has(hashToken(tok)) || seen.has(tok.toLowerCase())) continue
      seen.add(tok.toLowerCase())
      leaks.push(`${file}: denied identifier (starts "${tok.slice(0, 2)}…", ${tok.length} chars)`)
    }
  }
  assert.deepEqual(leaks, [], `a denied identifier appears outside contract §1's sanctioned list:\n  ${leaks.join('\n  ')}`)
})

test('no published prose file contains a denied token, path, key or tool identifier', () => {
  const violations = []
  for (const file of proseFiles()) {
    const name = rel(file)
    const text = stripAllowed(stripExampleBlocks(fs.readFileSync(file, 'utf8')), ALLOWED)

    for (const { source, flags, why } of PATTERNS) {
      if (isAdapter(file) && ADAPTER_EXEMPT.has(source)) continue
      const rx = new RegExp(source, flags.includes('g') ? flags : flags + 'g')
      let m
      while ((m = rx.exec(text))) violations.push(`${name}:${lineOf(text, m.index)} matches /${source}/ — ${why}`)
    }

    const seen = new Set()
    for (const tok of tokensOf(text)) {
      if (EXACT.has(hashToken(tok)) && !seen.has(tok.toLowerCase())) {
        seen.add(tok.toLowerCase())
        violations.push(`${name}: contains a denied identifier (starts "${tok.slice(0, 2)}…", ${tok.length} chars)`)
      }
    }

    // Proper-noun codenames: only a capitalised use that is NOT sentence-initial is a leak.
    const rx = /(^|[^\s>#*\-|])[ \t]+([A-Z][a-z]{2,})\b/gm
    let m
    while ((m = rx.exec(text))) {
      if ('.!?:'.includes(m[1])) continue
      if (PROPER.has(hashToken(m[2]))) violations.push(`${name}:${lineOf(text, m.index)} uses "${m[2]}" as a proper noun — that is an internal product or person name`)
    }
  }
  assert.deepEqual(violations, [], `redaction violations:\n  ${violations.join('\n  ')}`)
})

test('every field note states what was seen, why, and the rule drawn', () => {
  const file = path.join(ROOT, 'docs', 'field-notes.md')
  if (!fs.existsSync(file)) return
  const entries = fs.readFileSync(file, 'utf8').split(/^### /m).slice(1)
  assert.ok(entries.length >= 10, 'field notes should carry the accumulated entries')
  const bad = []
  for (const e of entries) {
    const title = e.split('\n')[0].trim()
    // `Saw:` and `Rule:` are literal — a reader scanning for "what is the rule?" must always find it.
    const sawAt = e.search(/\*\*Saw:?\*\*/)
    const ruleAt = e.search(/\*\*Rule:?\*\*/)
    if (sawAt < 0) { bad.push(`${title} — no **Saw:**`); continue }
    if (ruleAt < 0) { bad.push(`${title} — no **Rule:**`); continue }
    if (ruleAt < sawAt) { bad.push(`${title} — **Rule:** precedes **Saw:**`); continue }
    // A long entry must separate its diagnosis from its observation — that is what makes it
    // skimmable. A short one may fold the cause into the Saw sentence, which reads better than a
    // one-clause **Cause:** section.
    const middle = e.slice(sawAt, ruleAt)
    const isLong = e.split('\n').filter(l => l.trim()).length > 8
    const hasCause = /\*\*Cause[^*]{0,40}:?\*\*/.test(middle) || /\*\*[^*]{8,}\*\*/.test(middle.replace(/\*\*Saw:?\*\*/, ''))
    if (isLong && !hasCause) bad.push(`${title} — long entry with no labelled cause between Saw and Rule`)
  }
  assert.deepEqual(bad, [], `malformed field notes:\n  ${bad.join('\n  ')}`)
})

test('no session-facing document hardcodes a path that must come from the descriptor', () => {
  const bad = []
  for (const file of proseFiles()) {
    if (/docs[\\/](gotchas|field-notes)\.md$/.test(file)) continue // may quote a symptom verbatim
    // README/CONTRIBUTING/SECURITY address the human operator: telling them where their own
    // settings file lives is correct documentation, not a hardcoded session path.
    if (/(README|CONTRIBUTING|SECURITY)\.md$/.test(file)) continue
    const name = rel(file)
    const text = stripExampleBlocks(fs.readFileSync(file, 'utf8'))
    for (const src of ['%TEMP%', '~/\\.claude/(?!projects)']) {
      const rx = new RegExp(src, 'g')
      let m
      while ((m = rx.exec(text))) bad.push(`${name}:${lineOf(text, m.index)} hardcodes ${m[0]} — paths come from the session descriptor / FLEET_* env`)
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})
