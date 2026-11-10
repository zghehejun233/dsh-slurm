import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PrefsStore } from '../src/prefs.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-prefs-'))
  return path.join(dir, 'prefs.json')
}

test('PrefsStore persists the selected host', () => {
  const file = tempFile()
  const store = new PrefsStore(file)
  assert.equal(store.get(), undefined)
  store.set('sdu-5090-zp')
  assert.equal(store.get(), 'sdu-5090-zp')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  const again = new PrefsStore(file)
  assert.equal(again.get(), 'sdu-5090-zp')
  again.clear()
  assert.equal(again.get(), undefined)
  assert.equal(fs.existsSync(file), false)
})

test('PrefsStore ignores a malformed file', () => {
  const file = tempFile()
  fs.writeFileSync(file, '{broken')
  const store = new PrefsStore(file)
  assert.equal(store.get(), undefined)
})

test('PrefsStore does not change memory when the write fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-prefs-fail-'))
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  const store = new PrefsStore(path.join(blocker, 'prefs.json'))
  assert.throws(() => store.set('new-host'))
  assert.equal(store.get(), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})
