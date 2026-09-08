# Field notes

Long-form method notes distilled from the private runs that produced `claude-fleet`. Every entry is
a mistake that actually happened, the check that lied, the check that worked, and the durable rule
that came out of it. The playbooks are the canon; this file is where a rule proves it earned its
place before it is promoted into one. When a note is promoted, leave it here marked `→ promoted`.

Append-only. Newest entries at the bottom of their theme. Never rewrite an entry; correct it by
appending a new one that cites it. Title from the SYMPTOM, not the cause — the future reader
searches for what they can see.

**The editorial test:** *would this let a session three weeks from now, with no memory of today,
skip the diagnosis entirely?* If an entry does not pass that test, it is a diary line, not a field
note. The *diagnostic path* — which check lied, which one worked — is the part worth keeping, and it
only survives if it is captured while it is fresh: the launcher appends here the turn something
blocks, surprises, or is diagnosed, never at the end of a run when the detail is already gone.

**Redaction rule (contract §8 rule 7, verbatim):** Field notes: `### !! <symptom>` → **Saw** / a
cause / **Rule** (optional **Proof / Diagnostic / Also**). `**Saw:**` and `**Rule:**` are literal — a
reader scanning 100 notes for "what is the rule?" must always find it. The cause between them may
carry a descriptive label when that reads better than the bare word (`**It is an artifact of the
workflow.**`), but it must be there. A `Saw:` lets a stranger reproduce the *method* failure, never
locate a *product* defect. Vulnerability-shaped entries keep only the Rule and a fully synthetic Saw
with **no residual mechanism**.

No file paths, no issue keys, no product mechanism from any source repository. Paths are written as
`<component>:<line>` or under the synthetic tree `example/…`; keys as ticket A/B or `ABC-1xx`;
products, people and internal names never appear. A Saw must let a stranger reproduce the METHOD
failure, never locate a PRODUCT defect.

Vocabulary: **the operator** is the human running the fleet; **the launcher** is the `/fleet` or
`/fleet-check` session; **a session** is a spawned working/testing/checker agent; **a worker** is a
subagent or cloud sandbox inside `/fleet-check`. Tracker operations are named `op-1`..`op-27` as in
the contract; the tracker itself is only ever "the tracker".

---

## Measurement & denominators

### !! `wc -l` reports 108 for a 109-row file
**Saw:** `wc -l < worklist.tsv` printed `108` for a file independently confirmed to hold 109 rows.
**Cause:** `wc -l` counts NEWLINES, not lines. The file was written by joining rows with `"\n"`, so
the final row carries no trailing newline and is not counted. Silently off by exactly one.
**Rule:** Count **non-empty lines, never newlines**, whenever a file may have been written without a
trailing newline — `grep -c .` on POSIX, `(Get-Content f | Where-Object {$_ -ne ''}).Count` in
PowerShell, never `wc -l`. Always write generated data files with an explicit trailing newline
(`fleet check worklist write --items-json` does). A worklist that is silently one row short
produces a sweep that is silently one PR short — and every downstream count reconciles perfectly, so
nothing ever flags it.
**Proof:** `grep -c . worklist.tsv` → the true count; `wc -l` on the un-terminated source → one less.

### !! A High-severity finding was invisible to the "remaining Highs" scan
**Saw:** Reconciling what was left to file, a scan of `priority in ('High','Urgent')` reported the
High queue as clear. It was not: one slice had emitted `"priority": "high"` — lowercase — for a
finding the operator later rated among the sweep's most serious. Five findings across one slice used
lowercase; every other slice used the capitalised form from the brief's schema example.
**Cause:** The worker brief gives the enum inside a JSON example but never says the value is
case-sensitive, and nothing validates it on write. One worker in nineteen normalised it to lowercase.
The orchestrator's exact-match filter then silently skipped those rows — no error, just a smaller
number.
**Rule:** **Normalise every enum coming back from a subagent before counting or filtering on it**, and
assert the domain afterwards. Never filter on a free-text field a model produced without case-folding
first. Same for the a11y class (`screen_reader` vs `screen-reader`) and any status string. That is
what `fleet check enum check <tsv> --col N --domain …` is for — run it on every worker output before
the first filter.
**Diagnostic:** print the *value distribution* of every enum you filter on, not just the counts of the
values you expected — a distribution shows `{'high': 1}` sitting next to `{'High': 36}` immediately,
whereas "unfiled Highs: 0" looks like success.
**Also:** every miscount of this family in the source runs was a counting bug in the orchestrator,
never in the findings. Distrust your own aggregations first.

### !! A gate reported "22 of 22 done" while the label it gates on returned 58
**Saw:** After a gate over "every security-labelled High" was declared complete, the defining query
was finally run: op-16 `findIssues({labels:[securityLabel]})` with `complete: true` → **58 High + 5
Urgent**. The gate's own frozen input file was **22 rows**. Set-differencing left **21 live
security-labelled High/Urgent findings never gated, two of them Urgent** — and not one of the 21
appeared in the input file, so this was not a gate that ran and skipped them; they were never in the
work-list.
**Cause:** The 22-row list was hand-assembled and then *described* — in the report — as "every
security-labelled High". The defining label query was never actually run to build it. How the 22 were
chosen could not be reconstructed afterwards.
**The false reading that made it invisible:** every downstream number inherited the wrong denominator
and still looked healthy. "22 gated, 2 confirmed / 16 understated / 4 overstated, 0 false positives"
is a *complete-sounding* result. A gate never reports the findings it was never handed — it reports
100% of its input, always. **Completeness is not observable from inside the gate.**
**Rule:** ⛔ **A gate's work-list must be MACHINE-DERIVED from the attribute that defines the gate, and
the derivation must be re-runnable.** Save the query, not just its output (`fleet check frame derive`
writes both). Then, before reporting any gate result, re-run it (`fleet check frame check`) and assert
`gated == derived`; state the denominator and where it came from in the same sentence as the verdict
tally — "N of M, M from op-16 `findIssues({labels:[X]})`" — never a bare N.
**Diagnostic:** a hand-built work-list has a suspiciously round or small size, and no command that
reproduces it. If you cannot re-derive the list, you do not know what you covered.
**Also — the counter-example matters for calibration:** the same corpus's a11y invariants, checked
flat the same way, came back perfect — every a11y-labelled issue at the forced priority, zero
unassigned. So this is not "tree-scoped reasoning is always wrong". It is specifically the **gate
input** that must be derived, because a gate is the one artifact whose output cannot reveal its own
gaps.

### !! The corpus's two most severe findings sat in a category nobody had assigned a parent
**Saw:** After gating the high-severity findings by walking the category parents, a flat query for
`priority: 1` returned three Urgents nobody had gated — and two of them had no parent at all. Pulling
the full flat list showed the real size: **41 findings with no parent, 21 of them High** — an entire
body of work that had been assigned to other people and so never entered the categorisation pass.
**Cause:** Two compounding gaps. (1) The categorisation pass covered "all issues assigned to the
current user" — these were assigned elsewhere, so they were never in the set. (2) Every gate
enumerated findings by **traversing the category parents**, so anything outside the tree could not be
reached. An uncategorised issue is invisible to a tree walk, and nothing reports the gap.
**Rule:** ⛔ **Never enumerate a gate's input by walking a category tree.** Query the flat corpus by
the attribute that actually defines the gate — `priority`, or the label — across the whole scope,
then reconcile against the tree and treat any difference as a finding in itself. Concretely: op-16
`findIssues({priority: 1})` before and after any categorisation, and assert the counts match what the
parents hold.
**Also:** the categorisation was scoped by **assignee** while the gate was scoped by **severity**.
Whenever two passes over the same corpus use different scoping keys, the difference between them is
exactly the set nobody looks at. Reconcile the keys explicitly, or expect a hole.

### !! My own coverage check counted a CROSS-REFERENCE as coverage, and inflated the "gated" set
**Saw:** `gated == derived` was verified by extracting issue keys from the gate output files with a
regex over the **whole file**, then set-differencing against the derived work-list. It reported full
coverage. A later join written for a different purpose used a **field-1** match and disagreed:
the loose regex produced 53 "covered" keys where field-1 extraction produced the true per-row set,
and exactly one live High had no verdict row at all. It looked covered only because a sibling's
verdict text mentioned it as a cross-reference.
**Cause:** gate output rows are `KEY <TAB> verdict <TAB> severity <TAB> evidence…`, and the evidence
column is prose that routinely **cites sibling keys**. A whole-file grep cannot distinguish "this row
judges X" from "this row mentions X". Every good verdict that cross-references a sibling silently marks
that sibling as covered.
**The false reading, and why it was so comfortable:** the check *confirmed what the checker wanted* —
the rule about deriving work-lists had just been written, and the assertion passed. A verification
that agrees with you gets less scrutiny than one that does not.
**Rule:** ⛔ **Extract identifiers from a structured file by FIELD INDEX, never by a pattern over the
whole line or file** — split each row on the tab and match the key pattern against column 1 alone,
not a key-shaped grep over the row (`fleet check enum check <tsv> --col N --domain …` reads a named
column exactly this way). The evidence column exists precisely to reference other findings, so a
loose match over it is guaranteed to over-count. And **assert the row count equals the distinct-key
count** — that one check would have caught this immediately.
**Also:** a coverage check is itself a gate, and inherits every property written down about gates —
including that it reports 100% of whatever it was handed and cannot observe its own gaps.
**Cross-check a coverage number with a second, independently-written query before believing it.**

### !! Re-deriving the work-list AFTER applying verdicts reported 42 misses; the real number was 1
**Saw:** op-16 `findIssues({priority: 3})` returned 121 live Mediums. Subtracting everything in the
Medium gate's input and output files left **42 apparently ungated findings** — a coverage hole big
enough to invalidate the pass.
**Cause:** two independent mutations of the frame, in opposite directions. (a) Every `overstated`
verdict already applied moved its finding 3 → 4, so the query no longer returned findings that had
been gated — the denominator shrinks as you work. (b) The **earlier High/Urgent pass downgraded 26
findings High → Medium**, so they are live Mediums that were already judged, under a different pass's
output file. Subtracting every pass's verdicts took 42 down to **1**.
**Rule:** a gate's coverage check is `frame = current-severity-query UNION everything-already-judged`,
and the judged set spans **every pass**, not just this one. Never reconcile a severity-scoped frame
against a single pass's outputs, and never re-derive the frame from a mutable field you are actively
writing to without unioning in what you already wrote. `fleet check frame check` unions every verdict
file under `audit/` for exactly this reason.

### !! The coverage assertion passed, and three of my own High/Medium findings had still never been gated
**Saw:** the reconciliation reported 1 true miss, it was closed, and the ledger said complete. Later,
while verifying an artifact claim that "11 of 11 findings this audit filed were put back through the
gate", the actual verdict files showed three of them — one High — had no verdict row in either pass.
11 of 14, not 11 of 11.
**Cause:** **a gate that files new findings extends its own denominator.** Every frame derived was
correct at the moment it was derived and stale the moment the next issue was filed. The High was
filed *after* the High/Urgent frame was derived, so that frame never contained it; and it is not
Medium, so the later Medium-frame assertion could not see it either. It fell between two frames, each
individually sound.
**Rule:** **re-derive the frame AFTER filing stops, not after judging stops** — and derive it across
every severity the gate covers, not just the band you are currently working. Concretely: make the last
step of the run op-16 over the whole scope filtered to the gate's severity range, minus everything
with a verdict row in ANY pass's output. Treat your own newly-filed findings as first-class members of
the denominator; they are the ones nobody else will ever check.
**Also:** the thing that caught it was refusing to publish an unverified number. "11 of 11" was only
checked because it was going to be read by someone. **Verify round numbers about your own coverage —
they are the ones you are least likely to have counted.**

### !! The parent-exclusion list was an ID list, so an umbrella filed later walked straight into the frame
**Saw:** the a11y work-list excluded the ten category parents by key and judged one further issue as
if it were a finding. That issue was an umbrella carrying both a11y labels and the forced priority —
**label-for-label and priority-for-priority identical to its own children.** No filter keyed on
labels or priority could have caught it.
**Cause:** the exclusion encoded *the parents known about when the list was written*, not *what a
parent is*. An ID list is a snapshot; the frame kept moving.
**Rule:** exclude parents structurally — `parentIsNull` within the frame (op-16 exposes it) — never by
key. The rows already carry `parentId`, so this costs nothing and is immune to umbrellas filed after
the list was written.
**Diagnostic:** `judged` minus `frame` should be non-empty only for cancelled/duplicate rows. Here it
came back 7 cancelled + 7 duplicate + **1 open** — and that single open row was the whole bug.

### !! I told the operator to stop gating on evidence from a sample that was SELECTED, not drawn
**Saw:** After gating 119 High/Urgent findings the gate was extended to 14 Medium/Low ones, and the
verdict split "inverts at low severity" was reported — with a recommendation **not** to gate the
remaining ~155 Mediums, calling the expected yield low. That recommendation went to the operator and
into a tracker comment.
**The flaw:** those 14 were not a sample. They were **every Medium/Low finding that happened to have a
fix-spec written for it** — the ones someone had already judged worth specifying — and 13 of the 14
were a single category. A set selected for quality and concentrated in one defect family was
generalised to a population spanning ten.
**What an actual random sample showed:** stratified across all categories, 16 judged, briefed WITHOUT
the prior distribution: 19% confirmed, 31% understated, **50% overstated**, 0 false positives.
**13 of 16 (81%) needed a correction.** The "low yield" claim was simply false. The yield is high; what
inverts is the **direction**.
**Cause:** "the sample I happen to have" was treated as "a sample". The 14 were convenient — already
in front of the gate because they had just been judged for a different reason. Nothing about how they
were assembled made them representative, and nobody asked.
**Rule:** ⛔ **Before generalising from a set, state HOW IT WAS ASSEMBLED in one sentence.** If that
sentence contains "the ones that happened to…" or "everything with a…", it is a **selected set, not a
sample**, and it can only support a claim about that selection. Drawing a real sample is cheap — 19
findings against a corpus of 466 — and it is the difference between a recommendation and a guess.
**Also:** the corrected conclusion is more useful than the one being defended: gating **Highs** finds
work that is **under-scoped** (you would fix too little); gating **Mediums** finds work that is
**over-scoped** (you would spend too much on it). Both are worth doing, for opposite reasons.

### !! The band that looked healthiest by verdict had the WORST fixes — I nearly skipped it on that evidence
**Saw:** after gating High/Urgent and Medium, the Low band's verdict split came back 33% confirmed,
51% overstated, 14% understated, 1% false positive — the *most often exactly right* of the three
bands. By the same reasoning that had (wrongly) skipped the Mediums earlier that day, skipping Low was
the obvious call. **A 9-finding calibration draw then returned 0 false positives and 7 of 9 with a
damaging, impossible or no-op prescribed fix.** The full pass found ~45 defective fixes in 69 findings
— the worst rate of any band.
**Cause:** **verdict accuracy and fix quality are INDEPENDENT axes, and only the first was being
measured.** The verdicts grade whether the *diagnosis* is right. They say nothing about whether the
*prescription* works. As severity drops the diagnosis gets simpler and more often correct — while the
prescription gets more casual, because a Low feels like it doesn't warrant checking the fix. The two
move in **opposite** directions.
**Rule:** **never calibrate a gate on the verdict split alone.** Score the prescribed fix as its own
column, and set the go/no-go threshold on THAT. Concretely, before extending or skipping a band: draw
a machine-spaced sample, brief it with *"test the fix on every single one"*, and **fix the decision
rule in writing before you look at the result** — e.g. *"≥2 damaging fixes OR ≥1 false positive → run
the full band."* Low's verdict column would never have tripped any threshold.
**Also:** the Medium pass was oriented on severity, so its damaging fixes surfaced *incidentally* —
22 counted out of 158. The Low pass was briefed to hunt them and found ~45 out of 69. **Treat an
incidental count as a floor, never as a rate.**

### !! I excluded a population three times on three different arguments, and all three were about the wrong axis
**Saw:** across one audit a band was excluded from gating three times. (1) Mediums — on a sample that
was every Medium with a fix-spec. (2) Lows — nearly, on the verdict column. (3) a11y — because they
are forced to a fixed priority by a standing rule, "so a severity gate has nothing to correct", and
that was **written into the ledger as settled**.
**Cause:** each exclusion was a *sound argument about the wrong property*. (1) reasoned about
availability, (2) about diagnosis accuracy, (3) about severity mutability. **None of the three reasoned
about whether the prescribed fixes were dangerous** — which is what the gate actually buys. The
arguments were not sloppy; they were well-formed answers to questions that did not decide anything.
**Rule:** **when you exclude a population, write down WHICH PROPERTY your exclusion reasons about,
then ask whether that is the property the gate exists to check.** If the sentence is "this band
doesn't need gating because <X>", and X is not the thing you would report as the gate's output, the
argument is void no matter how true X is. *"Severity is fixed here"* does not imply *"the fixes are
safe here"*, and only the second is a reason to skip.
**Also — the tell:** #3 is the one already recorded as justified. **A conclusion written into durable
state is the hardest one to re-examine**, because it now reads as a finding rather than a choice.
Re-read your own settled exclusions with the same suspicion you apply to the tickets.

### !! Grepping the fix column for "fails/breaks/damages" undercounted defective fixes by ~40%
**Saw:** wanting a machine number for "how many prescribed fixes are defective", field 5 of the
verdict TSVs was grepped for failure phrasing. It scored the Low band 27/69. Reading the same 69
entries gave ~45/69. The scan then reported 21/78 for the a11y band, which was nearly published as a
rate.
**Cause:** the analysts wrote *what the fix does wrong*, not *that it is wrong* — "needs a companion
change", "does not transfer", "one-quarter of the job", "is a no-op". None of those match a failure
keyword, and the strongest findings had the least alarmed phrasing.
**Rule:** the fix axis is **prose, not a column** — either give it its own enum field in the batch
output spec, or read it. A keyword count over it is a **floor**, and must be labelled as one.
Publishing it as a rate would have understated the run's headline result by nearly half.

### !! I reported a 2-of-25 pass as though it were the whole corpus check
**Saw:** a construct index was built over 463 verdict rows, two constructs were read, two real
clusters were found and written up — in the ledger, on the tracker, in the report — as *"the
corpus-wide check."* **23 clusters had never been opened.** Finishing them turned up a third finding
worth two new tickets, filed four separate times by four batches that could not see each other.
**Cause:** the first two clusters were the two already suspected, and both paid out immediately. A
pass that starts with its best hits *feels* finished long before it is — the yield curve and the
completion curve point in opposite directions.
**Rule:** **state the denominator of your own sweep in the same sentence as its result** — "2 of 25
clusters" not "the corpus check". The no-silent-caps rule is not only for subagent work-lists; it
binds the thing you do by hand, where nothing else is counting for you.
**Also:** the missed cluster was the largest finding of the three. There is no reason to expect the
tail to be less valuable than the head when the ordering was by *suspicion*, not by evidence.

### !! My cluster-ranking heuristic was wrong 9 times out of 11 — and it was still worth running
**Saw:** to pick which of 21 remaining clusters to read, each construct's mentions were split into
prescription-language vs condemnation-language and any showing both was flagged. It flagged 11. On
reading, 2 yielded findings; the rest surfaced only findings already recorded on their own tickets.
**Cause:** the condemnation vocabulary ("is wrong", "no-op", "does not work") appears in almost every
`overstated` verdict, because that is what an `overstated` verdict *says*. The heuristic was detecting
the verdict, not a cross-ticket conflict.
**Rule:** a cheap heuristic over analyst prose is a **reading order, never a conclusion.** Publishing
its output as findings would have produced nine false ones. Say which it was: it sorted 21 clusters
into an order and then all of them were read — that is legitimate; reading only the flagged 11 and
reporting them would not have been.
**Proof it earned its place anyway:** the two it got right were the two new tickets, and it put them
early enough that the expensive classification work started sooner.

### !! Line-oriented search gave me three wrong numbers in one session, in three different disguises
**Saw:** three counts, all wrong, all from matching within a single line. (1) **Classifying by the
next line:** children of a wrapper element classified on the one following line → 19 defective; over
an 8-line window → 16, plus 6 parked as "unresolved" that were worse than the counted ones. (2) **Grep
scoped to the named package:** zero hits, so "the symbol does not exist" was written; it exists in a
different package. (3) **Single-line grep for a multi-line attribute set:** zero hits, so "the idiom
is used once"; the attributes sit on three consecutive lines and a 6-line window found a second
instance.
**Cause:** grep is line-oriented and the markup is not. Every one of these was a shortcut that worked
perfectly for *locating* the pattern and then silently produced a *count*.
**Rule:** **a line-oriented search finds candidates; it never counts them and never refutes them.**
Before any number goes in a ticket, re-derive it over a window wide enough to hold the whole
construct (a multiline-capable search, or a fixed-size line window), and over the **whole tree**, not
the path the claim named.
**Diagnostic that would have caught all three:** the count changed when the window was widened. **If a
number is stable under widening, it is a number; if you never widened, it is a guess.**
**Also — the errors ran in BOTH directions.** Two overcounts (which make a fixer dismiss the ticket at
the first site they check) and one undercount that hid the *worst* instances in the residual bucket.
Do not assume a sloppy scan is conservative.

### !! CORRECTION + fourth instance: the same window bug, and the residual bucket was NOT safe to round
**Saw:** the entry above reported the corrected total as 22. Resolving the 7 sites parked as
"component / unresolved" made it 24. Two of the seven were defects.
**Cause of the parking:** all 7 pass their child **on the anchor's own line**. The window skipped the
anchor line and read from the next one, so it saw the sibling element and gave up. Fourth instance of
one mistake in a session: classify-by-next-line, package-scoped grep, single-line-vs-multi-line, and
now skip-the-anchor-line.
**Rule:** **a residual bucket is not a safe rounding.** It ran 2 defects in 7, against a base rate of
~19 in 84 — the unresolved sites were *as likely* to be defective as the measured ones. Report the
floor honestly, then **go back and close it**; a floor is a promise, not a result.
**Also:** one of the two needed a **different fix from the other 23**. **Resolving a residual can
change the shape of the fix, not just the size of the number.**

### !! Twice in one run a tally in my own ticket was wrong, both times transcribed instead of generated
**Saw:** two filed tickets carried a count assembled by reading rather than by pasting a command's
output. One said "75 occurrences" where 75 was the all-files number and 35 of them were in test
files; the ticket's follow-on step proposed a sweep about twice its real size. The other listed
"eight uses" of a symbol with their line numbers; the grep returns nine, and **the missing one was the
most useful** — the line that turned "a different function is more careful" into "the same function
sets a version on the way out and never checks what comes back".
**Cause:** the grep was run, the output read, and the list written from memory of it while composing
prose around it. The transcription step is where items drop, and the ones that drop are the ones that
did not fit the sentence being written.
**Rule:** **a tally in a ticket is a claim — generate it, never transcribe it.** Paste the command AND
its output; if the list must be prose, produce it with the command in the same shell block so the two
cannot drift. **Then re-run the command after editing** — a count that was right when written goes
stale the moment the surrounding argument changes.

