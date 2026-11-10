import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULTS,
  normalizeConfig,
  parseRawTarget,
  readSshHosts,
  resolveHost,
} from '../src/config.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-config-'))
  const file = path.join(dir, 'dsh-ssh.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    hosts: [
      {
        alias: 'demo',
        host: '10.0.0.5',
        port: 2222,
        user: 'bob',
        auth: { kind: 'key', keyPath: '/home/bob/.ssh/id_ed25519' },
        proxyJump: ['jump.example'],
      },
    ],
  }))
  return file
}

test('parseRawTarget reads user, host and port', () => {
  assert.deepEqual(parseRawTarget('bob@10.0.0.5'), { user: 'bob', host: '10.0.0.5', port: 22 })
  assert.deepEqual(parseRawTarget('bob@10.0.0.5:2222'), { user: 'bob', host: '10.0.0.5', port: 2222 })
  assert.equal(parseRawTarget('10.0.0.5'), undefined)
  assert.equal(parseRawTarget('@10.0.0.5'), undefined)
})

test('resolveHost uses a dsh-ssh alias', () => {
  const spec = resolveHost('demo', { sshStorePath: tempStore(), connectTimeoutMs: 15000 })
  assert.equal(spec.target, 'bob@10.0.0.5')
  assert.equal(spec.port, 2222)
  assert.equal(spec.keyPath, '/home/bob/.ssh/id_ed25519')
  assert.deepEqual(spec.proxyJump, ['jump.example'])
  assert.ok(spec.options.includes('BatchMode=yes'))
  assert.ok(spec.options.includes('ConnectTimeout=15'))
  const argv = spec.options.join(' ')
  assert.match(argv, /ControlPath=/)
})

test('resolveHost accepts a raw target and omits the port flag for 22', () => {
  const spec = resolveHost('alice@203.0.113.9:2200')
  assert.equal(spec.target, 'alice@203.0.113.9')
  assert.equal(spec.port, 2200)
  const sshOptions = spec.options.join(' ')
  assert.match(sshOptions, /BatchMode=yes/)
})

test('resolveHost reports known aliases for a typo', () => {
  assert.throws(
    () => resolveHost('demoo', { sshStorePath: tempStore() }),
    /known aliases: demo/,
  )
})

test('readSshHosts tolerates a missing or broken file', () => {
  assert.deepEqual(readSshHosts('/definitely/not/here.json'), [])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-broken-'))
  const file = path.join(dir, 'dsh-ssh.json')
  fs.writeFileSync(file, '{not json')
  assert.deepEqual(readSshHosts(file), [])
})

test('normalizeConfig clamps and defaults', () => {
  const cfg = normalizeConfig({ pollSeconds: 3, host: '  x  ', sshExtraArgs: ['-v', 7] })
  assert.equal(cfg.pollSeconds, 15)
  assert.equal(cfg.host, 'x')
  assert.deepEqual(cfg.sshExtraArgs, ['-v'])
  assert.equal(cfg.enabled, DEFAULTS.enabled)
  assert.equal(cfg.panelRefreshSeconds, 8)
  assert.equal(normalizeConfig({ panelRefreshSeconds: 1 }).panelRefreshSeconds, 3)
  assert.equal(normalizeConfig({ panelRefreshSeconds: 99 }).panelRefreshSeconds, 60)
  assert.equal(normalizeConfig({ pollSeconds: 9999 }).pollSeconds, 600)
  assert.equal(normalizeConfig(null).pollSeconds, 60)
})

test('control path includes jump/key identity and raw extra args stay first', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-ident-')), 'dsh-ssh.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    hosts: [
      { alias: 'a', host: '10.0.0.9', port: 22, user: 'u', auth: { kind: 'key', keyPath: '/k1' }, proxyJump: ['j1'] },
      { alias: 'b', host: '10.0.0.9', port: 22, user: 'u', auth: { kind: 'key', keyPath: '/k1' }, proxyJump: ['j2'] },
    ],
  }))
  const a = resolveHost('a', { sshStorePath: file, sshExtraArgs: ['-v', '-o', 'StrictHostKeyChecking=yes'] })
  const b = resolveHost('b', { sshStorePath: file })
  const controlA = a.options.find((option) => option.startsWith('ControlPath='))
  const controlB = b.options.find((option) => option.startsWith('ControlPath='))
  assert.notEqual(controlA, controlB)
  assert.deepEqual(a.extraArgs, ['-v', '-o', 'StrictHostKeyChecking=yes'])
  const c = resolveHost('a', { sshStorePath: file, sshExtraArgs: ['-v'] })
  assert.notEqual(c.options.find((option) => option.startsWith('ControlPath=')), controlA)
})
