import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from '../src/sys/exec.mjs'
import { parseSessionState } from '../src/session/shim.mjs'
import { STATUS } from '../src/backends/types.mjs'
import { envMapOf } from '../src/backends/fake.mjs'
import { buildSessionEnv } from '../src/config/env.mjs'
import { defaultsFor } from '../src/config/defaults.mjs'
import { decide, stashVerdict, stashReason, gitSubcommand, simpleCommands, nestedScripts } from '../hooks/block-git-stash.mjs'
import { planTabTitle, STATES } from '../hooks/tab-title.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS_DIR = path.join(ROOT, 'hooks')
const HOOKS_JSON = path.join(HOOKS_DIR, 'hooks.json')
const STASH_HOOK = path.join(HOOKS_DIR, 'block-git-stash.mjs')
const TITLE_HOOK = path.join(HOOKS_DIR, 'tab-title.mjs')

/** A temp root that goes away with the test, however the test ends. */
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-hooks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

/** `<root>/sessions/3.state`, with the directory the launcher would have created. */
function stateFileIn(t) {
  const sessions = path.join(tmpRoot(t), 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  return { sessions, stateFile: path.join(sessions, '3.state') }
}

/**
 * The environment a real session runs under: every contract §4 scalar, built by the same function
 * the launcher uses, so the hooks are fed real data rather than a hand-picked FLEET_SESSION=1.
 */
function sessionEnv(stateFile, over = {}) {
  const stateDir = path.dirname(path.dirname(stateFile))
  const env = envMapOf(buildSessionEnv(defaultsFor(), {
    label: '3', role: 'working', file: path.join(stateDir, 'sessions', '3.json'), stateFile, stateDir,
  }))
  return { ...env, ...over }
}

/** A PreToolUse payload as the agent CLI pipes it to a shell-tool hook (Bash, or PowerShell on Windows). */
const payload = (command, tool = 'Bash') => JSON.stringify({
  session_id: 'sess-3-9f2a', hook_event_name: 'PreToolUse', tool_name: tool, cwd: '/w/app-session-3',
  tool_input: { command, description: 'one step' },
})

// Real child processes, through the one spawner this plugin allows. run() layers `env` over the
// test's own environment, so blanking FLEET_SESSION is how "unset" is expressed (contract §3: blank
// env = unset) — a bare omission would inherit a live fleet window's value if the suite ran in one.
const runStash = (command, env, input = payload(command)) => run(process.execPath, [STASH_HOOK], { env, input, timeoutMs: 30_000 })
const runTitle = (args, env) => run(process.execPath, [TITLE_HOOK, ...args], { env, timeoutMs: 30_000 })

// ---- hooks.json --------------------------------------------------------------------------------

test('hooks.json wires the five events to the two scripts through plain node and ${CLAUDE_PLUGIN_ROOT}', () => {
  // A hook command is the one line of this plugin the agent CLI runs on every platform: a
  // powershell.exe here strands every macOS and Linux session, and a path that is not the plugin
  // root finds nothing once the plugin is installed from a cache directory.
  const doc = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'))
  const events = doc.hooks
  assert.deepEqual(Object.keys(events).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'])

  const entries = name => events[name].flatMap(group => group.hooks.map(h => ({ matcher: group.matcher ?? null, ...h })))
  for (const name of Object.keys(events)) {
    for (const h of entries(name)) {
      assert.equal(h.type, 'command', `${name}: only command hooks`)
      const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([a-z-]+\.mjs)"(?: ([a-z]+))?$/.exec(h.command)
      assert.ok(m, `${name}: ${h.command} must be node + a hooks/ script under \${CLAUDE_PLUGIN_ROOT}`)
      assert.ok(fs.existsSync(path.join(HOOKS_DIR, m[1])), `${name}: ${m[1]} is shipped`)
      assert.ok(Number.isInteger(h.timeout) && h.timeout > 0, `${name}: a hung hook is bounded`)
    }
  }
  // The stash guard must see BOTH shell tools: on Windows the agent CLI runs `git stash` through its
  // PowerShell tool, whose payload is the same tool_input.command, and a Bash-only matcher is a
  // guard that never fires on the platform the windows-terminal/powershell backends exist for.
  assert.deepEqual(entries('PreToolUse').map(h => [h.matcher, h.command]), [['Bash|PowerShell', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/block-git-stash.mjs"']])
  // A guard that times out is a non-blocking error and the tool call PROCEEDS: a cold node on a
  // machine mid-fan-out needs more room than the title hooks, which only paint.
  assert.ok(entries('PreToolUse')[0].timeout >= 20, 'the stash guard is not turned fail-open by a slow node start')
  assert.deepEqual(entries('UserPromptSubmit').map(h => h.command), ['node "${CLAUDE_PLUGIN_ROOT}/hooks/tab-title.mjs" working'])
  for (const name of ['Stop', 'StopFailure']) {
    assert.deepEqual(entries(name).map(h => [h.matcher, h.command]), [[null, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tab-title.mjs" ready']], name)
  }
  // SessionStart also fires after a compaction, mid-turn while the agent is busy: a `ready` painted
  // there is a working session triaged as idle until the next prompt. Only real starts paint it.
  assert.deepEqual(entries('SessionStart').map(h => [h.matcher, h.command]), [['startup|resume|clear', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tab-title.mjs" ready']])
})

test('the hooks load nothing but node: builtins — they run before every Bash call and after every prompt', () => {
  // The config stack behind src/ costs a subprocess-sized startup per import; paid on every Bash
  // call in every fleet window it is the tax that makes "hooks are fast" false.
  // The gate has to see every form a src/ import could take: a one-line import, a brace list that
  // spans lines, and a re-export — a single-line `^import` pattern lets the last two through.
  const IMPORT_SPECIFIER = /^(?:import|export)\s+(?:[^;'"]*?\bfrom\s+)?['"]([^'"]+)['"]\s*;?\s*$/gm
  const hidden = "import {\n  a,\n} from '../src/x.mjs'\nexport { b } from '../src/y.mjs'\nexport * from './z.mjs'\nimport fs from 'node:fs'\nexport function f() { return 'from' }\n"
  assert.deepEqual([...hidden.matchAll(IMPORT_SPECIFIER)].map(m => m[1]), ['../src/x.mjs', '../src/y.mjs', './z.mjs', 'node:fs'], 'the gate sees multi-line imports and re-exports')
  for (const file of [STASH_HOOK, TITLE_HOOK]) {
    const src = fs.readFileSync(file, 'utf8')
    const specifiers = [...src.matchAll(IMPORT_SPECIFIER)].map(m => m[1])
    assert.ok(specifiers.length > 0, `${path.basename(file)} has imports to check`)
    for (const s of specifiers) assert.ok(s.startsWith('node:'), `${path.basename(file)} imports ${s}`)
    assert.ok(!/\brequire\(|\bimport\(/.test(src), `${path.basename(file)} loads nothing dynamically either`)
  }
})

// ---- block-git-stash.mjs -----------------------------------------------------------------------

test('git stash in a fleet session exits 2 with the shared-refs/stash reason on stderr', t => {
  // Exit 2 is the one code that blocks the tool call, and stderr is what the agent reads: a reason
  // that does not say WHY and what to do instead is a session that tries the same thing again.
  const env = sessionEnv(stateFileIn(t).stateFile)
  const r = runStash('git stash push -m wip', env)
  assert.equal(r.code, 2)
  assert.equal(r.stderr, stashReason('git stash push -m wip'))
  assert.match(r.stderr, /refs\/stash is SHARED across every worktree/)
  assert.match(r.stderr, /git commit -m wip/, 'the way out is named')
  assert.equal(r.stdout, '')

  // the same stash through the Windows shell tool: the payload differs only in tool_name
  const ps = runStash('git stash', env, payload('git stash', 'PowerShell'))
  assert.equal(ps.code, 2)
  assert.equal(ps.stderr, stashReason('git stash'))
})

test('a stash named inside a quoted string passes; a real one beside it does not', t => {
  // The substring trap: a commit message that mentions `git stash list` (or a `git stash-name`)
  // carries the text and runs no stash, and a hook that greps the command line blocks the commit.
  const env = sessionEnv(stateFileIn(t).stateFile)
  const quoted = runStash('git commit -m "wip: run git stash list first"', env)
  assert.deepEqual([quoted.code, quoted.stdout, quoted.stderr], [0, '', ''])
  const hyphenated = runStash('git commit -m "git stash-name"', env)
  assert.deepEqual([hyphenated.code, hyphenated.stderr], [0, ''])
  const real = runStash('git stash push', env)
  assert.equal(real.code, 2)
  assert.match(real.stderr, /refused `git stash push`/)
})

test('outside a fleet session the stash hook does nothing at all', t => {
  // Only the guard is blanked: every other scalar is still present, so what this proves is that
  // FLEET_SESSION alone decides — an installed plugin's hooks run in the operator's own windows too.
  for (const value of ['', '0']) {
    const r = runStash('git stash push', sessionEnv(stateFileIn(t).stateFile, { FLEET_SESSION: value }))
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], `FLEET_SESSION=${JSON.stringify(value)}`)
  }
})

test('a payload that is not a Bash command is let through — the hook fails open, never closed', t => {
  // This hook can block one thing. "I could not read the payload" is not that thing, and a hook
  // that exits 2 on a parse hiccup blocks every Bash call for the rest of the session.
  const env = sessionEnv(stateFileIn(t).stateFile)
  const odd = [
    '',
    'not json',
    '{"tool_name":"Read","tool_input":{"file_path":"git stash"}}',
    '{"tool_input":{"command":42}}',
    '{"tool_input":{"command":null}}',
    '{"tool_input":"git stash"}',
    'null',
  ]
  for (const text of odd) assert.deepEqual(decide(env, text), { code: 0, stderr: '' }, JSON.stringify(text))
  assert.deepEqual(decide(env, payload('git stash')).code, 2, 'the same decider does block a real stash')

  const child = runStash('git stash', env, 'not json')
  assert.deepEqual([child.code, child.stdout, child.stderr], [0, '', ''])
  const empty = runStash('git stash', env, '')
  assert.deepEqual([empty.code, empty.stdout, empty.stderr], [0, '', ''])
})

test('every stash subcommand is caught however git is addressed — and only by its argv token', () => {
  // Both directions of the substring mistake at once: a stash reached through `-C`, a wrapper, a
  // chain, a substitution or a Windows path is still a stash; text that merely contains the word,
  // a `-C stash` directory, or another program called with "stash" is not.
  const blocked = [
    'git stash',
    'git stash pop',
    'git stash list',
    'git stash apply stash@{0}',
    'git stash drop',
    'git -C /w/app-session-3 stash list',
    'git --no-pager -c core.pager=cat stash show',
    'git --git-dir=/w/app/.git stash',
    'cd /w/app-session-3 && git stash',
    'npm test; git stash pop',
    'npm test || git stash pop',
    'git stash 2>&1 | tail -1',
    'echo "$(git stash list)"',
    '`git stash list`',
    'command git stash',
    'FOO=1 git stash',
    'env -i git stash',
    '/usr/bin/git stash',
    'git.exe stash',
    'GIT.EXE stash',
    '"C:\\Program Files\\Git\\bin\\git.exe" stash',
    "git 'stash'",
    'git   stash\t',
    'true\ngit stash push',
    '(git stash)',
    // a reserved word in front is not a command of its own
    'if git stash; then echo ok; fi',
    'if true; then git stash; fi',
    '! git stash',
    '{ git stash; }',
    'while git stash; do :; done',
    'for x in a; do git stash; done',
    // a wrapper option that takes a value: the value is not the command
    'env -u FOO git stash',
    'env -C /w/app git stash',
    'sudo -u ada git stash',
    'nice -n 10 git stash',
    'exec -a git git stash',
    // indirect launchers
    'timeout 30 git stash',
    'timeout -k 5 30s git stash',
    'xargs git stash',
    'echo x | xargs -n 1 git stash',
    // text handed to another shell is read the way that shell reads it
    'bash -c "git stash"',
    "sh -c 'git stash'",
    'bash -lc "cd /w/app-session-3 && git stash pop"',
    'bash -o pipefail -c "git stash"',
    'sudo sh -c "git stash"',
    'eval "git stash"',
    'eval git stash',
    'eval "bash -c \'git stash\'"',
    // a here-string opens no body, and a stash after a heredoc is still a stash
    'cat <<< "git stash"\ngit stash',
    'cat <<EOF\nprose\nEOF\ngit stash',
  ]
  for (const c of blocked) assert.equal(stashVerdict(c).block, true, `must block: ${JSON.stringify(c)}`)

  const allowed = [
    'git commit -m "wip: git stash list later"',
    "git commit -m 'git stash-name'",
    'git stash-name',
    'echo git stash',
    'echo "git stash"',
    'gitstash',
    'git status',
    'git show stash@{0}',
    'git -C stash status',
    'git -c foo=stash status',
    'mygit stash',
    '# git stash\ngit status',
    'npm run stash',
    'grep -r "git stash" docs/',
    'git',
    'git --version',
    '',
    // a here-document body is prose: the agent CLI's own commit/PR-body recipe starts lines with anything
    'git commit -F - <<EOF\nfix: hook\n\ngit stash guard added\nEOF',
    'gh pr create --body "$(cat <<\'EOF\'\n## Summary\ngit stash is refused by the hook\nEOF\n)"',
    'cat <<-EOF\n\tgit stash\n\tEOF\ngit status',
    'cat << EOF\ngit stash\nEOF',
    // a wrapper's value is a value, not the command
    'env -C stash git status',
    'sudo -u git status',
    'timeout 30 npm test',
    // other shells and reserved words running something else
    'bash -c "git status"',
    'eval "git status"',
    'if true; then git status; fi',
  ]
  for (const c of allowed) assert.equal(stashVerdict(c).block, false, `must allow: ${JSON.stringify(c)}`)

  assert.equal(stashVerdict('cd x && git -C /w stash list').offending, 'git -C /w stash list', 'the refusal quotes the simple command that stashes')
  assert.equal(stashVerdict('bash -c "cd x && git stash"').offending, 'git stash', 'and for nested text, the inner command that stashes')
  assert.equal(gitSubcommand(['git', '-C', 'stash', 'status']), 'status', '-C takes the next token as its value')
  assert.equal(gitSubcommand(['env', '-u', 'FOO', 'git', 'stash']), 'stash', 'env -u takes the next token as its value')
  assert.deepEqual(nestedScripts(['sudo', 'bash', '-lc', 'git stash']), ['git stash'])
  assert.deepEqual(nestedScripts(['bash', 'script.sh', 'git stash']), [], 'a script file is not readable text')
  assert.deepEqual(simpleCommands('a "b c" d; e'), [['a', 'b c', 'd'], ['e']])
  assert.deepEqual(simpleCommands('cat <<EOF | wc\ngit stash\nEOF\ngit status'), [['cat', '<<EOF'], ['wc'], ['git', 'status']], 'the body is skipped, the rest of the line and the lines after it are not')
})

// ---- tab-title.mjs -----------------------------------------------------------------------------

test('tab-title writes the word the shim reads back, atomically, with no temp file left behind', t => {
  // The shim polls this file and repaints on a change: a word it cannot parse is a title that never
  // changes colour, and a temp file nothing sweeps sits in sessions/ for the life of the state dir.
  const { sessions, stateFile } = stateFileIn(t)
  const env = sessionEnv(stateFile)

  const working = runTitle(['working'], env)
  assert.deepEqual([working.code, working.stdout, working.stderr], [0, '', ''])
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'working\n')
  assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'working')

  const ready = runTitle(['ready'], env)
  assert.equal(ready.code, 0)
  assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'ready', 'a rewrite replaces the word')
  assert.deepEqual(fs.readdirSync(sessions), ['3.state'], 'no temp file survives a successful write')

  assert.deepEqual([...STATES], [...STATUS], 'the words this hook accepts are exactly the ones the shim paints')
})

test('outside a fleet session tab-title touches nothing', t => {
  // There is no state file to write outside a fleet, and a hook that invents one leaves stray
  // files in whatever directory FLEET_STATE_FILE happened to name.
  const { sessions, stateFile } = stateFileIn(t)
  const r = runTitle(['working'], sessionEnv(stateFile, { FLEET_SESSION: '' }))
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  assert.deepEqual(fs.readdirSync(sessions), [])
})

test('a word the shim would not paint is refused with exit 1 and nothing on disk — never exit 2', t => {
  // Exit 2 from a Stop hook tells the agent to KEEP GOING; a misconfigured tab-title must be
  // visible (exit 1, stderr) without ever becoming an instruction.
  const { sessions, stateFile } = stateFileIn(t)
  const env = sessionEnv(stateFile)
  for (const args of [['busy'], []]) {
    const r = runTitle(args, env)
    assert.equal(r.code, 1, JSON.stringify(args))
    assert.notEqual(r.code, 2)
    assert.match(r.stderr, /unknown state .* working\|ready\|blocked/)
    assert.equal(r.stdout, '', 'stdout of a prompt/start hook is injected into the agent context: the refusal stays on stderr')
    assert.deepEqual(fs.readdirSync(sessions), [], 'nothing written')
  }
  const unset = runTitle(['ready'], sessionEnv(stateFile, { FLEET_STATE_FILE: '' }))
  assert.equal(unset.code, 1)
  assert.match(unset.stderr, /FLEET_STATE_FILE is unset/)

  // the decision is pure, and a padded path is still that path
  assert.deepEqual(planTabTitle('ready', { FLEET_SESSION: '1', FLEET_STATE_FILE: ` ${stateFile} ` }), { action: 'write', file: stateFile, word: 'ready', message: null })
  assert.equal(planTabTitle('ready', { FLEET_SESSION: '' }).action, 'skip')
  assert.equal(planTabTitle('busy', { FLEET_SESSION: '1', FLEET_STATE_FILE: stateFile }).action, 'refuse')
})

test("the state directory is the launcher's: a missing one is reported, not created", t => {
  // sessions/ is written by the launcher before any session exists. A Stop hook firing during
  // `fleet down` must not resurrect the directory the teardown just removed.
  const stateFile = path.join(tmpRoot(t), 'gone', 'sessions', '3.state')
  const r = runTitle(['ready'], sessionEnv(stateFile))
  assert.equal(r.code, 1)
  assert.notEqual(r.code, 2)
  assert.match(r.stderr, /could not write/)
  assert.equal(fs.existsSync(path.dirname(stateFile)), false)
})

test('a write whose rename cannot land removes its temp file', t => {
  // Same rule as the registry writer: nothing else in the plugin ever sweeps sessions/, so a
  // `.3.state.tmp` leaked by one failed write stays there forever.
  const { sessions, stateFile } = stateFileIn(t)
  fs.mkdirSync(stateFile) // a directory where the file should be: the rename cannot replace it
  const r = runTitle(['working'], sessionEnv(stateFile))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /could not write/)
  assert.deepEqual(fs.readdirSync(sessions), ['3.state'], 'the temp file is gone, the obstacle is untouched')
})

test('a temp file that can be neither written nor removed still reports the write as the cause', t => {
  // The cleanup is best-effort: `rmSync` with force only forgives a missing file, and an rm that
  // fails (a directory here; an indexer holding the file on Windows) must not replace the error the
  // operator needs — the one that made the write fail.
  const { stateFile } = stateFileIn(t)
  fs.mkdirSync(path.join(path.dirname(stateFile), '.3.state.tmp')) // a directory where the temp file goes
  const r = runTitle(['working'], sessionEnv(stateFile))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /could not write .*3\.state: EISDIR: illegal operation on a directory, open '/, 'the write error')
  assert.doesNotMatch(r.stderr, /rm returned/, 'not the cleanup error')
  assert.equal(fs.existsSync(stateFile), false)
})

test('the temp name is one fixed file per state file, so an interrupted write leaks at most one', t => {
  // A hook killed by its timeout between write and rename leaves the temp file behind, and nothing
  // sweeps sessions/. A pid-named temp is one leak per kill for the life of the state dir; a fixed
  // name is reused — and overwritten whole — by the very next write.
  const { sessions, stateFile } = stateFileIn(t)
  const tmp = path.join(sessions, '.3.state.tmp')
  fs.writeFileSync(tmp, 'wor') // the torn leftover of a killed hook
  const r = runTitle(['ready'], sessionEnv(stateFile))
  assert.deepEqual([r.code, r.stderr], [0, ''])
  assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'ready')
  assert.deepEqual(fs.readdirSync(sessions), ['3.state'], 'the leftover was reused, not joined by a second one')
})

test('a hook reached through a link still recognises itself as the entry point', t => {
  // The entry check compares real paths. A plugin root reached through a junction or symlink makes
  // argv[1] and import.meta.url spell the same file differently, and an href comparison there is a
  // hook that loads, decides nothing, and exits 0 — a guard that silently guards nothing.
  const root = tmpRoot(t)
  const link = path.join(root, 'hooks-link')
  try {
    fs.symlinkSync(HOOKS_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('no privilege to create a link here')
    return
  }
  const { stateFile } = stateFileIn(t)
  const title = run(process.execPath, [path.join(link, 'tab-title.mjs'), 'working'], { env: sessionEnv(stateFile), timeoutMs: 30_000 })
  assert.deepEqual([title.code, title.stderr], [0, ''])
  assert.equal(parseSessionState(fs.readFileSync(stateFile, 'utf8')), 'working')

  const stash = run(process.execPath, [path.join(link, 'block-git-stash.mjs')], { env: sessionEnv(stateFile), input: payload('git stash'), timeoutMs: 30_000 })
  assert.equal(stash.code, 2)
})
