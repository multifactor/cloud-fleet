import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PAGE, VIEW_FIELDS, LIST_FIELDS, DEFAULT_LIST_LIMIT, SEARCH_CEILING,
  parseJson, parseJsonStream, repoFromRemote, paginatedFiles, prView, prDiff, reconstructDiff,
  pathIndex, mergedAfter, openIndex, bundle, bundleLayout,
} from '../src/check/gh.mjs'
import { sliceLayout } from '../src/check/brief.mjs'
import { sweepLayout } from '../src/check/manifest.mjs'

const REPO = { owner: 'acme', repo: 'app' }
/** The joined argv of a `pr` subcommand when an explicit repo is given: pinned with `-R`, never resolved from cwd. */
const pinned = argv => `${argv} -R ${REPO.owner}/${REPO.repo}`

/**
 * A scripted forge CLI. `script(argv)` returns {stdout?, stderr?, code?, timedOut?} for the joined
 * argv, or undefined to fail the test on an unscripted call — a call the test did not expect is a
 * bug in the module, not something to answer with an empty reply.
 */
function scripted(script) {
  const calls = []
  const run = (command, args, opts) => {
    calls.push({ command, args, opts })
    const argv = [command, ...args].join(' ')
    const reply = script(argv, args)
    if (reply === undefined) throw new Error(`unscripted forge call: ${argv}`)
    const timedOut = !!reply.timedOut
    const code = reply.code ?? (timedOut ? null : 0) // a killed child has no exit code, as sys/exec reports it
    return { ok: code === 0 && !timedOut, code, signal: timedOut ? 'SIGTERM' : null, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', timedOut }
  }
  return { run, calls }
}

const paths = (n, prefix = 'example/f') => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`)
const viewJson = (n, over = {}) => JSON.stringify({
  number: n, title: `PR ${n}`, body: 'body', url: `https://github.com/acme/app/pull/${n}`,
  files: paths(2).map(p => ({ path: p, additions: 1, deletions: 0 })), state: 'MERGED',
  createdAt: '2026-03-13T09:00:00Z', mergedAt: '2026-03-14T10:00:00Z', mergeCommit: { oid: 'abc123' }, changedFiles: 2, ...over,
})
const apiFiles = (list, patch = '@@ -1 +1 @@\n-a\n+b') => list.map(p => (typeof p === 'string' ? { filename: p, status: 'modified', patch } : p))

// ---- repoFromRemote --------------------------------------------------------------------------------

test('repoFromRemote reads https, scp and ssh forms alike — an scp remote is not a URL and has no scheme to parse', () => {
  for (const url of [
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'https://ada@github.com/acme/app.git',
    'git@github.com:acme/app.git',
    'git@github.com:acme/app',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@github.com:22/acme/app.git',
  ]) assert.deepEqual(repoFromRemote(url), REPO, url)
  assert.throws(() => repoFromRemote('/srv/app'), /cannot read owner\/repo/, 'a local path is not a remote')
  assert.throws(() => repoFromRemote('https://github.com/app'), /cannot read owner\/repo/)
  assert.throws(() => repoFromRemote(''), /cannot read owner\/repo/)
})

// ---- parsing ---------------------------------------------------------------------------------------

test('non-JSON from the forge is an error carrying the first 200 characters, never a bare SyntaxError', () => {
  const banner = 'Welcome to the forge CLI! Please run auth login. ' + 'x'.repeat(300)
  let err
  try { parseJson(banner, 'gh pr view 1') } catch (e) { err = e }
  assert.ok(err && !(err instanceof SyntaxError))
  assert.match(err.message, /^gh pr view 1: expected JSON/)
  assert.ok(err.message.includes(banner.slice(0, 200)))
  assert.ok(!err.message.includes(banner.slice(0, 201)), 'the snippet is capped at 200 characters')
  assert.throws(() => parseJson('', 'x'), /got: <empty>/)
})

test('parseJsonStream splits concatenated pages by scanning, because a patch may contain "][" and a text split corrupts it', () => {
  const page1 = apiFiles(['example/a.ts'], 'const x = m[a][b]\n]\n[')
  const page2 = apiFiles(['example/b.ts', 'example/c.ts'])
  const concatenated = JSON.stringify(page1) + '\n' + JSON.stringify(page2) // what `--paginate` prints
  const values = parseJsonStream(concatenated)
  assert.equal(values.length, 2)
  assert.equal(values[0][0].patch, 'const x = m[a][b]\n]\n[')
  assert.equal(values[1].length, 2)
  // (a text split on `][` would not fail on this input — `JSON.parse('[' + text.replace(/\]\s*\[/g, ',') + ']')`
  // parses and SILENTLY yields the patch `const x = m[a,b]\n]\n[`: the trap is corruption without an error)
  // one value, and one value per line, still work
  assert.deepEqual(parseJsonStream(JSON.stringify(page2)), [page2])
  assert.equal(parseJsonStream('{"a":1}\n{"a":2}\n').length, 2)
  assert.deepEqual(parseJsonStream('  '), [])
  assert.throws(() => parseJsonStream('[{"a":1}', 'gh api'), /gh api: expected JSON/)
  assert.throws(() => parseJsonStream('not json at all'), /expected JSON/)
  // text beside a page is the error, never dropped: a banner before it, a warning after it, an error
  // message between two pages
  assert.throws(() => parseJsonStream('garbage [1]', 'gh api'), /gh api: expected JSON from the forge CLI, got: garbage \[1\]/)
  assert.throws(() => parseJsonStream('[1] garbage', 'gh api'), /gh api: expected JSON from the forge CLI, got: \[1\] garbage/)
  assert.throws(() => parseJsonStream('[1]\nHTTP 502: bad gateway\n[2]'), /expected JSON/)
  assert.throws(() => parseJsonStream(']['), /expected JSON/)
})

