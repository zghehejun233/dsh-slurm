/**
 * The seven model-facing tools. Each one is a thin, schema-validated layer
 * over the runtime assembled in `index.js`; the remote work lives in
 * `ssh.js` / `slurm.js`, the durable bookkeeping in `state.js`.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderJobs, renderLogs, renderStatus } from './render.js'
import {
  assertJobId,
  buildSbatchArgv,
  buildStatusCommand,
  parseHistory,
  parseNodes,
  assertLogTemplate,
  expandLogTemplate,
  parseSbatchJobId,
  parseSbatchResult,
  parseScontrolJob,
  parseSections,
  parseSinfo,
  parseSqueue,
  sanitizeName,
} from './slurm.js'
import { displayCommand, remoteCommand, shQuote } from './ssh.js'
import { assertRemotePath, finalizeFetch, prepareLocalTarget, sftpFetch } from './fetch.js'

const HOST_HELP = 'Host reference: an alias from dsh-ssh (~/.dsh/dsh-ssh.json) or user@host[:port]. Defaults to the cluster selected in the right sidebar, then the plugin config.'
const FOLLOW_UP_HELP = 'When true, register the job and start a new turn in this Chat when it reaches a terminal state.'

const QUEUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    state: { type: 'string', required: true },
    elapsed: { type: 'string' },
    timeLeft: { type: 'string' },
    nodelist: { type: 'string' },
    reason: { type: 'string' },
    timeLimit: { type: 'string' },
  },
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    host: { type: 'string', required: true },
    fetchedAt: { type: 'string', required: true },
    partitions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          partition: { type: 'string', required: true },
          avail: { type: 'string' },
          nodes: { type: 'integer' },
          state: { type: 'string' },
          gres: { type: 'string' },
        },
      },
    },
    queue: { type: 'array', required: true, items: QUEUE_SCHEMA },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string', required: true },
          allocatedCpus: { type: 'integer' },
          idleCpus: { type: 'integer' },
          totalCpus: { type: 'integer' },
          gres: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string' },
          state: { type: 'string' },
          exitCode: { type: 'string' },
          elapsedRaw: { type: 'integer' },
          end: { type: 'string' },
        },
      },
    },
    historyHours: { type: 'integer' },
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string' },
          state: { type: 'string' },
          exitCode: { type: 'string' },
          workDir: { type: 'string' },
          stdOut: { type: 'string' },
        },
      },
    },
    error: { type: 'string' },
  },
}

const SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobId: { type: 'string' },
    name: { type: 'string', required: true },
    host: { type: 'string', required: true },
    scriptPath: { type: 'string', required: true },
    logPath: { type: 'string' },
    followUp: { type: 'boolean', required: true },
    dryRun: { type: 'boolean', required: true },
    command: { type: 'string' },
    cluster: { type: 'string' },
    trackingError: { type: 'string' },
  },
}

const JOBS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobs: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string' },
          host: { type: 'string', required: true },
          state: { type: 'string' },
          terminal: { type: 'boolean' },
          submittedAt: { type: 'string' },
          notifiedAt: { type: 'string' },
          notifyFailedAt: { type: 'string' },
          sessionId: { type: 'string' },
          logPath: { type: 'string' },
          cluster: { type: 'string' },
          attempts: { type: 'integer' },
        },
      },
    },
  },
}

const LOGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobId: { type: 'string' },
    path: { type: 'string', required: true },
    text: { type: 'string', required: true },
    truncated: { type: 'boolean' },
  },
}

const CANCEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobId: { type: 'string', required: true },
    output: { type: 'string' },
  },
}

const WATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobId: { type: 'string', required: true },
    action: { type: 'string', required: true },
    removed: { type: 'integer' },
    state: { type: 'string' },
  },
}

const FETCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    jobId: { type: 'string' },
    remotePath: { type: 'string', required: true },
    localDir: { type: 'string', required: true },
    method: { type: 'string', required: true },
  },
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function hostOf(rt, args) {
  const value = String(args.host ?? rt.selectedHost?.() ?? rt.config.host ?? '').trim()
  if (value === '') throw new Error('No host given and the plugin config has no `host`.')
  return value
}

/**
 * Resolve the host a job operation should use. Explicit host wins; otherwise
 * a unique tracked host is used; an ambiguous id asks for `host`.
 */
