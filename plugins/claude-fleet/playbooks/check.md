---
command:
  name: fleet-check
  description: Review one or more PRs for still-open edge cases, future risks and scaling problems, and file each distinct gap as its own gated tracker issue with a real screenshot. Findings-only, one resumable sweep, never asks a question; the audit always follows.
  usage:
    - "/fleet-check <PR…|<KEY>|--from-file p> [--project <id|name|new>] [--mode local|sessions|cloud] [--auto] [--width N|auto] [--resume <sweepId>] [--dry-run]"
    - "/fleet-check audit <sweepId|project>"
    - "/fleet-check status"
    - "/fleet-check promote <sweepId> [--all | --fid <fid…> | --min-priority N] [--waive]"
  args:
    - name: "PR…"
      description: One or more PR numbers or URLs on the configured remote. A handful; runs as a single wave.
    - name: "<KEY>"
      description: A tracker issue (for example ABC-1234) whose work items list the PRs. Read once with op-26 readWorkItems; every resolved PR is mirrored back with op-27 tickWorkItem.
    - name: "--from-file p"
      description: A text file with one PR number or URL per line.
    - name: "<sweepId|project>"
      description: For audit and promote — a finished sweep, or the tracker group that holds an older corpus.
  flags:
    - name: "--project"
      values: "<id|name|new>"
      default: "`checker.project` when set (op-20); otherwise `op-21 createProject` named from `checker.projectNameTemplate`; `--project new` or `checker.projectPerSweep` forces a new project even when `checker.project` is set; provenance-label-only when the adapter's `grouping` is `none`."
      description: Where filed issues are grouped. Resolved once by op-20 and stored in the manifest by ID — never carried as a name.
    - name: "--mode"
      values: "local|sessions|cloud"
      default: "checker.defaultMode"
      description: Where the per-PR workers run. See section 5.
    - name: "--auto"
      description: After the audit, promote gate:passed findings to the ready state (checker.autoPromote = after-audit for this run). Refused with a hint when no gate exists to collapse.
    - name: "--width"
      values: "N|auto"
      default: "checker.waveWidth"
      description: Workers per wave. auto = as many as the harness runs concurrently, throttled when the machine strains.
    - name: "--resume"
      values: "<sweepId>"
      description: Resume an existing sweep dir explicitly. Re-running the original command resumes anyway — the sweepId is deterministic from the input.
    - name: "--dry-run"
      description: Plan only — create the sweep dir, print the worklist, the slices and the location plan; no tracker writes, no dispatch.
  preflight:
    run: 'node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" config status --json'
    onNotOk: "Anything but status ok — needs-checker included: print the payload's hint verbatim and EXIT. Never open a wizard, never ask."
  noArgs: "Print usage and exit. NEVER ask what to check."
  neverAsk: true
---

# `/fleet-check` — review PRs, file every still-open gap as a gated ticket

Take **one or more PRs**, find the edge cases / future risks / scaling problems they leave
unhandled, and file **one tracker issue per distinct gap that is still open on the base branch**.
This is a review, not a change: you **never edit code** — the only output is tracker issues (or,
without a tracker, rows in `findings.jsonl`). At scale it runs as **one fire-and-forget, resumable
sweep** (section 3), and every sweep is followed by the audit (`playbooks/check-audit.md`), which is
the only thing allowed to mutate a filed ticket destructively.

Written as `fleet <cmd>` below means `node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <cmd>`. Every
command takes `--json`; every payload starts `{"ok": bool, "v": 1, ...}`. Tracker work is only ever
described by its op name (`op-13 createIssue`, …); the adapter at `trackers/<id>.md` (or the project
overlay under `.fleet/trackers/`) says what each op calls. Every path you use comes from the CLI
payload or your session descriptor / `FLEET_*` env — never from a literal typed into this document.

> **Scope — three input forms:**
>
> 1. **Direct** — PR numbers / URLs passed as arguments (a handful; runs as a single wave).
> 2. **A tracker issue** — an issue key (e.g. `ABC-1234`) whose work items hold a list of PRs; the
>    sweep reads that list **once** as its worklist and **ticks each PR off as it finishes** so the run
>    is trackable, backtrackable and resumable (section 4).
> 3. **`--from-file p`** — one PR per line, for repos without a tracker or for a hand-built list.

---

## 0. Contract

- **Findings-only.** Never modify a PR's code, tests, or config. If you catch yourself editing a
  source file, stop. The only artefacts you produce are tracker issues, screenshots, and the sweep
  dir's own state.
- **⛔ NEVER ask the user a question. Not once, not "just to confirm".** No interactive question tool,
  no option list, no "which shape would you prefer?". The operator is usually idle, and this job takes
  hours of work — if you stop to ask questions it will never end. A sweep is launched and walked away
  from; a question does not pause it politely, it **stops it dead** for however long it takes the
  operator to look. The plan is detailed enough to decide from.
  - **Decide, act, and say what you chose** in the final report. Adjustments happen afterwards.
  - When two readings differ, take the one that **preserves the most information** — file it, keep the
    artefact, consolidate rather than discard. That is the cheaply-reversible direction.
  - This overrides any general "check in when it's ambiguous" instinct, and it applies to the
    orchestrating session as well as to workers. No arguments ⇒ print usage and exit. Preflight not
    `ok` ⇒ print the hint and exit. The group is decided, not asked: `checker.project` when set
    (op-20); otherwise `op-21 createProject` named from `checker.projectNameTemplate`; `--project new`
    or `checker.projectPerSweep` forces a new project even when `checker.project` is set;
    provenance-label-only when the adapter's `grouping` is `none`.
- **One command, resumable.** A sweep runs to completion from a **single invocation**; if it dies
  mid-way, re-running the same command resumes — finished PRs are already on the ledger and skipped.
  The `sweepId` is deterministic from the input (`<KEY>` · `prs-<sha1>` · `file-<sha1>`), which is
  what makes *re-run = resume* survive a dead session.
- **Repair, don't stall.** If a prerequisite is down (the dev app, the database container, a service),
  bring it up with `fleet doctor --repair` and continue (section 6) — never wait for the operator to fix
  it, and never skip a step because of it.
- **Every issue gets a screenshot** of the area it concerns — even when the edge case isn't
  reproducible (section 7.5). Skip only when there is genuinely no UI at all.
- **Verify before filing.** Every issue must be a real, plausible gap that **neither the PR nor any
  later PR already handles** — i.e. still open on the base branch — not a speculative "could maybe."
- **One PR → many separate issues.** Each edge case is its own issue — never bundle several gaps
  into one ticket. **The single exception is a11y**: every a11y-labelled issue is filed as a
  **sub-issue of the sweep's one a11y umbrella issue** (section 7.4).
- **The audit ALWAYS follows the sweep.** `fleet check finish` chains into `fleet check audit plan`.
  A sweep that files into triage without an audit has not finished; the fleet's intake refuses
  unaudited checker tickets (section 9).

---

## 1. Preflight

Run `fleet config status --json` **before anything else**. The status enum is
`ok | needs-init | needs-machine | needs-tracker | needs-checker | invalid | unmigrated`; the command
exits 0 in every state and the state is in the payload, not the exit code. **Anything but `ok`: print
the payload's `hint` verbatim and EXIT.** The configuration wizard lives only in `/fleet`;
`/fleet-check` never opens it and never asks. `tracker.mode: none` is a valid `ok` — the sweep then
files into `findings.jsonl` (section 9) instead of a tracker.

