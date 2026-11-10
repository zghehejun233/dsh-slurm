/**
 * Configuration schema and SSH target resolution for dsh-slurm.
 *
 * The plugin never stores credentials: a target is either an alias from
 * `$DSH_HOME/dsh-ssh.json` (the store the dsh-ssh plugin already maintains) or
 * a raw `user@host[:port]`. The OpenSSH client does the authentication.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export const DEFAULT_CONTINUE_PROMPT =
  '作业 {jobId}（{name}）已结束，状态 {state}，退出码 {exitCode}。请检查结果与日志，继续下一步。'

export const DEFAULTS = Object.freeze({
  enabled: true,
  host: '',
  workdir: '',
  pollSeconds: 60,
  panelRefreshSeconds: 8,
  historyHours: 24,
  retentionDays: 14,
  maxLogBytes: 65536,
  logTailLines: 40,
  followUpByDefault: true,
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  connectTimeoutMs: 10000,
  sshExtraArgs: [],
})

/** Merge a raw row config over the defaults and clamp numeric ranges. */
export function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => (value[key] === undefined ? DEFAULTS[key] : value[key])
  const clamp = (n, fallback, min, max) => {
    const number = Number(n)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }
  return {
    enabled: Boolean(pick('enabled')),
    host: String(pick('host') ?? '').trim(),
    workdir: String(pick('workdir') ?? '').trim(),
    pollSeconds: clamp(pick('pollSeconds'), DEFAULTS.pollSeconds, 15, 600),
    panelRefreshSeconds: clamp(pick('panelRefreshSeconds'), DEFAULTS.panelRefreshSeconds, 3, 60),
    historyHours: clamp(pick('historyHours'), DEFAULTS.historyHours, 1, 720),
    retentionDays: clamp(pick('retentionDays'), DEFAULTS.retentionDays, 1, 365),
    maxLogBytes: clamp(pick('maxLogBytes'), DEFAULTS.maxLogBytes, 1024, 1048576),
    logTailLines: clamp(pick('logTailLines'), DEFAULTS.logTailLines, 0, 500),
    followUpByDefault: Boolean(pick('followUpByDefault')),
    continuePrompt: String(pick('continuePrompt') ?? DEFAULT_CONTINUE_PROMPT),
    connectTimeoutMs: clamp(pick('connectTimeoutMs'), DEFAULTS.connectTimeoutMs, 1000, 120000),
    sshExtraArgs: Array.isArray(pick('sshExtraArgs'))
      ? pick('sshExtraArgs').filter((entry) => typeof entry === 'string')
      : [],
  }
}

/** `$DSH_HOME` with the same `~/.dsh` fallback the host uses. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** Short-lived directory holding OpenSSH control sockets. */
export function controlDir() {
  const digest = createHash('sha1').update(dshHome()).digest('hex').slice(0, 6)
  return path.join(os.tmpdir(), `dsh-cm-${digest}`)
}

/**
 * Read the dsh-ssh host store. A missing or malformed file reads as no hosts;
 * dsh-slurm only ever needs the connection fields, never credentials.
 * @param {string} [file] - explicit store path, for tests.
 * @returns {Array<object>} host records.
 */
export function readSshHosts(file = path.join(dshHome(), 'dsh-ssh.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const hosts = Array.isArray(parsed) ? parsed : parsed?.hosts
    return Array.isArray(hosts) ? hosts : []
  } catch {
    return []
  }
}

/** Split `user@host:port`; bracketed IPv6 literals are not supported. */
export function parseRawTarget(raw) {
  const at = raw.lastIndexOf('@')
  if (at <= 0) return undefined
  const user = raw.slice(0, at)
  let host = raw.slice(at + 1)
  let port = 22
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    port = Number(host.slice(colon + 1))
    host = host.slice(0, colon)
  }
  if (user === '' || host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { user, host, port }
}

/**
 * Turn a host reference into an OpenSSH target plus the options every call
 * shares. Known-host verification uses `accept-new` (trust on first use) so a
 * fresh cluster does not dead-end in BatchMode; the user can override via
 * `sshExtraArgs`.
 * @param {string} ref - alias from dsh-ssh.json or `user@host[:port]`.
 * @param {object} options - config fields that shape the connection.
 * @returns {{label: string, target: string, host: string, port: number, keyPath?: string, proxyJump: string[], options: string[]}}
 */
export function resolveHost(ref, options = {}) {
  const value = String(ref ?? '').trim()
  if (value === '') throw new Error('No Slurm host configured: set `host` to a dsh-ssh alias or user@host[:port].')

  const raw = parseRawTarget(value)
  if (raw !== undefined) {
    return decorate(value, { host: raw.host, port: raw.port, user: raw.user, keyPath: undefined, proxyJump: [] }, options)
  }

  const storePath = options.sshStorePath ?? path.join(dshHome(), 'dsh-ssh.json')
  const hosts = readSshHosts(storePath)
  const record = hosts.find((candidate) => candidate?.alias === value)
  if (record === undefined) {
    const available = hosts.map((candidate) => candidate?.alias).filter((alias) => typeof alias === 'string')
    const hint = available.length > 0 ? `; known aliases: ${available.join(', ')}` : ''
    throw new Error(`Unknown SSH host "${value}": configure it in dsh-ssh or use user@host[:port]${hint}.`)
  }
  if (typeof record.host !== 'string' || record.host === '') throw new Error(`SSH host "${value}" has no host address.`)
  const auth = record.auth ?? {}
  return decorate(value, {
    host: record.host,
    port: Number.isInteger(record.port) ? record.port : 22,
    user: typeof record.user === 'string' && record.user !== '' ? record.user : undefined,
    keyPath: typeof auth.keyPath === 'string' && auth.keyPath !== '' ? auth.keyPath : undefined,
    proxyJump: Array.isArray(record.proxyJump) ? record.proxyJump.filter((hop) => typeof hop === 'string') : [],
  }, options)
}

function decorate(label, parts, options) {
  const sshOptions = [
    'BatchMode=yes',
    `ConnectTimeout=${Math.max(1, Math.ceil(connectTimeoutOf(options) / 1000))}`,
    'ServerAliveInterval=20',
    'ServerAliveCountMax=2',
    'StrictHostKeyChecking=accept-new',
  ]
  const extraArgs = Array.isArray(options.sshExtraArgs)
    ? options.sshExtraArgs.filter((entry) => typeof entry === 'string')
    : []
  if (process.platform !== 'win32') {
    const identity = JSON.stringify({
      target: `${parts.user ?? ''}@${parts.host}:${parts.port}`,
      keyPath: parts.keyPath ?? '',
      proxyJump: parts.proxyJump,
      extraArgs,
    })
    const digest = createHash('sha1').update(identity).digest('hex').slice(0, 12)
    sshOptions.push(
      'ControlMaster=auto',
      `ControlPath=${path.join(controlDir(), digest)}`,
      'ControlPersist=120',
    )
  }
  return {
    label,
    target: parts.user === undefined ? parts.host : `${parts.user}@${parts.host}`,
    host: parts.host,
    port: parts.port,
    keyPath: parts.keyPath,
    proxyJump: parts.proxyJump,
    options: sshOptions,
    extraArgs,
  }
}

function connectTimeoutOf(options) {
  return Number.isFinite(Number(options.connectTimeoutMs)) ? Number(options.connectTimeoutMs) : DEFAULTS.connectTimeoutMs
}
