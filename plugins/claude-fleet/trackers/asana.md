---
# trackers/asana.md — the bundled Asana adapter. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens the file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line. A project overlay at
# <repo>/.fleet/trackers/asana.md replaces this file wholesale.

id: asana                        # == filename without `.md`; the value of `tracker.id` in .fleet/config.json.
name: Asana

mcp:
  # Any visible tool starting with one of these proves the Asana MCP server is connected. The first is
  # what `claude mcp add asana …` produces; the second is the hosted connector's prefix. The session's own
  # visible tool list is the only reliable connection check — MCP config files on disk are not (a machine
  # can list zero servers while the tools are live in-session).
  toolPrefixes: ["mcp__asana__", "mcp__claude_ai_Asana__"]
  # Rendered VERBATIM by the first-run wizard when no prefix is visible. The official server authenticates
  # with OAuth; sections, tags, subtasks, dependencies and attachments have NO MCP tool, so the REST
  # transport (a personal access token) is required as well, not optional.
  install:
    - label: "Connect the official Asana MCP server"
      command: "claude mcp add --transport http asana https://mcp.asana.com/v2/mcp"
      instructions: "Open a new session, run /mcp, and complete the browser sign-in; the tools appear in the next session. The older https://mcp.asana.com/sse endpoint is the deprecated v1 beta — do not use it."
    - label: "Create a personal access token for the REST transport"
      instructions: "In Asana: My settings → Apps → Developer apps → Personal access tokens → create one. Export it under the environment variable you name in tracker.rest.tokenEnv. It is a user-layer secret: never in .fleet/config.json."
  docs: https://developers.asana.com/docs/mcp-server

issueKey:
  # Asana tasks carry no human key — only a numeric gid — so the fleet's `<KEY>` is the task gid
  # (`derive: gid`, read from op-2). The lookarounds keep a run of digits inside a longer alphanumeric
  # token (the sha1 in a `check/<sweepId>/<slice>` branch) from reading as a key; the 12-digit floor
  # rules out ports, dates and PR numbers while still admitting the shorter gids older workspaces
  # issue. A workspace whose gids are shorter still can widen the floor in a project overlay — the
  # cost of a floor that is too high is a key the reclaim watcher cannot read at all, and the cost of
  # one that is too low is a branch misread as a key, which costs a real session. Branches render as
  # `ada/1201234567890123-<slug>`, assets as `assets-1201234567890123`.
  pattern: "(?<![0-9A-Za-z])[0-9]{12,20}(?![0-9A-Za-z])"
  caseInsensitive: false
  example: "1201234567890123"
  derive: gid

scope:
  label: workspace                 # Tags, search, user lookup and project creation are all workspace-scoped.
  required: true
  listOp: "mcp__asana__get_me"     # The current user's record carries their workspace memberships
                                   # ({gid, name}); the wizard lists those. The only place besides a
                                   # `Call:` line where a tool may be named.

capabilities:
  resolveChildren: true            # op-1  — subtasks of the parent task.
  cancel: true                     # op-9  — comment, then the cancelled tag, then `completed: true`.
  attachLink: true                 # op-8  — an `external` attachment (name + url) on the task.
  listQueue: true                  # op-12 — the open tasks of the queue project, filtered by section and tags.
  comment: true                    # op-11 — a story on the task, plain `text`.
  createIssue: true                # op-13/14/16.
  labels: true                     # op-17/18 — workspace tags.
  atomicPatch: false               # op-15 stays, emulated: `notes` is replaced whole by PUT, so read-modify-write
                                   # under the 1-slot `tracker-worklist:<KEY>` pool lock.
  subIssues: true                  # op-23 — setParent.
  duplicateRelation: true          # op-24 — comment, then the duplicate tag, then `completed: true`.
  relations: true                  # op-25 — a dependency for `blocks`; a comment on both for every other kind.
  grouping: project                # op-20/21 — a project in the workspace; its sections are the states.
  imageEmbed: attachment           # op-22 — a file attachment plus a caption sentence in `notes`; no inline image.
  imageUpload: rest                # op-22 — a multipart upload over the REST transport; there is no MCP upload tool.
  workItems: children              # op-26/27 — one subtask per PR under the to-do task; `completed: true` ticks it.
  findComplete: page-flag          # op-16 — `next_page: null` on the paged listings (search has no flag at all).

priority:
  # Four workspace tags, created by op-18 at plan time. Tags work on every workspace tier. An enum
  # custom field is the native alternative, but it is a premium feature and needs a per-workspace field
  # gid, so the bundled adapter stays on tags; a workspace that has the field can carry `priority.scale:
  # named` and the field gid in a project overlay, which replaces this file wholesale.
  scale: labels
  map: {1: "priority: urgent", 2: "priority: high", 3: "priority: medium", 4: "priority: low"}

states:
  # `in-progress` and `in-review` are SECTION names inside the state project (op-19 resolves them per
  # project — section gids differ per project, names are what op-19 returns). `cancelled` is a TAG name:
  # Asana has no cancelled status, so cancelled = that tag plus `completed: true`, in that order (op-5).
  in-progress: {promptDefault: "In Progress"}
  in-review:   {promptDefault: "In Review"}
  cancelled:   {promptDefault: "cancelled"}

config:
  - key: tracker.queue.scope
    prompt: "Project gid whose sections are the fleet's states and whose open tasks form the working queue (leave blank to run from explicit keys)"
    detect: null
    required: false
  - key: tracker.rest.baseUrl
    prompt: "Base URL of the Asana REST API (sections, tags, subtasks, dependencies and attachments have no MCP tool)"
    detect: "https://app.asana.com/api/1.0"
    required: true
  - key: tracker.rest.tokenEnv
    prompt: "Name of the environment variable that holds your Asana personal access token (user layer only — never the project file)"
    detect: "ASANA_ACCESS_TOKEN"
    required: true
  - key: tracker.settings.team
    prompt: "Team gid that owns the projects the fleet creates (organizations require one; leave blank in a plain workspace)"
    detect: null
    required: false
  - key: tracker.settings.duplicateTag
    prompt: "Tag name that marks a task closed as a duplicate (kept distinct from the cancelled tag)"
    detect: "duplicate"
    required: false

