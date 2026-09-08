# Gotchas — the trap catalogue

Everything in this file was paid for on a real run. It is the durable part of the fleet's field
notes: the traps that survived being confirmed twice, stripped of the incident that produced them and
kept for their **shape** — which check lied, which one told the truth, and what to do instead.

**How to read an entry.** Every entry is one paragraph in three parts — **Symptom** (what you will
see, and usually misread), **Cause** (what it actually was), **Rule** (imperative; what to do next
time) — followed by an `In claude-fleet:` line naming the module, command, config key or flag that
encodes the rule so you can find where it lives and why it is shaped the way it is. Entries whose
title carries `⛔` are hard rules: the rule is not a preference, and the sentence after it is the
*why* — read it before you decide the rule does not apply to you.

**Vocabulary.** *The operator* is the human running the fleet. *The launcher* is the `/fleet` or
`/fleet-check` session. *A session* is a spawned `working`, `testing` or `checker` Claude Code.
*A worker* is a subagent or a cloud sandbox inside `/fleet-check`. *A slot* is a shared dev-server
seat owned by a `testing` session and borrowed through the `testing` pool. Tracker actions are named
only by their operation number (`op-1`…`op-27`, see `docs/reference/contract.md` §6). Every path a
session touches comes from its descriptor or its `FLEET_*` environment — there are no literal paths
in this file because there are none in the product.

**Where new traps go.** New incidents land in `docs/field-notes.md` as `### !! <symptom>` entries
with a literal **Saw:** and **Rule:**, and a cause between them (a descriptive label is fine, its
absence is not), the moment they happen, not at the end of a run — notes written at the end of a run
collapse into a summary and lose the diagnostic path, which is the only part worth keeping.
Record refutations too: "my explanation was wrong; a clean restart with the dependency confirmed up
still failed" is worth more than silence, because the next operator otherwise re-derives the same
wrong answer. When an entry has been confirmed twice, or is severe enough to burn a run, it is
promoted here and into the playbook that owns it.

---

## Worktrees & installs

### ⛔ A killed `npm install` leaves packages the package manager will never repair

**Symptom:** the install exits 0, the ready sentinel is written, `npm ls` is clean, the unit tests and
the linter pass — and then the build fails on a missing module or a missing type declaration in a
file nowhere near your diff, or the type-checker emits a baffling error about a dependency's *other*
major version. **Cause:** interrupting an install leaves half-extracted package directories, and the
package manager sees a directory and calls the package installed — it never re-extracts, so exit 0,
the sentinel, a clean `npm ls` and green tests all lie. The nested trees (`<workspace>/node_modules`)
are the usual victims, and because the type-checker resolves workspace imports through the junction,
one missing nested `index.d.ts` makes it fall back to a different major version of the same package
and emit a type error that looks like your fault. **Rule:** detect by diffing **per-package file
counts against the intact primary checkout**, and make the scan cover the **nested** `node_modules`
too — a root-only scan misses exactly the trees that break. Repair by deleting each damaged package
directory and re-running the install — **never `npm ci`**, which wipes the whole tree — then
re-verify the counts and restart any dev server in that worktree, because its dependency tree
changed underneath it.
*In claude-fleet:* `install.proof.mode: compare-primary` with `install.proof.tolerance` is the
default proof in `src/core/install.mjs`; `fleet doctor --repair` runs the per-package comparison
(nested trees included) and deletes-then-reinstalls only the damaged packages; `fleet doctor
--verify-primary` refreshes the snapshot the comparison is made against.

### ⛔ The install sentinel proves the install *ran*, not that the tree is *complete*

**Symptom:** the worktree carries the ready flag, so a session starts running commands — and a third
of the way through, a build or a test runner dies on a package that is a directory with nothing
inside it. **Cause:** the sentinel is written when the install process exits; it cannot know that the
process was a second writer, was killed mid-extract, or ran over a tree a crash had already
NUL-padded. A session that trusts the sentinel alone is trusting an exit code with a nicer name.
**Rule:** the sentinel is written **only after** the content proof passes — a per-package comparison
against the primary (or the configured probe files at their full size) *and* a shim count at the
expected level — never after the install exit alone; and the session-side rule is the mirror image:
do not infer a usable tree from package counts, shim counts, `npm ls` or an install exit code, because
every one of them has lied independently. One tree had a perfect shim count with the compiler's main
library file absent; another had the file and zero shims; a third had the file truncated to a
quarter of its size.
*In claude-fleet:* `install.readyFlag` (default `.fleet-ready`) is written by `src/core/install.mjs`
only after the `install.proof.mode` proof passes; `install.proof.probeFiles` lets a project name the
large, always-present files whose exact size is the cheap tell; `playbooks/session.md` tells the
session to wait on the flag and to flag `install` rather than repair.

### ⛔ Two writers in one worktree corrupt it — and it still passes every cheap check

**Symptom:** dozens of tar-entry errors scroll past during an install, or none do and the tree simply
has the wrong shape afterwards: right package count, missing or truncated files. **Cause:** two
installs ran in one worktree at once — a second launcher, a session running `npm install` "to be
safe", a helper repairing a tree the launcher was still filling. The package manager does not lock
the tree against a concurrent writer, and once both have finished it sees directories and calls
everything installed. **Rule:** exactly one writer per tree, ever: sessions never run the install
themselves, and the launcher asserts no other launcher is alive before it starts one — a second
writer's damage cannot be repaired by a third install, only by deleting the damaged packages.
*In claude-fleet:* `playbooks/session.md` forbids `npm install` in a session; `fleet up` refuses to
start while another launcher process is alive (`src/core/fleet.mjs`); the blocked-flag category is
`install`.

### A network failure mid-install is not corruption — delete the partial tree and retry

**Symptom:** an install dies with a connect-timeout from the registry, or a postinstall script fails
on a DNS lookup and the package manager rolls the **whole** tree back. **Cause:** transient network,
unlike the two-writer case above, and unlike it a retry *can* succeed — but only on a clean tree,
because the rollback still leaves partial directories the package manager will call installed.
**Rule:** delete the partial tree, re-resolve the failing host first so a ten-minute install is not
burned rediscovering a dead network, then retry once. Two attempts, then escalate. Tell the two
failure classes apart by their errors: a connect/DNS error is transient; tar-entry errors mean two
writers, which no retry fixes.
*In claude-fleet:* `src/core/install.mjs` classifies the install log and retries the transient class
exactly once before writing a `blocked` flag with category `install`.

### ⛔ Never hand-patch the files a broken tree complains about

**Symptom:** a session "fixes" a build by editing the one missing type declaration the compiler named,
or by disabling type-checking for the build. **Cause:** the build was failing because the tree was
incomplete; patching the named file silences one symptom of a tree that is still broken elsewhere,
and disabling the check disables it for the **entire** build, so a real type error in the session's
own change still produces a good-looking build and screenshot — which destroys the capture's whole
value as evidence. **Rule:** a build failing on a missing module or declaration is an incomplete
`node_modules` until proven otherwise (nested trees included) — flag it with category `install` and
stop; never hand-patch the named file, and never add a suppression to the build config, even a narrow
one, without asking.
*In claude-fleet:* `playbooks/session.md` §Dependencies; `fleet flag blocked --category install`.

### A nested-only package directory is normal — a missing top-level copy is not a defect

**Symptom:** a repair scan reports a "missing" package because `node_modules/<pkg>/build` does not
exist at the top level. **Cause:** a healthy tree hoists what it can; some packages exist *only* as a
nested copy under another package's `node_modules`, and the top-level directory was never supposed
to be there. An operator nearly "repaired" healthy trees over this. **Rule:** compare each nested
location against the same location in the primary checkout — never assert a layout from first
principles.
*In claude-fleet:* `install.proof.mode: compare-primary` compares paths that exist in the primary,
nothing else.

### Never repair a worktree that is mid-install — tell it apart by the install log's mtime

**Symptom:** a repair sweep finds a tree with half the expected file count and rebuilds it; the
launcher's own install, which was two-thirds done, now collides with the repair and both trees are
wrong. **Cause:** by file count a stranded tree and an installing tree look identical. **Rule:** the
install log's modification time is the tell — fresh means installing, leave it alone; stale means
stranded, repair it.
*In claude-fleet:* `fleet doctor --repair` skips any worktree whose install log under `<stateDir>/logs/`
was written in the last few minutes.

### ⛔ A live worktree is not a donor — the reclaimer will delete it under your copy

**Symptom:** three trees cloned from a healthy sibling finish with the right shim count and the right
probe-file sizes, yet the test runner cannot start: a nested package's `build/` directory is empty.
**Cause:** the donor was a live session's worktree. It finished its ticket mid-copy, wrote its done
flag, and the reclaimer did its job — killed every process holding that path (the copy readers
included) and deleted the tree. In-flight copies were truncated silently because the copier's exit
code had already been captured for the batches that finished. **Rule:** never use a live worktree as a
donor. Snapshot one to a stable path **outside every worktree parent** so nothing reclaims it, and
verify the clone by **total file count against the donor** (with a small tolerance for caches a live
session writes) plus a probe of a **nested** file — shim count and probe-file size both passed on the
broken trees and only the count caught it. Verify with the test runner's list mode, not the
type-checker: the type-checker never loads the package that was missing. Whichever verifier you
run, echo its **explicit exit code** — a compiler prints nothing on success, so an empty log is
indistinguishable from a process that was killed mid-run.
*In claude-fleet:* `install.donor.enabled` / `install.donor.path` (default `<stateDir>/nm-donor`,
outside `repo.worktreeParent`); `src/core/install.mjs` clones from the donor and applies the
`compare-primary` proof to the result before writing the ready flag.

### ⛔ Re-capture the donor whenever the lockfile changes — the gate is exact

**Symptom:** every new session silently takes twenty-five minutes to install instead of ninety seconds,
and the fleet asymptotes below its target again. **Cause:** the donor is gated on the exact hash of
the manifest and lockfile it was captured from; one byte different and the fast path is skipped
without a word, because a donor from a different lockfile would be a corrupt tree with a green
sentinel. **Rule:** re-capture the donor every time the lockfile changes on the base branch, and log
loudly when the gate falls back to a full install so a slow wave is visible instead of looking like a
stalled autowave.
*In claude-fleet:* the donor manifest carries the lockfile hash; `src/core/install.mjs` logs every
fallback to a full install with its reason, and `fleet doctor` reports a stale donor.

### ⛔ Folder count is not capacity — count registered worktrees or reachable sessions

**Symptom:** the fleet looks **full** — twenty folders on disk — while only seven sessions answer, and
every top-up is silently refused. **Cause:** `git worktree remove --force` had deregistered eleven
worktrees and then failed to unlink their directories (shells still held files inside them); a
capacity check that counted folders saw a full fleet and never fired. **Rule:** take live capacity
from the registry or `git worktree list`, never from a directory listing — and after any removal,
verify the **filesystem**, not the exit code.
*In claude-fleet:* `fleet status` counts `sessions/<label>.json` descriptors reconciled against
`git worktree list`; `src/watchers/autowave.mjs` gates top-ups on that count, never on folders.

### ⛔ `git worktree remove --force` deregisters but often does not delete

**Symptom:** the reclaimer reports success on eleven sessions; all eleven folders remain, three
gigabytes each. A retry prints `fatal: '<path>' is not a working tree` — which reads like success and
means git had already dropped the registration and simply failed to unlink the directory, because
leftover shells still held files inside it. **Cause:** the command does two things — deregister and
delete — and routinely does the first and fails the second, so a half-finished removal is neither
"done" nor "not started". **Rule:** after the removal, kill the holders (positively identified, see
*Process management*), delete the folder, then **verify the directory is gone** — never trust the git
exit code.
*In claude-fleet:* `src/watchers/reclaim.mjs` removes → kills holders → deletes → asserts the path is
absent, and `fleet down` reports any survivor by path.

### ⛔ Never run a remote-dependent git command inside a worktree you may already have deregistered

**Symptom:** the reclaim safety gate refuses to reclaim a worktree forever: "branch not on the remote".
**Cause:** once a worktree is deregistered, `git -C <it> ls-remote` fails with "the remote does not
appear to be a git repository". The gate read that failure as "branch not pushed" and refused — a
deadlock, because attempt one broke the check that authorises attempt two. **Rule:** run every remote
lookup from the **primary** checkout, never from the worktree being judged. And keep the gate's
failure direction: it refused to delete what it could not verify, so nothing was lost while the bug
was live — gates should always fail that way.
*In claude-fleet:* `src/watchers/reclaim.mjs` resolves `repo.remote` from the primary checkout for
every safety check.

### Moving a worktree breaks its `node_modules` links

**Symptom:** a worktree moved to a new parent directory builds against packages that no longer exist,
or the dev server serves a workspace package from the *old* path. **Cause:** the workspace links
inside `node_modules` are absolute — they keep pointing at the old location after the move, and
nothing re-links them. **Rule:** do not move worktrees; if one has moved, re-create the links (or make
a fresh worktree) and restart any dev server in it.
*In claude-fleet:* `repo.worktreeParent` fixes where worktrees live; `install.junctions.mode: auto`
re-derives the workspace links from `package.json` `workspaces`, and `fleet doctor --repair`
re-creates them pointing **inside** the target tree.

### ⛔ Never `git stash` — `refs/stash` is shared across every worktree

**Symptom:** a session pops someone else's work-in-progress into its tree, or its own stash vanishes.
**Cause:** `refs/stash` is a single ref shared by every worktree of the repository, so a concurrent
session's stash operation races with yours and can pop *their* WIP into your tree or silently drop
yours. **Rule:** never `git stash`, `pop`, `push` or `apply`; to set changes aside make a WIP commit on
your own branch (undo later with a soft reset), or write patch files — read-only, so a session
resumes exactly as it left off. If you find a stash that is not yours, leave it.
*In claude-fleet:* `hooks/block-git-stash.mjs` rejects the command in every session; the rule is
restated in `playbooks/session.md` and `playbooks/testing.md`.

### ⛔ A recursive delete follows workspace junctions into the primary checkout

