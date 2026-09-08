// The two tracker stores, each test the incident that shaped a rule: the outbox (ops a session could
// not perform, drained by the launcher) and the offline ticket cache (what a session reads when its
// tracker is unreachable). Filesystem only — no backend, no clock that is not injected; the only
// processes spawned are two more `node`s running this same module, because a cross-process mutex is
// only proven across processes.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { ROOT } from './helpers/prose.mjs'
import { OP_NAMES, OP_COUNT, listAdapters, loadAdapter } from '../src/trackers/registry.mjs'
import { admit } from '../src/core/intake.mjs'
import {
  enqueue, list, pending, applied, ack, recordAttempt, verbatimText, normalizeOp, drainOrder, parseEntryName,
  entryName, compactInstant, outboxDir, appliedDir, refetchBeforeRetry, ALWAYS_VERBATIM,
} from '../src/trackers/outbox.mjs'
import {
  cacheTicket, readTicket, listTickets, ticketPaths, ticketsDir, assertKey, ticketRecord, renderTicketMarkdown, KEY_RE,
} from '../src/trackers/tickets.mjs'

// Every state dir a test makes is removed when the file is done: a suite that leaks one directory per
// test leaves hundreds on a CI runner by the end of the week.
const made = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stores-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})
const T0 = '2026-03-14T10:00:00.000Z'
/** T0 plus n seconds, as the ISO instant the stores record. */
const at = (n = 0) => new Date(Date.parse(T0) + n * 1000).toISOString()
const ls = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null)
const KEY = 'ABC-1234'

// ================================================================================================
// The outbox
// ================================================================================================

test('an entry is written atomically into a directory created on demand, under a name Windows accepts', () => {
  // A reader mid-scan must see a whole entry or none, so the write is temp+rename in the SAME
  // directory (a rename across filesystems is a copy). The instant is compacted because a colon is
  // illegal in a Windows filename, and `<ts>-<label>-<seq>` must parse back even for a label that
  // itself ends in digits (`check-12`), or the seq is read off the label.
  const dir = tmp()
  assert.equal(fs.existsSync(outboxDir(dir)), false)
  const e = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'hello' }, requestedBy: '3', at: T0 })
  assert.equal(e.id, '20260314T100000000Z-3-000001')
  assert.doesNotMatch(e.id, /[:.]/)
  assert.deepEqual(ls(outboxDir(dir)), [`${e.id}.json`], 'exactly the entry, no temp file left behind')
  assert.deepEqual(parseEntryName(e.id), { ts: '20260314T100000000Z', label: '3', seq: 1 })
  assert.deepEqual(parseEntryName(entryName({ at: T0, requestedBy: 'check-12', seq: 3 })), { ts: '20260314T100000000Z', label: 'check-12', seq: 3 })
  assert.equal(parseEntryName('notes'), null)
  assert.equal(compactInstant('2026-03-14T10:00:00.123Z'), '20260314T100000123Z')
  const onDisk = JSON.parse(fs.readFileSync(e.file, 'utf8'))
  assert.deepEqual(onDisk, { v: 1, id: e.id, seq: 1, n: 11, op: 'comment', key: KEY, args: { text: 'hello' }, verbatim: true, requestedBy: '3', at: T0, note: null, attempts: [] })
})

test('the op is validated at enqueue against the 27 registry names, in every spelling — a bad op found at drain time has lost its context', () => {
  // The session that knows what an op meant is reclaimed long before the launcher drains; a refusal
  // here reaches it, a refusal at drain time reaches nobody.
  for (const spelling of ['op-11', 'OP-11', '11', 11, 'comment', ' op-11 ']) {
    assert.deepEqual(normalizeOp(spelling), { n: 11, op: 'comment' }, `spelling ${JSON.stringify(spelling)}`)
  }
  // op-5 and op-7 share a name: the name resolves to the first, the second stays reachable by number.
  assert.deepEqual(normalizeOp('setState'), { n: 5, op: 'setState' })
  assert.deepEqual(normalizeOp('op-7'), { n: 7, op: 'setState' })
  assert.deepEqual(normalizeOp(String(OP_COUNT)), { n: OP_COUNT, op: OP_NAMES[OP_COUNT] })
  for (const bad of ['op-28', 'op-0', 'op-1.5', 'frobnicate', 'Comment', '', null, undefined, {}, -3]) {
    assert.throws(() => normalizeOp(bad), /is not a tracker op/, `op ${JSON.stringify(bad)} must be refused`)
  }
  const dir = tmp()
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-28', key: KEY, args: {} }), /is not a tracker op/)
  assert.equal(fs.existsSync(outboxDir(dir)), false, 'a refused op writes nothing, not even the directory')
})

test('a createIssue with no key yet is queued under its fid — the key is data, never a path', () => {
  // A fid is `slice|pr|index`; `|` is legal in no filename, and a key joined into a path would have
  // refused the one op that legitimately has no issue key.
  const dir = tmp()
  const fid = 'a01|123|7'
  const e = enqueue({ stateDir: dir, op: 'createIssue', key: fid, args: { title: 'x', body: 'b', labels: ['triage'], priority: 3 }, requestedBy: 'launcher', at: T0 })
  assert.equal(e.key, fid)
  assert.deepEqual(ls(outboxDir(dir)), [`${e.id}.json`])
  assert.equal(list({ stateDir: dir }).entries[0].key, fid)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-13', args: {} }), /needs a key/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-13', key: '   ', args: {} }), /needs a key/)
})

