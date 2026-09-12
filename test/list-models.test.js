import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModelsCmd, listImageModelsCmd } from '../src/commands/list-models.js'
import * as openrouter from '../src/providers/openrouter.js'
import { resetMetadataCaches } from '../src/providers/openrouter-meta.js'

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  return {
    allLogs: () => console.log.mock.calls.map((c) => String(c.arguments[0])),
  }
}

test('listModelsCmd tags vision-capable models', async (t) => {
  const consoleSpy = mockConsole(t)
  const provider = {
    async fetchModels() {
      return [
        { id: 'eye/model', name: 'Eye', contextLength: 128000, visionSupported: true, pricing: null },
        { id: 'plain/model', name: 'Plain', contextLength: 128000, visionSupported: false, pricing: null },
        { id: 'unknown/model', name: 'Unknown', contextLength: null, pricing: null },
      ]
    },
  }

  await listModelsCmd(provider, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 3)
  assert.ok(lines[0].includes('Eye') && lines[0].includes('[vision]'))
  assert.ok(lines[0].includes('128,000 ctx'))
  assert.ok(!lines[1].includes('[vision]'))
  assert.ok(!lines[2].includes('[vision]'))
})

test('listImageModelsCmd prints name, id, per-image price and sizing constraints', async (t) => {
  const consoleSpy = mockConsole(t)
  const provider = {
    async fetchImageModels() {
      return [
        {
          id: 'flux-1-1',
          name: 'Flux 1.1',
          pricing: { perImage: 0.02, byResolution: null, byQuality: null },
          constraints: {
            aspectRatios: ['1:1', '16:9'],
            resolutions: ['1K', '2K'],
            qualities: ['low', 'high'],
          },
          privacy: 'anonymized',
          offline: false,
        },
        {
          id: 'cheap-flux',
          name: 'Cheap Flux',
          pricing: { perImage: null, byResolution: { '1K': 0.01 }, byQuality: null },
          constraints: { aspectRatios: null, resolutions: null, qualities: null },
          privacy: null,
          offline: true,
        },
      ]
    },
  }

  await listImageModelsCmd(provider, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('Flux 1.1'))
  assert.ok(lines[0].includes('flux-1-1'))
  assert.ok(lines[0].includes('$0.02 per image'))
  assert.ok(lines[0].includes('[aspect: 1:1, 16:9]'))
  assert.ok(lines[0].includes('[resolution: 1K, 2K]'))
  assert.ok(lines[0].includes('[quality: low, high]'))
  assert.ok(lines[0].includes('[anonymized]'))
  assert.ok(lines[1].includes('from $0.01 per image'))
  assert.ok(lines[1].includes('[offline]'))
})

test('listImageModelsCmd prints token-billed prices per 1M tokens', async (t) => {
  const consoleSpy = mockConsole(t)
  const provider = {
    async fetchImageModels() {
      return [
        {
          id: 'openai/gpt-image-1',
          name: 'GPT Image 1',
          pricing: { perImage: null, perToken: 0.00004, byResolution: null, byQuality: null },
          constraints: { aspectRatios: null, resolutions: null, qualities: null },
          privacy: null,
          offline: false,
        },
        {
          id: 'unknown/price',
          name: 'No Price',
          pricing: { perImage: null, perToken: null, byResolution: null, byQuality: null },
          constraints: { aspectRatios: null, resolutions: null, qualities: null },
          privacy: null,
          offline: false,
        },
      ]
    },
  }

  await listImageModelsCmd(provider, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('$40.00 per 1M tokens'))
  assert.ok(lines[1].includes('?'))
})

