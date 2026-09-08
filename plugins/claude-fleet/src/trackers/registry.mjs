// The tracker adapter registry: finds, parses and validates `trackers/<id>.md`.
//
// An adapter is a markdown file with YAML front matter (machine-read here) and one `## op-<n>` body
// section per operation (model-read: a session opens the file and executes the Call: line of the
// section a playbook named). This module is what makes "a stranger can add a tracker by PR"
// enforceable: test/tracker-registry.test.mjs runs validateAdapter over every bundled file, so a
// malformed adapter fails CI rather than a fleet at 3am.
//
// ⛔ Sections are keyed by NUMBER, never by name — op-5 and op-7 are both `setState`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontMatter } from '../sys/yaml.mjs'

export const OP_COUNT = 27
export const OP_NAMES = Object.freeze([
  null, 'resolveChildren', 'getIssue', 'resolveUser', 'resolveState', 'setState', 'assign', 'setState',
  'attachLink', 'cancel', 'leaveOpen', 'comment', 'listQueue', 'createIssue', 'updateIssue', 'patchBody',
  'findIssues', 'listLabels', 'ensureLabel', 'listStates', 'resolveProject', 'createProject', 'attachImage',
  'setParent', 'markDuplicate', 'relate', 'readWorkItems', 'tickWorkItem',
])

/** Which capability flag, when false, makes an op's section a documented degradation rather than a Call. */
export const CAPABILITY_FOR_OP = Object.freeze({
  1: 'resolveChildren', 9: 'cancel', 8: 'attachLink', 12: 'listQueue', 11: 'comment', 13: 'createIssue',
  17: 'labels', 18: 'labels', 23: 'subIssues', 24: 'duplicateRelation', 25: 'relations', 26: 'workItems', 27: 'workItems',
})

export const ENUMS = Object.freeze({
  grouping: ['project', 'epic', 'milestone', 'label', 'list', 'none'],
  imageEmbed: ['inline', 'attachment', 'none'],
  imageUpload: ['mcp', 'rest', 'none', 'cli'],
  workItems: ['body', 'comment', 'children', 'checklist', 'none'],
  findComplete: ['page-flag', 'total', 'link-header', 'all-at-once'],
  priorityScale: ['numeric', 'named', 'labels', 'none'],
  scopeLabel: ['team', 'project', 'repo', 'workspace', 'board'],
  transport: ['mcp', 'rest', 'cli'],
  strategy: ['native-upload', 'assets-branch', 'attachment-only', 'none'],
})

/** The branch names an issue-key pattern must NOT match (contract §6). PURE. */
export function branchCorpus(config) {
  const base = config?.testing?.base || 'testing'
  const baseBranch = config?.repo?.baseBranch || 'main'
  return [baseBranch, 'develop', 'release-2', base, `${base}-2`, 'check/ABC-1234/a01', 'ada/fix-the-import-flow']
}

const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'trackers')

/** Every bundled adapter id (the template excluded). */
export function listAdapters({ bundledDir = BUNDLED, projectDir = null } = {}) {
  const ids = new Set()
  for (const dir of [bundledDir, projectDir].filter(Boolean)) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && !f.startsWith('_')) ids.add(f.slice(0, -3))
  }
  return [...ids].sort()
}

/** Resolve `<project>/.fleet/trackers/<id>.md` first, then the bundled file. */
export function adapterPath(id, { bundledDir = BUNDLED, projectDir = null } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) throw new Error(`adapter id "${id}" must be a lowercase slug`)
  const candidates = [projectDir && path.join(projectDir, `${id}.md`), path.join(bundledDir, `${id}.md`)].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) || null
}

