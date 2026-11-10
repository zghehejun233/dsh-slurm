import test from 'node:test'
import assert from 'node:assert/strict'

import { runProcess } from '../src/ssh.js'

test('runProcess returns output for a normal command', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'ok')
})

test('runProcess kills an ignored abort and reports aborted', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { signal: controller.signal, timeoutMs: 9000 })
  setTimeout(() => controller.abort(), 100)
  const result = await pending
  assert.equal(result.error, 'aborted')
  assert.ok(Date.now() - started < 4000)
})

test('runProcess does not start a command for an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("should-not-run")'], { signal: controller.signal })
  assert.equal(result.error, 'aborted')
  assert.equal(result.stdout, '')
})
