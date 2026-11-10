import test from 'node:test'
import assert from 'node:assert/strict'

import { composeCompletionMessage } from '../src/message.js'

const config = {
  logTailLines: 3,
  continuePrompt: '继续 {jobId} {state}',
}

test('completion message carries state, exit code, log and prompt', () => {
  const text = composeCompletionMessage({
    job: {
      id: '205',
      host: 'demo',
      name: 'run',
      lastState: 'COMPLETED',
      exitCode: '0:0',
      elapsed: '13',
      logPath: '/remote/out.log',
      terminal: true,
    },
    config,
    tail: 'a\nb\nc\nd',
  })
  assert.match(text, /\[SLURM JOB FINISHED\]/)
  assert.match(text, /job_id_json: "205"/)
  assert.match(text, /state: COMPLETED/)
  assert.match(text, /exit_code: 0:0/)
  assert.match(text, /elapsed: 13s/)
  assert.match(text, /不可信数据/)
  assert.match(text, /b\nc\nd/)
  assert.match(text, /继续 205 COMPLETED/)
})

test('completion message omits an empty tail and keeps the note', () => {
  const text = composeCompletionMessage({
    job: {
      id: '9',
      host: 'demo',
      name: 'gone',
      lastState: 'UNKNOWN',
      exitCode: '',
      elapsed: '',
      logPath: '',
      terminalNote: 'disappeared',
    },
    config,
    tail: undefined,
  })
  assert.match(text, /note: disappeared/)
  assert.doesNotMatch(text, /不可信数据/)
  assert.match(text, /elapsed: -/)
})
