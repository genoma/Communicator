import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModelsCmd } from '../src/commands/list-models.js'

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
