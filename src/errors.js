export class ApiError extends Error {
  constructor(message, { status = null, provider = null, retryable = false, cause = null } = {}) {
    super(message, { cause })
    this.name = "ApiError"
    this.status = status
    this.provider = provider
    this.retryable = retryable
  }
}

export function formatError(err) {
  if (err instanceof ApiError) return err.message
  return err?.message || String(err)
}
