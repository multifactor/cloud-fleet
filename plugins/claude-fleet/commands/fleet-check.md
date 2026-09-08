---
description: "Review one or more PRs for still-open edge cases, future risks and scaling problems, and file each distinct gap as its own gated tracker issue with a real screenshot. Findings-only, one resumable sweep, never asks a question; the audit always follows."
---

<!-- GENERATED from playbooks/check.md by scripts/render-commands.mjs — edit the playbook's `command:` front matter, then run `npm run commands:render`. A hand edit here is overwritten and fails test/generated-files.test.mjs. -->

# /fleet-check

**Before anything else:** Run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" config status --json` first. Anything but status ok — needs-checker included: print the payload's hint verbatim and EXIT. Never open a wizard, never ask.

**Never ask the operator a question.** Decide, act, and say what you chose in the final report. A question does not pause a run politely — it stops it dead for however long it takes someone to look.

## Usage

```
/fleet-check <PR…|<KEY>|--from-file p> [--project <id|name|new>] [--mode local|sessions|cloud] [--auto] [--width N|auto] [--resume <sweepId>] [--dry-run]
/fleet-check audit <sweepId|project>
/fleet-check status
/fleet-check promote <sweepId> [--all | --fid <fid…> | --min-priority N] [--waive]
```

## Arguments

- `PR…` — One or more PR numbers or URLs on the configured remote. A handful; runs as a single wave.
- `<KEY>` — A tracker issue (for example ABC-1234) whose work items list the PRs. Read once with op-26 readWorkItems; every resolved PR is mirrored back with op-27 tickWorkItem.
- `--from-file p` — A text file with one PR number or URL per line.
- `<sweepId|project>` — For audit and promote — a finished sweep, or the tracker group that holds an older corpus.

## Flags

- `--project <id|name|new>` — Where filed issues are grouped. Resolved once by op-20 and stored in the manifest by ID — never carried as a name. Default: `checker.project` when set (op-20); otherwise `op-21 createProject` named from `checker.projectNameTemplate`; `--project new` or `checker.projectPerSweep` forces a new project even when `checker.project` is set; provenance-label-only when the adapter's `grouping` is `none`.
- `--mode local|sessions|cloud` — Where the per-PR workers run. See section 5. Default: checker.defaultMode
- `--auto` — After the audit, promote gate:passed findings to the ready state (checker.autoPromote = after-audit for this run). Refused with a hint when no gate exists to collapse.
- `--width N|auto` — Workers per wave. auto = as many as the harness runs concurrently, throttled when the machine strains. Default: checker.waveWidth
- `--resume <sweepId>` — Resume an existing sweep dir explicitly. Re-running the original command resumes anyway — the sweepId is deterministic from the input.
- `--dry-run` — Plan only — create the sweep dir, print the worklist, the slices and the location plan; no tracker writes, no dispatch.

## With no arguments

Print usage and exit. NEVER ask what to check.

## Then

Read `${CLAUDE_PLUGIN_ROOT}/playbooks/check.md` **in full** and follow it exactly as your operating playbook. The arguments the operator typed are: $ARGUMENTS
