import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { assertNoSymlinkEscape, assertRemotePath, finalizeFetch, prepareLocalTarget, sftpFetch, sftpQuote } from '../src/fetch.js'
import { buildSftpArgv } from '../src/ssh.js'

test('remote paths reject control characters and require absolute paths', () => {
  assert.equal(assertRemotePath('/home/a b;$(x)'), '/home/a b;$(x)')
  assert.throws(() => assertRemotePath('relative'), /absolute/)
  assert.throws(() => assertRemotePath('/home/a\nb'), /control/)
})

test('sftp args put batch options before the target', () => {
  const argv = buildSftpArgv({ target: 'u@h', options: ['BatchMode=yes'], port: 22, keyPath: '', proxyJump: [], extraArgs: [] })
  const dash = argv.indexOf('--')
  assert.ok(dash > 0)
  assert.ok(argv.indexOf('-b') < dash)
  assert.equal(argv.at(-1), 'u@h')
})

test('sftpQuote escapes quotes and backslashes', () => {
  assert.equal(sftpQuote('/a b'), '"/a b"')
  assert.equal(sftpQuote('/a"b'), '"/a\\"b"')
  assert.equal(sftpQuote('/a\\b'), '"/a\\\\b"')
})

test('prepareLocalTarget rejects a symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-fetch-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-outside-'))
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.throws(
    () => prepareLocalTarget({ localDir: path.join(root, 'link', 'job'), cwd: root, resultsRoot: path.join(root, 'results') }),
    /Refusing to write|symlink/,
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('prepareLocalTarget creates a private staging directory inside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-fetch-ok-'))
  const prepared = prepareLocalTarget({ localDir: path.join(root, 'results', 'job'), cwd: root, resultsRoot: path.join(root, 'results') })
  assert.equal(fs.statSync(prepared.staging).isDirectory(), true)
  assert.equal(fs.existsSync(prepared.target), false)
  finalizeFetch(prepared.staging, prepared.target)
  assert.equal(fs.statSync(prepared.target).isDirectory(), true)
  assert.throws(() => prepareLocalTarget({ localDir: prepared.target, cwd: root, resultsRoot: path.join(root, 'results') }), /already exists/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('prepareLocalTarget does not create a parent outside the roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-fetch-out-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-outside-'))
  const target = path.join(outside, 'new-parent', 'leaf')
  assert.throws(() => prepareLocalTarget({ localDir: target, cwd: root, resultsRoot: path.join(root, 'results') }), /Refusing to write/)
  assert.equal(fs.existsSync(path.join(outside, 'new-parent')), false)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('finalizeFetch rechecks the destination parent before moving', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-final-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-final-out-'))
  const staging = fs.mkdtempSync(path.join(root, '.dsh-fetch-'))
  const roots = [fs.realpathSync(root)]
  assert.throws(() => finalizeFetch(staging, path.join(outside, 'leaf'), roots), /Refusing to move/)
  assert.equal(fs.existsSync(path.join(outside, 'leaf')), false)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('a parent symlink swapped after prepare cannot redirect finalize', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-swap-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-swap-out-'))
  const parent = path.join(root, 'real')
  const prepared = prepareLocalTarget({ localDir: path.join(parent, 'job'), cwd: root, resultsRoot: path.join(root, 'results') })
  fs.renameSync(parent, path.join(root, 'moved'))
  fs.symlinkSync(outside, parent)
  assert.throws(() => finalizeFetch(prepared.staging, prepared.target, prepared.roots), /Refusing to move/)
  assert.equal(fs.existsSync(path.join(outside, 'job')), false)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})


test('downloaded symlinks that leave the staging tree are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-symlink-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-symlink-out-'))
  fs.writeFileSync(path.join(outside, 'secret'), 'x')
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.throws(() => assertNoSymlinkEscape(root), /escapes the destination/)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})


test('sftpFetch rejects an escaping symlink after a successful transfer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-sftp-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-sftp-out-'))
  fs.symlinkSync(outside, path.join(root, 'link'))
  const rt = { runLocal: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }) }
  await assert.rejects(() => sftpFetch(rt, { target: 'u@h', options: [], extraArgs: [] }, '/remote/x', root), /escapes the destination/)
  assert.equal(fs.existsSync(root), false)
  fs.rmSync(outside, { recursive: true, force: true })
})