rest:
  # Both values are CONFIG KEYS to read, not literals. The token key is user-scope and SECRET: it is never
  # written to the project file (`fleet config validate` errors on it) — only to the user layer or the environment.
  baseUrlKey: tracker.rest.baseUrl
  tokenEnv: tracker.rest.tokenEnv
---

# Asana adapter

Asana has tasks, not issues; projects with sections, not statuses; tags, not labels; and a numeric gid,
not a key. This file is where those differences live. Everything else in the plugin — the playbooks, the
CLI, the docs — speaks in the 27 operation names (`op-1` … `op-27`) and nothing else, so a session never
needs to know any of what follows until it opens the section the playbook named.

## How the fleet's model lands on Asana

| fleet term | here |
| --- | --- |
| issue, `<KEY>` | a task; `<KEY>` **is the task gid** (`issueKey.derive: gid`), e.g. `1201234567890123` |
| scope (`tracker.scope`) | the workspace gid — tags, search, users and project creation are workspace-scoped |
| group (`checker.project`, op-20/21) | a project in the workspace |
| the **state project** | the project whose sections are the fleet's states: `tracker.queue.scope` when set; for a sweep, the group id the manifest recorded; for a transition on an arbitrary key, the project from op-2's `memberships[]` (prefer the membership in `tracker.queue.scope`) |
| state: `in-progress`, `in-review`, triage, ready | a **section** of the state project, addressed by name through op-19 |
| state: done | `completed: true` |
| state: `cancelled` | the tag named `tracker.states.cancelled` **plus** `completed: true` |
| duplicate | the tag named `tracker.settings.duplicateTag` plus `completed: true`, after the evidence comment |
| label | a workspace tag |
| priority 1..4 | one of the four `priority.map` tags |
| child / sub-issue | a subtask (`parent`) |
| work item (op-26/27) | one subtask per PR under the to-do task; `completed: true` ticks it |
| PR link (op-8) | an `external` attachment (name + url) |
| screenshot (op-22) | a file attachment plus a caption sentence in `notes` |
| relation (op-25) | a dependency for `blocks`; a comment on both tasks for every other kind |
| assignee `"me"` | the gid op-3 returns for `"me"`; write endpoints also accept the literal `"me"` |

A **stateRef** (what op-4 returns and op-5 consumes) has one of three shapes: `section:<gid>`,
`completed`, or `tag:<gid>`.

**Conventions every `Call:` below assumes.**

- **Transport lines.** Every op that makes a call of its own declares one. `Transport: mcp` means an
  MCP tool is the primary call and its REST twin is named on the same `Call:` line, so the launcher can
  drain the outbox on a machine where the MCP is down. `Transport: rest` means Asana exposes no MCP tool
  for that operation at all — sections, tags, subtask listing, dependencies and attachments are all in
  that class. Four ops mix the two, and say so: `Transport: rest + mcp` is a **branching** op
  whose branches split — the branch that has an MCP tool names it as an `(MCP twin …)` on the `Call:`
  line and every other branch is REST-only (op-5, op-14, op-16) — and `Transport: mcp + rest` is an op
  whose call is two mandatory halves, an MCP call **then** a REST-only one that no MCP tool can make
  (op-21). op-4, op-7, op-9 and op-10 declare none: they are compositions of other ops, or no call.
- **MCP.** The official server documents its tool *names* but not their parameters — the server's
  advertised tool schema is authoritative and may evolve. The argument names written in `Call:` lines
  are the REST field names the tools wrap (`name`, `notes`, `assignee`, `completed`, `memberships`,
  `tags`, `parent`, `opt_fields`, …); read that schema once per session and map them.
- **REST** (`Transport: rest`). Base URL from `{tracker.rest.baseUrl}`; header
  `Authorization: Bearer <value of the env var named by tracker.rest.tokenEnv>`; JSON bodies are wrapped
  `{"data": {…}}` and responses arrive under `data`; list endpoints take `limit=1..100` and `offset`, and
  return `next_page` (`{offset, path, uri}` or `null`). Issue the calls with `curl.exe` or Node's
  `fetch` — both exist on every platform the fleet runs on; in Windows PowerShell the bare name `curl`
  is an alias for `Invoke-WebRequest`, which takes different arguments and cannot issue these requests,
  so never write the bare alias and never a shell-specific recipe.
