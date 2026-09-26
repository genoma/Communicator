import { sanitizeAnsi } from './ui/hyperlink.js'

export class ApiError extends Error {
  constructor(message, { status = null, provider = null, retryable = false, cause = null, code = null, errorType = null, retryAfter = null } = {}) {
    super(message, { cause })
    this.name = 'ApiError'
    this.status = status
    this.provider = provider
    this.retryable = retryable
    // Provider error fields surfaced from the response body / SSE event so a
    // caller can act on the true cause instead of the rendered message: the
    // provider code (e.g. 'rate_limit_exceeded', 'MODEL_OVERLOADED'), a typed
    // error classification (error_type / type), and the retry-after window in
    // seconds. All default null so existing construction is unchanged.
    this.code = code
    this.errorType = errorType
    this.retryAfter = retryAfter
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
// Prompt cancellation is duck-typed by name: @inquirer/core exposes
// ExitPromptError, but importing the package just for one instanceof costs
// ~30 ms of startup on every invocation. The name check already covers every
// guard (inquirer sets this.name = 'ExitPromptError'), so a single helper
// replaces the six scattered imports.
export function isExitPromptError(err) {
  return err?.name === 'ExitPromptError'
}

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

const OVERFLOW_ERROR_TYPES = new Set(['context_length_exceeded', 'too_many_tokens'])

// An over-window request reaches the client in three shapes: a typed
// error_type/error code (mid-stream SSE events), or provider wording only.
// Both providers' live pre-flight 400s ship wording without a usable type
// (OpenRouter sends a numeric code, Venice a bare string), so classification
// is status-agnostic and wording-first, and the patterns stay conservative to
// avoid catching unrelated 400s.
const OVERFLOW_MESSAGE_PATTERNS = [
  /maximum context length/i,
  /longer than the model['\u2019]s context length/i,
  /exceeds the model['\u2019]s (?:maximum )?context/i,
  /combined input and output tokens exceed/i,
]

export function isContextOverflowError(err) {
  if (!err || typeof err !== 'object') return false
  if (OVERFLOW_ERROR_TYPES.has(String(err.errorType).toLowerCase())) return true
  if (OVERFLOW_ERROR_TYPES.has(String(err.code).toLowerCase())) return true
  const message = typeof err.message === 'string' ? err.message : ''
  return OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

const OVERFLOW_TEXTS = {
  repl: {
    preflight: "Request exceeds this model's context window; retrying unchanged will fail. Shorten it with /edit or /delete, start fresh with /new, or switch to a larger-window /model.",
    'mid-generation': 'The model hit its context window before finishing; retrying unchanged will fail. Shorten it with /edit or /delete, start fresh with /new, or switch to a larger-window /model.',
  },
  oneshot: {
    preflight: "The request exceeds the model's context window. Retry with a shorter prompt or less history.",
    'mid-generation': 'The model hit its context window before finishing. Retry with a shorter prompt or less history.',
  },
}

export function overflowErrorText({ phase = 'preflight', mode = 'repl' } = {}) {
  return OVERFLOW_TEXTS[mode]?.[phase] ?? OVERFLOW_TEXTS.repl.preflight
}

// A completed turn that produced no text and no parts is classified by why the
// provider stopped. The named reasons are terminal: the provider already spent
// the turn without writing, so replaying it unchanged cannot produce output
// (retryable stays false and the caller keeps the user turn for /edit).
// One-shot gets its own wording because it has no REPL commands to name.
const EMPTY_ANSWER_TEXTS = {
  length: {
    repl: 'Output limit reached: no answer was produced (the model used its whole output budget before writing content). Lower /reasoning effort or shorten the request.',
    oneshot: 'Output limit reached: no answer was produced (the model used its whole output budget before writing content). Lower the reasoning effort or shorten the prompt.',
  },
  content_filter: {
    repl: "Blocked by the provider's content filter: no answer was produced. Edit the message (/edit) or change the request.",
    oneshot: "Blocked by the provider's content filter: no answer was produced. Change the request and try again.",
  },
  error: {
    repl: 'The provider ended the generation with an error: no answer was produced.',
    oneshot: 'The provider ended the generation with an error: no answer was produced.',
  },
}

// `finishReason` is provider-controlled, so the lookup is own-property guarded:
// an unknown value must reach the generic fallback, never an inherited member.
export function emptyAnswerOutcome(finishReason, { mode = 'repl' } = {}) {
  if (Object.hasOwn(EMPTY_ANSWER_TEXTS, finishReason)) {
    const texts = EMPTY_ANSWER_TEXTS[finishReason]
    return { message: texts[mode] ?? texts.repl, retryable: false }
  }
  const reason = finishReason ? ` (finish reason: ${finishReason})` : ''
  return { message: `Provider returned no output${reason}.`, retryable: true }
}

// Unwraps a provider error body (OpenAI-compatible: `{ error: { message,
// code, metadata: { error_type } } }`, Venice `error.type`, or a bare string
// `{ error: "..." }`) into the fields the ApiError carries. Unknown shapes
// fall back to null so the caller keeps the existing truncated-raw-text path.
function parseProviderError(body) {
  const result = { code: null, errorType: null, message: null }
  if (typeof body !== 'string' || !body) return result
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return result
  }
  const err = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : parsed
  if (typeof err === 'string') {
    result.message = err
    return result
  }
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string') result.message = err.message
    if (err.code != null && (typeof err.code === 'string' || typeof err.code === 'number')) result.code = String(err.code)
    const meta = err.metadata
    if (meta && typeof meta === 'object' && typeof meta.error_type === 'string') result.errorType = meta.error_type
    else if (typeof err.type === 'string') result.errorType = err.type
  }
  return result
}

// True when the provider reports a 429 that means "the upstream is saturated"
// (OpenRouter `provider_at_capacity`, Venice `MODEL_OVERLOADED`) rather than a
// plain per-key rate limit. Those must be surfaced instead of silently
// auto-retried, which would just hammer a busy upstream.
function isProviderAtCapacity(errorType) {
  if (!errorType) return false
  return /at[-_]?capacity|overload|congestion/i.test(String(errorType))
}

export function makeHandleHttpError({ providerName, providerId = providerName, apiKeyEnv, notFoundMessage = null, retryable5xx = true }) {
  return function handleHttpError(status, body, meta = {}) {
    const parsed = parseProviderError(body)
    const retryAfter = typeof meta.retryAfter === 'number' ? meta.retryAfter : null
    const common = { status, provider: providerId, code: parsed.code, errorType: parsed.errorType, retryAfter }
    if (status === 401) {
      throw new ApiError(`Invalid API key. Check your ${apiKeyEnv} environment variable.`, { ...common, retryable: false })
    }
    if (status === 429) {
      const atCapacity = isProviderAtCapacity(parsed.errorType)
      const base = atCapacity
        ? `Rate limited by ${providerName}. The provider is at capacity.`
        : `Rate limited by ${providerName}. Wait a moment and try again.`
      const suffix = retryAfter != null ? ` Retry in ${Math.round(retryAfter)}s.` : ''
      throw new ApiError(base + suffix, { ...common, retryable: atCapacity ? false : true })
    }
    if (status === 404 && notFoundMessage) {
      throw new ApiError(notFoundMessage, { ...common, retryable: false })
    }
    // The provider's parsed message is a truer error than the raw body; fall
    // back to the raw body (capped) when it is not JSON or carries no
    // message. Both keep the capped length so a long error cannot span many
    // rows, and the OpenRouter ZDR remap (which matches the message against
    // /zdr|data retention/i) still sees the provider wording either way.
    const raw = typeof body === 'string' && body.length > 200 ? `${body.slice(0, 200)}...` : body
    const parsedMessage = parsed.message ? (parsed.message.length > 200 ? `${parsed.message.slice(0, 200)}...` : parsed.message) : null
    const detail = parsedMessage ?? raw
    // 5xx on a generation endpoint must not retry: a gateway 504 can fire
    // after the generation was already produced and billed server-side, so
    // re-POSTing would double the generation and the bill (429 stays
    // retryable — the server already rejected the request before doing work;
    // an at-capacity 429 is the one exception, surfaced instead of retried).
    throw new ApiError(`${providerName} request failed (${status}): ${detail}`, { ...common, retryable: status >= 500 && retryable5xx })
  }
}
