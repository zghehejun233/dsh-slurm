import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPanelPayload,
  listHosts,
  mergePanelJobs,
  parseDuration,
  parseTimeLimit,
  snapshotFromSections,
  sortActive,
  sortRecent,
  summarize,
} from '../src/panel.js'

test('parseDuration reads scheduler clock formats', () => {
  assert.equal(parseDuration('13'), 13)
  assert.equal(parseDuration('2:47'), 167)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration('2-01:02:03'), 176523)
  assert.equal(parseDuration(''), undefined)
  assert.equal(parseDuration('UNLIMITED'), undefined)
})

test('mergePanelJobs keeps one row per id and prefers live queue data', () => {
  const ledger = [
    { id: '205', host: 'demo', name: 'run', lastState: 'RUNNING', terminal: false, elapsed: '10', timeLimit: '3:00' },
    { id: '206', host: 'demo', name: 'done', lastState: 'COMPLETED', terminal: true, elapsed: '12', timeLimit: '3:00', delivered: {} },
    { id: '207', host: 'other', name: 'elsewhere', lastState: 'RUNNING', terminal: false },
  ]
  const queue = [
    { id: '205', state: 'RUNNING', elapsed: '12', timeLeft: '2:48', timeLimit: '3:00', reason: 'None', nodelist: 'n1' },
    { id: '208', state: 'PENDING', elapsed: '0:00', timeLeft: '1:00', timeLimit: '2:00', reason: 'Resources', nodelist: '' },
  ]
  const rows = mergePanelJobs({ ledger, queue, host: 'demo' })
  assert.equal(rows.length, 3)
  const job = rows.find((row) => row.id === '205')
  assert.equal(job.elapsedSec, 12)
  assert.equal(job.timeLeftSec, 168)
  assert.equal(job.tracked, true)
  assert.equal(job.node, 'n1')
  assert.equal(rows.find((row) => row.id === '208').tracked, false)
  assert.equal(rows.find((row) => row.id === '206').terminal, true)
  assert.equal(rows.some((row) => row.id === '207'), false)
})

test('terminal tracked jobs are not overwritten by a queue row', () => {
  const rows = mergePanelJobs({
    ledger: [{ id: '9', host: 'demo', lastState: 'CANCELLED', terminal: true }],
    queue: [{ id: '9', state: 'RUNNING', elapsed: '1:00' }],
    host: 'demo',
  })
  assert.equal(rows[0].state, 'CANCELLED')
})

test('summarize and sorting split running, pending and recent', () => {
  const rows = [
    { id: '1', state: 'PENDING', terminal: false },
    { id: '2', state: 'RUNNING', terminal: false },
    { id: '3', state: 'COMPLETED', terminal: true, finishedAt: '2026-11-09T05:00:00Z' },
    { id: '4', state: 'FAILED', terminal: true, finishedAt: '2026-11-09T06:00:00Z' },
  ]
  assert.deepEqual(summarize(rows), { running: 1, pending: 1, completed: 2 })
  assert.deepEqual(sortActive(rows).map((row) => row.id), ['2', '1'])
  assert.deepEqual(sortRecent(rows).map((row) => row.id), ['4', '3'])
})

test('listHosts adds the configured and selected fallbacks once', () => {
  const hosts = [{ alias: 'a', user: 'u', host: 'h1' }, { alias: 'b', user: 'u', host: 'h2', port: 2222 }]
  const rows = listHosts(hosts, 'legacy', 'b')
  assert.deepEqual(rows.map((row) => row.ref), ['a', 'b', 'legacy'])
  assert.equal(rows[1].detail, 'u@h2:2222')
})