### !! I corrected a table for test-file inflation and fixed only ONE of its two columns
**Saw:** an inventory table had already been corrected once — a file count went 42 → 34 after
excluding test files. A day later the **occurrence** column still read the all-files number beside
the non-test file count, and the ticket's next step repeated it. Two further stale spots survived in
the same description and had to be patched immediately after the correction comment was posted.
**Cause:** the cell that was challenged was corrected rather than the **mistake**. The defect was
"counts include tests", which applied to every number in the table.
**Rule:** **when a correction identifies a systematic error, re-derive every figure that shares the
mechanism** — all columns, all rows, and the prose that quotes them. Then **grep the document for the
old number** before posting; a stale figure in the summary outlives the corrected one in the table.

### !! TWO measurements in one session returned a clean-looking ZERO because the harness was broken
**Saw:** both looked like results. Neither was. (1) An icon-generation tool printed its "Creating…"
lines, did not error, and left the output directory with **0 files**. Read straight, that refutes a
**true** ticket. (2) A `git grep -f <patterns>` over the tree reported **`found in tree: 0`** out of
1502 patterns. Read straight, every symbol in the corpus is a phantom.
**Cause of #2, found by a control:** the path-conversion setting needed by one git invocation left git
unable to open the pattern file in the other — `fatal: cannot open …` — and `2>/dev/null` hid it.
**Cause of #1 never established** — a wrapper-resolution or path-conversion difference between the
harness's invocation and a by-hand one. Unresolved; what is certain is the log was truthful and the
observation was not.
**What caught both:** a **control with a known answer in the same invocation** (two symbols known to
exist, written to a file, must print back). The control failed loudly where the real query failed
silently.
**Rule:** **every measurement that can return "nothing found" needs a control whose answer you already
know, run in the same command.** Print it first and label it `CONTROL`. ⛔ **Never suppress stderr on
a measurement** (`2>/dev/null` / `2>$null`) — the fatal you are hiding is the explanation. And read
the **command's own** exit status, never the pipeline's. When the artifact on disk contradicts the
tool's own log, **suspect the harness before the claim**: re-run isolated — cwd outside the project,
inputs copied out, binary by full path, exit code captured directly.
**Also:** a zero is the most dangerous result shape, because it is what both a clean bill of health
and a broken harness look like.

### !! A sed-escaping bug made an audit flag EVERY file as missing — the inverse of the silent zero
**Saw:** auditing bare `file.ts:NNN` citations, the first run reported `NO-SUCH-FILE` for the very
first row and thousands like it. It was only doubted because that file had been read an hour earlier.
**Cause:** a `sed` expression meant to escape regex metacharacters lost a backslash to the shell, so
every pattern contained a literal ampersand and matched nothing — **every citation in the corpus
reported as a phantom.** The existing control did not catch it: it asserted only that the *tree*
loaded, not that the *matcher* worked. It tested the wrong stage and the wrong direction — every
control to that point asserted "a known-good thing passes", and this harness failed by **flagging
everything**.
**Rule:** **a control must cover the failure direction you are NOT expecting.** Assert all three: a
known-good input is **not** flagged, a known-bad input **is** flagged, and a known-ambiguous input
reports as ambiguous. And **when string-matching filenames, do not build regexes at all** — index by
basename and join. No escaping, no shell-quoting layer, and it is faster.
**Also:** this is the same family as the two zero-results above and the interpreter-path failure in
"Forge CLI limits" — several in one session, all masked by suppressed stderr.

### !! CORRECTION: my 9-row sample put the residue rate at 67%; reading all 67 gave 52%
**Saw:** a class of "residue" verdict rows (see the two-gates theme) was measured from a machine-spaced
sample of 9 and reported as 6 of 9 carrying a distinct defect. Reading all 67 at-risk rows gave
35 distinct / 31 corrections / 1 already filed = 52%.
**Cause:** not sampling error alone. The classification boundary itself moved under scrutiny: on the
9-row read one item counted as a distinct defect; on the full read it is plainly *the same defect at a
second site* — wider scope, not a new finding. **When a rate depends on a judgement boundary, a small
sample measures the boundary as much as the population.**
**Rule:** a small sample is sound for establishing **that a class exists** and for **choosing what to
verify first**. It is not sound for a **rate** whose numerator needs a judgement call. Say which you
are doing. If the deliverable is a work-list, **read the whole pool** — 67 rows cost one pass and the
result is actionable rather than indicative.
**Also — the triage IS the deliverable, and filing is not.** 35 tickets off one reader's
classification is the over-production a severity gate exists to prevent. Verify one end to end, file
that, hand over the classified list, and let the operator promote from it (`fleet check promote`).

### !! I chained the credential scan and the push into one command — so the scan could not stop the push
**Saw:** before pushing a branch, ran `git diff | grep -icE '<secret-pattern>' && git add -A && git
commit && git push` as one call. The scan printed a count of **1** and the push went through anyway.
Checked afterwards: the hit was prose in a ticket that named a credential *type*, not a secret value —
the push was safe. **But it was safe by luck, not by construction.**
**Cause:** a scan chained ahead of the action it is meant to gate is **decorative** — nothing reads
its output before the action runs. Worse, the exit code was actively inverted: `grep -c` and `grep -q`
exit 0 **on a match** and 1 on a clean diff, so the `&&` chain proceeds exactly when a secret IS found
and blocks on a CLEAN diff. Backwards in both directions.
**Rule:** ⛔ **never chain a safety check into the same command as the thing it gates** — a check
whose result nothing reads before the action runs cannot stop the action. **Run the scan as its own
call, read the output, then push.** If it must be one command, invert it so a hit is fatal and the
push is unreachable — and write that form for **both shells**, or let the CLI gate it. And remember a
match-counting scan exits 0 **on match** — the opposite of what an `&&` chain reads as success. Same
family as suppressing stderr on a measurement and reading a pipeline's exit status instead of the
command's (above): the shell answered a different question from the one the command was written to
ask.
**Also:** the pattern will keep firing on prose, because field notes and tickets discuss credentials
by name. That is fine — the check is cheap and the reading is one line. What is not fine is letting a
non-zero count scroll past because the push already happened.

### !! The regression test passed against a launcher that was still broken
**Saw:** a test written for a command-construction bug called the function directly, while the
launcher invokes the same function through a shell. The quoting differs between those two paths, and
the quoting was where the second bug lived — so the test went green over a launcher that would still
have failed in production. A later copy of the same test drifted the other way: it restated the
logic inline, so it kept passing after the source it was meant to guard had changed.
**Cause:** a test reaches the code by whatever path is convenient, and measures **that** path. The
gap between "the function is correct" and "the way we invoke it is correct" is invisible from inside
the test, and a restated copy of the logic is a test of the copy.
**Rule:** **invoke it exactly as production does** — same entry point, same spawn and quoting layer,
same argument shapes — and **extract the code under test verbatim from the source file** rather than
restating it in the test, so the two cannot drift. This is what the plugin's golden tests under
`test/` are for: they read the shipped artifact and compare, instead of describing what it should
say.

## Truncation & completeness

### !! op-16 returned EXACTLY the limit and no warning — the reconcile then invented an unfiled Urgent
**Saw:** Final reconciliation called op-16 `findIssues({group, limit: 250})`. It returned **exactly
250** issues. Reconciling the findings queue against that set reported **338 unfiled including 1
Urgent** — and the "unfiled Urgent" was a ticket filed hours earlier and visible in the project. The
real totals were 297 issues, 184 unfiled, 0 Urgent outstanding.
**Cause:** `limit` is a page size, not a total, and a full page comes back with no error, no ellipsis
and nothing in the payload that looks wrong. The response *does* carry a completeness flag (op-16's
`complete`) — but only the small responses render inline where you notice it; the big ones are
spilled to a file and the flag is easy to skip past while parsing for `issues`.
**The false reading it produces is specific and dangerous:** a truncated *filed* set makes real work
look **undone**. It manufactures phantom High/Urgent backlog, and acting on it means re-filing
duplicates of tickets that already exist.
**Rule:** **Treat `count == limit` as "truncated" until proven otherwise, and always read `complete`.**
When a scope may exceed one page, **split the query into bands that each fit** — one call per
`priority` (1/2/3/4) — and assert `complete == true` on **every** band before combining. Print the
per-band counts and the flags; a band silently at its cap is the failure you are looking for.
`fleet check reconcile tracker --pages <json>` refuses a page set with any `complete: false`.
**Also:** this is the same shape as the forge's file-list cap below — a paging API answering "here is
a page" to a question that meant "here is everything". Whenever a count is the input to a
*difference*, verify completeness on both sides first; the subtraction cannot tell you a side was
short. And do not trust a running tally kept in conversation either: one drifted to "275 filed"
against an actual 296. The system of record answers this in one query — ask it rather than counting
as you go.

### !! The tracker linked a checklist row to an unrelated onboarding issue
**Saw:** A 322-row PR checklist posted to the tracker came back with rows autolinked to `ABC-1` and
`ABC-2` — real, unrelated issues from the team's first week. None had anything to do with the PRs.
**Cause:** Titles were truncated to a fixed character count, which cut issue keys mid-token:
`(ABC-1xx7)` became `(ABC-1…` and `(ABC-2xx4)` became `(ABC-2…`. The tracker then autolinked the
**valid short key that was left** to real issues. The write "succeeded" and looked fine in the echo
unless you actually read the hrefs.
**Rule:** Never truncate text containing issue keys at a raw character offset (contract §8 rule 8).
Truncate at a word boundary, strip trailing `(KEY-\d+)` fragments, and wrap any surviving key in
backticks so the tracker cannot autolink it at all. Applies to any tracker, comment or description
built by slicing titles.
**Also:** This silently creates backlinks ON the unrelated issues, so it pollutes them too — it is not
purely cosmetic in the tracker.

### !! Sampling agents' output files mid-run invented a disagreement that never happened
**Saw:** Two duplicate passes were reconciled by reading `out/*.tsv` while 12 agents were still
appending. A pair was concluded "co-clustered but not emitted ⇒ an agent judged it distinct", labelled
a CONFLICT, and that framing shipped into a follow-up agent's prompt. The agent came back: the other
agent had judged it `subset`, and had simply not written the row yet.
**Cause:** per-finding appends mean a partially-written output file is indistinguishable from a
finished one that found nothing. The inference required the file to be complete; nothing said it was.
**Rule:** never derive a *negative* ("agent X did not find Y") from an output file until that agent's
completion notification has arrived. Counting rows for progress is fine; inferring absence is not.
Gate every reconciliation on the agent-done list, not on the files.
**Also:** the false conflict went into a downstream prompt as established fact. When you pass a
premise to an agent, mark it as a hypothesis to check — that agent correctly refuted it, but only
because it re-read the code instead of trusting the brief.

### !! "No X anywhere in <dir>" was literally false and substantively right — and I repeated it
**Saw:** several verdicts state *"there is no `<Provider>` anywhere in `example/app/src`"*, and it was
relayed verbatim on a ticket. Checked: the symbol appears in 6 files under that directory. **All six
are test files.** So the substance holds — no provider in production code, so the default applies —
but the sentence as written is false.
**Cause:** the analyst grepped production paths, or grepped and mentally filtered the tests, then
wrote the conclusion in absolute terms. The filter was real reasoning; it just did not survive into
the sentence.
**Rule:** **an absolute claim must be true of the command a reader will run.** If your grep needed a
filter — excluding tests, dist, fixtures — **put the filter in the claim**: *"no provider in
production code; the six occurrences are test harnesses."* Otherwise the first person to check finds
hits and stops reading, which is the same dismissal a wrong file path causes.
⛔ **This is the mirror of the too-narrow grep** (see "Verifying my own security shortlist" in the
gates theme). There, a too-narrow grep made a true finding look fabricated. Here, a too-broad claim
invites a reader's grep to do the same thing to a true finding. **Both are the gap between the search
you ran and the search you described.**
**Diagnostic:** before writing "no X anywhere in Y", run the naive grep a sceptic would run. If it
returns hits, your sentence needs the qualifier.

### !! "No failure report anywhere" was a claim about a sample taken at one instant
**Saw:** 8 cloud captures dispatched, 0 result branches. "Silent worker death" was inferred from the
absence of any failure marker. **That inference was wrong** — two workers later delivered manifests
with `status: failed` and a real failure report. The evidence existed; the check ran before those
branches landed and generalised from an incomplete sample.
**Cause:** when several agents are producing evidence concurrently, absence of evidence arrives late
far more often than it is truly absent.
**Rule:** re-check before generalising from absence. A "nothing delivered" verdict about a fan-out is
only valid once every worker has either delivered or exceeded the quiet threshold; until then it is
a snapshot, and must be labelled as one.

### !! `git log -S` names a commit that never touched the line — the checkout is a 13-commit shallow clone
**Saw:** `git rev-list --count HEAD` = 13, `.git/shallow` present, on a repo with a thousand merged
PRs all-time. `git log --oneline -3 -- <file>` returns a single unrelated commit.
**Cause:** the working checkout is shallow, so history is squashed/synthetic. Any `git log -S'<the
string the ticket says is missing>'` "confirms" whatever commit sits near the top.
**Rule:** in a false-positive audit, **never** decide "already fixed since filing" from git history —
that is precisely how you cancel a live bug. Decide from the **current file contents**, which are
accurate. State this in the auditor brief as a prohibition; every one of 49 auditors was given it and
`already_fixed` came back 0 across 466 findings, consistent with a sweep run against the same tree
hours earlier.
**Diagnostic:** `git rev-list --count HEAD` under ~50 on a repo with hundreds of PRs ⇒ shallow.

### !! "Not an ancestor" proved nothing — the repo squash-merges
**Saw:** testing whether reviewed code is what merged, `git merge-base --is-ancestor <headRefOid>
origin/main` returned **false for all four PRs**, which reads as *"the PR changed after review"* and
would have been a real finding.
**It is an artifact of the workflow.** `git log origin/main --merges` returns 0 in the last 30, and
the merge commits have one parent each: the repo squash-merges, so a reviewed head is *never* an
ancestor regardless of content.
**The correct test is content:** hash the blob at the reviewed head and at `origin/main` for each
file (`git cat-file -p "$oid:$f" | git hash-object --stdin`) and compare. All 10 files across the 4
PRs: identical. The reviewed code IS what shipped.
**Rule:** **before using ancestry to decide anything, check the repo's merge style** (`--merges`
count, parent count). In a squash/rebase repo, ancestry answers a question you are not asking.
**Compare blobs.**

### !! A sweep over OPEN PRs has a shelf life — 4 of them merged and no ticket noticed
**Saw:** every ticket from an open-PR review carries `**PR:** <link> *(open at time of review)*`.
Checking what `origin/main` actually pointed at: five commits ahead of the working tree — and ALL
FIVE were PRs the sweep reviewed while they were open. **8 findings silently changed meaning** — from
"a gap in a proposed change" to "a defect on main" — and every ticket still read *(open at time of
review)*. Spot-verifying the highest-priority one: the merge fixed the *naming* half of the finding
and not the reachability half. Not fixed.
**Cause:** the PRs a sweep reviews while they are open are exactly the ones about to merge, and the
`*(open at time of review)*` annotation is written once, at filing time, by a session that is gone by
the time it stops being true. Nothing in the corpus watches the base branch, so the tickets keep
asserting a state the repository has left.
**Rule:** **`git log HEAD..origin/<base>` against the worklist is a cheap, repeatable check** — run it
at wrap-up (`fleet check blast-radius --since <sha>`) and again whenever the corpus is revisited.
Findings on open PRs need a status line, and the tickets need updating when their PR lands.
**Also:** it pays forward — one of the merges shipped a tested component whose header states a class
ticket's diagnosis verbatim, **a precedent that did not exist when the class ticket was written.**
The sweep had grepped to prove a precedent was ABSENT and never grepped to see whether a better one
had APPEARED. Different questions; only the second finds work already done for you.

### !! The audit's "current main" went stale UNDER the run — 31 findings were judged against a tree 5 commits behind
**Saw:** ~115 agents read the primary checkout at one SHA and reported verdicts as "verified against
current code". By the end of the run `origin/main` was 5 commits ahead (4 PRs from the sweep's own
work-list had merged that morning, a 5th landed mid-check). 7 findings sat on those merged PRs and 24
more named files the merges touched: **31 of 435 judged against code that had moved.**
**Cause:** a long fan-out pins a checkout at dispatch time, but the base branch keeps moving —
especially on a sweep that reviews *open* PRs, because those PRs are exactly the ones about to merge.
Nobody re-reads the ref.
**Rule:** record `git rev-parse HEAD` at dispatch (the sweep `manifest.json` carries it), and at
wrap-up run `git fetch` + `git rev-list --count <snapshot>..origin/<base>`. If it is non-zero,
re-check every finding naming a file in `git diff --name-only <snapshot>..origin/<base>`. ⛔ Do
**not** `git checkout` to do it — other agents may still be reading the tree. Read the new code with
**`git show origin/<base>:<path>`**, which touches nothing.
**Result here:** 30 of 31 still open, 1 partially fixed. Low yield, but the yield is not the point —
"verified against current code" was an overclaim until it was checked.
**Also:** computing the blast radius by BASENAME gave 66 hits, nearly all bogus (`page.tsx` matching
dozens of unrelated routes). Full-path matching gave the true 24. Same basename trap as the duplicate
clustering, one layer up.

## Dedup & attribution

### !! Two slices file the same defect from two different PRs
**Saw:** Slice A (from PR A) and slice B (from PR B) independently produced the same finding about
the same control in `example/app/src/<component>.tsx`. Same file, same control, same consequence.
Neither worker could have known — each saw only its own PR.
**Cause:** Several PRs in one sweep touch the same file, and an edge case belongs to the *file*, not
to the PR that happened to surface it. This is the within-sweep version of the cross-sweep duplicate.
**Rule:** Before filing, group the whole sweep's findings **by file path** and eyeball any path with
findings from more than one slice (`fleet check dups cluster` writes `dups.tsv`). When two match, file
**one** issue citing **both** PRs in `links`, and merge each slice's unique detail — they are rarely
identical in depth. Here one slice alone had the deeper mechanism and the other alone had a second
trigger; either issue on its own would have been the weaker half.
**Diagnostic:** the tell is two findings whose `files` arrays intersect and whose titles describe the
same control. Cheap to check once over the consolidated queue; impossible to spot per-slice.

### !! Count how many INDEPENDENT slices rediscover a finding — it is a severity signal, not just a dedup chore
**Saw:** Several defects were found by two or three workers who shared no context, from different
PRs: a shared picker component keyboard-unreachable (3×), an empty state rendered on a failed read
(2×), a cache missing a field (2×, once for each consumer).
**Cause:** These are not per-PR bugs. They are **shared components or shared idioms** that many PRs
touch, so any worker reviewing any of those PRs meets the same defect. A per-PR sweep naturally
rediscovers them; a per-file one would not.
**Rule:** **Treat rediscovery count as evidence, in two directions.** (1) It raises confidence —
three workers with no shared context independently reaching the same conclusion is far stronger than
one. (2) It raises *scope*: the right ticket is the **pattern**, not the instance. File it once, list
every call site found, and say plainly that the fix belongs in the shared component; fixing one
consumer alone leaves the next one broken.
**Rule for the filing step:** when a finding matches one already filed, do not just drop it —
**append the new call site and the new PR reference to the existing issue** (op-14 `links`, op-11).
The second sighting is information the first ticket did not have.
**Diagnostic:** if two slices that share no PRs cite the same `file:line`, you are looking at a shared
component. Check the whole consumer list before filing.
**But see "Found independently by three reviews" in the gates theme** — convergence is evidence only
when the reviews do not share a premise.

### !! The dedup matcher reported 28 of 100 filed issues as unfiled, and its earlier run "matched 87 of 87"
**Saw:** Reconciling 230 findings against the project's tracker titles, the token-overlap matcher
returned `UNFILED: 202` — it recognised only 28 of the 100 issues demonstrably created. An earlier run
of the *same* matcher had printed `filed: 87` against 87 stored titles, which read as a perfect match
and was taken as proof the matcher worked.
**Cause:** Two bugs, one masking the other. (1) The stored titles were lines of the form
`ABC-1xx|<title>`, and the key was being tokenised as content. (2) The score divided by the
**finding's** token count. But the tracker title is a *shortened rewrite* of the finding title, so the
denominator is systematically the larger set and a correct match scores ~0.3–0.46.
**The false reading that made it dangerous:** `filed: 87` out of 87 stored titles looks like 100%
agreement. It was a coincidence of two roughly-equal-sized sets, not a match — and it is exactly the
number a working matcher would print, which is why it survived a whole filing session unquestioned.
**Rule:** **Score title similarity by containment on the SHORTER side —
`len(a & b) / min(len(a), len(b))`, threshold ~0.62 — and strip any id prefix before tokenising.**
Then validate the matcher against a title you *know* you just created, by name. Never accept an
aggregate count as evidence that a fuzzy matcher works.
**Diagnostic:** print the best-scoring candidate and its score for the first few "unfiled" rows. A
matcher that is working shows near-misses in the 0.1–0.3 band; a broken one shows obviously-correct
pairs sitting just under the threshold, which is instantly recognisable by eye.
**Also:** even with the fix, ~2 of 133 remained false positives — findings deliberately *merged* into
one ticket, so no single filed title matches either half. Merged findings need an explicit exclusion
list; the matcher cannot infer them. Better still: never match on title at all — give every finding a
stable `fid` (`fleet check fid mint <slice> --count N`) and reconcile by set-difference on it.

### !! Four PRs are marked `filed` in the ledger but no issue anywhere references them
**Saw:** Reconciling a sweep, the PR→issue index showed 4 of 267 `filed` PRs with **no issue keys** —
each with exactly one surviving finding in its slice output and none present in the filing queue.
Read naively that is four lost findings.
**Cause:** Three of the four were **filed against a sibling PR**. The dedup pass had correctly seen
them as already-covered, because the issue existed — attributed to the *other* PR whose code the
defect actually lives in. Only the fourth was genuinely never filed.
**Rule:** A `filed` ledger line with no matching issue is **not** proof of lost work. Before refiling,
search the tracker for the finding's distinctive phrase (op-16 `text`) — not its PR number. Cross-PR
attribution is the *correct* outcome when a defect is discovered reviewing PR A but lives in code PR B
introduced; the index just cannot see it, because the index joins on the `**PR:**` header.
**Diagnostic:** Refiling without that check produces a **duplicate**, which is worse than the gap.
Three of four here would have been duplicates. Record the cross-reference explicitly in `xref.tsv`
(`<pr>\t<issue>\t<why>`) so the next reconciliation does not re-investigate them.
**Also:** This is only visible if you *build* the PR→issue index. The ledger alone said "filed" and
was, in a sense, right. **Reconciliation found a real unfiled finding that every other check missed**
— worth the cost on its own.