function resolveJobTarget(rt, args, id) {
  const explicit = String(args.host ?? '').trim()
  const cluster = String(args.cluster ?? '').trim()
  const candidates = rt.store.list().filter((job) => String(job.id) === String(id)
    && (cluster === '' || (job.cluster ?? '') === cluster))
  if (explicit !== '') {
    return { host: explicit, job: candidates.find((job) => job.host === explicit) }
  }
  if (candidates.length > 1) {
    const hosts = candidates.map((job) => job.host).join(', ')
    throw new Error(`Job ${id} is tracked on multiple hosts (${hosts}); pass host.`)
  }
  if (candidates.length === 1) return { host: candidates[0].host, job: candidates[0] }
  const fallback = String(rt.selectedHost?.() ?? rt.config.host ?? '').trim()
  return { host: fallback, job: undefined }
}

const PROTOCOL_LONG = ['output', 'error', 'parsable', 'array', 'clusters', 'wait', 'quiet']
const PLUGIN_LONG = [...PROTOCOL_LONG, 'job-name', 'chdir', 'partition', 'gres', 'gpus', 'time', 'cpus-per-task', 'mem', 'dependency']
const LEGAL_LONG = ['gres-flags', 'mem-bind', 'mem-per-cpu', 'wait-all-nodes', 'gpu-bind', 'gpu-freq', 'ntasks-per-node', 'no-requeue', 'requeue', 'exclusive', 'oversubscribe', 'constraint', 'exclude', 'nodelist', 'export', 'open-mode', 'signal', 'comment', 'mail-type', 'mail-user', 'account', 'qos', 'reservation']
const PROTOCOL_SHORT = new Set(['o', 'e', 'a', 'M', 'W', 'Q'])
const VALUE_SHORT = new Set(['o', 'e', 'a', 'M', 'p', 't', 'c', 'J', 'D', 'A', 'C', 'n', 'N', 'w', 'x', 'q'])

function isProtocolArg(entry) {
  const text = String(entry).replace(/["']/gu, '')
  if (/^--[A-Za-z]/u.test(text)) {
    const name = text.slice(2).split('=')[0]
    return PROTOCOL_LONG.some((reserved) => reserved === name || reserved.startsWith(name))
  }
  if (/^-[A-Za-z]/u.test(text)) {
    for (const character of text.slice(1)) {
      if (PROTOCOL_SHORT.has(character)) return true
      if (VALUE_SHORT.has(character)) return false
    }
  }
  return false
}

/** Slurm accepts short options in clusters and long-option prefixes. */
function isReservedSbatchArg(entry) {
  if (isProtocolArg(entry)) return true
  const text = String(entry)
  if (!/^--[A-Za-z]/u.test(text)) return false
  const name = text.slice(2).split('=')[0]
  if (PLUGIN_LONG.includes(name)) return true
  return PLUGIN_LONG.some((reserved) => reserved.startsWith(name))
    && !LEGAL_LONG.some((legal) => legal.startsWith(name))
}

/** Validate model-supplied sbatch flags instead of silently dropping them. */
function extraSbatchArgs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('extraArgs must be an array of strings.')
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('extraArgs must contain only strings.')
    if (!/^--?[A-Za-z0-9][A-Za-z0-9_=.,:/%+&@#\[\]-]*$/u.test(entry)) {
      throw new Error(`Invalid sbatch argument: ${JSON.stringify(entry)}`)
    }
    if (isReservedSbatchArg(entry)) throw new Error(`extraArgs may not override the plugin's own option: ${entry}`)
    return entry
  })
}

