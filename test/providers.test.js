import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/errors.js'
import * as openrouter from '../src/providers/openrouter.js'
import * as venice from '../src/providers/venice.js'
import { getZdrIndex, getProviderPolicies, resetMetadataCaches } from '../src/providers/openrouter-meta.js'

function resetModels() {
  openrouter.resetModelCaches()
  venice.resetModelCaches()
}

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
  resetModels()
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
  resetModels()
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
  resetModels()
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
  resetModels()
  let calledWith
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calledWith = opts
    return jsonResponse({ data: [] })
  })

  await venice.fetchModels('')
  assert.equal(calledWith.headers.Authorization, undefined)
})

test('venice fetchEndpoints returns an empty list for an unknown model', async (t) => {
  resetModels()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ id: 'venice/known', name: 'Known' }],
  }))

  const endpoints = await venice.fetchEndpoints('key', 'venice/unknown')
  assert.deepEqual(endpoints, [])
})

test('openrouter 401 throws ApiError with friendly message, no retry', async (t) => {
  resetModels()
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

test('openrouter 404 throws friendly model-not-found message, no retry', async (t) => {
  resetModels()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: { message: 'Not Found', code: 404 } }, 404))

  await assert.rejects(
    openrouter.fetchEndpoints('key', 'nonexistent/model'),
    (err) => err instanceof ApiError
      && err.status === 404
      && err.retryable === false
      && err.message.includes('Model not found on OpenRouter')
      && err.message.includes('--list-models')
  )
  assert.equal(globalThis.fetch.mock.calls.length, 1)
})

test('venice 429 is retried twice then throws rate limited message', async (t) => {
  resetModels()
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
  resetModels()
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

test('openrouter fetchModels captures aliasTarget for tilde aliases', async (t) => {
  resetModels()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      { id: '~org/model-latest', name: 'Model Latest', alias_target: { slug: 'org/model-0731' } },
      { id: 'org/model', name: 'Model' },
    ],
  }))

  const models = await openrouter.fetchModels('key')
  assert.equal(models[0].aliasTarget, 'org/model-0731')
  assert.equal(models[1].aliasTarget, null)
})

test('openrouter fetchModels captures architecture and supported parameters', async (t) => {
  resetModels()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      {
        id: 'vision/model',
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['image_url', 'temperature'],
      },
      { id: 'plain/model' },
      { id: 'text/model', supported_parameters: ['temperature'] },
    ],
  }))

  const models = await openrouter.fetchModels('key')
  assert.deepEqual(models[0].architecture, { input_modalities: ['text', 'image'], output_modalities: [] })
  assert.deepEqual(models[0].supportedParameters, ['image_url', 'temperature'])
  assert.equal(models[0].visionSupported, true)
  assert.deepEqual(models[1].architecture, { input_modalities: [], output_modalities: [] })
  assert.equal(models[1].supportedParameters, null)
  assert.equal(models[1].visionSupported, undefined)
  assert.equal(models[2].visionSupported, false)
})

test('venice fetchModels normalizes vision support', async (t) => {
  resetModels()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      { id: 'vision', model_spec: { capabilities: { supportsVision: true } } },
      { id: 'text', model_spec: { capabilities: { supportsVision: false } } },
      { id: 'unknown', model_spec: { capabilities: {} } },
    ],
  }))

  const models = await venice.fetchModels('')
  assert.equal(models.find((m) => m.id === 'vision').visionSupported, true)
  assert.equal(models.find((m) => m.id === 'text').visionSupported, false)
  assert.equal(models.find((m) => m.id === 'unknown').visionSupported, undefined)
})

test('openrouter fetchEndpoints resolves tilde aliases to their target slug', async (t) => {
  resetModels()
  resetMetadataCaches()
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url)
    if (url.includes('/endpoints/zdr') || url.endsWith('/providers')) return jsonResponse({})
    return jsonResponse({ data: { endpoints: [
      { name: 'Provider', provider_name: 'Provider', tag: 'tag', status: 'online', pricing: {}, supported_parameters: [] },
    ] } })
  })

  const models = [{ id: '~org/model-latest', aliasTarget: 'org/model-0731' }]
  const endpoints = await openrouter.fetchEndpoints('key', '~org/model-latest', models)

  assert.equal(endpoints.length, 1)
  const endpointCalls = requested.filter((u) => u.includes('/endpoints') && !u.includes('/endpoints/zdr'))
  assert.equal(endpointCalls.length, 1)
  assert.ok(endpointCalls[0].endsWith('/models/org/model-0731/endpoints'), endpointCalls[0])
})

