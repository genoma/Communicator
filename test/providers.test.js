import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/errors.js'
import * as openrouter from '../src/providers/openrouter.js'
import * as venice from '../src/providers/venice.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sseResponse(chunks, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

test('openrouter fetchModels maps API models with pricing: null', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      { id: 'org/model', name: 'Model', context_length: 1000, description: 'desc' },
    ],
  }))

  const models = await openrouter.fetchModels('key')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'org/model')
  assert.equal(models[0].provider, 'org')
  assert.equal(models[0].contextLength, 1000)
  assert.equal(models[0].pricing, null)
  assert.equal(models[0].reasoning, null)
})

test('openrouter fetchModels normalizes reasoning metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      {
        id: 'effort-model',
        reasoning: {
          supported_efforts: ['high', 'medium', 'low'],
          default_effort: 'medium',
          default_enabled: true,
          mandatory: false,
        },
      },
      {
        id: 'auto-model',
        reasoning: { mandatory: false },
      },
      {
        id: 'mandatory-model',
        reasoning: { supported_efforts: ['high'], default_effort: 'high', mandatory: true },
      },
      {
        id: 'off-by-default',
        reasoning: { supported_efforts: ['high'], default_effort: 'high', default_enabled: false },
      },
    ],
  }))

  const models = await openrouter.fetchModels('key')

  const effort = models.find((m) => m.id === 'effort-model').reasoning
  assert.equal(effort.supported, true)
  assert.equal(effort.supportsEffort, true)
  assert.deepEqual(effort.supported_efforts, ['high', 'medium', 'low'])
  assert.equal(effort.default_effort, 'medium')
  assert.equal(effort.mandatory, false)
  assert.equal(effort.default_enabled, true)

  const auto = models.find((m) => m.id === 'auto-model').reasoning
  assert.equal(auto.supported, true)
  assert.equal(auto.supportsEffort, false)
  assert.equal(auto.supported_efforts, null)
  assert.equal(auto.default_effort, null)
  assert.equal(auto.default_enabled, true)

  const mandatory = models.find((m) => m.id === 'mandatory-model').reasoning
  assert.equal(mandatory.mandatory, true)
  assert.equal(mandatory.default_enabled, true)

  const offByDefault = models.find((m) => m.id === 'off-by-default').reasoning
  assert.equal(offByDefault.default_enabled, false)
})

test('venice fetchModels normalizes pricing and hides raw fields', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      {
        id: 'venice-model',
        model_spec: {
          name: 'Venice Model',
          availableContextTokens: 200000,
          pricing: { input: { usd: 2.5 }, output: { usd: 10 } },
          privacy: 'anonymized',
          capabilities: { supportsReasoning: true, supportsReasoningEffort: false },
          description: 'A model',
        },
      },
    ],
  }))

  const models = await venice.fetchModels('')
  assert.equal(models.length, 1)
  const m = models[0]
  assert.equal(m.pricing.prompt, 0.0000025)
  assert.equal(m.pricing.completion, 0.00001)
  assert.equal(m.capabilities.privacy, 'anonymized')
  assert.equal(m._rawPricing, undefined)
  assert.equal(m.privacy, undefined)
  assert.equal(m.reasoning.supportsEffort, false)
})

test('venice fetchModels works without an api key', async (t) => {
  let calledWith
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calledWith = opts
    return jsonResponse({ data: [] })
  })

  await venice.fetchModels('')
  assert.equal(calledWith.headers.Authorization, undefined)
})

test('openrouter 401 throws ApiError with friendly message, no retry', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 401 }))

  await assert.rejects(
    openrouter.fetchModels('bad-key'),
    (err) => err instanceof ApiError
      && err.status === 401
      && err.retryable === false
      && err.message.includes('Invalid API key')
  )
  assert.equal(globalThis.fetch.mock.calls.length, 1)
})

test('venice 429 is retried twice then throws rate limited message', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('slow down', { status: 429 })
  })

  await assert.rejects(
    venice.fetchModels('key'),
    (err) => err instanceof ApiError && err.status === 429 && err.message.includes('Rate limited by Venice')
  )
  assert.equal(calls, 3)
})

test('network errors are retried with backoff before succeeding', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls < 3) throw new TypeError('fetch failed')
    return jsonResponse({ data: [] })
  })

  const models = await openrouter.fetchModels('key')
  assert.deepEqual(models, [])
  assert.equal(calls, 3)
})

test('openrouter fetchEndpoints maps endpoint pricing and parameters', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: {
      endpoints: [
        {
          name: 'Provider',
          provider_name: 'Provider',
          tag: 'tag1',
          status: 'online',
          uptime_last_30m: 99.5,
          pricing: { prompt: '0.0000015', completion: '0.000006' },
          context_length: 1000,
          max_completion_tokens: 500,
          supported_parameters: ['reasoning'],
        },
      ],
    },
  }))

  const endpoints = await openrouter.fetchEndpoints('key', 'org/model')
  assert.equal(endpoints.length, 1)
  assert.equal(endpoints[0].providerName, 'Provider')
  assert.equal(endpoints[0].uptime30m, 99.5)
  assert.deepEqual(endpoints[0].supportedParameters, ['reasoning'])
})

test('chatCompletion streams tokens and usage for openrouter', async (t) => {
  const cacheHeaders = { 'x-openrouter-cache-status': 'MISS' }
  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    sseEvent({ choices: [{ delta: { content: 'Hel' } }] }),
    sseEvent({ choices: [{ delta: { content: 'lo' } }] }),
    sseEvent({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    'data: [DONE]\n\n',
  ], cacheHeaders))

  const tokens = []
  const result = await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (t, type) => tokens.push([type, t]),
    provider: 'Provider',
  })

  assert.equal(result.content, 'Hello')
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  assert.deepEqual(tokens, [['content', 'Hel'], ['content', 'lo']])
})

test('openrouter cache HIT zeroes usage and marks cacheHit', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sseResponse(
    [sseEvent({ choices: [{ delta: { content: 'cached' } }] }), 'data: [DONE]\n\n'],
    { 'x-openrouter-cache-status': 'HIT' }
  ))

  const result = await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
  })

  assert.equal(result.content, 'cached')
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true })
})

test('chatCompletion maps null reasoningEffort to reasoning disabled body', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
    reasoningEffort: null,
  })

  assert.deepEqual(sentBody.reasoning, { enabled: false })
})

test('chatCompletion sends temperature in the request body for openrouter', async (t) => {
  const sentBodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
    temperature: 1.3,
  })
  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
  })

  assert.equal(sentBodies[0].temperature, 1.3)
  assert.equal(sentBodies[1].temperature, 0.7)
})

test('chatCompletion sends temperature in the request body for venice', async (t) => {
  const sentBodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    temperature: 0.2,
  })
  await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
  })

  assert.equal(sentBodies[0].temperature, 0.2)
  assert.equal(sentBodies[1].temperature, 0.7)
})

test('chatCompletion maps truthy reasoningEffort to reasoning effort body', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
    reasoningEffort: 'high',
  })

  assert.deepEqual(sentBody.reasoning, { effort: 'high', exclude: false })
})

test('chatCompletion maps venice sessionId to prompt_cache_key', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    sessionId: '2026-01-01T00-00-00',
    reasoningEffort: 'high',
    supportsReasoning: true,
  })

  assert.equal(sentBody.prompt_cache_key, '2026-01-01T00-00-00')
  assert.equal(sentBody.reasoning_effort, 'high')
  assert.equal(result.content, 'ok')
})
