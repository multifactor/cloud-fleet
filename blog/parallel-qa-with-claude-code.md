---
title: "Parallel QA with Claude Code: one worktree per agent, one ticket each"
description: "How we turned edge-case review of a merged-PR backlog into a fleet of parallel agent sessions, and why the audit gate in front of it is the part worth copying."
slug: parallel-qa-with-claude-code
reading_time: "8 min"
draft: true
---

*Draft for review. Every number below is quoted from a run log or a field note.*

## The problem, concretely

A merged pull request is a fixed bug plus the cases nobody got to. The commonest shape is the deferred twin: the PR guards one call site and leaves the identical sibling untouched, and the sibling is repeatedly on the more destructive action — a confirm dialog added to deleting one record while deleting the whole parent stays unguarded.

Finding those is not hard. Finding them across three hundred merged PRs is, for two reasons that are bookkeeping rather than intelligence.

The first attempt was one long review session fanning read-only subagents over the PRs, keeping its own list of what it had filed. Good findings, unreliable totals: checked partway through, its running tally had drifted to "275 filed" against an actual 296. The quietest failure came later, and was the worst. A final reconciliation asked the tracker for the filed set with `limit: 250` and got back exactly 250 issues; differenced against the findings queue, that page reported **338 unfiled including one Urgent** — and the Urgent was a ticket filed hours earlier, plainly visible in the project. By then the real numbers were 297 issues, 184 unfiled, 0 Urgent.

None of that is a model failure. It is what happens when the record of a long job lives in a context window the job outgrows. The fix is a ledger on disk.

Nor does the work parallelise by hand. Four terminals against one checkout give four agents one working tree and one index; they collide on `.git/index.lock` within minutes. And an early teardown that killed "every agent process with no session-launcher ancestor" destroyed the operator's own hand-started session an hour into unrelated work, because a human-started agent has no such ancestor either.

## The shape of the answer

N Claude Code sessions. One git worktree each, one ticket each, driven from whatever tracker the team already uses — five adapters ship plus a template, and "no tracker" is a supported mode.

**Why worktrees, not branches in one checkout.** A worktree is a second working tree over the same object store: its own index and `HEAD`, history paid for once. Each session gets the isolation it needs, and cross-session damage narrows to the few things git genuinely shares — which we then made rules about. `refs/stash` is repo-wide, so one session's `git stash` can pop another's work into its tree; a hook blocks it and work-in-progress is snapshotted as patch files.

**Why not containers.** They would give real isolation, and we did not take them, for two reasons. Credentials: a session is useful only because it acts with the operator's git identity, forge CLI login, tracker MCP and real dev stack. Creation cost: a fresh dependency install extracts roughly 2,700 packages and 276,000 files — about 26 minutes per wave of two under load, against 99 seconds to clone a prepared donor tree. A container that installs on start pays the first number every time; one that bakes the tree into an image is doing what the donor tree does, and pays it once at build. So the cost argument bites on a fresh install per container, not on containers — which leaves credentials as the reason that actually decided it.

Memory sets the size, and working sessions are serverless because of it: a full dev stack each lags the machine past six or seven. A small shared pool of testing slots runs the servers, and a session needing a screenshot borrows one.

## A pass, end to end

Four stages: a sweep files, an audit gates, a human promotes, the fleet works. One finding through all four.

**1. The sweep.** The review command takes PR numbers, or a tracker issue listing them; its sweep id is deterministic, so re-running resumes instead of duplicating. Each candidate passes two gates before it may be filed, plus a third that applies only when the worklist contains open PRs: does the target PR already handle it; did a later merged PR fix it (from a forge-built index of post-merge PRs and their paths, never local `git log` — a shallow clone truncates history silently and then returns "nothing"); and, for an open PR, is another open PR fixing it now. This sweep is a merged-PR backlog, so the third does not run. Ours survives the two that do, and is filed as `ABC-1234` in triage with the provenance label, `gate:pending`, a priority and a screenshot. It prescribes a fix, because reviewers always do: *reuse the shared confirm helper.*