/** Split one #SBATCH line, preserving quoted # and stopping at an unquoted comment. */
function directiveTokens(body) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  for (const character of String(body)) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\') { current += character; escaped = true; continue }
    if (quote !== null) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue }
    if (character === '#') break
    if (/\s/u.test(character)) {
      if (current !== '') { tokens.push(current); current = '' }
      continue
    }
    current += character
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Script directives that would break the plugin's assumed paths or protocol. */
function assertSupportedScript(script) {
  let directives = true
  for (const line of String(script).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#!')) continue
    if (!trimmed.startsWith('#')) { directives = false; continue }
    if (!directives) continue
    const match = /^#SBATCH\s*(.*)$/u.exec(trimmed)
    if (match === null) continue
    for (const raw of directiveTokens(match[1])) {
      const decoded = raw.replace(/\\(.)/gu, '$1')
      if (isProtocolArg(decoded)) throw new Error(`Unsupported #SBATCH directive in the script: ${raw}`)
    }
  }
}

function clusterPrefix(job) {
  return job?.cluster === undefined ? '' : `-M ${shQuote(job.cluster)} `
}

function errorText(result) {
  const parts = [result.stderr, result.stdout].map((part) => String(part ?? '').trim()).filter(Boolean)
  return parts.join('\n') || result.error || `ssh exited ${String(result.code)}`
}

/** `slurm_status` -------------------------------------------------------- */
function statusTool(rt) {
  return defineTool({
    name: 'slurm_status',
    description: `Inspect a Slurm cluster: partitions and their GRES/state, your queued and running jobs, optionally per-node CPU/GPU availability, recent accounting history, and details of specific job ids. Read-only. Use this instead of ssh_exec for queue questions. ${HOST_HELP}`,
    parameters: {
      host: { type: 'string', description: HOST_HELP },
      jobs: { type: 'array', items: { type: 'string' }, description: 'Job ids whose `scontrol show job` detail should be included.' },
      nodes: { type: 'boolean', description: 'Include per-node CPU/GPU availability (`sinfo -N`).' },
      historyHours: { type: 'integer', description: 'Accounting window in hours (default: plugin config, 24).' },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => text(renderStatus(value)),
    },
    async execute(args, exec) {
      const hostRef = hostOf(rt, args)
      const spec = rt.resolveHost(hostRef)
      const jobIds = (args.jobs ?? []).map(assertJobId)
      const jobClusters = {}
      for (const id of jobIds) {
        const tracked = rt.store.list().find((job) => job.id === id && job.host === hostRef && job.cluster !== undefined)
        if (tracked !== undefined) jobClusters[id] = tracked.cluster
      }
      const historyHours = args.historyHours ?? rt.config.historyHours
      const result = await rt.run(spec, buildStatusCommand({ historyHours, nodes: args.nodes === true, jobIds, jobClusters }), {
        timeoutMs: 30_000,
        signal: exec.signal,
      })
      const sections = parseSections(result.stdout)
      const jobs = []
      for (const line of (sections.JOBS ?? '').split('\n')) {
        const parsed = parseScontrolJob(line)
        if (parsed !== undefined) jobs.push(parsed)
      }
      const sectionErrors = []
      if (result.timedOut) sectionErrors.push('query timed out')
      if (result.truncated) sectionErrors.push('output truncated')
      for (const name of ['SINFO', 'QUEUE']) {
        if (sections[name] === undefined) sectionErrors.push(`${name} section incomplete`)
        else if (sections[`${name}_EXIT`] === undefined || !/^\d+$/u.test(String(sections[`${name}_EXIT`]).trim())) {
          sectionErrors.push(`${name} exit marker invalid`)
        } else if (Number(sections[`${name}_EXIT`]) !== 0) sectionErrors.push(`${name} exited ${sections[`${name}_EXIT`]}`)
      }
      if (args.nodes === true) {
        if (sections.NODES === undefined) sectionErrors.push('NODES section incomplete')
        else if (sections.NODES_EXIT === undefined || !/^\d+$/u.test(String(sections.NODES_EXIT).trim())) {
          sectionErrors.push('NODES exit marker invalid')
        } else if (Number(sections.NODES_EXIT) !== 0) sectionErrors.push(`NODES exited ${sections.NODES_EXIT}`)
      }
      const value = {
        ok: result.code !== 255 && sectionErrors.length === 0 && (sections.SINFO !== undefined || sections.QUEUE !== undefined),
        host: spec.label,
        fetchedAt: new Date().toISOString(),
        partitions: parseSinfo(sections.SINFO ?? ''),
        queue: parseSqueue(sections.QUEUE ?? ''),
        ...(args.nodes === true ? { nodes: parseNodes(sections.NODES ?? '') } : {}),
        ...(historyHours > 0
          ? {
              history: parseHistory(sections.HISTORY ?? '').map(({ id, name, state, exitCode, elapsedRaw, end }) => ({ id, name, state, exitCode, elapsedRaw, end })),
              historyHours,
            }
          : {}),
        ...(jobIds.length > 0
          ? { jobs: jobs.map(({ id, name, state, exitCode, workDir, stdOut }) => ({ id, name, state, exitCode, workDir, stdOut })) }
          : {}),
        ...(result.code === 255 || sectionErrors.length > 0
          ? { error: (sectionErrors.join('; ') || errorText(result)).slice(0, 2000) }
          : {}),
      }
      return value
    },
  })
}