**Symptom:** the primary checkout's workspace packages are gone after "cleaning up" a session worktree.
**Cause:** a recursive delete that follows links descended through the workspace junctions inside the
worktree's `node_modules` — which point at the primary — and deleted the targets. **Rule:** remove a
worktree with a deletion that does **not** traverse links, and only after the junctions have been
unlinked; never hand-roll it in a shell.
*In claude-fleet:* `src/core/worktree.mjs` unlinks the workspace junctions (`install.junctions.mode` /
`install.junctions.extra`) first and deletes without following links; sessions never delete
`node_modules` themselves.

### A safety hook rejects the whole invocation — re-check state afterwards, never trust the absence of an error

**Symptom:** a multi-step cleanup block "ran" with no error, and afterwards nothing it was meant to do
has happened — the folder is still there, the junctions are still linked. **Cause:** a permission
hook that objects to one token in the command text (a delete flag it reads as a system path, for
instance) rejects the **whole** invocation, not the one step, and the rejection can surface as
silence rather than as an error the script sees. **Rule:** after any multi-step block that deletes or
unlinks, re-check the state it should have produced — the path is gone, the link is gone — rather
than trusting the absence of an error; and keep destructive steps in the CLI, which asserts its own
results, instead of hand-rolled shell blocks.
*In claude-fleet:* `fleet doctor --repair`, `fleet kill` and `fleet down` assert the filesystem after
every removal; `hooks/hooks.json` is the hook set the fleet itself installs.

### Reclaiming a worktree outlasts a tool-call timeout

**Symptom:** a teardown loop is killed at the tool timeout with some sessions deregistered and others
not. **Cause:** a worktree is several gigabytes across thousands of packages, so a single removal
routinely exceeds the two-minute cap a tool call gets. **Rule:** fire each removal detached and verify
afterwards with `git worktree list` and a filesystem check, rather than waiting on it.
*In claude-fleet:* `fleet kill` and `fleet down` run removals as detached children and re-query the
registry after; `--dry-run` prints the plan first.

### ⛔ A reboot after a hard freeze NUL-pads mid-write files, and every green signal lies afterwards

**Symptom:** after a hard reset every git command fails with "bad config line 1"; a worktree's index
is unreadable; packages are missing or NUL-padded across most worktrees — while the ready sentinel
and a full shim count still say "ready". **Cause:** files mid-write at the freeze came back as NULs,
and a follow-up install does not repair them (it sees directories and exits 0). **Rule:** after any
unclean reboot, check files by content — read a file's **last 64 bytes and look for NULs** (seconds,
where a file-count census takes minutes) — then delete `node_modules` root **and** nested, unlink the
workspace junctions first, and reinstall.
*In claude-fleet:* `fleet doctor` runs the NUL-tail probe over `install.proof.probeFiles` and the
git metadata of every registered worktree; `--repair` does the ordered delete-and-reinstall.

### The sentinel poll must anchor to the worktree root and stay under the tool timeout

**Symptom:** a session waits out its entire poll loop for a sentinel that has existed since before the
loop started. **Cause:** two independent traps. The tool shell's working directory **persists between
calls**, so a relative check for the flag silently returns false from any subdirectory a previous
command left you in. And a loop sized above the tool-call cap (600 s) can never reach its own "not
ready" verdict — it is killed and backgrounded with no output, which reads as "still installing"
forever. **Rule:** resolve the flag path from the worktree root every time, and keep one poll well
under the cap so the verdict actually prints.
*In claude-fleet:* the session reads `readyFlag` from its descriptor (`FLEET_SESSION_FILE`) as an
absolute path; `playbooks/session.md` sizes the poll at ~8 minutes per call.

### One poll is not a completion budget — installs run in paced waves

**Symptom:** a session flags "install never started" after eight minutes. **Cause:** installs run in
waves with a settle gap between them and a hold whenever free RAM is tight, so on a large fleet a
tree may not have *started* installing until half an hour in. A flag on the first "not ready" tells the
launcher something it already knows. **Rule:** on "not ready", run the same poll again; raise
`install` only after several consecutive polls (roughly fifty minutes) with no sentinel, or the
moment the install log shows an actual failure.
*In claude-fleet:* `install.concurrencyCap`, `install.settleSec`, `install.holdPollSec`,
`install.maxHoldSec`; the session's poll budget is in `playbooks/session.md`.

### ⛔ Sessions never run the install themselves

**Symptom:** a session sees no `node_modules` and runs `npm install` to "unblock itself". **Cause:** the
launcher's install for that tree may be running now, queued in a later wave, or held waiting for
free RAM — a second writer produces exactly the two-writer corruption above, which no later install
can repair. **Rule:** a missing `node_modules` is not a broken worktree; read and plan while it
installs, wait on the sentinel before the first command that needs dependencies, and if the tree
looks wrong, flag it — do not fix it.
*In claude-fleet:* `playbooks/session.md` §Dependencies; the session's window opens before its
install on purpose (see *Only a newly created worktree gets a window*).

### ⛔ A session operates only inside its own worktree — never `git worktree remove`/`prune`, never global git config, push only your own branch

**Symptom:** a sibling's worktree disappears from `git worktree list` mid-run; every session on the
machine suddenly commits under a different identity or against a changed remote; or an issue branch
turns up on the remote before its PR exists. **Cause:** the worktree registry, the global and
`--system` git config and the remote are shared by every session of the repository, so an action
that is local in a single checkout is fleet-wide here — a `prune` deregisters whatever trees another
session's shell was holding, a global config change rewrites every sibling's identity, and an early
push puts a branch on the remote that nothing is ready to review. **Rule:** operate only within your
own worktree: never `git worktree remove` or `prune` (the launcher reclaims); never change global or
`--system` git config (anything you need goes in `--local`); push only your own branch — plus the
merge of your own branch into a *testing* worktree while you hold its lock, and exactly two sanctioned
pushes that capture owns: the throwaway `vcs.captureRefTemplate` ref (force-push is fine; it is
deleted at PR time) and the `vcs.assetsBranchTemplate` screenshots branch. The issue branch itself is
never pushed before the PR step.
*In claude-fleet:* `playbooks/session.md` §Cross-session safety; `src/watchers/reclaim.mjs` is the
only thing that removes a worktree *automatically* (`fleet kill` and `fleet down` remove only on the
operator's explicit command); `fleet assets add --branch` is the sanctioned publisher for the assets
branch.

### A shell command line has a length limit, and a nested interpreter mangles quoting

**Symptom:** a clone fast path fails instantly — exit 1, zero files copied, zero seconds elapsed —
while the generated script is valid and runs fine by hand. **Cause:** two independent bugs. The chained
command exceeded the shell's command-line limit (on Windows just over 8 KB; POSIX limits are far
larger, but the second trap is identical) and was rejected before the first step ran; and a step
returned a shell-wrapped command string to a caller that already spawns through a shell, producing a
nested interpreter whose quote-stripping mangled the path. Chaining also
expands exit-code variables at *parse* time — before the step has run — so an inline exit-code guard
was silently meaningless. **Rule:** write multi-step recipes to a **script file** and return the quoted
path alone; test the code path **exactly as production invokes it** (a test that spawns differently
passes a broken launcher).
*In claude-fleet:* `src/sys/exec.mjs` writes long recipes to a script file in the state directory
and executes the path; the tests in `test/` spawn through the same helper.

### Only a newly created worktree gets a window

**Symptom:** a re-run of the launcher opens a second window onto a worktree that already has a live
session, and two agents now share one git index. **Cause:** worktrees persist on disk, terminals do
not, so a launcher cannot assume a reused worktree has a live window — and equally cannot assume it
does not. **Rule:** a window opens on **creation**, or on reuse only when that worktree's agent is
verifiably gone; a reused worktree with no `node_modules` re-queues its install but does not reopen
its window.
*In claude-fleet:* `src/core/fleet.mjs` reconciles `sessions/<label>.json` with a process snapshot
before spawning; `fleet relaunch <label>` is the only sanctioned way to open a new agent into an
existing worktree (see *Sessions*).

### Session numbering counts leftover folders, not just registered worktrees

**Symptom:** a new session is numbered into a folder that already exists — a stranded, deregistered
tree from an earlier run — and inherits its half-installed contents. **Cause:** numbering that counts
only `git worktree list` skips folders git has already forgotten. **Rule:** the next free number is the
first that has neither a registered worktree **nor** a folder on disk.
*In claude-fleet:* `repo.sessionDirTemplate` numbering in `src/core/worktree.mjs` scans both.

---

## Process management

### ⛔ Killing a collection with one call silently kills nothing

**Symptom:** a teardown prints a confident "killed", and afterwards an old wedged agent is still
running alongside a freshly relaunched one — two agents in one worktree, the git-index collision the
playbooks forbid. **Cause:** the filter returned a *collection*, so the PID property expanded to
"<pid> <pid>" (two PIDs joined by a space) and the kill utility rejected the lot; the script never
checked. **Rule:** expand the PIDs into an array, kill one per call, then **re-query and assert the
count is zero**; if an overlap may have happened, check for a stale `.git/index.lock` in that
worktree.
*In claude-fleet:* `src/sys/proc.mjs` `killTree()` kills one PID per call and re-snapshots, and
`fleet kill` fails loudly on any survivor.

### ⛔ Command-line filters self-match

**Symptom:** a count of running supervisors returns 5, then 0, then 5 across three consecutive probes
with nothing starting or stopping. **Cause:** the probe's own command line contained the literal
string being matched, so it counted itself, its shell and its children — and flipped to zero only
when the pattern happened to be built by concatenation. Wrong in both directions: a false 0 starts a
second launcher (which silently drops tickets), a false 5 stops you starting a needed one. **Rule:**
build the pattern by concatenation **and** exclude the probe's own PID plus its ancestor chain —
either measure alone is not enough, because concatenation fails the moment the real path is passed
as an argument.
*In claude-fleet:* `src/sys/proc.mjs` excludes `process.pid` and its ancestors from every match, and
the shim is matched by the exact argv token `--fleet-session=<label>`, never by a path substring.

### ⛔ Never kill by exclusion — positively identify descendants, deepest first, and re-query

**Symptom:** a teardown destroys the operator's own hand-started agent, an hour into unrelated work.
**Cause:** the teardown killed **by exclusion** — every agent process with no session-launcher ancestor
was treated as an orphan. The launcher and any human-started agent in the primary checkout *also*
have no such ancestor, so they were indistinguishable from orphans. **Rule:** only kill what is
positively identified as a descendant of a target session's own shim; leave everything unrecognised
alone; kill **deepest-first** so children are never orphaned in the first place (orphan *hunting* is
what forced the exclusion rule — removing the orphans removes the need); re-query and assert zero
survivors; and report how many agents were deliberately spared.
*In claude-fleet:* `fleet kill <label…>` walks down from `shimPid`/`agentPid`/`pgid` in the
descriptor, kills deepest-first, re-snapshots, asserts, and prints the spared count; `--dry-run`
prints the plan.

### ⛔ A tree-kill on a supervisor is not a scoped stop

**Symptom:** four sessions flag "install never started" after forty-five minutes; an audit finds
thirteen worktrees with no usable dependency tree while sessions launched later installed
perfectly. **Cause:** the autowave ran the launcher as a child, and the launcher ran the installs. A
tree-kill aimed at the autowave killed the whole tree — including an installer midway through
seventeen sessions. The fleet looked fine because worktrees are created before installs, so every
session existed while a third of them could not run anything. A tree-kill on the health watchdog
had the same shape: it had started the container runtime as its child, and took the database down
with it, so every DB-backed route fleet-wide returned 500. **Rule:** a tree-kill reaches every
descendant, including work you did not intend to interrupt. Before stopping a supervisor, check for a
running launcher and wait for it to go idle; kill a supervisor by its own PID, never its tree.
*In claude-fleet:* `src/watchers/guardian.mjs` stops helpers by PID; `src/watchers/autowave.mjs`
honours its own `busy` gate on a manual stop; the tmux backend kills the process group before the
window (the reverse order orphans grandchildren).

### ⛔ Never kill by command-line match from a script whose body contains the pattern

**Symptom:** a restart script prints "stopping 4 instance(s)" and dies with exit 1 before it reaches
the start step; the supervisor it was restarting is now at zero and the fleet drains silently.
**Cause:** the script was written to disk through a heredoc, and its body contains the literal path
being matched — so the literal also sits in the command line of the **shell writing the heredoc**,
which is the tool's own parent. The filter matched that shell and the tree-kill took it, and the tool
process, down mid-run. Concatenating the pattern does **not** save you: the match is on the target's
command line, and the literal still reaches the writing shell via the heredoc body. **Rule:**
starting is always safe; stopping is not. Resolve the exact PID first by a means that cannot match
your own tree — a pidfile, or a filter on the exact script argument **and** a parent outside your
ancestor chain — then kill that PID alone, never a tree over a match set you did not individually
verify.
*In claude-fleet:* `guardian.mjs` stops a helper by the PID it recorded when it started it, never
from a command-line search.

### After any supervisor restart, assert the count is exactly one

**Symptom:** two restarts in one hour each printed a plausible "stopping N" line and vanished, and
nothing noticed until the fleet had drained. **Cause:** "killed, never restarted" looks identical to
"restarted" unless something checks afterwards. **Rule:** after any restart of a supervisor, re-run
the health probe and confirm the count is **exactly 1** — a zero and a two are both failures.
*In claude-fleet:* `guardian.mjs` re-probes after every restart and raises `notifications.command`
on any count other than one.

### ⛔ Sessions never disable or kill the health supervisor — if something you started vanished, that is why

**Symptom:** a session's freshly started server disappears mid-capture; the session decides the
supervisor is "interfering" and stops it — and from then on nothing repairs a dead slot, reaps an
idle emulator or clears a stale lock for the whole fleet. **Cause:** the supervisor is fleet-wide: it
restarts dead testing servers, repairs services, reaps idle emulators, clears stale locks, and
tree-kills any dev server it finds inside a working worktree — that kill is the serverless rule being
enforced, not a fault. A session sees only its own worktree and cannot judge fleet-wide state.
**Rule:** never disable, stop or kill the supervisor from a session; if something you started
vanished, you were serverless and it did its job — read its status output for what it did, and flag
if a slot you need is genuinely down. Only the launcher stops a supervisor, by its own PID.
*In claude-fleet:* `src/supervisor/loop.mjs` is the supervisor and `src/watchers/guardian.mjs`
restarts it if missing; `playbooks/session.md` §Serverless and `playbooks/testing.md` §The supervisor
forbid touching it.

