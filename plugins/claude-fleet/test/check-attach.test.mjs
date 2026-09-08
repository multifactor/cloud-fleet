import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from './helpers/prose.mjs'
import {
  chooseStrategy, reusePlan, bareUrl, embedFor, shotOutcome, shotCounts, assetsBranchName,
  STRATEGIES, FORCED_BY_CONFIG, IMAGE_EMBEDS, IMAGE_UPLOADS, SCREENSHOT_PLACEHOLDER,
} from '../src/check/attach.mjs'
import { renderIssueBody } from '../src/check/findings.mjs'
import { listAdapters, loadAdapter } from '../src/trackers/registry.mjs'
import { SCHEMA } from '../src/config/schema.mjs'
import { defaultsFor, setPath } from '../src/config/defaults.mjs'

const BUNDLED = path.join(ROOT, 'trackers')

function cfg(over = {}) {
  const c = defaultsFor()
  for (const [k, v] of Object.entries(over)) setPath(c, k, v)
  return c
}
const caps = (imageUpload, imageEmbed) => ({ imageUpload, imageEmbed })

// ---- chooseStrategy: auto ----------------------------------------------------------------------

test('auto: a connector upload with inline embeds is native-upload over mcp', () => {
  const r = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg(), vcsHost: 'other' })
  assert.deepEqual([r.ok, r.strategy, r.transport, r.forced], [true, 'native-upload', 'mcp', false])
})

// A REST upload is only a route when the token is actually present; without it the code host takes
// over, and the reason must NAME the missing token so the operator fixes the env rather than the adapter.
test('auto: a REST upload needs the token — without it the choice falls to the code host, and says why', () => {
  const withToken = chooseStrategy({ capabilities: caps('rest', 'inline'), config: cfg(), vcsHost: 'github', hasRestToken: true })
  assert.deepEqual([withToken.strategy, withToken.transport], ['native-upload', 'rest'])
  const noToken = chooseStrategy({ capabilities: caps('rest', 'inline'), config: cfg(), vcsHost: 'github', hasRestToken: false })
  assert.deepEqual([noToken.strategy, noToken.transport], ['assets-branch', 'cli'])
  assert.match(noToken.reason, /tracker\.rest\.tokenEnv/)
  // a tracker that shows images only as attachments gets the caption strategy, not an inline embed
  const att = chooseStrategy({ capabilities: caps('rest', 'attachment'), config: cfg(), vcsHost: 'other', hasRestToken: true })
  assert.deepEqual([att.strategy, att.transport], ['attachment-only', 'rest'])
})

// The code host has no upload API at all; the assets branch is the only route, and it exists only on
// a forge that serves raw files.
test('auto: no upload API → assets-branch on github/gitlab, none elsewhere — with both blockers named', () => {
  const gh = chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg(), vcsHost: 'github' })
  assert.deepEqual([gh.strategy, gh.transport], ['assets-branch', 'cli'])
  const gl = chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg(), vcsHost: 'gitlab' })
  assert.equal(gl.strategy, 'assets-branch')
  const none = chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg(), vcsHost: 'other' })
  assert.deepEqual([none.ok, none.strategy, none.transport], [true, 'none', null])
  assert.match(none.reason, /imageUpload: none/)
  assert.match(none.reason, /vcs\.host other/)
  // tracker-less: no adapter at all still gets the assets branch when the host can serve it
  assert.equal(chooseStrategy({ capabilities: null, config: cfg(), vcsHost: 'github' }).strategy, 'assets-branch')
  // vcs.host is read from the config when not injected
  assert.equal(chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg({ 'vcs.host': 'github' }) }).strategy, 'assets-branch')
})

// An assets-branch embed IS an inline markdown image. Handing one to a tracker whose adapter says it
// cannot render an image (or renders images only as attachments) is a self-contradicting decision —
// the body carries a `![…](…)` the tracker shows as literal text.
test('auto: the assets branch needs imageEmbed inline — a tracker that cannot show an inline image gets none, not markdown', () => {
  const blind = chooseStrategy({ capabilities: caps('mcp', 'none'), config: cfg(), vcsHost: 'github' })
  assert.deepEqual([blind.ok, blind.strategy, blind.transport], [true, 'none', null])
  assert.match(blind.reason, /imageEmbed: none/)
  assert.doesNotMatch(blind.reason, /serves raw files/)
  // an attachment-only tracker without its REST token: an inline image in a plain-text notes field is no route either
  const notes = chooseStrategy({ capabilities: caps('rest', 'attachment'), config: cfg(), vcsHost: 'github', hasRestToken: false })
  assert.equal(notes.strategy, 'none')
  assert.match(notes.reason, /tracker\.rest\.tokenEnv/)
  assert.match(notes.reason, /imageEmbed: attachment/)
})

