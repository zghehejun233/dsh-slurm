import test from 'node:test'
import assert from 'node:assert/strict'

import { SlurmWatcher } from '../src/watcher.js'

function makeRt(overrides = {}) {
  const jobs = overrides.jobs ?? []
  const saved = []
  const deliveries = []
  const rt = {
    config: {
      pollSeconds: 60,
      retentionDays: 14,
      logTailLines: 0,
      continuePrompt: 'continue {jobId}',
    },
    store: {
      list: () => jobs,
      save: () => { saved.push(1) },
      prune: () => 0,
    },
    resolveHost: () => ({ label: 'demo' }),
    run: async () => ({
      code: 0,
      stdout: '__QUEUE__\n__QUEUE_EXIT__0\n__SACCT__\n205|COMPLETED|0:0|13|2026-11-09T05:00:00\n206|COMPLETED|0:0|7|2026-11-09T05:00:00\n__SACCT_EXIT__0\n',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 1,
    }),
    deliver: async (sessionId, text) => {
      if (rt.failDeliveries > 0) {
        rt.failDeliveries -= 1
        throw new Error('session busy')
      }
      deliveries.push({ sessionId, text })
      return { messageId: `m-${deliveries.length}` }
    },
    log: { info() {}, warn() {} },
    failDeliveries: 0,
  }
  return { rt, jobs, saved, deliveries }
}

test('watcher delivers once when a job reaches a terminal state', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false, delivery: { attempts: 0 } }
  const { rt, saved, deliveries } = makeRt({ jobs: [job] })
  const watcher = new SlurmWatcher(rt)
  await watcher.tick('test')
  assert.equal(job.terminal, true)
  assert.equal(job.lastState, 'COMPLETED')
  assert.ok(job.delivery.notifiedAt)
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /\[SLURM JOB FINISHED\]/)
  assert.match(deliveries[0].text, /state: COMPLETED/)
  assert.ok(saved.length > 0)

  await watcher.tick('test')
  assert.equal(deliveries.length, 1, 'must not deliver twice')
})

test('watcher retries a failed delivery with backoff', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false, delivery: { attempts: 0 } }
  const { rt, deliveries } = makeRt({ jobs: [job] })
  rt.failDeliveries = 1
  const watcher = new SlurmWatcher(rt)

  await watcher.tick('test')
  assert.equal(job.delivery.attempts, 1)
  assert.ok(job.delivery.nextAttemptAt)
  assert.equal(deliveries.length, 0)

  job.delivery.nextAttemptAt = new Date(Date.now() - 1000).toISOString()
  await watcher.tick('test')
  assert.equal(job.delivery.attempts, 1)
  assert.ok(job.delivery.notifiedAt)
  assert.equal(deliveries.length, 1)
})

test('watcher keeps tracking a job that disappears instead of declaring it finished', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false }
  const { rt, deliveries } = makeRt({ jobs: [job] })
  rt.run = async () => ({ code: 0, stdout: '__QUEUE__\n__QUEUE_EXIT__0\n__SACCT__\n__SACCT_EXIT__0\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 })
  const watcher = new SlurmWatcher(rt)
  await watcher.tick('test')
  await watcher.tick('test')
  await watcher.tick('test')
  assert.equal(job.terminal, false)
  assert.equal(job.lastState, 'MISSING')
  assert.equal(deliveries.length, 0)
  assert.match(job.lastError, /still tracking/)
})

test('a failed scheduler query is not an observation', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false }
  const { rt, deliveries } = makeRt({ jobs: [job] })
  rt.run = async () => ({ code: 255, stdout: '__QUEUE__\nssh: connection closed\n__QUEUE_EXIT__255\n__SACCT__\n__SACCT_EXIT__255\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 })
  const watcher = new SlurmWatcher(rt)
  await watcher.tick('test')
  assert.equal(job.terminal, false)
  assert.equal(job.lastState, undefined)
  assert.equal(deliveries.length, 0)
})

test('stop prevents an in-flight pass from delivering', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false, delivery: { attempts: 0 } }
  const { rt, deliveries, saved } = makeRt({ jobs: [job] })
  let release
  rt.run = () => new Promise((resolve) => { release = resolve })
  const watcher = new SlurmWatcher(rt)
  const pending = watcher.tick('test')
  watcher.stop()
  release({ code: 0, stdout: '__QUEUE__\n__QUEUE_EXIT__0\n__SACCT__\n205|COMPLETED|0:0|13|2026-11-09T05:00:00\n__SACCT_EXIT__0\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 })
  await pending
  assert.equal(deliveries.length, 0)
  assert.equal(saved.length, 0)
})

test('requeueable states wait for a grace window before finishing', async () => {
  const job = { id: '9', host: 'demo', name: 'run', sessionId: 's1', terminal: false, delivery: { attempts: 0 } }
  const { rt, deliveries } = makeRt({ jobs: [job] })
  rt.run = async () => ({ code: 0, stdout: '__QUEUE__\n__QUEUE_EXIT__0\n__SACCT__\n9|PREEMPTED|0:0|10|2026-11-09T05:00:00\n__SACCT_EXIT__0\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 })
  const watcher = new SlurmWatcher(rt)
  await watcher.tick('test')
  await watcher.tick('test')
  assert.equal(job.terminal, false)
  assert.equal(deliveries.length, 0)
  await watcher.tick('test')
  assert.equal(job.terminal, true)
  assert.equal(job.lastState, 'PREEMPTED')
  assert.equal(deliveries.length, 1)
})

test('stop during delivery does not persist a receipt', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false, delivery: { attempts: 0 } }
  const { rt } = makeRt({ jobs: [job] })
  let release
  rt.deliver = () => new Promise((resolve) => { release = resolve })
  const watcher = new SlurmWatcher(rt)
  const pending = watcher.tick('test')
  await new Promise((resolve) => setTimeout(resolve, 20))
  watcher.stop()
  release({ messageId: 'm' })
  await pending
  assert.equal(job.delivery.notifiedAt, undefined)
})

test('missing exit markers are a failed observation, not a completion', async () => {
  const job = { id: '205', host: 'demo', name: 'run', sessionId: 's1', terminal: false }
  const { rt, deliveries } = makeRt({ jobs: [job] })
  rt.run = async () => ({ code: 0, stdout: '__QUEUE__\n__SACCT__\n205|COMPLETED|0:0|13|2026-11-09T05:00:00\n', stderr: '', timedOut: false, truncated: false, durationMs: 1 })
  const watcher = new SlurmWatcher(rt)
  await watcher.tick('test')
  assert.equal(job.terminal, false)
  assert.equal(deliveries.length, 0)
})