Then read what the sweep will run against, once, from the resolved config (`fleet config resolve
--json`): `checker.*`, `review.riskProfile`, `review.emphasis`, `review.lensOverlay`,
`vcs.sensitivePaths`, `capture.*`, `testing.count`, `tracker.id` / `tracker.scope`. Never re-read
config mid-sweep to "check whether it changed"; the manifest written in step 2 is the sweep's truth.

`/fleet-check status` (`fleet check status --json`) is the read-only answer to "what is running" —
every known sweep, its counts and its audit state. It never writes and never resumes anything.

---

## 2. Inputs → the worklist, written once

`fleet check plan <args> --json` creates the sweep dir (`<stateDir>/sweeps/<sweepId>/` — the
payload prints the path; in a spawned `checker` session it is `FLEET_SWEEP_DIR`) and its
`manifest.json` (input, mode, base-branch snapshot sha, tracker ids as they resolve, gate, capture
strategy, slices, counts, audit status). It then needs the PR list, which you supply through **one**
of three routes, all of which end in `fleet check worklist write --items-json`:

| input | how the items are obtained |
| --- | --- |
| PR numbers / URLs | passed straight through as items `[{pr, done: false}]` |
| `<KEY>` | you run **`op-26 readWorkItems(KEY)`** → `[{pr, done, keys[], raw}]` and hand the array over verbatim; items with `done: true` are recorded as already resolved — **skipping them is what makes the sweep resumable and backtrackable** |
| `--from-file p` | the file's lines, one PR each |

`worklist.tsv` (`<pr> <merged_at|open> <title>`) is **written once at the start and never edited.**
Re-deriving it mid-sweep is the main source of forge-API flakiness and makes "what is left"
unanswerable. If a worklist already exists for this `sweepId`, `worklist write` refuses to overwrite it
and the run is a resume (section 3).

`fleet check plan` also resolves the PRs offline into `_sweep/prs/<n>.{json,diff}` via `fleet check gh
bundle` (section 7.1), builds the gate-2 and open-PR path indexes the workers consult, and emits the
**location plan** as outbox entries you execute now, before any worker starts:

- the sweep's group: `checker.project` when set (op-20); otherwise `op-21 createProject` named from
  `checker.projectNameTemplate` (e.g. `Edge-case sweep 2026-03-14`); `--project new` or
  `checker.projectPerSweep` forces a new project even when `checker.project` is set;
  provenance-label-only when the adapter's `grouping` is `none`.
- `op-3 resolveUser("me")` → the current user, the default assignee
- `op-17 listLabels(scope)` and `op-19 listStates(scope)`
- `op-18 ensureLabel` for `checker.provenanceLabel`, `checker.triage.label`, and
  `checker.gate.labels.pending` — **launcher-only**, once per sweep
- the a11y umbrella (`op-13 createIssue`, section 7.4) when `checker.a11y.umbrella` and the adapter
  has `capabilities.subIssues`

Execute each entry, `fleet outbox ack <id> --result <json>` it, and the CLI writes the resolved IDs
into the manifest. **Always reference the group, the umbrella and the assignee by ID from the
manifest, never by name** — names contain apostrophes, get renamed, and drift a sweep behind; the
project pointer has drifted more than once when it lived in memory instead of the manifest. Pass the
manifest path to every worker.

`--dry-run` stops here: it writes the sweep dir, prints the worklist, slices and location plan, and
touches neither the tracker nor a worker.

---

## 3. Execution model — one command, runs to completion, resumable

A sweep is **fire-and-forget**: the operator runs the command once (typically pointed at a tracker
issue listing the PRs) and walks away. It must process **every** PR, auto-paced to the machine /
harness limit, and survive a crash with nothing lost.

- **Loop to completion.** Repeatedly pull the next wave of still-unresolved PRs from the worklist
  (`fleet check slice --json` returns the next slice; `fleet check ledger resume` says what is left)
  and process them, wave after wave, until none remain. No manual batch-by-batch re-invocation.
- **Auto-pace to the limit.** Each wave fans out **one worker per PR**, as many at once as the harness
  runs concurrently (~10–16; `--width N` or `checker.waveWidth` caps it); the rest queue and flow in
  as slots free. Don't ask for a batch size. Throttle the wave width down if the machine strains.
- **Per-PR worker contract.** Give each worker one PR + the manifest path + the brief rendered by
  `fleet check brief` (appendix A): *run section 7 for this single PR and return **only a compact
  report** — created issue keys + URLs, dropped candidates (with the later PR that addressed each),
  and screenshots captured/skipped.* **Never return raw diffs, forge/tool output, or image bytes to
  the orchestrator** — that bulk dies inside the worker. **Per-PR workers do their one PR directly
  and must not spawn another per-PR layer** (no recursion). Within a PR the independent work
  (later-PR checks, per-issue file + screenshot) may still fan out.
- **Staged widths — match each stage to its bottleneck:**
  - *Analyze + verify* (read-only per PR) → **wide** (the wave).
  - *Screenshots* (drive the live app) → **the narrow testing pool** (`fleet pool acquire testing`,
    at most `testing.count` slots, each with its own isolated `capture.accounts` identity), never the
    full wave — the shared stack collides otherwise. Serialize onto the pool.
  - *File issues* → parallel `op-13 createIssue` calls are fine, but **serialize writes to the same
    issue or description** (including the worklist mirror, section 4) or they clobber.
- **Durable on-disk state — NOT the session scratchpad.** A scratchpad dies with the session, which
  is precisely when you need it. The sweep's state lives in the sweep dir under `paths.stateDir`
  (never `os.tmpdir()`, never a literal temp path, never a directory inside a worktree) so a *fresh*
  session with no context can resume from disk:
  - **`worklist.tsv`** — written once (section 2).
  - **`ledger.tsv`** — `<pr> <status> <issue_keys_or_-> <iso_ts> <note>`, appended **the moment each
    PR resolves** by `fleet check ledger append <pr> <status> [--keys k,k] [--note …]`. `status` is
    exactly one of `filed` · `clean` · `skipped` · `failed`.
  - **`RESUME.md`** — the protocol itself, written by `fleet check plan`, so a new session knows to
    read the other two first.

  > **⛔ A PR is not "done" until its outcome is on disk.** Nothing in context, in a plan, in a
  > worker's return value, or in a tracker query counts as progress. Bind the ledger to the
  > **outcome** (an issue exists / the PR is clean), never to the transport (a tool call returned).

  Rules, each of which is a bug that actually happened: append after **every** PR, never batch (a
  120 s tool timeout silently dropped three appends); never chain the ledger write behind a network
  call; **never write the ledger by hand — the CLI owns the append** (a pipeline write fed empty input
  is a silent no-op, and every shell has one); one machine-readable format only (four ad-hoc shapes
  broke every past reconciliation — `fleet check enum check ledger.tsv --col 2 --domain
  filed,clean,skipped,failed` proves it); **`failed` lines are mandatory** — a missing line means
  "never attempted", which is worse and less recoverable than "attempted and failed". A worker that
  crashes before reporting is recorded `failed` by the orchestrator, with the note saying so.

- **Resuming:** `fleet check ledger resume --json` set-differences `worklist.tsv` against `ledger.tsv`
  on column 1 and **prints all three counts** (`worklist=`, `done=`, `remaining=`). **A `done` of 0 on
  a non-empty ledger means the ledger did not load, *not* that no work was done — stop and
  investigate rather than re-running the whole sweep.** Then re-check the last `filed` line: a
  session can die *between* creating the issue and appending its line, so run `op-16 findIssues`
  for that PR's header line (`**PR:** #<n>`, within the sweep's group and provenance label) before
  filing it again.
