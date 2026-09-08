// PreToolUse hook (matcher: Bash|PowerShell) for fleet sessions: refuse `git stash`.
//
// ⛔ `refs/stash` is ONE ref shared by every worktree of a repository. A stash pushed from one session
// is visible to — and poppable by — every other, so a concurrent `stash pop` lands another session's
// work-in-progress in the wrong tree, or silently drops one's own. The playbooks say "never"; this
// hook makes "never" mechanical, because an agent reaching for a familiar habit does not re-read the
// rule first. Every stash subcommand is refused, `list` included: a listing of somebody else's entries
// is the invitation to pop one, and a rule with no exceptions is the only rule a session cannot argue
// itself past.
//
// Three properties, each the shape of a failure:
//   * self-guarded on FLEET_SESSION=1 and nothing else — an installed plugin's hooks run in EVERY
//     window, and the operator's own shell must be able to stash freely;
//   * matched on the ARGV TOKEN, never a substring — `git commit -m "see git stash-name"` and
//     `git stash-name` carry the text and must pass, while `git -C /w/app-session-3 stash list`,
//     `cd x && git stash` and `echo "$(git stash list)"` must not;
//   * fails OPEN and never throws — an uncaught exception in a hook is an error on every Bash call of
//     the session, and a parse hiccup on one odd payload must not block every command after it. A
//     positively identified stash is the only thing that exits 2. The timeout in hooks.json is the
//     same direction: a hook that times out is a non-blocking error and the tool call PROCEEDS, so
//     the guard is best-effort on a machine mid-fan-out (eight installs, a cold node) — its 20 s is
//     set so that only a machine in real trouble ever reaches it.
//
// It imports nothing from src/: it runs before every Bash call in every fleet window, and a config
// stack loaded per call is a subprocess tax the whole fleet pays hundreds of times an hour.
//
// A git ALIAS that hides a stash (`st = stash`), and a stash reached through an interpreter this
// hook does not read (`pwsh -c`, `python -c`, `env -S`), are invisible here — `sh -c '…'` and `eval`
// ARE read, recursively, because they are the one-token dual of the substring trap below. The
// playbook's prohibition still stands, and this hook is a guard rail rather than a wall.

import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// ---- pure ---------------------------------------------------------------------------------------

/**
 * Unquoted characters that end one simple command and begin the next. `&` covers `&&` and `2>&1`
 * (a redirect split in two still leaves `git stash` intact), `|` covers `||`, `(` a subshell, and a
 * newline a script line.
 */
const SEPARATORS = new Set([';', '|', '&', '\n', '('])

/**
 * Split a shell command line into simple commands, each an array of unquoted tokens.
 *
 * Quote-aware, so text inside `"…"` or `'…'` stays one token and never starts a command — that is
 * the substring trap: a stash named in a commit message is prose, not an invocation. But `$(…)` and
 * `` `…` `` RUN their contents, even inside double quotes, so they open a new command instead.
 * Inside double quotes a backslash escapes only $ ` " \ and newline, as the shell does — dropping the
 * others would turn a quoted Windows path to git.exe into a token whose basename is not `git.exe`.
 * A here-document body (`<<EOF` … `EOF`, `<<-EOF` with its tabs) is data, not commands: a commit
 * message or PR body fed through `$(cat <<'EOF' … EOF)` may well start a line with `git stash`, and
 * tokenising it would refuse a legitimate commit. The body runs from the next newline to the
 * delimiter line and is skipped whole; `<<<` is a here-string and opens no body.
 * @returns {string[][]}
 */