### !! Joining issues to PRs by scanning the description head invents PR references that were never claimed
**Saw:** Three mapper agents extracting PR numbers from the first 400 characters of each issue
description. One refused the instruction and narrowed the match to the `**PR:**` / `**PRs:**` header
line, reporting that three issues each cite an unrelated earlier PR in the prose sentence after the
header (*"…the same shape PR C introduced…"*). Rerunning the other two bands under the narrow rule
changed exactly one more pair each.
**Cause:** A good issue body **cites related PRs in its prose** — that is the sweep working as
intended. A positional window cannot tell "the PR this issue is about" from "a PR this issue mentions".
**Rule:** Join on the **`**PR:**` header line only**, never a character window. Genuine two-PR issues
put both on that header line, so the narrow rule loses nothing.
**Also:** The subagent that pushed back was right — **when a worker questions the spec, check before
overruling it**, and propagate the fix to the other workers mid-run (`fleet send`) rather than
repairing their output afterwards.

### !! Auditors surfaced 17 duplicate PAIRS that no dedup gate had caught, purely as a side effect
**Saw:** 17 pairs where two separately-filed issues are the same defect at the same `file:symbol`.
Both halves were verified real in every case. The dominant shape: one composite ticket folds a second
defect in as "filed here because it shares the fix", and that defect was **also** filed standalone by
a different worker.
**Cause:** parallel filing workers can't see each other's issues, and a within-slice duplicate is
invisible unless one agent happens to hold both PRs.
**Rule:** 17 is a **floor, not a count** — an auditor only sees its own slice. A real dedup pass has
to run globally over the `file:symbol` in each `**Where:**` line, after filing. Ask for the pairs as
a side-channel output (`dups.tsv`) in any per-slice fan-out; it costs nothing and it is the only
duplicate signal the sweep produces.
**Also:** do NOT dedup by title similarity — these pairs have completely different titles.

### !! Clustering issues by the file path an auditor recorded misses the commonest duplicate shape entirely
**Saw:** A global duplicate pass over 466 findings grouped on the source-file path recorded in each
finding's `Where:` line — 95 clusters, 662 candidate pairs, 12 agents. It found 22 pairs. But of 17
pairs a previous within-slice pass had found, **11 were never co-clustered at all** — the two issues
had recorded *different* primary file paths, so no agent ever compared them.
**Cause:** the dominant duplicate shape is **a composite issue plus the component it folds in**. The
composite records the file of its *main* defect; the standalone records the file of the folded-in
one. They can never cluster on path. 8 of those 11 were exactly this shape.
**Rule:** path clustering is necessary but **not sufficient** — always reconcile against any other
duplicate signal you have and judge the leftovers directly. And grep issue bodies for the phrase
"shares the fix" / "filed here because": that sentence *is* a duplicate marker, and it is far more
reliable than any file-path heuristic.
**Diagnostic:** for a pair your clustering did not emit, check whether the two issues ever landed in
the same cluster before concluding an agent judged them distinct. "Not emitted" and "judged and
rejected" look identical from the output files and mean opposite things.

### !! Two more duplicate signals, 43 pairs, ZERO duplicates — the path pass had already found everything
**Saw:** After the file-path duplicate pass (31 pairs → 20 merged), two independent signals were run
to close the completeness gap: **shared identifier** across different files (23 pairs) and **explicit
key cross-references** harvested from all 435 live descriptions (106 refs → 20 judged). Result: 0
duplicates, 0 subsets, from 43 pairs. Later run to exhaustion: 118 pairs, still zero.
**Cause:** the two signals fail in opposite ways. A shared *identifier* is mostly collision — event
handler names, one pure cross-app name clash. A cross-*reference* is mostly the filer telling you the
opposite of a duplicate: "Sibling: ABC-1xx" means they split the PR's findings **on purpose** and
cross-linked them. 8 of 8 sampled siblings were deliberate separations.
**Rule:** run path clustering first — it is the high-yield signal. Treat identifier-overlap and
cross-references as **completeness checks**, not as discovery: their value is the negative result that
says the path pass did not miss a category. Do not budget many agents for them — but the exhaustive
run is what turns "probably complete" into "complete".
**Diagnostic:** an identifier is worth checking only if it contains a lowercase→UPPERCASE transition
AND is not a DOM/framework handler name. Filtering on that alone cut 53 candidate pairs to 23.

### !! All four "shares the fix" claims were false, and one is a factual error inside a live ticket
**Saw:** Of the cross-references, only 4 were `same`/`shares-fix` — the strongest possible phrasing.
**All four judged distinct.** An earlier composite ticket had folded in three siblings under "filed
here because the fix is shared"; the verification gate split all three — the consumers lived in
different apps and neither fix repairs the other. One claim was not merely optimistic but **wrong
about the code**: it listed a caller its shared-primitive fix would cover, but that caller inlines
the primitive with its styling **hand-copied verbatim**, so a change to the shared component never
reaches it.
**Cause:** a filer who identifies one root *cause* writes "shares the fix" without checking that the
consumers actually go through the shared component. Hand-copied strings and per-app copies break the
link invisibly.
**Rule:** ⛔ **"Shares the fix" is the least reliable strong signal in the corpus** — 0 for 4 here,
and 0 for 3 on the earlier composite. Treat it as a duplicate *hypothesis*, never a verdict — check
the two fixes land in the same file; cross-app pairs almost never merge. Always verify the second
site actually *calls* the thing being fixed. When it does not, comment the correction on the ticket
(op-11): left alone, that sentence causes someone to close a second issue that was never fixed.

### !! An adversarial gate given the prior verdict confirmed 12 of 12; warned about anchoring, a sibling batch dropped to 5 of 9
**Saw:** Gate over 31 candidate duplicate pairs. One batch was handed the pairs **with the first
pass's claim in the input** and returned `duplicate/subset` for all 12, zero rejections. The next
batch was told explicitly that its input was "an unproven hypothesis", that the prior agent had
returned 12-of-12 "which is itself a reason for suspicion", and named one pair a sibling had already
overturned. That batch returned **5 merge_ok / 4 split** on 9 pairs.
**Cause:** stating a prior verdict in the prompt anchors the judgement even when the instruction says
to be adversarial. The prompt has to actively spend words *against* the anchor it just introduced.
**Rule:** when a verification gate must see the prior verdict (it usually must, to attack it), pair it
with an explicit debiasing line: name the prior pass's confirmation rate, say it is unproven, and cite
a concrete case where it was wrong. Across all 31 pairs the gate split **11** — every one of which
would have deleted a real tracked bug.
**Proof:** anchored batch 12/12 confirmed; warned batch 5/9. Overall 20 merge_ok / 11 split.

### !! The dangerous near-duplicates are not duplicates at all — they are partial overlaps with no vocabulary
**Saw:** Judging 118 candidate pairs produced zero duplicates but three shapes that a `duplicate /
subset / distinct` vocabulary cannot express, each of which would cause real damage if merged:
1. **Partial location overlap** — two tickets both claim `<component>:217`, but each also owns call
   sites the other does not. The fix is per-call-site, so closing either alone leaves tracked sites
   unfixed.
2. **Sequential, not shared** — ticket A exists *because* the PR that fixes ticket B introduces it.
   Merging them deletes the underlying bug if that PR is re-scoped.
3. **Same class, N disjoint sites** — one bug class, four separate call sites in one file, no
   composite.
**Cause:** the vocabulary assumes duplicates nest (one contains the other). Real filings overlap
partially, chain causally, or scatter across sites.
**Rule:** when a pair is `distinct` but the two tickets **name a shared line or a causal link**, do
not just drop it — **comment on both** (op-25 `relate` with a note) with who owns which sites. A
silent `distinct` verdict loses the information that one fix will half-close the other. Add a
`related-overlap` outcome to the agent's report even if it is not a merge action.

### !! The two tickets that shared a root fix were the ones with the LEAST vocabulary in common
**Saw:** Ticket A and ticket B turned out to be the **then- and else-branches of a single `if`** in
one startup script — `example/service/start.sh:102-105` and `:117-119`. One root fix closes both;
fixing either alone leaves the other open. A dedicated duplicate-detection pass had already run over
this corpus and **did not surface the pair at all**.
**Cause:** the dedup pass scored candidates on shared symbols and shared file paths, then on
description overlap. These two share a file but almost **no vocabulary**: different mechanism words,
different harm words, different line ranges. On text similarity they look unrelated — which is exactly
what you would expect, because **the two branches of an `if` describe opposite conditions by
construction.**
**The false reading:** high textual similarity was treated as the duplicate signal. It finds
re-filings of the same observation. It systematically **misses the more valuable case** — two
findings with one root cause, written by different reviewers who each saw a different arm of it.
**Rule:** ⛔ **Run a structural dedup pass in addition to the textual one: group findings by FILE and
sort by line number, then read every pair whose line ranges are within ~30 lines of each other,
regardless of how differently they read.** Ask "is one of these the other's `else`?" Adjacency in a
control-flow construct is a stronger root-fix signal than any amount of shared vocabulary.
**Also:** the same batch produced the inverse error — a composite's three "shares the fix with…"
claims were all false; the siblings lived in different apps. So textual similarity over-groups across
files and under-groups within one file. Both failures, one pass, opposite directions.

### !! The dedup pass didn't MISS the shared-fix pair — it examined the claim and REJECTED it
**Saw:** Second instance of the structural-adjacency shape, found within the hour. A ticket body
asserts *"Same root cause as ticket B — these should be fixed together."* A duplicate-detection pass
evaluated that claim and concluded **all three** of the ticket's "shares the fix with…" claims were
false. That conclusion was repeated, and the severity gate was briefed with it. **The gate refuted
it**: the two are same app, same file, adjacent functions — `<component>:673-681` vs `:726-740`. The
shared-fix claim was correct. (The other two claims were indeed false, so the pass was 2-for-3, not
wrong throughout — which is exactly why its verdict read as trustworthy.)
**Cause:** worse than the earlier entry's failure mode. That one was an *omission*. Here the pair
**was surfaced, was assessed, and was actively dismissed**. The pass compared the tickets'
*descriptions* rather than opening the file and looking at where the two line ranges actually sit. A
rejection carries more authority than a non-result, so it propagated: into the summary, into a
downstream brief, and it would have shipped as two separately-fixed tickets.
**Rule:** ⛔ **When a ticket ASSERTS a shared fix, do not adjudicate that claim from the two
descriptions — open the file and compare the line ranges.** Same file within ~50 lines is decisive on
its own. And record a dedup *rejection* with the same evidence standard as a merge: a wrong rejection
is more expensive than a wrong merge, because nothing downstream ever re-examines it.
**Also:** this is the second time in one run that an agent overturned a premise it was handed. Both
times the premise was the launcher's own earlier pass's conclusion, restated as fact in a brief. Brief
agents with the *claim and its provenance* ("a prior pass concluded X — verify it"), never with X as
background.

### !! An open PR carrying the exact fix reads as "already fixed" if you skim the PR body
**Saw:** A cluster agent reported a ticket as a probable already-fixed-on-merge case, citing a PR
which "deletes the private accessor and routes both call sites through the hardened reader". Checked:
the three bare parse calls are still on `main`, and the bundled PR metadata says `state: OPEN`,
`mergedAt: null`.
**Cause:** a PR body describes what it *will* do in the present tense. Reading it without checking
merge state turns an in-flight fix into a false closure.
**Rule:** before recording any already-fixed verdict, check **both** the current file contents **and**
`state`/`mergedAt` on the PR being credited. An open PR with the fix is still a real, open bug — but it
needs a "don't write a competing patch" comment naming the PR (op-11, op-8), per the cross-sweep
duplicate convention, not a closure (op-10 `leaveOpen`).

### !! Gate 2 has a THIRD form on an open-PR sweep: another OPEN PR already fixes it
**Saw:** One slice reviewing PR A reported, correctly, that an edit control is a bare icon holding
the only click handler — mouse-only, invisible to assistive tech. It is genuinely true on `main`, so
gate 2 as specified ("does main already handle it?") **passes it through as a valid finding**. But
another slice had already reviewed PR B, whose entire purpose is *"make that control a real focusable
button"*. Two different workers, two different PRs, one defect — and only the filing-time reconcile
caught it.
**Cause:** On a merged-PR sweep, gate 2 has two states: fixed later on main, or still open. On a
sweep that includes **open** PRs there is a third: **fixed by a different open PR that has not merged
yet.** No worker can see it, because each worker only holds its own few PRs and `main` — the fix
exists in neither.
**Rule:** When the worklist contains open PRs, **reconcile findings against the open-PR set as well as
against `main`.** Cheapest version: at filing time, grep the finding's cited file path against the
bundled `_sweep/prs/*.json` `files[]` for **open** PRs and read any hit's diff before creating the
issue. A finding whose file is touched by another open PR is a dedup candidate, not automatically a
finding.
**Also:** the reverse direction is a *real* finding and must not be dropped — PR B introduces two tab
stops with the same name, which only exists because it is fixing this. "Another PR fixes it" kills
the duplicate; it does not kill what the fixing PR itself gets wrong.
**Cost if skipped:** a duplicate ticket, and worse, one assigned against the wrong PR — so whoever
picks it up reads a diff that does not contain the fix they are being asked to review.

## The two gates

Gate 1 asks *is this finding real?* Gate 2 asks *is it still real, still open, and is the ticket
right about reach, trigger and remedy?* The audit that produced these notes ran gate 1 on every
finding and gate 2 adversarially; the entries below are what each gate got wrong, and what the review
lenses that feed them are.

### !! A guard added by a later PR silently skips a call site the earlier PR created
**Saw:** PR B merged **51 minutes after** PR A and added a guard to the three entry points that
existed on its branch base. PR A had just introduced a **fourth** entry point, which PR B's branch
never saw. Result on main: three guarded handlers and one unguarded one, in the same file, with no
conflict and no test failure.
**Cause:** Gate 2 is usually run as "did a later PR fix this?" — which assumes the later PR could
*see* the thing. When two PRs are in flight at once, a sweeping fix applied by the later one is
applied to **its own branch base**, not to what main looks like after both merge. Git merges them
cleanly because they touch different lines.
**Rule:** When PR A adds a new call site of a pattern and PR B (merged within hours, from a base that
predates A) hardens that pattern, **check A's new call sites against B's fix explicitly**. Compare
merge timestamps: any two PRs merged close together touching the same file are candidates. The tell
is a file where the same guard appears at some call sites and not others.
**Also:** this generalises beyond guards — the same shape applies to a later PR adding a null check,
a timeout, a label, or an aria attribute "everywhere". "Everywhere" means everywhere *its author
could see*.

### !! Sweeping OPEN PRs finds things no merged-PR sweep can
**Saw:** A slice reviewed six open PRs and, besides its findings, reported that two of them edit the
same form component. The hunks don't overlap textually, so git will auto-merge, but whichever lands
second should be re-verified — one PR's new call sits immediately above the block the other rewrites.
**Cause:** Two PRs in flight against the same file cannot see each other. Git's textual auto-merge
succeeds and hides a semantic interaction. No reviewer of either PR alone is looking at the other.
**Rule:** When sweeping open PRs, group the slice's PRs **by file** and flag any file touched by more
than one, even when the hunks are far apart — a clean auto-merge is exactly when this bites. Report
it as a merge-order caveat, not as an edge-case issue: it has no defect to file yet, and it evaporates
once one of them merges.
**Why open-PR sweeps are worth the cost at all:** every finding is **pre-merge**, so the fix is a
commit on an existing branch rather than a new ticket, a new branch, a new review and a new deploy.
Two of the slice's four findings were regressions the PR *introduces* — catching those before merge is
strictly cheaper than filing them after.
**Also:** for an open PR, gate 2 **inverts** — the question is not "did a later PR fix this?" but
"does main already handle it?". Tell the worker explicitly; the merged-PR phrasing silently produces
false positives on unmerged code.

### !! The single richest edge-case lens this sweep found: "what does a FAILED READ render as?"
**Saw:** Four independent PRs, in three different slices, produced the same High finding without any
shared prompt hint: a fetch error is discarded, the component renders its **empty state**, and the
empty state asserts a **security fact the user would act on** — no sessions, no keys, nobody blocked,
nothing shared — and in one case the zero also **disables the control that would fix it**.
**Cause:** `catch(() => setLoaded(true))`, `.finally(setLoaded)`, and "never read `error`" all collapse
*unknown* into *zero*. The rendering layer then has no way to tell the two apart, and zero is the
value that reads as reassuring.
**Rule:** On every PR touching a read, ask **"what does this render if the fetch rejects?"** and then
**"is that rendering a claim the user would act on?"** A false *empty* is far more dangerous than a
false *error*, because the user's response to "nothing here" is to stop looking. Escalate to **High**
whenever the empty state (a) asserts a security fact — no sessions, no passkeys, nobody blocked, not
shared — or (b) **disables the control that would fix it**.
**Diagnostic:** grep for `.finally(` and `.catch(() =>` near a `setLoaded`/`setState(true)`; and check
whether a count derived from the empty array gates a `disabled=` prop.
**Also:** this is the lens that produced the sweep's only cross-slice duplicate. Two workers reaching
the same file from different PRs is a *signal the finding is real*, not noise — but it needs the
reconcile-before-filing step, or it becomes two tickets.

### !! Check whether the PR WEAKENED a test — a narrowed assertion is how the same bug returns unnoticed
**Saw:** A PR deferred a reset past a close animation and introduced a 300 ms window in which an
in-progress edit is blanked. The sharp part was not the bug — it was that the same PR **re-scoped the
regression test that guarded it**, from *"the close-time reset must not wipe it afterwards"* to
*"must not flip `open` back on"*, and did not add the new wait there. So the guarantee the test
existed to hold became **unasserted in the same commit that broke it**. A separate slice found a CI
PR whose fix for a flaky test was a **20-second retry loop** that re-opens and re-clicks a menu —
papering over a real product defect so CI stays green while users keep hitting it.
**Cause:** Test changes read as housekeeping. A reviewer scanning a diff for *behaviour* skims the
test files, and a narrowed assertion looks like a tidy-up rather than a removed guarantee. The two
failure shapes are: (a) an assertion made **weaker or differently-scoped**, and (b) a **retry/wait
added to absorb** a failure whose cause is in the product, not the test.
**Rule:** **Read the test changes as part of the review, and ask what each one stops catching.** For
every modified or deleted assertion: what did the old one guarantee, does the new one still guarantee
it, and is the thing it guarded exactly what this PR touches? For every added retry, sleep or
`waitFor`: is it absorbing product flakiness that should be a finding instead?
**Why it is worth a finding rather than a note:** these are the changes that decide whether the
*next* occurrence is caught. A bug filed and fixed comes back if the test that would have caught it
was quietly narrowed on the way past.
**Also:** a PR whose test change and behaviour change point at the same code path is the strongest
possible signal — the author was near the boundary and adjusted the fence rather than the field.

### !! The adversarial gate rescued 39 of 44 flagged findings — an 89% overturn rate, not the 2× over-condemn already on record
**Saw:** False-positive audit over 466 findings, 49 gate-1 auditors + 7 gate-2 recheckers. Gate 1
flagged 44 (9.4%). Gate 2, told to *prove the finding real*, overturned **39** and upheld **5**. Final
confirmed-bogus rate: 5/466 = 1.1%. Two gate-2 batches came back `upheld=0` — every single flag wrong.
**Cause:** gate-1 auditors judge one slice in isolation and reach for a verdict when the ticket is
*imperfect* — wrong line number, overstated severity, a file outside the PR diff. None of those make
a finding false. An earlier and much smaller run put the over-condemn factor at ~2× (28 flagged, 17
rescued). At 466 findings it was 8.8×.
**Rule:** never act on gate 1 alone — not at any scale, and least of all when its flag rate looks
"reasonable". The 9.4% flag rate looked healthy and was ~89% noise. Budget for gate 2 as mandatory,
not as a confirmation step. And when a gate-2 batch returns 100% overturned, that is a signal about
gate 1's calibration, not a lucky slice. `fleet check gate apply --verdicts <tsv>` refuses to apply a
`gate:failed` label from a gate-1-only verdict file.
**Proof:** `awk -F'\t' '$3!="real"' g1/*.tsv | wc -l` = 44; `cat g2/*.tsv | awk -F'\t' '{print $3}'
| sort | uniq -c` = 39 overturned / 5 upheld.

### !! Three quarters of the flags were "the file isn't in the PR's diff" on findings the auditor had just verified line-for-line
**Saw:** 33 of 44 flags were `out_of_scope`, 11 were `false_positive`. In nearly every
`out_of_scope` the auditor's own evidence field said "verified verbatim", "code matches the claim
exactly", "the defect is real". Gate 2 overturned 32 of 33.
**Cause:** the verdict vocabulary offered `out_of_scope`, so auditors used it as a place to put
"true, but I'd have filed it against a different PR". Worse, in at least six cases the PR's **own
body** had a `## Not in scope` / `## Follow-up` section naming that exact file — so the ticket was the
tracker for a deferral the author deliberately made. Cancelling it would have deleted the only record
of the author's own TODO.
**Rule:** attribution is not truth. For a MERGED PR the only question that decides a cancel is *is the
defect real and open in current code* — never *whose diff does it belong to*. Before flagging a
finding for scope, grep the PR body for `not in scope` / `follow-up` / `separate ticket`: if the
author named the file, the ticket is correct and the scope objection is backwards.
**Also:** don't offer `out_of_scope` as a first-gate verdict at all unless something downstream
re-attributes rather than closes. It reads as a rejection and gets counted as one.

