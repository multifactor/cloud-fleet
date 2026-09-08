# `/fleet-check` audit — gating a finished sweep

This is the audit half of `/fleet-check`. It runs on a **finished corpus** — the tickets a sweep filed
into triage carrying `gate:pending` — and decides, per ticket, whether the finding is real, whether its
severity is right, and whether its prescribed fix works. It is the only part of the pipeline that
mutates tickets destructively (cancel, mark duplicate), which is why every rule below is written the
hard way and kept with its reason. Everything here speaks in tracker op names (`op-1`…`op-27`, see
`docs/reference/contract.md` §6) and in `fleet check …` subcommands; nothing here names a tracker tool.

The rules of `playbooks/check.md` still apply, in particular **⛔ NEVER ask the user a question** — an
audit is launched and walked away from; a question does not pause it politely, it stops it dead.
Decide, act, and say what you chose in the report. When two readings differ, take the one that
preserves the most information — leave the ticket open, keep the artefact, relate rather than merge.

## 0. When and how the audit runs

- **It always follows a sweep.** `fleet check finish <sweepId>` chains into
  `fleet check audit plan <sweepId>`. The audit is never skipped because a sweep "looked clean":
  measured on one corpus of 466 findings, the per-PR pass produced **0 false positives among the
  high-severity findings and yet only 8% were accurate as written** (§3.22) — the errors a sweep makes
  are scope, trigger and remedy, and no per-PR worker can see them.
- **It is its own subcommand, not a phase.** Its rules are corpus-level — the frame is re-derived
  *after filing stops*, batches run by category, contradictions are checked across the whole corpus —
  and none of that can run per wave. That is why `checker.autoPromote` is `never | after-audit` and
  there is no streaming promotion.
- **It is re-runnable.** `/fleet-check audit <sweepId|project>` runs
  `fleet check audit plan <sweepId|project>`, which derives the frame again from the *current* state of
  the corpus and mints a fresh `auditRunId`. Re-running on an old corpus is how you gate the findings a
  previous run never saw (§3.7) — every verdict row carries the `auditRunId` that produced it, so runs
  never overwrite one another.
- **What `audit plan` produces.** It reads `manifest.json` (the repo snapshot sha, the resolved
  umbrella / triage / ready ids, the sweep group), `filed/<slice>.tsv`, `findings.jsonl` and
  `worklist.tsv` from the sweep dir, derives the frame from the tracker (§3.6, op-16), and writes under
  `audit/`: the gate-1 slices grouped **by PR**, the category batches, the consequence set (every
  Urgent plus every High carrying `checker.securityLabel`), and the dedup clusters
  (`fleet check dups cluster`). `audit/verdicts.tsv` is the file the rest of the pipeline reads (§4).
- **Paths.** The sweep dir is `<stateDir>/sweeps/<sweepId>/`; `fleet check audit plan --json` prints
  it, and inside a checker session it is `FLEET_SWEEP_DIR`. Never a literal path.
- **Who writes what.** Workers judge and append to a **private per-slice TSV** under `audit/`, one row
  per finding, immediately — never batched. Only the orchestrating session merges those into
  `audit/verdicts.tsv`, queues ops, and touches shared state: the umbrella, the category parents, the
  work-list mirror issue, and any ticket a worker did not create. Same table as `check.md`.
- **The tracker is reached only through ops.** Everything the audit wants the tracker to do is an
  outbox entry (`fleet outbox add --op <op> --key <KEY> --args <json>`, or the entries
  `fleet check gate apply` enqueues) that the launcher drains by executing the adapter's `Call:` line.
  Without a tracker (`tracker.mode: none`) there is nothing to queue: `audit/verdicts.tsv` *is* the gate
  and `fleet check promote` reads it.

## 1. Gate vocabulary

Every verdict row scores a finding on **three independent axes** and derives one **gate** status. The
axes are independent because they fail independently — a correct diagnosis with a broken fix is the
dominant failure on a security corpus (§3.22), and a gate that reads only the diagnosis column skips it.

| axis | domain | what it grades |
| --- | --- | --- |
| `diagnosis` | `real` · `false_positive` · `already_fixed` · `uncertain` | is the defect real and open in current code? `real` is the default (§3.1) |
| `severity` | `confirmed` · `understated` · `overstated` · `n/a` | is the filed priority right? `n/a` only when `diagnosis ≠ real` |
| `fixAxis` | `verified` · `defective` · `no_op` · `absent` · `untested` | does the prescribed fix work? `absent` = the ticket prescribes nothing; `untested` = nobody was briefed to test it |
| `gate` | `pending` · `passed` · `failed` · `uncertain` · `disputed` · `waived` | the derived status mirrored to the ticket as a `checker.gate.labels` label and a `**Gate:**` body line |

**The decision rule** (`fleet check gate apply` enforces it; a row that violates it is rejected, not
"fixed up"):

- `passed` ⇔ `diagnosis = real` **and** `fixAxis ∈ {verified, absent}` **and** (`severity = confirmed`
  **or** the correction has been applied to the **priority field, the title AND the body**). A
  comment does not correct a description, and a fixer reads the description (§3.16); a ticket whose
  body still argues the old severity is not passed.
- `fixAxis ∈ {defective, no_op}` ⇒ **not passed** until the `⛔ DO NOT …` block sits in the body
  **immediately after the prescription** (§3.20). The comment records *why*; the description is what
  runs.
- `fixAxis = untested` **on a row whose diagnosis is `real`** ⇒ **not passed, and the corpus is not
  gated.** A batch that was not briefed to test the fix produces an incidental count, which is a floor
  and not a rate (§3.20) — re-run the band with the brief before reporting anything.
- `failed` ⇔ `diagnosis ∈ {false_positive, already_fixed}` **after both gates** (§2). Only a finding
  that fails *both* gates is cancelled, and only after its evidence comment is posted (§4).
- `uncertain` ⇔ neither gate could reach the code that settles it ("I couldn't find the file", a state
  no probe could produce). Left open; **the audit never promotes it** — only the operator's explicit
  `fleet check promote --waive` can (§8). Reported in its own column.
- `disputed` ⇔ the two gates returned contradictory verdicts and **both** point at specific code. Left
  open with both comments on the ticket; a human reads them. **The audit never promotes it** — only
  the operator's explicit `fleet check promote --waive` can (§8).
- `waived` is **human-only**. The audit never writes it; `fleet check promote --waive` is the
  operator's explicit act (§8).
- `pending` is what a sweep files with, and what a judged row keeps while a correction is still
  outstanding (§4.1). A row that no gate ever touched is a frame gap (§3.6), not a verdict;
  `fleet check gate status` separates the two.

## 2. The doubt-driven gate (find + rescue) — and the consequence-driven gate

The operator periodically asks to "check false positives" on a completed sweep. That is the
**doubt-driven gate**, it runs as gate 1 then gate 2, and the second is not optional — measured on one
sweep (466 findings), gate 1 flagged 44 and the rescue gate **overturned 39 of them (89%)**. Acting on
gate 1 alone would have cancelled 39 real, open bugs. "Both gates" always means these two.

**Gate 1 — find.** Fan out over the findings grouped **by PR** (~9 findings per worker; the slices
`fleet check audit plan` wrote). Each worker reads the PR's cached diff (`_sweep/prs/<n>.diff`) once,
pulls each issue with op-2 `getIssue`, then **opens the files the `**Where:**` line names and reads the
actual code** — via `git show origin/<base>:<path>`, never a checkout (§3.2). Verdicts: `real` (the
default) · `false_positive` · `already_fixed` · `uncertain`. Append one row per finding to the private
per-slice TSV immediately — never batch.

**Gate 2 — rescue.** Every flagged finding goes to an independent worker told to **prove the finding
IS real**, not to second-opinion it. Brief it with the ticket's own claim quoted verbatim (§3.21). Only
findings that fail *both* gates are reported bogus.

**The consequence-driven gate.** Gate 1 and gate 2 — the doubt-driven gate — track *doubt*. A security
corpus also needs scrutiny that tracks *consequence*: **every `Urgent`, and every High carrying
`checker.securityLabel`, goes to the consequence-driven gate regardless of gate 1's verdict** (§3.5),
briefed to test the prescribed fix on every single one (§3.20). The two passes have opposite yields and
catch different errors — the numbers are in §3.22; run both passes.

## 3. Methodology — the rules, in order

### 3.1 ⛔ The three rules that decide whether this audit helps or does damage

1. **`real` is the default, and imperfect is not false.** A wrong line number, an overstated
   severity, a misquoted comment, a claim that names a moved file — none of these make a finding
   false. Flag only when you can point at the specific code that **refutes** it. "I couldn't find the
   file" is `uncertain`.

