# Adding a tracker

A tracker is **one markdown file and one pull request**. This walks the whole path: from copying
`trackers/_template.md` to a passing test run, with the three operations where trackers genuinely
diverge spelled out and the finished adapters cited as worked examples.

You do not need to touch any module. You do not need to understand the supervisor, the worktree layer
or the capture pipeline. You need to answer, for one tracker, 27 questions of the form *"what call does
this operation become here, and what happens when it cannot be made?"*

## The model

Everything in this plugin except an adapter speaks in **27 canonical operation names** — `op-1` …
`op-27` — and nothing else. Playbooks say "run op-7, then op-8". The CLI names ops in its outbox
entries. The docs name ops. A test fails the build if a playbook so much as mentions a tracker vendor.

An adapter is the one file that knows what a tracker's tools are called. It maps each operation onto
one call, declares in its front matter which operations this tracker can support at all, and states for
each one what the caller does when the call cannot be made right now. That split is what keeps
"tracker-agnostic" true over time: adding a tracker is one file, and a malformed one fails CI rather
than someone's fleet.

Two mechanisms exist so that a tracker outage, a dropped connector or a sandbox with no tools never
costs a transition, and **an adapter names them in `If unsupported:` lines and documents them nowhere
else**: the **offline ticket cache** (reads fall back to it) and the **tracker outbox** (writes queue to
it, and the launcher drains, applies and verifies them later). Both are described in
`trackers/_template.md` under *Fallbacks every adapter gets for free*. Do not re-explain them in your
adapter.

### The 27 operations

```
op-1  resolveChildren(parentKey) → key[]
op-2  getIssue(key) → {key,id,title,description,url,status,priority,parentId,suggestedBranch?}
op-3  resolveUser(nameOrEmail|"me") → userRef
op-4  resolveState(scope, in-progress|in-review|cancelled) → stateRef
op-5  setState(key, stateRef)
op-6  assign(key, userRef)
op-7  setState(key, in-review)                     (= op-5 with resolveState)
op-8  attachLink(key, url, title)
op-9  cancel(key, reason)                          (comment FIRST, then state)
op-10 leaveOpen(key)                               (explicit non-action)
op-11 comment(key, verbatimText)                   (never paraphrased)
op-12 listQueue(selector) → key[]
op-13 createIssue({title, body, labels[], priority 1..4, assignee, group?, parent?, state?, links[]}) → {key,id,url}
op-14 updateIssue(key, {title?, body?, labels?:{add[],remove[]}, priority?, state?, assignee?, parent?, links?})
op-15 patchBody(key, edits:[{find, replace}]) → {applied}
op-16 findIssues({group?,labels?,priority?,state?,parentIsNull?,text?,createdAfter?,limit}) → {issues[], complete}
op-17 listLabels(scope) → [{id,name}]
op-18 ensureLabel(scope, name) → {id}              (launcher-only)
op-19 listStates(scope) → [{id,name,type}]
op-20 resolveProject(ref) → {id,name,url}
op-21 createProject(name) → {id,url}
op-22 attachImage(key, filePath, {alt, caption}) → {url, embed}
op-23 setParent(key, parentKey)
op-24 markDuplicate(key, ofKey, evidence)          (comment FIRST, then relation)
op-25 relate(key, otherKey, kind, note)
op-26 readWorkItems(key) → [{pr, done, keys[], raw}]
op-27 tickWorkItem(key, pr, keys[])                (launcher-only, ALWAYS)
```

Canonical priority is `1 Urgent · 2 High · 3 Medium · 4 Low`. Canonical state types are
`triage | unstarted | started | review | done | cancelled`. Both are normalised by the adapter, in the
adapter — the rest of the plugin only ever sees the canonical form.

## Step 1 — copy the template and fill in the front matter

```
cp trackers/_template.md trackers/<id>.md
```

