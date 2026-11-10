/**
 * Panel model for the right sidebar.
 *
 * The host does the merging, sorting and summary so the browser half only
 * renders. Everything here is pure: pass ledger jobs and one `squeue`
 * snapshot, get a payload that is easy to test.
 */

import { parseNodes, parseSections, parseSinfo, parseSqueue } from './slurm.js'

/** Seconds from `123`, `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS`. */
export function parseDuration(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = String(value).trim()
  if (/^\d+$/u.test(text)) return Number(text)
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text)
  if (match === null) return undefined
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

/** Slurm `--time`/`%l` values: a bare number is minutes, not seconds. */
export function parseTimeLimit(value) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim()
  if (/^\d+$/u.test(text)) return Number(text) * 60
  if (/^UNLIMITED$/iu.test(text)) return undefined
  const clock = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text)
  if (clock !== null) {
    const days = Number(clock[1] ?? 0)
    const hours = Number(clock[2] ?? 0)
    return days * 86400 + hours * 3600 + Number(clock[3]) * 60 + Number(clock[4])
  }
  const short = /^(\d+):(\d+)$/u.exec(text)
  if (short !== null) return Number(short[1]) * 60 + Number(short[2])
  return undefined
}

/** Turn one marker-framed status snapshot into panel cluster data. */
export function snapshotFromSections(text, { stale = false, error, truncated = false, timedOut = false, nodesRequired = false } = {}) {
  const sections = parseSections(text)
  const failures = []
  if (truncated) failures.push('output truncated')
  if (timedOut) failures.push('query timed out')
  for (const name of ['SINFO', 'QUEUE']) {
    if (sections[name] === undefined || sections[`${name}_EXIT`] === undefined) {
      failures.push(`${name} section incomplete`)
      continue
    }
    const exitText = String(sections[`${name}_EXIT`]).trim()
    if (!/^\d+$/u.test(exitText)) {
      failures.push(`${name} exit marker invalid`)
      continue
    }
    if (Number(exitText) !== 0) failures.push(`${name} exited ${exitText}`)
  }
  if (nodesRequired && sections.NODES === undefined) failures.push('NODES section incomplete')
  if (sections.NODES !== undefined) {
    const nodesExit = sections.NODES_EXIT
    if (nodesExit === undefined || !/^\d+$/u.test(String(nodesExit).trim())) failures.push('NODES exit marker invalid')
    else if (Number(nodesExit) !== 0) failures.push(`NODES exited ${nodesExit}`)
  }
  const reason = [error, ...failures].filter((part) => part !== undefined && part !== '').join('; ') || undefined
  return {
    partitions: parseSinfo(sections.SINFO ?? ''),
    queue: parseSqueue(sections.QUEUE ?? ''),
    nodes: parseNodes(sections.NODES ?? ''),
    stale: stale || failures.length > 0,
    ...(reason === undefined ? {} : { error: reason }),
  }
}

function ledgerRow(job) {
  return {
    id: String(job.id),
    name: job.name ?? '',
    state: job.lastState ?? (job.terminal === true ? 'TERMINAL' : 'PENDING'),
    terminal: job.terminal === true,
    tracked: true,
    notifiedAt: job.delivery?.notifiedAt,
    elapsedSec: parseDuration(job.elapsed),
    limitSec: parseTimeLimit(job.timeLimit),
    timeLeftSec: undefined,
    reason: job.reason ?? '',
    node: job.nodeList ?? '',
    submittedAt: job.submittedAt,
    finishedAt: job.terminalAt ?? job.delivery?.notifiedAt,
  }
}

function queueRow(row) {
  return {
    id: String(row.id),
    name: '',
    state: row.state,
    terminal: false,
    tracked: false,
    notifiedAt: undefined,
    elapsedSec: parseDuration(row.elapsed),
    limitSec: parseTimeLimit(row.timeLimit),
    timeLeftSec: parseDuration(row.timeLeft),
    reason: row.reason ?? '',
    node: row.nodelist ?? '',
    submittedAt: undefined,
    finishedAt: undefined,
  }
}

/**
 * Merge tracked jobs with the live queue into one row per job.
 * A tracked job keeps its terminal state; a live queue row wins for state,
 * elapsed and time limit while the job is active.
 */
