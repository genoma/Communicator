import { ApiError, TimeoutError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_DELAYS = [500, 1000]

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
