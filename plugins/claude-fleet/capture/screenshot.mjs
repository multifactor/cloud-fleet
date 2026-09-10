#!/usr/bin/env node
// The bundled capture runner: one URL in, one PNG out.
//
// It exists so a repo gets screenshots WITHOUT writing a runner first. `capture.mode` defaults to
// `local`, so a fleet has always believed it captures — while `capture.runner` defaulted to null and
// nothing shipped to fill it, which is how every review page came out reading "No screenshots." with
// no error anywhere to explain it.
//
// A project that needs to sign in, seed data or drive a flow still points `capture.runner` at its own
// command; this is the floor, not a ceiling.
//
// Usage: node screenshot.mjs --url <url> --out <file.png> [--width 1280] [--height 800]
//                            [--wait <selector>] [--full true] [--repo <dir>] [--timeout 30000]

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadPlaywright, findChrome, noRendererMessage } from './browser.mjs'

export function parseArgs(argv) {
  const out = { width: 1280, height: 800, full: true, timeout: 30_000 }
  for (let i = 0; i < argv.length; i += 2) {
    const k = String(argv[i] || '').replace(/^--/, '')
    let v = argv[i + 1]
    if (!k || v === undefined) continue
    if (k === 'width' || k === 'height' || k === 'timeout') v = Number(v)
    if (k === 'full') v = String(v) !== 'false'
    out[k] = v
  }
  return out
}

/** PURE. Chrome's headless screenshot argv. Chrome cannot wait for a selector, so it is not offered. */
export function chromeArgs({ url, out, width, height }) {
  return [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    `--screenshot=${out}`,
    url,
  ]
}

export async function screenshot({ url, out, width = 1280, height = 800, full = true, wait = null, repo = null, timeout = 30_000 } = {}) {
  if (!url) throw new Error('screenshot: --url is required')
  if (!out) throw new Error('screenshot: --out is required')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })

  let playwrightFailure = null
  const pw = await loadPlaywright(repo)
  if (pw) {
    let browser = null
    try {
      browser = await pw.chromium.launch()
      const page = await browser.newPage({ viewport: { width, height } })
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout })
      // ⛔ Judge by the STATUS CODE. A dev stack is two halves and either can die alone, so a page
      // that renders a framework error screen is still a 500 — and a screenshot of it, silently
      // filed as "after", is a reviewer being shown a fix that never ran.
      const status = res ? res.status() : null
      if (status !== null && status >= 400) {
        throw new Error(`${url} answered ${status} — capturing that would file an error page as evidence`)
      }
      if (wait) await page.waitForSelector(wait, { timeout })
      await page.screenshot({ path: out, fullPage: full })
      return { ok: true, via: 'playwright', out, url, status, width, height }
    } catch (e) {
      playwrightFailure = e && e.message ? e.message.split('\n')[0] : String(e)
      if (/answered \d+/.test(playwrightFailure)) throw e // a real bad status, not a missing browser
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  }

  const bin = findChrome()
  if (bin) {
    if (wait) {
      throw new Error(`screenshot: --wait ${wait} needs Playwright; the Chrome fallback cannot wait for a selector (npx playwright install chromium)`)
    }
    const r = spawnSync(bin, chromeArgs({ url, out, width, height }), { encoding: 'utf8', timeout: Math.max(timeout, 60_000) })
    if (r.status === 0 && fs.existsSync(out)) return { ok: true, via: path.basename(bin), out, url, status: null, width, height }
    throw new Error(`screenshot: ${path.basename(bin)} could not capture ${url}: ${(r.stderr || '').trim() || `exit ${r.status}`}`)
  }

  throw new Error(`screenshot: ${noRendererMessage({ repo, playwrightFailure })}`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const a = parseArgs(process.argv.slice(2))
  screenshot(a)
    .then(r => { console.log(JSON.stringify(r)); process.exit(0) })
    .catch(e => { console.error(e.message); process.exit(1) })
}
