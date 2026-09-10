import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliverSeedPrompt, gateShowing, stillUnsent } from '../src/cli/commands/up.mjs'

// The failure every test here is about: `spawn` returns as soon as tmux has a window, but the agent
// CLI inside it may still be showing a modal. The seed prompt goes into that modal, the Enter is
// swallowed, and tmux reports success either way — it can only report delivery of a KEYSTROKE.

const PROMPT = 'Read your descriptor at /state/sessions/1.json and start on ABC-1234 now.'

/** A backend whose pane text is scripted turn by turn. */
function fakeBackend(screens, { canSubmit = true } = {}) {
  const calls = { sends: [], submits: 0, reads: 0 }
  return {
    calls,
    readText() {
      calls.reads++
      return screens.length > 1 ? screens.shift() : screens[0]
    },
    send(_h, text) {
      calls.sends.push(text)
      return { ok: true, requested: text.length, delivered: text.length, truncated: false }
    },
    ...(canSubmit ? { submit() { calls.submits++; return { ok: true, reason: null } } } : {}),
  }
}

const nap = () => Promise.resolve()

test('the dialogs a session cannot answer are recognised by name', () => {
  assert.equal(gateShowing('Is this a project you trust?\n 1. Yes, I trust this folder'), 'a workspace-trust dialog')
  assert.equal(gateShowing('MCP servers may execute code or access system resources.'), 'an MCP-server approval dialog')
  assert.equal(gateShowing('⏵⏵ bypass permissions on · esc to interrupt'), null, 'a working session is not a gate')
  assert.equal(gateShowing(''), null)
  assert.equal(gateShowing(null), null)
})

test('unsent text is recognised through the input line\'s own wrapping', () => {
  // ⛔ A TUI wraps the input line at the pane width, so a literal substring test misses its own text
  // and the launcher would call an unsent prompt delivered.
  const wrapped = 'Read your descriptor at /state/sessions/1.json and start\non ABC-1234 now.\n'
  assert.equal(stillUnsent(wrapped, PROMPT), true)
  assert.equal(stillUnsent('⏺ Reading playbook…\n✽ Working (12s)', PROMPT), false)
  assert.equal(stillUnsent('', PROMPT), false)
})

test('a prompt the agent ECHOED after accepting it is not mistaken for one still unsent', () => {
  // ⛔ The regression this exists for. An agent that accepts a prompt echoes it into the transcript,
  // so the text is still on screen after a perfectly successful submit — above the input box, not in
  // it. Searching the whole capture reported every STARTED session as stuck, pressed Enter into it
  // three more times, and failed the launch of a fleet that was already working.
  const accepted = [
    '  Read your descriptor at /state/sessions/1.json and start on ABC-1234 now.',
    '',
    '⏺ I will start by reading my session descriptor and playbook.',
    '',
    '  Reading playbook part 1',
    '  ⎿  $ sed -n \'1,400p\' /state/playbook.md',
    ...Array.from({ length: 14 }, (_, i) => `  … playbook line ${i}`),
    '',
    '✽ Bootstrapping… (24s · ↓ 1.2k tokens)',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on · esc to interrupt',
  ].join('\n')
  assert.equal(stillUnsent(accepted, PROMPT), false, 'the echo sits above the input box, so it is not unsent')

  // The genuine article: the same text, but at the bottom, where the cursor is.
  const sitting = ['⏺ earlier output', '────────', `❯ ${PROMPT}`, '────────', '  ⏵⏵ bypass permissions on'].join('\n')
  assert.equal(stillUnsent(sitting, PROMPT), true)
})

test('the prompt waits for a trust dialog to clear, and is only sent once it has', async () => {
  const backend = fakeBackend([
    'Quick safety check: Is this a project you trust?',
    'Quick safety check: Is this a project you trust?',
    '❯ ready for input',
    '⏺ working now',
  ])
  const lines = []
  const r = await deliverSeedPrompt(backend, {}, PROMPT, { label: 'fleet up: 1', log: l => lines.push(l), sleep: nap })
  assert.equal(r.ok, true)
  assert.deepEqual(backend.calls.sends, [PROMPT], 'sent exactly once, after the gate cleared')
  assert.equal(lines.length, 1, 'the operator is told once, not once per poll')
  assert.match(lines[0], /waiting on a workspace-trust dialog in its window/)
})

test('a prompt left sitting in the input line is re-submitted, not called delivered', async () => {
  // The exact production failure: text landed, Enter was eaten, every layer reported success.
  const stuck = `❯ ${PROMPT}`
  // Read 1 is the gate check (no gate, so the prompt is sent); reads 2 and 3 still show the text
  // sitting in the input line, read 4 shows it gone.
  const backend = fakeBackend(['❯ ready for input', stuck, stuck, '⏺ off it goes'])
  const r = await deliverSeedPrompt(backend, {}, PROMPT, { label: '1', sleep: nap })
  assert.equal(r.ok, true)
  assert.equal(backend.calls.submits, 2, 'Enter is pressed again until the text leaves the input line')
  assert.deepEqual(backend.calls.sends, [PROMPT], 'the prompt itself is never sent twice')
})

test('a prompt that will not submit is reported as a failure, not as a healthy session', async () => {
  const backend = fakeBackend([`❯ ${PROMPT}`])
  const r = await deliverSeedPrompt(backend, {}, PROMPT, { label: '1', sleep: nap, attempts: 2 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /reached the input line but was never submitted/)
  assert.equal(backend.calls.submits, 2)
})

test('a gate that never clears fails the delivery instead of hanging the launch', async () => {
  let now = 0
  const backend = fakeBackend(['Is this a project you trust?'])
  const r = await deliverSeedPrompt(backend, {}, PROMPT, {
    label: '1', sleep: nap, gateMs: 5000, now: () => (now += 1000),
  })
  assert.equal(r.ok, false)
  assert.equal(r.gate, 'a workspace-trust dialog')
  assert.equal(backend.calls.sends.length, 0, 'nothing is typed into a dialog')
})

test('a backend that cannot read its panes keeps the old behaviour rather than failing', async () => {
  // Windows Terminal has no capture; the gate is an improvement where it exists, never a new floor.
  const calls = []
  const blind = { send: (_h, t) => { calls.push(t); return { ok: true, requested: t.length, delivered: t.length, truncated: false } } }
  const r = await deliverSeedPrompt(blind, {}, PROMPT, { label: '1', sleep: nap })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [PROMPT])
})
