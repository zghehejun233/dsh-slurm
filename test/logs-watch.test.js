import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { makeTools } from '../src/tools.js'

const tracked = { id: '7', host: 'demo', name: 'run', sessionId: 's', logPath: '/out.log', terminal: false }

function makeToolsFor(overrides = {}) {
  const upserts = []
  const rt = {
    config: normalizeConfig({ host: 'demo', maxLogBytes: 4096 }),
    store: {
      list: () => [tracked],
      find: (id, host) => (id === '7' && (host === undefined || host === 'demo') ? tracked : undefined),
      upsert: (job) => upserts.push(job),
      save() {},
    },
    selectedHost: () => 'demo',
    resolveHost: () => ({ label: 'demo', target: 'u@h', options: [], extraArgs: [], port: 22 }),
    run: async (_spec, command) => {
      if (command.startsWith('scontrol')) {
        return { code: 0, stdout: 'JobId=7 JobName=run JobState=RUNNING WorkDir=/w StdOut=/out.log StdErr=/err.log\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
      }
      if (command.startsWith('tail')) {
        return { code: 0, stdout: 'stderr line\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
    sessionId: () => 's',
    watcher: { kick() {} },
    ...overrides,
  }
  return { rt, upserts, tools: Object.fromEntries(makeTools(rt).map((tool) => [tool.name, tool])) }
}

test('slurm_logs resolves stderr even when a stdout logPath is tracked', async () => {
  const { tools } = makeToolsFor()
  const value = await tools.slurm_logs.execute({ jobId: '7', kind: 'stderr', lines: 5 }, { signal: undefined })
  assert.equal(value.path, '/err.log')
  assert.match(value.text, /stderr line/)
})

test('slurm_logs treats a nonzero tail as an error', async () => {
  const { tools } = makeToolsFor({
    run: async () => ({ code: 1, stdout: 'tail: no such file', stderr: '', timedOut: false, truncated: false, durationMs: 1 }),
  })
  await assert.rejects(() => tools.slurm_logs.execute({ jobId: '7', path: '/missing' }, { signal: undefined }), /Could not read/)
})

test('slurm_watch reattach clears a previous delivery failure', async () => {
  const previous = { ...tracked, notifyFailedAt: '2026-11-09T05:00:00Z', terminal: true, delivery: { attempts: 5 } }
  const { tools, upserts } = makeToolsFor({
    store: {
      list: () => [previous],
      find: () => previous,
      upsert: (job) => upserts.push(job),
      save() {},
    },
  })
  await tools.slurm_watch.execute({ jobId: '7', prompt: 'continue' }, { agent: { session: { id: 's' } }, signal: undefined })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].notifyFailedAt, undefined)
  assert.equal(upserts[0].terminal, false)
  assert.equal(upserts[0].delivery.attempts, 0)
})
