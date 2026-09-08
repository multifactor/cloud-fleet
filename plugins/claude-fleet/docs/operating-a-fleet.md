# Operating a fleet

This is the **human operator's** guide: how to size a fleet for the machine in front of you, why the
installs are paced the way they are, how to get a stuck session moving again, and what the supervisor
repairs on your behalf. It is the counterpart to two other files — `playbooks/launcher.md` is what the
`/fleet` session itself follows, and `docs/gotchas.md` is the trap catalogue every rule here descends
from. Names, config keys, CLI grammar and tracker operation numbers are defined once, in
`docs/reference/contract.md`.

Throughout, `fleet <cmd>` means `npx claude-fleet <cmd>` from a shell, or
`node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <cmd>` from inside a session. Every command takes `--json`,
and every JSON payload starts `{"ok": bool, "v": 1, …}`.

> **Where the implementation stands.** Almost every behaviour described here is written and tested —
> each section below names the module that carries it, so a rule can be read against the code that
> enforces it. What is not finished is the CLI in front of them: `fleet config` and `fleet doctor`
> dispatch today, and the other verbs answer `unknown command` until their modules land under
> `src/cli/commands/`. `node bin/claude-fleet.mjs --help` is the authority on that, not this
> sentence. Read the rest as the operating manual it will be, and as the specification those command
> modules are written against.

---

## 1. The shape of a run

A fleet is one conversation plus *n* independent agents, each in its own git worktree:

| role | what it is | what it owns |
| --- | --- | --- |
| **the launcher** | the `/fleet` (or `/fleet-check`) session you talk to | the tracker, the machine, the decisions; it has no worktree and is never counted, killed or reclaimed |
| **working** | one session working one ticket | its worktree, its branch, its PR; it starts no server |
| **testing** | a session that owns a shared dev-server slot | one slot's server, lent to working sessions through the `testing` pool |
| **checker** | a session running one `/fleet-check` slice | its slice of a review sweep; see `playbooks/check.md` |

Each spawned session gets a git worktree under `repo.worktreeParent` named from
`repo.sessionDirTemplate`, created detached at `<repo.remote>/<repo.baseBranch>`; a terminal of its
own; and an agent process started by the CLI with the agent's permission prompts suppressed, so it
can follow its playbook unattended rather than stopping on a confirmation nobody is watching for.
⛔ **The model is pinned on that command line** (`--model <fleet.model>`), never inherited: with no
model passed, the agent picks its own default, which has silently put a whole fleet on the wrong
model mid-run.

Nothing talks to anything directly. Every session reads its own descriptor
(`<stateDir>/sessions/<label>.json` — written and reconciled by `src/core/fleet.mjs`, and the process
that reads it inside the window is `src/session/shim.mjs`) and the mirrored `FLEET_*` environment for
its paths, and
communicates through files under the state dir: **flags** (`done-<label>.json`,
`blocked-<label>.json`), the **tracker outbox**, the **ticket cache**, the **locks**, and the session
registry. That is why a fleet survives a closed terminal, a crashed launcher, and — with one
reconcile — a reboot.

The state dir is per repo, per machine (`paths.stateDir`), and it is deliberately **not** the system
temp directory: a temp path differs between a login shell and a service-spawned process on some
platforms, so a "shared" lock there is not shared at all, and two repos would collide on one flag
name.

---

## 2. The first run

1. Open `/fleet` in the repo. Its first action is always `fleet config status --json` — fast, never
   writes, and it exits 0 even when nothing is configured.
2. If the repo has no config, the wizard runs: it **detects** everything it can (bootstrap and
   dev-server commands from the package scripts, containers from a compose file, your branch prefix
   from your git user name, the fleet size from this machine) and proposes the schema defaults for the
   rest — the fixed-port URL template and the default probes, each row carrying a *source* that says so
   and, for the probes, that one of them wants pointing at an API route. Emulator slots are not probed
   at all; that pool is enabled by hand. It shows the lot as **one table with a source column**. Accept
   all, or name the rows to change. Target: three turns.
