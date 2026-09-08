---
# trackers/_template.md — copy this file to trackers/<id>.md (bundled) or <repo>/.fleet/trackers/<id>.md
# (project overlay) and replace every placeholder. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens the file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line. Every field below is required
# unless its comment says optional. Placeholder values are deliberately fictional.

id: example-tracker              # MUST equal the filename without `.md` (trackers/example-tracker.md).
                                 # It is also the value of `tracker.id` in .fleet/config.json.
name: Example Tracker            # Human name shown by the wizard and by `fleet trackers list`.

mcp:
  # Tool-name prefixes that prove this tracker's MCP server is connected: if ANY tool visible in the
  # session starts with one of these, the tracker is connected. The session's own visible tool list is
  # the only reliable connection check — MCP config files on disk are not (a machine can list zero
  # servers while the tools are live in-session). Declare several when community servers differ.
  toolPrefixes: ["mcp__example_tracker__", "mcp__claude_ai_ExampleTracker__"]
  # Rendered VERBATIM by the first-run wizard when the tracker is not connected — adding a tracker adds
  # its own install instructions. `command` must be copy-pasteable on every platform (or omitted);
  # `instructions` is free text. Run every entry once on a clean machine before opening the PR.
  install:
    - label: "Add the Example Tracker MCP server"
      command: "claude mcp add example-tracker -- npx -y @example/tracker-mcp"                        # optional
      instructions: "Sign in when the browser opens, then start a new session so the tools appear."   # optional
  docs: https://example.com/docs/mcp   # Shown next to the install steps.

issueKey:
  pattern: "[A-Z][A-Z0-9]+-[0-9]+"   # Regex for ONE issue key. Must compile, must match `example`, and must
                                     # match nothing in a normal branch name (see the pre-PR checklist).
  caseInsensitive: true              # true: `abc-1234` typed by the operator resolves to ABC-1234.
  example: "ABC-1234"                # Used in prompts, tests and docs. Never a real key.
  derive: null                       # optional. Trackers whose items carry no human key name the op-2 result
                                     # field to use as <KEY> (e.g. a short-link id) so the branch, assets
                                     # and capture templates keep working. null = keys are native.

scope:
  label: team                        # What a "scope" is called here: team | project | repo | workspace | board.
  required: true                     # true: the wizard must obtain `tracker.scope` before `fleet up`.
  listOp: "mcp__example_tracker__list_teams"   # The tool that lists scope candidates for the wizard. The only
                                               # place besides a `Call:` line where a tool name may appear.

capabilities:
  resolveChildren: true              # op-1.     false = every key is a leaf; `fleet up --issues` fans out per key given.
  cancel: true                       # op-9.     false = evidence comment + leaveOpen; the done-flag still says `cancelled`.
  attachLink: true                   # op-8.     false = the PR URL goes on its own body line and in a comment.
  listQueue: true                    # op-12.    false = explicit keys (`fleet up --issues`) or `fleet.queue.source: findings`.
  comment: true                      # op-11.    false = op-9 and op-24 are REFUSED (no evidence record is possible).
  createIssue: true                  # op-13/14 (op-16 must also work). false = /fleet-check runs tracker-less.
  labels: true                       # op-17/18. false = markers move to body lines; selectors fall back to state.
  atomicPatch: true                  # op-15 is a native find/replace. false = read-modify-write under the
                                     # 1-slot `tracker-worklist:<KEY>` pool lock.
  subIssues: true                    # op-23.    false = the umbrella is an index issue whose body is a checklist.
  duplicateRelation: true            # op-24.    false = evidence comment + cancelled state, naming the original.
  relations: true                    # op-25.    false = a cross-linking comment on BOTH issues.
  grouping: project                  # op-20/21 target: project | epic | milestone | label | list | none.
  imageEmbed: inline                 # op-22 result: inline | attachment | none.
  imageUpload: mcp                   # op-22 transport for native-upload: mcp | rest | none.
  workItems: body                    # op-26/27 mirror shape: body | comment | children | checklist | none.
  findComplete: page-flag            # How op-16 proves completeness: page-flag | total | link-header | all-at-once.

priority:
  scale: numeric                     # numeric | named | labels | none. `labels`: the four map values are label
                                     # names that op-18 creates at plan time. `none`: priority lives only on
                                     # the `**Priority:**` body line.
  map: {1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}   # Canonical 1..4 → this tracker's values.