### !! One category swallowed 57% of a slice and the neighbouring category collapsed to zero
**Saw:** Classifying 337 issues into 10 defect families. The taxonomy listed *"anything carrying the
security label"* as a criterion for category 1, and the taxonomy was precedence-ordered. Result:
`security` took **57% of the High band**, and `false-empty` — which the same document called *"the
signature family of this sweep"* — came back as 3, then 0, across two slices. Three separate agents
flagged it unprompted.
**Cause:** The criterion named a **label**, not a **harm**. Under precedence, a label then overrides
every subsequent category. A failed read rendering as an empty session list carries the security
label and sits on a security surface — but the harm is **the lie**, not a disclosure.
**Rule:** **A classification criterion must name a harm, never a label, a file path, or a surface.**
Labels are *signals* that inform the judgement, never overrides that replace it. State that
explicitly in the taxonomy, because a conscientious classifier will otherwise apply the literal rule.
Corrected wording: *"confidentiality, authentication or authorisation is **itself** what breaks."*
**Diagnostic — build the shape check into the brief:** *"if category X exceeds ~a quarter of your
slice, or category Y collapses to near zero, you are letting a label override the harm; re-read
against Y before settling."* All four workers ran that check and it caught the problem every time.
After correction: `security` 57% → 26.8%, `false-empty` 3 → 28 across the full set.
**Also:** This is the **same mistake** as classifying an everyone-harming bug as a11y because it has
a focus side-effect. Both are surface-over-substance. **Classify by who is harmed and what breaks,
never by what the defect touches or what it is tagged with.** And a refinement a worker drew: **auth
failing *closed* is not a security finding** — a lockout is correctness, a wiped healthy session is
data loss; only *fails-open* belongs in security.

### !! The audit gave the two most severe findings the LEAST scrutiny — it escalated doubt, not consequence
**Saw:** The false-positive audit sent only **flagged** findings to the adversarial gate. So a Low
that one agent found suspicious got two passes, while the sweep's only two **Urgent** findings got
**one each**, because no agent had doubted them. Verified both afterwards on six axes: both
**confirmed**, and both turned out to be *understated*.
**Cause:** the escalation rule keyed on the gate-1 verdict (`real` → done, flagged → recheck). That
is the right rule for finding false positives and the wrong rule for a security corpus, where the
cost of a wrong `real` on an Urgent is far higher than a wrong `real` on a Low.
**Rule:** ⛔ **Escalate on severity as well as on doubt.** Every `Urgent`, and every security-labelled
High (`checker.securityLabel`), goes to the adversarial gate regardless of whether gate 1 flagged it.
That is a handful of extra agents on a 466-finding corpus — 2 here — and it is the cheapest insurance
in the whole process.
**Proof of value:** neither verdict changed, but both re-checks materially improved the tickets — one
fix belonged in a shared helper serving three flows the ticket never mentioned; the other's stated
trigger was its *weakest* one. Both also contained a framing hazard that invited a working-as-designed
dismissal. A confirmed finding is not the same as an actionable one.

### !! Gating on doubt overturned 89%; gating on consequence overturned 0% — and only 2 of 24 tickets were accurate
**Saw:** Two gates over the same corpus, measured. **Doubt-driven** (recheck what gate 1 flagged):
44 flags, 39 overturned. **Consequence-driven** (recheck every Urgent and every security-labelled
High regardless of verdict): 24 findings, **0 false positives** — but only **2 confirmed as written**.
16 understated, 4 overstated.
**Cause:** they catch opposite errors. A flagged finding is one an agent already doubted, so the base
rate of it being wrong is high. A high-severity `real` finding is one nobody doubted — its errors are
not *falsity* but **scope, trigger choice, and prescribed remedy**, none of which a false-positive
hunt is looking for.
**Rule:** run **both**, and expect different yields. Doubt-driven protects against deleting true
findings. Consequence-driven protects against *fixing them wrongly* — which on this corpus was the far
more common failure: **7 of 24 tickets prescribed a fix that does not work**, including one whose
"obvious" remedy ships attacker-forgeable data into an approval prompt, one that fails open to the
exact state it was fixing, and one whose remedy does not exist in the library at all.
**Also — every `overstated` ticket hid a STRONGER trigger behind its weak one.** Three for three: an
attacker-controlled-height claim collapsed but the dialog is unreachable for *every* user under a
small viewport; an escalation claim collapsed but accepting writes bidirectional rows; a "purge the
artifacts" claim collapsed but the steps had moved to `if: always()`, so every *future* run leaks.
⛔ **Never downgrade on the headline alone — look for what the ticket found and mis-described.**

### !! My paraphrase of a ticket was less accurate than the ticket
**Saw:** Briefing a verifier, *"nothing requests the strongest file-protection class"* was compressed
into *"no file-protection class"*. The verifier flagged the paraphrase as the overstatement: the
platform still applies a default class, so the file is **not** unprotected at rest. The ticket's
original wording was precise; the brief's was not.
**Cause:** compressing a finding for a prompt drops the qualifier that made it survivable. The
qualifier is usually the part a reviewer will attack.
**Rule:** when briefing an agent about an existing ticket, **quote the ticket's own claim** rather
than summarising it, and tell the agent the quote is the claim under test. Otherwise you can hand it a
strawman and get back a refutation of something nobody filed.

### !! Two security claims were settled by RUNNING them, after prose had failed to settle either
**Saw:** two security claims — one about an input sanitiser, one about a layout bound — could not be
settled by argument; each was settled in minutes by executing it.
**Cause:** parser-differential and layout claims are empirical. Prose about them is unfalsifiable in
either direction, which is why both a finder and a checker can agree and both be wrong.
**Rule:** for a sanitiser, run the bypass strings. For a layout/overflow claim, measure the bound.
⛔ **And always test the ticket's *prescribed fix*, not just its claim** — a correct finding with an
insufficient remedy ships as a closed ticket and an open hole.

### !! A severity filed as an open question was wrong — one browser probe overturned it in four minutes
**Saw:** A High was filed with an explicit unresolved question about whether a queued storage delete
survives page teardown — noting the answer decides High vs Medium. Two agents had reasoned about it
and neither could settle it from source. Run in an actual browser instead: two probes on a neutral
origin, ~4 minutes. The delete survives and completes; a connection opened afterwards queues behind
it. **The ticket was downgraded by its own author, High → Medium.**
**Cause:** browser storage semantics — blocking, connection queues, what survives a navigation — are
cheap to *measure* and expensive to *argue*. Both agents produced plausible prose and neither was
decisive, because the question is empirical.
**Rule:** when a finding's severity turns on runtime browser behaviour, **stop reading and open a
browser**. Model the two roles on any neutral origin, reproduce the exact timings the app uses, and
read the result. Do not file the question as an unknown when the tools to answer it are already
attached — an unresolved severity in a ticket is a decision pushed onto whoever picks it up.
**Also:** the finding survived the downgrade. The code comment justifying the app's backstop was
**false** — the probe disproved it. The outcome is right by luck, not by the stated reasoning. A
defect can be real while the severity argued for it is wrong, and both halves are worth reporting.

### !! Three candidate defects came out of fix-planning; one was refuted, and it was the most convincing one
**Saw:** Writing fix specs surfaced 3 new candidates nobody had filed. Verdicts after an adversarial
pass each: 1 real (filed), 2 REFUTED. A 67% false-positive rate on findings discovered this way,
against ~1% on the swept-and-audited corpus. The refuted one was the one that read most like an
already-confirmed finding, because it pattern-matched an issue that *was* real. It died on two
independent grounds: the empty-context state is unreachable, **and** the path fails closed anyway.
**Cause:** fix-planning is a good defect *detector* and a bad defect *judge*. An agent deep in one
mechanism sees that shape everywhere, and the strongest false positives are the ones that resemble a
confirmed true positive.
**Rule:** findings discovered while doing something else get the **same** verification gate as swept
findings — no exceptions for "I found it while I was in there". Record them, then verify, then file.
Both refuted ones would have been filed on a single pass.
**Also:** the second refutation inverted the story — the claimed "verbatim repeat" of a confirmed bug
shared the skeleton but had **no skip condition at all**, so the exact place the bug lives is the one
place the two files differ. It was the *reference implementation* the buggy sibling had been fixed to
match. **A shape-level scan matches the skeleton and misses the structural difference.**

### !! A verified finding's stated BOUND was wrong, because the pass that set it never went looking for a second write path
**Saw:** An earlier verification pass on a ticket established a reassuring bound: *"at most one
record at rest"* — one key, overwritten each time. A later severity gate, asked a different question,
found a **second write path in the same feature**, keyed differently — so it is a growing map, not
one overwritten pair, and the cleanup never covers that key.
**Cause:** the first pass asked *"is this finding real?"* and stopped the moment it confirmed the cited
code. Bounding a defect ("at most one", "only on this path", "capped at N") is a **different and much
stronger claim** than confirming it, and it requires an exhaustive search the confirm question never
motivates. The bound was a by-product, asserted with the confidence earned by the confirmation.
**The false reading it produced:** the bound made the finding look *contained*, which is exactly the
kind of sentence that lowers a severity or defers a fix. A wrong bound is more dangerous than a wrong
claim, because it argues for inaction and sounds precise while doing it.
**Rule:** ⛔ **Never let a bound ride on a confirmation pass.** If you write "at most", "only", "capped
at", or "one", that clause needs its own exhaustive search — `git grep` every writer of the key, every
caller of the helper — and if you did not run it, write "at least" instead and say the upper bound is
unestablished. Confirming the cited line says nothing about the lines that were never cited.
**Also:** the same batch found this in two more tickets — one named 1 of 4 call sites, another named a
trigger whose contrast file is not even on `main`. Confirmation passes systematically under-count
reach.

### !! A "committed key" finding had its harm exactly INVERTED — it fails LOUD, and the gate caught it before filing
**Saw:** A candidate surfaced mid-gate: an example config ships a placeholder key, with no guard, and
the signature check it feeds is the sole authenticity gate. Framing: *"the placeholder that breaks
loudly is the API key; the one that breaks silently is this one — it works perfectly, for the
attacker too."* An adversarial verifier **refuted it**. Every technical sub-claim held. The **impact**
was the part that died: the placeholder was the **verifying** half, so an operator who leaves it
unedited ships a service that rejects 100% of legitimate traffic and surfaces on the first test
message — the loudest possible failure. The attacker cannot exploit it either.
**Cause:** "committed private key + no guard + sole auth gate" is a checklist that reads as critical,
and every item on it was TRUE. The harm direction was never checked. A placeholder *signing* key would
indeed be silently forgeable; a placeholder *verifying* key is a self-DoS.
**Rule:** ⛔ **For any credential-placeholder finding, name which HALF of the keypair it is before you
write the impact sentence.** Signing/private → forgeable, silent. Verifying/public → rejects
everything, loud. Symmetric secret → depends on direction of use. The checklist (committed? guarded?
sole gate?) establishes the *defect*; only the key half establishes the *harm*, and severity follows
the harm.
**Also — the process worked, and that is the point worth keeping:** earlier in the same run a finding
was filed at High on an unverified assumption and had to be downgraded. This time the candidate went
to an adversarial verifier *before* filing and never became a wrong ticket.

### !! Second candidate in a row refuted on HARM while its mechanism was entirely correct — both killed by finding the authoritative artifact on disk
**Saw:** A gate reported an out-of-bounds read in a native integration — version-gated struct fields
read with no version guard while the sibling function guards — with the garbage "dereferenced as a
pointer". The verifier found the **platform's own SDK header on the machine**, which states the
version mapping authoritatively: on every runtime the function's own version floor admits, the field
is **in bounds**. The premise needed a version the code already rejects. Pointer-deref: impossible.
**Cause:** the same failure as the previous refuted candidate. **The mechanism was real** — the guard
asymmetry exists, none of that was wrong. **The harm was assumed from the shape.** "Unguarded
version-dependent field read" pattern-matches to memory-unsafety, and the pattern-match was done
instead of the version arithmetic.
**Rule:** ⛔ **Verify the mechanism and the harm as two separate questions, and never let a correct
mechanism carry an assumed consequence.** Then: **when a claim turns on a platform's own contract —
struct layouts, API version floors, header constants — go find the authoritative artifact rather than
reasoning about it.** Also check evaluation ORDER: a fallible expression on an earlier field can
short-circuit the suspect read out of reach entirely.
**Also — the cost of getting this wrong is asymmetric and public.** The OOB claim had already been
written into a tracker comment before the verdict landed, and a retraction had to be posted on the
same ticket. File nothing, and write nothing into a ticket, on a severe-sounding incidental finding
until it has survived the gate — a retraction is cheaper than a wrong CVE-shaped ticket, but not free.

### !! A work-order written from an ungated finding was WRONG, and nothing downstream would ever have re-checked it
**Saw:** A six-heading implementation spec handed to a fixer was written before its source ticket
reached the severity gate. When the gate finally ran it returned `understated`, and the spec inherited
both gaps verbatim: its blast radius omitted a third site with the identical defect, and its
prescribed gate did not close the write path at all.
**Cause:** the pipeline ran **file → categorise → fix-spec**, with the severity gate as a *parallel*
branch rather than a *precondition*. So specs were generated from ticket text that had only ever
passed the "is it real?" check. Nothing in the process re-opens a spec when its source ticket is later
amended, and a spec reads as more authoritative than the ticket it came from — it is formatted as
instructions.
**The false reading:** 27 fix-specs existed and looked like progress. They were progress *conditional
on the tickets being right about reach and remedy*, which is exactly the property that had never been
tested. An `understated` verdict does not invalidate a ticket — but it does invalidate every artifact
derived from it.
**Rule:** ⛔ **Never generate an implementation spec from a finding that has not passed the severity
gate.** Make the gate a precondition of spec-writing, not a parallel track. This is why
`fleet.queue.requireGate` defaults to `true` and `fleet intake check` refuses a checker-filed ticket
without a `gate:*` verdict label. And when a gate later amends a finding, **grep the derived
artifacts for its key and append a correction block to each** — the spec, any batch/grouping file,
any summary. Check for *references* too: two sibling specs cited this one for grouping only, and were
correctly left alone.
**Diagnostic:** if you can produce a spec faster than the finding can be adversarially verified, you
are producing them from unverified input by construction.

### !! I filed two tickets AFTER learning the failure mode, and both reproduced it
**Saw:** By the time two more tickets were filed, 116 findings had gone through the gate and the
lesson had been written into the playbook: 81 of 116 understate reach, 30 overstate harm, only 5 are
accurate. Both tickets had already passed an adversarial verifier that judged them real, distinct and
correctly severed. They were gated anyway. **Both came back `understated`, with four factual errors
between them** — a filter described as an exclusion that is an allowlist; a UI marker described
wrongly; a "divergence between two surfaces" that is in fact a feature with no list route at all; a
cited line off by 270 and a prescribed fix that does not close the defect.
**Cause:** both tickets were written from **an agent's summary of what it found**, not from the code.
The verifier's job was "is this real and is it a duplicate" — it answered that correctly, and a yes
was treated as licence to write the ticket in the launcher's own words. Every one of the four errors
is a detail the verifier never asserted and the author filled in by inference.
**The false reading:** "this survived an adversarial verifier" felt like it discharged the obligation.
It discharges *existence*. Reach, mechanism, line numbers and remedy are a **different question**, and
being the author is not a substitute for having read the code.
**Rule:** ⛔ **Gate your own findings too, and brief that gate to be HARDER on them, not softer.** Say
in the prompt that you wrote it. Never let "I just verified this" exempt a ticket from the same pass
every other ticket gets — especially a ticket you wrote from a summary rather than from the file.
**Also:** this is the strongest evidence in the whole run that the failure mode is **structural, not a
quality problem with particular reviewers**. Knowing the statistic, having written the rule, and
having a verifier's blessing was still not enough. The gate is not there to catch careless people.

### !! A spec's "Risk / do NOT do X" section encoded the exact error — and pre-empted the reviewer who would have caught it
**Saw:** A fix spec prescribes gating an inbox on a `loaded` flag alone, and its Risk bullet 1 says
explicitly: *"Do **not** add an error channel to the shared context for this."* Verified at
`origin/main`: the context carries no error signal, and the availability flag is a local constant
that never reaches these components. So on a failed post-cache sync, `loaded` stays false permanently
→ **the prescribed placeholder never resolves.** The spec converts a false-empty into a permanent
spinner, and its Risk section **forbids the one change that would prevent that**. The
counter-precedent is 350 lines from the code being edited: *"spin only while the fetch is in flight,
and say so once it has failed rather than spinning forever."*
**Cause:** a "Risk" or "do not do X" bullet is written to pre-empt an objection, so it is read as
**evidence the author already considered that option and rejected it**. An omission invites a
reviewer to ask "what about the error case?"; an explicit prohibition closes the question before it
is asked. **A wrong constraint is more durable than a wrong instruction.**
**Rule:** ⛔ **Treat every "do NOT do X" in a spec as a claim requiring the same evidence as a "do X",
and check it against the code.** If a spec forbids a defensive change, verify the structure it
assumes. Ask specifically: *"if I obey this prohibition, what state can the UI reach?"*
⚖️ **Counter-calibration, so this does not become blanket distrust of specs:** in the same batch
another spec was **better than its own ticket** — it silently declined to adopt the ticket's remedy,
which would have broken a documented invariant. Specs are not uniformly downstream-degraded; they are
a second opinion that can improve on the finding, which is why the correction pass has to read them
rather than assume either direction.

### !! I verified the HARM of findings but accepted the harm-reasoning of REFUTATIONS unchecked
**Saw:** Two incidental candidates were refuted on harm grounds and both refutations were accepted,
correctly. A third refutation used the same shape — *"mechanism real, harm collapses: no email,
reversible, disclosed, it's what the user asked for"* — and it was accepted too, and **posted on the
ticket**. A later pass disagreed, so a tiebreak was run. **The refutation lost.** Two of its five
grounds were false: **"reversible"** — the removal path never touches the invitation or notification
rows, so the inbound request is consumed permanently; and **"disclosed"** — it is a bare integer shown
only conditionally, while the single-invite path names the person for the identical outcome. Decisive
fact neither pass raised: **the app demands an explicit Accept for this exact transition in two other
places.**
**Cause:** the rule "verify the mechanism and the harm separately" had been applied rigorously to
**findings**. A refutation is also a claim with a mechanism and a harm model — and its harm reasoning
was treated as a conclusion rather than as something to test. Worse, a refutation *reduces* work, so
it meets less resistance than a finding that creates work.
**The false reading:** two correct refutations in a row established the pattern as reliable. **The
third looked identical from the outside** — same shape, same confident enumeration of mitigations —
and the shape is exactly what carried no information.
**Rule:** ⛔ **Apply the same evidential standard to a refutation as to a finding, and check its
mitigations one at a time.** "Reversible", "disclosed", "already handled", "the user asked for it"
are each a factual claim with a file and a line. **And ask the question a refutation never asks: does
the app require an explicit confirmation for this same transition anywhere else?** An internal
inconsistency in the product is the strongest single signal, and no amount of mitigation-listing
surfaces it.
**Also — what saved it was disagreement, not diligence.** **When two of your own passes disagree,
that is data; adjudicate from the code, never from the two summaries** — and never default to the
conclusion you have already written down somewhere public.

### !! An agent I briefed to write my conclusions into a spec REFUSED one of them, and it was the one I had wrong
**Saw:** A spec-correction agent was told that `<component>:171-172` was "an unmentioned third site"
and to write that into the spec. The spec **already listed it**, in its blast radius, as
`<component>:168-173`. The agent verified the claim, found it false, and **wrote the discrepancy into
the block instead of the claim** — then separately verified the *site* and added only the detail the
spec genuinely lacked. The wrong version had already been published as a tracker comment.
**Cause:** the brief said *"verify each claim above before writing it; if one does not hold, say so in
the block rather than transcribing it."* Without that sentence the agent's job is **stenography**, and
a stenographer has no reason to check the dictation.
**The false reading:** by this point 130+ findings had been gated and the claim *felt* like
established fact rather than something inferred from a gate summary. Late-run confidence is the
dangerous kind: the evidence base is large, so individual claims stop getting checked.
**Rule:** ⛔ **When delegating "write my conclusions into a durable artifact", always instruct the
agent to verify each claim first and to REPORT discrepancies rather than transcribe them.** One
sentence in the brief. The failure it prevents is asymmetric: an unverified claim in a spec outlives
the conversation, outranks the ticket it came from, and reads as instruction rather than opinion.
**Also:** this was the third time in one run that an agent briefed to be skeptical caught an error of
the launcher's. All three were caught because the brief invited contradiction. **Brief agents with the
claim AND its provenance — "a prior pass concluded X, verify it" — never with X as background fact.**

### !! A finding I cancelled as a false positive contained a real bug that was its exact inverse
**Saw:** A ticket claimed a thread reset strands a second tab mid-stream. Refuted cleanly: the abort
signal is never passed, so the cancel is inert, the stream completes, and status returns to ready.
Cancelled (op-9).
**Cause:** the very fact that refuted it — *the stream completes* — is the mechanism of a different,
real defect. Because the turn survives the delete, the reply persists into the just-emptied thread
and broadcasts to every tab except the one that pressed Reset. Filed separately.
**Rule:** when a refutation turns on "X does not happen because Y happens instead", **spend one more
step asking what Y itself causes.** A gate that stops at `false_positive` throws away the evidence it
just paid for. Two of the five false positives in this pass had a live residue underneath; only one
would have been found by re-reviewing the PR from scratch.

### !! I nearly mapped every `overstated` verdict onto a priority downgrade, and 3 of them were not downgrades
**Saw:** one batch returned `ticket A — overstated → medium`, `ticket B — understated → medium`,
`ticket C — understated → medium`. All three inputs were already Medium. A ledger rule of "overstated
⇒ drop a band, understated ⇒ raise a band" would have made three wrong tracker edits.
**Cause:** **the verdict grades the ticket's claims; the second field grades the severity band.** They
are independent. A ticket can over-claim one detail while the remaining harm still prices as Medium;
another can understate *reach* without crossing into High.
**Rule:** read the **severity field**, never infer the priority change from the verdict word. Require
the gate's output format to carry both, and treat `overstated → <same band>` as a normal, expected
row — it means "the ticket is wrong about something that does not move the number".
`fleet check gate apply` takes the priority change from the severity column, never from the verdict
word.

### !! Two of the three items I escalated as "needs a human" were not judgement calls at all
**Saw:** The sweep closed with three items marked *"for a human, not for more analysis"*. Revisiting
them: one was answered in four minutes by one grep (an exact string-equality check makes the
cross-origin release impossible in either direction). Another was answered by reading five files,
becoming a new High. Only the third was framed as genuinely human — it asks how *likely* a
hand-edited value is to drift, which is a probability, not a fact.
**Cause:** two different things were conflated under one label. A **judgement call** needs a human
because it trades off values or estimates a probability the code cannot tell you. A **verification
question** just needs someone to read the code — it *feels* like escalation because it is open, but
the answer is sitting in the repo.
**Rule:** before writing "needs a human", ask **"is this a question about values, or a question about
the code?"** If the code can answer it, answer it — an unanswered verifiable question in a security
ticket is not escalation, it is an unfinished sentence that the next reader will have to finish.
Escalate probabilities, priorities and trade-offs. Never escalate "I did not check".
**Correction (same day, one item later):** the third item was *still* the wrong question. Reading the
code turned "how likely is drift?" into "what stops drift?" — and the answer was measurable and
damning: two safety properties read off the **same** string, five call sites with no type binding,
and the guard the source comment promises does not exist. Escalated Medium → High. **So all three
were answerable from the repo.** A probability question is often a *badly posed* question. Before
escalating "how likely is X", ask **"what prevents X?"** — that version usually has an answer in the
code, and if the answer is "nothing", the probability stopped mattering.