test('openrouter fetchEndpoints fetches models to resolve aliases when none are passed', async (t) => {
  resetModels()
  resetMetadataCaches()
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url)
    if (url.includes('/endpoints/zdr') || url.endsWith('/providers')) return jsonResponse({})
    if (url.endsWith('/models')) {
      return jsonResponse({ data: [{ id: '~org/model-latest', alias_target: { slug: 'org/model-0731' } }] })
    }
    if (url.includes('/endpoints')) {
      const alias = url.includes('~org')
      return alias
        ? jsonResponse({ data: { id: '~org/model-latest', endpoints: [] } })
        : jsonResponse({ data: { endpoints: [
          { name: 'Provider', provider_name: 'Provider', tag: 'tag', status: 'online', pricing: {}, supported_parameters: [] },
        ] } })
    }
    return jsonResponse({})
  })

  const endpoints = await openrouter.fetchEndpoints('key', '~org/model-latest')

  assert.equal(endpoints.length, 1)
  const routing = requested.filter((u) => (u.endsWith('/models') || u.includes('/endpoints')) && !u.includes('/endpoints/zdr'))
  assert.equal(routing.length, 3)
  assert.ok(routing[0].endsWith('/models/~org/model-latest/endpoints'), routing[0])
  assert.ok(routing[1].endsWith('/models'), routing[1])
  assert.ok(routing[2].endsWith('/models/org/model-0731/endpoints'), routing[2])
})

test('openrouter fetchEndpoints maps endpoint pricing and parameters', async (t) => {
  resetModels()
  resetMetadataCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/endpoints/zdr')) {
      return jsonResponse({ data: [{ provider_name: 'Provider', tag: 'tag1', model_id: 'org/model' }] })
    }
    if (url.endsWith('/providers')) {
      return jsonResponse({ data: [
        { name: 'Provider', privacy_policy_url: 'https://example.com/privacy', terms_of_service_url: 'https://example.com/tos' },
      ] })
    }
    return jsonResponse({
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
    })
  })

  const endpoints = await openrouter.fetchEndpoints('key', 'org/model')
  assert.equal(endpoints.length, 1)
  assert.equal(endpoints[0].providerName, 'Provider')
  assert.equal(endpoints[0].uptime30m, 99.5)
  assert.deepEqual(endpoints[0].supportedParameters, ['reasoning'])
  assert.equal(endpoints[0].zdr, true)
  assert.equal(endpoints[0].privacyPolicyURL, 'https://example.com/privacy')
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

test('openrouter chatCompletion adds ephemeral cache_control for anthropic models without a pinned provider', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
  })

  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' })
})

test('openrouter chatCompletion adds a 1h ttl cache_control for anthropic prompts at or above the caching minimum', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'system', content: 'x'.repeat(5000) }, { role: 'user', content: 'hi' }],
    onToken: () => {},
  })

  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('openrouter chatCompletion counts array content parts toward the caching minimum', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'x'.repeat(2500) },
        { type: 'text', text: 'y'.repeat(2500) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aa' } },
      ],
    }],
    onToken: () => {},
  })

  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('openrouter chatCompletion adds cache_control for tilde anthropic aliases', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: '~anthropic/claude-sonnet-latest',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
  })

  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' })
})

test('openrouter chatCompletion keeps cache_control when the pinned provider supports automatic caching', async (t) => {
  const sentBodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  for (const provider of ['Anthropic', 'Amazon Bedrock', 'Google Vertex AI', 'Microsoft Azure']) {
    await openrouter.chatCompletion({
      apiKey: 'key',
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: () => {},
      provider,
    })
  }

  assert.equal(sentBodies.length, 4)
  for (const body of sentBodies) {
    assert.deepEqual(body.cache_control, { type: 'ephemeral' })
  }
})

test('openrouter chatCompletion omits cache_control when the pinned provider does not support automatic caching', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    provider: 'Featherless',
  })

  assert.equal(sentBody.cache_control, undefined)
})

