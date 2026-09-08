# Contributing

This repository is the marketplace `claude-qa-skills` and the one plugin it ships, `claude-fleet`.
Everything below is about that plugin: where its parts live, how to run its tests on a bare clone,
which files are generated, and the two gates that decide whether your prose may be published.

Read [`plugins/claude-fleet/docs/reference/contract.md`](./plugins/claude-fleet/docs/reference/contract.md)
before you change anything. It is the single vocabulary — names, config keys, the 27 tracker
operations, the CLI surface, the state layout, and the prose rules. **If a playbook, adapter, module
or doc disagrees with the contract, the contract wins and the other file is the bug.** Do not invent a
config key, a CLI subcommand, a flag, an environment variable or an operation that the contract does
not define; propose the addition to the contract in the same pull request, and say so in the
description.

## What exists today

Be clear-eyed about the state of this repository before you plan an afternoon around it.

**You cannot run a fleet end to end yet — but nearly everything under the CLI is built, the command
surface now included.** Two facts about a command module are easy to conflate, and only the second one
decides whether you can type the verb:

- **On disk.** `src/cli/commands/` holds nineteen modules — `config`, `doctor`, `up`, `add`, `status`,
  `down`, `relaunch`, `attach`, `watch`, `pool`, `flag`, `outbox`, `ticket`, `session`, `slots`,
  `intake`, `send`, `kill`, `assets`.
- **Dispatching.** A module reaches `src/cli.mjs` only through the `MODULE_FILES` table in
  `src/cli/registry.mjs`. All nineteen are listed there today, so all nineteen dispatch; a finished
  module left out of that table is invisible however complete it looks.

Three verb groups of contract §7 have no module yet — `trackers`, `cloud` and `check …` — and answer
`unknown command` with exit 2. Verify all of that rather than trusting this paragraph, which goes
stale faster than the code does: `node bin/claude-fleet.mjs --help` prints exactly what dispatches
today.

- **Built and tested** — the config layer (schema, defaults, layered resolution with scope
  enforcement, derivation, validation, the env layer, the on-disk loader and the machine probe); the
  system primitives (process trees, kill safety, the mkdir-mutex resource pool, snapshots, the TSV
  ledger, the YAML subset); the core (registry and reconciler, worktrees, paced installs, install
  pacing, seeded prompts, intake); the session shim; all four terminal backends (Windows Terminal,
  PowerShell, tmux, `none`) plus the `fake` one the conformance suite drives; the session hooks; the
  supervisor loop and its seven checks; the four watchers (reclaim, stalls, autowave, guardian);
  cloud dispatch; the tracker registry, outbox and offline ticket cache; the twelve `/fleet-check`
  modules; and both generator scripts.
- **Written and enforced** — all six playbooks, the five bundled tracker adapters and the template
  they are written from, the contract, the trap catalogue and the field notes. These are still the
  product's actual content: the operating rules the modules load rather than reimplement.
- **Not written** — everything marked `·` in the tree below: the `trackers`, `cloud` and `check …`
  command modules, `src/core/layout.mjs`, `src/sys/notify.mjs`, `extras/windows/*.ps1` and
  `docs/case-studies/`.

So the useful contributions right now are: `src/core/layout.mjs`, `src/sys/notify.mjs`,
`extras/windows/*.ps1` and `docs/case-studies/`; one of the three command modules that are genuinely
absent — run `--help` before you start, so you do not rewrite a verb that already dispatches; adding
or correcting a tracker adapter; correcting a playbook or a doc; and adding a test that encodes a real
failure. All of those are verifiable today.

## Repository layout

`✔` exists · `·` not written yet.

