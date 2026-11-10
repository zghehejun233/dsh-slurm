import test from 'node:test'
import assert from 'node:assert/strict'

import { fillTemplate, formatDuration, mdTable, renderJobs, renderStatus, tailLines } from '../src/render.js'

test('mdTable escapes pipes and caps rows', () => {
  const table = mdTable(['A', 'B'], [['x|y', 'z']])
  assert.match(table, /x\\\|y/)
  const capped = mdTable(['A'], Array.from({ length: 5 }, (_, index) => [String(index)]), { limit: 2 })
  assert.match(capped, /3 more row/)
})

test('formatDuration is compact', () => {
  assert.equal(formatDuration(5), '5s')
  assert.equal(formatDuration(65), '1m05s')
  assert.equal(formatDuration(3725), '1h02m')
  assert.equal(formatDuration(0), '0s')
})

test('tailLines keeps the end', () => {
  assert.equal(tailLines('a\nb\nc', 2), 'b\nc')
  assert.equal(tailLines('a\nb', 0), '')
})

test('fillTemplate only replaces known placeholders', () => {
  assert.equal(fillTemplate('job {jobId} {unknown}', { jobId: '7' }), 'job 7 {unknown}')
  assert.equal(fillTemplate('{jobId}{jobId}', { jobId: '7' }), '77')
})

test('renderStatus includes the important sections', () => {
  const text = renderStatus({
    host: 'demo',
    fetchedAt: 'now',
    partitions: [{ partition: 'gpu', avail: 'up', nodes: 1, state: 'mix', gres: 'gpu:rtx5090:2' }],
    queue: [{ id: '197', state: 'RUNNING', elapsed: '0:17', timeLeft: '1:59:43', nodelist: 'n1', reason: '' }],
    nodes: [{ node: 'n1', allocatedCpus: 16, idleCpus: 16, totalCpus: 32, gres: 'gpu:rtx5090:2', state: 'mix' }],
    history: [],
    historyHours: 24,
  })
  assert.match(text, /# Slurm status · demo/)
  assert.match(text, /## Partitions/)
  assert.match(text, /## My queue/)
  assert.match(text, /## Nodes/)
  assert.match(text, /16\/16\/32/)
})

test('renderJobs marks delivered jobs', () => {
  const text = renderJobs([
    { id: '1', name: 'a', host: 'h', lastState: 'RUNNING', submittedAt: 's', delivery: {} },
    { id: '2', name: 'b', host: 'h', lastState: 'COMPLETED', submittedAt: 's', delivery: { notifiedAt: 't' } },
  ])
  assert.match(text, /RUNNING/)
  assert.match(text, /COMPLETED/)
})
