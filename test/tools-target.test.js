import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { makeTools } from '../src/tools.js'

const a = { id: '123', host: 'a', name: 'a', sessionId: 's', terminal: false }
const b = { id: '123', host: 'b', name: 'b', sessionId: 's', terminal: false }

function makeToolsFor() {
  const rt = {
    config: normalizeConfig({ host: 'b' }),
    store: {
      list: () => [a, b],
      find: (id, host) => [a, b].find((job) => job.id === id && (host === undefined || job.host === host)),
      upsert() { throw new Error('should not write') },
      save() {},
    },
    selectedHost: () => 'b',
    resolveHost: () => ({ label: 'b', target: 'u@h', options: [], extraArgs: [], port: 22 }),
    run: async () => { throw new Error('should not run') },
    sessionId: () => 's',
    sessionCwd: () => '/tmp',
    home: () => '/tmp',
    mkdir() {},
    watcher: { kick() {} },
  }
  return Object.fromEntries(makeTools(rt).map((tool) => [tool.name, tool]))
}

test('an ambiguous job id refuses cancel, logs and fetch instead of guessing a host', async () => {
  const tools = makeToolsFor()
  await assert.rejects(() => tools.slurm_cancel.execute({ jobId: '123' }), /multiple hosts/)
  await assert.rejects(() => tools.slurm_logs.execute({ jobId: '123' }), /multiple hosts/)
  await assert.rejects(() => tools.slurm_fetch.execute({ jobId: '123', remotePath: '/x' }), /multiple hosts/)
})

test('an explicit host disambiguates the same id', async () => {
  const tools = makeToolsFor()
  // resolveHost/run are stubbed to fail, so only the target-resolution step is observed.
  await assert.rejects(() => tools.slurm_cancel.execute({ jobId: '123', host: 'a' }, { signal: undefined }), /should not run/)
})