- **Bodies are plain text.** `notes` (tasks) and `text` (comments) are stored and returned literally —
  the markdown the fleet writes (`**PR:** #<n>`, `**Priority:**`, backticked keys, the
  `_No UI surface — <reason>_` sentence) survives verbatim, which is exactly what the join rules need.
  `html_notes` / `html_text` are XML-valid HTML alternatives the fleet never writes.

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/tasks/<parentKey>/subtasks?limit=100&opt_fields=gid,name,completed` → follow `next_page.offset` until `next_page` is `null` → the `gid` of every subtask whose `completed` is `false`, in returned order
If unsupported: the launcher treats the key as a leaf and says so in the `fleet up` output; reads are never queued to the outbox.

Returns the direct subtasks of a parent so the launcher can fan out **one session per child**
(`fleet up --issues <parent>`, `fleet add <parent>`); sessions never call it. An assigned key is
typically one subtask of a parent that was split across sessions — a session works **only** its assigned
task, never the parent, never a sibling — so return leaves only, skip completed subtasks (finished
work), and return an empty array for a leaf. Asana nests subtasks to any depth and this call returns
exactly one level; when a returned subtask is itself a parent, the launcher calls op-1 on it again
rather than assigning it. Apply the op-16 completeness rule to the page.

⛔ Never point `fleet up --issues` at a sweep's to-do task — because with `workItems: children` its
subtasks are the per-PR work items of op-26, not tickets, and the fan-out would spawn one session per
PR row with no defect to fix.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Transport: mcp
Call: `mcp__asana__get_task` on `<key>` with `opt_fields: "name,notes,permalink_url,completed,parent.gid,assignee.gid,tags.gid,tags.name,memberships.project.gid,memberships.section.gid,memberships.section.name,created_at"` (REST twin `GET {tracker.rest.baseUrl}/tasks/<key>?opt_fields=…`) → `key = id = gid`, `title = name`, `description = notes` (raw text), `url = permalink_url`, `status` = the `section.name` of the membership in the state project — or, when `completed` is true, the cancelled tag's name if present, the duplicate tag's name if present, else `Completed` — `priority` = the `priority.map` value whose tag is present → 1..4 (`null` when none), `parentId = parent.gid`; no `suggestedBranch`
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

One task by gid. Asana suggests no branch, so the session renders `vcs.branchTemplate`. The launcher
calls op-2 for every assigned key **before** spawning and pipes the JSON into
`fleet ticket cache --issue <KEY> --from-json -`, which is what makes the fallback above exist.

⛔ If the tracker tools are not visible in your session, do **not** stall on that — read the ticket
cache and carry on; write a blocked flag (`fleet flag blocked --category tracker …`) only if that
file is missing too — because tracker tools can race a fleet-launch burst, and every state write you
owe meanwhile travels through the outbox, so nothing is lost by proceeding.

⛔ Always pass `opt_fields` — because the compact task record omits `notes`, `memberships`, `tags` and
`permalink_url`, so a call without it returns a title and nothing to work from, and the miss looks like
an empty ticket rather than a bad request.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Transport: mcp
Call: `"me"` → `mcp__asana__get_me` → `gid` (REST twin `GET {tracker.rest.baseUrl}/users/me`); an email or a gid → `mcp__asana__get_user` on `<nameOrEmail>` → `gid` (REST twin `GET {tracker.rest.baseUrl}/users/<email or gid>` — the path segment takes `me`, an email, or a user gid); a display name → `mcp__asana__get_users` for `<tracker.scope>` (REST twin `GET {tracker.rest.baseUrl}/workspaces/<tracker.scope>/users?limit=100&opt_fields=gid,name,email`, paged) → the **single** exact match's `gid`
If unsupported: for `"me"`, the REST twin on the `Call:` line above; if neither transport is up, `tracker.defaultAssignee` must hold a literal gid set in the **user** layer.

`"me"` means the authenticated tracker user and is the only assignee the playbooks ever ask for,
unless `checker.routing` matches the **defect's** path. Return the gid, not the email — the write
endpoints accept `"me"` and an email on `assignee`, but the descriptor, the outbox and the manifest
need a ref that does not change when someone changes their address. A display name is not a ref here:
it resolves only through the workspace user list on an exact, single match, and an ambiguous name is
refused rather than guessed.

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public.

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 for the **state project** (see the table above), then pick the entry whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → its `id`: `section:<gid>` for `in-progress` and `in-review`, `tag:<gid>` for `cancelled`
If unsupported: do not resolve in-session — queue the transition **by name** (`fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'`) and the launcher resolves the ref with its own transport.

Maps the three canonical transitions to a real ref. It is its own step because sections are **per
project** — the same name is a different gid in every project, and a task multi-homed into several
projects has a section in each — and because `cancelled` is not a section at all but a tag paired with
`completed` (op-5 knows the order).

⛔ Never hard-code a section or tag gid in a `Call:`; resolve it every time through the configured
scope — because a tracker can hold two states of the same type (a project with two sections both
carrying the configured in-review name, a workspace with two tags of one name, one of them the
cancelled tag whose paired `completed: true` takes the task out of every queue, list and report), and
only the configured name — resolved to the gid the launcher recorded — tells them apart.

## op-5 setState

`setState(key, stateRef)`

