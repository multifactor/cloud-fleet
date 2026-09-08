# Testing-session playbook (`role: testing`)

Operating instructions for a **`testing`** session of a `/fleet` run. Follow this from the top.

You are **one of the shared dev servers**. `testing` is the only role that runs a **shared** dev server —
no `working` session ever starts one. There are at most `testing.maxSlots` of you (`testing.count` are
live at once), and every `working` session is serverless: when `capture.mode` is `local` it merges its own
branch into *your* worktree and captures its evidence against *your* URL.
Your identity comes from your session descriptor and the `FLEET_*` environment the shim set for you, so
read it first and use it everywhere below — ⛔ **never hard-code a path, a branch, a port or a URL**,
because every one of them differs per repo, per machine and per slot, and a literal borrowed from
somewhere else points at another session's tree.

Every `fleet <cmd>` in this playbook — fenced blocks included — is shorthand for
`node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <cmd>`; there is no bare `fleet` bin, so run it in that form.

| where                | what it tells you                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FLEET_ROLE`         | must be `testing`. If it is anything else this playbook is not yours — stop and tell the operator.                                                                                    |
| `FLEET_LABEL`        | your session label — the name `fleet send`, `fleet kill` and `fleet relaunch` address you by                                                                                          |
| `FLEET_SESSION_FILE` | your descriptor (`sessions/<label>.json`): `worktree`, `branch`, `testingUrl`, `paths{stateDir flagsDir outboxDir artifactsDir}`, `readyFlag`                                          |
| descriptor `branch`  | your **slot branch** — `testing.base` for slot 1, `<testing.base>-<n>` for slot n (default base `testing`, so `testing`, `testing-2`, …)                                               |
| `FLEET_TESTING_URL`  | the URL you serve, rendered from `devServer.urlTemplate` for your slot — a per-branch host such as `https://testing-2.dev.localhost`, or a fixed port such as `http://localhost:3001`  |
| `FLEET_TESTING_URLS` | every slot URL actually running, **yours included** — the other entries are your sibling slots, the ones you must never touch                                                          |
| `FLEET_STATE_DIR`    | the per-repo state directory — flags, locks, logs and the session registry live under it                                                                                              |
| `fleet slots`        | the slot table: every slot's number, branch, worktree and URL. Your row is the one whose branch equals your descriptor's `branch`.                                                     |

`fleet session env --label <your label>` reprints the same environment if you ever lose it; `fleet config
get <key>` answers "what does this repo call that?" for any config key named below.

Your slot number `n` is read off your branch (`testing.base` → 1, `<testing.base>-<n>` → n); `fleet slots`
shows the same mapping. Use it in every report so the operator knows which of you is speaking.

Your branch is a running **integration of many sessions' work**, so it is disposable: you ⛔ **NEVER push
it** and ⛔ **NEVER open a PR from this worktree** — it is a throwaway mashup of other sessions' branches,
and a PR from it would present their work as one unreviewable blob under your name. Working sessions keep
their own branches — those are what become the PRs.

You also ⛔ **never touch the tracker**: the working session owns its ticket and its status, and a second
writer produces contradictory history nobody can read back. Report to the operator instead.

## Cross-session safety (CRITICAL — read first)

You share this git repo, the dev-server proxy/ports and the machine with several other **live agent
sessions running concurrently** in sibling worktrees — including the *other* testing sessions. Hard rules:

- ⛔ **NEVER run `git stash`** (nor `pop` / `push` / `apply`). `refs/stash` is **shared across every
  worktree of this repo** — a concurrent session's stash op races with yours and can pop *their* WIP into
  your tree or drop yours. If you find a stash that isn't yours, **leave it**. (The plugin's
  `block-git-stash` hook refuses the command; do not look for a way around it.)
- ⛔ **NEVER run `commands.stopAll`** — whatever the repo calls its "stop/kill everything" script, it is
  repo-wide and would kill other sessions' servers *and your own*. You only ever start and keep **your**
  server up.
- ⛔ **Stay in your own worktree** — never `git worktree remove` / `prune`, never delete `node_modules`
  (workspace packages are shared through the install junctions — `install.junctions.mode`, plus any
  `install.junctions.extra` — so deleting *through* a link deletes the target for every worktree at once),
  never change global / `--system` git config, and never touch another testing worktree.
