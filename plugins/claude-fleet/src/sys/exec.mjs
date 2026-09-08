// The one place this tool spawns a process.
//
// ⛔ Never `shell: true`. Every call passes an explicit argv, so a branch name, a worktree path or a
// ticket title containing a quote, a space or a semicolon is data rather than syntax. A tool that
// runs a configured `commands.*` string in a fleet of worktrees is exactly where shell injection
// would be both easy and catastrophic.
//
// A configured command (commands.bootstrap, commands.devServer …) IS a shell string by nature — the
// user wrote it — so it goes through `shellCommand()`, which is explicit about that at the call site
// instead of leaving `shell: true` scattered around.

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

/** Cap on captured output, so a runaway command cannot exhaust memory. */
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Run a command with an explicit argv and wait for it.
 * @returns {{ok: boolean, code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}}
 */
export function run(command, args = [], opts = {}) {
  const { cwd, env, timeoutMs = 120_000, input, encoding = 'utf8' } = opts
  const r = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs,
    input,
    encoding,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    shell: false,
  })
  if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM' && r.error
  return {
    ok: r.status === 0 && !timedOut,
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: !!timedOut,
  }
}

/** Run and throw a useful error unless the exit code is 0. */
export function runOrThrow(command, args = [], opts = {}) {
  const r = run(command, args, opts)
  if (!r.ok) {
    const why = r.timedOut ? `timed out after ${opts.timeoutMs ?? 120_000}ms` : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}`
    throw new Error(`${command} ${args.join(' ')} — ${why}\n${(r.stderr || r.stdout).slice(0, 2000)}`)
  }
  return r
}

/**
 * Run a user-configured command string through the platform shell. Use ONLY for `commands.*` values,
 * which are shell strings by definition; everything else uses run().
 */
export function shellCommand(commandString, opts = {}) {
  const { cwd, env, timeoutMs = 20 * 60_000 } = opts
  const [file, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', commandString]]
    : ['/bin/sh', ['-c', commandString]]
  return run(file, args, { cwd, env, timeoutMs })
}

/**
 * Start a long-lived process and return immediately.
 * On POSIX `detached: true` makes it a process-group leader, so the whole tree can be signalled by
 * `kill(-pgid)` later — that is what makes teardown reliable rather than best-effort.
 * @returns {{pid: number|undefined, pgid: number|undefined, child: import('node:child_process').ChildProcess}}
 */
export function spawnDetached(command, args = [], opts = {}) {
  const { cwd, env, stdio = 'ignore' } = opts
  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    detached: process.platform !== 'win32',
    stdio,
    windowsHide: true,
    shell: false,
  })
  child.unref()
  return { pid: child.pid, pgid: process.platform === 'win32' ? undefined : child.pid, child }
}

/** Is `command` on PATH? Cheap and side-effect free. */
export function which(command) {
  const probe = process.platform === 'win32'
    ? run('where.exe', [command], { timeoutMs: 5000 })
    : run('/usr/bin/env', ['sh', '-c', `command -v ${JSON.stringify(command)}`], { timeoutMs: 5000 })
  if (!probe.ok) return null
  const first = probe.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
  return first || null
}

/** git, always with an explicit -C so no call depends on the process's cwd. */
export function git(repoDir, args, opts = {}) {
  return run('git', ['-C', repoDir, ...args], { timeoutMs: 60_000, ...opts })
}

export function gitOrThrow(repoDir, args, opts = {}) {
  return runOrThrow('git', ['-C', repoDir, ...args], { timeoutMs: 60_000, ...opts })
}
