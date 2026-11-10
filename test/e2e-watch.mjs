import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig, resolveHost } from '../src/config.js'
import { ensureRuntimeDirs, JobStore } from '../src/state.js'
import { runProcess, runSsh } from '../src/ssh.js'
import { SlurmWatcher } from '../src/watcher.js'
import { makeTools } from '../src/tools.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const HOST = process.env.DSH_SLURM_HOST
const WORKDIR = process.env.DSH_SLURM_WORKDIR ?? '/home'
const SSH_STORE = process.env.DSH_SSH_STORE ?? `${process.env.HOME}/.dsh/dsh-ssh.json`
if (!HOST) {
  console.error('Set DSH_SLURM_HOST before running this real-cluster probe; it submits a short CPU job.')
  process.exit(2)
}
ensureRuntimeDirs()
const root = path.dirname(new URL(import.meta.url).pathname)
const store = new JobStore('/tmp/dsh-slurm-e2e-jobs.json')
store.jobs = []
store.save()

fs.mkdirSync(path.join(root, 'e2e-output'), { recursive: true })
const cfg = normalizeConfig({ host: HOST, pollSeconds: 15, logTailLines: 20 })
const deliveries = []

const rt = {
  config: cfg,
  store,
  watcher: undefined,
  log: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) },
  home: () => process.env.DSH_HOME,
  mkdir(dir) { fs.mkdirSync(dir, { recursive: true }) },
  resolveHost(ref) { return resolveHost(ref, { sshStorePath: SSH_STORE }) },
  run(spec, command, options) { return runSsh(spec, command, options) },
  runLocal(file, args, options) { return runProcess(file, args, options) },
  async remoteHome() { return WORKDIR },
  sessionId() { return 'session-e2e' },
  sessionCwd() { return path.join(root, 'e2e-output') },
  async deliver(sessionId, text) {
    deliveries.push({ sessionId, text, at: new Date().toISOString() })
    return { messageId: `msg-${deliveries.length}` }
  },
}
const watcher = new SlurmWatcher(rt)
rt.watcher = watcher
const tools = Object.fromEntries(makeTools(rt).map((tool) => [tool.name, tool]))
const exec = { agent: { session: { id: 'session-e2e' } }, signal: undefined }

const stamp = Date.now().toString(36)
const jobName = `dsh-e2e-${stamp}`
const script = [
  '#!/bin/bash',
  `#SBATCH --job-name=${jobName}`,
  '#SBATCH --cpus-per-task=1',
  '#SBATCH --mem=1G',
  '#SBATCH --time=00:03:00',
  'echo "start $(date -Is)"',
  'sleep 12',
  'echo "SMOKE_DONE"',
  '',
].join('\n')

console.log('submitting', jobName)
const submitted = await tools.slurm_submit.execute({
  script,
  jobName,
  partition: 'gpu',
  cpus: 1,
  mem: '1G',
  time: '00:03:00',
  followUp: true,
  prompt: 'SMOKE: 报告作业状态并确认 SMOKE_DONE。',
}, exec)
console.log('submitted', submitted.jobId, submitted.logPath)
assert.equal(submitted.followUp, true)
assert.equal(submitted.dryRun, false)

let delivered
for (let attempt = 0; attempt < 40; attempt += 1) {
  await watcher.tick('manual')
  if (deliveries.length > 0) { delivered = deliveries[0]; break }
  await sleep(5000)
}
if (delivered === undefined) {
  const job = store.find(submitted.jobId)
  throw new Error(`no delivery after 200s; last state ${JSON.stringify(job?.lastState)} (${JSON.stringify(job?.lastSource)})`)
}
console.log('--- delivered message ---')
console.log(delivered.text)
assert.match(delivered.text, /\[SLURM JOB FINISHED\]/)
assert.match(delivered.text, /state: COMPLETED/)
assert.match(delivered.text, /SMOKE_DONE/)
assert.match(delivered.text, /SMOKE: 报告作业状态/)
assert.equal(deliveries.length, 1, 'exactly one delivery')
assert.match(delivered.sessionId, /session-e2e/)

const job = store.find(submitted.jobId)
assert.equal(job.terminal, true)
assert.ok(job.delivery.notifiedAt)

const logs = await tools.slurm_logs.execute({ jobId: submitted.jobId, lines: 10 }, exec)
console.log('--- log tail ---')
console.log(logs.text.trim())
assert.match(logs.text, /SMOKE_DONE/)

const remote = logs.path
const fetched = await tools.slurm_fetch.execute({ jobId: submitted.jobId, remotePath: remote }, exec)
console.log('fetch', fetched.localDir, fetched.method, fs.existsSync(fetched.localDir))
assert.ok(fs.existsSync(fetched.localDir))

console.log('\nE2E WATCH CHECK PASSED')