// ---- prView ----------------------------------------------------------------------------------------

test('exactly 100 files means paginate — a 167-file PR once reported exactly 100 with no marker', () => {
  const all = paths(167)
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 1240 ')) return { stdout: viewJson(1240, { files: all.slice(0, PAGE).map(p => ({ path: p })), changedFiles: 167 }) }
    if (argv.startsWith('gh api repos/acme/app/pulls/1240/files?per_page=100 --paginate')) {
      return { stdout: JSON.stringify(apiFiles(all.slice(0, PAGE))) + JSON.stringify(apiFiles(all.slice(PAGE))) }
    }
  })
  const pr = prView(1240, { run: gh.run, repo: REPO })
  assert.equal(pr.files.length, 167)
  assert.equal(pr.changedFiles, 167)
  assert.equal(pr.mergeCommit, 'abc123')
  assert.deepEqual([pr.number, pr.state, pr.createdAt, pr.mergedAt, pr.url], [1240, 'MERGED', '2026-03-13T09:00:00Z', '2026-03-14T10:00:00Z', 'https://github.com/acme/app/pull/1240'])
  assert.ok(!('filesTruncated' in pr), 'no field that is a constant in every written bundle')
  // every runner call is an explicit argv — tokens, never a shell string — and the explicit repo
  // reaches the `pr` subcommand as `-R` and the REST call in its path: one repo, never cwd's
  assert.equal(gh.calls.length, 2)
  assert.equal(gh.calls[0].command, 'gh')
  assert.deepEqual(gh.calls[0].args, ['pr', 'view', '1240', '--json', VIEW_FIELDS.join(','), '-R', 'acme/app'])
  assert.deepEqual(gh.calls[1].args, ['api', 'repos/acme/app/pulls/1240/files?per_page=100', '--paginate'])
})

test('a file list under the page size is taken as-is, and a PR with exactly 100 files is still paginated (100 is truncated until proven otherwise)', () => {
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 1 ')) return { stdout: viewJson(1, { files: paths(84).map(p => ({ path: p })), changedFiles: 84 }) }
    if (argv.startsWith('gh pr view 2 ')) return { stdout: viewJson(2, { files: paths(PAGE).map(p => ({ path: p })), changedFiles: PAGE }) }
    if (argv.startsWith('gh api repos/{owner}/{repo}/pulls/2/files')) return { stdout: JSON.stringify(apiFiles(paths(PAGE))) }
    // no changedFiles at all: exactly one page still paginates, and the paginated list is the truth
    if (argv.startsWith('gh pr view 4 ')) return { stdout: viewJson(4, { files: paths(PAGE).map(p => ({ path: p })), changedFiles: undefined }) }
    if (argv.startsWith('gh api repos/{owner}/{repo}/pulls/4/files')) return { stdout: JSON.stringify(apiFiles(paths(150))) }
  })
  const small = prView(1, { run: gh.run })
  assert.equal(small.files.length, 84)
  assert.equal(gh.calls.length, 1, 'no pagination call for a list under the page size')
  assert.ok(!gh.calls[0].args.includes('-R'), 'without an explicit repo the CLI resolves it from the checkout')

  const exact = prView(2, { run: gh.run })
  assert.equal(exact.files.length, PAGE)
  // without an explicit repo the api path keeps the placeholders the CLI resolves from the checkout
  assert.equal(gh.calls[2].args[1], 'repos/{owner}/{repo}/pulls/2/files?per_page=100')

  const uncounted = prView(4, { run: gh.run })
  assert.equal(uncounted.changedFiles, null)
  assert.equal(uncounted.files.length, 150, 'with no count to check against, the paginated list is taken whole')
  assert.equal(gh.calls[4].args[1], 'repos/{owner}/{repo}/pulls/4/files?per_page=100')
})

test('a short one-page list is paginated even under 100 when the PR says it changed more files', () => {
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 3 ')) return { stdout: viewJson(3, { files: paths(40).map(p => ({ path: p })), changedFiles: 120 }) }
    if (argv.includes('/pulls/3/files')) return { stdout: JSON.stringify(apiFiles(paths(120))) }
  })
  const pr = prView(3, { run: gh.run, repo: REPO })
  assert.equal(pr.files.length, 120)
})

test('a one-page entry with no path is an error, as it is for the paginated list — never a silently shorter file list', () => {
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 6 ')) return { stdout: viewJson(6, { files: [{ path: 'example/a.ts' }, { additions: 1, deletions: 0 }], changedFiles: 2 }) }
  })
  assert.throws(() => prView(6, { run: gh.run, repo: REPO }), /gh pr view 6: an entry has no filename: \{"additions":1,"deletions":0\}/)
  assert.equal(gh.calls.length, 1, 'the error is raised on the one-page list itself, before any pagination')
})

