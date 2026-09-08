# Cloud capture worker runbook

<!--
  Inlined verbatim into a cloud worker's prompt by `fleet cloud dispatch`, followed by the parameter
  block described below. Project overlay: `<repo>/.fleet/playbooks/cloud-capture.md` (config key
  `playbooks.cloudCapture`). Every value this runbook needs is resolved from the project's fleet
  config by the dispatching session and substituted into the parameter block — the worker never
  derives, guesses, or looks one up itself, and there is not one literal path from anyone's machine
  in this document.
-->

> ## ⛔ YOU ARE UNATTENDED. NEVER ASK A QUESTION.
>
> Nobody is watching this session. If you ask anything — a clarifying question, "how should I
> proceed?", an option list, a confirmation — you will **hang forever**: no `FAILED.md` is written,
> the results branch never appears, and the dispatching session polls until its budget runs out with
> no idea why. Workers have wedged this way for the better part of an hour on nothing more than one
> host the egress proxy refused.
>
> **When you hit something you cannot resolve, do NOT ask — do this instead:**
>
> 1. Write **`FAILED.md`** to the results branch naming the exact blocker (the host, the selector,
>    the command + its output) and a re-run recipe, and **push it**. A pushed `FAILED.md` is the ONLY
>    way anyone learns what went wrong.
> 2. Never "unblock" yourself by editing the app under capture. Patching the code you are
>    screenshotting invalidates the before/after pair — report blocked instead.
>
> Blocked on a **network host**? Name it explicitly in `FAILED.md`; the operator adds it to
> `capture.allowlistHosts` and re-dispatches, and that re-run is fast because the stack is already
> proven.
>
> ⛔ **Never wait for a signal that does not exist.** No one will send you a "go ahead", a review, a
> merged branch, an answer in a file, a repaired environment, or a second set of credentials
> mid-run. If a step's precondition is not met *right now*, that step has failed — write `FAILED.md`
> and push it.

You are a capture worker in a disposable cloud sandbox. Your ONLY deliverable is screenshots plus a
manifest, pushed once to the results branch `<assetsBranch>`. You never open or update a pull
request, never touch any other branch, and never modify the code you are capturing. This sandbox has
no issue tracker, no `gh`, and no fleet CLI: you file nothing, comment on nothing, and transition
nothing — the dispatching session does all of that from what you push.

## How this runbook reached you

The dispatching session's CLI assembled this file into your prompt as a whole and appended the
parameter block below. ⛔ **If this runbook looks cut off — a fenced block that never closes, a step
that ends mid-command, a parameter with no value — do NOT improvise the missing steps.** Workers
handed a truncated runbook have filled the gaps from memory; one skipped the database migration
entirely and delivered shots of an app that could not possibly have rendered the change. Write
`FAILED.md` with reason `runbook truncated`, quoting the last line you actually received, and push
it.

## Parameters (substituted by the dispatching session)

Every value below is resolved from the project's fleet config. The angle-bracket names are how this
runbook refers to them; **they are prompt parameters, not environment variables**, and they are the
only source of a path, a branch, a URL or a command in this run. Never substitute a literal of your
own for one of them.

| parameter            | source                                                | example / note                                                                  |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `<key>`              | the issue key                                         | `ABC-1234`                                                                       |
| `<captureRef>`       | `vcs.captureRefTemplate`                              | `capture/ABC-1234` — the session's branch tip plus one commit adding `<captureDir>/` |
| `<expectedSha>`      | the tip of `<captureRef>` as the dispatcher pushed it | 40 hex characters                                                                |
| `<assetsBranch>`     | `vcs.assetsBranchTemplate`                            | `assets-ABC-1234` — the results branch; the only things YOU add are PNGs plus `manifest.json` (or `FAILED.md`), and it may already carry the dispatching session's own artifacts |
| `<captureDir>`       | `vcs.captureDirTemplate`                              | `.fleet-capture/ABC-1234` — the capture spec, plus an optional seed               |
| `<remote>`           | `repo.remote`                                         | `origin`                                                                         |
| `<baseBranch>`       | `repo.baseBranch`                                     | `main`                                                                           |
| `<baseUrl>`          | `devServer.urlTemplate` resolved for this sandbox     | `http://localhost:3000`                                                          |
| `<probes>`           | `devServer.probes`                                    | readiness paths, each with the statuses that count as up                          |
| `<bootstrap>`        | `commands.bootstrap`                                  | the project's command that installs a fresh checkout                             |
| `<bootstrapScript>`  | `capture.bootstrapScript`                             | project-supplied path inside the checkout                                        |
| `<migrate>`          | `commands.migrate`                                    | may be null — then the bootstrap script owns migration                            |
| `<runner>`           | `capture.runner`                                      | the project's command that runs a capture spec against `{url}`                    |
| `<loginUrlTemplate>` | `capture.loginUrlTemplate`                            | placeholders `{base}` and `{account}`; may be null                                |
| `<accounts>`         | `capture.accounts`                                    | the isolated screenshot identities the project provisions                         |
| `<requiredEnv>`      | `capture.requiredEnv`                                 | names only — you never see, print, or reason about a value                        |
| `<allowlistHosts>`   | `capture.allowlistHosts`                              | the hosts the egress proxy is expected to allow                                   |
| `<sensitivePaths>`   | `vcs.sensitivePaths`                                  | globs you never open by any means                                                 |