- **Resume = re-run the same command.** Progress lives in the ledger and its tracker mirror, so a
  crash loses nothing: re-running skips finished PRs and continues. Idempotent.
- **Finish** through `fleet check finish` (section 8), then the audit, then the report.

---

## 4. The mirror — tick the tracker the moment the ledger line lands

- **⛔ TICK THE TRACKER WORK ITEM THE MOMENT A PR IS RESOLVED. Never batch it to wrap-up, never
  defer it.** The moment a PR's ledger line is written, its `op-27 tickWorkItem(KEY, pr, keys[])`
  is owed. The operator watches this list to see the sweep moving — a tracker showing 3 of 322 while
  the ledger says 322 tells them the run is dead. Every time you are done with a PR, tick it, so the
  overall progress is visible. General rule.
  - Mechanically: `fleet check ledger append` **enqueues** the tick as a `tickWorkItem` outbox
    entry. The orchestrator drains those entries **once per wave, as one `op-27` call carrying every
    tick from that wave** (`fleet check tick plan --json` lists what is owed; run the call under
    `fleet check tick --lock`, which holds the 1-slot `tracker-worklist:<KEY>` pool for adapters
    that must read-modify-write). "Once per wave" is the *latest* it may land, not a licence to wait
    for wrap-up.
  - The tick is a **small patch** on the one line (`- [ ] #<n>` → `- [x] #<n> → ABC-1234, ABC-1235`),
    never a whole-description rewrite. Patches are small, atomic, and cannot clobber a concurrent edit.
    Keys are backtick-wrapped so nothing autolinks; the anchor is the `- [ ] #<n>` token, because a
    bare `#<n>` appears inside other titles.
  - **Only the orchestrating session writes the mirror.** Workers never touch it; in `sessions` mode
    the checker *sessions* never tick either — the parent orchestrator ticks from the shared ledger.
    Parallel writers to one description overwrite each other.
  - The ledger stays the source of truth; the tracker is its human-visible mirror. If they disagree,
    the ledger is right — but **a stale mirror is a real defect, not cosmetic**: fix it at the next
    drain and say so in the report.
- The mirror is also the resume point a human can read: ticked = done, keys = what was filed.

---

## 5. Modes — where the workers live, and who files

| mode | worker | who files | shared-state ops |
| --- | --- | --- | --- |
| `local` (default) | subagents inside the `/fleet-check` session, one per PR, ~10–16 wide | **the worker** — distinct `op-13 createIssue` calls parallelise cleanly | orchestrator only |
| `sessions` (the scale-out path) | fleet sessions with `role: checker` (`fleet up --role checker`), each on `check/{sweepId}/{slice}` (`vcs.checkerBranchTemplate`) with **its own dev-server host**, running this playbook on its slice | the session's own subagents | the **parent** orchestrator only — sessions never tick, never touch the umbrella |
| `cloud` | sandboxes via `fleet cloud dispatch --bundle <sweepDir>/_sweep --ref <branch> [--slice f]`, fed the offline `_sweep/` bundle | **never the worker** — it emits `createIssue` outbox entries + PNGs on its results branch; the orchestrator harvests and drains them | orchestrator only |

**⛔ The old blanket rule "workers never touch the tracker" over-generalised from one real incident
about concurrent edits to a single description.** Creating *distinct* issues shares no mutable state
and parallelises cleanly: thirteen local workers once filed over a hundred issues with zero failures
and zero duplicates, against hours of serial round-trips from one session. The line is **shared
state**, not the tracker itself:

| operation | who |
| --- | --- |
| Create a new issue it was assigned (`op-13`) | **any worker** (except cloud — see below) |
| Edit an issue it created itself (`op-14`, `op-15`, `op-22`) | **any worker** (except cloud — see below) |
| The worklist mirror (`op-27`) · the a11y umbrella (`op-23 setParent` onto it) · `op-15 patchBody` on an issue another agent created · `op-21 createProject` · `op-18 ensureLabel` | **orchestrator only, in every mode** |

`sessions` beats `cloud` as the primary scale path because it reuses the *entire* fleet — worktrees,
per-branch hosts, the registry, `fleet watch` stall/reclaim/guardian, done-flags (outcome
`check-complete`), a live tracker connection — and removes the screenshot bottleneck the same way:
one dev-server host per session. Each session takes a **disjoint slice** of the worklist (`FLEET_SLICE`)
and runs sections 6–7 against **its own** host (`FLEET_TESTING_URL`), so screenshots no longer
serialize on one stack. Bound the session count to what the machine can sustain — many concurrent
dev servers + browsers is heavy load — and all sessions still share one dev database, so keep
screenshot accounts isolated (`capture.accounts`). A checker session ends with `fleet flag done
--outcome check-complete`; it never writes the mirror.

**Cloud rules — each learned the hard way.** A cloud sandbox has **neither the tracker connection nor
the forge CLI**; a worker that tries to use either will hang rather than fail. It works only from the
`_sweep/` bundle (metadata, diffs, gate-2 and open-PR path indexes precomputed by `fleet check plan`)
and returns a findings package — `createIssue` outbox entries plus PNGs — on its results branch, which
the orchestrator pulls back with `fleet check harvest <sweepId>` and then drains through the outbox as
its own `op-13` / `op-22` calls. The sandbox is prepared by `capture.bootstrapScript` with
`capture.requiredEnv` present and network limited to `capture.allowlistHosts`; follow
`playbooks/cloud-capture.md` for boot, timings and the install sequence rather than improvising.

- **⛔ The worker prompt must forbid reading, grepping, cat-ing or editing any path in
  `vcs.sensitivePaths`.** The permission layer flags those files as sensitive and prompts **even for
  read-only, already-redacted commands** — and a permission prompt hangs a worker *forever* with no
  failure marker, no branch and no timeout, indistinguishable from a crash. Four workers once burned
  30–45 minutes each on exactly this. Probe a secret by its **length**, never by reading the file that
  holds it. Detect a stuck worker by the *absence of a delivered branch* — never by waiting for a
  signal that does not exist.
- **⛔ Gate the ramp on branches DELIVERED, never on sessions created.** A dead worker holds its slot
  and looks identical to a busy one: eight sessions "running" once produced zero deliveries. Poll the
  remote for the results branches and **check the exit code** of the listing — a network failure reads
  as "branch absent". Ramp 3 → ~10 → the rest, **staggered by a couple of minutes**, because prompts
  cluster at boot.
- **`exit 137` is a per-container out-of-memory kill**, independent of any session cap — **split the
  slice, don't retry it.**
- **A worker quiet for more than 25 minutes with no branch is stuck**, not slow: a dependency install
  retry-loops against a blocked host for twenty minutes without ever erroring. Record it `failed` in the
  ledger with the note, re-slice, redispatch.
- `--ref` is mandatory on `fleet cloud dispatch`: without a pinned ref the upload dies with a
  misleading "repository too large".

---

## 6. Environment — repair, don't stall

When something the sweep needs is down, **fix it and continue** — do not block on the operator, and do
not silently skip the step (especially a screenshot). Diagnose → repair → verify → proceed.