states:
  # The wizard proposes these NAMES (never ids) for `tracker.states`; op-4 resolves them per scope through
  # op-19 at run time. Names, because ids differ per scope and names are what op-19 returns.
  in-progress: {promptDefault: "In Progress"}
  in-review:   {promptDefault: "In Review"}
  cancelled:   {promptDefault: "Canceled"}

config:
  # Extra keys this adapter needs the wizard to ask for. `key` is either a contract `tracker.*` key or an
  # adapter-declared key under `tracker.settings.*` — nothing else. `detect` is an optional hint string for
  # `fleet config detect` to pre-fill the value (null = always ask). `required: true` blocks `fleet up`
  # until the key is answered.
  - key: tracker.rest.baseUrl
    prompt: "Base URL of your tracker's REST API (only needed for image upload)"
    detect: null
    required: false
  - key: tracker.settings.region
    prompt: "Which region hosts your workspace? (us | eu)"
    detect: null
    required: false

rest:
  # optional — present only when some op declares `Transport: rest`. Both values are CONFIG KEYS to read,
  # not literals. The token key is user-scope and SECRET: it is never written to the project file
  # (`fleet config validate` errors on it) — only to the user layer or the environment.
  baseUrlKey: tracker.rest.baseUrl
  tokenEnv: tracker.rest.tokenEnv
---

# Adapter template — adding a tracker to claude-fleet

An adapter is the only file that knows what a tracker's tools are called. Everything else in the
plugin — the playbooks, the CLI, the docs — speaks in the 27 operation names below (`op-1` …
`op-27`) and nothing else. That split is what keeps "tracker-agnostic" true over time: a new tracker
is one file and one pull request, and a malformed one fails CI, not someone's fleet.

Read this file top to bottom once. The invariants written under each op are what the playbooks assume
of **every** adapter; they were each paid for once already. Your adapter may restate the ones your
tracker makes easy to violate (one line each) and may never weaken one.

## How adapters are loaded

- **Bundled** adapters live at `${CLAUDE_PLUGIN_ROOT}/trackers/<id>.md`. A **project overlay** at
  `<repo>/.fleet/trackers/<id>.md` replaces the bundled file of the same id wholesale (no merging).
  There is no third copy anywhere under the user's home directory.
- `src/trackers/registry.mjs` parses the front matter. `fleet trackers list` names every adapter it
  found; `fleet trackers show <id>` prints one parsed and validated. `fleet config detect` proposes
  `tracker.id` from whichever adapter's `mcp.toolPrefixes` are visible in the session; the wizard
  renders `mcp.install[]` verbatim when none are.
- On `fleet up` the launcher writes `resolved.json` (which records the chosen `adapter`) and gives
  **every session** the adapter's path in its descriptor (`tracker.adapterPath`, alongside
  `tracker.id`, `tracker.mode`, `tracker.scope`, `tracker.states`, `tracker.assignee`) and injects
  that path into the session prompt beside the playbook. A session reads its descriptor from
  `FLEET_SESSION_FILE` and its mode from `FLEET_TRACKER_MODE` — never from a literal path.
- The playbooks call ops **by name only** ("run op-7, then op-8"). The session opens the adapter,
  finds `## op-<n>`, and executes the `Call:` line. If the section is absent, the capability is
  `false` and the *Degradation rules* below apply.

## Anatomy of an op section

Every supported op gets exactly one section, in numeric order, shaped like this:

```
 ## op-<n> <name>

 `<signature copied from the contract>`

 Call: `<the exact tool, endpoint or command, with its argument shape>`
 If unsupported: <what the caller does when this Call cannot be made in THIS session right now>

 <One or two sentences: what the op means here, and the invariants the Call must honour.>
```

(The example above is indented one space so nothing can mistake it for a real section; your real
sections start at column 0.)

- **`Call:`** is the only line in the whole plugin that may name a tracker tool. Make it something a
  model can execute without guessing: tool name, argument names, and how the result maps onto the
  signature's return shape. For `Transport: rest` write the method and path with the config key that
  supplies the base URL (`{tracker.rest.baseUrl}`), never a literal host.
