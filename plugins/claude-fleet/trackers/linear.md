---
# trackers/linear.md — the bundled Linear adapter. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens this file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line.
#
# TOOL NAMES BELOW ARE WRITTEN WITHOUT THEIR CONNECTOR PREFIX. Linear reaches a session under more
# than one connector, and each connector prefixes the same tools differently — the CLI-added server
# and the first-party connector each carry their own prefix (see `mcp.toolPrefixes`). Hard-coding
# either prefix makes the adapter wrong for half its users, so every `Call:` line and `scope.listOp`
# names the tool WITHOUT its prefix; the caller prepends whichever entry of `mcp.toolPrefixes` its
# own visible tool list carries.

id: linear                       # == filename; also the value of `tracker.id` in .fleet/config.json.
name: Linear                     # Human name shown by the wizard and by `fleet trackers list`.

mcp:
  # Any visible tool starting with one of these ⇒ connected. Both routes below produce one of them.
  toolPrefixes: ["mcp__linear__", "mcp__claude_ai_Linear__"]
  install:
    - label: "Add the Linear MCP server to the agent CLI"
      command: "claude mcp add --transport http linear https://mcp.linear.app/mcp"
      instructions: "Then start a new session, run /mcp, choose linear, and sign in when the browser opens. The tools appear in that session once the sign-in completes."
    - label: "Or enable the Linear connector in the desktop / web app"
      instructions: "Settings → Connectors → Linear → Connect, then start a new session. Either route satisfies the detection above; you do not need both."
  docs: https://linear.app/docs/mcp

issueKey:
  pattern: "[A-Z][A-Z0-9]+-[0-9]+"   # team key + number, e.g. ABC-1234
  caseInsensitive: false             # Case-SENSITIVE on purpose: case-insensitively this pattern also
                                     # matches ordinary branch names ("release-2", "testing-2"), and the
                                     # front-matter test asserts no branch name matches in the declared
                                     # case mode. Consequence: a lower-case `abc-1234` typed by the
                                     # operator does NOT match — keys are read and typed as Linear
                                     # shows them.
  example: "ABC-1234"
  derive: null                       # keys are native — every tool below accepts the identifier directly

scope:
  label: team                        # `tracker.scope` is a team name or id; workflow states and team
                                     # labels live on the team.
  required: true                     # the wizard must obtain `tracker.scope` before `fleet up`
  listOp: "list_teams"               # lists scope candidates for the wizard — bare, per the note above

capabilities:
  resolveChildren: true              # op-1  — sub-issues by parent
  cancel: true                       # op-9  — comment, then the configured canceled-type state
  attachLink: true                   # op-8  — `links` on the issue
  listQueue: true                    # op-12 — filtered list, priority-sorted
  comment: true                      # op-11 — top-level comment threads
  createIssue: true                  # op-13 / op-14 / op-16
  labels: true                       # op-17 / op-18 — team and workspace labels, addressed by name
  atomicPatch: true                  # op-15 — native `patch` (ordered, atomic, exactly-once anchors)
  subIssues: true                    # op-23 — `parentId`
  duplicateRelation: true            # op-24 — `duplicateOf` (moves state by itself)
  relations: true                    # op-25 — `relatedTo` / `blocks` / `blockedBy`
  grouping: project                  # op-20 / op-21 — a project attached to the scope team
  imageEmbed: inline                 # op-22 — `![alt](assetUrl)` renders inline in the description
  imageUpload: mcp                   # op-22 — prepare → signed PUT → finalize, all through the connector
  workItems: body                    # op-26 / op-27 — a markdown checklist in the to-do issue's description
  findComplete: page-flag            # op-16 — the response's `hasNextPage`

priority:
  scale: numeric                     # the field is already 1..4; `0` means none and is returned as null
  map: {1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}

states:
  # Names, never ids — op-4 resolves them per team through op-19 at run time. `Canceled` (one `l`) is
  # Linear's spelling of the built-in canceled-type state; keep the spelling your team actually shows.
  in-progress: {promptDefault: "In Progress"}
  in-review:   {promptDefault: "In Review"}
  cancelled:   {promptDefault: "Canceled"}

config: []                           # nothing beyond the scope — no REST transport, no adapter settings
---

# Linear adapter

This is the only file in the plugin that knows what Linear's tools are called, and the only place
Linear's own behaviours are written down. Everything else — the playbooks, the CLI, the docs — speaks
in `op-1` … `op-27` and nothing else. The invariants under each op in `trackers/_template.md` hold
here unchanged; the sections below restate the ones Linear makes easy to violate, and add the ones
Linear introduces. Every one of them was paid for once already.

## Linear in one screen

- **Tool names below are bare.** Linear arrives under more than one connector and each prefixes the
  same tools differently, so a `Call:` line names the bare tool, not one connector's spelling of it.
  Prepend whichever entry of `mcp.toolPrefixes` your own visible tool list carries; if both are
  visible, either works — they are the same server.
