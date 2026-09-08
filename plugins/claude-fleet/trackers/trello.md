---
# trackers/trello.md — the bundled Trello adapter. The YAML front matter is MACHINE-READ by
# src/trackers/registry.mjs; the markdown body is MODEL-READ — a session opens the file, finds the
# `## op-<n>` section the playbook named, and executes its `Call:` line. A project overlay at
# <repo>/.fleet/trackers/trello.md replaces this file wholesale.

id: trello                       # == filename without `.md`; the value of `tracker.id` in .fleet/config.json.
name: Trello

mcp:
  # Any visible tool starting with this prefix proves a Trello MCP server is connected. Trello has no
  # first-party server, so the prefix is whatever NAME the community server was registered under — the
  # install step below registers it as `trello`, which is what produces `mcp__trello__…`. The session's
  # own visible tool list is the only reliable connection check; MCP config files on disk are not.
  toolPrefixes: ["mcp__trello__"]
  # Rendered VERBATIM by the first-run wizard when no prefix is visible. Trello authenticates every call
  # with an API key plus a token, and the community servers read both from their own environment; the
  # same two variables also drive this adapter's REST transport, which is NOT optional here (members,
  # labels, search and uploads have no MCP tool on any server surveyed).
  install:
    - label: "Create a Trello API key and a token for your own account"
      instructions: "Open the Trello Power-Ups admin (trello.com/power-ups/admin), create or open a Power-Up, generate an API key, then follow the token link beside it and authorise a token. The key is a public identifier; the token is a full login to your account — keep it out of committed files."
    - label: "Register a community Trello MCP server under the name `trello`"
      command: "claude mcp add trello -e TRELLO_API_KEY=<your key> -e TRELLO_TOKEN=<your token> -- npx -y @delorenj/mcp-server-trello"
      instructions: "Start a new session so the tools appear. Any community server works as long as it is registered under the name `trello` (that is what makes the tool prefix match) and offers the tools the `Call:` lines below name; registering it under another name changes the prefix and the adapter reports the tracker as not connected. Every op also names a REST twin, so a server missing a tool is a degradation, not an outage."
    - label: "Put the same two values in your own environment for the REST transport"
      instructions: "Export the key and the token under the variable names you give for tracker.settings.apiKeyEnv and tracker.rest.tokenEnv, the way your platform sets environment variables. The token variable is a user-layer secret: never in .fleet/config.json."
  docs: https://developer.atlassian.com/cloud/trello/rest/

issueKey:
  # Trello cards carry NO human key. The fleet's <KEY> is the card's `shortLink` — the 8-character id in
  # `https://trello.com/c/<shortLink>` — named through `derive` below, so branch, assets and capture
  # templates keep working unchanged. A shortLink is accepted anywhere the API takes a card id, is stable
  # for the card's life, and is case-SENSITIVE.
  #
  # A bare `[a-zA-Z0-9]{8}` would also match an ordinary eight-letter word in a branch slug and an
  # eight-hex-character sha fragment in a `check/<sweepId>/<slice>` branch — and a false match costs a real
  # session, because this is the regex the reclaim watcher reads keys with. So the pattern is word-bounded
  # and refuses the two shapes a real shortLink almost never takes: all-lowercase letters (≈0.1% of
  # shortLinks) and lowercase hex digits only (≈0.002%). Single-quoted so YAML leaves the backslashes alone.
  pattern: '\b(?![a-z]{8}\b)(?![0-9a-f]{8}\b)[a-zA-Z0-9]{8}\b'
  caseInsensitive: false           # shortLinks are case-sensitive: `Ab1Cd2Ef` and `ab1cd2ef` are different cards.
  example: "Ab1Cd2Ef"
  derive: shortLink                # op-2 returns `key = shortLink`; every {key} template renders that.

scope:
  label: board                     # One BOARD is the scope: its lists are the states, its labels are the
  required: true                   # labels, a sweep's group is one of its lists. `tracker.scope` = board id.
  listOp: "mcp__trello__list_boards"   # Lists the boards the token can see so the wizard can offer them. The
                                       # only place besides a `Call:` line where a tool name may appear.

capabilities:
  resolveChildren: false           # op-1  — cards have no children; every key is a leaf (see the op-1 section).
  cancel: true                     # op-9  — evidence comment, move to the cancelled list, then archive.
  attachLink: true                 # op-8  — a URL attachment; Trello renders a PR link as a link tile.
  listQueue: true                  # op-12 — the open cards of the list the selector's state names.
  comment: true                    # op-11 — a card comment, markdown, verbatim.
  createIssue: true                # op-13 / op-14 / op-16.
  labels: true                     # op-17 / op-18 — board labels (a board owns its own label set).
  atomicPatch: false               # op-15 stays, emulated: there is no patch call and a description write
                                   #        replaces the whole field, so read-modify-write under the 1-slot
                                   #        `tracker-worklist:<KEY>` pool lock.
  subIssues: false                 # op-23 — no parent field on a card; the a11y umbrella is an index card.
  duplicateRelation: false         # op-24 — no duplicate relation; evidence comment, then op-25, then op-9's close.
  relations: true                  # op-25 — a card URL attached to a card renders as a live card tile, both ways.
  grouping: list                   # op-20 / op-21 — a sweep's group is a LIST on the board.
  imageEmbed: attachment           # op-22 — the PNG is an attachment and becomes the card cover; no inline image.
  imageUpload: rest                # op-22 — multipart upload over REST; no server surveyed uploads a local file.
  workItems: checklist             # op-26 / op-27 — native check items on the work-list card; a tick is atomic.
  findComplete: all-at-once        # op-16 — the board-cards read returns the board in one unpaged response.

priority:
  # Cards have no priority field on any plan, so the four canonical priorities are board labels that op-18
  # creates at plan time. The `**Priority:**` body line carries the same value — see op-13.
  scale: labels
  map: {1: "priority: urgent", 2: "priority: high", 3: "priority: medium", 4: "priority: low"}

states:
  # Trello has no status field: a state is a LIST (a column) and `tracker.states` holds list NAMES; op-4
  # turns a name into a list id through op-19 at run time, because a list id is meaningless off its board.
  # A default board ships three lists, so create the missing columns before `fleet up`.
  in-progress: {promptDefault: "Doing"}
  in-review:   {promptDefault: "Review"}
  cancelled:   {promptDefault: "Cancelled"}

config:
  - key: tracker.settings.listIds
    prompt: "Optional: pin list ids per state name ({\"Doing\": \"<list id>\"}) — needed only when two lists on the board share a name"
    detect: null
    required: false
  - key: tracker.rest.baseUrl
    prompt: "Base URL of the Trello REST API (members, labels, search and uploads have no MCP tool)"
    detect: "https://api.trello.com/1"
    required: true
  - key: tracker.rest.tokenEnv
    prompt: "Name of the environment variable holding your Trello TOKEN (user layer only — never the project file)"
    detect: "TRELLO_TOKEN"
    required: true
  - key: tracker.settings.apiKeyEnv
    prompt: "Name of the environment variable holding your Trello API KEY (a public identifier, not a secret; the same one the MCP server reads)"
    detect: "TRELLO_API_KEY"
    required: true

