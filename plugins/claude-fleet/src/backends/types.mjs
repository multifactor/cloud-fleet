// The terminal-backend interface — the seam that makes this tool cross-platform.
//
// Sessions are NOT found by grepping process command lines. That is how the private original worked
// and nearly every trap it accumulated is downstream of it: a filter self-matching the shell running
// it, session 7 matching session 70, a kill by exclusion taking an unrelated agent with it. Here a
// backend resolves an opaque `backendRef` recorded in the registry, and command-line matching
// survives only as the reconciler that rebuilds the registry after a crash.
//
// The interface is designed from tmux's object model — a pane is a named, addressable thing with a
// stable id and attachable user options — and the Windows backend is brought up to that level by its
// own registry rather than the interface being dragged down to Windows Terminal's (which has no
// query API at all).
//
// Every backend declares CAPABILITIES rather than silently doing nothing. A caller that needs
// something a backend lacks logs one line saying so; there are no silent no-ops.

/**
 * @typedef {object} Capabilities
 * @property {boolean} authoritativeList     list() reflects reality without a process snapshot
 * @property {boolean} reliableSend          send() delivers arbitrary length without truncation
 * @property {boolean} observableStatus      setStatus() can be read back
 * @property {boolean} gridLayout            layout() can tile sessions logically
 * @property {boolean} pixelLayout           layout() can place windows by pixel geometry
 * @property {boolean} multiMonitor          pixel placement spans monitors
 * @property {boolean} freeFloatingWindows   sessions are separate OS windows
 * @property {boolean} detachSurvivesLauncher a running fleet outlives the process that spawned it
 * @property {boolean} focusById             focus(handle) is exact rather than best-effort
 */

/** Every capability false — a backend declares up from this, so a new flag defaults to "no". */
export const NO_CAPABILITIES = Object.freeze({
  authoritativeList: false,
  reliableSend: false,
  observableStatus: false,
  gridLayout: false,
  pixelLayout: false,
  multiMonitor: false,
  freeFloatingWindows: false,
  detachSurvivesLauncher: false,
  focusById: false,
})

export const CAPABILITY_NAMES = Object.freeze(Object.keys(NO_CAPABILITIES))

/** The states a session's status indicator can show. */
export const STATUS = Object.freeze(['working', 'ready', 'blocked'])

/**
 * @typedef {object} SpawnSpec
 * @property {string} id        session label, unique within the fleet
 * @property {'working'|'testing'|'checker'} role
 * @property {string} title     what the tab/window is called before the status hook takes over
 * @property {string} cwd       the worktree
 * @property {Array<{name: string, value: string}>} env  from buildSessionEnv()
 * @property {string} command   executable
 * @property {string[]} args    argv, already including the --fleet-session=<id> marker
 */

/**
 * @typedef {object} SessionHandle
 * @property {string} id
 * @property {'working'|'testing'|'checker'} role
 * @property {object} backendRef  backend-private addressing (tmux ids, or a window + title token)
 * @property {number} [shimPid]
 * @property {number} [pgid]
 */

/** The methods every backend must implement. */
export const BACKEND_METHODS = Object.freeze([
  'probe', 'capabilities', 'spawn', 'list', 'isAlive', 'send', 'setStatus', 'kill', 'focus', 'layout',
])

// --- return shapes ------------------------------------------------------------------------------
//
// Declared here rather than left to each backend, because a caller that swaps backends must not have
// to change: if one returns `{ok}` from send() and another returns a boolean, every call site is
// quietly wrong on one platform and nothing fails until a message silently is not delivered.
//
// `send` is the shape that matters most. Delivery can be PARTIAL — a console input buffer accepts
// what fits and submits the fragment — so a boolean cannot express the outcome. Reporting
// `delivered` against `requested` is what lets a caller notice a short write instead of believing a
// truncated instruction arrived whole.

/**
 * @typedef {object} ProbeResult   {available, name, reason} — `reason` explains an unavailable
 *   backend in words a user can act on ("tmux is not installed: brew install tmux").
 * @typedef {object} SendResult    {ok, requested, delivered, truncated, reason}
 * @typedef {object} KillResult    {ok, killed: string[], alreadyGone: string[], survivors?: string[]}
 * @typedef {object} LayoutResult  {mode, placed, notice} — `notice` is the degradation line, or null.
 */

