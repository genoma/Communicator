import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSSEStream, extractPartialToken } from '../src/sse-parser.js'

function streamReader(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return stream.getReader()
}

function event(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

test('parses a simple content stream', async () => {
  const tokens = []
  const { fullText, fullReasoning, finalUsage } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'Hello' } }] }), event({ choices: [{ delta: { content: ' world' } }] })]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'Hello world')
  assert.equal(fullReasoning, '')
  assert.deepEqual(tokens, [['content', 'Hello'], ['content', ' world']])
  assert.equal(finalUsage, null)
})

test('handles fragmented chunks across reads', async () => {
  const fullLine = `data: ${JSON.stringify({ choices: [{ delta: { content: 'fragmented' } }] })}\n\n`
  const chunks = []
  for (let i = 0; i < fullLine.length; i += 7) {
    chunks.push(fullLine.slice(i, i + 7))
  }

  const { fullText } = await parseSSEStream(streamReader(chunks), () => {})
  assert.equal(fullText, 'fragmented')
})

test('emits reasoning then content transition events', async () => {
  const tokens = []
  const { fullText, fullReasoning } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      event({ choices: [{ delta: { reasoning_content: 'ing' } }] }),
      event({ choices: [{ delta: { content: 'Answer' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullReasoning, 'thinking')
  assert.equal(fullText, 'Answer')
  assert.deepEqual(tokens, [
    ['start_reasoning', '\n'],
    ['reasoning', 'think'],
    ['reasoning', 'ing'],
    ['end_reasoning', null],
    ['content', 'Answer'],
  ])
})

test('captures usage chunk and skips [DONE]', async () => {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  const { fullText, finalUsage } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'ok' } }] }), event({ usage }), 'data: [DONE]\n\n']),
    () => {}
  )
  assert.equal(fullText, 'ok')
  assert.deepEqual(finalUsage, usage)
})

test('skips unparseable lines', async () => {
  const { fullText } = await parseSSEStream(
    streamReader(['data: {not json\n\n', event({ choices: [{ delta: { content: 'kept' } }] })]),
    () => {}
  )
  assert.equal(fullText, 'kept')
})

test('extractPartialToken pulls in-flight reasoning or content', () => {
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"reasoning_content":"The cat w'),
    { type: 'reasoning', text: 'The cat w' }
  )
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"content":"Partial ans'),
    { type: 'content', text: 'Partial ans' }
  )
  assert.equal(extractPartialToken('data: {"choices":[{"delta":{}'), null)
})

test('collects venice web_search_citations and fires onSources on first sight', async () => {
  const calls = []
  const { fullText, fullSources } = await parseSSEStream(
    streamReader([
      event({
        venice_parameters: {
          web_search_citations: [
            { title: 'One', url: 'https://one.example' },
            { title: 'Two', url: 'https://two.example' },
          ],
        },
        choices: [{ delta: { content: 'Answer ^1^' } }],
      }),
      event({ choices: [{ delta: { content: ' here' } }] }),
    ]),
    () => {},
    (sources) => calls.push(sources)
  )
  assert.equal(fullText, 'Answer ^1^ here')
  assert.deepEqual(fullSources, [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0], fullSources)
})

test('collects openrouter delta annotations and dedupes by url', async () => {
  const calls = []
  const { fullSources } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: 'done' } }] }),
      event({
        choices: [{
          delta: {
            annotations: [
              { type: 'url_citation', url_citation: { title: 'One', url: 'https://one.example' } },
              { type: 'url_citation', url_citation: { title: 'One again', url: 'https://one.example' } },
              { type: 'url_citation', url_citation: { title: 'Two', url: 'https://two.example' } },
            ],
          },
        }],
      }),
      'data: [DONE]\n\n',
    ]),
    () => {},
    (sources) => calls.push(sources)
  )
  assert.deepEqual(fullSources, [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' },
  ])
  assert.equal(calls.length, 1)
})

test('falls back to message annotations and ignores non-url_citation types', async () => {
  const { fullSources } = await parseSSEStream(
    streamReader([
      event({
        choices: [{
          message: {
            annotations: [
              { type: 'other', value: 'ignored' },
              { type: 'url_citation', url_citation: { url: 'https://three.example' } },
            ],
          },
        }],
      }),
    ]),
    () => {}
  )
  assert.deepEqual(fullSources, [{ title: null, url: 'https://three.example' }])
})

test('captures sources on a chunk that also carries usage', async () => {
  const { fullSources, finalUsage } = await parseSSEStream(
    streamReader([
      event({
        venice_parameters: { web_search_citations: [{ title: 'T', url: 'https://t.example' }] },
        choices: [{ delta: { content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ]),
    () => {}
  )
  assert.deepEqual(fullSources, [{ title: 'T', url: 'https://t.example' }])
  assert.deepEqual(finalUsage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
})

test('returns empty sources when no citations are present', async () => {
  const { fullSources } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'plain' } }] })]),
    () => {}
  )
  assert.deepEqual(fullSources, [])
})