rest:
  # Present because several ops declare `Transport: rest`. Both values are CONFIG KEYS to read, not
  # literals. Trello authenticates every REST call with TWO query parameters: `key` (public, from the env
  # var named by tracker.settings.apiKeyEnv) and `token` (secret, from the env var named below). The token
  # key is user-scope and SECRET: `fleet config validate` errors if it appears in the project file.
  baseUrlKey: tracker.rest.baseUrl
  tokenEnv: tracker.rest.tokenEnv
---

# Trello adapter

Trello is the adapter that stresses the abstraction hardest, and this file exists to show the 27 ops
survive it. Almost nothing the playbooks assume of a tracker is native here:

| the playbooks say | on Trello it is |
| --- | --- |
| issue, `<KEY>` | a **card**; the key is its 8-character `shortLink` (`Ab1Cd2Ef`), derived by op-2 |
| scope | one **board** — `tracker.scope` is the board id |
| state | the **list** the card sits in; `tracker.states` names lists, op-4 maps a name to a list id |
| assignee | a **member** on the card — cards hold a set of members and have no single assignee |
| label | a **board label**; priority is four of them (`priority.map`) |
| group / project | a **list** per sweep (`grouping: list`) |
| parent / child | nothing — the a11y umbrella is an **index card** whose body lists its children |
| duplicate relation | nothing — evidence comment, card link, cancelled list, archive |
| screenshot | an **attachment** that becomes the card **cover**; no inline image |
| work-list mirror | a native **checklist** on the work-list card; ticking one item is one atomic call |
| cancel | comment, move to the cancelled list, then **archive** (`closed: true`) |

Two facts drive most of the rules below.

**A card has no key.** The number on a card front (`idShort`, shown as `#12`) is unique only within its
own board and is documented as subject to change, so the fleet never uses it: `shortLink` is the key,
and lowercasing it names a different card. Everything keyed on `<KEY>` therefore renders from it
unchanged, once `vcs.branchTemplate` is set to the `{key}` form the ⛔ below prescribes: a branch
`ada/Ab1Cd2Ef-<slug>`, an assets branch `assets-Ab1Cd2Ef`, a capture ref `capture/Ab1Cd2Ef`, a cached
ticket `Ab1Cd2Ef.json`. `fleet doctor` reports `resolveChildren: false` for
this adapter — every key is a leaf, and `fleet up --issues A,B` fans out exactly the keys given.

**A state is a column.** Moving a card is the only transition there is, a card is in exactly one list,
and so a state list and a group list compete for the same card. That is why the sweep's list *is* its
triage column (op-13, op-20) and why op-5's move silently takes a card out of its group.

## Conventions every `Call:` below assumes

- **MCP.** Community servers differ. The tool names written below are the ones a widely used server
  exposes; read `tools/list` once per session and map the argument names before the first write, and use
  the REST twin named on the same line whenever the tool is missing. Nothing else in the plugin knows a
  tool name.
- **REST** (`Transport: rest`). Base URL from `{tracker.rest.baseUrl}`; **every** call carries
  `key=<value of the env var named by tracker.settings.apiKeyEnv>` and
  `token=<value of the env var named by tracker.rest.tokenEnv>` in the query string, written `key=…&token=…`
  below. Bodies are form or query parameters, not JSON. Issue the calls with `curl`, which is present on
  Windows 10+ and every POSIX platform — never a shell-specific recipe. An op whose **primary** call is
  REST declares `Transport: rest`; an op that has an MCP tool names its REST twin on the same `Call:`
  line, so the launcher can drain the outbox for it with no MCP connected at all.
- **Bodies are markdown.** A card description and a comment are stored and returned literally and rendered
  as markdown, so `**PR:** #<n>`, `**Priority:**`, backticked keys and the `_No UI surface — <reason>_`
  sentence all survive byte-for-byte, which is exactly what the join rules in op-13 and op-16 need.

⛔ The token travels in the **query string** — never paste a REST URL into a comment, a card, a flag, a
dev page or a PR body, and redact `token=` before quoting any error — because a leaked token is a full
login to the operator's account, query strings survive in shell history and proxy logs, and this adapter
is public.

⛔ Trello rate-limits **per token** (100 requests per 10 seconds; 300 per 10 seconds per API key, and
`/1/members/` far harder at 100 per 900 seconds), and a 429 is never a reason to sleep-loop — record the
key, mark the write cosmetic, or queue it to the outbox and move on — because the budget is shared by
every session on one token, so it shrinks exactly as the fleet grows, and a session sleeping on a
cosmetic write holds a worktree the launcher could have reclaimed.

⛔ Set `vcs.branchTemplate` to `"{prefix}/{key}-{slug}"` rather than the default `{key-lower}` form —
because a lowercased shortLink names a **different card**, and the reclaim watcher reads keys back out of
branch names with the case-sensitive pattern in the front matter.

## op-1 resolveChildren

`resolveChildren(parentKey) → key[]`

Call: none — `resolveChildren: false`; a card has no children, so there is nothing to call
If unsupported: every key is a leaf; `fleet up --issues A,B` fans out exactly the keys given, `fleet add <k>` adds one session, and `fleet doctor` says so. Reads are never queued to the outbox.

Degradation, in full: a "parent" here is a convention, not a structure — a card whose body links other
cards, or a checklist of them. The launcher never opens a card looking for children, so work is split
across sessions by passing the child cards' keys explicitly. A session works **only** its assigned card,
never the parent, never a sibling, and never a card the body happens to link.

⛔ Never point `fleet up --issues` at a sweep's work-list card — because with `workItems: checklist` its
check items are the per-PR rows of op-26, not tickets, and a human reading that card cannot tell the
difference from the outside.

## op-2 getIssue

`getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}`

Call: `mcp__trello__get_card({ cardId: <key>, includeMarkdown: true })` (REST twin `GET {tracker.rest.baseUrl}/cards/<key>?fields=id,shortLink,shortUrl,name,desc,idList,idLabels,idMembers,closed&key=…&token=…`) → `key = shortLink`, `id = id`, `title = name`, `description = desc` (raw markdown), `url = shortUrl`, `status` = the name of the list `idList` names, resolved through op-19, `priority` = the canonical 1..4 whose `priority.map` label id is in `idLabels` (`null` when none is), `parentId = null` always; no `suggestedBranch`
If unsupported: read the offline ticket cache at the descriptor's `ticketFile` (or `fleet ticket show <KEY>`); reads are never queued.

One card by key. Both transports accept the `shortLink` wherever a card id is expected, so `<key>` needs
no lookup. Trello suggests no branch name, so the session renders `vcs.branchTemplate`. The launcher calls
op-2 for every assigned key **before** spawning and pipes the JSON into
`fleet ticket cache --issue <KEY> --from-json -`, which is what makes the fallback above exist.