- **`If unsupported:`** answers "the tool is not visible, `tracker.mode` is `manual`, the transport is
  not configured, or the tracker rejected the call as unavailable — now what?" Reads fall back to the
  offline ticket cache or the CLI; writes go to the tracker outbox (both described below — do not
  re-document them, just name them). It is **not** where you document a feature your tracker lacks:
  for that, set the capability to `false` and delete the section.
- **`## op-22`** additionally carries a `Strategy:` line and, whenever a non-MCP transport is
  involved, a `Transport:` line.

Which capability gates which section (the registry test enforces this both ways):

| capability | sections | capability | sections |
| --- | --- | --- | --- |
| `resolveChildren` | op-1 | `atomicPatch` | op-15 is native; `false` keeps the section but emulates |
| `cancel` | op-9 | `subIssues` | op-23 |
| `attachLink` | op-8 | `duplicateRelation` | op-24 |
| `listQueue` | op-12 | `relations` | op-25 |
| `comment` | op-11 | `grouping` ≠ `none` | op-20, op-21 |
| `createIssue` | op-13, op-14, op-16 | `imageEmbed`/`imageUpload` ≠ `none` | op-22 (strategy `native-upload`) |
| `labels` | op-17, op-18 | `workItems` ≠ `none` | op-26, op-27 |
| always present | op-2, op-3, op-4, op-5, op-6, op-7, op-10, op-19 | `findComplete` | how op-16 fills `complete` |

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Call: `mcp__example_tracker__list_issues({ parentId: <id of parentKey>, limit: 250 })` → map `identifier` → `key[]` in display order
If unsupported: the launcher treats the key as a leaf and says so in the `fleet up` output; reads are never queued to the outbox.

Returns the direct children of a parent so the launcher can fan out **one session per child**
(`fleet up --issues <parent>`, `fleet add <parent>`); sessions never call it. An assigned key is
typically one child of a parent that was split across sessions — a session works **only** its assigned
issue, never the parent, never a sibling — so return leaves only, and an empty array for a leaf.
Apply the op-16 completeness rule to the page.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Call: `mcp__example_tracker__get_issue({ id: <key> })` → `description` is the raw markdown body, `status` is the state NAME, `priority` is canonical 1..4 via `priority.map`
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

One issue by key. `suggestedBranch` only when the tracker offers one — the session prefers it and
otherwise renders `vcs.branchTemplate`. The launcher calls op-2 for every assigned key **before**
spawning and pipes the JSON into `fleet ticket cache --issue <KEY> --from-json -`, which is what
makes the fallback above exist.

⛔ If the tracker tools are not visible in your session, do **not** stall on that — read the ticket
cache and carry on; write a blocked flag (`fleet flag blocked --category tracker …`) only if that
file is missing too — because tracker tools can race a fleet-launch burst, and every state write you
owe meanwhile travels through the outbox, so nothing is lost by proceeding.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Call: `"me"` → `mcp__example_tracker__get_viewer({})` → `id`; anything else → `mcp__example_tracker__list_users({ query: <nameOrEmail> })` → the single exact match's `id`
If unsupported: for `"me"`, use the tracker's authenticated-identity call; if none exists, `tracker.defaultAssignee` must hold a literal ref set in the **user** layer.

`"me"` means the authenticated tracker user and is the only assignee the playbooks ever ask for,
unless `checker.routing` matches the **defect's** path. Return the tracker's opaque ref — some
trackers identify users only by an account id, so an email is never assumed to be a valid ref.

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public.

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 for `scope`, then pick the state whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → its `id`
If unsupported: trackers with no status field return the list or column id the transition maps to.

Maps the three canonical transitions to a real state in this scope. It is its own step because some
trackers set status through **transitions that depend on the current status**, and because state
names differ per team.

⛔ Never hard-code a state id or name in a `Call:`; resolve it every time through the configured
scope — because a tracker can hold two states of the same type (two "cancelled" states, one of them
destructive and irreversible), and only the configured name tells them apart.

## op-5 setState