### ⛔ A partial-path filter matches sibling worktrees

**Symptom:** killing the holders of `session-1`'s worktree also kills sessions 10 through 19.
**Cause:** `*<repo>-session-1*` is a prefix of every two-digit sibling. **Rule:** match the **exact**
worktree path with a boundary check — a trailing separator or an end anchor — never a bare
substring.
*In claude-fleet:* `src/sys/proc.mjs` matches worktree paths with a terminating separator; the
descriptor's `worktree` field is the only source of the path.

### ⛔ Never run two launchers at once

**Symptom:** a wave lands short by several sessions and the missing tickets are simply gone.
**Cause:** both launchers read `git worktree list` at startup, so each skips the worktrees the other
has just created — and a skipped slot **silently drops its ticket**. A background launcher with no
output yet is *not* a failed launcher. **Rule:** assert the launcher count is **zero** before starting
one, by a process snapshot, never by the absence of a log.
*In claude-fleet:* `fleet up` takes a process snapshot and refuses while another launcher is alive
(`src/core/fleet.mjs`); `fleet status` reports it.

### ⛔ A launcher whose output redirect fails still runs — headless, with no log

**Symptom:** the launch command prints errors, no log file appears, the process list shows no
launcher — and thirty-four minutes later a worktree's dependency tree is corrupt. **Cause:** the
redirect flags failed to bind, the launcher started anyway with no log, and the "it never started"
conclusion rested on the missing log plus a process listing that was itself lying (next entry). It ran
alongside a second launcher, hence the corruption. **Rule:** confirm a launcher started or died from a
process snapshot filtered on the launcher's exact argument — never from a log's absence.
*In claude-fleet:* `fleet status` reports launcher liveness from the process snapshot, and the
launcher's log under `<stateDir>/logs/` is opened before anything else runs.

### ⛔ The process list can silently return zero under load

**Symptom:** the quick process listing returns nothing while telemetry shows forty-two live processes.
**Cause:** on a loaded box the cheap listing utility degrades to empty output rather than erroring.
**Rule:** never use it for a liveness decision; take one authoritative snapshot per pass (slow under
load, but honest), cache it, and reuse it for every match in that pass. On macOS the snapshot needs
the wide-output flags or arguments are truncated and matching silently misses; on Linux read the
process filesystem directly.
*In claude-fleet:* `src/sys/proc-windows.mjs` takes one CIM snapshot per pass (never the removed
legacy tool); `src/sys/proc-posix.mjs` reads `/proc` on Linux and uses wide `ps` output on macOS.

### A background helper dies with its parent's console unless both streams are redirected

**Symptom:** a watcher dies twice with an empty error stream and no log line; another will not stay up
at all — same command, same script, every time. **Cause:** a helper launched from a shell that exits
immediately inherits that shell's console handles; when the parent goes, the console is torn down
and the child dies on its next write. Redirecting only the error stream is not enough. **Rule:** start
every long-lived helper detached with **both** output streams redirected to files — and supervise it
anyway, so an unexplained death becomes a self-correcting one.
*In claude-fleet:* `src/sys/exec.mjs` `spawnDetached()` redirects both streams under
`<stateDir>/logs/`; `guardian.mjs` restarts any missing watcher.

### An empty result written through a shell pipeline may not truncate the file

**Symptom:** the autowave queue never empties; it relaunches the same two tickets six times, putting
twelve sessions on two tickets before the sessions themselves flag it. **Cause:** the queue was
rewritten by piping the remaining items to a file writer. When the batch drained the queue the
remainder was an empty collection — an empty pipeline sends no input, the writer is never invoked,
and the file is left **unchanged**. It fails only in the one case that matters, and silently. **Rule:**
never write a file that may be empty through a shell pipeline; write it from code that truncates on
empty, and test the empty case explicitly. What contained it: every duplicated session detected the
clash itself via `git worktree list`, refused to force a checkout, and flagged — sessions verifying
before acting turned a launcher bug into an inconvenience.
*In claude-fleet:* `<stateDir>/queue.txt` is written only by `src/watchers/autowave.mjs` through
`fs.writeFileSync`, and `test/` covers the empty-queue write.

### ⛔ Never run the repo-wide killer

**Symptom:** every shared dev server in the fleet dies at once, including the testing slots.
**Cause:** the repository's "stop everything" script is global — it prunes every registered dev host
on the machine, not the current worktree's. **Rule:** no session ever runs it; only the launcher's
teardown stops servers, and only by positively identified process.
*In claude-fleet:* `commands.stopAll` is recorded so `fleet down` can run it once, deliberately;
`playbooks/session.md` and `playbooks/testing.md` forbid it in every session.

---

## Dev servers

### ⛔ A dead slot answers 404, not 502 — only 2xx/3xx is up, on a 45 s probe

**Symptom:** a probe reports a testing slot "up" because the response was not a gateway error; a session
captures against it and files screenshots of a "route not found" page. **Cause:** when a dev server
never registered its route, a per-branch-host proxy serves *its own* 404 for that host —
indistinguishable from an app 404 by status code alone. And a short probe false-alarms while the
server recompiles after a merge. **Rule:** only **2xx/3xx** counts as up; a 000 or 502 means still
compiling, not dead; use a **45 s** timeout.
*In claude-fleet:* `devServer.probes[].expectStatus` defaults to `"2xx,3xx"` with `timeoutSec: 45`;
`testing.lock.probeTimeoutSec` is the same 45 s on the pool side; `src/supervisor/checks/*.mjs`.

### ⛔ A slot serving `/` 200 says nothing about its API half

**Symptom:** four sessions report "the API is dead": the root page and the login page return 200 while
every API route returns 500 — and the API process was running the whole time. **Cause:** a dev stack
can be two independent halves — the page renderer and the API worker — and either can die while the
other keeps answering, so the slot looks alive and is useless. (One instance of this was never fully
diagnosed: a clean restart with the database confirmed listening still 500'd and the env file matched
the primary byte for byte — do not repeat "the watchdog restarted it before the database came up" as
established fact.) **Rule:** probe an API route, not `/`, before declaring a slot up; a testing
session never reports ready on a 200 alone, and never silently keeps serving a half-dead slot,
because working sessions will capture against it and file false evidence.
*In claude-fleet:* `devServer.probes` is a list — add an API path with `dependsOnPrevious: true`;
`devServer.processes[]` (`{name, match, notMatch, min}`) counts each half separately;
`playbooks/testing.md` §Self-check.

### Judge by the status code, never by a proxy header — and a 404 on a non-GET route is healthy

**Symptom:** a slot is flagged broken because its responses carry the proxy's marker header, or
because an auth endpoint answers 404 to a GET. **Cause:** the proxy stamps its header on *every*
response, healthy 200s included — it is not a "no upstream" signal. And a route that exists but does
not serve that method answers 404 by design; every healthy slot does it. Only a 500 means the worker
is broken. **Rule:** read the status code; know which 404s are the healthy answer.
*In claude-fleet:* `devServer.probes[].expectNotStatus` (e.g. `[500]`) expresses "anything but 500 is
fine" for such a route; headers are never inspected.

### A server with live processes is compiling — leave it

**Symptom:** a watchdog restarts a slot that was thirty seconds from serving, and does so on every tick.
**Cause:** after a merge or a cold start a dev server can be silent for a minute while it compiles;
a probe-only judgement calls that dead. **Rule:** a slot is only really down if its host is missing
from the proxy's route list **and** it has no server processes; otherwise it is compiling — wait out
the 45 s probe.
*In claude-fleet:* `devServer.routeListCommand` supplies the route list; `devServer.processes`
supplies the process count; the supervisor restarts only on "no route **and** no process".

### ⛔ The watchdog can kill a healthy server that is still booting

**Symptom:** a testing slot is killed and restarted, repeatedly, during a large launch. **Cause:** the
"half-dead" test — API half alive, page half at zero — is *true* during early startup, before the page
child has started; and the same watchdog will keep "restarting" a slot whose worktree has **no
`node_modules` yet**, which can never succeed. **Rule:** a fault must be observed for several
consecutive ticks before it triggers a restart, and a slot with no dependency tree is not a fault at
all — during the install phase of a big launch the watchdog is a net negative, so it stands down
until every worktree is installed and every server is serving.
*In claude-fleet:* `devServer.softFaultStrikes` (default 4) is the consecutive-tick threshold; the
supervisor skips slots whose worktree lacks `install.readyFlag`.

### ⛔ The dev-server heap ratchets

**Symptom:** each testing slot's memory footprint grows for hours and never comes back; a four-slot
pool costs as much as ten working sessions by afternoon. **Cause:** the dev server's heap cap
defaulted to half of the machine's total memory, and the JS engine ratchets up without compacting, so
each slot grows for the whole session. **Rule:** cap the dev server's heap explicitly; budget slots
from the *measured* per-slot cost, not the idle one; and restart a slot to reclaim it.
*In claude-fleet:* `commands.devServer` is the place to carry an explicit heap flag; budget
`testing.count` slots at their measured cost when setting `fleet.size` / `install.reservePhysicalGb` —
the derivation itself is `clamp(1, floor((ram − install.reservePhysicalGb) / install.perInstallGb), cpus)`.

### An env file is not hot-reloaded — compare its mtime with the process start time

**Symptom:** an env value is corrected, the file is re-read to "prove" it, and every call that depends
on it still fails. **Cause:** the API half reads its env file at start; re-reading the file proves
nothing about the running process. **Rule:** decide stale-vs-reloaded by comparing the file's last-write
time against the server processes' creation time — processes older than the file are still running the
old env — and restart on a real fix.
*In claude-fleet:* `playbooks/testing.md` §Restarting; the supervisor logs process creation times in
`fleet slots`.

### A restart touches no git state — say so

**Symptom:** working sessions re-merge into a slot after its server restarts, redoing work they already
had. **Cause:** they assumed a restart reset the branch. It does not: merges already in the testing
branch survive it. **Rule:** when a testing session reports a restart, it says in the same message that
no re-merge is needed.
*In claude-fleet:* `playbooks/testing.md` §Restarting.

### If the supervisor restarted your server, carry on — never start a second one

**Symptom:** a testing session notices the supervisor restarted its server and starts "its own"
alongside; two servers now race for the slot's host, and the proxy routes to whichever registered
last. **Cause:** the supervisor restarts only a server that is *fully* gone — so a restart means
yours was dead, not that you need another. **Rule:** treat a supervisor restart as your server,
already running: carry on with the self-check, and read the supervisor's status output if you want
to know why it moved. A half-dead slot is still yours to catch, because the supervisor reacts only to
a server that is completely gone.
*In claude-fleet:* `src/supervisor/loop.mjs` restarts only on "no route **and** no process";
`playbooks/testing.md` §Self-check; `fleet slots` shows each server's process creation time.

### Fix a bad env value at the primary too — bootstrap copies it into every new worktree

**Symptom:** the same env breakage recurs every wave, in every new worktree, after it was fixed in the
one that tripped over it. **Cause:** the bootstrap copies the env file from the primary checkout
verbatim, so a wrong value there is inherited by every new worktree. **Rule:** apply an env fix at the
**primary** checkout as well as in the worktree that surfaced it.
*In claude-fleet:* `commands.bootstrap` runs against the primary's state; `playbooks/launcher.md`
§Unblocking step 2.

### A missing helper binary makes the proxy serve its own 404 — which reads as an app bug

**Symptom:** a per-branch host never comes up; the proxy answers 404 for it; the app looks broken.
**Cause:** the proxy mints a per-host TLS certificate by shelling out to a binary that was not on the
spawned window's `PATH`; it died on spawn, the host never registered, and the proxy's own 404 read as
an application error. A watchdog or launcher started from a shell without that binary fails the same
way even after the sessions are fixed. **Rule:** put required helper binaries on every spawned
process's `PATH` — sessions, watchdog and launcher alike — and probe for them before the first spawn.
*In claude-fleet:* `paths.pathPrepend` and `paths.nodeBinDirs` are applied to every spawn by
`src/session/shim.mjs`; `fleet doctor` probes `commands.devServer`'s dependencies.

### After a reboot, restore services before touching sessions — a missing database reads as an app bug

**Symptom:** after a reboot every login and provisioning call returns 500, while `/` serves 200 and an
authenticated route correctly returns 401 — so it looks like an application bug. **Cause:** the
container runtime does not auto-start, so the database container stays down and nothing listens on
its port. A session cannot see any of this from inside its worktree, and a teardown that also killed
the watchdog left nothing to self-heal. **Rule:** order after any reboot — start the container
runtime → start the containers → confirm the ports → start the supervisor → only then resume sessions.
*In claude-fleet:* `services.docker.startCommand`, `services.containers[]` with `healthHost`/
`healthPort`; `fleet doctor --repair` runs that order and `fleet up` refuses while a required
service is down.

### A database alarm can be permanent noise when the database is remote

**Symptom:** sessions flag "database down" forever; the watchdog reports the container missing on every
tick. **Cause:** when a project's dev database is remote there is no local container, so "container
does not exist" and "port refused" are expected and nothing depends on them. **Rule:** declare which
services are actually required, and never flag the ones that are not.
*In claude-fleet:* `services.docker.required: false` and an empty `services.containers` silence the
check; sessions flag category `services` only for a service the config declares.

### ⛔ Working sessions never start a local server

**Symptom:** a machine hard-powers-off with a dozen sessions each running a full dev stack. **Cause:**
one stack per session is what lags and then freezes the box past a handful of sessions; and a
session's own server serves nobody but itself. **Rule:** working sessions are serverless — not even
briefly, not even for a screenshot. Captures go through a borrowed testing slot or a cloud sandbox,
and the supervisor tree-kills any server it finds inside a working worktree so the rule is enforced,
not just documented. Never resolve a block by letting a session start its own server.
*In claude-fleet:* `devServer.serverProcessPattern` (derived from `commands.devServer`) is the
rogue-server pattern the supervisor kills inside `working` worktrees; `playbooks/session.md`
§Serverless.

