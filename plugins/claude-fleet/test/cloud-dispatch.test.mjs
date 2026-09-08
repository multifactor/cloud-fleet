import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FIRST_WAVE, SECOND_WAVE, STAGGER_MS, STALL_MS, OOM_EXIT, RUNBOOK_FILE, END_SENTINEL, PS_ARGS,
  assertRefName, nextRef, assertEnvName, buildRunbookPrompt, verifyRunbookCopy,
  posixQuote, psLiteral, crtQuote, encodeUtf16, paneCommand, tmuxLaunchArgs, parseTmuxSpawn,
  windowsLaunchScript, parseWindowsSpawn, launchPlan,
  rampPlan, stallVerdict,
  parseLsRemote, dispatchGate, pollResults,
  probeVerdict, reasonToken, parseFailedMd, parseManifest, collectVerdict, harvestResult,
  sessionInfoFrom, writeRunbook, buildStub, readDispatchLog, appendDispatchLog, dispatch, harvest,
} from '../src/cloud/dispatch.mjs'
import { run as execRun } from '../src/sys/exec.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The bundled runbook, exactly as dispatch() inlines it: fenced shell, backticks, `$vars`, `$(…)`. */
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'playbooks', 'cloud-capture.md'), 'utf8')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cloud-'))
const T0 = Date.parse('2026-03-14T10:00:00Z')
const MIN = 60_000
const SHA = 'c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11'
const OTHER = 'd15ea5e0d15ea5e0d15ea5e0d15ea5e0d15ea5e0'
const REF = 'capture/ABC-1234'
const RESULTS = 'assets-ABC-1234'
const decodePs = b64 => Buffer.from(b64, 'base64').toString('utf16le')

/** The parameters a dispatching session resolves from its config (contract §3), as one prompt. */
const prompt = (over = {}) => buildRunbookPrompt({
  playbookText: RUNBOOK,
  ref: REF,
  resultsBranch: RESULTS,
  bootstrapScript: 'scripts/sandbox-bootstrap.sh',
  captureSpec: '.fleet-capture/ABC-1234',
  requiredEnv: ['REGISTRY_TOKEN'],
  sensitivePaths: ['.env*', 'secrets/**'],
  expectedSha: SHA,
  params: { key: 'ABC-1234', remote: 'origin', baseBranch: 'main', baseUrl: 'http://localhost:3000' },
  ...over,
})

// ---- runners --------------------------------------------------------------------------------------

/**
 * A scripted runner. `script(argv, {command, args})` answers {stdout?, stderr?, code?, timedOut?}, or
 * undefined to fail the test on a call it did not expect — an unexpected spawn is a bug, not a detail.
 */
function scripted(script) {
  const calls = []
  const run = (command, args = [], opts = {}) => {
    calls.push({ command, args: args.slice(), opts })
    const reply = script([command, ...args].join(' '), { command, args })
    if (reply === undefined) throw new Error(`unscripted call: ${command} ${args.join(' ')}`)
    const code = reply.code ?? 0
    return { ok: code === 0 && !reply.timedOut, code, signal: null, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', timedOut: !!reply.timedOut }
  }
  return { run, calls }
}

/** Real git, scripted everything else (the launch is the only spawn a test cannot make for real). */
function hybrid(script) {
  const s = scripted(script)
  const run = (command, args = [], opts = {}) => {
    if (command === 'git') {
      s.calls.push({ command, args: args.slice(), opts })
      return execRun(command, args, opts)
    }
    return s.run(command, args, opts)
  }
  return { run, calls: s.calls }
}

// ---- real repositories ----------------------------------------------------------------------------

const gitq = (dir, args, opts = {}) => {
  const r = execRun('git', ['-C', dir, ...args], { timeoutMs: 60_000, ...opts })
  if (!r.ok) throw new Error(`git ${args.join(' ')} — ${r.stderr || r.stdout}`)
  return r
}

function bareRemote() {
  const dir = tmp()
  const r = execRun('git', ['init', '-q', '--bare', dir])
  if (!r.ok) throw new Error(r.stderr)
  return dir
}

function workClone(remote) {
  const dir = tmp()
  const r = execRun('git', ['init', '-q', dir])
  if (!r.ok) throw new Error(r.stderr)
  gitq(dir, ['config', 'user.name', 'ada'])
  gitq(dir, ['config', 'user.email', 'ada@example.com'])
  gitq(dir, ['config', 'commit.gpgsign', 'false'])
  if (remote) gitq(dir, ['remote', 'add', 'origin', remote])
  return dir
}

/** Write files (strings or Buffers), commit them all, return the sha. */
function commitAll(dir, files, message) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  gitq(dir, ['add', '-A'])
  gitq(dir, ['commit', '-q', '-m', message])
  return gitq(dir, ['rev-parse', 'HEAD']).stdout.trim()
}

/** A remote carrying `capture/ABC-1234`; returns {remote, sha}. */
function remoteWithCaptureRef() {
  const remote = bareRemote()
  const w = workClone(remote)
  const sha = commitAll(w, { 'README.md': 'app\n', '.fleet-capture/ABC-1234/spec.mjs': 'export const shots = ["home"]\n' }, 'capture spec for ABC-1234 (never merged)')
  gitq(w, ['push', '-q', 'origin', `HEAD:refs/heads/${REF}`])
  return { remote, sha, work: w }
}

// ---- fixtures -------------------------------------------------------------------------------------

/** FAILED.md as the runbook's §FAILURE list shapes it: numbered, bold labels, a fenced command. */
const FAILED_MD = `# FAILED — capture ABC-1234

1. **reason** — blocked host cdn.example.com
2. **phase** — boot
3. **blockedHosts[]** — cdn.example.com, downloads.example.com
4. **probe results per host**
   - \`registry.example.com\`: reached (status 401)
   - \`cdn.example.com\`: blocked (403 CONNECT)
   - \`downloads.example.com\`: blocked (connect_rejected)
   - \`mirror.example.com\`: dns failure
   - \`www.example.com\`: reached (status 200)
5. **the exact command that failed**

\`\`\`
npm install --ignore-scripts --prefer-offline --no-audit --no-fund
\`\`\`

\`\`\`
npm ERR! network request to https://cdn.example.com/pkg.tgz failed
npm ERR! 403 CONNECT
\`\`\`

6. **a re-run recipe** — add cdn.example.com and downloads.example.com to capture.allowlistHosts, then re-dispatch on capture/ABC-1234-v2 and resume from Boot step 4.
`

const manifestFixture = (over = {}) => JSON.stringify({
  issue: 'ABC-1234',
  ref: SHA,
  status: 'ok',
  before_commit: OTHER,
  after_commit: SHA,
  blockedHosts: ['fonts.example.com'],
  hostProbe: { 'registry.example.com': 'reached (401)', 'fonts.example.com': 'blocked (403 CONNECT)', 'cdn.example.com': 'reached (200)' },
  specPatch: null,
  phases: { before: { shots: ['before-home.png'], before_missing: [] }, after: { shots: ['after-home.png'] } },
  notes: [],
  ...over,
}, null, 2)

// ---- the prompt -----------------------------------------------------------------------------------

