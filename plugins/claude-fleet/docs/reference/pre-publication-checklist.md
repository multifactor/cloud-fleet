# Pre-publication checklist

The ordered, mechanical list a human runs before flipping this repository public. Run it top to
bottom in one sitting. Every step is a command whose output you read, or a judgement no command can
make; steps 1–3 are cheap and fail loudly, so run them first and stop on the first failure.

Working directory for every `npm` command below is `plugins/claude-fleet`. Repository-root commands
are marked.

> ⛔ **Read [Unresolved blockers](#unresolved-blockers) before anything else.** As of the scan
> recorded at the bottom of this file, this repository is **NOT clear to publish**: the git history
> carries the material the working tree was cleaned of. That is not fixable by editing a file, and
> nothing in steps 1–6 or 8–12 detects it, because every one of those gates reads the working tree.
> **Only step 7 sees it, and only if you run it.**

---

## Unresolved blockers

### BLOCKER 1 — git history publishes the plaintext denylist

Early commits carry a version of `plugins/claude-fleet/docs/reference/contract.md` in which the
redaction denylist is written out **in plain text**, before it was replaced by the hashed fixtures.
Those blobs name, verbatim, essentially the whole of what
`test/fixtures/redaction-{exact,proper}.txt` exists to keep hashed — identifiers, people, the
company's domain, its email shape, and the phrase that discloses what the source product is.

The blob and commit SHAs, the count, and the shapes are deliberately **not written down here.** They
are a working index to the plaintext, and this file ships in the published tree; step 7 finds all of
it from a clean checkout in one command, which is how it was found in the first place. Run step 7 and
read its output privately.

It was redacted in the working tree by the commit that added the prose gates. Every commit before that
still contains it, and `git clone` ships all of them. `git log -p`, `git cat-file`, and GitHub's own
blob and compare views all expose it without effort.

**Disposition: unresolved. Requires a history rewrite, and that is the operator's decision.** There is
no edit to any file that fixes it. The two realistic options:

- **Squash to a single root commit** (`git checkout --orphan public && git commit && git branch -M
  main`) — simplest, and the history has no external value yet: 20 commits, one author, no forks, no
  published releases, nothing referencing a SHA.
- **`git filter-repo --path plugins/claude-fleet/docs/reference/contract.md --invert-paths`** followed
  by re-adding the current file, if the rest of the history is worth keeping.

After either, re-run the history scan in step 7 and confirm it is clean **before** the repository is
made public. A history rewrite after publication does not help: clones and GitHub's cached views keep
the old objects.

### BLOCKER 2 — git history carries a contributor's absolute path and the source repo's directory name

A historical blob of `plugins/claude-fleet/src/config/paths.mjs` carries a comment reading
`Verified against real directories: <Windows drive path> → …`, which names both a contributor
machine's absolute path and the source checkout's directory name. It is present in a long run of
consecutive commits. **Fixed in the working tree; still in history.** SHAs withheld for the same
reason as BLOCKER 1 — step 7 prints them. Same remedy as BLOCKER 1, and the same rewrite clears both
at once.

### OPEN QUESTION — the pattern fixture still publishes five denied strings

`test/fixtures/redaction-patterns.txt` is, by design, readable regexes. **Five** of them spell out what
they deny, and their own `why` column says so. Rows are keyed by that `why` column rather than by line
number, so this table cannot go stale when the fixture is reordered:

| its `why` column reads | why that is a leak |
| --- | --- |
| "discloses what the source product is" | it is the product category, in plain text |
| "the source project's dev host convention" | a private dev-host convention (contract §1: infrastructure) |
| "a source-repo directory" (three separate patterns) | names a private source path |

Read the file itself for the exact strings; they are not repeated here, for the same reason they should
not be in the fixture. Three token-shaped siblings (the company domain, the real issue-key prefix, and
four employees' first names) were removed in this scan and replaced by hashes — see
[Findings](#findings), F1. These five cannot be, because the hash check runs over single tokens and
every distinctive word in them is a generic English or filesystem word on its own. Keeping them
publishes the product category and a dev-host convention next to a `LICENSE` that names the company.

**RESOLVED — the approval bot.** A sixth row named a third-party review bot. This checklist previously
said to hash it, "no mechanism change needed, do this one regardless of what is decided about the
rest". ⛔ **That advice was wrong twice over, and acting on it would have broken the build.**

- Its distinctive token is a common English word this codebase uses nine times as the pagination
  concept (`capabilities.findComplete: cursor`, "follow the cursor" in three adapters). Hashing it
  would have made the gate deny every one of them.
- The row could not match anything anyway. It ended `\]\b`, and `\b` after `]` asserts a boundary
  against a NON-word character — so it fired only when a word character followed the handle, never on
  a bare one. It published a vendor name in the file that exists to prevent leaks, and denied nothing.

Replaced by the SHAPE `\w+\[bot\]`, which names no vendor and catches *any* bot handle — strictly more
coverage, no mechanism change. `docs-redaction.test.mjs` now asserts **every** pattern matches one of
its own probes and refuses a row that has none, so an inert guard cannot ship again.

**Decide the rest before publishing:**

1. Teach `tokensOf` / the gate a hashed **bigram** check, then hash the product-category phrase and the
   dev-host convention and delete the plaintext lines. Correct, and it is a change to the enforcement
   mechanism, so it needs its own review.
2. Accept the three "a source-repo directory" patterns — conventional monorepo directory names that
   identify nothing — or hash them too.
3. If any of the five is kept, record here explicitly what is considered publishable and why.
---

## The checklist

### 1. Confirm the working tree is the tree you mean to publish

```bash
# repository root
git status --porcelain --untracked-files=all
git log --oneline -1
```

Nothing uncommitted, nothing untracked. **An untracked file that is not ignored is a file that will be
committed by the next person and published without ever having been scanned** — during the scan below,
21 such files existed, including the CLI, the supervisor and the cloud dispatcher. Record the SHA you
are certifying; everything after this step is a statement about that SHA and nothing else.

### 2. The two prose gates

```bash
npm run lint:redaction
```

Eleven tests. This is the gate that fails a build on a leaked name. Know its blind spots before you
trust it: it reads `.md` and `.txt` under `playbooks/`, `docs/`, `commands/` and `trackers/`, plus
`README.md`, `CONTRIBUTING.md` and `SECURITY.md` at the repository root. **It does not read** source
files, test fixtures, JSON, `.ps1`, `.yml`, git history, or any prose in a new top-level directory —
`blog/` appeared during this scan and is not covered by anything.

### 3. A fresh, complete test run

```bash
npm test          # node --test
```

Read the totals, not the exit code alone. Two things to know about this suite:

- **It is not deterministic on a loaded machine.** The suites that spawn real processes, bind real
  ports and drive real worktrees — `test/backend-conformance.test.mjs`, `test/supervisor.test.mjs` and
  `test/cli-lifecycle.test.mjs` — fail sporadically when `node --test` runs them in parallel with
  everything else. Two consecutive full runs while this step was last re-measured gave 4 failures and
  a larger spread, in `backend-conformance` and `cli-lifecycle` both times. **All three pass in
  isolation** (`node --test test/backend-conformance.test.mjs`, and the same for the other two: 19/19,
  and 26/26 for `cli-lifecycle`). So: if a run fails, re-run the failing file alone before believing
  it — and do not let that habit quietly become "re-run until green", which is how a real regression
  ships.
- **Verify that list rather than trusting it.** It is a snapshot of which files were parallelism-
  sensitive on one machine on one day, not a property of the suite. A failure in a file not named here
  is real until you have watched it pass alone; a failure in one that *is* named here is real too if
  it still fails alone. The rule is "isolate, then believe", never "it is on the list, so ignore it".
- **CI has not seen this yet.** The `unit` job runs `npm test` across 9 OS/Node combinations, on
  smaller and more contended machines than a developer box. Expect that job to go flaky as soon as
  these two files are committed, and consider giving them their own serial job the way
  `integration-tmux` has one.

### 4. Generated files are in sync

```bash
npm run schema:build
npm run commands:render
git diff --exit-code       # repository root; any diff means a generated file was hand-edited
```

`schema/fleet.config.schema.json` is generated from `src/config/schema.mjs`, and `commands/*.md` from
the playbooks' front matter. A hand-edited generated file is how a stale description ships.

### 5. Secret scan

```bash
# repository root, over tracked AND untracked files
FILES=$(git ls-files --cached --others --exclude-standard)

grep -nE 'ghp_[A-Za-z0-9]|github_pat_|gho_|ghs_|ghu_|sk-[A-Za-z0-9]{8}|AKIA[0-9A-Z]{8}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10}|-----BEGIN|_authToken|glpat-|AIza[0-9A-Za-z_-]{10}|Bearer [A-Za-z0-9]' $FILES

grep -nEi '(postgres|postgresql|mysql|mongodb|redis|amqp)://|://[^ /"]*:[^ /"]*@' $FILES

grep -nE "['\"][A-Za-z0-9+/_=-]{28,}['\"]" $FILES
```

Every hit needs a disposition, not a glance. Never paste a hit into a ticket, a commit message or a
chat: describe it as *"\<kind\>, first 4 characters and length"*.

### 6. Denylist scan over every file type

The gate covers prose. This covers everything else — source, tests, fixtures, JSON, PowerShell, YAML.
Apply the same hashed denylist the gate uses to every file `git` will publish:

```bash
# repository root. --input-type=module is required: below Node 22.7 stdin is parsed as CommonJS and
# this script dies on its first `import`, and `engines.node` is >=20.
node --input-type=module - <<'EOF'
import fs from 'node:fs'; import path from 'node:path'
import { execFileSync } from 'node:child_process'; import { createHash } from 'node:crypto'
const FIX = 'plugins/claude-fleet/test/fixtures'
const h = s => createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 16)
const set = f => new Set(fs.readFileSync(path.join(FIX, f), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')))
const EXACT = set('redaction-exact.txt'), PROPER = set('redaction-proper.txt')
const PATS = fs.readFileSync(path.join(FIX, 'redaction-patterns.txt'), 'utf8').split(/\r?\n/)
  .filter(l => l.trim() && !l.startsWith('#')).map(l => { const [f, p, w] = l.split('\t'); return { f, p, w } })
for (const file of execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')) {
  let t; try { t = fs.readFileSync(file, 'utf8') } catch { continue }
  const self = /redaction-\w+\.txt$/.test(file)
  for (const { f, p, w } of PATS) { let rx; try { rx = new RegExp(p, (f || '') + 'g') } catch { continue }
    if (rx.test(t)) console.log(`${self ? 'SELF' : 'HIT '} ${file} /${p}/ ${w}`) }
  const seen = new Set()
  for (const tok of t.match(/[A-Za-z][A-Za-z0-9]*/g) || [])
    if (EXACT.has(h(tok)) && !seen.has(tok.toLowerCase())) { seen.add(tok.toLowerCase())
      console.log(`${self ? 'SELF' : 'HIT '} ${file} denied identifier "${tok.slice(0, 2)}…" (${tok.length} chars)`) }
  const rx = /(^|[^\s>#*\-|])[ \t]+([A-Z][a-z]{2,})\b/gm; let m
  while ((m = rx.exec(t))) if (!'.!?:'.includes(m[1]) && PROPER.has(h(m[2])))
    console.log(`${self ? 'SELF' : 'HIT '} ${file} proper noun "${m[2]}"`)
}
EOF
```

Expected output is the publishing-organisation exemption and nothing else. Every `HIT` on a file that
is **not** `LICENSE`, the two `.claude-plugin` manifests, or the `README.md` install command is a
finding. `SELF` lines are the fixtures matching themselves.

Then the shapes the hashed list cannot express:

```bash
# re-declared here so this block runs standalone; without it the greps below read stdin and hang
FILES=$(git ls-files --cached --others --exclude-standard)

# real issue keys — everything should be ABC-, GH-, or XYZ-
grep -hEo '\b[A-Z][A-Z0-9]{1,9}-[0-9]+\b' $FILES | sort -u

# absolute contributor paths — `ada` is the sanctioned placeholder person
grep -nEi 'C:\\Users|C:/Users|C:\\projects|C:/projects|/Users/[a-z]|/home/[a-z]' $FILES | grep -vE '/home/ada|/Users/ada'

# every host the repository names
grep -hoEi 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' $FILES | sed -E 's#(https?://[^/]+).*#\1#' | sort -u
```

Every host must be `example.com`-family, `localhost`/`127.0.0.1`, a public vendor documentation URL an
adapter legitimately cites, or `github.com/acme/app`.

### 7. Git history scan — the one nothing else does

Every step above reads the working tree. `git clone` ships the objects. Scan them:

```bash
# repository root — the same script as step 6, over every reachable blob
git rev-list --objects --all | while read sha rest; do
  [ -n "$rest" ] || continue
  git cat-file -p "$sha" 2>/dev/null | grep -qiE '<the strings you are guarding>' && echo "$sha $rest"
done
```

In practice, run the step-6 Node script with its file list replaced by `git rev-list --objects --all`
and `fs.readFileSync` replaced by `git cat-file -p <sha>`; that is exactly how BLOCKER 1 and BLOCKER 2
were found, and neither is visible from the working tree.

```bash
# secrets that were committed and later deleted
git log -p --all | grep -nE '^\+.*(ghp_|github_pat_|sk-[A-Za-z0-9]{12}|AKIA[0-9A-Z]{8}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|_authToken)'
```

A hit here is a blocker, and the only fix is a history rewrite before publication.

### 8. Authorship

```bash
# repository root
git log --format='%an <%ae>' | sort | uniq -c
git log --format='%cn <%ce>' | sort | uniq -c
git log --format='%B' | grep -iE 'co-authored-by|signed-off-by' | sort | uniq -c
```

Every address must be one the author is content to publish — a `@users.noreply.github.com` address, or
a genuinely public one. A personal or corporate address on the history blocked a previous attempt.
Check the trailers too, not only the author line.

### 9. Outbound network calls in code

```bash
grep -rnE "\bfetch\(|node:(http|https|net|dgram|tls)|XMLHttpRequest|WebSocket|axios|undici|got\(" plugins/claude-fleet/src plugins/claude-fleet/bin plugins/claude-fleet/hooks plugins/claude-fleet/scripts
```

Read every hit and confirm each target is the operator's own configured tracker, forge, dev server or
declared service. **There must be no telemetry, no analytics and no phone-home**, and if this command's
output ever grows a host that is not something the operator configured, that is a blocker regardless of
intent. Cross-check the result against the *What talks to the network* section of `SECURITY.md` and
correct that section if it has drifted.

### 10. Read the field notes yourself — no gate replaces this

```bash
grep -c '^### ' plugins/claude-fleet/docs/field-notes.md
```

`test/docs-redaction.test.mjs` checks that every entry has a `**Saw:**` and a `**Rule:**` and that no
entry contains a *known* token. **It cannot tell whether a `Saw:` still lets a reader locate a real
defect in a real product.** That is the most serious category of leak in this repository and the only
one with no mechanical check, so a human reads the file end to end — all 153 entries — asking one
question of each:

> Does this `Saw:` let a stranger reproduce the **method** failure, or does it let them find a **real
> defect in a real product**?

Pay closest attention to the entries about security findings, refutations and severity — the ones under
*The two gates* — because those are the entries most likely to carry a residual mechanism.

There is a mechanical aid, but **its pattern is not written down here** — an alternation of the source
product's domain nouns is exactly the disclosure this step exists to catch, and committing it would
publish the vocabulary in the file that hunts for it. Build it in your shell, run it, and let it die
with the shell:

- Take the denied phrases from `test/fixtures/redaction-patterns.txt` and add the domain nouns of the
  source product — the words a stranger would use to describe what it does.
- **Make every term plural-tolerant** (`\bfoos?\b`, not `\bfoo\b`). This is not a nicety: with the
  singular-only form the one real hit in this repository, the field-note entry reported as F3 below,
  does not match, and a reader would close F3 as resolved on a clean result.
- Run it case-insensitively over `--include=*.md .` from the repository root, and do not paste it, the
  expanded pattern, or its hits into a ticket, a commit message or a chat.

Vocabulary specific to the source product's domain narrows what the product is, even when no name
appears. Any hit is a rewrite, not a discussion. A clean result from this aid proves nothing the manual
read above does not still have to prove.

### 11. Prose the gate does not cover

```bash
# repository root — every .md the gate's proseFiles() does not walk
git ls-files '*.md' | grep -vE '^(README|CONTRIBUTING|SECURITY)\.md$' | grep -vE '^plugins/claude-fleet/(playbooks|docs|commands|trackers)/'
```

Read each one by hand. At the time of this scan that list is `blog/parallel-qa-with-claude-code.md` — a
draft blog post about the private origin of the tool, i.e. exactly the highest-risk prose in the
repository, checked by nothing. Either extend `proseFiles()` in `test/helpers/prose.mjs` to cover it or
accept that it is reviewed manually, every time, forever.

### 12. Final pass

- `LICENSE` names the right copyright holder and year.
- `.claude-plugin/marketplace.json` and `plugins/claude-fleet/.claude-plugin/plugin.json` name the
  publishing organisation, and the `README.md` install command points at the real repository path.
  Those four places are the **only** sanctioned uses of that name (contract §1).
- `package.json` `dependencies` is still `{}`.
- `.gitignore` covers `.fleet/config.local.json`, `node_modules/`, `*.log` and the test-scratch paths.
- **Private vulnerability reporting is enabled** — Settings → Code security → *Private vulnerability
  reporting*. `SECURITY.md` names GitHub private security advisories as the **only** channel and tells
  reporters not to open a public issue; that setting is **off by default**, so if it is not on there is
  no Security-tab *Report a vulnerability* button and the policy points at nothing. Nothing in the
  working tree can verify this — open the Security tab and look.
- Re-run steps 2 and 3. Then publish.

---

## Scan record — 2026-09-04

Full pre-publication security re-scan of the whole repository.

**Scope.** Tracked and untracked-but-not-ignored files at commit `270fa10` ("fix(proc): one process with a
control character no longer blinds the whole snapshot"), plus every reachable git object.
Categories covered: credentials of any shape; the redaction denylist over every file type, not only
`.md`; anything that would let a reader reach a private system; unreleased product detail or a
described vulnerability of a real product; outbound network calls; commit authorship.

**Caveat on the baseline.** This repository was moving throughout the scan. It advanced four commits
to the certified SHA, gained a `blog/` directory, and gained a set of `src/cli/commands/` modules that
were still uncommitted when the scan closed. Every scan was re-run against the tree at the certified
SHA plus those uncommitted modules, which were checked for credentials, denied identifiers, absolute
paths, hosts and network calls and came back clean. **Anything landed after that is unscanned** — which
is the argument for running this checklist immediately before flipping the repository public, and not
once in advance.

**This record is already behind the tree.** The command modules have since been committed, along with
further work, and this checklist itself was untracked when it was written — which is exactly what step
1 condemns. Before certifying any SHA: commit everything you mean to publish (this file included),
re-run steps 2 and 6 over the result, then replace the scope paragraph above with the new SHA. A scan
record that names a SHA the tree has moved past is a statement about a repository that no longer
exists.

### Result

**Working tree: clean, with one fixture leak fixed during the scan (F1) and two items needing a
decision (F2, F3).**

**Git history: NOT clean. Two blockers, above, neither fixable by editing a file.**

### Findings

| # | file:line | severity | disposition |
| --- | --- | --- | --- |
| B1 | historical blobs of `docs/reference/contract.md` (SHAs withheld — step 7 prints them) | **blocker** | Unresolved. History rewrite required — see [BLOCKER 1](#blocker-1--git-history-publishes-the-plaintext-denylist). |
| B2 | historical blob of `src/config/paths.mjs` (SHAs withheld — step 7 prints them) | **blocker** | Unresolved. Same rewrite — see [BLOCKER 2](#blocker-2--git-history-carries-a-contributors-absolute-path-and-the-source-repos-directory-name). |
| F1 | `test/fixtures/redaction-patterns.txt:3,4,13` (pre-fix numbering) | high | **Fixed during this scan.** The file published, in plain text, three things the hashed fixtures exist to hide: a regex naming the source workspace's real issue-key prefix, a regex naming the company's internet domain, and an email regex alternating four employees' first names. They sat in the one file whose job is to catch exactly those strings, and no gate covers `test/fixtures/`. Removed all three lines. Added `sha256` prefixes for the two tokens not already in `redaction-exact.txt`, so no coverage is lost; the other four names were already hashed. Added a header rule saying a pattern that would have to spell out what it denies belongs in the hashed list instead. Coverage verified equal or better with a direct probe of the gate's own matcher: a key of that prefix, that domain, and all four `<name>@…` addresses are still caught — now case-insensitively and in any context, rather than only in the exact shape the deleted regexes matched. `npm run lint:redaction` passes; `redaction-exact.txt` holds 19 hashes (the assertion floor is 15). |
| F2 | `test/fixtures/redaction-patterns.txt` — the six rows keyed in the open question below | medium | **Unresolved — operator decision.** Six remaining patterns spell out what they deny: the phrase whose own `why` column reads "discloses what the source product is", a dev-host convention, an approval bot's vendor name, and three source-repo directories. Five are not mechanically fixable without a change to the gate's matching mechanism; the approval bot can be hashed today. See [Open question](#open-question--the-pattern-fixture-still-publishes-six-denied-strings). |
| F3 | `docs/field-notes.md:895`, `docs/field-notes.md:903` | medium | **Unresolved — operator decision.** The rewrite otherwise held: 153 entries were reviewed against the "method failure, not product defect" test and every vulnerability-shaped entry (the committed-key refutation, the out-of-bounds-read refutation, the two-security-claims entry, the security-shortlist entry, the silent-failure entry, the browser-probe severity entry) is clean — mechanism abstracted, no path, no product, no locator, and several are entries about findings that were *refuted*. The single residue is the empty-state entry, whose `Saw:` and `Rule:` each carry a four-item enumeration of what an empty state might assert. That is not a defect locator — the underlying pattern is generic — but the nouns in those enumerations are domain vocabulary specific to the source product, and naming the category is precisely what the product-category phrase in the pattern fixture (F2, first row) exists to prevent. The strings are not quoted here for the same reason. Suggested edit: replace the two enumerations with a neutral example set. Left for the operator, because `field-notes.md` is declared append-only and its entries are not mine to rewrite. |
| F4 | `schema/fleet.config.schema.json:3`, `scripts/build-schema.mjs:27` | low | **Accept or extend the exemption.** Both carry the publishing organisation's name inside the schema's canonical `$id` URL. That is package-identity metadata in spirit, but contract §1 lists exactly four sanctioned places and these are not among them. Either accept them as identity metadata and amend §1 to say five, or change `$id` to a relative identifier. Same question, smaller, for `test/fixtures/redaction-allow.txt:6-8`, which necessarily quotes the repository address in order to allow it. |
| F5 | `blog/parallel-qa-with-claude-code.md` (whole file) | low | **Clean, but unguarded.** Scanned against the full denylist and against product vocabulary: no denied token, no real issue key (only `ABC-1234`), no URL, no absolute path, and the install snippet uses `<owner>/claude-qa-skills`. It does publish run metrics from the private origin (corpus sizes, open-issue counts, PR counts), which the redaction rules do not forbid. The finding is structural: `proseFiles()` does not walk `blog/`, so this file and any future sibling are checked by nothing. Covered by checklist step 11. |
| F6 | `test/config-load.test.mjs:197` | informational | **Accepted, no action.** A `GITHUB_TOKEN` fixture whose value is the literal string `ghp_secret` — a token-shaped prefix plus the English word, 10 characters, synthetic. Recorded because a third-party secret scanner may flag the prefix; it is not a credential. |
| F7 | `Co-Authored-By:` trailers | informational | **Confirm before publishing.** The history carries model-naming co-author trailers under three different model names, four commits under one of them. If any of those names is not public, a public git history discloses it. The names are not written here — run step 8, which prints them. Cheap to fix now (no forks) and impossible after; folds into the BLOCKER 1 rewrite at no extra cost. |
| F8 | `test/backend-conformance.test.mjs`, `test/supervisor.test.mjs`, `test/cli-lifecycle.test.mjs` | informational | **Known; not a publication blocker, but fix it before the flakiness teaches anyone to re-run until green.** All three spawn real processes, bind real ports or drive real worktrees, and all fail sporadically when `node --test` runs them in parallel with the rest of the suite; consecutive full runs gave different failure counts in different places. All three pass in isolation. CI's `unit` job runs `npm test` on 9 contended runners and will inherit this. Covered by checklist step 3, whose file list is a snapshot to re-verify, not a whitelist. |

### Clean categories

- **Credentials.** No `ghp_`/`github_pat_`/`sk-`/`AKIA`/`xox`/`eyJ` token, no `-----BEGIN` block, no
  `_authToken`, no `Bearer` literal, no `glpat-`/`AIza` key, no password and no connection string in
  any tracked or untracked file, and none in any historical blob. The only connection string in the
  repository is `postgres://postgres:postgres@127.0.0.1:5432/app` in a cloud-capture example, which is
  a documented throwaway generated by the sandbox bootstrap.
- **Issue keys.** Every issue-key-shaped token in the repository is a sanctioned placeholder:
  `ABC-*`, `GH-*`, `XYZ-9`. The remainder are regex and format artefacts (`Z0-9`, `UTF-8`, `UTF-16`,
  `RELEASE-2`, `OP-11`, `SESSION-3`) — every hit the step's own grep returns is accounted for here.
- **Absolute paths.** Every machine path uses the placeholder person `ada` — `/home/ada`,
  `/Users/ada`, and a Windows home path whose user segment is `ada`. Neither Windows absolute-path
  shape the pattern fixture denies occurs in the working tree.
- **Reachable private systems.** Every host named in the repository is an `example.com`-family
  placeholder, `localhost`/`127.0.0.1`, `github.com/acme/app`, the publishing repository itself, or a
  public vendor documentation URL an adapter legitimately cites. No internal hostname, no non-public
  URL, no private repo path, no workspace or project identifier. No infrastructure or vendor name
  appears in any prose file.
- **MCP tool identifiers.** Every `mcp__*` identifier is either a public vendor server named on an
  adapter's `Call:`/`Transport:` line, where `playbook-brands.test.mjs` permits it, or a placeholder
  (`mcp__example__`, or a single-letter stand-in in a unit test). No private MCP server is named.
- **Outbound network calls.** Two, both to operator-configured targets: a credential-free `GET` status
  probe of the configured dev-server URL (`src/supervisor/checks/slots.mjs:450`) and a TCP connect to
  a declared container's health port, default `127.0.0.1`
  (`src/supervisor/checks/services.mjs:121`). Nothing else in `src/`, `bin/`, `hooks/` or `scripts/`
  imports `node:http`, `node:https`, `node:net`, `node:dgram` or `node:tls`; there is no `fetch`, no
  WebSocket and no HTTP client library in the tree. **No telemetry, no analytics, no phone-home.**
  Every other network effect is a program the operator already had — `git`, `gh`, the tracker MCP, the
  cloud CLI, the project's own `commands.*`.
- **Commit authorship.** All 20 commits are authored *and* committed by one identity using a
  `@users.noreply.github.com` address. **No personal or corporate email address appears anywhere in
  the history** — the blocker from the previous attempt is resolved. The author's real name is on
  every commit, which is normal for a public repository and is the one place the "name no person" rule
  is deliberately not applied; confirm that is intended. Trailers: see F7.

### Actions before publishing

1. Resolve BLOCKER 1 and BLOCKER 2 with a history rewrite, then re-run step 7. **Nothing else matters
   until this is done.**
2. Decide F2 (the **five** remaining plaintext patterns — the sixth is resolved above) and F3 (the
   field-note vocabulary).
3. ~~Decide F4~~ — **resolved**: contract §1 now names all six sanctioned files (it claimed four and
   said "nowhere else", which was untrue of its own tree), and the exemption is enforced over every
   tracked file rather than left to authors. ~~F7~~ — **resolved by the rewrite**: the history is two
   commits, both naming one public model.
4. ~~Extend `proseFiles()` to cover `blog/`~~ — **done**: the gate walks `blog/` (`test/helpers/prose.mjs`).
5. Re-run steps 2 and 3 and confirm both are green on the rewritten history.

> **Addendum, 2026-09-08.** The scan record above is a record of one scan and its numbers are left as
> they were measured. Since then the history has grown from 20 commits to 41, and both blockers were
> re-confirmed live on that larger history — BLOCKER 1's blobs are introduced in commits that are
> ancestors of `main`, so a squash of the feature branch does not reach them and the rewrite has to
> cover `main` itself.