2. **⛔ Attribution is not truth — do not offer `out_of_scope` as a rejection.** 33 of the 44 flags
   were "this file isn't in the PR's diff" on findings the auditor had *just verified line-for-line*;
   gate 2 overturned 32 of them. For a MERGED PR the only question that justifies a cancel is **is
   the defect real and open in current code**. Before flagging for scope, search the PR body (cached
   in `_sweep/prs/<n>.json`) for `not in scope` / `follow-up` / `separate ticket`: authors routinely
   defer work and name the file, which makes the ticket the tracker for that deferral, not a scope
   error.

3. **⛔ Never decide "already fixed" from `git log`.** A checkout may be a **shallow clone**
   (`git rev-list --count HEAD` returning a two-digit number against a thousand-plus merged PRs), so
   `git log -S'<missing string>'` confidently names a commit that never touched the line. Decide from
   **current file contents**, which are accurate. Put this in the auditor brief as a prohibition.

### 3.2 ⛔ Re-check the snapshot before you claim "verified against current code"

A long fan-out pins a checkout at dispatch time and `<base>` keeps moving — especially on a sweep that
reviews **open** PRs, because those are exactly the PRs about to merge. On one sweep, `origin/<base>`
was **5 commits ahead** by wrap-up and **31 of 435 findings** had been judged against a stale tree.

At wrap-up, always (the snapshot sha is in `manifest.json`):

```
git fetch origin <base>
git rev-list --count <snapshot-sha>..origin/<base>       # 0 means nothing to do
fleet check blast-radius --since <snapshot-sha>          # the changed paths, matched on FULL path
```

Re-check every finding naming one of those files. ⛔ Match on the **full path** — matching by
basename gave 66 hits of which 42 were bogus (`page.tsx` matching dozens of unrelated routes) against
a true 24. `fleet check blast-radius` matches on full path for exactly this reason; do not re-derive the
list by hand.

⛔ **Do not `git checkout` to read the new code** — other agents may still be reading the tree, and a
stale-tree read silently returns the OLD file, so an agent concludes "unchanged" and is wrong. Use
**`git show origin/<base>:<path>`** and `git diff <snapshot-sha>..origin/<base> -- <path>`, which touch
nothing.

Expect low yield (30 of 31 still open in the measured case) — the point is not the count. Until this
runs, "verified against current code" is an overclaim, and the one hit was worth it: a ticket
half-closed by a merge, plus an open PR that now imports a module that merge deleted.

### 3.3 ⛔ If a severity turns on runtime browser behaviour, measure it — do not file it as an open question

Browser storage and lifecycle semantics — IndexedDB blocking, connection queues, what survives a
navigation, what a service worker holds — are **cheap to measure and expensive to argue**. Two agents
reasoned about one such question from source and neither could settle it; a browser probe answered it
in about four minutes and **inverted the severity**, forcing a filed High down to Medium.

When a finding's impact depends on what the runtime actually does:

1. Model the two roles on a **neutral origin** (never the live product): one context holding the
   resource, one performing the operation.
2. Reproduce the app's **exact timings** — if the code waits 2000 ms before declaring success, wait
   2000 ms and read the state at that instant.
3. Tear down the initiator the way the app does (navigate away), then release the holder, and observe
   what completes.
4. **Clean up** every database, key and tab the probe created.

An unresolved severity in a filed ticket is a decision pushed onto whoever picks it up. Do not ship
one when the tools to settle it are already attached.

⚠️ **A defect can survive a downgrade.** In that case the data *was* eventually deleted, so the
severity dropped — but the code comment justifying the app's backstop was **disproved** by the same
probe. The outcome was right by luck, not by the stated reasoning. Report both halves: the corrected
severity *and* the false premise, because the premise is what will produce the next bug.

### 3.4 ⛔ A finding you trip over while doing something else still needs the gate

Fix-planning, refactoring and code reading are good defect **detectors** and bad defect **judges** —
an agent deep in one mechanism starts seeing that shape everywhere. Of three candidates surfaced this
way on one sweep, **one verified real and two were refuted** — a 67% false-positive rate, against ~1%
on the swept-and-audited corpus.

Both failures were seductive for the same reason: each pattern-matched a *confirmed* true positive
one file over. One died because the triggering state was unreachable **and** the path failed closed
anyway. The other shared a bug's whole skeleton but lacked the one structural element the bug
actually needs — and turned out to be the reference implementation the buggy file had been fixed to
match. ⛔ **A shape-level scan matches the skeleton and misses the difference.** With near-copy-paste
siblings, find the line where they diverge before believing they share a defect.

Record such findings immediately, then put them through the **same** adversarial verification as
swept findings before filing. "I found it while I was in there" is not evidence.

### 3.5 ⛔ Escalate on severity as well as on doubt

The obvious escalation rule — gate 1 says `real`, done; gate 1 flags it, recheck — is right for
catching false positives and **wrong for a security corpus**. It makes scrutiny track *doubt* instead
of *consequence*.

On one sweep that produced an exactly inverted result: a Low that one agent found suspicious got two
passes, while the corpus's only two **Urgent** findings — both security claims — got **one each**,
because nobody had doubted them.

**Rule: every `Urgent`, and every High carrying `checker.securityLabel`, goes to the consequence-driven
gate regardless of gate 1's verdict.** On 466 findings that was 2 extra agents. It is the cheapest insurance
in the process.

⚠️ **The point is not that the verdict flips.** Both were confirmed. The value was that both turned
out to be *understated*, and both carried a framing hazard:

- one's fix belonged in a **shared helper** serving three other flows the ticket never mentioned —
  fixing it where the ticket pointed would have left the more sensitive artifact still exposed;
- the other's **stated trigger was its weakest**; the common path was an early return the ticket never
  mentioned, after an operation the user believes failed;
- one led with behaviour that is **intended by design**, inviting a reviewer to dismiss the whole
  ticket as working-as-designed rather than reading to the actual defect;
- and one's obvious fix **silently breaks the feature** unless a second, non-obvious call is made
  alongside it.

A confirmed finding is not the same as an actionable one. Re-checking your worst findings is how you
find out which you have.

### 3.6 ⛔ Enumerate a gate's input from the FLAT corpus, never by walking the category tree

The rule above ("every `Urgent`, every security-labelled High goes to the gate") is only as good as
the *list* you apply it to — and the obvious way to build that list is the one that silently
under-counts.

Measured on one sweep. Gates enumerated their input by traversing the category parents. A late
group-wide query for `priority: 1` returned **three Urgents nobody had gated**, two of which had
**no parent at all**. The flat list then showed the true size: **41 findings with no parent, 21 of
them High** — an entire subsystem's worth of findings, including some of the most severe in that
corpus.

**An uncategorised issue is invisible to a tree walk, and nothing reports the gap.** The gate does not
fail; it succeeds over a smaller set and reports a confident number. The auditor said "22
security-labelled Highs gated" — that was 22 of the Highs *under one parent*, not the group's. The rule
was satisfied for a subtree mistaken for the whole.

**Rule:** build every gate's work-list with op-16 `findIssues` over the **whole sweep group**
(`checker.project`), filtered by *the attribute that defines the gate* — `priority`, or the label —
one call per band, and **assert `complete`** on every page set (a page returning exactly `limit` with no
completeness signal is truncated by definition). Then reconcile it against what the parents hold
(op-1 `resolveChildren` per parent) and **treat any difference as a finding in its own right**.
`fleet check frame derive` consumes those op-16 pages and does the exclusion structurally (§3.19).

**The general shape, worth more than the instance:** the categorisation pass was scoped by
**assignee**; the gate was scoped by **severity**. *Whenever two passes over one corpus use different
scoping keys, the difference between them is exactly the set nobody looks at.* Reconcile the keys
explicitly, or expect a hole — and expect it to be in someone else's area, which is why nobody
noticed.

**And it is not enough to run the query once — the work-list must be re-derivable.** Applying the rule
above to the *same* sweep immediately found a second, separate hole: the security gate's hand-frozen
input list held **22 rows**, while op-16 over the group filtered by the security label returned **58
Highs and 5 Urgents**. Twenty-one live findings — two of them Urgent — had never been gated, and **none
of them appeared in the 22-row list**. Those 21 all had category parents, so this was not the orphan
hole; the list had simply been hand-assembled and then *described* as "every security-labelled High".

**Why nothing caught it: a gate never reports the findings it was never handed.** It reports 100% of
its input, always. "22 gated — 2 confirmed, 16 understated, 4 overstated, 0 false positives" reads as
a complete result at any level of scrutiny *inside* the gate. Completeness is the one property a gate
cannot observe about itself.

**So:** save the query that built the list, not just the list — `fleet check audit plan` records it in
`audit/`. Before reporting any gate result, re-run it (`fleet check frame check`) and assert
`gated == derived`. And state the denominator **with its provenance in the same sentence as the
tally** — "N of M, M from op-16 over the group filtered by label X" — never a bare N. *Diagnostic:* if
you cannot re-derive the work-list with a command, you do not know what you covered.