- The **one deliberate exception** to "stay in your own worktree" is inbound: merging other sessions'
  branches **into your own branch** is your whole job, and that only ever writes into *this* worktree.
  **Working sessions also self-merge into a testing worktree** to capture their real "after", so everyone
  serializes on **the slot lock** — ⛔ **always hold your own slot before you `git merge` here**, because a
  merge that lands mid-capture hands a working session a screenshot of a tree it never asked for.
- ⛔ **Never kill a process by exclusion** ("everything except mine"). You stop only processes you have
  positively identified as belonging to *your* worktree; an exclusion filter is how one slot takes down
  the whole machine's servers.

## The slot lock (how sharing works)

The `testing` pool (`fleet pool …`) hands out the testing slots. A working session runs
`fleet pool acquire testing`, gets *some* free slot, merges **its own branch** into that slot's worktree,
captures against that slot's URL, and releases. N slots = N sessions merging at once, which is why nobody
else needs to start a server of their own.

⛔ **You do not merge on a working session's behalf.** They hold the lock and merge themselves; you merge
only when the operator tells you to (see **Pull in a session**), under the same lock. Two writers to one
worktree with one lock between them is exactly the collision the lock exists to prevent.

**Before you merge anything, take your OWN slot:**

```
fleet pool acquire testing --wait <seconds> --json    # non-zero exit = still busy → run it again
# ... git merge / git reset ...
fleet pool release testing <slot>
```

- The `--json` payload names the slot it granted, with its worktree, branch and URL — **use those, don't
  assume**. As a testing session you need **your own** slot: the one whose branch is your branch. If the
  grant names another slot, ⛔ **release it immediately** and retry — holding a sibling's slot blocks a
  working session's capture for no reason, and merging under it would write into a tree that is not yours.
- `acquire` waits patiently (`--wait`); a non-zero exit just means the slot is still busy — run it again.
  ⛔ **Never work around a busy slot by merging without it** — the lock is the only thing standing between
  your merge and another session's capture.
- A holder whose heartbeat is older than `testing.lock.staleMinutes` (default 12) is treated as crashed
  and its slot is stolen — ⛔ **by timestamp only, never by guessing whether some process is still alive**;
  process identity is reused and misread, and a wrong guess steals a live session's slot mid-capture. Your
  session shim heartbeats every lock you hold, so a live session's slot never goes stale and a dead
  session's frees itself inside the window.
- The pool may health-probe a slot before granting it (`testing.lock.probeTimeoutSec`, default 45 s). A
  slot that fails that probe is not handed out — one more reason a half-dead slot of yours must be caught
  and fixed rather than left serving.
- ⛔ **Always release, including after an abort or an error** — a slot you forgot to release blocks every
  working session's capture until the stale window expires. If a command between acquire and release
  fails, release first, then deal with the failure.
- Check every slot any time with `fleet pool status`.

## 0. First action (start the server)

1. Run `git branch --show-current` in your worktree. It **must** print your descriptor's `branch`. If it
   prints nothing (detached HEAD) or another name, ⛔ **STOP and tell the operator** — never start a server
   on the wrong branch. With a per-branch-host proxy the wrong branch registers the wrong host, typically
   the shared default host that every mis-branched server then fights over; with fixed ports it answers on
   another slot's port. Either way both slots start lying about whose code they are serving.
2. Check the worktree is actually installed: the ready sentinel (`install.readyFlag`, default
   `.fleet-ready`) must exist in your worktree. If it doesn't, or the server fails to boot on missing
   dependencies, run `fleet doctor --repair` and only raise a flag (category `install`) if that doesn't fix
   it. ⛔ **Never "fix" an install by deleting `node_modules`** (see cross-session safety).
3. Find out what to run: `fleet config get commands.devServer`. If no such server is running for **this
   worktree** yet, start it **in the background, detached from your shell**, with its output going to a log
   file under `<FLEET_STATE_DIR>/logs/` so you can read why it died if it dies. A foreground tool call has
   a timeout, and the server dies with it when the timeout fires — silently, in the middle of someone's
   capture. ⛔ **Never start it in another worktree, and never start a second one for your slot**: after a
   `fleet relaunch` you land in the **same** worktree, so check whether a server is already serving this
   worktree (the supervisor may also have restarted it) before you start one, and two servers on one slot
   fight over the host/port and neither answers reliably.
   - With a fixed-port `devServer.urlTemplate`, the server must bind exactly the port `fleet slots` shows
     for your slot (`devServer.portBase + (n − 1) × devServer.portStride`) — that is the only way it can
     answer `FLEET_TESTING_URL`.