export function mergePanelJobs({ ledger = [], queue = [], host }) {
  const rows = new Map()
  for (const job of ledger) {
    if (host !== undefined && job.host !== host) continue
    const row = ledgerRow(job)
    rows.set(String(row.id), row)
  }
  for (const queueRowValue of queue) {
    const row = queueRow(queueRowValue)
    const key = String(row.id)
    const parentKey = key.split('_')[0]
    const parent = rows.get(parentKey)
    if (parent?.tracked === true && parentKey !== key && !parent.terminal) {
      parent.tasks = (parent.tasks ?? 0) + 1
      parent.elapsedSec = Math.max(parent.elapsedSec ?? 0, row.elapsedSec ?? 0)
      parent.timeLeftSec = parent.timeLeftSec === undefined ? row.timeLeftSec : Math.min(parent.timeLeftSec, row.timeLeftSec ?? parent.timeLeftSec)
      parent.limitSec = parent.limitSec ?? row.limitSec
      if (parent._arraySeen !== true) { parent.state = row.state; parent._arraySeen = true }
      else if (row.state === 'RUNNING' || row.state === 'COMPLETING') parent.state = 'RUNNING'
      else if (row.state !== 'COMPLETED' && parent.state !== 'RUNNING') parent.state = row.state
      rows.delete(key)
      continue
    }
    const existing = rows.get(key)
    if (existing === undefined) {
      rows.set(key, row)
      continue
    }
    if (existing.terminal) continue
    existing.state = row.state
    existing.elapsedSec = row.elapsedSec ?? existing.elapsedSec
    existing.limitSec = row.limitSec ?? existing.limitSec
    existing.timeLeftSec = row.timeLeftSec
    existing.reason = row.reason
    existing.node = row.node || existing.node
  }
  return [...rows.values()]
}

/** Counts used by the header line. */
export function summarize(jobs) {
  let running = 0
  let pending = 0
  let completed = 0
  for (const job of jobs) {
    if (job.terminal) completed += 1
    else if (job.state === 'RUNNING' || job.state === 'COMPLETING') running += 1
    else pending += 1
  }
  return { running, pending, completed }
}

const ACTIVE_ORDER = { RUNNING: 0, COMPLETING: 1, CONFIGURING: 2, PENDING: 3 }

/** Running first, pending second, then by id descending. Terminal rows are excluded. */
export function sortActive(jobs) {
  return jobs
    .filter((job) => !job.terminal)
    .sort((a, b) => {
      const order = (ACTIVE_ORDER[a.state] ?? 9) - (ACTIVE_ORDER[b.state] ?? 9)
      return order !== 0 ? order : String(b.id).localeCompare(String(a.id), undefined, { numeric: true })
    })
}

/** Newest terminal jobs first. */
export function sortRecent(jobs, limit = 8) {
  return jobs
    .filter((job) => job.terminal)
    .sort((a, b) => String(b.finishedAt ?? b.submittedAt ?? '').localeCompare(String(a.finishedAt ?? a.submittedAt ?? '')))
    .slice(0, limit)
}

/** Host choices for the selector: dsh-ssh aliases plus the configured fallback. */
export function listHosts(hosts, configured, selected) {
  const rows = hosts
    .filter((host) => typeof host?.alias === 'string' && host.alias !== '')
    .map((host) => ({
      ref: host.alias,
      label: host.alias,
      detail: `${host.user ?? ''}@${host.host ?? ''}${host.port !== undefined && host.port !== 22 ? `:${host.port}` : ''}`.replace(/^@/u, ''),
    }))
  if (typeof configured === 'string' && configured !== '' && !rows.some((row) => row.ref === configured)) {
    rows.push({ ref: configured, label: configured, detail: 'plugin config' })
  }
  if (typeof selected === 'string' && selected !== '' && !rows.some((row) => row.ref === selected)) {
    rows.unshift({ ref: selected, label: selected, detail: 'selected' })
  }
  return rows
}

/**
 * Build the complete panel payload.
 * @param {object} input - selected host, host choices, ledger, snapshot, config.
 */
export function buildPanelPayload({
  host,
  hosts,
  ledger,
  snapshot,
  panelRefreshSeconds,
  otherHosts = 0,
  now = new Date(),
}) {
  const cluster = snapshot ?? { partitions: [], queue: [], nodes: [], stale: false }
  const all = mergePanelJobs({ ledger, queue: cluster.queue ?? [], host })
  const active = sortActive(all).slice(0, 50)
  const recent = sortRecent(all)
  return {
    ok: true,
    host,
    hosts,
    updatedAt: snapshot?.capturedAt ?? now.toISOString(),
    panelRefreshSeconds,
    summary: summarize(all),
    otherHosts,
    jobs: active,
    recent,
    cluster: {
      partitions: cluster.partitions ?? [],
      nodes: cluster.nodes ?? [],
    },
    stale: cluster.stale === true,
    ...(cluster.error === undefined ? {} : { error: cluster.error }),
  }
}
