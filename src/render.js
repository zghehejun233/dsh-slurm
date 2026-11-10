/**
 * Model-facing Markdown rendering. Tool schemas carry the structured value;
 * these functions produce the compact text the agent actually reads.
 */

function cell(value) {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\n+/gu, ' ').trim()
}

export function mdTable(headers, rows, { limit = 40 } = {}) {
  if (rows.length === 0) return '_none_'
  const shown = rows.slice(0, limit)
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...shown.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ]
  if (rows.length > shown.length) lines.push(`_… ${rows.length - shown.length} more row(s)_`)
  return lines.join('\n')
}

/** Human duration from seconds. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.trunc(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, '0')}s`
  return `${secs}s`
}

/** Keep the last `count` lines of a text. */
export function tailLines(text, count) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  if (count <= 0) return ''
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

/** Replace `{name}` placeholders without treating braces in values as syntax. */
export function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (whole, key) =>
    values[key] === undefined ? whole : String(values[key]))
}

export function renderStatus(snapshot) {
  const parts = [`# Slurm status · ${snapshot.host}`]
  if (snapshot.error) parts.push(`error: ${snapshot.error}`)
  parts.push('', '## Partitions', mdTable(
    ['Partition', 'Avail', 'Nodes', 'State', 'GRES'],
    snapshot.partitions.map((row) => [row.partition, row.avail, row.nodes, row.state, row.gres || '-']),
  ))
  parts.push('', '## My queue', mdTable(
    ['Job', 'State', 'Elapsed', 'Time left', 'Node', 'Reason'],
    snapshot.queue.map((row) => [row.id, row.state, row.elapsed, row.timeLeft, row.nodelist || '-', row.reason || '-']),
  ))
  if (Array.isArray(snapshot.nodes)) {
    parts.push('', '## Nodes', mdTable(
      ['Node', 'CPU (alloc/idle/total)', 'GRES', 'State'],
      snapshot.nodes.map((row) => [row.node, `${row.allocatedCpus}/${row.idleCpus}/${row.totalCpus}`, row.gres || '-', row.state]),
    ))
  }
  if (Array.isArray(snapshot.history)) {
    parts.push('', `## History (last ${snapshot.historyHours}h)`, mdTable(
      ['Job', 'Name', 'State', 'Exit', 'Elapsed(s)', 'End'],
      snapshot.history.map((row) => [row.id, row.name ?? '', row.state, row.exitCode, row.elapsedRaw, row.end]),
    ))
  }
  if (Array.isArray(snapshot.jobs) && snapshot.jobs.length > 0) {
    parts.push('', '## Requested jobs', mdTable(
      ['Job', 'Name', 'State', 'Exit', 'WorkDir', 'StdOut'],
      snapshot.jobs.map((row) => [row.id, row.name, row.state, row.exitCode, row.workDir, row.stdOut]),
    ))
  }
  parts.push('', `_fetched ${snapshot.fetchedAt}_`)
  return parts.join('\n')
}

export function renderJobs(jobs, { all = false } = {}) {
  const rows = (all ? jobs : jobs.filter((job) => job.terminal !== true || job.delivery?.notifiedAt === undefined))
    .slice()
    .sort((a, b) => String(a.submittedAt ?? '').localeCompare(String(b.submittedAt ?? '')))
  if (rows.length === 0) return '_no tracked jobs_'
  const hasCluster = rows.some((job) => job.cluster !== undefined)
  return mdTable(
    ['Job', 'Name', 'Host', ...(hasCluster ? ['Cluster'] : []), 'State', 'Submitted', 'Notified', 'Session'],
    rows.map((job) => [
      job.id,
      job.name ?? '',
      job.host,
      ...(hasCluster ? [job.cluster ?? '-'] : []),
      job.lastState ?? job.state ?? (job.terminal ? 'TERMINAL' : 'PENDING'),
      job.submittedAt ?? '',
      job.delivery?.notifiedAt ?? job.notifiedAt ?? (job.notifyFailedAt ? `failed ${job.notifyFailedAt}` : '-'),
      job.sessionId ?? '-',
    ]),
  )
}

export function renderLogs({ jobId, path, text, truncated }) {
  return [
    `# Log · job ${jobId}`,
    `path: ${path}`,
    truncated ? '_truncated to the configured byte limit_' : '',
    '',
    '```',
    text,
    '```',
  ].filter((line) => line !== '').join('\n')
}
