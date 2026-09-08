// Screenshot attachment: the route a captured PNG takes to the tracker, how one upload is shared by
// the sibling findings of a PR, and the body line that records the outcome. PURE — `fleet check plan`
// records the choice in the manifest once and every worker reads it; nothing here touches a tracker.
//
// ⛔ The strategy is chosen ONCE, by code, from the adapter's `imageEmbed` / `imageUpload`
// capabilities and `checker.attachStrategy` — never improvised at filing time. Workers left to work
// out an upload route mid-sweep produced several embed shapes across one corpus, and the report could
// no longer say how many issues carried a screenshot.
//
// ⛔ One upload per DISTINCT screenshot file, never per issue. Uploading once per issue multiplied the
// filing cost by the findings-per-PR ratio — a 300-finding sweep over ~100 screens became ~900
// round-trips.
//
// ⛔ Store the BARE URL. One tracker re-signs its asset URLs on every read; a signed URL copied into a
// sibling's body expires, and the image dies in every issue that inlined it.
//
// ⛔ `_No screenshot attached: <reason>_` is a DIFFERENT line from `_No UI surface — <reason>._`.
// "The app was down" and "there is no screen" are different outcomes; lumping them overstates
// coverage, and a missing line altogether is the worst case — a sweep once filed fifteen issues with
// no image and nobody could tell which were skips.

import path from 'node:path'
import { ENUMS } from '../trackers/registry.mjs'
import { renderTemplate } from '../config/derive.mjs'
import { SCHEMA } from '../config/schema.mjs'
import { assertSweepId } from './manifest.mjs'

/** The strategy vocabulary — the same list the adapter validator checks an op-22 `Strategy:` line against. */
export const STRATEGIES = ENUMS.strategy

// Contract §6 vocabularies for the two capabilities the decision reads. Spelled out here rather than
// taken from the registry because its `imageUpload` list also carries `cli`, which §6 defines only as
// a TRANSPORT — a value outside these lists is rejected, never described as "cannot upload".
export const IMAGE_EMBEDS = Object.freeze(['inline', 'attachment', 'none'])
export const IMAGE_UPLOADS = Object.freeze(['mcp', 'rest', 'none'])

/** `checker.attachStrategy` value → the strategy it forces. `auto` forces nothing. */
export const FORCED_BY_CONFIG = Object.freeze({
  native: 'native-upload',
  'assets-branch': 'assets-branch',
  attachment: 'attachment-only',
  none: 'none',
})

/** Forges whose blob URLs serve a PNG hot-linkably (`?raw=true`); anything else cannot host an assets branch. */
const RAW_HOSTS = ['github', 'gitlab']
/** Contract §3: `vcs.host github|gitlab|other`. A value outside it is rejected, never described as "cannot serve raw files". */
const VCS_HOSTS = SCHEMA.find(e => e.key === 'vcs.host').enum

const NO_SHOT_PREFIX = '_No screenshot attached: '
const NO_UI_PREFIX = '_No UI surface — '

/**
 * The placeholder line a worker files an issue with (playbooks/check.md §7.5 step 1 — the literal the
 * brief names too) and op-15 replaces once the shot is up. It carries no URL on purpose: an issue still
 * showing it was never patched, and shotOutcome() counts it as `missing`.
 */
export const SCREENSHOT_PLACEHOLDER = '![screenshot]'

const UNRESOLVED_HOST = 'vcs.host is unresolved — derive the config (fleet config resolve) before planning'