test('args must be an object and requestedBy must be a session label — a path or a quoting accident is refused', () => {
  // `--args '"text"'` reaches the adapter as a call with no arguments at all; `requestedBy` is
  // joined into the filename and a `../` there writes the entry somewhere no drain ever looks.
  const dir = tmp()
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: 'in-progress' }), /must be a JSON object, got string/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: ['x'] }), /must be a JSON object, got an array/)
  // (`undefined` is the launcher's own default; `null` is a lost label and is refused)
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.hidden', null]) {
    assert.throws(() => enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: {}, requestedBy: bad }), /is not a session label/, `label ${JSON.stringify(bad)}`)
  }
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: {}, at: 'yesterday' }), /is not an instant/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: {}, note: 42 }), /note must be a string/)
  assert.throws(() => enqueue({ stateDir: '', op: 'op-5', key: KEY, args: {} }), /stateDir is required/)
  assert.equal(fs.existsSync(outboxDir(dir)), false)
  // a numeric label is the common case (FLEET_LABEL=3) and is a label
  assert.equal(enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'in-progress' }, requestedBy: 3, at: T0 }).requestedBy, '3')
})

test('entries drain in the order they were added — never by timestamp, never by directory order', () => {
  // op-11 comment before op-9 cancel, op-15 patchBody before the done flag: a state change moves the
  // issue out from under its rationale. And an NTP step backwards mid-run must not reorder the queue,
  // so the instant is a tie-break only and the per-outbox sequence is the order.
  const dir = tmp()
  const a = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'why' }, requestedBy: '3', at: at(10) })
  const b = enqueue({ stateDir: dir, op: 'op-9', key: KEY, args: { reason: 'why' }, requestedBy: '3', at: at(5) }) // clock stepped back
  const c = enqueue({ stateDir: dir, op: 'op-15', key: 'ABC-1240', args: { edits: [{ find: 'a', replace: 'b' }] }, requestedBy: '2', at: at(1) })
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3])
  assert.deepEqual(list({ stateDir: dir }).entries.map(e => e.op), ['comment', 'cancel', 'patchBody'])
  // …and the directory listing, sorted by name, would have said otherwise
  assert.notDeepEqual(ls(outboxDir(dir)).map(n => n.slice(0, -5)), [a.id, b.id, c.id])
  // the sequence mutex is taken per add and released with it — a held lock would stall every other add
  assert.equal(fs.existsSync(path.join(dir, 'locks', 'outbox', 'seq')), false)

  // the pure rule: seq first, then the instant, then the label
  const shuffled = [
    { seq: 2, at: at(0), requestedBy: '1' }, { seq: 1, at: at(9), requestedBy: '9' },
    { seq: 3, at: at(0), requestedBy: 'b' }, { seq: 3, at: at(0), requestedBy: 'a' }, { seq: 3, at: at(-1), requestedBy: 'z' },
  ]
  assert.deepEqual(drainOrder(shuffled).map(e => `${e.seq}/${e.requestedBy}`), ['1/9', '2/1', '3/z', '3/a', '3/b'])
})

test('two processes adding at once never mint the same sequence number — the order stays the order of addition, not the clock', async () => {
  // nextSeq is a scan-then-write; without the mutex a session and the launcher scanning in the same
  // window compute the same seq, the filenames differ by label so nothing is clobbered, and drainOrder
  // falls to the timestamp tie-break — the ordering the module exists to rule out. Two real `node`
  // processes contend on one state dir here; each holds `locks/outbox/seq/` for one add at a time.
  // (sys/lock.mjs's tryAcquire failed this test on its first run: its steal path writes a holder into
  // a directory another acquire just re-created, and both adds minted seq 4.)
  const dir = tmp()
  const each = 25
  const script = `
    const { enqueue } = await import(process.env.FLEET_TEST_MODULE)
    for (let i = 0; i < ${each}; i++) {
      enqueue({ stateDir: process.env.FLEET_TEST_STATE_DIR, op: 'op-11', key: 'ABC-1234', args: { text: process.env.FLEET_LABEL + ':' + i }, requestedBy: process.env.FLEET_LABEL })
    }
  `
  const run = label => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, FLEET_TEST_MODULE: new URL('../src/trackers/outbox.mjs', import.meta.url).href, FLEET_TEST_STATE_DIR: dir, FLEET_LABEL: label },
  })
  await Promise.all([run('3'), run('launcher')])
  const view = list({ stateDir: dir })
  assert.deepEqual(view.unreadable, [])
  assert.equal(view.entries.length, 2 * each)
  const seqs = view.entries.map(e => e.seq)
  assert.deepEqual(seqs, Array.from({ length: 2 * each }, (_, i) => i + 1), 'every seq minted exactly once, 1…N, so the order never falls to the timestamp')
  assert.equal(fs.existsSync(path.join(dir, 'locks', 'outbox', 'seq')), false, 'both processes released the mutex')
})

test('the sequence never restarts after a drain, so a new id can never land on an acknowledged one', () => {
  // Pending alone would restart at 1 once the queue drained; the next entry from the same session in
  // the same millisecond would then be named exactly like a record `applied/` already holds, and a
  // rename replaces silently on every platform.
  const dir = tmp()
  const a = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'x' }, requestedBy: '3', at: T0 })
  const b = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'x' }, requestedBy: '3', at: T0 })
  assert.notEqual(a.id, b.id, 'same instant, same label, still two entries')
  ack(a.id, { stateDir: dir, result: {}, at: T0 })
  ack(b.id, { stateDir: dir, result: {}, at: T0 })
  assert.deepEqual(pending({ stateDir: dir }).entries, [])
  const c = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'x' }, requestedBy: '3', at: T0 })
  assert.equal(c.seq, 3)
  const ids = [...applied({ stateDir: dir }).entries, ...pending({ stateDir: dir }).entries].map(e => e.id)
  assert.equal(new Set(ids).size, 3)
})