Transport: rest + mcp
Call: by ref shape — `section:<gid>` → `POST {tracker.rest.baseUrl}/sections/<gid>/addTask` `{"data":{"task":"<key>"}}` (when op-2 shows the task is not yet in that section's project: `POST {tracker.rest.baseUrl}/tasks/<key>/addProject` `{"data":{"project":"<project gid>","section":"<gid>"}}` instead); `completed` → `PUT {tracker.rest.baseUrl}/tasks/<key>` `{"data":{"completed":true}}` (MCP twin `mcp__asana__update_tasks` on `<key>` with `{completed: true}`); `tag:<gid>` → `POST {tracker.rest.baseUrl}/tasks/<key>/addTag` `{"data":{"tag":"<gid>"}}` **then** the `completed` write — then op-2 to confirm `status` changed
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the ref and applies it.

One transition. Re-read after writing: the section-move write answers with an empty record whether or
not the task moved, and a task that is not a member of the section's project is left where it was — the
playbooks treat "I called setState" as "the state changed", so the op-2 read is what makes that true.

⛔ For `cancelled`, the tag lands **first** and `completed: true` second — because a completed task
without the tag is indistinguishable from shipped work in every list, search and report, while a tagged
task that is still open visibly says "being cancelled"; if the session dies between the two writes the
mirror still tells the truth.

Completion never moves a task between sections, and a section move never completes it — the two axes
are independent here, so `done` is always `completed`, never a section named "Done".

## op-6 assign

`assign(key, userRef)`

Transport: mcp
Call: `mcp__asana__update_tasks` on `<key>` with `{assignee: <userRef>}` (REST twin `PUT {tracker.rest.baseUrl}/tasks/<key>` `{"data":{"assignee":"<userRef>"}}`)
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Assign to the gid op-3 returned. The default is always `"me"`; `checker.routing` is the only thing
that changes it, and it matches on the path of the defect, not the PR that surfaced it. A task has one
assignee; assigning replaces the previous one.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `(state project, in-review)` → op-5 `(key, section:<gid>)`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. It is listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context. In review is a **section**: the task stays
open (`completed: false`) — only a merge, a cancel or a duplicate verdict ever completes it.

## op-8 attachLink

`attachLink(key, url, title)`

Transport: rest
Call: `POST {tracker.rest.baseUrl}/attachments` as `multipart/form-data` with fields `parent=<key>`, `resource_subtype=external`, `name=<title>`, `url=<url>` → `{gid, name, permanent_url}`; the link appears in the task's attachments panel
If unsupported: put the URL on its own line in `notes` via op-14 (Asana renders a bare URL in `notes` as a link) and in an op-11 comment; queue to the outbox when tools are down.

Attach the PR URL (`https://github.com/acme/app/pull/<n>`) to the task with the PR title as its name.
`name` and `url` are both required for an `external` attachment; there is no MCP tool for this.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the issue, and
never sleep on it — because the request budget is shared by every session authenticating with one
token, so it shrinks exactly as the fleet grows, and re-creating is how duplicates appear. Record the
key, move on, and let the launcher's serial cleanup pass attach it when waiting is free; a bare PR URL
in `notes` keeps the association visible meanwhile.

## op-9 cancel

`cancel(key, reason)        (comment FIRST, then state)`

Call: op-11 `(key, <reason, verbatim, with its file:line evidence>)`, **then** op-4 `(state project, cancelled)` → op-5 `(key, tag:<gid>)` — the cancelled tag, then `completed: true`
If unsupported: op-11 with the same text, then op-10; the done-flag still carries `--outcome cancelled`.

Close a task as not needed — the defect is already fixed on the base branch, or never existed.

⛔ Comment **first**, then state — because the comment is the record of why a filed bug was deleted
and must stand on its own; a cancel whose state lands first leaves an unexplained closure if the
session dies between the two calls.

⛔ `cancelled` means "already fixed — here is `path:line`" and is **not** the same as `duplicate`
("another session shipped it in a PR that is legitimately in review and must not be closed") —
because an assertion with no line number cannot be acted on and the ticket stays open, while a
duplicate closed as cancelled deletes a live review. A session with live tools performs op-9 itself
and writes `fleet flag done --outcome cancelled --evidence <path:line> --reason …` either way — the
flag is the only thing that survives the session.

⛔ Never cancel by deleting — this adapter has no delete path on purpose — because a delete takes the
evidence comment, the attachments and every subtask with it and cannot be undone when the cancel was
wrong, while the tag plus `completed` is reversible and still answers every search.

## op-10 leaveOpen

`leaveOpen(key)             (explicit non-action)`

Call: none — no tracker call is made
If unsupported: always supported.

An explicit decision to leave the task as it is, recorded in the done-flag (`--outcome duplicate`
or `--outcome no-code-change`) so the launcher's report can tell "left open on purpose" from "the
session died". It exists so the flag grammar can distinguish `cancel` from `leaveOpen` — the very
distinction the playbooks insist on.

## op-11 comment

`comment(key, verbatimText) (never paraphrased)`

Transport: mcp
Call: `mcp__asana__add_comment` on `<key>` with `{text: <verbatimText>}` (REST twin `POST {tracker.rest.baseUrl}/tasks/<key>/stories` `{"data":{"text":"<verbatimText>"}}`) → a story with `gid`
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

Always `text`, never `html_text`: `text` is stored literally, whereas `html_text` must be XML-valid
HTML inside `<body>`, and escaping a verbatim comment to survive that is exactly the "cleaning up" the
rule below forbids. Markdown is not rendered in a story — backticks and `**` stay visible, which is
fine; they are there for the next reader's parser, not for looks.

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason.

⛔ Never truncate text containing issue keys at a raw character offset; cut at a word boundary,
strip trailing fragments, and wrap every surviving key in backticks — because a cut key becomes a valid
*shorter* key: here a 16-digit gid cut to 15 is still a well-formed gid, and a `permalink_url` cut
inside its trailing number still resolves — to a different task, or to nothing — while the write
"succeeds" and looks fine in the echo.

## op-12 listQueue

`listQueue(selector) → key[]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/projects/<selector.group ?? tracker.queue.scope>/tasks?completed_since=now&limit=100&opt_fields=gid,name,parent.gid,assignee.gid,tags.name,memberships.project.gid,memberships.section.name` → follow `next_page.offset` until `next_page` is `null` (`completed_since=now` returns only open tasks) → keep rows whose section **in this project** equals `selector.state`, whose `tags[].name` include every `selector.labels` entry and none of `selector.excludeLabels`, and whose `assignee.gid` equals op-3 `(selector.assignee)` when one is given → sort by the `priority.map` tag (1 first, untagged last) → gids
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`; with neither `tracker.queue.scope` nor `selector.group` set there is no project to list and the launcher says so.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside the queue project, priority-sorted; the launcher writes them to `queue.txt` for autowave. The
default selector excludes `checker.triage.label`, and the result is only a **candidate** list:
`fleet intake check` still refuses any checker-filed ticket that lacks `gate:passed|waived` when
`fleet.queue.requireGate` is on, and counts the refusals — never silently. Apply the op-16
completeness rule to the page, and use the project listing rather than search for the reason op-16
gives: a ticket promoted a minute ago must be in the queue now.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Transport: mcp
Call: `mcp__asana__create_tasks` with one task `{workspace: <tracker.scope>, name: <title>, notes: <body>, memberships: [{project: <group>, section: <the op-19 entry in <group> whose name equals state? (checker.triage.state), its gid without the "section:" prefix>}] (or projects: [<group>] when state? is unset), tags: [<gids from op-17 for every labels[] name> + <gid of the priority.map[priority] tag>], assignee: <op-3 "me">, parent: <parent>}` (REST twin `POST {tracker.rest.baseUrl}/tasks` `{"data":{…}}`) → `{key: gid, id: gid, url: permalink_url}`; then op-8 once per `links[]` entry
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the task and records the gid.

One task per finding, **one task per call** — the create tool accepts a batch of up to 50, but a
finding's gid must be in `filed/<slice>.tsv` before the next create is attempted, and a batched
response that fails halfway leaves you unable to say which fids landed. `state?` is
`checker.triage.state` (a section of the group project, resolved through op-19 against that project);
`labels[]` always carry `checker.triage.label`, `checker.provenanceLabel` and
`checker.gate.labels.pending`, and only names that op-17 returned; `assignee` is `"me"` unless
`checker.routing` matches the defect's path.

⛔ Reconcile against the system of record with op-16 at the **start of every filing batch**; never
track "what have I already filed" in a hand-kept file or a running tally — because both drift, and
the failure mode is duplicate tickets, the opposite of what the dedup gates exist for.

⛔ Join filed issues to findings on the `**PR:**` header line or the opaque `fid`, never on title
similarity — because titles are rewritten when filing, so text similarity mis-scored 28 of 100 in
one sweep, while an opaque key cannot drift. `notes` returns the header line byte-for-byte, so the join
is a string match.

⛔ An oversized "error" echo (`result exceeds maximum … saved to <file>`) usually means the write
**applied** — re-fetch with op-2 or op-16 before any retry, never blind-retry — because a blind retry
creates a duplicate.

⛔ Priority is set **twice**: the priority tag (through `priority.map`) and a `**Priority:**`
line in the body — because trackers with `priority.scale: labels|none` have no field to hold it, and
for issues whose tag is forced (`checker.a11y.forcedPriority`) the body line is the only channel
the assessed severity can travel on.

⛔ A subtask does **not** inherit its parent's projects — pass `memberships` (or `projects`) on every
*finding* child you create with `parent`, exactly as on a top-level task; the op-26 work items are the
deliberate exception: they carry `parent` only, precisely so they stay out of the project listing —
because a child created with `parent` alone lives only under its parent: it is absent from the group
project's list, from op-12 and op-16, and so from every count and every gate, and the umbrella's
children then read as never filed.

A failed `links[]` entry is cosmetic (op-8 rule); the task is created correctly without it.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Transport: rest + mcp
Call: `title?`/`body?`/`assignee?` → `PUT {tracker.rest.baseUrl}/tasks/<key>` `{"data":{…only the fields given, mapped to name / notes / assignee}}` (MCP twin `mcp__asana__update_tasks` on `<key>` with the same fields); `labels.add[]` → `POST {tracker.rest.baseUrl}/tasks/<key>/addTag` `{"data":{"tag":"<gid from op-17>"}}` per name and `labels.remove[]` → `POST {tracker.rest.baseUrl}/tasks/<key>/removeTag` `{"data":{"tag":"<gid>"}}` per name; `priority?` → `removeTag` the other three `priority.map` tags, `addTag` the one; `state?` → op-4 → op-5; `parent?` → op-23; `links?` → op-8
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`), never a replacement — because a
replacement erases the labels another pass added (gate labels, a11y labels). Asana makes the delta
literal: tags cannot be set through the update body at all, only added and removed one call each.
`fleet check gate apply` uses it to mirror `gate:<status>`; the rediscovery rule uses it to append a
new call site to an existing issue (body and comment only — never title or state, so it reads as new
evidence). `body?` replaces `notes` whole — for anything partial use op-15, which takes the lock.

