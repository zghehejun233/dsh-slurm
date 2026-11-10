/**
 * OpenSSH transport for dsh-slurm.
 *
 * Everything here is argv-based: no model-supplied text is ever handed to a
 * local shell. The remote side still runs a shell (OpenSSH semantics), so
 * remote command strings are assembled exclusively from `shQuote`d pieces.
 */

import { spawn } from 'node:child_process'

/** Quote one word for a POSIX shell. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Printable form of an argv: the program stays bare, unsafe words are quoted. */
export function displayCommand(argv) {
  const safe = /^[A-Za-z0-9_@%+=:,./-]+$/u
  return argv.map((word, index) => (index === 0 || safe.test(String(word)) ? String(word) : shQuote(word))).join(' ')
}

/** Join an argv into one remote shell command line. */
export function remoteCommand(argv) {
  return argv.map(shQuote).join(' ')
}

function optionArgs(spec, portFlag = 'p') {
  const args = [...(spec.extraArgs ?? [])]
  for (const option of spec.options ?? []) args.push('-o', option)
  if (Number.isInteger(spec.port) && spec.port !== 22) args.push(`-${portFlag}`, String(spec.port))
  if (typeof spec.keyPath === 'string' && spec.keyPath !== '') args.push('-i', spec.keyPath)
  if (Array.isArray(spec.proxyJump) && spec.proxyJump.length > 0) args.push('-J', spec.proxyJump.join(','))
  return args
}

/** Build the local `ssh` argv for one remote command. */
export function buildSshArgv(spec, command) {
  return [...optionArgs(spec), '--', spec.target, command]
}

/** Build the local `sftp` argv. */
export function buildSftpArgv(spec) {
  return [...optionArgs(spec, 'P'), '-b', '-', '--', spec.target]
}

/** Build the local `scp` argv. */
export function buildScpArgv(spec, remotePath, localPath, { recursive = true } = {}) {
  const args = optionArgs(spec, 'P')
  if (recursive) args.push('-r')
  args.push(`${spec.target}:${remotePath}`, localPath)
  return args
}

/** Build the `ssh` command string rsync's `-e` expects. */
export function buildRsyncSsh(spec) {
  const parts = ['ssh']
  for (const option of spec.options ?? []) parts.push('-o', shQuote(option))
  if (Number.isInteger(spec.port) && spec.port !== 22) parts.push('-p', String(spec.port))
  if (typeof spec.keyPath === 'string' && spec.keyPath !== '') parts.push('-i', shQuote(spec.keyPath))
  if (Array.isArray(spec.proxyJump) && spec.proxyJump.length > 0) parts.push('-J', shQuote(spec.proxyJump.join(',')))
  return parts.join(' ')
}

/**
 * Run one local process, capturing bounded stdout/stderr.
 * @param {string} file - executable.
 * @param {string[]} args - argv.
 * @param {{input?: string, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, durationMs: number, error?: string}>}
 */
export function runProcess(file, args, options = {}) {
  const { input, timeoutMs = 20000, signal, maxBytes = 2000000 } = options
  return new Promise((resolve) => {
    if (signal !== undefined && signal.aborted) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0, error: 'aborted' })
      return
    }
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let abortError
    const timers = []

    const finish = (code, error) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout: clip(stdout, maxBytes),
        stderr: clip(stderr, maxBytes),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        ...(abortError !== undefined ? { error: abortError } : error === undefined ? {} : { error }),
      })
    }
    const terminate = (sig) => {
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, sig); return } catch {}
      }
      try { child.kill(sig) } catch {}
    }
    const onAbort = () => {
      if (settled || abortError !== undefined) return
      abortError = 'aborted'
      terminate('SIGKILL')
      const timer = setTimeout(() => finish(null, abortError), 3000)
      timer.unref?.()
      timers.push(timer)
    }
    const append = (chunk, target) => {
      const text = chunk.toString('utf8')
      if (target === 'out') {
        stdout += text
        if (stdout.length > maxBytes) { stdout = stdout.slice(-maxBytes); truncated = true }
      } else {
        stderr += text
        if (stderr.length > maxBytes) { stderr = stderr.slice(-maxBytes); truncated = true }
      }
    }

    let child
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error))
      return
    }

    child.stdout.on('data', (chunk) => append(chunk, 'out'))
    child.stderr.on('data', (chunk) => append(chunk, 'err'))
    child.on('error', (error) => finish(null, error instanceof Error ? error.message : String(error)))
    child.on('close', (code) => finish(code))

    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate('SIGTERM')
      const hard = setTimeout(() => terminate('SIGKILL'), 500)
      hard.unref?.()
      timers.push(hard)
      const giveUp = setTimeout(() => finish(null, 'timed out'), 5000)
      giveUp.unref?.()
      timers.push(giveUp)
    }, Math.max(1000, timeoutMs))
    timer.unref?.()
    timers.push(timer)

    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function clip(text, limit) {
  return text.length <= limit ? text : text.slice(-limit)
}

/** Run `ssh <target> <command>`. */
export function runSsh(spec, command, options = {}) {
  return runProcess('ssh', buildSshArgv(spec, command), options)
}
