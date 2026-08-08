import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
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
    if (a === 192 && (b === 0 || b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase().split('%')[0]
    if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('ff')) return true
    return false
  }
  return false
}

// Guards outbound fetches of model/provider-supplied URLs against SSRF: only
// http(s) targets resolving to public addresses are allowed. Redirect targets
// must pass the same check (callers re-validate each hop).
export async function assertSafeUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'invalid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unsupported URL scheme'
  const host = parsed.hostname
  if (!host) return 'invalid URL'
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? 'blocked URL (private or loopback address)' : null
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return 'blocked URL (unresolvable host)'
  }
  return addresses.some((entry) => isPrivateAddress(entry.address)) ? 'blocked URL (private or loopback address)' : null
}

// Fetches a URL through SSRF-validated manual redirects (max 5 hops). Each
// hop is re-validated via `assertSafeUrl` before the fetch. The `fetchFn`
// must accept a URL string and return a Response or throw.
// Returns the final Response on success, or null when a hop fails.
export async function fetchWithRedirects(url, fetchFn, { maxHops = 5 } = {}) {
  let current = url
  let res = null
  for (let hop = 0; hop <= maxHops; hop++) {
    const unsafe = await assertSafeUrl(current)
    if (unsafe) return null
    try {
      res = await fetchFn(current)
    } catch {
      return null
    }
    if (res.status < 300 || res.status >= 400) break
    const location = res.headers.get('location')
    await res.body?.cancel?.()
    if (!location) return null
    try {
      current = new URL(location, current).href
    } catch {
      return null
    }
  }
  return res
}

// Fetches a URL with the SSRF guard and a hard byte cap. Follows redirects
// manually so every hop is re-validated. Returns null on any unsafe/invalid/
// oversized outcome and throws only on unexpected body-read errors.
export async function fetchSafeBytes(url, { maxBytes, timeoutMs = 30_000 } = {}) {
  const res = await fetchWithRedirects(url, (current) =>
    fetchWithTimeout(current, { redirect: 'manual' }, { timeoutMs })
  )
  if (!res) return null
  if (res.status >= 400) return null
  const contentLength = Number(res.headers.get('content-length') || 0)
  if (contentLength > maxBytes) return null
  let bytes
  try {
    bytes = Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
  return bytes.length <= maxBytes ? bytes : null
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
        throw err
      }
      return res
    } catch (err) {
      if (signal?.aborted) throw err
      if (err instanceof ApiError && !(err instanceof TimeoutError)) throw err
      if (attempt < attempts) {
        await sleep(retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1], signal)
        continue
      }
      if (err instanceof TimeoutError) throw err
      throw new ApiError(`Network request failed: ${err?.message || 'unknown error'}`, { retryable: true, cause: err })
    }
  }
}