### ⛔ A testing session starts its server only on its slot's branch — detached or wrong means stop

**Symptom:** a testing session boots its server from a detached HEAD or a stray branch; the proxy
registers it under the bare default host instead of the slot's per-branch host, it collides with
every other server on the machine, and working sessions capture against whichever one answered.
**Cause:** with a per-branch-host proxy the branch *is* the address — a server started off-branch
takes the shared host, and nothing tells a working session which slot it actually hit. **Rule:**
before starting, assert the current branch equals the slot's branch exactly (an empty answer is
detached HEAD — also wrong); on a mismatch stop and flag rather than start. After starting, confirm
the proxy reports the slot's own URL, not the bare host; if it reports the bare host you are on the
wrong branch — fix it and do not proceed.
*In claude-fleet:* the slot's `branch` and `testingUrl` come from the descriptor;
`playbooks/testing.md` §First action asserts both; `devServer.urlTemplate` with `{branch}` is the
per-branch host.

### ⛔ Never hand-resolve a conflict in a shared testing worktree — reset it

**Symptom:** two sessions' branches touch the same file; the slot carrying one conflicts with the
other. **Cause:** the slot is a throwaway mashup, never pushed and never merged anywhere — nobody
reviews a hand resolution there and it vanishes on the next reset. **Rule:** abort the merge,
`reset --hard` the slot to the base branch, merge **only your own branch**, and hold the lock across
reset → merge → capture → release, or another session's merge lands in between and undoes it. Check
the candidate ticket list for **file collisions before launching** — two sessions on one file collide
at capture time, not at code time.
*In claude-fleet:* `playbooks/testing.md` §Reset; `fleet intake check <KEY…>` reports overlapping
paths across a candidate set (`src/core/intake.mjs`).

### ⛔ A testing worktree is never pushed, and never opens a PR

**Symptom:** a slot's branch turns up on the remote, or a PR is opened from the testing worktree
carrying a dozen sessions' merges — and nobody can review it, because no one author owns what is in
it and half of it is already in review elsewhere. **Cause:** a slot is a disposable mashup: branches
are merged into it only so something can be captured against them, and it is `reset --hard` back to
the base branch whenever the next session takes the lock. It belongs to no ticket and its history is
thrown away. **Rule:** a testing session never pushes its branch and never opens a PR from its
worktree — not for a "useful" combined branch, not to preserve a merge that took effort. Every fix
branch it carries is pushed by the session that owns it, from that session's own worktree.
*In claude-fleet:* `playbooks/testing.md` §Reset; `testing.base` names the slot branches, and
`vcs.pr.createCommand` is run only by `working` sessions (`playbooks/session.md` §Open the PR).

### ⛔ A shared slot does not give a clean baseline — assert the diff is empty for your files

**Symptom:** a "before" screenshot already shows part of the fix. **Cause:** a testing slot is a mashup
of every branch merged into it, so another session's change to *your* screen silently corrupts your
before-shot. **Rule:** before capturing locally, assert `git -C <slot> diff <base> -- <your files>` is
**empty**; if it is not, release the slot and capture in a clean environment instead — a contaminated
before is worse than a slow one, and never paper over it on the review page.
*In claude-fleet:* `playbooks/session.md` §Capture step 6c.

### `HELD` means busy, not broken

**Symptom:** a session flags a slot as dead because the pool would not hand it out. **Cause:** another
session holds it mid-capture. **Rule:** a held slot is a queue, not a fault; only the launcher can
tell "broken" from "busy", because only it sees the whole machine — that is why blocked flags exist.
*In claude-fleet:* `fleet pool status`; the launcher's unblocking loop in `playbooks/launcher.md`
answers with "held by another session, keep retrying" rather than restarting anything.

---

## Locks

### ⛔ Lock staleness by timestamp only — the holder PID is a short-lived acquire shell

**Symptom:** two sessions hold the same testing slot at once and one captures the other's merge.
**Cause:** the PID recorded in the lock belonged to the short-lived `acquire` shell and was dead within
seconds; a lock that treated "holder process gone" as stealable handed one slot to two sessions.
**Rule:** decide staleness by the lock's **timestamp** only, refreshed by a heartbeat from the holder
while it works; a dead PID means nothing.
*In claude-fleet:* `<stateDir>/locks/<pool>/<slot>/holder.json` is a mkdir-mutex whose staleness is
`testing.lock.staleMinutes` (and `emulator.lockStaleMinutes`) from its last heartbeat, written by
`src/session/shim.mjs`; `src/sys/lock.mjs`.

### ⛔ Do not put locks in the temp directory

**Symptom:** on macOS two processes each believe they hold "the" lock. **Cause:** the temp directory
differs between a login shell and a service-spawned process on macOS, so a lock placed there is not
shared between them at all. **Rule:** lock directories live in an explicit, per-repo, per-machine state
directory — never the OS temp directory.
*In claude-fleet:* `paths.stateDir` (never `os.tmpdir()`); everything under `<stateDir>/locks/`.

### A lock that tracks the acquire child does not hold — slots get stolen mid-work

**Symptom:** a session's slot is taken from under it halfway through a capture. **Cause:** the lock's
liveness was tied to the acquiring shell rather than to the session doing the work, so it looked
abandoned the moment that shell exited. **Rule:** the lock is held by the *session*, heartbeated for as
long as it works, and released explicitly.
*In claude-fleet:* `fleet pool acquire <pool> [--wait s]` records the session label and the shim
heartbeats it; `fleet pool release <pool> <slot>`.

### `STILL BUSY` is an answer — and working sessions do not loop on it

**Symptom:** ten sessions queue on three slots, each retrying every few seconds for half an hour.
**Cause:** the old "retry until you get a slot" advice re-created exactly the queue the shared pool was
supposed to remove. **Rule:** a working session tries a local slot **once**; busy means go to the cloud
path (when configured) and carry on; `no pool` means there is no local pool at all — it is not a
`testing-slot` fault. A testing session, by contrast, waits patiently for its **own** slot before it
merges. Flag `testing-slot` only when `acquire` errors in some way that is neither of those, or after
well over fifteen minutes of genuine waiting where waiting is the design.
*In claude-fleet:* `fleet pool acquire testing` returns immediately without `--wait`; `capture.mode`
decides the fall-through; `playbooks/session.md` §Capture step 6b.

### Use the worktree, branch and URL the lock prints — never assume slot 1

**Symptom:** a session merges into slot 1 while holding slot 2, and the review link points at an app
without the fix. **Cause:** it assumed the default slot. **Rule:** `acquire` prints which slot you got;
use those values for the merge, the capture and the link you report, and remember which slot you
landed on.
*In claude-fleet:* `fleet pool acquire` prints `worktree=`, `branch=`, `url=`; the default
`FLEET_TESTING_URL` is only for the pre-merge "before".

### ⛔ Never invent a test URL — with no local pool, report the fixed "no local slot up" line

**Symptom:** a session's report ends with a plausible-looking test link that resolves to nothing, or
to a slot that never had its branch merged; the operator clicks it and reviews the wrong app.
**Cause:** a cloud sandbox has no reachable address and a session with no local pool has no slot, so
any URL such a session writes is fabricated — and a fabricated link is worse than none, because it
looks like evidence. **Rule:** the test-login line is either the URL the lock printed for the slot
carrying your merge (the default testing URL before you have merged), or, when there is no local
pool, the fixed line `Test login: no local slot up — say "pull into a slot" and one will be booted
with this branch.` Never omit the line, and never compose a URL by hand.
*In claude-fleet:* `FLEET_TESTING_URL` / `FLEET_TESTING_URLS` from the descriptor are the only URL
sources; an empty `FLEET_TESTING_URLS` (`testing.count: 0`) means the fixed line;
`playbooks/session.md` §Message format.

### The emulator pool is small — acquire before touching it, build inside the lock, never kill it

**Symptom:** two sessions' device builds collide, or a cold boot times out and the session gives up.
**Cause:** concurrent device builds collide as badly as concurrent captures, so the pool is whatever
`emulator.slots[]` declares — usually one, because a second emulator's memory cost rarely pays for
itself; and a cold boot can exceed one tool call. **Rule:** acquire the slot first and do the whole
build → install → capture inside it — one full acquire →
capture → release cycle for the before shots and another for the after, never holding the slot across
the fix itself, because the pool is small and every sibling that needs it is queued behind you;
if `acquire` times out mid-boot, run it again — it re-attaches to the slot you already hold; release
the moment you are done; never shut the emulator down yourself — the idle reaper does that, and a
warm one is fine to leave. Use it **only** for what a browser cannot show (safe-area insets, the soft
keyboard);
everything else mobile goes in a browser at a mobile viewport.
*In claude-fleet:* `emulator.slots[]`, `emulator.idleSeconds`, `emulator.lockStaleMinutes`;
`fleet pool acquire emulator` prints the serial; `src/supervisor/loop.mjs` is the single reaper,
gated by `emulator.idleSeconds`.

### ⛔ Commit-time test contention is not your bug — never `--no-verify`, never edit the hook or another test's timeout

**Symptom:** with a full fleet committing, the pre-commit hook fails a *different* timeout-marginal
test each run, with every other suite green, in a file nowhere near your diff. **Cause:** the hook runs
the entire test suite, each run capped at a couple of workers, so twenty sessions committing together
put dozens of workers on a sixteen-thread box — the largest unpaced load source in the workflow.
**Rule:** that is contention, not your bug — retry once or twice, then flag it; repeated retries add
to the load causing it. Never `--no-verify`, and never "fix" it by editing the test config, the hook or
another test's timeout. Fleet-wide, commits want a lock like the e2e and emulator pools.
*In claude-fleet:* `playbooks/session.md` §Pre-commit; the declared pools are `testing`, `emulator`,
`e2e-port` and `tracker-worklist:<KEY>` — there is **no** commit pool yet, so expect a contention
spike whenever a wave finishes together; until one exists the launcher, not the session, is what
spaces commits out.

---

## Terminal

### ⛔ Console-input injection half-delivers — the written count must be honoured

**Symptom:** a ~700-character message injected into a session arrives as 62 characters followed by
Enter, and the session acts on the fragment. **Cause:** console-input injection writes only what fits
in the target's input buffer, then the Enter submits whatever landed. The call returns the number of
records written — two per character — and the caller ignored it. **Rule:** never inject prose. Write
the real message to a file and inject a short pointer to it; **assert the returned record count
equals twice the line length** and retry on a short count.
*In claude-fleet:* `fleet send <label…> --file p` writes the file and injects the pointer;
`src/backends/windows-terminal.mjs` chunks the write and acts on the returned count, falling back to
the file pointer above roughly 500 characters.

### ⛔ A write count proves delivery to the buffer, never consumption

**Symptom:** twenty-two sessions each return a perfect "ok" for a nudge; every transcript still ends at
the error it was nudged out of, with no trace of the message. **Cause:** the count proves the
characters reached the console input buffer. A dead turn never reads the buffer. **Rule:** to prove a
nudge was *acted on*, check that the session's transcript **mtime advanced**; if the turn is dead, a
new process is the only recovery (see *Sessions*).
*In claude-fleet:* `fleet send --json` reports buffer delivery and transcript-mtime advance (within
a grace window) as two separate facts, never as one "ok".

### A multi-target send binds only its first target — one call per label

**Symptom:** "send to 1, 2, 3" reaches session 1, or reaches nobody with a "no matching sessions"
message while the listing shows them all. **Cause:** an array parameter cannot bind through a script
invocation — a comma list arrives as one mangled token, a space list binds only the first. The same
trap applies to any array-typed parameter on any script. **Rule:** loop one call per target, and verify
each landed.
*In claude-fleet:* `fleet send <label…>` takes labels as separate arguments and reports per-label
results; `fleet kill <label…>` likewise.

### A process cannot attach to a console it already owns

**Symptom:** a script that types into the launcher's own prompt returns "wrote 0 of N records" every
time and silently does nothing. **Cause:** attaching to a console the process already owns is illegal;
run detached, with its own console, the same script writes N of N. **Rule:** anything that injects
into the *current* window must be re-launched detached.
*In claude-fleet:* `fleet send` to the launcher's own label spawns detached; the result line reports
the written count.

### tmux paste-buffer has no truncation class

**Symptom:** operators porting from a console-injection backend add file-pointer workarounds to tmux
sends. **Cause:** not needed — `send-keys -l` for short text and `load-buffer` + `paste-buffer -p`
(bracketed paste) for long text deliver whole messages with no buffer limit. **Rule:** keep the
file-pointer path as the *portable* contract (it is what the playbooks assume), but do not expect a
short-count on tmux.
*In claude-fleet:* `src/backends/tmux.mjs` `send()`; `capabilities()` on both backends declares what
each can and cannot do, so a gap is logged, never a silent no-op.

### ⛔ A terminal that cannot be queried must not be *searched* — the registry is the lookup

**Symptom:** `list`, `send` and `kill` disagree about which sessions exist: one reports a session that
died an hour ago, another cannot find a session whose window is plainly open, and a kill lands on the
wrong tab. **Cause:** one backend has no query API at all — every window belongs to a single terminal
host process, so the owning PID identifies nothing — and the code compensated by searching command
lines for a path. That search self-matches (see *Process management*), matches sibling paths by
prefix, and misses anything that re-executed itself, so every operation resolved a different set.
**Rule:** identity comes from the registry — one descriptor per session, written at spawn, carrying
the backend reference, the shim PID, the agent PID and the process group. Command-line matching
survives **only** as the reconciler that rebuilds the registry after a crash or a reboot, never as the
lookup for list, send or kill; and the shim is matched by an exact argv token, never by a substring of
a path.
*In claude-fleet:* `sessions/<label>.json` (`backendRef`, `shimPid`, `agentPid`, `pgid`) is the
lookup for every backend operation; `src/core/fleet.mjs` reconciles it against one cached process
snapshot; the shim's `--fleet-session=<label>` token is matched whole.

### A detached multiplexer server outlives the launcher — adopt it, and tear it down explicitly

