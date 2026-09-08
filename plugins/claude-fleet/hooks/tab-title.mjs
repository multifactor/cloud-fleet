// UserPromptSubmit / Stop / StopFailure / SessionStart hook for fleet sessions:
//
//     node tab-title.mjs working|ready
//
// writes that word to $FLEET_STATE_FILE, and that is all it does.
//
// A hook runs with no console of its own: it cannot paint a tab title or a status bar, and on some
// terminals nothing can be painted from outside the window at all. So the hook records the state in
// a file, and the session shim (src/session/shim.mjs) — which does own the window — tails that file
// and repaints on a CHANGE. The word is the whole protocol: `parseSessionState` there reads the first
// line, and a word it does not recognise is a title that never changes colour.
//
// Four properties, each the shape of a failure:
//   * self-guarded on FLEET_SESSION=1 — an installed plugin's hooks run in EVERY window, and outside
//     a fleet session there is no state file and nothing to paint;
//   * atomic (temp file + rename in the same directory) — the shim reads while this writes, and a
//     half-written word is a torn read the shim discards, which leaves the title stale for a tick;
//     a rename lands a whole word or nothing;
//   * never exit 2 — a Stop hook that exits 2 tells the agent to KEEP GOING, so even a
//     misconfiguration here is reported with exit 1 (shown, non-blocking) and never 2;
//   * never throws — an uncaught exception in a hook is an error on every prompt of every session;
//     a failure is one line on stderr and an exit code.
//
// The state file has a SECOND writer: `writeStatus` in src/backends/registry-first.mjs records the
// same word in JSON form (which `parseSessionState` also reads) — but it creates the directory and
// writes in place, so neither the atomic-write nor the never-mkdir property above holds on that
// path. That is a gap in that module, not a licence for this one.
//
// It imports nothing from src/: it runs on every prompt and every stop in every fleet window.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// ---- pure ---------------------------------------------------------------------------------------

/**
 * The words the shim's `parseSessionState` recognises — src/backends/types.mjs `STATUS`, spelled
 * here rather than imported so this hook loads nothing but node: builtins. test/hooks.test.mjs pins
 * the two together by feeding what this writes to the shim's own parser.
 */
export const STATES = Object.freeze(['working', 'ready', 'blocked'])

/**
 * What to do, from the argument and the environment. PURE.
 * @returns {{action: 'skip'|'refuse'|'write', file: string|null, word: string|null, message: string|null}}
 */
export function planTabTitle(word, env) {
  if (!env || env.FLEET_SESSION !== '1') return { action: 'skip', file: null, word: null, message: null }
  if (!STATES.includes(word)) {
    // A typo in hooks.json must not land on disk: the shim would ignore the word and the title would
    // stay on its previous colour with nothing anywhere saying why.
    return { action: 'refuse', file: null, word: null, message: `tab-title: unknown state ${JSON.stringify(word ?? null)} — one of ${STATES.join('|')}; nothing written` }
  }
  const file = String(env.FLEET_STATE_FILE ?? '').trim()
  if (!file) return { action: 'refuse', file: null, word: null, message: 'tab-title: FLEET_SESSION=1 but FLEET_STATE_FILE is unset (the launcher mirrors it into every session); nothing written' }
  return { action: 'write', file, word, message: null }
}

// ---- thin I/O -----------------------------------------------------------------------------------

/**
 * Write the word so a reader sees the old word or the new one, never part of one: a temp file IN
 * THE SAME DIRECTORY, renamed over the target — a rename across filesystems is a copy, which is the
 * torn write this exists to avoid. Nothing else ever sweeps `sessions/`, so a leaked temp file sits
 * there for the life of the state dir: a failure removes it (best-effort — an rm that fails on a
 * file something else holds must not replace the error that made the write fail), and the temp name
 * is ONE fixed `.3.state.tmp` per state file rather than one per pid, so a hook killed between the
 * write and the rename (the hook timeout) leaks at most one file, which the next write reuses. Last
 * writer wins, which is already the semantics of the word itself.
 *
 * The directory is NOT created here: `sessions/` is the launcher's, written before any session
 * exists, and a Stop hook firing during `fleet down` must not resurrect what the teardown just
 * removed. No fsync either — the next hook rewrites the word anyway, and an fsync per prompt across a
 * fleet is measurable.
 */
export function writeState(file, word) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp`)
  try {
    fs.writeFileSync(tmp, `${word}\n`)
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* the write's own error is the one to report */ }
    throw e
  }
  return file
}

/** `node tab-title.mjs <word>` → an exit code and what to say. Never throws, never returns 2. */
export function main(argv = process.argv.slice(2), env = process.env) {
  const plan = planTabTitle(argv[0], env)
  if (plan.action === 'skip') return { code: 0, stderr: '' }
  if (plan.action === 'refuse') return { code: 1, stderr: `${plan.message}\n` }
  try {
    writeState(plan.file, plan.word)
    return { code: 0, stderr: '' }
  } catch (e) {
    return { code: 1, stderr: `tab-title: could not write ${plan.file}: ${e && e.message ? e.message : e}\n` }
  }
}

/**
 * Is this file the process entry, as opposed to imported by a test? Compared by REAL path on both
 * sides: a plugin root reached through a symlink makes argv[1] and import.meta.url spell the same
 * file differently, and a mismatch here is a hook that silently paints nothing.
 */
function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  let r
  try {
    r = main()
  } catch (e) {
    r = { code: 1, stderr: `tab-title: ${e && e.message ? e.message : e}\n` }
  }
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.code
}