`<id>` is a short lower-case identifier and it **must equal the filename** without `.md`. It is also
the value of `tracker.id` in a project's `.fleet/config.json`.

You can develop without a pull request: a project overlay at `<repo>/.fleet/trackers/<id>.md` replaces
a bundled adapter of the same id wholesale (no merging), so you can iterate against a real workspace
first and upstream the finished file afterwards.

Read `trackers/_template.md` top to bottom once before you start editing it. The invariants written
under each op are what the playbooks assume of **every** adapter. Your adapter may restate the ones
your tracker makes easy to violate, one line each, and may never weaken one.

The front matter is machine-read; the body is model-read. Field by field, what each one decides:

| field | what it decides |
| --- | --- |
| `id` | the filename, `tracker.id`, and the overlay name. Must match the filename. |
| `name` | the human name the wizard and `fleet trackers list` show. |
| `mcp.toolPrefixes` | **connection detection** — see Step 2. |
| `mcp.install[]` | what the wizard prints, **verbatim**, when the tracker is not connected. `{label, command?, instructions?}`. This is why adding a tracker adds its own onboarding. |
| `mcp.docs` | the docs link shown beside those steps. |
| `issueKey.pattern` | the regex for one key. Also what the launcher's reclaim watcher reads keys with — so a pattern that matches a branch name costs a real session. |
| `issueKey.caseInsensitive` | whether an operator's lower-case typing resolves. Choose `false` when case-insensitivity would make the pattern match ordinary branch names. |
| `issueKey.example` | used in prompts, tests and docs. Never a real key. |
| `issueKey.derive` | for trackers whose items carry no human key: the op-2 result field to use as `<KEY>`, so branch, assets and capture templates keep working. |
| `scope.label` | what a scope is called here: `team`, `project`, `repo`, `workspace` or `board`. |
| `scope.required` | whether the wizard must obtain `tracker.scope` before a fleet can start. |
| `scope.listOp` | the tool that lists scope candidates. The only place besides a `Call:` line where a tool may be named. |
| `capabilities.*` | **the most important block in the file** — see below. |
| `priority.scale` / `.map` | how canonical 1..4 becomes this tracker's priority — see Step 6. |
| `states.*.promptDefault` | the state **names** (never ids) the wizard proposes for `tracker.states`. op-4 resolves them per scope at run time through op-19, because ids differ per scope and names are what op-19 returns. |
| `config[]` | extra keys the wizard must ask for. `key` is either a contract `tracker.*` key or an adapter-declared `tracker.settings.*` key — nothing else. |
| `rest` | present **if and only if** some op declares `Transport: rest`. Both values are config *keys to read*, never literals: `baseUrlKey: tracker.rest.baseUrl`, `tokenEnv: tracker.rest.tokenEnv`. The token key is user-scope and `secret`; it holds the **name** of an environment variable, and writing it into a committed project file is a validation error. |

### `capabilities.*` — why this block matters most

The capability block is what makes the playbooks **degrade correctly instead of failing**. Every
capability you set to `false` (or `none`) has a documented degradation in the template's *Degradation
rules* table — the playbooks already know what to do without that operation, and they will do it
silently and correctly. What they cannot survive is a capability declared `true` whose call does not
work, because then a session hits an error in the middle of a transition it has already half made.

So: **declare what your tracker really has, not what you wish it had.** `false` is a supported answer
everywhere. The whole point of the block is that `/fleet-check` runs against a board of index cards
with no keys, no statuses and no children, because Trello declared exactly that and the playbooks took
the documented path.

```
resolveChildren  cancel  attachLink  listQueue  comment  createIssue  labels
atomicPatch  subIssues  duplicateRelation  relations
grouping:     project | epic | milestone | label | list | none
imageEmbed:   inline | attachment | none          imageUpload: mcp | rest | none
workItems:    body | comment | children | checklist | none
findComplete: page-flag | total | link-header | all-at-once
```