/**
 * Choose how screenshots reach the tracker. Decision table (`auto`):
 *   imageUpload mcp|rest(+token) and imageEmbed inline      → native-upload
 *   imageUpload mcp|rest(+token) and imageEmbed attachment  → attachment-only
 *   otherwise, imageEmbed inline and vcs.host github|gitlab → assets-branch (it IS an inline markdown image)
 *   otherwise                                               → none, with the reason for the body line
 * No adapter at all (tracker-less) reads as imageEmbed inline / imageUpload none: the findings render
 * as local markdown, which shows an inline image but has nothing to upload to. `vcs.host` is a derived
 * key; when it is unresolved AND would decide the route, the result is a refusal naming it — never a
 * silent `other`.
 * A forced `checker.attachStrategy` is honoured when the capabilities support it and REFUSED (`ok:
 * false`, strategy `none`) when they do not — a forced route that is silently swapped for another makes
 * the config lie, and a refusal at plan time is caught before the first tracker write instead of on
 * the three-hundredth issue.
 *
 * @param {{capabilities?: {imageEmbed?: string, imageUpload?: string}|null, config?: object, vcsHost?: string, hasRestToken?: boolean}} p
 *   ONE options object — never `(caps, config)`. `hasRestToken` is injected — whether the env var
 *   named by `tracker.rest.tokenEnv` is set — so the decision stays pure.
 * @returns {{ok: boolean, strategy: string, transport: 'mcp'|'rest'|'cli'|null, forced: boolean, reason: string, auto?: string}}
 */
export function chooseStrategy(p = {}) {
  // A positional `(caps, config)` call lands the capabilities where the options object should be and
  // used to resolve to `none` silently — a whole sweep losing its screenshots with no error.
  if (p && p.capabilities === undefined && (p.imageEmbed !== undefined || p.imageUpload !== undefined)) {
    throw new Error('chooseStrategy takes one options object: chooseStrategy({ capabilities, config, hasRestToken }), not (caps, config)')
  }
  const { capabilities, config, vcsHost, hasRestToken = false } = p || {}
  const caps = capabilities || { imageEmbed: 'inline', imageUpload: 'none' }
  const embed = caps.imageEmbed || 'none'
  const upload = caps.imageUpload || 'none'
  if (!IMAGE_EMBEDS.includes(embed)) throw new Error(`chooseStrategy: unrecognised imageEmbed "${embed}" (contract §6: ${IMAGE_EMBEDS.join('|')})`)
  if (!IMAGE_UPLOADS.includes(upload)) throw new Error(`chooseStrategy: unrecognised imageUpload "${upload}" (contract §6: ${IMAGE_UPLOADS.join('|')} — cli is a transport, not an upload capability)`)
  const host = vcsHost || (config && config.vcs && config.vcs.host) || null
  // An off-enum host (`Github`, `bitbucket`) is a config bug, not a forge that cannot serve raw files:
  // described as the latter it silently resolved to `none` and a whole sweep lost its screenshots.
  if (host !== null && !VCS_HOSTS.includes(host)) throw new Error(`chooseStrategy: unrecognised vcs.host "${host}" (contract §3: ${VCS_HOSTS.join('|')})`)
  const setting = (config && config.checker && config.checker.attachStrategy) || 'auto'

  // What each route needs, and — when it is unavailable — why, in words fit for the body line.
  let transport = null
  let uploadBlocker = null
  if (upload === 'mcp') transport = 'mcp'
  else if (upload === 'rest' && hasRestToken) transport = 'rest'
  else if (upload === 'rest') uploadBlocker = 'no REST token: the env var named by tracker.rest.tokenEnv is unset'
  else uploadBlocker = `the adapter cannot upload images (imageUpload: ${upload})`
  // Only an `inline` tracker can carry an inline markdown image — which is what an assets-branch embed is.
  const embedBlocker = embed === 'none' ? 'the tracker cannot show an image (imageEmbed: none)'
    : embed !== 'inline' ? `the tracker cannot embed inline (imageEmbed: ${embed})` : null
  const hostBlocker = host === null ? UNRESOLVED_HOST
    : RAW_HOSTS.includes(host) ? null : `vcs.host ${host} cannot serve raw files for an assets branch`
  const branchBlocker = embedBlocker || hostBlocker

  const auto = () => {
    if (transport && embed === 'inline') return { ok: true, strategy: 'native-upload', transport, reason: `imageUpload ${upload} with inline embeds` }
    if (transport && embed === 'attachment') return { ok: true, strategy: 'attachment-only', transport, reason: `imageUpload ${upload}; the tracker shows images as attachments, not inline` }
    const why = uploadBlocker || embedBlocker
    if (!branchBlocker) return { ok: true, strategy: 'assets-branch', transport: 'cli', reason: `${why}; vcs.host ${host} serves raw files` }
    const reason = branchBlocker === why ? why : `${why}; ${branchBlocker}`
    // The host alone would have decided between assets-branch and none, and it is unknown: refuse, never guess.
    return { ok: branchBlocker !== UNRESOLVED_HOST, strategy: 'none', transport: null, reason }
  }

  if (setting === 'auto') return { forced: false, ...auto() }

  const want = FORCED_BY_CONFIG[setting]
  if (!want) throw new Error(`checker.attachStrategy: unrecognised value "${setting}" (expected auto|${Object.keys(FORCED_BY_CONFIG).join('|')})`)
  let blocker = null
  let forcedTransport = null
  if (want === 'native-upload') {
    blocker = uploadBlocker || embedBlocker
    forcedTransport = transport
  } else if (want === 'attachment-only') {
    blocker = uploadBlocker || (embed === 'none' ? embedBlocker : null)
    forcedTransport = transport
  } else if (want === 'assets-branch') {
    blocker = branchBlocker
    forcedTransport = 'cli'
  }
  if (blocker) {
    return { ok: false, strategy: 'none', transport: null, forced: true, reason: `checker.attachStrategy ${setting} cannot be honoured: ${blocker}`, auto: auto().strategy }
  }
  return { ok: true, strategy: want, transport: forcedTransport, forced: true, reason: `forced by checker.attachStrategy ${setting}` }
}

