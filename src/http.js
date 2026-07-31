import { ApiError } from "./errors.js"

const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_DELAYS = [500, 1000]

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason || new Error("Aborted"))
    }, { once: true })
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
      throw new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, { retryable: true })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchWithRetry(url, opts = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 3, signal, errorResponse } = {}) {
  let lastError
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
          await sleep(RETRY_DELAYS[attempt - 1], signal)
          continue
        }
        throw err
      }
      return res
    } catch (err) {
      if (signal?.aborted) throw err
      if (err instanceof ApiError) throw err
      lastError = err
      if (attempt < attempts) {
        await sleep(RETRY_DELAYS[attempt - 1], signal)
        continue
      }
    }
  }
  throw new ApiError(`Network request failed: ${lastError?.message || "unknown error"}`, { retryable: true, cause: lastError })
}