⛔ Editing an issue you did not create is **launcher-only** — because parallel writers to one issue
overwrite each other, while creating *distinct* issues shares no mutable state and parallelises
cleanly. The line is shared state, not the tracker itself.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Transport: rest
Call: emulated — `fleet pool acquire tracker-worklist:<KEY>` → `GET {tracker.rest.baseUrl}/tasks/<key>?opt_fields=notes` → apply every edit to the text locally (each `find` must match exactly once; an edit that matches zero or several times is skipped and not counted) → `PUT {tracker.rest.baseUrl}/tasks/<key>` `{"data":{"notes":"<new text>"}}` → re-read `notes` and confirm every counted edit is present → `fleet pool release tracker-worklist:<KEY> <slot>` (the slot `acquire` returned) → `applied` = the number of edits confirmed
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'`.

Find/replace edits against `notes`. `atomicPatch` is `false` here: Asana has no patch operation and
`PUT` replaces the body whole, so the adapter emulates it by read-modify-write under the 1-slot
`tracker-worklist:<KEY>` pool, because two unlocked read-modify-writes silently drop one another's
edits. Release the lock immediately after the re-read; nothing else runs under it.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ Send N edits in **one** call per wave, never one call per edit — because the response echoes the
whole task every time (a 322-row body costs ~25 KB per call), while several edits in one call is
still a single serialized write with no clobber risk. Under an emulated patch it is also N times fewer
lock acquisitions, so a wave cannot starve the sessions waiting behind it.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Transport: rest + mcp
Call: `GET {tracker.rest.baseUrl}/projects/<group>/tasks?limit=100&opt_fields=gid,name,completed,created_at,parent.gid,tags.gid,tags.name,memberships.project.gid,memberships.section.name,permalink_url` → follow `next_page.offset` until `next_page` is `null` → filter locally: `labels` ⊆ `tags[].name`, `priority` = the `priority.map` tag, `state` = the section name in `<group>` (or `completed` for done), `parentIsNull` → `parent == null`, `createdAfter` → `created_at` → `issues[]` as `{key: gid, id: gid, title: name, priority, status, parentId: parent.gid}`; `complete = true` only when the final page carried `next_page: null`. `text?` → `GET {tracker.rest.baseUrl}/workspaces/<tracker.scope>/tasks/search?text=<text>&projects.any=<group>&is_subtask=false&tags.any=<gid of the priority.map[priority] tag, one call per band when priority is given>&sort_by=created_at&sort_ascending=true&limit=100` (MCP twin `mcp__asana__search_tasks` with the same filters) → search returns **no** `next_page`, so a page of exactly `limit` rows is truncated: re-query with `created_at.after=<the last row's created_at>` until a page comes back short, and only then `complete = true`. No `group` → `GET {tracker.rest.baseUrl}/tags/<gid of checker.provenanceLabel>/tasks?limit=100&opt_fields=…`, paged the same way
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and must file tracker-less (`localId` rows) — say so in your PR.

