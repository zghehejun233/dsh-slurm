/**
 * Slurm command construction and output parsing.
 *
 * All parsers are pure and deliberately tolerant: the remote shell merges
 * stderr into the captured sections, so a failed `sacct` shows up as text in
 * that section and must not break the rest of the snapshot.
 */

import { shQuote } from './ssh.js'

/** States that Slurm may leave in accounting but may also requeue later. */
export const REQUEUEABLE_STATES = new Set(['PREEMPTED', 'NODE_FAIL', 'SPECIAL_EXIT', 'REQUEUED'])

/** States after which a job will not run again without a new submission. */
export const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'OUT_OF_MEMORY',
  'BOOT_FAIL',
  'DEADLINE',
  'REVOKED',
])

/** Uppercase, strip `+`/` by <user>` decorations, and keep the base state. */
export function normalizeState(raw) {
  let value = String(raw ?? '').trim().toUpperCase()
  if (value === '') return 'UNKNOWN'
  value = value.replace(/\+$/u, '')
  const by = value.indexOf(' BY ')
  if (by > 0) value = value.slice(0, by)
  value = value.replace(/\s+/gu, '_')
  if (value.startsWith('CANCELLED')) return 'CANCELLED'
  return value
}

export function isTerminal(state) {
  return TERMINAL_STATES.has(normalizeState(state))
}

/** Validate a Slurm job id (plain or array-task form) before it reaches a command. */
export function assertJobId(value) {
  const id = String(value ?? '').trim()
  if (!/^\d+(?:_\d+)?$/u.test(id)) throw new Error(`Invalid Slurm job id "${id}".`)
  return id
}

/** Keep a job name safe for a remote path component. */
export function sanitizeName(value, fallback = 'job') {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[._]+/u, '')
  return (cleaned === '' ? fallback : cleaned).slice(0, 64)
}

/** `--parsable` prints `<id>` or `<id>;<cluster>`. */
export function parseSbatchResult(stdout) {
  const lines = String(stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^(\d+)(?:;([^;]*))?$/u.exec(lines[index])
    if (match !== null) return { id: match[1], ...(match[2] === undefined || match[2] === '' ? {} : { cluster: match[2] }) }
  }
  return undefined
}

/** Backward-compatible id-only form. */
export function parseSbatchJobId(stdout) {
  return parseSbatchResult(stdout)?.id
}

/** Only `%j`, `%x`, `%A` and `%%` are expanded; array task `%a` is rejected. */
export function assertLogTemplate(template) {
  const text = String(template ?? '')
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '%') continue
    const next = text[index + 1]
    if (next === '%') { index += 1; continue }
    if (next === undefined || !['j', 'x', 'A'].includes(next)) {
      throw new Error(`Unsupported log path specifier %${next ?? ''}; use %j, %x, %A or %%.`)
    }
    index += 1
  }
  return text
}

/** Expand the supported Slurm output specifiers for one submitted job. */
export function expandLogTemplate(template, { jobId, jobName }) {
  return String(template).replace(/%(.)/gu, (whole, specifier) => {
    if (specifier === '%') return '%'
    if (specifier === 'j') return jobId
    if (specifier === 'x') return jobName
    if (specifier === 'A') return String(jobId).split('_')[0]
    return whole
  })
}

/** Build the remote argv for one `sbatch` submission. */
export function buildSbatchArgv(job) {
  const argv = ['sbatch', '--parsable']
  if (job.jobName) argv.push(`--job-name=${job.jobName}`)
  if (job.partition) argv.push(`--partition=${job.partition}`)
  if (job.cpus) argv.push(`--cpus-per-task=${job.cpus}`)
  if (job.gpus) argv.push(`--gres=gpu:${job.gpus}`)
  if (job.mem) argv.push(`--mem=${job.mem}`)
  if (job.time) argv.push(`--time=${job.time}`)
  if (job.workdir) argv.push(`--chdir=${job.workdir}`)
  if (job.logPath) argv.push(`--output=${job.logPath}`)
  if (job.dependency) argv.push(`--dependency=${job.dependency}`)
  for (const extra of job.extraArgs ?? []) argv.push(extra)
  argv.push(job.scriptPath)
  return argv
}