test('a failed or still-short pagination is an error — a 100-entry list is never returned as the truth', () => {
  const fail = scripted(argv => {
    if (argv.startsWith('gh pr view 1240 ')) return { stdout: viewJson(1240, { files: paths(PAGE).map(p => ({ path: p })), changedFiles: 167 }) }
    if (argv.includes('/pulls/1240/files')) return { code: 1, stderr: 'HTTP 502: bad gateway' }
  })
  assert.throws(() => prView(1240, { run: fail.run, repo: REPO }), /gh api pulls\/1240\/files: exit 1 — HTTP 502/)

  const short = scripted(argv => {
    if (argv.startsWith('gh pr view 1240 ')) return { stdout: viewJson(1240, { files: paths(PAGE).map(p => ({ path: p })), changedFiles: 167 }) }
    if (argv.includes('/pulls/1240/files')) return { stdout: JSON.stringify(apiFiles(paths(150))) }
  })
  assert.throws(() => prView(1240, { run: short.run, repo: REPO }), /150 entries but the PR reports 167 changed files/)

  const view = scripted(argv => {
    if (argv.startsWith('gh pr view 9 ')) return { code: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 9.' }
  })
  assert.throws(() => prView(9, { run: view.run }), /gh pr view 9: exit 1 — GraphQL: Could not resolve/)
  const slow = scripted(() => ({ timedOut: true }))
  assert.throws(() => prView(1, { run: slow.run }), /gh pr view 1: timed out$/)

  const junk = scripted(() => ({ stdout: '<html>rate limited</html>' }))
  assert.throws(() => prView(1, { run: junk.run }), /gh pr view 1: expected JSON from the forge CLI, got: <html>rate limited<\/html>/)
  const wrongShape = scripted(() => ({ stdout: '[1,2]' }))
  assert.throws(() => prView(1, { run: wrongShape.run }), /expected a JSON object/)
})

test('paginatedFiles normalises the REST shape and refuses an entry with no filename', () => {
  const gh = scripted(argv => {
    if (argv.includes('/pulls/7/files')) return { stdout: JSON.stringify([{ filename: 'example/a.ts', status: 'renamed', previous_filename: 'example/old.ts', patch: '@@' }, { filename: 'example/i.png', status: 'added' }]) }
    if (argv.includes('/pulls/8/files')) return { stdout: JSON.stringify([{ status: 'added' }]) }
  })
  assert.deepEqual(paginatedFiles(7, { run: gh.run, repo: REPO }), [
    { path: 'example/a.ts', status: 'renamed', previousPath: 'example/old.ts', patch: '@@' },
    { path: 'example/i.png', status: 'added', previousPath: null, patch: null },
  ])
  assert.throws(() => paginatedFiles(8, { run: gh.run, repo: REPO }), /an entry has no filename/)
})

// ---- prDiff ----------------------------------------------------------------------------------------

test('the forge\'s own diff is returned verbatim when it delivers one', () => {
  const text = 'diff --git a/example/a.ts b/example/a.ts\n--- a/example/a.ts\n+++ b/example/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
  const gh = scripted(argv => (argv === pinned('gh pr diff 1240') ? { stdout: text } : undefined))
  assert.deepEqual(prDiff(1240, { run: gh.run, repo: REPO }), { diff: text, reconstructed: false, omitted: [] })
  assert.deepEqual(gh.calls[0].args, ['pr', 'diff', '1240', '-R', 'acme/app'])
})

test('a failed diff (HTTP 406 past 20k lines) is rebuilt from the per-file patches and marked reconstructed', () => {
  const gh = scripted(argv => {
    if (argv === pinned('gh pr diff 1240')) return { code: 1, stderr: 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)' }
    if (argv.includes('/pulls/1240/files')) {
      return { stdout: JSON.stringify([
        { filename: 'example/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'example/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
        { filename: 'example/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-gone' },
        { filename: 'example/moved.ts', status: 'renamed', previous_filename: 'example/old.ts', patch: '@@ -1 +1 @@\n-x\n+y' },
        { filename: 'example/logo.png', status: 'added' },
      ]) }
    }
  })
  const d = prDiff(1240, { run: gh.run, repo: REPO })
  assert.equal(d.reconstructed, true)
  assert.deepEqual(d.omitted, ['example/logo.png'])
  const lines = d.diff.split('\n')
  assert.match(lines[0], /^# reconstructed from per-file patches — gh pr diff #1240 failed: exit 1 could not find pull request diff: HTTP 406/)
  assert.equal(lines[1], '# 1 file(s) without a patch (binary or too large): example/logo.png')
  assert.ok(d.diff.includes('diff --git a/example/a.ts b/example/a.ts\n--- a/example/a.ts\n+++ b/example/a.ts\n@@ -1 +1 @@\n-a\n+b\n'))
  assert.ok(d.diff.includes('diff --git a/example/new.ts b/example/new.ts\n--- /dev/null\n+++ b/example/new.ts\n'))
  assert.ok(d.diff.includes('diff --git a/example/gone.ts b/example/gone.ts\n--- a/example/gone.ts\n+++ /dev/null\n'))
  assert.ok(d.diff.includes('diff --git a/example/old.ts b/example/moved.ts\n--- a/example/old.ts\n+++ b/example/moved.ts\n'))
  assert.ok(d.diff.includes('diff --git a/example/logo.png b/example/logo.png\n# no patch for example/logo.png\n'))
  assert.ok(d.diff.endsWith('\n'))
  // the same rebuild is reachable directly
  assert.equal(reconstructDiff(1, [], 'x').diff, '# reconstructed from per-file patches — gh pr diff #1 failed: x\n')
})

test('a 0-byte diff with exit 0 is never accepted as "no changes" — it once produced a confident clean', () => {
  const recovered = scripted(argv => {
    if (argv === pinned('gh pr diff 1240')) return { stdout: '' }
    if (argv.includes('/pulls/1240/files')) return { stdout: JSON.stringify(apiFiles(['example/a.ts'])) }
  })
  const d = prDiff(1240, { run: recovered.run, repo: REPO })
  assert.equal(d.reconstructed, true)
  assert.match(d.diff, /failed: exit 0 with a 0-byte diff/)
  assert.ok(d.diff.includes('+b'))

  const nothing = scripted(argv => {
    if (argv === pinned('gh pr diff 1241')) return { stdout: '  \n' }
    if (argv.includes('/pulls/1241/files')) return { stdout: '[]' }
  })
  assert.throws(() => prDiff(1241, { run: nothing.run, repo: REPO }), /refusing to record a 0-byte diff as "no changes"/)

  // when the rebuild's own source fails, the failure is explicit — not an empty diff
  const dead = scripted(argv => {
    if (argv === pinned('gh pr diff 1242')) return { code: 1, stderr: 'HTTP 406' }
    if (argv.includes('/pulls/1242/files')) return { code: 1, stderr: 'HTTP 500' }
  })
  assert.throws(() => prDiff(1242, { run: dead.run, repo: REPO }), /gh api pulls\/1242\/files: exit 1 — HTTP 500/)

  // a timeout has no exit code and no stderr; the rebuilt header still names the reason
  const slow = scripted(argv => {
    if (argv === pinned('gh pr diff 1243')) return { timedOut: true }
    if (argv.includes('/pulls/1243/files')) return { stdout: JSON.stringify(apiFiles(['example/a.ts'])) }
  })
  const late = prDiff(1243, { run: slow.run, repo: REPO })
  assert.equal(late.reconstructed, true)
  assert.match(late.diff.split('\n')[0], /gh pr diff #1243 failed: timed out$/)
})

// ---- mergedAfter / indexes -------------------------------------------------------------------------

const listItem = (n, files, mergedAt = '2026-03-15T00:00:00Z') => ({ number: n, title: `later ${n}`, mergedAt, files: files.map(p => ({ path: p })) })

test('mergedAfter asks the forge with an explicit limit and never returns a count equal to it — a shallow clone would answer "nothing" from git log', () => {
  const full = Array.from({ length: DEFAULT_LIST_LIMIT }, (_, i) => listItem(2000 + i, ['example/a.ts']))
  const gh = scripted((argv, args) => {
    // the merged PR with exactly one page of files is paginated like any other
    if (argv.includes('/pulls/2501/files')) return { stdout: JSON.stringify(apiFiles(paths(101))) }
    if (!argv.startsWith('gh pr list ')) return undefined
    const limit = Number(args[args.indexOf('--limit') + 1])
    if (limit === 200) return { stdout: JSON.stringify(full) }                   // exactly the limit: truncated by definition
    if (limit === 400) return { stdout: JSON.stringify([...full, listItem(2500, ['example/b.ts', 'example/c.ts']), listItem(2501, paths(PAGE))]) }
  })
  const m = mergedAfter('2026-03-14T10:00:00Z', { run: gh.run, base: 'main', repo: REPO })
  assert.equal(m.since, '2026-03-14T10:00:00+00:00', 'a trailing Z becomes +00:00 for the search syntax')
  assert.equal(m.base, 'main')
  assert.equal(m.count, 202)
  assert.equal(m.limit, 400)
  assert.deepEqual(gh.calls[0].args, ['pr', 'list', '--state', 'merged', '--base', 'main', '--search', 'merged:>2026-03-14T10:00:00+00:00', '--json', LIST_FIELDS.join(','), '--limit', '200', '-R', 'acme/app'])
  assert.equal(gh.calls[1].args[gh.calls[1].args.indexOf('--limit') + 1], '400')
  assert.deepEqual(m.index.get('example/b.ts'), [2500])
  assert.equal(m.index.get('example/a.ts').length, DEFAULT_LIST_LIMIT)
  assert.deepEqual(m.index.get('example/f100.ts'), [2501], 'the 101st file of the paginated PR is in the index')
  assert.equal(m.prs.find(p => p.number === 2501).files.length, 101)
  // a plain date passes through; fractional seconds (what Date#toISOString yields), an offset and a
  // zone-less timestamp all become the one form the search syntax accepts; local git is never consulted
  const plain = scripted(argv => (argv.startsWith('gh pr list ') ? { stdout: '[]' } : undefined))
  assert.equal(mergedAfter('2026-03-14', { run: plain.run }).since, '2026-03-14')
  assert.equal(mergedAfter('2026-03-14T10:00:00.000Z', { run: plain.run }).since, '2026-03-14T10:00:00+00:00')
  assert.equal(mergedAfter('2026-03-14T12:00:00+02:00', { run: plain.run }).since, '2026-03-14T10:00:00+00:00')
  assert.equal(mergedAfter('2026-03-14T10:00:00', { run: plain.run }).since, '2026-03-14T10:00:00+00:00')
  assert.throws(() => mergedAfter('yesterday', { run: plain.run }), /not a date: "yesterday"/)
  assert.ok(plain.calls.every(c => c.command === 'gh'))
})

test('mergedAfter splits a window at the search API\'s 1000-result ceiling in two by date and unions the halves — the forge stops at 1000 whatever the limit says', () => {
  assert.equal(SEARCH_CEILING, 1000)
  /** The forge: `count` PRs numbered from `first`, capped at the limit asked and at the search ceiling. */
  const page = (args, first, count) => {
    const limit = Number(args[args.indexOf('--limit') + 1])
    return { stdout: JSON.stringify(Array.from({ length: Math.min(limit, count, SEARCH_CEILING) }, (_, i) => listItem(first + i, [`example/w${first + i}.ts`, 'example/shared.ts']))) }
  }
  const search = args => args[args.indexOf('--search') + 1]
  const gh = scripted((argv, args) => {
    if (!argv.startsWith('gh pr list ')) return undefined
    // the whole window has 1199 PRs: every limit up to 1600 comes back at the ceiling
    if (search(args) === 'merged:>2026-03-14') return page(args, 1, 1199)
    // the halves; PR 600 merged exactly at the midpoint sits in both (the `..` form is inclusive)
    if (search(args) === 'merged:2026-03-14T00:00:00+00:00..2026-03-15T00:00:00+00:00') return page(args, 1, 600)
    if (search(args) === 'merged:2026-03-15T00:00:00+00:00..2026-03-16T00:00:00+00:00') return page(args, 600, 600)
  })
  const m = mergedAfter('2026-03-14', { run: gh.run, until: '2026-03-16' })
  assert.equal(m.since, '2026-03-14', 'the anchor is reported as given')
  assert.equal(m.count, 1199, 'the boundary PR is counted once')
  assert.equal(m.prs[0].number, 1)
  assert.equal(m.prs[m.prs.length - 1].number, 1199)
  assert.equal(m.index.get('example/shared.ts').length, 1199)
  assert.deepEqual(m.index.get('example/w600.ts'), [600])
  assert.equal(m.limit, 800, 'the widest limit any half needed')
  const asked = gh.calls.map(c => `${search(c.args)} @${c.args[c.args.indexOf('--limit') + 1]}`)
  assert.deepEqual(asked, [
    'merged:>2026-03-14 @200', 'merged:>2026-03-14 @400', 'merged:>2026-03-14 @800', 'merged:>2026-03-14 @1600',
    'merged:2026-03-14T00:00:00+00:00..2026-03-15T00:00:00+00:00 @200', 'merged:2026-03-14T00:00:00+00:00..2026-03-15T00:00:00+00:00 @400', 'merged:2026-03-14T00:00:00+00:00..2026-03-15T00:00:00+00:00 @800',
    'merged:2026-03-15T00:00:00+00:00..2026-03-16T00:00:00+00:00 @200', 'merged:2026-03-15T00:00:00+00:00..2026-03-16T00:00:00+00:00 @400', 'merged:2026-03-15T00:00:00+00:00..2026-03-16T00:00:00+00:00 @800',
  ], 'the limit grew 200 → 400 → 800 → 1600 and the 1600 reply of exactly 1000 is not "under the limit"; then each half on its own')

  // a window one second wide that is still at the ceiling cannot be split further — that is the error
  const capped = scripted((argv, args) => (argv.startsWith('gh pr list ') ? page(args, 1, 5000) : undefined))
  assert.throws(() => mergedAfter('2026-03-14T00:00:00Z', { run: capped.run, until: '2026-03-14T00:00:01Z' }),
    /1000 or more PRs merged in the second at 2026-03-14T00:00:00\+00:00 — the forge search API returns at most 1000 whatever the limit, and a one-second window cannot be split further/)
  assert.equal(capped.calls.length, 4)
})

test('mergedAfter gives up loudly when the count never drops under the limit, and rejects a non-list reply', () => {
  const always = scripted((argv, args) => {
    if (!argv.startsWith('gh pr list ')) return undefined
    const limit = Number(args[args.indexOf('--limit') + 1])
    return { stdout: JSON.stringify(Array.from({ length: limit }, (_, i) => listItem(i + 1, []))) }
  })
  // a small caller limit keeps every doubling under the search ceiling, so it is the growth that runs out
  assert.throws(() => mergedAfter('2026-03-14', { run: always.run, limit: 50 }), /still equals its limit at 400 — the result is truncated by definition/)
  assert.equal(always.calls.length, 4)
  const object = scripted(() => ({ stdout: '{"message":"Bad credentials"}' }))
  assert.throws(() => mergedAfter('2026-03-14', { run: object.run }), /expected a JSON array/)
  const down = scripted(() => ({ code: 1, stderr: 'HTTP 503' }))
  assert.throws(() => mergedAfter('2026-03-14', { run: down.run }), /gh pr list --state merged --limit 200: exit 1 — HTTP 503/)
  assert.throws(() => mergedAfter('', { run: down.run }), /a date is required/)
})

test('openIndex counts only open PRs; pathIndex dedups and sorts', () => {
  const prs = [
    { number: 1241, state: 'OPEN', files: ['example/b.ts', 'example/c.ts'] },
    { number: 1240, state: 'MERGED', files: ['example/b.ts'] },
    { number: 1239, state: 'open', files: ['example/b.ts', 'example/b.ts'] },
    { number: 1238, state: 'CLOSED', files: ['example/z.ts'] },
  ]
  const idx = openIndex(prs)
  assert.deepEqual([...idx.keys()], ['example/b.ts', 'example/c.ts'])
  assert.deepEqual(idx.get('example/b.ts'), [1239, 1241])
  assert.deepEqual(idx.get('example/c.ts'), [1241])
  assert.deepEqual([...pathIndex(prs).get('example/b.ts')], [1239, 1240, 1241])
  assert.equal(openIndex([]).size, 0)
})

// ---- bundle ----------------------------------------------------------------------------------------

test('bundle writes the offline payload, records a failing PR without leaving a diff behind, and skips what is already on disk', t => {
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'))
  t.after(() => fs.rmSync(sweepDir, { recursive: true, force: true }))
  const layout = bundleLayout(sweepDir)
  const prsDir = layout.prs
  fs.mkdirSync(prsDir, { recursive: true })
  fs.writeFileSync(path.join(prsDir, '1242.diff'), '') // a stale 0-byte diff from a killed run
  const diff = n => `diff --git a/example/${n}.ts b/example/${n}.ts\n@@ -1 +1 @@\n-a\n+b\n`
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 1240 ')) return { stdout: viewJson(1240, { files: [{ path: 'example/a.ts' }, { path: 'example/b.ts' }], createdAt: '2026-03-09T00:00:00Z', mergedAt: '2026-03-10T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 1240')) return { stdout: diff(1240) }
    if (argv.startsWith('gh pr view 1241 ')) return { stdout: viewJson(1241, { title: 'open one', files: [{ path: 'example/b.ts' }, { path: 'example/c.ts' }], state: 'OPEN', mergedAt: null, mergeCommit: null }) }
    if (argv === pinned('gh pr diff 1241')) return { stdout: diff(1241) }
    if (argv.startsWith('gh pr view 1242 ')) return { stdout: viewJson(1242, { files: [{ path: 'example/d.ts' }], changedFiles: 1, mergedAt: '2026-03-12T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 1242')) return { code: 1, stderr: 'HTTP 406' }
    if (argv.includes('/pulls/1242/files')) return { code: 1, stderr: 'HTTP 500' }
    if (argv.startsWith('gh pr list ')) return { stdout: JSON.stringify([listItem(1300, ['example/b.ts'], '2026-03-12T00:00:00Z'), listItem(1301, ['example/b.ts', 'example/q.ts'], '2026-03-13T00:00:00Z')]) }
  })
  const listQueries = calls => calls.filter(c => c.args[1] === 'list').map(c => c.args[c.args.indexOf('--search') + 1])
  const r = bundle(['1240', 1241, 1242], sweepDir, { run: gh.run, base: 'main', repo: REPO })
  assert.equal(r.ok, false)
  assert.equal(r.dir, layout.dir)
  assert.equal(layout.dir, path.join(sweepDir, '_sweep'), 'contract §4: the bundle lives under _sweep/')
  assert.deepEqual(r.written, [1240, 1241])
  assert.deepEqual(r.skipped, [])
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].pr, 1242)
  assert.match(r.errors[0].error, /gh api pulls\/1242\/files: exit 1 — HTTP 500/)
  // the gate-2 window opens at the earliest anchor among the bundled PRs: 1240's mergedAt (the open
  // 1241 anchors on its later createdAt; the failed 1242 anchors nothing)
  assert.deepEqual(listQueries(gh.calls), ['merged:>2026-03-10T00:00:00+00:00'])

  // the two good PRs are on disk in full, each json promising its diff's exact size; the failed one
  // left NOTHING (the stale 0-byte diff is gone), and the atomic writes left no temp file anywhere
  const j1240 = JSON.parse(fs.readFileSync(path.join(prsDir, '1240.json'), 'utf8'))
  assert.deepEqual([j1240.number, j1240.state, j1240.mergeCommit, j1240.createdAt, j1240.reconstructed, j1240.diffBytes],
    [1240, 'MERGED', 'abc123', '2026-03-09T00:00:00Z', false, Buffer.byteLength(diff(1240))])
  assert.deepEqual(j1240.files, ['example/a.ts', 'example/b.ts'])
  assert.equal(fs.readFileSync(path.join(prsDir, '1240.diff'), 'utf8'), diff(1240))
  assert.equal(fs.readFileSync(path.join(prsDir, '1241.diff'), 'utf8'), diff(1241))
  assert.deepEqual(fs.readdirSync(prsDir).sort(), ['1240.diff', '1240.json', '1241.diff', '1241.json'])
  assert.deepEqual(fs.readdirSync(layout.dir).sort(), ['gate2-index.tsv', 'open-index.tsv', 'prs'])

  // the indexes a worker consults offline
  assert.equal(fs.readFileSync(layout.gate2Index, 'utf8'),
    'example/b.ts\t1300\t2026-03-12T00:00:00Z\tlater 1300\nexample/b.ts\t1301\t2026-03-13T00:00:00Z\tlater 1301\nexample/q.ts\t1301\t2026-03-13T00:00:00Z\tlater 1301\n')
  assert.equal(fs.readFileSync(layout.openIndex, 'utf8'), 'example/b.ts\t1241\topen one\nexample/c.ts\t1241\topen one\n')
  assert.deepEqual(r.gate2, { since: '2026-03-10T00:00:00+00:00', count: 2, rows: 3, limit: DEFAULT_LIST_LIMIT })
  assert.deepEqual(r.open, { count: 1, rows: 2 })

  // re-running is the resume path: what is on disk is not asked of the forge again; the failed PR is retried
  const before = gh.calls.length
  const again = bundle([1240, 1241, 1242], sweepDir, { run: gh.run, base: 'main', repo: REPO })
  assert.deepEqual(again.skipped, [1240, 1241])
  assert.deepEqual(again.written, [])
  assert.equal(again.errors[0].pr, 1242)
  const asked = gh.calls.slice(before).map(c => c.args.join(' '))
  assert.ok(asked.every(a => !a.includes('1240') && !a.includes('1241')), `re-asked the forge for a bundled PR: ${asked.join(' | ')}`)
  assert.equal(fs.readFileSync(path.join(prsDir, '1240.diff'), 'utf8'), diff(1240), 'the skipped diff on disk is the full one')
  assert.equal(again.open.rows, 2, 'the open index is rebuilt from the bundles on disk')
  assert.deepEqual(listQueries(gh.calls.slice(before)), ['merged:>2026-03-10T00:00:00+00:00'], 'the on-disk record\'s mergedAt feeds the window on resume')
  // an input that is not a PR number is an error row carrying the raw input, not a crash — and
  // "a PR number" is digits only: Number() would read these as 1000, 16 and 0
  for (const raw of ['abc', '1e3', '0x10', '', '0', '12.5', '-3']) {
    assert.deepEqual(bundle([raw], sweepDir, { run: gh.run, repo: REPO }).errors[0], { pr: raw, error: `not a PR number: "${raw}"` }, JSON.stringify(raw))
  }
  assert.deepEqual(fs.readdirSync(prsDir).sort(), ['1240.diff', '1240.json', '1241.diff', '1241.json'], 'no junk input bundled anything')
})

test('bundle re-fetches the residue of a killed run — a complete json beside a diff cut mid-hunk, a corrupt json beside a whole diff — and never dies on it', t => {
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'))
  t.after(() => fs.rmSync(sweepDir, { recursive: true, force: true }))
  const prsDir = bundleLayout(sweepDir).prs
  const diff = n => `diff --git a/example/${n}.ts b/example/${n}.ts\n--- a/example/${n}.ts\n+++ b/example/${n}.ts\n@@ -1,40 +1,4 @@\n-a\n+b\n`
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 7 ')) return { stdout: viewJson(7, { mergedAt: '2026-03-10T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 7')) return { stdout: diff(7) }
    if (argv.startsWith('gh pr view 8 ')) return { stdout: viewJson(8, { mergedAt: '2026-03-11T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 8')) return { stdout: diff(8) }
    if (argv.startsWith('gh pr list ')) return { stdout: '[]' }
  })
  assert.deepEqual(bundle([7, 8], sweepDir, { run: gh.run, repo: REPO }).written, [7, 8])

  // killed one byte past zero: the json is complete, the diff stops mid-hunk with no marker of its own
  fs.writeFileSync(path.join(prsDir, '7.diff'), 'diff --git a/example/7.ts b/example/7.ts\n@@ -1,40 +1,4')
  // killed mid-json: the diff is whole, the json is not
  fs.writeFileSync(path.join(prsDir, '8.json'), fs.readFileSync(path.join(prsDir, '8.json'), 'utf8').slice(0, 32))
  const before = gh.calls.length
  let again
  assert.doesNotThrow(() => { again = bundle([7, 8], sweepDir, { run: gh.run, repo: REPO }) })
  assert.deepEqual(again.skipped, [])
  assert.deepEqual(again.written, [7, 8])
  assert.deepEqual(again.errors, [])
  const asked = gh.calls.slice(before).map(c => c.args.join(' '))
  assert.ok(asked.includes(pinned('pr diff 7')) && asked.includes(pinned('pr diff 8')), `neither residue was taken as a bundle: ${asked.join(' | ')}`)
  assert.equal(fs.readFileSync(path.join(prsDir, '7.diff'), 'utf8'), diff(7), 'the diff on disk is the forge\'s full reply, not the truncated one')
  assert.equal(fs.readFileSync(path.join(prsDir, '8.diff'), 'utf8'), diff(8))
  assert.equal(JSON.parse(fs.readFileSync(path.join(prsDir, '8.json'), 'utf8')).diffBytes, Buffer.byteLength(diff(8)))

  // whole again, both are skipped — and the atomic writes left nothing beside the four files
  assert.deepEqual(bundle([7, 8], sweepDir, { run: gh.run, repo: REPO }).skipped, [7, 8])
  assert.deepEqual(fs.readdirSync(prsDir).sort(), ['7.diff', '7.json', '8.diff', '8.json'])

  // the indexes are never resumed from disk: the residue of a killed index write (a row cut short) is
  // recomputed on the next plan, and the atomic write leaves no temp file beside either index
  const layout = bundleLayout(sweepDir)
  fs.writeFileSync(layout.gate2Index, 'example/b.ts\t13')
  fs.writeFileSync(layout.openIndex, 'example/b.ts\t7\tPR')
  bundle([7, 8], sweepDir, { run: gh.run, repo: REPO })
  assert.equal(fs.readFileSync(layout.gate2Index, 'utf8'), '', 'the forge said nothing merged since: a computed-empty index is an empty FILE, and the residue row is gone')
  assert.equal(fs.readFileSync(layout.openIndex, 'utf8'), '', 'neither PR is open')
  assert.deepEqual(fs.readdirSync(layout.dir).sort(), ['gate2-index.tsv', 'open-index.tsv', 'prs'])
})

