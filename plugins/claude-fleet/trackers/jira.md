---
# trackers/jira.md — Jira adapter for claude-fleet. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens this file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line. Two deployments, one adapter:
# Jira Cloud through the hosted Atlassian MCP server, and self-hosted Jira (Server / Data Center)
# through REST. Every `Call:` line that makes a direct tracker call carries a REST form; the composite
# ops (op-4, op-7, op-9, op-10, op-18) delegate to the ops they name and have none of their own. The
# hosted-MCP form is given wherever the server exposes a tool for that operation (op-8 and op-17 are
# REST-only; op-22 uploads through REST because that is the portable path).

id: jira                         # == filename without `.md`; the value of `tracker.id` in .fleet/config.json.
name: Jira

mcp:
  # If ANY tool visible in the session starts with one of these, the tracker is connected. The visible
  # tool list is the only reliable connection check — MCP config files on disk are not (a machine can
  # list zero servers while the tools are live in-session). Community servers use the other prefixes.
  toolPrefixes: ["mcp__atlassian__", "mcp__jira__", "mcp__claude_ai_Jira__"]
  # Rendered VERBATIM by the first-run wizard when no prefix is visible.
  install:
    - label: "Add the hosted Atlassian MCP server (Jira Cloud)"
      command: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp"
      instructions: "Start a new session, run /mcp, choose the atlassian server and finish the browser sign-in; the Jira tools appear in the next session. Cloud sites only."
    - label: "Self-hosted Jira (Server / Data Center): use the REST transport"
      instructions: "The hosted MCP server cannot reach a self-hosted Jira. Set tracker.rest.baseUrl to your server URL in the project file, and put a personal access token in the environment variable named by tracker.rest.tokenEnv (user layer — never the project file). Every Call: line below that makes a direct tracker call has a REST form; the composite ops delegate to the ops they name."
  docs: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/

issueKey:
  # A Jira key is an upper-case project key (2+ characters; letters, digits, underscore), a hyphen, a
  # number. Case-SENSITIVE on purpose: Jira itself only ever displays keys upper-case, and a
  # case-insensitive match would read `testing-2` (a testing-slot branch) as a key — this regex is also
  # what the launcher's reclaim watcher uses, so a false match costs a real session.
  pattern: "[A-Z][A-Z0-9_]+-[0-9]+"
  caseInsensitive: false
  example: "ABC-1234"
  derive: null                   # keys are native

scope:
  label: project                 # `tracker.scope` is a Jira project KEY (e.g. `ABC`), never an id or a name.
  required: true
  listOp: "mcp__atlassian__listJiraProjects"

capabilities:
  # `attachLink`, `labels` and `imageUpload` need the REST transport (op-8 and op-17 are REST-only —
  # the hosted server exposes no write for either; op-22 uploads through REST because that is the
  # portable path). These values are static declarations, not run-time state: with
  # `tracker.rest.baseUrl` unset — the hosted-MCP-only install path — the transport is simply not
  # configured, and op-8, op-17 and op-22 each take their own `If unsupported:` line.
  resolveChildren: true          # op-1  — JQL `parent = <key>` (plus the legacy Epic Link field when configured)
  cancel: true                   # op-9  — a workflow transition into the configured cancelled status
  attachLink: true               # op-8  — a remote issue link (REST-only)
  listQueue: true                # op-12 — JQL rendered from fleet.queue.selector
  comment: true                  # op-11
  createIssue: true              # op-13 / op-14 / op-16
  labels: true                   # op-17 / op-18 — free-form strings with NO spaces; no create call; the list is REST-only
  atomicPatch: false             # op-15 is emulated: read-modify-write under the `tracker-worklist:<KEY>` pool lock
  subIssues: true                # op-23 — the native `parent` field (subtasks / hierarchy) or the legacy Epic Link field
  duplicateRelation: true        # op-24 — issue link type `Duplicate`; the link does NOT move the status (op-5 does)
  relations: true                # op-25 — issue link types `Relates` / `Blocks`
  grouping: epic                 # op-20 / op-21 — the sweep container is an Epic inside `tracker.scope`
  imageEmbed: inline             # op-22 — wiki-markup `!url!` (v2 bodies) or a markdown image (the hosted MCP converts it)
  imageUpload: rest              # op-22 — multipart POST to the attachments endpoint
  workItems: children            # op-26 / op-27 — one subtask per PR under the to-do issue; comment fallback
  findComplete: page-flag        # op-16 — Cloud answers with `isLast` + a continuation token; self-hosted answers with `total`, which the REST form reduces to the same boolean

priority:
  scale: named                   # Jira's default priority scheme; the names are per-site and op-13 sends them verbatim
  map: {1: "Highest", 2: "High", 3: "Medium", 4: "Low"}

states:
  # NAMES, never ids: op-19 lists the scope's statuses and op-4 picks by name. Jira's default software
  # workflows carry no cancelled status at all — service-desk workflows ship "Canceled"; if yours has
  # "Won't Do" or "Closed" instead, set `tracker.states.cancelled` to that name. With no such status,
  # op-9 records the evidence comment and leaves the transition to the operator (see op-5).
  in-progress: {promptDefault: "In Progress"}
  in-review:   {promptDefault: "In Review"}
  cancelled:   {promptDefault: "Canceled"}

config:
  - key: tracker.settings.cloudId
    prompt: "Atlassian cloud id of your Jira Cloud site (leave blank for self-hosted Jira)"
    detect: "accessible-resources"
    required: false
  - key: tracker.settings.subtaskLinkType
    prompt: "How a child attaches to its parent: parent (default — the native parent field), epic-link (the legacy Epic Link custom field), or the name of an issue link type to use when the parent's issue type cannot hold children"
    detect: null
    required: false
  - key: tracker.rest.baseUrl
    prompt: "Base URL of your Jira site (https://<site>.atlassian.net, or your self-hosted server URL). Required for self-hosted Jira; on Cloud it enables attachments, remote links and the label list"
    detect: null
    required: false
  - key: tracker.rest.tokenEnv
    prompt: "Name of the environment variable holding your Jira credential: `<email>:<api-token>` for Cloud (sent as Basic auth), a personal access token for self-hosted (sent as Bearer)"
    detect: null
    required: false

rest:
  # Both values are CONFIG KEYS to read, not literals. The token key is user-scope and SECRET: it is
  # never written to the project file (`fleet config validate` errors on it).
  baseUrlKey: tracker.rest.baseUrl
  tokenEnv: tracker.rest.tokenEnv
---

# Jira adapter

Jira is the adapter that stresses the abstraction hardest, and four of its habits shape every section
below. Read this page once before executing any `Call:` line.

1. **Status is a transition, not a field.** An issue moves only through the workflow transitions that
   are legal *from its current status*. op-4 therefore returns a target status (name + id), and op-5
   reads the issue's available transitions at the moment of the change and picks the one that lands
   there. No matching transition → an op-11 comment `needs manual transition to <name>` and carry on;
   never chain two transitions to reach a status (op-5 says why).