test('openrouter chatCompletion omits cache_control for non-anthropic models', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
  })

  assert.equal(sentBody.cache_control, undefined)
})

test('openrouter chatCompletion sends session_id only when unpinned', async (t) => {
  const sentBodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    sessionId: '2026-01-01T00-00-00',
  })
  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    sessionId: '2026-01-01T00-00-00',
    provider: 'OpenAI',
  })
  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
  })

  assert.equal(sentBodies[0].session_id, '2026-01-01T00-00-00')
  assert.equal(sentBodies[1].session_id, undefined)
  assert.equal(sentBodies[2].session_id, undefined)
})

test('openrouter chatCompletion sends cache_control and session_id together on unpinned anthropic requests', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    sessionId: '2026-01-01T00-00-00',
  })

  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' })
  assert.equal(sentBody.session_id, '2026-01-01T00-00-00')
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
    topP: 0.8,
  })
  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
  })

  assert.equal(sentBodies[0].temperature, 1.3)
  assert.equal(sentBodies[1].temperature, 0.7)
  assert.equal(sentBodies[0].top_p, 0.8)
  assert.equal(sentBodies[1].top_p, 0.95)
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
    topP: 0.6,
  })
  await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
  })

  assert.equal(sentBodies[0].temperature, 0.2)
  assert.equal(sentBodies[1].temperature, 0.7)
  assert.equal(sentBodies[0].top_p, 0.6)
  assert.equal(sentBodies[1].top_p, 0.95)
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

test('venice chatCompletion maps a disabled reasoning effort to none', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    reasoningEffort: null,
    supportsReasoning: true,
  })

  assert.equal(sentBody.reasoning_effort, 'none')
})

test('openrouter chatCompletion adds the web_search server tool with default max_results and max_total_results in auto mode', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    webSearch: 'auto',
  })

  assert.deepEqual(sentBody.tools, [{ type: 'openrouter:web_search', parameters: { max_results: 10, max_total_results: 10 } }])
  assert.equal(sentBody.plugins, undefined)
})

test('openrouter chatCompletion uses custom max_results and max_total_results in the server tool when webResults is set', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    webSearch: 'auto',
    webResults: 3,
  })

  assert.deepEqual(sentBody.tools, [{ type: 'openrouter:web_search', parameters: { max_results: 3, max_total_results: 3 } }])
})

test('openrouter chatCompletion uses the deprecated web plugin with default max_results in always mode', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    webSearch: 'always',
  })

  assert.deepEqual(sentBody.plugins, [{ id: 'web', max_results: 10 }])
  assert.equal(sentBody.tools, undefined)
})

test('openrouter chatCompletion uses custom max_results in the web plugin when webResults is set', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    webSearch: 'always',
    webResults: 3,
  })

  assert.deepEqual(sentBody.plugins, [{ id: 'web', max_results: 3 }])
})

test('openrouter chatCompletion never sends tools or plugins when web search is off', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    webSearch: 'off',
    webResults: 3,
  })

  assert.equal(sentBody.tools, undefined)
  assert.equal(sentBody.plugins, undefined)
})

test('venice chatCompletion maps auto/always/off to enable_web_search', async (t) => {
  const sentBodies = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await venice.chatCompletion({ apiKey: 'key', model: 'm', messages: [], onToken: () => {}, webSearch: 'auto' })
  await venice.chatCompletion({ apiKey: 'key', model: 'm', messages: [], onToken: () => {}, webSearch: 'always' })
  await venice.chatCompletion({ apiKey: 'key', model: 'm', messages: [], onToken: () => {}, webSearch: 'off' })
  await venice.chatCompletion({ apiKey: 'key', model: 'm', messages: [], onToken: () => {} })

  assert.equal(sentBodies[0].venice_parameters.enable_web_search, 'auto')
  assert.equal(sentBodies[0].venice_parameters.enable_web_citations, true)
  assert.equal(sentBodies[0].venice_parameters.include_search_results_in_stream, true)
  assert.equal(sentBodies[1].venice_parameters.enable_web_search, 'on')
  assert.equal(sentBodies[1].venice_parameters.enable_web_citations, true)
  assert.equal(sentBodies[1].venice_parameters.include_search_results_in_stream, true)
  assert.equal(sentBodies[2].venice_parameters.enable_web_search, 'off')
  assert.equal(sentBodies[2].venice_parameters.enable_web_citations, undefined)
  assert.equal(sentBodies[2].venice_parameters.include_search_results_in_stream, undefined)
  assert.equal(sentBodies[3].venice_parameters.enable_web_search, 'off')
  assert.equal(sentBodies[3].venice_parameters.enable_web_citations, undefined)
  assert.equal(sentBodies[3].venice_parameters.include_search_results_in_stream, undefined)
})

