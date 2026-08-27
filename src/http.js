import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { ApiError, TimeoutError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_DELAYS = [500, 1000]

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // IANA special-purpose and TEST-NET-1 (192.0.0.0/24, 192.0.2.0/24).
    if (a === 192 && b === 0) return true
    // RFC 2544 benchmark range 198.18.0.0/15.
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase().split('%')[0]
    if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true
    if (lower.startsWith('::ffff:')) {
      // URL parsing canonicalizes mapped IPv4 into hex (::ffff:a00:1), so
      // the tail must be re-expanded to a dotted quad when it is not one.
      const tail = lower.slice(7)
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) return isPrivateAddress(tail)
      const groups = tail.split(':')
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
        const hex = groups.map((g) => g.padStart(4, '0')).join('')
        const ip4 = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.')
        return isPrivateAddress(ip4)
      }
      return false
    }
    // NAT64 (RFC 6052 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48),
    // 6to4 (RFC 3056 2002::/16) and Teredo (RFC 4380 2001::/32) can
    // embed private IPv4 targets and must not pass the guard.
    if (lower.startsWith('64:ff9b') || lower.startsWith('2002')) return true
    if (lower.startsWith('2001')) {
      // 2001:0000::/32 is the Teredo range; 2001:1::/48 and later are public.
      const group = lower.split(':')[1]
      if (group === '0' || group === '0000' || group === '') return true
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) return true
    if (lower.startsWith('ff')) return true
    return false
  }
  return false
}

// Resolves and SSRF-validates a URL in one pass, returning the exact
// addresses the guard approved. The subsequent request pins DNS to those
// addresses, closing the check-then-fetch race a rebinding domain could
// otherwise exploit (guard approves one resolution, fetch uses another).
async function resolveSafeUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { error: 'invalid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'unsupported URL scheme' }
  // URL.hostname serializes IPv6 literals with brackets; strip them so
  // isIP/isPrivateAddress see the bare address.
  const rawHost = parsed.hostname
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!host) return { error: 'invalid URL' }
  if (isIP(host) !== 0) {
    return isPrivateAddress(host)
      ? { error: 'blocked URL (private or loopback address)' }
      : { addresses: [host], family: isIP(host) }
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { error: 'blocked URL (unresolvable host)' }
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return { error: 'blocked URL (private or loopback address)' }
  }
  return { addresses: addresses.map((entry) => entry.address), family: addresses[0]?.family || 0 }
}

// Guards outbound fetches of model/provider-supplied URLs against SSRF: only
// http(s) targets resolving to public addresses are allowed.
export async function assertSafeUrl(url) {
  const { error } = await resolveSafeUrl(url)
  return error ?? null
}

function defaultRequestFn(parsed, options) {
  return (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, options)
}

// Single-hop GET whose DNS is pinned to the addresses resolveSafeUrl
// validated: SNI and the Host header still carry the original hostname, so
// TLS and virtual hosts work while the connection can only land on the
// approved IPs. Returns a Response-like object ({ status, headers, body })
// so the shared redirect/body helpers stay transport-agnostic.
export function pinnedFetch(url, { addresses, family = 0, timeoutMs = DEFAULT_TIMEOUT_MS, signal, requestFn = defaultRequestFn } = {}) {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new TimeoutError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      signal?.removeEventListener('abort', onSignalAbort)
      fn(value)
    }
    const onAbort = () => finish(reject, controller.signal.reason || signal?.reason || new Error('Aborted'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    // Settle on the CALLER's abort too: the combined signal aborts the
    // underlying request, but its error event may be delayed — without this
    // listener the timeout timer keeps ticking (and the event loop alive)
    // after the caller has already given up.
    const onSignalAbort = () => finish(reject, signal?.reason || new Error('Aborted'))
    signal?.addEventListener('abort', onSignalAbort, { once: true })
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    const req = requestFn(parsed, {
      method: 'GET',
      // node invokes lookup with { all: true } and expects the same shape
      // dns.lookup returns: address objects in the all case, a single
      // address string otherwise.
      lookup: (hostname, options, callback) => {
        if (options?.all) {
          callback(null, addresses.map((address) => ({ address, family })))
        } else {
          callback(null, addresses[0], family)
        }
      },
      signal: combined,
    })
    req.on('response', (res) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers || {})) {
        if (value === undefined) continue
        headers.append(name, Array.isArray(value) ? value.join(', ') : String(value))
      }
      finish(resolve, { status: res.statusCode ?? 0, headers, body: Readable.toWeb(res) })
    })
    req.on('error', (err) => finish(reject, err))
    req.end()
  })
}

