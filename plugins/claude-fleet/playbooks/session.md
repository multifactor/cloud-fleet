# Working-session playbook

Operating instructions for a claude-fleet session whose role is **`working`** — one session, one
ticket, one branch, one draft PR. Follow this from the top. Everything you need to know about *which*
repo, *which* ticket and *where* to write comes from your session descriptor and the `FLEET_*`
environment (section 0); nothing in this document is a literal path on anyone's machine.

The tracker is only ever named by its operation number (`op-2`, `op-11`, …). The mapping from an op to
the concrete tool call lives in the adapter file your descriptor points at (`tracker.adapterPath`), and
nowhere else.

---

## TL;DR — the rules that matter most

- ⛔ **Never `git stash`.** `refs/stash` is shared across every worktree of this repo; a concurrent
  session's stash op races with yours and can pop *their* work into your tree or drop yours.
- ⛔ **Never start a dev server in this worktree while `working`** — not even briefly, not even for a
  screenshot. Every session doing that at once is what hard-powers-off the machine. Capture goes
  through `fleet pool acquire testing`, or `fleet cloud dispatch`, or not at all.
- ⛔ **Never run `commands.stopAll`** (the repo-wide killer) and **never kill processes by exclusion** —
  both reach into other sessions' trees, including the testing servers everyone shares.
- ⛔ **Never run the install yourself** (`commands.bootstrap`, a bare package install, or a "repair").
  A second writer in one worktree produces a tree the package manager will then refuse to repair.
- ⛔ **Never ask which issue to work on.** Your descriptor carries it. Nobody is reading your window;
  the launcher only reads **flags**, so a question in your output is a session that has stopped for
  no reason.
- ⛔ **The ticket's prescribed fix is a hypothesis, not an order.** Quote it, re-derive the mechanism
  from current code, test the prescription before writing it, and record the outcome (section 10.4).
- ⛔ **Screenshots are real captures from the live app or they do not exist.** Inventing, mocking,
  reconstructing or placeholding an image is a serious error — worse than having none.
- ⛔ **A draft PR is the only PR you open**, and `fleet flag done` is the **very last** thing you do.
  That flag is what frees your worktree's RAM and disk for the next wave.
- **Fan out read-only subagents at every stage.** Always on; you alone make edits.
- **When infrastructure blocks you, write `fleet flag blocked` and keep working** on everything that
  does not depend on the blocker. Never work around it by starting a server.

---

## 0. Who you are — read your descriptor first

Your identity, assignment and every path you may write to come from **one file and a handful of
environment variables**. Read them before anything else.

**The descriptor** is the JSON file at **`$FLEET_SESSION_FILE`** (also registered under
`$FLEET_STATE_DIR/sessions/<label>.json`). Its fields:

| field | what it tells you |
| --- | --- |
| `id`, `label`, `role` | who you are; `role` must be `working` for this playbook to apply |
| `worktree`, `branch` | the worktree you own, and the branch you were launched on (empty = detached) |
| `issue` | **your assigned ticket key** (or, in tracker-less mode, the PR number / branch / task reference) |
| `ticketFile` | the launcher's offline copy of the ticket text (`fleet ticket cache`), read it when the tracker is unreachable |
| `tracker{id mode adapterPath scope states assignee}` | which adapter to speak through, the mode (`mcp` / `manual` / `none`), the resolved `in-progress` / `in-review` / `cancelled` states, and the assignee (default `"me"` = the current user) |
| `playbook` | the path of this document (a project overlay wins over the plugin copy) |
| `testingUrl`, `testingUrls` | the default testing slot URL and every slot actually running — **empty means there is no local pool** |
| `paths{stateDir flagsDir outboxDir artifactsDir}` | where flags, queued tracker ops and your scratch review page go |
| `readyFlag` | the sentinel file the launcher writes in your worktree root when your install is complete (`install.readyFlag`, default `.fleet-ready`) |
| `agent`, `model` | what you are running as |
| `transcriptDir` | where your transcript lands (the launcher reads it to see you are alive) |
| `backendRef`, `shimPid`, `agentPid`, `pgid`, `createdAt` | the launcher's handles on you — informational; never act on another session's |

**Mirrored environment scalars**, present in every session:

```
FLEET_SESSION=1          FLEET_SESSION_FILE     FLEET_LABEL           FLEET_ROLE
FLEET_STATE_FILE         FLEET_STATE_DIR        FLEET_TESTING_URL     FLEET_TESTING_URLS
FLEET_TRACKER_MODE
```

(`FLEET_SWEEP_DIR` and `FLEET_SLICE` exist only for `checker` sessions and are not yours.)
`fleet session env --label $FLEET_LABEL` prints the same set if you need to re-read it. Any *config*
key this playbook names — `capture.mode`, `commands.test`, `vcs.branchTemplate`, … — is resolved for
your repo and your machine: read it with `fleet config get <key>` (or `fleet config resolve`) rather
than guessing at a default.

⛔ **Never substitute a literal path for any of these.** The state directory, the flags directory,
the scratch-page directory and the outbox differ per repo and per machine; a hard-coded temp
directory or home-directory path is how two repos end up sharing one flag file and one of them
reclaims the other's worktree.

---

## 1. Cross-session safety (CRITICAL — read first)

You share this git repo — and the per-branch dev-server proxy, if the project uses one — with several
other **live sessions running concurrently** in sibling worktrees, including the **testing sessions**,
which run the shared dev servers. Their work and yours must never collide. Hard rules:

- ⛔ **NEVER run `git stash`** (nor `stash pop` / `push` / `apply`). `refs/stash` is **shared across
  every worktree of this repo** — a concurrent session's stash op races with yours and can pop
  *their* WIP into your tree or silently drop yours. To set changes aside, make a WIP commit on your
  own branch instead — run `git add -A`, then `git commit -m wip` (undo later with
  `git reset --soft HEAD^`). Two separate commands, deliberately: a `&&` chain is a parser error in
  some of the shells a fleet runs in. If you find a stash that isn't yours, **leave it** — never
  `pop`. (The plugin ships a hook that blocks `git stash`; do not look for a way around it.)
