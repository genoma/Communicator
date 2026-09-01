import { sanitizeAnsi } from './ui/hyperlink.js'

export class ApiError extends Error {
  constructor(message, { status = null, provider = null, retryable = false, cause = null } = {}) {
    super(message, { cause })
    this.name = 'ApiError'
    this.status = status
    this.provider = provider
    this.retryable = retryable
  }
}

export class TimeoutError extends ApiError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true })
    this.name = 'TimeoutError'
  }
}

export class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

// Error messages can carry provider/model-derived text (SSE stream errors,
// HTTP error bodies), so the terminal-facing renderings are sanitized here —
// the same treatment content/reasoning output gets before display.
export function formatError(err) {
  if (err instanceof ApiError) return sanitizeAnsi(err.message)
  return sanitizeAnsi(err?.message || String(err))
}

// One-line rendering of a command failure: CliErrors already carry their
// user-facing text, everything else is prefixed and passed through
// formatError. Plain message shape (no leading newline) — the REPL branch
// that reached the failure already closed the submitted line.
export function commandErrorLine(err) {
  return err instanceof CliError ? `${sanitizeAnsi(err.message)}\n` : `Error: ${formatError(err)}\n`
}

export function makeHandleHttpError({ providerName, providerId = providerName, apiKeyEnv, notFoundMessage = null, retryable5xx = true }) {
  return function handleHttpError(status, body) {
    if (status === 401) {
      throw new ApiError(`Invalid API key. Check your ${apiKeyEnv} environment variable.`, { status, provider: providerId, retryable: false })
    }
    if (status === 429) {
      throw new ApiError(`Rate limited by ${providerName}. Wait a moment and try again.`, { status, provider: providerId, retryable: true })
    }
    if (status === 404 && notFoundMessage) {
      throw new ApiError(notFoundMessage, { status, provider: providerId, retryable: false })
    }
    const trunc = typeof body === 'string' && body.length > 200 ? `${body.slice(0, 200)}...` : body
    // 5xx on a generation endpoint must not retry: a gateway 504 can fire
    // after the generation was already produced and billed server-side, so
    // re-POSTing would double the generation and the bill (429 stays
    // retryable — the server already rejected the request before doing work).
    throw new ApiError(`${providerName} request failed (${status}): ${trunc}`, { status, provider: providerId, retryable: status >= 500 && retryable5xx })
  }
}
