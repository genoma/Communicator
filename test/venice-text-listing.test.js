import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as venice from '../src/providers/venice.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('venice fetchModels builds the full listing line with price, reasoning, privacy and the description below it', async (t) => {
  venice.resetModelCaches()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      {
        id: 'venice-text-1',
        model_spec: {
          name: 'Text One',
          availableContextTokens: 200000,
          pricing: { input: { usd: 2.5 }, output: { usd: 10 } },
          privacy: 'anonymized',
          capabilities: { supportsReasoning: true, supportsReasoningEffort: true },
          description: 'A descriptive line',
        },
      },
    ],
  }))

  const [m] = await venice.fetchModels('key')

  assert.equal(m.description, '200,000 ctx  |  in $2.50 / out $10.00 per 1M  |  reasoning  |  anonymized\nA descriptive line')
  assert.equal(m.contextLength, 200000)
  assert.equal(m.capabilities.privacy, 'anonymized')
})

test('venice fetchModels falls back to the unknown-context marker and a single-line description', async (t) => {
  venice.resetModelCaches()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ id: 'venice-min', model_spec: { name: 'Minimal' } }],
  }))

  const [m] = await venice.fetchModels('key')

  assert.equal(m.description, '? ctx  |  ?')
  assert.equal(m.contextLength, null)
  assert.ok(!m.description.includes('\n'), m.description)
})

test('venice fetchModels labels reasoning models with reasoning or auto-reasoning', async (t) => {
  venice.resetModelCaches()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [
      { id: 'effort', model_spec: { capabilities: { supportsReasoning: true, supportsReasoningEffort: true } } },
      { id: 'auto', model_spec: { capabilities: { supportsReasoning: true } } },
      { id: 'none', model_spec: { capabilities: {} } },
    ],
  }))

  const models = await venice.fetchModels('key')
  const description = (id) => models.find((m) => m.id === id).description

  assert.equal(description('effort'), '? ctx  |  ?  |  reasoning')
  assert.equal(description('auto'), '? ctx  |  ?  |  auto-reasoning')
  assert.equal(description('none'), '? ctx  |  ?')
})

test('venice fetchModels omits the privacy segment when the catalog advertises none', async (t) => {
  venice.resetModelCaches()
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    data: [{ id: 'venice-plain', model_spec: { availableContextTokens: 4096, capabilities: {} } }],
  }))

  const [m] = await venice.fetchModels('key')

  assert.equal(m.description, '4,096 ctx  |  ?')
})
