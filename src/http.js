/** Minimal loopback JSON route helpers shared by the panel endpoints. */

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read one JSON body with a hard byte cap. */
export function readJsonBody(req, limit = 65_536) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > limit) {
        reject(new Error('request body too large'))
        try { req.destroy() } catch {}
      }
    })
    req.on('end', () => {
      try { resolve(text === '' ? {} : JSON.parse(text)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** Only a local socket may read or change the panel state. */
export function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  const localAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!localAddress) return false
  const host = String(req?.headers?.host ?? '').toLowerCase()
  if (host === '') return true
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * Reject a cross-site write. Same-origin browsers send an Origin matching the
 * Host header; a missing Origin is allowed for local tooling, but the request
 * must still be loopback and JSON.
 */
export function isSameOrigin(req) {
  const origin = String(req?.headers?.origin ?? '')
  if (origin === '' || origin === 'null') return origin === ''
  const host = String(req?.headers?.host ?? '')
  if (host === '') return true
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** A POST from the panel must be JSON, so a cross-site form cannot trigger it. */
export function isJsonRequest(req) {
  const type = String(req?.headers?.['content-type'] ?? '').toLowerCase()
  return type.startsWith('application/json')
}
