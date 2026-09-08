---
# trackers/github.md — GitHub Issues adapter for claude-fleet. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens this file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line. Transport is the code-host CLI
# throughout: every `Call:` line is a CLI command, and no op calls an MCP server.

id: github                       # == filename without `.md`; the value of `tracker.id` in .fleet/config.json.
name: GitHub Issues

mcp:
  # Connection is what the contract defines: any tool visible in the session with one of these
  # prefixes ⇒ connected (it is also what `fleet config detect` proposes `tracker.id` from). Nothing
  # in this adapter calls that server — every `Call:` line below is a CLI command — so whether the
  # CLI can act is learned per call and answered by each op's `If unsupported:` line. `fleet doctor`
  # reports what the configured repository supports; no op waits on that report before trying.
  toolPrefixes: ["mcp__github__", "mcp__claude_ai_GitHub__"]
  install:
    - label: "Install the code-host CLI and sign in"
      instructions: "Install the code-host CLI for your platform and complete its sign-in as the account that can write `tracker.scope` — issues and labels in the issues repository; the CLI's sign-in status must report that account. Non-interactive shells and GitHub Enterprise Server hosts are configured through the CLI's own token and host environment variables (see `mcp.docs`). Every op in this adapter runs through the CLI."
  docs: https://cli.github.com/manual/

issueKey:
  # GitHub has no prefixed keys — an issue is `#1234`. A bare number matches inside every ordinary
  # branch name (`testing-2`, `check/<sweepId>/<slice>`) and `#` is unsafe in refs and shells, so the
  # fleet's <KEY> for a GitHub issue is `GH-<number>`. op-2 accepts `#1234`, `1234`, `acme/app#1234`
  # and the issue URL and normalises them; branch, assets and capture templates render `GH-1234`.
  pattern: "GH-[0-9]+"
  caseInsensitive: true
  example: "GH-1234"
  derive: null

scope:
  label: repo                    # `tracker.scope` is the issues repository as `owner/name` (`acme/app`).
  required: true                 # It may differ from the code repository; every Call: passes it explicitly.
  listOp: "gh repo list --json nameWithOwner --limit 100"

capabilities:
  resolveChildren: true          # op-1  — sub-issues API; task-list parse when the plan lacks sub-issues.
  cancel: true                   # op-9  — close as "not planned".
  attachLink: true               # op-8  — a comment carrying the URL; the code host cross-references it.
  listQueue: true                # op-12
  comment: true                  # op-11
  createIssue: true              # op-13 / op-14 / op-16
  labels: true                   # op-17 / op-18
  atomicPatch: false             # op-15 stays but is emulated: read-modify-write under the
                                 # 1-slot `tracker-worklist:<KEY>` pool lock (GitHub has no body patch).
  subIssues: true                # op-23 — a 404/403 from the endpoint degrades to a task-list umbrella.
  duplicateRelation: true        # op-24 — "Duplicate of #n" comment + the duplicate close reason (else not planned).
  relations: true                # op-25 — a cross-referencing comment on both issues (auto-linked).
  grouping: label                # op-20 / op-21 — a `sweep:<id>` label. What this line declares is the
                                 # label form; `tracker.settings.groupBy: milestone` is a runtime variant
                                 # of op-20 / op-21 and does not change the declared capability.
  imageEmbed: inline             # op-22 — markdown image pointing at the assets branch.
  imageUpload: none              # GitHub has no API for issue image uploads; strategy is assets-branch.
  workItems: body                # op-26 / op-27 — a task list in the to-do issue's body.
  findComplete: link-header      # op-16 — the paginated list follows `Link: rel="next"` until absent.

priority:
  scale: labels                  # Four labels, created by op-18 at plan time; also mirrored on the
                                 # `**Priority:**` body line (the field-less trackers' only channel).
  map: {1: "priority:urgent", 2: "priority:high", 3: "priority:medium", 4: "priority:low"}

states:
  # GitHub issues are `open` or `closed` (closed carries a reason). The two working transitions are
  # label-backed state NAMES that op-19 returns; `cancelled` is the closed state with reason "not planned".
  in-progress: {promptDefault: "status:in-progress"}
  in-review:   {promptDefault: "status:in-review"}
  cancelled:   {promptDefault: "Closed (not planned)"}

config:
  # `tracker.scope` is not listed here — `scope.required: true` above is what makes the wizard obtain
  # it, and `scope.listOp` hands it candidates already shaped `owner/name`. Listing it twice asks twice.
  - key: tracker.settings.groupBy
    prompt: "Group a sweep's issues by a sweep:<id> label or by a milestone? (label | milestone; default label)"
    detect: null
    required: false

# No `rest:` block — no op declares `Transport: rest`; op-22 is `Transport: cli`.
---

# GitHub Issues adapter

Everything the plugin says about a tracker it says in the 27 op names; this file is the only one
that names what those ops call. Read the *How this adapter maps the fleet onto GitHub*
section once — it holds the rules GitHub makes easy to violate — then execute the `Call:` line of
the op the playbook named. The invariants under each op in `trackers/_template.md` hold for this
adapter too; the ones restated here are the ones this tracker's shape makes easy to break.

## How this adapter maps the fleet onto GitHub

- **Transport.** Every op is a code-host CLI command named on its `Call:` line; no op calls an MCP
  server. *Connected* means what the contract says — a tool carrying an `mcp.toolPrefixes` prefix is
  visible in the session — and, beyond that, every `Call:` needs a signed-in CLI for an account that
  can write `tracker.scope`: a session without one follows each op's `If unsupported:` line, and a
  cloud worker, which has neither the CLI nor a token, always goes through the outbox.
  Non-interactive shells and Enterprise Server hosts are configured through the CLI's own token and
  host environment variables (see `mcp.docs`); a host-qualified `tracker.scope` works too.
- **Scope.** `tracker.scope` is the issues repository, `owner/name`. It is usually — not always —
  the code repository the worktrees are clones of.