**2. The audit.** Every finding is scored on three independent columns: **diagnosis** (`real | false_positive | already_fixed | uncertain`), **severity** (`confirmed | understated | overstated | n/a`), and **fixAxis** — whether the prescribed fix works (`verified | defective | no_op | absent | untested`). Every finding that first pass flags then goes to a second, independent worker briefed to prove it real. `untested` is what makes the fix column mandatory rather than advisory: a `real` finding whose fix nobody was briefed to test does not merely fail its own row, it ungates the entire corpus until the band is re-run with the brief. `ABC-1234` returns `real`, `confirmed`, `defective`: the destructive path never calls that helper, so following the prescription ships a no-op. The gate refuses the row until the correction is in the **body** — a "do not do this" block immediately after the prescription, where the next reader is looking, not in a comment nobody scrolls to.

**3. Promotion.** Off by default: a human moves `gate:passed` tickets to ready, which drops the triage label. Waiving the gate is a human-only flag.

**4. The fleet.** Intake admits ordinary human-filed tickets unconditionally — the gate is for machine-generated findings — and refuses a checker-filed one lacking `gate:passed` or `gate:waived`, counting and logging the refusal. The session that takes `ABC-1234` branches off `origin/main` in its own worktree and treats the prescription as a hypothesis rather than a specification: quote it verbatim, re-derive the mechanism from current code, and here, open the *caller*, not the helper. Then the corrected fix, a patched ticket body, before/after captures from a borrowed slot, a review page outside every worktree, a **draft** PR — and the done flag last, because that flag frees the worktree.

## The part worth stealing

### The gate is mandatory, not a parallel track

An implementation spec was once written for a fixer from a ticket that had not been through the gate. When the gate ran it returned `understated`, and the spec had inherited both gaps verbatim: its blast radius omitted a third site with the identical defect, and its prescribed guard did not close the write path at all. Twenty-seven such specs existed and looked like progress — progress conditional on the tickets being right about reach and remedy, the one property nothing had tested. And a spec reads as more authoritative than its source ticket, because it is formatted as instructions.

The diagnostic is the sentence worth keeping: **if you can produce a work order faster than the finding can be adversarially verified, you are producing work orders from unverified input by construction.** So the gate became a precondition, enforced by the queue in code rather than by a README.

The subtler half was our most useful measurement: **the prescribed fix is a separate axis from the diagnosis, and it fails independently of it.** We nearly skipped a whole severity band on exactly the wrong evidence. The Low band's verdict split was the *best* of the three — 33% confirmed, 51% overstated, 14% understated, 1% false positive — so by verdict quality alone, skipping was the obvious call. A nine-finding calibration draw then came back with **zero false positives and seven of nine carrying a damaging, impossible or no-op prescribed fix**; the full pass, briefed to test every fix, found roughly 45 defective in 69. The Medium band, which was not briefed, surfaced 22 in 158 incidentally — a floor, not a rate, and so not a number the two bands can be ranked on. That is the stronger point: only one band had been measured for the thing we were about to decide on. As severity drops the diagnosis gets simpler while the prescription gets more casual: the axes move in opposite directions, and only one was being measured.

### A rule learned from an incident should end up as a test

When an incident produces a rule, put the rule somewhere it can be *executed* rather than remembered — usually by pulling the decision out of the I/O, so it can be tested against a fake table instead of a live fleet.

**Lock staleness is judged by timestamp, never by "is the holder alive".** Two sessions once held the same testing slot and one captured the other's merge. The pid in the lock belonged to the short-lived shell that ran `acquire`, dead within seconds, so "holder process gone" was true of every healthy lock in the pool. Staleness is now the last heartbeat only, refreshed by the long-lived session process, and the decision functions are pure and exported so tests can drive them with a clock. A second-order bug sits in the same file: an *unreadable* holder is not stale either, because `mkdir` wins the mutex and the holder file lands a moment later. A reader in that window sees an empty directory and double-grants the slot; it reproduced on 3 of 9 CI runners.

**Never kill by exclusion.** After the teardown that took out the operator's unrelated session, process-tree reasoning moved into a pure module over a snapshot: positively identified descendants of a known root only, self and every ancestor protected, deepest-first, then re-query and assert zero survivors. Sessions match on an exact argv token, never a path substring — substring matching gave us a `session-1`/`session-10` collision, and probes that counted five supervisors, then zero, then five, because the probe's own command line contained the pattern.