The repair is one command: **`fleet doctor --repair`**. It walks `services.containers[]`
(start + health — e.g. the `app-postgres` container on 5432), `commands.migrate`,
`commands.devServer` and `devServer.probes[]` for the slot you hold, on either platform. Run it
whenever a probe fails, a screenshot login bounces, or a slot's first sync hangs — a cold slot
briefly reporting "can't reach the app" is usually a first-sync race, not an outage, so let the probe
timeout (`testing.lock.probeTimeoutSec`) elapse before calling it down. Other self-heals you own
rather than escalate: a stale or partial dependency tree breaking the build (`fleet doctor --repair`
re-installs against the install proof), a wedged dev server (the doctor frees the slot's port and
restarts it), a pending migration.

**Never skip a screenshot because the app was down.** Only after a genuine repair attempt fails do
you stop: `fleet flag blocked --category dev-server|services|testing-slot|… --observation <what
broke and what you tried>`, note it on the affected issue as `_No screenshot attached: <reason>_`,
and continue with the rest of the PR. Sessions never run `commands.stopAll`, never start a server
outside their own slot, and never kill by exclusion.

---

## 7. Per-PR workflow

### 7.1 Resolve the PR

`fleet check gh bundle <pr> --json` (already run by `plan`; run again only when the bundle is
missing) writes `_sweep/prs/<n>.json` (number, title, body, url, files, state, mergedAt, merge
commit) and `_sweep/prs/<n>.diff`. Two truncation guards are built in, and you must respect the
same limits if you ever query the forge directly:

- **⛔ `files.length == 100` ⇒ the file list is paginated**, by definition — the forge caps that field
  at one page with no marker, no error and no ellipsis. The bundle paginates; a hand query must too, or
  the gate-2 and gate-3 path checks run against a file list that quietly stops at the century mark.
- **⛔ A failed diff (exit ≠ 0) ⇒ reconstruct from the per-file patches; never accept a 0-byte diff.**
  A 0-byte diff reads as "this PR changed nothing" and produces a confident `clean` — the one ledger
  status nobody ever re-checks.

Read the changed files themselves (not just the diff hunks) enough to understand **what the PR
actually does** — you'll restate it in plain English in every issue. Read them at the base-branch
snapshot the manifest records; never `git checkout` a shared worktree to do so.

### 7.2 Resolve the location — once, up front, from the manifest

Everything a filing needs is already in `manifest.json` (section 2): the group ID, the current user's
ref, the label IDs (`checker.provenanceLabel`, `checker.triage.label`, `checker.gate.labels.pending`,
`checker.a11y.labels.*`, `checker.securityLabel`), the triage state, and the a11y umbrella's key.
Workers read it; they never re-resolve. A worker that cannot find a required ID in the manifest
records the PR `failed` with note `manifest incomplete: <field>` — it does not go looking.

### 7.3 Find the edge cases — then verify each (three gates)

Enumerate candidates through the lens below, then run **each** candidate through the gates and drop
it if any says "already handled":

1. **Gate 1 — the target PR itself.** Open the diff/code and confirm the PR doesn't already handle the
   case and that it's genuinely plausible (not far-fetched). Read the PR body for `not in scope` /
   `follow-up` / `separate ticket`: a deferral named by the author is still a real gap on the base
   branch — file it, and say the PR deferred it.
2. **Gate 2 — PRs merged after the target PR.** A later PR may have already fixed the gap, which would
   make the issue invalid. **⛔ Use the forge CLI (the gate-2 index in `_sweep/`), never local `git
   log`:** a shallow clone truncates older history **silently**, so `git log --since` / commit ranges
   confidently return "nothing" and you file a bug that was fixed weeks ago. The index lists PRs merged
   after the target's `mergedAt` and the paths each touched; keep the ones touching the affected paths,
   read their diffs, and if any already addresses this edge case **do not file it** — record it in the
   report as "already addressed by #<n>". (Target PR still open? There's no `mergedAt` — compare
   against currently-merged PRs on the base branch that touch the same paths.) When querying the
   forge by hand, pass a limit high enough that the result is not exactly the limit.
3. **Gate 3 — other OPEN PRs, only when the worklist contains open PRs.** Gate 2 has two states
   (fixed later on the base branch, or still open). A sweep that includes open PRs has a **third**:
   *fixed by a different open PR that hasn't merged yet.* No worker can see it — each holds only its
   own PR and the base branch, and the fix is in neither. Before filing, look the finding's cited path
   up in the open-PR path index in `_sweep/` and read any hit's diff. A finding whose file is touched
   by another open PR is a **dedup candidate, not automatically a finding**. (The reverse still counts:
   what the *fixing* PR itself gets wrong is a real finding.)

Rank the survivors by impact. Every issue you file must be a gap that is **still open on the base
branch.**

**The edge-case lens.** Keep every angle; weight the security row by `review.riskProfile`
(`security-critical` puts it first, `data-critical` lifts the data-loss row, `consumer-ui` lifts
long-input / mobile / a11y); `review.emphasis` names lens ids to lead with; the project overlay at
`review.lensOverlay` (`.fleet/lenses.md`) appends repo-specific angles — read it if it exists.

| Angle | Ask |
| --- | --- |
| **What does a FAILED READ render as?** | **The single highest-yield lens — it produced ~20 Highs in one sweep.** A discarded fetch error rendering a confident empty state, a permanent skeleton, or a wrong default. Shapes seen: "No active sessions." *(which also disables the sign-out-everywhere control)*, "Nothing set up yet.", a counter showing `0`, "All clear — nothing here right now.", "0 people · not shared yet", a capability shown as "(Not available)" *and disabled*, every notification switch defaulting **ON**, a consent dialog that **never appears** because `.catch(() => [])` reads as "shared with nobody", and a recipient list that pre-selected everyone after a failed read and would have **sent real duplicate invitation emails**. Escalate to **High** when the empty state asserts a security fact, **disables the control that would fix it**, cannot recover, or drives an outbound side-effect. |
| **Deferred twins** | The most common finding of all: the PR fixes one call site and leaves an identical one. Grep the fixed pattern repo-wide. Then ask the question that matters: **is the unfixed sibling on a more destructive or less recoverable action?** It repeatedly is — a confirm added to deleting one record while deleting the *whole parent* stayed unguarded; a `reset()` fixed on one dialog while the sibling dialog holding the **most sensitive field** was missed. |
| **Did the PR weaken a test?** | Read `*.test.*` / `*.spec.*` changes as part of the review. For every modified or deleted assertion: what did the old one guarantee, and does the new one still? For every added retry / `waitFor`: is it absorbing **product** flakiness that should be a finding? A PR that narrows the very assertion guarding what it broke is how the bug returns unnoticed. |
| Busy flags / unsettled promises | `await` with no `finally`; a call never answered; a spinner with no terminal state. **Ask what one rejection does.** |
| All-or-nothing loops | One failure abandons the rest, reports a blanket error, and **cannot be retried in place** (a retry replays what already committed). |
| Defaults that fail open | A cleared cache, a thrown write, or a missing config reverting a security control to its **weakest** value. |
| Scale / concurrency | "What if 20 users instead of 1?" 20k rows? Two requests racing? |
| Empty / null / missing | No data, first-run, a required field absent, an empty list |
| Boundaries & limits | 0, 1, max, off-by-one, pagination edges, very large values |
| Long input / overflow | Long names / emails / org names — the usual `truncate` / `min-w-0` flex traps |
| Failure paths | Network error, partial write, a dependency down, a rejected promise |
| Ordering / timing | Stale reads, optimistic-update races, event ordering |
| i18n · mobile · a11y | RTL / long translations, small screens, keyboard / screen-reader |
| **Security** | Auth/authz, injection, leakage — **top priority when `review.riskProfile` is `security-critical`**, always present otherwise |
| Data loss / migration | Destructive ops, backwards-compat, migration on existing rows |