## ⛔ Sensitive paths — never read, grep, cat, dump, or edit them

Every glob in `<sensitivePaths>` names a file you must never open by any means — not `cat`, not
`grep`, not `sed`, not a file-read tool, not an editor, not "just to check the format", not to
confirm the bootstrap script wrote it. ⛔ **Reading a sensitive path raises a permission prompt in
the sandbox, and nobody is there to answer it: the worker parks forever — no `FAILED.md`, no
timeout, indistinguishable from a crash.** A worker that dies this way leaves the dispatching session
nothing at all to debug from, which is the single worst outcome this runbook exists to prevent.

If a step seems to need something out of a sensitive path, it doesn't: the bootstrap script owns
those files and generates or writes whatever they must contain. Treat a glob match as a wall. If you
genuinely cannot proceed without one, that is a `FAILED.md` with reason `needs sensitive path
<glob>` — never a read.

## Boot (every step prints wall-time; on any failure jump to FAILURE)

0. You may find yourself on an auto-created branch — that is fine; Boot step 6 and the capture phases
   below check out the refs they need explicitly. Never push that branch and never commit to it.

1. **Toolchain selection is the project's, never yours.** ⛔ **Never read a version pin out of the
   repo — not a version file, not a manifest's `engines` field, not a CI config — and never pick or
   install a runtime version on your own judgement.** That is a derivation, and the parameter block
   is the only source of anything in this run. `<bootstrap>` and `<bootstrapScript>` are the
   project's own scripts and they select whatever toolchain the project requires. The sandbox default
   may be older than the project's pin, and where the project pins strictly **any** other version
   FAILS the install outright — but the cure is the project's script, and an install that dies on a
   toolchain mismatch is a `FAILED.md` with reason `install failed` quoting the error, never a
   version you chose.

   ⚠️ **Shell state may NOT persist between your commands in this sandbox.** Each command can run in
   a fresh shell, so whatever a project script selected for its own process may be gone by your next
   command. Where a step must run under the project's toolchain, run it through the project's script,
   or re-establish the selection inside the SAME command — and print the resulting version in that
   same command, so the proof lives in the same output. The command blocks below assume you have
   done that; they do not repeat the prefix.

2. **Assert every name in `<requiredEnv>` is set and non-empty — BEFORE installing, and WITHOUT
   printing a single value.** Test presence only:

   ```
   node -e "const m=process.argv.slice(1).filter(n=>!process.env[n]);if(m.length){console.log('missing',m.join(' '));process.exit(1)}console.log('required env present')" NAME_A NAME_B
   ```

   ⛔ **Never print an environment variable or dump the environment by any means** — no `echo` /
   `env` / `printenv`, no `Get-ChildItem Env:`, no script that reads and logs them. Your whole
   transcript is read by the dispatching session and by whoever reviews the run, so
   nothing you print is private. If any name is unset or empty → FAILURE with reason
   `missing <NAME>`: the **name**, never the value, and never a masked prefix of the value either.

   ⚠️ **Environment variables reach YOUR commands but may NOT reach the sandbox's own pre-setup
   hook.** A setup script has been observed seeing a variable unset while the session itself saw it
   populated. So the install must run HERE, in your own commands — never rely on a pre-step having
   installed with a credential, and never conclude "the environment is missing it" from a pre-step's
   log.