4. Confirm the URL: the first `devServer.probes` entry against `FLEET_TESTING_URL` must satisfy its
   `expectStatus` (default `2xx,3xx`) within its `timeoutSec` (default **45 s** — a cold compile takes
   that long, and a probe fired early reads a healthy slot as dead). If `devServer.routeListCommand` is
   set, run it: your host must appear in its output. A **404 on the root probe means no upstream is
   registered at your host** — either the server is not up yet (wait the full `timeoutSec` and re-probe)
   or it registered under another host; a route list that shows only the default host means the wrong
   branch. Fix it and don't proceed.
5. Run the **full self-check** (see **Self-check** below) before you call it up — a slot that serves 200s
   can still have a dead API half, and reporting it ready sends working sessions off to capture false
   evidence that then lands on a PR.
6. ⛔ **Do not start an emulator idle-reaper, and do not shut idle emulators down yourself** — the
   `emulator` pool and `fleet watch` own that now, and a second reaper races the first and kills an
   emulator a working session is holding.
7. Report: **`Testing slot <n> ready: <FLEET_TESTING_URL>`** and wait for the operator's next instruction.

## Pull in a session (merge-to-test) — your core loop

When the operator says **"pull in session N"** (or "merge session N" / "test session N"):

1. Find that working session's branch: `fleet status --json` lists every session with its `label`,
   `worktree` and `branch` (the same fields as its descriptor under `<FLEET_STATE_DIR>/sessions/`). Its
   worktree is the sibling named by `repo.sessionDirTemplate` (default `{repo}-session-{n}`), and reading
   its branch with `git -C <that worktree> branch --show-current` is fine — reading is not touching. Or
   just use the branch name or PR the operator gives you, fetching from `repo.remote` first.
2. **Take your own slot** (above), then `git merge --no-edit <branch>` in this worktree, then **release the
   slot** — ⛔ including after an abort.
   - **Clean merge** → the dev server recompiles and hot-reloads. Re-probe and allow the **full 45 s**: a
     recompile after a merge takes that long, and an early probe reports a healthy slot as dead.
   - ⛔ **Then re-run the full self-check, not just the root probe.** A merged branch can add a dependency
     this worktree doesn't have yet, and the half that bundles server code then dies while pages keep
     serving 200 — the classic half-dead slot. If that happens, `fleet doctor --repair` (or re-run
     `commands.bootstrap`) and restart your server before you tell anyone the slot is ready.
   - **Conflict** → run `git merge --abort`, list the conflicting files, and ask the operator how to
     proceed. ⛔ **Don't hand-resolve unless told to** — a resolution here lives nowhere but this
     disposable tree, and it hides from the working session the conflict its PR will hit against
     `repo.baseBranch`. If the merge simply cannot proceed, flag it (category `other`) with the conflicting
     paths.
3. You can stack several sessions' branches this way so the operator can test them together. The working
   sessions **keep their own branches untouched** — those are what get PR'd to
   `<repo.remote>/<repo.baseBranch>`, never your integration branch.
4. Say **what is now in your tree** when you report — the operator and the working sessions are both
   reasoning about a mashup, and only you know its contents.

## Reset testing

When the operator says **"reset testing"** / **"clear testing"**: wipe the integration state back to a
clean base — take your slot, run `git fetch <repo.remote>`, then
`git reset --hard <repo.remote>/<repo.baseBranch>`, release. The server reloads onto a clean tree; re-probe,
re-run the self-check, and tell the operator it's reset. If the operator doesn't name a slot and there are
several, say which one you reset.

A common variant: **reset, then merge exactly one branch**, so a working session gets a clean solo diff
for its evidence instead of a shot contaminated by everyone else's merges. Same lock, same steps, one
merge.

## If you're blocked, raise a flag

If something outside your control stalls you — your dev server won't come up, a service the project
declares is down, a merge can't proceed — raise a blocked flag so the launcher can triage it (it sees the
whole machine and can tell "broken" from "busy"):

```
fleet flag blocked --category dev-server --observation "slot <n>: <what you observed>" [--evidence-url <url>]
```

Categories that apply to you:

| category     | when                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `dev-server` | won't start, half-dead, wrong URL, 5xx after a full rebuild window                                                            |
| `services`   | a container or database the project **declares** (`services.docker.required`, a `services.containers` entry such as `app-postgres`) is down |
| `install`    | the worktree's dependencies are broken — run `fleet doctor --repair` first and flag only if that doesn't fix it              |
| `emulator`   | the emulator pool is wedged (you don't repair it; you only report it)                                                        |
| `other`      | a merge that can't proceed, and anything else                                                                                |

Be concrete: what you ran, what answered, for how long. Then keep retrying — the launcher and `fleet
watch` repair from outside and will `fleet send` you what they fixed or what to do instead. Once you're
unblocked, say so in your next report so the flag can be retired.

⛔ **Only services the project declares are ever an outage.** If the config declares no Docker requirement
and no containers (`services.docker.required: false`, empty `services.containers`), then "container does
not exist" or "nothing is listening on 5432" are expected forever and nothing depends on them — never
flag them, and never "fix" them. The app is talking to whatever its own environment points at, which may
well be a managed database somewhere else, and an hour spent reviving a local service nobody uses is an
hour the slot is down.

## Self-check: your server can go HALF-dead (and look healthy)

A dev server is usually **several independent processes** — a page/asset server and an API/worker runtime,
say — and either can die while the other keeps running, so the slot keeps answering while it is actually
useless:

- **API half dead** → pages still serve **200**, but every API route returns **500**, so the app's sign-in
  never redirects and every capture shows an app broken in a way the branch never was. Seen as: API-half
  process count 0, page-half count 3.
- **Page half dead** → with a per-branch-host proxy the route **deregisters**, so the proxy answers with
  its own **404** ("no upstream registered for this host"); with fixed ports the port simply refuses. Seen
  as: API-half count 2, page-half count 0.

The project encodes exactly this in `devServer.processes` (`[{name, match, notMatch?, min}]`) and
`devServer.probes`. `fleet doctor --json` runs both against your slot; run it, and read its verdict rather
than eyeballing a page. What it checks, and what you check if you are inspecting by hand:

1. **Processes** — for every `devServer.processes` entry, count the processes whose command line matches
   `match`, belongs to **your** worktree (the path matched **on a path-separator boundary**), and does not
   match `notMatch`; each count must be ≥ `min`. ⛔ **Count each kind separately, never the total** — a
   total hides a dead half behind a live one, which is the whole failure above. ⛔ **The filter must
   exclude sibling slots**: slot 1's worktree path is a *prefix* of slot 2's, so a plain "contains"
   match on the path counts both worktrees and reports a sibling's processes as yours — that is why the
   boundary match exists, and `notMatch` only drops unrelated processes such as one-off build or test runs.
   If `devServer.processes` is empty, judge by probes only.
2. **Probes** — for every `devServer.probes` entry in order, request `FLEET_TESTING_URL` + `path`. Up means
   the status is in `expectStatus` (`2xx,3xx` by default) — or, where `expectNotStatus` is set, any status
   **not** in that list. Allow the full `timeoutSec` (45 s). Entries marked `dependsOnPrevious` are skipped
   when the previous entry failed, so read the first failure, not the cascade.
3. **Route list** — if `devServer.routeListCommand` is set, your host must appear in its output.

Re-run all of it periodically, after every merge and after every restart. If any half is missing, raise the
flag (category `dev-server`) and restart — ⛔ **never silently keep serving a half-dead slot**, because
working sessions will capture against it and file false evidence, and a false "after" costs more than an
hour of downtime.

⛔ **Judge by the status code, never by a header or by "it looks alive":**

- An API route that legitimately answers **404** to a probe GET is **HEALTHY** — the route *is* served,
  that method or path just isn't a GET endpoint. Projects mark such probes with `expectNotStatus` (for
  example `[500]`): only a status in that list means the worker half is broken. The **root** probe is the
  opposite case — there, a 404 is the proxy saying *no upstream*, i.e. dead.
- A per-branch-host proxy stamps its marker header on **every** response, healthy 200s included. The header
  means "I routed this", never "there is nothing behind me" — reading it as a liveness signal makes a dead
  slot look fine and a fine slot look dead.

## Restarting your server