An archived card keeps its `idList`, so `status` is still that list's name and `closed: true` is what says
it is off the board — which is exactly why op-9 moves a card to the cancelled list *before* archiving it.

⛔ If the tracker tools are not visible in your session, do **not** stall on that — read the ticket
cache and carry on; write a blocked flag (`fleet flag blocked --category tracker …`) only if that
file is missing too — because tracker tools can race a fleet-launch burst, and every state write you
owe meanwhile travels through the outbox, so nothing is lost by proceeding.

⛔ Derive `<KEY>` from `shortLink` only — never from the card-front number and never from the URL slug —
because the number is unique to one board and documented as subject to change, and the slug is the title,
which filing rewrites; a key that changes silently orphans the session's branch, its assets branch and its
capture ref.

⛔ Prefer the descriptor's `issue` field to any branch-name parse when both are available — because the
key pattern here is a recogniser of last resort: it deliberately refuses the two branch-token shapes that
collide with a shortLink, and an eight-character slug word containing a digit can still fool it, whereas
the descriptor was written by the launcher from op-2.

## op-3 resolveUser

`resolveUser(nameOrEmail|"me") → userRef`

Transport: rest
Call: `"me"` → `GET {tracker.rest.baseUrl}/members/me?fields=id,username,fullName&key=…&token=…` → `id`; anything else → `GET {tracker.rest.baseUrl}/boards/<tracker.scope>/members?fields=id,username,fullName&key=…&token=…` → the **single** member whose `username` or `fullName` matches `<nameOrEmail>` exactly → `id`; zero or several matches is refused, never guessed
If unsupported: the launcher resolves `"me"` once at `fleet up` and writes the ref into every descriptor as `tracker.assignee`; with no REST transport at all, `tracker.defaultAssignee` must hold a literal member id set in the **user** layer.

`"me"` means the token's owner and is the only assignee the playbooks ever ask for, unless
`checker.routing` matches the **defect's** path. Return the opaque member `id`, never the username:
usernames are changed by their owners, ids are not. Trello exposes no email address on a member, so an
address in `checker.routing` cannot resolve here — route by `username`, and `fleet config validate` warns
about an `@` in a project-scope routing value for the same reason it always does.

⛔ Resolve `"me"` **once** per launch and reuse the ref from the descriptor — never once per card, never
once per op — because the `/1/members/` routes allow only 100 requests per 900 seconds per token, so a
fleet whose sessions each resolve themselves exhausts that budget in the first wave and every later
assign returns 429.

⛔ No person is ever named in an adapter, a playbook, or a project-scope config value; the assignee
is "the current user" (`"me"`) — because a name in a committed file is an org chart, and adapters
are public.

## op-4 resolveState

`resolveState(scope, in-progress|in-review|cancelled) → stateRef`

Call: op-19 for `scope`, then the one **open** list whose `name` equals `tracker.states.<transition>` (adapter `promptDefault` when unset) → its `id`; only when that name matches **more than one** open list does `tracker.settings.listIds[<the configured name>]` come in, and only after op-19's own open lists are checked for that id — a pinned id no open list carries is refused, never used
If unsupported: this tracker has no status field, so the transition maps to nothing else — the launcher reports the missing list and every dependent write waits in the outbox.

Maps the three canonical transitions to a list on this board. It is its own step because a list id is
meaningless off its board, because the operator renames columns, and because state names differ per board.

⛔ Never hard-code a list id or name in a `Call:`; resolve it every time through the configured
scope — because a board can hold two lists of the same name (Trello does not enforce uniqueness), and
only the configured name — or, when even that is ambiguous, the id pinned in `tracker.settings.listIds` —
tells them apart.

⛔ If the configured name matches **no** open list, or **more than one** with no pinned id among them,
fail loudly and stop the transition — never pick "the closest" or "the first", and never take a pin
op-19's open lists do not carry — because a card moved to the wrong column looks exactly like a finished
transition to every check that follows, and an archived list of the same name is not a state at all.

## op-5 setState

`setState(key, stateRef)`

Call: `mcp__trello__move_card({ cardId: <key>, listId: <stateRef> })` (REST twin `PUT {tracker.rest.baseUrl}/cards/<key>?idList=<stateRef>&key=…&token=…`), then op-2 to confirm `idList` equals `stateRef`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"<in-progress|in-review|cancelled>"}'` — the launcher resolves the list and applies it.

One move. Because a card is in exactly one list, setting a state also **leaves** the previous one —
including a sweep's group list (op-13, op-20), which is by design here. Re-read after writing: a move onto
an archived list, or a list on another board, is rejected without the card changing, and the playbooks
treat "I called setState" as "the state changed".

## op-6 assign

`assign(key, userRef)`

Transport: rest
Call: `POST {tracker.rest.baseUrl}/cards/<key>/idMembers?value=<userRef>&key=…&token=…` — a member already on the card is a no-op, not an error
If unsupported: `fleet outbox add --op assign --key <KEY> --args '{"user":"me"}'`.

Add the member op-3 returned. The default is always `"me"`; `checker.routing` is the only thing that
changes it, and it matches on the path of the defect, not the PR that surfaced it.

⛔ This op only ever **adds** a member, never removes one — because a card holds a set of members with no
"the" assignee, and a removal is somebody else's assignment being undone by a session that cannot know
why it was there.

## op-7 setState

`setState(key, in-review)  (= op-5 with resolveState)`

Call: op-4 `(tracker.scope, in-review)` → op-5 `(key, stateRef)`
If unsupported: `fleet outbox add --op setState --key <KEY> --args '{"state":"in-review"}'`.

The close-out transition, made right after the PR is pushed and paired with op-8. It is listed
separately because it is the one transition every working session makes and the one the launcher
must be able to replay from the outbox without any context — it needs only the key and the word
`in-review`.

## op-8 attachLink

`attachLink(key, url, title)`

Call: `mcp__trello__attach_file_to_card({ cardId: <key>, fileUrl: <url>, name: <title> })` (REST twin `POST {tracker.rest.baseUrl}/cards/<key>/attachments?url=<url>&name=<title>&key=…&token=…`) → the PR URL becomes a link tile on the card
If unsupported: put the URL on its own line in the body via op-14 (Trello renders a bare URL in a description as a link) and in an op-11 comment; queue to the outbox when tools are down.

Attach the PR URL (`https://github.com/acme/app/pull/<n>`) to the card with the PR title as its name.

⛔ A failed link attachment is **cosmetic and separately retryable** — never re-create the card, and
never sleep on it — because the request budget is per token and shared by the whole fleet, so it shrinks
exactly as the fleet grows, and re-creating is how duplicates appear. Record the key, move on, and let
the launcher's serial cleanup pass attach it when waiting is free; a bare PR URL in the body keeps the
association visible meanwhile.

