// `fleet check verify-citations` and `fleet check verify-paths` — machine-checking an audit's own
// evidence against the base branch.
//
// The decision is `src/check/citations.mjs` (pure). What this file adds is the tree and the file
// lengths, read from git at one ref, and the CONTROL that is printed first.
//
// ⛔ The control comes FIRST and it covers the direction you are not expecting: a known-good citation
//    must pass AND a known-bad one must be flagged, through this same matcher, on this same tree.
//    A control that only proves the file list loaded once passed while the matcher was garbage, and
//    the audit it certified reported every citation in its corpus as a phantom.
// ⛔ Never discard the error stream. A `fatal:` from git is the explanation for the zero underneath
//    it, and a zero with no explanation reads as a clean result.

import fs from 'node:fs'
import path from 'node:path'

import { CliError, stringFlag } from '../../args.mjs'
import { envelope } from '../../../cli.mjs'
import { run as exec } from '../../../sys/exec.mjs'
import { extractCitations, extractPaths, verifyCitations, verifyPaths, matcherControl } from '../../../check/citations.mjs'

function corpusText(ctx, args) {
  const where = stringFlag(args.flags, 'corpus', null) || args.positionals[1]
  if (!where) {
    throw new CliError('check.no-corpus', `fleet check ${args.sub} needs --corpus <file>`, 'point it at the prose whose citations you are checking — `audit/verdicts.tsv`, a findings file, or a report')
  }
  try {
    return { file: where, text: fs.readFileSync(path.resolve(ctx.cwd, where), 'utf8') }
  } catch (e) {
    throw new CliError('check.corpus-unreadable', `--corpus ${where}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`, 'pass a readable file')
  }
}

/** Every path in the tree at `ref`. The git error travels with the failure — it is the explanation. */
function treeAt(ctx, ref) {
  const r = exec('git', ['ls-tree', '-r', '--name-only', ref], { cwd: ctx.cwd, timeoutMs: 60_000 })
  if (!r.ok) {
    throw new CliError('check.ref-unreadable', `git ls-tree -r --name-only ${ref} failed: ${(r.stderr || '').trim().slice(0, 300)}`, `fetch first (\`git fetch origin\`); a ref the local clone has never seen cannot be listed, and an empty listing would report every citation in the corpus as a phantom`, 1)
  }
  const paths = String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!paths.length) {
    throw new CliError('check.ref-empty', `${ref} lists no files`, 'a zero here is not a clean result — it makes every citation unresolvable; check the ref', 1)
  }
  return paths
}

/** Line counts at `ref`, memoised: one `git show` per distinct file, not per citation. */
function lengthReader(ctx, ref) {
  const cache = new Map()
  return file => {
    if (cache.has(file)) return cache.get(file)
    const r = exec('git', ['show', `${ref}:${file}`], { cwd: ctx.cwd, timeoutMs: 30_000 })
    // A binary or deleted file is unreadable, not zero-length: a 0 would flag every line cited in it.
    const len = r.ok ? String(r.stdout).split('\n').length : null
    cache.set(file, len)
    return len
  }
}

const refOf = (ctx, args) => stringFlag(args.flags, 'ref', null) || `origin/${ctx.config.repo.baseBranch}`

export function verifyCitationsCmd(ctx, args) {
  const { file, text } = corpusText(ctx, args)
  const ref = refOf(ctx, args)
  const tree = treeAt(ctx, ref)
  const lengthOf = lengthReader(ctx, ref)

  const control = matcherControl(tree, lengthOf)
  if (!ctx.jsonMode) ctx.log(`CONTROL  ${control.ok ? 'ok' : 'FAILED'} — ${control.file || '(no file)'}${control.length ? ` (${control.length} lines)` : ''}: good citation ${control.goodPassed ? 'passed' : 'FAILED'}, bad citation ${control.badFlagged ? 'flagged' : 'NOT FLAGGED'}`)

  const citations = extractCitations(text)
  const result = verifyCitations(citations, tree, lengthOf)
  const body = {
    corpus: file,
    ref,
    control,
    citations: result.total,
    testable: result.testable,
    resolved: result.ok,
    rate: result.rate,
    failures: result.failures,
    ambiguous: result.ambiguous.length,
    absent: result.absent.length,
    unreadable: result.unreadable.length,
    // Triage before reporting: on a PR sweep most non-resolving paths are legitimately PR-branch
    // files, so neither `absent` nor `ambiguous` is an error count.
    note: 'ambiguous and absent citations are untestable, not wrong: a basename with several homes cannot be resolved, and a PR-branch file is legitimately absent from the base',
  }

  if (!control.ok) {
    const err = { code: 'check.control-failed', message: control.reason, hint: 'every count in this payload is meaningless until the control passes' }
    if (ctx.jsonMode) ctx.json(envelope(false, { ...body, error: err }))
    else ctx.log(`CONTROL FAILED: ${control.reason}`)
    return 1
  }

  if (ctx.jsonMode) ctx.json(envelope(result.failures.length === 0, result.failures.length ? { ...body, error: { code: 'check.citations-out-of-range', message: `${result.failures.length} citation(s) name a line past the end of the file`, hint: 'treat cited line numbers as approximate and cited SUBSTANCE as load-bearing — but a line past the end of the file is not drift, it is a citation to nothing' } } : body))
  else {
    ctx.log(`${result.ok} of ${result.testable} testable citation(s) resolve (${result.total} found; ${result.ambiguous.length} ambiguous, ${result.absent.length} absent, ${result.unreadable.length} unreadable)`)
    for (const f of result.failures) ctx.log(`  PAST END ${f.raw} — ${f.resolved} has ${f.length} lines`)
  }
  return result.failures.length ? 1 : 0
}

export function verifyPathsCmd(ctx, args) {
  const { file, text } = corpusText(ctx, args)
  const ref = refOf(ctx, args)
  const tree = treeAt(ctx, ref)
  const result = verifyPaths(extractPaths(text), tree)
  const body = {
    corpus: file,
    ref,
    // The control for a set-difference is that the tree loaded at all: treeAt refuses an empty one,
    // so reaching here means the denominator is real.
    control: { ok: true, treePaths: tree.length },
    cited: result.total,
    exact: result.exact,
    byBasename: result.byBasename,
    ambiguous: result.ambiguous,
    missing: result.missing,
    note: 'a miss is not an error count: on a PR sweep most non-resolving paths are legitimately PR-branch files. Triage them before reporting.',
  }
  if (ctx.jsonMode) ctx.json(envelope(true, body))
  else {
    ctx.log(`CONTROL  ok — ${tree.length} path(s) in ${ref}`)
    ctx.log(`${result.exact} of ${result.total} cited path(s) exist exactly; ${result.byBasename.length} resolve by basename, ${result.ambiguous.length} ambiguous, ${result.missing.length} missing`)
    for (const m of result.missing) ctx.log(`  MISSING ${m}`)
  }
  // Missing paths are reported, not failed: triage is the operator's, and a non-zero exit here would
  // make every PR sweep look broken.
  return 0
}