```
claude-qa-skills/
  .claude-plugin/marketplace.json                                  ✔
  LICENSE (MIT) · README.md · CONTRIBUTING.md · SECURITY.md        ✔
  .github/workflows/ci.yml                                         ✔  unit · redaction · integration-tmux
  blog/parallel-qa-with-claude-code.md                             ✔  publishable prose that neither
                                                                      gate scans — reviewed by hand
  plugins/claude-fleet/
    .claude-plugin/plugin.json                                     ✔
    package.json                                                   ✔  bin claude-fleet, zero deps, node >= 20
    bin/claude-fleet.mjs                     → src/cli.mjs         ✔
    commands/fleet.md · commands/fleet-check.md                    ✔  GENERATED from the `command:` front
                                                                      matter of playbooks/launcher.md and
                                                                      playbooks/check.md
    hooks/hooks.json · hooks/block-git-stash.mjs · hooks/tab-title.mjs   ✔
    src/cli.mjs · src/cli/{args,plan,registry}.mjs                      ✔
    src/cli/commands/{config,doctor,up,add,status,down,relaunch,        ✔  each is one module in the
                      attach,watch,pool,flag,outbox,ticket,session,        registry's MODULE_FILES
                      slots,intake,send,kill,assets}.mjs                   table; `--help` is the
                                                                           authority, not this tree
    src/cli/commands/{trackers,cloud,check}.mjs                         ·  the three verbs of contract
                                                                           §7 with no module yet
    src/config/{schema,defaults,paths,load,resolve,derive,validate,env,probe}.mjs  ✔
    src/core/{fleet,worktree,install,pacing,prompts,intake}.mjs        ✔
    src/core/layout.mjs                                               ·  window placement lives inside each
                                                                         backend today (the `placeWindows` hook)
    src/backends/{types,index,fake,registry-first,tmux,windows-terminal,powershell,none}.mjs  ✔
    src/backends/wt-inject.ps1 · src/backends/ps-launcher.ps1 · tmux.conf (plugin root)       ✔
    src/sys/{proc,proc-windows,proc-posix,snapshot,kill,memory,lock,exec,tsv,yaml}.mjs        ✔
    src/sys/notify.mjs                                                ·  the watchers take an injected
                                                                         `notify` seam; nothing runs
                                                                         `notifications.command` yet
    src/session/shim.mjs                                               ✔
    src/supervisor/loop.mjs                                            ✔
    src/supervisor/checks/{orphans,rogue-servers,stale-locks,memory,sessions,services,slots}.mjs  ✔
    src/watchers/{reclaim,stalls,autowave,guardian}.mjs                ✔
    src/cloud/dispatch.mjs                                             ✔
    src/trackers/{registry,outbox,tickets}.mjs                         ✔
    src/check/{plan,worklist,ledger,fid,manifest,findings,checklist,   ✔
               reconcile,attach,brief,gate,gh}.mjs
    trackers/{_template,linear,jira,github,asana,trello}.md             ✔
    playbooks/{launcher,session,testing,cloud-capture,check,check-audit}.md   ✔
    docs/{gotchas,field-notes,operating-a-fleet,adding-a-tracker}.md          ✔
    docs/reference/contract.md                                               ✔
    docs/case-studies/                                                       ·
    schema/fleet.config.schema.json                                          ✔  GENERATED from src/config/schema.mjs
    scripts/{build-schema,render-commands}.mjs                               ✔
    test/*.test.mjs · test/fixtures/ · test/helpers/prose.mjs                 ✔
    extras/windows/{grid,retile}.ps1                                         ·  unsupported, not in CI; the
                                                                                directory is there and empty
```

Two consequences of that split are worth stating, because they are the reason the layout looks the
way it does:

- **Playbooks and adapters are loaded from disk at run time**, from `${CLAUDE_PLUGIN_ROOT}/…` with a
  project overlay at `<repo>/.fleet/playbooks/<name>.md` and `<repo>/.fleet/trackers/<id>.md`.
  Nothing is ever copied into the agent CLI's home directory, so there is no "keep three copies in
  sync" failure mode — and editing a playbook is a product change, not documentation.