`setState(key, stateRef)`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, stateId: <stateRef> })`, then op-2 to confirm `status` changed
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the ref and applies it.

One transition. Re-read after writing on trackers that use transitions — a transition that is not
legal from the current status can fail silently, and the playbooks treat "I called setState" as
"the state changed".

## op-6 assign

`assign(key, userRef)`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, assigneeId: <userRef> })`
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Assign to the ref op-3 returned. The default is always `"me"`; `checker.routing` is the only thing
that changes it, and it matches on the path of the defect, not the PR that surfaced it.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `(tracker.scope, in-review)` → op-5 `(key, stateRef)`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. It is listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context.

## op-8 attachLink

`attachLink(key, url, title)`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, links: [{ url: <url>, title: <title> }] })`
If unsupported: put the URL on its own line in the body via op-14 (most trackers auto-embed a bare URL) and in an op-11 comment; queue to the outbox when tools are down.

Attach the PR URL to the issue.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the issue, and
never sleep on it — because the attachment budget is per-workspace, so it shrinks exactly as the
fleet grows, and re-creating is how duplicates appear. Record the key, move on, and let the
launcher's serial cleanup pass attach it when waiting is free; a bare PR URL in the body keeps the
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

Call: `mcp__example_tracker__save_comment({ issueId: <id of key>, body: <verbatimText> })`
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason.

⛔ Never truncate text containing issue keys at a raw character offset; cut at a word boundary,
strip trailing `(KEY-` fragments, and wrap every surviving key in backticks — because a cut key
becomes a valid *shorter* key that autolinks to a real, unrelated issue and pollutes it with
backlinks, while the write "succeeds" and looks fine in the echo.

## op-12 listQueue

`listQueue(selector) → key[]`

Call: `mcp__example_tracker__list_issues({ teamId: <tracker.scope>, state: <selector.state>, labels: <selector.labels>, excludeLabels: <selector.excludeLabels>, assignee: <selector.assignee>, limit: 250 })` → keys sorted by priority
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside `tracker.queue` / `tracker.scope`, priority-sorted; the launcher writes them to `queue.txt`
for autowave. The default selector excludes `checker.triage.label`, and the result is only a
**candidate** list: `fleet intake check` still refuses any checker-filed ticket that lacks
`gate:passed|waived` when `fleet.queue.requireGate` is on, and counts the refusals — never silently.
Apply the op-16 completeness rule to the page.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Call: `mcp__example_tracker__save_issue({ teamId: <tracker.scope>, title, description: <body>, labelIds: <ids from op-17>, priority: <priority.map[n]>, assigneeId: <op-3 "me">, projectId: <group>, parentId: <parent>, stateId: <state>, links })` → `{ identifier, id, url }`
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the issue and records the key.

One issue per finding. `state?` is `checker.triage.state`; `labels[]` always carry
`checker.triage.label`, `checker.provenanceLabel` and `checker.gate.labels.pending`, and only names
that op-17 returned; `assignee` is `"me"` unless `checker.routing` matches the defect's path.

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

A failed `links[]` entry is cosmetic (op-8 rule); the issue is created correctly without it.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, …only the fields given; labelIds = current ∪ add − remove })`
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`), never a replacement — because a
replacement erases the labels another pass added (gate labels, a11y labels). `fleet check gate
apply` uses it to mirror `gate:<status>`; the rediscovery rule uses it to append a new call site to
an existing issue (body and comment only — never title or state, so it reads as new evidence).

⛔ Editing an issue you did not create is **launcher-only** — because parallel writers to one issue
overwrite each other, while creating *distinct* issues shares no mutable state and parallelises
cleanly. The line is shared state, not the tracker itself.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, patch: [{ op: "replace", find, replace }, …] })` → `applied` = number of edits that matched exactly once
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'`.

Find/replace edits against the body; each `find` must match exactly once. With `atomicPatch: true`
this is the tracker's native patch; with `false` the adapter emulates it by read-modify-write under
`fleet pool acquire tracker-worklist:<KEY>` (release with `fleet pool release`), because two
unlocked read-modify-writes silently drop one another's edits.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ Send N edits in **one** call per wave, never one call per edit — because the response echoes the
whole body every time (a 322-row body costs ~25 KB per call), while several edits in one call is
still a single serialized write with no clobber risk.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Call: `mcp__example_tracker__list_issues({ projectId: <group>, labels, priority, state, parentIsNull, query: <text>, createdAfter, limit })` → `issues[]` (each with `key,id,title,priority,status,parentId`), `complete = !response.hasNextPage`
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and must file tracker-less (`localId` rows) — say so in your PR.

Filtered query. `complete` is derived per `capabilities.findComplete`: `page-flag` (a has-more flag),
`total` (a total count to compare against), `link-header` (pagination headers), or `all-at-once`
(the tracker never pages). `reconcile.assertComplete()` in the CLI trusts nothing else.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates.

⛔ Band the query by `priority` (1, 2, 3, 4 — one call each) so each band fits a page, assert
`complete` on **every** band before combining, and print the per-band counts — because a band
silently at its cap is the failure you are looking for.

⛔ Exclude parents structurally with `parentIsNull: true`, never by a list of parent ids — because
an umbrella filed later carries the same labels and priority as its own children and walks straight
into any frame keyed on those; an id list is a snapshot of the parents you knew about when you wrote it.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Call: `mcp__example_tracker__list_issue_labels({ teamId: <scope>, limit: 250 })` → `[{ id, name }]`, complete per op-16's rule
If unsupported: label-driven markers move to body lines (see *Degradation rules*).

⛔ Sessions and workers pick labels from this list **only**; nobody invents one — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Call: op-17, return the match by exact `name`; else `mcp__example_tracker__create_issue_label({ teamId: <scope>, name })` → `{ id }`
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`,
`checker.triage.label`, every `checker.gate.labels.*`, both `checker.a11y.labels.*`, and the four
`priority.map` names when `priority.scale: labels`.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Call: `mcp__example_tracker__list_issue_statuses({ teamId: <scope> })` → `[{ id, name, type }]` with `type` mapped onto `triage | unstarted | started | review | done | cancelled`
If unsupported: trackers without states return their lists or columns as states, typed through `tracker.states`.

Every state in the scope with its canonical type. op-4 picks from it; `checker.ready.state`
defaults to the adapter's `unstarted` state. Return **all** states of a type, not the first — op-4
must be able to choose the configured one.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Call: `mcp__example_tracker__list_projects({ teamId: <tracker.scope>, query: <ref> })` → the exact match by `id`, `slug` or `name`
If unsupported: `grouping: none` — there is no group; `checker.provenanceLabel` alone marks the sweep.

Resolves `checker.project` (id, slug or name) once at plan time.

⛔ From then on reference the group by **id** everywhere — in `manifest.json`, in every worker brief,
in every op-13 call — never by name — because names carry apostrophes and change, and a pointer kept
in prose or memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Call: `mcp__example_tracker__save_project({ teamId: <tracker.scope>, name })` → `{ id, url }`
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question.

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: native-upload | assets-branch | attachment-only | none   ← declare exactly one
Transport: mcp | rest | cli                                        ← declare exactly one; required whenever the strategy is not `none`
Call: `mcp__example_tracker__prepare_attachment_upload({ issueId: <id of key>, filename, contentType: "image/png", size })` → `{ uploadRequest, assetUrl }`; PUT the file to `uploadRequest.url` with **every** `uploadRequest.headers` entry verbatim; `url = assetUrl`, `embed = "![<alt>](<assetUrl>)"`
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy`, never improvised at filing time:

- `native-upload` — prepare → signed PUT → embed, through `Transport: mcp` or `Transport: rest`
  (`{tracker.rest.baseUrl}` + the token named by `tracker.rest.tokenEnv`).
- `assets-branch` — `fleet assets add <file…> --branch <name>` commits the PNGs to the branch rendered
  from `vcs.assetsBranchTemplate` and returns hot-linkable raw URLs to embed. On a private repository
  those render as broken images to anyone not signed in to the code host — say so in your adapter.
- `attachment-only` — attach the file, then a caption sentence in the body; no inline image.
- `none` — `_No screenshot attached: <reason>_`, counted **separately** from `_No UI surface — <reason>_`
  in the report, because "the app was down" and "there is no screen" are different outcomes and lumping
  them overstates coverage.

⛔ Store the **bare** URL — because the tracker re-signs it on read; a signed URL copied forward
expires, and the image dies in every sibling issue that inlined it.

⛔ **One upload per screenshot.** Create the first issue, upload its shot once, then create the sibling
findings with the same `embed` already inlined — because several findings from one PR share one
screen, and per-issue uploads turn a 300-finding sweep into ~900 round-trips.

⛔ The signed upload URL lives about **60 seconds**, and one file must finish before the next is
prepared — because a second prepare invalidates the first, and a half-uploaded PNG embeds as a broken
image nobody re-checks.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none.

## op-23 setParent

`setParent(key, parentKey)`

Call: `mcp__example_tracker__save_issue({ id: <id of key>, parentId: <id of parentKey> })`
If unsupported: the umbrella becomes an index issue whose body is a checklist of its children (op-15 / op-14), and each child carries a `**Parent:**` body line plus op-25 when available.

Make `key` a sub-issue of `parentKey`. Its main use is the a11y umbrella (`checker.a11y.umbrella`,
titled `checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the
working queue while keeping **one issue per gap** — a pattern ticket would lose the per-site
file/line/PR that makes each one actionable.

⛔ Parenting onto the umbrella is **launcher-only**; a worker passes `parent?` at op-13 time only for
issues it creates itself — because the umbrella is shared state.

⛔ When re-parenting retroactively, query each a11y label with op-16 and **union the two result sets
by id** before iterating — because the two label queries overlap heavily, and iterating both issues
duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over parent/child when two findings
carry different severities — because nesting an Urgent under a High buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Call: op-11 `(key, <evidence, verbatim, naming ofKey in backticks>)`, **then** `mcp__example_tracker__save_issue({ id: <id of key>, duplicateOf: <id of ofKey> })` — the relation moves the state by itself
If unsupported: op-11 with the same evidence, then op-4 `(tracker.scope, cancelled)` → op-5, with `Duplicate of \`<ofKey>\`` as the comment's first line; if `cancel` is also `false`, op-11 then op-10.

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

Call: `mcp__example_tracker__save_issue({ id: <id of key>, relations: [{ type: <kind mapped to this tracker's vocabulary>, issueId: <id of otherKey> }] })`, then op-11 `(key, note)` and op-11 `(otherKey, note)`
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. `kind` is whatever the playbook passes
(`related`, `blocks`, and the partial-overlap shapes); map it onto the closest relation your tracker
has and say which in the `Call:`. When a pair is judged *distinct* but the two name a shared line or a
causal link, relate them and put the "who owns which sites" note on **both** — because a distinct
verdict that still needs an action is silently lost otherwise, and closing one ticket half-closes the
other's sites.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Call: op-2 `(key)` → parse every body line matching `^- \[( |x|X)\] #(\d+)` → `{ pr, done, keys: <backticked keys on the line>, raw: <the untouched line> }`
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the to-do issue, in the shape
`capabilities.workItems` declares: `body` (a checklist in the description), `comment` (one comment
per PR), `children` (one sub-task per PR), or `checklist` (native, atomic items). `raw` is the exact
line op-27 will anchor its edit on.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Call: op-15 `(key, [{ find: "- [ ] #<pr>", replace: "- [x] #<pr> (\`<key1>\`, \`<key2>\`)" }, …])` — one call per wave carrying every PR resolved in it; `checklist` shape: the tracker's atomic set-complete call per item
If unsupported: `workItems: none` — no-op; `fleet check status` is the only progress view.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op the
instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells them
the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from the
shared ledger — because parallel writers to one description overwrite each other, and a bookkeeping
step attached to one execution path dies when the path changes (the tick once vanished the day filing
moved to subagents while the ledger append survived).

⛔ Anchor on the leading `- [ ] #<n>` and backtick-wrap every key you append — because a bare `#<n>`
also appears inside other PR titles on the same list, and an unwrapped key autolinks.

⛔ Patch, never a whole-body rewrite — because patches are atomic and cannot clobber a concurrent
edit. With `atomicPatch: false`, do the read-modify-write under `fleet pool acquire
tracker-worklist:<KEY>` and release it immediately after; `fleet check tick --lock` does exactly this.

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

## Degradation rules

What the playbooks do when a capability is `false` (or `none`). These are the plugin's behaviour, not
yours to redefine — if your tracker needs a different degradation, propose it in the PR.

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
| `createIssue` | `/fleet-check` runs tracker-less: rows get `localId: CHK-<sweepId>-<n>`, `/fleet-check promote` flips their state, and sessions spawned from `fleet.queue.source: findings` take the finding body as their task text. |

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
