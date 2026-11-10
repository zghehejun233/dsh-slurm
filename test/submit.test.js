import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { makeTools } from '../src/tools.js'

function makeRt(overrides = {}) {
  const calls = []
  const upserts = []
  const rt = {
    config: normalizeConfig({ host: 'demo', followUpByDefault: true }),
    store: {
      list: () => [],
      find: () => undefined,
      upsert(job) { upserts.push(job) },
      save() {},
    },
    selectedHost: () => 'demo',
    resolveHost: () => ({ label: 'demo', target: 'u@h', options: [], extraArgs: [], port: 22 }),
    run: async (_spec, command) => {
      calls.push(command)
      return { code: 0, stdout: command.startsWith('sbatch') ? '123\n' : '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
    sessionId: () => 's',
    sessionCwd: () => '/tmp',
    remoteHome: async () => '/home/u',
    watcher: { kick() {} },
    log: { warn() {} },
    ...overrides,
  }
  return { rt, calls, upserts, tools: Object.fromEntries(makeTools(rt).map((tool) => [tool.name, tool])) }
}

const exec = { agent: { session: { id: 's' } }, signal: undefined }
const script = '#!/bin/bash\n#SBATCH --job-name=x\necho hi\n'

test('submit dry-run creates a unique script path and keeps the template', async () => {
  const { tools } = makeRt()
  const first = await tools.slurm_submit.execute({ script, jobName: 'x'.repeat(64), workdir: '/home/u', dryRun: true, followUp: false }, exec)
  const second = await tools.slurm_submit.execute({ script, jobName: 'x'.repeat(64), workdir: '/home/u', dryRun: true, followUp: false }, exec)
  assert.notEqual(first.scriptPath, second.scriptPath)
  assert.match(first.logPath, /%j/)
  assert.equal(first.dryRun, true)
})

test('submit rejects reserved and malformed extraArgs instead of dropping them', async () => {
  const { tools } = makeRt()
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['--output=/tmp/x'], followUp: false }, exec), /may not override/)
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['--bad arg'], followUp: false }, exec), /Invalid sbatch argument/)
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['--clusters=other'], followUp: false }, exec), /may not override/)
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['-M', 'other'], followUp: false }, exec), /may not override/)
  for (const flag of ['-o/tmp/other.out', '-a1-5', '-Mother', '--out=other', '--wai', '-va1-5', '--part=gpu']) {
    await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: [flag], followUp: false }, exec), /may not override/, flag)
  }
})

test('submit accepts a legal ampersand flag and rejects array log templates', async () => {
  const { tools } = makeRt()
  const value = await tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['--constraint=a100&nvlink'], followUp: false }, exec)
  assert.match(value.command, /--constraint=a100&nvlink/)
  const legal = await tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, extraArgs: ['--gres-flags=enforce-binding', '--mem-bind=local', '--wait-all-nodes=1', '-Ateam', '-CMaxwell', '-Cgpu'], followUp: false }, exec)
  assert.match(legal.command, /--gres-flags=enforce-binding/)
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, logPath: '/tmp/x-%a.out', followUp: false }, exec), /Unsupported log path specifier/)
  const percent = await tools.slurm_submit.execute({ script, workdir: '/home/u', dryRun: true, logPath: '/tmp/x-%%', followUp: false }, exec)
  assert.match(percent.logPath, /%%/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --array=1-5\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --output=/tmp/x\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --clusters=other\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH -M other\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
})

test('a submitted job whose ledger write fails still reports the job id', async () => {
  const { rt, tools } = makeRt()
  rt.store.upsert = () => { throw new Error('disk full') }
  const value = await tools.slurm_submit.execute({ script, jobName: 'run', workdir: '/home/u', followUp: true }, exec)
  assert.equal(value.ok, true)
  assert.equal(value.jobId, '123')
  assert.match(value.trackingError, /disk full/)
})

test('session validation happens before sbatch', async () => {
  let ran = 0
  const { tools } = makeRt({
    run: async () => { ran += 1; return { code: 0, stdout: '123\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 } },
    sessionId: () => { throw new Error('no session') },
  })
  await assert.rejects(() => tools.slurm_submit.execute({ script, workdir: '/home/u', followUp: true }, exec), /no session/)
  assert.equal(ran, 0)
})


test('a cluster-qualified parsable id is returned, not turned into a failure', async () => {
  const { tools } = makeRt({
    run: async (_spec, command) => ({
      code: 0,
      stdout: command.startsWith('sbatch') ? '123;cluster-a\n' : '',
      stderr: '', timedOut: false, truncated: false, durationMs: 1,
    }),
  })
  const value = await tools.slurm_submit.execute({ script, workdir: '/home/u', followUp: true }, exec)
  assert.equal(value.ok, true)
  assert.equal(value.jobId, '123')
  assert.equal(value.followUp, true)
  assert.equal(value.cluster, 'cluster-a')
  assert.equal(value.trackingError, undefined)
})


test('legal independent options and comments after the first executable line pass', async () => {
  const { tools } = makeRt()
  const legal = [
    '#!/bin/bash',
    '#SBATCH --gres-flags=enforce-binding',
    '#SBATCH --mem-bind=local',
    '#SBATCH --wait-all-nodes=1',
    'echo start',
    '#SBATCH --array=1-5',
    '',
  ].join('\n')
  const value = await tools.slurm_submit.execute({ script: legal, workdir: '/home/u', dryRun: true, followUp: false }, exec)
  assert.equal(value.dryRun, true)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH "--array"=1-5\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --ar"ray"=1-5\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  const comment = await tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --constraint=gpu # --array=1-5\n', workdir: '/home/u', dryRun: true, followUp: false }, exec)
  assert.equal(comment.dryRun, true)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --comment="#" --array=1-5\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  await assert.rejects(() => tools.slurm_submit.execute({ script: '#!/bin/bash\n#SBATCH --comment="#" --clusters=other\n', workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/)
  for (const line of ['--ar\\ray=1-5', '\\--array=1-5', '--clu\\sters=other']) {
    await assert.rejects(() => tools.slurm_submit.execute({ script: `#!/bin/bash\n#SBATCH ${line}\n`, workdir: '/home/u', dryRun: true, followUp: false }, exec), /Unsupported #SBATCH directive/, line)
  }
})
