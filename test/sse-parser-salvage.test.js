import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSSEStream, extractPartialToken } from '../src/sse-parser.js'
import { ApiError } from '../src/errors.js'

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

test('salvages an interrupted tail whose JSON is not parseable', async () => {
  // Esc-stop mid-content: the buffered tail already carries an invalid JSON
  // escape (\q), so JSON.parse rejects the whole string; the salvage must
  // still decode the \n and \t the model wrote.
  const partial = 'data: {"choices":[{"delta":{"content":"line1\\nline2\\tend\\q'
  let first = true
  const reader = {
    read: async () => {
      if (first) {
        first = false
        return { done: false, value: new TextEncoder().encode(partial) }
      }
      throw new Error('aborted')
    },
    cancel: async () => {},
  }

  const err = await parseSSEStream(reader, () => {}).then(() => null, (e) => e)
  assert.equal(err.pendingBuffer, partial)
  assert.deepEqual(extractPartialToken(err.pendingBuffer), { type: 'content', text: 'line1\nline2\tend\\q' })
})

test('falls back to decoding only \\n and \\t when a truncated escape breaks JSON', async () => {
  // A stream cut inside a \uXXXX escape: JSON.parse rejects the tail, and the
  // incomplete escape is left as the model wrote it.
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"reasoning_content":"why\\nnot\\u12'),
    { type: 'reasoning', text: 'why\nnot\\u12' }
  )
})

test('drops citation and annotation urls that cannot be parsed instead of failing the stream', async () => {
  let sources = null
  const { fullText, fullSources } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: 'Answer' } }] }),
      event({
        venice_parameters: {
          web_search_citations: [
            { title: 'Bad', url: 'http://[not-an-ip' },
            { title: 'Blank', url: '' },
            { title: 'Number', url: 42 },
            { title: 'Good', url: 'https://good.example' },
          ],
        },
      }),
      event({
        choices: [{
          delta: {
            annotations: [
              { type: 'url_citation', url_citation: { title: 'Bad', url: 'https://exa mple .com' } },
              { type: 'url_citation', url_citation: { title: 'Good', url: 'https://also.example' } },
            ],
          },
        }],
      }),
    ]),
    () => {},
    (s) => { sources = s }
  )
  assert.equal(fullText, 'Answer')
  assert.deepEqual(fullSources, [
    { title: 'Good', url: 'https://good.example' },
    { title: 'Good', url: 'https://also.example' },
  ])
  assert.equal(sources, fullSources)
})

test('attaches the SSE error status to the thrown ApiError', async () => {
  await assert.rejects(
    parseSSEStream(
      streamReader([event({ error: { message: 'upstream exploded', status: 503, type: 'server_error' } })]),
      () => {}
    ),
    (err) => err instanceof ApiError && err.message === 'upstream exploded' && err.status === 503 && err.errorType === 'server_error'
  )
  // A string error event carries no status field: the ApiError default stays.
  await assert.rejects(
    parseSSEStream(streamReader([event({ error: 'plain failure' })]), () => {}),
    (err) => err instanceof ApiError && err.message === 'plain failure' && err.status === null
  )
})