test('a comment and a cancellation reason are verbatim by definition, and verbatimText hands back the bytes exactly as queued', () => {
  // A cancellation rationale is evidence; paraphrasing it is how a wrong cancellation becomes
  // unfindable. The text is round-tripped through disk with its leading whitespace, CRLF, tabs,
  // non-ASCII and trailing newline intact — a session that forgot `--verbatim` gets the same.
  const dir = tmp()
  const text = '  Fixed on base at src/thing.tsx:42\r\n\tsee also `src/thing.test.ts:88`\n⛔ do not re-open — ada, 2026-03-14\n\n'
  const e = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text }, requestedBy: '3', at: T0 }) // no verbatim flag
  assert.equal(e.verbatim, true)
  const listed = list({ stateDir: dir }).entries[0]
  assert.equal(listed.verbatim, true)
  assert.equal(verbatimText(listed), text)
  assert.equal(Buffer.from(verbatimText(listed), 'utf8').equals(Buffer.from(text, 'utf8')), true)

  const cancel = enqueue({ stateDir: dir, op: 'op-9', key: KEY, args: { reason: text }, requestedBy: '3', at: T0 })
  assert.equal(verbatimText(list({ stateDir: dir }).entries.find(x => x.id === cancel.id)), text)
  assert.deepEqual([...ALWAYS_VERBATIM], [9, 11, 15, 24])

  // an op with no text is not verbatim, and asking for its text answers null rather than ""
  const plain = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'in-review' }, requestedBy: '3', at: T0 })
  assert.equal(plain.verbatim, false)
  assert.equal(verbatimText(plain), null)
  // a body IS text when the session says so
  const created = enqueue({ stateDir: dir, op: 'op-13', key: 'a01|1|1', args: { title: 't', body: 'the body' }, verbatim: true, requestedBy: 'launcher', at: T0 })
  assert.equal(verbatimText(created), 'the body')
})

test('op-15 body edits survive exactly, and verbatimText is null there because the texts live in args.edits', () => {
  // The ⛔ block after a refuted prescription lands IMMEDIATELY after the prescription, in the body,
  // and the `find` is what locates it: one character tidied and the edit lands nowhere.
  const dir = tmp()
  const edits = [{ find: 'Prescribed fix: change X', replace: 'Prescribed fix: change X\n\n⛔ DO NOT change X — it breaks Y; see comment 2026-03-14' }]
  enqueue({ stateDir: dir, op: 'op-15', key: KEY, args: { edits }, requestedBy: '3', at: T0 })
  const e = list({ stateDir: dir }).entries[0]
  assert.equal(e.verbatim, true)
  assert.deepEqual(e.args.edits, edits)
  assert.equal(verbatimText(e), null)
})

test('--verbatim on an op with nothing to post, or a verbatim op with no text, is refused at the door', () => {
  // Refused HERE: a comment with an empty text, applied at drain time, is a state change with no
  // record — the mystery the comment-first rule exists to prevent.
  const dir = tmp()
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-8', key: KEY, args: { url: 'https://github.com/acme/app/pull/1' }, verbatim: true }), /carries no text to post verbatim/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: {} }), /needs a non-empty string in args\.text/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-9', key: KEY, args: { reason: '' } }), /needs a non-empty string in args\.reason/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-15', key: KEY, args: { edits: [] } }), /needs args\.edits/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-15', key: KEY, args: { edits: [{ find: '', replace: 'x' }] } }), /needs args\.edits/)
  assert.throws(() => enqueue({ stateDir: dir, op: 'op-24', key: KEY, args: { ofKey: 'ABC-1240' } }), /needs a non-empty string in args\.evidence/)
  assert.equal(fs.existsSync(outboxDir(dir)), false)
})

test('ack MOVES the entry to applied/ with the result merged in — never a delete', () => {
  // The applied record is the only evidence of why an issue changed state: a reconciler reading a
  // done flag that says "cancelled" while the tracker says otherwise has nothing else to consult.
  const dir = tmp()
  const e = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'why' }, requestedBy: '3', at: T0 })
  const rec = ack(e.id, { stateDir: dir, result: { commentId: 'c1', verified: 'op-2 shows the comment' }, at: at(60) })
  assert.equal(rec.id, e.id)
  assert.deepEqual(rec.result, { commentId: 'c1', verified: 'op-2 shows the comment' })
  assert.equal(rec.appliedAt, at(60))
  assert.equal(rec.file, path.join(appliedDir(dir), `${e.id}.json`))
  assert.deepEqual(ls(outboxDir(dir)), ['applied'], 'the pending file is gone and nothing else appeared')
  assert.deepEqual(ls(appliedDir(dir)), [`${e.id}.json`])
  assert.deepEqual(pending({ stateDir: dir }).entries, [])
  const done = applied({ stateDir: dir })
  assert.deepEqual(done.unreadable, [])
  assert.equal(done.entries.length, 1)
  assert.equal(verbatimText(done.entries[0]), 'why', 'the text is still readable after the move')
  assert.deepEqual(done.entries[0].result, rec.result)
  // a result may legitimately be absent (the launcher verified and had nothing to record)
  const f = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'x' }, requestedBy: '3', at: T0 })
  assert.equal(ack(f.id, { stateDir: dir, at: T0 }).result, null)
})

test('acknowledging twice, or acknowledging what was never queued, throws — "acknowledged twice" means "applied twice"', () => {
  const dir = tmp()
  const e = enqueue({ stateDir: dir, op: 'op-5', key: KEY, args: { state: 'x' }, requestedBy: '3', at: T0 })
  ack(e.id, { stateDir: dir, at: T0 })
  assert.throws(() => ack(e.id, { stateDir: dir, at: T0 }), /already acknowledged/)
  assert.throws(() => ack(entryName({ at: T0, requestedBy: '3', seq: 9 }), { stateDir: dir }), /no pending entry/)
  assert.throws(() => ack('9', { stateDir: dir }), /is not an outbox entry id/)
  assert.throws(() => ack('../applied/x', { stateDir: dir }), /is not an outbox entry id/)
  assert.deepEqual(ls(appliedDir(dir)), [`${e.id}.json`], 'nothing written by any of the refusals')
})