test('venice chatCompletion returns sources and forwards onSources', async (t) => {
  const citations = [{ title: 'One', url: 'https://one.example' }]
  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    sseEvent({
      venice_parameters: { web_search_citations: citations },
      choices: [{ delta: { content: 'See ^1^' } }],
    }),
    'data: [DONE]\n\n',
  ]))

  const seen = []
  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [],
    onToken: () => {},
    onSources: (sources) => seen.push(sources),
    webSearch: 'auto',
  })

  assert.deepEqual(result.sources, citations)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], result.sources)
})

test('openrouter chatCompletion returns sources on cache HIT', async (t) => {
  const annotations = [{ type: 'url_citation', url_citation: { title: 'One', url: 'https://one.example' } }]
  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    sseEvent({ choices: [{ delta: { content: 'cached' } }] }),
    sseEvent({ choices: [{ delta: { annotations } }] }),
    'data: [DONE]\n\n',
  ], { 'x-openrouter-cache-status': 'HIT' }))

  const result = await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
    webSearch: 'auto',
  })

  assert.deepEqual(result.sources, [{ title: 'One', url: 'https://one.example' }])
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true })
})

test('both providers accept the full documented option set without throwing', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  const fullOpts = {
    apiKey: 'key',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    provider: 'Provider',
    reasoningEffort: 'high',
    supportsReasoning: true,
    sessionId: '2026-01-01T00-00-00',
    temperature: 0.9,
    webSearch: 'auto',
    webResults: 3,
    zdr: true,
    signal: undefined,
  }

  await openrouter.chatCompletion(fullOpts)
  await venice.chatCompletion(fullOpts)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].provider, { order: ['Provider'], allow_fallbacks: false, zdr: true })
  assert.equal(calls[1].provider, undefined)
})

test('openrouter ignores supportsReasoning and maps sessionId to session_id', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    reasoningEffort: 'high',
    supportsReasoning: true,
    sessionId: '2026-01-01T00-00-00',
  })

  assert.equal(sentBody.prompt_cache_key, undefined)
  assert.equal(sentBody.sessionId, undefined)
  assert.equal(sentBody.session_id, '2026-01-01T00-00-00')
  assert.deepEqual(sentBody.reasoning, { effort: 'high', exclude: false })
  assert.deepEqual(Object.keys(sentBody).sort(), ['messages', 'model', 'reasoning', 'session_id', 'stream', 'temperature', 'top_p'])
})

test('venice maps sessionId to prompt_cache_key with the full option set', async (t) => {
  let sentBody
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sentBody = JSON.parse(opts.body)
    return sseResponse([sseEvent({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
  })

  await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    provider: 'Provider',
    reasoningEffort: 'high',
    supportsReasoning: true,
    sessionId: '2026-01-01T00-00-00',
    temperature: 0.9,
    webSearch: 'auto',
    webResults: 3,
  })

  assert.equal(sentBody.prompt_cache_key, '2026-01-01T00-00-00')
  assert.equal(sentBody.reasoning_effort, 'high')
  assert.equal(sentBody.venice_parameters.enable_web_search, 'auto')
  assert.equal(sentBody.temperature, 0.9)
})

test('openrouter meta declares zero-retention support', () => {
  assert.equal(openrouter.meta.supportsZdr, true)
})

test('isZdrIndexDegraded reflects index fetch success and failure', async (t) => {
  resetMetadataCaches()
  let fail = true
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new TypeError('boom')
    return jsonResponse({ data: [{ provider_name: 'X', tag: 'x', model_id: 'org/model' }] })
  })

  assert.equal(await openrouter.isZdrIndexDegraded(), true)
  resetMetadataCaches()
  fail = false
  assert.equal(await openrouter.isZdrIndexDegraded(), false)
  assert.equal((await getZdrIndex()).tags.has('x'), true)
})