⚖️ **Calibration, so this does not become blanket paranoia:** the same group's a11y invariants,
checked flat the same way, were **perfect** — 106 of 106 issues carrying a `checker.a11y.labels` label
at `checker.a11y.forcedPriority`, zero unassigned. Tree-scoped reasoning is not always wrong. It is
specifically the **gate input** that must be machine-derived, because a gate is the one artifact whose
output cannot reveal its own gaps.

### 3.7 ⛔ Re-derive the frame AFTER filing stops — a gate that FILES findings extends its own denominator

The rule above is necessary and **not sufficient**. It was applied twice on the same sweep, passed
both times, and still missed findings — because the frame is not static while you work.

**Three ways the frame moves under you, all observed on one run:**

1. **Applied verdicts remove rows.** Every `overstated` → downgrade moves a finding out of
   `priority:3`. Re-querying that band *after* applying verdicts under-reports what you covered.
2. **A neighbouring pass's downgrades add rows.** 26 findings corrected High → Medium became live
   Mediums that were **already judged**, under a different pass's output file. Subtracting only the
   current pass's outputs reported **42 misses**; the true number was **1**.
3. **⛔ Your own filings extend the range.** A gate that files new findings is a *producer* of the
   denominator, not only a consumer. Three findings filed mid-run — one of them **High** — sat between
   two individually-sound frames: filed after the High/Urgent frame was derived, and not `priority:3`,
   so the later Medium assertion could not see them either.

**The assertion that actually closes it**, run **after filing stops**, across **every** severity the
gate covers — not just the band you were last working in:

```
# one op-16 call per severity in range, over the whole sweep group; assert `complete` on each
op-16 findIssues({group: <checker.project>, priority: 1, limit})
op-16 findIssues({group: <checker.project>, priority: 2, limit})
op-16 findIssues({group: <checker.project>, priority: 3, limit})
# keep rows whose state type is not `cancelled` (drops cancelled and duplicate-closed rows);
# drop the category parents and the work-list mirror issue (structurally, §3.19)
fleet check frame check        # frame minus judged-by-EVERY-pass must be empty
```

`fleet check frame check` subtracts the judged ids from **every** pass's output, not just the current
one, and prints the difference. It must be empty.

**Treat findings the audit filed itself as first-class members of the denominator.** They are the only
ones nobody else will ever check, and they are exactly the ones a severity-scoped re-query misses.

⚠️ **The tell that caught it:** a round number about the auditor's own coverage — "11 of 11 self-filed
findings were re-gated" — written into a report and checked only because someone would read it. It was
11 of 14. **Verify coverage claims about your own output before publishing them; they are the ones you
are least likely to have actually counted.**

### 3.8 ⛔ The verdict split INVERTS with severity — and a selected set is not a sample

Gate high-severity findings and you mostly find work that is **under-scoped**. Gate Mediums and you
mostly find work that is **over-scoped**. Measured on one corpus, same method, same four verdicts:

| | High/Urgent (119) | random Medium (16) |
|---|---|---|
| `confirmed` | 4% | **19%** |
| `understated` | 68% | **31%** |
| `overstated` | 26% | **50%** |
| `false_positive` | 0 | **0** |

**Both are worth gating, for opposite reasons.** At High the payoff is finding the call sites and the
broken remedies a fixer would have missed. At Medium the payoff is a queue that stops being inflated:
half of them were priced above their actual harm — a "will not scale" claim whose N is capped by a
constant two files away, a hardening claim whose supposedly hostile parties turn out to share trust
with the site, a lockout argument aimed at a component the fix does not touch.

⛔ **The methodological trap, which the auditor fell into first.** The first draw sampled the Mediums
that **already had fix-specs** — and concluded the yield was too low to bother. Those 14 were *every
Medium with a spec*, i.e. selected for having been judged worth specifying, and 13 of 14 were one
defect family. A properly stratified draw across all ten categories put `overstated` at **50%**, not
36%, and `confirmed` at 19%. **81% still needed a correction** — the yield was never low.

**Before generalising from a set, say in one sentence how it was assembled.** If that sentence contains
*"the ones that happened to…"*, it is a **selected set, not a sample**, and supports a claim only about
that selection. Drawing a real one is cheap — 19 findings against a corpus of 466. Draw it
**machine-spaced**: every k-th row of the sorted work-list at a fixed stride, never hand-picked.

⚠️ **And brief a calibration sample WITHOUT the prior distribution.** Every other batch in that run
was told "0 false positives, expect understated reach". Telling a calibration batch that destroys the
measurement — say explicitly that a `confirmed` verdict is a welcome outcome.

### 3.9 ⛔ Batch the gate BY CATEGORY, and ask what no single-ticket review can

Judging one ticket at a time cannot see a contradiction that lives **between** two tickets. Measured
across 13 batches of six on an accessibility corpus, **four pairs** turned up where one ticket
prescribes exactly what another files as a defect — and **both tickets were individually correct**:

| ticket | its prescribed fix produces | filed as a defect by |
|---|---|---|
| `ABC-101` | a tooltip wrapper around a disabled control | `ABC-102` — same batch |
| `ABC-103` | a live region mounted with its text already inside | `ABC-104` — same batch |
| `ABC-105` | a visually-hidden label beside a responsive one, read twice | `ABC-106` — same batch |
| `ABC-107` / `ABC-108` | a busy attribute on a text field | `ABC-109` — disproves it |

A sweep files one ticket per PR per candidate, and each finder sees only its own PR. Two finders at
opposite ends of one pattern independently write "do X" and "X is wrong". Nothing inside either
ticket reveals it.

✅ **So batch by category, not by PR**, and after every batch ask the one question the per-ticket
pass structurally cannot: **does any ticket here prescribe what another files as a defect?** The
pairs are always adjacent in the category tree — the same property that makes a category batch feel
repetitive is what makes it work. `fleet check audit plan` writes the category batches for this
reason; gate 1 is by PR, the contradiction pass is by category.

### 3.10 ⛔ Then run the contradiction check at CORPUS scale — and gate the GUIDANCE documents

Per-batch is not enough. Batching by category found **4** contradiction pairs; a construct index over
the whole corpus found **2 more clusters spanning 5 and 6 batches**, which no batch could see.

**The method, in one pass over verdict prose you already have:**

1. Index every **construct** named across all verdict rows — `aria-*`, `role=*`, `data-*`, dotted API
   paths, camelCase identifiers.
2. For each construct in ≥4 tickets, read the rows and split them into **prescribed** vs **filed as a
   defect**.
3. Any construct appearing on both sides is a corpus-level contradiction.

⚠️ **Read every cluster, and say how many you read.** A first pass over the two constructs you
already suspect will pay out immediately and *feel* complete — the measured run's did, and it was
written up as "the corpus check" with **23 of 25 clusters unopened.** The largest finding was in the
tail. **State the denominator of your own sweep in the same sentence as its result.**

⚠️ **A prescription-vs-condemnation heuristic is a reading ORDER, not a conclusion.** The measured
heuristic flagged 11 clusters; 2 yielded findings. Condemnation vocabulary appears in nearly every
`overstated` verdict because that is what such a verdict says — the heuristic detects the verdict, not
a conflict. Publishing its output would have produced nine false findings.

⛔ **Index only on tokens that cannot be ordinary prose.** `inert` returned 25 tickets of which **4**
were the HTML attribute; the rest were the English word. `aria-busy` (10) and `role=alert` (8) were
100% signal and both yielded real findings. **Sort candidate clusters by precision, not frequency.**

✅ **Ground each cluster in a repo count before writing it up.** `aria-busy`: **zero occurrences** on
`origin/<base>` — so every ticket citing it as precedent was wrong. `role="alert"`: **42 files**
against `role="status"`'s **5** — so a ticket arguing for polite-by-default is proposing a house-style
change, not a local fix, and should say so.

### 3.11 ⛔ Gate the umbrella, the category parents and the work-list mirror — AFTER the findings are judged

Every gate judges **findings**. Nothing judges the **guidance**, which is the first document a fixer
opens and the only one whose advice reaches every ticket at once.

Measured: the a11y umbrella governing **77 sub-issues** prescribed `aria-busy` in its "recurring
shapes" table — the exact pattern its own sub-issue files as a defect, and a primitive with zero
occurrences in the repo. Four sub-issues had already inherited it. The same umbrella's **top**
pull-forward item cited a **symbol that does not exist**.

