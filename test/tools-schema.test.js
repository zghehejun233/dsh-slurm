import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { makeTools } from '../src/tools.js'

const toolset = makeTools({
  config: { selectedHost: '', host: '', maxLogBytes: 4096, followUpByDefault: true },
  store: { list: () => [], find: () => undefined },
  selectedHost: () => 'demo',
  watcher: { kick() {} },
  sessionId: () => 's',
  sessionCwd: () => '/tmp',
  home: () => '/tmp',
  mkdir() {},
})

const samples = {
  slurm_status: {
    ok: true,
    host: 'demo',
    fetchedAt: '2026-11-09T05:00:00.000Z',
    partitions: [{ partition: 'gpu', avail: 'up', nodes: 1, state: 'mix', gres: 'gpu:1' }],
    queue: [{ id: '1', state: 'RUNNING', elapsed: '1:00', timeLeft: '2:00', nodelist: 'n1', reason: 'None', timeLimit: '1:00:00' }],
    nodes: [{ node: 'n1', allocatedCpus: 1, idleCpus: 1, totalCpus: 2, gres: 'gpu:1', state: 'mix' }],
    history: [{ id: '2', name: 'x', state: 'COMPLETED', exitCode: '0:0', elapsedRaw: 5, end: '2026-11-09T05:00:00' }],
    historyHours: 24,
    jobs: [{ id: '3', name: 'y', state: 'RUNNING', exitCode: '0:0', workDir: '/w', stdOut: '/l' }],
  },
  slurm_submit: {
    ok: true, jobId: '1', name: 'n', host: 'demo', scriptPath: '/s', logPath: '/l', followUp: true, dryRun: false, command: 'sbatch',
  },
  slurm_jobs: {
    ok: true,
    jobs: [{
      id: '1', name: 'n', host: 'demo', state: 'RUNNING', terminal: false, submittedAt: '2026-11-09T05:00:00.000Z',
      notifiedAt: '2026-11-09T05:01:00.000Z', sessionId: 's', logPath: '/l', attempts: 0,
    }],
  },
  slurm_logs: { ok: true, jobId: '1', path: '/l', text: 'x', truncated: false },
  slurm_cancel: { ok: true, jobId: '1', output: '' },
  slurm_watch: { ok: true, jobId: '1', action: 'attach', removed: 0, state: 'RUNNING' },
  slurm_fetch: { ok: true, jobId: '1', remotePath: '/r', localDir: '/l', method: 'rsync' },
}

test('every tool output matches its declared schema', () => {
  for (const tool of toolset) {
    const value = samples[tool.name]
    assert.ok(value, `missing sample for ${tool.name}`)
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(violations, [], `${tool.name}: ${JSON.stringify(violations)}`)
  }
})

test('every tool render returns content blocks', () => {
  for (const tool of toolset) {
    const rendered = tool.output.render({}, samples[tool.name])
    assert.ok(Array.isArray(rendered), `${tool.name} render must be an array`)
    assert.ok(rendered.every((block) => block.type === 'text' && typeof block.text === 'string'), tool.name)
  }
})

test('tool names are the seven documented tools', () => {
  assert.deepEqual(toolset.map((tool) => tool.name), [
    'slurm_status', 'slurm_submit', 'slurm_jobs', 'slurm_logs', 'slurm_cancel', 'slurm_watch', 'slurm_fetch',
  ])
})