3. It writes two files through the CLI, never by hand: `<repo>/.fleet/config.json` — committed,
   shared with the team — and a per-machine user config under your platform's config dir (override
   with `FLEET_CONFIG_HOME`). Machine-shaped values (worktree parent, fleet size, branch prefix,
   terminal backend) live in the user file; `fleet config init` **refuses** to write them into the
   committed project file, which is what keeps a shared config portable.
4. A teammate cloning that repo runs `/fleet` once and answers only the machine rows — one turn.

Before the first launch, run `fleet doctor` (`src/cli/commands/doctor.mjs`). It probes, and prints one
line each: **git** on `PATH`; the **repo** — that you are inside a checkout, and which checkout is the
primary one; **node**, the running version against the repository's `engines.node`, because every
session inherits this interpreter; the **terminal backend** it would select and what it tried first;
the **tracker adapter** named by `tracker.id`, parsed and validated; the **state dir**, that it is
writable; the **artifacts dir**, that it is not inside any worktree; and **services**, each declared
container and its health port. It also **echoes `devServer.serverProcessPattern`**, the pattern the
supervisor uses to recognise a rogue dev server. ⛔ **Read that line every run:** a pattern that also
matches a test runner or a build will tree-kill a session's own work.

`fleet doctor --repair` fixes what is mechanically fixable: it runs the declared `startCommand` of the
container engine and of every declared container that is down — and where one is down with no
`startCommand`, it says exactly that instead of failing quietly.
`fleet doctor --verify-primary` additionally snapshots the primary checkout as the install reference
and fails loudly if that tree is empty or half-installed — a damaged reference certifies the damage
everywhere, because every worktree is proven against it.

Three things it does **not** probe yet, so check them yourself before a first launch: free physical
RAM against `install.reservePhysicalGb`, that `commands.bootstrap` actually runs, and the emulator SDK
when `emulator.enabled`.

**Tracker modes.** `tracker.mode: mcp` is the normal one. `manual` runs the whole fleet with every
tracker transition queued in the outbox for the launcher to apply — useful when a tracker connection
is down and you would rather work than wait. `none` drops the tracker entirely: sessions take a PR
number, a branch, or plain task text. None of the three changes how the fleet is sized or paced.

---

## 3. Sizing the fleet

### ⛔ Size from free physical RAM — never from the commit limit

Commit (RAM + swap) is a bookkeeping ceiling. The resource that actually runs out is **physical
RAM**. Sizing to a percentage of commit systematically halves every estimate; worse, it reads as
roomy right up to the freeze — one box hung hard with tens of gigabytes of commit headroom and under
three gigabytes of physical free.

If a hardware change (more RAM) does not move your ceiling, check swap before blaming anything else:
a system-managed swap file does not scale with installed RAM, so commit can stay the binding term
after a memory upgrade. Set it so that **free physical RAM becomes the binding constraint** — and
then stop. Extra commit beyond that converts directly into paging, which is the thrashing you are
trying to avoid, and a bigger commit limit is not freeze protection.

### The number the CLI derives is the install-safe one

`fleet.size` defaults to (`fleetSizeFor` in `src/config/derive.mjs`):

```
clamp(1, floor((total physical RAM − install.reservePhysicalGb) / install.perInstallGb), cpu count)
```

with `install.reservePhysicalGb` 8 and `install.perInstallGb` 4 by default. That is deliberately the
**install-safe** number: it assumes every session might be installing at once, which is the state
that actually freezes machines. The wizard shows the arithmetic (`floor((64 − 8) / 4) = 14, capped at
16 cpus`) rather than only the result, so you can see what to change.

Note which memory reading each number uses, because they are not the same one. This default is a
**static estimate** made before anything runs, so it is derived from *total* RAM minus the reserve. The
gate that decides whether the next install may start reads **free physical** RAM at that moment —
that is `decide()` in `src/core/pacing.mjs`, and it is where the rule above is actually enforced (§4).

### Steady state is much cheaper — raise the size deliberately

Once the installs are done, a working session is small. To size for steady state, measure and use:

```
workers = (physical RAM − reserve floor − measured OS/apps floor − slots × per-slot cost) ÷ per-session peak
```

Set `fleet.size` (and `fleet.hardCeiling`, which defaults to `size + 2`) from that number in the user
config, and keep `install.concurrencyCap` where it is — the two are independent, and that separation
is the whole point: **pace the installs, size the workers generously.**

