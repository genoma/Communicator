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

export function formatError(err) {
  if (err instanceof ApiError) return err.message
  return err?.message || String(err)
}

export function makeHandleHttpError({ providerName, providerId = providerName, apiKeyEnv, notFoundMessage = null }) {
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
    throw new ApiError(`${providerName} request failed (${status}): ${trunc}`, { status, provider: providerId, retryable: status >= 500 })
  }
}