- **Key.** `GH-<number>`. `#<number>` is GitHub's display form and autolinks; `GH-<number>` never
  does. The adapter writes `GH-…` in prose by default and a bare `#<n>` **only** where a
  cross-reference on the other issue's timeline is the point (op-8, op-13's `**PR:**` header line,
  op-24, op-25, the task list).
- **Ids.** `id` in every op result is the issue **number** — the handle every command takes. The
  node id and the database id are different values; only op-23 needs the latter, and its `Call:`
  shows how to fetch it.
- **States.** `open` / `closed` plus a close reason (`completed`, `not planned`, `duplicate`). The
  fleet's `in-progress` and `in-review` are labels named by `tracker.states`; `cancelled` is the
  closed state whose reason the configured `tracker.states.cancelled` name selects (`not planned`
  by default); `done` is `closed` + `completed`. op-19 synthesises the list.
- **Labels are named, not id'd.** Every command addresses a label by exact name, so op-17's `id`
  is the name. A label must exist before a write can reference it — the CLI refuses an unknown
  name — and only the launcher creates one (op-18).
- **Endpoints that answer per repository.** The sub-issues endpoints return 404/403 on a repository
  whose plan lacks them, and an older CLI or API version rejects the duplicate close reason.
  `fleet doctor` probes both once for `tracker.scope` and reports what this repository actually has,
  so the launcher knows before a sweep starts; that probe is a *report*, not a gate. Every `Call:`
  that touches one still branches on the live answer — 404/403 (or the rejected reason) means "apply
  this op's degradation now", never "retry" — because the same call against the same repository
  fails the same way twice, and the *Degradation rules* rows exist for exactly that answer.
- **Limits worth knowing.** Issue and comment bodies: 65,536 characters. Label names: 50
  characters. Assignees: 10 per issue. Sub-issues: 100 per parent. Search results: 1,000 per query.
  REST list pages: 100 rows. Default page size on the issue and label list commands: **30**.

⛔ Pass the issues-repository scope on every command that addresses a repository (each such `Call:`
shows the flag; the user lookups in op-3 and every `fleet …` call take none) —
because a session's working directory is a worktree of the *code* repository, the CLI silently
targets whatever `origin` it finds there, and the issues repository need not be the same one.

⛔ Read structured output and write verbatim text from a file (the `Call:` lines show both flags),
never by parsing human output or quoting text inline — because human output changes between CLI
versions, and shell quoting differs between the two platforms and mangles backticks, `$` and `!` in
text the contract says must land unchanged.

⛔ Set the page size explicitly on every list — because the default page is 30 rows, returned with
exit 0 and no ellipsis, so a truncated list is indistinguishable from a complete one.