- ⛔ **Stay inside your own worktree.** Never `git worktree remove` / `prune`, never run
  `commands.stopAll` (it is global and kills other sessions' servers, including the testing servers),
  never change global or `--system` git config, never delete `node_modules` (it is junction-shared
  across worktrees). Operate only within `worktree`; push only your own branch — **plus exactly two
  sanctioned extras** that capture owns: your throwaway capture ref (`vcs.captureRefTemplate`,
  default `capture/<KEY>`; deleted at close-out — force-push is fine for the **first** push of a ref
  only: ⛔ a re-dispatch after a correction MUST go on a **new** ref name (10.7b), never a force-push
  of the same one, because a fresh worker does not reliably see the force-pushed commit) and your
  assets branch (`vcs.assetsBranchTemplate`, default `assets-<KEY>`). Your actual issue branch still
  never gets pushed before close-out (section 14).
- ⛔ **Never kill a process by exclusion** ("everything except mine"). Match the exact process you
  own, deepest-first, protect yourself and your ancestors, re-query and assert — anything looser
  takes the testing servers and other sessions with it. If you need something killed that you did
  not start, flag it.
- **The ONE cross-worktree write** a working session may ever make is the merge of its own branch
  into a *testing* worktree it holds through the lock (section 10.7a). Nothing else, ever.

---

## 2. You are SERVERLESS in this worktree — never start a local server (HARD RULE)

⛔ **You must never run `commands.devServer`, or any framework's dev/serve command, in this worktree —
not even briefly, not even to grab a screenshot.** Every session doing that at once is what
hard-powers-off the machine, so the launcher's supervisor actively tree-kills any process matching
`devServer.serverProcessPattern` that it finds inside a working worktree. If something you started
vanishes, that is why. ⛔ **Never disable, evade or kill the supervisor** — it also repairs declared
services, restarts a dead testing server, reaps idle emulators and clears stale locks for everyone.
`fleet status` shows what it did.

Where your screenshots come from is decided by **`capture.mode`** (an `either`-scope key; the
resolved value is in your descriptor's config and may differ per machine):

| `capture.mode` | what you do |
| --- | --- |
| `local` | borrow a shared testing slot through `fleet pool acquire testing`, merge your branch into that slot's worktree, capture against that slot's URL, `fleet pool release testing <slot>` (section 10.7a) |
| `cloud` | dispatch your own throwaway sandbox with `fleet cloud dispatch` and collect from your assets branch (section 10.7b) |
| `none` | no screenshots are taken; every other step — the fix, the scratch review page, the PR — is unchanged (section 10.7c) |

`$FLEET_TESTING_URLS` lists the slots actually running in this fleet; **when it is EMPTY there is no
local pool** — do not probe testing URLs, do not run `acquire`. `$FLEET_TESTING_URL` is the default
slot (empty when there is no pool). Slot `n`'s branch is `testing.base` for `n == 1` and
`<testing.base>-<n>` otherwise; its URL is `devServer.urlTemplate` rendered for that slot.
⛔ **Never assume a URL — the lock tells you which slot you got**, and the wrong host means the
operator tests an app without your fix.

---

## 3. When something blocks you — RAISE A FLAG, don't struggle on

Infrastructure you don't own can stall you: a testing server that won't answer, a declared service
or container down, a testing slot you can't get, the emulator wedged, a cloud worker that never
delivers. **Don't sit silently, don't escalate to the operator, and above all don't work around it by
starting your own server.** Tell the launcher — it watches for this and can see the whole machine, so
it can tell whether the thing is genuinely broken, or simply busy with another session, and fix or
clear it for you.

Write the flag, then carry on with anything that doesn't depend on the blocker:

```
fleet flag blocked --category <category> --observation "<what you observed>" [--evidence-url <url>]
```

The CLI writes `$FLEET_STATE_DIR/flags/blocked-<label>.json` (plus a one-line `.txt` twin) with
`{"v":1,"session":"<label>","issue":"ABC-1234","category":"…","observation":"…","evidenceUrl":"…","at":"<iso>"}`.
Use one of these **categories** so the launcher can triage without guessing:

| category | when |
| --- | --- |
| `dev-server` | (only when a local pool exists) a testing URL won't answer, 5xxs, or serves an unexpected 404 after you waited through a rebuild |
| `testing-slot` | (only when a local pool exists) you have been retrying `fleet pool acquire testing` for well over ~15 min and never get a slot — "no pool configured" is NOT this: it means there is no pool at all |
| `services` | DB-backed routes fail, a declared container (`services.containers`, e.g. `app-postgres`) is down, the container runtime errors |
| `emulator` | the pooled emulator won't boot, won't take an install, or the slot never frees |
| `tracker` | the tracker MCP tools are absent **and** the offline ticket copy is missing too (section 9) |
| `cloud-env` | a cloud capture worker delivered a failure report, your dispatch itself errored, or the assets-branch poll timed out — include the worker's URL as `--evidence-url` and the failure excerpt |
| `install` | your `readyFlag` never appeared after the wait in section 5, or the install log shows a real failure |
| `other` | anything else you cannot resolve inside your own worktree (a failing build, a wedged pre-commit hook, an incomplete tree) |

**Judge a testing slot by the STATUS CODE, never by a header or by "it looks alive".** A dev stack is
usually two independent halves (the page server and the API/worker), and either can die on its own,
so there are four shapes and you must tell them apart:

- **App root 404 (or connection refused)** → there is no upstream: the page server is dead, or that
  slot was never started. Flag it (`dev-server`).
- **App root 5xx (502/503/504, or a proxy's own error page)** → something answers for that host but
  the server behind it is dead, wedged, or still coming up. Wait out one rebuild window, re-probe,
  and if it persists flag it (`dev-server`). ⛔ **No single status code is "the" dead-slot code** —
  which one a dead slot produces depends on the proxy in front of the pool, so never dismiss a 5xx
  as "not the dead shape".
- **Pages serve 200 but every API route returns 500** → the API half is dead: the app renders, so it
  looks alive, but sign-in can never work. Flag it (`dev-server`).
- **A route whose *normal* answer is 404 (an auth probe, a health path) returning 404 is HEALTHY.** Do
  not report it. `devServer.probes` lists what the launcher itself considers "up" (2xx/3xx on a
  45 s probe).

A proxy identification header rides on healthy 200s too, so a header proves nothing by itself — the
status code is the signal. And in all four cases you only ever flag: **never start or restart a
server yourself.**

⛔ **Never work around a failing build — flag the error and stop.** In particular, do **not** switch
off type-checking for the whole build (any "ignore build errors" knob in the framework config): that
disables it for the **entire** build, so a type error in your own change still produces a
good-looking binary or screenshot — which destroys the capture's whole value as evidence. A session
once did this on a belief that the repo could not build; the build in fact exited 0 on a clean base
branch. Flag the exact error (`other`) instead. Even a narrowly-targeted suppression isn't yours to
assume.

Be concrete — `ABC-1234 dev-server: https://testing-2.dev.localhost 502 for 6 min, slot listed as
running` is actionable; "it's broken" isn't. **Then keep working** on anything unaffected (reading
code, the fix itself, the review page's explanation) and retry the blocked step periodically; the
launcher will send back either "fixed, go ahead", "that's another session's — here's what to use
instead", or a specific instruction (it arrives as a message in your window via `fleet send`).

**Once you are unblocked, retire the flag** — say so in your next message, and if the blocker simply
cleared on its own (the slot freed, the rebuild finished) delete your own
`$FLEET_STATE_DIR/flags/blocked-<label>.json` and its `.txt` twin; the launcher removes it itself only
when it answers you. A blocked flag left lying around has the launcher diagnosing a blocker that is
already gone, and it hides the next real one. Write a fresh flag if it happens again — a recurrence
should look like a new flag, not like the same unresolved one. Only stop and hand back to the operator
if the launcher tells you to.

---

## 4. Fan out subagents (ALWAYS ON)

From the moment this session starts to the moment it finishes, **default to fanning out subagents.**
This is always enabled — you never wait to be told, and it applies to every stage of every flow
below. If something could be done by several agents at once, don't do it serially yourself.

**Launch read-only subagents in a single message** — whatever your agent CLI calls that capability
(`fleet.agent` decides which CLI you are; the mechanism differs, the rule does not) — so they actually
run concurrently. Use them for anything read-only, at any point, e.g.:

- **Understanding** — read the ticket, the affected components, and the surrounding conventions in
  parallel.
- **Root-causing** — several agents chasing the cause down different paths (one of them a broad-sweep
  explorer over the whole tree).
- **Testing the prescription** (section 10.4) — one agent per bypass string, per bound, per "second
  call site".
- **Auditing the fix** — a general auditor: does it do what the issue asked, and does it break
  anything nearby?
- **Sweeping for missed sites** — other places with the same bug pattern the fix didn't cover.
- **Pre-PR review** — audit the diff before you push.

Two hard limits, so this never collides with the serial work:

- ⛔ **Subagents are READ-ONLY.** They investigate and report back; they must never edit files, run
  git, start or stop servers, or touch the emulator. You own this worktree and you alone drive edits
  and captures — parallel writers collide (see Cross-session safety). Every edit is made by you,
  informed by what they find. Subagents also never read anything matching `vcs.sensitivePaths`.
- **Never sit idle waiting on them.** Launch, then get on with your own next step (the fix, the
  capture, the review page) while they work, and fold in what they surface when it lands.

⛔ **A subagent that died returned NOTHING — never read its silence as a null result.** If one comes
back "failed" or "terminated early due to an API error" (an overloaded upstream, a session or usage
limit), it produced no findings at all. It did **not** tell you "no matches", "no such convention
exists", or "nothing to fix", and you must never build a fix on that — **re-run it.** This has cost
real time: a "survey the wrapping convention" agent died and its silence looked like an answer.

---

## 5. Dependencies may still be installing (start reading, don't run anything yet)

Your window opens **immediately**, before the install finishes in your worktree — that is deliberate.
Installs used to run one-at-a-time with each window opening only after its own, so the last session
in a fleet appeared ~45 minutes late. Now every window opens up front — staggered a few seconds apart
(`install.spawnStaggerSec`), so a whole fleet booting simultaneously doesn't spike the box — and the
installs run behind them in **paced waves** (`install.concurrencyCap` at a time, a settle gap between
waves, and a hold whenever free RAM is under `install.reservePhysicalGb`).

So: **everything up to the first command is safe right now** — read your notes file (section 6), set
the ticket in progress, read the ticket, read the code, plan, fan out read-only subagents, and make
your edits.

**Before your first package-manager / test / build / capture command, wait for the sentinel** — the
file named by your descriptor's `readyFlag` (default `.fleet-ready`) **in your worktree root**. It is
written when your install completes *and* passes the install proof (`install.proof`: your tree
compared against a snapshot of the primary checkout).

Poll it every ~10 s, **at most ~50 iterations (≈8 min) per tool call**, then print a verdict:
`deps ready` or `NOT READY — re-run this same poll`.

- ⛔ **Anchor the check to the worktree root (`git rev-parse --show-toplevel`), never to the bare
  file name.** The shell tool's working directory **persists between calls**, so the moment you are
  anywhere but the root — a subdirectory, or wherever a previous command left you — a relative
  existence check silently returns *false* for a sentinel that exists, and you wait out the entire
  loop for nothing. One session's deps were ready two minutes before its poll started, and it burned
  ten minutes on a tree that was already complete.
- ⛔ **Keep the loop under the tool-call cap (600 s).** A longer loop can never reach its own
  verdict branch: instead of flagging, it is killed at the cap and moved to the background with no
  verdict at all, which reads as "still installing" forever. ~8 minutes leaves headroom for the
  verdict to actually print.
- ⛔ **8 minutes is ONE POLL, not a completion budget.** Installs run in waves, so on a large fleet
  your tree may not have *started* installing yet — the last wave of a 25-worktree run begins 30+
  minutes in. On `NOT READY`, simply run the same poll again. Only raise a flag (category `install`)
  after **six** consecutive polls (~50 min) with no sentinel, or as soon as the install log under
  `$FLEET_STATE_DIR/logs/` shows an actual failure. Flagging on the first `NOT READY` just tells the
  launcher something it already knows.

If it never appears, the install failed. Raise an `install` flag with the tail of the log rather than
trying to repair it yourself; a half-installed tree (packages present but zero binary shims) wedges
every retry and needs a rebuild that only the launcher should run (`fleet doctor --repair`).

⛔ **Do not treat a missing `node_modules` as a broken worktree, and do not run the install yourself**
— you would collide with the launcher's own install for your tree, which may be running now, queued
in a later wave, or held waiting for free RAM. A second writer in one worktree produces extraction
errors and a tree the package manager will then refuse to repair — it sees the package directory and
calls it installed. If your tree looks wrong, flag it; do not fix it.

⛔ **The ready flag proves the install RAN and the proof passed, not that every file you will touch
is intact.** A killed install leaves half-extracted packages, and a re-run will **not** repair them.
Unit tests and lint both pass on such a tree, so only a build catches it. So if a build fails on a
missing module or a missing type declaration, suspect an incomplete tree — including the **nested**
`node_modules` inside workspace packages — run `fleet doctor` to see the install proof, and flag it
(category `install`) rather than hand-patching the individual files it complains about, which only
silences the symptom. Do not infer your tree is usable from package counts, shim counts, a dependency
listing, or an install exit code: all of them have lied — one tree had a perfect shim count with the
compiler's main file missing entirely; another had the file and zero shims.

---

## 6. First action — crash-safe memory

**Read your notes, then keep them current.** If a file named `.fleet-session-notes.md` exists in your
worktree root, read it first. It is **your** durable crash-recovery note, and **you are the one who
writes it**. Nothing else captures your reasoning in a form the *next* agent in this worktree can
act on: `fleet relaunch` kills your process tree and spawns a fresh agent into the **same** worktree,
and that agent has your transcript at best and your notes at least. Maintain it as you go: **create
it once you understand the task, and UPDATE it at every milestone** — after you confirm the root
cause, after you commit the fix, after a dispatch (record the worker URL), before you hand off — with
a concise **state summary**: assigned issue + branch; what the bug is; the quoted prescription and
which of the three outcomes you are heading for (section 10.4); confirmed root cause; fix status incl.
commit hash; the exact next step. Keep it short — state, not a transcript.

⛔ **Never `git add` the notes file.** It is scratch and it is deleted at close-out (unlike the review
page, which survives close-out for the operator — 14.4). If you crash and reopen, this note is how
you pick up instantly. Work out from it what you were doing; **if your descriptor names an `issue`, or you are on a branch shaped like
`vcs.branchTemplate` (`ada/abc-1234-…`), or the note names a ticket — that IS your assignment. Do NOT
ask what to work on and do NOT just park. Continue that issue from where the note left off**,
proceeding with the next action; only stop and wait if the note shows your last action was
explicitly handing something to the operator for review or a decision.

Then decide which entry point applies:

- Your descriptor's **`issue` is set** → go to **Auto-start** (section 7a). This is the normal case.
- `issue` is empty and `git branch --show-current` **prints a branch name** → **Resume** (7b).
- `issue` is empty and HEAD is **detached** → **Fresh start** (7c).

---

## 7. Auto-start / Resume / Fresh start

### 7a. Auto-start (issue pre-assigned in the descriptor)

Your descriptor's `issue` names a specific ticket (e.g. `ABC-1234`) — you were fanned out to work
**that one issue**, so ⛔ **don't ask which issue or PR.** It is typically one **sub-issue** of a
parent that was split across sessions (one session per sub-issue): work **only** your assigned issue
— never the parent, never a sibling.

1. Run `git status --porcelain` and `git branch --show-current`.
2. **Clean and detached** (no branch, nothing uncommitted) → go straight to the **ticket flow**
   (section 10) for your assigned issue, starting at step 1. This is the normal case.
3. **Already on the branch for THIS issue** (the branch name contains your `<KEY>` in the position
   `vcs.branchTemplate` puts it) → this is a crash-reopen of the same issue, not a conflict. Read
   your notes to see how far you got, then **continue the ticket flow from where you left off** (or
   start it at step 1 if nothing was done) — don't ask, don't restart from scratch, don't sit idle.
4. **On a DIFFERENT branch, or uncommitted changes unrelated to `<KEY>`** → you are mid-work on
   something else. ⛔ **STOP — do not switch branches, reset, or discard anything** (see Cross-session
   safety). This is the one situation where you write a flag about *yourself*:
   `fleet flag blocked --category other --observation "assigned ABC-1234 but worktree is on branch <X> with uncommitted work"`
   and wait for the launcher's instruction. Nobody else can safely decide whose work that is.

### 7b. Resume (already on a branch, no `issue` in the descriptor)

- Do **not** change the branch. The branch name (`vcs.branchTemplate`, default
  `{prefix}/{key-lower}-{slug}`) tells you your assigned issue — the `<KEY>` segment, upper-cased.
- Read your notes (if present) to see how far the previous run got, then **continue that issue's
  ticket flow from the next step — don't park asking what to do.** If nothing was started yet, begin
  the flow at step 1. If the notes show you were mid-task, pick up at that step. Only if the notes
  show your last action was explicitly awaiting the operator's review or decision: say
  `Resumed on branch <name> — <where things stand>; awaiting <X>.` and wait. Otherwise proceed with
  the fix (there is no server to start — captures come from a slot or a sandbox) and keep going.

### 7c. Fresh start (detached, nothing assigned)

You were launched without an assignment (a bare `fleet up n`). The launcher will hand you one with
`fleet send`. ⛔ **Do not ask what to work on** — nobody is reading your window and the launcher only
reads flags, so a question there is a session that has stopped for no reason. Spend the wait reading:
the repo's layout, its conventions, the areas the fleet is working (fan out read-only subagents,
section 4). When the message arrives, act on it:

- An issue key (matching the adapter's `issueKey.pattern`) or an issue URL → **ticket flow**
  (section 10).
- A PR URL or number → **PR flow** (section 16).
- **Assignee:** always the descriptor's `tracker.assignee` (default `"me"`, the current user,
  resolved through op-3). You never assign work to a named person unless config routes it.

---

## 8. Tracker-less mode (`FLEET_TRACKER_MODE=none`)

When `FLEET_TRACKER_MODE` is `none`, there is no tracker at all. Your task is whatever the descriptor
gives you: the `issue` field holds a **PR number, a branch name, or a task reference**, and the task
text itself is in the file at `ticketFile` (also readable through `fleet ticket show <KEY>` where
`<KEY>` is the descriptor's `issue` value; for findings that `/fleet-check` produced tracker-less,
this is the finding body and the key is its `localId`).

In this mode you **skip every tracker op**: no op-2 (read `ticketFile` instead), no op-4/op-5/op-6
in-progress or assign, no op-7/op-8 at close-out, no op-9/op-10/op-11/op-14/op-15. Everything else —
the hypothesis discipline in 10.4, capture, the review page, the draft PR, the flags — is identical.
The `<KEY>` token in branch, capture-ref and assets-branch templates is the descriptor's `issue`
value. The done flag is still mandatory; for tracker-less findings it is how `fleet check mark
<localId> done` learns the finding shipped.

---

## 9. When the tracker MCP is absent — the outbox

The tracker's MCP tools can race a fleet-launch burst and simply not be registered in your session.
**Do not stall on that.**

- **Reading:** the launcher pre-writes every assigned issue's full ticket text with `fleet ticket
  cache`; the path is your descriptor's `ticketFile`, and `fleet ticket show <KEY>` prints it. Read
  that and carry on.
- **Writing:** every tracker op you would have performed — state changes, the assign, comments, the
  body patch, the PR link — goes into the outbox instead, and the launcher applies it through the
  adapter on its next monitor turn, **re-reads the issue to verify**, then acks it:

  ```
  fleet outbox add --op op-5  --key ABC-1234 --args '{"state":"in-progress"}'
  fleet outbox add --op op-11 --key ABC-1234 --args '{"text":"<your comment>"}' --verbatim
  fleet outbox add --op op-8  --key ABC-1234 --args '{"url":"<pr url>","title":"PR"}'
  ```

  `--verbatim` marks text the launcher must post **unchanged** — comments and body patches always
  carry it (op-11 is "never paraphrased" by definition, and the launcher honours that).
- Entries are applied in the order you add them, so queue them in the order this playbook performs
  them (op-11 before op-9; op-15 and op-11 before the done flag — section 10.4).
- The same mechanism is the contract for `tracker.mode: manual`, where **every** transition is queued
  by design.
- Write a `tracker` flag only if the MCP is absent **and** `ticketFile` is missing too.

Anything you queue is applied by the launcher, not by you; do not also retry it later through the
MCP if the tools reappear — you would apply it twice.

---

## 10. The ticket flow

### 10.1 Read the ticket

Read the issue with **op-2 `getIssue(key)`** → `{key, id, title, description, url, status, priority,
parentId, suggestedBranch?}`. If the MCP is absent, read `ticketFile` / `fleet ticket show <KEY>`
(section 9). Fan out read-only subagents at once: one on the ticket and its comments, one per
affected component, one on the surrounding conventions.

If the ticket carries the provenance label (`checker.provenanceLabel`, default `filed-by:fleet-check`),
it came out of a review sweep and its body has a `**Gate:**` line and possibly a `⛔ DO NOT` block
already patched in by the audit. Read both — the gate verdict is *diagnosis* quality; the ⛔ block is a
previous reader saying the *prescription* was wrong. When `fleet.queue.requireGate` is true (the
default), intake refuses a ticket that does not carry `<checker.gate.labels.passed>` or
`<checker.gate.labels.waived>` (default `gate:passed` / `gate:waived`), so you are normally not handed
an unaudited finding — but the gate is configurable and can be off, and audited is not the same as
correct either way (section 10.4).

### 10.2 Set in progress, assign to the current user

- **op-4 `resolveState(scope, in-progress)`** → `stateRef`, then **op-5 `setState(key, stateRef)`**
  (your descriptor's `tracker.states` already carries the resolved refs; use them).
- **op-3 `resolveUser("me")`** → `userRef`, then **op-6 `assign(key, userRef)`** — unless the
  descriptor's `tracker.assignee` is something other than `"me"`, in which case assign to that. You
  never pick a person yourself.

MCP absent → both through `fleet outbox add` (section 9).

### 10.3 Branch off the base branch

`git fetch <repo.remote>`, then create and check out a new branch off `<repo.remote>/<repo.baseBranch>`:

- **prefer the tracker's `suggestedBranch`** when op-2 returned one;
- otherwise render `vcs.branchTemplate` (default `{prefix}/{key-lower}-{slug}` → `ada/abc-1234-fix-wrap`),
  where `{prefix}` is `vcs.branchPrefix` (derived from your git user name unless configured).

Do **not** push it yet.

### 10.4 The prescription is a hypothesis

Most tickets prescribe a fix ("wrap the field", "add a bound of 200", "sanitise on the way in", "reuse
the helper from X"). The *diagnosis* of a well-audited ticket is usually right; the *prescription* is
a separate axis and is wrong far more often than the diagnosis — worst exactly where the diagnosis
looks most confident. Treat it as **the claim under test**, not the specification of your diff.

**1. Quote, do not paraphrase.** Copy the ticket's edge-case text and any prescribed fix **verbatim**
into your plan (and your notes file) as the claim under test. A paraphrase is already an
interpretation, and the whole point is to find where the original was wrong.

**2. Re-derive the mechanism from current code.** Tickets go stale and readers guess. Read from the
**function signature down** — not from the line the ticket cites; enumerate the **controls still on
screen** in the affected state (what can the user actually reach?); name the **caller that reaches
the state** the ticket describes. If you cannot name the caller, you have not found the mechanism
yet.

**3. Test the prescription before writing it.** The test depends on the shape of the prescription:

- **A sanitiser / validator** → run the bypass strings against the *current* code and against the
  prescribed rule: empty, whitespace-only, unicode look-alikes, the delimiter it splits on, a value
  that is valid *after* one round of the sanitiser and invalid after two.
- **A bound / limit** → **measure it**: what is the real value at the boundary, on the real data
  shape? A prescribed "200" that the layout truncates at 180 is a wrong prescription.
- **"Just show a message"** → name the **field the message comes from** and **where it is set**. If
  no code path sets it in the state the ticket describes, the message can never appear.
- **"Reuse the shared helper"** → check that the **second site actually calls it** — open the caller,
  not the helper. Helpers that "everything uses" frequently have one site that does not.

Fan these out as read-only subagents in one message; each returns evidence (`path:line`, the string,
the measured number).

**4. Three outcomes, each with a mandated write.** Decide which one you are in before you edit, and
record it in your notes.

| outcome | what you do | what you write |
| --- | --- | --- |
| **FOLLOWED** — the prescription survived step 3 | implement it as written | at close-out: `fleet flag done --outcome pr-pushed --pr-url <url> --prescription followed` |
| **AMENDED** — the diagnosis holds, the prescribed fix does not | implement the **corrected** fix | (a) **op-15 `patchBody(key, [{find: "<the prescription, verbatim>", replace: "<the prescription, verbatim>\n\n⛔ DO NOT <original prescription> — <one-line why>; see comment 2026-03-14"}])`** — the block lands **IMMEDIATELY AFTER the prescription in the description**, so the ticket is corrected *where it is read*, not only in a comment nobody scrolls to; (b) **op-11 `comment(key, verbatimText)`** with the evidence from step 3 (what you ran, what came back, `path:line`); (c) at close-out: `fleet flag done --outcome pr-pushed --pr-url <url> --prescription amended --body-patched` |
| **REFUTED DIAGNOSIS** — the mechanism the ticket describes does not exist in current code | **no code change**, and ⛔ **never cancel** | (a) **op-11 `comment`** with the evidence — the caller you traced, the control you enumerated, the value you measured; (b) **op-14 `updateIssue(key, {labels: {add: [<checker.gate.labels.disputed>]}})`** (default `gate:disputed`); (c) **op-10 `leaveOpen(key)`** — the explicit non-action; (d) `fleet flag done --outcome no-code-change --reason disputed --prescription refuted` |

⛔ **Never cancel on a refuted diagnosis.** One reader's refutation is overturned most of the time
when it is re-checked adversarially — the disputed label routes it to that re-check; a cancel
silently ends it. The distinction between "already fixed on the base branch" (section 12, a cancel
with `path:line`) and "I believe the diagnosis is wrong" (disputed, left open) has to be in your
writes, because the flag and the label are the only things that survive your session.

⛔ **For AMENDED, both tracker writes happen before the done flag.** If the tracker is unreachable,
both go through the outbox **first** —
`fleet outbox add --op op-15 --key ABC-1234 --args '{"edits":[{"find":"…","replace":"…"}]}' --verbatim`
and `fleet outbox add --op op-11 … --verbatim` — and **the done flag is not written until they are at
least queued**. A done flag carrying `--body-patched` with no patch applied or queued anywhere is a
lie the next reader acts on.

If the ticket has **no prescription at all** (a symptom report), omit `--prescription`; steps 1–2
still apply to the *symptom*.

**5. Labels a session never applies by hand.** You never add or remove: any `gate:*` label
(`checker.gate.labels.*`) **except `disputed`**, the provenance label (`checker.provenanceLabel`), or
the triage label (`checker.triage.label`). Those belong to the audit, the checker and the operator's
promotion step; a session touching them corrupts the gate that decides what gets worked next
(section 18).

### 10.5 Write the capture spec (skip when `capture.mode` is `none` or the issue has no UI)

Your screenshots are taken by a runner (`capture.runner`) executing a script **you author now**, in
the capture directory inside this worktree (`vcs.captureDirTemplate`, default `.fleet-capture/<KEY>/`):

- **The spec** — a browser-automation script that takes its **base URL** and **output directory**
  from the runner (the runner substitutes `{url}`; never hard-code a host), signs in through
  `capture.loginUrlTemplate` rendered with `{base}` = that URL and `{account}` = one of
  `capture.accounts` (isolated identities the project provisions for screenshots), drives to the
  affected screens, and writes PNGs into the output directory. The same script is run twice — once on
  the clean base branch (**before**) and once on your branch (**after**) — so keep it phase-agnostic.
- **Seed data** (optional; the cloud-capture playbook says where it is applied) — ⚠️ a sandbox
  database is **EMPTY**: everything the screen must show has to be seeded or created by the spec
  through the UI. Any first-run gate that latches on empty data (an onboarding dialog, a "create your
  first item" wall) will block the shot — seed at least one row or handle the dialog in the spec.
- **Authoring rules:** selectors and URLs must be valid on BOTH sides of your fix — if the fix renames
  what you target, ship a `before` spec and an `after` spec. Exact in-app captures only — do **NOT**
  use any repro/mock harness and do **NOT** build a reproduction or mock of the UI. Features that
  need real secrets the sandbox does not have (`capture.requiredEnv` lists what it *does* get) cannot
  render there — capture those locally when a pool exists, and say so on the review page if you
  cannot.
- **Safe-area or soft-keyboard change?** A browser cannot show those — see **the emulator pool**
  (10.10); it needs a local pool.

### 10.6 Do the fix

Implement the change the issue asks for — as amended by 10.4 if that is the outcome — then **commit it
on your own branch** (the capture ref in 10.7b is cut from your committed HEAD, so your work must be
committed) — but do **not** push your branch or open a PR yet. Scope stays inside the ticket
(section 11).

### 10.7 Capture — routed by `capture.mode`

#### 10.7a `local` — merge into a shared testing slot

1. **Acquire a slot** — `fleet pool acquire testing [--wait <s>]`. On success it prints the slot plus
   `worktree=`, `branch=`, `url=` — **use these, don't assume**. While it reports busy, **do not sit
   in a tight loop**: keep working on everything that does not need a slot (review-page prose, notes,
   subagent audits; the fix is already committed) and retry with a bounded `--wait`. A patient retry
   loop is a queue, and a queue is what makes a whole fleet wait on three slots. Flag `testing-slot`
   only after well over ~15 min of failed acquires; "no pool configured" is not a flag, it means
   `$FLEET_TESTING_URLS` is empty and there is nothing to acquire. ⛔ **There is no escape hatch:
   never start your own server.**
2. ⛔ **Local slots do NOT give a clean baseline — verify before trusting a local "before".** A
   testing slot is a mashup of every branch merged into it, so another session's change to *your*
   screen silently corrupts your before-shot. **Before capturing, assert the slot is clean for the
   files you touch**: `git -C <slot worktree> diff <repo.remote>/<repo.baseBranch> -- <your changed files>`
   must be EMPTY. If it isn't, release the slot and, if your project also allows cloud capture, go to
   10.7b; otherwise capture anyway and **say so on the review page** — never paper over it. A
   contaminated before is worse than a slow one.
3. **Before shots** — run your spec against the slot's `url=` **before your branch is merged in**.
4. **Merge (slot held):** `git -C <slot worktree> merge --no-edit <your-branch>`. **Clean** → the dev
   server hot-reloads; wait ~15–20 s and re-probe the URL (2xx/3xx). **Conflict** →
   `git -C <slot worktree> merge --abort`, **release the slot**, flag `other` with the conflicting
   paths, and stop the capture — ⛔ **don't hand-resolve: testing branches are throwaway, and this
   merge is the ONE cross-worktree write a working session may make**, only ever into a *testing*
   worktree.
5. **After shots** against the same `url=`, then **release immediately**:
   `fleet pool release testing <slot>`. A short hold is what keeps the pool useful to everyone else.
   **Remember which slot you landed on** — the test sign-in link you report must use *that* URL.
6. **Isolation caveat** (these shots become PR evidence): a testing branch is a running mashup of
   many sessions, so your after cleanly shows *your* change only if nothing else touching this screen
   merged between your before and now. If in doubt, say so on the review page; the launcher can reset
   the slot to the base branch plus just your branch for a clean solo diff.
7. Push the PNGs to your assets branch: `fleet assets add <file…> --branch assets-<KEY>` (the branch
   name is `vcs.assetsBranchTemplate`). Record the commit SHA it reports — PR embeds are pinned to it.

#### 10.7b `cloud` — dispatch your own sandbox

No queue, no merge, no waiting on a slot. One throwaway sandbox boots the full stack (the project
supplies the bootstrap, `capture.bootstrapScript`) and runs your spec twice from one ref: **BEFORE**
from the clean base branch (+ your spec overlaid), **AFTER** from your branch. That before is a
clean baseline — strictly better than a mashup slot's.

- **Ship the spec on a throwaway ref** (your issue branch itself stays unpushed):

  ```
  git add -f .fleet-capture/<KEY>
  git commit -m "capture spec for ABC-1234 (never merged)"
  git push -f <repo.remote> HEAD:capture/<KEY>
  git reset HEAD^        # mixed reset: the PR branch stays clean; the spec stays on disk
  ```

  Record the SHA you pushed — you will assert against it at collection.

- ⛔ **The dispatch MUST target the ref, never your worktree:**
  `fleet cloud dispatch --bundle .fleet-capture/<KEY> --ref capture/<KEY>`. A cloud session cannot
  teleport a full repository checkout — a freshly cloned monorepo is hundreds of megabytes and is
  rejected outright with a "too large" error that misleadingly points at a hosting setting. With
  `--ref`, the CLI builds a tiny blobless stub pinned to that ref and the sandbox checks the **real
  tree out server-side**. If you see the too-large error, you omitted `--ref`.

- ⛔ **The CLI assembles the worker's runbook — never hand-build, retype or echo it.** Workers have
  arrived with a **truncated runbook** and then improvised the missing steps — one skipped the
  database migration entirely and shot an app with no schema. The bundle the CLI ships is verified
  whole; anything you paste by hand is not.

- ⛔ **Re-dispatching after a correction? Use a NEW ref name (`capture/<KEY>-v2`), do NOT force-push
  the same one.** A session once force-pushed its capture ref with a corrected commit and
  re-dispatched, and the second worker still checked out the **previous** commit server-side — its
  manifest named the pre-correction SHA and its after-shots were byte-identical to run 1's. A
  force-pushed ref is NOT reliably seen by a fresh worker; a brand-new ref name cannot collide with
  cached state.

- The dispatch prints the worker's URL — **record it in your notes file**; it is the only handle
  anyone has on the worker, and it is your `--evidence-url` if you have to flag `cloud-env`.

- **Poll for delivery — and keep working while you wait** (review-page prose, notes, subagent
  audits; the fix is already committed). Budget **~40 min** (measured successes ran to 33 min, and
  one landed 9 min *after* its session gave up). A single tool call is capped at 600 s, so poll at
  most ~15 × 30 s per call and repeat:

  ⛔ **Snapshot the tip BEFORE dispatching, then poll for a DIFFERENT tip** —
  `git ls-remote --heads <repo.remote> assets-<KEY>` before, and loop until the output *changes*.
  Polling for mere *existence* returns instantly on any re-dispatch and collects the **previous**
  run's shots.

- **Collect:**

  ```
  git fetch <repo.remote> assets-<KEY>
  git rev-parse FETCH_HEAD                       # PIN this SHA — see below
  git show FETCH_HEAD:<manifest path the cloud-capture playbook names>
  git archive --format=tar -o <artifactsDir>/<KEY>-shots.tar FETCH_HEAD   # then: tar -xf … -C <artifactsDir>/<KEY>-img/
  ```

  (`git archive` to a file plus `tar -xf` is byte-safe on both platforms; a shell redirect of binary
  output is **not** byte-safe in every shell — do not `>` a PNG.)

  ⛔ **HARD-FAIL — do not proceed — if ANY of these is true:** the manifest is missing (a
  differently-named file does NOT count); its status is missing or not "ok" (a *missing* status is
  not "ok"); its after-commit is not the SHA you pushed to the capture ref; its blocked-hosts list is
  non-empty and includes a host your screen needs (`capture.allowlistHosts` says what the sandbox may
  reach — a blocked logo or asset host renders monogram fallbacks; say so on the review page or
  re-capture). Raise a `cloud-env` flag instead. Then **embed PR images by the PINNED COMMIT SHA, not
  the branch name**: a worker can push again AFTER you collect — one landed four seconds before a PR
  opened.

  Verify every expected PNG exists with a plausible, **distinct** size before calling the capture
  done — identical byte-sizes across "different" shots are a known blank-capture tell.

- **A silent worker is not an environment failure.** About 1 worker in 8 dies without pushing an
  assets branch **and** without a failure report, so there is nothing to debug from. Before flagging
  `cloud-env`, check whether sibling dispatches from the same wave delivered — if they did, the
  environment is fine and yours is a per-worker death. **Re-dispatch once, on a NEW ref name.** Two
  silent deaths on the same spec means the fault is likely in **your spec**, not the environment —
  re-read it, or capture locally (if a pool exists) where you can see the real error instead of
  silence.

- **Failure** — a failure report in the branch, a failed dispatch, or a dry poll after the budget:
  raise a **`cloud-env`** flag quoting the failure and the worker URL. If the failure is your spec (a
  selector missing in the before phase, missing seed data), fix the spec, ship it on a **new** ref,
  and dispatch a fresh worker.

#### 10.7c `none`

No screenshots. Skip 10.5, 10.7 and 10.8 entirely — no worker, no capture ref, no slot — and still
build the review page (10.11) with its plain-English explanation and, for a semantic fix, the
a11y-tree diff (10.9).

### 10.8 REAL captures only, NEVER fabricated

Both shots of a pair come from the SAME source (the same sandbox, or the same slot) — ⛔ **never mix a
locally-captured image with a cloud one**; fonts and rendering differ and the diff lies.

⛔ **Screenshots are ONLY real captures from the live app — NEVER fabricate, mock, reconstruct,
replicate, or hand-build a before or after image** (no placeholder or filler text, no rebuilt
layouts). A screenshotable issue's review page ALWAYS gets a real before AND a real after. If a real
capture is genuinely blocked by something you can't fix, do NOT put a "pending", placeholder, or
invented image in the page — flag the blocker (section 3) and finish only once it's cleared. The
operator must NEVER receive a review page containing a pending, placeholder, or invented image;
inventing a screenshot is a serious error, worse than having none.

⛔ **"Blocked" means YOU probed it and it failed RIGHT NOW — never a reported, inherited, or
ticket-based verdict.** An open ticket, a known-issue note, another session's report, or a launcher
ruling is **not** evidence that a thing is still broken; tickets stay open long after the cause is
gone. The test is the symptom, not the mechanism — go make the thing happen and look. If your probe
**does** show a live failure, flag it with the evidence you just gathered (what you ran, what came
back), not a ticket number. **The best proof a capture really hit a live API** is that the page
rendered real seeded data.

**If this issue has no screenshotable UI area, skip 10.5, 10.7 and this step entirely** — and still
build the review page (10.11).

### 10.9 Evidence: pick its TYPE from the fix

⛔ **An accessibility fix produces byte-identical before/after PNGs. That is correct, and it is
useless as evidence.** An accessible name, a focus target, a live region — none of them change a
pixel, so two identical images invite the reader to conclude nothing happened. For a semantic fix the
evidence is an **accessibility-tree snapshot text diff** (the automation library's aria-snapshot, or
an equivalent a11y-tree dump), with the screenshots kept only as labelled context ("visually
unchanged by design — the fix is in the tree, below"). A unit-test dump of the accessible name or the
active element works too. **Paste real output only** — if you cannot produce it, say so on the page in
one line rather than inventing it.

An identical pair *within* a mixed set is usually a deliberate **control** shot, proving an unaffected
viewport did not regress. That is good practice — label it as such so a reviewer can tell it from a
failed capture.

Pixels for visual/layout, a tree diff for semantic/a11y. Never ask which.

### 10.10 Safe-area + soft-keyboard changes → the emulator pool

**Requires a local pool** (`capture.mode: local`, `emulator.enabled: true`): the emulator app captures
against a LOCAL live server, so with `$FLEET_TESTING_URLS` empty these cases can't be captured at all
— note **"needs local emulator follow-up (safe-area/soft-keyboard)"** on the review page AND in the PR
body, then: when `capture.mode` is `cloud`, capture what the browser *can* show; when it is `none`,
there is nothing to capture at all (10.7c) — record the gap on the review page and in the PR body and
move on.

⛔ **The emulator is slow** (native build → install → boot → drive), **so use it only when the browser
genuinely cannot show the bug.** That is exactly **two cases**:

- **Safe-area insets** — content sitting under the notch/status bar or the system navigation bar
  (`env(safe-area-inset-*)`). A browser has no inset to render.
- **Soft keyboard** — the on-screen keyboard covering or pushing content, or anything driven by its
  resize of the visual viewport. A browser cannot spawn the device keyboard; resizing the viewport
  only approximates it, which is not good enough to screenshot as evidence.

**Everything else mobile goes in the browser** with a mobile viewport — mobile-only layout, density,
dropdowns, toasts, navbars, and the mobile app's own web screens included. Being a mobile-app issue is
**not** on its own a reason to use the emulator. If you're unsure, use the browser.

The pool is small (`emulator.slots`; often one — a second costs ~2 GB the box does not have spare),
so sessions serialise on it through the lock:

1. ⛔ **Acquire the slot first — don't touch the emulator until you hold it.**
   `fleet pool acquire emulator`. Success prints the slot and its serial (`emulator-<port>`) — that
   emulator is yours (it lazy-boots if it wasn't already running; a cold boot can take a while, and if
   the call times out mid-boot just run `acquire` again — it re-attaches to the slot you already
   hold). Busy → retry with `--wait`; `fleet pool status` shows the holder.
2. **Capture while holding your slot**, always targeting your serial: build the app, install it on
   `<serial>`, drive it to the state, and screen-capture from `<serial>`. Keep the whole build→capture
   inside the lock (concurrent native builds also collide).
3. ⛔ **Release the moment you're done capturing:** `fleet pool release emulator <slot>`. **Never kill
   or close the emulator yourself** — the idle reaper shuts unused emulators down after
   `emulator.idleSeconds`; a warm one is fine to leave for the next session.

Do a full **acquire → capture → release** cycle for the **before** shots and another for the
**after** shots — ⛔ **don't hold a slot across the fix itself.** Everything else (the review page,
reporting, close-out) is identical to a web change.

### 10.11 Always build the scratch review page

Build a standalone HTML review page at **`<paths.artifactsDir>/<KEY>.html`** — your descriptor's
`paths.artifactsDir`, by default `$FLEET_STATE_DIR/dev-pages/<KEY>.html`. Create the directory if it
is missing. Build it **every time, with or without screenshots**.

- ⛔ **It lives OUTSIDE every worktree and is never committed to any branch.** `paths.artifactsDir`
  is validated to be outside every worktree precisely so the page can never be staged; it is for the
  operator's review only and must never appear in the PR diff. Do **not** auto-open it in a browser —
  building it is enough; include its `file://` link when you report.
- **Self-contained** means **no NETWORK dependencies** — *not* images inlined into the HTML (see
  below). **Always render in dark mode**: put an explicit dark background + light text on the page;
  never rely on `prefers-color-scheme` or the browser default, which flips between light and dark.
- It must contain, in order: (a) **What was broken** — the user-visible symptom, plain language, one
  short paragraph; **Why it happened** — one paragraph, no jargon; **What changed** — what a user
  experiences differently now; (b) **Before / after evidence**, clearly labelled, side by side, of
  the type 10.9 prescribes — **when you have it** (strongly preferred whenever there is a
  screenshotable area); (c) **How to verify it yourself** — the exact clicks; (d) if 10.4 amended or
  refuted the prescription, one paragraph saying what the ticket asked for and why you did
  otherwise. Write it for a human reviewer, not as a changelog.
- ⛔ **Screenshots MUST be sibling PNG files — NEVER inline base64.** Write the captures to
  `<paths.artifactsDir>/<KEY>-img/*.png` and reference them relatively
  (`<img src="<KEY>-img/before.png">`). A full-page capture is ~115 KB, so a `data:image/png;base64,…`
  src is ~150 KB — and **some viewers silently drop those**: the reader sees ALL of the prose and
  NONE of the images, with no broken-image glyph and no gap to hint at it. A browser loads them fine
  (`img.complete === true`, correct `naturalWidth`), so every check you run passes and you report
  "before/after captured" in perfectly good faith.
- ⛔ **Images in the review page must be LOCAL FILES, not hosted URLs.** If the repository is private,
  a `?raw=true` blob URL renders as a broken image in any browser that is not signed in — the page
  then looks like your work is missing. Extract the PNGs from your assets branch into `<KEY>-img/`
  (10.7b's `git archive` + `tar` recipe). ⛔ **Do not check the orphan assets branch out** — that
  untracks your worktree.
- **Verify before you report:** load the page headless and assert every `document.images` entry has
  `complete && naturalWidth > 0` **and** that the image count equals what you expect — a page with
  zero `<img>` tags passes "no broken images" trivially. Best of all, have the generator refuse to
  write the page unless every capture file exists on disk. A broken image is worse than no image.

### 10.12 Verify the fix

- Run `commands.test` and `commands.typecheck` when they are configured (and `commands.lint` /
  `commands.build` if the change warrants it) — **after** the ready sentinel (section 5). A failing
  build you did not cause is an `install` or `other` flag, not something to patch around.
- ⛔ **If a configured test command binds a fixed port** (an end-to-end suite, a preview server it
  starts itself), take one from the pool first — `fleet pool acquire e2e-port`, release it after.
  Two sessions running the same suite otherwise bind the same port and both fail, and the second
  failure looks exactly like a real regression in your diff.
- `fleet doctor` reports the health of your install; run it before you start blaming individual
  files for a missing module.
- Fan out a read-only audit of the diff: does it do what the ticket asked (as amended), does it break
  anything nearby, did the sweep for the same pattern elsewhere come back with real evidence (not a
  dead agent's silence)?

---

## 11. DO NOT ASK QUESTIONS — follow the ticket and ship

Nobody is reading your window waiting to answer. The operator is not watching, and the launcher only
reads **flags** — so a question in your output is a session that has stopped for no reason. Decide it
yourself and keep going.

**The ticket is the specification of the *problem*.** It was written after a real investigation: it
names the file, usually the line, the symptom and the intended behaviour. Its *prescription* is a
hypothesis you have already tested (10.4). If it offers two possible approaches, pick the smaller one
and say in the PR body which you picked and why.

**Never stop for any of these** — decide and proceed:

- "Which of these two approaches should I take?" → the smaller, more surgical one.
- "Should I also fix this adjacent thing I noticed?" → ⛔ **No.** Out of scope. Mention it in the PR
  body in one line; do not touch it. Scope creep is what makes a PR unreviewable.
- "The ticket mentions a file that no longer exists / has moved." → find the current location, fix
  it there, and note the discrepancy in the PR body. Tickets go stale; the defect is what matters.
- "Is this worth doing at all?" → not your call. Implement it. If the defect is genuinely **already
  fixed on the base branch**, that IS a real finding — section 12.
- "Should the copy say X or Y?" → match the surrounding copy's voice and ship.
- "Do you want screenshots or an a11y diff?" → pick from the fix type (10.9). Never ask.

⛔ **A flag is ONLY for infrastructure you cannot fix from inside your worktree** — a dead testing
slot, a failed install, a silent capture worker, a duplicate assignment, a stalled dependency. It is
not a question channel, and it is not for design decisions. If you flag, keep working on anything
that does not depend on the answer.

**If you are genuinely blocked on the CODE and cannot proceed** — which should be rare — do not idle
and do not ask. Open the **DRAFT** PR with what you have, state the open question in one line in the
PR body under an "Open question" heading, and write your done flag. A draft PR with a clear question
is reviewable; a stalled session is not.

---

## 12. "There is nothing to do" is a real outcome — report it, don't just stop

Sometimes the honest answer is that no PR should exist: the defect is **already fixed on the base
branch**, or another session already shipped it. That is a finding worth having, not a failure — but
it only counts if you report it, because the ticket is still open and will be re-queued to another
session otherwise. Three distinct cases, three distinct writes:

| finding | tracker writes (comment FIRST, always) | done flag |
| --- | --- | --- |
| **Already fixed on the base branch** | **op-11 `comment`** citing `path:line` of the fix (and its test) — verbatim, with the evidence; then **op-9 `cancel(key, reason)`** | `fleet flag done --outcome cancelled --reason "fixed on base at src/thing.tsx:42" --evidence src/thing.tsx:42 --evidence src/thing.test.ts:88` |
| **Duplicate — another session shipped it** | **op-11 `comment`** naming the PR URL; then **op-10 `leaveOpen(key)`** — ⛔ **do NOT cancel**: the issue is legitimately in review and must not be closed | `fleet flag done --outcome duplicate --reason "shipped in <pr url>" --pr-url <pr url>` |
| **Refuted diagnosis** (10.4) | op-11 with evidence, op-14 add `checker.gate.labels.disputed`, op-10 `leaveOpen` | `fleet flag done --outcome no-code-change --reason disputed --prescription refuted` |

⛔ **Comment FIRST, then change state** — a state change can move the issue out from under you (and
on some trackers the relation that marks a duplicate moves it too), so the evidence must already be
attached when it does. The comment is posted **verbatim**; op-11 is never paraphrased. Cite
`path:line`: an assertion with no line number cannot be acted on and the ticket stays open. The flag
body plus the comment is the entire report — it is read by the reclaim watcher and is the only thing
that survives your session — so make it stand on its own.

Then stop. ⛔ **Do not open an empty PR, and do not "improve" the existing fix you found** — that is
new scope nobody asked for.

⛔ **Do not silently leave edits behind.** If you already wrote code before discovering the work was
moot, that is fine and it will be preserved as a patch on your branch — but the flag still has to
say `cancelled` or `duplicate`. A session that goes quiet without a flag looks identical to a crashed
one and gets left running.

---

## 13. If the pre-commit hook blocks you on a test you did not touch

The hook typically runs the **entire** unit suite, and with a full fleet committing there can be
several dozen test workers competing for a handful of cores. A timeout-marginal spec then fails
randomly — a *different* test each run, with all but one suite green, in a file nowhere near your
diff. That is contention, not your bug.

Retry once or twice, then **stop and flag it** (`other`) — repeated retries add to the load causing
it. ⛔ **Do not use `--no-verify`, and do not "fix" it by editing the test runner's config, the hook,
or another test's timeout.** If the launcher offers you a commit to cherry-pick past it, check what
**paths** that commit touches before taking it: a file matching `vcs.sensitivePaths` changes who has
to review your PR, however trivial the change — drop it before pushing.

---

## 14. Closing out — do NOT wait for a "push the PR" prompt. Finish, then push yourself, as a DRAFT

There is no "push the PR" prompt. When your issue is fixed and verified, you run the whole close-out
yourself and then stop. Nobody is coming to tell you to start.

### Order matters — the review page is built BEFORE the PR

⛔ **HARD GATE: no PR create until the review page exists and renders.** This is not a preference and
not an ordering suggestion — a PR without its evidence is not reviewable, and the review is what the
whole run exists for. Before you run the create command, assert all four — 1 and 2 always; **3 and 4
only when `capture.mode` is not `none` and the issue has a screenshotable area**, since under
`capture.mode: none` there are no screenshots, no capture ref and no assets push at all (10.7c) and
those two can never be satisfied:

1. `<paths.artifactsDir>/<KEY>.html` **exists** on disk.
2. You **opened it** (headless is fine) and every image rendered — no broken-image icons, no missing
   a11y-tree block.
3. Its evidence **matches the fix type** — screenshots for visual, an a11y-tree diff for semantic.
   Two byte-identical PNGs are NOT evidence for an a11y fix. (A semantic fix's a11y-tree diff is
   required under every `capture.mode`, `none` included — it costs no capture.)
4. The screenshots are on the **`assets-<KEY>`** branch (pushed by `fleet assets add`, or by your
   cloud worker), so the PR body can embed them.

If any that applies fails, **fix it before pushing**. If you truly cannot build the page (missing
captures, blocked tooling), do NOT push the PR — write a blocked flag instead and say what is missing.
Pushing first and "adding the evidence later" is exactly what this rule forbids.

### 1. Push the evidence to the assets branch — NEVER the PR branch

⛔ **Screenshots (and the review page itself) must NOT appear in your PR's diff.** Screenshots go to
the separate **`assets-<KEY>`** branch via `fleet assets add <file…> --branch assets-<KEY>` (the CLI
writes the orphan branch without checking it out — never check it out yourself; that untracks your
worktree). Your PR branch stays clean — only the real code fix. Note the commit SHA the CLI reports.

### 2. Open the PR — as a DRAFT

Push your branch (`git push -u <repo.remote> <your-branch>`), then run `vcs.pr.createCommand`
(default `gh pr create`) with the draft flag when `vcs.pr.draft` is true (the default):

```
gh pr create --draft --title "ABC-1234: <what changed>" --body-file <body.md>
```

⛔ **Draft is mandatory.** Every PR from this flow starts as a draft; the operator promotes them
after review. Never mark it ready yourself, and never *undo* ready on anything — an undo **dismisses a
live approval**.

The PR body **must** contain:

- **What / why** — the plain-English problem and fix (reuse the review page's first section).
- **Prescription** — one of `followed` / `amended (see ticket comment 2026-03-14)` / `n/a`; for
  `amended`, the one-line why.
- **Evidence** — the screenshots embedded as `?raw=true` blob URLs from `assets-<KEY>`, **pinned to
  the commit SHA, never the branch name**
  (`https://github.com/acme/app/blob/<sha>/before.png?raw=true`), or the a11y-tree diff in a fenced
  block. ⛔ **Never inline base64 in a PR body** either — the host strips or truncates it.
- **Out of scope** — the one-line mentions from section 11, if any.
- **Open question** — only if section 11's last paragraph applied.
- **Sensitive paths** — if any file in your diff matches `vcs.sensitivePaths`, say so in one line;
  that changes who reviews it.

⚠️ Check the **path** of every file in your diff before pushing. If you cherry-picked anything to get
past the pre-commit hook, drop it first.

### 3. Move the ticket to in-review and link the PR

**op-7 `setState(key, in-review)`** (op-5 with the resolved `in-review` ref from `tracker.states`),
then **op-8 `attachLink(key, prUrl, "PR")`**. MCP absent → both through `fleet outbox add`
(section 9). Tracker-less → skip both.

### 4. Clean up

- Delete any scratch dev **route** or debug flag you added inside the repo (it would otherwise ship
  in the diff — re-check `git status` and the PR's file list).
- Delete the capture directory from disk (`.fleet-capture/<KEY>` is untracked after the mixed reset
  in 10.7b) and delete the notes file (`.fleet-session-notes.md`).
- Delete the throwaway capture ref(s): `git push <repo.remote> --delete capture/<KEY>` (and any
  `-v2`). The assets branch **stays** — the PR links into it.
- ⛔ **Leave the review page in place** (`<paths.artifactsDir>/<KEY>.html` and `<KEY>-img/`). It lives
  outside every worktree, so it can never reach the PR diff, and it is the operator's review
  artifact (10.11): your last message links to it and the operator opens it long after you have
  stopped. Deleting it here is what once cost a whole fleet its evidence — the pages went as a
  cleanup step and every one had to be rebuilt from scratch when review started. What you must
  assert before flagging done is the other half of that rule: **the PR body already carries every
  piece of evidence the page holds**, so the PR is reviewable on its own. If it is not, fix the PR
  body — never by binning the page.
- Return the worktree to a clean, detached state on the base branch so the launcher can reuse it:
  `git checkout --detach <repo.remote>/<repo.baseBranch>` (your branch is pushed; nothing is lost).
  Never delete the worktree itself.

### 5. Flag done — as your VERY LAST action

```
fleet flag done --outcome pr-pushed --pr-url <pr url> [--prescription followed|amended] [--body-patched]
```

The CLI writes `$FLEET_STATE_DIR/flags/done-<label>.json` (plus a one-line `.txt` twin):

```json
{"v":1,"session":"<label>","issue":"ABC-1234",
 "outcome":"pr-pushed",
 "prUrl":"https://github.com/acme/app/pull/1",
 "reason":"", "evidence":[],
 "prescription":"followed", "bodyPatched":false,
 "at":"2026-03-14T10:00:00Z"}
```

`outcome` is one of `pr-pushed | cancelled | duplicate | no-code-change` for a working session
(`check-complete` belongs to checker sessions). `--prescription amended` **requires** `--body-patched`
to be true in fact (10.4). ⛔ **This flag tells the launcher your worktree can be reclaimed
IMMEDIATELY** — it is what frees RAM and disk for the next wave, so write it as the last thing you do
and then stop. Do not start new work, do not poll, do not wait for a reply.

---

## 15. If you genuinely cannot finish

Write `fleet flag blocked --category <c> --observation "<what you observed>"` instead. Do not push a
half-finished PR to look productive, and do not sit idle — a flag gets you an answer. (A code-level
dead end is different: section 11's last paragraph — draft PR with an "Open question", then a done
flag.)

---

## 16. PR flow (given a PR URL or number)

When the assignment is an existing PR rather than a ticket:

- Check the PR's branch out in this worktree (`gh pr checkout <n>` on a GitHub-hosted repo; the
  equivalent on other hosts). It is now "your branch"; every cross-session rule still applies.
- Read the PR's description, its review comments and its ticket (op-2 if it names one); then wait for
  the launcher's next instruction (`fleet send`) — a PR assignment always comes with one. Testing
  happens in a testing slot or a sandbox, never in this worktree.
- Close-out is section 14 from step 2 onward, pushing to the PR's existing branch (no new PR); the
  done flag's `--pr-url` is that PR.

---

## 17. Message format

- **End EVERY message with a short TL;DR** — 2–4 lines in plain terms (what you did · what's next ·
  anything the operator must decide), no jargon.
- **End EVERY message with these two lines**, on their own lines right under the TL;DR, formatted as
  markdown links, never bare or backticked URLs (on the close-out message only, the DONE banner in the
  last bullet comes after them):
  - **Test sign-in** — when a local pool exists and you merged into a slot:
    `[Test sign-in](<that slot's URL + the sign-in path>)` — the slot you *actually* merged into;
    before any merge, `$FLEET_TESTING_URL`. When `$FLEET_TESTING_URLS` is empty (cloud or none):
    the fixed line `Test sign-in: no local slot up — the launcher can boot one with this branch.`
    ⛔ **Never invent a URL** — your cloud sandbox has no reachable address, and a wrong host means the
    operator tests an app without your fix.
  - **[Review page](file:///<paths.artifactsDir>/<KEY>.html)** — always present once it exists (it is
    built every time, and it survives close-out — 14.4 — so the link keeps working after you stop).
    Once the PR exists, add its link on the same line; never replace the page link with it.
- **Cross-session safety (section 1) is not optional**, **fanning out subagents is always on**, and
  you are **serverless in this worktree** — every message, every stage.
- ⛔ **After close-out only — the DONE banner is the message's LAST thing.** The message in which you
  finish section 14 ends with exactly these three lines, in this order, below the TL;DR and the two
  link lines above — ⛔ **do NOT wrap them in a code block, and put NOTHING after them**:

  **DONE — ABC-1234**
  [PR](https://github.com/acme/app/pull/1) — draft
  **WHAT'S NEXT:** <the one thing the operator has to do, or `nothing — awaiting review`>

  The operator triages a wall of finished windows by scanning for that banner: a code fence hides it
  from that scan, and anything printed after it — a stray tool result, a "let me know if…" — makes a
  finished session read as one that is still running.

---

## 18. Labels a session never applies by hand

Repeated here because it is the easiest rule to break with a well-meaning `updateIssue`:

- any `gate:*` label (`checker.gate.labels.pending|passed|failed|uncertain|waived`) — the audit's
  and the operator's, **except `checker.gate.labels.disputed`**, which is exactly the session's
  signal in 10.4;
- the provenance label (`checker.provenanceLabel`) — says who *filed* the ticket, never who worked it;
- the triage label (`checker.triage.label`) — the human gate between "filed" and "ready"; a session
  removing it promotes an unaudited finding into the next wave's queue.

The only tracker writes a working session makes are: op-5 (in-progress), op-6 (assign), op-7
(in-review), op-8 (PR link), op-9 (cancel, after op-11), op-10 (leaveOpen), op-11 (comment,
verbatim), op-14 (add `disputed` only), op-15 (the `⛔ DO NOT` block after an amended prescription).
Everything else is the launcher's or the checker's.