/** One remote snapshot command; section markers survive stderr merging. */
export function buildStatusCommand({ historyHours, nodes, jobIds, jobClusters = {} }) {
  const sections = [
    ['SINFO', 'sinfo -h -o "%P|%a|%D|%t|%G"'],
    ['QUEUE', 'squeue -h -r -u "$(id -un)" -o "%i|%T|%M|%L|%N|%r|%l"'],
  ]
  if (nodes) sections.push(['NODES', 'sinfo -N -h -o "%N|%C|%G|%t"'])
  if (historyHours) {
    const hours = Math.max(1, Math.trunc(Number(historyHours) || 1))
    sections.push(['HISTORY', `sacct -X -P -n -u "$(id -un)" --starttime now-${hours}hour --format=JobID,JobName%30,State,ExitCode,ElapsedRaw,End,AllocTRES`])
  }
  if (Array.isArray(jobIds) && jobIds.length > 0) {
    const ids = jobIds.map(assertJobId)
    const commands = ids.map((id) => {
      const cluster = jobClusters[id]
      const flag = typeof cluster === 'string' && cluster !== '' ? `-M ${shQuote(cluster)} ` : ''
      return `scontrol show job ${flag}-o ${id} 2>&1`
    })
    sections.push(['JOBS', commands.join('; ')])
  }
  const parts = []
  for (const [name, command] of sections) {
    parts.push(`echo __${name}__`, `${command} 2>&1`, `echo __${name}_EXIT__$?`)
  }
  return `${parts.join('; ')}; true`
}

/** Split a marker-framed snapshot into named sections. */
export function parseSections(text) {
  const sections = Object.create(null)
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const marker = /^__([A-Z][A-Z0-9_]*)__(.*)$/u.exec(line.trim())
    if (marker !== null) {
      current = marker[1]
      if (marker[2] !== '') sections[current] = marker[2]
      else sections[current] ??= []
      continue
    }
    if (current !== null && Array.isArray(sections[current])) sections[current].push(line)
  }
  for (const key of Object.keys(sections)) if (Array.isArray(sections[key])) sections[key] = sections[key].join('\n')
  return sections
}

/** Parse `sinfo -h -o "%P|%a|%D|%t|%G"`. */
export function parseSinfo(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('PARTITION|')) continue
    const fields = trimmed.split('|')
    if (fields.length < 4) continue
    rows.push({
      partition: fields[0].replace(/\*+$/u, ''),
      avail: fields[1] ?? '',
      nodes: Number(fields[2]) || 0,
      state: fields[3] ?? '',
      gres: fields[4] === undefined || fields[4] === '(null)' ? '' : fields[4],
    })
  }
  return rows
}

/** Parse `sinfo -N -h -o "%N|%C|%G|%t"`. */
export function parseNodes(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('NODELIST|')) continue
    const fields = trimmed.split('|')
    if (fields.length < 4) continue
    const cpu = /^(\d+)\/(\d+)\/(\d+)\/(\d+)$/u.exec(fields[1] ?? '')
    rows.push({
      node: fields[0],
      allocatedCpus: cpu === null ? 0 : Number(cpu[1]),
      idleCpus: cpu === null ? 0 : Number(cpu[2]),
      totalCpus: cpu === null ? 0 : Number(cpu[4]),
      gres: fields[2] === '(null)' ? '' : fields[2],
      state: fields[3] ?? '',
    })
  }
  return rows
}

/** Parse `squeue -h -o "%i|%T|%M|%L|%N|%r"`. */
export function parseSqueue(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('JOBID|')) continue
    const fields = trimmed.split('|')
    if (fields.length < 5) continue
    rows.push({
      id: fields[0],
      state: normalizeState(fields[1]),
      elapsed: fields[2] ?? '',
      timeLeft: fields[3] ?? '',
      nodelist: fields[4] ?? '',
      reason: fields[5] ?? '',
      timeLimit: fields[6] ?? '',
    })
  }
  return rows
}

/** Parse `sacct -X -P -n --format=JobID,State,ExitCode,ElapsedRaw,End`. */
export function parseSacct(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('JobID|') || trimmed.startsWith('---')) continue
    const fields = trimmed.split('|')
    if (fields.length < 4) continue
    const id = fields[0]
    if (!/^\d+(?:_\d+)?$/u.test(id)) continue
    rows.push({
      id,
      state: normalizeState(fields[1]),
      exitCode: fields[2] ?? '',
      elapsedRaw: Number(fields[3]) || 0,
      end: fields[4] ?? '',
    })
  }
  return rows
}

/** Parse `sacct -X -P --format=JobID,JobName%30,State,ExitCode,ElapsedRaw,End,AllocTRES`. */
export function parseHistory(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('JobID|') || trimmed.startsWith('---')) continue
    const fields = trimmed.split('|')
    if (fields.length < 6) continue
    if (!/^\d+(?:_\d+)?$/u.test(fields[0])) continue
    rows.push({
      id: fields[0],
      name: fields[1] ?? '',
      state: normalizeState(fields[2]),
      exitCode: fields[3] ?? '',
      elapsedRaw: Number(fields[4]) || 0,
      end: fields[5] ?? '',
      allocTRES: fields[6] ?? '',
    })
  }
  return rows
}