**A page that returns exactly its limit is truncated by definition.** That is the "338 unfiled" failure above, and it has a twin: `gh pr view --json files` returns exactly 100 entries for a PR with 167 changed files, with no error and no truncation marker. Repairing three such PRs added 146 paths to the index the later-PR gate reads — paths it had been silently blind to. Both are enforced now, by different means, because only one of them can be asked. Tracker pages carry a completeness signal, so a reconciler refuses any page set where a page reports itself incomplete. The forge's file list carries no such signal at all, so a count of exactly 100 is treated as truncated by definition: the full list is re-fetched from the REST paginated endpoint and cross-checked against `changed_files`, and a list that is still short is an error rather than an answer. In the same spirit, the redaction rules for open-sourcing this tool are a test, so a leaked name is a failing build rather than a review comment. Its corpus is the plugin's playbooks, docs, commands and trackers, the repository's top-level Markdown — and this post, which is the honest version of the rule: a gate that exempts the most widely read and least reviewed file in the repository was written for other people's files.

## What it costs, and what it does not do

**It does not sandbox the agent.** Sessions run with permission prompts disabled and act as the operator: their git identity, forge login, tracker MCP, machine. Guard rails exist — a hook blocks `git stash`, the supervisor tree-kills the dev servers it can recognise inside a working worktree, and when it cannot derive a server pattern from your dev command it says so and kills nothing — but guard rails are not permission prompts, and the sensitive-path list is a warning, not a boundary. Run it only where you would accept an unattended engineer with your credentials.

**It does not review the code an agent writes.** PRs open as drafts and a human promotes them; the sweep half never edits code at all. The job is to make review cheap, not skippable.

**The gate reduces bad tickets without eliminating them.** A first audit pass flagged 44 findings in a 466-finding corpus; an adversarial re-check upheld 5. A 1.1% confirmed-bogus rate is much better than 9.4%, and it is not zero — sessions still refute gated tickets, which is why a session can mark one disputed and record that it refuted the prescription.

**A fleet is bounded by RAM, and then by something duller.** Size is derived, not chosen: on a 64 GB box with 8 GB reserved and 4 GB per install, `floor((64 - 8) / 4) = 14`, capped at the CPU count. For a long time the real constraint was session *creation* rate — a fleet targeting 20 sat at 13-17 for hours with everything working, because sessions complete at 8-9 an hour while a launcher wave takes 12-51 minutes. Then ticket supply became the constraint: 467 open issues yielded about 132 candidates.

## If you want to try this

`claude-fleet` is one Claude Code plugin with zero third-party runtime dependencies — Node 20 and git; tmux 3.0+ on macOS/Linux, Windows Terminal on Windows (it degrades to a plain console window without it), plus a headless mode with no window at all. The constraint is deliberate: a tool that spawns agents with permissions disabled should have its whole trusted surface as code in one repository, with no transitive supply chain underneath it.

**One caveat first, because it decides what an afternoon with this looks like.** The fleet half runs. Nineteen commands dispatch, and `up`, `status` and `down` are verified end to end against a scratch repository: worktrees created and installed, sessions spawned and registered, processes killed deepest-first, worktrees removed, leftovers swept. The sweep half is not wired. Its twelve modules are built and tested — the worklist, the ledger, the four-count reconciler, the attach-strategy chooser — but no `fleet check` verb dispatches to them, so `/fleet-check` answers `unknown command`. You can fan out a fleet today. You cannot yet run a sweep.

```
/plugin marketplace add <owner>/claude-qa-skills
/plugin install claude-fleet@claude-qa-skills
```

It configures itself on first run. The launcher opens with a status check that takes a few hundred milliseconds and never writes; if the project or the machine is unconfigured, a wizard detects the tracker from the MCP tools live in the session, ranks bootstrap and dev commands out of `package.json`, sizes the fleet with the arithmetic shown, and presents the lot as one table with a source column.

Read the README's Status section and its warning first. Then read the audit playbook, which is the part worth copying and is legible without running anything: the three columns, the two gates, and what it insists on about the fixes a finding prescribes.
