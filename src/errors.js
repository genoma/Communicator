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