When configured, apply the skill named by `review.securitySkill` for the security angle and think in
the terms of `review.testingSkill` about untested behaviour — but **file issues; do not write code or
tests.** Cite every location as `<repo-root-relative path>:<line> — <symbol>`; the audit re-derives
citations against the base branch (`fleet check verify-citations --corpus <f> --ref origin/<base>`,
and `fleet check verify-paths` for the paths alone), and a bare filename is unverifiable.

### 7.4 File one issue per confirmed edge case

#### ⛔ Reconcile against the system of record at the START of every filing batch

**Never track "what have I already filed" in a file you maintain by hand, or in a running tally.**
Both drift, and the failure mode is **duplicate tickets** — the opposite of what the dedup gates exist
for. A hand-kept index once under-reported by 4; a conversational tally drifted from an actual 296 to
a believed 275.

Ask the tracker, every batch: **`op-16 findIssues({group, labels: [provenanceLabel], priority: 1,
limit})`**, then `priority: 2`, `3`, `4` — one call per band — and hand the four pages to
`fleet check reconcile tracker --pages <json>`.

- **Split by `priority` so each band fits in one page**, and the CLI **asserts `complete` on every
  band** before combining. **A page that returns exactly its `limit` with no explicit completeness
  signal is truncated by definition**, with no error and no ellipsis. A truncated *filed* set makes
  real work look undone and manufactures phantom High/Urgent backlog.
- **Join on the PR header line, never the title.** Every description starts `**PR:** #<n>`; titles get
  rewritten when filing, so text similarity under-matches badly. If you must match on titles, score by
  containment on the *shorter* side (`len(a & b) / min(len(a), len(b))`), never by the finding's own
  token count — and sanity-check it against a title you know you just created.

#### ⛔ Rediscovery is a signal, not just a duplicate

When two slices that share no PRs cite the same `file:line`, you are looking at a **shared component**,
and independent rediscovery is *evidence the finding is real*. It changes two things:

- **Scope:** file the **pattern**, not the instance. List every call site and say the fix belongs in the
  shared component. (A shared input primitive that hard-codes `tabIndex={-1}` for *every* consumer —
  fixing one caller leaves the next one broken.)