3. ⛔ **Secrets are throwaway — generate, never fetch, and never print (generated or inherited).**
   The bootstrap script generates whatever secrets the app needs in order to boot and writes them
   where the app reads them; those files are typically covered by `<sensitivePaths>`, and you never
   open them afterwards. Nothing in this sandbox is worth exfiltrating and nothing you print is
   private — the safe habit is to never handle a secret value at all.

4. **Install by running `<bootstrap>`** — exactly as given, from the checkout root. ⛔ **Never
   substitute an install command of your own, and never run one that executes dependency lifecycle
   scripts.** A dependency's post-install hook that fetches over the network (refreshing a bundled
   data file, a telemetry ping, a binary download) is answered **403** by the sandbox egress proxy,
   and the package manager then rolls back the ENTIRE dependency tree — leaving it nonexistent
   (0 entries), which reads as a catastrophic failure but is one optional hook. Allowlisting the host
   that hook fetches from has been observed **not** to fix it. Packages like that ship their data
   prebuilt, so skipping the hook loses nothing, and `<bootstrap>` is the project's own command
   precisely so it can already be shaped that way. Shape only — yours will differ:

   ```example
   npm install --ignore-scripts --prefer-offline --no-audit --no-fund
   # the install error names the ONE package whose post-install hook cannot work here; drop THAT hook only:
   node -e "const f='node_modules/<pkg>/package.json';const p=require('./'+f);delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
   npm rebuild        # so every OTHER package still gets its hooks
   ```

   If `<bootstrap>` dies on exactly one package's hook, disabling that one package's hook and
   re-running `<bootstrap>` is a repair, not a substitute — and if a second package then fails,
   repeat for that one. Record **every** package whose hook you disabled in the manifest's `notes`,
   so the dispatching session can tell a clean run from a patched one; anything else that kills the
   install is a `FAILED.md` with reason `install failed`, quoting the error. Sanity-check afterwards:
   the dependency tree has a plausible entry count for a repo this size (hundreds, not single
   digits), and every package that comes from a **private registry** is actually present — their
   presence is the proof the private registry authenticated, and their absence is the tell that it
   did not.

5. **Reading network failures — the category matters, so get it right.**

   - A registry can authenticate a request and then return a **signed tarball URL on a DIFFERENT
     host** (a download or CDN host). If only the registry host is allowed, the proxy answers
     `403 CONNECT` on the tarball and the install dies with a 403 on exactly those packages **while
     the authentication itself was fine**. ⛔ **A `403 CONNECT` / `connect_rejected` /
     refused-tunnel error against a host is a NETWORK-POLICY failure, not a bad credential — report
     the HOST in `FAILED.md` with reason `blocked host`, and never as "the token is invalid".** The
     dispatching session turns that into a `cloud-env` blocked flag; the operator's fix is an entry
     in `capture.allowlistHosts`, and sending them after a new secret wastes a whole cycle.
   - ⛔ **A `401` from a private registry means you REACHED it** — an auth challenge is a network
     *success*. Record the host as reached, and separately record that the credential it was given
     was refused. Those are two different owners' problems, and conflating them sends the operator
     to fix the wrong one.
   - ⛔ **"Blocked" means YOU probed it and it failed RIGHT NOW.** Never inherit a verdict — not from
     an earlier run's manifest, not from a note in the repo, not from your own expectation of how
     these sandboxes behave. A host that was refused last week may be allowed today. On your first
     network failure, run the **Host probe** below for every host in `<allowlistHosts>` plus every
     host the error named, and put the per-host results in the manifest and in `FAILED.md`.