/** `slurm_submit` -------------------------------------------------------- */
function submitTool(rt) {
  return defineTool({
    name: 'slurm_submit',
    description: `Write a batch script on a Slurm cluster and submit it with sbatch. Returns the job id. With followUp=true (default) the job is tracked and this Chat is woken with a new turn when the job finishes. Use dryRun=true to inspect the sbatch command without submitting. The script content is sent over stdin, never interpolated into a shell. ${HOST_HELP}`,
    parameters: {
      script: { type: 'string', required: true, description: 'Complete batch script, including its #SBATCH directives.' },
      filename: { type: 'string', description: 'Optional script basename (defaults from jobName and a timestamp).' },
      jobName: { type: 'string', description: 'Slurm job name; also used for the script and log names.' },
      host: { type: 'string', description: HOST_HELP },
      workdir: { type: 'string', description: 'Remote working directory for the script and logs (absolute or ~/...). Defaults to the plugin config, then $HOME.' },
      partition: { type: 'string', description: 'Slurm partition, e.g. gpu.' },
      cpus: { type: 'integer', description: 'CPUs per task (`--cpus-per-task`).' },
      gpus: { type: 'integer', description: 'GPUs (`--gres=gpu:N`). Omit for CPU-only jobs.' },
      mem: { type: 'string', description: 'Memory request, e.g. 16G.' },
      time: { type: 'string', description: 'Wall-clock limit, e.g. 00:30:00 or 1-00:00:00.' },
      logPath: { type: 'string', description: 'Remote stdout path template; `%j` expands to the job id. Defaults to <workdir>/.dsh-slurm/<name>-%j.out.' },
      dependency: { type: 'string', description: 'Slurm dependency, e.g. afterok:123 or singleton.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra sbatch arguments, one flag per entry (e.g. --gres=gpu:rtx5090:1).' },
      followUp: { type: 'boolean', description: FOLLOW_UP_HELP },
      prompt: { type: 'string', description: 'Instruction carried into the completion turn; defaults to the plugin continuePrompt.' },
      dryRun: { type: 'boolean', description: 'Build and return the command without writing or submitting anything.' },
    },
    output: {
      schema: SUBMIT_SCHEMA,
      render: (_args, value) => {
        if (value.dryRun) return text(`dry run · ${value.host}\n\n${value.command}\n\nscript: ${value.scriptPath}`)
        const tracking = value.trackingError === undefined ? '' : `\ntracking: FAILED — ${value.trackingError}`
        return text(`submitted job ${value.jobId} · ${value.host}\nscript: ${value.scriptPath}\nlog: ${value.logPath}\nfollow-up: ${value.followUp ? 'yes' : 'no'}${tracking}`)
      },
    },
    async execute(args, exec) {
      const script = String(args.script ?? '')
      if (script.trim() === '') throw new Error('slurm_submit requires a non-empty script.')
      if (script.length > 65_536) throw new Error('The batch script exceeds 64 KiB.')
      assertSupportedScript(script)
      const hostRef = hostOf(rt, args)
      const spec = rt.resolveHost(hostRef)
      const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-')
      const jobName = sanitizeName(args.jobName ?? `dsh-${stamp}`, `dsh-${stamp}`)
      const dryRun = args.dryRun === true
      const followUp = args.followUp ?? rt.config.followUpByDefault
      const sessionId = followUp ? rt.sessionId(exec) : undefined

      let workdir = String(args.workdir ?? rt.config.workdir ?? '').trim()
      if (workdir === '' || workdir === '~') workdir = await rt.remoteHome(spec)
      else if (workdir.startsWith('~/')) workdir = `${await rt.remoteHome(spec)}${workdir.slice(1)}`
      if (!workdir.startsWith('/')) throw new Error(`workdir must be absolute or ~/..., got "${workdir}".`)
      workdir = workdir.replace(/\/+$/u, '')

      const dir = `${workdir}/.dsh-slurm`
      const stem = sanitizeName(args.filename ?? jobName, jobName).slice(0, 40)
      const basename = `${stem}-${stamp}-${randomUUID().slice(0, 8)}`
      const scriptPath = `${dir}/${basename}.sbatch`
      let outputTemplate = String(args.logPath ?? `${dir}/${basename}-%j.out`)
      if (!outputTemplate.startsWith('/')) outputTemplate = `${workdir}/${outputTemplate.replace(/^\.\//u, '')}`
      assertLogTemplate(outputTemplate)
      const extraArgs = extraSbatchArgs(args.extraArgs)
      const argv = buildSbatchArgv({
        jobName,
        partition: args.partition,
        cpus: args.cpus,
        gpus: args.gpus,
        mem: args.mem,
        time: args.time,
        workdir,
        logPath: outputTemplate,
        dependency: args.dependency,
        extraArgs,
        scriptPath,
      })
      const command = displayCommand(argv)

      if (dryRun) {
        return {
          ok: true,
          name: jobName,
          host: spec.label,
          scriptPath,
          logPath: outputTemplate,
          followUp,
          dryRun: true,
          command,
        }
      }

      const upload = await rt.run(
        spec,
        `mkdir -p ${shQuote(dir)} && chmod 700 ${shQuote(dir)} && (set -C; umask 077; cat > ${shQuote(scriptPath)})`,
        { input: script, timeoutMs: 20_000, signal: exec.signal },
      )
      if (upload.code !== 0) throw new Error(`Could not write the batch script: ${errorText(upload)}`)

      const submitted = await rt.run(spec, command, { timeoutMs: 30_000, signal: exec.signal })
      if (submitted.code !== 0) throw new Error(`sbatch failed: ${errorText(submitted)}`)
      const parsed = parseSbatchResult(submitted.stdout)
      if (parsed === undefined) throw new Error(`sbatch did not return a job id: ${submitted.stdout.trim()}`)
      const jobId = parsed.id
      const logPath = expandLogTemplate(outputTemplate, { jobId, jobName })
      let trackingError
      const canTrack = followUp
      if (canTrack) {
        try {
          rt.store.upsert({
          id: jobId,
          host: hostRef,
          name: jobName,
          sessionId,
          submittedAt: new Date().toISOString(),
          partition: args.partition,
          cpus: args.cpus,
          gpus: args.gpus,
          workdir,
          timeLimit: args.time,
          scriptPath,
          outputTemplate,
          logPath,
          ...(parsed.cluster === undefined ? {} : { cluster: parsed.cluster }),
          prompt: args.prompt,
          terminal: false,
          lastState: 'SUBMITTED',
          delivery: { mode: 'continue', attempts: 0 },
          })
          rt.watcher?.kick('submit')
        } catch (error) {
          trackingError = error instanceof Error ? error.message : String(error)
          rt.log?.warn?.(`[dsh-slurm] job ${jobId} submitted but could not be tracked: ${trackingError}`)
        }
      }
      return {
        ok: true,
        jobId,
        name: jobName,
        host: spec.label,
        scriptPath,
        logPath,
        followUp: canTrack && trackingError === undefined,
        dryRun: false,
        command,
        ...(parsed.cluster === undefined ? {} : { cluster: parsed.cluster }),
        ...(trackingError === undefined ? {} : { trackingError }),
      }
    },
  })
}