/** PURE. Parse an adapter's text into {front, body, sections}. */
export function parseAdapter(text, { file = '<adapter>' } = {}) {
  const { data, body } = parseFrontMatter(text)
  if (!data) throw new Error(`${file}: no YAML front matter`)
  // Split on level-1/2 headings rather than a lazy regex with a lookahead: `\s*$` under the m flag
  // matches every line end, which once made every section body empty and every adapter fail with
  // "no Call: line" — a bug in the checker, reported as a bug in all six adapters.
  const sections = {}
  const chunks = body.split(/^(?=#{1,2}\s)/m)
  for (const chunk of chunks) {
    const h = /^##\s+op-(\d+)\b[^\n]*\n?([\s\S]*)$/.exec(chunk)
    if (!h) continue
    const n = Number(h[1])
    const text = h[2]
    if (sections[n] !== undefined) { sections[n] = { ...sections[n], duplicate: true }; continue }
    sections[n] = {
      n,
      text: text.trim(),
      hasCall: /^\s*(?:[-*]\s*)?(?:\*\*)?Call\b/m.test(text),
      hasUnsupported: /If unsupported/i.test(text),
      hasStrategy: /Strategy/i.test(text),
      hasTransport: /Transport/i.test(text),
    }
  }
  return { front: data, body, sections }
}

/** Load and parse one adapter. */
export function loadAdapter(id, opts = {}) {
  const file = adapterPath(id, opts)
  if (!file) return null
  const parsed = parseAdapter(fs.readFileSync(file, 'utf8'), { file })
  return { id, file, ...parsed }
}

/**
 * PURE. Everything the template's checklist promises a contributor CI will check.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateAdapter(parsed, { expectedId = null, config = null } = {}) {
  const errors = []
  const warnings = []
  const f = parsed.front || {}
  const err = m => errors.push(m)

  if (!f.id) err('front matter: id is required')
  else if (expectedId && f.id !== expectedId) err(`front matter: id "${f.id}" must equal the filename "${expectedId}"`)
  if (!f.name) err('front matter: name is required')

  const mcp = f.mcp || {}
  if (!Array.isArray(mcp.toolPrefixes)) err('front matter: mcp.toolPrefixes must be a list (empty is allowed for a CLI-only adapter)')
  else for (const p of mcp.toolPrefixes) if (typeof p !== 'string' || !/^mcp__[A-Za-z0-9_]+__$/.test(p)) err(`front matter: mcp.toolPrefixes entry "${p}" must look like mcp__name__`)
  if (!Array.isArray(mcp.install) || !mcp.install.length) err('front matter: mcp.install must list at least one way to connect')
  else for (const [i, inst] of mcp.install.entries()) {
    if (!inst || !inst.label) err(`front matter: mcp.install[${i}] needs a label`)
    if (!inst.command && !inst.instructions) err(`front matter: mcp.install[${i}] needs a command or instructions`)
  }

  const key = f.issueKey || {}
  if (!key.pattern) err('front matter: issueKey.pattern is required')
  else if (!key.example) err('front matter: issueKey.example is required')
  else {
    let re
    try {
      re = new RegExp(`^(?:${key.pattern})$`, key.caseInsensitive ? 'i' : '')
    } catch (e) {
      err(`front matter: issueKey.pattern does not compile: ${e.message}`)
    }
    if (re) {
      if (!re.test(String(key.example))) err(`front matter: issueKey.pattern does not match its own example "${key.example}"`)
      for (const b of branchCorpus(config)) {
        if (re.test(b)) err(`front matter: issueKey.pattern matches the ordinary branch name "${b}" in its declared case mode — it would read a branch as a ticket`)
      }
    }
  }

  const scope = f.scope || {}
  if (scope.required && !scope.listOp) warnings.push('front matter: scope.required is true but scope.listOp is unset — the wizard cannot enumerate scopes')
  if (scope.label && !ENUMS.scopeLabel.includes(scope.label)) err(`front matter: scope.label "${scope.label}" is not one of ${ENUMS.scopeLabel.join('|')}`)

  const caps = f.capabilities || {}
  for (const [name, allowed] of Object.entries({ grouping: ENUMS.grouping, imageEmbed: ENUMS.imageEmbed, imageUpload: ENUMS.imageUpload, workItems: ENUMS.workItems, findComplete: ENUMS.findComplete })) {
    if (caps[name] === undefined) err(`front matter: capabilities.${name} is required`)
    else if (!allowed.includes(caps[name])) err(`front matter: capabilities.${name} "${caps[name]}" is not one of ${allowed.join('|')}`)
  }
  for (const name of ['resolveChildren', 'cancel', 'attachLink', 'listQueue', 'comment', 'createIssue', 'labels', 'atomicPatch', 'subIssues', 'duplicateRelation', 'relations']) {
    if (typeof caps[name] !== 'boolean') err(`front matter: capabilities.${name} must be true or false`)
  }

  const pr = f.priority || {}
  if (!ENUMS.priorityScale.includes(pr.scale)) err(`front matter: priority.scale must be one of ${ENUMS.priorityScale.join('|')}`)
  else if (pr.scale !== 'none') {
    const keys = Object.keys(pr.map || {}).sort()
    if (keys.join(',') !== '1,2,3,4') err('front matter: priority.map must have exactly the keys 1, 2, 3, 4')
    if (pr.scale === 'labels' && caps.labels === false) err('front matter: priority.scale is "labels" but capabilities.labels is false')
  }

  const states = f.states || {}
  for (const s of ['in-progress', 'in-review', 'cancelled']) {
    if (!states[s] || !states[s].promptDefault) err(`front matter: states.${s}.promptDefault is required`)
  }

  for (const [i, c] of (f.config || []).entries()) {
    if (!c || !c.key || !c.prompt) err(`front matter: config[${i}] needs key and prompt`)
    if (c && typeof c.required !== 'boolean') err(`front matter: config[${i}].required must be true or false`)
  }

  // --- body ---
  const sections = parsed.sections || {}
  for (let n = 1; n <= OP_COUNT; n++) {
    const s = sections[n]
    if (!s) { err(`body: no "## op-${n} ${OP_NAMES[n]}" section`); continue }
    if (s.duplicate) err(`body: op-${n} appears more than once`)
    const cap = CAPABILITY_FOR_OP[n]
    const supported = cap ? caps[cap] !== false : true
    if (supported && !s.hasCall) err(`body: op-${n} is supported (capabilities.${cap || 'core'}) but has no Call: line`)
    if (!s.hasUnsupported) err(`body: op-${n} has no "If unsupported:" line`)
    if (n === 22 && !s.hasStrategy) err('body: op-22 attachImage has no Strategy: line')
    if (n === 22 && s.hasStrategy) {
      const m = /Strategy:?\**\s*`?([a-z-]+)/i.exec(s.text)
      if (m && !ENUMS.strategy.includes(m[1])) err(`body: op-22 Strategy "${m[1]}" is not one of ${ENUMS.strategy.join('|')}`)
    }
  }
  const extra = Object.keys(sections).map(Number).filter(n => n < 1 || n > OP_COUNT)
  if (extra.length) err(`body: sections for nonexistent ops: ${extra.map(n => `op-${n}`).join(', ')}`)

  return { ok: errors.length === 0, errors, warnings }
}

/** PURE. Is this adapter's tracker connected, given the tool names visible in a session? */
export function isConnected(front, visibleToolNames) {
  const prefixes = front?.mcp?.toolPrefixes || []
  if (!prefixes.length) return { connected: null, reason: 'this adapter needs no MCP (CLI transport)' }
  const hit = visibleToolNames.find(t => prefixes.some(p => t.startsWith(p)))
  return hit ? { connected: true, reason: `saw ${hit}` } : { connected: false, reason: `no visible tool starts with ${prefixes.join(' or ')}` }
}

/** PURE. The RegExp the launcher uses to recognise an issue key of this tracker, word-bounded. */
export function issueKeyRegex(front) {
  const key = front?.issueKey || {}
  if (!key.pattern) throw new Error('adapter declares no issueKey.pattern')
  return new RegExp(`(?<![A-Za-z0-9])(${key.pattern})(?![A-Za-z0-9])`, key.caseInsensitive ? 'i' : '')
}

/**
 * PURE. Normalise something the operator explicitly passed AS a key (`--issues abc-1234`) to the
 * tracker's canonical form. This is the opposite job from issueKeyRegex: that one recognises keys
 * inside arbitrary text and must never claim a branch name, so it is case-sensitive and bounded;
 * this one trusts the operator's declaration, so `release-2` here IS the key RELEASE-2.
 */
export function canonicalKey(front, input) {
  const key = front?.issueKey || {}
  const s = String(input).trim()
  // Upper-case a candidate BEFORE matching a case-sensitive pattern: `abc-1234` typed by the
  // operator still resolves, while a lowercase branch segment like `release-2` never does.
  const candidate = key.caseInsensitive ? s : s.toUpperCase()
  const re = new RegExp(`^(?:${key.pattern})$`, key.caseInsensitive ? 'i' : '')
  return re.test(candidate) ? candidate : null
}
