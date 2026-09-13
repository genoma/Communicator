import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as openrouter from '../src/providers/openrouter.js'
import * as venice from '../src/providers/venice.js'
import { getZdrIndex, getProviderPolicies, resetMetadataCaches } from '../src/providers/openrouter-meta.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('openrouter fetchModels serves repeated catalog reads from the text model cache', async (t) => {
  openrouter.resetModelCaches()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return jsonResponse({ data: [{ id: 'org/model', name: 'Model', context_length: 1000 }] })
  })

  const first = await openrouter.fetchModels('key')
  const second = await openrouter.fetchModels('key')

  assert.equal(calls, 1)
  assert.equal(second, first)
  assert.equal(second[0].id, 'org/model')

  openrouter.resetModelCaches()
  await openrouter.fetchModels('key')
  assert.equal(calls, 2)
})

test('venice fetchModels serves repeated catalog reads from the text model cache', async (t) => {
  venice.resetModelCaches()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++
    assert.ok(String(url).endsWith('/models?type=text'), String(url))
    return jsonResponse({ data: [{ id: 'venice-text-1', model_spec: { name: 'Text One' } }] })
  })

  const first = await venice.fetchModels('key')
  const second = await venice.fetchModels('key')

  assert.equal(calls, 1)
  assert.equal(second, first)
  assert.equal(second[0].id, 'venice-text-1')

  venice.resetModelCaches()
  await venice.fetchModels('key')
  assert.equal(calls, 2)
})

test('concurrent getZdrIndex callers share one in-flight request', async (t) => {
  resetMetadataCaches()
  let calls = 0
  const gate = deferred()
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await gate.promise
    return jsonResponse({ data: [{ provider_name: 'X', tag: 'x', model_id: 'org/model' }] })
  })

  const first = getZdrIndex()
  const second = getZdrIndex()
  const third = getZdrIndex()
  gate.resolve()
  const [a, b, c] = await Promise.all([first, second, third])

  assert.equal(calls, 1)
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(a.degraded, false)
  assert.equal(a.tags.has('x'), true)
  assert.equal(a.modelIds.has('org/model'), true)
})

test('concurrent getProviderPolicies callers share one in-flight request', async (t) => {
  resetMetadataCaches()
  let calls = 0
  const gate = deferred()
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await gate.promise
    return jsonResponse({ data: [{ name: 'X', privacy_policy_url: 'https://example.com/privacy' }] })
  })

  const first = getProviderPolicies()
  const second = getProviderPolicies()
  gate.resolve()
  const [a, b] = await Promise.all([first, second])

  assert.equal(calls, 1)
  assert.equal(a, b)
  assert.equal(a.get('X').privacyPolicyURL, 'https://example.com/privacy')
})

test('getZdrIndex does not retry a failed metadata fetch and caches the degraded index', async (t) => {
  resetMetadataCaches()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new TypeError('boom')
  })

  const index = await getZdrIndex()

  assert.equal(calls, 1)
  assert.equal(index.degraded, true)
  assert.equal(index.tags.size, 0)
  assert.equal(index.modelIds.size, 0)

  assert.equal(await getZdrIndex(), index)
  assert.equal(calls, 1)
})

test('getProviderPolicies does not retry a failed metadata fetch and caches the empty policy map', async (t) => {
  resetMetadataCaches()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new TypeError('boom')
  })

  const policies = await getProviderPolicies()

  assert.equal(calls, 1)
  assert.equal(policies.size, 0)

  assert.equal(await getProviderPolicies(), policies)
  assert.equal(calls, 1)
})