### !! "This needs a human decision" was itself a claim worth attacking — the two positions answered different questions
**Saw:** A class ticket framed keyed-remount vs permanent-mount of a live region as a genuine
deadlock: two defensible philosophies, ten tickets blocked, "not asserting which is right". Reading
both rationales side by side instead of as opponents: keyed remount answers *a repeated identical
message must still announce*; permanent mount answers *a first message must announce at all*. **They
are not alternatives.** A permanently-mounted region whose **content** changes per announcement
satisfies both. The decision shrinks to "key the wrapper or the inner text node".
**Cause:** the disagreement was catalogued instead of reading each side's stated *requirement*. Two
positions that sound opposed often constrain different variables.
**Rule:** **before escalating anything as "needs a human", restate each side as the requirement it is
defending and check whether one design satisfies all of them.** A deadlock is a claim like any other —
try to refute it.

### !! Two tickets in the SAME batch each prescribed the fix the other files as a defect
**Saw:** One a11y batch: ticket A's prescribed fix is "wrap the disabled control in a tooltip and a
span, as at `<page>:974`". Ticket B, judged **in the same batch of six**, files that exact
construction as the defect. Then it happened three more times across the pass — a live-region
pattern, a screen-reader-only duplication, and a busy-state attribute one ticket prescribes and
another disproves.
**Cause:** a sweep files one ticket per PR per candidate, and each finder sees only its own PR. Two
finders looking at opposite ends of the same pattern will independently write "do X" and "X is wrong"
— and **both tickets are individually correct.** Nothing in a per-ticket review can see it, because
the contradiction is not inside either ticket.
**Rule:** batch the gate **by category, not by PR**, and after each batch ask one question the
per-ticket pass cannot: *does any ticket here prescribe what another files as a defect?* Four of these
came out of 13 batches of six. A gate that judges tickets one at a time will find zero.
**Also:** the pairs were always adjacent in the category tree, which is *why* category batching
catches them — the same property that makes a category batch feel repetitive is what makes it work.

### !! The umbrella issue prescribed the remedy its own sub-issue files as a defect
**Saw:** The a11y umbrella governing **77 sub-issues** carried a "recurring shapes" table whose first
row prescribed a busy-state attribute on a plain control. Its own sub-issue (verdict `confirmed`)
files exactly that pattern **as the defect** — the attribute is not surfaced by any screen reader on
a plain button. A tree-wide grep for it on `origin/main` returns **zero files**. Three more
sub-issues had already inherited the remedy, and one cited it as an existing repo precedent that does
not exist.
**Cause:** every gate judged **findings**. Nothing judged the **umbrella**, even though it is the
first document a fixer opens and the only one whose advice reaches all 77 tickets at once. It was
written early, from the shapes visible at the time, and never re-checked against the verdicts that
came later.
**Rule:** **gate the guidance documents too — umbrellas, category parents, trackers — after the
findings are judged, not before.** A wrong finding costs one ticket; a wrong umbrella costs every
ticket under it. Diff each claim in the parent against the verdicts of its own children.
**Also:** the same umbrella's top "worth pulling forward" item cited a symbol at a path where it does
not exist, and justified it as *"found independently by three reviews."*

### !! "Found independently by three reviews" was three reviews making the same mistake
**Saw:** A ticket claims a shared search-input component hard-codes `tabIndex={-1}`, so a keyboard
user cannot complete a core flow. The umbrella escalated it as its #1 pull-forward item **on the
strength of the convergence**. A grep for `tabIndex` over the named shared-component file on
`origin/main`: **zero hits.**
**Cause:** the three reviews were not independent in the way that matters — they shared a prior (the
underlying library *does* pin focus to the input by another mechanism), and each inferred the same
plausible mechanism from it without opening the file. Agreement measured the prior, not the code.
**Rule:** **convergence is not corroboration when the reviews share a premise.** Treat "N reviews
found this" as a reason to check the *symbol*, not a reason to skip checking it — and record which
line of which file at which ref, so the next reader can refute it in one command instead of
inheriting the agreement.
**CORRECTION:** that grep is correct; **the conclusion drawn from it is not.** A *different* wrapper,
in another package, **does** hard-code `tabIndex={-1}` — a single instance, sitting before a props
spread, so it is already caller-overridable. The verification was scoped to **the path the claim
named**. Getting zero there proves the *location* wrong, not the *claim*. **To refute a claim, search
the whole tree; to refute its location, search the named path.** Never let the second stand in for
the first. What survives from the original entry: the reviews still get no credit for convergence —
all three named the wrong package, which is the same shared-prior failure. And the finding itself is
real; what was wrong was its address and the size of its fix.

### !! I indexed the corpus for `inert` and 21 of the 25 hits were the English word
**Saw:** building a construct index over 463 verdict rows to find cross-ticket contradictions, `inert`
returned 25 tickets — near the top of the frequency table. Only 4 concerned the HTML attribute; the
rest were prose ("the guard is inert", "semantically inert"). `aria-busy` (10) and `role=alert` (8)
were both **100% signal** and both yielded real findings.
**Cause:** index terms were picked by how often they appear in fix discussions, not by whether they
can collide with ordinary English. The highest-frequency term was the least useful one.
**Rule:** **index on tokens that cannot be prose** — `aria-*`, `role=*`, `data-*`, dotted API paths,
camelCase identifiers. A bare English word in the term list inflates its own cluster and buries the
real ones underneath it. Sort candidate clusters by **precision**, not frequency.

