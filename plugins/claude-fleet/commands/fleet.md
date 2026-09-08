---
description: "Run the fleet playbook."
---

<!-- GENERATED from playbooks/launcher.md by scripts/render-commands.mjs — edit the playbook's `command:` front matter, then run `npm run commands:render`. A hand edit here is overwritten and fails test/generated-files.test.mjs. -->

# /fleet

**Before anything else:** Run `fleet config status --json` first, every run, before anything else — it never writes, exits 0 even when unconfigured, and its `status` field alone decides whether the wizard runs.

## Usage

```
/fleet [n] [--testing k] [--issues A,B] [--add k] [--role working|checker] [--dry-run] [--no-wizard]
/fleet                              status check, then the default fleet size — never asks
/fleet 6 --testing 2                6 working sessions + 2 shared dev-server slots (8 sessions)
/fleet --issues ABC-1234,ABC-1240   one auto-started working session per resolved issue key
/fleet --add 2                      two more working sessions above the current highest
/fleet --add 0 --testing 1          boot one shared dev-server slot later, on demand
/fleet 4 --dry-run                  plan the worktrees and windows, touch nothing
```

## Arguments

- `[n] [--testing k] [--issues A,B] [--add k] [--role working|checker] [--dry-run] [--no-wizard]`

## Flags

- `[n]` — Number of WORKING sessions to run (default: `fleet.size`, derived from this machine). Testing slots are on top of this number.
- `--testing k` — Shared dev-server slots to keep up, 0..`testing.maxSlots`. `0` = no local pool; captures go to the cloud or wait for a slot booted later with `--add 0 --testing 1`.
- `--issues A,B` — Comma-joined issue keys. One working session per key, each auto-started on its key. Parents are expanded to their children first (op-1) when the adapter supports it.
- `--add k` — Add `k` brand-new working sessions above the current highest label (default 1). Existing sessions and the testing pool are left as they are. With `--issues`, `k` must equal the resolved key count.
- `--role working|checker` — Role of the spawned sessions. `checker` sessions run a `/fleet-check` slice on `vcs.checkerBranchTemplate`; see `playbooks/check.md`.
- `--dry-run` — Print the worktree + window plan and exit without creating, installing or launching anything.
- `--no-wizard` — Never prompt: no wizard, no questions. If the status is not `ok`, `fleet up` exits non-zero with `{status, missing[], hint}` and writes nothing — pass it whenever nobody is there to answer.

## With no arguments

After the status check passes, launch the default fleet size with a bare `fleet up` (no count = `fleet.size`, derived from this machine's RAM and CPUs) — never ask the operator how many sessions they want.

## Then

Read `${CLAUDE_PLUGIN_ROOT}/playbooks/launcher.md` **in full** and follow it exactly as your operating playbook. The arguments the operator typed are: $ARGUMENTS