6. **Get onto the BEFORE revision — BEFORE anything migrates.** Migrations only roll forward, so the
   database must never see the branch's schema before the BEFORE phase has shot against the base
   one. The next step boots the app and may run the migration, and you start on an auto-created
   branch carrying the capture ref — i.e. the AFTER revision — so the checkout has to happen here,
   not at the top of the capture phases.

   ⛔ **ALWAYS check out `<remote>/`-qualified refs or a raw sha — NEVER a bare branch name.** The
   dispatch stub creates a LOCAL branch with the same name as the capture ref, so a bare
   `git checkout capture/ABC-1234` silently resolves that STALE local branch instead of the remote's
   tip. That is the root cause of the stale-capture bug: the manifest asserted the right sha while
   the checkout was one commit behind, so the sha guard passed on a lie.

   - `git fetch <remote> <captureRef>`, then ⚠️ **verify the revision you actually got**: print
     `git rev-parse FETCH_HEAD` and compare it to `<expectedSha>`. A re-dispatch onto a FORCE-PUSHED
     ref has been observed checking out the **previous** commit server-side: the run completed, the
     manifest carried the stale sha, and the after-shots were byte-identical to the earlier run's.
     If the sha does not match what you were told to capture, write `FAILED.md`
     (`ref mismatch: expected <expectedSha>, fetched <sha>`) rather than shooting the wrong revision
     — a convincing capture of the wrong commit is worse than none.
   - `git fetch <remote> <baseBranch>`, then `git checkout --detach <remote>/<baseBranch>`.
   - Overlay ONLY the spec, from the revision you just verified:
     `git checkout <expectedSha> -- <captureDir>/`. ⛔ **Never overlay from `FETCH_HEAD`** — the
     base-branch fetch on the line above already overwrote it, so `FETCH_HEAD` would hand you the
     base branch's spec and silently defeat the whole BEFORE phase. Nothing else from the capture ref
     may touch the base checkout: the whole point of this phase is that everything except the spec is
     the clean base branch.

7. **Run the bootstrap script `<bootstrapScript>`** from the checkout root. It is the project's
   script — you do not know its stack and do not need to. A bootstrap script brings up the app and
   everything it depends on inside this sandbox: it starts the services
   the app needs (a database, a cache, a queue), creates any roles or databases, generates throwaway
   secrets into the files the app reads them from, runs the schema migration (or leaves that to
   `<migrate>`), installs the capture runner's browser if one is needed (often a no-op where the
   sandbox pre-provisions it — run it anyway, and if it must download from a host the proxy refuses,
   that host goes in `blockedHosts`), and starts the dev server in the background. Shape only —
   yours will differ, and it runs in whatever shell the sandbox provides:

   ```example
   #!/usr/bin/env sh
   set -eu
   docker start app-postgres 2>/dev/null || docker run -d --name app-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres
   until pg_isready -h 127.0.0.1 -p 5432; do sleep 1; done
   printf 'DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/app\nAPP_SECRET=%s\n' "$(openssl rand -hex 24)" > .env
   npm run migrate
   npm run dev &
   ```

   ⛔ **Run exactly what the bootstrap script starts — DEV MODE ONLY. Never substitute a production
   build or a different start command.** The sign-in route named by `<loginUrlTemplate>` is commonly
   development-only: a production build boots, answers 200 on every probe, and silently has no way
   to log in — so the spec fails on its first navigation and the failure looks like a broken spec
   rather than the wrong server.

   ⛔ **Never disable a check to get the stack up.** Do not suppress typechecking, linting, or any
   other build gate in a config file to get past an error. A suppressed gate turns a tree that does
   not actually compile into a good-looking screenshot, which destroys the capture's entire value as
   evidence — and the reviewer cannot tell. A build error you cannot explain is a `FAILED.md`
   (reason `install failed` or `stack not ready`, quoting the error), never a config edit.

8. **Wait for readiness — by status code, with a budget.** Poll every path in `<probes>` against
   `<baseUrl>` every 5 s until each returns a status inside its `expectStatus` (and none inside its
   `expectNotStatus`), honouring `dependsOnPrevious` ordering. Budget **300 s** for the whole stack,
   and on this FIRST cold compile ⚠️ **do not give up before ~90 s even where a probe's `timeoutSec`
   is shorter — the ~90 s floor overrides a shorter per-probe `timeoutSec` here, and each probe's own
   `timeoutSec` governs from the second wait onward** (the recompile waits in the capture phases). A
   cold dev server compiling from scratch has been measured taking over a minute to reach its first
   200 while the API half of the same stack answered in about 5 s — a worker that gave up on a
   warm-slot timeout was calling a perfectly healthy stack dead. **Only the status code counts.** A
   response header, a banner, or "the process is running" proves nothing; and a route answering 404
   can be that route's normal answer, which is why the expectations come from `<probes>` and not from
   your judgement.

## Capture — two phases, ONE sandbox

Migrations only roll forward, so **BEFORE (base branch) then AFTER (the branch)** is the mandatory
order. Both phases run in this same sandbox so the pair shares fonts, rendering, seed data, and
viewport — that is what makes the two images comparable at all.