2. **Users are opaque `accountId`s.** An email is a search string, not a ref, and a privacy setting may
   hide it entirely. op-3 resolves once; every later call carries the id.
3. **Two parent notions.** The native `parent` field (subtasks under a standard issue; standard issues
   under an Epic-level parent) and the legacy "Epic Link" custom field that older company-managed sites
   still use. `tracker.settings.subtaskLinkType` says which one this site speaks; the default is
   `parent`. Jira's hierarchy is strict — one parent per issue, and only a subtask can hang under a
   standard issue — which is why the sweep group is an **Epic** and the a11y umbrella's children are
   **subtasks** (op-20, op-23).
4. **Descriptions are documents.** Cloud stores ADF; self-hosted stores wiki markup. Every read renders
   the body to plain text before anything looks at it (op-2 gives the walk), and every write sends plain
   text and lets the API wrap it: the hosted MCP converts markdown to a document itself, and the REST
   form of every body write uses the v2 endpoints, which accept text as-is on Cloud and self-hosted
   alike.

Conventions for every `Call:` line:

- **Tool prefix.** Tools are written with the first entry of `mcp.toolPrefixes`; substitute whichever
  entry is visible in your session. Older builds of the hosted server used different names for a few
  tools — the `Call:` line names the alias in parentheses where one exists. A tool that is not visible
  at all falls to the REST form on the same line whenever the transport is configured.
- **`cloudId`.** Every hosted-MCP call takes `cloudId: <tracker.settings.cloudId>`; it is omitted from
  the argument lists below to keep them readable. Blank on self-hosted sites.
- **REST form.** `{tracker.rest.baseUrl}` supplies the host, never a literal. `{v}` is `3` on Cloud
  (cloudId set) and `2` on self-hosted; **body writes (create, edit, comment) always use `2`** so text
  is accepted unwrapped. The `Authorization` header comes from the environment variable named by
  `tracker.rest.tokenEnv`: a value containing `:` is `<email>:<api-token>` and goes out as `Basic
  base64(value)`; anything else goes out as `Bearer <value>`. Issue the request with `curl.exe` or
  Node's `fetch` — both exist on every platform the fleet runs on. Write `curl.exe`, never a bare
  `curl`: in Windows PowerShell `curl` is an alias for `Invoke-WebRequest`, whose incompatible syntax
  swallows the flags without an error and breaks the op-22 multipart upload and every `--data-binary`
  body write. Any op that makes a direct tracker call may fall to its REST form when no tool is
  visible and the transport is configured; it is the primary form on self-hosted sites. The composite
  ops (op-4, op-7, op-9, op-10, op-18) have no REST form of their own — they delegate to the ops they
  name. Without `tracker.rest.baseUrl` the transport is not configured, and op-8, op-17 and op-22 each
  take their own `If unsupported:` line.
- **Issue type.** op-13 needs one. The scope's defect type, subtask type and Epic-level type are
  resolved once at `fleet check plan` through the issue-type lookup on op-13's `Call:` line (the
  project's issue types with `id`, `name`, `subtask` and `hierarchyLevel`) and recorded in the
  manifest, never asked: the defect type is the type named `Bug` when the project has one, else its
  first standard type; the subtask type has `subtask: true`; the Epic-level type has
  `hierarchyLevel: 1` (self-hosted reports no level — there it is the type named `Epic`).
- **Project style.** Team-managed and company-managed projects differ in exactly two places that
  matter here: the JQL subtree function (op-16) and the legacy Epic Link field (op-13, op-23). Both are
  resolved once at plan time and recorded in the manifest; nothing below re-decides them per call.

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Call: `mcp__atlassian__searchJiraIssuesUsingJql({ jql: "parent = <parentKey> ORDER BY created ASC", fields: ["key","summary","issuetype","status"], maxResults: 100, nextPageToken })` → map `issues[].key` → `key[]` in returned order; append ` OR \"Epic Link\" = <parentKey>` to the JQL **only** when `tracker.settings.subtaskLinkType` is `epic-link`. REST: `POST {tracker.rest.baseUrl}/rest/api/3/search/jql` body `{ jql, fields, maxResults, nextPageToken }` (Cloud) · `GET {tracker.rest.baseUrl}/rest/api/2/search?jql=<jql>&startAt=0&maxResults=100` (self-hosted)
If unsupported: the launcher treats the key as a leaf and says so in the `fleet up` output; reads are never queued to the outbox.

Returns the direct children of a parent so the launcher can fan out **one session per child**
(`fleet up --issues <parent>`, `fleet add <parent>`); sessions never call it. An assigned key is
typically one child of a parent that was split across sessions — a session works **only** its assigned
issue, never the parent, never a sibling — so return leaves only, and an empty array for a leaf.
`parent =` covers subtasks and the native hierarchy (team-managed epics, and company-managed projects
since the hierarchy unification); the legacy field is added only by configuration, because a JQL that
names a field the site does not have fails outright instead of returning nothing. Apply the op-16
completeness rule to the page.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Call: `mcp__atlassian__getJiraIssue({ issueIdOrKey: <key>, fields: ["summary","description","status","priority","parent","issuetype","labels","assignee"] })` → `{ key, id, title: summary, description: <body rendered to text>, url: "<site base>/browse/<key>", status: status.name, priority: <inverse of priority.map by name>, parentId: parent.key ?? <Epic Link value> ?? null }`; `suggestedBranch` is never returned (Jira offers none). REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>?fields=summary,description,status,priority,parent,issuetype,labels,assignee` — on `{v}=3` the description is an ADF document: walk `content[]` depth-first, emit every `text` node's `text`, a newline after each block node, `- ` before a `listItem`, `- [ ] ` / `- [x] ` for a `taskItem` by its `state` (`TODO` / `DONE`), `[text](href)` for a `link` mark; on `{v}=2` it is wiki markup and is used as-is.
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

One issue by key. The hosted MCP already returns the description as markdown; the REST form has to
render it, and the `taskItem` rule is what keeps the contract's checklist shape (op-26) readable on
every path. `parentId` is **raw** — the parent as stored, so an issue filed directly under a sweep
Epic carries the Epic's key; op-16 returns the same value, and only its `parentIsNull` filter reads
the group relatively. The priority name is mapped back through `priority.map`; a site-specific name
outside the map goes to the nearest canonical band (`Lowest` → 4, `Blocker` / `Critical` → 1) and is
noted in the result. The launcher calls op-2 for every assigned key **before** spawning and pipes the
JSON into `fleet ticket cache --issue <KEY> --from-json -`, which is what makes the fallback above
exist.

⛔ If the tracker tools are not visible in your session, do **not** stall on that — read the ticket
cache and carry on; write a blocked flag (`fleet flag blocked --category tracker …`) only if that
file is missing too — because tracker tools can race a fleet-launch burst, and every state write you
owe meanwhile travels through the outbox, so nothing is lost by proceeding.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Call: `"me"` → `mcp__atlassian__getJiraCurrentUser({})` (older builds: `atlassianUserInfo`) → `accountId`; anything else → `mcp__atlassian__lookupJiraAccountId({ searchString: <nameOrEmail> })` → the single exact match's `accountId`. REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/myself` → `accountId` (self-hosted: `name`) · `GET {tracker.rest.baseUrl}/rest/api/{v}/user/search?query=<nameOrEmail>` (self-hosted: `?username=<name>`) → exactly one `accountId` / `name`
If unsupported: for `"me"`, use the tracker's authenticated-identity call above; if none is reachable, `tracker.defaultAssignee` must hold a literal `accountId` set in the **user** layer.

