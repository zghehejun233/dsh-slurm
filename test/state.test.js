import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { JobStore, acquireWriterLock, ensureRuntimeDirs } from '../src/state.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-state-'))
  return path.join(dir, 'jobs.json')
}

test('JobStore round-trips jobs', () => {
  const file = tempFile()
  const store = new JobStore(file)
  store.upsert({ id: '194', host: 'demo', name: 'p1', submittedAt: '2026-11-08T00:00:00Z' })
  store.upsert({ id: '195', host: 'demo', name: 'p2' })

  const again = new JobStore(file)
  assert.equal(again.list().length, 2)
  assert.equal(again.find('194', 'demo').name, 'p1')
  assert.equal(again.find('194').host, 'demo')
  assert.equal(again.find('194', 'other'), undefined)

  again.upsert({ id: '194', host: 'demo', lastState: 'RUNNING' })
  assert.equal(again.list().length, 2)
  assert.equal(again.list()[0].name, 'p1')
  assert.equal(again.list()[0].lastState, 'RUNNING')
})

test('JobStore writes mode 0600 and survives a corrupt file', () => {
  const file = tempFile()
  const store = new JobStore(file)
  store.upsert({ id: '1', host: 'h', delivery: { notifiedAt: new Date().toISOString() } })
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)

  fs.writeFileSync(file, '{broken')
  const recovered = new JobStore(file)
  assert.deepEqual(recovered.list(), [])
  const corrupt = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-'))
  assert.equal(corrupt.length, 1)
})

test('JobStore prunes delivered records outside retention', () => {
  const file = tempFile()
  const store = new JobStore(file)
  store.upsert({ id: 'old', host: 'h', delivery: { notifiedAt: '2020-01-01T00:00:00Z' } })
  store.upsert({ id: 'new', host: 'h', delivery: { notifiedAt: new Date().toISOString() } })
  store.upsert({ id: 'active', host: 'h' })
  const removed = store.prune(14)
  assert.equal(removed, 1)
  assert.deepEqual(store.list().map((job) => job.id).sort(), ['active', 'new'])
})

test('JobStore remove and active filters', () => {
  const file = tempFile()
  const store = new JobStore(file)
  store.upsert({ id: 'a', host: 'h', terminal: true, delivery: { notifiedAt: '2026-11-08T00:00:00Z' } })
  store.upsert({ id: 'b', host: 'h', terminal: true })
  assert.equal(store.remove('a', 'h'), 1)
  assert.equal(store.remove('a', 'h'), 0)
  assert.equal(store.list().length, 1)
})

test('JobStore leaves memory unchanged when the write fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-state-fail-'))
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  const store = new JobStore(path.join(blocker, 'jobs.json'))
  assert.throws(() => store.upsert({ id: '1', host: 'h' }))
  assert.deepEqual(store.list(), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writer lock rejects a second Host and releases cleanly', () => {
  const previous = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-lock-'))
  process.env.DSH_HOME = home
  ensureRuntimeDirs()
  const first = acquireWriterLock()
  assert.equal(typeof first, 'function')
  assert.equal(acquireWriterLock(), undefined)
  first()
  const third = acquireWriterLock()
  assert.equal(typeof third, 'function')
  third()
  process.env.DSH_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})

test('job identity includes the cluster', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-cluster-key-'))
  const store = new JobStore(path.join(dir, 'jobs.json'))
  store.upsert({ id: '1', host: 'h', cluster: 'a' })
  store.upsert({ id: '1', host: 'h', cluster: 'b' })
  assert.equal(store.list().length, 2)
  assert.equal(store.find('1', 'h', 'a').cluster, 'a')
  assert.equal(store.remove('1', 'h', 'a'), 1)
  assert.equal(store.list().length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