### Typical measured costs

Measured on one 64 GB, 16-thread Windows box, by summing the working set of each session's whole
descendant tree. Treat them as **typical**, not as constants — re-measure on your own hardware:

| thing | typical cost |
| --- | --- |
| working session, idle | ~0.7 GB |
| working session, active (reading, editing, agents) | ~0.8–1.2 GB |
| working session, at peak (test runner, browser automation, type-checker) | ~2.0 GB |
| testing slot (a dev server, both halves) | ~5.6 GB, **ratcheting upward over hours** |
| one dependency install, at peak | ~4 GB (`install.perInstallGb`) |
| OS, browser and desktop apps floor | ~12 GB in the morning, ~14.4 GB by late afternoon |

On that box, at the **~2.0 GB peak** figure and with one slot, the formula yields roughly
**18–19 workers** — `(64 − 8 reserve − 12 to 14.4 OS floor − 5.6 for the slot) ÷ 2.0` — not the ten a
commit-based estimate suggested. Size against the peak row, not the active one: the cheaper
`~0.8–1.2 GB` denominator is what a fleet costs between test runs, and it is the peak that freezes the
box.

**Measure marginally, never by subtraction.** A per-session figure derived as
`(physical in use − OS − slots) ÷ workers` blames each worker for the file cache, memory compression,
the kernel pool and every small process on the machine, and inflates by roughly 2×. Sum the descendant
tree of one session instead. And re-measure the OS/apps floor **immediately before every wave** — it
grew by more than two gigabytes over a single afternoon as a browser and other desktop
applications grew.

**A configuration that has already been observed running outranks any formula.** 15 workers plus 4
slots (about 40 GB) ran for hours on that box; anything under that total is proven rather than
speculative. Write the proven configuration into the user config and stop re-deriving it.

### Ceilings that are not RAM

- **Quota.** A fleet twice the size burns account quota about twice as fast, so the account can become
  the binding constraint before the machine does. A fleet-wide limit stall is a **park**, not a fault
  (§7).
- **The dev-server heap.** Some dev servers size their heap from *total* memory and never compact, so
  every slot grows for the whole run — this is why the per-slot figure above ratchets. Cap the heap
  explicitly in `commands.devServer` (or in the environment it inherits) and restart a long-lived slot
  to reclaim what it has crept up to. `testing.count` is the multiplier: four slots is roughly three
  working sessions' worth of RAM.
- **Session creation rate.** Creating worktrees, not running them, is what makes a big fleet slow to
  start. See §4.
- **Disk.** A worktree is a few gigabytes across a couple of thousand packages. Twenty of them is real
  disk, and reclaiming finished ones promptly (§5) is what lets a long run keep going.

---

## 4. Install bursts — pacing, and why

⛔ **The freeze is the install burst, not the session count.** One run started eight installs at once
because it gated on commit headroom (which looked roomy); each install peaks around four gigabytes,
the burst drove the box to under three gigabytes of physical free, and it thrashed to a hard hang.
Steady-state sessions never did that.

So installs run in **waves, not a rolling pool**. The decision is `decide()` in
`src/core/pacing.mjs` — pure, with the per-OS memory probe injected, which is what lets the incident
above be a test case instead of a comment — and the wave loop and the install proof are
`src/core/install.mjs`:

- `install.concurrencyCap` (default 4) is the **wave size**, not a pool ceiling. Each wave barriers on
  all of its installs, then the box **genuinely idles** for `install.settleSec` (30 s) so disk
  writeback and the file cache drain. A rolling pool never has a quiet moment, and the quiet moment is
  the point. Two clamps sit above the config value and cannot be raised past: the module's own
  `HARD_CAP` of 4, and `floor(cpu count / 4)` — so a four-thread box installs one at a time whatever
  the config says.
- The wave size is re-probed every wave, and free physical RAM is re-probed **before every install**.
  When memory is tight the launcher holds (`install.holdPollSec`, 20 s) against a **run-wide** budget
  (`install.maxHoldSec`, 600 s) and then proceeds with a loud warning rather than stalling the fleet
  forever. Three readings lower the number by themselves: elevated memory pressure **serialises** to
  one install, and critical pressure or a **failed probe** yields zero and holds — a probe that failed
  tells you nothing, so it reads as tight and never as roomy. Commit headroom is a secondary guard
  that can only lower the number, never raise it.
