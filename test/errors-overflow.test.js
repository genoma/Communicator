import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, makeHandleHttpError, isContextOverflowError, overflowErrorText, emptyAnswerOutcome } from '../src/errors.js'

const handleOpenRouterError = makeHandleHttpError({ providerName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY' })
const handleVeniceError = makeHandleHttpError({ providerName: 'Venice', apiKeyEnv: 'VENICE_API_KEY' })

// The classifier receives the error the provider path actually threw, not a
// hand-shaped object: this unwraps the handler's throw the same way a caller
// would catch it.
function thrownError(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

// Live OpenRouter pre-flight over-window 400 (probed): wording only, the
// numeric code 400, no error_type and no usage.
const OPENROUTER_OVERFLOW_BODY = JSON.stringify({
  error: {
    message: "This endpoint's maximum context length is 16384 tokens. However, you requested about 26265 tokens (26255 of text input, 10 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
    code: 400,
    metadata: { provider_name: null },
  },
})

// Live Venice pre-flight over-window 400 (probed): `error` is a plain string.
const VENICE_OVERFLOW_BODY = JSON.stringify({
  error: "The input (35034 tokens) is longer than the model's context length (32768 tokens).",
  request_id: 'rjtN3RKyJaSf2OZOmtVbo',
})

test('the OpenRouter pre-flight over-window 400 classifies as a context overflow', () => {
  const err = thrownError(() => handleOpenRouterError(400, OPENROUTER_OVERFLOW_BODY))
  assert.ok(err instanceof ApiError)
  assert.equal(err.status, 400)
  assert.equal(err.errorType, null)
  assert.equal(isContextOverflowError(err), true)
})

test('the Venice pre-flight over-window 400 with a plain-string body classifies as a context overflow', () => {
  const err = thrownError(() => handleVeniceError(400, VENICE_OVERFLOW_BODY))
  assert.ok(err instanceof ApiError)
  assert.equal(err.code, null)
  assert.equal(isContextOverflowError(err), true)
})

test('a typed context_length_exceeded error classifies as a context overflow', () => {
  const err = new ApiError('Provider error', { errorType: 'context_length_exceeded' })
  assert.equal(isContextOverflowError(err), true)
})

test('a TOO_MANY_TOKENS code with the Venice docs wording classifies as a context overflow', () => {
  const err = new ApiError("Your request exceeds the model's maximum context. Please reduce your prompt or completion length.", { code: 'TOO_MANY_TOKENS' })
  assert.equal(isContextOverflowError(err), true, 'the typed code is a bonus signal')
  assert.equal(isContextOverflowError(new ApiError('Provider error', { code: 'TOO_MANY_TOKENS' })), true, 'the code alone classifies without wording')
})

test('message-only overflow wordings classify without any typed field', () => {
  // Venice's documented wording and OpenRouter's combined-token wording ship
  // no code or error_type at all, so the message regexes alone classify them.
  assert.equal(
    isContextOverflowError(new ApiError("Your request exceeds the model's maximum context. Please reduce your prompt or completion length.")),
    true,
  )
  assert.equal(
    isContextOverflowError(new ApiError("The combined input and output tokens exceed the model's context window.")),
    true,
  )
  // The typed classification is case-insensitive.
  assert.equal(isContextOverflowError(new ApiError('Provider error', { errorType: 'CONTEXT_LENGTH_EXCEEDED' })), true)
})

test('rate limits and unrelated 400s do not classify as a context overflow', () => {
  const rateLimited = thrownError(() => handleOpenRouterError(429, JSON.stringify({ error: { message: 'Rate limit exceeded' } })))
  assert.equal(isContextOverflowError(rateLimited), false)
  const invalidModel = thrownError(() => handleOpenRouterError(400, JSON.stringify({ error: { message: 'Invalid model id' } })))
  assert.equal(isContextOverflowError(invalidModel), false)
  assert.equal(isContextOverflowError(new ApiError('Content generated was filtered', { retryable: false, errorType: 'content_filter' })), false)
})

test('a plain Error and non-object values do not classify as a context overflow', () => {
  assert.equal(isContextOverflowError(new Error('boom')), false)
  assert.equal(isContextOverflowError('maximum context length exceeded'), false)
  assert.equal(isContextOverflowError(null), false)
  assert.equal(isContextOverflowError(undefined), false)
})

test('overflowErrorText returns the exact mode-specific texts', () => {
  assert.equal(
    overflowErrorText({ phase: 'preflight', mode: 'repl' }),
    "Request exceeds this model's context window; retrying unchanged will fail. Shorten it with /edit or /delete, start fresh with /new, or switch to a larger-window /model.",
  )
  assert.equal(
    overflowErrorText({ phase: 'mid-generation', mode: 'repl' }),
    'The model hit its context window before finishing; retrying unchanged will fail. Shorten it with /edit or /delete, start fresh with /new, or switch to a larger-window /model.',
  )
  assert.equal(
    overflowErrorText({ phase: 'preflight', mode: 'oneshot' }),
    "The request exceeds the model's context window. Retry with a shorter prompt or less history.",
  )
  assert.equal(
    overflowErrorText({ phase: 'mid-generation', mode: 'oneshot' }),
    'The model hit its context window before finishing. Retry with a shorter prompt or less history.',
  )
})

test('overflowErrorText defaults to the REPL pre-flight text', () => {
  assert.equal(overflowErrorText(), overflowErrorText({ phase: 'preflight', mode: 'repl' }))
})

test('emptyAnswerOutcome returns the exact classified texts and non-retryable flag', () => {
  assert.deepEqual(emptyAnswerOutcome('length'), {
    message: 'Output limit reached: no answer was produced (the model used its whole output budget before writing content). Lower /reasoning effort or shorten the request.',
    retryable: false,
  })
  assert.deepEqual(emptyAnswerOutcome('length', { mode: 'oneshot' }), {
    message: 'Output limit reached: no answer was produced (the model used its whole output budget before writing content). Lower the reasoning effort or shorten the prompt.',
    retryable: false,
  })
  assert.deepEqual(emptyAnswerOutcome('content_filter'), {
    message: "Blocked by the provider's content filter: no answer was produced. Edit the message (/edit) or change the request.",
    retryable: false,
  })
  assert.deepEqual(emptyAnswerOutcome('content_filter', { mode: 'oneshot' }), {
    message: "Blocked by the provider's content filter: no answer was produced. Change the request and try again.",
    retryable: false,
  })
  assert.deepEqual(emptyAnswerOutcome('error'), {
    message: 'The provider ended the generation with an error: no answer was produced.',
    retryable: false,
  })
  assert.deepEqual(emptyAnswerOutcome('error', { mode: 'oneshot' }), {
    message: 'The provider ended the generation with an error: no answer was produced.',
    retryable: false,
  })
})

test('emptyAnswerOutcome keeps the generic retryable verdict for stop, null and unknown reasons', () => {
  for (const reason of ['stop', 'tool_calls', 'made_up_reason']) {
    assert.deepEqual(emptyAnswerOutcome(reason), {
      message: `Provider returned no output (finish reason: ${reason}).`,
      retryable: true,
    })
  }
  assert.deepEqual(emptyAnswerOutcome(null), { message: 'Provider returned no output.', retryable: true })
  assert.deepEqual(emptyAnswerOutcome(undefined, { mode: 'oneshot' }), { message: 'Provider returned no output.', retryable: true })
  // The provider controls this string, so an inherited Object member must not
  // become a classified reason with an undefined message.
  assert.deepEqual(emptyAnswerOutcome('constructor'), { message: 'Provider returned no output (finish reason: constructor).', retryable: true })
})

test('the one-shot empty-answer texts never name REPL-only commands', () => {
  for (const reason of ['length', 'content_filter', 'error', 'stop', null]) {
    const { message } = emptyAnswerOutcome(reason, { mode: 'oneshot' })
    assert.ok(!/\/(?:edit|delete|new|reasoning)\b/.test(message), message)
  }
  // The REPL texts are the ones that name the commands the user can reach.
  assert.match(emptyAnswerOutcome('length').message, /\/reasoning/)
  assert.match(emptyAnswerOutcome('content_filter').message, /\/edit/)
})
