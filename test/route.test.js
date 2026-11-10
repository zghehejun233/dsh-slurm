import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slurm-route-'))
process.env.DSH_HOME = home
fs.writeFileSync(path.join(home, 'dsh-ssh.json'), JSON.stringify({
  version: 1,
  hosts: [{ alias: 'demo', host: '192.0.2.10', user: 'u', port: 22, auth: { kind: 'key', keyPath: '/k' }, proxyJump: [] }],
}))

const { apply } = await import('../main.js')

function makeHarness() {
  const routes = new Map()
  const cleanups = []
  const webCtx = {
    effect(fn) { const dispose = fn(); cleanups.push(dispose); return dispose },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    get() { return undefined },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { const dispose = fn(); cleanups.push(dispose); return dispose },
    get() { return undefined },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    inject(_services, callback) { callback(webCtx) },
  }
  apply(ctx, { host: '', panelRefreshSeconds: 8 })
  return { routes, cleanups }
}

function request(method, body, headers = {}) {
  const stream = body === undefined
    ? new Readable({ read() { this.push(null) } })
    : Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.headers = { host: '127.0.0.1:58879', ...headers }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
}

async function call(routes, path, req) {
  const res = response()
  await routes.get(path).handler(req, res)
  return { status: res.status, value: JSON.parse(res.body) }
}

test('GET state returns the empty-host panel model', async () => {
  const { routes, cleanups } = makeHarness()
  const result = await call(routes, '/api/dsh-slurm/state', request('GET'))
  assert.equal(result.status, 200)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.host, '')
  assert.ok(result.value.hosts.some((row) => row.ref === 'demo'))
  assert.deepEqual(result.value.jobs, [])
  assert.deepEqual(result.value.summary, { running: 0, pending: 0, completed: 0 })
  for (const dispose of cleanups) { try { dispose() } catch {} }
})

test('POST host persists a valid target', async () => {
  const { routes, cleanups } = makeHarness()
  const result = await call(routes, '/api/dsh-slurm/host', request('POST', { host: 'raw@example.invalid' }, {
    origin: 'http://127.0.0.1:58879',
    'content-type': 'application/json',
  }))
  assert.equal(result.status, 200)
  assert.equal(result.value.host, 'raw@example.invalid')
  const prefs = JSON.parse(fs.readFileSync(path.join(home, 'slurm', 'prefs.json'), 'utf8'))
  assert.equal(prefs.host, 'raw@example.invalid')
  for (const dispose of cleanups) { try { dispose() } catch {} }
})

test('POST host rejects cross-site and non-JSON writes', async () => {
  const { routes, cleanups } = makeHarness()
  const crossSite = await call(routes, '/api/dsh-slurm/host', request('POST', { host: 'a@b' }, {
    origin: 'https://evil.example',
    'content-type': 'application/json',
  }))
  assert.equal(crossSite.status, 403)
  const nonJson = await call(routes, '/api/dsh-slurm/host', request('POST', { host: 'a@b' }, {
    origin: 'http://127.0.0.1:58879',
    'content-type': 'text/plain',
  }))
  assert.equal(nonJson.status, 403)
  for (const dispose of cleanups) { try { dispose() } catch {} }
})

test('POST host rejects an empty or unknown host', async () => {
  const { routes, cleanups } = makeHarness()
  const empty = await call(routes, '/api/dsh-slurm/host', request('POST', {}, {
    origin: 'http://127.0.0.1:58879',
    'content-type': 'application/json',
  }))
  assert.equal(empty.status, 400)
  const unknown = await call(routes, '/api/dsh-slurm/host', request('POST', { host: 'not-a-configured-alias' }, {
    origin: 'http://127.0.0.1:58879',
    'content-type': 'application/json',
  }))
  assert.equal(unknown.status, 400)
  for (const dispose of cleanups) { try { dispose() } catch {} }
})

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