- **Playbooks speak only in operation names** (`op-1` … `op-27`). An adapter is the only file allowed
  to name a tracker vendor or a tool. That rule is enforced by a test, not by review; see
  [The two prose gates](#the-two-prose-gates).

## Running the tests

You need **Node ≥ 20** and **git**. Nothing else. There is no install step, no lockfile, and no
`node_modules` — the plugin declares zero runtime dependencies and the suite uses only `node:test`
and `node:assert`.

```
cd plugins/claude-fleet
npm test                                     # node --test — the whole suite
node --test test/sys-lock.test.mjs           # one file
node --test --test-name-pattern 'kill'       # one slice
npm run lint:redaction                       # just the two prose gates
npm run test:integration                     # the same command; what makes it an integration run is
                                             #   FLEET_TEST_BACKEND=tmux in the environment (CI sets it)
npm run test:wt                              # the Windows Terminal conformance gate — Windows, local only
npm run schema:build                         # regenerate schema/fleet.config.schema.json
npm run commands:render                      # regenerate commands/fleet.md and commands/fleet-check.md
```

Those six `npm run` lines are every script in `package.json`; there are no others. The two bare
`node --test` invocations above are not scripts — they are the runner's own file and name filters, and
they take any path or pattern you like. The suite is **767 tests across 37 files** as this paragraph
is written (`npm test` prints the current total, and it grows with every module), it is green on a
bare clone, and it takes about a minute — the files that spawn real
processes (the backends, the shim, the hooks, worktrees and installs) dominate that, while the pure
ones are still milliseconds. A handful of tests **skip themselves** rather than lying: the real-tmux
and real-Windows-Terminal blocks wait for `FLEET_TEST_INTEGRATION=1`, and a POSIX-shell test skips on
Windows. If the suite is red on a fresh clone, the failure is in this repository, not on your machine.

**The principle behind that, and please keep it true:** a test brings its own world. It builds the
repository it needs in a temp directory, the "agent" it spawns is a `node -e` one-liner, and an
"install" is a sleep. Nothing in this suite reads a fixture captured from the private fleet this
plugin was extracted from, and nothing needs a tracker account, a forge login, a dev server or a
network. That is deliberate: the original is not published and never will be, so any test that
depended on it would be a test nobody outside could run. If you find yourself wanting a fixture from
a real system, write the smallest synthetic one that reproduces the *shape* of the failure instead —
the process-tree test does exactly this, with a ten-row fake snapshot that reproduces a
kill-by-exclusion incident — two of those rows are the whole point: the operator's own hour-old agent
sitting under the same terminal, and the scanner process whose own command line matches the pattern it
is scanning for.

The tests that do spawn real processes — eight of them racing a two-slot pool, the session shim, the
hooks, the terminal backends, cloud dispatch and the tracker stores — use `process.execPath` with
`-e`, so they need no build and no fixture binary either. They are also the whole of the suite's
runtime, which is why "keep the decision pure and inject the side effect" is a performance rule here
as much as a design one.

CI runs three jobs, all from `plugins/claude-fleet`:

| job | what it runs | where |
| --- | --- | --- |
| `unit` | `npm test` | ubuntu, macos and windows × node 20, 22, 24 |
| `redaction` | `npm run lint:redaction` | ubuntu, node 22 |
| `integration-tmux` | `npm run test:integration` with `FLEET_TEST_BACKEND=tmux` | ubuntu and macos, tmux installed by the job |

`npm run test:wt` is the Windows Terminal conformance suite (`test/backend-conformance.test.mjs`). It
exists and it runs — but only on a Windows machine with Windows Terminal, which is why it is not one
of the CI jobs; see [The Windows-only gate](#the-windows-only-gate). The same file drives every other
backend from one set of assertions: `FLEET_TEST_BACKEND` names the one backend a run demands, and
`FLEET_TEST_INTEGRATION` enables the rest. Its total is therefore not a fixed number, and this file
will not pretend otherwise — the nine conformance assertions run once per backend the run selects,
beside the one selection test, so a machine with no real terminal runs the `fake` and `none` pairs and
skips the rest, and a Windows box with Windows Terminal adds nine more. Let the runner print it.

## Generated files

Two files in the tree are generated. **Edit the source, never the generated file** — the generated
one is golden-tested, so drift fails CI rather than shipping.

| generated | source | script |
| --- | --- | --- |
| `schema/fleet.config.schema.json` | `src/config/schema.mjs` | `npm run schema:build` |
| `commands/fleet.md`, `commands/fleet-check.md` | the `command:` front matter of `playbooks/launcher.md` and `playbooks/check.md` | `npm run commands:render` |

The reasoning is the same in both cases: one fact, one place. `src/config/schema.mjs` is what the
loader actually resolves against, so a JSON Schema written by hand beside it would drift into a lie
the first time a default changed. A command file is the slash-command surface of a playbook, so it
belongs to the playbook that defines the behaviour rather than to a second file somebody has to
remember.

Both generators are written and both generated files are checked in, so the golden test is live:
`test/generated-files.test.mjs` re-renders each one in memory and asserts a **byte match** against
what is on disk — edit a source and forget to re-run its script, and CI tells you which script to run.
It also checks the schema carries every key with its scope and marks the one `secret` key, and that
the command renderer never emits a command that asks the operator a question.

Beside it, `test/config-resolve.test.mjs` keeps the schema itself honest against the contract: the
keys the contract names exist in `src/config/schema.mjs` with the contract's defaults, every entry has
a scope and a description, no leaf key is a prefix of another, and `tracker.rest.tokenEnv` is the only
`secret` key and is user-scope.

## The two prose gates

Prose in this repository is a product surface — a session reads a playbook and acts on it — so two
tests gate it. Both live in `test/` and both run in the `redaction` CI job. Read them before you
argue with them; each assertion is short and says why it exists.

### `test/playbook-brands.test.mjs` — the abstraction gate

It keeps "tracker-agnostic" true after ship day. Concretely, it asserts:

1. **No playbook names a tracker vendor.** `Linear`, `Jira`, `Atlassian`, `Asana`, `Trello` and
   `GitHub Issues` may not appear anywhere in `playbooks/*.md` outside a fenced ```` ```example ````
   block. The failure mode it prevents is quiet: name a vendor once and the next edit reaches for
   that vendor's field names, and a year later the playbook only works for one tracker.
2. **No playbook names an MCP tool identifier** (`mcp__…`).
3. **Every `op-<n>` cited by a playbook or an adapter is in 1..27.** No invented operations.
4. **Every adapter covers all 27 operations**: one `## op-<n>` section each, no duplicates, each with
   a `Call:` line and an `If unsupported:` line, and `## op-22` additionally with a `Strategy:` line.
5. **Adapter front matter is self-consistent**: `id` equals the filename; `issueKey.pattern` compiles,
   matches `issueKey.example`, and — in the case mode the adapter declares — matches none of `main`,
   `develop` or `release-2`. That last one is not pedantry: the same regex is what the launcher's
   reclaim watcher reads keys with, so a pattern that matches a branch name costs a real session.
   **The gate covers three of the seven branch shapes contract §3 requires**, and the four it does not
   are yours to check by hand: `testing.base`, `<testing.base>-2`, `check/<sweepId>/<slice>`, and a
   `vcs.branchTemplate` render with the key removed. That gap matters, because §3 names one of the
   missing ones as the whole reason `caseInsensitive: false` exists — case-insensitively,
   `[A-Z][A-Z0-9]+-[0-9]+` matches `testing-2`. Extending the loop in
   `test/playbook-brands.test.mjs` to the full corpus is a welcome pull request.
6. **An adapter body names a tool only on a `Call:`, `Transport:` or `Strategy:` line** (or in
   `listOp`, a heading, or a block quote). Adapters are the only place a tool may be named at all, and
   this is where.
7. **`trackers/_template.md` documents all 27 operations**, so a contributor starts from a complete
   contract.

The rest of the adapter checklist now lives in `test/tracker-registry.test.mjs`, which runs
`validateAdapter` from `src/trackers/registry.mjs` over every bundled adapter and the template. It
asserts the declared capabilities are present and in range, `priority.map` covers exactly 1..4 (and
that a `labels` priority scale is not declared on an adapter without labels), each of
`states.{in-progress,in-review,cancelled}.promptDefault` is set, every `config[]` entry has a key, a
prompt and a boolean `required`, every op 1..27 has exactly one section, an op whose capability says
*supported* carries a `Call:` line, every op carries an `If unsupported:` line, `op-22` carries a
valid `Strategy:`, and no section exists for an op outside 1..27.

Three things are still yours to check by hand: that a section belonging to a `false` capability really
reads as a degradation rather than a live `Call:` (the gate requires a `Call:` where a capability is
true, but does not forbid one where it is false), that each `promptDefault` is a state *name* rather
than an id, and that the sections run in numeric order.

### `test/docs-redaction.test.mjs` — the redaction gate

`claude-fleet` was extracted from an internal fleet that ran against one company's repository, one
tracker and one machine. The generic version is the only public one, and this gate is what keeps it
that way. It scans every `.md` and `.txt` under `playbooks/`, `docs/`, `commands/` and `trackers/`,
plus `README.md`, `CONTRIBUTING.md` and `SECURITY.md` at the repository root — including this file
you are reading. For each it asserts:

1. **No denied token appears.** Every word in the file is hashed and checked against
   `test/fixtures/redaction-exact.txt`.
2. **No denied pattern matches** — the shapes in `test/fixtures/redaction-patterns.txt`: an internal
   issue-key regex, an internal domain, a source-repo directory, an absolute machine path, an MCP tool
   identifier (adapters are exempt from that last one only).
3. **No denied proper noun is used as a proper noun.** A capitalised word that is *not*
   sentence-initial is hashed against `test/fixtures/redaction-proper.txt` — that is how an internal
   product or person name reads when it slips into a sentence.
4. **The denylist fixtures contain only hashes**, at least 15 exact and 5 proper, and the allowlist
   holds at most 5 entries.
5. **Every field note is well formed** — see [Field notes](#field-notes).
6. **No session-facing document hardcodes a path that must come from the session descriptor** —
   no `%TEMP%`, no `~/.claude/` other than `~/.claude/projects`. The three root documents and
   `docs/gotchas.md` / `docs/field-notes.md` are exempt: telling a human where their own settings file
   lives is correct documentation, and a gotcha may quote a symptom verbatim.

A hit anywhere outside a fenced ```` ```example ```` block fails the build.

**What the gate does not scan.** `blog/` is outside both gates — `proseFiles()` in
`test/helpers/prose.mjs` walks `playbooks/`, `docs/`, `commands/` and `trackers/` plus the three root
documents, and nothing else. `blog/parallel-qa-with-claude-code.md` is publishable prose all the same,
so it is **reviewed by hand**: apply every rule in this section to it yourself, in the pull request,
and say in the description that you did. Adding `blog/` to `proseFiles()` would close that hole and is
a welcome pull request.

**Why the denylist is hashed.** A published plain-text list of forbidden names would leak the exact
names it exists to guard — it would be the most concentrated disclosure in the repository, sitting in
a file called `redaction-exact.txt`. So the fixtures store `sha256(token.toLowerCase())` truncated to
16 hex characters, one per line, and the test hashes each token of each file to compare. Patterns that
describe a *shape* rather than a secret (an issue-key regex, an absolute Windows path) are safe to
read, so those stay verbatim in `redaction-patterns.txt` with a `why` column.

**To check a token you are unsure about**, hash it and grep the fixtures — you never need to know
what is on the list, only whether your word is:

```
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1].toLowerCase()).digest('hex').slice(0,16))" <token>
```

**If you believe a hit is a false positive.** The escape hatch is
`test/fixtures/redaction-allow.txt`, and it is deliberately uncomfortable: every string in it is a
hole in the gate, the test asserts the file holds at most five entries, and each entry needs a
comment above it justifying why the string must appear verbatim. Before you reach for it, try the two
cheaper fixes: rephrase (a denied word almost always has a generic synonym — that is the point of the
exercise), or move the offending sample into a fenced ```` ```example ```` block if it genuinely is an
example. Add an allowlist line only when the string is load-bearing and unavoidable — the
repository's own address is the canonical case — and say so in the pull request description so a
reviewer looks at it specifically.

