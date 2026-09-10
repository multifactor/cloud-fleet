// Finding a browser to drive, without ever installing one.
//
// ⛔ THIS PLUGIN DECLARES NO DEPENDENCIES, and that is a promise to the repos it runs in: adding
// Playwright here would put a ~150 MB browser download in the install path of every user, including
// the ones who never capture anything. So a renderer is FOUND, in this order:
//
//   1. the REPO's own Playwright — a repo that screenshots already has one, and its browser build is
//      the one its own tests were written against;
//   2. a system Chrome-family browser, driven headless.
//
// ⛔ macOS is not an afterthought here. `page.pdf()` is chromium-only in Playwright, and a stock Mac
// has Safari and no Chrome — so the common macOS machine fails BOTH routes until someone runs
// `npx playwright install chromium`. That is a fine requirement; being told it is the whole point.
// A missing renderer therefore reports both routes by name, never "capture failed".

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Chrome-family binaries, most preferred first. PURE. */
export function chromeCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
}

/**
 * The repo's own Playwright module, or null.
 *
 * ⛔ `?? mod.default` is load-bearing. Playwright's entry is CommonJS, so `import()` hangs its
 * exports off `default` and a bare `mod.chromium` is `undefined`. Read as "no Playwright here", that
 * sent a machine with a perfectly good browser down the no-renderer path and reported that no
 * renderer existed — on the exact machine that had one.
 */
export async function loadPlaywright(repoRoot) {
  if (!repoRoot) return null
  const dir = path.join(repoRoot, 'node_modules', 'playwright')
  const entry = ['index.mjs', 'index.js'].map(f => path.join(dir, f)).find(f => fs.existsSync(f))
  if (!entry) return null
  try {
    const mod = await import(pathToFileURL(entry).href)
    if (mod && mod.chromium) return mod
    if (mod && mod.default && mod.default.chromium) return mod.default
    return null
  } catch {
    return null
  }
}

/** The first Chrome-family binary that exists, or null. */
export function findChrome(platform = process.platform, env = process.env) {
  return chromeCandidates(platform, env).find(p => fs.existsSync(p)) || null
}

/** PURE. The sentence a machine with no renderer gets. Both routes, by name. */
export function noRendererMessage({ repo = null, playwrightFailure = null, platform = process.platform } = {}) {
  const install = repo
    ? `npx playwright install chromium (run it in ${repo})`
    : 'npx playwright install chromium in the repo'
  const browser = platform === 'darwin'
    ? 'or install Google Chrome — a stock Mac has only Safari, which cannot print a PDF headlessly'
    : 'or install Google Chrome / Chromium'
  return `no renderer: ${install}, ${browser}.` +
    (playwrightFailure ? ` Playwright was present but failed: ${playwrightFailure}` : '') +
    ' Set capture.reviewPdf false to stop attaching a review PDF, or capture.mode none to turn capture off entirely.'
}

/** What a doctor probe reports, without launching anything. */
export async function probeRenderer({ repo = null, platform = process.platform, env = process.env } = {}) {
  const pw = await loadPlaywright(repo)
  if (pw) {
    // Present is not the same as usable: the browser BINARY is a separate download, and its absence
    // is the single commonest capture failure there is.
    let executable = null
    try {
      executable = pw.chromium.executablePath()
    } catch {
      executable = null
    }
    if (executable && fs.existsSync(executable)) return { ok: true, via: 'playwright', detail: `the repo's Playwright chromium (${executable})` }
    return {
      ok: !!findChrome(platform, env),
      via: findChrome(platform, env) ? 'chrome' : null,
      detail: findChrome(platform, env)
        ? `the repo has Playwright but no chromium build (npx playwright install chromium); falling back to ${path.basename(findChrome(platform, env))}`
        : "the repo has Playwright but its chromium is not installed — run `npx playwright install chromium`",
    }
  }
  const chrome = findChrome(platform, env)
  if (chrome) return { ok: true, via: 'chrome', detail: chrome }
  return { ok: false, via: null, detail: noRendererMessage({ repo, platform }) }
}