test('bundle: a PR number repeated in one input is fetched once and reported skipped the second time', t => {
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'))
  t.after(() => fs.rmSync(sweepDir, { recursive: true, force: true }))
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 7 ')) return { stdout: viewJson(7) }
    if (argv === pinned('gh pr diff 7')) return { stdout: 'diff --git a/example/f0.ts b/example/f0.ts\n@@ -1 +1 @@\n-a\n+b\n' }
    if (argv.startsWith('gh pr list ')) return { stdout: '[]' }
  })
  const r = bundle([7, '7'], sweepDir, { run: gh.run, repo: REPO })
  assert.deepEqual([r.written, r.skipped, r.errors], [[7], [7], []])
  assert.equal(gh.calls.filter(c => c.args[1] === 'view').length, 1)
  assert.deepEqual(fs.readdirSync(bundleLayout(sweepDir).prs).sort(), ['7.diff', '7.json'])
})

test('bundle: an open target anchors the gate-2 window on its createdAt; a gate-2 failure is a sweep-level error; an index never computed is absent, not empty', t => {
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'))
  t.after(() => fs.rmSync(sweepDir, { recursive: true, force: true }))
  const layout = bundleLayout(sweepDir)
  let listReply = { stdout: JSON.stringify([listItem(1300, ['example/f0.ts'], '2026-03-14T00:00:00Z')]) }
  const gh = scripted(argv => {
    if (argv.startsWith('gh pr view 5 ')) return { stdout: viewJson(5, { state: 'OPEN', mergedAt: null, mergeCommit: null }) }
    if (argv === pinned('gh pr diff 5')) return { stdout: 'diff --git a/example/f0.ts b/example/f0.ts\n' }
    if (argv.startsWith('gh pr view 6 ')) return { stdout: viewJson(6, { state: 'OPEN', createdAt: null, mergedAt: null, mergeCommit: null }) }
    if (argv === pinned('gh pr diff 6')) return { stdout: 'diff --git a/example/f1.ts b/example/f1.ts\n' }
    if (argv.startsWith('gh pr list ')) return listReply
  })
  // playbook §7.3: an open target has no mergedAt and is compared against what is merged on the base
  // branch — the window opens where the PR began, since nothing merged before it existed fixed it later
  const r = bundle([5], sweepDir, { run: gh.run, repo: REPO })
  assert.equal(r.ok, true)
  assert.deepEqual(r.gate2, { since: '2026-03-13T09:00:00+00:00', count: 1, rows: 1, limit: DEFAULT_LIST_LIMIT })
  const list = gh.calls.filter(c => c.args[1] === 'list')
  assert.equal(list.length, 1)
  assert.equal(list[0].args[list[0].args.indexOf('--search') + 1], 'merged:>2026-03-13T09:00:00+00:00')
  assert.equal(fs.readFileSync(layout.gate2Index, 'utf8'), 'example/f0.ts\t1300\t2026-03-14T00:00:00Z\tlater 1300\n')

  // an explicit `since` wins over the anchor, and a list failure removes the index rather than leaving a stale one
  listReply = { code: 1, stderr: 'HTTP 503' }
  const forced = bundle([5], sweepDir, { run: gh.run, repo: REPO, since: '2026-03-14' })
  assert.equal(forced.ok, false)
  assert.deepEqual(forced.skipped, [5])
  assert.deepEqual(forced.errors, [{ pr: null, error: 'gate-2 index: gh pr list --state merged --limit 200: exit 1 — HTTP 503' }])
  assert.equal(fs.existsSync(layout.gate2Index), false, 'a failed index is removed, never left stale')

  // nothing anchors the window (a view with neither date): the index is not written — a worker reads
  // only the disk, and an empty file would say "nothing merged since" — and the sweep is not ok
  listReply = { stdout: JSON.stringify([listItem(1300, ['example/f0.ts'], '2026-03-14T00:00:00Z')]) }
  bundle([5], sweepDir, { run: gh.run, repo: REPO }) // a good index back on disk first, to show it goes
  assert.equal(fs.existsSync(layout.gate2Index), true)
  const before = gh.calls.length
  const unanchored = bundle([6], sweepDir, { run: gh.run, repo: REPO })
  assert.equal(unanchored.ok, false)
  assert.deepEqual(unanchored.gate2, { since: null, count: 0, rows: 0, limit: null })
  assert.deepEqual(unanchored.errors, [{ pr: null, error: 'gate-2 index: nothing anchors the window — no bundled PR carries mergedAt or createdAt, and no since was given' }])
  assert.ok(gh.calls.slice(before).every(c => c.args[1] !== 'list'), 'no date, no list query')
  assert.equal(fs.existsSync(layout.gate2Index), false, 'absent, never empty')
  assert.equal(fs.readFileSync(layout.openIndex, 'utf8'), 'example/f0.ts\t6\tPR 6\nexample/f1.ts\t6\tPR 6\n', 'the open index is still written')
})