### !! I committed BOTH failures I had just written rules against, inside the guidance, within the hour
**Saw:** having corrected the umbrella's busy-state prescription, it was replaced with a
disabled-state attribute — **unconditionally**. Two verdicts refute the unconditional form: in one
component the native `disabled` prop is the **sole validity gate** and converting it ships a bypass;
in another the precedent applies the attribute *after* the press, so a control **born** disabled
needs no change at all.
**Cause:** it was accepted because **four gate notes independently converged on it** and because it
had **real in-repo precedent** — the two exact signals just written rules against ("convergence is
not corroboration when the reviews share a premise"; "existing precedent means a pattern is *used*,
not that it *transfers*"). Writing a rule does not inoculate you against the failure it names.
**Rule:** **gate your own edits to the guidance with the same index you ran over the tickets.** Treat
a change you make to an umbrella as a ticket: what does the corpus say about the construct you just
prescribed? It cost one pass over data already on disk and caught two live defects in the launcher's
own writing.
**Also:** the tell was that both edits were *replacements written in the same breath as the
diagnosis*. A remedy invented while indignant about the previous remedy gets the least scrutiny of
anything you write.

### !! Nobody had ever checked the one layer the whole gate rests on — the workers' own citations
**Saw:** after gating 465 findings, auditing the launcher's own filings, and gating its own edits to
the guidance, the **463 verdict rows** had never been checked at all. Every conclusion in the run was
built on line numbers written by 57 batch workers, and none had been verified.
**Cause:** every layer of the run was gated except the layer all the gates read from. Evidence
produced by subagents is treated as input, and inputs do not get audited.
**Proof:** extract every `file.ext:NNN` from the verdict prose (2,264 distinct, across
437 of 463 rows), keep only basenames mapping to exactly one file on `origin/main`, test
`cited_line <= file_length`. **1,219 of 1,232 resolve — 98.9%.** The 13 that don't are explained:
most overrun by 3-36 lines, the size of a PR adding code; the worst one resolved cleanly — the file
is 40 lines on `main` and 120 on the PR branch under review. **No evidence of fabricated coordinates.**
**Rule:** **verify the verifier.** When a run's conclusions rest on evidence produced by subagents,
machine-check that evidence's *falsifiable* part before publishing the conclusions
(`fleet check verify-citations --corpus <f> --ref origin/<base>`). Citations are ideal:
`cited_line <= file_length` is one pass over the tree and needs no judgement.
⛔ **And state the test's limits or the clean negative is worthless:** it catches invented coordinates
only — a wrong-but-in-range citation passes, and on a sweep of open PRs the branch-only files are a
large systematically-excluded slice. It is a soundness FLOOR, not proof of accuracy.
**Also — fifth instance of the loose-match-produces-a-wrong-count error, caught this time.** The
first run reported 33 overruns; 20 were basename collisions against generic names (`index.ts`)
matching unrelated files. Same diagnostic as always: tighten the match and see whether the number
moves. It did, so it was a guess.

### !! The evidence's line numbers drift ~1 in 6, but nothing in the sample was invented
**Saw:** the coordinate check stated its own limit — a wrong-but-in-range citation passes it. Closed
that by reading a **machine-spaced sample (every 182nd of 2,375 instances, n=13)** and judging
whether the cited line supports the claim. **Result: 10 of 12 resolvable citations exact, 2 with the
right substance at the wrong line (off by one; off by six), 0 false claims.**
**Cause of the drift:** analysts read a file, describe a construct correctly, and transcribe the line
from a neighbouring one — the same off-by-a-few you get from any human reading a diff.
**Rule:** **treat cited line numbers as approximate and cited *substance* as load-bearing.** When you
re-derive a finding, grep for the quoted symbol rather than jumping to the line; the symbol is
reliable, the coordinate is ±10. And when you cite in your own output, quote the snippet as well as
the line, so a reader can find it after either drifts.
⛔ **State n.** 12 resolvable citations puts the drift rate somewhere between ~2% and ~45% — it
establishes *that* coordinates drift, not *how often*. The firmer result is the negative: **nothing in
the sample was invented.**
**Also:** one apparent overrun turned out to be a correctly-labelled branch citation — the verdict
itself said *"Confirmed on PR head"*. **Read the claim before calling a citation wrong.**

### !! My own gate note quoted the line that supported the complaint and skipped the comment that answered it
**Saw:** A residue note said a "clear data and sign out" action leaves a still-valid server session
*"while the user was told at `:272` that this 'clears what it saved here'"* — framed as a false
promise. The behaviour verified exactly. **But six lines below the quoted code, a `// Deliberately NOT
done here:` block** gives a real reason (the screen cannot import the modules that would do it) and
states that the copy was scoped to match. Re-reading `:272` — *"signs you out of the app **on this
device**"* — it never claims server-side revocation.
**Cause:** reading stopped at the end of the *statement* being checked. The counter-argument was in
the next comment block, in the same function, unread.
**Rule:** **read the whole function, not the lines your claim needs** — and specifically **read the
comments around a deliberate-looking omission before calling it an oversight.** A `// Deliberately
NOT done here:` block is the author answering your question in advance.
⛔ **This is the exact failure this audit catches in other people's tickets** — "the PR's own comment
refutes the ticket" appears repeatedly in these verdicts. **Committed by the gate itself.** An auditor
is not exempt from the failure they are auditing for.
**What survived:** the deliberate list names one surface and not another, which nothing in that file
messages. A documented trade-off on one surface, an unconsidered one on another — narrow, and not
what the note claimed.

### !! Re-reading found nothing; trying to REFUTE the same ticket found a wrong citation in one pass
**Saw:** A self-filed ticket had been self-verified before filing, flagged as weaker than an
adversarial gate. Going back **specifically to break it** — not to re-read it — the core finding
survived but the severity sentence did not: it attributed one code path's version constant to the
other path. The suggested fix also named constants the file does not define at all.
**Cause:** verification asks *"is this true?"* and stops when the mechanism checks out. **Refutation
asks *"what would make this wrong?"* and goes looking at the numbers around the claim** — which is
where the error was.
**Rule:** **for anything you file yourself, do a second pass whose stated goal is to REFUTE it.** Not
re-read — refute. Attack the reachability sentence and the constants specifically: those carry the
severity and get the least scrutiny because they are not the mechanism.
✅ **The finding got sharper, not weaker.** A refutation attempt that fails usually improves the ticket.
⚠️ Re-reading would have found nothing. The sentence is fluent and internally plausible; only going
after the number exposed it.

### !! I verified the half of the mechanism I could see and INHERITED the half I could not
**Saw:** A self-filed Medium claimed a stale entry is reused under the same key by a later flow,
mixing two records. The deletion gap had been verified exactly. **Nobody had checked how the key is
generated.** It bakes a timestamp in, and the generator runs per scan — so every scan mints a new
key, the lookup misses, and there is no carry-over. **The headline outcome cannot happen.** Retitled,
downgraded, rescoped to what survives: entries accumulate and are never read again.
⛔ **And the same assumption was inherited from the host ticket**, whose title asserted the stable
key. The gate verdict on that ticket had refuted a different claim and **taken the stable-key premise
at face value**. Both tickets were corrected.
**Cause:** the deletion gap is visible in one file and verifiable in ten seconds. The key-stability
assumption sits one file away and looks too obvious to check — and it arrived pre-approved in the
ticket's title.
**Rule:** **a mechanism has as many halves as it has nouns.** "A stale entry is reused under the same
key" is two claims: *the entry survives* and *the key repeats*. Verify each in its own file. **The
half you inherit from the ticket's framing is the one that will be wrong**, because it is the half
nobody has re-derived.
⚠️ Three refutation passes, three finds, escalating: a wrong constant → an unclosed assumption → a
filed Medium whose central mechanism is invalid. Verification found none of them.

### !! "This code path exists" is not "this code path is reachable" — twice, right conclusion, wrong mechanism
**Saw:** two self-filed tickets had correct outcomes reached through mechanisms that cannot occur.
One said a broadcast drops on closing/closed sockets — real branches — but the factory **evicts** a
closing/closed socket and replaces it, so the loop only ever sees connecting or open. The outcome
survives via the **connecting** path (a fresh socket that never opens, message silently gone), but a
fixer reading the description would hunt for a closed socket, fail to find one, and close the ticket.
**Cause:** verification confirms *the branch is written* and stops. **Reachability is a different
question** — *how does the program get into that state?* — and it usually lives in a different
function from the branch.
**Rule:** for every conditional your finding depends on, **name the caller that puts the program in
that state**. If you cannot, the branch may be dead. ⛔ **A finding with the right outcome and the
wrong mechanism is more dangerous than a wrong finding**, because it reads as verified, survives
review, and wastes the fixer's time at exactly the moment they trusted you.
✅ Both survived once re-derived — the corrections made them *narrower and more accurate*, and one
got worse: because dead sockets are replaced, **every** retry during an outage takes the silent path.

### !! Three times I wrote "the only option is X" and missed a control in the same function
**Saw:** three self-filed tickets claimed a dead end that was not dead: *"the UI waits
indefinitely"* — a cleanup settles the waiter on reload; *"closed sockets are silently dropped"* —
the factory evicts and replaces them; *"the only clean escape lies to the model"* — the catch
re-enables the retry control two lines below the pasted code. **Every one of the missed escapes was
visible in the same function as the code quoted.**
**Cause:** when a finding is about *what does not happen*, attention goes to the absent thing, and
the surrounding lines are read as context rather than as candidate escapes. **You are scanning for an
absence, so a present control does not register.**
**Rule:** **whenever a finding contains "the only", "never", or "no way to", stop and enumerate the
controls still on screen and the lifecycle events still pending** — retry buttons, reloads, unmounts,
cache eviction, focus/visibility handlers. Write the list into the ticket even when it is empty; that
is what tells a reader you looked.
⚠️ None of the three findings died — but two would have wasted a fixer's time, because the mechanism
they were told to look at was not the one that fires.

### !! I filed a real bug against a file that has two guards against it, because I quoted a grep hit
**Saw:** A ticket claimed `<handler>:127-129` stamps a resolution after a losing decline. Reading the
function from its signature instead of from the grep hit: an earlier select cannot match (the accept
already nulled the column) and throws before `:127`; and the helper it calls carries its own
`resolved_at` guard. **Two independent guards, both above or beside the lines pasted.** The bug was
real — the helper has a **second caller** whose final update has no guard. Its own doc comment named
that caller; the comment was read and not followed.
**Cause:** the grep landed mid-function, and the quote came from the landing point. A grep hit has no
scope; the function does. **Everything between the signature and the hit is invisible to grep and is
exactly where guards live.**
**Rule:** **read from the function signature down to the line you intend to quote, every time**, and
when a helper's doc comment names other callers, **check each one** — the unguarded caller is the bug.
⚠️ **This is the failure mode that gets a real bug closed as fabricated:** a fixer opens the file you
named, finds the guard, and stops. **A wrong `Where:` is worse than a vague one.**

### !! A prescribed fix that "just shows a message" needed facts the client does not have
**Saw:** A ticket offered three fixes and recommended the third as *"the smallest and the only one
that is purely additive"*: show *"You've muted these in the app"* when a push deep-links to a
notification the sync withheld. **The client cannot know that.** It has an id absent from a list, and
absence has four causes. The field that says *why* travels only with the row that was withheld, and
there is no single-item read endpoint. Option 3 needs a new server signal, so it was neither the
smallest nor additive.
**Cause:** the fix was reasoned about from the **server's** knowledge, because that is where the
reading had just been. The message renders on the client.
**Rule:** **for any fix that renders an explanation, name the field it reads and where that field
comes from.** If the answer is "the server knows", the fix is a protocol change, not a UI change.

### !! I nearly refuted a real "silent failure" finding with a global handler that shows nothing
**Saw:** a finding about silently swallowed failures was nearly refuted by pointing at a global error
handler whose name promised user-facing reporting; following it to its call site showed it only
**logs and reports telemetry — nothing rendered**, and its "expected error" classifier skips the
whole class the flow actually returns. So the attempted refutation **strengthened** the ticket
instead.
**Also inverted:** a client function throwing a plain error on `!res.success` has no status, so it
DOES reach telemetry, while a well-formed HTTP 409 does not. **The better-behaved server response is
the one that vanishes.**
**Cause:** the handler's name sounds user-facing. The name was about to be accepted as the
behaviour.
**Rule:** **"there is a global error handler" is not "the user is told."** Follow the handler to a
line that renders something. And check what it *excludes* — an error classifier that skips 4xx skips
precisely the errors a well-built API returns.

### !! I argued instance B was worse than instance A with no code behind the distinction — and got lucky
**Saw:** A ticket claimed three notice rows "render together", unlike a sibling ticket's instance
which is "one at a time". All four files live in the same directory, so on the face of it they are
dispatched identically. **It survived only because a real predicate exists** — a filter in the parent
partitions credentials on the very property asserted. Two supporting claims WERE wrong, found the
same way.
**Cause:** a difference observed in the rendered UI was generalised into a claim about the code,
without finding the branch that produces it.
**Rule:** **when you claim two instances differ, find the line that makes the difference.** If it
exists, the distinction is a fact and the ticket gets better evidence than it started with. **If you
cannot find it, the distinction is a story** — drop the comparison or drop the ticket.

### !! A "why this exists" header comment is a testable claim about coverage, and it was half wrong
**Saw:** A module opens by explaining that a card gated only on `!data` "spins forever" on the 404
the endpoint was changed to return, which is why the error flag exists. **That reasoning holds only
for a user with no cached data.** For a returning user the cache retains the last successful `data`,
so the computed error is handed to the `empty` prop and discarded — the list renders, and the 404
message never appears. **The PR's own target case is the one still broken**, and now it fails
silently instead of spinning, which is harder to notice.
**Cause:** the header was read as context. It is an assertion about which states are covered.
**Rule:** **treat a "why this exists" comment as a claim to test** — take the case it names and walk
it through *every* state the component can be in, not just the one the author had in mind. The
author's blind spot is documented in their own comment.

### !! I cited a helper as an in-repo precedent; it exists only on an UNMERGED PR branch
**Saw:** A suggested fix said *"this is the pattern PR B already uses, so there is an in-repo
precedent to copy."* `git grep <symbol> origin/main` returns **zero hits**; the bundled metadata says
`state: OPEN`, `mergedAt: null`. **A fixer greps main, finds nothing, and either stops or builds a
parallel mechanism.** A corpus grep found a second ticket making the same citation.
**And the follow-on error was worse than the dead reference.** Having found no precedent, a different
in-repo mechanism was substituted as "the real precedent, stronger than what was prescribed". **PR
B's description explicitly rejects that approach for this page**, with a reason. The team's considered
refusal was recommended back to them as an improvement.
**Cause:** code was read without asking **which ref it lives on**, and an approach was cited without
reading **what its author decided and why**.
**Rule:** **a symbol on an unmerged PR branch is not an in-repo precedent.** `git grep` it on
`origin/<base>` before writing "already uses"; if it is PR-only, name the PR and its state and call it
a proposal. **And when a PR touches the same file, read its description for a rejected alternative
before recommending one** — the reason is usually recorded.
⚠️ **Silver lining worth keeping:** discovering the PR made the ticket CHEAPER — it adds the mechanism
to the very file, so the fix becomes "reuse it", plus a sequencing note so the two do not collide.

### !! The guidance layer was sloppier than the tickets it was auditing
**Saw:** the **filed ticket** opened with `**PR:** <link> *(open at time of review)*` — correctly
qualified. The **gate comment** on that same ticket said the PR "handles it", unqualified, and a
sibling ticket's fix said "the pattern PR B **already uses**". **The layer written to catch errors
introduced the error.**
**Cause:** the filing template forces a `PR:` line with the PR's state; gate comments have no such
slot, so provenance silently drops.
**Rule:** **apply every rule you enforce to your own commentary**, and when a template forces a piece
of provenance, carry that field into anything derived from it. A corpus audit should grep **your own
notes** first — they are the newest and least reviewed text in the corpus.

### !! "Say both" is not enough — residue on a downgraded ticket dies when that ticket closes
**Saw:** the gate's rule for an `overstated` verdict is *"say both"* — state what collapsed AND what
survives. It did that faithfully across 463 verdicts. A scan for residue language then found **67
rows on `overstated`/`false_positive` tickets**; a machine-spaced sample of 9 showed 6 carrying a
distinct defect, not a correction to the ticket's claim. The worst was a record saved against the
wrong owner — a finding that **existed nowhere but a comment on a ticket marked `overstated` with a
no-op prescribed fix**, i.e. first in line to be closed.
**Cause:** "say both" places the residue correctly for a *reader of that ticket* and catastrophically
for the *lifecycle* of the finding. A comment inherits the fate of its host issue.
**Rule:** **when a gate downgrades a ticket, promote any DISTINCT defect it discovered to its own
ticket at that moment** — and cross-link (op-25), so closing the host does not silently close the
discovery. Residue that is a *correction to the ticket's claim* stays put; residue that is *a
different defect* must leave.
⛔ **And do not extrapolate the sample.** 6 of 9 does not license filing ~40 tickets against 67 rows.
Verify one end to end, file that, and hand the pool over with the derivation attached.
**Diagnostic:** grep the verdict corpus for `unfiled|undisclosed|the ticket does not name|misses` and
split by verdict. The `overstated` slice is the at-risk pool — it is the one whose hosts get closed.

### !! Verifying my own security shortlist: 1 confirmed, 1 refuted, and BOTH had a wrong file path
**Saw:** before handing over 35 promoted-residue items the six flagged as security-relevant were
verified. The first two landed opposite ways. One cited a path under `example/plugin/` where the named
lines sit inside a test module and the key symbol appears **zero** times — **the first grep therefore
"refuted" it.** Widening to the whole tree found the real file under `example/native/`, where the
claim is exactly right. **Filed High.** The other reasoned that a programmatic close means the
framework never fires the change handler, so `reset()` never runs. **Premise true, conclusion
false**: `reset()` is not on the close path at all — the dialog's own submit calls it right after the
confirm resolves. **Refuted and withdrawn.**
**Cause of the second error:** reasoning about a *framework's* semantics instead of checking **where
the function is actually called from**. The close handler was a plausible home for `reset()` and not
the real one.
**Rule:** **verify the call site; never infer it from the framework's behaviour.** And when a claim
names a path that comes up empty, **widen to the whole tree before concluding "fabricated"** — this
is the third time a wrong path nearly buried a true finding.
⛔ **A residue item is a LEAD, not a finding.** Two of two verified had a wrong path; one looked
fabricated and was real, the other looked reasoned and was wrong. **That asymmetry is the whole
argument for handing over a classified list instead of filing 35 tickets.**

### !! "Verified" and "worth filing" are different tests, and collapsing them makes a ticket factory
**Saw:** promoting residue from downgraded tickets, five items were verified as true and **four**
filed. The fifth was exact — two early returns leave a row in `loading: true` — **but the note said
"forever" and that was wrong**: reopening re-runs the loop, so the row settles when the sweep reaches
it. A stale spinner for part of one sweep, no data or security consequence. **Recorded on the host
ticket, not promoted.**
**Cause of the near-miss:** verification has momentum. Four confirmations in a row build a rhythm
where the next confirmation *feels* like it produces a ticket, and the question "does this deserve a
queue entry?" stops being asked separately.
**Rule:** after confirming a residue item, ask the **second** question explicitly: *what does a fixer
do differently because this exists as its own issue?* If the answer is "nothing they wouldn't do
while in the file anyway", **write it on the host ticket and move on.** A gate that files everything
it confirms is a ticket factory, and the over-production is the exact failure the gate exists to
prevent.

### !! Three of my own residue notes over-claimed permanence, in a run auditing for over-claimed permanence
**Saw:** verifying promoted residue, the same distortion appeared three times — **in the launcher's
own writing, while running an audit whose Medium brief lists "over-claimed permanence" as failure
shape #3**: *"forever"* → the loop re-runs; *"silently **retire** the user's live alerts"* → nothing
is deleted, the next focus revalidates; *"the user was told this clears what it saved here"* → the
function's own comment states the reason and confirms the copy was scoped to match.
**Cause:** the strong word is doing the promotion. "Forever", "retire", "was told" are what make a
note *feel* like it deserves its own ticket; each was written at the moment of discovery, when the
failure looked maximal and the recovery path had not been traced yet.
**Rule:** **grep your own output for permanence words before promoting anything** — *forever,
permanently, never, always, retire, lost, cannot* — and for each one, find the code that would undo
it. If you cannot find that code, say you looked. **A finding whose severity rests on an adverb is
not verified.**
⛔ **And note the asymmetry that makes this cheap to fix:** all three were still REAL defects.
Removing the adverb did not remove the finding — it moved it from "file a ticket" to "note on the
host". The cost of the distortion is not false findings, it is **queue inflation**.
**Also:** one note "corrected" the ticket's line cite to a range that is a **type declaration**. The
correction was as wrong as the cite it corrected — check the correction, not just the claim.

### !! A residue item about an UNMERGED PR's change is not promotable, and the check is one grep
**Saw:** A residue note said two workflow steps *"moved from a publish-gated condition to
`if: always()`, so diagnostics now upload on publish runs too."* On `origin/main` both uploads are
**still** gated, `if: always()` does not appear in that file at all, and no fetched remote branch has
a version containing it. The change exists only in the PR under review.
**Cause:** the sweep reviews open PRs, so a verdict legitimately describes *the state the PR
creates*. Promoting that into a standalone issue produces a ticket whose code is already correct on
`main` — a fixer opens it, finds the gating intact, and closes it as invalid.
**Rule:** **resolve every residue claim against `main` FIRST.** If `main` already looks correct, the
finding is about the PR, belongs on the PR-review ticket, and **must not be promoted**. One grep
separates "existing defect" from "defect this PR would introduce", and only the first is a standalone
issue.
⛔ **Do not mistake this for a refutation.** The finding stands on its own ticket — the objection to
the PR is unchanged. What fails is the *promotion*, not the claim. Record it that way, or you will
look like you overturned a colleague's correct review.
**Diagnostic:** `git show origin/<base>:<file> | grep <the-old-form>` — if the old form is still
there, the claim is about a branch.

### !! Half of what I classified as promotable was not, and the error only ever ran one way
**Saw:** after triaging 67 residue rows into 35 "distinct defects", 24 were verified. **Exactly half
produced a ticket.** The other twelve split into: 3 refuted, 3 describing code not on `main`, 2
reclassified as never-distinct, 4 confirmed-but-too-small-to-queue.
⛔ **Every misclassification ran the same direction — toward promotion.** A second site of the same
defect and a warning about a prescribed fix both moved promote → stay. Neither moved the other way.
So "35" was an over-count, and the bias is systematic rather than noise.
**Cause:** at triage time the residue text was available and the code was not. Residue prose is
*written to be alarming* — it is the analyst flagging something — so reading it without the file
makes almost everything look standalone. The boundary between "different defect", "wider scope of the
same defect" and "warning about the fix" is only visible with the source open.
**Rule:** **a triage produces CANDIDATES, and the promote/stay call needs the file open.** State the
triage number as provisional, expect it to fall, and **report the drift** rather than quietly filing
the original count. If you must publish before verifying, say "≤35" not "35".
✅ **The payoff is measurable, not theoretical:** filing the 35 on sight would have produced **twelve
invalid or unwanted tickets** — six sending a fixer to code that is correct or absent, six adding
queue noise. Verification cost roughly one grep and one file read each.

### !! For any "setting A plus setting B" finding, confirm the UI actually OFFERS the combination
**Saw:** a residue note claimed two independent preference filters could combine into a state the
user is notified about but cannot view. Both filters verified. **But the finding only exists if a
user can actually reach that combination.** One grep settled it: both states are declared
independently and the settings page renders a separate toggle for each. Reachable by design. Filed.
**Cause of the near-miss:** a two-setting interaction reads as a defect the moment you confirm the
two code paths differ — and that is only half the claim. **Had the UI coupled the toggles, or exposed
only one, the whole thing would have been a theory** and the ticket unreproducible.
**Rule:** **for any finding of the form "state A plus state B", verify a user can produce A and B
together** before filing. Usually one grep for the control that sets each. This is the cheapest
defence against an unreproducible ticket, and it is separate from verifying the mechanism.
✅ When the combination IS reachable, say so with the evidence — it converts "I think this can happen"
into "here is the toggle that makes it happen", which is what stops the ticket being closed as
speculative.
**Also:** this residue was stronger than its own host ticket, whose trigger was a race. **A finding
that needs no race beats one that does** — when both live in the same verdict, promote the one with
the weaker precondition.

### !! A residue item's best outcome can be neither "file" nor "drop" — it can be evidence on a ticket you already filed
**Saw:** A residue item looked like another sequential-confirmed-delivery defect and was queued for
promotion. Verifying it, an import routine restores rows in a **sequential loop** with confirmed
delivery — exactly the waiter mechanism already filed as ticket A. Filing it separately would have
produced a duplicate. **But it is not merely a duplicate**: it changes what ticket A means. That
ticket describes one control hanging; this call site shows that if the waiter never settles on the
first row, **every remaining row of the import stalls behind it** — and the loop runs before any
plain request, making it reachable offline, the condition under which the store is most likely to
fail in the first place.
**Cause:** the promote/drop framing offers two outcomes, so an item whose real value is *to an issue
that already exists* has nowhere to go and gets forced into one of them — filed as a duplicate, or
dropped as "already covered".
**Rule:** before promoting, check whether the item is **the same defect at a worse call site**. If it
is, put it on the existing ticket as evidence (op-11) and **say what it changes about the priority**
— do not open a second issue, and do not drop it as "already covered". **"Already covered" loses the
amplifier.**
✅ **Three outcomes, not two:** file / drop / **strengthen something already filed.** The third is easy
to miss because both other options feel like a decision and this one feels like nothing happened.

## Filing & reconciliation

### !! Filing cost explodes if you upload one screenshot per ISSUE
**Saw:** The documented embed flow is create → upload → embed, per issue. At 3 tracker round-trips
per finding, a 300-finding sweep is ~900 calls, and the create echo alone returns the entire issue
body every time.
**Cause:** The flow is written per-attachment, but findings cluster: several findings from the SAME
PR share ONE screenshot of the same screen.
**Rule:** Upload **once per screenshot** (op-22 `attachImage` returns `{url, embed}`), then reuse the
returned URL verbatim in every sibling finding's description. Best order per PR: create the first
issue, upload its shot, then create the remaining issues with the embed already inlined in their
descriptions — one upload, zero extra round-trips.
**Also:** Some trackers append a short-lived signature to the asset URL when they echo the stored
description. Store the **bare** URL; the tracker re-signs on read. Do not copy a signed URL forward.

### !! 13 subagents wrote 136 issues in parallel with zero collisions — the "workers never touch the tracker" rule was too broad
**Saw:** Prior guidance said workers return a findings package and the orchestrator files everything,
because *"parallel workers writing the same description clobber each other"*. Filing 136 findings
serially from one session is hours of round-trips. 13 subagents on disjoint slices instead: **136
created, 0 failed, 136 unique keys, 136 unique fids**, no duplicates and no clobbering.
**Cause:** The original rule generalised from a real incident about **concurrent edits to ONE
description** (the tracker checklist) into a blanket ban on workers touching the tracker at all.
Creating *distinct* issues has no shared mutable state, so it parallelises cleanly. The dangerous
operation was never "write to the tracker" — it was "write to the same row".
**Rule:** Workers **may** create their own issues in parallel (op-13). What stays exclusive to the
launcher is anything that mutates **shared** state: the checklist description (op-27 is launcher-only,
ALWAYS), the umbrella parent, label creation (op-18), and any issue a worker did not itself create.
Give each worker a disjoint slice file and a private output ledger under `filed/<slice>.tsv`
(`fid → key`, appended one line per create), then reconcile by set-difference on `fid`
(`fleet check reconcile filed`).
**Proof:** `cat filed/*.tsv | cut -f2 | sort -u | wc -l` == `cut -f1 | sort -u | wc -l` == row count
== slice total. All four agreeing is what makes "0 failed" believable rather than asserted.
**Also:** Give workers a **stable `fid`** (`fleet check fid mint <slice> --count N`) rather than
matching on title. Title-similarity dedup mis-scored 28 of 100 earlier in the same sweep; an opaque
key cannot drift.

### !! A worker reports "rate limit exceeded — attaching links too often"
**Saw:** With 13 filing subagents creating issues concurrently, op-13 returned a failed-links warning
on some creates. The **issue itself was created correctly** every time; only the sidebar link
attachment was dropped.
**Cause:** The tracker rate-limits attachment creation separately from issue creation, and it is a
**per-workspace** budget — so it scales with total concurrent filers, not with any one worker.
**Rule:** Treat a failed link as **cosmetic and separately retryable**. Never re-create the issue —
that is how duplicates appear. A follow-up op-8 `attachLink` succeeds once the window clears. Tell
workers this explicitly in the brief, or they will retry the whole create.
**Also:** Most trackers auto-render a bare PR URL in the description body as a native embed, so the
PR stays reachable from the issue even when the attachment never lands.

### !! Filing workers each burned 20+ minutes of wall-clock on a cosmetic field
**Saw:** With 13 filers running and the link rate-limit firing, workers dutifully retried with backoff
— one waited ~20 minutes across three sleeps, another gave up after a final 10-minute wait. Several
`tool_uses` counts were inflated by pure waiting (53 calls for an 8-issue slice).
**Cause:** Two compounding mistakes. (1) The budget is **per workspace**, so it shrinks as the fleet
grows — exactly when each worker independently decides to wait it out. (2) The brief said "retry",
without saying **how important the thing being retried was**. A conscientious worker will burn
unbounded time on any instruction that does not carry its own priority.
**Rule:** In any fan-out brief, mark every retryable failure as **blocking** or **cosmetic**, and say
so explicitly. For links: *"ignore the failure, do not sleep, list the affected keys in your summary;
the launcher sweeps them at the end."* Then do one serial cleanup pass, where waiting is free because
nothing depends on it.
**Diagnostic:** A worker reporting far more `tool_uses` than its slice has items is waiting, not
working. Message the fleet mid-run — a message reaches a running agent at its next tool round and
they stop immediately.
**Proof (confirms the mechanism):** the deferred cleanup attached **42 of 42 links, 0 failures, zero
rate-limit responses**, run serially by a single agent after the fleet went idle. The same operation
that cost 13 concurrent workers 20+ minutes each cost one serial agent nothing. The limit is
contention, not throughput: **defer, don't retry.**

### !! The "already filed" index drifts, and the failure mode is DUPLICATE filing
**Saw:** Mid-sweep a hand-appended `filed.txt` (issue key | PR | title) was kept and the findings
queue diffed against it to decide what was left. After ~15 filing batches it reported findings as
unfiled that had demonstrably been created minutes earlier — four keys were simply never appended.
Rebuilding the index from op-16 on the project showed **87 filed** where the file claimed 83.
**Cause:** The index was maintained by hand, in a separate step from the write it was supposed to
track. Any batch where filing happened and the append did not silently desynchronised it. This is the
mirror image of the ledger rule (append the moment the work resolves) applied to the wrong artefact —
the ledger was disciplined, the index was not.
**Rule:** **Never track "what have I already created" in a file you maintain by hand. Reconcile
against the system of record** (`fleet check reconcile tracker`). Do that reconciliation at the START
of every filing batch, not once.
**Why it matters more than a miscount:** an under-reporting ledger loses work; an under-reporting
*filed index* **creates duplicates in the tracker** — the exact thing the cross-sweep dedup note
exists to prevent, arriving from a different direction.
**Also:** the reconciliation is cheap and self-correcting. It also catches issues filed by a
*previous* session of the same sweep, which a hand-kept file in a dead session's context cannot.

### !! The forced-Low a11y rule buries real bugs unless you first ask WHO the defect is about
**Saw:** The operator's standing rule: an issue labelled with either a11y label is forced to the
lowest priority (`checker.a11y.forcedPriority`). Applied to the worker's raw a11y-class field, that
rule sent several genuinely severe findings to the bottom of the queue — a permanent focus loss on an
error path, a reveal toggle unreachable and unnamed on *every* secret field. It also nearly buried
two findings whose primary harm has nothing to do with assistive tech: a pending item showing no
sender at all (everyone is affected; the unnamed buttons are the a11y half), and a menu unmounting
mid-interaction (everyone loses the menu; the focus drop is the a11y half).
**Cause:** The a11y class answers "does this finding touch an a11y surface?", but the rule needs "**is
this defect ABOUT keyboard or screen-reader users?**" Those differ constantly. A functional bug with
an incidental focus side-effect scores `keyboard` and is not an a11y issue; a hoverable-tooltip
failure affects low-vision pointer users and is neither class, so it correctly escapes the rule.
**Rule:** Before applying the label, ask **who is harmed if this is never fixed.** Label + force Low
only when the answer is *only* keyboard users or *only* screen-reader users. When a defect harms
everyone and merely also has an a11y dimension, file at true severity and describe the a11y dimension
in the body. *(Superseded in part by the next two entries — the who-is-harmed test decides the LABEL,
never the priority of a labelled issue.)*
**Also:** tell the worker brief this directly — "set the a11y class to keyboard/screen_reader only
when the defect is genuinely *about* those users; a functional bug with an incidental focus
side-effect is `none`". Fixing the classification at source is cheaper than re-judging every finding
at filing time.

### !! 60+ a11y tickets are still unreadable in the project view even though every one is labelled and Low
**Saw:** A sweep filed 58 issues carrying the a11y labels, all forced to the lowest priority exactly
as the standing rule requires. The operator looked at the project and asked for *"an issue called
a11y, and collect all screenreader-keyboard issues under that issue as sub-issues."* — i.e. the rule
had not achieved what it was written to achieve.
**Cause:** A label plus a low priority makes issues **sortable**, not **absent**. In the default
project view they still occupy 58 of ~330 rows, interleaved with the real queue. The rule's stated
goal was *"filterable out of the working queue"*, and filtering is a thing the reader has to do every
time; one collapsed parent is a thing done once.
**Rule:** Create **one umbrella issue titled `a11y`** per sweep (`checker.a11y.umbrella`,
`checker.a11y.umbrellaTitle`) and file every a11y finding as a **sub-issue** of it (op-23
`setParent`). Keep **one issue per gap** — do not consolidate call sites into "pattern" tickets,
which loses the per-site file/line/PR. If the sweep is already under way, re-parent retroactively:
query the scope once per a11y label (op-16), union the two sets, and op-23 each.
**Also:** The two label queries **overlap heavily** — 13 of 58 carried both labels. Union them by
identifier before iterating or you will issue duplicate updates and mis-count the total.

### !! The "file everyone-bugs at true severity" rule and the "force every a11y issue to Low" rule cannot both be obeyed
**Saw:** The playbook carried both, from different sweeps: *"Everyone, with an a11y dimension as well
→ file at true severity and apply the label alongside"* and *"Every issue carrying either label is
forced to Low, regardless of assessed impact."* Filing seven tickets hit the contradiction — each
harms all users **and** carries an a11y label, so the two sentences prescribe different priorities
for the same ticket.
**Cause:** The who-is-harmed test was written as a **priority** exemption when it is really a
**labelling** test. Once you accept "labelled ⇒ Low, no exceptions", the only place judgement can live
is the decision to apply the label at all.
**Rule:** WHO-IS-HARMED decides **whether the a11y label goes on**, never what priority a labelled
issue gets. Harms only keyboard/SR users → label, parent, force Low. Harms everyone → **do not label
it**; file it as an ordinary top-level issue at true severity and describe the a11y dimension in the
body. Record assessed severity on the `**Priority:**` line either way.
**Diagnostic:** Under the umbrella rule a mislabel no longer costs queue *position*, it costs
**visibility** — the ticket disappears under a collapsed parent. Mislabelling got strictly more
expensive the moment sub-issues arrived, so classify before filing, not after.

### !! I downgraded two tickets and left their BODIES arguing the original severity
**Saw:** after refuting their mechanisms the priority field and the title were changed, and that was
all. One description still carried a full **Consequence** section describing the refuted scenario, a
**"Why Medium and not High"** heading, and a closing **"Priority: Medium"**. Another still read
**"Why High and not Urgent"** and kept the word **"indefinitely"** that the refutation had removed. A
third still listed a dead code path as live. **A fixer reads the description, not the priority
field.** All three would have been worked on the refuted mechanism.
**Cause:** "correct the ticket" was treated as "correct the header". The refutation lived in a
**comment**; the description is the artifact that gets acted on, and it is the one not re-read end to
end.
**Rule:** **after any downgrade or refutation, re-read the WHOLE description and grep it for the old
severity word** — "High", "Medium", "forever", "indefinitely", "permanently", and the refuted
mechanism's key nouns. **A comment does not correct a description.** Keep the original text if it is
useful, but put it behind a `<details>` and mark it refuted, so nothing reads as live that is not.
This is exactly what op-15 `patchBody` and the `prescription: refuted` + `bodyPatched` fields of the
done flag exist for: a session that refutes a ticket's prescribed fix patches a ⛔ note into the
description body, where the next reader acts, not only into a comment.

### !! A note correcting a wrong file path shipped a wrong file path — I had CAPITALISED segments for emphasis
**Saw:** the gate note on a ticket reads: *"The Where: is WRONG and will cost a fixer time — the file
is `example/app/src/RESOURCES/ACCOUNTS/shared/pending.tsx`"*. **Paths are case-bearing.** The real
file is `…/resources/accounts/shared/pending.tsx`. Two segments were upper-cased the way you would
bold a word, inside a string a reader will paste into an editor. **A note whose entire subject is "a
plausible-looking wrong path silently costs a fixer time" shipped one.**
**Found by a machine-derived audit, not by reading:** extract every file-path-shaped token from all
gate outputs + verdicts + ledger (148 distinct), set-difference against
`git ls-tree -r --name-only origin/main` (5,186 files). 21 did not resolve. Triage: 16 files on an
OPEN PR BRANCH the gate was judging (legitimate); 1 extractor artifact; 1 wrong path quoted in order
to correct it (the gate working); 2 illustrative hypotheticals; 1 ellipsis abbreviation; **1 real**.
**Rule:** **never capitalise inside a path, and never abbreviate one with `...`** — bold *around* the
path, never within it, and write it in full. **Then run the set-difference**
(`fleet check verify-paths`): cited paths vs `git ls-tree -r --name-only origin/<base>` is one command
and catches the whole class. ⛔ **Triage the misses before reporting them** — most non-resolving
paths in a PR sweep are legitimately PR-branch files, so the raw count is not an error count.

### !! A bare filename in a Where: escaped my path audit AND matched two files
**Saw:** A ticket cited *"`auth.tsx` `approve()`"* with line numbers. The corpus path audit passed it
clean — because there was **no path to set-difference**, only a filename. `git ls-tree` returns
**two** files by that name. The path was also mis-guessed while verifying, and the line reads came
back **empty** — which is what a wrong path looks like: not an error, just blank output.
**Cause:** the audit checks *paths*, and a bare filename is not one. It is invisible to the very
check built to catch this class.
**Rule:** **always cite a repo-root-relative path, never a bare filename** — and when auditing,
**flag bare filenames as unverifiable rather than passing them.** ⚠️ **Blank output from a line read
is a wrong path, not an empty line** — the same silent-zero shape as everything else in this file.

### !! 80 basenames in the corpus are ambiguous — `page.tsx` matches 134 files
**Saw:** indexing every bare `file:line` citation against the tree by basename: `page.tsx` 134,
`index.ts` 52, `lib.rs` 28, `layout.tsx` 18, `main.rs` 16, `types.ts` 9. **A note reading
"`page.tsx:908`" hands a fixer 134 candidate files.**
**Cause:** a basename is not an address. Framework conventions concentrate hundreds of files on a
handful of names, so a bare `file:line` resolves only inside the context that produced it.
⚠️ **Not 80 defects** — inside its own ticket the file is usually obvious from the PR context, so
this is a **standalone-readability** failure, not a correctness one. It bites when the note is read
on its own, which is exactly what a class ticket or a corpus index does.
**Rule:** **the FIRST mention of a file in any note gets the full repo-root-relative path; later
mentions may abbreviate.** Cheap, and it makes every note survive being quoted elsewhere.

## Ledger, resume & durable state

### !! Resume says `remaining=231` when the true remainder is 148 — the ledger only recorded ONE delivery path
**Saw:** A mid-sweep `fleet check resume` printed `worklist=322 done=91 remaining=231`, and the
remaining list contained three PRs that had been filed **minutes earlier**. Reconciling the ledger
against the on-disk slice outputs appended **83 missing lines** in one pass: the real state was
`done=174 remaining=148`. The count was wrong by 56%.
**Cause:** The sweep grew a second execution path partway through. Cloud workers delivered a result
branch and the harvest step appended their ledger lines; **local subagents wrote `findings/<slice>.json`
directly and nothing appended anything.** The ledger write was attached to the *harvest* routine
rather than to the *outcome*, so the path that skipped harvest skipped the ledger.
**Rule:** **Bind the ledger append to the PR being resolved, never to the transport that delivered
it** — `fleet check ledger append <pr> <status> [--keys] [--note]` is called by whoever resolves the
PR, on every path. Whenever a sweep gains a second way to produce results, the first thing to check is
which one writes the ledger. Reconcile with a sweep over every result artefact
(`fleet check ledger reconcile --from findings`) — not by trusting the counter.
**Diagnostic that catches it instantly:** the remaining list contains a PR you can prove you finished.
A set-difference cannot tell "never attempted" from "attempted, unrecorded", so **spot-check the head
of the remaining list against work you remember doing** before dispatching against it. Dispatching on
this list would have re-reviewed 83 PRs at full token cost and filed duplicates for all of them.
**Also:** this is the same shape as the filed-index drift, arriving from the other side — there the
*record* was hand-maintained, here the *writer* was conditional. Both were caught only by reconciling
against an artefact that could not lie. Neither was caught by the counter.

### !! The ledger says 322/322 but the tracker checklist still shows 3 ticked
**Saw:** `ledger.tsv` held 322 lines (267 `filed`, 55 `clean`) and ~330 issues existed in the tracker
— but the sweep's checklist issue had **3** of 322 boxes ticked. The operator: *"you don't check the
checkmarks as you go in this task. Never skip that."* From outside the session an eight-hour run
looked stalled at PR three.
**Cause:** Ticking was coupled to the per-PR filing loop run by hand at the start. When the sweep
moved to fanned-out subagents the loop went away, the ledger append survived (workers wrote it) and
the tracker write silently did not — nobody owned it. Same shape as the "ledger bound to transport"
note: **a bookkeeping step attached to one execution path dies when the path changes.**
**Rule:** Tick the box in the **same step** that writes the ledger line, every PR, no batching
(`fleet check tick --lock` → op-27 `tickWorkItem`). Use a patch op (op-15: replace `- [ ] <pr>` →
`- [x] <pr> (\`ABC-1xx\`)`), never a whole-description rewrite — patches are atomic and cannot
clobber. **Only the launcher writes the checklist**; workers never do.
**Diagnostic:** At any resume point assert ticked-box count == ledger line count (`fleet check tick
plan` prints both). If they differ the mirror is stale — do not trust a progress claim made from the
ledger alone.
**Also:** an earlier pass had optimised the tick into a per-slice batch to save echo bytes. That
optimisation is what let the tick step die; the echo cost is real but the visibility cost is worse.
Keep the ledger append per PR — it is local, free, and it is the actual resume point — and keep the
tick with it.

### !! Clearing the done-flag threw away the only record of WHY a session stood down
**Saw:** a session concluded its issue needed no work, flagged, was reclaimed — and the ticket stayed
open, ready to be re-queued to another session.
**Cause:** the flag body (`ABC-1xx cancelled`) was the entire report, and the reclaimer's last act
was to delete it. The finding existed for about 15 seconds and then did not.
**Rule:** the reclaimer never destroys a flag's content — `flags/done-<label>.json` carries `outcome`,
`reason` and `evidence`, and the launcher reconciles every `cancelled` / `no-code-change` /
`duplicate` outcome against the tracker before the flag is archived: close the ticket with
`file:line` proof (op-9, comment FIRST), then record it so it is not handled twice.
**Distinguish the two cancel reasons — they need OPPOSITE actions.** "Already fixed on main" →
cancel the issue (op-9, with the proving line). "Duplicate, another session shipped it" → the issue
is legitimately in review, LEAVE IT OPEN (op-10): the shipped version was more complete than the
duplicate's, and cancelling it would have closed live work.

### !! The reclaim watcher DEADLOCKED cancelled sessions — retrying every 15 s forever
**Saw:** a session sat open doing nothing for hours after correctly concluding its issue was already
handled. The reclaim log showed the same three lines repeating every 15 seconds since morning.
**Cause:** two gates contradicting each other on the same session. Gate 2 accepted the flag
(`cancelled`) and logged "nothing to preserve"; gate 3 then refused to reclaim because one tracked
file was modified. Both conditions were permanent, so the watcher could never satisfy both and never
gave up — it just retried forever. The session window never closed and the slot was held.
**Rule:** the reclaimer branches on the cancelled outcome: it saves the working diff as a patch under
the state directory and proceeds, instead of skipping. **A gate that can never be satisfied must
either resolve the blocker or abandon the item — never loop.**
**Diagnostic:** when a session "looks stuck doing nothing", read the reclaim log for a repeating
`SKIP:` line BEFORE assuming the session itself is hung. The session was finished; the reclaimer was
the thing that was stuck.

### !! Push-PR deletes the dev page — which destroys the review artifact
**Saw:** asked to open all 22 review pages, every one had already been deleted by the push-PR cleanup
step. All 22 had to be rebuilt from scratch.
**Cause:** the cleanup treated the page as a build artifact of the session rather than as the
evidence the review runs on, so it was deleted at exactly the moment it started being read — and it
lived inside the worktree, which is what made deleting it look like tidying up.
**Rule:** ⛔ the dev page is what the PR is reviewed *with*. It must survive until sign-off, which is
why `paths.artifactsDir` lives outside every worktree (and `fleet config validate` errors if it does
not). Sessions rebuilding one must use **local image files** (`<KEY>-img/…`, relative `src`) — a
private repo's raw-file URLs render broken in a browser — and must open the page to confirm every
image renders.

### !! An a11y fix produces byte-identical before/after PNGs. That is not a failed capture.
**Saw:** byte-compared every pair on 22 review pages. Two issues' pairs were identical throughout —
both accessible-name/focus fixes, which change no pixels.
**Cause:** the fix changed the accessibility tree, not the render. A pixel diff is the wrong
instrument for it, and a zero-byte difference is indistinguishable from a capture that never ran.
**Rule:** ⛔ pick the evidence type from the fix. Pixels for visual/layout; an accessibility-tree
snapshot text diff for semantic ones. Identical pairs *elsewhere* are usually deliberate control
shots proving an unaffected viewport didn't regress — check the whole set before calling one
suspicious.

## Fan-out & supervision

### !! After a usage-limit stall, the launcher MUST nudge. Sessions do NOT self-recover.
**Saw:** the whole fleet hit the agent's usage limit at once. After quota was restored, 10 sessions
were observed actively writing within 47 s and the launcher concluded they had recovered on their
own. They had not — **the operator had nudged them by hand.**
**Cause:** a session whose turn closed on the limit error has nothing left to wake it. Earlier the
same day, 7 of 22 *did* self-recover — but only because each had a pending background subagent whose
completion notification arrived as a fresh prompt. No pending child ⇒ no wake-up, ever.
**Rule:** ⛔ when quota is restored (reset, new account, re-authentication), **nudge every stalled
session** (`fleet send <label…> continue`) — do not wait to see whether they resume. Self-recovery is
the exception and requires a pending subagent. Verify each nudge landed by transcript mtime, not by
the send's return code.

### !! "API Error: Connection closed mid-response" parks a session FOREVER and raises no flag
**Saw:** a session sat 24 minutes at its prompt after an API error, having already done the work. It
raised no flag, its window still read `READY`, and an in-chat monitor that was supposed to watch for
this missed it. The operator had been nudging these by hand.
**Cause:** an API error ends the turn. The session is not crashed, not blocked and not finished — it
is simply waiting for input that nobody is going to send. Nothing in the fleet times this out.
**Rule:** ⛔ detect it with the **API-error flag on the LAST assistant entry** of the newest
transcript (the stall watcher parses the JSONL), then inject `continue`. Do NOT substring-grep for
`API Error` / `Overloaded` / `529` — that matches EVERY session, because the seeded playbook prompt
quotes those strings, tool results carry line numbers 528/529, and base64 blobs contain `529`. Grepping
the last 6 KB for the limit string once classified 5 healthy sessions as dead, because the window
still contained an *earlier*, since-recovered error. A session writing within ~45 s is alive whatever
its tail says. Idle time is not a signal either: a session inside a long subagent/MCP call writes
nothing for many minutes and then resumes.
**A nudge is non-destructive, so the flag alone is a sufficient gate.** KILLING (`fleet kill`,
`fleet relaunch`) still needs the stricter rule: flag + two idle samples minutes apart + no live child
process. If the turn is truly dead, `fleet relaunch <label>` is the only recovery — a new agent
process into the SAME worktree; the worktree, branch and commits all survive.
**Also:** the stall watcher is **token-free** on purpose: it must keep working at the usage limit,
which is exactly when API errors cluster. A clean scan logs nothing, which reads identically to a dead
watchdog — so it heartbeats every Nth cycle, and the guardian supervises it.

### !! An account switch does NOT resume the fleet — and the freeze is invisible in every log
**Saw:** the 10-minute wave report printed an identical line six times in a row — `fleet=20/20
queue=2 launcher_busy=0` for a full hour. Nothing was logged as wrong: no flags, no errors, every
supervisor at 1, every window reading READY. The fleet had been frozen the whole time on the old
account's usage limit.
**Cause:** a limit-blocked session ends its turn and waits for input. Re-authenticating on a new
account does NOT wake it — nothing types into it. The stall watcher DID detect all 20 and kept
nudging, but those nudges were futile while the account behind them was exhausted.
**Rule:** an account change is a fleet-wide event: broadcast `continue` to the WHOLE fleet after a
short settle, and clear the per-session re-nudge cooldowns (they refer to a stall you have just
handled wholesale). Poll for the account-change signal on its own fast tick, not on the transcript
scan's slow one — the scan reads ~20 transcripts, the signal is one file stat.
**Diagnostic:** an unchanging status line is not "stable", it is a candidate freeze. Compare
CONSECUTIVE reports — identical fleet size AND identical queue AND zero completions across two ticks
means stalled, not healthy.

### !! Target 20 can never be REACHED without overshooting — the launcher is slower than the churn
**Saw:** the fleet sat at 13-17 sessions for hours with a target of 20, a healthy autowave, and 41
issues still queued. Nothing was broken.
**Cause:** arithmetic. A launcher run takes 12-51 min (install-paced, `install.concurrencyCap`,
settle waits), and the autowave's busy gate blocks ALL top-up for that entire window. Sessions keep
finishing meanwhile — measured 8-9 completions/hour, peak 15 — so ~3-4 sessions are reclaimed DURING
an average wave. Launching exactly `target − live` therefore lands short by that many every single
time; the fleet asymptotes below the target and never touches it.
**Rule:** aim PAST the target by the expected attrition, capped by `fleet.hardCeiling` so a lull in
completions cannot compound into a RAM problem; the launcher's own headroom gate is the backstop. Log
the arithmetic (`live=13 target=20 +overshoot=4 (ceiling 22) → launching 9`) so a short wave is
visible instead of looking like a stalled autowave.

### !! Session CREATION was the fleet's real ceiling — clone node_modules, do not install
**Saw:** the fleet sat at 13-17 for hours with a healthy autowave, a full queue, correct overshoot and
20 as the target. Every component was working.
**Cause:** arithmetic again, one level deeper. A fresh install extracts ~2,700 packages / ~276k
files and takes **26 min per wave of 2** under fleet load, so a 10-session top-up runs ~50 min. The
autowave cannot launch while a launcher runs (correctly — two launchers silently drop issues), and
sessions complete at 8-9/hour. So ~7 sessions finish during a wave that adds 10: net +3, then it
drains back. Overshoot alone cannot fix this because the CREATION RATE is the bottleneck.
**Rule:** clone a prepared dependency tree instead of installing (`install.donor.enabled`) — **99 s
vs ~26 min**, and a local file copy rather than a registry download plus extraction, so it is also far
gentler on the IO subsystem. The donor lives at `install.donor.path` (derived, under the state
directory, never inside any worktree) with a manifest carrying the lockfile hash it was captured from.
**⚠ RE-CAPTURE THE DONOR whenever the lockfile changes on the base branch.** The gate is exact: one
byte different and every new session silently falls back to a full install and the 26-min ceiling
returns.

### !! Cloning node_modules from a LIVE session is unsafe — the donor gets reclaimed mid-copy
**Saw:** three targets finished the clone with the right shim count and an intact compiler, yet the
test runner could not start: a nested package's `build/` directory was EMPTY. Two sessions
independently flagged the tree as half-extracted.
**Cause:** the donor was a **live** session. It flagged `pr-pushed` mid-clone, and the reclaimer did
its job: it killed every process holding that worktree path (which included the copy readers) and
deleted the tree. Copies in flight were truncated silently, because the copy's exit code had already
been captured for the batches that finished.
**Rule:** never use a live worktree as a donor. Snapshot one to a **stable path outside every
worktree** first — that is what `install.donor.path` is — so nothing reclaims it. The snapshot is also
reusable for every future repair.
**Rule 2 — shim count and one big file are NOT integrity checks.** Both passed on all three broken
trees. The only check that caught it was **total file count vs the donor** — which is why
`install.proof.mode: compare-primary` compares against a snapshot of the primary checkout with
`install.proof.tolerance` for caches a live session writes, and `install.proof.probeFiles` can pin a
nested file that must exist.
**Rule 3 — a MISSING top-level copy of a nested package is NORMAL.** A healthy tree does not have one;
only the nested copy matters. Healthy trees were nearly "repaired" over this.
**Verify with the test runner's list mode, not the type-checker.** The type-checker passed on the
broken tree because it never loads the missing package. **Never repair a session that is MID-INSTALL**
— it looks identical to a stranded one by file count. Tell them apart by the install log's **mtime**
(fresh = installing).

### !! Verify a node_modules tree by CONTENT. Counts and exit codes each lied independently.
**Saw:** three different corrupt shapes, all passing the cheap checks — one tree with the full package
count and **all** shims but the compiler's main file **absent**; two trees with the compiler intact
and **0** shims; three trees with the file truncated to a quarter of its size. Separately, in a
cloud sandbox, `npm install --ignore-scripts` produced ~29,876 failed proxy CONNECTs over ~21 minutes
against a blocked host and **never errored** — the boot sanity check "LIED": `ls node_modules | wc -l`
read ~1500 and the private-scope dirs existed but were EMPTY (no `package.json`), and `.bin` was empty.
**Cause:** two installs writing one worktree (`TAR_ENTRY_ERROR UNKNOWN` across dozens of files), and
interrupted installs. npm sees a package *directory* and calls it installed — exit 0, no repair. And
npm retry-loops on a blocked host rather than failing; nothing that looks like a failure is printed.
**Rule:** ⛔ the health check is content: a file INSIDE a package, a populated `node_modules/.bin`,
**and** a file-count comparison against the primary (`install.proof`). Write `install.readyFlag`
(`.fleet-ready`) only after all pass. Never trust exit code, package count, or shim count alone, and
**never accept a directory listing as proof an install worked.**
**Also:** any worker quiet >25 min with no branch is presumed stuck, not working.

### !! Transient network failures roll the WHOLE tree back — and are not the same as two-writer corruption
**Saw:** two sessions died with a postinstall DNS failure (`getaddrinfo ENOENT`) and npm reverted
everything; two others failed with a connect timeout with only one launcher running. All four
succeeded on retry.
**Cause:** the package manager rolls the whole tree back when a fetch or a postinstall cannot reach a
host, so a network blip and a two-writer corruption leave the same wreckage on disk — and only one of
the two is fixable by retrying.
**Rule:** transient — unlike `TAR_ENTRY_ERROR UNKNOWN` (two writers in one worktree), which a retry
can NOT fix. Delete the partial tree (npm will not repair it), re-resolve the host first so a
10-minute install is not burned rediscovering a dead network, then retry. Two attempts, then
escalate (`fleet flag blocked --category install`).

### !! The pre-commit hook runs the FULL test suite on every commit — the biggest unpaced load source
**Saw:** CPU pinned at 100% with writes near zero while 6 sessions independently failed the same
timing-sensitive test with `Exceeded timeout`, a different case each run.
**Cause:** the pre-commit hook runs the whole suite. The test runner caps a fleet session at 2
workers, so 22 sessions ⇒ ~44 workers on 16 threads.
**Rule:** ⛔ expect commit-time contention to spike whenever a wave finishes together. This wants a
fleet-wide commit lock, like the e2e-port and emulator pools. Never `--no-verify`.

### !! NEVER have sessions cherry-pick a fix that touches a POLICY-GATED PATH
**Saw:** to unblock the pre-commit failures a timeout constant was added to one test file and all 22
sessions were told to cherry-pick it. Every resulting PR then carried a file under a sensitive path;
the path-routed review policy classified all 22 as out-of-clearance for the current user, declined
them and routed them elsewhere.
**Cause:** the approval router routes on **file path**, not content. The change was 1 constant + 7
comment lines in a test, but the path was enough.
**Rule:** ⛔ before broadcasting any cherry-pick, check the file's path against `vcs.sensitivePaths`
and the repo's review-routing policy. A change to the test runner's config would have had zero
clearance impact. Fix: rebuild each branch from `origin/<base>`, cherry-picking only the session's own
commits, then `push --force-with-lease` — which also re-triggers the policy on a clean diff.

### !! Two sessions on one issue — and one of them proposed taking the other's work over
**Saw:** a queue bug relaunched the same two issues six times, putting 12 sessions on 2 issues. Every
duplicated session detected the clash itself via `git worktree list`, refused to force a checkout,
and flagged — so nothing reached origin and no work was lost. One flag asserted the owning session
had "died at its usage limit" and proposed taking over. It had not — it was active 81 s earlier.
**Cause:** the queue writer failed to truncate on an empty remainder, so the same keys were handed
out wave after wave. And a session has no view of any other session's state, so when it needs one it
infers it — an idle window read as a dead session.
**Rule:** sessions verifying before acting is what turned a launcher bug into an inconvenience — keep
that guard. And ALWAYS verify liveness from the transcript (`fleet status`) before reassigning an
issue; a session cannot see another session's state and will guess wrong.

### !! The issue queue's source is ONE scope — filtering anywhere else reads as "exhausted"
**Saw:** the fleet drained from 20 sessions to 3 and stayed there. The queue was reported empty and
the issue supply declared exhausted ("~8-10 issues left after filtering"), so the wave stopped and
waited on a direction decision that had already been given.
**Cause:** the search was run against the **general backlog** (~450 issues, every project and
owner), then narrowed by label and path until almost nothing survived. The fleet's actual source is a
single scope. Filtered correctly — `fleet.queue.selector` (group + assignee + state) — it returned
**70 issues**, not 8. The pool was never close to empty.
**Rule:** the queue comes from `fleet.queue.selector` (op-12 `listQueue`) and nowhere else. Never
label-match the general backlog and never filter by date — the selector's group boundary is what
selects this work. The sweep's own checklist meta-issue is excluded by `checker.triage.label`; it is
not a work item.
**Also:** an empty queue is a task, not a question to escalate. If the autowave is stopped to contain
a bug, restarting it is part of that fix — a stopped autowave is invisible and the fleet just drains.
The autowave logs `QUEUE EMPTY` and idles rather than launching junk, but that means the fleet
quietly drains to zero if nobody refills it: plan the next source before the queue empties.

### !! A testing slot serving `/` 200 says NOTHING about the worker
**Saw:** four sessions reported "the API worker is dead" — root and the sign-in page returned 200
while every `/api/*` route returned 500. The worker process was running the whole time.
**Cause (partly unresolved):** the health watchdog restarts the dev server on its tick without
checking the database is reachable, so after a reboot the worker binds with nothing on its port.
⚠️ A clean restart **with the port confirmed listening still 500'd**, and the env file was
byte-identical to the primary — so this is NOT fully diagnosed. Do not repeat the database
explanation as fact.
**Rule:** ⛔ probe an `/api/*` route, not `/`, before declaring a slot up — that is what
`devServer.probes` with `dependsOnPrevious` is for. Only 2xx/3xx counts, with a 45 s timeout
(`testing.lock.probeTimeoutSec`; a `000`/`502` = still compiling). `HELD` from `fleet pool acquire`
means busy, not broken.

### !! A shared testing slot may be RESET — that is what it is for
**Saw:** two wave-1 issues touched the same file, so the slot carrying one conflicted with the other.
The session correctly refused to hand-resolve inside a shared worktree without authorisation.
**Cause:** the refusal was right but the framing was wrong — the session treated the slot as shared
state to be preserved, when a slot holds no state worth preserving at all.
**Rule:** the slot is a throwaway mashup, never pushed and never merged anywhere — so
`reset --hard origin/<base>` + merge only your own branch is the cheap, correct fix. ⛔ Never
hand-resolve a conflict in a shared worktree: nobody reviews that resolution and it vanishes on the
next reset. Hold the pool lock across reset→merge→capture→release (`fleet pool acquire testing` …
`fleet pool release`), or another session's merge lands in between and undoes it.
**Wave-planning consequence:** check the candidate issue list for **file collisions before
launching** — two sessions on one file will collide at capture time, not at code time.

### !! `git worktree remove --force` deregisters but often does NOT delete the tree
**Saw:** the reclaimer reported success on 11 sessions, yet all 11 folders remained (~3 GB each). A
retry printed `fatal: '<path>' is not a working tree` — which reads like success.
**The operation has two effects and reports one exit code.** git deregisters the worktree and then
fails to unlink the directory, because leftover shells still hold files inside it.
**Consequence:** the fleet looked FULL (20 folders) while only 7 sessions were reachable, so a
capacity check based on folder count silently blocked every top-up.
**Rule:** ⛔ after `git worktree remove --force`, kill the holders, remove the folder, then **verify
the directory is gone** — never trust the git exit code (`fleet doctor --repair` does all three and
reports each). Count live capacity by the registry (`fleet status`) or `git worktree list`, never by
folder count.
⛔ When killing holders, match the EXACT worktree path with a boundary check: a prefix match on
`app-session-1` also matches session-10..19 and would kill live sessions. This is why the registry
holds `worktree` and `agentPid` per session and the shim matches itself by the exact argv token
`--fleet-session=<label>`, never a substring.

### !! ROOT CAUSE of three reclaim bugs: a half-finished git operation is neither "done" nor "not started"
**Saw:** three separate bugs in the reclaim path in one hour, all the same mistake — treating a
partially completed `git worktree remove` as binary:
1. **Trusting the exit code.** It deregisters AND deletes; it routinely does the first and fails the
   second. A retry then says `is not a working tree`, which READS like success while ~3 GB stays.
2. **Counting folders as capacity.** 20 folders vs 7 real worktrees, so a top-up gate saw a full
   fleet and never fired.
3. **Querying the deregistered worktree.** Once deregistered, `git -C <that worktree> ls-remote`
   fails with `'origin' does not appear to be a git repository`. The safety gate read that as "branch
   not on origin" and refused to reclaim — a **deadlock**, because attempt 1 breaks the check that
   authorises attempt 2.
**Cause:** the operation has two effects — deregister and delete — and reports one exit code. Every
consumer that treats it as atomic inherits a state that is neither "done" nor "not started", and each
of the three bugs is a different consumer making that same assumption.
**Rule:** ⛔ after any `git worktree remove`, verify the FILESYSTEM, not the exit code; take capacity
from `git worktree list` or the registry; and never run a remote-dependent git command inside a
worktree you may already have deregistered — run remote lookups from the PRIMARY checkout.
**Silver lining worth keeping:** bug 3 failed SAFE — it refused to delete something it could not
verify, so nothing was lost while it was live. Gates should always fail in that direction.

### !! The pure-UI issue supply is the real ceiling, not the machine
**Saw:** after 4 waves (34 issues) a full sweep of both source projects (467 open) found only ~132
label-matching candidates, of which ~34 die on ownership, ~31 on paths that would bounce off the
review policy, ~20 on collisions with in-flight waves, and ~15 collide with each other (one family
alone is 7 issues on 2 files).
**Cause:** every filter is multiplicative and they were only ever measured one at a time. Capacity
planning had been sizing the machine, which was never the binding constraint.
**Rule:** budget roughly one more full wave, then a handful remaining. Continuous 20-session waves
cannot be sustained from one scope alone. Plan the next source before the queue empties.

### !! A supervisor restart printed a plausible "stopping" line and left NOTHING running
**Saw:** two restarts of a supervisor, on different days. Both printed a believable `stopping N`
line, both returned success, and both left **zero** supervisors behind. Nothing logged an error; the
fleet simply ran unsupervised until somebody happened to look.
**Cause:** a restart is two operations reported as one. The stop half is the half that prints, so the
message describes what was killed and says nothing about what came back. "Killed, never restarted"
and "restarted cleanly" produce identical output.
**Rule:** after ANY restart of a supervisor, **re-run the health probe and confirm the count is
exactly 1** — not "it printed stopping", and not `>= 1` either, because a duplicate supervisor is its
own failure. Only an explicit after-check separates the two outcomes, and it costs one probe.

## Tracker quirks

Most tracker behaviour that bit a run is filed under the theme where it bit: op-16 paging under
*Truncation & completeness*; attachment rate-limits and signed asset URLs under *Filing &
reconciliation*; autolinking of truncated keys under *Truncation & completeness*. The entries here
are the ones that are purely about the tracker's write path.

### !! Backfilling 322 ticks trips the oversized-echo error — and the write applied anyway
**Saw:** Backfilling 322 checklist ticks needs a **whole-description** write (~31 KB), which trips
the tracker's oversized-response error. The write had applied.
**Cause:** the error is raised on the **response**, after the write has committed — it describes the
echo, not the outcome. Read as a failure it invites a retry, and the retry is a second write.
**Rule:** verify by re-fetching (op-26 `readWorkItems`) and counting `- [x]`, **never** by retrying —
a blind retry is how duplicate checklists get made. The same applies to any op-13/op-14 that errors
*after* the payload was sent: look before you re-send.

### !! A checklist patch must anchor on the row prefix, not the bare PR number
**Saw:** A patch of `replace "- [ ] <pr> -" → "- [x] <pr> (ABC-1xx, …) -"` matched uniquely only
because of the leading `- [ ] `. A bare PR number also appears inside other rows' titles (*"roll the
<pr> fix onto …"*).
**Cause:** a checklist built from PR titles contains every PR number those titles mention, so the
identifier you are keying on is not unique in the document you are patching.
**Rule:** op-15 `patchBody` edits anchor on the full row prefix. A `find` string that can match more
than once is refused by adapters that declare `atomicPatch`; where the adapter cannot guarantee
atomicity, the launcher serialises the writes through `fleet check tick --lock`.

### !! Two label queries overlap heavily — union by identifier before iterating
**Saw:** Re-parenting a11y issues, the two label queries returned sets where 13 of 58 carried both
labels.
**Cause:** the two labels are applied independently and one finding may earn both, so the result sets
are not disjoint — concatenating them double-counts and double-writes.
**Rule:** union op-16 results by `id` before iterating, or you will issue duplicate op-23/op-14
updates and mis-count the total. The same holds for any pair of selectors that are not disjoint by
construction.

## Cloud workers

### !! 4 cloud workers parked 30-45 min each, no failure report, no result branch
**Saw:** Workers for four tickets sat 30-45 min. A separate 6-minute verification worker hit 2
prompts. From the dispatch side: no branch, no failure report, no timeout — identical to a crash. The
cloud console showed them as `Needs input — Waiting on permission`.
**Cause:** All four prompts were on the same sensitive file (a package-manager rc file holding an
auth token). The permission layer treats it as sensitive and fires **even for read-only commands that
already redact the token**. The workers only touched it because they were diagnosing an install
failure.
**Rule:** Worker briefs must never read, grep, cat or edit any path in `vcs.sensitivePaths`
(`fleet check brief` includes the list). Probe a secret **by its length**, never by reading the file
that holds it — the env var is not sensitive, the *file* is. Approve with "always allow", never
"allow once", or the same worker re-prompts.
**Diagnostic:** A permission hang emits NO signal, ever. Never wait on a worker; poll the cloud
console for `Needs input`.

### !! 8 cloud sessions "running", 0 delivering
**Saw:** ~8-10 concurrent cloud sessions, no concurrency-limit error at any point — and zero result
branches produced. Nearly all had died at boot inside ~90 s.
**Cause:** A dead worker still holds its slot and is indistinguishable from a busy one when you are
counting sessions. "No concurrency error" was read as "the ceiling is fine"; it was actually
near-zero evidence, because ten workers failing fast is nothing like ten holding containers through
full captures.
**Rule:** Gate every ramp step on branches DELIVERED, never on sessions created: count the heads
`git ls-remote --heads origin` returns for the `vcs.assetsBranchTemplate` pattern (`fleet check
harvest` / `fleet check status` already report delivery). Advance only when that number is rising.
Check the exit code too — a network failure mid-poll reads as "branch absent".

### !! Container OOM (`exit 137`) is predictable from the pilot — measure it, then check what is accumulating
**Saw:** A cloud container OOM-restarted with `exit 137`. Pilot on a 16 GB container: memory used
went 952 MB → 6,525 MB across 3 PRs, about 1.86 GB per PR. Slices were cut from 8 to 6 on that
number. Then a 6-PR slice went 5,432 → 7,903 MB: about **412 MB per PR**, with the worker noting the
browser was closed after each capture.
**Cause:** Per-container memory ceiling — entirely independent of any session-count cap, and
invisible to a ramp that counts sessions. The pilot held a browser open across the whole slice; the
per-PR figure was mostly accumulated browser instances, **not** an inherent property of reviewing
another PR.
**Rule:** Extrapolate before choosing a slice size — but **check whether the harness is
*accumulating* something between units before you resize the batch. A leak masquerades as a cost.**
Closing the browser between PRs is the fix, not shrinking the slice; with the guard in place a slice
of 8 would have been comfortable. Keep a guard in the worker brief: check free memory after every PR,
close the browser between PRs, and if available memory drops below a floor push what you have and
report `notReached`. A short slice that delivers beats a full slice that is OOM-killed with nothing
pushed. Treat a 137 as "split the slice", not "retry it unchanged".
**Also — where the time actually goes:** measured per-PR *capture* was only 31-50 s, and boot was ~3
min of real work. The other ~10 min per PR is the agent's own reading and judging. So bigger slices
amortise almost nothing, and memory is the binding constraint, not boot cost. Do not size slices to
"amortise the boot" — that intuition is wrong here.

### !! The forge CLI is absent inside the cloud sandbox
**Saw:** Pilot worker boot probe: `gh auth status` → `command not found`. The sandbox has node, npm,
a database and a browser, but **no forge CLI at all** — not an auth failure, the binary is absent.
**Cause:** The sandbox image does not ship it. The repo tree is checked out server-side by the
platform, so nothing in the normal capture flow ever needed it and the gap went unnoticed.
**Rule:** A cloud worker **cannot query the forge**. Any gate that needs PR metadata, diffs, or a
"was this fixed later?" lookup must be **precomputed locally and shipped in the checkout** — that is
the `_sweep/` bundle (`fleet check gh bundle`: per-PR `.json` + `.diff`, plus the gate-2 path index).
**Why this was nearly fatal:** the offline bundle was built as a *performance* measure — to stop ~40
workers hammering the forge. It turned out to be **load-bearing**: without it every worker would have
failed gate 2, and most likely would have quietly filed unverified findings rather than reporting a
blocker.
**Diagnostic:** always put `gh auth status` (or the equivalent for whatever external CLI you assume)
in the pilot's boot probe. Assumed-present tooling is invisible until it isn't there.

### !! Cloud capture down fleet-wide: 0-of-8 delivered is the ENVIRONMENT, never eight bad specs
**Saw:** a session flagged that its cloud capture had produced nothing after 70 min. Checking the
whole fleet: 8 `capture/*` refs pushed, 0 `assets-*` branches returned, no failure report anywhere.
**It is an environment fault, not eight bad specs:** the egress proxy refused CONNECT to the private
registry hosts and the token was unset in the sandbox — a broken token / allowlist / env config kills
EVERY worker identically.
**Diagnostic that settles it in one command:** count delivered vs dispatched — `git ls-remote --heads
origin 'assets-*'` vs `'capture/*'`. If 22 of 24 landed, the 2 outliers are their own specs; if 0 of
8 landed, stop reading specs.
**Rule:** do not re-dispatch to cloud and do not re-read the spec. Fall back to a LOCAL testing slot
(`fleet pool acquire testing`), take BOTH phases from that slot — never mix a local shot with a cloud
one — and use the worktree/branch/url the lock PRINTS rather than assuming slot 1. Probe the slots
first: one slot answered 200 while another answered 404 (a dead server hiding behind the proxy). If
the evidence is semantic rather than visual, an accessibility-tree snapshot diff needs no slot at all.
**Also:** the root cause was operator-side and cloud-only, which is why `capture.allowlistHosts` and
`capture.requiredEnv` exist — to make both declarable and probe-able before dispatch.

### !! ~1 in 8 cloud capture workers dies silently, with no failure report
**Saw:** 24 dispatched, 22 delivered. Three produced no result branch and no failure report; two of
the three landed on a re-dispatch.
**Cause:** a worker can die before it reaches the step that would write a failure report, so silence
is what individual failure looks like by default — and it is the same shape a dead environment
produces, which is why the sibling count is the only thing that separates them.
**Rule:** a silent worker is not an environment fault — check whether siblings delivered before
flagging `cloud-env`. Re-dispatch once on a **NEW ref name** (a `-v2` suffix on the
`vcs.captureRefTemplate` ref); force-pushing the existing ref makes the worker re-shoot the OLD commit
and yields convincing but stale PNGs. Escalate only after a second silence (two failures on one spec
⇒ suspect the spec, not the environment).

### !! Cloud capture: the config is PER-ACCOUNT, and a post-fix failure is NOT proof the fix failed
**Saw:** after an account switch, every cloud capture failed. Sessions correctly reported "no result
branch, no failure report" and reasonably concluded the environment was dead. The launcher told the
operator the account change "could not be the cause" because the machine still had the token in its
user environment — **the operator was right and the launcher was wrong.** Then, after the config was
corrected, three workers still reported `status: failed / missing token`.
**Cause:** (1) The cloud environment config is stored **per account**. A switch gives you an empty
default environment: no domain allowlist, no secrets. (2) "Changes apply to new sessions" is literal:
a worker whose container was created before the save still sees the OLD environment.
**Rule:** re-apply the canonical cloud config (`capture.allowlistHosts`, `capture.requiredEnv`,
`capture.bootstrapScript`) after EVERY account switch, and keep the network allowlist *extending* the
platform's default package-manager list rather than replacing it. ⛔ **A post-fix failure from a
pre-fix container proves nothing.** Re-dispatch on a **new ref** — a force-push of an existing
capture ref is not picked up.
**How to prove the allowlist specifically:** the worker probes the hosts itself. Blocked reads as a
CONNECT rejection with the host in `blockedHosts`; fixed reads as an auth challenge (`401`) or a
redirect with `blockedHosts` **empty**. A 401 is SUCCESS for the network question and a separate
failure for the credential question — don't read it as "still blocked".
**How to settle it:** dispatch a small verification worker on a ref that already exists (`fleet
cloud dispatch --bundle <dir> --ref <branch>`), have it push a result branch either way, and read the
verdict. Cost ~6 min.

### !! The acceptance test is the TOKEN-GATED artifact, not the install succeeding
**Saw:** the verification worker reported the install "added 2715 packages in 2m" with no errors.
That alone would have been accepted as proof the credential worked.
**Cause:** the install succeeds *without* the credential — the gated packages resolve to empty
directories rather than erroring — so a package count and a green install measure the network, not
the secret. The one thing the credential changes is the CONTENT of those packages.
**Rule:** ⛔ **The acceptance test is the packages that cannot be fetched without the credential.**
Their CONTENT proves the token works; a package count or a directory listing proves nothing (empty
dirs are exactly the failure mode). Declare them in `install.proof.probeFiles`.
⛔ **The sandbox's default runtime may not be the one the repo requires.** The bootstrap installed the
right version but did not put it on PATH; the session started on the older default, which violated
the engine constraint and died with a misleading engine error that read like a repo fault. Every
worker brief must activate the runtime the bootstrap installed and assert its version before the
install (`capture.bootstrapScript` is where that lives).

### !! A capture whose secret lives in an UNTRACKED file can never run in the cloud
**Saw:** a session proved the cloud path structurally impossible for one feature family: the
feature's API token lives in a gitignored local env file, so a cloud sandbox boots with no access and
the feature's UI never appears.
**Cause:** a cloud sandbox is built from the tracked tree plus the declared environment. A secret
that lives in neither exists on no path the sandbox can reach — and the failure presents as an
ordinary silent worker, which is why it kept being re-dispatched.
**Rule:** ⛔ captures that depend on a secret outside `capture.requiredEnv` are **local-only**. Do not
send a session down the cloud path for them (`capture.mode: local` per project, or a session-level
override), and do not read the resulting silence as a `cloud-env` fault. This is permanent, not
transient.

### !! A worker's "no failure report anywhere" was my own sample, not the workers' verdict
**Saw:** see *"No failure report anywhere" was a claim about a sample taken at one instant* under
Truncation & completeness. Two workers delivered `status: failed` manifests *after* the launcher had
already generalised from their absence.
**Cause:** the sample was taken while the fan-out was still running, and an absence has no
timestamp — nothing in "no failure report anywhere" records that it was true only of that instant.
**Rule:** the cloud-capture manifest carries `status`; harvest it (`fleet check harvest <sweepId>`)
before concluding anything about a silent worker, and re-harvest before every escalation.

## Forge CLI limits

### !! A 167-file PR reports exactly 100 changed files
**Saw:** `gh pr view <n> --json files` returned exactly **100** entries for three different PRs. The
REST endpoint `pulls/N` reports `changed_files: 167` for one of them, and `pulls/N/files?per_page=100
--paginate` returns all 167. Real counts: 100→167, 100→228, 100→118.
**Cause:** `gh pr view --json files` returns ONE page and does not paginate. It reports no error and
no truncation marker — a PR with exactly 100 files is indistinguishable from one with 500.
**Rule:** Treat a file count of exactly 100 as **truncated until proven otherwise**. Get the real
list with `gh api "repos/{owner}/{repo}/pulls/N/files?per_page=100" --paginate --jq '.[].filename'`,
and cross-check against `changed_files` from `gh api repos/{owner}/{repo}/pulls/N`
(`fleet check gh bundle` does both).
**Why it matters here:** the gate-2 index is keyed on changed paths. Repairing three PRs took the
index from **811 to 957 rows** — 146 paths that gate 2 would have been silently blind to, so "no
later PR touched this file" could have been wrong for any of them.
**Also:** the largest non-capped PR had 84 files, so nothing else in a 322-PR sweep was affected —
but that is luck, not a guarantee. The same shape applies to `gh pr list`: its default limit
silently truncates, so pass an explicit `--limit` well above the expected count and treat
`count == limit` as truncated.

### !! `gh pr diff` returns nothing and exit 1 on a large PR
**Saw:** `gh pr diff <n>` → exit 1, `could not find pull request diff: HTTP 406: Sorry, the diff
exceeded the maximum number of lines (20000)`. A naive script that redirects stdout leaves a
**0-byte diff file** behind and carries on.
**Cause:** The forge's diff media type caps at 20,000 lines. It is an HTTP error, not an empty diff.
**Rule:** Check the exit code of `gh pr diff` and never accept a 0-byte result as "no changes".
Rebuild the diff from `pulls/N/files?per_page=100 --paginate` using each entry's `.patch`, and mark
the file so the consumer knows it is reconstructed and capped.

### !! Same-name file written by one interpreter is missing when another opens it
**Saw:** a file written by a bash step was `FileNotFoundError` to a python step immediately after a
command that clearly succeeded. Later the same day, a python one-liner handed a
POSIX-emulation-style `/c/…` path printed an empty field for four PRs, so the launcher nearly reported *"the sweep failed to record
the provenance its own plan required"* — an unfair claim about the process. The field was there all
along.
**Cause:** On Windows, a POSIX-emulation shell maps its temp and `/c/…` paths to its own locations
while native interpreters resolve the same strings differently. Two different directories, same
string. And `2>/dev/null` ate the traceback.
**Rule:** Never hand an interpreter-relative path between a shell step and a native-interpreter step.
Use the absolute native path from the session descriptor (`FLEET_STATE_DIR`, `FLEET_SWEEP_DIR`) on
both sides, or `cd` into the directory and use a relative path. ⛔ And never suppress stderr on a
measurement (`2>/dev/null` / `2>$null`) — this is the same family as the two silent zeros under
*Measurement & denominators*: several in one session, all masked by suppressed stderr. This is the
same trap that once made a "0 of 178" audit look real.

### !! `gh pr ready --undo` DISMISSES a live approval
**Saw:** a PR was approved on a SHA. Converting it to draft dismissed the approval; the later
ready-for-review re-run changed its mind and did not restore it. No push occurred between the two
events.
**Cause:** a draft round-trip is a new review cycle, and the setting that preserves approvals across
a push is a *different* setting from the one that governs this. A repo can hold approvals through a
force-push and still drop them here, so the safe operation reads as unsafe and the unsafe one as
routine.
**Rule:** ⛔ never draft/undraft a PR that has earned an approval. Where the repo does not dismiss
stale reviews on push, a force-push preserves approvals — but a draft round-trip does not.
`vcs.pr.draft` decides the *initial* state only; a session never toggles it afterwards.

### !! After each merge, mergeability reads `UNKNOWN` for a few seconds
**Saw:** immediately after a merge the forge recomputed mergeability for every open PR and
`mergeable` read `UNKNOWN`; a merge attempted on that read failed.
**Cause:** mergeability is computed asynchronously for every open PR after each merge, and the API
answers `UNKNOWN` rather than waiting — a value that reads like a verdict and is really "ask again".
**Rule:** poll until it resolves rather than merging on a stale read. And know the repo's merge
gate: where there are no required status checks, red CI does not block merge and an approved PR
reads `UNSTABLE`, not `BLOCKED` — so "approved" is the real gate, and a check-based liveness read is
wrong.

## Retired

These entries were tied to the fleet's previous process-grep-and-console-injection tooling. The Node
redesign replaces every one of those mechanisms with the session registry, the shim, the pool locks
and the CLI, so the rules no longer apply. They are listed by symptom only, so a reader who finds one
in an old run log knows it has been superseded rather than forgotten.

- `ok(N)` from the broadcast helper meant BYTES WRITTEN to the console input buffer, never CONSUMED —
  replaced by `fleet send`, which reports delivery per session and is verified by transcript mtime.
- A launcher whose shell redirect failed still RAN, headless, with no log — replaced by the shim's
  own exit record and `fleet status`.
- `tasklist` silently returned ZERO processes under load — replaced by the registry (`sessions/<label>.json`)
  and pid liveness checks.
- A command-line filter reported a duplicate supervisor / 5 autowave instances / self-matched the
  probe's own shell (three separate incidents, reading AND writing) — replaced by the registry and the
  exact `--fleet-session=<label>` argv token; command-line grepping survives only as the post-crash
  reconciler.
- A kill-by-command-line written via heredoc killed its own parent shell and left the fleet unmanaged
  — replaced by `fleet kill <label>`, which resolves the exact pid tree from the registry and never
  kills by match set.
- Killing the autowave process TREE killed the in-flight installer and stranded 13 worktrees with no
  dependencies — replaced by the supervisor loop, which waits for a busy launcher before stopping it.
- A background helper started without BOTH streams redirected died on its next write — replaced by
  the supervisor spawning watchers with their own handles.
- An empty pipeline to the queue-file writer silently did NOT truncate the file, relaunching the same
  two issues six times — replaced by `queue.txt` written atomically by `src/core/intake.mjs`.
- The shell's command-length limit and nested-interpreter quoting rejected the dependency-clone script
  — replaced by `src/core/install.mjs` running the clone in-process.
- The stall watcher "scanned 0 sessions" while a session run from the primary checkout was parked —
  every session now has a descriptor, so nothing is out of scope.
- "Never retile unprompted" was reversed to "retile after every wave" — layout is now derived from the
  live registry by `src/core/layout.mjs`; the rule no longer needs stating.
- Watching the agent's credential file mtime as the account-switch signal — the rule survives above
  (*An account switch does NOT resume the fleet*); the file-path mechanism does not.
- The machine's unexplained resets and the case for pinning processor throttling — a per-machine
  hardware note, not a method.
