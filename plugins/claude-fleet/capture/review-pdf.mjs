#!/usr/bin/env node
// Render a session's scratch review page to a ONE-PAGE PDF, for attaching to the PR.
//
// ⛔ ONE PAGE, ALWAYS. A review page is a single argument — the ticket, the cause, the before/after
// pair, the caveats. Paginated, a page break lands in the middle of that pair and the reviewer reads
// half of it. So the document height is MEASURED after layout and handed to Chromium as the paper
// height: the sheet is exactly as tall as the content, however tall that is, and there is nothing
// left to break. `pageRanges: '1'` is the belt to that braces.
//
// Usage: node review-pdf.mjs --html <file> --out <file.pdf> [--width 1100] [--repo <dir>]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { loadPlaywright, findChrome, noRendererMessage } from './browser.mjs'

/** PURE. `--k v` pairs. */
export function parseArgs(argv) {
  const out = { width: 1100 }
  for (let i = 0; i < argv.length; i += 2) {
    const k = String(argv[i] || '').replace(/^--/, '')
    const v = argv[i + 1]
    if (k && v !== undefined) out[k] = k === 'width' ? Number(v) : v
  }
  return out
}

/**
 * PURE. Chromium's headless argv for a background-preserving print with no browser furniture.
 *
 * ⛔ `--no-pdf-header-footer`: without it Chrome stamps the file:// URL and a date across every
 * sheet, which on an attached review page is a full local path published to the PR.
 */
export function chromeArgs({ url, out, width, heightPx }) {
  return [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${Math.round(width)},${Math.round(heightPx)}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${out}`,
    url,
  ]
}

export async function renderPdf({ html, out, width = 1100, repo = null } = {}) {
  if (!html || !fs.existsSync(html)) throw new Error(`review-pdf: no such HTML file: ${html}`)
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  const url = pathToFileURL(path.resolve(html)).href

  let playwrightFailure = null
  const pw = await loadPlaywright(repo)
  if (pw) {
    let browser = null
    try {
      browser = await pw.chromium.launch()
      const page = await browser.newPage({ viewport: { width, height: 1200 } })
      await page.goto(url, { waitUntil: 'networkidle' })
      const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight))
      await page.pdf({ path: out, printBackground: true, width: `${width}px`, height: `${height + 2}px`, pageRanges: '1' })
      return { ok: true, via: 'playwright', out, width, height }
    } catch (e) {
      // The commonest cause is a Playwright with no chromium BUILD, which has a second route below.
      playwrightFailure = e && e.message ? e.message.split('\n')[0] : String(e)
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  }

  const bin = findChrome()
  if (bin) {
    // Chrome cannot measure the document for us, so a very tall window is the approximation; the
    // print box follows --window-size in headless, so it still emits one sheet.
    const r = spawnSync(bin, chromeArgs({ url, out, width, heightPx: 20000 }), { encoding: 'utf8', timeout: 120_000 })
    if (r.status === 0 && fs.existsSync(out)) return { ok: true, via: path.basename(bin), out, width, height: null }
    throw new Error(`review-pdf: ${path.basename(bin)} could not print ${html}: ${(r.stderr || '').trim() || `exit ${r.status}`}`)
  }

  throw new Error(`review-pdf: ${noRendererMessage({ repo, playwrightFailure })}`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const a = parseArgs(process.argv.slice(2))
  renderPdf({ html: a.html, out: a.out, width: a.width, repo: a.repo || null })
    .then(r => { console.log(JSON.stringify(r)); process.exit(0) })
    .catch(e => { console.error(e.message); process.exit(1) })
}