test('buildPanelPayload returns active, recent, summary and cluster', () => {
  const payload = buildPanelPayload({
    host: 'demo',
    hosts: [{ ref: 'demo', label: 'demo', detail: 'u@h' }],
    ledger: [{ id: '1', host: 'demo', lastState: 'RUNNING', terminal: false, elapsed: '5' }],
    snapshot: {
      partitions: [{ partition: 'gpu', nodes: 1, state: 'mix', gres: 'gpu:1' }],
      queue: [{ id: '1', state: 'RUNNING', elapsed: '6', timeLimit: '1:00' }, { id: '2', state: 'PENDING', reason: 'Priority' }],
      nodes: [],
      stale: false,
    },
    panelRefreshSeconds: 8,
    otherHosts: 2,
  })
  assert.equal(payload.host, 'demo')
  assert.equal(payload.summary.running, 1)
  assert.equal(payload.summary.pending, 1)
  assert.equal(payload.jobs.length, 2)
  assert.equal(payload.jobs[0].id, '1')
  assert.equal(payload.otherHosts, 2)
  assert.equal(payload.cluster.partitions.length, 1)
  assert.equal(payload.stale, false)
})

test('parseTimeLimit treats bare Slurm numbers as minutes', () => {
  assert.equal(parseTimeLimit('60'), 3600)
  assert.equal(parseTimeLimit('1:00'), 60)
  assert.equal(parseTimeLimit('02:00:00'), 7200)
  assert.equal(parseTimeLimit('UNLIMITED'), undefined)
})

test('snapshotFromSections marks a failed required command as stale', () => {
  const snapshot = snapshotFromSections('__SINFO__\n__SINFO_EXIT__1\n__QUEUE__\n__QUEUE_EXIT__0\n__SACCT__\n')
  assert.equal(snapshot.stale, true)
  assert.match(snapshot.error, /SINFO exited 1/)
})

test('snapshotFromSections rejects missing markers and truncated output', () => {
  assert.equal(snapshotFromSections('__SINFO__\n__QUEUE__\n').stale, true)
  assert.equal(snapshotFromSections('__SINFO__\n__SINFO_EXIT__0\n__QUEUE__\n__QUEUE_EXIT__0\n', { truncated: true }).stale, true)
})

test('a tracked array parent aggregates its task rows', () => {
  const rows = mergePanelJobs({
    ledger: [{ id: '123', host: 'demo', name: 'array', lastState: 'RUNNING', terminal: false, timeLimit: '1:00:00' }],
    queue: [
      { id: '123_1', state: 'RUNNING', elapsed: '0:10', timeLeft: '0:50', timeLimit: '1:00:00' },
      { id: '123_2', state: 'RUNNING', elapsed: '0:12', timeLeft: '0:48', timeLimit: '1:00:00' },
    ],
    host: 'demo',
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '123')
  assert.equal(rows[0].tasks, 2)
})

test('parent array state prefers a running task over a pending one', () => {
  const rows = mergePanelJobs({
    ledger: [{ id: '123', host: 'demo', name: 'array', lastState: 'PENDING', terminal: false }],
    queue: [
      { id: '123_1', state: 'PENDING' },
      { id: '123_2', state: 'RUNNING' },
    ],
    host: 'demo',
  })
  assert.equal(rows[0].state, 'RUNNING')
})

test('parent array does not keep a stale RUNNING state when all tasks pend', () => {
  const rows = mergePanelJobs({
    ledger: [{ id: '123', host: 'demo', name: 'array', lastState: 'RUNNING', terminal: false }],
    queue: [{ id: '123_1', state: 'PENDING' }, { id: '123_2', state: 'PENDING' }],
    host: 'demo',
  })
  assert.equal(rows[0].state, 'PENDING')
})

test('a required NODES section must be present and numeric', () => {
  const base = '__SINFO__\n__SINFO_EXIT__0\n__QUEUE__\n__QUEUE_EXIT__0\n'
  assert.equal(snapshotFromSections(base, { nodesRequired: true }).stale, true)
  assert.equal(snapshotFromSections(`${base}__NODES__\n__NODES_EXIT__x\n`, { nodesRequired: true }).stale, true)
  assert.equal(snapshotFromSections(`${base}__NODES__\n__NODES_EXIT__0\n`, { nodesRequired: true }).stale, false)
})