## Field notes

`docs/field-notes.md` is the long-form record: a mistake that actually happened, the check that lied,
the check that worked, and the durable rule that came out of it. It is **append-only**, newest entry
at the bottom of its theme, title taken from the *symptom* rather than the cause, because the future
reader searches for what they can see. Never rewrite an entry; correct it by appending a new one that
cites it. When a note has been confirmed twice, or is severe enough to burn a run, it is promoted into
`docs/gotchas.md` and the playbook that owns it, and the note is marked `→ promoted` where it stands.

The format is contract §8 rule 7, and the redaction gate enforces its skeleton:

```
### !! <symptom, written as what you will see>
**Saw:** <the observation — what was on the screen, what the command printed>
**Cause:** <the diagnosis; a descriptive label instead of the bare word is fine>
**Rule:** <imperative; what to do next time, with the one sentence of why>
**Proof / Diagnostic / Also:** <optional — the command that distinguishes the two explanations>
```

`**Saw:**` and `**Rule:**` are **literal**: a reader scanning a hundred notes for "what is the rule?"
must always find it, in that spelling, in that order. The cause between them may carry a descriptive
label when that reads better than the bare word (`**It is an artifact of the workflow.**`) — but it
must be there, and the test requires it explicitly on any entry longer than eight non-empty lines.