- Window spawns are staggered by `install.spawnStaggerSec` (3 s), which also spaces out each
  `git worktree add`.
- `FLEET_INSTALL_CONCURRENCY_CAP` may only **lower** the cap, never raise it. Config keys map to
  environment variables by the usual rule (`install.concurrencyCap` → `FLEET_INSTALL_CONCURRENCY_CAP`).

**Wall clock, 25 worktrees:** wave size 4 ≈ 7 waves ≈ **40 minutes**; 2 ≈ 13 waves ≈ **70 minutes**;
1 ≈ 25 waves ≈ **2 h 15**. Tell whoever is waiting which trade you took.

⚠️ **A bigger wave does not lower the peak write rate — only a smaller wave does.** Four concurrent
installs produce roughly 1,660 disk writes per second (about 415 each); two produce about half that.
Settle gaps cut the *average* load and give a fragile platform recovery windows, but the peak is set
by the wave size alone. If a box hangs or resets **with tens of gigabytes still free**, that is not
memory: it is sustained all-core CPU plus saturated storage, and the only software answer is a smaller
wave. Do not re-diagnose it as RAM every time — record the refutation in `docs/field-notes.md`.

Pacing also makes a crash *cheaper*. A reset while the box was idle corrupted nothing; a reset
mid-install corrupted six dependency trees at once.

**Warm donor.** `install.donor.enabled` keeps a warm dependency tree at `install.donor.path` and
copies it into a new worktree before running a much shorter install. It is gated on a lockfile hash,
and the copy is verified afterwards exactly like a fresh install — a stale donor is worse than no
donor.

**After a crash mid-install**, do not trust any cheap signal. The ready flag, a full package count and
a complete set of binary shims have all been present on trees whose files were NUL-padded by the
reboot. The check that catches it is the **install proof** in `src/core/install.mjs`
(`install.proof.mode: compare-primary`): a per-package file-count comparison against the primary
checkout, nested workspace trees included, which is the only detector for a half-extracted package —
a rerun of the package manager will never repair one, because the directory already exists. Run
`fleet doctor --verify-primary` first, because it checks that the reference tree those counts are
compared against is itself intact: a damaged reference certifies the damage everywhere.

---

## 5. Recycling finished sessions

A finished worktree holds real disk and a live agent process, so reclaiming it is what lets a long run
keep going.

**Sessions announce themselves; nothing polls for them.** As its very last action a working session
writes `flags/done-<label>.json` with an `outcome` — `pr-pushed`, `cancelled`, `duplicate`,
`no-code-change` or `check-complete` — plus the PR URL, the reason and `evidence` when it has them.
The flag is the session asserting it is finished, so it authorises **immediate teardown with no
waiting period**.

`fleet watch` reclaims flagged sessions on its own. By hand it is `fleet kill <label>`, which
re-confirms the worktree is detached and clean, kills the process tree deepest-first, removes the
worktree, verifies with `git worktree list`, and deletes the flag. `--dry-run` prints the plan first.

The reclaimer is `src/watchers/reclaim.mjs`, and it re-verifies four things before anything is
destroyed — each one a run that went wrong. The worktree is detached **and** clean. A `pr-pushed`
outcome really has its branch on the remote (`git ls-remote --heads`, run from the primary checkout:
a flag once said "pushed" for a push that had failed). An `amended` prescription is either already
patched into the ticket body or queued in the outbox, or the reclaim **refuses** — once the worktree
is gone there is nobody left to ask for the correction. And no *second* process is live in that
worktree, because a relaunch that spawned beside a wedged agent leaves two in one tree and reclaiming
one deletes the tree under the other. A `cancelled`, `duplicate` or `no-code-change` flag raised over
uncommitted changes saves them as a patch under `<stateDir>/wip/` and then proceeds.

Two rules that cost real runs:

- ⛔ **Never recycle a session that is still installing.** A fresh worktree is detached, clean and
  branch-less until its install finishes — indistinguishable from a finished one by git state alone —
  and under wave pacing it may not have *started*: the last wave of a 25-worktree run begins 30+
  minutes in, so this state can persist for most of an hour. The missing ready flag
  (`install.readyFlag`) is the protection, and `fleet kill` refuses such a worktree unless you name it
  explicitly.
- ⛔ **Do not use a PR lookup to decide whether a session is finished.** A finished session may
  legitimately have no PR and no branch — it closed its issue with no code change — and a PR listing
  filtered on an empty branch name returns *all* PRs, so the first row is an unrelated one.

For a session that crashed **before** flagging, the fallback is inference: the worktree is detached,
clean, and its **reflog** shows a checkout moving from its issue branch back to the base branch — the
move the close-out itself performs. A second arm covers a session that never branched at all: zero
such reflog entries but a present ready flag and no live agent, on a longer idle. Inference arms get a
two-strike delay; the flag needs none.

Expect the occasional **empty, cwd-locked folder** to survive a removal — a shell still has it as its
working directory, so the directory itself cannot be unlinked even though its contents are gone. It is
cosmetic: it holds no disk, is not a registered worktree, and the next `git worktree add` reuses an
empty directory happily. Session numbering counts leftover folders as well as registered worktrees, so
it never collides with one.

---

## 6. Unblocking a stalled session

Sessions can see their own worktree and nothing else. They cannot tell a genuinely broken dev server
from one another session is mid-rebuild on, or a wedged lock from a busy one — so when infrastructure
stalls them they write `flags/blocked-<label>.json` with a `category`
(`dev-server`, `testing-slot`, `services`, `emulator`, `tracker`, `cloud-env`, `install`,
`capture-spec`, `usage-limit`, `merge`, `other`) and an observation, then carry on with anything that
does not depend on the blocker.

The launcher's job is to **diffuse** the block, not relay it to you. What that looks like:

1. **Diagnose against the whole machine** — `fleet doctor --json`, `fleet pool status`, and the
   supervisor's log. Most "outages" are not: a dev-server URL is down only if its route is missing from
   the proxy **and** its worktree has no server processes (otherwise it is compiling — hence the 45 s
   probe); a slot the pool reports `HELD` is *busy*, not broken; a `tracker` flag naming a key, a
   target state and a PR URL is an outbox entry, not a diagnosis problem.
2. **Fix what is fixable** — `fleet doctor --repair` for services, a restart for a slot that truly has
   no server processes, `fleet pool release <pool> <slot>` for a lock whose holder is verifiably gone,
   the pool for a wedged emulator. When the fix is a value in a per-worktree environment file, apply it
   at the **primary checkout too**: `commands.bootstrap` copies such files verbatim into every new
   worktree, so a wrong value at the primary is inherited by every wave.
3. **Reply to the session, by file** — `fleet send <label> --file <path>`. Console injection can
   half-deliver (see `docs/gotchas.md` → *Terminal*), and a message a session never read is worse than
   no message, because it looks answered. Be specific: what was fixed and that they can retry, or that
   the resource is legitimately held and roughly for how long, or which slot to use instead.
4. **Verify delivery** — the proof is the session moving again, not the send command's exit code.
5. **Delete the flag**, so a recurrence re-flags instead of looking like the same unresolved one.

Two things never to do. ⛔ **Never resolve a block by letting a session start its own server** — every
session doing that at once is the load profile that hard-powers-off a machine, which is why the
supervisor tree-kills dev servers found inside working worktrees. And ⛔ **never leave a session
retrying forever**: if something is genuinely unfixable (hardware, a wedged stack that needs a
restart), say so plainly to the session and to yourself, and park.

---

## 7. Stalls, quota and account switches

Two failures look identical from outside — a quiet session behind a green "ready" tab — and are
handled oppositely. The stall watcher (`src/watchers/stalls.mjs`) tells them apart by parsing each
session's newest transcript and reading the **last assistant entry's** API-error field (never by
grepping the tail: a tail grep for an error phrase once marked five healthy sessions dead, because the
window still held an older, already-recovered error). The park-and-resume half — the work-in-progress
patches, the fleet manifest, and restarting a helper loop that died — is `src/watchers/guardian.mjs`.