Filtered query. `complete` is derived per `capabilities.findComplete: page-flag` — the paged project,
tag and subtask listings carry a real has-more flag (`next_page`), and `reconcile.assertComplete()` in
the CLI trusts nothing else.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates. Search is the endpoint that has no signal; treat every full search page
as truncated.

⛔ Always pass `limit` on every listing call — because the default page is 20 rows and `next_page` is
only present when `limit` was given, so a call without it silently returns the first 20 rows with no
flag at all and looks complete by construction.

⛔ Follow `next_page.offset` immediately and never construct one — because offsets are opaque tokens
that expire as the data changes, and the only recovery from an expired one is to restart the walk from
the first page; a fabricated offset is rejected, and a *stale* one silently skips rows.

⛔ Band by `priority` — on search one call per band, banded on the priority tag (the filter on the
`Call:` line), so each band fits a page; on the project listing page to `next_page: null` and split by
priority tag — assert `complete` on **every** band before combining and print the four counts —
because a band silently at its cap is the failure you are looking for.

⛔ Exclude parents structurally with `parentIsNull: true`, never by a list of parent ids — because
an umbrella filed later carries the same labels and priority as its own children and walks straight
into any frame keyed on those; an id list is a snapshot of the parents you knew about when you wrote it.
The listing rows carry `parent`; search takes `is_subtask=false`.

⛔ Never run the start-of-batch reconcile through search — because a change takes 10–60 seconds to
index (longer during incidents) and search is documented as unsuited to read-your-own-write use, so
the sibling a worker filed a moment ago is invisible and the reconcile re-files it — the exact
duplicate it exists to prevent; the project listing reads your own writes.

⛔ Reconcile a sweep through the **project listing**, never search, once it passes a few hundred
findings — because search results are truncated at roughly 1,000 objects however you page them, so a
large sweep's tail is unreachable by that endpoint and its absence looks like nothing was filed.

Search is a premium feature: on a workspace without it the call answers `402` and there is no `text?`
query at all. Degrade to the project (or tag) listing plus a local substring match over `name` and
`notes` — slower, complete, and it reads your own writes.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate. Because of the indexing lag, wait out at least a minute after the row's timestamp
before trusting an empty search result, then confirm with the project listing.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/workspaces/<scope>/tags?limit=100&opt_fields=gid,name` → follow `next_page.offset` until `next_page` is `null` → `[{id: gid, name}]`, complete per op-16's rule
If unsupported: sessions and workers read the tag gids the launcher recorded in `manifest.json` at plan time; when there is no manifest, label-driven markers move to body lines (see the template's *Degradation rules*).

⛔ Sessions and workers pick labels from this list **only**; nobody invents one — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on.

Tag names are **not unique** in a workspace: two tags can share a name and nothing but the gid tells
them apart. The launcher records the gid it chose (or created) for every marker in `manifest.json`; from
then on every op-13/op-14 call and every priority-tag filter uses that gid, never the name.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Transport: rest
Call: op-17, return the match by exact `name` (the lowest gid when several match, and say so in the plan output); else `POST {tracker.rest.baseUrl}/tags` `{"data":{"workspace":"<scope>","name":"<name>"}}` → `{id: gid}`
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`,
`checker.triage.label`, every `checker.gate.labels.*`, both `checker.a11y.labels.*`, the four
`priority.map` names (`priority.scale` is `labels` here), and — because this adapter's states need
them — the tag named `tracker.states.cancelled` and the tag named `tracker.settings.duplicateTag`.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode. Here
the race is worse than near-duplicate: Asana accepts N tags with the *identical* name, and afterwards
no query can tell them apart.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/projects/<state project>/sections?limit=100&opt_fields=gid,name` → follow `next_page.offset` until `next_page` is `null` → one entry per section `{id: "section:<gid>", name, type}` with `type` = `started` when `name` equals `tracker.states.in-progress`, `review` when it equals `tracker.states.in-review`, `triage` when it equals `checker.triage.state`, otherwise `unstarted`; plus two synthetic entries: `{id: "completed", name: "Completed", type: done}` and `{id: "tag:<gid>", name: <tracker.states.cancelled>, type: cancelled}` where `<gid>` is that tag's gid from op-17
If unsupported: the descriptor's `tracker.states` names plus the section gids the launcher recorded in `manifest.json` at plan time; a session with neither queues its transitions by name (op-5's fallback).

Every state of the state project with its canonical type. op-4 picks from it; `checker.ready.state`
defaults to the first section op-19 types `unstarted` (the first section that is not the triage,
in-progress or in-review name); when `checker.triage.state` is set, name the ready section explicitly
in `checker.ready.state` rather than leaving it implicit. Return **all** sections, not the first
match — op-4 must be able to choose the configured one. Sections belong to projects, not to the
workspace: a `scope` that is the workspace gid has no sections, which is why the state-project
resolution at the top of this file exists.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Transport: mcp
Call: a `ref` that is all digits → `mcp__asana__get_project` on `<ref>` with `opt_fields: "gid,name,permalink_url"` (REST twin `GET {tracker.rest.baseUrl}/projects/<ref>?opt_fields=gid,name,permalink_url`); otherwise `mcp__asana__get_projects` for `<tracker.scope>` (REST twin `GET {tracker.rest.baseUrl}/workspaces/<tracker.scope>/projects?archived=false&limit=100&opt_fields=gid,name,permalink_url`, paged to `next_page: null`) → the **single** exact match by `name` → `{id: gid, name, url: permalink_url}`; zero or several matches is a plan-time failure, reported with the candidate gids
If unsupported: the plan step cannot proceed without a group id and fails fast with a hint (a sweep is never launched against a guessed project); it never asks.

Resolves `checker.project` (gid or name) once at plan time. Project names are not unique in a
workspace, so a name that matches twice is refused rather than picked.

⛔ From then on reference the group by **gid** everywhere — in `manifest.json`, in every worker brief,
in every op-13 call — never by name — because names carry apostrophes and change, and a pointer kept
in prose or memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Transport: mcp + rest
Call: **first half, MCP** — `mcp__asana__create_project` with `{workspace: <tracker.scope>, name: <name>, team: <tracker.settings.team when set>}` (REST twin `POST {tracker.rest.baseUrl}/projects` `{"data":{"workspace":"…","name":"…","team":"…"}}`) → `{id: gid, url: permalink_url}`; **then the second half, REST-only** (sections have no MCP tool) — `POST {tracker.rest.baseUrl}/projects/<gid>/sections` `{"data":{"name":"<name>"}}` once for each of `checker.triage.state`, `checker.ready.state`, `tracker.states.in-progress`, `tracker.states.in-review` (each when set and not already present per op-19), in that order
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question.
Organizations require `team` on project creation — a workspace that is an organization refuses the
call without it, which is what `tracker.settings.team` is for.

⛔ Create the state sections before the first op-13 into a new project — because a fresh project has
none of them, op-19 lists by name inside that project, and a filing whose triage section does not
exist lands in the default section with no triage marker, which `fleet intake check` then cannot gate.
Creating triage first makes it the first section, so even a task filed without `state?` lands there.

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: attachment-only
Transport: rest
Call: `POST {tracker.rest.baseUrl}/attachments` as `multipart/form-data` with a `parent=<key>` field and exactly one part named `file` carrying the PNG bytes at `<filePath>` with `Content-Type: image/png` (optionally a `name=<basename>` field) → `{gid, name, permanent_url, download_url}`; `url = permanent_url`; `embed = "_Screenshot: <alt> — attached to this task as <name>. <caption>_"`; for a sibling finding that reuses the shot, `embed = "_Screenshot: <alt> — see the attachment on task <first key> (<permanent_url>). <caption>_"`; then op-14 `body` (or op-15) to place `embed` where the `![screenshot]` line would go
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy`, never improvised at filing time. Here it is
`attachment-only`: the file goes on the task's attachments panel and the body carries a caption
sentence naming it — no inline image. Asana does allow an inline image in `html_notes`, but only for an
attachment **of that same task**, and the whole body would have to be rewritten as XML-valid HTML — so
inlining would cost one upload per sibling and break the one-upload rule below; the caption keeps it.
The attachment endpoint needs an existing `parent`, so the order is create → upload → update, never
upload-at-create.