- **Keys are native.** `ABC-1234` is the issue identifier, and every tool below that asks for an issue
  accepts it directly — there is no lookup from key to internal id anywhere in this adapter. Responses
  carry both the human key and the internal id (an issue read returns `identifier` + `id`; list rows
  expose the key as `id` and the internal id as `uuid`); the playbooks only ever need the key.
- **The scope is a team.** `tracker.scope` is the team's name or id. Workflow states and team labels
  live on the team; labels can also be workspace-wide (op-17 lists both); projects are workspace
  objects attached to one or more teams, which is why op-21 attaches the scope team explicitly.
- **Tools visible is not server connected.** A session can list every tool below and still receive a
  "not connected" error on its first call — the connector authenticates lazily, and that can race a
  fleet-launch burst. Treat the error exactly like an absent tool: follow the op's `If unsupported:`
  line (reads → the ticket cache, writes → the outbox) and carry on. It is not a bug in your call.
- **Writes echo the whole issue.** Every issue write returns the full issue, so a large body can come
  back as an oversized-result pseudo-error *after the write applied*. The write sections that can hit
  it — op-5, op-13, op-14, op-15 and op-27 — all say the same thing: re-fetch, never blind-retry.
  List calls take `fields` — request only what you need; the echo is the cost of every call.
- **Limits are per workspace, not per session.** Link attachments and uploads draw on one budget
  shared by the whole fleet, so a limit error is contention, not failure: record the key, move on, and
  let the launcher's serial pass finish it when waiting is free.
- **Lists page at 250, projects at 50.** `limit` is a page size; completeness is the response's
  `hasNextPage`, followed through `cursor`. A page of exactly `limit` with no flag is truncated.
- **Priority is already canonical.** The field is `1 Urgent · 2 High · 3 Medium · 4 Low`; `0` means
  none and is returned as `null`, never forced up to a value the tracker does not hold.
- **Nothing here is degraded.** No capability is `false` or `none`. If a project overlay flips one, the
  template's *Degradation rules* apply unchanged — do not redefine them here.

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Call: `list_issues({ parentId: <parentKey>, limit: 250, fields: ["id", "uuid", "title", "priority", "parentId"] })` → the human key of every row in the order returned, following `cursor` while `hasNextPage` is true
If unsupported: the launcher treats the key as a leaf and says so in the `fleet up` output; reads are never queued to the outbox.

Returns the direct sub-issues of a parent so the launcher can fan out **one session per child**
(`fleet up --issues <parent>`, `fleet add <parent>`); sessions never call it. An assigned key is
typically one child of a parent that was split across sessions — a session works **only** its assigned
issue, never the parent, never a sibling — so return leaves only, and an empty array for a leaf.
Linear nests sub-issues to any depth and this call returns exactly one level; when a returned child
is itself a parent, the launcher calls op-1 on it again rather than assigning it. Apply the op-16
completeness rule to the page.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Call: `get_issue({ id: <key> })` → `key = identifier`, `id` = the internal id, `description` = the raw markdown body, `url`, `status` = the state NAME, `priority` = the numeric field as-is (`0` → `null`), `parentId`, `suggestedBranch = gitBranchName`
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

One issue by key. Linear always offers a `gitBranchName`, so the session prefers it and renders
`vcs.branchTemplate` only when it is absent. The return is the contract's shape and nothing more —
`getIssue(key)` takes no options, so the adapter has no place to ask for the relation edges, and an
audit that needs them reads them through op-16 instead. The launcher calls op-2 for every assigned
key **before** spawning and pipes the JSON into `fleet ticket cache --issue <KEY> --from-json -`,
which is what makes the fallback above exist.

⛔ If the tracker tools are not visible in your session — or the first call answers "not connected" —
do **not** stall on that: read the ticket cache and carry on; write a blocked flag
(`fleet flag blocked --category tracker …`) only if that file is missing too — because tracker tools
can race a fleet-launch burst, and every state write you owe meanwhile travels through the outbox, so
nothing is lost by proceeding.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Call: `"me"` → `get_user({ query: "me" })` → `id`; anything else → `list_users({ query: <nameOrEmail>, limit: 250 })` → the single row whose email or name matches exactly → `id`; zero or several matches is an error, never a guess
If unsupported: every assignee-taking write on this tracker also accepts the literal `"me"`, so a session may pass `"me"` straight through without resolving it; for any other ref, `tracker.defaultAssignee` must hold a literal user id set in the **user** layer.

`"me"` means the authenticated tracker user and is the only assignee the playbooks ever ask for,
unless `checker.routing` matches the **defect's** path. Return the opaque `id`, not the email: a
routing entry may name an email, but the ref that gets written is always the id the lookup returned,
because an email that no longer belongs to a workspace member is rejected while an id is stable.

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public. (`fleet config validate` warns on an `@` inside `checker.routing` at project scope for
the same reason.)

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 for `scope`, then pick the state whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → its `id`
If unsupported: op-4 itself is never queued — a session that cannot resolve queues the *write* by its canonical transition name (`fleet outbox add --op setState … '{"state":"cancelled"}'`) and the launcher resolves the ref when it drains; if the configured name matches no state in the scope, the launcher reports it and `fleet up` refuses to start rather than guessing.