- **A transient API error or timeout** kills the *turn*, not the work. A message sent into that dead
  turn is consumed and lost, so the session needs a new **process**: `fleet relaunch <label>` kills the
  old tree, verifies it is gone, and starts a fresh agent in the **same worktree** — branch, commits and
  untracked helpers all survive, and the seeded prompt makes it resume. A new worktree would abandon
  the branch, which is why relaunch is its own command. Killing the old process first is not optional:
  two agents in one worktree collide on the git index.
- **A usage or session limit is account-level, and nothing bypasses it.** Relaunching hits the same
  wall in a fresh process, and it stops the *whole fleet* — most of a fleet dies within minutes of
  itself. Park until the reset and say so plainly rather than reporting motion. While parked, the
  guardian snapshots each worktree's uncommitted work as **patch files** (a diff plus the untracked
  list) — read-only, so a session resumes exactly as it left off. ⛔ **Never `git stash`**: `refs/stash`
  is shared across every worktree of a repo, so one session's stash is visible and poppable by another.

⛔ **After quota returns — a reset, a different account, a re-login — the sessions must be nudged.
They do not self-recover.** A session whose turn closed on the limit error has nothing left to wake it.
`fleet watch` detects the switch and nudges every stalled session; if it is not running, nudge them
yourself. The one exception is a session with a pending background subagent, whose completion arrives
as a fresh prompt — roughly a third of one fleet self-recovered that way while the rest sat dead. Do
not mistake "sessions are writing again" for self-recovery: verify the nudge was the cause, or you
will write down a false rule.

---

## 8. Terminal backends: Windows Terminal vs tmux

`terminal.backend` is `auto` by default and probes what the machine has. The two supported backends
differ in ways worth knowing before you pick:

| | Windows Terminal | tmux (macOS / Linux) |
| --- | --- | --- |
| **a session is** | a tab in a fleet window, running the session shim | a window in a dedicated tmux session |
| **listing** | the fleet registry plus one cached process snapshot (there is no window query API) | authoritative, from tmux itself, in milliseconds |
| **sending text** | chunked console input that honours the returned written count, with a file-pointer fallback for anything long | a paste buffer — no truncation class at all |
| **status** | the shim paints the tab title red (working) / green (ready) | one status bar for the whole fleet, and the state is readable back |
| **survives the terminal closing** | no | **yes** — the server is detached; `fleet attach` reconnects, including after a dropped remote connection |
| **layout** | `windows` (default); `pixel-grid` is a Windows-only opt-in whose placement scripts would live in `extras/windows/` — they are not written, so it degrades to plain windows with a notice | `tiled-panes` as a logical grid, unreadable past about six |

The backends live in `src/backends/` — `windows-terminal`, `powershell`, `tmux`, and the headless
`none` — over one interface (`types.mjs`) and one conformance suite. Everything without a window-query
API (the two Windows ones and `none`) answers "which sessions exist?" from the registry plus a single
process snapshot, never from a command-line search: that shared half is `registry-first.mjs`.

Notes that matter in practice:

- **Windows Terminal** is used when `wt` is present and falls back to a plain console window when it
  is not, announcing what it tried. Because a detached fleet cannot survive the terminal on this
  backend, treat closing the fleet window as ending the run.
- **`none`** is not part of `auto` on any platform; set it deliberately. It spawns each session
  detached with its output in `<stateDir>/logs/<label>.log`, and a send into it reports that nothing
  was delivered rather than pretending otherwise.
- **tmux** needs 3.0 or newer and gets a **dedicated socket and config** (`terminal.tmux.socket`,
  `terminal.tmux.session`), so a fleet never shares your own tmux server or inherits your prefix. Two
  consequences: `fleet down` must kill that server, and a second `fleet up` **adopts** the existing
  session rather than starting a rival one.
- **Window placement is not part of the tool.** The fleet view is `fleet status`, the tmux status bar,
  and the tab titles. Nothing re-arranges windows as a side effect of a session finishing or a refill
  — a slightly untidy layout that stays put is strictly better than a tidy one that moves under
  someone reading it.
- **`fleet slots`** prints the slot table (branch, worktree, URL, holder) and **`fleet session env
  --label <label>`** prints one session's resolved environment — the two things to read before
  believing a session was handed the wrong URL or state dir.