/** `slurm_jobs` --------------------------------------------------------- */
function jobsTool(rt) {
  return defineTool({
    name: 'slurm_jobs',
    description: 'List jobs tracked by dsh-slurm with their last observed state, whether the completion turn was delivered, and the owning Chat. Use `all=true` to include already-notified jobs.',
    parameters: {
      all: { type: 'boolean', description: 'Include jobs that already delivered their completion turn.' },
    },
    output: {
      schema: JOBS_SCHEMA,
      render: (_args, value) => text(renderJobs(value.jobs, { all: true })),
    },
    async execute(args) {
      const jobs = rt.store.list()
        .filter((job) => args.all === true || job.terminal !== true || job.delivery?.notifiedAt === undefined)
        .slice(0, args.all === true ? 200 : 50)
        .map((job) => ({
          id: job.id,
          name: job.name,
          host: job.host,
          state: job.lastState ?? (job.terminal === true ? 'TERMINAL' : 'UNKNOWN'),
          terminal: job.terminal === true,
          submittedAt: job.submittedAt,
          ...(job.delivery?.notifiedAt === undefined ? {} : { notifiedAt: job.delivery.notifiedAt }),
          ...(job.notifyFailedAt === undefined ? {} : { notifyFailedAt: job.notifyFailedAt }),
          sessionId: job.sessionId,
          ...(job.logPath === undefined ? {} : { logPath: job.logPath }),
          ...(job.cluster === undefined ? {} : { cluster: job.cluster }),
          attempts: job.delivery?.attempts ?? 0,
        }))
      return { ok: true, jobs }
    },
  })
}