Maps the three canonical transitions to a real state in this team. Linear's write accepts a state
**type**, a **name** or an **id**; this op always resolves to the id, because a type matches the first
state of that type and a name can exist in several teams.

⛔ Never hard-code a state id or name in a `Call:`, and never write a state by its *type*; resolve it
every time through the configured scope — because a Linear workspace can hold two states of the same
type (two canceled-type states, one of them effectively destructive and irreversible), and only the
configured name tells them apart.

## op-5 setState

`setState(key, stateRef)`

Call: `save_issue({ id: <key>, state: <stateRef> })` (older builds: `update_issue` with the same arguments), then op-2 to confirm `status` is now the state's name
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the ref and applies it.

One transition. Re-read after writing — the write echoes the whole issue, and on a large body that
echo arrives as the oversized-result pseudo-error while the state already changed; the playbooks
treat "I called setState" as "the state changed", so confirm with op-2 rather than assume, and
never retry on the echo.

## op-6 assign

`assign(key, userRef)`

Call: `save_issue({ id: <key>, assignee: <userRef> })` — `assignee` takes a user id, name, email or `"me"`; pass the id op-3 returned (or the literal `"me"`), never a name
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Assign to the ref op-3 returned. The default is always `"me"`; `checker.routing` is the only thing
that changes it, and it matches on the path of the defect, not the PR that surfaced it. `null`
un-assigns, which nothing in the playbooks ever asks for.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `(tracker.scope, in-review)` → op-5 `(key, stateRef)`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. It is listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context. Linear has no review-*type* state — an
"In Review" state is normally a started-type state your team added — which is exactly why this op
goes through the configured **name** and never through a type.

## op-8 attachLink

`attachLink(key, url, title)`

Call: `save_issue({ id: <key>, links: [{ url: <url>, title: <title> }] })` — `links` is append-only; the PR appears in the issue's links panel and Linear renders a card for it (older builds: `create_attachment({ issueId: <key>, url, title })`)
If unsupported: put the URL on its own line in the body via op-14 (Linear auto-embeds a bare PR URL) and in an op-11 comment; queue to the outbox when tools are down.

Attach the PR URL to the issue. `fleet flag done --pr-url` still carries the URL for the launcher's
report whether or not the attachment landed.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the issue, and
never sleep on it — because the link-attachment budget is per-workspace, so it shrinks exactly as the
fleet grows, and re-creating is how duplicates appear. Several workers once slept twenty minutes each
on this limit for a field a later serial pass attaches in seconds. Record the key, move on, and let
the launcher's serial cleanup pass attach it when waiting is free; a bare PR URL in the body keeps the
association visible meanwhile.

## op-9 cancel

`cancel(key, reason)        (comment FIRST, then state)`

Call: op-11 `(key, <reason, verbatim, with its file:line evidence>)`, **then** op-4 `(tracker.scope, cancelled)` → op-5
If unsupported: op-11 with the same text, then op-10; the done-flag still carries `--outcome cancelled`.

Close an issue as not needed — the defect is already fixed on the base branch, or never existed.

⛔ Comment **first**, then state — because the comment is the record of why a filed bug was deleted
and must stand on its own; a cancel whose state lands first leaves an unexplained closure if the
session dies between the two calls.

⛔ `cancelled` means "already fixed — here is `path:line`" and is **not** the same as `duplicate`
("another session shipped it in a PR that is legitimately in review and must not be closed") —
because an assertion with no line number cannot be acted on and the ticket stays open, while a
duplicate closed as cancelled deletes a live review. A session with live tools performs op-9 itself
and writes `fleet flag done --outcome cancelled --evidence <path:line> --reason …` either way — the
flag is the only thing that survives the session.

⛔ Go through the configured `cancelled` **name**, never the canceled *type* — because a Linear team
can carry a second canceled-type state that behaves like deletion, and a write by type lands on
whichever of the two the team lists first.

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

Call: `save_comment({ issueId: <key>, body: <verbatimText> })` — `body` is markdown passed as literal text (real newlines, no escape sequences); a new top-level thread — never `parentId`, never `id`
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

Never `@`-mention anyone in the body: the playbooks name no person, and a mention turns an evidence
record into a notification for someone the config never routed to.

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason.

⛔ Never truncate text containing issue keys at a raw character offset; cut at a word boundary,
strip trailing `(KEY-` fragments, and wrap every surviving key in backticks — because a cut key
becomes a valid *shorter* key that autolinks to a real, unrelated issue and pollutes it with
backlinks, while the write "succeeds" and looks fine in the echo. Linear autolinks every bare
`ABC-1234` it renders, so this is not hypothetical here.

⛔ Never count your own writes by matching PR-link text in a later read — because Linear rewrites a
markdown PR link into an embed card on save, so the literal text under-counts what you actually
wrote, and the shortfall reads as unfiled work. Count keys, or the `**PR:**` header line, instead.

## op-12 listQueue

`listQueue(selector) → key[]`