---

## 9. What `fleet watch` repairs — and what it will not

`fleet watch` is the supervisor loop (`src/supervisor/loop.mjs`). Start it right after `fleet up`;
there is **exactly one** per fleet, and the loop enforces that itself — a second instance detects the
first by the exact `cli.mjs watch` argv, and the **newer** one exits.

One pass takes **one** process snapshot and runs every check against that single reading: the Windows
scan alone costs about 450 ms, and two checks reading two different snapshots disagree about which
processes exist. A check that throws is recorded as a fault and the pass continues, because a
supervisor that dies on one bad reading is one nobody notices is gone. Each pass writes
`<stateDir>/watch.status.json` and appends a line to `<stateDir>/logs/watch.log`.

The seven checks are `src/supervisor/checks/{orphans,rogue-servers,stale-locks,memory,sessions,
services,slots}.mjs`, run in that order — kills first, then locks, then the memory reading, then
sessions, then **services before slots**, because the container engine and its containers must be up
before a dev server is judged, or every restart lands on a slot whose database is down. Beside them
run the four watchers (`src/watchers/`), which are separate loops on their own intervals so they keep
working when the fleet is parked at a usage limit. Between them, on those timers, that machinery:

- **reclaims flagged sessions** — a `done` flag, re-confirmed detached and clean, then torn down;
- **surfaces blocked flags and stalls** for the launcher, classifying each stalled session from its
  transcript's last assistant entry;
- **restarts a dev server that is genuinely dead** — only when the worktree has *no* server processes
  at all (live processes mean it is compiling), only after `devServer.softFaultStrikes` consecutive
  soft faults, only once the worktree's ready flag exists, and only after re-checking the slot is on
  its own branch;
- **tree-kills any dev server found inside a working worktree** — this is what makes "working sessions
  are serverless" real rather than merely documented — and any process orphaned by a removed worktree;
- **repairs declared services** from config (`services.docker.*`, `services.containers[]`), including
  their health ports;
- clears **stale locks by timestamp only** (the recorded PID belongs to a short-lived acquire process
  and is dead within seconds of a healthy acquire, so "holder process gone" is not a staleness test —
  it hands one slot to two sessions), with a per-pool window: `testing.lock.staleMinutes` for a slot,
  `emulator.lockStaleMinutes` for the emulator. **The idle-emulator reaper is not written yet**: a
  stale emulator *lock* is cleared, but nothing shuts an idle emulator down after
  `emulator.idleSeconds`, so that one is still yours;
- **watches memory**, logging the footprint and raising an alarm below a floor, naming the biggest
  **non-fleet** consumers — usually a browser or a desktop app, not the fleet;
- **detects an account switch** and nudges parked sessions;
- **tops the fleet up from the queue** when autowave is on, taking capacity from `git worktree list`
  rather than a folder count.