/** `slurm_logs` --------------------------------------------------------- */
function logsTool(rt) {
  return defineTool({
    name: 'slurm_logs',
    description: 'Show the tail of a remote job log (stdout by default). Resolves the path from the tracked job or from `scontrol show job` when only the job id is known; an explicit `path` wins.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'Slurm job id.' },
      kind: { type: 'string', enum: ['stdout', 'stderr'], description: 'Which stream to read when the path must be resolved (default stdout).' },
      lines: { type: 'integer', description: 'Number of trailing lines (default 80, max 500).' },
      path: { type: 'string', description: 'Explicit remote log path; overrides resolution.' },
      host: { type: 'string', description: HOST_HELP },
      cluster: { type: 'string', description: 'Slurm cluster name for a cluster-qualified job.' },
    },
    output: {
      schema: LOGS_SCHEMA,
      render: (_args, value) => text(renderLogs(value)),
    },
    async execute(args, exec) {
      const id = assertJobId(args.jobId)
      const target = resolveJobTarget(rt, args, id)
      if (target.host === '') throw new Error('No host given and the plugin config has no `host`.')
      const spec = rt.resolveHost(target.host)
      let logPath = args.path
      if (logPath === undefined || logPath === '') {
        if (args.kind === 'stderr' || target.job?.logPath === undefined) {
          const detail = await rt.run(spec, `scontrol show job ${clusterPrefix(target.job ?? { cluster: args.cluster })}-o ${id} 2>&1`, { timeoutMs: 15_000, signal: exec.signal })
          const parsed = parseScontrolJob(detail.stdout)
          logPath = args.kind === 'stderr' ? parsed?.stdErr : parsed?.stdOut
        } else {
          logPath = target.job.logPath
        }
      }
      if (logPath === undefined || logPath === '') throw new Error(`No ${args.kind ?? 'stdout'} path known for job ${id}.`)
      const lines = Math.min(500, Math.max(1, Number(args.lines ?? 80) || 80))
      const result = await rt.run(spec, `tail -n ${lines} -- ${shQuote(logPath)} 2>&1`, {
        timeoutMs: 20_000,
        maxBytes: rt.config.maxLogBytes,
        signal: exec.signal,
      })
      if (result.code !== 0) throw new Error(`Could not read ${logPath}: ${errorText(result)}`)
      return { ok: true, jobId: id, path: logPath, text: result.stdout, truncated: result.truncated }
    },
  })
}

