import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
import { resolveHost } from '../src/config.js'
import { ensureRuntimeDirs, JobStore } from '../src/state.js'
import { runProcess, runSsh } from '../src/ssh.js'
import { makeTools } from '../src/tools.js'

const HOST = process.env.DSH_SLURM_HOST
const WORKDIR = process.env.DSH_SLURM_WORKDIR ?? '/home'
const SSH_STORE = process.env.DSH_SSH_STORE ?? `${process.env.HOME}/.dsh/dsh-ssh.json`
if (!HOST) {
  console.error('Set DSH_SLURM_HOST (a dsh-ssh alias or user@host) before running this real-cluster probe.')
  process.exit(2)
}
ensureRuntimeDirs()
const store = new JobStore('/tmp/dsh-slurm-manual-jobs.json')
store.jobs = []
const cfg = normalizeConfig({ host: HOST, historyHours: 1, pollSeconds: 60 })

const rt = {
  config: cfg,
  store,
  watcher: { kick() {} },
  log: { info() {}, warn() {}, error() {} },
  home: () => process.env.DSH_HOME,
  mkdir() {},
  resolveHost(ref) { return resolveHost(ref, { sshStorePath: SSH_STORE }) },
  run(spec, command, options) { return runSsh(spec, command, options) },
  runLocal(file, args, options) { return runProcess(file, args, options) },
  async remoteHome(spec) { return WORKDIR },
  sessionId() { return 'session-test' },
  sessionCwd() { return process.cwd() },
  async deliver() { throw new Error('delivery not expected in this probe') },
}

const tools = makeTools(rt)
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
const exec = { agent: { session: { id: 'session-test' } }, signal: undefined }
const line = (name) => console.log('---', name, '---')

line('registry')
console.log(tools.map((tool) => tool.name).join(', '))

line('slurm_status')
const status = await byName.slurm_status.execute({ nodes: true, historyHours: 1 }, exec)
assert.equal(status.ok, true)
assert.ok(Array.isArray(status.partitions))
assert.ok(Array.isArray(status.queue))
const statusContent = byName.slurm_status.output.render({}, status)
assert.ok(Array.isArray(statusContent), 'status render must return content blocks')
console.log(statusContent[0].text.split('\n').slice(0, 12).join('\n'))

line('slurm_jobs')
const jobs = await byName.slurm_jobs.execute({ all: true }, exec)
assert.ok(Array.isArray(byName.slurm_jobs.output.render({}, jobs)))

line('slurm_submit dryRun')
const dry = await byName.slurm_submit.execute({
  script: '#!/bin/bash\n#SBATCH --job-name=dsh-probe\nsleep 2\necho PROBE_DONE\n',
  jobName: 'dsh-probe',
  partition: 'gpu',
  cpus: 1,
  mem: '1G',
  time: '00:02:00',
  dryRun: true,
}, exec)
assert.equal(dry.dryRun, true)
assert.ok(dry.command.startsWith('sbatch'))
assert.ok(Array.isArray(byName.slurm_submit.output.render({}, dry)))
console.log(dry.command)

line('slurm_logs (bad path)')
await assert.rejects(
  () => byName.slurm_logs.execute({ jobId: '999999', path: `${WORKDIR}/.dsh-slurm-missing.log`, lines: 5 }, exec),
  /Could not read/,
)

line('slurm_watch detach')
const detach = await byName.slurm_watch.execute({ jobId: '999999', action: 'detach' }, exec)
assert.equal(detach.action, 'detach')
assert.ok(Array.isArray(byName.slurm_watch.output.render({}, detach)))

line('slurm_fetch path guard')
await assert.rejects(
  () => byName.slurm_fetch.execute({ remotePath: `${WORKDIR}/x`, localDir: '/etc/passwd' }, exec),
  /Refusing to write outside|already exists/,
)

line('slurm_cancel rejects bad id')
await assert.rejects(() => byName.slurm_cancel.execute({ jobId: '1; rm -rf /' }, exec), /Invalid Slurm job id/)

console.log('\nALL MANUAL TOOL CHECKS PASSED')