// Fetches a URL through SSRF-validated manual redirects (max 5 hops). Each
// hop is resolved and validated exactly once via resolveSafeUrl and then
// fetched with DNS pinned to those addresses, so a rebinding domain cannot
// pass the check and then connect to a private address.
// Returns { res, url, error }: `res` is the final Response-like
// (non-redirect) on success, `url` its final URL after the hops; `error`
// carries the failure reason when `res` is null.
export async function fetchWithRedirects(url, { maxHops = 5, timeoutMs = DEFAULT_TIMEOUT_MS, signal, requestFn } = {}) {
  let current = url
  for (let hop = 0; hop <= maxHops; hop++) {
    const resolved = await resolveSafeUrl(current)
    if (resolved.error) return { res: null, error: resolved.error }
    let res
    try {
      res = await pinnedFetch(current, { addresses: resolved.addresses, family: resolved.family, timeoutMs, signal, requestFn })
    } catch (err) {
      return { res: null, error: err?.message || 'network error' }
    }
    if (res.status < 300 || res.status >= 400) return { res, url: current, error: null }
    const location = res.headers.get('location')
    await res.body?.cancel?.()
    if (!location) return { res: null, error: 'redirect without location' }
    try {
      current = new URL(location, current).href
    } catch {
      return { res: null, error: 'invalid redirect URL' }
    }
  }
  return { res: null, error: 'too many redirects' }
}

// Reads a response body with an idle deadline (reset on every chunk, so a
// slow-but-progressing body survives) and an optional hard byte cap enforced
// mid-stream. Returns null when the cap is crossed; throws on deadline or
// read errors. Falls back to arrayBuffer for non-streaming bodies, where
// only the cap applies.
export async function readBodyWithDeadline(res, { limit = Infinity, timeoutMs = 30_000 } = {}) {
  const body = res.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        reader.cancel().catch(() => {})
      }, timeoutMs)
      let next
      try {
        next = await reader.read()
      } finally {
        clearTimeout(timer)
      }
      if (timedOut) throw new Error('could not read response body')
      const { done, value } = next
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  return bytes.length > limit ? null : bytes
}

// Fetches a URL with the SSRF guard and a hard byte cap. Follows redirects
// manually so every hop is re-validated. Returns null on any unsafe/invalid/
// oversized outcome and throws only on unexpected body-read errors.
export async function fetchSafeBytes(url, { maxBytes, timeoutMs = 30_000, requestFn } = {}) {
  const { res } = await fetchWithRedirects(url, { timeoutMs, requestFn })
  if (!res) return null
  if (res.status >= 400) {
    await res.body?.cancel?.()
    return null
  }
  const contentLength = Number(res.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    await res.body?.cancel?.()
    return null
  }
  try {
    const bytes = await readBodyWithDeadline(res, { limit: maxBytes, timeoutMs })
    return bytes !== null && bytes.length <= maxBytes ? bytes : null
  } catch {
    return null
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchWithTimeout(url, opts = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    return await fetch(url, { ...opts, signal: combined })
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new TimeoutError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchWithRetry(url, opts = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 3, signal, errorResponse, retryDelays = RETRY_DELAYS } = {}) {
  if (attempts < 1) throw new Error('fetchWithRetry requires attempts >= 1')
  const idempotent = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(String((opts.method || 'GET').toUpperCase()))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts, { timeoutMs, signal })
      if (!res.ok) {
        const body = await res.text()
        let err
        try {
          err = errorResponse(res.status, body)
        } catch (thrown) {
          err = thrown
        }
        if (attempt < attempts && err?.retryable) {
          await sleep(retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1], signal)
          continue
        }
        // A misbehaving errorResponse may return undefined instead of
        // throwing; never `throw undefined`.
        if (!(err instanceof Error)) {
          err = new ApiError(`HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 })
        }
        throw err
      }
      return res
    } catch (err) {
      if (signal?.aborted) throw err
      if (err instanceof ApiError && !(err instanceof TimeoutError)) throw err
      // A request that never got a response may still have been processed by
      // the server (a POST completion or image generation can finish
      // server-side after a client-side timeout): silently re-sending it
      // would double the generation and the bill. Network/timeout retries
      // are therefore reserved for idempotent requests; response-class
      // retries (429/5xx via `errorResponse`) stay available for any method
      // because the server already rejected the request.
      if (idempotent && attempt < attempts) {
        await sleep(retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1], signal)
        continue
      }
      if (err instanceof TimeoutError) throw err
      throw new ApiError(`Network request failed: ${err?.message || 'unknown error'}`, { retryable: true, cause: err })
    }
  }
}
