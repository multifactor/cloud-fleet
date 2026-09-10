import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromeCandidates, noRendererMessage, loadPlaywright } from '../capture/browser.mjs'
import { chromeArgs as pdfArgs, parseArgs as pdfParseArgs, renderPdf } from '../capture/review-pdf.mjs'
import { chromeArgs as shotArgs, parseArgs as shotParseArgs, screenshot } from '../capture/screenshot.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-capture-'))

test('a Chrome-family browser is looked for on every platform, macOS included', () => {
  // ⛔ macOS is the platform this whole path was missing on: page.pdf() is chromium-only and a stock
  // Mac has Safari and no Chrome, so a darwin list that came back empty meant no PDF, ever.
  const mac = chromeCandidates('darwin')
  assert.ok(mac.some(p => p.includes('Google Chrome.app')), 'Chrome')
  assert.ok(mac.some(p => p.includes('Chromium.app')), 'Chromium')
  assert.ok(mac.every(p => p.startsWith('/Applications/')), 'macOS apps live in /Applications')
  assert.ok(chromeCandidates('linux').length > 0)
  assert.ok(chromeCandidates('win32', { ProgramFiles: 'C:\\PF' }).some(p => p.includes('chrome.exe')))
})

test('a machine with no renderer is told BOTH routes, and how to opt out', () => {
  // "capture failed" is the report an operator cannot act on; this one names the two fixes.
  const m = noRendererMessage({ repo: '/w/app', platform: 'darwin' })
  assert.match(m, /playwright install chromium/)
  assert.match(m, /Google Chrome/)
  assert.match(m, /only Safari/, 'the macOS reason is spelled out, not implied')
  assert.match(m, /capture\.reviewPdf false|capture\.mode none/)
  // A Playwright that IS present but broken must not be reported as "no Playwright".
  assert.match(noRendererMessage({ playwrightFailure: 'browser not installed' }), /Playwright was present but failed/)
})

test('a repo without Playwright resolves to null rather than throwing', async () => {
  assert.equal(await loadPlaywright(null), null)
  assert.equal(await loadPlaywright(tmp()), null, 'an empty directory is not a Playwright install')
})

test('the print argv never stamps the local file path across the page', () => {
  // Chrome's default header/footer prints the source URL — for a file:// review page that publishes
  // an absolute local path into an attachment on a company PR.
  const a = pdfArgs({ url: 'file:///w/x.html', out: '/w/x.pdf', width: 1100, heightPx: 3000 })
  assert.ok(a.includes('--no-pdf-header-footer'))
  assert.ok(a.includes('--headless'))
  assert.ok(a.includes('--print-to-pdf=/w/x.pdf'))
  assert.ok(a.includes('--window-size=1100,3000'))
  assert.equal(a.at(-1), 'file:///w/x.html', 'the URL is last, as Chrome wants it')
})

test('the screenshot argv carries the viewport it was asked for', () => {
  const a = shotArgs({ url: 'http://localhost:3000/', out: '/w/s.png', width: 1280, height: 800 })
  assert.ok(a.includes('--screenshot=/w/s.png'))
  assert.ok(a.includes('--window-size=1280,800'))
  assert.ok(a.includes('--hide-scrollbars'), 'a scrollbar in a before/after pair reads as a diff')
})

test('flags parse, and the defaults are the ones a session gets', () => {
  assert.deepEqual(pdfParseArgs(['--html', 'a.html', '--out', 'a.pdf']), { width: 1100, html: 'a.html', out: 'a.pdf' })
  assert.equal(pdfParseArgs(['--width', '900']).width, 900, 'width is a number, not the string "900"')
  const s = shotParseArgs(['--url', 'http://x/', '--out', 'o.png'])
  assert.equal(s.full, true, 'full-page by default: a fold-cropped shot hides the half that changed')
  assert.equal(s.width, 1280)
  assert.equal(shotParseArgs(['--full', 'false']).full, false)
  assert.equal(shotParseArgs(['--timeout', '5000']).timeout, 5000)
})

test('a missing input file is refused before any browser is launched', async () => {
  await assert.rejects(
    () => renderPdf({ html: path.join(tmp(), 'nope.html'), out: path.join(tmp(), 'o.pdf') }),
    /no such HTML file/,
  )
  await assert.rejects(() => screenshot({ out: '/w/o.png' }), /--url is required/)
  await assert.rejects(() => screenshot({ url: 'http://x/' }), /--out is required/)
})