The gating rule, which the tests enforce in one direction today and a reviewer checks in the other: a
capability that is `true` (or not `none`) **must** have its `## op-<n>` section; one that is `false`
**must not** have it, and is covered by the degradation table instead. `atomicPatch: false` is the
single exception — op-15 keeps its section and is emulated (read-modify-write under a lock).

Two capabilities deserve a warning:

- **`comment: false` is severe.** op-9 `cancel` and op-24 `markDuplicate` are then *refused*, not
  degraded, because a closure with no evidence record is unaccountable — and the comment *is* the
  record.
- **`createIssue: false`** puts `/fleet-check` in tracker-less mode: findings get local ids, promotion
  flips them, and sessions take the finding body as their task text. That is a real supported mode, but
  say so in your pull request so nobody expects filed tickets.

## Step 2 — detection

`mcp.toolPrefixes` is a list of tool-name prefixes. **If any tool visible in the session starts with
one of them, the tracker is connected.** That is the whole check, and it is the only reliable one.

Why it is the only reliable one: a connector can be live in a session while leaving **no trace in any
configuration file a CLI can read**. A machine can list zero configured servers and still have the
tools present, because the connection was made in the application rather than on disk. So file-based
detection is a **hint** for pre-filling a wizard answer at best, and never a verdict. `fleet config
detect` proposes `tracker.id` from whichever adapter's prefixes are visible *in the session*, and the
wizard renders `mcp.install[]` verbatim when none are.

Declare **several** prefixes when your tracker can reach a session by more than one route — a
CLI-added server and a first-party connector commonly prefix the same tools differently, and hard-coding
either one makes the adapter wrong for half its users. `linear.md` is the worked example: it lists two
prefixes and, because of that, writes every `Call:` line and its `scope.listOp` with the tool name
**stripped of any prefix**, leaving the caller to prepend whichever prefix its own visible tool list
carries. If your tracker has exactly one route, name the full prefixed tool.

Write `mcp.install[]` for a stranger on a clean machine: a `command` that is copy-pasteable on every
platform (or no `command` at all, just `instructions`), and instructions that mention the part everyone
forgets — that a **new session** is usually needed before the tools appear. Run every entry once, on a
clean machine, before you open the pull request.

## Step 3 — the per-op contract

Every supported op gets exactly one section, in numeric order:

````
```example
## op-<n> <name>

`<signature copied from the operation list above>`

Call: `<the exact tool, endpoint or command, with its argument shape and how the result maps onto the return shape>`
If unsupported: <what the caller does when this Call cannot be made in THIS session right now>

<One or two sentences: what the op means here, and the invariants the Call must honour.>
```
````

- **`Call:`** is the only line in the whole plugin that may name a tracker tool. Write it so a model can
  execute it without guessing: the tool or endpoint, the argument names, and the mapping from the
  response onto the signature's return shape. For a REST transport, write the method and path with the
  **config key** that supplies the base URL — `{tracker.rest.baseUrl}` — never a literal host.
- **`If unsupported:`** answers "the tool is not visible, `tracker.mode` is `manual`, the transport is
  not configured, or the tracker rejected the call as unavailable — now what?". Reads fall back to the
  offline ticket cache or the CLI; writes go to the tracker outbox. **Name** those two, do not
  re-document them. It is *not* the place to describe a feature your tracker lacks — for that, set the
  capability to `false` and delete the section.
- **`## op-22` also carries a `Strategy:` line**, always. A test asserts it.
- **`Transport:`** appears wherever a non-tool transport is involved: `mcp | rest | cli`. Required
  whenever op-22's strategy is not `none`, and used on any other op whose call is a REST endpoint or a
  CLI invocation rather than a tool.

Some operations compose others, and it is normal for a `Call:` line to name an op instead of a tool —
op-24's call is "op-11, **then** the relation"; op-27's call is "op-15 with these edits". Compose
rather than duplicating a tool name in two places.