**Symptom:** the launcher is closed (or an SSH connection drops) and the fleet is assumed gone; a
second `fleet up` then opens a duplicate set of windows onto worktrees that already have live agents —
two agents in one worktree, the git-index collision the playbooks forbid. Or the reverse: `fleet down`
reports success while every session is still running, detached. **Cause:** a multiplexer server is a
background process that survives its client, which is a feature — closing the terminal does not kill
the fleet — but it means "no visible windows" says nothing about what is alive, in either direction.
**Rule:** reconcile at startup, always: a `fleet up` that finds an existing server **adopts** its
sessions rather than spawning beside them; teardown stops the server itself, not just the panes; and
the fleet uses its **own** dedicated server socket and config so it never shares, adopts or kills the
operator's own multiplexer sessions.
*In claude-fleet:* `terminal.tmux.session` / `terminal.tmux.socket` isolate the fleet's server;
`fleet up` reconciles and adopts, `fleet attach` re-attaches an operator who closed their terminal,
and `fleet down` stops the server after the sessions (`--dry-run` prints the plan first).

### ⛔ A title token is overwritten by the status hook — position at spawn, or re-find the window by stamping its agent's console title — and restore the status title afterwards

**Symptom:** a window-placement pass finds none of its windows: the title tokens it stamped at launch
are gone. **Cause:** the tab-title hook repaints the title with the red/green status within seconds
of any turn, so a title token survives only until the first prompt; and every session window belongs
to one terminal host process, so the owning PID identifies nothing. **Rule:** position a window at
spawn time, or find it by attaching to its agent process (resolved by walking down from its shim) and
stamping a unique title — and if you do that, **restore the status title afterwards**, because the
watcher only repaints on a *state change*, so a stamped title stays forever and the whole fleet
loses its red/green.
*In claude-fleet:* `hooks/tab-title.mjs` owns the title; `terminal.layout: pixel-grid` places at
spawn (Windows-only opt-in, `extras/windows/grid.ps1`); the tmux backend keeps state in a window
option (`@fleet_state`) rendered in one status bar — readable back, so testable.

### Retile after every wave, not once