⛔ Issues and pull requests share **one** number sequence and the REST issues endpoints return pull
requests as issues — drop pull-request rows on every list (the REST list `Call:` lines in op-1 and
op-16 carry `select(.pull_request == null)`; op-12's issue-list command excludes them itself), and
confirm a `#<n>` is an issue with op-2 before treating it as a key — because a to-do issue's
checklist is a list of *pull requests*, and a session fanned out on a PR number is a session with
no ticket.

⛔ Pace content-creating writes (creates, comments, label edits) and honour `Retry-After` on a
`403` secondary-rate-limit response, never blind-retrying — because GitHub caps content creation
per account (documented at roughly 80 per minute and 500 per hour at the time of writing), a
300-finding sweep with a comment per issue exceeds that inside one wave, and a retry after a
timeout that actually applied is how duplicate issues appear. Re-fetch (op-2 / op-16) before any retry.

⛔ Write the ledger, the flags and the outbox through the CLI (`fleet check ledger append`,
`fleet flag …`, `fleet outbox add`), never by hand from a shell — because the two shells disagree on
encoding and empty-pipeline semantics, and a silently dropped append is a PR that reads as never
attempted.

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Call: `gh api "repos/{tracker.scope}/issues/<n of parentKey>/sub_issues?per_page=100" --paginate --jq '.[] | select(.pull_request == null) | .number'` → `GH-<number>` each, in the order returned; when the call returns 404/403 (sub-issues unavailable for this repository), parse the parent's body (op-2) for task-list lines `^- \[( |x|X)\] #(\d+)` and keep the numbers op-2 confirms are issues rather than pull requests
If unsupported: the launcher treats the key as a leaf and says so in the `fleet up` output; reads are never queued to the outbox.

Direct children only, so the launcher can fan out **one session per child** (`fleet up --issues
<parent>`, `fleet add <parent>`); sessions never call it. An assigned key is typically one child of
a parent that was split across sessions — a session works **only** its assigned issue, never the
parent, never a sibling, because a sibling is another session's ticket and the parent is the
launcher's — so return leaves only — a child that is itself a parent (sub-issues nest eight levels)
is expanded, not assigned — and an empty array for a leaf. A parent holds at most 100 sub-issues, so
one paginated run is the whole set; apply the op-16 completeness rule anyway.

⛔ A `#<n>` in a parent's task list is not known to be an issue until op-2 says so — because the
number space is shared with pull requests, and the task-list fallback would otherwise hand a
session a "ticket" that is somebody's PR.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Call: `gh issue view <n> -R {tracker.scope} --json number,title,body,url,state,stateReason,labels,milestone,assignees` → `key = "GH-" + number`, `id = number`, `description = body` (raw markdown, untouched), `status` = the op-19 name for this issue (`Open`; the `tracker.states` label it carries; `Closed (completed)` / `Closed (not planned)` / `Closed (duplicate)` from `stateReason`), `priority` = canonical 1..4 from whichever `priority.map` label it carries (else the `**Priority:**` body line, else `null`), `parentId` = `gh api repos/{tracker.scope}/issues/<n> --jq '.parent.number // empty'` (the issue payload carries the pointer only where sub-issues are enabled and this issue has one) and, when that is empty or the call answers 404/403, the number on a `**Parent:** GH-<n>` body line, else `null`; `suggestedBranch` is never set — GitHub offers none, so the session renders `vcs.branchTemplate`
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

`<n>` is the trailing digits of whatever form the key arrived in — `GH-1234`, `gh-1234`, `#1234`,
`1234`, `acme/app#1234` or the issue URL. The launcher calls op-2 for every assigned key **before**
spawning and pipes the JSON into `fleet ticket cache --issue <KEY> --from-json -`, which is what
makes the fallback above exist.

⛔ If the CLI is missing, not signed in, or the API is unreachable in your session, do **not** stall
on that — read the ticket cache and carry on; write a blocked flag (`fleet flag blocked --category
tracker …`) only if that file is missing too — because a fleet-launch burst can hit the API's
rate limit together, and every state write you owe meanwhile travels through the outbox, so nothing
is lost by proceeding.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Call: `"me"` → `gh api user --jq .login`; a login → `gh api users/<login> --jq .login` (404 = unknown); an email → `gh api "search/users?q=<email>+in:email" --jq '[.items[].login]'` and accept only an exactly-one-element result → `userRef` is the **login** (`@me` is accepted by every `--assignee` flag and means the same as the `"me"` result)
If unsupported: for `"me"`, the CLI's sign-in status reports the login; if even that is unavailable, `tracker.defaultAssignee` must hold a literal login set in the **user** layer.

`"me"` means the authenticated account and is the only assignee the playbooks ever ask for, unless
`checker.routing` matches the **defect's** path. GitHub identifies people by login and hides most
email addresses, so an email that does not resolve to exactly one public profile is refused —
configure the login instead. An assignee must have access to the repository, or op-6 fails
(cosmetically, see there).

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public.

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 `({tracker.scope})`, then pick the entry whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → that entry's `id` — `label:<name>` for a label-backed name, `closed:<reason>` for a closed name (so `Closed (not planned)` yields `closed:not_planned` and `Closed (duplicate)` yields `closed:duplicate`)
If unsupported: always supported — the list is synthesised from configuration, not fetched.

Maps the three canonical transitions to what GitHub actually has. It stays its own step because a
label-backed state only exists once the launcher has created the label (op-18) in *this*
repository, and because `closed` has three reasons that look alike in a list and mean different
things.

⛔ Never hard-code a state name or a close reason in a `Call:`; resolve it every time through the
configured scope — because GitHub holds two `cancelled`-type states (`not planned`, `duplicate`) and
one `done`-type state that a careless close lands in, and only the configured name tells them apart.
The one deliberate exception is op-24, whose close reason *is* the duplicate marker: it hands op-19's
`closed:duplicate` entry to op-5 directly and falls back to op-4 when the API rejects it.

## op-5 setState

`setState(key, stateRef)`

Call: `label:<name>` → (`gh issue reopen <n> -R {tracker.scope}` first if the issue is closed) then `gh issue edit <n> -R {tracker.scope} --add-label "<name>" --remove-label "<every other tracker.states label the issue carries, comma-joined>"`; `closed:not_planned` → `gh issue close <n> -R {tracker.scope} --reason "not planned"`; `closed:duplicate` → `gh issue close <n> -R {tracker.scope} --reason duplicate`, and where that CLI build knows no such reason, once — never in a loop — `gh api -X PATCH repos/{tracker.scope}/issues/<n> -f state=closed -f state_reason=duplicate`; `closed:completed` → `gh issue close <n> -R {tracker.scope} --reason completed`; `open` → `gh issue reopen <n> -R {tracker.scope}` and remove both status labels; then op-2 to confirm `status` changed
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the ref and applies it.

One transition. A label-backed state implies `open`, so reopen first. Re-read after writing: the
edit exits 0 when it removes a label the issue did not carry, and closing an already-closed issue
is a no-op that prints a warning, so the exit code alone does not prove the state you asked for is
the state the issue has.

⛔ Never reach `closed:completed` from a working session — because `completed` is the *done* state,
the code host closes the issue that way itself when a PR that says `Closes #<n>` merges, and a
session closing an issue as completed before its PR is reviewed reads as "shipped".

## op-6 assign

`assign(key, userRef)`

Call: `gh issue edit <n> -R {tracker.scope} --add-assignee <login|@me>`
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Assign to the login op-3 returned. The default is always `"me"`; `checker.routing` is the only
thing that changes it, and it matches on the path of the defect, not the PR that surfaced it. A
login without repository access makes the command fail — treat that as cosmetic: record the key,
leave the assignee as `"me"` in a comment, and move on; never loop on it.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `({tracker.scope}, in-review)` → op-5 `(key, stateRef)` — adds the `in-review` label and removes the `in-progress` one
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. Listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context. The issue stays `open` here — GitHub
closes it when the PR merges, which is the `done` state.

## op-8 attachLink

`attachLink(key, url, title)`

Call: `gh issue comment <n> -R {tracker.scope} --body-file <path>` where the file holds the one line `<title>: <url>` — a full pull-request URL in a comment makes the code host cross-reference the PR on the issue's timeline, which is GitHub's native issue↔PR link; the PR's own body saying `Closes #<n>` is what fills the issue's Development panel and closes the issue on merge
If unsupported: on a locked conversation — where the comment above is refused but a body write still lands — put the URL on its own line in the body via op-14; when the CLI is down, `fleet outbox add --op attachLink --key <KEY> --args <json>`.

Attach the PR URL to the issue.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the issue,
and never sleep on it — because the write budget is per-account, so it shrinks exactly as the fleet
grows, and re-creating is how duplicates appear. Record the key, move on, and let the launcher's
serial cleanup pass attach it when waiting is free; a bare PR URL in the body keeps the association
visible meanwhile.

## op-9 cancel

`cancel(key, reason)        (comment FIRST, then state)`

Call: op-11 `(key, <reason, verbatim, with its file:line evidence>)`, **then** op-4 `({tracker.scope}, cancelled)` → op-5, then op-2 and confirm `status` is the configured `cancelled` name
If unsupported: op-11 with the same text, then op-10; the done-flag still carries `--outcome cancelled`.

Close an issue as not needed — the defect is already fixed on the base branch, or never existed.
Two explicit calls, not the close command's inline-comment option, so the order is visible and the
comment travels as a file.

⛔ Comment **first**, then state — because the comment is the record of why a filed bug was deleted
and must stand on its own; a cancel whose state lands first leaves an unexplained closure if the
session dies between the two calls.

⛔ `cancelled` means "already fixed — here is `path:line`" and is **not** the same as `duplicate`
("another session shipped it in a PR that is legitimately in review and must not be closed") —
because an assertion with no line number cannot be acted on and the ticket stays open, while a
duplicate closed as cancelled deletes a live review. A session with a working transport performs
op-9 itself and writes `fleet flag done --outcome cancelled --evidence <path:line> --reason …`
either way — the flag is the only thing that survives the session.

⛔ **Never** the *completed* close reason — the close is always reached through op-4 from the
configured `cancelled` name (`Closed (not planned)` by default) — because `completed` is the shape of
a finished ticket in every GitHub view and filter, and a cancelled bug that reads as fixed is a hole
the tracker says is gone.

## op-10 leaveOpen

`leaveOpen(key)             (explicit non-action)`

Call: none — no tracker call is made
If unsupported: always supported.

An explicit decision to leave the issue as it is, recorded in the done-flag (`--outcome duplicate`
or `--outcome no-code-change`) so the launcher's report can tell "left open on purpose" from "the
session died". It exists so the flag grammar can distinguish `cancel` from `leaveOpen` — the very
distinction the playbooks insist on.

## op-11 comment

`comment(key, verbatimText) (never paraphrased)`

Call: `gh issue comment <n> -R {tracker.scope} --body-file <path>` — the text written to the file byte-for-byte (`--body-file -` reads standard input); a single short line without backticks, `$` or `!` may use `--body "<text>"`
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

A comment is capped at 65,536 characters. A `#<n>` token in the text autolinks and puts a
"mentioned" event on that issue or PR's timeline; a `GH-<n>` token does neither — choose the form
deliberately (see the mapping section).

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason.

⛔ Never truncate text containing issue or PR numbers at a raw character offset; cut at a word
boundary, strip a trailing `#` or `GH-` fragment, and keep every `GH-` key in backticks — because
`#1234` cut to `#12` is a valid *shorter* reference that autolinks to a real, unrelated issue and
pollutes it with a backlink, while the write "succeeds" and looks fine in the echo.

## op-12 listQueue

`listQueue(selector) → key[]`

Call: `gh issue list -R {tracker.scope} --state open [--label "<selector.labels plus the sweep:<group> label, comma-joined>"] [--assignee <login|@me>] [--milestone "<selector.group>" when groupBy is milestone] --json number,title,labels,milestone --limit 1000` → drop rows carrying any `selector.excludeLabels` name (and, for `state: ready`, any `tracker.states` label), sort by the `priority.map` label (1 first, unlabelled last, then by number), map `number` → `GH-<number>`
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside `tracker.queue` / `tracker.scope`, priority-sorted; the launcher writes them to `queue.txt`
for autowave. `state: ready` is the adapter's `unstarted` state — `open` with neither `tracker.states`
label — unless `checker.ready.state` names a label. The list command has no exclude filter, so
exclusion is applied on the returned rows. The default selector excludes `checker.triage.label`, and
the result is only a **candidate** list: `fleet intake check` still refuses any checker-filed ticket
that lacks `gate:passed|waived` when `fleet.queue.requireGate` is on, and counts the refusals —
never silently. Apply the op-16 completeness rule: a result of exactly the page size is truncated.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Call: `gh issue create -R {tracker.scope} --title "<title>" --body-file <path> --label "<labels ∪ {priority.map[priority]} ∪ {sweep:<group> when groupBy is label} ∪ {state when it is a label}, comma-joined>" --assignee <login|@me> [--milestone "<group title>" when groupBy is milestone]` → prints the new issue's URL; `key = "GH-" + <trailing number of the URL>`, `id` = that number, `url` as printed; then op-23 for `parent?` and op-8 for each `links[]` entry
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the issue and records the key.

One issue per finding. `state?` is `checker.triage.state` (on GitHub, a label or nothing — a
freshly created issue is always `open`); `labels[]` always carry `checker.triage.label`,
`checker.provenanceLabel` and `checker.gate.labels.pending`, and only names that op-17 returned;
`assignee` is `"me"` unless `checker.routing` matches the defect's path. Non-interactive creation
needs both a title and a body file or the CLI opens an editor — the `Call:` passes both; with a
body file given, issue templates are bypassed. The body's first line is `**PR:** #<n> — <url>` —
the bare `#<n>` is deliberate: it cross-references the PR, and it is the join key below.

⛔ Reconcile against the system of record with op-16 at the **start of every filing batch**; never
track "what have I already filed" in a hand-kept file or a running tally — because both drift, and
the failure mode is duplicate tickets, the opposite of what the dedup gates exist for.

⛔ Join filed issues to findings on the `**PR:**` header line or the opaque `fid`, never on title
similarity — because titles are rewritten when filing, so text similarity mis-scored 28 of 100 in
one sweep, while an opaque key cannot drift.

⛔ A timeout, a `502`/`504`, or an oversized echo (`result exceeds maximum … saved to <file>`)
usually means the write **applied** — re-fetch with op-2 or op-16 before any retry, never
blind-retry — because a blind retry creates a duplicate.

⛔ Priority is set **twice**: the `priority.map` label and a `**Priority:**` line in the body —
because GitHub has no priority field at all, the label is the only filterable channel, and for
issues whose label is forced (`checker.a11y.forcedPriority`) the body line is the only channel the
assessed severity can travel on.

⛔ Every label name passed at create must have come from op-17 — because the create refuses an
unknown label and the whole create fails, and a worker that "fixes" that by creating the label
fragments the queue filter and the gate mirror everyone else keys on (op-18 is launcher-only).

A failed `links[]` entry is cosmetic (op-8 rule); the issue is created correctly without it. A
`403` secondary-rate-limit response is *not* an applied write — wait `Retry-After`, then continue
the batch from where it stopped, still reconciling with op-16 first.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Call: `gh issue edit <n> -R {tracker.scope} [--title "<title>"] [--body-file <path>] [--add-label "<add, comma-joined>"] [--remove-label "<remove, comma-joined>"] [--add-assignee <login|@me>] [--milestone "<title>" | --remove-milestone]` — only the flags for fields given; `priority?` = `--remove-label` the other three `priority.map` names and `--add-label` the one; `state?` → op-5; `parent?` → op-23; `links?` → op-8
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`), which is exactly what the `Call:`'s
add/remove flags express — never rebuild the full set — because a replacement erases the labels
another pass added (gate labels, a11y labels). `fleet check gate apply` uses it to mirror
`gate:<status>`; the rediscovery rule uses it to append a new call site to an existing issue (body
and comment only — never title or state, so it reads as new evidence).

⛔ A body write through op-14 **replaces the whole body** — a body edit that must not clobber goes
through op-15, never through op-14 from a copy you read earlier — because two whole-body writes
from two writers keep only the last one, silently.

⛔ Editing an issue you did not create is **launcher-only** — because parallel writers to one issue
overwrite each other, while creating *distinct* issues shares no mutable state and parallelises
cleanly. The line is shared state, not the tracker itself.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Call: `fleet pool acquire tracker-worklist:<KEY>` → op-2 `(key)` for the body **as stored now** → apply every `{find, replace}` to that text, counting only edits whose `find` occurs exactly once → `gh issue edit <n> -R {tracker.scope} --body-file <path>` → op-2 again and assert every applied `replace` string is present → `fleet pool release tracker-worklist:<KEY> <slot>` → `{applied}`
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'`.

Find/replace edits against the body; each `find` must match exactly once. GitHub has no native
patch, so `atomicPatch: false` and the adapter emulates it by read-modify-write under
`fleet pool acquire tracker-worklist:<KEY>` (release with `fleet pool release`), because two
unlocked read-modify-writes silently drop one another's edits. Match on the exact bytes op-2
returned — GitHub stores the body as written, line endings included, so a `find` composed from a
local copy with different line endings matches zero times.

⛔ Re-read the body **inside** the lock, never before it — because the operator can tick a task-list
box in the web UI, which rewrites the body underneath you, and a write built on a pre-lock read puts
their tick back.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ After any downgrade or refutation, re-read the **whole** body as stored and search it for the old
severity word and the refuted mechanism's key nouns, patching each occurrence in the same op-15
call; keep useful original text behind a `<details>` block marked refuted, which GitHub renders
collapsed — because a priority label and a title get corrected while the body still argues the
original severity, and the body is what a fixer reads.

⛔ Send N edits in **one** call per wave, never one call per edit — because every emulated patch is
a full-body round-trip under a lock (a 322-row body is ~13 KB each way), while several edits in one
call is still a single serialized write with no clobber risk.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Call: `gh api "repos/{tracker.scope}/issues?state=<open|closed|all>&labels=<labels ∪ {priority.map[priority]} ∪ {sweep:<group> when groupBy is label}, comma-joined>[&milestone=<group number> when groupBy is milestone][&since=<createdAfter>]&per_page=100" --paginate --jq '.[] | select(.pull_request == null) | {number, title, labels: [.labels[].name], state, state_reason, created_at, sub_issues_total: (.sub_issues_summary.total // 0)}'` → `issues[]` with `key = "GH-" + number`, `id = number`, `priority` from the `priority.map` label, `status` per op-19, `parentId` per op-2's rule; `createdAfter?` is then applied on `created_at` (the `since=` parameter filters by *update* time and only pre-narrows); `parentIsNull?` keeps rows whose op-2 `parentId` is `null` (`true`) or not (`false`); `complete = true` only when the `--paginate` run exited 0 — the CLI follows the `Link: rel="next"` header until it is absent; `text?` → `gh api search/issues -f q='repo:{tracker.scope} is:issue "<text>"' --jq '{total: .total_count, numbers: [.items[].number]}'` with `complete = (numbers.length == total)` and a hard cap of 1,000 results
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and must file tracker-less (`localId` rows) — say so in your PR.

Filtered query. The label filter is an AND; for an OR (both a11y labels) run one call per label and
union the rows by `number`. `complete` comes from the `link-header` mechanism: a run that stopped
early (non-zero exit, a `403` mid-pagination) is incomplete however many rows it printed.
`reconcile.assertComplete()` in the CLI trusts nothing else.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates.

⛔ Band the query by `priority` (1, 2, 3, 4 — one call each, i.e. one `priority.map` label each) so
each band fits a page, assert `complete` on **every** band before combining, and print the per-band
counts — because a band silently at its cap is the failure you are looking for. Issues carrying no
priority label form a fifth band; query by the provenance label, subtract the four bands, and say so.

⛔ Exclude parents structurally — `sub_issues_total > 0` marks a parent in every op-16 row,
and `parentIsNull` uses the parent pointer — never by a list of parent ids — because an umbrella
filed later carries the same labels and priority as its own children and walks straight into any
frame keyed on those; an id list is a snapshot of the parents you knew about when you wrote it.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate. The search endpoint has its own, lower rate limit and indexes with a delay of
seconds to minutes, so a just-created issue can be absent from it — the list endpoint is the
system of record.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Call: `gh label list -R {tracker.scope} --json name,description --limit 1000` → `[{ id: <name>, name }]` — GitHub addresses labels by name everywhere, so `id` is the name; complete when the row count is below `--limit`
If unsupported: label-driven markers move to body lines (see *Degradation rules*).

⛔ Sessions and workers pick labels from this list **only**; nobody invents one — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Call: op-17, return the exact-`name` match; else `gh label create "<name>" -R {tracker.scope} --color <hex> --description "managed by claude-fleet"` → `{ id: <name> }` (`gh label create` errors on an existing name, which is why op-17 comes first; never `--force`, which rewrites an existing label's colour and description)
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`,
`checker.triage.label`, every `checker.gate.labels.*`, both `checker.a11y.labels.*`, the four
`priority.map` names, the `sweep:<id>` group label, and — at `fleet up` — the two `tracker.states`
labels a working session's op-5 needs. Any hex colour is valid; one colour per family (priority,
gate, status) makes the issue list scannable. Names are capped at 50 characters.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Call: none — synthesised: `[{id:"open", name:"Open", type:"unstarted"}, {id:"label:<tracker.states.in-progress>", name:<that label>, type:"started"}, {id:"label:<tracker.states.in-review>", name:<that label>, type:"review"}, {id:"closed:completed", name:"Closed (completed)", type:"done"}, {id:"closed:not_planned", name:"Closed (not planned)", type:"cancelled"}, {id:"closed:duplicate", name:"Closed (duplicate)", type:"cancelled"}]`, plus `{id:"label:<checker.triage.state>", name:<that label>, type:"triage"}` when `checker.triage.state` is set
If unsupported: always supported — GitHub has no state list to fetch; its two states and three close reasons are fixed, and the label-backed ones are configuration.

Every state with its canonical type. op-4 picks from it; `checker.ready.state` defaults to `Open`,
the adapter's `unstarted` state. Both `cancelled`-type states are returned, not the first — op-4
must be able to choose the configured one, and op-24 lands in the other on purpose.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Call: `tracker.settings.groupBy` unset or `label` → op-17, match `<ref>` exactly against a label name (the full `sweep:<…>` name, or the bare `<…>` after the prefix) → `{ id: <label name>, name: <label name>, url: "https://{host}/{tracker.scope}/labels/<url-encoded name>" }` where `{host}` is the host the CLI is signed in to for `tracker.scope`; `milestone` → `gh api "repos/{tracker.scope}/milestones?state=all&per_page=100" --paginate --jq '.[] | select(.number == <ref> or .title == "<ref>") | {id: .number, name: .title, url: .html_url}'`
If unsupported: `grouping: none` — there is no group; `checker.provenanceLabel` alone marks the sweep.

Resolves `checker.project` (a label name, or a milestone number or title) once at plan time.

⛔ From then on reference the group by **id** everywhere — the exact label name, or the milestone
*number* — in `manifest.json`, in every worker brief, in every op-13 call — never by a display name
or a re-derived slug — because names carry punctuation and change, and a pointer kept in prose or
memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Call: label mode → op-18 `({tracker.scope}, "sweep:<slug of name>")` → `{ id: <label name>, url: <label url as in op-20> }`; milestone mode → `gh api -X POST repos/{tracker.scope}/milestones -f title="<name>" --jq '{id: .number, url: .html_url}'` (a `422` means the title already exists — resolve it with op-20 instead of retrying)
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question. The
slug is lowercase, non-alphanumerics collapsed to `-`, and the whole label cut at a `-` so it stays
within 50 characters.

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: assets-branch
Transport: cli
Call: `fleet assets add <filePath> --branch <vcs.assetsBranchTemplate rendered for this key or sweep>` → the CLI commits the PNG to that branch of the code repository, pushes it, and prints the hot-linkable URL, shaped `https://{host}/{owner}/{repo}/blob/{branch}/{path}?raw=true` with the host and `{owner}/{repo}` taken from the code repository's remote (for `github.com/acme/app` and the default `vcs.assetsBranchTemplate`, that renders `https://github.com/acme/app/blob/assets-GH-1234/before.png?raw=true`) — and prints the sha of the commit it pushed, which substitutes for `{branch}` to give the pinned form `https://{host}/{owner}/{repo}/blob/<sha>/{path}?raw=true`; `url` = the printed URL verbatim, in the pinned `blob/<sha>/<path>` form whenever the rule below applies, `embed` = `![<alt>](<url>)` followed, when a caption is given, by a line `_<caption>_`
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from
`capabilities.imageEmbed`, `capabilities.imageUpload` and `checker.attachStrategy`, never improvised
at filing time. GitHub exposes no API for the drag-and-drop image uploads its web UI performs, so
`imageUpload: none` and `native-upload` is never available here; `assets-branch` is what this
adapter does, and it requires `vcs.host: github`. The `{owner}/{repo}` in the URL is the **code**
repository's remote (`repo.remote`), which `fleet assets add` derives; the issues repository
(`tracker.scope`) may differ and the image still renders, because it is a URL. The `?raw=true` blob
URL is stable and unsigned — nothing to re-sign, nothing to expire.

`_No screenshot attached: <reason>_` is counted **separately** from `_No UI surface — <reason>_` in
the report, because "the app was down" and "there is no screen" are different outcomes and lumping
them overstates coverage.

On a **private** repository those URLs render as broken images to anyone not signed in to the code
host — the issue's readers must have repository access, and any dev page or external report must
carry the PNG as a local file instead of hot-linking it.

⛔ The PNGs and the dev page go on the assets branch, never on the PR branch — because a screenshot
in a PR's diff is noise a reviewer has to wade through, and it ships binary evidence into the
history of the code it evidences.

⛔ Never check the assets branch out into a worktree; read a file from it with `git show
<remote>/<branch>:<path>` — because it is an orphan branch and checking it out untracks every file
of your working tree.

⛔ Pin the embed to the commit the CLI printed (`blob/<sha>/<path>`) whenever anything can push to
that branch after you read it (a cloud capture worker still running) — because a branch-named URL
resolves to whatever lands last, and a worker landing seconds after you collected turns your
before/after into two afters.

⛔ **One upload per screenshot.** Commit the shot once, then create the sibling findings with the
same `embed` already inlined — because several findings from one PR share one screen, and
per-issue commits turn a 300-finding sweep into ~900 round-trips and a branch history nobody can read.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none. Before embedding, check that the file exists with a plausible, distinct
size — identical byte-sizes across "different" shots are a blank-capture tell.

## op-23 setParent

`setParent(key, parentKey)`

Call: `gh api -X POST repos/{tracker.scope}/issues/<n of parentKey>/sub_issues -F sub_issue_id=<database id of key>` where the database id is `gh api repos/{tracker.scope}/issues/<n of key> --jq .id` (an integer — not the issue number, not the GraphQL node id), then op-15 `(key, [{ find: <the body's first line>, replace: "**Parent:** GH-<n of parentKey>\n" + <that line> }])` so the pointer is readable without the API
If unsupported: (the sub-issues endpoint answered 404/403 for this repository) the umbrella becomes an index issue whose body is a task list `- [ ] #<n of key> <title>` appended by op-15 under the `tracker-worklist:<umbrella KEY>` lock, each child carries the `**Parent:**` body line, and op-25 links the pair.

Make `key` a sub-issue of `parentKey`. Its main use is the a11y umbrella (`checker.a11y.umbrella`,
titled `checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the
working queue while keeping **one issue per gap** — a pattern ticket would lose the per-site
file/line/PR that makes each one actionable. Sub-issue availability depends on the repository's plan:
`fleet doctor` probes it once for `tracker.scope` and says which shape this sweep will get, and the
endpoint's own answer decides at call time — a 404/403 takes the `If unsupported:` path on every
call, without a retry; a parent holds at most 100 children, so a sweep past that files a second umbrella
(`<title> (2)`) rather than an index for the overflow, and says so in the report.

⛔ Parenting onto the umbrella is **launcher-only**; a worker passes `parent?` at op-13 time only for
issues it creates itself — because the umbrella is shared state.

⛔ When re-parenting retroactively, query each a11y label with op-16 and **union the two result sets
by number** before iterating — because the two label queries overlap heavily, and iterating both
issues duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over parent/child when two findings
carry different severities — because nesting an Urgent under a High buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Call: op-11 `(key, <evidence, verbatim, whose first line is "Duplicate of #<n of ofKey>">)`, **then** op-5 `(key, "closed:duplicate")` — op-19's duplicate entry, the one close reason a `Call:` names on purpose (op-4 rule); if both forms op-5 tries reject the duplicate reason, op-4 `({tracker.scope}, cancelled)` → op-5 instead, which closes it as *not planned*; then op-2 and confirm `status` is `Closed (duplicate)` or the configured `cancelled` name
If unsupported: op-11 with the same evidence, then op-4 `({tracker.scope}, cancelled)` → op-5, with `Duplicate of #<n of ofKey>` as the comment's first line; if `cancel` is also `false`, op-11 then op-10.

The literal first line `Duplicate of #<n>` is GitHub's own duplicate marker — the code host shows
it on the original's timeline — and the bare `#<n>` is deliberate for that reason.

⛔ Comment **first**, then the close — because the evidence comment is mandatory and the relation is
the bonus; a close that lands first leaves a duplicate with no pointer to the original if the
session dies between the two calls.

⛔ Never decide a duplicate by title similarity; compare the **mechanism** — same function, same
missing guard, same line — because true pairs routinely have completely different titles, unrelated
findings on one large file often have similar ones, and a wrong merge silently deletes a tracked bug,
which is worse than a duplicate sitting in the backlog.

⛔ "Shares the fix" is a hypothesis, not a verdict — check that both fixes touch the same file before
accepting it — because cross-app pairs almost never merge; one composite folded in three siblings whose
fixes landed in three different apps. When the claim turns out wrong, comment the correction on the
ticket (op-11) — because left alone that sentence makes someone close a second issue that was never
fixed.

## op-25 relate

`relate(key, otherKey, kind, note)`

Call: op-11 `(key, "<kind>: #<n of otherKey> — <note>")` and op-11 `(otherKey, "<kind>: #<n of key> — <note>")` — the bare `#<n>` is deliberate: it is what makes the code host cross-reference the two timelines, and that cross-reference is the only relation GitHub has besides sub-issues and "Duplicate of"; `kind` stays as plain text (`related`, `blocks`, `blocked-by`, `partial-overlap`, `sequential`, …)
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. One comment would already put a "mentioned"
event on the other issue, but the *note* has to be readable from both sides. When a pair is judged
*distinct* but the two name a shared line or a causal link, relate them and put the "who owns which
sites" note on **both** — because a distinct verdict that still needs an action is silently lost
otherwise, and closing one ticket half-closes the other's sites.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Call: op-2 `(key)` → parse every body line matching `^- \[( |x|X)\] #(\d+)` → `{ pr, done, keys: <backticked GH-… keys on the line>, raw: <the untouched line> }`
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the to-do issue as a task list in
its body (`capabilities.workItems: body`). GitHub renders each `- [ ] #<n>` as a checkbox with the
PR's title, and the operator can tick one in the web UI — which rewrites the body. `raw` is the exact
line op-27 anchors its edit on.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Call: `fleet check tick --lock` — which is op-15 under the `tracker-worklist:<KEY>` lock: `(key, [{ find: "- [ ] #<pr>", replace: "- [x] #<pr> (\`<key1>\`, \`<key2>\`)" }, …])`, one call per wave carrying every PR resolved in it, followed by op-26 and the assertion that the count of `- [x]` lines grew by exactly N
If unsupported: `workItems: none` — no-op; `fleet check status` is the only progress view.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op
the instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells
them the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from
the shared ledger — because parallel writers to one description overwrite each other, and a
bookkeeping step attached to one execution path dies when the path changes (the tick once vanished
the day filing moved to subagents while the ledger append survived).

⛔ Anchor on the leading `- [ ] #<n>` and backtick-wrap every key you append — because a bare
`#<n>` also appears inside other PR titles on the same list, and an unwrapped reference autolinks.

⛔ Patch, never a whole-body rewrite from a stale copy — because on this tracker the patch *is* a
whole-body write, and only the lock plus an in-lock re-read keeps it from clobbering a concurrent
edit or the operator's own tick. Every tick goes through `fleet check tick --lock`, which does
exactly this.

⛔ Verify a backfill by re-fetching (op-26) and counting ticked rows, never by retrying — because a
whole-description backfill trips the oversized echo or a gateway timeout and the write applied
anyway; a blind retry is how duplicate trackers get made. At any point the ticked-row count must
equal the ledger's line count — `fleet check tick plan` prints the difference. A body that would
exceed 65,536 characters after the appended keys is refused by the API — split the worklist across
two to-do issues at plan time rather than dropping keys.

## Fallbacks every adapter gets for free (do not re-document)

Two mechanisms exist so that a tracker outage, a dropped MCP, or a sandbox without tools never costs a
transition. The `If unsupported:` lines above name them; this is what they are, and nothing else in
this file repeats them.

- **The offline ticket cache** — `<stateDir>/tickets/<KEY>.json` and `.md`, written by
  `fleet ticket cache --issue <KEY> --from-json -` from the launcher's op-2 call before a session is
  spawned. Its path lands in the session descriptor as `ticketFile`; `fleet ticket show <KEY>` and
  `fleet ticket list` read it. At `fleet check finish` every filed row is ingested too, so a later
  `/fleet` session has the body, PR and `where` locally without a single tracker call.
- **The tracker outbox** — `<stateDir>/tracker-outbox/*.json` (`{op, key, args, verbatim}`), moved to
  `applied/` once done. A session queues with `fleet outbox add --op <op> --key <KEY> --args <json>
  [--verbatim]`; the launcher drains it every monitor turn, applies each entry through **this adapter's
  `Call:` lines**, posts `verbatim: true` text unchanged, **re-reads the issue to verify** the write
  landed, then `fleet outbox ack <id> [--result <json>]`. Sessions find the directory through their
  descriptor's `paths.outboxDir`, never a literal path.
- `tracker.mode: manual` runs the whole fleet with every transition queued (the operator applies them
  from `fleet outbox list`); `tracker.mode: none` skips state, assign and comment ops entirely —
  sessions take a PR number, branch or task text, and `/fleet-check` rows get a `localId`. Every session
  sees its mode in `FLEET_TRACKER_MODE`.

⛔ The drain verifies by re-reading, never by retrying — because an "error" echo frequently means the
write applied, and re-applying a `createIssue` or a comment duplicates it.

## Degradation rules

What the playbooks do when a capability is `false` (or `none`). These are the plugin's behaviour, not
an adapter's to redefine; the full table lives in `trackers/_template.md`. The rows this adapter
actually exercises:

| capability | here |
| --- | --- |
| `atomicPatch: false` | op-15 stays but is emulated: acquire the 1-slot `tracker-worklist:<KEY>` pool, read, apply the edits locally, write the whole body, re-read to verify, release. Every op-27 tick goes through `fleet check tick --lock`. |
| `imageUpload: none` | op-22 strategy is `assets-branch` because the code host serves raw files from a branch; it falls to `none` with `_No screenshot attached: <reason>_` only when `vcs.host` is not `github` or the assets branch cannot be pushed. |
| sub-issues unavailable on this plan (`subIssues` stays `true`; `fleet doctor` reports which of the two shapes this repository gets) | op-1 parses the parent's task list; op-23 maintains the umbrella as an index issue under the lock and writes the `**Parent:**` body line; op-2/op-16 read `parentId` from that line. The a11y umbrella is still created (op-13), priority forcing and labels on the children are unchanged. |
| the duplicate close reason rejected by this CLI/API version (`duplicateRelation` stays `true`) | op-24 falls to op-4 (`cancelled`) → op-5 after the mandatory `Duplicate of #<n>` comment; op-19's `Closed (duplicate)` entry is then never reached and op-2 reports such issues under the configured `cancelled` name. |

## Pre-PR checklist

Run through every line before opening the pull request. `test/playbook-brands.test.mjs` and
`test/docs-redaction.test.mjs` iterate `trackers/*.md` and assert the machine-checkable lines (op
sections, `Call:` / `If unsupported:` / `Strategy:` presence, tool-name placement, `id`, the key pattern
against branch names, redaction), so those misses fail CI rather than someone's fleet; the rest is on
you.

- [ ] `id` equals the filename without `.md`.
- [ ] `issueKey.pattern` compiles, matches `issueKey.example`, and matches **nothing** in a normal
      branch name — check it, in the declared case mode, against the base branch, `testing`,
      `testing-2`, a `check/<sweepId>/<slice>` branch, and a branch rendered from `vcs.branchTemplate`
      with the key removed. It is also the regex the launcher's reclaim watcher uses to read keys from
      its own flags and descriptors (contract §4 — they carry the key exactly as this adapter renders
      it, never a branch name, which `vcs.branchTemplate` renders with `{key-lower}` and a
      case-sensitive pattern cannot read), so a false match costs a real session.
- [ ] Every capability that is `true` (or not `none`) has a non-empty `## op-<n>` section with a
      `Call:` line and an `If unsupported:` line; every `false`/`none` capability has **no** section —
      except `atomicPatch`, whose op-15 section stays and emulates, and `imageUpload: none`, whose
      op-22 section stays because `imageEmbed` is not `none` — and is covered by a row in
      *Degradation rules*.
- [ ] Sections appear in numeric order and use the contract's op names exactly (`## op-9 cancel`, not
      `## op-9 close`).
- [ ] `## op-22` has a `Strategy:` line, and a `Transport:` line whenever the strategy is not `none`;
      a `rest` block exists if and only if some op declares `Transport: rest`.
- [ ] `states.*.promptDefault` are state **names** that op-19 returns for a real scope, not ids.
- [ ] `priority.map` covers 1, 2, 3 and 4; with `scale: labels` each value is a label name op-18 can create.
- [ ] `scope.listOp` names the tool that lists scopes, and `config[].key` entries are either contract
      `tracker.*` keys or `tracker.settings.*` — no other key path is accepted.
- [ ] `mcp.install[]` entries are copy-pasteable on every platform (or have no `command`) and each was
      run once on a clean machine; `mcp.docs` resolves.
- [ ] No tracker tool or command name appears anywhere except `Call:` lines and
      `scope.listOp`; no real issue key, PR number, person or company appears anywhere, and no product
      other than this adapter's own tracker and its CLI — placeholders otherwise (`ABC-1234`,
      `github.com/acme/app`, `ada`, `the operator`, `2026-03-14`).
- [ ] Every `⛔` rule you restated kept its one-sentence *why*; none was weakened.
- [ ] `fleet trackers show <id>` renders the adapter without warnings, and `node --test` passes.