test('an entry in BOTH directories is an interrupted ack: never handed out as pending, finished by the next ack — and a torn applied record leaves the pending copy where it is', () => {
  // The move is two steps; a launcher killed between them leaves the entry in BOTH directories. The op
  // landed and was verified before the ack began, so a drain that lists it as pending posts the
  // comment twice — it goes under `alreadyApplied`, which the launcher only acks.
  const dir = tmp()
  const e = enqueue({ stateDir: dir, op: 'op-8', key: KEY, args: { url: 'https://github.com/acme/app/pull/1', title: 'PR' }, requestedBy: '3', at: T0 })
  const f = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'why' }, requestedBy: '3', at: T0 })
  fs.mkdirSync(appliedDir(dir), { recursive: true })
  const appliedFile = path.join(appliedDir(dir), `${e.id}.json`)
  fs.writeFileSync(appliedFile, JSON.stringify({ ...e, file: undefined, result: { linked: true }, appliedAt: at(30) })) // the first ack died right after this write
  const view = list({ stateDir: dir })
  assert.deepEqual(view.entries.map(x => x.id), [f.id], 'the applied one is NOT a pending entry')
  assert.equal(view.alreadyApplied.length, 1)
  const [seen] = view.alreadyApplied
  assert.deepEqual([seen.id, seen.op, seen.appliedFile, seen.appliedAt, seen.result, seen.error], [e.id, 'attachLink', appliedFile, at(30), { linked: true }, null])
  assert.deepEqual(ls(outboxDir(dir)), [`${e.id}.json`, `${f.id}.json`, 'applied'].sort(), 'a read finishes nothing')
  const rec = ack(e.id, { stateDir: dir, result: { ignored: true }, at: T0 })
  assert.equal(rec.id, e.id)
  assert.deepEqual(rec.result, { linked: true }, 'the record the first ack wrote is what stands')
  assert.deepEqual(pending({ stateDir: dir }).entries.map(x => x.id), [f.id])
  assert.deepEqual(pending({ stateDir: dir }).alreadyApplied, [])
  assert.deepEqual(ls(appliedDir(dir)), [`${e.id}.json`])

  // A torn applied record: the tracker may hold the change, so the entry is still not handed out
  // blind — and the pending copy is the op's only readable record, so the ack must not remove it.
  fs.writeFileSync(path.join(appliedDir(dir), `${f.id}.json`), '{"v":1,')
  const torn = list({ stateDir: dir })
  assert.deepEqual(torn.entries, [])
  assert.equal(torn.alreadyApplied[0].id, f.id)
  assert.match(torn.alreadyApplied[0].error, /^applied record is not valid JSON$/)
  assert.throws(() => ack(f.id, { stateDir: dir, at: T0 }), /applied record .* is not valid JSON — the pending entry stays in place/)
  assert.equal(fs.existsSync(f.file), true, 'the pending copy survived the throw')
  assert.equal(list({ stateDir: dir }).alreadyApplied.length, 1, 'and is still listed')
})

test('verbatim is re-derived on read: an op-11 whose flag was lost is still verbatim, and a verbatim entry with no text is unreadable', () => {
  // Another producer's bare `{op, key, args}` (a cloud worker, the check planner) and a hand edit both
  // arrive without the flag; trusting it would let the launcher paraphrase a comment the header
  // promises is verbatim by definition.
  const dir = tmp()
  const e = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'the exact words' }, requestedBy: '3', at: T0 })
  const onDisk = JSON.parse(fs.readFileSync(e.file, 'utf8'))
  for (const flag of [{ verbatim: false }, {}]) {
    const d = { ...onDisk, ...flag }
    if (!('verbatim' in flag)) delete d.verbatim
    fs.writeFileSync(e.file, JSON.stringify(d))
    const listed = list({ stateDir: dir }).entries[0]
    assert.equal(listed.verbatim, true, `flag ${JSON.stringify(flag)}`)
    assert.equal(verbatimText(listed), 'the exact words')
  }
  // the text itself gone: an unreadable entry, reported — never a comment posted with nothing in it
  fs.writeFileSync(e.file, JSON.stringify({ ...onDisk, args: {} }))
  const view = list({ stateDir: dir })
  assert.deepEqual(view.entries, [])
  assert.match(view.unreadable[0].error, /is verbatim but carries no text to post — it needs a non-empty string in args\.text/)
  assert.throws(() => ack(e.id, { stateDir: dir }), /fix or move it by hand/)
  // a flag set by hand on an op that has no text to post is reported too, by op name
  const g = enqueue({ stateDir: dir, op: 'op-8', key: KEY, args: { url: 'https://github.com/acme/app/pull/1', title: 'PR' }, requestedBy: '3', at: T0 })
  fs.writeFileSync(g.file, JSON.stringify({ ...JSON.parse(fs.readFileSync(g.file, 'utf8')), verbatim: true }))
  assert.match(list({ stateDir: dir }).unreadable.find(u => u.id === g.id).error, /is flagged verbatim, but op-8 attachLink has no text to post/)
})

test('a failed apply stays pending with the attempt recorded, and the drain view says re-fetch before retrying', () => {
  // A tracker once applied an oversized write and then errored on the ECHO; the blind retry applied
  // it twice. The module cannot re-fetch (it has no tracker), so it marks: the launcher re-reads the
  // issue (op-2) before any second attempt.
  const dir = tmp()
  const e = enqueue({ stateDir: dir, op: 'op-15', key: KEY, args: { edits: [{ find: 'a', replace: 'b' }] }, requestedBy: '3', at: T0 })
  assert.equal(list({ stateDir: dir }).entries[0].refetchBeforeRetry, false)
  const after = recordAttempt(e.id, { stateDir: dir, result: { error: 'response too large to return' }, at: at(30) })
  assert.deepEqual(after.attempts, [{ at: at(30), result: { error: 'response too large to return' } }])
  assert.equal(after.file, e.file, 'in place: still the pending file')
  const view = list({ stateDir: dir }).entries[0]
  assert.equal(view.refetchBeforeRetry, true)
  assert.equal(refetchBeforeRetry(view), true)
  assert.deepEqual(view.args.edits, [{ find: 'a', replace: 'b' }], 'the op itself is untouched')
  assert.deepEqual(ls(outboxDir(dir)), [`${e.id}.json`], 'no temp file, no applied dir')
  // …and it can then be acknowledged, attempts and all
  const rec = ack(e.id, { stateDir: dir, result: { applied: 1 }, at: at(90) })
  assert.equal(rec.attempts.length, 1)
  assert.throws(() => recordAttempt(e.id, { stateDir: dir, result: {} }), /already acknowledged/)
  assert.throws(() => recordAttempt(entryName({ at: T0, requestedBy: '3', seq: 7 }), { stateDir: dir, result: {} }), /no pending entry/)
})