// `vcs.host` is derived from the origin at resolve time and defaults to null in the schema; an
// underived config must not silently read as `other` and turn a GitHub repo's sweep into `none`.
test('auto: an unresolved vcs.host is refused when it would decide the route — never defaulted to "other"', () => {
  const underived = cfg()
  assert.equal(underived.vcs.host, null)
  const r = chooseStrategy({ capabilities: caps('none', 'inline'), config: underived })
  assert.deepEqual([r.ok, r.strategy, r.transport], [false, 'none', null])
  assert.match(r.reason, /vcs\.host is unresolved/)
  assert.doesNotMatch(r.reason, /vcs\.host other/)
  // a route that never touches the code host does not need it
  const native = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: underived })
  assert.deepEqual([native.ok, native.strategy], [true, 'native-upload'])
  // nor does a tracker that could not carry the assets branch whatever the host is
  const none = chooseStrategy({ capabilities: caps('none', 'none'), config: underived })
  assert.deepEqual([none.ok, none.strategy], [true, 'none'])
  // a forced assets branch on an unresolved host is a refusal with the same reason
  const forced = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'assets-branch' }) })
  assert.equal(forced.ok, false)
  assert.match(forced.reason, /vcs\.host is unresolved/)
})

// `vcs.host` is a schema enum (contract §3: github|gitlab|other). A casing typo or an unknown forge is
// a config bug; described as "cannot serve raw files" it silently became a sweep with no screenshots.
test('an off-enum vcs.host is rejected, not described as a forge that cannot serve raw files', () => {
  for (const host of ['Github', 'bitbucket', 'GITLAB']) {
    assert.throws(() => chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg(), vcsHost: host }), /unrecognised vcs\.host/, host)
    assert.throws(() => chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg({ 'vcs.host': host }) }), /unrecognised vcs\.host/, host)
  }
  // …even on a route that would never have read it: the config is wrong either way
  assert.throws(() => chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg(), vcsHost: 'bitbucket' }), /unrecognised vcs\.host "bitbucket"/)
  assert.equal(chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg(), vcsHost: 'other' }).strategy, 'none')
})

// The adapters describe the call as `attach.chooseStrategy(caps, config)`; called that way the
// capabilities land where the options object should be and the result used to be a silent `none`.
test('chooseStrategy takes one options object — a positional (caps, config) call throws instead of resolving to none', () => {
  assert.throws(() => chooseStrategy(caps('mcp', 'inline'), cfg({ 'vcs.host': 'github' })), /one options object/)
})

// Contract §6: `imageEmbed: inline|attachment|none`, `imageUpload: mcp|rest|none`. `cli` is a TRANSPORT
// (§6's op-22 `Transport:` line), never an upload capability — the chooser must reject it rather than
// describe it as "cannot upload", whatever the registry's own enum happens to carry.
test('the capability vocabularies are contract §6\'s — an off-contract value is rejected, not described', () => {
  assert.deepEqual([...IMAGE_EMBEDS], ['inline', 'attachment', 'none'])
  assert.deepEqual([...IMAGE_UPLOADS], ['mcp', 'rest', 'none'])
  assert.throws(() => chooseStrategy({ capabilities: caps('cli', 'inline'), config: cfg(), vcsHost: 'github' }), /unrecognised imageUpload "cli"/)
  assert.throws(() => chooseStrategy({ capabilities: caps('mcp', 'cover'), config: cfg(), vcsHost: 'github' }), /unrecognised imageEmbed "cover"/)
})

// Every strategy the chooser can emit must be one the adapter validator accepts on an op-22
// `Strategy:` line — the two vocabularies drifting is how a manifest records a route no adapter documents.
test('every chosen strategy is in the adapter validator\'s vocabulary', () => {
  assert.deepEqual([...STRATEGIES], ['native-upload', 'assets-branch', 'attachment-only', 'none'])
  const combos = []
  for (const up of IMAGE_UPLOADS) for (const em of IMAGE_EMBEDS) for (const host of ['github', 'other']) for (const tok of [true, false]) combos.push({ up, em, host, tok })
  for (const { up, em, host, tok } of combos) {
    const r = chooseStrategy({ capabilities: caps(up, em), config: cfg(), vcsHost: host, hasRestToken: tok })
    assert.ok(STRATEGIES.includes(r.strategy), `${up}/${em}/${host}/${tok} → ${r.strategy}`)
    assert.equal(r.ok, true, `${up}/${em}/${host}/${tok}: auto with a resolved host never refuses`)
    assert.ok(r.reason.length > 0)
  }
  for (const v of Object.values(FORCED_BY_CONFIG)) assert.ok(STRATEGIES.includes(v))
})