/** Parse one `scontrol show job -o` line. */
export function parseScontrolJob(text) {
  const source = String(text ?? '')
  const start = source.indexOf('JobId=')
  if (start < 0) return undefined
  const line = source.slice(start).split('\n')[0]
  const fields = Object.create(null)
  const pattern = /(?:^|\s)([A-Za-z][A-Za-z0-9]*)=(.*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/gu
  let match
  while ((match = pattern.exec(line)) !== null) {
    fields[match[1]] = match[2].replace(/^"|"$/gu, '')
  }
  if (fields.JobId === undefined) return undefined
  return {
    id: fields.JobId,
    name: fields.JobName ?? '',
    state: normalizeState(fields.JobState),
    exitCode: fields.ExitCode ?? '',
    workDir: fields.WorkDir ?? '',
    stdOut: fields.StdOut ?? '',
    stdErr: fields.StdErr ?? '',
    runTime: fields.RunTime ?? '',
    nodeList: fields.NodeList ?? '',
    partition: fields.Partition ?? '',
    timeLimit: fields.TimeLimit ?? '',
  }
}

/** Base id for an array task (`123_4` -> `123`). */
export function baseJobId(id) {
  return String(id ?? '').split('_')[0]
}

/**
 * Combine queue and accounting observations for the tracked ids.
 * @returns {Map<string, {state: string, terminal: boolean, exitCode: string, elapsed: string, nodelist: string, reason: string, source: string}>}
 */
export function mergeJobStates(queueRows, sacctRows, ids) {
  const result = new Map()
  for (const raw of ids) {
    const id = String(raw)
    const matches = (row) => String(row.id) === id || (/^\d+$/u.test(id) && String(row.id).startsWith(`${id}_`))
    const queued = queueRows.filter(matches)
    const accounted = sacctRows.filter(matches)
    if (queued.length > 0) {
      const active = queued.find((row) => !isTerminal(row.state))
      const aggregate = aggregateAccounting(accounted)
      const row = active ?? queued[0]
      result.set(id, {
        state: active === undefined && accounted.length > 0 ? aggregate.state : row.state,
        terminal: active === undefined && accounted.length > 0 && aggregate.terminal && !aggregate.requeueable,
        requeueable: active === undefined && aggregate.requeueable,
        exitCode: aggregate.exitCode,
        elapsed: active === undefined && accounted.length > 0 ? String(aggregate.elapsed) : row.elapsed,
        nodelist: row.nodelist,
        reason: row.reason,
        source: 'squeue',
        tasks: queued.length,
      })
      continue
    }
    if (accounted.length > 0) {
      const aggregate = aggregateAccounting(accounted)
      result.set(id, {
        state: aggregate.state,
        terminal: aggregate.terminal && !aggregate.requeueable,
        requeueable: aggregate.requeueable,
        exitCode: aggregate.exitCode,
        elapsed: aggregate.elapsed > 0 ? String(aggregate.elapsed) : '',
        nodelist: '',
        reason: '',
        source: 'sacct',
        tasks: accounted.length,
      })
      continue
    }
    result.set(id, { state: 'UNKNOWN', terminal: false, exitCode: '', elapsed: '', nodelist: '', reason: '', source: 'none', tasks: 0 })
  }
  return result
}

function aggregateAccounting(rows) {
  if (rows.length === 0) return { state: 'UNKNOWN', terminal: false, exitCode: '', elapsed: 0 }
  const terminal = rows.every((row) => isTerminal(row.state))
  const failed = rows.find((row) => row.state !== 'COMPLETED' && isTerminal(row.state))
  const pending = rows.find((row) => !isTerminal(row.state))
  return {
    state: failed?.state ?? pending?.state ?? 'COMPLETED',
    terminal,
    requeueable: rows.some((row) => REQUEUEABLE_STATES.has(row.state))
      && rows.every((row) => isTerminal(row.state) || REQUEUEABLE_STATES.has(row.state)),
    exitCode: failed?.exitCode ?? rows[0].exitCode ?? '',
    elapsed: rows.reduce((total, row) => total + (Number(row.elapsedRaw) || 0), 0),
  }
}

/** Remote command that observes both squeue and sacct for the given ids. */
export function buildWatchCommand(ids, { cluster } = {}) {
  const list = ids.map(assertJobId)
  const clusterFlag = typeof cluster === 'string' && cluster !== '' ? `-M ${shQuote(cluster)} ` : ''
  return [
    'echo __QUEUE__',
    `squeue -h -r ${clusterFlag}-j ${list.join(',')} -o "%i|%T|%M|%L|%N|%r|%l" 2>&1`,
    'echo __QUEUE_EXIT__$?',
    'echo __SACCT__',
    `sacct -X -P -n ${clusterFlag}-j ${list.join(',')} --format=JobID,State,ExitCode,ElapsedRaw,End 2>&1`,
    'echo __SACCT_EXIT__$?',
    'true',
  ].join('; ')
}