test('an unreadable entry is reported beside the healthy ones, never skipped — a skipped entry is an op nobody applies', () => {
  const dir = tmp()
  const good = enqueue({ stateDir: dir, op: 'op-11', key: KEY, args: { text: 'ok' }, requestedBy: '3', at: T0 })
  const d = outboxDir(dir)
  const name = seq => `${entryName({ at: T0, requestedBy: '3', seq })}.json`
  fs.writeFileSync(path.join(d, 'notes.json'), '{"op":"comment","key":"ABC-1234","args":{"text":"hand-written"}}')
  fs.writeFileSync(path.join(d, name(5)), '{"v":1,') // torn write
  fs.writeFileSync(path.join(d, name(6)), JSON.stringify({ ...good, file: undefined, id: name(7).slice(0, -5), seq: 7 })) // claims another id
  fs.writeFileSync(path.join(d, name(8)), JSON.stringify({ ...good, file: undefined, id: name(8).slice(0, -5), seq: 9 })) // seq disagrees
  fs.writeFileSync(path.join(d, name(10)), JSON.stringify({ ...good, file: undefined, id: name(10).slice(0, -5), seq: 10, n: 99, op: undefined }))
  fs.writeFileSync(path.join(d, `.${name(11)}.4242.0.tmp`), '{"v":1') // an interrupted write of ours: not an entry, not a complaint
  fs.mkdirSync(path.join(d, 'applied'), { recursive: true })

  const view = list({ stateDir: dir })
  assert.deepEqual(view.entries.map(e => e.id), [good.id])
  assert.deepEqual(view.unreadable.map(u => u.id), [name(5), name(6), name(8), name(10)].map(n => n.slice(0, -5)).concat(['notes']).sort())
  const errors = Object.fromEntries(view.unreadable.map(u => [u.id, u.error]))
  assert.match(errors.notes, /is not named <ts>-<label>-<seq>\.json/)
  assert.match(errors[name(5).slice(0, -5)], /is not valid JSON/)
  assert.match(errors[name(6).slice(0, -5)], /carries id .*not its filename/)
  assert.match(errors[name(8).slice(0, -5)], /carries seq 9, its filename says 8/)
  assert.match(errors[name(10).slice(0, -5)], /carries n 99/)
  for (const u of view.unreadable) assert.equal(path.dirname(u.file), d, 'each report names the file')
  // a well-named file that cannot be read is never acknowledged in passing
  assert.throws(() => ack(name(5).slice(0, -5), { stateDir: dir }), /fix or move it by hand/)
  assert.deepEqual(ls(appliedDir(dir)), [])
})

test('a missing outbox reads as empty and is not created by a read', () => {
  const dir = tmp()
  assert.deepEqual(list({ stateDir: dir }), { entries: [], alreadyApplied: [], unreadable: [] })
  assert.deepEqual(pending({ stateDir: dir }), { entries: [], alreadyApplied: [], unreadable: [] })
  assert.deepEqual(applied({ stateDir: dir }), { entries: [], unreadable: [] })
  assert.equal(fs.existsSync(outboxDir(dir)), false)
})

test('the launcher records an op it applied from a done flag as enqueue + ack, so a cleared flag is not the only record of why', () => {
  // A cancelled flag was once the whole report and the reclaimer's last act deleted it; the finding
  // existed for fifteen seconds. The applied record carries the reason verbatim, and the planner's
  // `note` rides along for the launcher's eyes only.
  const dir = tmp()
  const reason = 'fixed on base at src/thing.tsx:42 (test src/thing.test.ts:88)'
  const e = enqueue({ stateDir: dir, op: 'cancel', key: KEY, args: { reason }, requestedBy: 'launcher', at: T0, note: 'from flags/done-3.json' })
  assert.equal(e.note, 'from flags/done-3.json')
  assert.equal(list({ stateDir: dir }).entries[0].note, 'from flags/done-3.json')
  ack(e.id, { stateDir: dir, result: { state: 'cancelled', verified: 'op-2' }, at: at(5) })
  const rec = applied({ stateDir: dir }).entries[0]
  assert.equal(verbatimText(rec), reason)
  assert.equal(rec.note, 'from flags/done-3.json')
  assert.deepEqual(rec.result, { state: 'cancelled', verified: 'op-2' })
})

test('the drain view carries what the playbook promises: {id, op, key, args, verbatim}, in op names the adapter is keyed by number for', () => {
  const dir = tmp()
  enqueue({ stateDir: dir, op: 'op-7', key: KEY, args: { state: 'in-review' }, requestedBy: '3', at: T0 })
  const e = list({ stateDir: dir }).entries[0]
  for (const f of ['id', 'op', 'key', 'args', 'verbatim', 'n', 'requestedBy', 'at', 'file']) assert.ok(f in e, `entry lacks ${f}`)
  assert.equal(e.n, 7, 'op-7 stays op-7 — a drain keyed by the name setState would apply op-5')
  assert.equal(e.op, 'setState')
})

// ================================================================================================
// The ticket cache
// ================================================================================================

const cfg = {
  checker: { provenanceLabel: 'filed-by:fleet-check', gate: { labels: { pending: 'gate:pending', passed: 'gate:passed', failed: 'gate:failed', uncertain: 'gate:uncertain', disputed: 'gate:disputed', waived: 'gate:waived' } } },
  fleet: { queue: { requireGate: true } },
}