// The config validator accepts exactly the values the chooser can honour; a value the schema gained
// that the table does not know would throw `unrecognised value` at plan time on a validated config.
test('the checker.attachStrategy schema enum and the chooser\'s forced table are one vocabulary', () => {
  const e = SCHEMA.find(x => x.key === 'checker.attachStrategy')
  assert.ok(e, 'schema has checker.attachStrategy')
  assert.deepEqual(e.enum, ['auto', ...Object.keys(FORCED_BY_CONFIG)])
})

// The bundled adapters each declare their strategy and transport by hand on the op-22 section; the
// chooser must reach the same answer from the front matter, or the playbook's "strategy the manifest
// records" and the adapter's own Call: line disagree.
const STRATEGY_LINE = /Strategy:?\**\s*`?([a-z-]+)/i // the registry's own op-22 regex (not exported; keep in step)
const TRANSPORT_LINE = /^Transport:\**\s*`?([a-z]+)/im

test('the chooser agrees with every bundled adapter\'s op-22 Strategy: and Transport: lines', () => {
  const ids = listAdapters({ bundledDir: BUNDLED })
  assert.ok(ids.length >= 5)
  for (const id of ids) {
    const a = loadAdapter(id, { bundledDir: BUNDLED })
    assert.ok(a.sections[22], `${id}: no op-22 section`)
    const declared = STRATEGY_LINE.exec(a.sections[22].text)
    assert.ok(declared, `${id}: op-22 has no Strategy: line`)
    const host = a.front.capabilities.imageUpload === 'none' ? 'github' : 'other'
    const r = chooseStrategy({ capabilities: a.front.capabilities, config: cfg(), vcsHost: host, hasRestToken: true })
    assert.equal(r.strategy, declared[1], `${id}: chooser says ${r.strategy}, adapter declares ${declared[1]}`)
    if (r.strategy !== 'none') {
      const transport = TRANSPORT_LINE.exec(a.sections[22].text)
      assert.ok(transport, `${id}: strategy ${r.strategy} but op-22 has no Transport: line`)
      assert.equal(r.transport, transport[1], `${id}: chooser says transport ${r.transport}, adapter declares ${transport[1]}`)
    }
  }
})

// ---- chooseStrategy: forced --------------------------------------------------------------------

// A forced route the adapter cannot carry is REFUSED, not swapped: silently substituting the auto
// route makes the config lie, and the refusal at plan time is caught before the first tracker write.
test('a forced strategy the capabilities cannot support is refused with the reason, never swapped', () => {
  const native = chooseStrategy({ capabilities: caps('none', 'inline'), config: cfg({ 'checker.attachStrategy': 'native' }), vcsHost: 'github' })
  assert.deepEqual([native.ok, native.strategy, native.forced], [false, 'none', true])
  assert.match(native.reason, /checker\.attachStrategy native cannot be honoured: the adapter cannot upload images/)
  assert.equal(native.auto, 'assets-branch')
  // native also needs an inline embed — an attachment-only tracker cannot render it
  const inlineless = chooseStrategy({ capabilities: caps('rest', 'attachment'), config: cfg({ 'checker.attachStrategy': 'native' }), vcsHost: 'other', hasRestToken: true })
  assert.equal(inlineless.ok, false)
  assert.match(inlineless.reason, /imageEmbed: attachment/)
  // a REST route without its token is refused for the same reason auto avoids it
  const tokenless = chooseStrategy({ capabilities: caps('rest', 'inline'), config: cfg({ 'checker.attachStrategy': 'attachment' }), vcsHost: 'github', hasRestToken: false })
  assert.equal(tokenless.ok, false)
  assert.match(tokenless.reason, /tracker\.rest\.tokenEnv/)
  // the assets branch needs a forge that serves raw files
  const branch = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'assets-branch' }), vcsHost: 'other' })
  assert.equal(branch.ok, false)
  assert.match(branch.reason, /vcs\.host other/)
  assert.equal(branch.auto, 'native-upload')
  // …and a tracker that can show an inline image: forcing the branch onto one that cannot is refused too
  const blind = chooseStrategy({ capabilities: caps('mcp', 'none'), config: cfg({ 'checker.attachStrategy': 'assets-branch' }), vcsHost: 'github' })
  assert.deepEqual([blind.ok, blind.strategy], [false, 'none'])
  assert.match(blind.reason, /checker\.attachStrategy assets-branch cannot be honoured: .*imageEmbed: none/)
  const notes = chooseStrategy({ capabilities: caps('rest', 'attachment'), config: cfg({ 'checker.attachStrategy': 'assets-branch' }), vcsHost: 'github', hasRestToken: true })
  assert.equal(notes.ok, false)
  assert.match(notes.reason, /imageEmbed: attachment/)
})