- **Procedure:** when a finding matches one already filed, **append the new call site and PR reference
  to the existing issue** (`op-15 patchBody` if you created it; otherwise hand it to the orchestrator,
  who owns edits to other agents' issues) rather than just dropping it. The second sighting is
  information the first ticket did not have. Record the pair in `xref.tsv`
  (`<key> <key> <shared file:symbol>`) so `fleet check dups cluster` and the audit see it.

#### Creating the issue

`op-13 createIssue({title, body, labels[], priority, assignee, group, parent?, state, links: [{url:
<PR url>, title: "PR #<n>"}]})` with every ID taken from the manifest.

- **Title** — concise and specific to the *one* edge case.
- **Body** — plain English, not too technical:

  ```markdown
  **PR:** #<n> — <url> — *(merged 2026-03-14)* | *(open at time of review)*
  **What the PR does:** <1–2 plain sentences>
  **Edge case:** <the problem in plain terms + why it matters / what breaks at scale>
  **Where:** <repo-root-relative path>:<line> — <symbol>
  **Priority:** <Urgent | High | Medium | Low> — <one-line why>
  **Gate:** pending (<sweepId>)

  ![screenshot](<url>)
  _Area affected (context, not a repro): <screen/component>._   ← caption when the shot isn't a repro
  ```

  The `**PR:**` line is the join key for every reconcile (above), and it also records the PR's **state
  at review time**, copied from `worklist.tsv`'s `<merged_at|open>` column as `*(merged <date>)*` or
  `*(open at time of review)*`. **⛔ A finding on an open PR is a claim with an expiry date, so write
  the marker on every ticket** — it is written once, at filing time, by a worker that is gone by the
  time it stops being true, and without it nothing downstream can tell which tickets were argued
  against a PR that has since landed (section 8, check 3). The `**Where:**` line is what the
  audit opens — full path, never a bare filename, never capitalised or abbreviated with `...`. The
  `**Gate:**` line is written `pending (<sweepId>)` by the sweep and rewritten by `fleet check gate
  apply` after the audit; never set it to anything else yourself. The `![screenshot]` line is
  **required on every issue** (section 7.5). Only when there is genuinely no associated UI at all,
  replace it with `_No UI surface — <reason>._`
- **Priority** — set it **both** as the tracker `priority` field **and** on the `**Priority:**` line
  in the body (canonical `1 Urgent · 2 High · 3 Medium · 4 Low`; the adapter maps it). Map impact:
  security / data-loss / scaling → Urgent (1) or High (2); functional-but-minor → Medium (3);
  cosmetic → Low (4). When two agents would disagree, the body line carries the argument and the
  field carries the number — the audit compares them.
- **State** — the triage state: `checker.triage.state`, else the adapter's default for a new issue.
  A checker-filed ticket is never born `ready`; the gate promotes it (section 9).
- **Labels** — pick from **existing** labels returned by `op-17 listLabels(scope)` at plan time (the
  manifest holds them). Don't invent labels; the only ones the sweep may create are the three
  `op-18 ensureLabel` ensured at plan time. Every filed issue carries `checker.provenanceLabel`,
  `checker.triage.label` and `checker.gate.labels.pending`; a security-angle finding also carries
  `checker.securityLabel` when it is configured.
- **The two a11y classes get their own labels and a forced priority.** Keyboard-only and
  screen-reader findings are real and still worth listing, but they must be filterable out of the
  working queue:
  - focus / tab order / arrow nav / an unreachable control → `checker.a11y.labels.keyboard`
  - missing accessible name / unannounced state change / mislabelled control →
    `checker.a11y.labels.screenReader`
  - both apply → add both.

  Every issue carrying either label is forced to `checker.a11y.forcedPriority` (default **Low, 4**)
  regardless of assessed impact, and its `**Priority:**` body line says Low to match. Do **not**
  stretch a genuine functional bug into an a11y one to bury it, or the reverse.

  **⛔ Every a11y issue is a SUB-ISSUE of one umbrella issue.** The launcher creates it once per sweep
  at plan time — title exactly `checker.a11y.umbrellaTitle` (default `a11y`), in the sweep's group,
  assigned to the current user, at the forced priority, carrying both a11y labels — and the manifest
  holds its key; pass it as `parent` on every a11y finding you file (`op-13`'s `parent`, or `op-23
  setParent` afterwards — the umbrella is shared state, so the orchestrator applies the parenting in
  `sessions` and `cloud` mode). When the adapter lacks `capabilities.subIssues`, its `If unsupported:`
  line for `op-23` decides the fallback (an index body the orchestrator maintains); never skip the
  grouping.

  This is what makes the rule work. Labels alone still leave 60+ tickets interleaved in the group
  view; one collapsed parent removes them from the working queue while keeping **one issue per gap**,
  so no detail is lost to consolidation. Do **not** merge several call sites into one "pattern"
  ticket instead — sub-issues were asked for specifically, and a pattern ticket loses the per-site
  file/line/PR that makes each one actionable.

  - Give the umbrella body the **recurring shapes** table (focus dropped to `<body>`, state change
    never announced, no accessible name, keyboard-unreachable) — the value of collecting them is
    seeing that four mechanisms explain almost all of them. Cite only constructs that exist on the
    base branch; the audit gates the umbrella's guidance like any ticket.
  - **Re-parent retroactively.** If a sweep is already under way when the umbrella is created, `op-16
    findIssues` the group by each a11y label, union the two result sets, and `op-23 setParent` every
    one onto the umbrella. Cheap, and it is the only way the parent is actually complete.
  - The forced Low applies to **every** sub-issue with no exception — including ones you assessed
    High. Sub-issue priority is not the escalation channel; the `**Priority:**` line in the body is.
    Say *"filed **Low** per the standing a11y rule; assessed High because …"* and list them in the
    final report so the operator can lift the ones they agree with in one pass.

  **⛔ The WHO-IS-HARMED test decides whether the a11y label goes on AT ALL — not what priority a
  labelled issue gets.** Once the label is on, Low is unconditional. So the judgement happens *before*
  labelling, and it is the only judgement that matters here. Ask: *who is affected if this is never
  fixed?*

  - **Only keyboard users, or only screen-reader users** → apply the label, parent it to the umbrella,
    force Low. The rule working as intended.
  - **Everyone, with an a11y dimension as well** → **do NOT apply the a11y label.** File it as an
    ordinary top-level issue at true severity and describe the a11y dimension in the body. A pending
    invitation that hides *who sent it* (unnamed buttons are merely the a11y half), a menu that closes
    mid-interaction (focus loss is the a11y half), a duplicated sensitive input in the tab order —
    these are functional bugs that also happen to hurt assistive-technology users. Labelling them
    buries a real bug, and under the umbrella rule it now also **hides them from the group view
    entirely**, which is a strictly worse outcome than the old label-only version of this mistake.

  That last point is why this test got sharper when sub-issues arrived: mislabelling used to cost
  queue position, and now costs visibility. Get it right at classification time.

  **When the label genuinely applies to something severe, say so in the body:** *"filed Low per the
  standing a11y rule; the review assessed this High because …"*. The rule then costs queue position,
  not information — and the operator can revisit the policy, which they cannot do if every a11y ticket
  looks equally trivial. Shapes that have been assessed High and filed Low: a share dialog's recipient
  field being keyboard-unreachable (total loss of the feature for keyboard users), a permanent focus
  loss to `<body>` on an error path, and a reveal toggle being `tabIndex={-1}` **and unnamed** on
  *every* secret field.

  **Fix the classification at source.** The brief tells the worker: *set `a11yClass` to `keyboard` /
  `screen_reader` only when the defect is genuinely about those users; a functional bug with an
  incidental focus side-effect is `none`.* Cheaper than re-judging every finding at filing time.
- **Assignee** — `checker.routing` is a list of `{paths: glob[], assignee}`; match the **defect's**
  path (the `**Where:**` line), first hit wins, resolved through `op-3 resolveUser`. No hit ⇒
  `checker.assignee` (default `"me"`, the current user). Judge by where the **defect** lives, not by
  which PR surfaced it. Every a11y issue routes like any other; the umbrella itself is the current
  user's.
- **⛔ Write echo — don't double-file.** A large `op-13` / `op-14` call can return an "error" like
  *"result exceeds maximum allowed tokens / saved to <file>"* — that's the oversized **echo**, and
  the write usually **applied.** Don't blindly retry (you'll create a duplicate). **Re-fetch first**:
  `op-16 findIssues` on the PR header line (or `op-2 getIssue` if you already hold the key), or grep
  the saved result file. Trackers also auto-convert PR links into embeds, so plain-text matching of
  your own writes under-counts.
- **⛔ Mark every retryable failure `blocking` or `cosmetic` in the brief.** Left unsaid, a
  conscientious worker will burn unbounded wall-clock on a trivial field — a tracker's *per-workspace*
  link-attachment rate limit once cost several workers 20+ minutes each of pure sleeping. **A
  per-workspace rate limit is contention, not a transient — defer, do not retry.** Cosmetic failures
  (`op-8 attachLink`, `op-22 attachImage`, a label add, `op-25 relate` between sibling findings of one
  PR): record the key and the missing piece in the report, move on; the orchestrator sweeps them at the
  end when waiting is free. Blocking failures (`op-13` itself, a missing bundle, a 0-byte diff, the
  filed-ledger append): record the PR `failed` with the note and stop that PR.
- **`fid` and the filed ledger.** Before filing, `fleet check fid mint <slice> --count N` mints one
  **stable opaque `fid`** (`<slice>|<pr>|<index>`) per candidate you are about to file. Immediately
  after each successful create — never batched — append one row `fid → key → url → pr → priority →
  a11y` to your **private** `filed/<slice>.tsv`, and one record per candidate (filed *and* dropped,
  with `where: [{path, line, symbol}]` and a `state`) to `findings/<slice>.jsonl`. Never dedup or
  join on title similarity: that mis-scored 28 of 100 in one sweep, while an opaque key cannot
  drift. `fleet check reconcile filed --json` then asserts **all four agree — row count, unique
  `fid`s, unique issue keys, and the slice total.** Four numbers agreeing is what makes "0 failed" a
  fact rather than a claim.
- A running worker can be corrected mid-run by message; it lands at the worker's next tool round.

### 7.5 Screenshots — always attach a visual of the affected area

**Every issue gets a screenshot**, even when the edge case can't be reproduced. The shot's job is to
**orient the reader** — show the screen/component the issue is about — not to prove the bug. (A prior
run filed 15 issues with zero screenshots; that is the failure mode this prevents.) `checker.screenshots`
is `always` by default; `when-ui` only skips the capture attempt for findings you have already judged
`_No UI surface_`; `never` replaces the line with `_No screenshot attached: disabled by config_`.

- **Reproducible visually?** Capture that exact state.
- **Not reproducible** (backend race, scale, a state you can't trigger)? Still capture the
  **relevant screen/component in its normal state**, and caption it in the body:
  `_Area affected (context, not a repro): <screen/component>._`
- **Skip only** when there is genuinely **no associated UI at all** (pure infra / no screen) — then
  write `_No UI surface — <reason>._` and flag it in the summary. Treat this as rare; most edge cases
  touch *some* screen (a settings page, a list, a modal, an empty state).
- **Could not capture** (repair failed, section 6) is a different line: `_No screenshot attached:
  <reason>_`, counted separately in the report from the no-UI skips.

**Capture:** `fleet pool acquire testing --wait <s> --json` → you hold one slot and its URL. Sign in
via `capture.loginUrlTemplate` (`{base}` = the slot URL, `{account}` = one of `capture.accounts`,
so parallel captures never share a session), navigate to the affected UI with `capture.runner`
against `{url}`, save the PNG under `<sweepDir>/shots/<fid>.png`, then **`fleet pool release
testing <slot>`** — always, including on failure. Drive the **live dev app**, not a repro harness.
**Serialize onto the small isolated-account pool** (section 3): a few concurrent browsers at most,
each on its own account, never the full wave. If the app is unreachable, repair it (section 6) —
bring the stack up yourself and continue; only if a genuine repair attempt fails, note it on the
issue and tell the operator in the report. Never skip the screenshot just because the app was down.

Two configurations have no local slot to acquire: `testing.count: 0` (no pool was booted) and
`capture.mode: cloud`. Then the capture belongs to the cloud sandbox that reviewed the PR and arrives
with its results branch (section 5); if neither is available, the finding takes
`_No screenshot attached: no capture slot_` and is counted in the report. `capture.mode: none` means
the repo has opted out entirely — the line is `_No screenshot attached: capture disabled_`, and it is
never a reason to skip filing.

**Embed — `op-22 attachImage(key, filePath, {alt, caption})`.** Some trackers require an existing
issue before they accept an upload, so the order is always **create → upload → embed**:

1. `op-13 createIssue` with the text body and a placeholder `![screenshot]` line; capture its key.
2. `op-22 attachImage` using the **strategy the manifest records** (chosen by the CLI from the
   adapter's `imageEmbed` / `imageUpload` capabilities and `checker.attachStrategy`; never improvise
   one). Native uploads send every header the adapter's `Transport:` line names **verbatim** (casing
   included), finish one file within the signed window (~60 s) before preparing the next, and **store
   the bare URL** — some trackers re-sign on read, and a stored signed URL rots. The `assets-branch`
   strategy is `fleet assets add <png> --branch <vcs.assetsBranchTemplate rendered for this sweep>`
   plus a raw-content link, so the PNG never enters the diff. `attachment` strategies embed nothing
   and add the caption sentence instead.
3. `op-15 patchBody` (or `op-14 updateIssue`) to replace the placeholder with `![screenshot](<url>)`.

**One upload per screenshot.** Sibling findings that share a screen inline the **same URL** in their
create call — never re-upload the same PNG. Strategy `none` (or a cosmetic upload failure) ⇒
`_No screenshot attached: <reason>_`, never a silently missing line.

### 7.6 Report (per worker → orchestrator)

Return **only** the compact report: per PR — created issues (key + URL + priority + a11y flag),
candidates **dropped** with the gate that dropped each (the target PR / the later PR `#<n>` that
already addressed it / the open PR that would), screenshots attached, `_No UI surface_` skips,
`_No screenshot attached_` failures, cosmetic failures left for the sweep (key + missing piece),
a11y issues assessed High and filed Low, and the line "no source files touched". No diffs, no tool
output, no image bytes.

---

## 8. Finish

When `fleet check ledger resume` reports `remaining=0`, run **`fleet check finish <sweepId> --json`**.
It refuses to complete until every check passes, and each check is a rule that was once broken by hand:

1. **Four counts**, per slice and for the sweep: ledger `filed` rows == rows in `filed/*.tsv` ==
   unique `fid`s == unique issue keys (`fleet check reconcile filed`). A disagreement names the slice;
   re-check that slice's last create against the tracker (`op-16` on the PR header line) and repair
   the row — never "fix" the count.
2. **Ledger ↔ findings reconcile** (`fleet check ledger reconcile --from findings`): every `filed` PR
   has ≥1 finding in state `filed`, every `clean` PR has none, every candidate in `findings/*.jsonl`
   carries a terminal `state`. Bind the ledger to the **outcome**, never the transport.
3. **Frame re-check.** First, `fleet check finish` **merges the workers' per-slice `findings/*.jsonl`
   into the sweep's single `findings.jsonl`** — from here on (this check, the audit, section 9) the
   merged `findings.jsonl` is the corpus that is read and written, and the per-slice files are history.
   A long fan-out pins the tree at dispatch time and the base branch keeps moving —
   especially on a sweep that reviews **open** PRs, because those are exactly the PRs about to merge.
   `fleet check blast-radius --since <manifest.snapshotSha>` fetches the base branch, counts the commits
   since the snapshot (0 ⇒ nothing to do) and lists the changed paths; `fleet check frame check` then
   names every finding whose `**Where:**` path is in that list — matched on the **full path**, because
   a basename match once gave 66 hits of which 42 were bogus. Re-read those findings against the base
   branch's current contents with `git show origin/<base>:<path>` (and
   `git diff <snapshot>..origin/<base> -- <path>`), then mark any now-fixed finding `already_fixed` in
   `findings.jsonl` so the audit cancels it with the evidence comment. **⛔ Do not `git checkout` to
   read the new code** — other agents may still be reading the tree, and a stale-tree read silently
   returns the OLD file, so an agent concludes "unchanged" and is wrong. Expect low yield; the point is
   not the count. Until this runs, "verified against current code" is an overclaim.

   **⛔ A sweep over open PRs has a shelf life — re-resolve the merge state of every PR that
   `worklist.tsv` recorded as `open`, at wrap-up and on every revisit.** The PRs a sweep reviews while
   they are open are exactly the ones about to merge, and the moment one lands its findings change
   meaning from "a gap in a proposed change" to "a defect on the base branch" while their tickets go on
   asserting a state the repository has left. Measured: five reviewed-while-open PRs had merged by
   wrap-up, carrying 8 findings whose tickets still read *(open at time of review)*. Resolve each state
   through the forge (the same open-PR / gate-2 indexes as section 7.3; a local `git log
   HEAD..origin/<base>` is the cheap version and is trustworthy **only** on a complete clone, because a
   shallow one truncates silently). For every PR that landed: `op-15 patchBody` its tickets' `**PR:**`
   line to `*(merged <date>)*`, and run the frame check above over that PR's paths — a merge routinely
   fixes one half of a finding and leaves the other, so "it merged" is not "it is fixed".