test('a cached ticket round-trips byte for byte, and its .md twin ends with the description exactly as written', () => {
  // A session works from this text as its specification: a description that came back re-wrapped,
  // trimmed or with its CRLFs folded is a different ticket.
  const dir = tmp()
  const description = '## Edge case\r\n\r\n  Prescribed fix: change X  \n```\ncode  block\n```\n⛔ — ada, 2026-03-14'
  const r = cacheTicket({ stateDir: dir, key: KEY, title: 'Fix the import flow', description, url: 'https://github.com/acme/app/issues/1234', status: 'Todo', priority: 2, suggestedBranch: 'ada/abc-1234-fix-the-import-flow', labels: ['triage'], at: T0 })
  assert.equal(r.file, ticketPaths(dir, KEY).json)
  assert.equal(r.mdFile, ticketPaths(dir, KEY).md)
  assert.deepEqual(ls(ticketsDir(dir)), ['ABC-1234.json', 'ABC-1234.md'], 'both files, no temp file')
  const back = readTicket(KEY, { stateDir: dir })
  assert.equal(back.description, description)
  assert.equal(Buffer.from(back.description, 'utf8').equals(Buffer.from(description, 'utf8')), true)
  assert.deepEqual({ ...back, file: undefined, mdFile: undefined }, {
    v: 1, key: KEY, id: null, title: 'Fix the import flow', description, url: 'https://github.com/acme/app/issues/1234', status: 'Todo', priority: 2,
    parentId: null, suggestedBranch: 'ada/abc-1234-fix-the-import-flow', labels: ['triage'], cachedAt: T0, body: description, file: undefined, mdFile: undefined,
  })
  assert.equal('body' in JSON.parse(fs.readFileSync(r.file, 'utf8')), false, 'the file keeps op-2\'s one name for the text; `body` is the read result\'s alias for the gate')
  const md = fs.readFileSync(r.mdFile, 'utf8')
  assert.ok(md.startsWith('# ABC-1234 — Fix the import flow\n'), md.split('\n')[0])
  assert.ok(md.endsWith('\n---\n\n' + description + '\n'), 'the description is the tail of the twin, verbatim, ending on a line')
  for (const line of ['- url: https://github.com/acme/app/issues/1234', '- status: Todo', '- priority: 2', '- labels: triage', '- suggested branch: ada/abc-1234-fix-the-import-flow', `- cached: ${T0}`]) {
    assert.ok(md.includes(`${line}\n`), `twin lacks "${line}"`)
  }
  // a title with a newline is folded onto the heading; a missing description says so
  assert.ok(renderTicketMarkdown(ticketRecord({ key: KEY, title: 'a\nb', at: T0 })).startsWith('# ABC-1234 — a b\n'))
  assert.ok(renderTicketMarkdown(ticketRecord({ key: KEY, title: 't', at: T0 })).endsWith('\n(no description)\n'))
})

test('every bundled adapter\'s example key is a filename, so is a jira-shaped key with an underscore, and anything path-like is refused', () => {
  // A key is joined into `<KEY>.json` off a CLI flag; a new adapter whose keys carry a separator
  // fails here rather than a fleet at spawn time, and `AB_C-12` (jira: letters, digits, underscore)
  // must not be refused, or its session is spawned with no ticketFile.
  const ids = listAdapters({ bundledDir: path.join(ROOT, 'trackers') })
  assert.ok(ids.length >= 5)
  for (const id of ids) {
    const example = loadAdapter(id, { bundledDir: path.join(ROOT, 'trackers') }).front.issueKey.example
    assert.equal(assertKey(example), example, `${id}: example key ${example}`)
  }
  for (const ok of ['AB_C-12', 'GH-1234', '1201234567890123', 'aB3dEf7H', 'ABC-1234']) assert.equal(assertKey(ok), ok)
  const dir = tmp()
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.hidden', '..', 'ABC 1234', 'ABC-1234|1|1', undefined, null, 1234]) {
    assert.throws(() => assertKey(bad), /is not an issue key/, `key ${JSON.stringify(bad)}`)
    assert.throws(() => ticketPaths(dir, bad), /is not an issue key/)
    assert.throws(() => readTicket(bad, { stateDir: dir }), /is not an issue key/)
    assert.throws(() => cacheTicket({ stateDir: dir, key: bad, title: 't' }), /is not an issue key/)
  }
  assert.equal(fs.existsSync(ticketsDir(dir)), false, 'a refused key creates nothing')
  assert.equal(KEY_RE.test('ABC-1234'), true)
})

test('the record validates what a session works from: a title, a string description, a priority on the contract scale', () => {
  // A tracker returning rich text as an object would otherwise be cached as "[object Object]" and a
  // session would work from that; `true` coerced to 1 would be cached as Urgent, and a raw `9` as a
  // legal urgency.
  assert.throws(() => ticketRecord({ key: KEY, title: '  ' }), /needs a title/)
  assert.throws(() => ticketRecord({ key: KEY, title: 't', description: { blocks: [] } }), /description must be a string.*verbatim/)
  for (const bad of ['High', true, false, 0, 5, 9, 1.5, -1, [2], {}, 'NaN', '2.0']) {
    assert.throws(() => ticketRecord({ key: KEY, title: 't', priority: bad }), /priority must be 1 Urgent … 4 Low \(contract §6\) or null/, `priority ${JSON.stringify(bad)}`)
  }
  assert.throws(() => ticketRecord({ key: KEY, title: 't', at: 'yesterday' }), /is not an instant/)
  assert.throws(() => ticketRecord({ key: KEY, title: 't', url: {} }), /url must be a string/)
  assert.deepEqual([1, 2, 3, 4, '1', '4', null, undefined, ''].map(p => ticketRecord({ key: KEY, title: 't', priority: p, at: T0 }).priority), [1, 2, 3, 4, 1, 4, null, null, null])
  const r = ticketRecord({ key: KEY, title: 't', id: 12, priority: '2', at: Date.parse(T0) })
  assert.deepEqual([r.description, r.id, r.priority, r.cachedAt, r.labels], ['', '12', 2, T0, null])
})