/** `slurm_cancel` ------------------------------------------------------- */
function cancelTool(rt) {
  return defineTool({
    name: 'slurm_cancel',
    description: 'Cancel one Slurm job with scancel. This never resubmits or retries anything; the completion watcher will still report the CANCELLED state.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'Slurm job id to cancel.' },
      host: { type: 'string', description: HOST_HELP },
      cluster: { type: 'string', description: 'Slurm cluster name for a cluster-qualified job.' },
    },
    output: {
      schema: CANCEL_SCHEMA,
      render: (_args, value) => text(`cancelled ${value.jobId}\n${value.output ?? ''}`.trim()),
    },
    async execute(args, exec) {
      const id = assertJobId(args.jobId)
      const target = resolveJobTarget(rt, args, id)
      if (target.host === '') throw new Error('No host given and the plugin config has no `host`.')
      const spec = rt.resolveHost(target.host)
      const result = await rt.run(spec, `scancel ${clusterPrefix(target.job ?? { cluster: args.cluster })}${id} 2>&1`, { timeoutMs: 15_000, signal: exec.signal })
      if (result.code !== 0) throw new Error(`scancel failed: ${errorText(result)}`)
      const job = rt.store.find(id, target.host, target.job?.cluster)
      if (job !== undefined) {
        job.cancelRequestedAt = new Date().toISOString()
        rt.store.save()
      }
      return { ok: true, jobId: id, output: result.stdout.trim() }
    },
  })
}