Restate an invariant from the template when your tracker makes it easy to violate, and keep its `⛔`
and its one-sentence *why*. The why is the value; drop it and the next contributor deletes the rule.

## Step 4 — the three hard ops

Twenty-four of the operations are a straightforward mapping. Three are where trackers actually diverge,
and where a wrong answer is expensive rather than annoying. Read the finished adapters for these; each
one is cited below.

### op-22 `attachImage` — four strategies

Declare exactly one `Strategy:`. The CLI chooses it from `capabilities.imageEmbed`,
`capabilities.imageUpload` and `checker.attachStrategy` — it is never improvised at filing time.

- **`native-upload`** — the tracker hosts the image and it renders inline. Two shapes exist. Through a
  connector (`Transport: mcp`): *prepare* an upload against an existing issue → **signed PUT** of the
  raw bytes with **every** returned header verbatim, name, value and casing → *finalize*. Through REST
  (`Transport: rest`): a multipart POST to the attachments endpoint. `linear.md` is the connector
  example, `jira.md` the REST one — and Jira's shows why the details matter: the upload endpoint
  refuses any request without a specific anti-forgery header, and the error reads like an
  authentication failure.
- **`attachment-only`** — the tracker takes the file but will not inline it. The file goes on the item,
  and **the embed is a caption sentence** rather than an image: `_Screenshot: <alt> — attached to this
  task as <name>. <caption>_`. Choose this when the tracker's asset URLs are only served to a
  signed-in viewer with access, so an inline image would render broken in an export, a share link, or
  anywhere the reader is not signed in. `asana.md` and `trello.md` are the worked examples; Trello's
  also promotes the image to the card cover.
- **`assets-branch`** — for a forge with **no issue-upload API at all**. Commit the PNG to a branch of
  the code repository with `fleet assets add <file…> --branch <name>` (the branch renders from
  `vcs.assetsBranchTemplate`) and hot-link the raw URL it prints. `github.md` is the worked example.
  Three rules travel with it: the PNGs go on the assets branch and **never** into the pull request's
  diff; **never check that branch out** into a worktree — read a file from it with `git show
  <remote>/<branch>:<path>`, because it is an orphan branch and checking it out untracks your working
  tree; and **pin the embed to the commit sha the CLI printed** whenever anything can still push to that
  branch, because a branch-named URL resolves to whatever lands last and a capture worker finishing
  seconds after you collected turns your before/after into two afters. On a private repository these
  URLs render as broken images for anyone not signed in to the code host — say so in your adapter.
- **`none`** — the body carries `_No screenshot attached: <reason>_`, counted **separately** from
  `_No UI surface — <reason>_` in the report, because "the app was down" and "there is no screen" are
  different outcomes and lumping them overstates coverage.

Two rules apply to every strategy:

- ⛔ **Store the bare URL.** Many trackers re-sign asset URLs on read, and some return a preview or
  download variant beside the permanent one. A signed URL copied forward expires and the image dies in
  every sibling issue that inlined it. Say in your `Call:` line exactly which response field is the bare
  one — Trello's attachment `url` and never a `previews[]` entry; Asana's `permanent_url` and never
  `download_url`, which can be valid for as little as two minutes; Jira's `content` and never the
  thumbnail.
- ⛔ **One upload per screenshot; siblings share it.** Create the first issue, upload its shot once,
  then create the sibling findings with the same `embed` already inlined (or, where the tracker supports
  it, a link attachment pointing at the same asset). Several findings from one pull request share one
  screen, and per-issue uploads turn a 300-finding sweep into roughly 900 round-trips.

Note the ordering constraint most trackers impose: an upload is prepared *against an existing item*, so
the sequence is create (op-13, without the image line) → upload (op-22) → patch the image line in
(op-15), never upload-at-create.

### op-26 / op-27 — the work-list

A sweep's worklist is a list of pull requests to review. **The on-disk `worklist.tsv` is the truth**;
the tracker holds a **human-visible mirror** on the to-do issue so the operator can watch the sweep
move. `capabilities.workItems` declares the mirror's shape, and there are four:

| shape | what the mirror is | worked example |
| --- | --- | --- |
| `body` | a markdown checklist in the description | `linear.md` (native patch), `github.md` (emulated) |
| `children` | one sub-item per pull request | `jira.md`, `asana.md` |
| `checklist` | native check items with atomic per-item completion | `trello.md` |
| `comment` | one comment per pull request | fallback shape; Jira uses it when the to-do issue cannot hold sub-items |
| `none` | no mirror at all; `fleet check status` is the only progress view | — |

op-26 reads the mirror and returns `{pr, done, keys[], raw}` per row, where **`raw` is the exact line
op-27 will anchor its edit on**. op-27 ticks one row.

The rules, and why each exists:

- ⛔ **Tick the moment the pull request's ledger line lands** — never batched to wrap-up, never
  deferred. The operator watches this checklist to see the sweep moving, and a mirror showing 3 of 322
  while the ledger says 322 tells them the run is dead.
- ⛔ **A stale mirror is a real defect, not cosmetic.** If the mirror and the ledger disagree the ledger
  is right — but from outside the session, a stalled mirror is indistinguishable from a dead run.
- ⛔ **op-27 is launcher-only, always.** Checker sessions and workers never tick; the orchestrator ticks
  from the shared ledger. Parallel writers to one description overwrite each other, and a bookkeeping
  step attached to one execution path dies the day that path changes.
- ⛔ **Anchor on the item prefix**, not on the number — `- [ ] #<pr>` (or the whole `raw` line
  byte-for-byte) — because a bare `#<n>` also appears inside other pull-request titles on the same
  list, and a naive replace ticks the wrong row.
- ⛔ **Wrap every key you append in backticks**, so nothing autolinks. An unwrapped key autolinks, and a
  key truncated at a character offset autolinks to a *different* issue.
- ⛔ **Patch, never a whole-body rewrite** — a patch is atomic and cannot clobber a concurrent edit.
  **Where the tracker has no atomic patch (`atomicPatch: false`), the tick is a read-modify-write under
  the 1-slot `tracker-worklist:<KEY>` pool lock**, acquired and released around the read and the write;
  `fleet check tick --lock` does exactly this. `github.md` shows the emulated form, `linear.md` the
  native one, and `trello.md` the case where no lock is needed at all because each check item is
  updated atomically by id.
- ⛔ **Verify a backfill by re-fetching (op-26) and counting ticked rows, never by retrying** — a
  whole-description backfill can trip an oversized-response error *after* the write applied, and a blind
  retry is how duplicates get made. At any point the ticked-row count must equal the ledger's line
  count.

### op-23 / op-24 / op-25 — umbrella, duplicate, related

**op-23 `setParent`** builds the accessibility umbrella: one collapsed parent that removes a whole class
of tickets from the working queue while keeping **one issue per gap**, because a pattern ticket would
lose the per-site file, line and pull request that makes each one actionable. Real sub-item support
exists on Linear (`parentId`), Jira (the native parent field, or the legacy epic-link field on older
sites), Asana (`setParent`) and GitHub (a sub-issues endpoint that can answer 404 or 403 per repository,
so `github.md` degrades *at run time* to a task-list umbrella). Trello has no parent field on a card at
all: `subIssues: false`, and the umbrella becomes an **index card** whose body is a checklist of its
children.

**op-24 `markDuplicate`** has real relation support on Linear (`duplicateOf`), Jira (a `Duplicate` issue
link), GitHub (a duplicate close reason) and Asana (a duplicate tag plus completion). Trello has none —
`duplicateRelation: false` — so the evidence comment is followed by an op-25 link and the cancel path.
Note the difference that matters for ordering: **Linear's relation moves the state by itself; Jira's
link does not**, so Jira's adapter follows the link with op-4 → op-5.

