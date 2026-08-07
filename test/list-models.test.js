import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModelsCmd, listImageModelsCmd } from '../src/commands/list-models.js'

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