/** `slurm_watch` -------------------------------------------------------- */
function watchTool(rt) {
  return defineTool({
    name: 'slurm_watch',
    description: 'Attach an already-submitted Slurm job to this Chat so its completion starts a new turn (action=attach), or stop tracking it (action=detach). Use this for jobs submitted outside slurm_submit, e.g. by a script or another tool.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'Slurm job id.' },
      action: { type: 'string', enum: ['attach', 'detach'], description: 'attach (default) or detach.' },
      prompt: { type: 'string', description: 'Instruction carried into the completion turn.' },
      logPath: { type: 'string', description: 'Remote log path; resolved from scontrol when omitted.' },
      host: { type: 'string', description: HOST_HELP },
      cluster: { type: 'string', description: 'Slurm cluster name for a cluster-qualified job.' },
    },
    output: {
      schema: WATCH_SCHEMA,
      render: (_args, value) => text(`${value.action} ${value.jobId}${value.state ? ` (${value.state})` : ''}${value.removed ? ` · removed ${value.removed}` : ''}`),
    },
    async execute(args, exec) {
      const id = assertJobId(args.jobId)
      const target = resolveJobTarget(rt, args, id)
      if (target.host === '') throw new Error('No host given and the plugin config has no `host`.')
      const hostRef = target.host
      const action = args.action ?? 'attach'
      if (action === 'detach') {
        const removed = rt.store.remove(id, hostRef)
        return { ok: true, jobId: id, action, removed }
      }
      const spec = rt.resolveHost(hostRef)
      const watchCluster = args.cluster ?? target.job?.cluster
      const detail = await rt.run(spec, `scontrol show job ${clusterPrefix({ cluster: watchCluster })}-o ${id} 2>&1`, { timeoutMs: 15_000, signal: exec.signal })
      const parsed = parseScontrolJob(detail.stdout)
      if (parsed === undefined) throw new Error(`Job ${id} not found on ${spec.label}: ${detail.stdout.trim().slice(0, 300)}`)
      const existing = target.job
      rt.store.upsert({
        ...existing,
        id,
        host: target.host,
        name: parsed.name,
        sessionId: rt.sessionId(exec),
        submittedAt: existing?.submittedAt ?? new Date().toISOString(),
        logPath: args.logPath ?? existing?.logPath ?? parsed.stdOut,
        workdir: parsed.workDir,
        timeLimit: parsed.timeLimit,
        ...(watchCluster === undefined ? {} : { cluster: watchCluster }),
        prompt: args.prompt ?? existing?.prompt,
        terminal: false,
        terminalAt: undefined,
        terminalNote: undefined,
        notifyFailedAt: undefined,
        misses: 0,
        lastState: parsed.state,
        lastCheckedAt: new Date().toISOString(),
        delivery: { mode: 'continue', attempts: 0 },
      })
      rt.watcher?.kick('watch')
      return { ok: true, jobId: id, action, state: parsed.state }
    },
  })
}

/** `slurm_fetch` -------------------------------------------------------- */
function fetchTool(rt) {
  return defineTool({
    name: 'slurm_fetch',
    description: 'Copy a file or directory from the cluster to this machine over SFTP. The local destination must be new and inside the session working directory or $DSH_HOME/slurm/results. Use this to collect checkpoints, result directories, or logs.',
    parameters: {
      remotePath: { type: 'string', required: true, description: 'Absolute remote path to copy.' },
      localDir: { type: 'string', description: 'New local destination directory (default <session cwd>/slurm-results/<host>-<jobId>).' },
      jobId: { type: 'string', description: 'Job id, used for the default destination and job lookup.' },
      host: { type: 'string', description: HOST_HELP },
    },
    output: {
      schema: FETCH_SCHEMA,
      render: (_args, value) => text(`fetched ${value.remotePath} → ${value.localDir} (${value.method})`),
    },
    async execute(args, exec) {
      const jobId = args.jobId === undefined ? undefined : assertJobId(args.jobId)
      const target = resolveJobTarget(rt, args, jobId)
      if (target.host === '') throw new Error('No host given and the plugin config has no `host`.')
      const spec = rt.resolveHost(target.host)
      const remotePath = assertRemotePath(args.remotePath)
      const cwd = rt.sessionCwd(exec)
      const resultsRoot = path.join(rt.home(), 'slurm', 'results')
      const label = `${sanitizeName(target.host, 'host')}-${jobId ?? 'fetch'}-${Date.now().toString(36)}`
      const requested = args.localDir ?? path.join(cwd, 'slurm-results', label)
      const prepared = prepareLocalTarget({ localDir: requested, cwd, resultsRoot })
      await sftpFetch(rt, spec, remotePath, prepared.staging, { signal: exec.signal })
      finalizeFetch(prepared.staging, prepared.target, prepared.roots)
      return { ok: true, ...(jobId === undefined ? {} : { jobId }), remotePath, localDir: prepared.target, method: 'sftp' }
    },
  })
}

export function makeTools(rt) {
  return [
    statusTool(rt),
    submitTool(rt),
    jobsTool(rt),
    logsTool(rt),
    cancelTool(rt),
    watchTool(rt),
    fetchTool(rt),
  ]
}