`"me"` means the authenticated tracker user and is the only assignee the playbooks ever ask for,
unless `checker.routing` matches the **defect's** path. Return the opaque `accountId` (the `name` on
self-hosted) — an email is never a valid ref here, and a privacy setting may hide it from the search
entirely, so resolve routing entries **once at plan time**, require exactly one match, and fail
loudly on zero or several rather than guessing.

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public.

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 for `scope`, then pick the status whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → `{ id, name }` — a **target status**, not a transition id; the transition that reaches it is chosen per issue at op-5 time
If unsupported: trackers with no status field return the list or column id the transition maps to; Jira always has one — when the configured name is not in the scope, return nothing and let op-5 apply its no-transition rule.

Maps the three canonical transitions to a real status in this scope. It is its own step because Jira
sets status through **transitions that depend on the current status**, and because status names
differ per project and per issue type.

⛔ Never hard-code a status id or name in a `Call:`; resolve it every time through the configured
scope — because a tracker can hold two statuses of the same type (two "done"-category statuses, one
of them wired to a post-function that resolves or archives irreversibly), and only the configured name
tells them apart.

## op-5 setState

`setState(key, stateRef)`

Call: `mcp__atlassian__listJiraIssueTransitions({ issueIdOrKey: <key> })` (older builds: `getTransitionsForJiraIssue`) → `transitions[]{ id, name, to{ id, name, statusCategory{ key } } }` → the entry whose `to.id` (or `to.name`) equals the stateRef → `mcp__atlassian__transitionJiraIssue({ issueIdOrKey: <key>, transition: { id: <transition id> } })`, then op-2 to confirm `status` changed. REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/transitions?expand=transitions.fields` → `POST {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/transitions` body `{ "transition": { "id": "<id>" } }` (204); when the chosen transition's `fields` mark `resolution` required, add `"fields": { "resolution": { "name": "<one of its allowedValues>" } }` — never a name you made up
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the ref and applies it.

One transition. Re-read after writing — a transition that is not legal from the current status can
fail silently, and the playbooks treat "I called setState" as "the state changed".

⛔ Read the available transitions **at the moment of the change**, never from a list cached at plan
time — because what is legal depends on the issue's current status, and a transition id that was
valid a minute ago is rejected, or lands somewhere else, after a concurrent move.

⛔ No transition reaches the target from here → post op-11 `needs manual transition to <name>` and
**continue**; never chain two transitions to get there — because an intermediate status fires its own
post-functions (a resolution set, an assignee reset, notifications sent) and leaves a history nobody
asked for, while the comment is a complete record the operator can act on with one click.

## op-6 assign

`assign(key, userRef)`

Call: `mcp__atlassian__editJiraIssue({ issueIdOrKey: <key>, fields: { assignee: { accountId: <userRef> } } })`. REST: `PUT {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/assignee` body `{ "accountId": "<userRef>" }` (self-hosted: `{ "name": "<userRef>" }`) (204)
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Assign to the ref op-3 returned. The default is always `"me"`; `checker.routing` is the only thing
that changes it, and it matches on the path of the defect, not the PR that surfaced it. A `400` here
means the user is not assignable in this project — record it in the done-flag `--reason` and continue;
assignment is bookkeeping, not a gate.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `(tracker.scope, in-review)` → op-5 `(key, stateRef)`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. It is listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context. op-5's no-transition rule applies
unchanged: a workflow whose in-review status is not reachable from the current one gets the comment,
not a detour.

## op-8 attachLink

`attachLink(key, url, title)`

Transport: rest
Call: `POST {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/remotelink` body `{ "globalId": "<url>", "object": { "url": "<url>", "title": "<title>" } }` → `{ id, self }` — the same `globalId` **upserts**, so a retry cannot create a second link. The hosted MCP only reads these (`mcp__atlassian__listJiraIssueRemoteIssueLinks({ issueIdOrKey: <key> })`); it exposes no remote-link write
If unsupported: put the URL on its own line in the body via op-14 (Jira renders a bare URL as a link) and in an op-11 comment; queue to the outbox when tools are down.

Attach the PR URL to the issue. A `403` (no *Link Issues* permission) or a `404` (issue linking
disabled on the site) **is** the unsupported case above, not a retry. When the code host's Jira app is
installed, a PR whose branch or title carries the key also shows up under the issue's development
panel by itself — a bonus, not a substitute: that panel is not readable through op-2, and the remote
link is what the launcher's report and the offline cache can see.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the issue, and
never sleep on it — because the attachment budget is per site and per user, so it shrinks exactly as
the fleet grows, and re-creating is how duplicates appear. Record the key, move on, and let the
launcher's serial cleanup pass attach it when waiting is free; a bare PR URL in the body keeps the
association visible meanwhile.

## op-9 cancel

`cancel(key, reason)        (comment FIRST, then state)`

Call: op-11 `(key, <reason, verbatim, with its file:line evidence>)`, **then** op-4 `(tracker.scope, cancelled)` → op-5
If unsupported: op-11 with the same text, then op-10; the done-flag still carries `--outcome cancelled`.

Close an issue as not needed — the defect is already fixed on the base branch, or never existed. If
the cancelled transition demands a resolution, op-5 supplies one from the transition's own allowed
values; a workflow with no cancelled status at all ends at op-5's `needs manual transition` comment,
which is a complete outcome — the evidence is on the issue and the flag says `cancelled`.

⛔ Comment **first**, then state — because the comment is the record of why a filed bug was deleted
and must stand on its own; a cancel whose state lands first leaves an unexplained closure if the
session dies between the two calls.

⛔ `cancelled` means "already fixed — here is `path:line`" and is **not** the same as `duplicate`
("another session shipped it in a PR that is legitimately in review and must not be closed") —
because an assertion with no line number cannot be acted on and the ticket stays open, while a
duplicate closed as cancelled deletes a live review. A session with live tools performs op-9 itself
and writes `fleet flag done --outcome cancelled --evidence <path:line> --reason …` either way — the
flag is the only thing that survives the session.

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

Call: `mcp__atlassian__addOrEditJiraIssueComment({ issueIdOrKey: <key>, commentBody: <verbatimText> })` (older builds: `addCommentToJiraIssue`) — the server wraps the text into a document. REST: `POST {tracker.rest.baseUrl}/rest/api/2/issue/<key>/comment` body `{ "body": "<verbatimText>" }` — v2 takes the text as-is on Cloud and self-hosted; v3 would make you wrap it as ADF yourself
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason. Do not "escape" wiki markup or markdown on the way in either — escaping changes the text.

⛔ Never truncate text containing issue keys at a raw character offset; cut at a word boundary,
strip trailing `(KEY-` fragments, and wrap every surviving key in backticks — because a cut key
becomes a valid *shorter* key that autolinks to a real, unrelated issue and pollutes it with
backlinks, while the write "succeeds" and looks fine in the echo. Jira autolinks every key-shaped
token wherever it appears, so on this tracker never cutting a key is the *only* defence.

## op-12 listQueue

`listQueue(selector) → key[]`

Call: `mcp__atlassian__searchJiraIssuesUsingJql({ jql: <rendered selector>, fields: ["key","priority","status","labels","assignee","parent"], maxResults: 100, nextPageToken })` → keys in returned order (already priority-sorted). Render the selector as `project = "<tracker.scope>"` + ` AND status = "<state name>"` + ` AND labels in ("<a>","<b>")` + ` AND (labels not in ("<x>") OR labels is EMPTY)` + ` AND assignee = currentUser()` (a routed assignee: `= "<accountId>"`) + ` AND parent = "<group>"` (`epic-link` sites: ` AND "Epic Link" = "<group>"`) + ` ORDER BY priority DESC, created ASC`. REST: `POST {tracker.rest.baseUrl}/rest/api/3/search/jql` (Cloud) · `GET {tracker.rest.baseUrl}/rest/api/2/search?jql=…&startAt=…&maxResults=100` (self-hosted)
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside `tracker.queue` / `tracker.scope`, priority-sorted; the launcher writes them to `queue.txt`
for autowave. The default selector excludes `checker.triage.label`, and the result is only a
**candidate** list: `fleet intake check` still refuses any checker-filed ticket that lacks
`gate:passed|waived` when `fleet.queue.requireGate` is on, and counts the refusals — never silently.
Apply the op-16 completeness rule to the page.

⛔ Render `excludeLabels` as `(labels not in (…) OR labels is EMPTY)`, never as `labels not in (…)`
alone — because JQL's `not in` silently drops every issue that has **no** labels, and the queue would
then be only the issues someone happened to label, which is not the queue.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Call: `mcp__atlassian__createJiraIssue({ projectKey: <tracker.scope>, issueTypeName: <the scope's defect type, or its subtask type when parent? names a standard issue>, summary: <title>, description: <body — plain text / markdown; the server converts it>, assignee_account_id: <op-3 "me">, additional_fields: { labels: [<names from op-17>], priority: { name: <priority.map[n]> }, parent: { key: <parent ?? group> } } })` → `{ key, id, url: "<site base>/browse/<key>" }`; `epic-link` sites put `group` in `additional_fields["<Epic Link field id>"]` and keep `parent` for a real parent; `state?` is applied afterwards through op-4 → op-5; `links[]` through op-8. REST: `POST {tracker.rest.baseUrl}/rest/api/2/issue` body `{ "fields": { "project": { "key": "<scope>" }, "issuetype": { "id": "<type id>" }, "summary": "<title>", "description": "<body>", "assignee": { "accountId": "<me>" }, "labels": [ … ], "priority": { "name": "<name>" }, "parent": { "key": "<parent ?? group>" } } }` → `{ id, key, self }` (self-hosted: `"assignee": { "name": … }`). The Epic Link field id comes from `GET {tracker.rest.baseUrl}/rest/api/{v}/field` → the entry whose `name` is `Epic Link`, resolved once at plan time; the issue types come from `mcp__atlassian__listJiraProjectIssueTypesMetadata({ projectIdOrKey: <tracker.scope> })` (older builds: `getJiraProjectIssueTypesMetadata`; REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/project/<scope>`) → `issueTypes[]{ id, name, subtask, hierarchyLevel }` — defect type: the entry named `Bug`, else the first with `subtask: false` and `hierarchyLevel: 0`; subtask type: the entry with `subtask: true`; Epic-level type: the entry with `hierarchyLevel: 1` (self-hosted returns no `hierarchyLevel`: the Epic-level type is the entry named `Epic`, and the defect fallback is the first `subtask: false` entry not named `Epic`) — resolved once at plan time and recorded in the manifest, together with the required-field list from `mcp__atlassian__getJiraIssueTypeMetaWithFields({ projectIdOrKey: <tracker.scope>, issueTypeId: <defect type id> })` so a project with a mandatory custom field fails in the plan, once, instead of once per finding
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the issue and records the key.

One issue per finding. `state?` is `checker.triage.state`; `labels[]` always carry
`checker.triage.label`, `checker.provenanceLabel` and `checker.gate.labels.pending`, and only names
that op-17 returned or that op-18 recorded (configured → normalised) in the manifest — on a fresh site
those three markers exist nowhere until this create makes them (op-18), which is why the manifest is
the second source; `assignee` is `"me"` unless `checker.routing` matches the defect's path. Jira
cannot create an issue straight into an arbitrary status, so the triage state is a second call — the
triage **label** is what marks the issue from the first instant, which is why it is mandatory here.
`parent?` wins over `group?` when both are given: an issue has exactly one parent, and a subtask of the
umbrella is inside the group transitively (op-16 explains how it is found).

⛔ Reconcile against the system of record with op-16 at the **start of every filing batch**; never
track "what have I already filed" in a hand-kept file or a running tally — because both drift, and
the failure mode is duplicate tickets, the opposite of what the dedup gates exist for.

⛔ Join filed issues to findings on the `**PR:**` header line or the opaque `fid`, never on title
similarity — because titles are rewritten when filing, so text similarity mis-scored 28 of 100 in
one sweep, while an opaque key cannot drift.

⛔ An oversized "error" echo (`result exceeds maximum … saved to <file>`) usually means the write
**applied** — re-fetch with op-2 or op-16 before any retry, never blind-retry — because a blind retry
creates a duplicate.

⛔ Priority is set **twice**: the `priority` field (through `priority.map`) and a `**Priority:**`
line in the body — because trackers with `priority.scale: labels|none` have no field to hold it, and
for issues whose field is forced (`checker.a11y.forcedPriority`) the body line is the only channel
the assessed severity can travel on.

⛔ A label with a space in it fails the **whole create** with a `400` — because Jira labels are
single tokens; validate and normalise every label name at `fleet check plan` (op-18) so the rejection
happens once, in the plan, not once per finding in the middle of a wave.

A failed `links[]` entry is cosmetic (op-8 rule); the issue is created correctly without it.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Call: `mcp__atlassian__editJiraIssue({ issueIdOrKey: <key>, fields: { summary?: <title>, description?: <body>, priority?: { name: <priority.map[n]> }, assignee?: { accountId }, parent?: { key } }, update?: { labels: [ { add: "<a>" }, …, { remove: "<b>" }, … ] } })` — only the fields given, and labels **only** through `update.labels` (`fields.labels` replaces the whole set); `state?` → op-4 → op-5; `links?` → op-8. REST: `PUT {tracker.rest.baseUrl}/rest/api/2/issue/<key>` body `{ "fields": { … }, "update": { "labels": [ { "add": "<a>" }, { "remove": "<b>" } ] } }` (204)
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`) and maps onto the delta form on the `Call:`
line, never onto the replacement form — because a replacement erases the labels another pass added
(gate labels, a11y labels). `fleet check gate apply` uses it to mirror `gate:<status>`; the
rediscovery rule uses it to append a new call site to an existing issue (body and comment only — never
title or state, so it reads as new evidence). Leave the notification behaviour at its default:
suppressing watcher mail needs an administer permission and a `403` fails the whole edit.

⛔ Editing an issue you did not create is **launcher-only** — because parallel writers to one issue
overwrite each other, while creating *distinct* issues shares no mutable state and parallelises
cleanly. The line is shared state, not the tracker itself.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Call: emulated (`atomicPatch: false`) — `fleet pool acquire tracker-worklist:<KEY>` → op-2 `(key)` for the current text → apply every `find` → `replace` locally (each `find` must match exactly once; `applied` = the count that did) → `mcp__atlassian__editJiraIssue({ issueIdOrKey: <key>, fields: { description: <the whole new text> } })` (REST: `PUT {tracker.rest.baseUrl}/rest/api/2/issue/<key>` body `{ "fields": { "description": "<text>" } }`) → op-2 again to verify → `fleet pool release tracker-worklist:<KEY> <slot>`
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'`.

Find/replace edits against the body. Jira has no native patch, so the adapter emulates it by
read-modify-write under `fleet pool acquire tracker-worklist:<KEY>` (release with `fleet pool
release`), because two unlocked read-modify-writes silently drop one another's edits.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ Send N edits in **one** call per wave, never one call per edit — because the response echoes the
whole body every time (a 322-row body costs ~25 KB per call), while several edits in one call is
still a single serialized write with no clobber risk.

⛔ Never round-trip a description a human wrote by hand — because the read is a *rendering* of a
document and the write re-converts the text, so tables, panels, mentions and inline media are
flattened on every pass; fleet-filed bodies are plain text by construction and survive the trip, and
they are the only kind op-15 touches — on an operator-authored body use op-11.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Call: `mcp__atlassian__searchJiraIssuesUsingJql({ jql: <rendered filter>, fields: ["key","summary","priority","status","parent","labels","created"], maxResults: <limit>, nextPageToken })` → `issues[]` as `{ key, id, title: summary, priority: <inverse map>, status: status.name, parentId: parent.key ?? <Epic Link value> ?? null (raw — the value op-2 returns) }`; `complete = response.isLast === true`, or `complete = !response.nextPageToken` when the response carries a token but no flag; when it carries **neither**, `complete` is unknown — never infer "last page" from an absent signal, fall to the REST form (`total`, `complete = startAt + issues.length >= total`) to page it. Render the filter as `project = "<tracker.scope>"` + the group clause + ` AND labels in (…)` + ` AND priority = "<priority.map[n]>"` + ` AND status = "<state>"` + ` AND text ~ "\"<phrase>\""` for `text?` + ` AND created >= "<createdAfter as yyyy-MM-dd HH:mm>"` + ` ORDER BY created ASC`. Group clause: `parentIsNull: true` → ` AND parent = "<group>"` (direct children only); `parentIsNull: false` → ` AND parent in (<the manifest's umbrella keys>)`; unset → the whole subtree, ` AND parentEpic = "<group>"` on a company-managed project and ` AND parent in ("<group>", <the manifest's umbrella keys>)` on a team-managed one (`parentEpic` does not exist there) — without a group, `parent is EMPTY` / `parent is not EMPTY` literally; `epic-link` sites use `"Epic Link" = "<group>"` in place of every `parent = "<group>"`. REST: `POST {tracker.rest.baseUrl}/rest/api/3/search/jql` body `{ jql, fields, maxResults, nextPageToken }` → `{ issues, isLast, nextPageToken }` (Cloud) · `GET {tracker.rest.baseUrl}/rest/api/2/search?jql=…&startAt=…&maxResults=…` → `{ issues, startAt, maxResults, total }` with `complete = startAt + issues.length >= total` (self-hosted)
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and files tracker-less (`localId` rows), and the plan output says so.

Filtered query. `complete` is derived per `capabilities.findComplete`: `page-flag` here — Cloud's
enhanced search answers with `isLast` and a continuation token, and the self-hosted form answers with
`total`, which the REST form reduces to the same boolean. `reconcile.assertComplete()` in the CLI
trusts nothing else. The **filter** is translated relative to the sweep while the **result** is not:
in Jira the group *is* a parent-field value, so `parentIsNull` is rendered as "no parent other than
the group", but `parentId` stays raw — an issue filed directly under the Epic carries the Epic's key,
exactly as op-2 returns it — because a literal `parent is EMPTY` inside an epic-grouped sweep returns
nothing, and an empty frame reads as "nothing filed" and re-files the entire sweep as duplicates. The
only key list that may appear in the group clause is the sweep's **own** umbrellas, read from
`manifest.json`, which is the record of what this sweep created; it is never a hand-kept list of
parents someone remembered.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates. Some builds of the hosted server return **no** pagination metadata at all
on this call — treat that as "no signal", not as "last page", and fall to the REST form to page it.

⛔ Band the query by `priority` (1, 2, 3, 4 — one call each) so each band fits a page, assert
`complete` on **every** band before combining, and print the per-band counts — because a band
silently at its cap is the failure you are looking for. On this tracker a band that still fills its
page is walked with the continuation token, or through the REST form when the tool gives none.

⛔ Exclude parents structurally with `parentIsNull: true`, never by a list of parent ids — because
an umbrella filed later carries the same labels and priority as its own children and walks straight
into any frame keyed on those; an id list is a snapshot of the parents you knew about when you wrote it.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate. JQL's `text ~` is a fuzzy full-text match: quote the phrase (`"\"…\""`) and
confirm the hit by reading its `**PR:**` line, never by the match alone.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/rest/api/{v}/label?startAt=<n>&maxResults=1000` → `values[]` (strings) → `[{ id: <name>, name }]`, paging until `isLast` (self-hosted lacks this endpoint: `GET {tracker.rest.baseUrl}/rest/api/2/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=<prefix>` once per marker prefix the plan needs — `gate:`, `a11y`, the triage and provenance names). The hosted MCP exposes no label list
If unsupported: the list is the plan's declared marker names (each one comes into existence on first use — op-18) plus every label seen on the issues op-16's `Call:` returns for the JQL `project = "<scope>" AND labels is not EMPTY` (fields `labels` only, banded per op-16) — an in-use list, weaker than the site list; the plan output says which one it got.

Labels are site-wide free-form tokens with no id, so `id` is the name itself and the "scope" only
narrows the in-use fallback. Complete per op-16's rule.

⛔ Sessions and workers pick labels from this list **only**, plus the normalised marker names op-18
recorded in the manifest at `fleet check plan`; nobody invents one beyond those — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on. The manifest
exception is what lets op-13 apply the mandatory markers on a fresh site, where no issue carries them
yet and this list therefore cannot name them.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Call: normalise the configured name first — remove every whitespace character, deterministically (`a11y: keyboard` → `a11y:keyboard`, `a11y: screen reader` → `a11y:screenreader`) — and record the configured → normalised pair in the manifest so op-12, op-13, op-14 and op-16 carry the normalised name from then on; then op-17, return the match by exact normalised `name`; else validate it (at most 255 characters, no whitespace) and return `{ id: <name> }` — Jira has no create call; a label exists the first time an issue carries it, and op-13's first create is that moment. A name that still fails validation stops `fleet check plan` with the hint to reconfigure the marker
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`,
`checker.triage.label`, every `checker.gate.labels.*`, both `checker.a11y.labels.*`, and the four
`priority.map` names when `priority.scale: labels`. The contract's default `checker.a11y.labels`
carry spaces; the normalisation on the `Call:` line is what lets them work here unchanged.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode. On
this tracker the race is a *spelling* race (there is no create call to collide on), which is worse:
two spellings never merge.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Call: `mcp__atlassian__listJiraStatuses({ projectKey: <scope> })` → flatten the per-issue-type groups, dedupe by `id`, and type each status from `statusCategory.key`: `new` → `unstarted` (name matching `/triage|backlog/i` → `triage`), `indeterminate` → `started` (name matching `/review/i` → `review`), `done` → `done` (name matching `/cancel|won.?t|reject|declin/i` → `cancelled`); a name configured in `tracker.states.*` always carries its configured type. REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/project/<scope>/statuses` → `[{ id, name, subtask, statuses[]{ id, name, statusCategory{ key } } }]`, same flatten
If unsupported: trackers without states return their lists or columns as states, typed through `tracker.states`.

Every status in the scope with its canonical type. op-4 picks from it; `checker.ready.state`
defaults to the adapter's `unstarted` state. Return **all** statuses of a type, not the first — op-4
must be able to choose the configured one. Jira knows only three categories, so `triage`, `review`
and `cancelled` are read off the name; that heuristic is for reporting — the configured names are
what the fleet actually moves issues into.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Call: a key-shaped `ref` → `mcp__atlassian__getJiraIssue({ issueIdOrKey: <ref>, fields: ["summary","issuetype","project"] })`, requiring `project.key == <tracker.scope>` and an Epic-level `issuetype`; anything else → `mcp__atlassian__searchJiraIssuesUsingJql({ jql: "project = \"<scope>\" AND issuetype = <Epic-level type> AND (summary ~ \"\\\"<ref>\\\"\" OR id = <ref when numeric>)", fields: ["summary"], maxResults: 10 })` → exactly one → `{ id, name: summary, url: "<site base>/browse/<key>" }` (record the `key` beside the `id` — JQL takes either, the API prefers the id). REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/issue/<ref>` · `POST {tracker.rest.baseUrl}/rest/api/3/search/jql` / `GET {tracker.rest.baseUrl}/rest/api/2/search` with the same JQL
If unsupported: `grouping: none` — there is no group; `checker.provenanceLabel` alone marks the sweep.

Resolves `checker.project` (an Epic's key, numeric id or summary) once at plan time. The group is an
**Epic inside `tracker.scope`**, not a Jira project — a project per sweep would need site
administration and a fresh project key every time, while an Epic is the container Jira already has
for "a body of related work".

⛔ From then on reference the group by **id** everywhere — in `manifest.json`, in every worker brief,
in every op-13 call — never by name — because names carry apostrophes and change, and a pointer kept
in prose or memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Call: `mcp__atlassian__createJiraIssue({ projectKey: <tracker.scope>, issueTypeName: <the scope's Epic-level type>, summary: <name>, description: "Sweep container created by fleet-check on <date>." })` → `{ id, url: "<site base>/browse/<key>" }`. REST: `POST {tracker.rest.baseUrl}/rest/api/2/issue` body `{ "fields": { "project": { "key": "<scope>" }, "issuetype": { "id": "<Epic-level type id>" }, "summary": "<name>", "description": "…" } }`
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question. Team-
managed projects may call their level-1 type something other than `Epic`; the type is resolved by
hierarchy level at plan time (op-13's `Call:` gives the lookup), by name only on self-hosted, which
reports no level.

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: native-upload
Transport: rest
Call: `POST {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/attachments` as `multipart/form-data` with exactly one part named `file` holding the PNG, headers `X-Atlassian-Token: no-check` and `Authorization` as in the conventions → `[{ id, filename, content, thumbnail }]`; `url = content` (the bare, unsigned attachment URL — same-site and permission-gated, never expiring); `embed` is the token for the transport that will write the body: `!<url>|alt=<alt>,width=800!` for a wiki-markup body (the REST v2 form, Cloud and self-hosted) or `![<alt>](<url>)` for a markdown body (the hosted MCP converts it to a media node). Where the hosted server exposes `mcp__atlassian__uploadAttachmentToJiraIssue({ issueIdOrKey: <key>, … })` and it accepts your file, it is equivalent; the REST call is the portable path and the only one a self-hosted site has
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; the CLI falls to `assets-branch` first when the code host can serve raw files (see the degradation table); cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy`, never improvised at filing time:

- `native-upload` — the multipart POST above, through `Transport: rest` (`{tracker.rest.baseUrl}` +
  the token named by `tracker.rest.tokenEnv`). Jira needs an **existing issue** to attach to, so the
  order is create (op-13, body carrying the caption line) → upload → op-14 to inline `embed`.
- `assets-branch` — `fleet assets add <file…> --branch <name>` commits the PNGs to the branch rendered
  from `vcs.assetsBranchTemplate` and returns hot-linkable raw URLs to embed. On a private repository
  those render as broken images to anyone not signed in to the code host, so prefer `native-upload`
  there.
- `attachment-only` — attach the file, then a caption sentence in the body; no inline image.
- `none` — `_No screenshot attached: <reason>_`, counted **separately** from `_No UI surface — <reason>_`
  in the report, because "the app was down" and "there is no screen" are different outcomes and lumping
  them overstates coverage.

⛔ Store the **bare** URL — because the tracker re-signs it on read; a signed URL copied forward
expires, and the image dies in every sibling issue that inlined it. Jira's `content` URL is already
bare; never store the `thumbnail` URL or a browser download URL in its place.

⛔ **One upload per screenshot.** Create the first issue, upload its shot once, then create the sibling
findings with the same `embed` already inlined — because several findings from one PR share one
screen, and per-issue uploads turn a 300-finding sweep into ~900 round-trips. The `embed` carries the
first issue's attachment URL, which is why it must be the URL form and not a bare `!filename!` — a
bare filename resolves only on the issue that owns the attachment.

⛔ One file per request, sequentially, and a non-`2xx` means the file is **not** attached — check the
response array before inlining anything — because a half-uploaded PNG embeds as a broken image nobody
re-checks.

⛔ `X-Atlassian-Token: no-check` is mandatory on the upload — because the endpoint refuses any
request without it as a forgery attempt, with an error that reads like an authentication failure and
sends you chasing the wrong credential.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none.

## op-23 setParent

`setParent(key, parentKey)`

Call: `mcp__atlassian__editJiraIssue({ issueIdOrKey: <key>, fields: { parent: { key: <parentKey> } } })` when `key`'s issue type may sit under `parentKey`'s (a subtask under a standard issue; a standard issue under an Epic-level parent); a standard issue being re-parented under a standard umbrella must become a subtask in the same call — `fields: { issuetype: { id: <the scope's subtask type> }, parent: { key: <parentKey> } }` — and on a `400` falls to `tracker.settings.subtaskLinkType`: `epic-link` → `fields: { "<Epic Link field id>": "<parentKey>" }`; an issue-link type name → op-25 `(key, parentKey, <that name>, …)` plus a `**Parent:**` body line via op-14. REST: `PUT {tracker.rest.baseUrl}/rest/api/2/issue/<key>` with the same `fields`
If unsupported: the umbrella becomes an index issue whose body is a checklist of its children (op-15 / op-14), and each child carries a `**Parent:**` body line plus op-25 when available.

Make `key` a sub-issue of `parentKey`. Its main use is the a11y umbrella (`checker.a11y.umbrella`,
titled `checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the
working queue while keeping **one issue per gap** — a pattern ticket would lose the per-site
file/line/PR that makes each one actionable. On this tracker the umbrella is an ordinary
finding-level issue under the sweep group, and its children are **subtasks** created with `parent?`
at op-13 time — because an issue has exactly one parent, a standard issue's parent must be Epic-level,
and only a subtask can hang under a standard issue; subtasks keep their own labels and priority and
stay inside the group's subtree walk (op-16). A project whose subtask type is disabled takes the
`subtaskLinkType` path above.

⛔ Parenting onto the umbrella is **launcher-only**; a worker passes `parent?` at op-13 time only for
issues it creates itself — because the umbrella is shared state.

⛔ When re-parenting retroactively, query each a11y label with op-16 and **union the two result sets
by id** before iterating — because the two label queries overlap heavily, and iterating both issues
duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over parent/child when two findings
carry different severities — because nesting an Urgent under a High buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Call: op-11 `(key, <evidence, verbatim, naming ofKey in backticks>)`, **then** `mcp__atlassian__createJiraIssueLink({ type: { name: "Duplicate" }, outwardIssue: { key: <key> }, inwardIssue: { key: <ofKey> } })` — reads "`<key>` duplicates `<ofKey>`" / "`<ofKey>` is duplicated by `<key>`" — **then** op-4 `(tracker.scope, cancelled)` → op-5, because a Jira link never moves a status. The type name is site-configurable: confirm it once at plan time with `mcp__atlassian__listJiraIssueLinkTypes({})` (REST: `GET {tracker.rest.baseUrl}/rest/api/{v}/issueLinkType` → `issueLinkTypes[]{ id, name, inward, outward }`) and use the site's spelling. REST: `POST {tracker.rest.baseUrl}/rest/api/{v}/issueLink` with the same body (201)
If unsupported: op-11 with the same evidence, then op-4 `(tracker.scope, cancelled)` → op-5, with `Duplicate of \`<ofKey>\`` as the comment's first line; if `cancel` is also `false`, op-11 then op-10.

⛔ Comment **first**, then the relation — because on some trackers the relation moves state on its own
and setting the duplicate state first fails; the evidence comment is mandatory and the relation is the
bonus. On this tracker the relation moves nothing, so the closing transition is a third step and
op-5's no-transition rule applies to it — the comment plus the link is still a complete record.

⛔ Never decide a duplicate by title similarity; compare the **mechanism** — same function, same
missing guard, same line — because true pairs routinely have completely different titles, unrelated
findings on one large file often have similar ones, and a wrong merge silently deletes a tracked bug,
which is worse than a duplicate sitting in the backlog.

⛔ "Shares the fix" is a hypothesis, not a verdict — check that both fixes touch the same file before
accepting it — because cross-app pairs almost never merge; one composite folded in three siblings whose
fixes landed in three different apps.

Creating a link that already exists answers `201` as well, so a retried link is harmless; the comment
is what must not be retried blind (op-11, and the outbox drain rule).

## op-25 relate

`relate(key, otherKey, kind, note)`

Call: `mcp__atlassian__createJiraIssueLink({ type: { name: <kind → "Relates" for related and every partial-overlap shape; "Blocks" for blocks, with outwardIssue = the blocker> }, outwardIssue: { key: <key> }, inwardIssue: { key: <otherKey> } })`, then op-11 `(key, note)` and op-11 `(otherKey, note)`; the site's type names come from the plan-time link-type list (op-24's `Call:`) and win over these defaults. REST: `POST {tracker.rest.baseUrl}/rest/api/{v}/issueLink` with the same body (201)
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. `kind` is whatever the playbook passes
(`related`, `blocks`, and the partial-overlap shapes); it is mapped onto the closest link type the
site has — `Relates` unless the kind is `blocks` — and the `Call:` says which. When a pair is judged
*distinct* but the two name a shared line or a causal link, relate them and put the "who owns which
sites" note on **both** — because a distinct verdict that still needs an action is silently lost
otherwise, and closing one ticket half-closes the other's sites.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Call: `mcp__atlassian__searchJiraIssuesUsingJql({ jql: "parent = <key> AND issuetype in subtaskIssueTypes() ORDER BY created ASC", fields: ["key","summary","status","description"], maxResults: 100, nextPageToken })` → for every subtask whose `summary` matches `^#(\d+)\b`: `{ pr, done: status.statusCategory.key === "done", keys: <backticked keys in its description>, raw: "<subtask key> <summary>" }`; when the to-do issue has **no** subtasks yet, parse its own description instead — every line matching `^- \[( |x|X)\] #(\d+)` (op-2's rendering turns task items into exactly that shape) → `{ pr, done, keys, raw: <the untouched line> }`. Comment fallback (the to-do issue cannot hold subtasks): `mcp__atlassian__listJiraIssueComments({ issueIdOrKey: <key> })` → one row per comment matching the same line shape. REST: the op-16 search forms · `GET {tracker.rest.baseUrl}/rest/api/{v}/issue/<key>/comment?startAt=…&maxResults=100`
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the to-do issue, in the shape
`capabilities.workItems` declares — `children` here: one subtask per PR, whose done-category status
is the tick. At `fleet check plan` the launcher creates them from the worklist, one op-13
`{ title: "#<pr> <title>", parent: <key> }` per row with the subtask type, **find-or-create by the
`#<pr>` summary prefix** so a resumed sweep never doubles them; the operator's hand-written checklist
in the description is the *input* and is never edited. Jira draws a subtask progress bar on the parent,
which is the operator's live view. `raw` is the exact token op-27 anchors on.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Call: the subtask for `pr` from op-26 (`raw`) → `mcp__atlassian__listJiraIssueTransitions({ issueIdOrKey: <subtask key> })` → the transition whose `to.statusCategory.key === "done"` → `mcp__atlassian__transitionJiraIssue({ issueIdOrKey: <subtask key>, transition: { id } })`, then `mcp__atlassian__editJiraIssue({ issueIdOrKey: <subtask key>, fields: { description: "Resolved: \`<key1>\`, \`<key2>\`" } })` — one subtask per PR resolved in the wave, issued back-to-back in the same drain; comment fallback: op-11 `(key, "- [x] #<pr> (\`<key1>\`, \`<key2>\`)")`. REST: the op-5 transition forms on the subtask · `PUT {tracker.rest.baseUrl}/rest/api/2/issue/<subtask key>` body `{ "fields": { "description": "…" } }`
If unsupported: `workItems: none` — no-op; `fleet check status` is the only progress view.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op the
instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells them
the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from the
shared ledger — because parallel writers to one description overwrite each other, and a bookkeeping
step attached to one execution path dies when the path changes (the tick once vanished the day filing
moved to subagents while the ledger append survived).

⛔ Anchor on the leading `#<pr>` of the subtask summary as a whole token, and backtick-wrap every key
you write — because a bare `#<n>` also appears inside other PR titles on the same list, and an
unwrapped key autolinks to a real, unrelated issue.

⛔ Patch, never a whole-body rewrite — because patches are atomic and cannot clobber a concurrent
edit. In the `children` shape each subtask is its own row: the transition and the description write
touch only that subtask, and the to-do issue's own description is never rewritten; the comment
fallback appends and never edits. Every tick still runs through `fleet check tick --lock` — with
`atomicPatch: false` the CLI serialises every drain under the `tracker-worklist:<KEY>` pool whatever
the shape — so the comment fallback and any edit that touches the to-do body sit under the same lock.

⛔ Verify a backfill by re-fetching (op-26) and counting ticked rows, never by retrying — because a
whole-description backfill trips the oversized echo and the write applied anyway; a blind retry is how
duplicate trackers get made. At any point the count of done-category subtasks must equal the ledger's
line count — `fleet check tick plan` prints the difference.

## Fallbacks every adapter gets for free (do not re-document)

Two mechanisms exist so that a tracker outage, a dropped MCP, or a sandbox without tools never costs a
transition. The `If unsupported:` lines above name them; this is what they are.

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

What the playbooks do when a capability is `false` (or `none`). These are the plugin's behaviour; the
adapter does not redefine them. On this adapter `atomicPatch` is `false` always; the other declared
capabilities stand as written, and an op whose transport is not configured (op-8, op-17, op-22 without
`tracker.rest.baseUrl`) takes its own `If unsupported:` line instead.

| capability | when `false` / `none` |
| --- | --- |
| `subIssues` | op-23 is never called. The a11y umbrella is still created (op-13) but as an **index issue**: its body is a checklist of child keys maintained by op-15, each child carries a `**Parent:**` body line, and op-25 links them when `relations` is true. Priority forcing and labels on the children are unchanged. |
| `duplicateRelation` | op-24 becomes op-11 (evidence, mandatory) followed by op-4/op-5 into the `cancelled` state, with `Duplicate of \`<ofKey>\`` as the comment's first line. If `cancel` is also false: op-11 then op-10, and the done-flag records `--outcome duplicate`. |
| `relations` | op-25 becomes op-11 on **both** issues, each naming the other key in backticks and the kind. Nothing is dropped: the "who owns which sites" note still lands on both sides. |
| `labels` | op-17/op-18 are never called. `checker.provenanceLabel`, `checker.triage.label`, the `checker.gate.labels.*` and `checker.a11y.labels.*` markers become body lines (`**Filed by:** fleet-check`, `**Gate:** pending`, `**A11y:** keyboard`) written at op-13 and mirrored by op-15; `fleet.queue.selector.excludeLabels` is ignored with a warning and the queue is gated by `checker.triage.state` / `checker.ready.state` instead; `priority.scale: labels` is invalid for this adapter. |
| `grouping: none` | op-20/op-21 are never called and `checker.project*` is ignored with a warning. The sweep is identified by `checker.provenanceLabel` plus its `sweepId` (or, with `labels` also false, by the `**Sweep:**` body line). |
| `workItems: none` | op-26/op-27 are never called; the on-disk `worklist.tsv` and ledger are the only worklist and `fleet check status` the only progress view. `comment`: every tick is one op-11 comment. `children`: one sub-task per PR (op-13 with `parent`), ticked by moving it to a `done`-type state. `checklist`: atomic per-item completion, no lock needed. `body`: op-15 patches, one call per wave. |
| `atomicPatch` | op-15 stays but is emulated: acquire the 1-slot `tracker-worklist:<KEY>` pool, read, apply the edits locally, write the whole body, release. Every op-27 tick goes through `fleet check tick --lock`. |
| `imageEmbed`/`imageUpload` | op-22 strategy falls to `assets-branch` when the code host can serve raw files, else `attachment-only`, else `none` with `_No screenshot attached: <reason>_`. |
| `findComplete: all-at-once` | op-16's `complete` is true by construction; the banding rule still applies where a scope can exceed one response. |
| `resolveChildren` | every key is a leaf; `fleet up --issues A,B` fans out exactly the keys given, and `fleet doctor` says so. |
| `cancel` | op-9 becomes op-11 then op-10; the done-flag still says `cancelled` with its `file:line` evidence so the launcher's report shows what needs a human close. |
| `attachLink` | the PR URL goes on its own body line via op-14 and into an op-11 comment. |
| `listQueue` | no autowave from the tracker; the queue is `fleet up --issues` / `fleet add`, or `fleet.queue.source: findings`. |
| `comment` | op-9 and op-24 are **refused** — the playbooks fall back to op-10 and put the evidence in the done-flag's `--reason` — because a closure with no evidence record is unaccountable, and the comment *is* the record. |
| `createIssue` | `/fleet-check` runs tracker-less: rows get `localId: CHK-<sweepId>-<n>`, `fleet check promote <sweepId> --fid …` flips their state, and sessions spawned from `fleet.queue.source: findings` take the finding body as their task text. |

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
      `Call:` line and an `If unsupported:` line; every `false`/`none` capability has **no** section and
      is covered by a row in *Degradation rules*. Parity is asserted in both directions.
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
      PR number, person, company or product appears anywhere — placeholders only (`ABC-1234`,
      `github.com/acme/app`, `ada`, `the operator`, `2026-03-14`).
- [ ] Every `⛔` rule you restated kept its one-sentence *why*; none was weakened.
- [ ] `fleet trackers show <id>` renders the adapter without warnings, and `node --test` passes.