/** Separators and `./`/`//` normalised so `shots\a.png`, `./shots/a.png` and `shots/a.png` are one file; blank is "no shot". */
function shotKey(p) {
  const s = String(p || '').trim().replace(/\\/g, '/')
  return s ? path.posix.normalize(s) : null
}

/**
 * One upload per DISTINCT screenshot file. The first finding naming a file is its owner (created →
 * uploaded → patched); every later sibling inlines the owner's URL in its own create call.
 * @param {Array<{fid: string, screenshot?: string|null}>} findings  in filing order
 * @param {{caseInsensitive?: boolean}} [o]  true on a case-insensitive filesystem (win32) — the caller knows, this module does not probe
 * @returns {{uploads: Array<{file: string, ownerFid: string, fids: string[]}>, byFid: Record<string, {file: string|null, ownerFid: string|null, reuse: boolean}>, noShot: string[], counts: {findings: number, uploads: number, reused: number, noShot: number}}}
 */
export function reusePlan(findings, { caseInsensitive = false } = {}) {
  const uploads = []
  const byFile = new Map()
  const byFid = Object.create(null) // a fid named `constructor` must not read as a duplicate
  const noShot = []
  for (const f of findings) {
    const fid = f && f.fid
    if (!fid) throw new Error('reusePlan: every finding needs a fid')
    if (byFid[fid]) throw new Error(`reusePlan: duplicate fid "${fid}"`)
    const file = shotKey(f.screenshot)
    if (!file) {
      noShot.push(fid)
      byFid[fid] = { file: null, ownerFid: null, reuse: false }
      continue
    }
    const key = caseInsensitive ? file.toLowerCase() : file
    let u = byFile.get(key)
    if (!u) {
      u = { file, ownerFid: fid, fids: [] }
      byFile.set(key, u)
      uploads.push(u)
    }
    u.fids.push(fid)
    byFid[fid] = { file: u.file, ownerFid: u.ownerFid, reuse: u.ownerFid !== fid }
  }
  const withShot = findings.length - noShot.length
  return {
    uploads,
    byFid, // returned as built: a spread would put Object.prototype back, and `byFid.toString` for an absent fid would be a function
    noShot,
    counts: { findings: findings.length, uploads: uploads.length, reused: withShot - uploads.length, noShot: noShot.length },
  }
}