export function simpleCommands(text) {
  const out = []
  let cmd = []
  let tok = null   // the token being built; null BETWEEN tokens, so an empty "" still counts as one
  let quote = null // the quote we are inside: "'" | '"' | null
  const open = []  // substitutions entered: {close: ')' | '`', quote: the quote suspended by it}
  let opLen = 0    // unquoted `<` the current token STARTS with: 2 is a heredoc operator, 3 a here-string
  const heredocs = [] // {delim, dash}: bodies that begin at the next newline, in the order they were named
  let awaitDelim = null // `<< EOF`: the operator ended a token of its own, the next token is its delimiter
  const s = String(text ?? '')

  const add = ch => { tok = (tok ?? '') + ch }
  const endTok = () => {
    if (tok === null) return
    if (awaitDelim) { heredocs.push({ delim: tok, dash: awaitDelim.dash }); awaitDelim = null }
    else if (opLen === 2) {
      const dash = tok[2] === '-'
      const delim = tok.slice(dash ? 3 : 2)
      if (delim) heredocs.push({ delim, dash }); else awaitDelim = { dash }
    }
    cmd.push(tok); tok = null; opLen = 0
  }
  const endCmd = () => { endTok(); if (cmd.length) out.push(cmd); cmd = [] }
  /** Skip every pending body from index `from`; returns the index just past the last delimiter line. */
  const skipBodies = from => {
    let j = from
    while (heredocs.length) {
      const { delim, dash } = heredocs.shift()
      while (j < s.length) {
        let eol = s.indexOf('\n', j)
        if (eol === -1) eol = s.length
        let line = s.slice(j, eol)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (dash) line = line.replace(/^\t+/, '')
        j = eol + 1
        if (line === delim) break
      }
    }
    return Math.min(j, s.length)
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else add(ch)
      continue
    }
    if (ch === '\\') {
      const next = s[i + 1]
      if (next === undefined) { add(ch); continue }
      if (quote === '"' && !'$`"\\\n'.includes(next)) { add(ch); continue }
      i++
      if (next !== '\n') add(next) // backslash-newline is a continuation and produces nothing
      continue
    }
    if (ch === '$' && s[i + 1] === '(') {
      endCmd()
      open.push({ close: ')', quote })
      quote = null
      i++
      continue
    }
    if (ch === '`') {
      endCmd()
      const top = open[open.length - 1]
      if (top && top.close === '`') quote = open.pop().quote
      else { open.push({ close: '`', quote }); quote = null }
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else add(ch)
      continue
    }
    // unquoted from here
    if (ch === '"' || ch === "'") { quote = ch; add(''); continue }
    if (ch === ')') {
      endCmd()
      const top = open[open.length - 1]
      if (top && top.close === ')') quote = open.pop().quote
      continue
    }
    if (ch === '#' && tok === null) {
      // a comment runs to the end of its line: "# never git stash here" is prose, not a command
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
      continue
    }
    if (ch === '\n') {
      endTok()          // a delimiter written right before the newline is still the delimiter
      awaitDelim = null // `cat <<` with no word is a syntax error, not a body
      if (heredocs.length) { endCmd(); i = skipBodies(i + 1) - 1; continue }
    }
    if (SEPARATORS.has(ch)) { endCmd(); continue }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endTok(); continue }
    if (ch === '<' && (tok ?? '').length === opLen) opLen++
    add(ch)
  }
  endCmd()
  return out
}

/**
 * Shell reserved words that stand in front of a command without being one: `if git stash; then`,
 * `! git stash`, `{ git stash; }`, `while … do git stash` all run the stash.
 */
const RESERVED = new Set(['if', 'elif', 'while', 'until', '!', '{', 'do', 'then', 'else'])

/**
 * Wrappers that run their trailing argument as the command (`command git stash` is still a stash),
 * each with the options it takes a VALUE for — `env -u FOO git stash`, `sudo -u ada git stash` — and
 * the positional operands before its command: `timeout 30 git stash` has one. A value skipped as a
 * flag would leave `FOO` as the "command", and git is never inspected.
 */
const WRAPPERS = new Map(Object.entries({
  command: {},
  builtin: {},
  nohup: {},
  exec: { values: ['-a'] },
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  sudo: { values: ['-u', '-g', '-h', '-p', '-C'] },
  doas: { values: ['-u', '-C'] },
  timeout: { values: ['-k', '-s', '--kill-after', '--signal'], operands: 1 },
  xargs: { values: ['-n', '-P', '-I', '-L', '-d', '-s', '-E', '-a'] },
}).map(([name, o]) => [name, { values: new Set(o.values ?? []), operands: o.operands ?? 0 }]))

/** Interpreters whose `-c` argument is shell text this hook can read: `bash -c "git stash"` is a stash. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * git's global options that take their value as the NEXT token. `git -C stash status` runs
 * `status` in a directory called stash; reading its second token as the subcommand blocks it.
 */
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The program a token names, however it is addressed: `git`, `git.exe`, `/usr/bin/git`, a quoted Windows path. */
function basename(token) {
  return String(token).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '')
}
const isGit = token => basename(token) === 'git'
const isShell = token => SHELLS.has(basename(token))

/**
 * Index of the token a simple command actually dispatches: leading `NAME=value` assignments,
 * reserved words and wrappers (each with its flags, their values and its operands) are stepped over.
 */
function programIndex(tokens) {
  let i = 0
  for (;;) {
    while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || RESERVED.has(tokens[i]))) i++
    const wrapper = i < tokens.length ? WRAPPERS.get(tokens[i]) : undefined
    if (!wrapper) return i
    i++
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (wrapper.values.has(tokens[i])) i++
      i++
    }
    i += wrapper.operands
  }
}

/**
 * The git subcommand a simple command runs, or null when it does not run git at all.
 * Whatever stands in front of git is stepped over (`programIndex`), and git's global options are
 * stepped over too, so the answer is the first thing git itself dispatches on — which is exactly the
 * token a substring match gets wrong in both directions.
 */