✅ **Diff each claim in a parent against the verdicts of its own children** (op-1 `resolveChildren`,
then the children's rows in `audit/verdicts.tsv`). A wrong finding costs one ticket; a wrong umbrella
costs every ticket under it.

### 3.12 ⛔ An absolute claim must be true of the command a reader will run

*"There is no `QueryProvider` anywhere in `example/app/src`"* appears in several verdicts.
`QueryProvider` appears in **6 files** there — **all `.test.tsx`**. The substance was right (no
provider in production code); the sentence was false, and the first reader to search finds six hits
and stops reading.

✅ **If your search needed a filter — excluding tests, `dist`, fixtures — put the filter in the
claim:** *"no `QueryProvider` provider in production code; the six occurrences are test harnesses."*

⛔ **This is the mirror of the wrong-path failure.** A too-narrow search makes a true finding look
fabricated to *you*; a too-broad claim makes a true finding look fabricated to *your reader*. **Both
are the gap between the search you ran and the search you described.**

✅ **Diagnostic:** before writing "no X anywhere in Y", run the naive search a sceptic would run. If it
returns hits, the sentence needs the qualifier.

### 3.13 ⛔ A line-oriented search finds candidates. It never COUNTS them and never REFUTES them.

Three wrong numbers in one session, all from matching inside a single line:

| shortcut | reported | true |
|---|---|---|
| classify by the **next line** | 19 defective sites | **22** — 3 were fine, 6 worse ones were hidden |
| search scoped to **the named package** | "the symbol does not exist" | it exists, in another package |
| single-line search for a **multi-line attribute set** | "used once" | **used twice** |

A line search is line-oriented; JSX and similar template syntaxes are not. Each shortcut was perfect
for *locating* the pattern and then silently produced a *count*.

✅ **Before any number goes in a ticket, re-derive it over a window wide enough to hold the whole
construct** (a multi-line-aware search) **and over the whole tree**, not the path the claim named.

✅ **Diagnostic:** widen the window and see if the number moves. **A number stable under widening is a
number; a number you never widened is a guess.**

⚠️ **A residual bucket is not a safe rounding.** After correcting the count the auditor still had 7
sites parked as "unresolved" and said so honestly. Resolving them found **2 more defects** — a rate
matching the measured population, not a lower one. **Report the floor, then go back and close it: a
floor is a promise, not a result.** And one of the two needed a *different fix* from the other 23 (the
component was correct; only the call site was short a prop) — **closing a residual can change the
shape of the fix, not just the size of the number.**

⚠️ **The errors run in both directions.** Overcounts let a fixer dismiss the whole ticket at the first
site they check; undercounts hide the worst instances in the residual bucket. **A sloppy scan is not
conservative.**

### 3.14 ⛔ Promote the residue — "say both" does not survive the host ticket closing

When you downgrade a ticket to `overstated`, the surviving half goes in the comment. **That is the right
place for a reader and the wrong place for the finding's lifecycle** — a comment inherits the fate of
its issue, and an `overstated` ticket is first in line to be closed.

Measured: **67 verdict rows** carry residue on an `overstated`/`false_positive` ticket. A machine-spaced
sample of 9 found **6 carrying a distinct defect rather than a correction** — including a distinct
data-integrity defect that existed nowhere but a comment on a ticket marked `overstated` with a no-op
fix.

✅ **Split the residue by kind, at the moment you write it:**
- **a correction to the ticket's claim** → stays in the comment (op-11)
- **a different defect the ticket does not contain** → **its own ticket, cross-linked** (op-13
  `createIssue` into the sweep group with `gate:pending`, then op-25 `relate` both ways), so closing
  the host does not silently close the discovery. A ticket the audit files is a first-class member of
  the denominator (§3.7).

⛔ **A triage produces CANDIDATES; the promote/stay call needs the file open.** Measured: of 24 triaged
"distinct defects" verified, **exactly half produced a ticket** — the rest were refuted, described code
not on `<base>`, were never distinct, or were too small to queue. **Every misclassification ran toward
promotion**, because residue prose is written to be alarming and reads as standalone without the source
beside it. **Publish the triage count as provisional (`≤N`), expect it to fall, and report the drift.**

⛔ **Do not extrapolate the sample — and if the deliverable is a work-list, read the whole pool.** A
9-row sample put this rate at 67%; reading all 67 gave **52%**, because the classification boundary
itself moved (one row called a distinct defect was plainly the same defect at a second site).
**When a rate needs a judgement call, a small sample measures the boundary as much as the population.**
A sample establishes *that a class exists* and *what to verify first*; it does not measure it.

⛔ **Read the whole function, not the lines your claim needs.** A residue note quoted the copy that
supported its complaint and missed `// Deliberately NOT done here:` six lines below — the author
answering the objection in advance, with a reason, and confirming the user-facing copy had been scoped
to match. **A deliberate-looking omission usually has a comment; read it before calling it an
oversight.** This is the same "the PR's own comment refutes the ticket" failure the gate catches in
others — the auditor is not exempt from it.

⛔ **For any "state A plus state B" finding, verify a user can produce A and B together.** Two code
paths differing is only half the claim. Measured: a finding rested on *setting A off while setting B
on* — real only because the channel list holds both and the settings page renders an **independent
toggle** for each. Had the UI coupled them, the ticket would have been unreproducible. **Usually one
search for the control that sets each.** ✅ And when it IS reachable, cite the control — that converts
"I think this can happen" into "here is the toggle that makes it happen".

⛔ **Resolve every residue claim against `<base>` FIRST.** If `<base>` already looks correct, the
finding describes *a change an unmerged PR makes* — it belongs on the PR-review ticket and **must not
be promoted**. A standalone issue for it sends a fixer to code that is already right. One search
separates "existing defect" from "defect this PR would introduce". ⚠️ **This is not a refutation** —
the objection to the PR is unchanged; only the promotion fails. Say so, or you will look like you
overturned a correct review.

✅ **There are THREE outcomes, not two: file / drop / strengthen something already filed.** Check whether
the item is *the same defect at a worse call site*. Measured: one residue item turned out to be the
waiter defect already filed — but at a **sequential loop**, so a hang on the first row stalls an entire
import rather than one control. **Put it on the existing ticket as evidence (op-11) and say what it
changes about the priority.** Filing it again duplicates; dropping it as "already covered" loses the
amplifier.

✅ **And after confirming an item, ask the SECOND question separately:** *what does a fixer do
differently because this exists as its own issue?* If the answer is "nothing they would not do while in
that file anyway", **write it on the host ticket instead.** Measured: of five residue items verified
true, four earned a ticket and one did not. **Verification has momentum — four confirmations in a row
make the fifth feel like it produces a ticket.**

⚠️ **Search your own output for permanence words before promoting anything** — *forever, permanently,
never, always, retire, lost, cannot* — and for each, **find the code that would undo it**. Measured:
three of the auditor's own residue notes over-claimed permanence (`forever` → settles next sweep;
`retire` → stale until the next revalidation; `was told` → the function's own comment says the copy was
scoped to match), in a run whose Medium brief lists over-claimed permanence as failure shape #3. **All
three were still real defects** — removing the adverb moved them from "file a ticket" to "note on the
host". The cost of the distortion is **queue inflation, not false findings**.

⚠️ **Check your own corrections too.** One of those notes "corrected" a ticket's line cite to a range
that turned out to be a type declaration — as wrong as the cite it replaced.

⚠️ **Check your own severity adverbs on the way past.** "forever", "permanently", "never" were what made
the fifth look promotable; the code said *until the loop comes round again*. Over-claimed permanence is
the very thing the Medium brief warns about — easy to commit while auditing for it.

✅ **The triage is the deliverable; filing is not.** 35 tickets off one reader's classification is the
over-production a severity gate exists to prevent. Verify one end to end, file that, hand over the
classified list, and let a human promote from it.

### 3.15 ⛔ Verify the VERIFIER — machine-check the evidence your conclusions rest on

Every conclusion in a delegated run is built on line numbers written by subagents. Check them before
publishing. Citations have a falsifiable part that needs no judgement:

```
fleet check verify-citations --corpus audit/verdicts.tsv --ref origin/<base>
```

It extracts every `file.ext:NNN` from the verdict prose, keeps basenames that are unique on
`origin/<base>`, and asserts `cited_line <= file_length`. Measured on 463 verdict rows: **2,264
citations, 1,219 of 1,232 testable ones resolve — 98.9%.** The 13 that didn't were explained, not
defects (PR branches are longer than `<base>`; installed-dependency dist files collide with repo
basenames).

✅ **Then close the limit you just named.** Read a **machine-spaced** sample of the citations and judge
whether the cited line supports the claim. Measured (n=13, every 182nd of 2,375): **10 of 12 resolvable
exact, 2 right-substance-wrong-line, 0 false claims.**

