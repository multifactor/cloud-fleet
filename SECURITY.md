# Security policy

## Reporting a vulnerability

Report it privately, through this repository's **GitHub private security advisories**: the
**Security** tab → **Report a vulnerability**. That opens a private thread visible only to the
maintainers, and it is the only reporting channel — there is no security email address and no
individual to contact.

Please do **not** open a public issue or pull request for a vulnerability, and please do not post the
details anywhere public until a fix has landed.

A useful report says what an attacker can do, not only what looks wrong: the affected file or command,
the conditions required (which config, which platform, which tracker mode), the steps to reproduce,
and the impact you believe it has. If a proof of concept touches a real repository or a real tracker,
redact it the way the rest of this project redacts things — the reproduction should be reconstructable
without naming anyone's repository, issue key or host. If you are unsure whether something counts,
report it; the boundary cases below exist precisely because this tool's normal behaviour looks alarming
if you have not read the design.

This project is pre-release (`0.1.0`) and has published no releases, so there are no supported
versions to backport to. Fixes land on `main`.

## What you are accepting when you run a fleet

The posture below is stated plainly. Some of it is uncomfortable, and none of it is spin: a tool that
runs unattended agents with your credentials should be described accurately or not published.

**One accuracy note about *when* this applies.** Most of this tool is now built. The config layer, the
system primitives, the session shim, four terminal backends, the CLI and its subcommands, the
supervisor loop and its seven checks, the watchers, the cloud dispatcher, the tracker stores and the
`/fleet-check` sweep core are code with tests. What is still absent is named in
[CONTRIBUTING.md](./CONTRIBUTING.md#what-exists-today), and includes three verb groups of contract §7
— `trackers`, `cloud` and `check …` — which have no module and answer `unknown command`. This section
is the first thing to go stale as modules land, so treat CONTRIBUTING.md and its annotated tree as
authoritative on what exists, and this file as authoritative on what any of it is allowed to do. Each
section below says which of it is code today and which is still a rule the unwritten parts are being
built against — and where the two disagree, this file describes the code.

### Spawned sessions run without permission prompts

*(Implemented: `src/session/shim.mjs`, `src/backends/*`. One correction, below, about where the
suppression actually comes from.)*

Every session `/fleet` opens is a full agent CLI running unattended. It **does not ask before running
a command, editing a file or calling an MCP tool**. That is not an incidental setting — it is the
point of the tool. A fleet of eight sessions exists to work eight tickets while nobody is watching,
and a session that stops at a confirmation dialog stops for the whole run.

**Where that comes from is worth being exact about, because it is not this plugin.** `buildChildSpec`
in `src/session/shim.mjs` starts the agent with an argv of exactly `--model <fleet.model>` and nothing
else; `--dangerously-skip-permissions` appears nowhere in `src/`, `commands/`, `playbooks/`, `hooks/`
or `schema/`. Unattended operation is therefore entirely a property of **your own agent-CLI
configuration** — the dangerous-mode setting and `skipDangerousModePermissionPrompt` in your user
settings, which [README.md](./README.md) tells you to set. Setting them yourself *is* the consent, and
nothing in this repository can grant it for you. It also means a fleet run on a machine that has not
been configured that way will park on the first prompt rather than proceed: that is the failure mode,
not a safety net you can rely on.

Concretely, a session acts as you: your operating-system account, your git identity, your forge CLI
login, your tracker MCP, your container daemon, your shell's `PATH`, and every credential any of those
already hold. Every value in `commands.*` is a shell command from your project config that runs
unprompted, and they are run by different things: **`commands.bootstrap` is run by the plugin itself**,
in every worktree it installs (`src/core/install.mjs`); **`commands.devServer` is run only in a testing
slot** — a working session is forbidden to start it; **`test`, `build`, `lint`, `typecheck` and
`migrate` are run by sessions**, as the playbooks direct; and **`commands.stopAll` is configured only
so sessions can be told never to run it** (it is repo-wide and would take other sessions' servers with
it). Read `.fleet/config.json` end to end before your first run, and treat a change to it in a pull
request as an executable change, because it is one.

**What actually spawns a process**, so you can audit it in one sitting: five modules call
`node:child_process` — `src/sys/exec.mjs`, the sanctioned wrapper the plugin's own work goes through;
`src/session/shim.mjs`, which launches the agent CLI; and `src/sys/kill.mjs`, `src/sys/proc-posix.mjs`
and `src/sys/proc-windows.mjs`, which run `taskkill`, `ps` and PowerShell for the process snapshot and
the survivor kill. **None of them passes `shell: true`** — the only `shell:` setting anywhere in `src/`
is `shell: false`, in `shim.mjs` and twice in `exec.mjs`.
`run()` takes an explicit argv, so a branch name or a ticket title containing a quote or a semicolon is
data, not syntax. `shellCommand()` is the single sanctioned shell path and exists only for `commands.*`
and `services.*.startCommand` values, which are shell strings by definition because you wrote them.
The programs the plugin itself invokes are a short list: `git`, `gh` (or whatever
`vcs.pr.createCommand` names), `tmux`, `powershell.exe`, `wt.exe`, `where.exe` / `/usr/bin/env sh` for
PATH lookup, `ps` on POSIX and one `Get-CimInstance` PowerShell round-trip on Windows for the process
snapshot, `vm_stat` / `sysctl` on macOS and `taskkill` on Windows as a last-resort survivor kill,
`docker` for the service probe, and the agent CLI itself. Two `.ps1` files ship with the plugin
(`src/backends/ps-launcher.ps1`, `src/backends/wt-inject.ps1`) and are the Windows launch and
keystroke-injection paths.

What limits it — accurately, and no further:

- Sessions run **as the user**, with the user's own permissions. The fleet grants nothing the
  operator's own shell does not already have; there is no privilege escalation, no setuid step, no
  service account, and nothing is installed system-wide.
- Each session works in **a git worktree of the user's own repository**, beside the primary checkout.
  A worktree is a working directory, not a boundary: it scopes what a session is *asked* to do, and it
  does not stop a session reaching elsewhere on the machine.
- The credentials in play are **the user's own**, already present on the machine before the fleet
  started. The plugin stores none of them and copies none of them anywhere.

There are guard rails, and they are real, but they are not permission prompts: a `PreToolUse` hook
blocks `git stash` (`refs/stash` is shared across every worktree of a repository), and it parses the
command line rather than substring-matching it, so `git -C stash status` is allowed and
`sh -c 'git stash'` is not (`hooks/block-git-stash.mjs`; five tests in `test/hooks.test.mjs` cover it,
one of them a table of ~77 command lines it must block or allow); the
supervisor tree-kills any process matching the derived dev-server pattern inside a *working* worktree
(`src/supervisor/checks/rogue-servers.mjs`); `vcs.sensitivePaths` warns sessions off listed files and
is a hard exclusion in a cloud worker's brief; intake refuses unaudited findings
(`src/core/intake.mjs`, `test/check-gate.test.mjs`). Each of those enforces one rule the fleet places
on itself. None of them constrains an agent that decides to do something else.

The honest summary: run the fleet on a repository and a machine where you would accept an unattended
engineer working with your credentials, and not on one where you would not.

### Configuration scope: secrets are user-scope, and a leak is an error

*(Implemented and tested today: `src/config/schema.mjs`, `src/config/resolve.mjs`,
`src/config/validate.mjs`; the enforcement cases are in `test/config-resolve.test.mjs`.)*

Config has two layers — a committed project layer (`<repo>/.fleet/config.json`) and a per-machine user
layer — and every key declares a scope of `project`, `user` or `either`. The scope is enforced, not
advisory, and each rule below is a named test:

- A **`user`-scope key found in a committed project file is ignored**, with a `config.scope.leak`
  warning (*a user-scope key in a committed file is ignored with config.scope.leak*).
- A **`secret` key found in a committed project file is an ERROR**, not a warning: it is not applied,
  and validation fails with `config.secret.committed` (*a secret key in a committed file is an ERROR
  and is not applied*). The same key in the user layer is fine, and that too is a test.
- The schema itself is checked: every entry must declare a scope, and *the only secret key is
  `tracker.rest.tokenEnv` and it is user-scope* asserts that the whole secret set is that one key.
- `$pinned` naming an unknown or user-scope key warns (`config.pinned.user-scope`) rather than
  silently pinning something the user layer was always going to win.

There is exactly one `secret` key: **`tracker.rest.tokenEnv`**, user-scope, and it holds **the NAME of
an environment variable, never a token value**. It is marked `x-secret: true` in the generated JSON
schema. Adapters that need REST transport read `{tracker.rest.baseUrl}` and the token from the
environment variable that key names; no adapter, no playbook and no module ever writes a token into
config, into a ticket, into a log or into a prompt. If you are adding an adapter that needs
credentials, this is the only mechanism — do not add a key that holds a value.

The shim is deliberate about the environment it hands a session, too: `CLAUDE_CODE_CHILD_SESSION` and
`CLAUDECODE` are deleted from both the child's environment and its own, and the role-scoped `FLEET_*`
scalars are cleared before this session's are applied, so one session cannot inherit another's slot,
branch or port. Your own `FLEET_*` config overrides are passed through untouched — they are yours.

That combination is also what keeps a committed `.fleet/config.json` free of anything personal,
machine-shaped or secret, which is the same property that makes it safe to share with a team.

### What talks to the network

*(Implemented. The inventory below was taken by reading every `node:` import and every `run()` call
site in `src/`, and it is complete as of the scan recorded in
[docs/reference/pre-publication-checklist.md](./plugins/claude-fleet/docs/reference/pre-publication-checklist.md).)*

The plugin opens a network connection in exactly **two** places, and both target something the
operator configured, on the operator's own machine or network:

- **`src/supervisor/checks/slots.mjs`** issues a plain `GET` to each testing slot's health probe —
  the URL built from your `devServer.urlTemplate` plus your configured probe paths — using
  `node:http` / `node:https` directly. It sends one header, `user-agent: claude-fleet-watch`, sends no
  credentials and no body, reads the status code, and discards the response. It sets
  `rejectUnauthorized: false`, because a per-branch local dev host normally serves a self-signed
  certificate; that is acceptable for a liveness probe that transmits nothing and trusts nothing it
  reads back, and it would not be acceptable for anything that carried a secret.
- **`src/supervisor/checks/services.mjs`** opens a TCP connection to `healthHost` (default
  `127.0.0.1`) on each declared container's `healthPort`, to answer "is the database actually
  listening", and closes it. Declared services only: with `services.docker.required: false` and no
  `services.containers`, the check is a no-op.

Nothing else in `src/` imports `node:http`, `node:https`, `node:net`, `node:dgram` or `node:tls`, and
there is no `fetch`, no WebSocket and no HTTP client library anywhere in the tree. Every other piece of
network activity in a run belongs to a program you already had:

1. **The tracker MCP the user connected** — whatever server provides the tracker tools, called by
   sessions through the adapter's `Call:` lines. `tracker.mode: manual` and `tracker.mode: none`
   remove even this: every transition is queued to the local outbox instead.
2. **The forge CLI** — `gh`, or whatever `vcs.pr.createCommand` names — for pushing branches, opening
   pull requests, and reading PRs during `/fleet-check`. `src/check/gh.mjs` shells out to it with an
   explicit argv; it does not speak the API itself.
3. **A cloud sandbox, only when `capture.mode: cloud`.** Off by default. `src/cloud/dispatch.mjs`
   makes no connection of its own — it drives your cloud CLI and polls `git ls-remote` against your
   own remote. See [Cloud capture](#cloud-capture) below.
4. **`notifications.command`, only if the user sets one.** It is `null` by default. When set, it is the
   operator's own command, run with `$FLEET_EVENT` and `$FLEET_MESSAGE`. There is no built-in push
   service and no third party in that path.

Beyond those: the project's own commands do whatever they do — `commands.bootstrap` will contact a
package registry, a dev server will bind a port — and the agent CLI talks to its own model provider.
Neither of those is the plugin's traffic, but both are traffic a run causes, and you should count them.

**There is no telemetry, no analytics, no usage reporting, no crash reporting and no phone-home of any
kind.** Nothing about your repository, your tickets, your configuration or your runs is sent anywhere
by this plugin. All state is local: a per-repository state directory on your own machine, holding the
session registry, locks, flags, the ticket cache, the outbox, sweep artifacts and logs.

**Zero runtime dependencies** means there is no transitive supply chain to audit: `dependencies` in
`package.json` is `{}`, there is no lockfile, the test suite installs nothing, and everything the
plugin executes is either in this repository or already on your machine. A public tool that spawns
agents with permission prompts disabled should be readable end to end in one sitting, and that is the
reason for the constraint.

### Kill safety

*(Implemented and tested today: `src/sys/proc.mjs`, `src/sys/kill.mjs`, `src/sys/proc-windows.mjs`,
`src/sys/proc-posix.mjs`, `src/sys/snapshot.mjs`; the lock discipline is `src/sys/lock.mjs`. The rules
below are named tests in `test/sys-proc.test.mjs` and `test/sys-lock.test.mjs`.)*

The fleet stops processes, and how it does that is a security property rather than a convenience.

**It never kills by exclusion.** "Kill everything except me" is the pattern that takes the launcher,
the sibling sessions, the operator's own unrelated agent and the dev servers with it — and it has done
exactly that. The rule is absolute: only processes **positively identified** as descendants of a root
the fleet itself started are ever killed (*killPlan: deepest first, only positively identified
descendants, never self or ancestors*).

The sequence is: take a process snapshot → compute the descendants of the named root → order them
**deepest-first** → subtract the **protected set** (the current process and every one of its ancestors,
plus any explicit extras) → kill → **re-snapshot and report survivors from the new snapshot, never from
the kill call's exit code**, because a kill that returns success and leaves the process running is a
routine occurrence (*killTree reports survivors from the re-snapshot, never from the kill exit code*).
`killTree` also offers a dry run that returns the plan and touches nothing, which is the honest way to
inspect what a teardown would do before doing it. On POSIX, a root spawned detached is its own process
group and the group is signalled first (SIGTERM, grace, SIGKILL) — but only when the plan protected
nobody, so a group signal can never reach a protected pid. On Windows, `taskkill /F /T` is a
survivors-only last resort, invoked one pid per call because a collection silently fails while printing
success.

Two identification rules keep "descendant" honest. A "child" whose start time precedes its parent's is
**not** a descendant — that is process-id reuse, and treating it as one is how an unrelated process
gets killed (*descendants ignores a "child" whose start time precedes its parent*). And a session is
matched by the **exact argv token** `--fleet-session=<label>`, never by substring, so session 7 never
matches session 70 (*session marker: exact token match, never substring*). Directory containment is
boundary-safe for the same reason: `app-testing` does not claim `app-testing-2`. More generally,
sessions are found through the registry — one descriptor file per session — and command-line scanning
survives only as the reconciler that rebuilds the registry after a crash, never as the lookup for
list, send or kill; the query's own shell and its ancestors are excluded from any command-line scan
(*findByCommand excludes the querying shell and its ancestors*).

The pool locks are the same discipline applied to shared resources. A lock is a `mkdir` mutex, and
staleness is judged **by heartbeat timestamp only, never by "is the holder process alive"** — the pid
in a lock belongs to whatever ran `acquire`, which is often a shell that exits seconds later, so
liveness would call every healthy lock stale. An **empty lock directory is HELD, not free**: `mkdir`
wins the mutex a moment before the holder file lands, and a reader in that window who treats the
directory as free double-grants the resource. Stealing a stale lock is serialised, so two claimants
cannot both win it.

### Cloud capture

*(`src/cloud/dispatch.mjs` and `test/cloud-dispatch.test.mjs` are written; the rules the worker itself
obeys are prose in `plugins/claude-fleet/playbooks/cloud-capture.md`, enforced by the brief the
dispatcher builds rather than by a sandbox.)*

`capture.mode: cloud` is off by default. When it is on, `/fleet-check` may dispatch a worker into an
ephemeral sandbox to bring up the app and take screenshots. The dispatcher targets a **pushed ref**
through a blobless stub rather than uploading a working directory, and it writes the runbook to a file
whose copy it verifies, passing only the quoted path on the command line — a runbook on an argv was
once truncated at a backtick and the worker improvised the missing steps. The rules that govern such a
worker:

- **It never reads any path matching `vcs.sensitivePaths`** — not by `cat`, not by a grep, not by an
  editor, not by a script. The globs are given to it explicitly, and the prohibition is absolute rather
  than best-effort. (It is also self-enforcing in a way worth knowing: a sensitive-path read raises a
  permission prompt nobody is there to answer, and the worker parks forever with no artefact.)
- **It asserts every name in `capture.requiredEnv` is set and non-empty without printing a single
  value.** Presence only. No `echo`, no `env`, no `printenv`, no environment dump by any means, and no
  masked prefix either. A failure reports the **name** that was missing and nothing else. The reason is
  concrete: the worker's whole transcript is read by the dispatching session and by whoever reviews the
  run, so nothing it prints is private.
- **The project supplies its own bootstrap.** `capture.bootstrapScript` is a path inside the checkout,
  written and reviewed by the project, and it is what generates whatever throwaway secrets the app needs
  in order to boot. Secrets in a sandbox are **generated, never fetched**, and the files they land in
  are typically covered by `vcs.sensitivePaths`, which the worker then never opens.
- **Egress is limited to `capture.allowlistHosts`**, and a blocked host is reported as a `cloud-env`
  blocked flag for the operator to fix in config — never worked around. A 401 from a host counts as
  *reached*: an auth challenge is a network success plus a separate credential question.
- **A cloud worker cannot file anything.** It has no tracker MCP and no forge CLI by construction; it
  emits outbox entries that the launcher applies later, under the operator's own credentials.

### Redaction of published prose

This plugin was extracted from an internal fleet. The generic version is the only public one, and two
tests in `plugins/claude-fleet/test/` enforce that on every build: no internal name, person, domain,
issue key, source path, product mechanism or machine path may appear in any published markdown, and
every field note must be written so a stranger can reproduce the *method* failure without being able to
locate a *product* defect. Vulnerability-shaped notes keep only their rule and a fully synthetic
observation with no residual mechanism. CI runs the pair as its own job (`redaction` in
`.github/workflows/ci.yml`), so a leak fails the build rather than the review.

The denylist those tests check against is stored as **hashes** — `sha256(token.toLowerCase())`
truncated to 16 hex characters — precisely because a published plain-text denylist would leak the names
it exists to guard. Anything expressible as a single token lives there. `redaction-patterns.txt` keeps
only the patterns whose distinctive part is a generic word or a shape, and a pattern that would have to
spell out the thing it denies belongs in the hashed list instead — a denylist that publishes its own
answers is the failure this design exists to avoid. The allowlist of strings that must appear anyway is
capped at five entries by an assertion. See
[CONTRIBUTING.md](./CONTRIBUTING.md#the-two-prose-gates) for how to check a token and what to do about
a false positive.

**Know what the gate does not cover.** It scans `.md` and `.txt` under `playbooks/`, `docs/`,
`commands/` and `trackers/`, plus `README.md`, `CONTRIBUTING.md` and `SECURITY.md` at the repository
root. It does not scan source files, test fixtures, JSON, or prose added in a new top-level directory,
and it cannot scan git history at all. Those are review's job, and
[the pre-publication checklist](./plugins/claude-fleet/docs/reference/pre-publication-checklist.md) is
where that review is written down and dated.

## What this tool is not

- **It is not a sandbox.** It does not contain, isolate, jail or virtualise the agent. A worktree is a
  directory. `vcs.sensitivePaths` is a declared rule and a hard exclusion for cloud workers — it is not
  an access control, and it does not stop a local session that decides otherwise. If you need
  containment, put the whole fleet inside something that provides it.
- **It does not review the code an agent writes.** A `/fleet` session produces a branch and a pull
  request — a *proposal*. Nothing in this plugin approves, merges or vouches for that code, and the
  pull request is opened as a draft by default for exactly that reason. Your existing review, CI and
  branch protection remain the thing that decides what lands.
- **`/fleet-check` finds candidate problems; it does not certify anything.** It is findings-only and
  never edits code. A finding is a hypothesis until a human has read it.
- **The audit gate reduces bad tickets; it does not eliminate them.** Every filed finding is re-checked
  — false positive? already fixed? duplicate? still real? — and only `gate:passed` or the human-only
  `gate:waived` reaches the working queue, **unless `fleet.queue.requireGate` is set to `false` in the
  project config, which disables the gate entirely** (`src/core/intake.mjs` then admits everything with
  an `intake.gate-disabled` warning). That is a filter with a real failure rate, not a guarantee, and
  `gate:uncertain` exists because some findings genuinely cannot be decided automatically.
- **The redaction gate catches known tokens and known shapes.** It cannot catch a leak nobody has
  added to the list, so it is a backstop for review, not a replacement for it.