**op-25 `relate`** is a non-hierarchical link plus a note on **both** sides. Map the `kind` the playbook
passes (`related`, `blocks`, and the partial-overlap shapes) onto the closest relation your tracker has,
and say which in the `Call:`. Where there is no relation type at all, a comment on both issues naming
the other key and the kind *is* the implementation — GitHub does this deliberately, because a bare
issue reference is what makes the code host cross-reference the two timelines.

**The invariant that binds all three:**

> ⛔ **The evidence comment comes FIRST, the relation second.**

On some trackers the relation moves the state on its own, and on some, setting the duplicate state
first makes the relation call fail. Either way, doing it in the reverse order loses the rationale — the
issue is closed, and the reason it was closed is nowhere. The comment is mandatory; the relation is the
bonus. The same ordering governs op-9 `cancel`.

The documented degradations, which are the plugin's behaviour and not yours to redefine:

| capability | when `false` |
| --- | --- |
| `subIssues` | op-23 is never called. The umbrella is still created, as an **index issue**: its body is a checklist of child keys maintained by op-15, each child carries a `**Parent:**` body line, and op-25 links them when `relations` is true. Priority forcing and labels on the children are unchanged. |
| `duplicateRelation` | op-24 becomes op-11 (evidence, mandatory) then op-4/op-5 into the cancelled state, with ``Duplicate of `<ofKey>` `` as the comment's **first line**. If `cancel` is also false: op-11 then op-10, and the done flag records `--outcome duplicate`. |
| `relations` | op-25 becomes op-11 on **both** issues, each naming the other key in backticks and the kind. Nothing is dropped — the "who owns which sites" note still lands on both sides. |

If your tracker needs a degradation that is not in that table, propose it in the pull request rather
than inventing one in your adapter.

## Step 5 — `findIssues` completeness

`capabilities.findComplete` declares **how op-16 proves it returned everything**, and the reconciler
trusts nothing else:

| value | the signal | worked example |
| --- | --- | --- |
| `page-flag` | a has-more / next-page flag on the response | `linear.md`, `asana.md`, `jira.md` (cloud) |
| `total` | a total count to compare against what you have read | `jira.md` (self-hosted: `startAt + len >= total`) |
| `link-header` | pagination headers followed until absent | `github.md` |
| `all-at-once` | the tracker never pages this read | `trello.md` (the board read returns the board) |

> ⛔ **A page returning exactly its `limit` with no explicit completeness signal is truncated by
> definition** — because `limit` is a page size, not a total. A full page comes back with no error, and
> a truncated result makes real work look undone and manufactures a phantom backlog that then gets
> re-filed as duplicates.

Two consequences to honour in your `Call:` line:

- **Band the query by priority** (1, 2, 3, 4 — one call each) so each band fits a page, assert `complete`
  on **every** band before combining, and report the per-band counts. A band silently at its cap is
  exactly the failure you are looking for.
- **Exclude parents structurally** with `parentIsNull: true`, never by a list of parent ids — an
  umbrella filed later carries the same labels and priority as its own children, and an id list is a
  snapshot of the parents you knew about when you wrote it.

If your tracker's search endpoint has **no** completeness signal at all, say so and page it another way.
`asana.md` is the worked example: its search returns no page flag, so a page of exactly `limit` rows is
treated as truncated and the query is repeated with a `created_at` cursor until a short page comes back.
Where the read filters locally after fetching (Trello), `complete` is true **only** when the local limit
dropped no rows, and a cut result reports the dropped count.

## Step 6 — priority

`priority.scale` is one of `numeric | named | labels | none`, and `priority.map` translates canonical
`1 Urgent · 2 High · 3 Medium · 4 Low` into this tracker's values.

- **`numeric`** — the tracker's field is already 1..4. `linear.md`.
- **`named`** — the tracker has a priority field with its own names, which may be site-configurable;
  send them verbatim. `jira.md`.