export function gitSubcommand(tokens) {
  let i = programIndex(tokens)
  if (i >= tokens.length || !isGit(tokens[i])) return null
  i++
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (VALUE_OPTIONS.has(tokens[i])) i++
    i++
  }
  return i < tokens.length ? tokens[i] : null
}

/**
 * The shell text a simple command hands to ANOTHER shell — `sh -c '…'`, `bash -lc "…"`, `eval …` —
 * so the verdict can read it the way that shell will, instead of seeing one quoted token. Quotes
 * were already stripped by simpleCommands, which is exactly what the inner shell receives.
 * @returns {string[]}
 */
export function nestedScripts(tokens) {
  const i = programIndex(tokens)
  if (i >= tokens.length) return []
  if (tokens[i] === 'eval') return i + 1 < tokens.length ? [tokens.slice(i + 1).join(' ')] : []
  if (!isShell(tokens[i])) return []
  let j = i + 1
  let wantsScript = false
  while (j < tokens.length && /^[-+]/.test(tokens[j])) {
    const opt = tokens[j++]
    if (opt === '--' || opt === '-') break        // end of options: the next token is the script
    if (/^-[^-]*c/.test(opt)) wantsScript = true  // -c, -ec, -lc, -xc
    if (/^[-+][^-]*[oO]$/.test(opt)) j++          // -o pipefail, +O extglob take a value
  }
  return wantsScript && j < tokens.length ? [tokens[j]] : []
}

/**
 * Does this command line run `git stash` anywhere? PURE. Recursive on the text a command hands to
 * another shell (`nestedScripts`); each level is strictly shorter than the one above, so it ends.
 * @returns {{block: boolean, offending: string|null}} `offending` is the simple command that did it,
 *          rendered token by token, so the refusal can quote what was actually run.
 */
export function stashVerdict(command) {
  for (const tokens of simpleCommands(command)) {
    if (gitSubcommand(tokens) === 'stash') return { block: true, offending: tokens.join(' ') }
    for (const script of nestedScripts(tokens)) {
      const inner = stashVerdict(script)
      if (inner.block) return inner
    }
  }
  return { block: false, offending: null }
}

/** The refusal the agent reads (a PreToolUse exit 2 feeds stderr back to it), with the way out. */
export function stashReason(offending) {
  return [
    `claude-fleet: refused \`${offending}\` — never \`git stash\` in a fleet session.`,
    'refs/stash is SHARED across every worktree of this repository: a stash from one session is visible to, and poppable by, every other, so a concurrent pop lands another session\'s work in the wrong tree or drops yours.',
    'To set changes aside, commit them on your own branch instead: `git add -A`, then `git commit -m wip` (undo later with `git reset --soft HEAD^`). If you find a stash that is not yours, leave it.',
    '',
  ].join('\n')
}

/**
 * The whole decision, from the environment and the raw stdin payload. PURE.
 *
 * The guard comes first: outside a fleet session the payload is not even parsed. Anything that is
 * not a shell command — no JSON, another tool, a command that is not a string — is allowed through:
 * this hook can block one thing, and "I could not read it" is not that thing.
 * @returns {{code: 0|2, stderr: string}}
 */
export function decide(env, payloadText) {
  if (!env || env.FLEET_SESSION !== '1') return { code: 0, stderr: '' }
  let command
  try {
    command = JSON.parse(String(payloadText ?? ''))?.tool_input?.command
  } catch {
    return { code: 0, stderr: '' }
  }
  if (typeof command !== 'string') return { code: 0, stderr: '' }
  const v = stashVerdict(command)
  return v.block ? { code: 2, stderr: stashReason(v.offending) } : { code: 0, stderr: '' }
}

// ---- thin I/O -----------------------------------------------------------------------------------

/** The hook payload arrives on stdin. Run by hand from a terminal there is none, and waiting would hang. */
async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Is this file the process entry, as opposed to imported by a test? Compared by REAL path on both
 * sides: a plugin root reached through a symlink makes argv[1] and import.meta.url spell the same
 * file differently, and a mismatch here is a hook that silently guards nothing.
 */
function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  // Nothing below can throw out: every failure path resolves to exit 0, because the alternative is a
  // hook error on every Bash call for the rest of the session.
  readStdin()
    .then(text => decide(process.env, text))
    .then(r => {
      if (r.stderr) process.stderr.write(r.stderr)
      process.exitCode = r.code
    })
    .catch(e => {
      process.stderr.write(`claude-fleet: block-git-stash failed open: ${e && e.message ? e.message : e}\n`)
      process.exitCode = 0
    })
}