## op-9 cancel

`cancel(key, reason)        (comment FIRST, then state)`

Call: op-11 `(key, <reason, verbatim, with its file:line evidence>)`, **then** op-4 `(tracker.scope, cancelled)` → op-5, **then** `mcp__trello__archive_card({ cardId: <key> })` (REST twin `PUT {tracker.rest.baseUrl}/cards/<key>?closed=true&key=…&token=…`)
If unsupported: op-11 with the same text, then op-10; the done-flag still carries `--outcome cancelled`, so the launcher's report shows what needs a human close.

Close a card as not needed — the defect is already fixed on the base branch, or never existed. Three
steps in this order: the comment is the record, the move puts the card in the column a human looks for
cancellations in, and the archive takes it off the board.

⛔ Comment **first**, then state — because the comment is the record of why a filed bug was deleted
and must stand on its own; a cancel whose state lands first leaves an unexplained closure if the
session dies between the two calls.

⛔ Move to the cancelled list **before** archiving, and never archive alone — because an archived card
keeps the list it was archived from, so a human who later sends it back to the board drops it straight
into that column; archived out of the ready list it walks back into the working queue with nothing saying
why it ever left.

⛔ `cancelled` means "already fixed — here is `path:line`" and is **not** the same as `duplicate`
("another session shipped it in a PR that is legitimately in review and must not be closed") —
because an assertion with no line number cannot be acted on and the ticket stays open, while a
duplicate closed as cancelled deletes a live review. A session with live tools performs op-9 itself
and writes `fleet flag done --outcome cancelled --evidence <path:line> --reason …` either way — the
flag is the only thing that survives the session.

⛔ Never cancel by deleting a card — this adapter has no delete path on purpose — because deletion takes
the evidence comment, the attachments and the checklists with it and cannot be undone when the cancel was
wrong, while archiving is reversible and still answers every search.

## op-10 leaveOpen

`leaveOpen(key)             (explicit non-action)`

Call: none — no tracker call is made
If unsupported: always supported.

An explicit decision to leave the card where it is, recorded in the done-flag (`--outcome duplicate`
or `--outcome no-code-change`) so the launcher's report can tell "left open on purpose" from "the
session died". It exists so the flag grammar can distinguish `cancel` from `leaveOpen` — the very
distinction the playbooks insist on. It carries extra weight here: op-24 degrades into op-9's archive, so
`leaveOpen` is the only way a duplicate whose original is still in review keeps its card on the board.

## op-11 comment

`comment(key, verbatimText) (never paraphrased)`

Call: `mcp__trello__add_comment({ cardId: <key>, text: <verbatimText> })` (REST twin `POST {tracker.rest.baseUrl}/cards/<key>/actions/comments?text=<verbatimText>&key=…&token=…`)
If unsupported: `fleet outbox add --op comment --key <KEY> --args '{"text":"…"}' --verbatim` — the launcher posts the text unchanged.

Comments render markdown, so `file:line` evidence, fenced blocks and backticked keys survive as written.

⛔ Post the text exactly as given — never paraphrased, summarised, or "cleaned up" — because a
compressed paraphrase drops the qualifier that made the claim survivable, and the qualifier is
exactly what the next reader attacks. The outbox marks these entries `verbatim: true` for the same
reason.

⛔ Never truncate text containing issue keys at a raw character offset; cut at a word boundary,
strip a trailing partial key, and wrap every surviving key in backticks — because a cut key becomes a
valid *shorter* token that the next reader pastes into a search and lands on an unrelated card, while
the write "succeeds" and looks fine in the echo. Trello does not autolink a bare shortLink, which makes
the damage quieter, not smaller.

## op-12 listQueue

`listQueue(selector) → key[]`

Call: op-19 `(tracker.scope)` → the open list whose `name` equals `<selector.state>` (`ready` → `checker.ready.state`) → its `id` → `mcp__trello__get_cards_by_list_id({ boardId: <tracker.scope>, listId: <that list id> })` (REST twin `GET {tracker.rest.baseUrl}/lists/<that list id>/cards?fields=id,shortLink,name,idLabels,idMembers,pos&key=…&token=…`) → keep cards whose `idLabels` contain every id op-17 maps `selector.labels` to and none it maps `selector.excludeLabels` to, and whose `idMembers` contain op-3 `(selector.assignee)` when one is given → `shortLink[]` sorted by the `priority.map` label (1 first, unlabelled last, then by `pos`)
If unsupported: explicit keys (`fleet up --issues A,B`, `fleet add <k>`) or `fleet.queue.source: findings`.

Keys matching `fleet.queue.selector` (`state`, `labels`, `excludeLabels`, `group`, `assignee`)
inside `tracker.queue` / `tracker.scope`, priority-sorted; the launcher writes them to `queue.txt`
for autowave. The default selector excludes `checker.triage.label`, and the result is only a
**candidate** list: `fleet intake check` still refuses any checker-filed ticket that lacks
`gate:passed|waived` when `fleet.queue.requireGate` is on, and counts the refusals — never silently.
A list read returns every open card in that list in one response, so op-16's completeness rule is
satisfied by construction.

⛔ A selector naming both a `state` and a `group` is contradictory on this tracker — the launcher warns
and uses the `state` — because both are lists and a card is in exactly one of them, so the intersection
of two different lists is always empty and would report an empty queue as if the backlog were clear.

## op-13 createIssue

`createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}`

Transport: rest
Call: `POST {tracker.rest.baseUrl}/cards?idList=<group list id when given, else the op-19 entry whose name equals state? (checker.triage.state), else the op-19 entry named by checker.ready.state>&name=<title>&desc=<body>&idLabels=<comma-joined ids from op-17 for every labels[] name, plus the id of priority.map[priority]>&idMembers=<op-3 "me" or the checker.routing ref>&pos=bottom&key=…&token=…` → `{ key: shortLink, id, url: shortUrl }`; then op-8 once per `links[]` entry (MCP twin `mcp__trello__add_card_to_list({ boardId: <tracker.scope>, listId, name, description })` followed by op-6 and op-14 for members and labels — three calls instead of one)
If unsupported: `fleet outbox add --op createIssue --key <fid> --args <json>` — cloud workers always do this; the launcher creates the card and records the key.

One card per finding. `state?` is `checker.triage.state`; `labels[]` always carry
`checker.triage.label`, `checker.provenanceLabel` and `checker.gate.labels.pending`, and only names
that op-17 returned; `assignee` is `"me"` unless `checker.routing` matches the defect's path.
`parent?` is not a field here (op-23): the worker writes a `**Parent:** \`<umbrella key>\`` body line
instead and the launcher adds the index line and the op-25 link.

With `grouping: list` the sweep's list **is** the triage column — a card filed into it sits there carrying
`gate:pending` until `fleet check promote` moves it (op-5) to the ready list. So leave `checker.triage.state`
unset on this tracker and let the sweep list play that role; setting both asks one card to be in two lists.