// Query parameters that sign a URL. Only these are stripped: a raw-content link carries `?raw=true`
// and must keep it, so "drop the whole query" would break every assets-branch embed.
const SIGNING_PARAMS = new Set(['signature', 'sig', 'token', 'expires', 'expiry', 'policy', 'key-pair-id'])
const SIGNING_PREFIXES = ['x-amz-', 'x-goog-']
// An Azure SAS is `sig` plus these companions (version, expiry, permissions, resource, delegation key).
// They go only ALONGSIDE `sig`: names this short cannot be claimed as signing parameters on every host.
const SAS_COMPANIONS = new Set(['sv', 'se', 'st', 'sp', 'sr', 'spr', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv'])

function paramName(pair) {
  let name = pair.split('=')[0]
  try { name = decodeURIComponent(name) } catch { /* keep the raw name */ }
  return name.toLowerCase()
}

/** The URL to STORE: signing parameters removed, everything else (including `?raw=true`) kept. */
export function bareUrl(url) {
  const s = String(url || '').trim()
  const hashAt = s.indexOf('#')
  const hash = hashAt >= 0 ? s.slice(hashAt) : ''
  const noHash = hashAt >= 0 ? s.slice(0, hashAt) : s
  const qAt = noHash.indexOf('?')
  if (qAt < 0) return s
  const pairs = noHash.slice(qAt + 1).split('&').filter(p => p !== '')
  const names = pairs.map(paramName)
  const sas = names.includes('sig')
  const kept = pairs.filter((p, i) => {
    const n = names[i]
    return !(SIGNING_PARAMS.has(n) || SIGNING_PREFIXES.some(x => n.startsWith(x)) || (sas && SAS_COMPANIONS.has(n)))
  })
  return noHash.slice(0, qAt) + (kept.length ? `?${kept.join('&')}` : '') + hash
}

const oneLine = s => String(s).replace(/\s+/g, ' ').trim()
// Markdown image syntax: a `]` in the alt or a paren/space in the url ends the token early, breaks the
// render, and then fails the very IMAGE_LINE match that counts the issue as attached.
const mdAlt = s => oneLine(s).replace(/[[\]]/g, '\\$&')
const MD_URL_ESCAPES = { ' ': '%20', '(': '%28', ')': '%29' }
const mdUrl = s => s.replace(/[ ()]/g, c => MD_URL_ESCAPES[c])
// A newline, tab or other control character is not something a URL can carry encoded — it is a
// corrupt value, and rendering it produced a token no counter recognised.
const CONTROL_CHAR = /[\x00-\x1f\x7f]/

/**
 * The body text that stands where the `![screenshot]` placeholder was. Markdown for the two inline
 * strategies, a caption sentence for `attachment-only`, and the `_No screenshot attached: <reason>_`
 * line for `none`. The URL is stored bare. A missing url or reason THROWS rather than rendering a
 * blank — a silently missing line is the failure this line exists to prevent.
 * @param {string} strategy  one of STRATEGIES
 * @param {{url?: string, alt?: string, caption?: string|null, reason?: string|null, reuse?: boolean, ownerKey?: string|null}} p
 *   `reuse` + `ownerKey` (from reusePlan) matter to `attachment-only` only: the file sits on the OWNER's
 *   issue, so a sibling's sentence must say where to look instead of claiming an attachment it has not got.
 */
export function embedFor(strategy, { url = null, alt = 'screenshot', caption = null, reason = null, reuse = false, ownerKey = null } = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`embedFor: unrecognised strategy "${strategy}" (expected ${STRATEGIES.join('|')})`)
  if (strategy === 'none') {
    if (!reason) throw new Error('embedFor: strategy none needs a reason — a bare "no screenshot" cannot be counted')
    return `${NO_SHOT_PREFIX}${oneLine(reason)}_`
  }
  if (!url) throw new Error(`embedFor: ${strategy} needs the stored url`)
  const stored = bareUrl(url)
  if (CONTROL_CHAR.test(stored)) throw new Error(`embedFor: the url ${JSON.stringify(stored)} carries a control character (newline, tab…) — not a URL a tracker can render`)
  const cap = caption ? oneLine(caption) : null
  if (strategy === 'attachment-only') {
    if (reuse && !ownerKey) throw new Error('embedFor: a reused attachment-only shot needs the ownerKey — the file is on the owner\'s issue, not this one')
    const where = reuse ? `see the attachment on ${ownerKey}` : 'attached to this issue'
    return `_Screenshot: ${oneLine(alt)} — ${where} (${stored}).${cap ? ` ${cap}` : ''}_`
  }
  return `![${mdAlt(alt)}](${mdUrl(stored)})${cap ? `\n_${cap}_` : ''}`
}

// The three attached forms, each anchored to its own line. The two image forms require a real URL —
// a prose image in the middle of a sentence or an unpatched placeholder is not an attachment. The
// caption form requires one of the two mandated phrases (`attached to this <issue|task|card>`, `see
// the attachment on <owner>`): a sentence that merely mentions an attachment (`not attached`,
// `attachment failed`) is a failure report, and counting it inflated a sweep's attached tally.
const IMAGE_LINE = /^\s*!\[(?:\\.|[^\]\\])*\]\(https?:\/\/[^)\s]+\)/m // the alt may carry the `\]` mdAlt emits
const WIKI_IMAGE_LINE = /^\s*!https?:\/\/\S+?(?:\|[^!\n]*)?!\s*$/m // Jira wiki markup: `!<url>|alt=<alt>,width=800!`
const ATTACHED_LINE = /^\s*_Screenshot: .* — (?:attached to this (?:issue|task|card)\b|see the attachment on )/m
const NO_SHOT_LINE = /^\s*_No screenshot attached:\s*(.*?)_\s*$/m
const NO_UI_LINE = /^\s*_No UI surface — (.*?)\.?_\s*$/m

