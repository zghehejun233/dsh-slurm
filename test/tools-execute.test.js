import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { normalizeConfig } from '../src/config.js'
import { makeTools } from '../src/tools.js'

function toolsFor(run) {
  const rt = {
    config: normalizeConfig({ host: 'demo', historyHours: 0 }),
    store: { list: () => [], find: () => undefined, upsert() {}, save() {} },
    selectedHost: () => 'demo',
    resolveHost: () => ({ label: 'demo', target: 'u@h', options: [], extraArgs: [], port: 22 }),
    run,
    sessionId: () => 's',
    sessionCwd: () => '/tmp',
    remoteHome: async () => '/home/u',
    watcher: { kick() {} },
    log: { warn() {} },
  }
  return Object.fromEntries(makeTools(rt).map((tool) => [tool.name, tool]))
}

test('slurm_status returns a schema-valid value from a real command shape', async () => {
  const tools = toolsFor(async () => ({
    code: 0,
    stdout: [
      '__SINFO__', 'gpu|up|1|mix|gpu:rtx5090:2', '__SINFO_EXIT__0',
      '__QUEUE__', '205|RUNNING|0:10|2:00|n1|None|3:00', '__QUEUE_EXIT__0',
      '__SACCT__', '205|RUNNING|0:0|10|Unknown', '__SACCT_EXIT__0',
    ].join('\n'),
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 1,
  }))
  const value = await tools.slurm_status.execute({ historyHours: 0, nodes: false }, { signal: undefined })
  assert.equal(value.ok, true)
  assert.equal(value.queue[0].timeLimit, '3:00')
  assert.deepEqual(validateJsonSchemaValue(tools.slurm_status.output.schema, value, 'value'), [])
})

test('slurm_submit dry-run returns a schema-valid value', async () => {
  const tools = toolsFor(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }))
  const value = await tools.slurm_submit.execute({
    script: '#!/bin/bash\necho hi\n', workdir: '/home/u', dryRun: true, followUp: false,
  }, { agent: { session: { id: 's' } }, signal: undefined })
  assert.equal(value.dryRun, true)
  assert.deepEqual(validateJsonSchemaValue(tools.slurm_submit.output.schema, value, 'value'), [])
})