test('a forced strategy the capabilities support is honoured — including a deliberate downgrade', () => {
  const branch = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'assets-branch' }), vcsHost: 'github' })
  assert.deepEqual([branch.ok, branch.strategy, branch.transport, branch.forced], [true, 'assets-branch', 'cli', true])
  assert.match(branch.reason, /forced by checker\.attachStrategy assets-branch/)
  // attachment-only on an inline-capable tracker is a legitimate choice (no inline image wanted)
  const att = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'attachment' }), vcsHost: 'other' })
  assert.deepEqual([att.ok, att.strategy, att.transport], [true, 'attachment-only', 'mcp'])
  // none is always honourable, and carries the reason the body line will show
  const none = chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'none' }), vcsHost: 'github' })
  assert.deepEqual([none.ok, none.strategy, none.transport], [true, 'none', null])
  assert.match(none.reason, /checker\.attachStrategy none/)
  assert.throws(() => chooseStrategy({ capabilities: caps('mcp', 'inline'), config: cfg({ 'checker.attachStrategy': 'inline' }) }), /unrecognised value "inline"/)
})

// ---- reusePlan ---------------------------------------------------------------------------------

// Per-issue uploads once multiplied filing cost by the findings-per-PR ratio; the plan is one upload
// per distinct FILE, the first finding owning it and every sibling inlining the same URL.
test('reusePlan: one upload per distinct screenshot file; siblings point at the owner', () => {
  const findings = [
    { fid: 'a01|1240|1', screenshot: 'shots/a01-1240-1.png' },
    { fid: 'a01|1240|2', screenshot: 'shots/a01-1240-1.png' },   // same screen as 1
    { fid: 'a01|1240|3', screenshot: 'shots/a01-1240-3.png' },
    { fid: 'a01|1240|4', screenshot: 'shots\\a01-1240-1.png' },  // same file, spelled with backslashes
    { fid: 'a01|1240|5', screenshot: null },                      // no shot — never uploaded
    { fid: 'a01|1240|6', screenshot: './shots/a01-1240-1.png' }, // same file, spelled from the cwd
  ]
  const plan = reusePlan(findings)
  assert.equal(plan.uploads.length, 2)
  assert.deepEqual(plan.uploads[0], { file: 'shots/a01-1240-1.png', ownerFid: 'a01|1240|1', fids: ['a01|1240|1', 'a01|1240|2', 'a01|1240|4', 'a01|1240|6'] })
  assert.deepEqual(plan.uploads[1], { file: 'shots/a01-1240-3.png', ownerFid: 'a01|1240|3', fids: ['a01|1240|3'] })
  assert.deepEqual(plan.byFid['a01|1240|2'], { file: 'shots/a01-1240-1.png', ownerFid: 'a01|1240|1', reuse: true })
  assert.deepEqual(plan.byFid['a01|1240|1'], { file: 'shots/a01-1240-1.png', ownerFid: 'a01|1240|1', reuse: false })
  assert.deepEqual(plan.byFid['a01|1240|5'], { file: null, ownerFid: null, reuse: false })
  assert.deepEqual(plan.byFid['a01|1240|6'], { file: 'shots/a01-1240-1.png', ownerFid: 'a01|1240|1', reuse: true })
  assert.deepEqual(plan.noShot, ['a01|1240|5'])
  assert.deepEqual(plan.counts, { findings: 6, uploads: 2, reused: 3, noShot: 1 })
  // the three counts partition the findings — the tally a report prints must add up
  assert.equal(plan.counts.uploads + plan.counts.reused + plan.counts.noShot, plan.counts.findings)
  // every sibling of an upload resolves to the SAME url once the owner's upload returns one
  const urlByFile = { 'shots/a01-1240-1.png': 'https://assets.example/one.png' }
  const urls = new Set(plan.uploads[0].fids.map(fid => urlByFile[plan.byFid[fid].file]))
  assert.deepEqual([...urls], ['https://assets.example/one.png'])
  assert.throws(() => reusePlan([{ fid: 'x|1|1' }, { fid: 'x|1|1' }]), /duplicate fid/)
  assert.throws(() => reusePlan([{ screenshot: 'a.png' }]), /needs a fid/)
})