/** op → the fields its result must carry. The conformance suite asserts every backend against this. */
export const RESULT_SHAPES = Object.freeze({
  probe: ['available', 'name', 'reason'],
  spawn: ['id', 'role', 'backendRef'],
  send: ['ok', 'requested', 'delivered', 'truncated'],
  kill: ['ok', 'killed', 'alreadyGone'],
  layout: ['mode', 'placed'],
})

/** `setStatus`, `isAlive` and `focus` answer with a boolean; `list` answers with an array. */
export const BOOLEAN_RESULTS = Object.freeze(['isAlive', 'setStatus', 'focus'])

/**
 * Does `value` carry the fields `op` promises?
 * @returns {{ok: boolean, missing: string[], note: string|null}}
 */
export function validateResultShape(op, value) {
  if (BOOLEAN_RESULTS.includes(op)) {
    return typeof value === 'boolean'
      ? { ok: true, missing: [], note: null }
      : { ok: false, missing: [], note: `${op} must return a boolean, got ${typeof value}` }
  }
  if (op === 'list') {
    return Array.isArray(value)
      ? { ok: true, missing: [], note: null }
      : { ok: false, missing: [], note: `list must return an array, got ${typeof value}` }
  }
  const want = RESULT_SHAPES[op]
  if (!want) return { ok: true, missing: [], note: null }
  if (!value || typeof value !== 'object') return { ok: false, missing: want, note: `${op} must return an object` }
  const missing = want.filter(f => value[f] === undefined)
  return { ok: missing.length === 0, missing, note: missing.length ? `${op} result is missing ${missing.join(', ')}` : null }
}

/** A send() result for a delivery that completed in full — so backends express "fine" identically. */
export function fullDelivery(text) {
  const n = String(text).length
  return { ok: true, requested: n, delivered: n, truncated: false, reason: null }
}

/** A send() result for a partial write, which is a FAILURE the caller must see rather than a warning. */
export function shortDelivery(text, delivered, reason) {
  const n = String(text).length
  return { ok: false, requested: n, delivered, truncated: delivered < n, reason }
}

/**
 * Assert an object implements the interface. Used by the conformance suite and by backend selection,
 * so a half-written backend fails at load rather than at 3am in the middle of a fan-out.
 * @returns {{ok: boolean, missing: string[], badCapabilities: string[]}}
 */
export function validateBackend(backend) {
  const missing = BACKEND_METHODS.filter(m => typeof backend?.[m] !== 'function')
  const badCapabilities = []
  if (!missing.includes('capabilities')) {
    let caps
    try {
      caps = backend.capabilities()
    } catch {
      badCapabilities.push('capabilities() threw')
      caps = null
    }
    if (caps) {
      for (const name of Object.keys(caps)) {
        if (!CAPABILITY_NAMES.includes(name)) badCapabilities.push(`unknown capability "${name}"`)
      }
      for (const name of CAPABILITY_NAMES) {
        if (typeof caps[name] !== 'boolean') badCapabilities.push(`capability "${name}" is not a boolean`)
      }
    }
  }
  return { ok: missing.length === 0 && badCapabilities.length === 0, missing, badCapabilities }
}

/** Throw unless `spec` is a complete SpawnSpec. */
export function assertSpawnSpec(spec) {
  for (const field of ['id', 'role', 'cwd', 'command']) {
    if (!spec?.[field]) throw new Error(`spawn: ${field} is required`)
  }
  if (!Array.isArray(spec.args)) throw new Error('spawn: args must be an array')
  if (!Array.isArray(spec.env)) throw new Error('spawn: env must be an array of {name, value}')
  for (const e of spec.env) {
    if (typeof e?.name !== 'string' || typeof e?.value !== 'string') throw new Error('spawn: env entries must be {name: string, value: string}')
  }
  if (!['working', 'testing', 'checker'].includes(spec.role)) throw new Error(`spawn: unknown role "${spec.role}"`)
  return spec
}

/**
 * A degradation is announced, never silent.
 * @returns {string|null} the line to log, or null when the capability is present
 */
export function degradationNotice(caps, capability, what) {
  if (caps[capability]) return null
  return `${what}: unavailable on this terminal backend (no ${capability})`
}