test('the runbook is inlined VERBATIM — fenced shell, backticks and $vars intact — with the resolved parameters and the five rules after it', () => {
  // A worker once received a runbook cut at its first backtick (a shell read it as a command
  // substitution) and improvised the missing steps: it skipped the migration and shot an app with no
  // schema. The prompt carries the shell snippets untouched; the TRANSPORT is what keeps them data.
  const p = prompt()
  assert.ok(p.startsWith(RUNBOOK.replace(/\s+$/, '')), 'the runbook is the head of the prompt, byte-for-byte')
  assert.ok(p.includes('node -e "const m=process.argv.slice(1).filter(n=>!process.env[n])'), 'a fenced shell snippet with $vars survives unescaped')
  assert.ok(p.includes('printf \'DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/app\\nAPP_SECRET=%s\\n\' "$(openssl rand -hex 24)"'), 'a $(…) substitution inside the runbook survives')
  assert.equal((p.match(/```/g) || []).length, (RUNBOOK.match(/```/g) || []).length, 'every fence the runbook opens or closes is still there')

  // the parameter block uses the runbook's own `<name>` vocabulary
  for (const line of [
    '- `<captureRef>`: capture/ABC-1234',
    `- \`<expectedSha>\`: ${SHA}`,
    '- `<assetsBranch>`: assets-ABC-1234',
    '- `<captureDir>`: .fleet-capture/ABC-1234',
    '- `<bootstrapScript>`: scripts/sandbox-bootstrap.sh',
    '- `<requiredEnv>`: ["REGISTRY_TOKEN"]',
    '- `<sensitivePaths>`: [".env*","secrets/**"]',
    '- `<key>`: ABC-1234',
    '- `<baseUrl>`: http://localhost:3000',
  ]) assert.ok(p.includes(line), `parameter line missing: ${line}`)

  // the rules a worker must not be able to miss
  assert.match(p, /ONLY with the project-supplied bootstrap/)
  assert.match(p, /assert every name in `<requiredEnv>` \(REGISTRY_TOKEN\) is set and non-empty — presence only\. ⛔ Never print a value/)
  assert.match(p, /Never read, grep, cat, dump or edit any path matched by `<sensitivePaths>` \(\.env\*, secrets\/\*\*\)\. A permission prompt parks you forever/)
  assert.match(p, /Push your results ONCE, in one commit, to `<assetsBranch>` \(`assets-ABC-1234`\) — never force-push it/)
  assert.match(p, /On ANY failure write `FAILED\.md`/)
  assert.ok(p.trimEnd().endsWith(END_SENTINEL), 'the sentinel is the last line, so a cut runbook is detectable at the far end')
  assert.deepEqual(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: p }), { ok: true, reason: null })
})

test('requiredEnv is NAMES only — a value is refused, and the refusal does not echo it either', () => {
  // The prompt is read by the worker, the dispatching session and whoever reviews the run; a value in
  // it is published. The same holds for the error that refuses it: an error message lands in exactly
  // the same transcripts.
  assert.throws(() => prompt({ requiredEnv: ['REGISTRY_TOKEN=npm_s3cr3tvalue'] }), e => {
    assert.match(e.message, /carries a value — names only/)
    assert.ok(!e.message.includes('s3cr3t'), 'the refusal must not carry the value')
    return true
  })
  assert.throws(() => assertEnvName('not a name'), /not an environment variable name/)
  assert.throws(() => assertEnvName(''), /not an environment variable name/)
  assert.equal(assertEnvName('REGISTRY_TOKEN'), 'REGISTRY_TOKEN')
})

test('a prompt with no runbook, a colliding results branch, a bad ref, a bad sha or an empty sensitive glob is refused at the door', () => {
  // A worker handed no runbook improvises one; a worker whose results branch IS the capture ref
  // pushes its shots over the commit it is photographing.
  assert.throws(() => prompt({ playbookText: '  \n' }), /playbookText is empty/)
  assert.throws(() => prompt({ resultsBranch: REF }), /both "capture\/ABC-1234"/)
  assert.throws(() => prompt({ ref: 'capture/ABC 1234' }), /not a valid git ref name/)
  assert.throws(() => prompt({ expectedSha: 'not-a-sha' }), /not a commit sha/)
  assert.throws(() => prompt({ sensitivePaths: ['.env*', ''] }), /empty glob/)
  assert.throws(() => prompt({ requiredEnv: ['REGISTRY_TOKEN'], resultsBranch: 'assets-ABC-1234.lock' }), /not a valid git ref name/)
})

test('the runbook copy is verified whole: size, head byte-for-byte, sentinel at the tail', () => {
  // A retyped or echoed runbook once arrived cut off mid-command and the worker filled the gap from
  // memory. The copy must be at least the source's size, begin with the source, and end with the
  // sentinel — and writeRunbook refuses to hand out a file that fails any of the three.
  const p = prompt()
  assert.equal(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: p }).ok, true)
  assert.match(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: p.slice(0, RUNBOOK.trimEnd().length - 50) }).reason, /is \d+ characters, the source \d+ — it was truncated/, 'cut inside the runbook: shorter than the source')
  assert.match(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: p.slice(0, -400) }).reason, /end sentinel — the parameter block or the rules were cut/, 'cut inside the appended block: the size passes, the tail does not')
  assert.match(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: 'x' + p.slice(1) }).reason, /byte-for-byte/)
  assert.match(verifyRunbookCopy({ sourceText: RUNBOOK, copyText: RUNBOOK + '\n'.repeat(3) + 'parameters but no sentinel' + ' '.repeat(600) }).reason, /end sentinel/)
  assert.match(verifyRunbookCopy({ sourceText: '', copyText: p }).reason, /source runbook is empty/)

  const dir = tmp()
  const file = writeRunbook({ dir, text: p, sourceText: RUNBOOK })
  assert.equal(file, path.join(dir, RUNBOOK_FILE))
  assert.equal(fs.readFileSync(file, 'utf8'), p)
  assert.throws(() => writeRunbook({ dir: tmp(), text: p.slice(0, RUNBOOK.trimEnd().length - 50), sourceText: RUNBOOK }), /not whole — .*truncated/)
})

// ---- the transport: where the escaping actually lives ---------------------------------------------

test('POSIX: only the QUOTED PATH of the prompt file reaches the shell; a backtick or $ in the runbook is never parsed', () => {
  // `"$(cat '<file>')"` substitutes the file's bytes into ONE positional and the result of a
  // substitution is never re-parsed — so the prompt travels as a file and the command line holds a
  // path. The path itself is single-quoted, with an embedded quote spelled '\''.
  const cmd = paneCommand({ agent: 'claude', args: ['--cloud', '--model', 'opus'], promptFile: "/s/ada's fleet/RUNBOOK.md" })
  assert.equal(cmd, `exec 'claude' '--cloud' '--model' 'opus' "$(cat '/s/ada'\\''s fleet/RUNBOOK.md')"`)
  assert.equal(posixQuote('a`b$c"d'), `'a\`b$c"d'`)
  assert.throws(() => paneCommand({ agent: 'claude', args: [] }), /promptFile is required — the prompt never rides on the command line/)

  const plan = launchPlan({ platform: 'linux', agent: 'claude', model: 'opus', promptFile: '/s/RUNBOOK.md', cwd: '/s/stub', tmux: { socket: 'fleet', session: 'fleet', exists: false, configFile: '/p/tmux.conf' } })
  assert.equal(plan.via, 'tmux')
  assert.equal(plan.transport, 'file-substitution')
  assert.deepEqual(plan.agentArgs, ['--cloud', '--model', 'opus'], 'the model is passed explicitly — an inherited default once put a fleet on the wrong model')
  assert.ok(!plan.args.join(' ').includes('YOU ARE UNATTENDED'), 'no runbook text on the command line')
  assert.deepEqual(plan.args, ['-L', 'fleet', '-f', '/p/tmux.conf', 'new-session', '-d', '-s', 'fleet', '-n', 'fleet-cloud', '-c', '/s/stub', '-P', '-F', '#{window_id} #{pane_id} #{pane_pid}', plan.paneCommand])
  const into = tmuxLaunchArgs({ socket: 'fleet', session: 'fleet', exists: true, configFile: '/p/tmux.conf', title: 't', cwd: '/s', command: 'x' })
  assert.deepEqual(into.slice(4, 8), ['new-window', '-d', '-t', '=fleet:'], 'an existing session is addressed EXACTLY (=name:), never by prefix')
  assert.deepEqual(parseTmuxSpawn('@3 %7 4242\n'), { windowId: '@3', paneId: '%7', panePid: 4242 })
  assert.equal(parseTmuxSpawn('no server running on /tmp/tmux-1000/fleet'), null)
})

test('POSIX: the cloud CLI refuses a non-TTY shell, so a launch with no tmux socket is refused rather than attempted', () => {
  // A session that invoked the cloud CLI from its tool shell got an instant refusal and misfiled it
  // as `cloud-env`. The scratch tmux window on the fleet's socket IS the pty; without one there is
  // nothing to launch into.
  assert.throws(() => launchPlan({ platform: 'linux', promptFile: '/s/RUNBOOK.md', cwd: '/s/stub' }), /tmux \{socket, session\} is required on POSIX — the cloud CLI refuses a non-TTY shell/)
  assert.throws(() => launchPlan({ platform: 'darwin', promptFile: '/s/RUNBOOK.md', cwd: '/s/stub', tmux: { socket: 'fleet' } }), /tmux \{socket, session\} is required/)
  assert.throws(() => launchPlan({ platform: 'linux', cwd: '/s/stub', tmux: { socket: 'fleet', session: 'fleet' } }), /promptFile is required/)
})