- **`labels`** — **the tracker has no priority field, so the four map values are label names that op-18
  creates at init/plan time**, and the `**Priority:**` body line carries the same value as a second
  channel. `github.md`, `trello.md` and `asana.md` all take this path. Note the consequence: an adapter
  with `priority.scale: labels` must have `labels: true`, because the labels have to be creatable.
- **`none`** — priority lives only on the `**Priority:**` body line.

`priority.map` must cover all four levels whichever scale you choose.

## Step 7 — run the tests, then the checklist

From `plugins/claude-fleet` (Node ≥ 20 and git; there is no install step):

```
npm test
npm run lint:redaction
```

`test/playbook-brands.test.mjs` is the gate your adapter meets. It asserts, over `trackers/*.md`:

- **every operation 1..27 has exactly one `## op-<n>` section** — none missing, none duplicated;
- **each section has a `Call:` line and an `If unsupported:` line**, and **`## op-22` also has a
  `Strategy:` line**;
- **`id` equals the filename**;
- **`issueKey.pattern` compiles, matches `issueKey.example`, and — in the case mode you declared —
  matches none of `main`, `develop` or `release-2`**;
- **a tool name appears in the body only on a `Call:`, `Transport:` or `Strategy:` line** (or in
  `listOp`, a heading, or a block quote);
- **no `op-<n>` outside 1..27 is cited anywhere**, in an adapter or a playbook.

`test/docs-redaction.test.mjs` also scans adapters: no real issue key, person, company, product,
internal domain or absolute machine path, in any file. Adapters are exempt from the tool-identifier
pattern only — that is the exemption that lets a `Call:` line exist at all.

Then walk the **pre-PR checklist at the bottom of `trackers/_template.md`** by hand. Several of its
items are not yet asserted by any test — capability ↔ section parity in both directions, sections in
numeric order, `priority.map` covering 1..4, `states.*.promptDefault` being names rather than ids,
`scope.listOp` naming a real tool, `config[].key` entries being contract `tracker.*` or
`tracker.settings.*` keys and nothing else. The checklist cites `test/tracker-registry.test.mjs` for
these; **that file is not written yet**, so a reviewer checks them, which means you should check them
first.

The same is true of `fleet trackers show <id>`: the CLI and `src/trackers/registry.mjs` are **not built
yet**, so you cannot render your adapter through them today. `npm test` is the verification that exists
now. Say in your pull request which parts of the checklist you verified against a real workspace and
which you could only reason about.

Finally, in the pull request description: name the tracker, list every capability you set to `false` and
what the operator loses as a result, and confirm you ran each `mcp.install[]` entry once on a clean
machine.

## Where a tracker-specific quirk goes

You will find something surprising. A signed URL that expires faster than documented; a search endpoint
that quietly caps at a thousand results; an error echo that means the write applied; a field that is
present on one plan and absent on another.

Two of those belong in the adapter — a constraint the `Call:` line must honour is an invariant under
its op, with its `⛔` and its one sentence of why. But the *diagnosis* — which check lied, which one
told the truth — belongs in `docs/field-notes.md`, appended the turn it happens, in the Saw / Cause /
Rule format:

```
### !! <the symptom, written as what you will see>
**Saw:** <what was on the screen, what the call returned>
**Cause:** <the diagnosis>
**Rule:** <imperative, with the one sentence of why>
```

`**Saw:**` and `**Rule:**` are literal, in that order, with a labelled cause between them; the
redaction gate enforces the skeleton. The editorial test is *would this let a session three weeks from
now, with no memory of today, skip the diagnosis entirely?*

And redact it: no source-repository paths, no real issue keys, no product mechanism, no person, no
company, no absolute path from your machine. Write paths as `<component>:<line>`, keys as `ABC-1234`,
dates as `2026-03-14`, and the human as "the operator". **A `Saw:` must let a stranger reproduce the
method failure and must never help anyone locate a product defect.**