**The editorial test — the one that decides whether an entry belongs at all:** *would this let a
session three weeks from now, with no memory of today, skip the diagnosis entirely?* If not, it is a
diary line, not a field note. The diagnostic path — which check lied, which one told the truth — is
the part worth keeping, and it only survives if it is captured while it is fresh, the turn something
blocks or surprises you, never at the end of a run when the summary has already eaten the detail.
Record refutations too: "my explanation was wrong; a clean restart with the dependency confirmed up
still failed" is worth more than silence, because the next person otherwise re-derives the same wrong
answer.

**Redaction, for notes specifically.** A `Saw:` must let a stranger reproduce the **method** failure
and must never help anyone locate a **product** defect. So: no source-repository paths (write
`<component>:<line>`, or a synthetic `example/…` tree), no real issue keys (ticket A and ticket B, or
`ABC-1234`), no product mechanism, no person, no company, no internal name, no absolute path from
anyone's machine, and dates as `2026-03-14`. Vulnerability-shaped entries keep only the **Rule** and a
fully synthetic **Saw** with no residual mechanism at all — if the note cannot be written that way, it
does not go in this file.

## Adding a tracker

A tracker is one markdown file and one pull request: YAML front matter the CLI reads, and a body the
session reads with one `## op-<n>` section per operation. Start from `trackers/_template.md`, which
documents all 27 operations and the invariants each one must honour, and follow
[`plugins/claude-fleet/docs/adding-a-tracker.md`](./plugins/claude-fleet/docs/adding-a-tracker.md) —
it walks the whole path from copying the template to a passing test run, spells out the three
operations where trackers really diverge (`op-22 attachImage`, the `op-26`/`op-27` work-list, and the
`op-23`/`op-24`/`op-25` relations), and cites the finished adapters as worked examples. `linear.md`
and `github.md` are the two to read first; `trello.md` is the one that stresses the abstraction
hardest, because a Trello card has no issue key, no status field and no children.