⛔ Reconcile against the system of record with op-16 at the **start of every filing batch**; never
track "what have I already filed" in a hand-kept file or a running tally — because both drift, and
the failure mode is duplicate tickets, the opposite of what the dedup gates exist for.

⛔ Join filed issues to findings on the `**PR:**` header line or the opaque `fid`, never on title
similarity — because titles are rewritten when filing, so text similarity mis-scored 28 of 100 in
one sweep, while an opaque key cannot drift. The description comes back byte-for-byte here, so the join
is a plain string match — and the same header line is what op-16 uses to tell a finding card from the
umbrella index card.

⛔ An oversized "error" echo (`result exceeds maximum … saved to <file>`) usually means the write
**applied** — re-fetch with op-2 or op-16 before any retry, never blind-retry — because a blind retry
creates a duplicate.

⛔ Priority is set **twice**: the `priority.map` label and a `**Priority:**` line in the body — because
this tracker has no priority field at all, so the label is the only filterable channel, and for cards
whose label is forced (`checker.a11y.forcedPriority`) the body line is the only channel the assessed
severity can travel on.

⛔ Keep the description under Trello's 16,384-character cap by moving the longest evidence into an op-11
comment, never by cutting at a character offset — because the API rejects an over-long description
outright (the card is created without it, or not at all), and a body cut mid-sentence loses exactly the
qualifier the next reader attacks.

A failed `links[]` entry is cosmetic (op-8's rule); the card is created correctly without it. The a11y
umbrella (`checker.a11y.umbrella`, titled `checker.a11y.umbrellaTitle`) is created with this same op, once
per sweep, in the group list, carrying both `checker.a11y.labels.*` and the `checker.a11y.forcedPriority`
label, with the index of its children in its body — see op-23.

## op-14 updateIssue

`updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})`

Transport: rest
Call: `title?` / `body?` → `PUT {tracker.rest.baseUrl}/cards/<key>?name=<title>&desc=<body>&key=…&token=…` with only the fields given (MCP twin `mcp__trello__update_card_details({ boardId, cardId, name?, description? })`); `labels.add[]` → `POST {tracker.rest.baseUrl}/cards/<key>/idLabels?value=<id from op-17>&key=…&token=…` once per name and `labels.remove[]` → `DELETE {tracker.rest.baseUrl}/cards/<key>/idLabels/<id>?key=…&token=…` once per name; `priority?` → remove the current `priority.map` label, add the new one; `state?` → op-4 → op-5; `assignee?` → op-6; `parent?` → a `**Parent:**` body line through op-15; `links?` → op-8
If unsupported: `fleet outbox add --op updateIssue --key <KEY> --args <json>`.

Partial update. `labels` is a **delta** (`add`, `remove`), never a replacement — because a
replacement erases the labels another pass added (gate labels, a11y labels). Trello's per-label add and
remove endpoints make the delta literal: no read, no rewrite, nothing to clobber. `fleet check gate apply`
uses it to mirror `gate:<status>`; the rediscovery rule uses it to append a new call site to an existing
issue (body and comment only — never title or state, so it reads as new evidence).

⛔ Use op-15, not `body?`, on any card another pass may also be writing — the work-list card, the umbrella
index card, anything the audit patches — because `desc` is replaced whole by this call and the lock op-15
takes is the only thing that stops two whole-body writes dropping one another.

⛔ Editing an issue you did not create is **launcher-only** — because parallel writers to one issue
overwrite each other, while creating *distinct* issues shares no mutable state and parallelises
cleanly. The line is shared state, not the tracker itself.

## op-15 patchBody

`patchBody(key, edits:[{find, replace}]) → {applied}`

Transport: rest
Call: emulated — `fleet pool acquire tracker-worklist:<KEY>` → op-2 `(key)` → apply every edit to `description` locally (each `find` must match exactly once; an edit matching zero or several times is skipped and not counted) → `PUT {tracker.rest.baseUrl}/cards/<key>?desc=<patched body>&key=…&token=…` → re-read with op-2 and confirm every counted edit is present → `fleet pool release tracker-worklist:<KEY> <slot>` (the slot `acquire` returned) → `applied` = the number of edits confirmed
If unsupported: `fleet outbox add --op patchBody --key <KEY> --args '{"edits":[…]}'` — the launcher performs the same locked read-modify-write.

Find/replace edits against the description. `atomicPatch` is `false` here: Trello has no patch operation
and a description write replaces the field whole, so the adapter emulates it by read-modify-write under
the 1-slot `tracker-worklist:<KEY>` pool, because two unlocked read-modify-writes silently drop one
another's edits. Release the lock immediately after the verifying read; nothing else runs under it.

⛔ A refuted prescription is patched into the **description body**, immediately after the bad
prescription, as a `⛔ DO NOT …` block — a comment alone is not enough — because a comment does not
correct a description, and the description is what a fixer (or a work-order generated from it)
actually reads and executes.

⛔ Send N edits in **one** call per wave, never one call per edit — because every call here is a whole
read plus a whole write under a lock, so one call per edit multiplies both the payload and the time the
lock is held, while several edits in one call is still a single serialized write with no clobber risk.

## op-16 findIssues

`findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/boards/<tracker.scope>/cards/all?fields=id,shortLink,shortUrl,name,desc,idList,idLabels,idMembers,closed&key=…&token=…` → filter locally: `group` / `state` → `idList` equals that list id; `labels` → `idLabels` contains every id op-17 maps them to; `priority` → the id of `priority.map[priority]` is in `idLabels`; `parentIsNull: true` → on this tracker it means "not the umbrella index card", detected by the `**PR:**` header line: the umbrella is the card that carries no such line and is the only card this filter drops, while a card's real `parentId` is `null` always (op-2, `subIssues: false`); `createdAfter` → the card's creation time, which is the first 8 hex characters of its `id` read as a unix timestamp; `limit` → applied locally after filtering, and reported → `issues[]` as `{key: shortLink, id, title: name, priority, status: <list name via op-19>, parentId: null}`, `complete = true` **only** when the local `limit` dropped no rows; a result cut by `limit` reports `complete = false` with the dropped count. `text?` → `GET {tracker.rest.baseUrl}/search?query=<text>&idBoards=<tracker.scope>&modelTypes=cards&card_fields=id,shortLink,name,desc,idList,idLabels&cards_limit=1000&partial=true&key=…&token=…`, intersected with the same filters, `complete = cards.length < 1000`
If unsupported: reads are never queued; without op-16 the checker cannot reconcile and must file tracker-less (`localId` rows) — say so in your PR.

Filtered query. `complete` is derived per `capabilities.findComplete: all-at-once` — the board-cards read
returns the whole board in one response with no cursor and no page flag, so completeness is by
construction, and `reconcile.assertComplete()` in the CLI trusts nothing else. The two exceptions are a
`limit` that actually dropped rows, and `text?`, which goes through the search endpoint and is capped —
each computes `complete` from what it actually returned rather than inheriting it. The read includes
**archived** cards (`/cards/all`, `closed: true`): cancelled and duplicate cards are archived here, so
keep them in the frame the way a cancelled state would be kept, and drop them by `closed` when the caller
wants live cards only.

⛔ A page returning **exactly `limit`** with no explicit completeness signal is truncated by
definition — because `limit` is a page size, not a total; a full page comes back with no error, and a
truncated *filed* set makes real work look undone and manufactures phantom Urgent backlog that then
gets re-filed as duplicates. On search that number is `cards_limit`.

⛔ Always pass `cards_limit` explicitly on a search — because its default is **10** and its maximum is
1,000, so a search without it answers with ten cards, no error and no flag, and a reconcile built on that
re-files nearly everything already filed.

⛔ Band the query by `priority` (1, 2, 3, 4 — one pass each over the same response), assert `complete` on
every band before combining, and print the per-band counts — because a band silently at its cap is the
failure you are looking for, and on this tracker an empty band means the priority label was never created
or never applied, not that nothing exists at that severity.

⛔ Exclude the umbrella **structurally** — by the absence of the `**PR:**` header line, never by a list of
card ids — because an index card filed later carries the same labels and the same priority label as its
own children and walks straight into any frame keyed on those; an id list is a snapshot of the parents you
knew about when you wrote it.

⛔ Watch the board's own ceiling: a board caps its **open** cards (documented `disableAt` 5,000, with a
warn threshold below it) and reports both in the `limits` object — say so in the plan output when a sweep
would approach it, because past that cap creates start failing while every read still looks complete.