// `shots/A.png` and `shots/a.png` are one file on Windows and two on Linux; the caller says which. And
// the duplicate check must see only fids, not Object.prototype — a fid spelled like a builtin is not a repeat.
test('reusePlan: case-insensitive dedupe is opt-in, and a fid named like an Object key is not a duplicate', () => {
  const two = [{ fid: 'x|1|1', screenshot: 'shots/A.png' }, { fid: 'x|1|2', screenshot: 'shots/a.png' }]
  assert.equal(reusePlan(two).counts.uploads, 2)
  const win = reusePlan(two, { caseInsensitive: true })
  assert.equal(win.counts.uploads, 1)
  assert.equal(win.uploads[0].file, 'shots/A.png') // the owner's spelling is the one uploaded
  assert.deepEqual(win.byFid['x|1|2'], { file: 'shots/A.png', ownerFid: 'x|1|1', reuse: true })
  for (const fid of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const plan = reusePlan([{ fid, screenshot: 'a.png' }])
    assert.equal(plan.counts.uploads, 1, fid)
    assert.deepEqual(plan.byFid[fid], { file: 'a.png', ownerFid: fid, reuse: false })
  }
  // …and the returned map must stay prototype-free: an ABSENT fid spelled like a builtin reads as
  // absent, not as Object.prototype's function — `if (plan.byFid[fid])` is how a caller asks.
  const absent = reusePlan(two).byFid
  for (const fid of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) assert.equal(absent[fid], undefined, fid)
  assert.equal(Object.getPrototypeOf(absent), null)
})

// ---- bareUrl -----------------------------------------------------------------------------------

// One tracker re-signs on read, so the stored URL is the bare one — but "drop the query" would also
// drop `?raw=true`, which every assets-branch link needs. Only signing parameters go.
test('bareUrl strips signing parameters and keeps everything else, including ?raw=true', () => {
  assert.equal(bareUrl('https://assets.example/x.png?signature=abc123'), 'https://assets.example/x.png')
  assert.equal(bareUrl('https://assets.example/x.png?token=t&Expires=1&X-Amz-Signature=s&X-Amz-Credential=c'), 'https://assets.example/x.png')
  assert.equal(bareUrl('https://github.com/acme/app/blob/assets-check-ABC-1234/x.png?raw=true'), 'https://github.com/acme/app/blob/assets-check-ABC-1234/x.png?raw=true')
  assert.equal(bareUrl('https://assets.example/x.png?raw=true&signature=abc'), 'https://assets.example/x.png?raw=true')
  assert.equal(bareUrl('https://assets.example/x.png?sig=abc#frag'), 'https://assets.example/x.png#frag')
  assert.equal(bareUrl('https://assets.example/x.png'), 'https://assets.example/x.png')
  assert.equal(bareUrl(''), '')
  // an Azure SAS: `sig` takes its companions (version, expiry, permissions, resource) with it…
  assert.equal(bareUrl('https://blob.example/x.png?sv=2020-08-04&se=2026-03-14&sp=r&sr=b&sig=abc'), 'https://blob.example/x.png')
  assert.equal(bareUrl('https://blob.example/x.png?sp=r&raw=true&sig=abc&skoid=k&sktid=t'), 'https://blob.example/x.png?raw=true')
  // …but only alongside `sig` — names that short are ordinary parameters on any other host
  assert.equal(bareUrl('https://assets.example/x.png?sp=1&se=2'), 'https://assets.example/x.png?sp=1&se=2')
})

// ---- embedFor ----------------------------------------------------------------------------------

test('embedFor renders markdown for the inline strategies and stores the BARE url', () => {
  assert.equal(embedFor('native-upload', { url: 'https://assets.example/x.png?signature=abc' }), '![screenshot](https://assets.example/x.png)')
  assert.equal(
    embedFor('assets-branch', { url: 'https://github.com/acme/app/blob/assets-check-ABC-1234/x.png?raw=true', alt: 'the list', caption: 'Area affected (context, not a repro): the list.' }),
    '![the list](https://github.com/acme/app/blob/assets-check-ABC-1234/x.png?raw=true)\n_Area affected (context, not a repro): the list._',
  )
})

// A `]` in the alt or a paren/space in the url ends the image token early: the render breaks AND the
// issue is later counted `missing` because the line no longer parses as an image. A control character
// in the url is not a URL at all — nothing to encode, so the renderer refuses it.
test('embedFor escapes what would break the markdown image token, and refuses a url that is not one', () => {
  const s = embedFor('native-upload', { url: 'https://assets.example/a b).png', alt: 'list [open] state' })
  assert.equal(s, '![list \\[open\\] state](https://assets.example/a%20b%29.png)')
  assert.equal(shotOutcome(s).outcome, 'attached')
  const parens = embedFor('assets-branch', { url: 'https://github.com/acme/app/blob/assets-check-ABC-1234/list (open).png?raw=true' })
  assert.equal(parens, '![screenshot](https://github.com/acme/app/blob/assets-check-ABC-1234/list%20%28open%29.png?raw=true)')
  assert.equal(shotOutcome(parens).outcome, 'attached')
  for (const bad of ['https://x.example/a\n.png', 'https://x.example/a\t.png', 'https://x.example/a\r\n.png', 'https://x.example/a\x00.png']) {
    assert.throws(() => embedFor('native-upload', { url: bad }), /control character/)
    assert.throws(() => embedFor('attachment-only', { url: bad }), /control character/)
  }
  // outer whitespace is trimmed by bareUrl and is not a refusal
  assert.equal(embedFor('native-upload', { url: '  https://x.example/a.png\n' }), '![screenshot](https://x.example/a.png)')
})