test('labels travel with the cache when the feeder has them and the gate reads them; an op-2 feed carries none, and the record says so rather than pretending', () => {
  // The autowave admits a queued key through core/intake.admit against THIS cache. A cache that
  // dropped the labels made every ticket look human-filed, and a gated hypothesis was worked.
  const dir = tmp()
  // The exact op-2 shape (contract §6, and every adapter's Call line returns "the contract's shape
  // and nothing more"): no labels. ⛔ admit() needs the provenance LABEL to know a ticket is
  // checker-filed, so a cache fed from op-2 alone cannot gate this hypothesis — the contract gap the
  // cache cannot close. What it can do is refuse to write `[]` ("the issue carries none") for "the
  // feeder carried none": the record says null and the twin says the gate is blind here.
  const op2 = { key: 'ABC-1', id: 'i-1', title: 'hypothesis', description: '## Edge case\n\n**Gate:** pending (a01)\n\nPrescribed fix: change X\n', url: 'https://github.com/acme/app/issues/1', status: 'Triage', priority: 3, parentId: null }
  const fromOp2 = cacheTicket({ stateDir: dir, ...op2, at: T0 })
  assert.equal(fromOp2.labels, null)
  assert.equal(readTicket('ABC-1', { stateDir: dir }).labels, null)
  assert.equal(JSON.parse(fs.readFileSync(fromOp2.file, 'utf8')).labels, null)
  assert.ok(fs.readFileSync(fromOp2.mdFile, 'utf8').includes('- labels: not supplied by the feeder (op-2 carries none)'), 'the twin names the blind spot')

  // A feeder that carries labels (the op-2 result plus label names, or op-17's {name} rows): the gate
  // reads them, refuses the unverified hypothesis, admits the verified one and the human-filed one.
  const labelled = (key, labels, description = op2.description) => cacheTicket({ stateDir: dir, ...op2, key, description, labels, at: T0 })
  labelled('ABC-2', [{ id: 'l1', name: 'filed-by:fleet-check' }, 'triage'])
  labelled('ABC-3', ['filed-by:fleet-check', 'gate:passed'])
  labelled('ABC-4', [])
  assert.deepEqual(readTicket('ABC-2', { stateDir: dir }).labels, ['filed-by:fleet-check', 'triage'])
  assert.deepEqual(readTicket('ABC-4', { stateDir: dir }).labels, [], 'an empty list is "the issue carries none", kept apart from null')
  assert.deepEqual(admit(readTicket('ABC-2', { stateDir: dir }), cfg), { admit: false, reason: 'ungated', warn: null, gate: 'pending' })
  assert.equal(admit(readTicket('ABC-3', { stateDir: dir }), cfg).admit, true)
  assert.equal(admit(readTicket('ABC-4', { stateDir: dir }), cfg).admit, true)

  // The gate status can live ONLY in the body's `**Gate:**` line (op-15 patches it there after the
  // audit); admit() reads that line from `body`, which the read result carries beside `description`.
  labelled('ABC-5', ['filed-by:fleet-check'], 'Prescribed fix: change X\n\n**Gate:** failed — diagnosis wrong (audit)\n')
  const five = readTicket('ABC-5', { stateDir: dir })
  assert.equal(five.body, five.description)
  assert.deepEqual(admit(five, cfg), { admit: false, reason: 'gate-failed', warn: null, gate: 'failed' })
  assert.equal(listTickets({ stateDir: dir }).tickets.find(t => t.key === 'ABC-5').body, five.description, 'the list view carries it too')

  assert.throws(() => cacheTicket({ stateDir: dir, key: 'ABC-6', title: 't', labels: 'triage' }), /labels must be a list/)
  assert.throws(() => cacheTicket({ stateDir: dir, key: 'ABC-6', title: 't', labels: [{ id: 'l1' }] }), /every label must be a name/)
  // a cache written before labels travelled reads as "not supplied", not as a broken cache
  const p = ticketPaths(dir, 'ABC-7')
  const old = { ...JSON.parse(fs.readFileSync(ticketPaths(dir, 'ABC-4').json, 'utf8')), key: 'ABC-7' }
  delete old.labels
  fs.writeFileSync(p.json, JSON.stringify(old))
  fs.writeFileSync(p.md, '# ABC-7\n')
  assert.equal(readTicket('ABC-7', { stateDir: dir }).labels, null)
  assert.equal(listTickets({ stateDir: dir }).tickets.find(t => t.key === 'ABC-7').labels, null)
  assert.equal(admit(readTicket('ABC-7', { stateDir: dir }), cfg).admit, true, 'no provenance label visible: ordinary work, as intake defines it')
})

test('re-caching replaces both files, so a body patched with a refutation reaches the next session', () => {
  const dir = tmp()
  cacheTicket({ stateDir: dir, key: KEY, title: 'v1', description: 'Prescribed fix: change X', at: T0 })
  const v2 = 'Prescribed fix: change X\n\n⛔ DO NOT change X — it breaks Y; see comment 2026-03-14'
  cacheTicket({ stateDir: dir, key: KEY, title: 'v2', description: v2, at: at(600) })
  const back = readTicket(KEY, { stateDir: dir })
  assert.deepEqual([back.title, back.description, back.cachedAt], ['v2', v2, at(600)])
  assert.ok(fs.readFileSync(back.mdFile, 'utf8').endsWith(v2 + '\n'))
  assert.deepEqual(ls(ticketsDir(dir)), ['ABC-1234.json', 'ABC-1234.md'])
})