⛔ **Treat cited line numbers as approximate and cited SUBSTANCE as load-bearing.** The drifts were off
by 1 and off by 6, with true claims both times. When re-deriving a finding, **search for the quoted
symbol rather than jumping to the line** — the symbol is reliable, the coordinate is ±10. When citing
in your own output, **quote the snippet as well as the line.**

⚠️ **State n.** 12 resolvable citations puts the drift rate between ~2% and ~45% — it establishes
*that* coordinates drift, not *how often*. And **read the claim before calling a citation wrong**: one
apparent overrun was a branch citation the verdict itself labelled as such.

⛔ **State the test's limits, or the clean negative is worthless.** It catches **invented coordinates
only** — a wrong-but-in-range citation passes it, and on a sweep of open PRs the branch-only files form
a large, *systematically* excluded slice rather than a random sample. **A soundness floor, not proof of
accuracy.**

⚠️ The first run of this same test reported **33** overruns. Twenty were basename collisions against
generic names. Tighten the match; if the number moves, it was a guess. (This is why the CLI owns the
basename map — do not rebuild it by hand.)

### 3.16 ⛔ For anything you file yourself, do a pass whose stated goal is to REFUTE it

Not re-read — **refute**. Measured: a self-verified High survived re-reading and lost a sentence to one
refutation pass. Its severity paragraph cited `<component>:203` as *"the options this code sends"* —
but `:203` is a **different operation's** options; the path under review sends a different version
constant at `:295`. One path's constant attributed to the other, and the suggested fix named version
constants **the file does not define**.

⛔ **After any downgrade or refutation, re-read the WHOLE description and search it for the old severity
word** — "High", "forever", "indefinitely", "permanently", and the refuted mechanism's key nouns. **A
comment does not correct a description**, and a fixer reads the description. Measured on three tickets
whose priority field and title were corrected while the body still argued the original severity and the
refuted mechanism. Keep useful original text behind a `<details>` marked refuted (op-15 `patchBody`).
This is the reason `passed` requires priority, title **and** body to carry the correction (§1).

⛔ **Always cite a repo-root-relative path, never a bare filename** — and when auditing, **flag bare
filenames as unverifiable rather than passing them.** A bare filename is invisible to a path
set-difference, and one measured here matched **two** files in the tree. ⚠️ Blank output from a line read
means a wrong path, not an empty line.

⛔ **A tally in a ticket is a claim — generate it, never transcribe it.** Paste the command and its
output; if it must read as prose, produce the prose in the same command block so the two cannot drift.
Measured twice in one run: an occurrence count that silently included test files (doubling a proposed
sweep), and an eight-item line list that was nine. **Both times the dropped item was the most useful
one** — it was dropped because it did not fit the sentence being written.

⛔ **Before finishing, set-difference every path you cited against the tree** — extract file-path-shaped
tokens from your own notes and compare with the tree at `origin/<base>`:

```
fleet check verify-paths --corpus audit/verdicts.tsv --ref origin/<base>
```

One command, and it catches the whole class. **Triage before reporting**: in a PR sweep most
non-resolving paths are legitimately PR-branch files, so the raw miss count is not an error count
(measured: 21 misses out of 148 cited, **1** a real defect).

⛔ **Never capitalise inside a path, and never abbreviate one with `...`.** Bold *around* the path, never
within it. Measured on a note whose own subject was "a plausible-looking wrong path silently costs a
fixer time" — which then gave `.../COMPONENTS/WIDGETS/...` for a lowercase directory.

⛔ **Search for every precedent you cite, on `origin/<base>`, before writing "already uses."** A symbol
on an unmerged PR branch is **a proposal, not a precedent** — name the PR and its state instead.
Measured twice in one corpus from a single phantom helper. **And when a PR touches the same file, read
its description for a rejected alternative before recommending one**: the same run recommended a
survivor-chain that the PR had explicitly refused for that page, with its reason written down.

⛔ **When you claim two instances differ — this one is worse, that one is fine — find the line that
makes the difference.** If it exists, the distinction is a fact and the ticket ends up better evidenced
than it started. **If you cannot find it, the distinction is a story**: drop the comparison, or drop the
ticket. Measured on a pair whose split turned out to be a literal `filter` predicate one file away — but
the ticket had asserted it without looking.

⛔ **A "why this exists" header comment is a testable claim about coverage.** Take the case it names and
walk it through every state the component can be in. Measured: a helper written to stop a card spinning
forever on a 404 still fails on that exact 404 for any user with cached data — **the author's blind spot
was documented in their own comment.**

⛔ **When a correction identifies a *systematic* error, re-derive every figure that shares the
mechanism** — every column, every row, and the prose quoting them — then search the document for the
old number. Measured: a table corrected once for test-file inflation kept the same inflation in its
neighbouring column, doubling the size of the follow-on sweep it proposed.

⛔ **"This needs a human decision" is a claim worth attacking.** Restate each side as the *requirement*
it defends and check whether one design satisfies all of them. Measured: a live-region "deadlock"
blocking ten tickets dissolved once the two positions were read as answers to different questions —
first-announcement reliability vs repeat-announcement delivery — which a single design satisfies.

⛔ **When a class list includes some members of an obvious family but not others, check the excluded
ones.** Either the list is short, or **the excluded members are the correct implementation you should
be prescribing** — measured on three sibling files that turned a design question into a copy.

⛔ **A sweep over open PRs has a shelf life — re-resolve the merge state of every open PR in
`worklist.tsv`, and run `fleet check blast-radius --since <snapshot-sha>`, at wrap-up and on every
revisit.** Measured: **five** reviewed-while-open PRs had merged, carrying **8 findings** whose tickets
still read *(open at time of review)* — they are now defects on `<base>`. ✅ It pays forward too: one of
them shipped a shared component whose header states a class ticket's diagnosis verbatim. **Search for a
precedent that has APPEARED, not only to prove one is absent.**

⛔ **Before using ancestry to decide anything, check the repo's merge style.** In a squash- or
rebase-merging repo a reviewed head is **never** an ancestor of `<base>`, so `merge-base --is-ancestor`
reads as "the PR changed after review" every single time. **Compare blobs instead** — the blob id of
`<reviewed-head>:<path>` (`git rev-parse <reviewed-head>:<path>`) against the same for
`origin/<base>:<path>`.

⛔ **A control must cover the failure direction you are NOT expecting.** Assert all three: a known-good
input is **not** flagged, a known-bad input **is** flagged, and a known-ambiguous input reports as
ambiguous. Measured: an escaping step that the shell reduced to a single character turned every pattern
into garbage, so an audit reported **every** citation in the corpus as a phantom — and the control in
place only proved the file list had loaded, not that the matcher worked. ⚠️ **When matching filenames,
build no regex at all** — index by basename and join; this is what `fleet check verify-citations` does,
so use it rather than a hand-built matcher.

⛔ **The first mention of a file in any note gets the full repo-root-relative path**; later mentions may
abbreviate. Measured: **80 basenames cited across one corpus are ambiguous** — `page.tsx` matches 134
files, `index.ts` 52, `lib.rs` 28. Obvious inside its own ticket, useless the moment the note is quoted
into a class ticket or an index.

⛔ **Every measurement that can return "nothing found" needs a control whose answer you already know,
in the same command** — print it first, labelled `CONTROL`. **Never discard a measurement's error
stream**: the `fatal:` you hide is the explanation. Measured twice in one session — an empty output
directory that read as a clean refutation, and `found in tree: 0` out of 1502 patterns caused by a
shell path-translation setting that left the search tool unable to open its own pattern file. **A zero
is the most dangerous result shape**, because a clean bill of health and a broken harness look
identical.

⛔ **When a claim can be executed, execute it — and when the artifact on disk contradicts the tool's
own log, suspect the harness before the claim.** Measured: a first probe left the output directory empty
while the tool printed a success line for the very artifact the directory lacked, which read as a clean
refutation of a **true** ticket. The isolated re-run produced 52 files including that artifact.
**Re-run isolated** — working directory outside the project, inputs copied out, binary by full path,
**exit code captured directly and never through a pipe** (a pipeline reports the **last** command's
status, not the one you care about — capture the status of the command itself).

⛔ **"There is a global error handler" is not "the user is told."** Follow it to a line that *renders*
something, and check what it excludes. Measured: the shared request helper's default error reporting
resolves to a console log plus an error-telemetry sink only, and its classifier skips **every 4xx** —
precisely the errors a well-built API returns. Cuts both ways: it does not refute a "silent failure"
finding, and it does not excuse an empty `.catch`.

⛔ **Read from the function signature down to the line you quote — never from the search hit.** A
search hit has no scope; the function does, and **everything between the signature and the hit is where
guards live.** Measured: a ticket filed against `<component>:127` that a pre-check at `:99-125` never
reaches, plus a null-guard on the helper beside it. **The bug was real, in a different file** — the
helper's doc comment named a second caller, and that one was unguarded. **When a helper's comment names
other callers, check each one: the unguarded caller is the bug.** ⚠️ A wrong `Where:` is worse than a
vague one — a fixer opens the file, finds the guard, and closes a real bug as fabricated.