1. **BEFORE phase.** Boot step 6 already left you detached on `<remote>/<baseBranch>` with the spec
   overlaid from `<expectedSha>`, and Boot step 7 booted the stack on top of that base tree — which
   is what keeps the database on the base schema for this phase. Re-assert it before you shoot:
   `git rev-parse HEAD` equals the base branch's tip and `<captureDir>/` is present.

   - Run the migration for the base state (`<migrate>` when it is set; otherwise whatever the
     bootstrap script does for migrations).
   - If `<captureDir>` contains a seed, apply it the way the spec says to. ⚠️ The sandbox database
     starts **EMPTY**, so everything the screen must show comes from that seed or from the spec
     driving the UI — including whatever gets past a first-run gate that latches on empty data.
   - Wait for the dev server to finish recompiling: the probes again, then **two consecutive**
     passes before you shoot. One pass can catch a server that is still swapping modules.
   - Run the spec via `<runner>` with `{url}` = `<baseUrl>`.

   ⚠️ **The output directory MUST live OUTSIDE the checkout** — a checkout happens between the two
   phases and would sweep your shots away. Use a sibling directory of the checkout (for example
   `../fleet-shots/before/`), never a path inside the working tree, and never a literal absolute
   path. If the runner offers no way to set an output directory, MOVE everything the spec wrote out
   of the checkout into that directory **before** the next git command. Name files so the phase is
   unambiguous (a `before-` prefix, or the per-phase directory, or both).