**Symptom:** under continuous refill the new windows land on top of the old ones and stay stacked for
hours. **Cause:** an earlier rule ("arrange once at launch, never after — the operator reads the fleet
by position") assumed a fleet launched once and left alone; a top-up computes its grid over only its
own wave, so every refill overlaps the existing fleet. Under refill, windows that never move are far
worse than windows that move. **Rule:** retile after every launcher run and after a batch of reclaims —
the layout is derived from the live session set — and log how many windows were placed.
*In claude-fleet:* `src/core/layout.mjs` recomputes the layout from the registry after every launcher
run and every batch of reclaims, on both backends, and logs the count placed;
`extras/windows/retile.ps1` is the unsupported pixel-grid extra. Tiled tmux panes are unreadable past
about six sessions — read the fleet with `fleet status` and the status bar instead of by position.

### ⛔ Do not fake a rename by writing into the transcript

**Symptom:** a hand-written `summary` record in a session's transcript file breaks the next release's
transcript parser. **Cause:** the transcript format is internal to the host and changes between
releases. **Rule:** name sessions through the host's own command by typing it into the prompt; never
write into the transcript.
*In claude-fleet:* `fleet send <label> "/rename …"`; `src/watchers/stalls.mjs` only *reads*
transcripts.

### Set the theme and the effort explicitly on another machine

**Symptom:** spawned windows look uncoloured next to each other, or a whole fleet silently runs at a
lower effort. **Cause:** with no explicit theme each spawned session auto-detects and some land on the
flat palette; and the effort level has no command-line flag, so a settings wipe drops it even though
the model survives (it is passed explicitly — see *Sessions*). **Rule:** set theme and effort in the
host's settings on every machine that runs a fleet, and check them in `fleet doctor`.
*In claude-fleet:* `fleet doctor` reports the host settings it depends on.

### ⛔ The statusline must never read stdin

**Symptom:** the box slows to a crawl with dozens of orphaned helper processes — over eighty on one
run, a couple of gigabytes between them — none of which any watcher started or can account for.
**Cause:** the host invokes the statusline command on every repaint, and one that blocks reading
stdin never exits: each repaint leaks another process that lives until something kills it, and with a
fleet of sessions repainting continuously the leak compounds fleet-wide. **Rule:** a statusline
command reads its state from a file or the environment, never from stdin, and always exits — and a
sudden population of unaccounted helper processes is a leak to trace to its spawner, not load to
size around.
*In claude-fleet:* the shim writes state to the descriptor and the title hook reads it from there;
`src/supervisor/checks/*.mjs` counts orphans against the registry so an unaccounted population is
reported rather than absorbed.

---

## Sessions

### ⛔ A session that died on an API error sits behind a green "ready" tab forever

**Symptom:** a session is idle for twenty-six minutes behind a green ready tab, having swallowed both a
STOP and an ALL-CLEAR broadcast; it raised no flag and did the work. **Cause:** an API error ends the
turn. The session is not crashed, not blocked and not finished — it is waiting for input nobody will
send, and a message injected into that dead turn is consumed and lost. Nothing in the fleet times
this out. **Rule:** watch the **transcripts**, not just the flags: for each session read the newest
transcript's last **assistant** entry; an API-error flag there plus a couple of idle minutes means
stalled — inject a `continue`. **Key the dedup on the error text only** — folding the idle minutes into
the key makes it re-fire on every poll.
*In claude-fleet:* `src/watchers/stalls.mjs` (token-free on purpose — it must keep working at the
usage limit, which is exactly when API errors cluster) polls every few minutes, re-nudges the same
session no oftener than a cooldown, and logs a heartbeat every Nth clean scan so a quiet log is
distinguishable from a dead watcher; `paths.transcriptsDir`.

### ⛔ Never grep a transcript tail for an error string — read the last assistant entry's flag

**Symptom:** a tail grep for "session limit" marks five healthy sessions dead. **Cause:** the window
still contained an *earlier*, since-recovered error; and a substring grep for "API Error", "Overloaded"
or an HTTP code matches **every** session, because the seeded playbook quotes those strings, read
results carry line numbers, and base64 blobs contain any three digits. **Rule:** parse the JSONL and
read the last **assistant** entry's API-error flag. A session writing within ~45 s is alive whatever
its tail says.
*In claude-fleet:* `src/watchers/stalls.mjs` parses entries; it never substring-matches.

### Idle time is not a signal

**Symptom:** a session is killed as "hung" for being silent ten minutes; it was inside a long subagent
call and would have resumed. **Cause:** a session inside a long tool or subagent call writes nothing
for many minutes and then continues. **Rule:** a nudge is non-destructive, so the error flag alone is a
sufficient gate for a nudge. **Killing** needs the stricter rule — flag **plus** two idle samples
minutes apart **plus** no live child process.
*In claude-fleet:* `stalls.mjs` nudges on the flag; `fleet kill`/`fleet relaunch` are never
automatic.

### ⛔ After a usage-limit stall, the launcher MUST nudge — sessions do not self-recover

**Symptom:** the whole fleet hits the usage limit; after the account is switched, ten sessions are seen
writing within a minute and the operator concludes they recovered on their own. They had not — a
human had nudged them by hand. **Cause:** a session whose turn closed on the limit error has nothing
left to wake it. Earlier the same day a third of the fleet *did* self-recover — only because each had
a pending background subagent whose completion notification arrived as a fresh prompt. No pending
child, no wake-up, ever. **Rule:** when quota is restored (reset, new account, re-login), nudge
**every** stalled session; do not wait to see whether they resume; verify each nudge by transcript
mtime, not by the send's return code. And do not mistake "they are writing again" for self-recovery —
verify *you* were the cause, or you record a false rule.
*In claude-fleet:* `stalls.mjs` nudges on account change (next entry) and clears every per-session
cooldown, because they refer to a stall just handled wholesale.

### ⛔ A usage limit cannot be revived — park, and protect work with patch files

**Symptom:** a relaunched session hits the same wall in a fresh process. **Cause:** two lookalike stalls
need opposite responses. An overload or timeout is transient — the turn is dead, so relaunch the
process (worktree, branch and commits survive). A usage limit is **account-level** and nothing
bypasses it; it stops the *whole fleet*, not one session, and a fleet twice the size burns quota
about twice as fast — so the account can become the real ceiling before RAM does. **Rule:** read which
error it is; on a usage limit say so plainly and park until the reset rather than reporting motion.
While parked, protect uncommitted work with patch files (a diff plus the untracked-file list) — never
`git stash` (shared `refs/stash`); a WIP commit works but mutates the branch and can confuse the
session on resume.
*In claude-fleet:* `stalls.mjs` classifies limit vs transient from the entry text and reports
`parked` in `fleet status`; `hooks/block-git-stash.mjs`.

### ⛔ A login or account switch does not resume a parked fleet — watch the credentials file

**Symptom:** the ten-minute report prints an identical line six times — same fleet size, same queue, no
completions — and nothing is logged as wrong: no flags, all supervisors at 1, every window reading
ready. The fleet has been frozen for an hour on the old account's limit. **Cause:** a limit-blocked
session waits for input; logging in on a new account rewrites the credentials but types nothing into
any session, so they sit forever. The stall nudger *did* keep nudging, futilely, while the account
behind it was exhausted. **Rule:** watch the host's credentials file — a login rewrites it, so its
mtime changing is an exact, token-free "the account changed" signal — then broadcast `continue` to the
**whole** fleet after a short settle and clear the per-session cooldowns. Poll the credentials file
on its **own fast tick**: riding it on the transcript-scan tick cost minutes of a twenty-session
freeze, and it is one file stat. On macOS credentials live in the keychain, so a session-start hook
marker stands in for the mtime.
*In claude-fleet:* `src/watchers/stalls.mjs` polls the credentials mtime every ~15 s (honouring
`CLAUDE_CONFIG_DIR`) and uses the hook marker where there is no file.

### An unchanging status line is a candidate freeze, not stability

**Symptom:** the report looks calm. **Cause:** a frozen fleet produces the same report a healthy idle
one does. **Rule:** compare **consecutive** reports — identical fleet size **and** identical queue
**and** zero completions across two ticks means stalled, not healthy.
*In claude-fleet:* `fleet watch` diffs consecutive `fleet status --json` payloads and raises
`notifications.command` on a no-progress pair.

### ⛔ A wedged session needs a new process into the same worktree — kill the old one first, and verify

**Symptom:** a session retrying an overload error forever while its siblings work fine; a fresh worktree
would abandon its branch; the launcher refuses to reopen a window for a reused worktree. **Cause:** the
turn is dead; only a new process recovers it, and the worktree is where its state lives. **Rule:** kill
the old agent (by PID array, deepest-first, re-query), **verify it is gone**, then spawn a fresh agent
into the **same** worktree — branch, commits and untracked helpers all survive, and the seeded
resume prompt picks up. Two agents in one worktree is a git-index collision.
*In claude-fleet:* `fleet relaunch <label>` does exactly this and refuses to spawn until the old
tree is verified gone.

### ⛔ Assigned a key but the worktree is already on another branch — stop; never switch, reset or discard

**Symptom:** a session is told to work `ABC-1234`, finds its worktree on a different branch or
carrying uncommitted changes unrelated to the key, and "tidies up" by checking out the base branch —
and someone's half-finished work is gone. **Cause:** a reused worktree can be mid-work on something
else: a relaunched agent resuming an earlier ticket, a duplicate launch onto a tree another session
still owns, or a stranded tree with unreclaimed changes. From inside, the session cannot tell which,
and every one of those states belongs to someone. **Rule:** stop — do not switch branches, reset or
discard anything. Flag what you found (the branch, the changes, the key you were given) and wait for
the launcher's ruling; a WIP commit on the existing branch is the only sanctioned way to set that
work aside, and only when told to. A session that verifies before acting turns a launcher bug into an
inconvenience; one that force-checks-out turns it into lost work.
*In claude-fleet:* `playbooks/session.md` §Auto-start / Resume; `fleet flag blocked --category other
--observation <branch and changes found>`.

### ⛔ An inherited `CLAUDE_CODE_CHILD_SESSION` means NO transcript

**Symptom:** every watcher is blind to a session — no stall detection, no liveness, no dedup — and the
session itself has no readable memory of what it did. **Cause:** a session spawned from inside another
Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION` (and `CLAUDECODE`); a child session writes
**no transcript**. **Rule:** delete both variables in the environment of every spawned session, and
have the session keep its own crash-recovery note in its worktree as a second memory.
*In claude-fleet:* `src/session/shim.mjs` deletes both before exec; `playbooks/session.md` §First
action keeps the note current at every milestone.

### ⛔ Pin the model explicitly

**Symptom:** a whole fleet is silently on the wrong model mid-run. **Cause:** with no model key in the
host's settings the CLI picks its own default; a settings change or wipe moved the fleet without a
word. **Rule:** pass the model on every agent command line; never inherit it. To re-point a running
session, inject the model command into its prompt.
*In claude-fleet:* `fleet.model` (default `opus`) is always passed as `--model` by the shim;
`fleet.agent` selects the agent.

### The transcript directory is derived, verified, and falls back to a scan

**Symptom:** the stall watcher reads the wrong transcript directory after a host upgrade changed the
slug rule. **Cause:** the transcript path is a slug of the worktree path whose rule is not part of any
contract. **Rule:** compute the slug, **verify** the directory exists, else scan the transcript root for
the newest file whose entries carry the worktree as `cwd` — authoritative and version-proof — and
cache the answer in the registry.
*In claude-fleet:* `transcriptDir` in `sessions/<label>.json`, derived in `src/config/derive.mjs`
with the `cwd` scan fallback; `paths.transcriptsDir`.

### A subagent that died returned nothing — never read its silence as a null result

**Symptom:** a session builds a fix on "no such convention exists" — the finding of a survey subagent
that was in fact terminated by an API error. **Cause:** a subagent that fails or is cut off returns no
findings at all; it did not say "no matches". **Rule:** a failed or terminated subagent is re-run;
nothing is built on its silence.
*In claude-fleet:* `playbooks/session.md` §Fan out.

### ⛔ Subagents are read-only — and a session never sits idle waiting on them

**Symptom:** two writers in one worktree — a survey subagent "helpfully" applies the fix it found
while the session is editing the same file, or restarts a server it judged stale; or a session sits
for twenty minutes with nothing to show, waiting on a fan-out that had already answered. **Cause:** a
subagent shares its session's worktree, git index and slot, so one that edits, runs git, starts or
stops a server or touches the emulator is a second, unregistered writer the fleet's safety rules
cannot see — the same collision the two-agents-in-one-worktree rule exists for; and a session parked
on its subagents throws away the only thing fan-out buys. **Rule:** subagents investigate and report;
the session alone edits, runs git, captures and drives the emulator, informed by what they find.
Launch them, then get on with the next step — the fix, the capture, the review page — and fold in
what they surface when it lands.
*In claude-fleet:* `playbooks/session.md` §Fan out.

### A session cannot see another session's state — verify liveness before reassigning

**Symptom:** a flag asserts the owning session "died at its usage limit" and proposes taking over its
ticket; that session was active eighty seconds earlier. **Cause:** a session can only see its own
worktree; it guesses about siblings and guesses wrong. **Rule:** the launcher verifies liveness from
the transcript before reassigning anything; sessions report, they do not adjudicate.
*In claude-fleet:* `playbooks/launcher.md` §Unblocking; `fleet status` is the only liveness source.

### A gate that can never be satisfied must resolve or abandon — never loop

**Symptom:** a finished session sits open for hours doing nothing; the reclaim log shows the same three
lines every fifteen seconds. **Cause:** two gates contradicted each other on one session — gate two
accepted the `cancelled` flag ("nothing to preserve"), gate three refused to reclaim because a tracked
file was modified. Both conditions were permanent, so the watcher never satisfied both and never gave
up. The session was finished; the *reclaimer* was the thing that was stuck. **Rule:** a gate that can
never be satisfied either resolves the blocker (save the diff as a patch and proceed) or abandons the
item with a loud log line — never retries forever. Diagnostic: when a session "looks stuck doing
nothing", read the reclaim log for a repeating skip line *before* assuming the session is hung.
*In claude-fleet:* `src/watchers/reclaim.mjs` saves a patch under `<stateDir>/` on a `cancelled`
flag with local changes and proceeds; every skip is logged with a reason.

### Clearing a flag throws away the record of *why* a session stood down

**Symptom:** a session concludes its ticket needs no work, flags, and is reclaimed — and the ticket
stays open, ready to be re-queued to another session. **Cause:** the flag body was the entire report,
and the reclaimer's last act deleted it; the finding existed for fifteen seconds. **Rule:** the flag is
persisted (with its evidence) before it is cleared, reconciled against the tracker, and marked
reconciled so it is not handled twice. And the two cancel reasons need **opposite** actions: "already
fixed on the base branch" → cancel the ticket (op-9) with `file:line` proof; "duplicate — another
session shipped it" → the ticket is legitimately in review, **leave it open** (op-10), because
cancelling it would close live work.
*In claude-fleet:* `done-<label>.json` carries `outcome: cancelled | duplicate | no-code-change` plus
`reason` and `evidence: ["path:line"]`; the launcher applies op-9 or op-10 and records the result in
`tracker-outbox/applied/`.

### Sessions do not ask questions — nobody is reading

**Symptom:** a session stops with "which of these two approaches do you want?" and sits for an hour.
**Cause:** nobody is reading its window; the launcher only reads flags, so a question in the output is
a session that stopped for no reason. **Rule:** the ticket is the specification — decide and ship: the
smaller approach; no adjacent fixes (mention them in one line in the PR body); a moved file is fixed
at its new location and noted; copy matches the surrounding voice. A flag is only for infrastructure
you cannot fix from inside your worktree, never a question channel. If genuinely blocked on the code,
open the **draft** PR with what you have, state the open question in one line in its body, and flag
`done`.
*In claude-fleet:* `playbooks/session.md` §Do not ask; `fleet flag done --outcome pr-pushed`.

### "There is nothing to do" is a real outcome — report it, do not just stop

**Symptom:** a session goes quiet without a flag; it looks identical to a crashed one and is left
running. **Cause:** it found the defect already fixed, or shipped by a sibling, and stopped without
saying so. **Rule:** write the done flag with the right outcome and the proof — `file:line` for "fixed
on the base branch", the PR for "duplicate" — then stop. Do not open an empty PR, and do not "improve"
the existing fix you found.
*In claude-fleet:* `fleet flag done --outcome cancelled|duplicate --evidence path:line --reason …`.

### Sessions announce themselves — the flag is the return channel, inference is the fallback

**Symptom:** a launcher polls for finished sessions and reclaims them eleven minutes late, or infers
"finished" from a PR lookup and reclaims one that legitimately has no PR. **Cause:** a done flag is the
session asserting it is finished — it authorises immediate teardown with no waiting period. Inference
is the fallback for a session that crashed before flagging: detached, clean, and a reflog that shows
the post-push move back to the base branch. A PR lookup is unreliable both ways (an empty head filter
lists everything; a real PR has gone unlisted), and a finished session may have **no PR and no
branch** by design. A session's own notes file is not a signal either — sessions report deleting it
and keep it. **Rule:** watch the flags on a fast tick, and have the watcher forget a flag once its file is
gone so a reused label can flag again — a watcher that remembers handled flags by label silently
ignores the next session to wear it; use the reflog inference with a two-strike delay only for
crashed sessions; and never recycle a session that is still installing — a fresh worktree is
detached, clean and branch-less until its install finishes, which under wave pacing can be most of an
hour.
*In claude-fleet:* `flags/done-<label>.json` (+ `.txt` twin for tailing) is the return channel;
`src/watchers/reclaim.mjs` implements the fallback arms.

### The target can never be reached without overshoot

**Symptom:** the fleet sits at 13–17 for hours with a healthy autowave, a full queue and 20 as the
target. Nothing is broken. **Cause:** arithmetic. A launcher run takes tens of minutes (install-paced)
and the autowave's busy gate blocks all top-up for that window, while sessions complete at eight or
nine an hour — so several are reclaimed *during* every wave and launching exactly `target − live`
lands short every time. **Rule:** aim past the target by the expected attrition, under a hard ceiling
so a lull in completions cannot compound into a memory problem, and **log the arithmetic** so a short
wave is visible instead of looking like a stalled autowave.
*In claude-fleet:* `fleet.size` and `fleet.hardCeiling` (default `size+2`) in
`src/watchers/autowave.mjs`, which logs `live/target/overshoot/ceiling → launching N`.

### Session creation rate is the real ceiling — clone, do not install

**Symptom:** the same plateau, with overshoot correct. **Cause:** one level deeper: a full install
extracts thousands of packages and takes tens of minutes per wave under fleet load, the autowave
cannot launch while a launcher runs (correctly — two launchers drop tickets), and completions outrun
creation. **Rule:** clone a prepared dependency tree instead of installing — a local file copy is a
hundred times faster and far gentler on the IO subsystem — gated on the exact lockfile hash.
*In claude-fleet:* `install.donor.*` (see *Worktrees & installs*).

### The queue comes from one selector — filtering anywhere else reads as "exhausted"

**Symptom:** the fleet drains from twenty to three and the queue is declared empty with "about eight
tickets left". **Cause:** the search ran against the general backlog, then narrowed by label and path
until almost nothing survived; the fleet's actual source was a single group with an assignee and a
state, which returned seventy. **Rule:** the queue is the configured selector and nowhere else —
never label-match the general backlog, never filter by date; exclude the sweep's own meta-ticket. An
empty queue is a **task**, not a question to escalate, and a stopped autowave is invisible — the
fleet just drains — so restarting it is part of any fix that stopped it. Plan the next queue source
before the current one empties.
*In claude-fleet:* `fleet.queue.selector` and `fleet.queue.source` drive op-12 `listQueue`;
`autowave.mjs` logs `QUEUE EMPTY` and idles rather than launching junk.

### ⛔ Never broadcast a cherry-pick of a file on a review-gated path

**Symptom:** every PR in a wave is bounced to a human reviewer as security-sensitive, although each is
a one-line UI fix. **Cause:** to get past a flaky pre-commit test, one constant was changed in a test
file under a security-gated directory and cherry-picked into every branch. The approval bot routes on
**file path**, not content; the path was enough. **Rule:** before broadcasting any cherry-pick, check
its paths against the review routing; the same fix in the test config would have had no impact.
Recovery: rebuild each branch from the base branch cherry-picking only the session's own commits,
then force-push with lease — which also re-triggers the bot on a clean diff.
*In claude-fleet:* `vcs.sensitivePaths` is checked by `fleet intake check` and warned on by sessions
before push; `checker.routing[]` encodes path-based reviewer routing for filed tickets.

### ⛔ Dev-mode-only bugs pass e2e — a framework's development mode may double-invoke effects; smoke new UI on a dev server before calling it verified

**Symptom:** a UI change passes every end-to-end test and breaks in development. **Cause:** the e2e
suite drives a production build, where the framework does not double-invoke effects; a bug that only
appears under development-mode double invocation is invisible to it. **Rule:** smoke new UI on a dev
server before calling it verified — what the double invoke exposes is a real defect to fix, never
something to paper over.
*In claude-fleet:* `playbooks/session.md` §Capture requires the after-shot from a dev-mode server
(slot or sandbox), never from a production build alone.

### ⛔ The review page is the review artefact — no PR opens until it exists and renders, and it survives teardown outside any worktree

**Symptom:** twenty-two review pages are requested for review and every one has already been deleted by
the session's own cleanup step; all are rebuilt from scratch. Or a PR is pushed "with the page to
follow" and is unreviewable for the rest of the run. **Cause:** the page was treated as scratch. It
is what the PR is reviewed *with*, and the review is what the whole run exists for. **Rule:** the page
lives **outside every worktree** so neither the session's cleanup nor the fleet teardown can touch
it, at the stable path `paths.artifactsDir` resolves to, so its link stays valid after teardown; it is
never committed to the PR branch; and it is a **hard gate** on the PR — before running the PR-create
command, assert all four: the page
**exists** on disk; you **opened it** and every image rendered; its evidence **matches the fix type**
(pixels for visual, an accessibility-tree diff for semantic — two byte-identical PNGs are not evidence
for an accessibility fix); and it is **published** on the assets branch as the portable backup, while
the link a reviewer opens is the `paths.artifactsDir` copy that actually renders its images. If any of
the four fails, fix it before pushing; if the page truly cannot be built (missing captures,
blocked tooling), do **not** push the PR — write a blocked flag saying what is missing. Pushing first
and "adding the page later" is exactly what this rule forbids. The page is built **every time**, with
or without screenshots: a ticket with no screenshotable UI skips the capture entirely — no worker, no
capture ref — and still gets its page with the plain-English problem-and-fix summary.
*In claude-fleet:* `paths.artifactsDir` (default `<stateDir>/dev-pages`) is an **error** if it
resolves inside any worktree; `fleet assets add <file…> --branch <name>` publishes the portable copy
on the `vcs.assetsBranchTemplate` branch; `playbooks/session.md` §Closing out gates
`vcs.pr.createCommand` on the page, and `fleet flag blocked` carries what is missing.

### Images must be local files — and verified to render

**Symptom:** the operator sees all of the prose and none of the images, with no broken-image glyph and
no gap; every check the session ran passed. **Cause:** inline base64 images render in a browser and
are silently dropped by the operator's viewer; and a raw-blob URL into a private repository renders as
a broken image in any unauthenticated browser. **Rule:** write captures as sibling PNG files and
reference them relatively; before reporting, load the page and assert every image is complete with a
non-zero width **and** that the image count equals what you expect — a page with zero images passes
"no broken images" trivially. Best: the generator refuses to write the page unless every capture file
exists.
*In claude-fleet:* `playbooks/session.md` §Dev page; the page generator in the playbook asserts file
existence.

### Self-contained means no network dependencies — not assets inlined into the HTML

**Symptom:** a page that rendered perfectly the day it was written opens later with unstyled text, a
missing icon font or an empty panel — or renders that way on the first machine that opens it without
a network. **Cause:** "self-contained" was read as "inline everything into the page", which is the
opposite of the requirement (and inlining images is its own trap — see the previous entry). What
breaks a page is a **remote** dependency: a stylesheet, a font or a script fetched from a CDN at read
time, long after the worktree that built the page is gone. **Rule:** the review page has no network
dependencies at all — no CDN stylesheet, font or script, no hotlinked asset — so it still renders
offline and after teardown, from its own file plus its sibling capture files. Any styling it needs is
in the page.
*In claude-fleet:* `paths.artifactsDir` holds the page and its sibling images, outside every
worktree; `playbooks/session.md` §Dev page.

### The review page is always rendered dark — set the colours explicitly

**Symptom:** the same page reads dark for the session that built it and glaring white for the
operator who opens it, or flips between the two on one machine; text picked to read on one of those
backgrounds is unreadable on the other. **Cause:** a page with no colours of its own inherits
`prefers-color-scheme` and whatever the reader's viewer defaults to, so its appearance is a property
of the reader rather than of the artefact — and the artefact is evidence. **Rule:** put an explicit
dark background and light text on the page itself; never rely on `prefers-color-scheme` or the
browser default, and check the rendered page rather than assuming the stylesheet won.
*In claude-fleet:* `playbooks/session.md` §Dev page specifies the explicit palette the generator
emits.

### End every message with a TL;DR and the two fixed lines

**Symptom:** the operator reads a long, accurate report and still cannot tell in one pass whether
anything is ready to look at — then cannot find the running app or the review page at all, so
finished work sits unreviewed. **Cause:** a session's window is read for seconds, between many
others; a verdict buried in the middle of a report and artefacts that are named but not linked cost
the operator exactly the time the fleet exists to save. **Rule:** end **every** message with a short
TL;DR, then the two lines **Test login** and **Dev page**, both formatted as markdown links — the
test-login line exactly as *Never invent a test URL* defines it (including the fixed no-local-slot
line), the dev-page line pointing at the page under `paths.artifactsDir`. Never drop either line,
even when nothing has changed since the last message.
*In claude-fleet:* `playbooks/session.md` §Message format; `FLEET_TESTING_URL` /
`FLEET_TESTING_URLS` and `paths.artifactsDir` from the descriptor are the only sources for the two
links.

### ⛔ Never check the orphan assets branch out — read files from it with `git show <ref>:<path>`

**Symptom:** a session checks the assets branch out to pull a screenshot into its review page, and its
worktree is now on an orphan history — every tracked file reads as deleted, the fix branch is gone
from `HEAD`, and the reclaimer sees abandoned work. **Cause:** the assets branch is an orphan with no
ancestor in common with the base branch, so checking it out replaces the whole working tree rather
than switching a few files. **Rule:** never check it out; read a file from it with
`git show <remote>/<assets-branch>:<path> > <file>` (byte-safe), and publish to it only through the
fleet's own command.
*In claude-fleet:* `fleet assets add <file…> --branch <name>` writes the branch without touching the
working tree; `vcs.assetsBranchTemplate`.

### Verify every capture exists at a plausible, distinct size — identical byte-sizes are a blank-capture tell

**Symptom:** six "different" screens all weigh exactly the same number of bytes, or a before/after
pair is byte-identical and the fix is judged a no-op. **Cause:** a capture that failed silently — a
blank page, an unrendered route, a login that never landed — still writes a file, and a blank image
is the same bytes every time. **Rule:** before calling a capture done, verify every expected file
exists with a plausible size and that sizes across shots that should differ are distinct; identical
byte-sizes across "different" shots mean the capture is blank, not that nothing changed — re-capture,
do not report. The one legitimate identical pair is the accessibility case in the next entry, and it
is labelled as such.
*In claude-fleet:* `playbooks/session.md` §Capture; `playbooks/cloud-capture.md` §Deliver.

### ⛔ An accessibility fix produces byte-identical before/after PNGs — pick the evidence type from the fix

**Symptom:** byte-comparing every pair on twenty-two review pages finds two whose shots are identical
throughout — both accessible-name or focus fixes. **Cause:** an accessible name, a focus target, a live
region — none changes a pixel, so two identical images invite the reader to conclude nothing
happened. **Rule:** pixels for visual and layout fixes; an accessibility-tree text diff for semantic
ones, with any screenshot labelled "visually unchanged by design". Paste real output only — if you
cannot produce it, say so in one line rather than inventing it. An identical pair *within* a mixed set
is usually a deliberate control shot proving an unaffected viewport did not regress — label it so a
reviewer can tell it from a failed capture.
*In claude-fleet:* `playbooks/session.md` §Evidence; `checker.screenshots: when-ui` for the checker.

### ⛔ Never fabricate a capture — and "blocked" means you probed it right now

**Symptom:** a review page with a placeholder, a mock-up, or a "pending" image; or a capture declared
blocked on the strength of an open ticket. **Cause:** inventing a screenshot is worse than having none;
and tickets stay open long after the cause is gone, so a ticket, a known-issue note, a sibling's report
or a launcher ruling is not evidence anything is still broken. **Rule:** screenshots are real captures
from the live app or nothing — stop and report the blocker instead of shipping a partial page. The test
for "blocked" is the symptom, not the mechanism: make the thing happen and look; if it fails, flag it
with what you ran and what came back, not a ticket number. The best proof a capture hit a live API is
that the page rendered real seeded data — and a feature that renders an empty successful turn with no
error banner has proved nothing.
*In claude-fleet:* `playbooks/session.md` §Real captures only; `fleet flag blocked --observation
<what you ran and saw>`.

### Never mix a local shot with a cloud one

**Symptom:** a before/after pair differs in fonts and rendering as well as in the fix. **Cause:** the two
phases were captured in different environments. **Rule:** both phases from the same environment — the
same sandbox or the same slot — never one of each.
*In claude-fleet:* `playbooks/session.md` §Capture step 7; `playbooks/cloud-capture.md` runs both
phases in one worker.

### Fire teardown on the transition, not the state — and check the primary is clean first

**Symptom:** an unguarded "zero working sessions → tear everything down" rule re-runs the full
teardown on every tick after the first, or hard-resets the operator's own uncommitted work in the
primary checkout. **Cause:** zero working sessions stays true forever once it is true; and a full
teardown resets the primary to the base branch. **Rule:** teardown fires on the **transition** to zero
and only while there is still something fleet-related to tear down; it stops and says so if the
primary checkout is dirty (that is the operator's work, not session scratch) or if any done- or
blocked-flag is still un-actioned. An empty folder held open as some shell's working directory is
cosmetic — it holds no disk and is not a registered worktree.
*In claude-fleet:* `fleet down` runs the four checks and `--dry-run` prints them; `autowave.mjs`
triggers it on the transition only.

---

## Tracker

### ⛔ An oversized write echoes as an error but applied — re-fetch, never blind retry

**Symptom:** a body update returns a tool error about response size; the operator retries; the ticket
now has the edit applied twice, or the second write clobbers a concurrent change. **Cause:** the
tracker applied the write and then failed to *echo* the (large) result back — the error is about the
response, not the request. **Rule:** on any error from a write, **re-fetch** the ticket (op-2) and diff
before deciding whether to retry; prefer targeted find/replace edits over full-body rewrites, so a
duplicated apply is idempotent.
*In claude-fleet:* `src/trackers/outbox.mjs` re-fetches before any retry; op-15 `patchBody` with
`edits:[{find, replace}]` is used wherever the adapter declares `capabilities.atomicPatch`.

### ⛔ Truncating a title mid-key autolinks to the wrong issue

**Symptom:** a filed ticket's title ends in `ABC-12…` and the tracker autolinks it to `ABC-12`, a real
and unrelated ticket. **Cause:** text was truncated at a character offset that fell inside an issue
key. **Rule:** never truncate text at a character offset; shorten at a word boundary and never inside
a key, URL or code span.
*In claude-fleet:* contract §8 rule 8; the title builder in `src/check/findings.mjs` trims at word
boundaries and rejects a trailing partial key.

### A per-workspace link rate limit is contention — defer, do not retry

**Symptom:** attaching PR links to filed tickets starts failing with a rate-limit error during a wave,
and a retry loop makes it worse. **Cause:** link attachment is rate-limited per workspace, and a
dozen workers filing at once share that budget. **Rule:** treat the limit as contention: queue the
attachment and let the launcher drain it later, in order, with backoff; never retry inline.
*In claude-fleet:* op-8 `attachLink` failures are written to `tracker-outbox/` and drained by the
launcher; `checker.attachStrategy` picks native links, an assets branch or attachments per adapter;
`src/check/attach.mjs`.

### Markdown PR links auto-convert, so text matching under-counts

**Symptom:** a reconciliation pass reports fewer ticked work items than exist. **Cause:** the tracker
converts a markdown PR link into its own rich link object, so the rendered body no longer contains the
markdown text the matcher was looking for. **Rule:** match on the URL or key from the tracker's *raw*
representation, never on rendered text.
*In claude-fleet:* op-26 `readWorkItems` returns `raw`; `fleet check reconcile tracker --pages`
(`src/check/reconcile.mjs`) matches on `pr` and `keys[]`; op-27 `tickWorkItem` is launcher-only,
always.

### Tracker tools can race a fleet-launch burst — cache the ticket before spawning

**Symptom:** a session's tracker tools are not registered when it starts and it stalls on reading its
own ticket. **Cause:** tool registration can race a burst of simultaneous launches. **Rule:** the
launcher writes every assigned ticket's full text to a cache before spawning, and the session reads
that; it flags `tracker` only if the cache is missing too.
*In claude-fleet:* `fleet ticket cache --issue K --from-json -` → `<stateDir>/tickets/<KEY>.md`,
named in the descriptor as `ticketFile`; `fleet ticket show <KEY>`.

### When a session's tracker connection drops, the launcher applies the op — and verifies it landed

**Symptom:** the tracker tool set disconnects mid-close-out for four sessions in one run; each can only
flag and wait. **Cause:** a session has no fallback credential. **Rule:** the session queues the exact
operation; the launcher, which has its own access, applies it — and **verifies** the state actually
changed, because one session reported "cancelled" while the ticket was still in progress.
*In claude-fleet:* `fleet outbox add --op <op> --key <KEY> --args <json>`; the launcher drains with
`fleet outbox list|ack <id> --result <json>` after re-reading with op-2; `tracker.mode: manual`
routes every op through the outbox when there is no tool connection at all.

### ⛔ Never paraphrase a cancellation rationale — comment first, verbatim, then change state

**Symptom:** a ticket is cancelled with a launcher's summary of why; the evidence the session gathered
is gone. **Cause:** the reason *is* the evidence. **Rule:** the session writes the exact comment text;
the launcher applies op-9 `cancel(key, reason)` with that text as `reason` — the adapter comments
first, then changes state (or op-11 followed by op-5 with `resolveState(scope, cancelled)`) — in that
order, so a failed state change never leaves a silent cancellation, and a failed comment never leaves
an unexplained one.
*In claude-fleet:* `fleet outbox add --verbatim`; op-9 and op-24 are defined as comment FIRST.

### Resolve children first — never work the parent

**Symptom:** two sessions work the same parent ticket while its sub-tickets sit untouched. **Cause:** a
parent passed on the command line was worked directly instead of expanded. **Rule:** resolve every
passed key's children (op-1) in the given order, flatten, and launch one session per resolved key;
a parent is never worked directly, and a session works **only** its assigned key — never the parent,
never a sibling.
*In claude-fleet:* `fleet up --issues A,B` expands through op-1 in `src/core/intake.mjs`;
`fleet up --add k --issues A,B` asserts the resolved count equals `k` and exits 1 on mismatch rather than
opening a session with no ticket.

### ⛔ Drafting a PR that has an approval dismisses it

**Symptom:** an approved PR is converted to draft to hold it; the approval is dismissed and the
re-review does not restore it, with no push in between. **Cause:** a draft round-trip dismisses live
approvals even where a force-push does not. **Rule:** never draft or undraft a PR that has earned an
approval; every fleet PR *starts* as a draft and the operator promotes it after review.
*In claude-fleet:* `vcs.pr.draft: true` by default; `playbooks/session.md` §Open the PR forbids
`ready --undo` on anything.

### Mergeability reads unknown briefly after a merge — poll

**Symptom:** a merge sweep acts on a stale mergeability read and fails, or merges something it should
not. **Cause:** after each merge the forge recomputes mergeability for the rest; the field reads
`UNKNOWN` for a few seconds. **Rule:** poll until it resolves, never act on the stale read. And know
the branch protection: with no required checks, red CI does not block merge and an approved PR reads
"unstable", not "blocked".
*In claude-fleet:* `src/check/gh.mjs` polls mergeability; `playbooks/launcher.md` §Merge mechanics.

### Path-based review routing classifies on paths, not content — and can be non-deterministic

**Symptom:** the same trivial test file is a low-risk chore on one PR and out-of-clearance on another.
**Cause:** the approval bot fires on two events (ready-for-review and push), routes on file path, and
its verdict on a borderline file is a coin flip; there is nothing repo-side to invoke it. **Rule:** fix
the classification (keep gated paths out of the diff) rather than re-rolling the verdict; drop any
cherry-pick that was only there to pass a hook before pushing.
*In claude-fleet:* `vcs.sensitivePaths`; `playbooks/session.md` §Open the PR step 3.

---

## Cloud workers

### ⛔ A permission prompt parks a worker forever, with no failure artefact

**Symptom:** several workers sit thirty to forty-five minutes with no result branch and no failure
file — indistinguishable from a crash — and the environment is declared dead. **Cause:** the workers
were parked on "allow this action?" prompts; the sandbox's web UI showed them as needing input, and
approving resumed them instantly. **Rule:** forbid the actions that prompt — above all reading
sensitive paths — in the worker's brief, and have the dispatcher poll the web UI for "needs input"
rather than inferring death from silence.
*In claude-fleet:* `vcs.sensitivePaths` (workers never read these); `src/cloud/dispatch.mjs` polls
worker state; blocked category `cloud-env` with `--evidence-url` carrying the worker's URL.

### 0-of-N delivered is the environment; about 1-in-8 silent is a worker

**Symptom:** a session flags that its cloud capture produced nothing after seventy minutes. **Cause:**
two different things look the same from one session. A broken token, allowlist or env config kills
**every** worker identically; a per-worker death (roughly one in eight, no result and no failure
file) leaves its siblings delivering. **Rule:** one command settles it — count delivered result
branches against dispatched capture refs. If most landed, the outliers are their own specs:
re-dispatch once on a **new ref**, and two silences on one spec means suspect the spec. If none
landed, stop reading specs — it is the environment; fall back to a local slot and take **both** phases
there.
*In claude-fleet:* `fleet cloud dispatch` records dispatched refs; `fleet check status` shows the
delivered/dispatched ratio; `vcs.captureRefTemplate` / `vcs.assetsBranchTemplate`.

### ⛔ Re-dispatch on a NEW ref — a force-pushed ref re-shoots the old commit

**Symptom:** a corrected spec is force-pushed to the same capture ref and re-dispatched; the second
worker's manifest names the pre-correction commit and its after-shots are byte-identical to run one's.
**Cause:** a fresh worker does not reliably see a force-pushed ref; a brand-new ref name cannot collide
with cached state. **Rule:** every re-dispatch uses a new ref name (e.g. `capture/ABC-1234-v2`), never
a force-push of the existing one.
*In claude-fleet:* `fleet cloud dispatch --ref <branch>` takes the ref explicitly;
`playbooks/cloud-capture.md`.

### Poll for a *different* tip, not for existence — and pin the sha you collected

**Symptom:** a re-dispatch "delivers" instantly and the session collects the previous run's shots; or a
PR embeds images by branch name and a late worker pushes again four seconds before the PR opens.
**Cause:** polling for the result branch's existence returns immediately on any re-dispatch; a branch
name is a moving target. **Rule:** snapshot the result branch's tip **before** dispatching and poll for
a different tip; pin the collected commit and embed by that sha, never by branch name.
*In claude-fleet:* `playbooks/cloud-capture.md` §Collect; `fleet assets add` records the sha it
pushed.

### ⛔ Assert the manifest's after-commit equals the sha you pushed

**Symptom:** a before/after pair that is silently both "before". **Cause:** the worker checked out a
different commit than the session believed. **Rule:** hard-fail the collection if the manifest is
missing (a differently-named file does not count), its status is missing or not `ok` (a missing
status is not `ok`), its after-commit differs from the sha you pushed, or its blocked-host list names
a host your screen needs; raise `cloud-env` instead of proceeding.
*In claude-fleet:* `playbooks/cloud-capture.md` §Collect hard-fail list.

### The sandbox database is empty, and one spec runs on both sides of the fix

**Symptom:** a cloud capture returns a pristine onboarding screen, an empty list or a "not found" —
in both phases — and the session reads it as a broken environment; or the after-shot is fine and the
before-shot is a selector timeout, because the fix renamed the element the spec targets. **Cause:**
the sandbox boots a throwaway local database with nothing in it, not the shared data a local slot
sees, so everything the screen must show has to be seeded by the spec's seed step or created through
the UI (an empty account may latch an onboarding gate — seed enough to get past it); and the worker
runs the **same** spec twice, once on the clean base branch and once on the fix branch, so a selector
or URL that exists on only one side fails the other phase. **Rule:** ship a seed with the spec that
puts every needed row in place; keep selectors and URLs valid on both sides of the fix, and if the fix
renames what you target ship a `before` spec and an `after` spec instead of one; capture exactly the
real app — never a mock, a reproduction harness or a rebuilt fragment of the UI.
*In claude-fleet:* `capture.runner` runs the spec against `{url}`; `playbooks/cloud-capture.md`
§Capture — two phases; `playbooks/session.md` §Capture spec.

### ⛔ A directory listing is not proof an install worked

**Symptom:** the worker's own sanity check passes — the package directory count reads normal and the
scoped packages appear in the listing — while all of those directories are **empty** and the binaries
directory is empty too. **Cause:** the package manager created the directories before the fetch that
failed. **Rule:** check a file **inside** a package, the same verify-by-content rule as for local
trees; the acceptance test for a credential is the *content* of the credential-gated packages, not the
install exiting, because empty directories are exactly the failure mode.
*In claude-fleet:* `playbooks/cloud-capture.md` §Boot verifies `install.proof.probeFiles` inside the
sandbox before the first capture.

### An install quiet for twenty-plus minutes is retry-looping against a blocked host

**Symptom:** a worker never finishes its install; no exit code, no error line. **Cause:** an egress
proxy refused the connection to a registry host the project's `.npmrc` pins a scope to, and the
package manager retry-looped — tens of thousands of failed connects over twenty minutes — until
something killed it. **Rule:** every host the install needs is on the sandbox allowlist and probed
**before** the install; the worker treats an install with no output for a bounded time as failed and
writes its failure file. A 401 from a registry host is **success** for the network question
(reached — an auth challenge) and a separate failure for the credential question; do not read it as
"still blocked".
*In claude-fleet:* `capture.allowlistHosts` and `capture.requiredEnv` are asserted by
`playbooks/cloud-capture.md` §Boot before the install.

### ⛔ Environment config is per account, and "applies to new sessions" is literal

**Symptom:** after an account switch every cloud capture fails; the box still holds the credential in
its environment, so the account change "cannot be the cause". It was. Then, after the config is fixed,
three more workers fail — proof the fix did not work. It had. **Cause:** the sandbox's environment
configuration (allowlist, secrets) is stored **per account**; a switch gives you an empty default
environment. And a worker whose container was created before the save still sees the old
environment — "applies to new sessions" means exactly that. **Rule:** re-apply the canonical
environment config after **every** account switch, to the default environment (the dispatcher never
selects a named one); a post-fix failure from a pre-fix container proves nothing — re-dispatch on a new
ref and read that verdict. Prove a fix with a small verification worker that pushes a result branch
either way.
*In claude-fleet:* `capture.bootstrapScript`, `capture.requiredEnv`, `capture.allowlistHosts` are
the checklist; `fleet doctor` lists them for the operator to re-apply.

### ⛔ Secrets in untracked files never reach the sandbox — those captures are local-only

**Symptom:** a cloud worker for a feature behind a gateway token raises no tool card and captures an
empty turn; the session reads the silence as an environment fault. **Cause:** the token lives in a
file that is not tracked, so a sandbox boots with no access to it — structurally, not transiently.
**Rule:** features gated by an untracked secret are captured locally, always; do not send a session
down the cloud path for them, and do not read the resulting silence as `cloud-env`. The same holds for
device-only cases (safe-area insets, soft keyboard) — when there is no local pool, note "needs local
follow-up" on the review page and in the PR body, and move on.
*In claude-fleet:* `capture.requiredEnv` names the secrets; a spec needing one that the sandbox
cannot supply is routed local by `playbooks/session.md` §Capture step 6a.

### Dispatch by ref, never by teleporting the worktree

**Symptom:** a dispatch fails with "repository too large to teleport — set up the forge integration",
which reads like a settings problem. **Cause:** the cloud CLI uploads the working directory unless
given a ref; a large repository exceeds the limit outright, and the message points at the wrong fix.
**Rule:** always dispatch against a pushed ref: the dispatcher builds a tiny blobless stub pinned to
that ref and the sandbox checks the real tree out server-side.
*In claude-fleet:* `fleet cloud dispatch --bundle <dir> --ref <branch>` — `--ref` is required.

### ⛔ Never call the cloud CLI directly from a session — it refuses non-TTY shells; go through the dispatcher

**Symptom:** a session invokes the agent CLI's cloud mode from a tool shell and gets an immediate
refusal, or a call that hangs with nothing created — and reads it as the environment being down.
**Cause:** the cloud CLI wants a TTY, and a session's tool shell is not one. The dispatcher exists
for exactly that: it runs the CLI where a console exists, records the worker's URL and the dispatched
ref, and hands back what the session needs to poll. **Rule:** sessions dispatch only through the
dispatcher, never by invoking the cloud CLI themselves — a direct call is not a shortcut, it is a
guaranteed failure that then gets misfiled as `cloud-env`.
*In claude-fleet:* `fleet cloud dispatch --bundle <dir> --ref <branch>` (`src/cloud/dispatch.mjs`)
is the only sanctioned path; `playbooks/session.md` §Capture (cloud).

### Copy the runbook as a file and verify its size

**Symptom:** a worker reports "the runbook I was handed is cut off mid-command" and improvises the
missing steps — one skipped the migration entirely. **Cause:** the brief was retyped or echoed through
a shell and truncated. **Rule:** copy the runbook file byte-for-byte, append the parameters, and assert
the copy is at least the source's size and ends with your parameters.
*In claude-fleet:* `src/cloud/dispatch.mjs` bundles `playbooks/cloud-capture.md` from disk and
asserts the bundle size.

### ⛔ Activate the pinned runtime and assert its version before the first install — the sandbox default violates the engines pin

**Symptom:** the install dies with an engine-mismatch error that reads like a repository fault.
**Cause:** the bootstrap installed the pinned runtime version but did not put it on `PATH`; the worker
ran on the sandbox default under strict engine checking. **Rule:** every worker activates the pinned
runtime explicitly and asserts its version before the first install command — otherwise the failure
is misfiled as a repository fault and the capture never happens.
*In claude-fleet:* `capture.bootstrapScript` is the project's hook; `playbooks/cloud-capture.md`
§Boot asserts the version.

### The sandbox may lack the forge CLI

**Symptom:** a worker's final step — open a PR or comment via the forge CLI — fails and the result is
lost. **Cause:** the sandbox image does not carry the CLI, or has no credential for it. **Rule:** the
worker's return channel is a **pushed result branch** with a manifest, never the forge CLI; anything
the forge must do is bundled for the launcher to apply afterwards.
*In claude-fleet:* `fleet check gh bundle` (`src/check/gh.mjs`) prepares what the launcher applies;
`fleet cloud dispatch --bundle <dir>`.

### Exit 137 means split the work

**Symptom:** a worker dies with exit 137 and no failure file. **Cause:** the sandbox killed it for
memory; the slice was too large for the box it ran on. **Rule:** do not retry the same slice; split it
and re-dispatch the halves.
*In claude-fleet:* `fleet cloud dispatch --slice f`; `checker.waveWidth` bounds how much runs at once.

### Ramp on deliveries, not sessions

**Symptom:** a wave of twenty cloud workers is dispatched at once; most park or die together and the
cause is invisible until all have timed out. **Cause:** dispatching by count assumes the environment
is healthy; only a delivered result proves it. **Rule:** dispatch a small first wave, widen only as
result branches land, and stop widening the moment deliveries stop.
*In claude-fleet:* `checker.waveWidth: "auto"` ramps on ledger deliveries (`fleet check ledger
append <pr> <status>`); `src/cloud/dispatch.mjs`.

### Absence of evidence arrives late — re-check before generalising

**Symptom:** "no failure file anywhere" is reported for eight workers; two of them later deliver
manifests with a real failure file and the actual cause. **Cause:** the check was a sample taken at one
instant while several agents were still producing evidence. **Rule:** when many agents produce evidence
concurrently, re-check before generalising from absence — absence of evidence arrives late far more
often than it is truly absent.
*In claude-fleet:* `fleet check status` re-reads the result refs on every call rather than caching a
verdict.

---

## Memory & capacity

### ⛔ Physical RAM, not commit, is what runs out

**Symptom:** a fleet sized "to 80 % of the commit limit" is half the size the box can run; or a box
freezes with tens of gigabytes of commit headroom. **Cause:** commit is a bookkeeping ceiling; the
resource that actually runs out is physical RAM. Sizing from commit systematically halved every
estimate, and a per-session cost derived by *subtraction* blamed each worker for file cache, memory
compression, kernel pool and every small process on the box. **Rule:** size from **free physical RAM**
and the **measured** marginal cost of a session — sum the working set of its whole descendant tree,
idle and at peak — and re-measure the OS/apps floor immediately before every wave (it grew by
gigabytes over one afternoon as desktop apps and a browser grew). A configuration that has already
been observed running outranks any formula.
*In claude-fleet:* `fleet.size` derives as `clamp(1, floor((ram − install.reservePhysicalGb) /
install.perInstallGb), cpus)` in `src/config/derive.mjs`; `src/sys/memory.mjs` reports available
physical memory; `fleet doctor --json` prints the measured floor.

### ⛔ The install burst is what freezes a box — steady state is cheap

**Symptom:** eight installs at once; commit looked roomy at nearly fifty gigabytes free; the burst hit
94 % commit with under three gigabytes of physical free, and the box thrashed to a hard hang. **Cause:**
each install peaks at several gigabytes and the launcher gated only on commit headroom. Steady-state
sessions are cheap; the burst is the danger. **Rule:** installs run in **waves**, not a rolling pool —
each wave barriers on all its installs, then the box genuinely idles for a settle period so writeback
and the file cache drain (a rolling pool never has a quiet moment, and the quiet moment is the point);
free physical RAM is re-probed before **every** install and holds while tight against a run-wide
budget, then proceeds with a loud warning rather than stalling the fleet forever; a **failed probe
reads tight** and serialises to one. Wave size does **not** lower the peak write rate — only a smaller
wave does — so where the platform is fragile, lower the cap. Pacing also makes a crash *cheaper*: an
idle-time reset corrupted nothing; a mid-install one corrupted six trees.
*In claude-fleet:* `install.concurrencyCap` (env may only **lower** it), `install.perInstallGb`,
`install.reservePhysicalGb`, `install.settleSec`, `install.holdPollSec`, `install.maxHoldSec`,
`install.spawnStaggerSec`; `pacing.decide()` in `src/core/pacing.mjs` is a pure function of the
probe and config, and the freeze above is a test case in `test/`.

### ⛔ `os.freemem()` is wrong on Linux and macOS

**Symptom:** the pacing gate holds forever on Linux with plenty of memory available, or never holds on
macOS until the box is already swapping. **Cause:** on Linux `freemem` excludes reclaimable cache —
`MemAvailable` is the honest number (and the same file gives commit limit and committed bytes, a
direct commit-gate analogue); on macOS the compressor makes "free bytes" meaningless and memory
pressure level is the only honest signal. On Windows `freemem` is already the available-physical
figure, and one OS read gives commit headroom in a quarter of a second where the performance-counter
route took seconds. **Rule:** probe memory per platform, measured — never `os.freemem()` on POSIX.
*In claude-fleet:* `src/sys/memory.mjs` reads `MemAvailable`/`CommitLimit`/`Committed_AS` on Linux,
memory-pressure level on macOS, and one `Win32_OperatingSystem` read on Windows.

### Check swap before blaming RAM — and do not enlarge it hoping to scale

**Symptom:** after doubling physical RAM the fleet ceiling barely moves. **Cause:** commit limit is
physical RAM plus swap, and a system-managed swap file does not scale with installed RAM — it sat at
a fraction of physical and was provably idle (peak ever used: a megabyte). Commit, not RAM, was
throttling. **Rule:** set swap so that free physical RAM becomes the binding constraint — and then
stop: most committed memory here is genuinely resident, so extra commit converts directly into
paging, which is the thrashing that froze the box. A bigger commit limit is not freeze protection —
the freeze happened at under three gigabytes of physical free, where allocations were *succeeding*.
*In claude-fleet:* `fleet doctor` reports commit limit vs physical and warns when swap is the binding
term.

### ⛔ A box that resets at idle is not a load problem — stop re-diagnosing it as one

**Symptom:** dozens of unexpected resets over months; one at 4 % CPU with tens of gigabytes free, after
the box survived hours at 100 % CPU and hundreds of thousands of hard faults; no bugcheck code, no
hardware error records. **Cause:** platform instability (memory configuration or power delivery),
not load. Software cannot fix it; it can only stop producing the load profile. **Rule:** keep pacing —
it makes a reset *cheaper* — but do not size the fleet to prevent resets that are not load-related,
and do not re-diagnose them as memory every time. Record the refutation so the next operator does not
re-derive the same wrong answer.
*In claude-fleet:* `docs/field-notes.md` — refutations are entries, and the *not fully diagnosed*
wording is mandatory.

### Quota can become the ceiling before RAM

**Symptom:** a doubled fleet stops twice as often on the account limit. **Cause:** a fleet twice the size
burns quota about twice as fast; the account, not the machine, becomes the binding constraint.
**Rule:** size the fleet against the quota window as well as RAM, and treat a fleet-wide limit stall as
a park, not a fault (see *Sessions*).
*In claude-fleet:* `fleet.hardCeiling`; `fleet status` reports `parked` sessions and the limit text.