Call: `list_issues({ team: <tracker.queue.scope ?? tracker.scope>, state: <id from op-19 whose name equals selector.state ("ready" → checker.ready.state)>, label: <one of selector.labels>, assignee: <selector.assignee ?? tracker.queue.assignee>, project: <selector.group>, limit: 250, fields: ["id", "uuid", "title", "priority", "status", "parentId", "labels"] })`, following `cursor` while `hasNextPage`; with several `labels`, one call per label keeping only keys present in **every** result; drop every row whose `labels` contain any `selector.excludeLabels` entry; sort by `priority` 1 → 4 with `0` (none) last → `key[]`
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside `tracker.queue` / `tracker.scope`, priority-sorted; the launcher writes them to `queue.txt`
for autowave. Linear filters by **one** label per call and has no exclude filter, so `labels[]` is an
**intersection** of calls (a key must appear in every label's result) and `excludeLabels` is applied
to each row's own `labels` field — which is why `labels` is always in `fields`. That intersection is
the **opposite** of op-16, whose `labels[]` is a union; the two share an argument name, not a meaning,
and each op states its own. The default selector excludes `checker.triage.label`, and the result
is only a **candidate** list: `fleet intake check` still refuses any checker-filed ticket that lacks
`gate:passed|waived` when `fleet.queue.requireGate` is on, and counts the refusals — never silently.
Apply the op-16 completeness rule to every page.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Call: `save_issue({ team: <tracker.scope>, title, description: <body>, labels: <names from op-17>, priority: <1..4>, assignee: <id from op-3, or the literal "me">, project: <group id>, parentId: <parent key>, state: <id from op-19 by name (checker.triage.state), omitted for the team default>, links: [{ url, title }] })` → `{ key: identifier, id, url }` — **no `id` argument**: an `id` turns the call into an update (older builds: `create_issue` with the same arguments)
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the issue and records the key.

One issue per finding. `team` is required on create and is always `tracker.scope`. `state?` is
`checker.triage.state` (omit it to take the team's default state); `labels[]` always carry
`checker.triage.label`, `checker.provenanceLabel` and `checker.gate.labels.pending`, and only names
that op-17 returned — on a create `labels` is the full initial set, which is safe because there is
nothing to erase yet; `assignee` is `"me"` unless `checker.routing` matches the defect's path;
`group` is the project **id** from op-20/op-21; `parent` is the a11y umbrella's key when the finding
carries an a11y label. Never pass `template`: a template body replaces the description you wrote.

⛔ The WHO-IS-HARMED test decides whether a `checker.a11y.labels.*` label goes on **at all** — never
what priority a labelled issue gets (once the label is on, `checker.a11y.forcedPriority` is
unconditional). Ask *who is affected if this is never fixed?* Only keyboard users, or only
screen-reader users → apply the label, parent it to the umbrella, force the priority. **Everyone**,
with an a11y dimension as well → do **not** apply the label: file it as an ordinary top-level issue at
its true severity and describe the a11y dimension in the body — because labelling a functional bug
buries it, and under the umbrella rule it now also hides it from the project view entirely, which costs
visibility rather than queue position. Get it right at classification time.

⛔ When the forced priority genuinely understates a labelled finding, say so in the body — *"filed
Low per the standing a11y rule; the review assessed this High because …"* — because the rule then
costs queue position rather than information, and the operator can lift the ones they agree with in
one pass, which they cannot do if every a11y ticket reads as equally trivial.

⛔ Reconcile against the system of record with op-16 at the **start of every filing batch**; never
track "what have I already filed" in a hand-kept file or a running tally — because both drift, and
the failure mode is duplicate tickets, the opposite of what the dedup gates exist for.

⛔ Join filed issues to findings on the `**PR:**` header line or the opaque `fid`, never on title
similarity — because titles are rewritten when filing, so text similarity mis-scored 28 of 100 in
one sweep, while an opaque key cannot drift.

⛔ An oversized "error" echo (`result exceeds maximum … saved to <file>`) usually means the write
**applied** — re-fetch with op-2 or op-16 (search `text` for the `**PR:**` line or the `fid`) before
any retry, never blind-retry — because a blind retry creates a duplicate. When the echo names a saved
result file, that file already holds the new key.

⛔ Priority is set **twice**: the `priority` field and a `**Priority:**` line in the body — because
trackers with `priority.scale: labels|none` have no field to hold it, and for issues whose field is
forced (`checker.a11y.forcedPriority`) the body line is the only channel the assessed severity can
travel on. Linear's field is numeric and canonical, so nothing is mapped here; the body line is still
mandatory.

A failed `links[]` entry is cosmetic (op-8 rule); the issue is created correctly without it.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Call: `save_issue({ id: <key>, title?, description?: <body>, addLabels?: <labels.add>, removeLabels?: <labels.remove>, priority?, state?: <id from op-19 by name; op-4 only when the target is one of the three canonical transitions>, assignee?, parentId?: <parent key>, links? })` — only the fields given; `description` is the whole body (prefer op-15 for a substitution)
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`), never a replacement — because a
replacement erases the labels another pass added (gate labels, a11y labels). `fleet check gate
apply` uses it to mirror `gate:<status>`; the rediscovery rule uses it to append a new call site to
an existing issue (body and comment only — never title or state, so it reads as new evidence).

⛔ Send the delta as `addLabels` / `removeLabels`, never as `labels` — because on an update `labels`
replaces the **full** set and silently removes every label not in the list, which is exactly the
erase the delta rule exists to prevent; the two forms cannot be combined in one call, so there is no
half-way.

⛔ In `/fleet-check`, editing an issue a worker did not create is **launcher-only** — because parallel
writers to one issue overwrite each other, while creating *distinct* issues shares no mutable state
and parallelises cleanly. The line is shared state, not the tracker itself: a working session's
**assigned** issue has exactly one writer — that session — so its own op-14 on it (the `disputed`
label, the op-8 fallback body line) and op-15 (the `⛔ DO NOT` block) are not what this rule guards.

⛔ Rediscovery is a signal, not just a duplicate: when a new finding matches one already filed,
**append** the new call site and PR reference to the existing issue with this op rather than dropping
it — because two slices that share no PRs citing one `file:line` is evidence the finding is real and
the fix belongs in the shared component, and the second sighting is information the first ticket did
not have.

A whole-body `description` write on a large issue trips the oversized echo (op-13 rule); when the
change is a substitution, use op-15, which is atomic and small.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Call: `save_issue({ id: <key>, patch: [{ op: "replace", old_string: <find>, new_string: <replace> }, …] })` → `applied` = `edits.length` when the call succeeds (every anchor matched exactly once), `0` when it is rejected — there is no partial success
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'`.

Find/replace edits against the body; each `find` must match exactly once. This is Linear's native
patch: the edits are applied in order and atomically, and one failing edit aborts the whole save.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ After any downgrade or refutation, re-read the **whole** description and grep it for the old
severity word (`High`, `forever`, `indefinitely`, `permanently`) and the refuted mechanism's key nouns,
then patch every hit; keep useful original text behind a `<details>` block marked refuted rather than
deleting it — because a comment does not correct a description, and a fixer reads the description:
three tickets once had their priority field and title corrected while the body still argued the
original severity and the refuted mechanism.

⛔ Send N edits in **one** call per wave, never one call per edit — because the response echoes the
whole body every time (a 322-row body costs ~25 KB per call), while several edits in one call is
still a single serialized write with no clobber risk.

⛔ At most **50** edits per call — split a larger wave into consecutive calls of 50, each verified by
op-26 before the next — because the call is rejected as a whole above that, and a rejected wave leaves
the mirror stale, which from outside is indistinguishable from a dead run.

⛔ When a patch is rejected, re-read (op-26 / op-2) and re-anchor, never re-send the same edits —
because the only reason it fails is an anchor that no longer matches exactly once (someone else
edited, or an earlier wave already applied it), and re-sending cannot make that anchor match. A
rejection is not the oversized echo: the echo says the result was saved to a file, a rejection is an
error about the patch itself.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Call: `list_issues({ project: <group id>, label: <one label>, priority, state: <id from op-19>, query: <text>, createdAt: <createdAfter>, limit: <≤ 250>, fields: ["id", "uuid", "title", "priority", "status", "statusType", "parentId", "labels", "url"] })` → `issues[]` (each `{ key, id, title, priority, status, statusType, parentId, labels, url }`), `complete = (hasNextPage === false)`; with several `labels`, one call per label and **union** by id (the opposite of op-12's intersection); `parentIsNull` is applied to the returned rows (`parentId == null`) — it is not a server filter
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and must file tracker-less (`localId` rows) — say so in your PR.

Filtered query. `labels[]` here is a **union** — a row appears if it carries any of them — which is
the opposite of op-12's intersection; the only caller that passes several is the a11y re-parent rule
(op-23), every other query passes one label. `complete` is `page-flag`: the response carries
`hasNextPage`, and only an explicit `false` counts. Follow `cursor` when you need the whole set
(reconciliation) and treat "I stopped paging" as `complete: false`. `reconcile.assertComplete()` in
the CLI trusts nothing else.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates.

⛔ Band the query by `priority` (1, 2, 3, 4 — one call each) so each band fits a page, assert
`complete` on **every** band before combining, and print the per-band counts — because a band
silently at its cap is the failure you are looking for.

⛔ Exclude parents structurally with `parentIsNull: true`, never by a list of parent ids — because
an umbrella filed later carries the same labels and priority as its own children and walks straight
into any frame keyed on those; an id list is a snapshot of the parents you knew about when you wrote
it. The rows already carry `parentId`, so this costs nothing.

⛔ When a frame must count only live work, filter on `statusType` (keep the unstarted / started
types, drop `cancelled` and `done`) rather than on a state name — because a name differs per team
while the type does not, and a frame that silently keeps cancelled and duplicate rows reports
coverage it never had.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate. `query` searches title and description, so both the `**PR:** #<n>` header line
and the `fid` are findable with it.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Call: `list_issue_labels({ team: <scope>, limit: 250 })` → `[{ id, name }]`, following `cursor` while `hasNextPage` — the list holds the team's labels **and** the workspace-wide ones, both usable by name
If unsupported: label-driven markers move to body lines (see the template's *Degradation rules*).

`name` is what every write here takes, so return names exactly as listed — case and spacing
included. A label that belongs to a label group is still addressed by its own name, not by
`group/name`; group rows themselves are not labels you can apply.

⛔ Sessions and workers pick labels from this list **only**; nobody invents one — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Call: op-17, return the match by exact `name`; else `list_teams({ query: <scope> })` → the team's `id`, then `save_issue_label({ name, teamId: <that id> })` → `{ id }` — **no `id` argument** on the create; `teamId` is the team's internal id (omit it only to create a workspace-wide label, which the playbooks never ask for). Older builds expose the same create as `create_issue_label` with the same arguments
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`,
`checker.triage.label`, every `checker.gate.labels.*` and both `checker.a11y.labels.*` (the four
`priority.map` names are not created on this adapter — its scale is numeric). A workspace-wide label
of the same name already satisfies the find — never create a team twin of it, because two labels with
one name split every filter that keys on it.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Call: `list_issue_statuses({ team: <scope> })` → `[{ id, name, type }]` with Linear's `type` mapped onto the canonical set — `triage → triage`, `backlog → unstarted`, `unstarted → unstarted`, `started → started`, `completed → done`, `canceled → cancelled`; nothing maps to `review`
If unsupported: reads are never queued; a session with live tools reaches this list through op-4 (for op-7 and op-9), and a session whose tools are down never needs it — its descriptor already carries `tracker.states` by name, and every state write it queues names the canonical transition, which the launcher resolves with live tools when it drains.

Every state in the team with its canonical type. op-4 picks from it; `checker.ready.state`
defaults to the adapter's `unstarted` state. Return **all** states of a type, not the first — op-4
must be able to choose the configured one — and return them in the team's workflow order.

Two Linear facts the defaults must respect. There is no review-*type* state, so `in-review` is
always chosen by **name**. And a team normally has two unstarted-type states (a backlog one and a
to-do one), so the `checker.ready.state` default is ambiguous here — set it explicitly in
`.fleet/config.json` to the name of the state your team treats as "ready to pick up", or promotion
lands on whichever unstarted-type state the team lists first.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Call: `get_project({ query: <ref> })` → `{ id, name, url }` — `query` takes a name, id, identifier or slug and must resolve to exactly one project; when a name is ambiguous, `list_projects({ team: <tracker.scope>, query: <ref>, fields: ["id", "name", "url"] })` and take the single exact-name match
If unsupported: `grouping: none` for this run — there is no group; `checker.provenanceLabel` alone marks the sweep, and the manifest records that the project was not resolved.

Resolves `checker.project` (id, slug or name) once at plan time.

⛔ From then on reference the group by **id** everywhere — in `manifest.json`, in every worker brief,
in every op-13 call — never by name — because names carry apostrophes and change, and a pointer kept
in prose or memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Call: `save_project({ name, addTeams: [<tracker.scope>] })` → `{ id, url }` — **no `id` argument**; at least one team is required on create, and it is always the scope team
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question. Record
the returned `id` in the manifest before a single issue is filed (op-20 rule).

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: native-upload
Transport: mcp
Call: `prepare_attachment_upload({ issue: <key>, filename: <basename of filePath>, contentType: "image/png", size: <exact byte length> })` → `{ uploadRequest: { url, headers }, assetUrl }`; PUT the file's raw bytes to `uploadRequest.url` with **every** `uploadRequest.headers` entry verbatim (name, value and casing) within 60 seconds — the runtime's own `fetch(url, { method: "PUT", headers, body: <bytes> })` is the canonical form on every platform (node ≥ 20 is a plugin requirement); a command-line HTTP client works too, but only one that sends the bytes unmodified and does not rewrite header casing — never base64-encode or otherwise transform the bytes; then finalize with `create_attachment_from_upload({ issue: <key>, assetUrl, title: <caption> })` — required, the third step of the connector's own upload sequence, and what puts the file in the issue's attachments panel; then `url = assetUrl` (bare, exactly as returned) and `embed = "![<alt>](<assetUrl>)"`
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy`, never improvised at filing time. On Linear
that is `native-upload` over the connector: the tracker hosts the image, and it renders inline in the
description of every issue that embeds the same URL. `checker.attachStrategy: assets-branch` forces
the code-host route instead (`fleet assets add <file…> --branch <name>`, branch rendered from
`vcs.assetsBranchTemplate`); on a private repository those images render as broken to anyone not
signed in to the code host — say so on the page that links them. When the strategy falls to `none`,
the body line `_No screenshot attached: <reason>_` is counted **separately** from
`_No UI surface — <reason>_` in the report — because "the app was down" and "there is no screen" are
different outcomes, and lumping them overstates coverage.

⛔ Every issue gets a shot, even one whose defect cannot be reproduced: capture the affected screen in
its normal state and caption it `_Area affected (context, not a repro): <screen/component>._` —
because the shot's job is to orient the reader, not to prove the bug, and a sweep once filed fifteen
issues with no image at all by treating "not reproducible" as "no screenshot".

⛔ The first issue is created **before** its screenshot is uploaded — the order is op-13 (without the
image line) → op-22 → op-15 to patch the `![…](…)` line in — because an upload is prepared *against
an existing issue*, and there is nothing to prepare it against until the create has returned a key.

⛔ Store the **bare** URL — because the tracker re-signs it on read; a signed URL copied forward
expires, and the image dies in every sibling issue that inlined it.

⛔ **One upload per screenshot.** Create the first issue, upload its shot once, then create the sibling
findings with the same `embed` already inlined — because several findings from one PR share one
screen, and per-issue uploads turn a 300-finding sweep into ~900 round-trips.

⛔ The signed upload URL lives about **60 seconds**, and one file must finish (prepare → PUT →
finalize) before the next is prepared — because a second prepare invalidates the first, and a
half-uploaded PNG embeds as a broken image nobody re-checks. Omitting or altering any signed header,
casing included, is a 403 — send the header set exactly as returned, nothing added, nothing renamed.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none.

A deprecated base64 upload path also exists on this connector for tiny files; do not use it — base64
that passes through model-visible text corrupts silently, and the signed PUT costs nothing more.

## op-23 setParent

`setParent(key, parentKey)`

Call: `save_issue({ id: <key>, parentId: <parentKey> })` — `parentId` accepts the identifier; `null` would detach, which nothing here asks for
If unsupported: the umbrella becomes an index issue whose body is a checklist of its children (op-15 / op-14), and each child carries a `**Parent:**` body line plus op-25 when available.

Make `key` a sub-issue of `parentKey`. Its main use is the a11y umbrella (`checker.a11y.umbrella`,
titled `checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the
working queue while keeping **one issue per gap** — a pattern ticket would lose the per-site
file/line/PR that makes each one actionable. Parenting does not move the child between projects or
teams; both stay in the sweep's project.

⛔ The umbrella itself is created **once per sweep**, by the launcher at plan time through op-13:
title exactly `checker.a11y.umbrellaTitle`, `group` = the sweep's project id, priority
`checker.a11y.forcedPriority`, carrying **both** `checker.a11y.labels.*` — because the label queries
and the priority band are how the project view finds the a11y work, and an umbrella filed outside
them sits under a different filter than the very tickets it exists to collect.

⛔ Parenting onto the umbrella is **launcher-only**; a worker passes `parent?` at op-13 time only for
issues it creates itself — because the umbrella is shared state.

⛔ When re-parenting retroactively, query each a11y label with op-16 (one call per label — Linear
filters by a single label) and **union the two result sets by id** before iterating — because the two
label queries overlap heavily, and iterating both issues duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over parent/child when two findings
carry different severities — because nesting an Urgent under a High buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Call: op-11 `(key, <evidence, verbatim, naming ofKey in backticks>)`, **then** `save_issue({ id: <key>, duplicateOf: <ofKey> })` — the relation moves the issue into the team's duplicate state by itself; never a `state` in the same call
If unsupported: op-11 with the same evidence, then op-4 `(tracker.scope, cancelled)` → op-5, with `Duplicate of \`<ofKey>\`` as the comment's first line; if `cancel` is also `false`, op-11 then op-10.

⛔ Comment **first**, then the relation — because the relation moves state on its own and setting the
duplicate state first fails on this tracker (the state is a consequence of the relation, not an input
to it); the evidence comment is mandatory and the relation is the bonus.

⛔ Never decide a duplicate by title similarity; compare the **mechanism** — same function, same
missing guard, same line — because true pairs routinely have completely different titles, unrelated
findings on one large file often have similar ones, and a wrong merge silently deletes a tracked bug,
which is worse than a duplicate sitting in the backlog.

⛔ "Shares the fix" is a hypothesis, not a verdict — check that both fixes touch the same file before
accepting it — because cross-app pairs almost never merge; one composite folded in three siblings whose
fixes landed in three different apps. Verify that the second site actually *calls* the shared thing —
one ticket claimed a shared-primitive fix covered a dialog that inlined the primitive with its styling
hand-copied, so the fix could never reach it — and when the claim is wrong, **comment the correction
on the ticket** with op-11 — because left alone that sentence makes someone close a second issue that
was never fixed.

⛔ A cross-reference usually argues **against** a merge — `Sibling: \`ABC-1234\`` means the filer
split one PR's findings deliberately and cross-linked them — because in one audit every sampled
sibling pair was exactly that; sample the sibling / related bulk rather than judging all of it, and
spend the real effort on the `same` / `shares-fix` claims.

When an audit needs the count of merged pairs, count the rows op-16 returns whose `statusType` is
`cancelled` together with the evidence comment this op makes mandatory — never the state name, which
several unrelated closures share.

## op-25 relate

`relate(key, otherKey, kind, note)`

Call: `save_issue({ id: <key>, relatedTo: [<otherKey>] })` for `related` and every partial-overlap shape; `save_issue({ id: <key>, blocks: [<otherKey>] })` when `kind` is `blocks` (`blockedBy` for its inverse) — all append-only; then op-11 `(key, note)` and op-11 `(otherKey, note)`
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. `kind` is whatever the playbook passes
(`related`, `blocks`, and the partial-overlap shapes: partial location overlap, sequential-not-shared,
same-class-disjoint-sites); Linear has exactly three relation vocabularies — related, blocks and
duplicate — so every overlap shape maps to `relatedTo` and the note carries which shape it is. When a
pair is judged *distinct* but the two name a shared line or a causal link, relate them and put the
"who owns which sites" note on **both** — because a distinct verdict that still needs an action is
silently lost otherwise, and closing one ticket half-closes the other's sites.

⛔ Residue that is a **different defect** the host ticket does not contain gets its **own ticket**
(op-13), related to the host with this op — never only a comment on the host — because a comment
inherits the fate of its issue, and a downgraded host is first in line to be closed, so closing it
silently closes the discovery. A correction to the host's own claim stays in the comment.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Call: op-2 `(key)` → parse every body line matching `^- \[( |x|X)\] ` whose remainder holds `#(\d+)` or a PR URL ending in `/pull/(\d+)` → `{ pr, done: <x or X>, keys: <backticked keys on the line>, raw: <the untouched line> }`
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the to-do issue, in the `body`
shape: a markdown checklist in the description, one PR per line. Linear may render a PR link as an
embed card, but the description text you read back still holds the line — match on the number either
way. `raw` is the exact line op-27 will anchor its edit on, so return it byte-for-byte. Rows already
ticked `- [x]` are done: skipping them is what makes a sweep resumable and backtrackable.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Call: op-15 `(key, [{ find: <the raw line op-26 returned for pr, byte-for-byte>, replace: <that line with its leading "- [ ] " turned into "- [x] " and " (\`<key1>\`, \`<key2>\`)" appended> }, …])` — one call per wave carrying every PR resolved in it, at most 50 edits per call; the anchor is always the whole `raw` line, whether it holds `#<pr>` or a PR URL
If unsupported: the tick stays queued — `fleet check ledger append` writes the mirror op into the launcher's outbox and it is drained on the first monitor turn with live tools; the ledger is already right meanwhile.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op the
instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells them
the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from the
shared ledger — because parallel writers to one description overwrite each other, and a bookkeeping
step attached to one execution path dies when the path changes (the tick once vanished the day filing
moved to subagents while the ledger append survived).

⛔ Anchor on the **whole** `raw` line op-26 returned, never on the leading `- [ ] #<n>` alone, and
backtick-wrap every key you append — because `- [ ] #12` is a prefix of `- [ ] #123 …`, so a
bare-number anchor matches twice on a list holding both and op-15 rejects the entire wave; a bare
`#<n>` also appears inside other PR titles on the same list; and an unwrapped key autolinks.

⛔ Patch, never a whole-body rewrite — because patches are atomic and cannot clobber a concurrent
edit. `atomicPatch` is true here, so the tick needs no pool lock; `fleet check tick` still serialises
it through the launcher.

⛔ Verify a backfill by re-fetching (op-26) and counting ticked rows, never by retrying — because a
whole-description backfill trips the oversized echo and the write applied anyway; a blind retry is how
duplicate trackers get made. At any point the ticked-row count must equal the ledger's line count —
`fleet check tick plan` prints the difference.

## Pre-PR checklist

Run through every line before opening the pull request. `test/tracker-registry.test.mjs` iterates
`trackers/*.md` and asserts the structural lines (op sections, `Call:` / `If unsupported:` /
`Strategy:` presence, `id`, the key pattern against branch names, capability parity), and
`test/docs-redaction.test.mjs` + `test/playbook-brands.test.mjs` assert redaction and tool-name
placement, so those misses fail CI rather than someone's fleet; the rest is on you.

- [ ] `id` equals the filename without `.md`.
- [ ] `issueKey.pattern` compiles, matches `issueKey.example`, and matches **nothing** in a normal
      branch name — check it, in the declared case mode, against the base branch, `testing`,
      `testing-2`, a `check/<sweepId>/<slice>` branch, and a branch rendered from `vcs.branchTemplate`
      with the key removed. It is also the regex the launcher's reclaim watcher uses to read keys from
      its own flags and descriptors (contract §4 — they carry the key exactly as the tracker shows it,
      never a branch name, which `vcs.branchTemplate` renders with `{key-lower}` and a case-sensitive
      pattern cannot read), so a false match costs a real session.
- [ ] Every capability that is `true` (or not `none`) has a non-empty `## op-<n>` section with a
      `Call:` line and an `If unsupported:` line; every `false`/`none` capability has **no** section and
      is covered by a row in the template's *Degradation rules*. Parity is asserted in both directions.
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
- [ ] No tracker tool name appears anywhere except `Call:` lines and `scope.listOp`; no real issue key,
      PR number, person or company appears anywhere, and no product other than this adapter's own
      tracker (and the runtime the plugin already requires) — placeholders otherwise (`ABC-1234`,
      `github.com/acme/app`, `ada`, `the operator`, `2026-03-14`).
- [ ] Every `⛔` rule you restated kept its one-sentence *why*; none was weakened.
- [ ] `fleet trackers show <id>` renders the adapter without warnings, and `node --test` passes.