/**
 * Which of the three outcomes an issue body records — or `missing`, when it records none. This is what
 * lets a report count "could not attach" separately from "nothing to show". An explicit outcome line
 * wins over an image elsewhere in the body: the line is the record, the prose is not.
 * @returns {{outcome: 'attached'|'no-screenshot'|'no-ui'|'missing', reason: string|null}}
 */
export function shotOutcome(body) {
  const text = String(body || '')
  const ns = NO_SHOT_LINE.exec(text)
  if (ns) return { outcome: 'no-screenshot', reason: ns[1].trim() }
  const nu = NO_UI_LINE.exec(text)
  if (nu) return { outcome: 'no-ui', reason: nu[1].trim() }
  if (IMAGE_LINE.test(text) || WIKI_IMAGE_LINE.test(text) || ATTACHED_LINE.test(text)) return { outcome: 'attached', reason: null }
  return { outcome: 'missing', reason: null }
}

/** The report tally: attached / noScreenshot / noUi / missing over a set of bodies. */
export function shotCounts(bodies) {
  const out = { attached: 0, noScreenshot: 0, noUi: 0, missing: 0 }
  for (const b of bodies) {
    const o = shotOutcome(b).outcome
    if (o === 'attached') out.attached++
    else if (o === 'no-screenshot') out.noScreenshot++
    else if (o === 'no-ui') out.noUi++
    else out.missing++
  }
  return out
}

// git check-ref-format, the parts a rendered template can violate.
function validRefName(name) {
  if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (/\.\.|@\{|\/\/|[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false
  return !name.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock'))
}

/**
 * The orphan branch a sweep's PNGs go to, rendered from `vcs.assetsBranchTemplate`. `{key}` renders
 * as `check-<sweepId>` so a sweep's branch can never collide with a ticket's own `assets-<KEY>` branch —
 * which holds only if the template actually consumes `{key}`; one without it names the same branch for
 * every sweep and every ticket, so it is refused. Throws on an unrendered placeholder or a name git
 * would refuse — a literal `{key}` was once pushed as a branch and every embed pointed at it. The
 * sweepId itself must be a plain directory name (manifest's rule): one carrying `/` would render a
 * valid multi-component ref and break "one branch per sweep" for any caller that skipped `plan`.
 */
export function assetsBranchName(template, sweepId) {
  if (!sweepId) throw new Error('assetsBranchName: sweepId is required')
  assertSweepId(sweepId)
  const tpl = template || 'assets-{key}'
  if (!/\{key\}/.test(tpl)) throw new Error(`assetsBranchName: vcs.assetsBranchTemplate "${tpl}" must contain {key} — without it every sweep and every ticket share one branch`)
  const name = renderTemplate(tpl, { key: `check-${sweepId}` })
  const left = /\{[a-zA-Z0-9_-]+\}/.exec(name)
  if (left) throw new Error(`assetsBranchName: "${name}" still carries the placeholder ${left[0]} — vcs.assetsBranchTemplate knows only {key}`)
  if (!validRefName(name)) throw new Error(`assetsBranchName: "${name}" is not a valid git branch name`)
  return name
}