test('POSIX: a real /bin/sh hands the agent the prompt intact — backticks, $HOME, $(cmd) and quotes included', { skip: process.platform === 'win32' ? 'no /bin/sh on Windows' : false }, () => {
  const dir = tmp()
  const promptFile = path.join(dir, RUNBOOK_FILE)
  const out = path.join(dir, 'received.txt')
  const p = prompt()
  fs.writeFileSync(promptFile, p)
  // node stands in for the agent and records its LAST argv token — the prompt.
  const js = `require('fs').writeFileSync(process.env.FLEET_TEST_OUT, process.argv[process.argv.length - 1])`
  const r = execRun('/bin/sh', ['-c', paneCommand({ agent: process.execPath, args: ['-e', js], promptFile })], { env: { FLEET_TEST_OUT: out }, timeoutMs: 30_000 })
  assert.equal(r.ok, true, r.stderr)
  // $(…) strips trailing newlines and nothing else
  assert.equal(fs.readFileSync(out, 'utf8'), p.replace(/\n+$/, ''))
})

test('Windows: the prompt cannot ride on a 32,767-character command line, so it arrives on stdin from the file, in a hidden console', () => {
  // The bundled runbook alone is larger than the Windows command-line ceiling; a "quoted" prompt
  // would not be mangled, it would be refused or cut. The script redirects stdin from the verified
  // file; the argv carries the agent, `--cloud` and the model, C-runtime quoted.
  const script = windowsLaunchScript({ agent: 'C:\\Tools\\claude.cmd', args: ['--cloud', '--model', 'opus'], promptFile: 'C:\\s\\ada\'s\\RUNBOOK.md', cwd: 'C:\\s\\stub' })
  assert.match(script, /^\$ErrorActionPreference = 'Stop'$/m)
  assert.match(script, /Start-Process -FilePath 'cmd\.exe' -WorkingDirectory 'C:\\s\\stub' -ArgumentList @\('\/d', '\/s', '\/c', '"C:\\Tools\\claude\.cmd --cloud --model opus"'\) -RedirectStandardInput 'C:\\s\\ada''s\\RUNBOOK\.md' -WindowStyle Hidden -PassThru/)
  assert.match(script, /\[Console\]::Out\.WriteLine\(\$p\.Id\)/)
  assert.throws(() => windowsLaunchScript({ agent: 'claude', args: [], cwd: 'C:\\s' }), /promptFile is required/)

  const plan = launchPlan({ platform: 'win32', agent: 'claude', model: 'opus', promptFile: 'C:\\s\\RUNBOOK.md', cwd: 'C:\\s\\stub' })
  assert.equal(plan.via, 'hidden-console')
  assert.equal(plan.transport, 'stdin')
  assert.equal(plan.command, 'powershell.exe')
  assert.deepEqual(plan.args.slice(0, 5), [...PS_ARGS, '-EncodedCommand'])
  assert.equal(decodePs(plan.args[5]), plan.script, 'the script travels UTF-16LE base64 — the only encoding a script with quotes survives on a Windows command line')
  assert.ok(!plan.script.includes('YOU ARE UNATTENDED'))
  assert.deepEqual(parseWindowsSpawn('#< CLIXML\r\n31337\r\n'), { pid: 31337 })
  assert.equal(parseWindowsSpawn(''), null)

  // the three quoting layers, each for the parser that will read it
  assert.equal(crtQuote('plain'), 'plain')
  assert.equal(crtQuote('has space'), '"has space"')
  assert.equal(crtQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(crtQuote('a b\\'), '"a b\\\\"', 'trailing backslashes double before the closing quote')
  assert.equal(psLiteral("it's"), "'it''s'")
  assert.equal(psLiteral('`$x`'), "'`$x`'", 'a PowerShell single-quoted literal keeps backticks and $ as data')
  assert.equal(encodeUtf16('x'), Buffer.from('x', 'utf16le').toString('base64'))
})

test('Windows: a real hidden console delivers the whole runbook byte-exact on stdin', { skip: process.platform !== 'win32' ? 'powershell.exe only' : false }, async () => {
  // The launch script is run for real with node standing in for the agent, and the bytes it read from
  // stdin are compared with the file: no quoting layer sits between the file and the CLI.
  const dir = tmp()
  const promptFile = path.join(dir, RUNBOOK_FILE)
  const out = path.join(dir, 'received.txt')
  const p = prompt()
  fs.writeFileSync(promptFile, p)
  const js = "let b=[];process.stdin.on('data',c=>b.push(c)).on('end',()=>require('fs').writeFileSync(process.argv[1],Buffer.concat(b)))"
  const script = windowsLaunchScript({ agent: process.execPath, args: ['-e', js, out], promptFile, cwd: dir })
  const r = execRun('powershell.exe', [...PS_ARGS, '-EncodedCommand', encodeUtf16(script)], { timeoutMs: 60_000 })
  assert.equal(r.ok, true, r.stderr)
  assert.ok(parseWindowsSpawn(r.stdout), `the launch must print the pid, got ${JSON.stringify(r.stdout)}`)
  const deadline = Date.now() + 30_000
  while (!fs.existsSync(out) && Date.now() < deadline) await new Promise(res => setTimeout(res, 100))
  assert.ok(fs.existsSync(out), 'the hidden console never ran the agent')
  assert.equal(fs.readFileSync(out, 'utf8'), p)
})

// ---- the ramp -------------------------------------------------------------------------------------

test('the ramp is gated on branches DELIVERED, never on sessions created: 3 → ~10 → the rest', () => {
  // Eight sessions "running" once produced zero deliveries: a dead worker holds its slot and looks
  // identical to a busy one. Only a landed result branch proves the environment.
  const at = (o) => rampPlan({ target: 20, now: T0, lastDispatchAt: T0 - 10 * MIN, ...o })
  assert.equal(FIRST_WAVE, 3)
  assert.equal(SECOND_WAVE, 10)

  // stage 1: the probe wave, and nothing more until something lands
  assert.deepEqual([at({ dispatched: 0, delivered: 0 }).more, at({ dispatched: 0, delivered: 0 }).stage], [3, 1])
  assert.equal(at({ dispatched: 0, delivered: 0, target: 2 }).more, 2, 'never past the target')
  const probeOut = at({ dispatched: 3, delivered: 0 })
  assert.equal(probeOut.more, 0)
  assert.match(probeOut.reason, /nothing delivered from 3 dispatched — the probe wave is out; diagnose the environment/)
  assert.equal(at({ dispatched: 8, delivered: 0 }).more, 0, 'eight running with zero delivered buys nothing')
  assert.equal(at({ dispatched: 2, delivered: 0, failed: 2 }).more, 1, 'a failure at zero deliveries frees a slot but does not widen the wave')

  // stage 2: the first delivery proves the pipeline; up to 10 in flight
  const second = at({ dispatched: 3, delivered: 1 })
  assert.deepEqual([second.stage, second.ceiling, second.inFlight, second.more], [2, 10, 2, 8])
  assert.equal(at({ dispatched: 11, delivered: 1 }).more, 0)
  assert.match(at({ dispatched: 11, delivered: 1 }).reason, /10 in flight is the stage-2 ceiling/)
  assert.equal(at({ dispatched: 3, delivered: 1, failed: 2 }).more, 10, 'failed workers free their slots')
  assert.equal(at({ dispatched: 3, delivered: 1, maxInFlight: 4 }).more, 2, 'checker.waveWidth caps stage 2 too')

  // stage 3: the probe wave has landed; the rest, bounded by the width
  const rest = at({ dispatched: 11, delivered: 3 })
  assert.deepEqual([rest.stage, rest.inFlight, rest.more], [3, 8, 9])
  assert.equal(at({ dispatched: 11, delivered: 3, maxInFlight: 6 }).more, 0)
  assert.match(at({ dispatched: 11, delivered: 3, maxInFlight: 6 }).reason, /width ceiling/)
  assert.equal(at({ dispatched: 20, delivered: 20 }).more, 0)
  assert.equal(at({ dispatched: 20, delivered: 20 }).reason, 'target reached')
  assert.equal(at({ dispatched: -1, delivered: 'x', target: 'y' }).more, 0, 'garbage counts are zero, never NaN')
})

test('batches are staggered by minutes, because prompts cluster at boot', () => {
  // Twenty workers dispatched in one burst all hit the same cold boot and the same prompt at the same
  // second; the stagger spreads the load and gives the first failures time to show before the next batch.
  assert.equal(STAGGER_MS, 2 * MIN)
  const held = rampPlan({ dispatched: 3, delivered: 1, target: 20, now: T0, lastDispatchAt: T0 - 30_000 })
  assert.deepEqual([held.more, held.waitMs], [0, 90_000])
  assert.match(held.reason, /staggered: 90s until the next batch/)
  assert.equal(rampPlan({ dispatched: 3, delivered: 1, target: 20, now: T0, lastDispatchAt: T0 - STAGGER_MS }).more, 8, 'exactly the stagger is enough')
  assert.equal(rampPlan({ dispatched: 3, delivered: 1, target: 20, now: T0 }).more, 8, 'no previous dispatch, no wait')
  assert.equal(rampPlan({ dispatched: 3, delivered: 1, target: 20, now: new Date(T0).toISOString(), lastDispatchAt: new Date(T0 - 30_000).toISOString() }).waitMs, 90_000, 'ISO timestamps are accepted')
  assert.equal(rampPlan({ dispatched: 3, delivered: 0, target: 20, now: T0, lastDispatchAt: T0 - 30_000 }).waitMs, 0, 'nothing to dispatch means nothing to stagger')
})

// ---- the stall clock ------------------------------------------------------------------------------

test('a worker quiet for more than 25 minutes with no branch is presumed stuck, not slow', () => {
  // An install retry-looped ~30k times over 21 minutes against a blocked host without ever
  // erroring; the worker never wrote FAILED.md because nothing ever failed. Silence past the clock is
  // the verdict, and the re-dispatch goes on a NEW ref.
  assert.equal(STALL_MS, 25 * MIN)
  const running = stallVerdict({ dispatchedAt: T0, now: T0 + 24 * MIN })
  assert.deepEqual([running.verdict, running.action, running.remainingMs], ['running', 'wait', 1 * MIN])
  assert.equal(stallVerdict({ dispatchedAt: T0, now: T0 + 25 * MIN }).verdict, 'running', 'exactly the clock is still running')
  const stuck = stallVerdict({ dispatchedAt: T0, now: T0 + 25 * MIN + 1 })
  assert.deepEqual([stuck.verdict, stuck.action, stuck.retryAsIs], ['stuck', 'redispatch-new-ref', false])
  assert.match(stuck.reason, /quiet 25 min with no branch: presumed stuck/)
  assert.equal(stallVerdict({ dispatchedAt: '2026-03-14T10:00:00Z', now: '2026-03-14T10:30:00Z' }).verdict, 'stuck', 'ISO timestamps are accepted')
  const delivered = stallVerdict({ dispatchedAt: T0, now: T0 + 40 * MIN, delivered: true })
  assert.deepEqual([delivered.verdict, delivered.action], ['delivered', 'harvest'], 'a landed branch is never stuck, however long it took')
  const pushedFailure = stallVerdict({ dispatchedAt: T0, now: T0 + 2 * MIN, failed: true })
  assert.deepEqual([pushedFailure.verdict, pushedFailure.action], ['failed', 'read-failed-md'])
  assert.equal(stallVerdict({ dispatchedAt: T0, now: T0 + 2 * MIN, exitCode: 1 }).verdict, 'failed')
  const noClock = stallVerdict({ dispatchedAt: null, now: T0 })
  assert.deepEqual([noClock.verdict, noClock.quietMs], ['running', null])
  assert.match(noClock.reason, /no clock/)
})

test('exit 137 is the per-container OOM kill: split the slice, never retry it as it was', () => {
  // The sandbox killed the worker for memory; the same slice dies the same way on the same box.
  assert.equal(OOM_EXIT, 137)
  const oom = stallVerdict({ dispatchedAt: T0, now: T0 + 2 * MIN, exitCode: 137 })
  assert.deepEqual([oom.verdict, oom.action, oom.retryAsIs], ['oom', 'split', false])
  assert.match(oom.reason, /split it and dispatch the halves; the same slice dies the same way/)
  assert.equal(stallVerdict({ dispatchedAt: T0, now: T0 + 40 * MIN, exitCode: 137 }).verdict, 'oom', 'OOM outranks the stall clock')
})

// ---- the results poll -----------------------------------------------------------------------------

test('pollResults checks the EXIT CODE: a network failure is a failed listing, never "branch absent"', () => {
  // `git ls-remote` prints nothing for an absent branch (exit 0) and nothing for a dead network
  // (exit 128); a caller that read the empty output as "absent" re-dispatched onto a force-pushed ref
  // and the fresh worker re-shot the previous commit.
  const dead = scripted(() => ({ code: 128, stderr: 'fatal: unable to access \'https://github.com/acme/app/\': Could not resolve host: github.com' }))
  const r = pollResults({ remote: 'origin', branch: RESULTS, run: dead.run })
  assert.deepEqual([r.ok, r.present, r.sha, r.changed, r.delivered], [false, null, null, null, false])
  assert.match(r.error, /git ls-remote origin assets-ABC-1234: exit 128 — fatal: unable to access/)
  assert.deepEqual(dead.calls[0].args, ['ls-remote', '--heads', 'origin', 'refs/heads/assets-ABC-1234'], 'an explicit argv, one token each — never a shell string')

  const slow = scripted(() => ({ timedOut: true }))
  assert.match(pollResults({ remote: 'origin', branch: RESULTS, run: slow.run }).error, /timed out/)

  const absent = scripted(() => ({ stdout: '' }))
  const a = pollResults({ remote: 'origin', branch: RESULTS, run: absent.run })
  assert.deepEqual([a.ok, a.present, a.sha, a.delivered, a.error], [true, false, null, false, null])

  const present = scripted(() => ({ stdout: `${SHA}\trefs/heads/${RESULTS}\n${OTHER}\trefs/heads/${RESULTS}5\n` }))
  const p = pollResults({ remote: 'origin', branch: RESULTS, run: present.run })
  assert.deepEqual([p.ok, p.present, p.sha, p.changed, p.delivered], [true, true, SHA, null, true])
  assert.equal(parseLsRemote(`${OTHER}\trefs/heads/${RESULTS}5\n`, RESULTS), null, 'a branch whose name merely starts with ours is not ours')
  assert.throws(() => pollResults({ remote: 'origin', branch: 'bad..name', run: present.run }), /not a valid git ref name/)
  assert.throws(() => pollResults({ branch: RESULTS, run: present.run }), /remote is required/)
})

test('a delivery is a DIFFERENT tip, not an existing branch: the tip is snapshotted before dispatch', () => {
  // Polling for existence returns instantly on any re-dispatch and collects the previous run's shots;
  // the results branch may also already carry the dispatching session's own artifacts.
  const present = scripted(() => ({ stdout: `${SHA}\trefs/heads/${RESULTS}\n` }))
  const same = pollResults({ remote: 'origin', branch: RESULTS, run: present.run, before: SHA })
  assert.deepEqual([same.present, same.changed, same.delivered], [true, false, false], 'the branch exists, but it is last run\'s tip')
  const moved = pollResults({ remote: 'origin', branch: RESULTS, run: present.run, before: OTHER })
  assert.deepEqual([moved.changed, moved.delivered], [true, true])
  const born = pollResults({ remote: 'origin', branch: RESULTS, run: present.run, before: null })
  assert.deepEqual([born.changed, born.delivered], [true, true], 'a branch that did not exist before dispatch and exists now has moved')
})

test('pollResults against a real remote: absent, then present with the pushed sha', () => {
  const { remote, sha, work } = remoteWithCaptureRef()
  const absent = pollResults({ remote, branch: RESULTS, run: execRun })
  assert.deepEqual([absent.ok, absent.present], [true, false])
  const ref = pollResults({ remote, branch: REF, run: execRun })
  assert.deepEqual([ref.ok, ref.present, ref.sha], [true, true, sha])
  gitq(work, ['push', '-q', 'origin', `HEAD:refs/heads/${RESULTS}`])
  assert.equal(pollResults({ remote, branch: RESULTS, run: execRun, before: null }).delivered, true)
  assert.equal(pollResults({ remote, branch: RESULTS, run: execRun, before: sha }).delivered, false)
  const gone = pollResults({ remote: path.join(remote, 'no-such-repo'), branch: RESULTS, run: execRun })
  assert.deepEqual([gone.ok, gone.present], [false, null], 'a remote that cannot be read is not an absent branch')
})

test('a ref that was dispatched once is never dispatched again — the correction goes on `-v2`', () => {
  // A force-pushed ref is not reliably seen by a fresh worker: the second worker's manifest named the
  // pre-correction commit and its after-shots were byte-identical to run one's. A brand-new name
  // cannot collide with cached state.
  assert.equal(nextRef(REF), 'capture/ABC-1234-v2')
  assert.equal(nextRef('capture/ABC-1234-v2'), 'capture/ABC-1234-v3')
  assert.equal(nextRef('capture/ABC-1234-v9'), 'capture/ABC-1234-v10')
  assert.deepEqual(dispatchGate({ ref: REF, previous: [] }), { ok: true, reason: null, suggestedRef: null, previous: null })
  const seen = { ref: REF, at: '2026-03-14T10:00:00.000Z', sha: SHA }
  const refused = dispatchGate({ ref: REF, previous: [{ ref: 'capture/ABC-1240' }, seen] })
  assert.equal(refused.ok, false)
  assert.equal(refused.suggestedRef, 'capture/ABC-1234-v2')
  assert.equal(refused.previous, seen)
  assert.match(refused.reason, /already dispatched at 2026-03-14T10:00:00.000Z \(sha c0ffee11/)
  assert.match(refused.reason, /never re-dispatch onto an existing ref/)
  for (const bad of ['', 'has space', 'a..b', '-lead', 'x/', 'x.lock', 'a//b', '.hidden', 'a/.b', 'x@{1}', 'y~1', 'z^2', 'q:r', 'w*']) {
    assert.throws(() => assertRefName(bad), /not a valid git ref name/, `ref ${JSON.stringify(bad)} must be refused`)
  }
  assert.equal(assertRefName('capture/ABC-1234-v2'), 'capture/ABC-1234-v2')
})

// ---- what the worker pushed -----------------------------------------------------------------------

test('a 401 from a private registry means REACHED — a network success and a separate credential question', () => {
  // Reading a 401 as "still blocked" sent the operator to fix the allowlist while the token was the
  // problem, and cost a whole cycle. Only a refused tunnel is `blocked`; a name that does not
  // resolve is its own verdict — and the runbook's probe prints it as `blocked ENOTFOUND`.
  const auth = probeVerdict('registry.example.com', 'reached 401')
  assert.deepEqual([auth.verdict, auth.status, auth.credentialRefused], ['reached', 401, true])
  const origin403 = probeVerdict('registry.example.com', 'reached (status 403)')
  assert.deepEqual([origin403.verdict, origin403.credentialRefused], ['reached', true], 'a 403 FROM THE ORIGIN is reached too')
  const ok = probeVerdict('www.example.com', 'reached 200')
  assert.deepEqual([ok.verdict, ok.status, ok.credentialRefused], ['reached', 200, false])
  const tunnel = probeVerdict('cdn.example.com', 'blocked 403 CONNECT')
  assert.deepEqual([tunnel.verdict, tunnel.status, tunnel.credentialRefused], ['blocked', null, false])
  assert.equal(probeVerdict('cdn.example.com', 'blocked connect_rejected').verdict, 'blocked')
  assert.equal(probeVerdict('cdn.example.com', 'blocked (403 CONNECT)').verdict, 'blocked')
  assert.equal(probeVerdict('mirror.example.com', 'blocked ENOTFOUND').verdict, 'dns-failure')
  assert.equal(probeVerdict('mirror.example.com', 'dns failure').verdict, 'dns-failure')
  assert.equal(probeVerdict('x.example.com', '').verdict, 'unknown')
})

test('FAILED.md parses into reason, phase, blocked hosts, per-host probes, the failing command and the recipe', () => {
  // The file is prose a worker wrote under pressure, in the order the runbook's FAILURE section
  // dictates; the dispatching session quotes it into a `cloud-env` flag, so the parts must come apart.
  const f = parseFailedMd(FAILED_MD)
  assert.equal(f.reason, 'blocked host cdn.example.com')
  assert.equal(f.reasonToken, 'blocked-host')
  assert.equal(f.phase, 'boot')
  assert.deepEqual(f.blockedHosts, ['cdn.example.com', 'downloads.example.com'], 'the 401 host and the DNS host are NOT blocked hosts')
  assert.deepEqual(f.probes.map(p => [p.host, p.verdict, p.credentialRefused]), [
    ['registry.example.com', 'reached', true],
    ['cdn.example.com', 'blocked', false],
    ['downloads.example.com', 'blocked', false],
    ['mirror.example.com', 'dns-failure', false],
    ['www.example.com', 'reached', false],
  ])
  assert.equal(f.command, 'npm install --ignore-scripts --prefer-offline --no-audit --no-fund', 'the first fence after the command label is the command; the output fence is not')
  assert.match(f.recipe, /^add cdn\.example\.com and downloads\.example\.com to capture\.allowlistHosts/)
  assert.equal(f.raw, FAILED_MD)

  // a label may stand alone with its value on the next line
  const twoLine = parseFailedMd('**reason**\nmissing REGISTRY_TOKEN\n\n**phase**\nafter\n')
  assert.deepEqual([twoLine.reason, twoLine.reasonToken, twoLine.phase], ['missing REGISTRY_TOKEN', 'missing', 'after'])
  // a hyphen inside a word is label text, not a separator; a colon or a SPACED dash is
  const dashes = parseFailedMd('reason - ref mismatch: expected c0ffee, fetched d15ea5\nphase — deliver\nre-run recipe: re-push the ref and dispatch on capture/ABC-1234-v2\n')
  assert.deepEqual([dashes.reason, dashes.reasonToken, dashes.phase, dashes.recipe], ['ref mismatch: expected c0ffee, fetched d15ea5', 'ref-mismatch', 'deliver', 're-push the ref and dispatch on capture/ABC-1234-v2'])
  // a bare first line is the reason
  const bare = parseFailedMd('install failed: engine mismatch\nphase: before\n')
  assert.deepEqual([bare.reason, bare.reasonToken, bare.phase], ['install failed: engine mismatch', 'install-failed', 'before'])
  const empty = parseFailedMd('')
  assert.deepEqual([empty.reason, empty.reasonToken, empty.phase, empty.blockedHosts, empty.probes], [null, 'unknown', null, [], []])

  assert.equal(reasonToken('runbook truncated: last line received was "8. Wait for readiness"'), 'runbook-truncated')
  assert.equal(reasonToken('needs sensitive path .env*'), 'needs-sensitive-path')
  assert.equal(reasonToken('ref mismatch: expected c0ffee, fetched d15ea5'), 'ref-mismatch')
  assert.equal(reasonToken('Stack Not Ready after 300s'), 'stack-not-ready')
  assert.equal(reasonToken('the worker felt unwell'), 'unknown')
})

test('the manifest is judged by the collection hard-fail list: exact name, a status that is "ok", the pushed sha, no needed host blocked', () => {
  // A missing status is not "ok"; five of six workers once invented a different filename and the
  // status gate silently passed nothing; a worker that checked out a different commit produced a
  // before/after pair that was both "before".
  const files = ['manifest.json', 'before-home.png', 'after-home.png', 'outbox/0001-createIssue.json', 'outbox/0002-createIssue.json']
  const good = harvestResult({ sha: OTHER, files, manifestText: manifestFixture(), expectedSha: SHA, outboxTexts: { 'outbox/0002-createIssue.json': '{"op":"op-13","key":null}', 'outbox/0001-createIssue.json': '{"op":"op-13","title":"a"}' } })
  assert.equal(good.status, 'ok')
  assert.equal(good.sha, OTHER)
  assert.deepEqual(good.verdict, { ok: true, reasons: [] })
  assert.deepEqual(good.shots, ['after-home.png', 'before-home.png'], 'only PNGs, sorted')
  assert.deepEqual(good.blockedHosts, ['fonts.example.com'], 'the manifest list plus every probe that says blocked; the 401 host is not among them')
  assert.deepEqual(good.probes.map(p => [p.host, p.verdict, p.credentialRefused]).sort(), [
    ['cdn.example.com', 'reached', false],
    ['fonts.example.com', 'blocked', false],
    ['registry.example.com', 'reached', true],
  ])
  assert.deepEqual(good.outboxEntries.map(e => [e.file, e.entry.op, e.error]), [['outbox/0001-createIssue.json', 'op-13', null], ['outbox/0002-createIssue.json', 'op-13', null]], 'outbox entries in file order')

  const needed = harvestResult({ files, manifestText: manifestFixture(), expectedSha: SHA, neededHosts: ['FONTS.example.com'] })
  assert.deepEqual(needed.verdict.reasons, ['blocked host fonts.example.com is one the screen needs'])

  const wrongSha = harvestResult({ files, manifestText: manifestFixture({ after_commit: OTHER }), expectedSha: SHA })
  assert.match(wrongSha.verdict.reasons[0], /after_commit d15ea5e0.* is not the pushed sha c0ffee11.* — the worker photographed a different revision/)
  assert.equal(harvestResult({ files, manifestText: manifestFixture({ after_commit: SHA.slice(0, 12) }), expectedSha: SHA }).verdict.ok, true, 'an abbreviated sha that is a prefix still matches')
  assert.match(harvestResult({ files, manifestText: manifestFixture({ after_commit: null }), expectedSha: SHA }).verdict.reasons[0], /after_commit is missing/)

  const noStatus = harvestResult({ files, manifestText: manifestFixture({ status: undefined }), expectedSha: SHA })
  assert.equal(noStatus.status, 'missing-status')
  assert.deepEqual(noStatus.verdict.reasons, ['manifest status is missing — a missing status is not "ok"'])
  assert.deepEqual(harvestResult({ files, manifestText: manifestFixture({ status: 'failed' }), expectedSha: SHA }).verdict.reasons, ['manifest status is "failed"'])

  const renamed = harvestResult({ files: ['capture-manifest.json', 'after-home.png'], manifestText: null })
  assert.equal(renamed.status, 'missing-manifest')
  assert.deepEqual(renamed.verdict.reasons, ['manifest.json is missing (a differently named file does not count)'])
  assert.deepEqual(parseManifest('[1,2]'), { manifest: null, error: 'manifest.json is not a JSON object' })
  assert.match(parseManifest('{not json').error, /does not parse/)
  assert.deepEqual(parseManifest(null), { manifest: null, error: null })

  const withFailure = harvestResult({ files: [...files, 'FAILED.md'], manifestText: manifestFixture(), failedText: FAILED_MD, expectedSha: SHA })
  assert.equal(withFailure.verdict.ok, false)
  assert.match(withFailure.verdict.reasons[0], /FAILED\.md present: blocked host cdn\.example\.com/)
  assert.deepEqual(withFailure.blockedHosts, ['fonts.example.com', 'cdn.example.com', 'downloads.example.com'])
  assert.equal(withFailure.failed.phase, 'boot')

  const failedOnly = harvestResult({ files: ['FAILED.md'], failedText: 'stack not ready\nphase: boot\n' })
  assert.equal(failedOnly.status, 'failed')
  assert.deepEqual(collectVerdict({ manifest: null, failed: failedOnly.failed }).reasons, ['FAILED.md present: stack not ready', 'manifest.json is missing (a differently named file does not count)'])
  const badOutbox = harvestResult({ files: ['outbox/x.json'], outboxTexts: { 'outbox/x.json': '{oops' } })
  assert.equal(badOutbox.outboxEntries[0].entry, null)
  assert.match(badOutbox.outboxEntries[0].error, /does not parse/)
})

test('harvest against a real remote: fetch, pin the tip, read every file by sha, extract the shots byte-exact', () => {
  // The sha is PINNED because a worker can push again after collection — one landed seconds before a
  // PR opened and the images the PR embedded were not the ones reviewed. Files are read with
  // `git show <sha>:<path>`, never from a checkout, and a PNG must come back byte-for-byte.
  const { remote, sha } = remoteWithCaptureRef()
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really an image \u00ff\u0000 but binary enough\r\n\n', 'latin1'), Buffer.from([0, 1, 2, 3, 255, 254, 13, 10])])
  const results = workClone(remote)
  const tip1 = commitAll(results, {
    'manifest.json': manifestFixture({ after_commit: sha, ref: sha, blockedHosts: [] , hostProbe: { 'registry.example.com': 'reached (401)' } }),
    'before-home.png': png,
    'after-home.png': Buffer.concat([png, Buffer.from([42])]),
    'outbox/0001-createIssue.json': '{"op":"op-13","title":"Login button unreachable by keyboard","labels":["a11y: keyboard"]}\n',
    'notes.txt': 'not a shot\n',
  }, 'capture results for ABC-1234')
  gitq(results, ['push', '-q', 'origin', `HEAD:refs/heads/${RESULTS}`])

  const into = workClone(remote) // the primary checkout or a scratch clone — never a worktree that may be deregistered
  const extractTo = path.join(tmp(), 'shots')
  const h = harvest({ branch: RESULTS, into, remote: 'origin', run: execRun, expectedSha: sha, extractTo })
  assert.equal(h.sha, tip1)
  assert.equal(h.status, 'ok')
  assert.deepEqual(h.verdict, { ok: true, reasons: [] })
  assert.deepEqual(h.shots, ['after-home.png', 'before-home.png'])
  assert.deepEqual(h.files.sort(), ['after-home.png', 'before-home.png', 'manifest.json', 'notes.txt', 'outbox/0001-createIssue.json'])
  assert.deepEqual(h.outboxEntries.map(e => [e.file, e.entry.op, e.entry.labels[0]]), [['outbox/0001-createIssue.json', 'op-13', 'a11y: keyboard']])
  assert.deepEqual(h.probes.map(p => [p.host, p.verdict, p.credentialRefused]), [['registry.example.com', 'reached', true]])
  assert.deepEqual(h.blockedHosts, [])
  assert.deepEqual(h.extracted.map(f => path.relative(extractTo, f)).sort(), ['after-home.png', 'before-home.png'])
  assert.ok(fs.readFileSync(path.join(extractTo, 'before-home.png')).equals(png), 'the PNG bytes are exact — a text decode would corrupt them')
  assert.ok(fs.readFileSync(path.join(extractTo, 'after-home.png')).equals(Buffer.concat([png, Buffer.from([42])])))

  // a later push moves the tip: the harvest pins the NEW sha and reads the failure from it
  const tip2 = commitAll(results, { 'FAILED.md': FAILED_MD, 'manifest.json': manifestFixture({ status: 'failed', after_commit: null }) }, 'second push')
  gitq(results, ['push', '-q', 'origin', `HEAD:refs/heads/${RESULTS}`])
  const again = harvest({ branch: RESULTS, into, remote: 'origin', run: execRun, expectedSha: sha })
  assert.equal(again.sha, tip2)
  assert.notEqual(again.sha, tip1)
  assert.equal(again.status, 'failed')
  assert.equal(again.failed.reasonToken, 'blocked-host')
  assert.deepEqual(again.blockedHosts, ['fonts.example.com', 'cdn.example.com', 'downloads.example.com'], 'the manifest\'s blocked hosts and the failure\'s are merged')
  assert.equal(again.verdict.ok, false)
  assert.match(again.verdict.reasons.join('\n'), /FAILED\.md present/)
  assert.match(again.verdict.reasons.join('\n'), /manifest status is "failed"/)

  // a failed fetch is a failed harvest, never "nothing delivered"
  assert.throws(() => harvest({ branch: 'assets-ABC-9999', into, remote: 'origin', run: execRun }), /git fetch origin assets-ABC-9999 failed — .*a failed fetch is not "nothing delivered"/)
  assert.throws(() => harvest({ branch: RESULTS, remote: 'origin', run: execRun }), /into \(a repository directory\) is required/)
})

// ---- the transcript and the log -------------------------------------------------------------------

test('the session id and viewer URL are read loosely from the transcript — field names, then any URL that names the id', () => {
  // The transcript format is the host's and changes between releases; a fixed record shape would go
  // blind on the next release and every dispatch would "fail" with a live worker behind it.
  const lines = [
    'not json at all',
    JSON.stringify({ type: 'system', session_id: 'sess_01ABC', cwd: '/s/stub' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Follow along at https://cloud.example.com/sessions/sess_01ABC?tab=log — running.' }] } }),
  ].join('\n')
  assert.deepEqual(sessionInfoFrom(lines), { sessionId: 'sess_01ABC', viewUrl: 'https://cloud.example.com/sessions/sess_01ABC?tab=log' })
  assert.deepEqual(sessionInfoFrom(JSON.stringify({ remoteSessionId: 'r1', viewUrl: 'https://cloud.example.com/r/r1' })), { sessionId: 'r1', viewUrl: 'https://cloud.example.com/r/r1' })
  assert.deepEqual(sessionInfoFrom(JSON.stringify({ sessionId: 'x9', text: 'see https://cloud.example.com/other/unrelated' })), { sessionId: 'x9', viewUrl: null }, 'a URL that does not name the id is not the viewer URL')
  assert.deepEqual(sessionInfoFrom(''), { sessionId: null, viewUrl: null })
  assert.deepEqual(sessionInfoFrom(null), { sessionId: null, viewUrl: null })
})

test('the dispatch log is one JSON line per dispatch, appended synchronously; a half-written line is skipped, never fatal', () => {
  // A dispatch killed mid-write leaves a partial last line; a reader that threw on it would refuse
  // EVERY later dispatch for the whole state dir.
  const stateDir = tmp()
  assert.deepEqual(readDispatchLog(stateDir, 'linux'), [])
  const file = appendDispatchLog(stateDir, { ref: REF, sha: SHA, at: '2026-03-14T10:00:00.000Z' }, 'linux')
  appendDispatchLog(stateDir, { ref: 'capture/ABC-1240', sha: OTHER }, 'linux')
  fs.appendFileSync(file, '{"ref":"capture/ABC-12')
  const log = readDispatchLog(stateDir, 'linux')
  assert.deepEqual(log.map(e => [e.v, e.ref]), [[1, REF], [1, 'capture/ABC-1240']])
  assert.ok(fs.readFileSync(file, 'utf8').split('\n')[0].endsWith('}'), 'each complete record ends with its newline')
  assert.equal(dispatchGate({ ref: REF, previous: log }).ok, false)
  assert.equal(dispatchGate({ ref: 'capture/ABC-1234-v2', previous: log }).ok, true)
})

// ---- the stub -------------------------------------------------------------------------------------

test('the stub is a tiny blobless clone pinned to the PUSHED ref — never the worktree', () => {
  // The cloud CLI uploads its working directory; a checkout of a monorepo died with a misleading
  // "too large" error. The stub carries the ref's commit, a local branch of the same name and HEAD
  // on it, and the sandbox checks the real tree out server-side.
  const { remote, sha } = remoteWithCaptureRef()
  const into = path.join(tmp(), 'stub')
  const built = buildStub({ into, remoteUrl: remote, ref: REF })
  assert.deepEqual(built, { sha, head: REF })
  assert.equal(gitq(into, ['rev-parse', 'HEAD']).stdout.trim(), sha)
  assert.equal(gitq(into, ['symbolic-ref', 'HEAD']).stdout.trim(), `refs/heads/${REF}`)
  assert.equal(gitq(into, ['remote', 'get-url', 'origin']).stdout.trim().replace(/\\/g, '/'), remote.replace(/\\/g, '/'))
  assert.ok(fs.existsSync(path.join(into, '.git', 'shallow')), 'depth 1')
  assert.ok(!fs.existsSync(path.join(into, 'README.md')), 'nothing is checked out: the stub is an address, not a tree')

  assert.throws(() => buildStub({ into, remoteUrl: remote, ref: REF }), /already exists and is not empty/)
  assert.throws(() => buildStub({ into: path.join(tmp(), 's2'), remoteUrl: remote, ref: 'capture/ABC-9999' }), /git fetch origin capture\/ABC-9999 failed/)
  assert.throws(() => buildStub({ into: path.join(tmp(), 's3'), remoteUrl: remote, ref: 'bad ref' }), /not a valid git ref name/)
})

// ---- dispatch, end to end -------------------------------------------------------------------------

/** The scripted tmux: no fleet session yet, the new one prints its ids, the window option sticks. */
const tmuxScript = (argv, { command, args }) => {
  if (command !== 'tmux') return undefined
  if (args.includes('has-session')) return { code: 1, stderr: 'no server running' }
  if (args.includes('new-session') || args.includes('new-window')) return { stdout: '@1 %1 4242\n' }
  if (args.includes('set-option')) return {}
  return undefined
}
const TRANSCRIPT = [
  JSON.stringify({ type: 'system', sessionId: 'sess_01ABC', cwd: '/s/stub' }),
  JSON.stringify({ type: 'assistant', content: 'Follow along at https://cloud.example.com/sessions/sess_01ABC' }),
].join('\n') + '\n'

test('dispatch (POSIX): real stub, verified runbook, scratch tmux window on the fleet socket, id + URL from the transcript, one log line — and never the same ref twice', async () => {
  const { remote, sha } = remoteWithCaptureRef()
  const stateDir = tmp()
  const bundleDir = path.join(tmp(), 'ABC-1234')
  fs.mkdirSync(bundleDir)
  fs.writeFileSync(path.join(bundleDir, 'spec.mjs'), 'export const shots = ["home"]\n')
  const p = prompt({ expectedSha: sha })
  const launch = hybrid(tmuxScript)
  const reads = []

  const r = await dispatch({
    ref: REF, resultsBranch: RESULTS, remoteUrl: remote, prompt: p, playbookText: RUNBOOK, bundleDir, stateDir,
    platform: 'linux', tmux: { socket: 'fleet', session: 'fleet', configFile: '/p/tmux.conf' }, agent: 'claude', model: 'opus',
    run: launch.run, readTranscript: (q) => { reads.push(q); return TRANSCRIPT }, sleep: async () => { throw new Error('must not sleep when the transcript answers at once') }, clock: () => T0,
  })
  assert.equal(r.sessionId, 'sess_01ABC')
  assert.equal(r.viewUrl, 'https://cloud.example.com/sessions/sess_01ABC')
  assert.deepEqual([r.ref, r.sha, r.resultsBranch, r.resultsTipBefore, r.via, r.launchedAt, r.warnings], [REF, sha, RESULTS, null, 'tmux', T0, []])
  assert.deepEqual(r.launch, { windowId: '@1', paneId: '%1', panePid: 4242 })

  // the stub: pinned to the pushed sha, the bundle beside the runbook, the runbook whole
  assert.equal(gitq(r.stub, ['rev-parse', 'HEAD']).stdout.trim(), sha)
  assert.ok(r.stub.startsWith(path.join(stateDir, 'cloud')), 'stubs live under the state dir, never a temp dir')
  assert.ok(fs.existsSync(path.join(r.stub, 'ABC-1234', 'spec.mjs')), 'the --bundle directory is copied in under its basename')
  assert.equal(r.promptFile, path.join(r.stub, RUNBOOK_FILE))
  assert.equal(fs.readFileSync(r.promptFile, 'utf8'), p)
  assert.deepEqual(reads[0], { cwd: r.stub, sinceMs: T0 }, 'the transcript is looked for under the STUB (the CLI ran there), written since the launch')

  // the launch: the fleet's socket, a detached window, the runbook by PATH only, remain-on-exit
  const tmuxCalls = launch.calls.filter(c => c.command === 'tmux')
  assert.deepEqual(tmuxCalls.map(c => c.args.find(a => ['has-session', 'new-session', 'new-window', 'set-option'].includes(a))), ['has-session', 'new-session', 'set-option'])
  const spawn = tmuxCalls[1].args
  assert.deepEqual(spawn.slice(0, 6), ['-L', 'fleet', '-f', '/p/tmux.conf', 'new-session', '-d'])
  assert.equal(spawn[spawn.indexOf('-c') + 1], r.stub)
  assert.equal(spawn[spawn.indexOf('-n') + 1], 'cloud-capture-ABC-1234')
  const pane = spawn[spawn.length - 1]
  assert.ok(pane.startsWith(`exec 'claude' '--cloud' '--model' 'opus' "$(cat '`), pane)
  assert.ok(pane.includes(posixQuote(r.promptFile)), 'the runbook file path, single-quoted')
  assert.ok(!pane.includes('YOU ARE UNATTENDED') && !pane.includes(END_SENTINEL), 'no runbook text on the command line')
  assert.deepEqual(tmuxCalls[2].args.slice(4), ['set-option', '-w', '-t', '@1', 'remain-on-exit', 'on'], 'a crashed CLI keeps its scrollback — the only evidence of why the dispatch died')
  assert.ok(!launch.calls.some(c => c.opts && c.opts.shell), 'never shell: true')

  // the log: exactly one record, and it is what refuses a second dispatch on this ref
  const log = readDispatchLog(stateDir, 'linux')
  assert.equal(log.length, 1)
  assert.deepEqual([log[0].v, log[0].ref, log[0].sha, log[0].resultsBranch, log[0].resultsTipBefore, log[0].viewUrl, log[0].sessionId, log[0].via, log[0].at], [1, REF, sha, RESULTS, null, r.viewUrl, 'sess_01ABC', 'tmux', new Date(T0).toISOString()])
  await assert.rejects(dispatch({
    ref: REF, resultsBranch: RESULTS, remoteUrl: remote, prompt: p, playbookText: RUNBOOK, stateDir,
    platform: 'linux', tmux: { socket: 'fleet', session: 'fleet' }, run: hybrid(tmuxScript).run, readTranscript: () => TRANSCRIPT, sleep: async () => {}, clock: () => T0 + MIN,
  }), /already dispatched at 2026-03-14T10:00:00\.000Z .*; dispatch on capture\/ABC-1234-v2 instead/)
  assert.equal(readDispatchLog(stateDir, 'linux').length, 1)
})

test('dispatch refuses an unpushed ref, and a listing that FAILS is "cannot read", never "not pushed"', async () => {
  // The dispatch targets a pushed ref through the stub — an absent ref would have the sandbox
  // check out nothing. And the network trap from pollResults applies here too: a dead network must
  // not read as "push it first", or the session force-pushes a ref that was never the problem.
  const { remote } = remoteWithCaptureRef()
  const stateDir = tmp()
  const p = prompt({ ref: 'capture/ABC-1240' })
  const base = { resultsBranch: RESULTS, remoteUrl: remote, prompt: p, playbookText: RUNBOOK, stateDir, platform: 'linux', tmux: { socket: 'fleet', session: 'fleet' }, readTranscript: () => TRANSCRIPT, sleep: async () => {}, clock: () => T0 }
  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', run: hybrid(tmuxScript).run }), /capture\/ABC-1240 is not on the remote — push it first \(git push <remote> HEAD:capture\/ABC-1240\); the dispatch targets the ref, never the worktree/)

  const dead = scripted((argv, { args }) => (args.includes('ls-remote') ? { code: 128, stderr: 'fatal: unable to access: Could not resolve host' } : undefined))
  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', run: dead.run }), e => {
    assert.match(e.message, /cannot read capture\/ABC-1240 on the remote — git ls-remote .* exit 128/)
    assert.ok(!/not on the remote/.test(e.message), 'a network failure is not "absent"')
    return true
  })
  assert.equal(dead.calls.length, 1, 'nothing else was attempted')
  assert.deepEqual(readDispatchLog(stateDir, 'linux'), [], 'nothing was recorded, so a retry is allowed')

  // the results-branch snapshot must succeed too: without it a poll cannot tell this run from the last
  const halfDead = scripted((argv, { args }) => {
    if (!args.includes('ls-remote')) return undefined
    return args.includes(`refs/heads/${RESULTS}`) ? { timedOut: true } : { stdout: `${SHA}\trefs/heads/capture/ABC-1240\n` }
  })
  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', run: halfDead.run }), /cannot snapshot assets-ABC-1234 before dispatching — .*timed out; without that snapshot a poll cannot tell this run's delivery from the last one's/)

  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', resultsBranch: 'capture/ABC-1240', run: hybrid(tmuxScript).run }), /both "capture\/ABC-1240"/)
  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', bundleDir: path.join(tmp(), 'absent'), run: hybrid(tmuxScript).run }), /bundle .* does not exist/)
  await assert.rejects(dispatch({ ...base, ref: 'capture/ABC-1240', prompt: '', run: hybrid(tmuxScript).run }), /prompt is required — build it with buildRunbookPrompt/)
})

test('dispatch (Windows): the hidden console is started through powershell.exe with the runbook on stdin, and the pid is the handle', async () => {
  const { remote, sha } = remoteWithCaptureRef()
  const stateDir = tmp()
  const p = prompt({ expectedSha: sha })
  const ps = hybrid((argv, { command }) => (command === 'powershell.exe' ? { stdout: '#< CLIXML\r\n31337\r\n' } : undefined))
  const r = await dispatch({
    ref: REF, resultsBranch: RESULTS, remoteUrl: remote, prompt: p, playbookText: RUNBOOK, stateDir,
    platform: 'win32', agent: 'claude', model: 'opus', run: ps.run, readTranscript: () => TRANSCRIPT, sleep: async () => {}, clock: () => T0,
  })
  assert.deepEqual([r.via, r.launch, r.sessionId], ['hidden-console', { pid: 31337 }, 'sess_01ABC'])
  const call = ps.calls.find(c => c.command === 'powershell.exe')
  assert.deepEqual(call.args.slice(0, 5), [...PS_ARGS, '-EncodedCommand'])
  const script = decodePs(call.args[5])
  assert.ok(script.includes(`-RedirectStandardInput ${psLiteral(r.promptFile)}`), script)
  assert.ok(script.includes(`-WorkingDirectory ${psLiteral(r.stub)}`))
  assert.ok(script.includes('-WindowStyle Hidden -PassThru'))
  assert.ok(script.includes('claude --cloud --model opus'))
  assert.ok(!script.includes('YOU ARE UNATTENDED'), 'no runbook text on the command line')
  assert.ok(!ps.calls.some(c => c.command === 'tmux'), 'no tmux on Windows')
  assert.equal(readDispatchLog(stateDir, 'win32')[0].via, 'hidden-console')
})

test('a launch whose transcript never names a session fails LOUDLY and records nothing — so the retry on the same ref stays allowed', async () => {
  // The log entry is written last, on purpose: a dispatch that died before a worker existed must not
  // leave a record that then refuses the retry with "already dispatched".
  const { remote, sha } = remoteWithCaptureRef()
  const stateDir = tmp()
  let t = T0
  const launch = hybrid(tmuxScript)
  let slept = 0
  await assert.rejects(dispatch({
    ref: REF, resultsBranch: RESULTS, remoteUrl: remote, prompt: prompt({ expectedSha: sha }), playbookText: RUNBOOK, stateDir,
    platform: 'linux', tmux: { socket: 'fleet', session: 'fleet' }, run: launch.run, readTranscript: () => null,
    sleep: async () => { slept++ }, clock: () => (t += 30_000), harvestTimeoutMs: 2 * MIN, pollMs: 1,
  }), /the worker launched \(tmux \{"windowId":"@1","paneId":"%1","panePid":4242\}\) but no transcript named a session within 120s — open the window and read what the CLI printed; nothing was recorded, so a retry on capture\/ABC-1234 is allowed/)
  assert.ok(slept >= 2, 'it polled with the injected sleep rather than spinning')
  assert.deepEqual(readDispatchLog(stateDir, 'linux'), [])

  // a transcript with an id but no URL is a warning, not a failure: the id is the worker handle
  const idOnly = JSON.stringify({ sessionId: 'sess_02' }) + '\n'
  const r = await dispatch({
    ref: REF, resultsBranch: RESULTS, remoteUrl: remote, prompt: prompt({ expectedSha: sha }), playbookText: RUNBOOK, stateDir,
    platform: 'linux', tmux: { socket: 'fleet', session: 'fleet' }, run: hybrid(tmuxScript).run, readTranscript: () => idOnly,
    sleep: async () => {}, clock: () => (t += 30_000), harvestTimeoutMs: 2 * MIN,
  })
  assert.deepEqual([r.sessionId, r.viewUrl], ['sess_02', null])
  assert.deepEqual(r.warnings, ['the transcript names a session id but no viewer URL — record the id as the worker handle'])
  assert.equal(readDispatchLog(stateDir, 'linux').length, 1)
})