## Code style

**Zero runtime dependencies.** This tool spawns agent sessions with permission prompts disabled, so
it should be auditable in one sitting — by a reader who does not trust it yet. Every dependency added
here is code that runs with the operator's full credentials, at a moment when nothing will stop it and
ask. `dependencies` in `package.json` is `{}` and stays `{}`. Dev dependencies are unnecessary too:
`node:test` and `node:assert/strict` are the test framework.

**Pure core, thin side-effect edges.** The interesting logic — staleness, the kill plan, layer
precedence, priority normalisation, the gate verdict — is pure functions over plain data, and the
process spawning, file writing and tool calling sit in a thin shell around it. That is why most of the
suite runs in milliseconds with no mocks anywhere: `killPlan` takes a snapshot object and returns a
list, `killTree` is the only part that has to actually kill anything; `decide()` in `src/core/pacing.mjs`
takes an injected memory reading and returns a wave size, so the install-burst incident is a test case
rather than a comment. The minute the whole suite takes is spent almost entirely in the handful of
files that spawn real processes. When you add a module, ask which half each function belongs to, and
do not let a pure function grow an `fs` call.

**One test per real incident, not one test per function.** The suite's job is to keep paid-for
knowledge from being refactored away, not to reach a coverage number. Look at the existing names —
`isStale: timestamp only — a dead pid with a fresh heartbeat is NOT stale`; `session marker: exact
token match, never substring — session 7 does not match 70`; `descendants ignores a "child" whose
start time precedes its parent (pid reuse)`; `priority normalises across case, numbers and P-codes;
unknown throws (a lowercase "high" once hid a High)`. Each one is a specific way something went wrong,
frozen.