4. **Cosmetic sweep.** Drain the cosmetic failures the workers reported: `op-8 attachLink`, `op-22`
   retries, label adds, `op-25 relate` — now that waiting is free. Drain the outbox
   (`fleet outbox list`) and the last wave's mirror ticks; the mirror must equal the ledger before
   finish completes.
5. **Manifest complete**: counts (worklist / filed / clean / skipped / failed / no-UI / no-screenshot /
   a11y-forced-Low), audit status `pending`, `RESUME.md` marked finished. Every filed row is ingested
   with `fleet ticket cache --issue <KEY> --from-json -` so a later `/fleet` session has the body, the
   PR and the `where` locally, without the tracker.

**Then, ALWAYS the audit — `fleet check finish` has already chained `fleet check audit plan`.** Follow
`playbooks/check-audit.md` with the `sweepId` and `auditRunId` that `finish` printed; do **not** run
`audit plan` again for this sweep, or you mint a second `auditRunId` over the same corpus. The audit is
not optional and not a flag: it runs on the finished corpus, batches by category, and is the only step
that cancels, downgrades or re-parents a filed ticket. Run `fleet check audit plan <sweepId|project>
--json` by hand only for `/fleet-check audit <sweepId|project>` on an older corpus.

Finally, aggregate the ledger and the audit into **one summary for the operator, grouped by PR**:
filed (key, URL, priority), dropped (with the gate and PR that dropped each), screenshots / no-UI /
no-screenshot counts **with their provenance in the same sentence as the tally** ("N of M, M from the
ledger" — never a bare N), the a11y assessed-High-filed-Low list, the cosmetic failures that still
failed, and every decision you made where the source was ambiguous. Confirm no source files were
touched.

---

## 9. Handoff — triage → gate → promote → fleet

- **Filed ⇒ triage.** Every checker ticket is born in the triage state (`checker.triage.state`, else
  the adapter default) with `checker.triage.label`, `checker.provenanceLabel` and
  `checker.gate.labels.pending`, and its body carries `**Gate:** pending (<sweepId>)`.
- **Audit ⇒ gate.** The audit writes `audit/verdicts.tsv`; `fleet check gate apply --verdicts <tsv>`
  mirrors a `gate:<passed|failed|uncertain|disputed>` label (`checker.gate.labels.*`) and the
  `**Gate:**` body line onto each issue, patches a `⛔ DO NOT …` block into the body immediately after
  a defective prescription (a comment does not protect a fixer who reads only the description), and
  cancels confirmed false positives with the evidence comment **first** (`op-9`). `fleet check gate
  status` shows the split.
- **Promote.** `checker.autoPromote` is `never` (default) or `after-audit`. With `never`, a human
  promotes `gate:passed` tickets in the tracker UI or with `/fleet-check promote <sweepId> [--all |
  --fid … | --min-priority N]`; with `after-audit` (or `--auto` on this run) the sweep promotes them
  itself once the audit has applied. Promotion moves the ticket to `checker.ready.state` (default:
  the adapter's `unstarted` state), adds `checker.ready.label` when set, and removes the triage label.
  `--waive` (`gate:waived`) is **human-only** — never pass it from a playbook. There is no streaming
  promotion: the audit's rules are corpus-level (the frame is re-derived *after filing stops*, batched
  by category) and cannot run per wave, so `--auto` is refused with a hint when no gate exists to
  collapse.
- **Fleet intake refuses any checker-filed ticket without `gate:passed | gate:waived`**
  (`fleet.queue.requireGate: true`, `fleet intake check <KEY…>`); refusals are counted in `fleet
  status` and logged, never silent. A fleet session treats the ticket's *prescribed fix* as a
  hypothesis; if it refutes it, it patches a ⛔ note into the description — where the next reader
  acts — not only a comment, and flags `--prescription refuted`.
- **Tracker-less** (`tracker.mode: none`): rows in `findings.jsonl` get `localId: CHK-<sweepId>-<n>`
  and go through the same audit; `/fleet-check promote` flips their `state`; autowave with
  `fleet.queue.source: findings` spawns sessions whose task text is the finding body; a session's
  done-flag is reflected back with `fleet check mark <localId> done`.

---

## A. Worker brief (rendered by `fleet check brief`)

`fleet check brief --json` renders the per-PR brief from the manifest, the mode and the slice. It is
handed to the worker verbatim; do not paraphrase it (a compressed paraphrase drops the qualifier that
made a rule survivable). Its shape:

```markdown
# fleet-check worker — PR #<n> · sweep <sweepId> · slice <slice> · fid range <slice>|<n>|1..N

You are reviewing ONE PR for edge cases that are still open on <base>. Findings-only: never edit
code, tests or config. NEVER ask a question — decide, act, and report what you chose.

## Inputs (read, never re-resolve)
- manifest: <sweepDir>/manifest.json — group <id>, assignee <ref>, umbrella <key>, labels {…}, triage state <ref>
- bundle: <sweepDir>/_sweep/prs/<n>.json · <n>.diff · gate-2 index · open-PR index
- playbook: playbooks/check.md section 7 (this is the procedure; run 7.1–7.6 for this PR only)

## You MAY / you MAY NOT
| operation | you |
| --- | --- |
| op-13 createIssue for a finding of THIS PR | MAY  (cloud: MAY NOT — emit a createIssue outbox entry instead) |
| op-14 / op-15 / op-22 on an issue YOU created | MAY  (cloud: MAY NOT) |
| op-16 findIssues to reconcile before filing | MAY  (cloud: use the bundle's filed index only) |
| op-27 tickWorkItem · the a11y umbrella · op-15 on another agent's issue · op-21 · op-18 | MAY NOT — orchestrator only |
| forge CLI queries for gate 2 / gate 3 | MAY  (cloud: MAY NOT — the indexes are in the bundle) |
| spawn another per-PR layer | MAY NOT |
| read, grep, cat or edit any path matching vcs.sensitivePaths: <globs> | MAY NOT — a permission prompt hangs you forever with no failure marker |

## Retryable failures — how long to care
- blocking (record the PR `failed` with a note, stop this PR): op-13 create failing for a reason that
  is not a write echo · bundle missing or 0-byte diff · the filed-ledger append failing
- cosmetic (record key + missing piece in your report, move on — the orchestrator sweeps at the end):
  op-8 attachLink · op-22 attachImage · a label add · op-25 relate · ANY per-workspace rate limit
  (that is contention, not a transient — never sleep on it)
- write echo ("result exceeds maximum … saved to <file>"): the write usually applied — re-fetch
  via op-16 on the `**PR:** #<n>` line before any retry

## a11yClass
Set `keyboard` / `screen_reader` only when the defect is genuinely about those users; a functional
bug with an incidental focus side-effect is `none`. Who is harmed if this is never fixed?

## Screenshots
`fleet pool acquire testing` → capture with capture.runner via capture.loginUrlTemplate → release.
Every issue gets one; `_No UI surface — <reason>._` only when there is truly no screen;
`_No screenshot attached: <reason>_` when the repair failed.

## Return ONLY this
- filed: [{fid, key, url, priority, a11y}]
- dropped: [{candidate, gate, by: "#<n>" | "target PR" | "open #<n>"}]
- screenshots: {attached: N, noUi: N, noShot: N}
- cosmeticFailures: [{key, op, detail}]
- a11yAssessedHigherThanFiled: [{key, assessed, why}]
- "no source files touched"
No raw diffs. No tool output. No image bytes.
```

The brief also states the `checker.routing` table and `checker.a11y.forcedPriority` so the worker
routes and forces priority without re-reading config.

---

## B. Tracker operations used in this playbook

Only these, only by these names; the adapter decides the call.

| op | used for |
| --- | --- |
| `op-2 getIssue` | re-fetching an issue you hold the key for (write-echo check) |
| `op-3 resolveUser` | `"me"` at plan time; `checker.routing` assignees |
| `op-8 attachLink` | the PR link on each issue (cosmetic if it fails) |
| `op-11 comment` | evidence comments, verbatim, before any state change (audit) |
| `op-13 createIssue` | every finding; the a11y umbrella (launcher) |
| `op-14 updateIssue` | embedding the screenshot; label / priority fixes on your own issues |
| `op-15 patchBody` | replacing the `![screenshot]` placeholder; appending a rediscovered call site; the `**Gate:**` line (gate apply) |
| `op-16 findIssues` | reconcile-first, banded by priority; the resume re-check on the PR header line; retro re-parenting |
| `op-17 listLabels` | the only source of labels (plan time) |
| `op-18 ensureLabel` | provenance · triage · gate:pending — **launcher-only**, once per sweep |
| `op-19 listStates` | triage / ready state refs (plan time) |
| `op-20 resolveProject` · `op-21 createProject` | the sweep's group, by ID in the manifest |
| `op-22 attachImage` | one upload per screenshot, strategy from the manifest, bare URL stored |
| `op-23 setParent` | a11y findings onto the umbrella — orchestrator applies it in `sessions` / `cloud` |
| `op-25 relate` | cross-links between sibling findings of one PR (cosmetic if it fails) |
| `op-26 readWorkItems` | the `<KEY>` input, read once into the worklist |
| `op-27 tickWorkItem` | the mirror — **launcher-only, ALWAYS**, drained once per wave |

Not used here: `op-9 cancel` and `op-24 markDuplicate` belong to the audit — never cancel or
de-duplicate a ticket during the sweep. `op-1`, `op-4`–`op-7`, `op-10` and `op-12 listQueue` belong
to `/fleet`.