test('the .md twin is written first, a failed write leaves no temp file, and the half-cached ticket is reported rather than read', () => {
  // The other order leaves a descriptor pointing at a ticketFile that is not there when the process
  // dies between the two writes; and nothing else ever sweeps `.<name>.<pid>.<n>.tmp`.
  const dir = tmp()
  const p = ticketPaths(dir, KEY)
  fs.mkdirSync(p.json, { recursive: true }) // the rename cannot replace a directory
  // (EISDIR on Linux, EPERM on Windows: the JSON rename is what failed, not anything before it)
  assert.throws(() => cacheTicket({ stateDir: dir, key: KEY, title: 't', description: 'd', at: T0 }), /EISDIR|EPERM|ENOTDIR|EEXIST/)
  assert.deepEqual(ls(ticketsDir(dir)), ['ABC-1234.json', 'ABC-1234.md'], 'the twin landed, the JSON did not, no temp file')
  const half = listTickets({ stateDir: dir })
  assert.deepEqual(half.tickets, [])
  assert.equal(half.unreadable.length, 1)
  assert.match(half.unreadable[0].error, /cannot be read/)
  fs.rmdirSync(p.json)
  const orphanMd = listTickets({ stateDir: dir })
  assert.deepEqual(orphanMd.tickets, [])
  assert.match(orphanMd.unreadable[0].error, /has no \.json record — an interrupted cache write/)
  assert.equal(readTicket(KEY, { stateDir: dir }), null, 'no record means never cached: the launcher caches again')
})

test('readTicket is null for an absent key and THROWS for a corrupt one — "absent" would send a session to flag over a cache the launcher can see', () => {
  const dir = tmp()
  fs.mkdirSync(ticketsDir(dir), { recursive: true })
  fs.writeFileSync(ticketPaths(dir, 'ABC-1').json, '{"key":"ABC-1"')
  fs.writeFileSync(ticketPaths(dir, 'ABC-2').json, JSON.stringify({ key: 'ABC-9', title: 't', description: '' }))
  fs.writeFileSync(ticketPaths(dir, 'ABC-3').json, JSON.stringify({ key: 'ABC-3', title: 't', description: { rich: true } }))
  assert.throws(() => readTicket('ABC-1', { stateDir: dir }), /cache .*ABC-1\.json is not valid JSON/)
  assert.throws(() => readTicket('ABC-2', { stateDir: dir }), /carries key "ABC-9", not its filename/)
  assert.throws(() => readTicket('ABC-3', { stateDir: dir }), /has no description string/)
  assert.equal(readTicket('ABC-4', { stateDir: dir }), null)
})

test('lookups are exact-key on every platform: a case-different key is a miss, never another ticket', () => {
  // On a case-folding volume the filesystem answers `abc-1234.json` with ABC-1234's file; a session
  // and the launcher must get the same answer for the same string on Windows and on Linux.
  const dir = tmp()
  cacheTicket({ stateDir: dir, key: KEY, title: 't', at: T0 })
  assert.equal(readTicket('abc-1234', { stateDir: dir }), null)
  assert.equal(readTicket(KEY, { stateDir: dir }).key, KEY)
})

test('listTickets orders by key and reports every file that is not a whole cached ticket', () => {
  const dir = tmp()
  cacheTicket({ stateDir: dir, key: 'ABC-2', title: 'two', at: T0 })
  cacheTicket({ stateDir: dir, key: 'ABC-10', title: 'ten', at: T0 })
  const d = ticketsDir(dir)
  fs.writeFileSync(path.join(d, 'notes.json'), '{}') // a valid key SHAPE with no ticket in it
  fs.writeFileSync(path.join(d, 'bad key.json'), '{}') // not a key shape at all
  fs.writeFileSync(path.join(d, 'bad name.md'), '# stray\n') // not a key shape either — a stray file, not an interrupted write
  fs.writeFileSync(path.join(d, '.hidden.json'), '{}') // dot-names are not keys, whichever extension
  fs.writeFileSync(path.join(d, '.hidden.md'), '#\n')
  fs.writeFileSync(path.join(d, 'ABC-3.md'), '# ABC-3\n') // interrupted cache: twin with no record
  fs.writeFileSync(path.join(d, 'ABC-4.json'), '{"key":') // torn
  fs.writeFileSync(path.join(d, 'ABC-6.json'), JSON.stringify({ key: 'ABC-6', title: 't', description: '' })) // record with no twin
  fs.writeFileSync(path.join(d, '.ABC-7.json.4242.0.tmp'), '{') // ours, in flight
  fs.writeFileSync(path.join(d, '.ABC-7.md.4242.1.tmp'), '#')
  const view = listTickets({ stateDir: dir })
  assert.deepEqual(view.tickets.map(t => t.key), ['ABC-10', 'ABC-2'])
  assert.deepEqual(view.unreadable.map(u => u.key), ['.hidden', '.hidden', 'ABC-3', 'ABC-4', 'ABC-6', 'bad key', 'bad name', 'notes'])
  const errors = Object.fromEntries(view.unreadable.filter(u => u.key !== '.hidden').map(u => [u.key, u.error]))
  assert.match(errors['ABC-3'], /has no \.json record/)
  assert.match(errors['ABC-4'], /is not valid JSON/)
  assert.match(errors['ABC-6'], /has no \.md twin/)
  assert.match(errors['bad key'], /is not named <KEY>\.json/)
  assert.match(errors['bad name'], /is not named <KEY>\.md, so it is not a cached ticket/)
  assert.match(errors.notes, /carries key undefined, not its filename/)
  // the same rule for both extensions: `.hidden.json` and `.hidden.md` are each reported, neither silently
  assert.deepEqual(view.unreadable.filter(u => u.key === '.hidden').map(u => path.basename(u.file)).sort(), ['.hidden.json', '.hidden.md'])
  for (const u of view.unreadable) assert.equal(path.dirname(u.file), d)
})

test('a missing tickets directory reads as empty, is not created by a read, and is created by the first cache', () => {
  const dir = tmp()
  assert.deepEqual(listTickets({ stateDir: dir }), { tickets: [], unreadable: [] })
  assert.equal(readTicket(KEY, { stateDir: dir }), null)
  assert.equal(fs.existsSync(ticketsDir(dir)), false)
  assert.throws(() => listTickets({ stateDir: '' }), /stateDir is required/)
  cacheTicket({ stateDir: dir, key: KEY, title: 't', at: T0 })
  assert.equal(listTickets({ stateDir: dir }).tickets.length, 1)
})
