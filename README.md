# claude-qa-skills

QA skills for Claude Code, shipped as one plugin: **`claude-fleet`**.

`claude-fleet` fans out N isolated Claude Code sessions — one git worktree each, one ticket each — over a
shared pool of dev servers, with locks, a supervisor, crash recovery and a Push-PR flow (`/fleet`); and it
reviews pull requests for edge cases, filing each still-open gap as a *gated* ticket for the fleet to work
(`/fleet-check`). It is company-independent: it drives any repository that has a bootstrap command, any
issue tracker you have an MCP for (Linear, Jira, GitHub Issues, Asana, Trello — or none at all), on
Windows, macOS and Linux, and it configures itself on first run instead of assuming a pre-seeded machine.
Every spawned session is a full agent CLI — Claude Code by default (`fleet.agent`) — so the fleet can use
every skill and MCP tool you already have.

- [The pipeline](#the-pipeline)
- [Status](#status)
- [Platforms and requirements](#platforms-and-requirements)
- [Install](#install)
- [First run](#first-run)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Tracker support](#tracker-support)
- [Configuration](#configuration)
- [Safety rules](#safety-rules)
- [Provenance](#provenance)
- [Documentation](#documentation)
- [License](#license)

## The pipeline

```
 /fleet-check <PRs | KEY>          audit (always runs)           promotion                     /fleet
┌───────────────────────┐   ┌───────────────────────────┐   ┌──────────────────────────┐   ┌───────────────────────────┐
│ review each PR        │   │ every filed ticket is     │   │ a human promotes         │   │ intake accepts only       │
│ file one ticket per   │ → │ re-checked: false         │ → │ gate:passed tickets in   │ → │ gate:passed | gate:waived │
│ still-open gap, with  │   │ positive? duplicate?      │   │ the tracker UI or with   │   │ one worktree per session  │
│ the triage label and  │   │ structural twin? frame    │   │ /fleet-check promote     │   │ read → fix → screenshots  │
│ gate:pending          │   │ still real after filing?  │   │                          │   │ → PR → in-review          │
│                       │   │ → gate:<verdict> on each  │   │  …or checker.autoPromote │   │                           │
└───────────────────────┘   └───────────────────────────┘   └──────────────────────────┘   └───────────────────────────┘
        sweep files                  audit gates            human promotes | autoPromote          fleet works
```

Both halves share one config, one set of tracker adapters, one capture layer, one state directory and one
outbox. The gate is on by default: `/fleet-check` files with the triage label and `gate:pending` (and into
`checker.triage.state` when a project sets one), the audit writes a verdict onto every ticket, and
`/fleet`'s queue only takes *ready* tickets that carry `gate:passed` or `gate:waived`.
`checker.autoPromote: after-audit` collapses the human step — but never the audit, whose rules are
corpus-level and cannot run per wave.

## Status

**The fleet half runs. The sweep half runs as far as the wrap-up.** Read this section before you plan
an afternoon around the rest of the file.

`fleet up`, `fleet status` and `fleet down` are verified end to end against a scratch repository:
worktrees created and installed, sessions spawned and registered, processes killed deepest-first,
worktrees removed, leftovers swept. Every command contract §7 defines now has a module, and a test
asserts that in both directions — a verb the reference defines with nothing behind it used to reach
"unknown command", which sends an operator looking for a typo in their own invocation. `fleet --help`
lists exactly what is wired, and is the authority this paragraph is not.

`fleet check` now dispatches over those twelve modules: `plan` (which resumes when you retype the line
that started it), `worklist write`, `resume`, `slice`, `brief`, `ledger append|resume|reconcile`,
`fid mint`, `reconcile filed` and `status`. That is a `--mode local` sweep from its first PR to its
last, driven from the CLI rather than by hand.

The gate runs too: `gate status|apply` reads `audit/verdicts.tsv`, refuses a corpus it has not
finished scoring, and queues the evidence comment **before** the cancellation it explains;
`promote [--all|--fid|--min-priority] [--waive]` moves only what passed. `enum check` and
`blast-radius` are there for the audit.

`finish` closes a sweep, or refuses to: it repairs the ledger from the findings, checks the three
counts and the four counts, asks whether the base branch has moved under the sweep, and says the
audit is still owed rather than reporting "done".

`verify-citations` and `verify-paths` machine-check an audit's own evidence against the base branch —
and lead with a control that a known-good citation passes, a known-bad one is flagged, and a path that
cannot exist stays untestable. A control that only proved the file list had loaded once certified an
audit whose matcher was garbage and which reported every citation in its corpus as a phantom.

`frame derive|check` and `reconcile tracker` take the op-16 pages the model fetched and refuse a set
that is short before anything is subtracted from it — a page returning exactly its limit with no
completeness signal is truncated by definition, and every band must have been queried.

`dups cluster` runs the structural pass a similarity check systematically misses, and `harvest` pulls
a cloud run back from its results branch.

`audit plan` lays out the audit's three passes over a finished corpus — gate 1 by PR (so a worker
reads that PR's diff once), the consequence-driven pass over every Urgent, and the contradiction pass
by category — and refuses a corpus that is not finished, or a second run over one. It builds the
category batches from a `category` the findings carry and **never invents one**: where the corpus
records none, that is printed as a named gap rather than papered over, because a guessed taxonomy
would group tickets that share a word and do it silently.

**Every verb under `fleet check` now dispatches.** The one command still refusing **by name** is
`fleet cloud dispatch` — the loop over `src/cloud/dispatch.mjs`, which is itself written and tested.
It refuses rather than stubbing, because a dispatch that launched sandboxes and then failed to harvest
them would leave work on a results branch nobody reads.

The gates themselves are still judgement: workers follow `playbooks/check-audit.md` over the batches
and write `audit/verdicts.tsv`. Everything on either side of that file is code.

Two smaller things are configurable but unwritten, and say so where they are described: the idle
emulator reaper (`emulator.idleSeconds`) and the `notifications.command` runner. And `fleet doctor`
does not yet probe free physical RAM against `install.reservePhysicalGb`, whether `commands.bootstrap`
actually runs, or the Android SDK when `emulator.enabled` — check those three yourself.

Where this file describes something not yet enforced, it is marked. `CONTRIBUTING.md` carries the
path-by-path map, and `plugins/claude-fleet/docs/reference/contract.md` is the specification the
modules are written against.

## Platforms and requirements

| platform | terminal backend | notes |
| --- | --- | --- |
| Windows | **Windows Terminal** (`wt`) — one tab per session | `terminal.backend: auto` falls back to a plain console window when `wt.exe` is absent (`powershell`), announcing what it tried; the backend exposes a hook for pixel-grid tiling (`terminal.layout: pixel-grid`), but the `extras/windows/` scripts that would fill it are not written yet, so that layout degrades to plain windows with a notice |
| macOS / Linux | **tmux ≥ 3.0** — one window per session | the fleet runs on its own socket and config file (`terminal.tmux.socket`, default `fleet`) so it never shares your tmux server or inherits your prefix; it survives closing the terminal or an SSH drop, and `fleet attach` reconnects |
| any, headless | **`terminal.backend: none`** — no window at all | opt in explicitly; sessions are spawned detached with their output in `<stateDir>/logs/<label>.log`. There is nothing to type into, and it says so — a send answers "nothing was delivered, and here is why" rather than swallowing the message. This is the backend CI runs |

Everything else: **Node ≥ 20** and **git**. The plugin has **zero runtime dependencies** — a public tool
that spawns agents with `--dangerously-skip-permissions` should be auditable in one sitting. `gh` (or the
forge CLI you set in `vcs.pr.createCommand`) is needed for the Push-PR flow and for `/fleet-check` to read
PRs. Docker (`services.docker.required`), an Android emulator (`emulator.enabled`) and a cloud sandbox for
screenshots (`capture.mode: cloud`) are all optional and off by default. `fleet doctor` checks the machine,
and `fleet doctor --repair` fixes what it can on either platform.

## Install

In Claude Code:

```
/plugin marketplace add multifactor-apps/claude-qa-skills
/plugin install claude-fleet@claude-qa-skills
```

Then set the **user settings a plugin cannot set**, in your Claude Code user `settings.json` (it lives in
your Claude Code config directory; `CLAUDE_CONFIG_DIR` is honoured if you have moved it):

```json
{
  "skipDangerousModePermissionPrompt": true,
  "effortLevel": "xhigh",
  "theme": "dark"
}
```

- `skipDangerousModePermissionPrompt` — see the warning below. Without it every spawned window stops at a
  confirmation dialog and the fleet never starts.
- `effortLevel` — sessions inherit it; the playbooks are written for the highest effort.
- `theme` — sessions inherit it too, and the scratch review pages a session builds are dark-mode.
- Optional: `"enableAllProjectMcpServers": true` if your tracker MCP is declared in the repository's
  `.mcp.json` rather than in your user config, so spawned sessions inherit it without a prompt.

The model is **not** a user setting here — the fleet passes `--model <fleet.model>` (default `opus`)
explicitly to every session, so a machine default can never silently change what the fleet runs on.

> ⚠️ **WARNING — sessions run with `--dangerously-skip-permissions`.**
> Every session the fleet spawns is a Claude Code that **does not ask before running commands, editing
> files or calling MCP tools**. It acts as *you*: with your git identity, your `gh` login, your tracker
> MCP, your Docker daemon and anything else your shell can reach — in its own worktree and, in principle,
> anywhere else on the machine. `skipDangerousModePermissionPrompt: true` removes the last confirmation
> dialog; that is exactly why the plugin cannot set it for you — setting it is your consent.
>
> Before your first `fleet up`: read `.fleet/config.json` end to end (every `commands.*` entry runs
> unprompted, in every worktree), keep secrets out of the repository (see [Safety rules](#safety-rules)),
> list the paths sessions must not read in `vcs.sensitivePaths` (a *warning* to sessions and a hard
> exclusion for cloud workers — not a sandbox), and run the fleet only on a repository and a machine where
> you would accept an unattended engineer working with your credentials. The playbooks add guard rails (a
> hook blocks `git stash`; the supervisor kills servers that appear where they must not), but guard rails
> are not permission prompts.

## First run

`/fleet`'s first action on every run is `fleet config status --json` — a few hundred milliseconds and a
handful of read-only git calls, never writes, exits 0 even when unconfigured (this one you can run
today). It answers two independent questions, so a second run is never
re-interrogated: *is this project configured?* (a valid `.fleet/config.json`) and *is this machine
configured for this repository?* (an entry for the repo in your user config). When either is missing, the
**wizard** runs:

1. **Detection first.** `fleet config detect --json` proposes everything in one call: the bundled tracker
   adapters and the MCP tool prefixes each one declares — the CLI cannot see the launcher's tool list, so
   the *launcher* matches those prefixes against the tools visible in its own session, which is the only
   reliable connection check (a config file listing zero MCP servers says nothing about what is live
   in-session); bootstrap and dev-server commands ranked from `package.json` scripts; the default
   fixed-port dev URL template (a per-branch host is an operator answer, not a probe); the default health
   probes, with a prompt to point one of them at an API route, because a `/` that answers 200 proves only
   the frontend half is alive; containers from `docker-compose.yml`; the fleet size **with the arithmetic
   shown** (`floor((64 − 8) / 4) = 14, capped at 16 cpus`); your branch prefix from `git config user.name`;
   and the assignee stored as the sentinel `"me"` — the authenticated tracker user, never a name. Emulator
   slots are deliberately *not* probed — a second virtual device costs RAM the box usually has not got, so
   that pool is enabled by hand.
2. **One proposal table.** The project questions and the machine questions appear as a single table with a
   *source* column — "accept all, or tell me which to change". Only genuinely ambiguous items (the tracker
   scope, the URL domain, two dev scripts scoring within 0.15 of each other) get their own turn. Target:
   three turns for a first run, one turn for a teammate's new machine.
3. **Write through the CLI.** The wizard never writes config itself; it calls `fleet config init
   --from-json` (`--dry-run` shows the diff first). `init` **refuses to write user-scope keys into the
   project file** — that refusal is the enforcement point for company- and person-independence.

Three situations the wizard handles explicitly:

- **Tracker not connected** → the adapter's own install instructions are rendered verbatim, with its docs
  link, followed by three choices: connect now and re-check · run in `tracker.mode: manual` (every tracker
  transition is queued to the outbox for you to apply) · pick a different tracker.
- **Configured, but the MCP is gone on a later run** → warn once, offer manual mode for this run, and **do
  not block the launch** — every transition is recoverable through the outbox.
- **No tracker at all** → `tracker.mode: none` is a supported mode, not a degraded one. Sessions take a PR
  number, a branch or plain task text; state, assign and comment operations are skipped; `/fleet-check`
  still works, and gives its findings local ids that `/fleet-check promote` flips to ready.

Non-interactive use (`fleet up --no-wizard`) never prompts: it exits non-zero with
`{status, missing[], hint}`. A schema upgrade runs `fleet config migrate` and then asks **only** for
`missing[]`.

## Usage

`fleet <cmd>` below means `npx claude-fleet <cmd>` (inside a session the plugin runs it as
`node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <cmd>`). There is deliberately no bare `fleet` binary — other
tools already own that name. Every command takes `--json`, and every JSON payload starts `{"ok", "v": 1}`.

### `/fleet` — work tickets

```
/fleet                       open (or top up to) the default fleet — size derived from RAM and CPUs — plus the testing pool
/fleet 8 --testing 2         8 working sessions sharing 2 testing servers (the pool is 0..testing.maxSlots; more slots = a shorter capture queue)
/fleet --issues ABC-1234     resolve the issue's children (op-1) and open one session per child, each auto-starting its own;
                             no children → one session on the issue itself
/fleet --issues ABC-1234,ABC-1240        one session per key, in the order given
/fleet --add 2               add two sessions to a running fleet ("add another session" works too);
                             with issue keys, `--add k` must match the resolved issue count, so a
                             miscounted fan-out fails loudly instead of opening a session with no issue
/fleet --dry-run             print the session plan; touch nothing
/fleet --no-wizard           never prompt: if the config is not `ok`, exit non-zero with {status, missing[], hint}
```

With no keys, sessions pull from the queue: `fleet.queue.selector` (default: state *ready*, excluding the
triage label) over the tracker, over the checker's findings, or both (`fleet.queue.source`).

What one working session does, in order: read the ticket (op-2, cached offline by `fleet ticket cache` so
a dropped MCP does not blind it), set it in-progress (op-4 → op-5) and assign it to the current user
(op-6), branch off `origin/<repo.baseBranch>` as `{prefix}/{key-lower}-{slug}`, borrow a testing slot and
capture live *before* screenshots, do the fix — fanning out **read-only** subagents at every stage
(understand the ticket, root-cause, audit the fix, sweep for missed sites, pre-PR review) while the
session itself makes every edit, so the agents cannot collide with it — capture *after* screenshots, build
a scratch review page under `paths.artifactsDir`, then run the **Push-PR flow**: commit, open the PR
(draft by default, `vcs.pr.draft`) with a detailed body, put the screenshots on a separate `assets-{key}`
branch with `fleet assets add` and hot-link them with `?raw=true`, attach the PR to the ticket (op-8),
move it to in-review (op-7), and raise its done flag. A ticket the session decides *not* to fix ends in an
explicit `cancel` (op-9: comment first, then state) or an explicit `leaveOpen` (op-10) — never silence.

### `/fleet-check` — review PRs, file gated tickets

```
/fleet-check <pr> <pr>                  review two PRs by number in one fan-out wave; file one ticket per still-open gap
/fleet-check ABC-1234                   a tracker issue whose body lists PRs → one resumable sweep;
                                        the same command again = resume (finished PRs are skipped)
/fleet-check <pr…> --mode sessions      scale out: fleet sessions with role `checker`, each on its own dev-server host
                                        (the default comes from `checker.defaultMode`)
/fleet-check audit <sweepId|project>    re-run the audit gates on a finished corpus and mirror the verdicts onto the tickets
/fleet-check status                     worklist / done / remaining, per sweep
/fleet-check promote <sweepId> [--all | --fid <fid…> | --min-priority N] [--waive]
```

`/fleet-check` is **findings-only — it never edits code**. It **never asks the user a question**: anything
it cannot decide it decides by rule (no group named → create one, or file with the provenance label alone
when the tracker has no grouping) or it fails fast with a hint — it is a fire-and-forget sweep, and a
question asked into an unattended terminal parks it forever. Each finding gets a plain-language
description, only labels the tracker actually has (op-17), a priority from `1 Urgent` to `4 Low`, a
`**Gate:**` line, and a real screenshot of the affected area (op-22) — `checker.screenshots` is `always`
by default, `when-ui` to limit it to findings with a UI surface. The `sweepId` is deterministic from the
input, so *re-running the same command resumes* instead of duplicating. Modes: `local` (subagents in the
`/fleet-check` session — the wave is as wide as the harness runs concurrently, 10 when that limit is
unknown, and the sweep is resumable, so the PR count is bounded by time rather than by a cap),
`sessions` (fleet sessions reviewing slices in parallel, each with a live MCP and its own dev-server
host — the scale-out path, because it reuses the whole fleet) and
`cloud` (sandboxes fed an offline bundle; they have neither the tracker MCP nor the forge CLI, so they
**never file** — they emit outbox entries the launcher drains).

### Operating the fleet

```
fleet status [--json]                 the fleet table: label · role · issue · branch · state · slot
fleet watch                           the supervisor loop (see below); leave it running while sessions work
fleet send <label…> <text|--file p>   type into one or more sessions (long text is never truncated, on either platform)
fleet relaunch <label>                kill the session's process tree, verify it is gone, spawn a fresh agent into the SAME worktree
fleet add [k]                         add k working sessions to a running fleet; the pool is left alone
fleet kill <label…> [--dry-run]       safe teardown of one session
fleet down [--dry-run]                full teardown back to a clean base branch
fleet attach                          (tmux) reattach to the fleet's session
fleet doctor [--repair] [--verify-primary] [--json]
                                      environment check and repair; also echoes the derived rogue-server pattern
fleet slots · fleet pool status · fleet outbox list · fleet ticket list · fleet trackers list|show <id>
fleet session env --label <n> · fleet intake check <KEY…> · fleet assets add <file…> --branch <name>
fleet config status|detect|init|set|get|resolve|sources|validate|migrate
```

Of these, `fleet config` and `fleet doctor` are the two that run today — see [Status](#status).

## How it works

### One worktree per session

Each session lives in its own git worktree beside the primary checkout (`repo.worktreeParent`), named
`{repo}-session-{n}`. New worktrees are bootstrapped with `commands.bootstrap` in **paced install waves**:
the pacing decision is a pure function of a memory probe (`MemAvailable` on Linux, the memory-pressure
level on macOS, commit headroom on Windows — the naive "free bytes" reading is wrong on two of the three)
and `install.perInstallGb` / `install.reservePhysicalGb`, with `install.concurrencyCap` as the hard cap.
An optional warm donor `node_modules` (`install.donor.enabled`) is copied and then relinked by an offline
install, so workspace links come out right for any repository rather than from a hardcoded map. Every
install is **proven**, not assumed: a per-package file-count comparison against the primary checkout
(`install.proof.mode: compare-primary`) — the only detector for a half-extracted package, which a rerun of
the package manager will never repair, because the directory already exists. A `.fleet-ready` sentinel
marks the worktree usable. Only a *newly created* worktree gets a window; a reused one with no
`node_modules` re-queues its install but does not reopen its window, and session numbering counts leftover
folders, not just registered worktrees.

### The registry and the shim

Sessions are never found by grepping process command lines — that design produced phantom self-matches, a
`session-1`/`session-10` prefix collision, and a kill-by-exclusion incident that took the launcher with
it. Instead every session has a **descriptor** at `<stateDir>/sessions/<label>.json` (`id label role
worktree branch issue ticketFile backendRef shimPid agentPid pgid transcriptDir …`), and is started by one
**shim** (`src/session/shim.mjs`) on every platform. The shim sets the session's environment
(`FLEET_SESSION=1`, `FLEET_LABEL`, `FLEET_ROLE`, `FLEET_STATE_DIR`, `FLEET_TESTING_URL`,
`FLEET_TRACKER_MODE`, …), changes into the worktree, registers itself, tails the hook-written state file
to paint the status indicator, spawns the agent with `--model <fleet.model>` and the exact argv token
`--fleet-session=<label>`, heartbeats any locks it holds, and writes an exit record. It also deletes the
inherited `CLAUDE_CODE_CHILD_SESSION` and `CLAUDECODE` variables — inherited, a session writes **no
transcript** and every watcher goes blind. Command-line scanning survives only as the reconciler that
rebuilds the registry after a crash or a reboot, never as the lookup for list, send or kill. A session
takes every path it uses from its descriptor or its `FLEET_*` environment, never from a literal.

Status at a glance: each session shows **red while working, green when idle** — in the Windows Terminal
tab title, or in one tmux status bar for the whole fleet. Hooks write the state; the shim paints it.

### The testing-slot pool

A full dev stack per session lags a machine past six or seven sessions, so working sessions are **strictly
serverless**. Only the **testing pool** (`--testing k`, `0..testing.maxSlots`) runs servers: slot 1 on
branch `testing`, slot 2 on `testing-2`, and so on, each owned by a `testing`-role session. When a working
session needs to test, it runs `fleet pool acquire testing`, merges its own branch into that slot's
worktree, captures against that slot's URL (`devServer.urlTemplate`, with `{branch}`, `{slot}` or
`{port}`), and releases. Locks are `mkdir` mutexes under `<stateDir>/locks/<pool>/<slot>/`, stolen only
when **stale by timestamp** (`testing.lock.staleMinutes`, default 12) and heartbeated by the shim while a
session holds one, so a dead holder is noticed in minutes rather than the better part of an hour. The same
pool primitive serves the shared Android emulator (serialising build → install → screencap, with an idle
reaper), a per-session e2e port, and the per-ticket work-item lock `tracker-worklist:<KEY>`.

### `fleet watch`

The supervisor loop runs pluggable checks — orphaned processes, **rogue servers** inside working worktrees
(tree-killed, so the serverless rule is enforced rather than merely documented), stale locks, memory
pressure, dead sessions — and runs the **repair commands the project declares** in config
(`services.containers[].startCommand`, `commands.devServer`, `devServer.probes[]`) instead of hardcoding
any stack. A slot is judged by its probes: only `2xx`/`3xx` within 45 s counts as *up*, and four soft
faults in a row (`devServer.softFaultStrikes`) are required before a restart, so a server that is merely
compiling is left alone. Beside the checks run the watchers: **reclaim** (a finished session's worktree is
freed for the next ticket), **stalls** (classifies the *last assistant entry* of the transcript for an API
error — never a substring grep for an error string, which also matches the model discussing one),
**autowave** (refills the fleet from the queue, capacity taken from `git worktree list`, never a folder
count) and the **guardian** (work-in-progress patch snapshots of every worktree — never `git stash` —
plus a fleet manifest and usage-limit park/resume). The only outbound notification is your own
`notifications.command`, run with `$FLEET_EVENT` and `$FLEET_MESSAGE`; there is no telemetry and no
third-party push service. (The watchers take the notifier as an injected seam; the module that runs
your command is one of the unwritten ones — see [Status](#status).)

### Done and blocked flags

A session finishes by writing a flag, through the CLI so the shape is always right:

```
fleet flag done --outcome pr-pushed --pr-url <url> [--evidence path:line…] [--prescription followed|amended|refuted]
fleet flag blocked --category dev-server|testing-slot|services|emulator|tracker|cloud-env|install|capture-spec|usage-limit|merge|other --observation "<text>"
```

Flags land in `<stateDir>/flags/` as JSON with a one-line `.txt` twin for tailing. `outcome` is an enum —
`pr-pushed | cancelled | duplicate | no-code-change | check-complete` — because free text could not tell
*cancelled* from *left open*, the very distinction the playbook insists on. An `amended` prescription is
also patched into the ticket body (op-15), where the next reader will act on it, not only into a comment.
The launcher reads flags to reclaim worktrees and to report; a blocked flag says *why*, with a category
and a first-hand observation, so the operator fixes the environment instead of the session.

### The outbox

A session that cannot reach its tracker (the MCP dropped mid-run, `tracker.mode: manual`, or a cloud
worker that has no MCP at all) does not improvise and does not skip the transition — it queues it:

```
fleet outbox add --op op-7 --key ABC-1234 --args '{}'
fleet outbox add --op op-11 --key ABC-1234 --args '{"text":"…"}' --verbatim
```

The launcher drains `<stateDir>/tracker-outbox/` every monitor turn, applies each entry through the
adapter, posts `--verbatim` text **unchanged**, re-reads the issue to verify, then `fleet outbox ack`s it.
`/fleet-check` uses the same mechanism for everything the CLI wants the tracker to do — which is how a
cloud worker produces filings it is not itself allowed to make.

### Playbooks and overlays

Sessions follow bundled playbooks (`playbooks/session.md`, `testing.md`, `cloud-capture.md`, `check.md`,
`check-audit.md`; the launcher's own is `launcher.md`). A repository can overlay any of them at
`.fleet/playbooks/<name>.md`, and any tracker adapter at `.fleet/trackers/<id>.md` — nothing is ever
copied into the agent CLI's home directory, so there is no "keep three copies in sync" failure mode.
Playbooks speak only in tracker **operation names** (`op-1` … `op-27`); the adapter maps each one to a
tool call.

## Tracker support

Bundled adapters: **Linear · Jira · GitHub Issues · Asana · Trello**, plus `trackers/_template.md` for
your own. An adapter is one markdown file: YAML front matter the CLI reads (connection detection by tool
prefix, issue-key pattern, capabilities, state defaults, extra config keys) and a body the session reads,
one `## op-<n>` section per operation, each with a `Call:` line and an `If unsupported:` line.

| tracker | grouping | labels | atomicPatch | subIssues | duplicateRelation | imageEmbed | workItems |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Linear | project | yes | yes (native patch) | yes | yes | inline (native upload) | body checklist |
| Jira | epic | yes (REST transport) | no — emulated under the work-item lock | yes (subtask / parent) | yes (issue link) | inline (REST upload) | children — one subtask per PR |
| GitHub Issues | label (a setting swaps in milestones) | yes | no — emulated under the work-item lock | yes (degrades to a task-list umbrella) | yes (duplicate close reason) | inline (assets-branch hot-link) | body task list |
| Asana | project | yes (tags) | no — emulated under the work-item lock | yes | yes | attachment (caption, no inline) | children — one subtask per PR |
| Trello | list | yes | no — emulated under the work-item lock | none — every card is a leaf | none — the umbrella is an index card | attachment (card cover, no inline) | native checklist |

**Every cell in that table is a summary — see `trackers/<id>.md`; the adapter is authoritative.**
`fleet trackers show <id>` prints the live front matter, and `test/tracker-registry.test.mjs` validates
every bundled adapter on each run — all 27 sections present and unique, a `Call:` line wherever the
declared capability says the operation is supported, an `If unsupported:` line everywhere, a
`priority.map` covering 1..4, and an issue-key pattern that matches no ordinary branch name — so a
malformed adapter fails CI rather than someone's fleet.

Two adapters stress the abstraction, and are the reason some operations exist as their own step: Jira
changes status through *transitions* that depend on the current status and identifies users by an opaque
account id (hence `resolveState`, op-4, and `resolveUser`, op-3); Trello has no issue keys at all (the
adapter *derives* the fleet's `<KEY>` token from the card's short link, so branch, assets and capture
templates keep working), no status field (`setState` is a move to a list) and no children (`fleet doctor`
says so, and every key is treated as a leaf). Degradation is always **declared, never silent**: where a
relation is missing, the evidence **comment** is still mandatory — the relation is the bonus.

To add a tracker, see `plugins/claude-fleet/docs/adding-a-tracker.md`.

## Configuration

Config has **two layers**. The **project** layer is `<repo>/.fleet/config.json` — committed, shared by the
team, present in every worktree automatically, with an optional gitignored `.fleet/config.local.json`
beside it. The **user** layer is `%APPDATA%\claude-fleet\config.json` on Windows or
`$XDG_CONFIG_HOME/claude-fleet/config.json` elsewhere (override with `FLEET_CONFIG_HOME`), shaped
`{version, defaults, repos: {<repoKey>: {…, checkouts: {<path>: {…}}}}}`, where `repoKey` is the
normalised origin (`host/owner/name`) — identical from the primary checkout and from every worktree.
Precedence: defaults → project → project-local → user defaults → user repo → user checkout → `FLEET_*`
env → CLI flags. **Every key declares a scope** — `project`, `user` or `either` — and that scope is
enforced: a user-scope key found in a committed file is ignored with a `config.scope.leak` warning, a
`secret` key there is an **error**, and `fleet config init` refuses to write one. `$pinned` lets a project
name keys the user layer may *not* override (env and CLI still win, loudly) — a per-machine testing-branch
name would desynchronise that machine's worktrees from everyone else's. Anything that can be derived is
derived, never asked: workspace links from `package.json`, the slot table from `testing.base` +
`testing.maxSlots`, the rogue-server pattern from `commands.devServer`, the fleet size from RAM and CPUs,
the branch prefix from `git config user.name`, and `"me"` from the tracker. Env names are `FLEET_` plus
the key path in upper snake case (`commands.devServer` → `FLEET_COMMANDS_DEV_SERVER`).

A minimal project file:

```json
{
  "version": 1,
  "$pinned": ["testing.base", "devServer.urlTemplate"],
  "repo": { "baseBranch": "main" },
  "commands": {
    "bootstrap": "npm ci",
    "devServer": "npm run dev",
    "test": "npm test"
  },
  "devServer": {
    "urlTemplate": "https://{branch}.dev.localhost",
    "probes": [{ "path": "/", "expectStatus": "2xx,3xx", "timeoutSec": 45 }]
  },
  "testing": { "base": "testing", "maxSlots": 4 },
  "services": {
    "containers": [
      { "name": "app-postgres", "startCommand": "docker start app-postgres", "healthPort": 5432 }
    ]
  },
  "tracker": { "id": "linear", "scope": "ABC" },
  "vcs": {
    "branchTemplate": "{prefix}/{key-lower}-{slug}",
    "pr": { "draft": true },
    "sensitivePaths": [".env*", "secrets/**"]
  },
  "checker": { "triage": { "label": "triage" }, "autoPromote": "never" }
}
```

And the matching machine-level entry — which is where anything personal, machine-shaped or secret lives:

```json
{
  "version": 1,
  "defaults": { "terminal": { "backend": "auto" }, "install": { "reservePhysicalGb": 8 } },
  "repos": {
    "github.com/acme/app": {
      "vcs": { "branchPrefix": "ada" },
      "fleet": { "size": 6 },
      "testing": { "count": 1 },
      "tracker": { "rest": { "tokenEnv": "TRACKER_TOKEN" } }
    }
  }
}
```

`fleet config resolve` prints the merged result, `fleet config sources` says which layer each value came
from, and `fleet config validate` explains every warning. The full key table — type, default and scope for
every key — is `plugins/claude-fleet/docs/reference/contract.md §3`; the JSON Schema is
`plugins/claude-fleet/schema/fleet.config.schema.json`, generated from the same source as the loader, with
a test asserting parity.

## Safety rules

These are the rules the fleet enforces on itself. Each one was paid for; the sentence after it is the
value.

- ⛔ **Never `git stash` in a session.** `refs/stash` is shared across every worktree of a repository, so
  one session's stash silently becomes another's. A PreToolUse hook blocks it, and the guardian snapshots
  work-in-progress as patch files instead.
- ⛔ **Never kill by exclusion** ("everything except me"). It takes the launcher, sibling sessions and the
  dev servers with it. The CLI kills by registry: snapshot → descendants → deepest-first → protect self
  and ancestors → re-query → assert zero survivors.
- ⛔ **Never run the repository-wide killer (`commands.stopAll`) from a session.** It stops every session's
  server, not just yours; only the launcher may run it, at teardown.
- ⛔ **A working session never starts its own dev server.** A full stack per session lags the machine past
  six or seven sessions; only the testing pool runs servers, and the supervisor tree-kills any server that
  appears inside a working worktree, so the rule is enforced rather than merely documented.
- ⛔ **Never start a server while detached or on the base branch.** Per-branch hosts collide on the same
  URL, and the collision surfaces as someone else's screenshots in your ticket.
- ⛔ **A session operates only inside its own worktree.** It never removes or prunes worktrees, never
  writes global git config, and pushes only its own branch — each of those reaches into work another
  session is holding open.
- ⛔ **Sessions never disable or kill the supervisor.** If something a session started vanished, that is
  the supervisor enforcing a rule — read the log rather than removing the check.
- ⛔ **Lock staleness is decided by timestamp only.** A dead PID with a fresh heartbeat is *not* stale, and
  PID reuse makes "is the holder alive?" a lie; the shim heartbeats whatever it holds. Locks live in the
  per-repo state directory, never in the system temp directory — which is not the same directory for every
  process that has to share the lock.
- ⛔ **Only `2xx`/`3xx` within 45 s means "up".** A dead slot answers 404, not 502, so an any-status probe
  reports a corpse as healthy — and a server that is still compiling is left alone until it fails four
  times in a row.
- ⛔ **Never invent a test URL, and never fabricate a capture.** With no local slot up, a session reports
  that in one fixed line and stops; "blocked" means it probed the thing just now and can say what it saw.
- ⛔ **Subagents are read-only.** The session itself makes every edit and owns the dev stack, so parallel
  agents cannot collide with it — and the session never sits idle waiting on them.
- ⛔ **Gate before fleet.** Intake refuses any checker-filed ticket without `gate:passed` or `gate:waived`
  (`fleet.queue.requireGate`): an unaudited finding is a hypothesis, not work. `gate:waived` is
  human-only, and refusals are counted in `fleet status` and logged, never silent.
- ⛔ **Secrets never in project config.** A `secret` key in `.fleet/config.json` is an error, and a
  user-scope key there is ignored with a warning — this is the mechanism that keeps a committed config
  person-, machine- and company-independent.
- ⛔ **Screenshots live on an assets branch, never in the PR diff.** Binaries in the diff pollute the
  review and the history; `fleet assets add` commits them to `assets-{key}` and the PR hot-links them.
  That branch is never checked out — its files are read with `git show <ref>:<path>`.
- ⛔ **Comment first, then the relation.** For `cancel` (op-9) and `markDuplicate` (op-24) the evidence
  comment is mandatory and the relation is the bonus: on some trackers the relation moves the state by
  itself, and the reasoning would be lost.
- ⛔ **Queued tracker text is posted verbatim.** Never paraphrased, never truncated at a character offset
  (a title cut mid-key autolinks to a different issue); the launcher re-reads the issue after applying, to
  verify.
- ⛔ **`/fleet-check` is findings-only and never asks the user a question.** It never edits code — the fix
  belongs to a fleet session that owns a worktree and a branch — and an unattended sweep that asks a
  question parks forever, so it decides by rule or fails fast with a hint.
- ⛔ **A PR is not done until its outcome is on disk.** The ledger, not the transcript, is the record; a
  crash mid-wave resumes from the ledger, and the tracker's human-visible mirror is ticked the moment the
  ledger line lands.
- ⛔ **Never trust a full page.** A tracker query that returns exactly `limit` items with no completeness
  signal is truncated by definition, and a reconcile built on it re-files what already exists.

`plugins/claude-fleet/docs/gotchas.md` carries the full list, and `docs/field-notes.md` the incidents
behind it — each note as *Saw / cause / Rule*, written so a stranger can reproduce the method failure
without learning anything about any product.

## Provenance

`claude-fleet` was **extracted from an internal fleet** that ran for months against one company's
repository, one tracker and one machine. The generic version is the **only public one**: the original is
not published, and this repository carries no company, product, repository, person or incident from it —
examples use `ABC-1234`, `github.com/acme/app`, `ada`, `app-postgres` and `2026-03-14`, and two tests
(`test/docs-redaction.test.mjs`, `test/playbook-brands.test.mjs`) fail the build on a slip. What survived
the extraction is the part that matters: every hard rule, and the one sentence that says why it exists.

## Documentation

- `plugins/claude-fleet/docs/operating-a-fleet.md` — the operator's guide: sizing, the monitor loop,
  unblocking, teardown
- `plugins/claude-fleet/docs/gotchas.md` and `docs/field-notes.md` — the rules, and the incidents behind them
- `plugins/claude-fleet/docs/adding-a-tracker.md` — from `trackers/_template.md` to a passing registry test
- `plugins/claude-fleet/docs/reference/contract.md` — every name, key, operation, subcommand and env var
- `plugins/claude-fleet/playbooks/` — what the sessions actually read
- `CONTRIBUTING.md` — layout, `npm test` on a bare clone, the generated files, commit hygiene
- `SECURITY.md` — reporting, the skip-permissions posture, and what talks to the network

## License

MIT — see [LICENSE](./LICENSE).
