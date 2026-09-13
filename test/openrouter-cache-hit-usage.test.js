import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as openrouter from '../src/providers/openrouter.js'

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

test('openrouter cache HIT with a usage chunk marks cacheHit and keeps the usage counts', { timeout: 5000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    sseEvent({ choices: [{ delta: { content: 'cached' } }] }),
    sseEvent({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
    'data: [DONE]\n\n',
  ], { 'x-openrouter-cache-status': 'HIT' }))

  const result = await openrouter.chatCompletion({
    apiKey: 'key',
    model: 'org/model',
    messages: [],
    onToken: () => {},
  })

  assert.equal(result.content, 'cached')
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cacheHit: true })
})