`text?` is for the distinctive-phrase search a worker runs before re-filing a ledger row that says
`filed` but has no key — cross-PR attribution is a correct outcome, not lost work, and re-filing it
produces a duplicate. Search here is word-based: search a distinctive **phrase**, never a whole sentence.

## op-17 listLabels

`listLabels(scope) → [{id,name}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/boards/<scope>/labels?fields=id,name,color&limit=1000&key=…&token=…` → `[{id, name}]`, complete per op-16's rule
If unsupported: label-driven markers move to body lines — `**Filed by:** fleet-check`, `**Gate:** pending`, `**A11y:** keyboard`, `**Priority:** High` — written at op-13 and mirrored by op-15; `fleet.queue.selector.excludeLabels` is ignored with a warning and the queue is gated by the ready list alone.

Board labels: a board owns its own set, so the scope of this op is the board and a label id is meaningless
on another one. Several labels may share a name with different colours; match by exact `name` and, when
two share it, use the id op-18 recorded in `manifest.json` — never pick by colour.

⛔ Pass `limit=1000` on every call — because the default is **50**, a board that has more labels returns
the first 50 with no error and no flag, and a marker label that exists but fell outside that page is a
label op-18 then creates a second time.

⛔ Sessions and workers pick labels from this list **only**; nobody invents one — because label
creation is shared state, and a label that exists only in one worker's output fragments the queue
filter (`fleet.queue.selector.excludeLabels`) and the gate mirror everyone else keys on.

## op-18 ensureLabel

`ensureLabel(scope, name) → {id}      (launcher-only)`

Transport: rest
Call: op-17, return the match by exact `name`; else `POST {tracker.rest.baseUrl}/labels?idBoard=<scope>&name=<name>&color=<colour>&key=…&token=…` → `{id}`, with `colour` fixed per marker: `red`, `orange`, `yellow`, `green` for `priority.map` 1 to 4 and `null` (no colour) for every other fleet label
If unsupported: the launcher's plan step reports the missing label and applies the `labels` degradation for that marker.

Find-or-create, called once at `fleet check plan` for `checker.provenanceLabel`, `checker.triage.label`,
every `checker.gate.labels.*`, both `checker.a11y.labels.*`, and the four `priority.map` names
(`priority.scale` is `labels` here). Trello wants a colour at creation; the fixed mapping above keeps the
four priority labels visually ordered on every board the fleet touches without asking the operator, and
`/fleet-check` never asks.

⛔ Launcher-only, never a session or worker — because create-if-missing from N parallel workers
races into N near-duplicate labels, and shared-state writes are orchestrator-only in every mode. Here the
race is worse than near-duplicate: a board accepts several labels with the identical name, and only the
recorded id tells them apart afterwards.

## op-19 listStates

`listStates(scope) → [{id,name,type}]`

Call: `mcp__trello__get_lists({ boardId: <scope> })` (REST twin `GET {tracker.rest.baseUrl}/boards/<scope>/lists?filter=open&fields=id,name,pos&key=…&token=…`) → one entry per **open** list as `{id, name, type}`, in board order, typed by name: `tracker.states.in-progress` → `started`, `tracker.states.in-review` → `review`, `tracker.states.cancelled` → `cancelled`, a list whose name is `Done`, `Completed` or `Closed` (case-insensitive) → `done`, every other open list → `unstarted`
If unsupported: there are no other states to fall back to — the launcher reports the tracker as unreachable and every transition waits in the outbox.

Every list on the board with its canonical type. op-4 picks from it; `checker.ready.state` defaults to the
adapter's `unstarted` state, which here is the **leftmost** one, because a board reads left to right and
the backlog column is first. Archived lists are omitted: they are not states, and a card cannot be moved
into one.

⛔ Return **all** lists of a type, not the first — because op-4 must be able to choose the configured one,
and a real board has several `unstarted` columns at once (a backlog, a to-do, one list per sweep).

There is no `triage` type on this tracker: the sweep's list plays that role (op-13, op-20), and
`fleet check promote` moves cards out of it into the ready list.

## op-20 resolveProject

`resolveProject(ref) → {id,name,url}`

Call: op-19 `(tracker.scope)` → the one open list whose `id` or exact `name` equals `<ref>` → `{id, name, url: <the board's shortUrl>}`, the board's `shortUrl` coming from `mcp__trello__list_boards({})` (REST twin `GET {tracker.rest.baseUrl}/boards/<tracker.scope>?fields=shortUrl&key=…&token=…`) because a list has no URL of its own; zero or several matches is a plan-time failure, reported with the candidate ids
If unsupported: `grouping: none` — there is no group; `checker.provenanceLabel` alone marks the sweep.

Resolves `checker.project` (a list id or name) once at plan time. The group is a **list**, and a list is
also what a state is: a card filed into the sweep's list has that list as its state by that very fact
(op-13), and leaves the group the moment op-5 moves it. That is deliberate — after `fleet check promote`
the sweep is identified by `checker.provenanceLabel` plus the `sweepId`, exactly as
`grouping: none` would identify it, and op-16 reconciles on those once the cards have moved on.

⛔ From then on reference the group by **id** everywhere — in `manifest.json`, in every worker brief,
in every op-13 call — never by name — because names carry apostrophes and change, two lists may share
one, and a pointer kept in prose or memory drifted a whole sweep behind more than once.