⛔ **For any fix that renders an explanation to the user, name the field it reads and where that field
comes from.** If the answer is "the server knows", it is a protocol change, not a UI change — and any
claim that it is "small" or "purely additive" is wrong. Measured on a fix that would have shown *"you
muted these"* from a client that cannot see the muted item's source.

⛔ **Whenever a finding says "the only", "never", or "no way to" — enumerate the controls still on
screen and the lifecycle events still pending.** Retry buttons, reloads, unmounts, cache eviction,
visibility handlers. Measured three times in one run: a `setBusy(false)` two lines below the `catch`
that was quoted, a socket eviction six lines above the loop, and an effect cleanup that settles on
reload. **All three were in the same function as the code that was pasted** — when you are scanning for
an *absence*, a present control does not register. **Write the enumeration into the ticket even when it
is empty**; that is what shows a reader you looked.

⛔ **"This code path exists" is not "this code path is reachable."** For every conditional your finding
depends on, **name the caller that puts the program into that state.** Measured twice: a drop-on-CLOSED
branch that is real but unreachable (the factory evicts closed sockets first), and a stale-entry reuse
that cannot hit because the key embeds `Date.now()`. **A finding with the right outcome and the wrong
mechanism is more dangerous than a wrong finding** — it reads as verified, survives review, and wastes
the fixer's time exactly when they trusted you. ✅ Both survived re-derivation and came out *narrower and
more accurate*.

⛔ **A mechanism has as many halves as it has nouns.** *"A stale entry is reused under the same key"* is
**two** claims — *the entry survives* and *the key repeats* — and they live in different files. Measured:
the auditor verified the survival exactly and inherited the key-stability from the ticket's own title.
The key embeds `Date.now()`; **the headline outcome could not happen**, and the Medium became a Low.
**The half you inherit from the framing is the one that will be wrong**, because it is the half nobody
has re-derived.

✅ **Attack the reachability sentence and the constants specifically.** They carry the severity and get
the least scrutiny, because they are not the mechanism — and the mechanism is what verification checks.

✅ **A failed refutation improves the ticket.** Here it surfaced that options-version and
returned-struct-version are different values, which *is* the argument for the fix.

### 3.17 ⛔ Gate your OWN edits to the guidance — a remedy written in the same breath as the diagnosis

Having corrected an umbrella that prescribed `aria-busy`, the auditor replaced it with `aria-disabled`
— **unconditionally** — and was wrong twice over:

- One verdict shows `disabled={!valid}` is the **only** validity gate on its button (`onClick` calls
  the handler with no check; the only `if (valid)` sits on the form's `onSubmit`). Converting it
  **ships a bypass**.
- Another shows the cited precedent applies only where the control goes disabled **after** the press.
  A control **born** disabled never held focus, so it drops none and needs no change.

⚠️ **It was accepted on the two signals the same run had just written rules against:** four notes
*converged* on it, and it had *existing in-repo precedent*. **Writing a rule does not inoculate you
against the failure it names.**

✅ **Treat every edit you make to an umbrella, parent or work-list mirror as a ticket, and run the corpus
index against it.** One pass over data already on disk. The tell to watch for: a remedy invented while
you are indignant about the previous remedy gets the least scrutiny of anything you write.

### 3.18 ⛔ "Found independently by N reviews" is not corroboration when the reviews share a premise

An escalation rested on three reviews agreeing that a shared input primitive hard-codes `tabIndex={-1}`
**in the shared UI package**. That file has **zero** `tabIndex` occurrences; the real hard-code is one
instance in the app package, sitting **before** the `{...props}` spread, so it is already
caller-overridable. All three reviews named the wrong package and over-sized the fix — they shared a
correct prior (the underlying listbox library pins focus via an active-descendant pattern) and each
inferred the same plausible mechanism **without opening the file**, so the agreement measured the
prior, not the code.

⛔ **And note how the auditor first got this wrong:** searching only the package the claim named, got
zero, and concluded the symbol was fabricated. **A search scoped to the named path can only refute the
location.** To refute the claim, search the whole tree.

✅ Treat convergence as a reason to check the **symbol**, not a licence to skip it. Record file, line
and ref so the next reader can refute in one command rather than inherit the agreement.

### 3.19 ⛔ Exclude parents STRUCTURALLY, never by an ID list

An ID list encodes the parents you knew about when you wrote it. An umbrella issue filed later
carries the **same labels and the same priority as its own children** — no label or priority filter
can separate it — and walks straight into the frame. One did, and was judged as a finding.

The op-16 rows already carry `parentId`, so this costs nothing: `fleet check frame derive` queries the
group with `parentIsNull: true`, treats a top-level row **with children** (op-1 `resolveChildren`
non-empty) as a parent and drops it, and treats a top-level row **without children** as an
uncategorised finding — kept in the frame **and** reported as a gap (§3.6). Never hand it a list of
parent ids.

✅ **Diagnostic:** `judged` minus `frame` should contain **only** rows whose state type is `cancelled`
(cancelled or duplicate-closed). A single live open row in that difference *is* the bug.

### 3.20 The fix axis — its own enum, scored on every finding

#### ⚠️ The fix axis is PROSE — a keyword count over it is a floor, not a rate

Searching the fix column for "fails / breaks / damages" scored one band **27/69**; reading the same 69
gave **~45/69** — a **~40% undercount**. Analysts write *what* the fix does wrong, not *that* it is
wrong: "needs a companion change", "does not transfer", "one-quarter of the job", "is a no-op". The
strongest findings had the least alarmed phrasing.

✅ Give the fix axis its **own enum field** in the batch output spec — that is the `fixAxis` column of
`audit/verdicts.tsv` — or read it. Never publish a keyword count over it as a rate. Validate the column:

```
fleet check enum check audit/verdicts.tsv --col 5 --domain verified,defective,no_op,absent,untested
```

#### ⛔ Score the PRESCRIBED FIX as its own axis — the verdict split will not tell you about it

The four verdicts grade whether the **diagnosis** is right. They say nothing about whether the
**prescription** works. Measured across three bands on one corpus, the two axes moved in **opposite
directions**:

| | High & Urgent (133) | Medium (158) | Low (69) |
|---|---|---|---|
| `confirmed` — diagnosis exactly right | 7% | 22% | **33%** |
| `false_positive` | 0% | 3% | **1%** |
| **prescribed fix defective** | — | 22 counted *incidentally* | **~2 in 3** |

**Low was the most accurate band by verdict and the worst by fix.** As severity drops the diagnosis
gets simpler and more often correct, while the prescription gets more casual — because a Low feels like
it does not warrant checking the remedy. A gate calibrated on the verdict column skips exactly the band
where the fixes are most dangerous.

**What that band's fixes actually did:** destroyed a row the parser should have kept; weakened a stored
value's type on a round-trip; re-introduced the loss the PR was fixing; removed the confirmation from an
irreversible action; and left a crashed surface over a correct navigation.

**So:**

1. **Brief every batch with "test the fix on every single one."** Without that instruction, defective
   fixes surface only *incidentally* — one pass counted 22 in 158 that way, another briefed for it and
   found ~45 in 69. **An incidental count is a floor, not a rate.** A row whose `fixAxis` is `untested`
   is not passed and does not gate the corpus (§1).
2. **Calibrate on the fix axis.** Before extending or skipping a band, draw a **machine-spaced** sample
   (every k-th row over the sorted work-list — never hand-picked), and **write the decision rule down
   before you look at the result.** A workable one: *">= 2 damaging/no-op fixes OR >= 1 false
   positive -> run the full band."*
3. **Report it as its own number.** "N findings gated, M with a defective prescribed fix" — because M is
   the figure that predicts damage, and N is the one that predicts nothing.

⛔ **And correct the ticket where it is read.** A gate comment does not protect a fixer who reads only
the description — and in a pipeline where work-orders are generated *from* descriptions (a `/fleet`
session works the ticket body), the harmful instruction is the thing that gets executed. Patch the
`⛔ DO NOT …` warning into the **description body**, immediately after the bad prescription (op-15
`patchBody`; `fleet check gate apply` queues it for every `defective|no_op` row and refuses `passed`
until it is there). The comment records *why*; the description is what runs.

### 3.21 ⛔ Quote the ticket, don't paraphrase it

When briefing an agent about an existing finding, **quote the ticket's own claim verbatim** and say
that the quote is the claim under test. A compressed paraphrase drops the qualifier that made the
claim survivable — and the qualifier is usually exactly what a reviewer would attack.

Measured: a brief compressed *"nothing requests the strict mode of setting X"* into *"setting X is
absent"*. The verifier correctly identified **the paraphrase** as the overstatement, since the platform
applies a default mode of X on its own. The ticket was right; the summary was not. Hand an agent a
strawman and you get back a refutation of something nobody filed. Gate-2 briefs therefore carry the
op-2 `getIssue` description text itself, never a summary of it.

### 3.22 ⛔ Two passes, opposite yields — measured

Run **both passes**. They catch different errors, and the numbers are not close.

| pass | escalates | measured on 466 findings |
|---|---|---|
| **doubt-driven** | whatever gate 1 flagged | 44 flags, **39 overturned (89%)** |
| **consequence-driven** | every `Urgent` + every High carrying `checker.securityLabel`, regardless of verdict | **149 checked, 0 false positives** — but only **12 accurate as written (8%)** |

A flagged finding is one an agent already doubted, so its base rate of being wrong is high — that
gate stops you deleting true findings. A high-severity `real` finding is one **nobody** doubted, so
its errors are not falsity at all. They are **scope, trigger choice, and prescribed remedy** — none
of which a false-positive hunt looks for.

⛔ **The dominant failure on a security corpus is a correct finding with a fix that does not work.**
Roughly a third of the 106. One "obvious" remedy introduced a new hole of the same class it was
closing. One failed open to the exact state it was fixing. One did not exist in the library at all. A
ticket closed against a broken remedy is worse than an open ticket: the hole stays and the tracker says
it is gone. **So test the ticket's prescribed fix, not only its claim.**

⛔ **Never downgrade on the headline alone.** Every `overstated` ticket in this pass hid a *stronger*
trigger behind its weak one — nearly without exception across **29 `overstated` verdicts**. A threat
claim collapsed while the same dialog was unusable for **every** user on a small viewport; an escalation
claim collapsed while the same action still wrote data it should not; a "purge the artifacts" claim
collapsed while the CI step had moved to run unconditionally, making every *future* run leak. Ask what
the reporter actually saw and mis-described, then re-file that.

⛔ **Expect the reach to be understated.** **72 of 106** named fewer call sites than exist — 3 where ~20
were live, one already shipped at a second site the ticket never mentioned, one whose "restore"
trigger was the weak one when *any ordinary save* reproduced it.

### 3.23 ⛔ Run the bypass, measure the bound

Sanitiser and layout claims are **empirical**, and prose about them is unfalsifiable in both
directions — which is how a finder and a checker can agree and both be wrong.

- **For a sanitiser:** execute the bypass strings, and execute them **against the proposed fix too**.
  One ticket's remedy — a substring check — was defeated by an encoded form the parser normalises away
  before the check ever runs.
- **For an overflow/height claim:** measure the bound. One "attacker controls the height" claim died
  on the measurement — the field reached its maximum length but admits no break opportunities, so it
  overflows horizontally and adds no height.

Run probes on a neutral origin (§3.3), never the live product, and clean up after them.

## 4. Acting on the result

### 4.1 `audit/verdicts.tsv`

One row per finding per audit run, tab-separated, header row first. Workers append to a private
per-slice file; the orchestrator merges them into `audit/verdicts.tsv` (single writer) and validates
every enum column before anything is applied:

```
fid	key	diagnosis	severity	fixAxis	gate	auditRunId	evidence
<fid>	ABC-1234	real	confirmed	verified	passed	<auditRunId>	<component>:118 guard absent; fix tested on branch, works
<fid>	ABC-1235	real	overstated	verified	passed	<auditRunId>	priority 2→3 applied; title + body patched; residue → ABC-1301
<fid>	ABC-1236	real	confirmed	defective	pending	<auditRunId>	diagnosis holds; the prescribed fix is a no-op at the second call site — ⛔ DO NOT block queued
<fid>	ABC-1237	false_positive	n/a	absent	failed	<auditRunId>	<component>:44 already guards this; both gates agree — comment posted, then cancel
```

```
fleet check enum check audit/verdicts.tsv --col 3 --domain real,false_positive,already_fixed,uncertain
fleet check enum check audit/verdicts.tsv --col 4 --domain confirmed,understated,overstated,n/a
fleet check enum check audit/verdicts.tsv --col 5 --domain verified,defective,no_op,absent,untested
fleet check enum check audit/verdicts.tsv --col 6 --domain pending,passed,failed,uncertain,disputed,waived
```

(The third row is why `passed` is derived and never asserted: the diagnosis is right, so a verdict
column alone would pass it — but a `defective` fix cannot be `passed` until the body carries the
`⛔ DO NOT …` block, so the row stays `pending` and `gate apply` reports it rather than "fixing it up".
The fourth is the shape that gets cancelled — `failed`, i.e. `false_positive` **or** `already_fixed`,
after both gates, evidence first; the two are reported in separate columns, §4.2.)

The `evidence` column is the record of why a filed bug was changed or deleted: it must name what the
code actually does, cite a repo-root-relative `path:line` plus the quoted snippet (§3.15), and stand
on its own — a reader who never saw the corpus must be able to check it.

### 4.2 `fleet check gate apply --verdicts audit/verdicts.tsv`

The CLI reads the verdicts, enforces the decision rule (§1), and **enqueues** outbox entries — it never
touches the tracker itself; the launcher drains the outbox by executing the adapter's `Call:` lines.
Per row, in this order:

1. **Every row** — op-14 `updateIssue(key, {labels: {add: [<checker.gate.labels[gate]>], remove:
   [<checker.gate.labels.pending>]}})`, then op-15 `patchBody(key, [{find: "**Gate:** …", replace:
   "**Gate:** <gate> — <auditRunId> — <one-line evidence>"}])`. The label is for the queue selector
   (`fleet.queue.requireGate`); the body line is for the human and the next `/fleet` session, which
   reads the body. Gate labels were ensured at `fleet check plan` (op-18, launcher-only); `gate apply`
   never invents a label.
2. **`severity ∈ {understated, overstated}`** — op-14 `updateIssue(key, {priority, title})` and op-15
   `patchBody` for the body's `**Priority:**` line and severity prose (with the old argument kept
   behind a `<details>` marked refuted). `passed` is granted only once these are applied — priority,
   title **and** body (§3.16).
3. **`fixAxis ∈ {defective, no_op}`** — op-15 `patchBody` inserting the `⛔ DO NOT …` block **right
   after the prescription**, with the comment (op-11) recording why. Not `passed` until it lands
   (§3.20).
4. **`gate = failed`** — op-11 `comment(key, evidence)` **FIRST**, then op-9 `cancel(key, reason)`,
   which the adapter maps to `states.cancelled`. Cancel only the findings that failed **both** gates.
   The comment must name what the code actually does and stand on its own, because it is the record
   of why a filed bug was deleted. The adapter maps exactly one tracker state to `states.cancelled`;
   a tracker may offer several closed states — never pick one by hand.
5. **`gate ∈ {uncertain, disputed}`** — op-10 `leaveOpen(key)` (the explicit non-action) plus, for
   `disputed`, op-11 comments carrying **both** gates' evidence. These rows are reported in their own
   columns and never promoted by the audit — only by the operator's explicit `--waive` (§8).
6. **`gate = waived`** — never written by `gate apply`; a row carrying it is rejected (§8).

`fleet check gate status` prints the per-status counts with their provenance (rows in
`audit/verdicts.tsv` against the derived frame), and the outbox entries still undrained. **Report
`already_fixed` and re-attribution candidates separately from confirmed-bogus.** They are different
outcomes and lumping them together overstates the sweep's error rate: an `already_fixed` row is
cancelled with the fixing change named in its evidence, and counted in its own column; a
re-attribution (right defect, wrong `Where:`) is a body patch, not a cancel.

## 5. Duplicate detection — a separate pass, with the calibration inverted

Run it after the false-positive gates, reusing the same slice outputs. **Invert the default:** in the
false-positive audit `real` is the default because deleting a true bug is the costly error; here
`distinct` is the default for the same reason — a wrong merge silently deletes a tracked bug, which is
worse than a duplicate sitting in the backlog. Agents emit rows only for `duplicate` or `subset`; a
cluster yielding nothing is a normal result. Then run the same adversarial gate, tasked with proving
each pair should stay **split**. Measured on one sweep: 31 candidate pairs → **20 merged, 11 split**.
Every one of those 11 would have deleted a real tracked bug.

⛔ **Never dedup by title similarity.** True pairs routinely have completely different titles, and
unrelated findings on one big `page.tsx` often have similar ones. Compare the **mechanism** — same
function, same missing guard, same line.

⛔ **"Filed here because it shares the fix" is a hypothesis, not a verdict.** It is the single most
common duplicate marker *and* a common false one. One composite folded in three siblings; the gate
split all three, because the fixes landed in three different apps. **Cross-app pairs almost never
merge** — check that both fixes touch the same file before accepting one.