⛔ Store the **bare** URL — here that is `permanent_url`, which does not expire (it does require an
active session to resolve), never `download_url` — because the tracker re-signs it on read:
`download_url` may be valid for as little as two minutes from retrieval, and a signed URL copied
forward expires, so the image dies in every sibling issue that inlined it.

⛔ **One upload per screenshot.** Create the first issue, upload its shot once, then create the sibling
findings with the sibling `embed` form from the `Call:` line already inlined — because several findings
from one PR share one screen, and per-issue uploads turn a 300-finding sweep into ~900 round-trips.

⛔ One file per request, and record the returned `gid` and `permanent_url` before starting the next —
because the attachment record is returned only in that response; a response lost to a timeout leaves an
orphan file on the task that no caption names and a caption that names nothing, and the 100 MB cap is
enforced per request, not per task.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none.

`_No screenshot attached: <reason>_` is counted **separately** from `_No UI surface — <reason>_` in
the report, because "the app was down" and "there is no screen" are different outcomes and lumping
them overstates coverage.

## op-23 setParent

`setParent(key, parentKey)`

Transport: rest
Call: `POST {tracker.rest.baseUrl}/tasks/<key>/setParent` `{"data":{"parent":"<parentKey>"}}` → then op-2 `(key)` and, when its `memberships[]` no longer include the group project, `POST {tracker.rest.baseUrl}/tasks/<key>/addProject` `{"data":{"project":"<group>"}}`
If unsupported: the umbrella becomes an index issue whose body is a checklist of its children (op-15 / op-14), and each child carries a `**Parent:**` body line plus op-25 when available.