**A test that asserts a fixed behaviour says in a comment which failure it encodes.** If the assertion
is `assert.equal(x, 2)` and the reason is not in the name or in a comment beside it, the next
contributor cannot tell a deliberate constant from an accident, and will "fix" it. Put the incident in
the comment: the process-tree fixture, for instance, carries a note that pid 900 is the operator's own
hour-old agent sitting under the same terminal, and must never be touched.

**Match the file you are in.** Two-space indent, LF endings, single quotes and no semicolons in
`.mjs`, `.editorconfig` and `.gitattributes` are checked in. Anything platform-specific is stated for
both platforms or delegated to the CLI — never a PowerShell-only or bash-only recipe in prose (contract
§8 rule 6).

## Commit hygiene

Conventional Commits with a scope: `feat(config):`, `fix(lock):`, `test(prose):`, `docs(contract):`,
`chore:`. The subject line says what changed; **the body says why**, in prose, and that is the part
that matters here — this project's whole thesis is that a rule without its reason gets deleted by the
next person. Look at `fix(lock): an empty lock directory is HELD, and stealing is serialised` for the
shape: what was observed, what the cause was, what changed, and how it was verified.

- One logical change per commit. A generated file lands in the same commit as the source it was
  generated from.
- Before pushing: `npm test` **and** `npm run lint:redaction` from `plugins/claude-fleet`.
- If your change adds a rule to a playbook, keep its `⛔` and its one-sentence *why*; if it removes
  one, say in the commit body which incident you believe no longer applies.
- If you hit something surprising while working, append a field note in the same pull request. That
  is the cheapest moment it will ever be to write.

## The Windows-only gate

The Windows Terminal backend conformance suite (`npm run test:wt`) **cannot run on CI runners**: the
GitHub-hosted Windows image has no Windows Terminal and no interactive desktop session, and the
backend's whole job is to open tabs in one. The CI file says so in a comment where the job would
otherwise be, so nobody adds it back and watches it fail mysteriously.

That makes it an **author-verified local gate**. If you touch anything under `src/backends/`,
`src/session/`, `hooks/tab-title.mjs` or `extras/windows/`, run it yourself on a Windows machine with
Windows Terminal installed and say so in the pull request description — "ran `npm run test:wt` on
Windows 11 / Windows Terminal 1.x, N tests passing" — because no reviewer and no runner can check it
for you. The tmux backend has the mirror-image property and *is* covered: the `integration-tmux` job
installs tmux on ubuntu and macos and runs the suite with `FLEET_TEST_BACKEND=tmux`.

The same caution applies more loosely to anything touching process trees, junctions or path handling:
the unit matrix covers all three operating systems, so run the full suite before you push rather than
assuming your platform is representative.