test('bundle: a sweep-wide gate-2 window past the search ceiling is split, and the index carries every half — a wide worklist once left every worker with no gate 2', t => {
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'))
  t.after(() => fs.rmSync(sweepDir, { recursive: true, force: true }))
  const layout = bundleLayout(sweepDir)
  const search = args => args[args.indexOf('--search') + 1]
  const page = (args, first, count, day) => {
    const limit = Number(args[args.indexOf('--limit') + 1])
    return { stdout: JSON.stringify(Array.from({ length: Math.min(limit, count, SEARCH_CEILING) }, (_, i) => listItem(first + i, [`example/w${first + i}.ts`], `2026-0${day}-01T00:00:00Z`))) }
  }
  const gh = scripted((argv, args) => {
    // the earliest PR merged months before the latest: 1400 PRs merged in between
    if (argv.startsWith('gh pr view 100 ')) return { stdout: viewJson(100, { createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 100')) return { stdout: 'diff --git a/example/f0.ts b/example/f0.ts\n' }
    if (argv.startsWith('gh pr view 2000 ')) return { stdout: viewJson(2000, { createdAt: '2026-05-01T00:00:00Z', mergedAt: '2026-05-02T00:00:00Z' }) }
    if (argv === pinned('gh pr diff 2000')) return { stdout: 'diff --git a/example/f1.ts b/example/f1.ts\n' }
    if (!argv.startsWith('gh pr list ')) return undefined
    if (search(args) === 'merged:>2026-01-02T00:00:00+00:00') return page(args, 101, 1400, 3)
    if (search(args) === 'merged:2026-01-02T00:00:00+00:00..2026-03-03T00:00:00+00:00') return page(args, 101, 700, 2)
    if (search(args) === 'merged:2026-03-03T00:00:00+00:00..2026-05-02T00:00:00+00:00') return page(args, 801, 700, 4)
  })
  const r = bundle([100, 2000], sweepDir, { run: gh.run, repo: REPO, until: '2026-05-02T00:00:00Z' })
  assert.deepEqual(r.errors, [])
  assert.equal(r.ok, true)
  assert.deepEqual(r.gate2, { since: '2026-01-02T00:00:00+00:00', count: 1400, rows: 1400, limit: 800 })
  const rows = fs.readFileSync(layout.gate2Index, 'utf8').split('\n').filter(Boolean)
  assert.equal(rows.length, 1400)
  assert.ok(rows.includes('example/w101.ts\t101\t2026-02-01T00:00:00Z\tlater 101'), 'the first half is in the index')
  assert.ok(rows.includes('example/w1500.ts\t1500\t2026-04-01T00:00:00Z\tlater 1500'), 'the second half is in the index')
  assert.equal(gh.calls.filter(c => c.args[1] === 'list').length, 10, '4 for the whole window (200 → 1600), 3 per half')
})

test('bundleLayout and the worker brief spell the same bundle paths — a brief that points at a file the bundle never writes reads a missing index as "nothing"', () => {
  const stateDir = path.join(path.sep, 'state')
  const sweep = sweepLayout(stateDir, 'ABC-1234', process.platform)
  const brief = sliceLayout(stateDir, 'ABC-1234', 'a', process.platform)
  const b = bundleLayout(sweep.dir)
  assert.equal(b.dir, sweep.sweep, 'contract §4: _sweep/ under the sweep dir')
  assert.deepEqual([b.prs, b.gate2Index, b.openIndex], [brief.prs, brief.gate2Index, brief.openIndex])
})