- ⛔ **An env-file change needs a real restart.** Some server halves do **not** hot-reload their env file —
  a fix to an environment file only takes effect on a genuine restart, and re-reading the file proves
  nothing. Decide **stale vs reloaded** by comparing the env file's last-write time with your server
  processes' start time: processes older than the file means you are still running the old environment.
- **A restart touches no git state.** Merges already in your testing branch survive it, so a working
  session **never** needs to re-merge afterwards — ⛔ **say so when you report a restart**, or sessions
  will redo work they already have and burn a slot doing it.
- A restart means: stop **your** server processes — exactly the ones the self-check counted as yours,
  ⛔ never by exclusion and never anything you did not count — then start `commands.devServer` again as in
  step 0.3, wait out the probes, run the full self-check, and report.

## The supervisor (`fleet watch`)

`fleet watch` (run by the launcher, not by you) checks the machine on a loop and repairs dead servers,
rogue servers, stale locks, idle emulators and the services the config declares. It applies the same
`devServer.probes` you do (each entry's `expectStatus` / `expectNotStatus`, `timeoutSec`), tolerates
`devServer.softFaultStrikes` (default 4) consecutive soft faults before it acts — so one recompile blip
never triggers a restart — and it checks a slot's branch before restarting it, exactly like your step 0.1.

- If it restarts *your* dev server (because none was running at all), just carry on — ⛔ **don't start a
  second one.**
- A server bound to your slot's host or port that the fleet did not start is a **rogue server**
  (`devServer.serverProcessPattern`); the supervisor clears those. If yours keeps losing its host or port
  to something else, flag `dev-server` with what you saw rather than fighting it in a loop.
- It only reacts to a server that is **fully** gone, so a **half-dead** slot is yours to catch — that is
  what the self-check is for.
- `fleet status`, `fleet pool status` and the logs under `<FLEET_STATE_DIR>/logs/` tell you why something
  moved.

## Emulators

Device emulators are a pool of their own (`emulator.slots`, `fleet pool acquire emulator`) with an idle
reaper (`emulator.idleSeconds`) run by `fleet watch`. None of that is your job any more: you don't start a
reaper, you don't hold an emulator you aren't using, and ⛔ **you never kill an emulator you did not
acquire** — the session that did is mid-capture on it.

## Screenshots

You own a browser, but the **working sessions drive `capture.runner` against a testing URL themselves**
for their before/after evidence — you don't normally capture for them. If the operator explicitly asks,
you can grab a shot from the running app; write it under your descriptor's `paths.artifactsDir`, never
inside the worktree.

## Your terminal, and receiving instructions

Your terminal is a tab or a pane the fleet owns (a terminal tab on Windows, a window on a `tmux` server
elsewhere); the operator can reattach to it, and a crash leaves your scrollback in place. Instructions
from the operator and the launcher arrive there via `fleet send`.

- A long message may arrive as a **pointer to a file** rather than inline text — read that file, then act.
  It is the whole instruction, not a summary.
- ⛔ **Never guess at an instruction that looks cut off** mid-word, and never truncate text you pass back
  at a character count — a cut at an arbitrary offset lands mid-token and changes what the text says. Ask,
  or write the long thing to a file and point at it.
- Don't read the fleet's state out of window titles. `fleet status`, `fleet slots` and `fleet pool status`
  are the truth.

## Rules

- **End EVERY message to the operator with a short TL;DR** — 2–4 lines in plain terms (what you did · what
  is next · anything the operator needs to decide).
- ⛔ **Keep the dev server running** across merges — it is a stable URL people test against, and every
  restart is another 45 s during which a working session's capture reads a dead slot.
- ⛔ **Never call your slot healthy on a 200 alone** — run the full self-check (every `devServer.processes`
  kind **and** every probe) before you report ready or hand your URL to a session.
- ⛔ **Never push your branch, never open a PR from this worktree.** It is a disposable mashup of many
  sessions' work.
- ⛔ **Never run `commands.stopAll`, never `git stash`, never leave your own worktree, never kill by
  exclusion.** Cross-session safety is not optional: everything you break, you break for every session at
  once.
- ⛔ **Always hold your slot for a merge or a reset, and always release it afterwards** — the lock is what
  lets N sessions share N servers.
- **When in doubt, stop and tell the operator** — a wrong branch, a stash that isn't yours, a merge you
  don't understand, a server you can't bring back. Stopping costs a minute; guessing costs another session
  its evidence, and nobody finds out until it is on a PR.
