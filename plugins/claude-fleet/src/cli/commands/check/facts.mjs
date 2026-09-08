// The ONE impure module behind `fleet check`: everything the pure planner needs but must never probe.
//
// `src/check/plan.mjs` is a pure function of `(args, config, adapter, facts)` and says so twice in
// its own guards — it throws rather than reading a clock, a git head or a memory gauge. That rule is
// what makes the planner testable, so the probing has to live somewhere, and it lives here rather
// than inside each verb: three verbs plan a sweep (`plan`, `resume`, and a re-planned `finish`), and
// three copies of "what is the base branch's sha" is three chances to answer it differently.

import fs from 'node:fs'

import { run } from '../../../sys/exec.mjs'
import { probeMemory } from '../../../sys/memory.mjs'
import { sweepLayout } from '../../../check/manifest.mjs'
import { DEFAULT_HARNESS_MAX } from '../../../check/plan.mjs'

/**
 * The base branch's commit, as the frame the sweep is judged against.
 *
 * ⛔ `origin/<base>`, not `<base>`. A local base branch on a launcher that has not fetched in a week
 * dates the snapshot a week early, and `fleet check blast-radius --since <sha>` then reports as
 * "changed since the sweep" every commit that landed before it — which is how a finished sweep gets
 * re-judged against a frame it never ran on. Unresolvable is null, never a guess: the manifest
 * records "no snapshot" honestly and blast-radius refuses rather than measuring from nowhere.
 */
export function snapshotShaFor(cwd, baseBranch) {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const r = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, timeoutMs: 10_000 })
    const sha = String(r.stdout || '').trim()
    if (r.ok && /^[0-9a-f]{40}$/.test(sha)) return { sha, ref }
  }
  return { sha: null, ref: null }
}

/**
 * Assemble `facts` for planSweep from this machine.
 * @param {object} ctx  the CLI context
 * @param {{sweepId?: string|null}} [opts]  when the sweep id is already known, `worklistWritten` is
 *   stat'ed for it — the planner requires that boolean on a resume and refuses to stat it itself.
 */
export function checkFacts(ctx, { sweepId = null } = {}) {
  const { config, facts, env, cwd } = ctx
  const platform = (facts && facts.machine && facts.machine.platform) || process.platform
  const at = new Date(ctx.now()).toISOString()
  const tokenEnv = config.tracker.rest && config.tracker.rest.tokenEnv
  const { sha } = snapshotShaFor(cwd, config.repo.baseBranch)

  let worklistWritten
  if (sweepId && config.paths.stateDir) {
    try {
      worklistWritten = fs.existsSync(sweepLayout(config.paths.stateDir, sweepId, platform).worklist)
    } catch {
      // An unusable sweep id is the planner's refusal to make, not ours — leave the fact unset.
      worklistWritten = undefined
    }
  }

  return {
    platform,
    now: at,
    date: at.slice(0, 10),
    cwd,
    repoKey: (facts && facts.repoKey) || null,
    snapshotSha: sha,
    harnessMax: DEFAULT_HARNESS_MAX,
    memory: probeMemory({ platform }),
    hasRestToken: !!(tokenEnv && env[tokenEnv]),
    ...(worklistWritten === undefined ? {} : { worklistWritten }),
  }
}