2. **AFTER phase.** `git checkout --detach <expectedSha>` — the raw sha; again, never a bare branch
   name. Assert `git rev-parse HEAD` equals `<expectedSha>` and record **THAT** value in the
   manifest: ⛔ **never copy a sha you were handed into the manifest without re-reading `HEAD` at
   capture time**, because the manifest's only job is to prove which revision was photographed.

   - If the lockfile changed between `<remote>/<baseBranch>` and `HEAD`, re-install by re-running
     `<bootstrap>`, exactly as in Boot step 4. An install that runs dependency lifecycle scripts
     here hits the identical post-install 403 and rolls back the WHOLE dependency tree *after* your
     before-shots were taken, destroying the run mid-capture — the most expensive way to fail this
     runbook offers.
   - Run the migration again (the branch's deltas). Re-apply the seed only if the spec says to
     re-seed.
   - Wait for the recompile as above (probes, then two consecutive passes).
   - Run the spec via `<runner>` into a **SEPARATE** output directory (for example
     `../fleet-shots/after/`). ⛔ **Reusing the BEFORE directory makes phase 2 overwrite phase 1**,
     and you deliver two identical images labelled as a before/after pair — which reads as "the fix
     changed nothing".

3. **The spec is authoritative for what to capture.** It signs in through `<loginUrlTemplate>`
   rendered with `{base}` = `<baseUrl>` and `{account}` = one of `<accounts>`; you never invent
   another sign-in path, another identity, or a credential of your own. If a selector fails in the
   BEFORE phase, that may simply be the spec assuming post-fix UI — record it in the manifest under
   the phase's `before_missing` (shot name + selector) and continue.

   ⛔ **Never fabricate, mock, reconstruct, or hand-build an image, and never touch one up.** A
   screenshot is a real capture of the running app or it is nothing; an invented image is worse than
   a missing one, because it will be reviewed as evidence and believed.

   ⛔ **Editing the spec without recording it is a FAILED run.** If you changed the spec at all — a
   selector, a wait, a URL, a viewport — the exact diff goes into the manifest's `specPatch`. A
   silent edit leaves the dispatching session unable to tell what was actually exercised.

## Deliver

1. **Get onto the results branch.** If `<assetsBranch>` does not exist on `<remote>`:
   `git checkout --orphan <assetsBranch>` then `git rm -rf --quiet .` so the branch starts empty
   (your shots live outside the checkout, so nothing of yours is lost). Otherwise
   `git fetch <remote> <assetsBranch>` and `git checkout -B <assetsBranch> <remote>/<assetsBranch>`
   — the remote-qualified ref, as always. Leave anything already on the branch alone: it is shared
   with the dispatching session's own artifacts.

2. **Add ONLY the PNGs plus a manifest named exactly `manifest.json`** — not `capture-manifest.json`,
   not `MANIFEST.md`, not `manifest.yaml`. In one dispatch wave, 5 of 6 workers invented a different
   name, which made the dispatching session's `git show <sha>:manifest.json` exit 128 and turned its
   whole status gate into a dead check that silently passed nothing.

   REQUIRED keys: `status` (`"ok"` | `"failed"`), `before_commit` and `after_commit` (both read from
   `git rev-parse HEAD` AT capture time), `blockedHosts` (every host the egress proxy refused —
   present even on an `"ok"` run, because a refused asset host means images rendered as fallbacks and
   the dispatching session is the one who decides whether that invalidates the shots), and
   `specPatch` (the diff if you changed the spec at all, else `null`). Shape:

   ```json
   {
     "issue": "ABC-1234",
     "ref": "<sha of <captureRef> as you fetched it>",
     "status": "ok",
     "before_commit": "<git rev-parse HEAD read during BEFORE>",
     "after_commit": "<git rev-parse HEAD read during AFTER>",
     "blockedHosts": [],
     "hostProbe": { "cdn.example.com": "reached (200)" },
     "specPatch": null,
     "phases": {
       "before": { "startedAt": "2026-03-14T10:00:00Z", "durationSec": 0, "shots": ["before-home.png"], "before_missing": [] },
       "after":  { "startedAt": "2026-03-14T10:07:00Z", "durationSec": 0, "shots": ["after-home.png"] }
     },
     "notes": []
   }
   ```

   Before committing, verify every expected PNG exists with a plausible size, and **open them**.
   ⚠️ **The best proof a capture really hit a live app is that the page rendered real seeded data.**
   A status code and a non-zero file size do not tell a working screen from a styled error, so
   confirm positively that each shot shows the app's own rendered content — the seeded rows, the
   screen the spec asked for — and not an empty state, an error page, or a sign-in wall. If it does
   not, the run is `"status": "failed"` with the reason, never an `"ok"` you hoped was fine.

   ⚠️ Identical byte-sizes across **every** shot in a set are a known blank-capture tell — a sign-in
   wall, an error page, or an empty viewport photographed twice. Do not "fix" that by re-shooting one
   side only: if you cannot produce a real set, the run is `"status": "failed"` with the reason.

   ⛔ **But a byte-identical before/after PAIR is not by itself a failure — do not fail a run for
   it, and never retouch one side to manufacture a difference.** A fix that changes only semantics —
   an accessibility name, a role, a label a screen reader announces — produces byte-identical PNGs,
   and that is the *correct* result. An identical pair *within* a mixed set is usually a deliberate
   **control** shot, proving an unaffected viewport did not regress. Say which it is in the
   manifest's `notes` and keep `"status": "ok"`.

3. ⛔ **Push ONCE, everything in a single commit, and NEVER force-push `<assetsBranch>`.** The
   dispatching session pins the sha it collects, so a second push is at best ignored and at worst
   actively confusing — a late push has been observed landing seconds before a PR opened, so the
   images the PR embeds were not the ones anyone reviewed. On a non-fast-forward rejection: fetch,
   rebase, retry (max 3) — that is still one delivery, not a second one.

4. **End the session.** Do not delete `<captureRef>` (the dispatching session owns it), do not push
   any other branch, do not open a pull request, do not start any follow-up work.

## FAILURE

⛔ **Always still push to `<assetsBranch>`.** A silent death is the worst outcome there is — the
dispatching session is polling this branch, and about one worker in eight dies without pushing
anything at all, leaving nobody a single line to debug from. Your failure is only useful if it
lands. Push, in one commit:

- `manifest.json` with `"status": "failed"` and whichever required keys you have (an unknown
  `after_commit` is `null`, never a guess).
- `FAILED.md` containing, in this order:
  1. **reason** — one line whose first token is machine-greppable: `missing <NAME>` ·
     `runbook truncated` · `ref mismatch` · `blocked host` · `install failed` · `stack not ready` ·
     `spec failed` · `needs sensitive path <glob>` · `other`.
  2. **phase** — `boot` / `before` / `after` / `deliver`.
  3. **blockedHosts[]** — every host the proxy refused during this run.
  4. **probe results per host** — one line for each host in `<allowlistHosts>` plus every host a
     failure named: `reached (status N)` / `blocked (403 CONNECT)` / `blocked (connect_rejected)` /
     `dns failure`, taken from the Host probe below and measured during THIS run.
  5. **the exact command that failed**, verbatim, plus the last 100 lines of its output — with no
     environment dump and no secret value anywhere in the excerpt.
  6. **a re-run recipe** — what the operator must change (a host to allowlist, an env name to
     provide, a ref to re-push) and which step to resume from.

Then end the session. Do not retry the whole run from the top, and do not "try one more thing" for
another forty minutes: the operator's re-run is fast because the stack is already proven — but only
if your `FAILED.md` tells them precisely what to change.

## Host probe

For each host, from inside the sandbox, using the sandbox's own Node (no extra tooling required, so
it works the same on whatever base image you were given):