test('listModelsCmd strips terminal escape sequences from remote catalog fields', async (t) => {
  const consoleSpy = mockConsole(t)
  const provider = {
    async fetchModels() {
      return [
        {
          id: 'escape/model',
          name: 'Escape',
          contextLength: 128000,
          visionSupported: true,
          pricing: { prompt: 0.000001, completion: 0.000002 },
          capabilities: { privacy: '\x1b[2Janonymized\x1b[0m' },
        },
      ]
    },
  }

  await listModelsCmd(provider, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\x1b'))
  assert.ok(lines[0].includes('[anonymized]'))
})

test('listImageModelsCmd strips terminal escape sequences from remote constraint lists', async (t) => {
  const consoleSpy = mockConsole(t)
  const provider = {
    async fetchImageModels() {
      return [
        {
          id: 'escape/image',
          name: 'Escape Image',
          pricing: { perImage: 0.02, byResolution: null, byQuality: null },
          constraints: {
            aspectRatios: ['1:1', '\x1b[31m16:9\x1b[0m'],
            resolutions: ['\x1b[2J1K'],
            qualities: ['low'],
          },
          privacy: 'anonymized\x1b]0;title\x07',
          offline: false,
        },
      ]
    },
  }

  await listImageModelsCmd(provider, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\x1b'))
  assert.ok(lines[0].includes('[aspect: 1:1, 16:9]'))
  assert.ok(lines[0].includes('[resolution: 1K]'))
})

test('listImageModelsCmd requests pricing for OpenRouter and prints from-price rows with tags', async (t) => {
  const consoleSpy = mockConsole(t)
  let pricingRequested = false
  const provider = {
    async fetchImageModels(apiKey, { withPricing } = {}) {
      pricingRequested = withPricing === true
      return [
        {
          id: 'openai/gpt-image-1-mini',
          name: 'GPT Image 1 Mini',
          pricing: { perImage: 0.0085, byResolution: null, byQuality: null },
          constraints: {
            aspectRatios: ['1:1', '3:2', '2:3', 'auto'],
            formats: null,
            resolutions: ['1024x1024'],
            qualities: null,
          },
          privacy: null,
          offline: false,
        },
      ]
    },
  }

  await listImageModelsCmd(provider, 'key')

  assert.equal(pricingRequested, true)
  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('GPT Image 1 Mini'))
  assert.ok(lines[0].includes('openai/gpt-image-1-mini'))
  assert.ok(lines[0].includes('$0.009 per image'))
  assert.ok(lines[0].includes('[aspect: 1:1, 3:2, 2:3, auto]'))
  assert.ok(lines[0].includes('[resolution: 1024x1024]'))
})

test('listModelsCmd asks for ZDR tags on a ZDR-capable provider and prints them', async (t) => {
  const consoleSpy = mockConsole(t)
  const calls = []
  const provider = {
    meta: { supportsZdr: true },
    async fetchModels(apiKey, options) {
      calls.push(options)
      return [
        { id: 'zdr/model', name: 'Zdr', contextLength: 1000, zdr: true, pricing: null },
        { id: 'plain/model', name: 'Plain', contextLength: 1000, pricing: null },
      ]
    },
  }

  await listModelsCmd(provider, 'key')

  assert.deepEqual(calls, [{ zdr: true }])
  const lines = consoleSpy.allLogs()
  assert.ok(lines[0].includes('[zdr]'))
  assert.ok(!lines[1].includes('[zdr]'))
})

test('listModelsCmd leaves the listing untagged on a provider without a ZDR index', async (t) => {
  const consoleSpy = mockConsole(t)
  const calls = []
  const provider = {
    meta: { hasEndpoints: false },
    async fetchModels(apiKey, options) {
      calls.push(options)
      return [{ id: 'plain/model', name: 'Plain', contextLength: 1000, pricing: null }]
    },
  }

  await listModelsCmd(provider, 'key')

  assert.deepEqual(calls, [{ zdr: false }])
  assert.ok(!consoleSpy.allLogs()[0].includes('[zdr]'))
})

test('listModelsCmd leaves the listing untagged when the ZDR index is unavailable', async (t) => {
  const consoleSpy = mockConsole(t)
  openrouter.resetModelCaches()
  resetMetadataCaches()
  t.after(() => {
    openrouter.resetModelCaches()
    resetMetadataCaches()
  })
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/endpoints/zdr')) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify({ data: [{ id: 'org/model', name: 'Model', context_length: 1000 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  await listModelsCmd(openrouter, 'key')

  const lines = consoleSpy.allLogs()
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('org/model'))
  assert.ok(!lines[0].includes('[zdr]'))
})