test('openrouter fetchModels marks models that have zero-retention endpoints', async (t) => {
  resetModels()
  resetMetadataCaches()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/endpoints/zdr')) {
      return jsonResponse({ data: [
        { provider_name: 'X', tag: 'x', model_id: 'org/model' },
        { provider_name: 'Y', tag: 'y', model_id: 'other/model' },
      ] })
    }
    return jsonResponse({ data: [
      { id: 'org/model', name: 'Model', context_length: 1000 },
      { id: 'plain/model', name: 'Plain', context_length: 1000 },
      { id: '~org/alias', alias_target: { slug: 'org/model' } },
    ] })
  })

  const models = await openrouter.fetchModels('key', { zdr: true })
  assert.equal(models.find((m) => m.id === 'org/model').zdr, true)
  assert.equal(models.find((m) => m.id === 'plain/model').zdr, undefined)
  assert.equal(models.find((m) => m.id === '~org/alias').zdr, true)
})

test('chatCompletion sends provider.zdr only when zdr is set', async (t) => {
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
    provider: 'Provider',
    zdr: true,
  })
  await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
    provider: 'Provider',
  })

  assert.deepEqual(sentBodies[0].provider, { order: ['Provider'], allow_fallbacks: false, zdr: true })
  assert.deepEqual(sentBodies[1].provider, { order: ['Provider'], allow_fallbacks: false })
})

test('chatCompletion rewrites a 400 ZDR rejection with a friendly hint', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(
    { error: { message: 'Provider does not support ZDR' } },
    400
  ))

  await assert.rejects(
    openrouter.chatCompletion({
      apiKey: 'key',
      model: 'org/model',
      messages: [],
      onToken: () => {},
      provider: 'Provider',
      zdr: true,
    }),
    (err) => err instanceof ApiError
      && err.status === 400
      && err.message.includes('ZDR request failed')
      && err.message.includes('zero data retention')
  )
})

test('venice scrapePage posts the url with Bearer auth and returns the markdown', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts })
    return jsonResponse({ url: 'https://example.com/article', content: '# Title\n\nBody', format: 'markdown' })
  })

  const result = await venice.scrapePage({ apiKey: 'key', url: 'https://example.com/article' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.venice.ai/api/v1/augment/scrape')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer key')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { url: 'https://example.com/article' })
  assert.deepEqual(result, { url: 'https://example.com/article', content: '# Title\n\nBody', format: 'markdown' })
})

test('venice scrapePage surfaces blocked-site 400s as ApiError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'Cannot scrape this page' }, 400))

  await assert.rejects(
    () => venice.scrapePage({ apiKey: 'key', url: 'https://x.com/post' }),
    (err) => err instanceof ApiError && err.status === 400 && err.message.includes('Cannot scrape this page')
  )
})

test('metadata indexes cache within the TTL and degrade to empty on failure', async (t) => {
  resetMetadataCaches()
  let zdrCalls = 0
  let providerCalls = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/endpoints/zdr')) {
      zdrCalls++
      return jsonResponse({ data: [{ provider_name: 'X', tag: 'x', model_id: 'org/model' }] })
    }
    providerCalls++
    return jsonResponse({ data: [{ name: 'X', privacy_policy_url: 'https://example.com/privacy' }] })
  })

  const first = await getZdrIndex()
  assert.equal(first.tags.has('x'), true)
  assert.equal(first.modelIds.has('org/model'), true)
  await getZdrIndex()
  assert.equal(zdrCalls, 1)

  const policies = await getProviderPolicies()
  assert.equal(policies.get('X').privacyPolicyURL, 'https://example.com/privacy')
  await getProviderPolicies()
  assert.equal(providerCalls, 1)

  resetMetadataCaches()
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('boom') })
  const degraded = await getZdrIndex()
  assert.equal(degraded.tags.size, 0)
  assert.equal(degraded.modelIds.size, 0)
  assert.equal(degraded.degraded, true)
  const noPolicies = await getProviderPolicies()
  assert.equal(noPolicies.size, 0)
})