## op-21 createProject

`createProject(name) → {id,url}`

Call: op-19 first — reuse the open list of that exact name when one exists; else `mcp__trello__add_list_to_board({ boardId: <tracker.scope>, name: <name> })` (REST twin `POST {tracker.rest.baseUrl}/lists?idBoard=<tracker.scope>&name=<name>&pos=bottom&key=…&token=…`) → `{id, url: <the board's shortUrl>}`
If unsupported: provenance-label-only; the sweep's pointer is the label plus the `sweepId`.

Launcher-only. Used when `checker.projectPerSweep` is on (`checker.projectNameTemplate`, with
`{date}` rendered like `2026-03-14`) or when `checker.project` is unset and the tracker groups —
the decision is made, not asked, because `/fleet-check` never asks the operator a question. The new list
lands at the right-hand end of the board; leave it there, because reordering a human's columns is not the
fleet's call.

⛔ Check op-19 for an open list of the same name **before** creating one, and reuse it — because
`--resume` re-runs the same command and must land in the same list, and two same-name lists make every
later op-4 and op-20 lookup ambiguous for good.

## op-22 attachImage

`attachImage(key, filePath, {alt, caption}) → {url, embed}`

Strategy: attachment-only
Transport: rest
Call: `POST {tracker.rest.baseUrl}/cards/<key>/attachments?setCover=true&name=<alt>&mimeType=image/png&key=…&token=…` as `multipart/form-data` with `file=@<filePath>` → `{id, url, name}`; `url` = the attachment's `url` field (bare, never a `previews[]` entry); `embed = "_Screenshot: <alt> — attached to this card and shown as its cover. <caption>_"`; a sibling finding that shares the shot gets `POST {tracker.rest.baseUrl}/cards/<sibling>/attachments?url=<that url>&name=<alt>&key=…&token=…` (a link attachment to the same asset, no second upload) and `embed = "_Screenshot: <alt> — see the attachment on card \`<first key>\`. <caption>_"`; then op-14 `body` (or op-15) puts `embed` where the `![screenshot]` line would go; an upload whose response was lost is re-read with `GET {tracker.rest.baseUrl}/cards/<key>/attachments?fields=id,name,url&key=…&token=…` before any retry
If unsupported: strategy `none` — the body carries `_No screenshot attached: <reason>_`; cloud workers ship their PNGs on the results branch and the launcher attaches them.

The strategy is chosen by the CLI's `attach.chooseStrategy(caps, config)` from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy`, never improvised at filing time. Here it is
`attachment-only`: the file goes on the card, Trello promotes the first image attachment to the card
**cover** (`setCover=true` says so explicitly), and the body carries the caption sentence — no inline
image, because an attachment URL is served only to a viewer with access to the board, so an `![…](…)` in
a description renders as a broken image in an export, a share link, or anywhere the reader is not signed
in. `assets-branch` is no better on a private repository, where a raw URL renders broken for anyone not
signed in to the code host — say so in the overlay if a project switches to it.

⛔ Store the **bare** URL — never a `previews[]` URL — because the tracker re-generates and re-signs
previews on read, so a preview URL copied forward expires and the image dies in every sibling card that
linked it.

⛔ **One upload per screenshot.** Create the first card, upload its shot once, then give the sibling
findings a link attachment to that same `url` — because several findings from one PR share one screen,
per-card uploads turn a 300-finding sweep into ~900 round-trips, and the per-token request budget is
shared by the whole fleet.

⛔ One file must finish before the next is started, and an upload whose response was lost is checked by
re-reading the card's attachments (the read on this op's `Call:` line) before any retry — because a
multipart upload that timed out has frequently **applied**, a blind retry attaches the same PNG twice, and a
half-uploaded attachment is a cover that never renders and nobody re-checks.

⛔ The file is a **real capture** of the live app or nothing — never a mock, placeholder, or
reconstruction — because a fabricated screenshot is evidence for a claim nobody verified, and that is
worse than having none.

`_No screenshot attached: <reason>_` is counted **separately** from `_No UI surface — <reason>_` in the
report, because "the app was down" and "there is no screen" are different outcomes and lumping them
overstates coverage. The per-attachment size cap (10 MB on a free workspace, 250 MB on a paid one) is far
above a full-page PNG, so a size rejection means the wrong file was named, not that the cap needs raising.

## op-23 setParent

`setParent(key, parentKey)`

Call: none — `subIssues: false`; a card has no parent field, so there is nothing to call
If unsupported: the umbrella becomes an **index card** — its body is a checklist of its children, one `- [ ] \`<key>\` — <title>` line each, maintained by op-15 (launcher-only, under the `tracker-worklist:<KEY>` lock) — and every child carries a `**Parent:** \`<umbrella key>\`` body line written at op-13, plus an op-25 link to the umbrella.

Degradation, in full. The umbrella's purpose is unchanged (`checker.a11y.umbrella`, titled
`checker.a11y.umbrellaTitle`): one collapsed parent removes a whole class of tickets from the working
queue while keeping **one issue per gap** — a pattern ticket would lose the per-site file/line/PR that
makes each one actionable. What changes here is only *how* the collapse is achieved: the index card sits
in the sweep's list and its children stay on the board, kept out of the working queue by the
`checker.a11y.labels.*` markers and the forced `priority.map[checker.a11y.forcedPriority]` label, which is
what `fleet.queue.selector.excludeLabels` keys on. When `checker.a11y.forcedPriority` is `null` no priority
label is forced and those markers alone hold the children out of the queue. Priority forcing and labels on
the children are unchanged.

⛔ Writing the umbrella's index body is **launcher-only**; a worker writes the `**Parent:**` line only into
cards it creates itself — because the umbrella is shared state, and op-15 here is a locked
read-modify-write that N workers would either serialise into a queue or, unlocked, clobber.

⛔ When re-parenting retroactively, query each a11y label with op-16 and **union the two result sets
by id** before iterating — because the two label queries overlap heavily, and iterating both issues
duplicate updates and mis-counts the total.

Prefer op-25 with an explicit "one root fix closes both" note over the index when two findings carry
different severities — because listing an Urgent under a Low umbrella buries it.

## op-24 markDuplicate

`markDuplicate(key, ofKey, evidence)   (comment FIRST, then relation)`

Call: none — `duplicateRelation: false`; there is no duplicate relation to set
If unsupported: op-11 `(key, <evidence, verbatim>)` with ``Duplicate of `<ofKey>` `` as the comment's **first line**, then op-25 `(key, ofKey, "duplicate", <that same first line>)` so a reader of either card sees the other, then op-4 `(tracker.scope, cancelled)` → op-5 and the archive step of op-9; the done-flag records `--outcome duplicate`. If `cancel` were also false: op-11 then op-10.