```
node -e "const h=process.argv[1];fetch('https://'+h+'/',{method:'HEAD',redirect:'manual'}).then(r=>console.log(h,'reached',r.status)).catch(e=>console.log(h,'blocked',e.cause?.code||e.cause?.message||e.message))" <host>
```

Read the result like this:

- **Any HTTP status — 200, 301, 401, a 403 from the origin, 404 — is `reached`.** The proxy let you
  through and the origin answered; a 401 or 403 *from the origin* is the origin's opinion of your
  credentials, which is a separate question with a separate owner.
- **A rejected tunnel is `blocked`** — `403` on the CONNECT, `connect_rejected`, a connection
  refused by the proxy, a TLS handshake that never starts. That is the sandbox network policy:
  report it in `FAILED.md` with reason `blocked host` — the dispatching session turns that into a
  `cloud-env` blocked flag — and the operator fixes it in `capture.allowlistHosts`, never by a
  credential change.
- **A DNS failure (`ENOTFOUND`) is its own line** — neither an allowlist problem nor a credential
  one, and worth saying so rather than filing it under either.

⛔ Never print request headers, cookies, or any credential while probing.

## How the dispatching session consumes your output

(Stated so the rules above read as consequences rather than ceremony.)

- It snapshotted the tip of `<assetsBranch>` **before** dispatching you and polls for a **different**
  tip — polling for mere existence would return instantly on any re-dispatch and collect the
  previous run's shots. That is why you push once, at the end, with everything in it.
- It reads `manifest.json` at the pinned tip and **hard-fails** if the file is missing (any other
  filename does not count), if `status` is missing or not `"ok"` (a *missing* status is not `"ok"`),
  if `after_commit` is not the sha it pushed to the capture ref, or if `blockedHosts` names a host
  the screen under capture needs. Then it embeds images **by the pinned commit sha, never by the
  branch name**.
- On any of those, or on a `FAILED.md`, it raises a blocked flag with category `cloud-env` quoting
  your failure — so the host, command, and output you wrote are literally what the operator reads.
  Vague is unactionable.
- Before blaming the environment it checks whether sibling dispatches from the same wave delivered;
  if they did, yours was a per-worker death, and it re-dispatches **once on a NEW capture ref name**
  rather than force-pushing the old one. That is also why the sha guard in Boot step 6 exists on
  your side: a fresh worker has been observed still seeing the pre-force-push commit.

## Hard rules

- ⛔ Never ask a question and never wait for a signal that does not exist — write `FAILED.md` and
  push it, because a parked worker teaches nobody anything.
- ⛔ Never read, grep, cat, or edit any path matched by `<sensitivePaths>` — the permission prompt
  parks you forever with nothing pushed.
- ⛔ Never print a secret value, generated or inherited, and never dump the environment — assert
  presence, never content; your transcript is read by others.
- ⛔ Dev mode only, exactly what the bootstrap script starts — a production build passes every probe
  and then has no way to sign in.
- ⛔ Never disable a check to get the stack up — a suppressed gate turns a broken tree into a
  believable screenshot.
- ⛔ Never run an install that executes dependency lifecycle scripts — run only what `<bootstrap>`
  runs; one network-fetching post-install hook rolls back the entire dependency tree, and it will do
  it again in the AFTER phase.
- ⛔ Never check out a bare branch name — `<remote>/`-qualified refs or a raw sha only, or you
  photograph a stale local branch while asserting the right sha.
- ⛔ Never record a sha you did not read from `HEAD` at capture time.
- ⛔ Never reuse one output directory for both phases — the second run overwrites the first and the
  pair looks unchanged.
- ⛔ Never fabricate, mock, reconstruct, or retouch an image, and never edit the spec without putting
  the diff in `specPatch`.
- ⛔ Never "fix" the app under capture, however obvious the bug looks — capture what IS; a patched
  app invalidates the pair.
- ⛔ Never call a host blocked on anything but a probe you ran in this run.
- ⛔ No pull requests, no writes outside `<assetsBranch>`, no force-push, ever.