It will **not** repair a corrupt dependency tree, answer a blocked flag (that judgment is the
launcher's), decide anything about your code, or kill a process it cannot positively identify as a
descendant of a fleet session. ⛔ **Never kill by exclusion:** an ad-hoc teardown that treated every
agent process without a fleet ancestor as an orphan once destroyed an operator's own hand-started
agent an hour into unrelated work — the launcher and any human-started agent in the primary checkout
also lack a fleet ancestor, so they were indistinguishable from orphans.

⛔ **Stopping it: `fleet down`, or its single PID — never a tree-kill.** The supervisor starts the
container engine and dev servers as its own children, so a tree-kill takes the database down with it,
silently, and every login and provisioning call across the fleet starts returning 500. After any
restart, assert the count is exactly one: two supervisors race each other's repairs.

`notifications.command` is the one outbound hook: a command of yours, run for fleet events with the
event and the message in the environment, if you want a desktop or phone notification rather than
watching a terminal. There is no telemetry and no third-party service. **It is not wired yet** — the
watchers take the notifier as an injected seam, and the module that runs your command is unwritten, so
today a fleet event reaches the status file and the log and nowhere else.

---

## 10. A day in commands

```
fleet doctor [--repair]        machine check before anything is spawned; --repair starts declared services
fleet up 6 --testing 1         6 working sessions + 1 shared dev-server slot
fleet up --issues ABC-1234,ABC-1240      one auto-started session per key (parents expand to children)
fleet add 2                    two more working sessions, pool untouched
fleet status [--json]          the fleet table: role, worktree, branch, issue, install state, stalls, refusals
fleet watch                    the supervisor loop (exactly one)
fleet attach                   re-attach to the fleet's terminal session (tmux)
fleet slots                    which slot is which, and who holds it
fleet send <label> --file p    reply to a session, by file
fleet relaunch <label>         new process, same worktree — for a dead turn
fleet kill <label> [--dry-run] reclaim one finished session
fleet pool status|release      the shared testing / emulator / e2e-port / worklist pools
fleet ticket list|show KEY     the offline ticket cache the sessions read
fleet outbox list|ack <id>     tracker operations queued by sessions whose tools were down
fleet config sources           where every effective value came from, layer by layer
fleet down [--dry-run]         full teardown back to a clean base branch
```

Every command above dispatches. `fleet check …` is not listed here because it belongs to the other
half of the pipeline — `playbooks/check.md` drives it — but it dispatches too, as far as the wrap-up:
`plan`, `worklist write`, `resume`, `slice`, `brief`, `ledger`, `fid`, `reconcile filed`, `status`,
`gate`, `promote`, `enum check`, `blast-radius`, `finish`, `mark`, `gh bundle` and `tick plan` run;
`verify-citations`, `verify-paths`, `frame`, `reconcile tracker`, `dups cluster`, `harvest` and
`audit plan` do too — every verb under `fleet check` dispatches. The one command that still refuses by
name is `fleet cloud dispatch`.
`fleet --help` always lists exactly what is wired, and outranks this page.

---

## 11. After a reboot, and after an unclean shutdown

Restore the infrastructure **before** touching sessions. A container engine does not usually
auto-start, so a declared database stays down, nothing listens on its port, and every login and
provisioning call returns 500 — while the app's root still serves 200 and unauthenticated routes still
answer correctly, so it reads as an application bug rather than a missing dependency. No session can
see any of this from inside its worktree.

Order: `fleet doctor --repair` → confirm the health ports → (after an *unclean* shutdown)
`fleet doctor --verify-primary` and a per-package check of any worktree that was installing → start
`fleet watch` → only then resume or launch sessions.

⛔ **Never run two launchers at once.** Both read `git worktree list` at startup, so each skips the
worktrees the other has just created — and a skipped slot silently drops its issue. A launcher with no
output yet is not a failed launcher: check whether one is running before starting another, and never
conclude one failed to start from a missing log.

---

## 12. Housekeeping

- **State** lives under `paths.stateDir`, per repo and per machine: the session registry, flags, the
  outbox, the ticket cache, locks, the queue, and sweep directories for `/fleet-check`.
- ⛔ **Review artefacts** live under `paths.artifactsDir`, which validation **errors** on if it sits
  inside any worktree — a review page must survive the session that made it, because review starts
  after the fleet is gone. Teardown never touches it.
- **Field notes** (`docs/field-notes.md`) are the staging area for anything that surprised you, written
  **the moment it happens** — a note written at the end of a run collapses into a summary and loses the
  diagnostic path, which is the only part worth keeping. Record refutations too: "my explanation was
  wrong, and here is what disproved it" saves the next operator from re-deriving the same wrong answer.
  Confirmed twice, an entry is promoted into `docs/gotchas.md` or the playbook that owns it.

---

## 13. Ending a run

When the last working session has finished and fleet resources still exist, run `fleet down`. It
returns the machine to a clean base branch and reclaims what per-session teardown cannot: the dev
servers, the proxy, the emulator, the supervisor, and on tmux the dedicated server.

It is destructive and it resets the primary checkout, so four things are checked first — zero working
worktrees remain (verified with `git worktree list`, not assumed); there is still something to tear
down (⛔ **fire on the transition, not the state**, or an unguarded rule re-runs teardown forever); no
un-actioned flags are left; and the **primary checkout is clean**. ⛔ If the primary has uncommitted
work, **stop**: that is your own work, and losing it is far worse than leaving a few servers running.
`fleet down --dry-run` prints exactly what would go.