Make `key` a subtask of `parentKey`. Its main use is the a11y umbrella (`checker.a11y.umbrella`,
titled `checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the
working queue while keeping **one issue per gap** — a pattern ticket would lose the per-site
file/line/PR that makes each one actionable.

⛔ Re-read the child's `memberships[]` after re-parenting and re-add the group project if it is gone —
because the API does not document what re-parenting does to a subtask's project memberships, and a
child that has dropped out of the project is invisible to op-12 and op-16, so it counts as never filed
in every gate that follows.

⛔ Parenting onto the umbrella is **launcher-only**; a worker passes `parent?` at op-13 time only for
issues it creates itself — because the umbrella is shared state.

⛔ When re-parenting retroactively, query each a11y label with op-16 (`group` = the sweep project,
`labels: [<that label>]`) and **union the two result sets by gid** before iterating — because the two
label queries overlap heavily, and iterating both issues duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over parent/child when two findings
carry different severities — because nesting an Urgent under a High buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Transport: rest
Call: op-11 `(key, <evidence, verbatim, first line "Duplicate of \`<ofKey>\` <permalink_url of ofKey>">)`, **then** `POST {tracker.rest.baseUrl}/tasks/<key>/addTag` `{"data":{"tag":"<gid of the tag named tracker.settings.duplicateTag>"}}`, **then** `PUT {tracker.rest.baseUrl}/tasks/<key>` `{"data":{"completed":true}}`
If unsupported: op-11 with the same evidence, then op-4 `(state project, cancelled)` → op-5, with `Duplicate of \`<ofKey>\`` as the comment's first line; if `cancel` is also `false`, op-11 then op-10.

Asana has no duplicate relation. The duplicate tag is what tells a duplicate from a cancel in every
list and every tag query afterwards, the comment is the record that names the original, and
`completed` takes it out of every queue — tag before `completed`, for op-5's reason.

⛔ Comment **first**, then the relation — because the relation moves state on its own and setting the
duplicate state first fails on some trackers; the evidence comment is mandatory and the relation is
the bonus.

⛔ Never decide a duplicate by title similarity; compare the **mechanism** — same function, same
missing guard, same line — because true pairs routinely have completely different titles, unrelated
findings on one large file often have similar ones, and a wrong merge silently deletes a tracked bug,
which is worse than a duplicate sitting in the backlog.

⛔ "Shares the fix" is a hypothesis, not a verdict — check that both fixes touch the same file before
accepting it — because cross-app pairs almost never merge; one composite folded in three siblings whose
fixes landed in three different apps.

## op-25 relate

`relate(key, otherKey, kind, note)`

Transport: rest
Call: `kind = blocks` → `POST {tracker.rest.baseUrl}/tasks/<otherKey>/addDependencies` `{"data":{"dependencies":["<key>"]}}` (`key` blocks `otherKey`, so `otherKey` depends on `key`), then op-11 `(key, note)` and op-11 `(otherKey, note)`; every other `kind` (`related`, the partial-overlap shapes) → op-11 on **both**, each naming the other key in backticks with its `permalink_url` and the `kind`
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. `kind` is whatever the playbook passes
(`related`, `blocks`, and the partial-overlap shapes); the only native relation here is a dependency,
so `blocks` maps onto it and everything else is carried by the two comments. A task can hold at most
30 dependents and dependencies combined — past that the call is refused, and the pair keeps the comments
only (say so in the note). When a pair is judged *distinct* but the two name a shared line or a causal
link, relate them and put the "who owns which sites" note on **both** — because a distinct verdict
that still needs an action is silently lost otherwise, and closing one ticket half-closes the other's
sites.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/tasks/<key>/subtasks?limit=100&opt_fields=gid,name,completed,notes` → follow `next_page.offset` until `next_page` is `null` → for every subtask whose `name` matches `^#(\d+)` → `{pr, done: completed, keys: <every key-shaped token on the "keys:" line of its notes>, raw: "<subtask gid>\t<name>"}`, in returned order; when the to-do task has **no** such subtasks yet, parse its own `notes` for lines matching `^- \[( |x|X)\] #(\d+)` (an operator pasted a plain checklist) and return those with `raw` = the untouched line
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the to-do task, in the
`capabilities.workItems: children` shape: one subtask per PR, named `#<pr> — <title>`, with `parent`
only and **no project** (a work item is not a finding and must stay out of op-12/op-16's project
listing). `fleet check plan` materialises the subtasks from the pasted checklist (op-13 with `parent`
and no `group`) the first time it runs; from then on the subtasks are the mirror. `raw` carries the
subtask gid — the anchor op-27 uses.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Transport: rest
Call: for each PR resolved in the wave, `PUT {tracker.rest.baseUrl}/tasks/<subtask gid from op-26 raw>` `{"data":{"completed":true,"notes":"keys: \`<key1>\`, \`<key2>\`"}}` — one request per subtask, every subtask of the wave in one drain pass; then op-26 to count `done` rows
If unsupported: `workItems: none` — no-op; `fleet check status` is the only progress view.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op the
instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells them
the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from the
shared ledger — because parallel writers to one description overwrite each other, and a bookkeeping
step attached to one execution path dies when the path changes (the tick once vanished the day filing
moved to subagents while the ledger append survived).

⛔ Anchor on the subtask **gid** from op-26's `raw`, never on the `#<n>` in a name, and backtick-wrap
every key you write — because a bare `#<n>` also appears inside other PR titles on the same list, and
in plain-text `notes` two unwrapped 16-digit keys glued by a comma read back as one wrong key.

⛔ Patch, never a whole-body rewrite — because patches are atomic and cannot clobber a concurrent
edit. Here each subtask is its own record, so `completed: true` is atomic by construction and needs no
lock; never rewrite the to-do task's own `notes` checklist to tick — it races the launcher's op-15,
and once the subtasks exist the checklist is not the mirror. `fleet check tick --lock` is harmless on
this shape and still the command to use.

⛔ Verify a backfill by re-fetching (op-26) and counting ticked rows, never by retrying — because a
whole-description backfill trips the oversized echo and the write applied anyway; a blind retry is how
duplicate trackers get made. At any point the ticked-row count must equal the ledger's line count —
`fleet check tick plan` prints the difference.

## Fallbacks every adapter gets for free (do not re-document)

Two mechanisms exist so that a tracker outage, a dropped MCP, or a sandbox without tools never costs a
transition. Adapters name them in `If unsupported:` lines and describe them nowhere else.

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

## Pre-PR checklist

Run through every line before opening the pull request. `test/tracker-registry.test.mjs` iterates
`trackers/*.md` and asserts all of it, so a miss fails CI rather than someone's fleet.

- [ ] `id` equals the filename without `.md`.
- [ ] `issueKey.pattern` compiles, matches `issueKey.example`, and matches **nothing** in a normal
      branch name — check it, in the declared case mode, against the base branch, `testing`,
      `testing-2`, a `check/<sweepId>/<slice>` branch, and a branch rendered from `vcs.branchTemplate`
      with the key removed. It is also the regex the launcher's reclaim watcher uses to read keys, so a
      false match costs a real session.
- [ ] Every capability that is `true` (or not `none`) has a non-empty `## op-<n>` section with a
      `Call:` line and an `If unsupported:` line; every `false`/`none` capability has **no** section —
      except `atomicPatch`, whose op-15 section stays and emulates — and is covered by a row in the
      template's *Degradation rules*. Parity is asserted in both directions.
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
      PR number, person, company or product appears anywhere — placeholders only (this adapter's
      `issueKey.example` for keys, since Asana has no human key, plus `github.com/acme/app`, `ada`,
      `the operator`, `2026-03-14`).
- [ ] Every `⛔` rule you restated kept its one-sentence *why*; none was weakened.
- [ ] `fleet trackers show <id>` renders the adapter without warnings, and `node --test` passes.