test('embedFor renders a caption sentence, never an image, for attachment-only', () => {
  const s = embedFor('attachment-only', { url: 'https://files.example/one.png?token=t', alt: 'the list', caption: 'Area affected (context, not a repro): the list.' })
  assert.equal(s, '_Screenshot: the list — attached to this issue (https://files.example/one.png). Area affected (context, not a repro): the list._')
  assert.ok(!/!\[/.test(s))
  assert.equal(shotOutcome(s).outcome, 'attached')
})

// For a sibling that reusePlan marks `reuse`, the file sits on the OWNER's issue; "attached to this
// issue" would be false, so the sentence says where to look. This is the CLI's own wording — each
// attachment-only adapter mandates its own sentence on its op-22 Call: line (see the divergence test
// below); what the two forms share is the anchor phrase shotOutcome() keys on.
test('embedFor: a sibling that reuses an attachment-only shot points at the owner, never claims "attached to this issue"', () => {
  const s = embedFor('attachment-only', { url: 'https://files.example/one.png?token=t', alt: 'the list', caption: 'Area affected (context, not a repro): the list.', reuse: true, ownerKey: 'ABC-1234' })
  assert.equal(s, '_Screenshot: the list — see the attachment on ABC-1234 (https://files.example/one.png). Area affected (context, not a repro): the list._')
  assert.doesNotMatch(s, /attached to this issue/)
  assert.equal(shotOutcome(s).outcome, 'attached')
  assert.throws(() => embedFor('attachment-only', { url: 'https://files.example/one.png', reuse: true }), /needs the ownerKey/)
  // the inline strategies inline the same url whoever owns the upload
  assert.equal(embedFor('native-upload', { url: 'https://assets.example/x.png', reuse: true, ownerKey: 'ABC-1234' }), '![screenshot](https://assets.example/x.png)')
})

// embedFor's attachment-only sentence is NOT the adapters' — asana says "attached to this task as
// <name>", trello "attached to this card and shown as its cover", and their sibling forms differ too.
// A CLI-rendered body and an adapter-rendered body therefore disagree in wording; what must hold is
// that every mandated shape (read from the Call: line, not retyped here) AND the CLI's own are counted
// `attached` by the same anchored rule — the counter is the only place the forms have to agree.
test('embedFor diverges from the attachment-only adapters\' mandated sentences, but every form counts as attached', () => {
  const fill = tpl => tpl
    .replace(/<alt>/g, 'the list').replace(/<caption>/g, 'Area affected (context, not a repro): the list.')
    .replace(/<name>/g, 'one.png').replace(/<first key>/g, 'ABC-1234').replace(/<[a-z_]*url>/g, 'https://files.example/one.png')
  const cli = {
    owner: embedFor('attachment-only', { url: 'https://files.example/one.png', alt: 'the list', caption: 'Area affected (context, not a repro): the list.' }),
    sibling: embedFor('attachment-only', { url: 'https://files.example/one.png', alt: 'the list', caption: 'Area affected (context, not a repro): the list.', reuse: true, ownerKey: 'ABC-1234' }),
  }
  const seen = []
  for (const id of listAdapters({ bundledDir: BUNDLED })) {
    const a = loadAdapter(id, { bundledDir: BUNDLED })
    if (a.front.capabilities.imageEmbed !== 'attachment') continue
    seen.push(id)
    const embeds = [...a.sections[22].text.matchAll(/embed = "([^"]+)"/g)].map(m => fill(m[1]))
    assert.equal(embeds.length, 2, `${id}: op-22 Call: mandates an owner embed and a sibling embed`)
    for (const e of embeds) {
      assert.match(e, /^_Screenshot: /, `${id}: ${e}`)
      assert.equal(shotOutcome(e).outcome, 'attached', `${id}: ${e}`)
      assert.notEqual(e, cli.owner, `${id}: the adapter's sentence is its own, not embedFor's`)
      assert.notEqual(e, cli.sibling, `${id}: the adapter's sentence is its own, not embedFor's`)
    }
  }
  assert.deepEqual(seen, ['asana', 'trello'])
})

// A blank where the line should be is the failure the line exists to prevent, so the renderer throws
// instead of producing one.
test('embedFor never renders a silently missing line: none needs a reason, the rest need a url', () => {
  assert.equal(embedFor('none', { reason: 'no capture slot' }), '_No screenshot attached: no capture slot_')
  assert.equal(embedFor('none', { reason: 'repair failed:\n  the dev server never came up' }), '_No screenshot attached: repair failed: the dev server never came up_')
  assert.throws(() => embedFor('none', {}), /needs a reason/)
  assert.throws(() => embedFor('native-upload', {}), /needs the stored url/)
  assert.throws(() => embedFor('attachment-only', { caption: 'c' }), /needs the stored url/)
  assert.throws(() => embedFor('inline', { url: 'https://x' }), /unrecognised strategy/)
})

// ---- shotOutcome -------------------------------------------------------------------------------

// "Could not attach" and "nothing to show" are different outcomes; the report counts them apart, and
// a body with neither is `missing` — the fifteen-issues-with-no-image failure made countable.
test('the no-screenshot line is distinct from the no-UI line, and a body with neither is "missing"', () => {
  const noShot = embedFor('none', { reason: 'capture disabled' })
  const noUi = renderIssueBody({ prs: ['1240'], whatThePrDoes: 'x', edgeCase: 'y', priority: 4, why: 'z', sweepId: 'ABC-1234', noUiReason: 'pure infrastructure' })
  assert.notEqual(noShot, noUi)
  assert.deepEqual(shotOutcome(noShot), { outcome: 'no-screenshot', reason: 'capture disabled' })
  assert.deepEqual(shotOutcome(noUi), { outcome: 'no-ui', reason: 'pure infrastructure' })
  const withShot = renderIssueBody({ prs: ['1240'], whatThePrDoes: 'x', edgeCase: 'y', priority: 4, why: 'z', sweepId: 'ABC-1234', screenshot: 'https://assets.example/x.png' })
  assert.equal(shotOutcome(withShot).outcome, 'attached')
  assert.deepEqual(shotOutcome('**PR:** #1240\n**Edge case:** y'), { outcome: 'missing', reason: null })
  assert.deepEqual(shotCounts([noShot, noShot, noUi, withShot, 'nothing here']), { attached: 1, noScreenshot: 2, noUi: 1, missing: 1 })
})

// Each bundled adapter's op-22 Call: line fixes an embed shape; a shape the counter does not know
// reports a whole native-upload sweep as 0 attached.
test('shotOutcome recognises every attached form the bundled adapters mandate', () => {
  // asana.md op-22 — the owner's sentence and the sibling's
  assert.equal(shotOutcome('_Screenshot: the list — attached to this task as one.png. Area affected (context, not a repro): the list._').outcome, 'attached')
  assert.equal(shotOutcome('_Screenshot: the list — see the attachment on task ABC-1234 (https://files.example/one.png). Area affected (context, not a repro): the list._').outcome, 'attached')
  // trello.md op-22 — the owner's sentence and the sibling's
  assert.equal(shotOutcome('_Screenshot: the list — attached to this card and shown as its cover. Area affected (context, not a repro): the list._').outcome, 'attached')
  assert.equal(shotOutcome('_Screenshot: the list — see the attachment on card `ABC-1234`. Area affected (context, not a repro): the list._').outcome, 'attached')
  // jira.md op-22 — the wiki-markup (REST v2) embed, with and without the alt/width options
  assert.equal(shotOutcome('**PR:** #1240\n\n!https://files.example/one.png|alt=the list,width=800!\n_Area affected (context, not a repro): the list._').outcome, 'attached')
  assert.equal(shotOutcome('!https://files.example/one.png!').outcome, 'attached')
  // linear.md / github.md — the markdown image on its own line
  assert.equal(shotOutcome('**Gate:** pending (ABC-1234)\n\n![the list](https://github.com/acme/app/blob/assets-check-ABC-1234/x.png?raw=true)').outcome, 'attached')
})

// The caption form is anchored to the two mandated phrases. A `_Screenshot: …_` line that merely
// mentions an attachment is a failure report; counting it as attached once inflated a sweep's tally.
test('shotOutcome: a Screenshot line that only mentions an attachment is not an attachment', () => {
  for (const line of [
    '_Screenshot: the list — not attached, rate-limited_',
    '_Screenshot: attachment failed (429)_',
    '_Screenshot: the list — attachment failed (429)_',
    '_Screenshot: the list — attached nowhere; see the failure above_',
    '_Screenshot: the list — the attachment on ABC-1234 was deleted_',
    'the shot is attached to this issue as a comment', // not the Screenshot line
  ]) assert.equal(shotOutcome(`**PR:** #1240\n${line}`).outcome, 'missing', line)
  // the line must stand on its own — a phrase quoted in the edge-case prose is not the record
  assert.equal(shotOutcome('**Edge case:** the body reads "_Screenshot: x — attached to this issue (https://x.example/a.png)._"').outcome, 'missing')
})

// An image mentioned in the prose of the edge case is not the screenshot line, and the op-13
// placeholder an op-15 never replaced is exactly the "no image, nobody could tell" case.
test('shotOutcome: an explicit outcome line wins over a prose image, and a placeholder is not an attachment', () => {
  const prose = '**Edge case:** the icon ![x](https://x.example/i.png) breaks\n_No screenshot attached: no capture slot_'
  assert.deepEqual(shotOutcome(prose), { outcome: 'no-screenshot', reason: 'no capture slot' })
  assert.equal(shotOutcome('**Edge case:** the icon ![x](https://x.example/i.png) breaks\n_No UI surface — pure infrastructure._').outcome, 'no-ui')
  assert.equal(shotOutcome('**Edge case:** the icon ![x](https://x.example/i.png) breaks').outcome, 'missing')
  assert.equal(SCREENSHOT_PLACEHOLDER, '![screenshot]')
  assert.equal(shotOutcome(`**PR:** #1240\n\n${SCREENSHOT_PLACEHOLDER}`).outcome, 'missing')
  assert.equal(shotOutcome('**PR:** #1240\n\n![screenshot](pending)').outcome, 'missing')
  // a local path never reached the tracker — only a URL is an attachment
  assert.equal(shotOutcome('![screenshot](shots/a01-1240-1.png)').outcome, 'missing')
})

// The placeholder is ONE literal: the worker writes what the playbook and the brief name, and an op-15
// edit whose `find` is this constant must match it — a second spelling silently no-ops the patch and
// the issue stays `missing`.
test('SCREENSHOT_PLACEHOLDER is the literal the check playbook and the brief name', () => {
  const quoted = `\`${SCREENSHOT_PLACEHOLDER}\``
  const playbook = fs.readFileSync(path.join(ROOT, 'playbooks', 'check.md'), 'utf8')
  assert.ok(playbook.includes(`placeholder ${quoted}`), `playbooks/check.md §7.5 names the placeholder ${quoted}`)
  const brief = fs.readFileSync(path.join(ROOT, 'src', 'check', 'brief.mjs'), 'utf8')
  assert.ok(brief.includes(`${quoted} placeholder`), `src/check/brief.mjs names the placeholder ${quoted}`)
})

// ---- assetsBranchName ----------------------------------------------------------------------------

// The default template's `{key}` renders as `check-<sweepId>`, so a sweep's PNGs can never land on the
// branch a ticket's own before/after shots use — which holds only if the template consumes `{key}`; a
// template that rendered nothing throws instead of pushing a literal `{key}`.
test('assetsBranchName renders the sweep branch and refuses an unrendered, keyless or invalid name', () => {
  assert.equal(assetsBranchName('assets-{key}', 'ABC-1234'), 'assets-check-ABC-1234')
  assert.equal(assetsBranchName('assets-{key}', 'prs-1a2b3c4d'), 'assets-check-prs-1a2b3c4d')
  assert.equal(assetsBranchName(undefined, 'file-9f8e7d6c'), 'assets-check-file-9f8e7d6c')
  assert.equal(assetsBranchName('shots/{key}', 'ABC-1234'), 'shots/check-ABC-1234')
  assert.throws(() => assetsBranchName('assets-{key}-{sweepId}', 'ABC-1234'), /still carries the placeholder \{sweepId\}/)
  // no {key} = one constant branch for every sweep AND every ticket, the collision the key exists to prevent
  assert.throws(() => assetsBranchName('assets', 'ABC-1234'), /must contain \{key\}/)
  assert.throws(() => assetsBranchName('assets-{sweepId}', 'ABC-1234'), /must contain \{key\}/)
  assert.throws(() => assetsBranchName('assets {key}', 'ABC-1234'), /not a valid git branch name/)
  assert.throws(() => assetsBranchName('assets-{key}..old', 'ABC-1234'), /not a valid git branch name/)
  assert.throws(() => assetsBranchName('assets-{key}', ''), /sweepId is required/)
  // a sweepId with a separator renders a VALID multi-component ref — so it is the sweepId, not the
  // rendered name, that is refused (the manifest's rule, applied here for callers that skip plan)
  assert.throws(() => assetsBranchName('assets-{key}', 'prs/abc'), /must be a plain directory name/)
  assert.throws(() => assetsBranchName('assets-{key}', '../ABC-1234'), /must be a plain directory name/)
})