⛔ **Path clustering alone is not sufficient.** Grouping by the file each finding names misses the
commonest shape entirely: a composite plus the component it folds in record *different* primary
paths and can never co-cluster. 11 of 17 known pairs were invisible to it. Reconcile against every
other duplicate signal you have and judge the leftovers directly — and remember that "my clustering
did not emit this pair" and "an agent judged it distinct" look identical in the output and mean
opposite things.

Act only on verified merges: op-11 `comment(key, <shared-fix evidence>)` **first**, then op-24
`markDuplicate(key, ofKey, evidence)` — the relation moves the issue to its duplicate state on its own.
Setting a duplicate state first fails on trackers that derive it from the relation; the relation must
land first. The evidence comment is mandatory, the relation is the bonus.

### ⛔ The dangerous pairs are not duplicates — they are partial overlaps with no vocabulary

118 candidate pairs across three signals produced **zero** duplicates but three shapes that
`duplicate / subset / distinct` cannot express. Each is a `distinct` verdict that still needs an
action, and dropping it silently loses real information:

| shape | example | why it matters |
|---|---|---|
| **partial location overlap** | two tickets both claim one line, each also owning sites the other does not | the fix is per-call-site, so closing one leaves the other's sites unfixed |
| **sequential, not shared** | ticket B exists *because* the PR that fixes ticket A introduces it | merging deletes A's underlying bug if that PR is re-scoped or abandoned |
| **same class, N disjoint sites** | one bug class, four separate call sites, no composite | neither ticket covers the other's sites |

**Rule:** when a pair is `distinct` but the two tickets name a **shared line** or a **causal link**,
op-25 `relate(keyA, keyB, "related", <note>)` on **both**, the note saying who owns which sites — then
leave them open. Ask agents to report this as a `related-overlap` note alongside their verdict; it is
not a merge, but it is the difference between a coordinated fix and a half-closed one.

## 6. Structural dedup — `fleet check dups cluster`

### ⛔ Also dedup STRUCTURALLY — the root-fix pairs share a file, not a vocabulary

Textual similarity finds re-filings of the same observation. It systematically misses the more
valuable case: **two findings with one root cause, written by different reviewers who each saw a
different arm of it.**

Measured. Ticket A and ticket B turned out to be the **then- and else-branches of a single `if`** in
one script — `<component>:102-105` and `:117-119`. One root fix closes both; fixing either alone leaves
the other open. A dedicated duplicate-detection pass had already run over that corpus and **did not
surface the pair at all**, because they share a file and almost no words: one describes the
condition-true arm in its own vocabulary, the other the condition-false arm in its own. Different
mechanism words, different harm words. **The two branches of an `if` describe opposite conditions by
construction** — low textual similarity is the expected signal, not a counter-indication.

**So run a second, structural pass:** group every finding by **file**, sort by **line number**, and
read each pair whose ranges sit within ~30 lines of one another *however differently they read*.
`fleet check dups cluster` does the grouping and windowing from the `where` entries in `findings.jsonl`
and writes the clusters under `audit/`; a worker reads each cluster. The question is not "do these say
the same thing?" but **"is one of these the other's `else`?"** Adjacency inside one control-flow
construct is a stronger root-fix signal than any amount of shared vocabulary.

⚖️ The same sweep produced the exact inverse, which is why you need both passes and neither alone:
one ticket's three *"shares the fix with…"* claims were **all false** — those siblings lived in
different apps and shared no fix at all. **Textual similarity over-groups across files and
under-groups within one file.**

When a structural pair is confirmed, prefer **op-25 `relate` plus an explicit "one root fix closes
both" note on each** over op-23 `setParent`, whenever the two carry different severities or different
threat models — nesting an Urgent under a High buries it, and the sequencing information is what the
fixer actually needs.

## 7. Completeness — two cheap checks, and what a zero result buys you

Path clustering is the high-yield signal, but it has a known blind spot (§5), so close it with two
checks that cost ~2 agents each. Measured on one sweep, both returned **zero** new duplicates from 118
pairs (43 sampled, then run to exhaustion) — which is the point: a zero here is what lets you say the
pass was complete rather than merely large.

1. **Shared identifier across different files.** Extract identifiers from each finding's `**Where:**`
   line and pair up findings sharing one. ⛔ Filter hard or it is all noise: require a
   lowercase→UPPERCASE transition and drop DOM event-handler names (`onClick`, `onChange`, …).
   Unfiltered this produced 53 pairs of which most were `native` / `packaging` / `dashboard`; filtered,
   23 real ones — and still 0 duplicates, including a pure cross-app collision (a component prop named
   `onRemoved` vs a platform event listener of the same name).

2. **Explicit issue-key cross-references in the descriptions** (the adapter's `issueKey.pattern`).
   Harvest them with read-only workers (op-2 `getIssue` only), recording the relationship word, into
   `xref.tsv` in the sweep dir. Ignore keys from earlier sweeps and the sweep's own work-list mirror /
   umbrella / category parents.

   ⛔ **A cross-reference usually argues AGAINST a merge.** "Sibling: ABC-1xxx" means the filer split
   the PR's findings deliberately and cross-linked them — 8 of 8 sampled siblings were exactly that.
   So sample the `sibling`/`related` bulk rather than judging all of it, and spend the real effort on
   `same` / `shares-fix`.

⛔ **And do not trust `shares-fix` either — it is the least reliable strong signal in the corpus.**
0 for 4 here, 0 for 3 on an earlier composite. Verify the second site actually *calls* the shared
thing: one ticket claimed a shared-primitive fix covered a dialog that inlines the primitive with its
className hand-copied, so the fix could never reach it. When a claim is wrong, **comment the
correction on the ticket** (op-11) — left alone that sentence makes someone close a second issue that
was never fixed.

### Free duplicate detection — `dups.tsv` is a floor

Ask each slice agent to also append `<keyA>	<keyB>	<shared path:symbol>` to the sweep's `dups.tsv`
when two of *its own* findings are the same defect. One audit surfaced **17 pairs** this way. Treat
that as a **floor, not a count** — an agent only sees its own slice, so a complete pass needs a global
sweep over the `path:symbol` in every `**Where:**` line (`fleet check dups cluster`, §6).
⛔ Never dedup by title similarity; these pairs have entirely different titles.

## 8. Promotion

- **Nothing leaves triage without a gate.** `/fleet` intake refuses any checker-filed ticket that does
  not carry `gate:passed` or `gate:waived` (`fleet.queue.requireGate: true`); refusals are counted in
  `fleet status` and written to `intake-refused.jsonl`, never silent.
- **`checker.autoPromote: never`** (default) — the audit ends with `audit/verdicts.tsv`, the applied
  gate labels and a report. The operator promotes `gate:passed` tickets in the tracker UI or runs
  `fleet check promote <sweepId> [--all | --fid … | --min-priority N]`, which moves each selected
  `passed` row from triage to ready via op-14 `updateIssue` (`checker.ready.state` / `checker.ready.label`,
  removing `checker.triage.label`). Only `passed` rows are eligible; `--min-priority` narrows by the
  *corrected* priority.
- **`checker.autoPromote: after-audit`** — `fleet check finish` chains sweep → audit → promote
  survivors itself, using the same command. There is no streaming path: promotion is a corpus-level
  decision because the gate is (§0).
- **`gate:waived` is human-only.** `fleet check promote --waive` is the operator's explicit act on a
  ticket the audit left `uncertain` or `disputed`; the audit never writes `waived`, `gate apply` rejects a
  row carrying it, and a worker brief that mentions it is wrong.
- **The prescribed fix stays a hypothesis downstream.** A `/fleet` session working a promoted ticket
  treats the prescription as a hypothesis; if it refutes it, it op-15 patches a `⛔` note into the
  description — where the next reader acts — not only a comment, and its done flag says
  `--prescription refuted --body-patched`. That is the same rule as §3.20, applied one stage later.
- **Tracker-less mode.** Rows carry `localId`; `audit/verdicts.tsv` is the gate, and
  `fleet check promote` flips each `passed` row's `state` in `findings.jsonl`; `fleet check mark
  <localId> done` reflects a session's done flag back. Nothing here changes except that there are no
  ops to queue.

**Report** from `audit/verdicts.tsv` and `fleet check gate status`, never from memory: per status the
count **with its denominator and provenance in the same sentence** (§3.6); `already_fixed` and
re-attribution in their own columns (§4.2); "N gated, M with a defective prescribed fix" (§3.20); the
dedup outcomes as merged / related-overlap / split; the frame check result (`fleet check frame check`
empty, or the rows it printed); the citation and path checks with their limits stated (§3.15); and
every ticket the audit filed itself, listed so the operator can see they were re-gated.