Degradation, in full: the evidence comment is mandatory and the relation is the bonus — here the
"relation" is the card-URL attachment op-25 makes, which renders as a live card tile on both sides. The
close then follows op-9's own ordering: cancelled list first, archive second.

⛔ Comment **first**, then the link, then the state — because the comment is the record of why a filed bug
was folded into another and must stand on its own; a duplicate whose archive lands first leaves an
unexplained closure if the session dies between the calls, and archiving also takes the card off the board
where nobody will look for it.

⛔ Never decide a duplicate by title similarity; compare the **mechanism** — same function, same
missing guard, same line — because true pairs routinely have completely different titles, unrelated
findings on one large file often have similar ones, and a wrong merge silently deletes a tracked bug,
which is worse than a duplicate sitting in the backlog.

⛔ "Shares the fix" is a hypothesis, not a verdict — check that both fixes touch the same file before
accepting it — because cross-app pairs almost never merge; one composite folded in three siblings whose
fixes landed in three different apps.

⛔ A working session whose own card duplicates a PR **legitimately in review** uses op-10, not this op —
because the original's review is live and must not be archived; the done-flag's `--outcome duplicate`
with the PR URL in `--reason` is the whole report.

## op-25 relate

`relate(key, otherKey, kind, note)`

Call: `mcp__trello__attach_file_to_card({ cardId: <key>, fileUrl: <shortUrl of otherKey>, name: "<kind>: <otherKey>" })` **and** the mirror call on `<otherKey>` pointing back at `<key>` (REST twin `POST {tracker.rest.baseUrl}/cards/<key>/attachments?url=<shortUrl of otherKey>&name=<kind>: <otherKey>&key=…&token=…`, twice) — a card URL attached to a card renders as a live card tile — then op-11 `(key, note)` and op-11 `(otherKey, note)`
If unsupported: op-11 on **both** issues, each naming the other key in backticks and the `kind`.

A non-hierarchical link plus a note on both sides. `kind` is whatever the playbook passes
(`related`, `blocks`, `duplicate`, and the partial-overlap shapes); Trello has exactly one relation
vocabulary — "this card links to that card" — so the `kind` travels in the attachment's name and in the
note, which is where a reader finds it. When a pair is judged *distinct* but the two name a shared line or
a causal link, relate them and put the "who owns which sites" note on **both** — because a distinct
verdict that still needs an action is silently lost otherwise, and closing one ticket half-closes the
other's sites.

## op-26 readWorkItems

`readWorkItems(key) → [{pr, done, keys[], raw}]`

Transport: rest
Call: `GET {tracker.rest.baseUrl}/cards/<key>/checklists?checkItems=all&checkItem_fields=name,state,pos&fields=name,pos&key=…&token=…` → every check item of **every** checklist on the card, checklists in `pos` order and items in `pos` order; for each item whose `name` starts `#<digits>` or holds a PR URL → `{pr, done: state === "complete", keys: <the backticked keys on the item name>, raw: <the untouched name>, id: <the check-item id — adapter-internal, not part of the contract's op-26 shape>}` (MCP twin: `mcp__trello__get_checklist_items({ boardId: <tracker.scope>, name: <each checklist's name> })`, which addresses a checklist by name and so needs the card's checklist names first)
If unsupported: `workItems: none` — return `[]`; `fleet check status` is the only progress view.

Reads the human-visible **mirror** of a sweep's worklist held on the work-list card, in the shape
`capabilities.workItems: checklist` declares: native check items, one per PR, named `#<n> <title>`.
`raw` is the exact name op-27 anchors on and `id` is what it ticks — `id` is adapter-internal, since the
contract's op-26 returns `{pr, done, keys[], raw}` and nothing else: op-27 re-derives it from its own op-26
call here, and no playbook may assume a field the contract does not define.

⛔ Read **all** the checklists on the card, never only the first — because the per-checklist item cap
varies by board and account (the board's `limits` object states the current one), so a long worklist is
split across several checklists on the same card, and a reader that stops at the first reports a sweep one
checklist wide and calls the rest missing.

⛔ `worklist.tsv` on disk is the truth and the tracker holds a mirror; if they disagree the ledger is
right — but a stale mirror is a **real defect, not cosmetic** — because from outside the session a
stalled mirror is indistinguishable from a dead run.

## op-27 tickWorkItem

`tickWorkItem(key, pr, keys[])   (launcher-only, ALWAYS)`

Transport: rest
Call: op-26 → the item whose `raw` begins `#<pr> ` (or whose URL ends `/<pr>`) → `PUT {tracker.rest.baseUrl}/cards/<key>/checkItem/<that item's id>?state=complete&name=<raw + " (\`<key1>\`, \`<key2>\`)">&key=…&token=…` — one call per PR, each atomic, no lock (MCP twin `mcp__trello__update_checklist_item({ cardId: <key>, checkItemId: <that item's id>, state: "complete", name: <the same> })`)
If unsupported: `workItems: none` — no-op; `fleet check status` is the only progress view.

The `checklist` shape: the tracker's own atomic set-complete call, one per item. A check item is its own
record, so ticking one cannot clobber another and this is the one place this tracker is *easier* than a
body checklist — `fleet check tick --lock` is harmless here and is still the command to use.

⛔ Tick the moment the PR's ledger line lands — `fleet check ledger append` enqueues the mirror op the
instant it writes — never batched to wrap-up, never deferred — because the operator watches this
checklist to see the sweep moving, and a mirror showing 3 of 322 while the ledger says 322 tells them
the run is dead.

⛔ Launcher-only, **always** — checker sessions and workers never tick; the orchestrator ticks from the
shared ledger — because a bookkeeping step attached to one execution path dies when the path changes (the
tick once vanished the day filing moved to subagents while the ledger append survived), and "atomic per
item" does not make N independent writers observable or resumable.

⛔ Anchor on the **leading** `#<n>` of the item name and backtick-wrap every key you append — because a
bare `#<n>` also appears inside other PR titles on the same list, and a key that is not visibly a key gets
read as an ordinary word by the next person who searches for it.

⛔ Tick by check-item **id**; never delete and re-add the item, and never rewrite a whole checklist —
because a delete-and-add loses the item's position and its history, and a whole-checklist rewrite is
exactly the clobbering write this shape exists to avoid.

⛔ Verify a backfill by re-fetching (op-26) and counting `complete` items, never by retrying — because a
write that timed out applied anyway, and a blind retry against a renamed item finds no anchor and reports
a PR as missing. At any point the ticked-item count must equal the ledger's line count — `fleet check
tick plan` prints the difference.

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
      `Call:` line and an `If unsupported:` line; every `false`/`none` capability either has **no**
      section or — as with op-1, op-23 and op-24 here — keeps one whose `Call:` says there is
      nothing to call and whose `If unsupported:` line **is** the degradation the template's *Degradation
      rules* prescribe; `atomicPatch: false` is the other shape those rules prescribe, and keeps op-15
      with a real, emulated `Call:`. Parity is asserted in both directions.
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
