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

test('keeps the final line when the stream ends mid-emoji without a trailing newline', async () => {
  const emoji = '😀'
  const line = `data: ${JSON.stringify({ choices: [{ delta: { content: `done ${emoji}` } }] })}`
  const bytes = new TextEncoder().encode(line)
  const cut = bytes.length - 3
  const chunks = [
    Buffer.from(bytes.subarray(0, cut)).toString('utf-8'),
    Buffer.from(bytes.subarray(cut)).toString('utf-8'),
  ]

  const { fullText, skippedChunks } = await parseSSEStream(streamReader(chunks), () => {})
  assert.equal(fullText, `done ${emoji}`)
  assert.equal(skippedChunks, 0)
})

// The incomplete trailing line is accumulated as unscanned fragments, so the
// three shapes below all exercise the reassembly seam: a single event far
// larger than one chunk, several complete lines arriving in one chunk on top
// of a carried fragment, and a chunk boundary landing exactly on the newline.
test('reassembles a single event spread over many newline-less chunks', async () => {
  const blob = 'x'.repeat(200_000)
  const line = `${event({ choices: [{ delta: { content: blob } }] })}`
  const chunks = []
  for (let i = 0; i < line.length; i += 4096) chunks.push(line.slice(i, i + 4096))

  const { fullText, skippedChunks } = await parseSSEStream(streamReader(chunks), () => {})
  assert.equal(fullText, blob)
  assert.equal(skippedChunks, 0)
})

test('handles several complete events arriving in one chunk after a carried fragment', async () => {
  const first = event({ choices: [{ delta: { content: 'one' } }] })
  const rest = event({ choices: [{ delta: { content: 'two' } }] }) + event({ choices: [{ delta: { content: 'three' } }] })
  const split = first.length - 5

  const tokens = []
  const { fullText } = await parseSSEStream(
    streamReader([first.slice(0, split), first.slice(split) + rest]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'onetwothree')
  assert.deepEqual(tokens, [['content', 'one'], ['content', 'two'], ['content', 'three']])
})

test('handles a chunk boundary falling exactly on the newline', async () => {
  const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'edge' } }] })}`
  const { fullText } = await parseSSEStream(streamReader([line, '\n', '\n']), () => {})
  assert.equal(fullText, 'edge')
})

// The three tests above pin reassembly, which the previous implementation also
// got right: it was correct but quadratic. This one pins the complexity, the
// only property that actually regressed. A newline-less event delivered in
// many small chunks made the old per-chunk `buffer.split('\n')` rescan the
// whole accumulated line every read: measured 3435 ms here versus 57 ms now,
// so the ceiling leaves the fix ~25x of headroom while the old code overshoots
// it by more than 2x.
test('parses a large newline-less event in linear time', async () => {
  const blob = 'x'.repeat(8 * 1024 * 1024)
  const bytes = new TextEncoder().encode(event({ choices: [{ delta: { content: blob } }] }))
  let offset = 0
  const reader = {
    read: async () => {
      if (offset >= bytes.length) return { done: true, value: undefined }
      const end = Math.min(offset + 4096, bytes.length)
      const value = bytes.subarray(offset, end)
      offset = end
      return { done: false, value }
    },
    cancel: async () => {},
  }

  const startedAt = performance.now()
  const { fullText } = await parseSSEStream(reader, () => {})
  const elapsed = performance.now() - startedAt
  assert.equal(fullText.length, blob.length)
  assert.ok(elapsed < 1500, `parsing took ${Math.round(elapsed)}ms, expected linear-time parsing well under 1500ms`)
})

test('accepts spec-valid data events without a space after the colon', async () => {
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader([
      `data:${JSON.stringify({ choices: [{ delta: { content: 'tight' } }] })}\n\n`,
      'data:[DONE]\n\n',
    ]),
    () => {}
  )
  assert.equal(fullText, 'tight')
  assert.equal(skippedChunks, 0)
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

test('reports the reasoning phase duration when reasoning was streamed', async () => {
  const { fullReasoning, reasoningMs } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      event({ choices: [{ delta: { content: 'Answer' } }] }),
    ]),
    () => {}
  )
  assert.equal(fullReasoning, 'think')
  assert.equal(typeof reasoningMs, 'number')
  assert.ok(reasoningMs >= 0 && reasoningMs < 60_000)
})

test('reports the duration when the stream ends mid-thinking', async () => {
  const { fullReasoning, reasoningMs } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { reasoning_content: 'deep' } }] })]),
    () => {}
  )
  assert.equal(fullReasoning, 'deep')
  assert.equal(typeof reasoningMs, 'number')
  assert.ok(reasoningMs >= 0)
})

test('reports null reasoning duration when no reasoning was streamed', async () => {
  const { reasoningMs } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'ok' } }] })]),
    () => {}
  )
  assert.equal(reasoningMs, null)
})

test('anchors the thinking clock at request start so a one-burst block reports real wait', async () => {
  // Regression: an endpoint that flushes the whole reasoning block into a
  // single synchronous burst (start + reasoning deltas + content in one tick)
  // produced reasoningMs ~0, so the meter checkpoint showed `· 0s`. With a
  // request-anchored clock the reported duration reflects the wait the user
  // actually experienced, not the sub-millisecond delta span.
  let nowMs = 2400
  const { fullReasoning, reasoningMs } = await parseSSEStream(
    // All reasoning deltas and the closing content arrive in the SAME chunk
    // (one reader read), so the deltas span ~0ms of wall time between them.
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      event({ choices: [{ delta: { reasoning_content: 'ing hard' } }] }),
      event({ choices: [{ delta: { content: 'Answer' } }] }),
    ]),
    () => {},
    null,
    { now: () => nowMs, requestStartedAt: 200 }
  )
  assert.equal(fullReasoning, 'thinking hard')
  // Wait time measured from the request anchor even though all deltas arrived
  // in a single burst (2400 - 200 = 2.2s).
  assert.ok(reasoningMs >= 2200 && reasoningMs <= 2400)
})

test('falls back to the first-delta anchor when no request clock is provided', async () => {
  // Absent-option callers keep the pre-request-anchor behavior: the duration
  // is measured from the first reasoning delta.
  let nowMs = 400
  const { fullReasoning, reasoningMs } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      event({ choices: [{ delta: { content: 'Answer' } }] }),
    ]),
    () => {},
    null,
    { now: () => nowMs }
  )
  assert.equal(fullReasoning, 'think')
  // First-delta anchor: close at 400 minus the first-delta time (400) = ~0.
  assert.ok(reasoningMs <= 400)
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

test('captures full-message content carried on the usage chunk', async () => {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  const { fullText, finalUsage } = await parseSSEStream(
    streamReader([
      event({ choices: [{ message: { content: 'full answer' } }], usage }),
      'data: [DONE]\n\n',
    ]),
    () => {}
  )
  assert.equal(fullText, 'full answer')
  assert.deepEqual(finalUsage, usage)
})

test('captures a final delta token carried on the usage chunk', async () => {
  const { fullText, finalUsage } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: 'Hello' } }] }),
      event({ choices: [{ delta: { content: ' tail' } }], usage: { total_tokens: 5 } }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'Hello tail')
  assert.deepEqual(finalUsage, { total_tokens: 5 })
})

test('does not duplicate text when the usage chunk carries both message and delta content', async () => {
  const { fullText } = await parseSSEStream(
    streamReader([
      event({ choices: [{ message: { content: 'once' }, delta: { content: 'once' } }], usage: { total_tokens: 2 } }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'once')
})

test('closes the thinking block when the stream ends mid-reasoning', async () => {
  const tokens = []
  const { fullReasoning, fullText } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'deep thoughts' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullReasoning, 'deep thoughts')
  assert.equal(fullText, '')
  assert.deepEqual(tokens, [
    ['start_reasoning', '\n'],
    ['reasoning', 'deep thoughts'],
    ['end_reasoning', null],
  ])
})

test('skips unparseable lines and counts them', async () => {
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader([
      'data: {not json\n\n',
      'data: {also not json\n\n',
      event({ choices: [{ delta: { content: 'kept' } }] }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'kept')
  assert.equal(skippedChunks, 2)
})

test('joins multi-line data fields into a single event per the SSE spec', async () => {
  const tokens = []
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader([
      'data: {\n',
      'data:   "choices": [\n',
      'data:     { "delta": { "content": "pretty" } }\n',
      'data:   ]\n',
      'data: }\n',
      '\n',
      event({ choices: [{ delta: { content: ' second' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  // Consecutive data: lines form one event whose payload is them joined with
  // \n; re-joined they are valid (pretty-printed) JSON, so the delta arrives
  // whole instead of both halves being dropped as malformed.
  assert.equal(fullText, 'pretty second')
  assert.equal(skippedChunks, 0)
})

test('flushes a trailing data event at EOF without a blank line', async () => {
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader([`data: ${JSON.stringify({ choices: [{ delta: { content: 'eof' } }] })}\n`]),
    () => {}
  )
  assert.equal(fullText, 'eof')
  assert.equal(skippedChunks, 0)
})

test('cancels the reader when the stream stalls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = 0
  const reader = {
    read: () => new Promise(() => {}),
    cancel: async () => { cancelled++ },
  }

  const promise = parseSSEStream(reader, () => {}, null, { idleTimeoutMs: 10_000 })
  const assertion = assert.rejects(promise, (err) => err instanceof ApiError && /stalled/.test(err.message))
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  await assertion
  assert.equal(cancelled, 1)
})

test('aborts when the stream exceeds maxBytes', async () => {
  let cancelled = 0
  const reader = {
    read: async () => ({ done: false, value: new TextEncoder().encode('x'.repeat(200)) }),
    cancel: async () => { cancelled++ },
  }

  await assert.rejects(
    parseSSEStream(reader, () => {}, null, { maxBytes: 64 }),
    (err) => err instanceof ApiError && /exceeded/.test(err.message)
  )
  assert.equal(cancelled, 1)
})

test('passes a stream whose bytes equal maxBytes', async () => {
  const chunk = event({ choices: [{ delta: { content: 'hello' } }] })
  const reader = streamReader([chunk])
  const { fullText } = await parseSSEStream(reader, () => {}, null, { maxBytes: new TextEncoder().encode(chunk).byteLength })
  assert.equal(fullText, 'hello')
})

test('cancels the reader when the provider sends an error event', async () => {
  let cancelled = 0
  const reader = {
    read: async () => ({ done: false, value: new TextEncoder().encode(event({ error: { message: 'boom' } })) }),
    cancel: async () => { cancelled++ },
  }

  await assert.rejects(parseSSEStream(reader, () => {}), (err) => err.message === 'boom')
  assert.equal(cancelled, 1)
})

test('throws an ApiError on SSE-level error events instead of an empty success', async () => {
  await assert.rejects(
    parseSSEStream(
      streamReader([
        event({ choices: [{ delta: { content: 'partial' } }] }),
        event({ error: { message: 'model overloaded', code: 503 } }),
      ]),
      () => {}
    ),
    (err) => err instanceof ApiError && err.message === 'model overloaded' && err.retryable === false
  )
  await assert.rejects(
    parseSSEStream(streamReader([event({ choices: [{ error: { message: 'bad' } }] })]), () => {}),
    (err) => err instanceof ApiError && err.message === 'bad'
  )
})

test('propagates renderer errors instead of counting them as malformed chunks', async () => {
  await assert.rejects(
    parseSSEStream(
      streamReader([event({ choices: [{ delta: { content: 'boom' } }] })]),
      () => { throw new Error('renderer exploded') }
    ),
    /renderer exploded/
  )
})

test('emits end_reasoning before final-only content after streamed reasoning', async () => {
  const tokens = []
  const { fullText } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      event({ choices: [{ message: { content: 'Final answer' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'Final answer')
  assert.deepEqual(tokens, [
    ['start_reasoning', '\n'],
    ['reasoning', 'think'],
    ['end_reasoning', null],
    ['content', 'Final answer'],
  ])
})

test('rethrows reader errors with the pending buffer attached', async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"par'
  let first = true
  const reader = {
    read: async () => {
      if (first) {
        first = false
        return { done: false, value: new TextEncoder().encode(partial) }
      }
      throw new Error('boom')
    },
  }

  await assert.rejects(parseSSEStream(reader, () => {}), (err) => err.message === 'boom' && err.pendingBuffer === partial)
})

// The unterminated tail is accumulated as fragments, so a partial that spans
// more than one read is the case where the salvage buffer could lose a piece.
test('attaches a pending buffer that spans several reads', async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"par'
  const chunks = [partial.slice(0, 12), partial.slice(12, 30), partial.slice(30)]
  let reads = 0
  const reader = {
    read: async () => {
      if (reads < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[reads++]) }
      throw new Error('boom')
    },
  }

  await assert.rejects(parseSSEStream(reader, () => {}), (err) => err.message === 'boom' && err.pendingBuffer === partial)
})

test('throws a retryable stall error when the stream goes idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const partial = 'data: {"choices":[{"delta":{"content":"par'
  let reads = 0
  const reader = {
    read: () => {
      reads++
      if (reads === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(partial) })
      return new Promise(() => {})
    },
  }

  const promise = parseSSEStream(reader, () => {}, null, { idleTimeoutMs: 10_000 })
  const assertion = assert.rejects(
    promise,
    (err) => err instanceof ApiError && err.retryable === true && /stalled after 10s/.test(err.message) && err.pendingBuffer === partial
  )
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  await assertion
})

test('does not start the idle timer when idleTimeoutMs is zero', async () => {
  const { fullText } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'ok' } }] })]),
    () => {},
    null,
    { idleTimeoutMs: 0 }
  )
  assert.equal(fullText, 'ok')
})

test('extractPartialToken handles escaped quotes and newlines', () => {
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"content":"Say \\"hi\\" no'),
    { type: 'content', text: 'Say "hi" no' }
  )
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"content":"line1\\nline2\\t'),
    { type: 'content', text: 'line1\nline2\t' }
  )
  assert.deepEqual(
    extractPartialToken('data: {"choices":[{"delta":{"reasoning_content":"half\\'),
    { type: 'reasoning', text: 'half' }
  )
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

test('emits image and file parts from array content deltas and folds text in', async () => {
  const tokens = []
  const imagePart = { type: 'image_url', image_url: { url: 'https://img.example/a.png' } }
  const filePart = { type: 'file', file: { filename: 'doc.pdf', file_data: 'https://files.example/doc.pdf' } }
  const { fullText, fullParts } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: [{ type: 'text', text: 'Here is ' }, imagePart, { type: 'text', text: 'your file' }] } }] }),
      event({ choices: [{ delta: { content: [filePart] } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'Here is your file')
  assert.deepEqual(fullParts, [imagePart, filePart])
  assert.deepEqual(tokens, [
    ['content', 'Here is '],
    ['image', imagePart],
    ['content', 'your file'],
    ['file', filePart],
  ])
})

test('treats data-url image parts as parts', async () => {
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const { fullParts } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: [part] } }] })]),
    () => {}
  )
  assert.deepEqual(fullParts, [part])
})

test('ignores unknown part types without corrupting the stream', async () => {
  const tokens = []
  const { fullText, fullParts } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: [{ type: 'audio', audio: { url: 'https://a.example/x.mp3' } }, { type: 'text', text: 'ok' }] } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'ok')
  assert.deepEqual(fullParts, [])
  assert.deepEqual(tokens, [['content', 'ok']])
})

test('collects non-text parts from a final message.content without duplicating streamed text', async () => {
  const imagePart = { type: 'image_url', image_url: { url: 'https://img.example/b.png' } }
  const { fullText, fullParts } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: 'Done' } }] }),
      event({ choices: [{ message: { content: [{ type: 'text', text: 'Done' }, imagePart] } }] }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'Done')
  assert.deepEqual(fullParts, [imagePart])
})

test('emits text from a final message.content when the chunk carries no delta', async () => {
  const { fullText, fullParts } = await parseSSEStream(
    streamReader([
      event({
        choices: [{
          message: {
            content: [
              { type: 'text', text: 'Only answer' },
              { type: 'image_url', image_url: { url: 'https://img.example/x.png' } },
            ],
          },
        }],
      }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'Only answer')
  assert.equal(fullParts.length, 1)
})

test('emits text from a final message.content even when the delta is an empty object', async () => {
  const { fullText, fullParts } = await parseSSEStream(
    streamReader([
      event({
        choices: [{
          delta: {},
          message: {
            content: [
              { type: 'text', text: 'Only answer' },
              { type: 'image_url', image_url: { url: 'https://img.example/y.png' } },
            ],
          },
        }],
      }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'Only answer')
  assert.equal(fullParts.length, 1)
})

test('emits a string final message.content when nothing was streamed', async () => {
  const tokens = []
  const { fullText } = await parseSSEStream(
    streamReader([
      event({ choices: [{ message: { content: 'Whole answer' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullText, 'Whole answer')
  assert.deepEqual(tokens, [['content', 'Whole answer']])
})

test('does not duplicate a string final message.content after deltas streamed', async () => {
  const { fullText } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: 'Part' } }] }),
      event({ choices: [{ message: { content: 'Whole answer' } }] }),
    ]),
    () => {}
  )
  assert.equal(fullText, 'Part')
})

test('dedupes repeated parts between delta and final message', async () => {
  const part = { type: 'image_url', image_url: { url: 'https://img.example/c.png' } }
  const { fullParts } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { content: [part] } }] }),
      event({ choices: [{ message: { content: [part] } }] }),
    ]),
    () => {}
  )
  assert.equal(fullParts.length, 1)
})

test('only collects http(s) source urls', async () => {
  let sources = null
  await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { annotations: [
        { type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'A' } },
        { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'Bad' } },
        { type: 'url_citation', url_citation: { url: 'file:///etc/passwd', title: 'Local' } },
      ] } }] }),
    ]),
    () => {},
    (s) => { sources = s }
  )
  assert.deepEqual(sources, [{ title: 'A', url: 'https://example.com/a' }])
})

const ENCRYPTED = 'ab'.repeat(100)

test('decryptToken option decrypts streamed content and reasoning deltas', async () => {
  const tokens = []
  const decrypted = []
  const { fullText, fullReasoning } = await parseSSEStream(
    streamReader([
      event({ choices: [{ delta: { reasoning_content: ENCRYPTED } }] }),
      event({ choices: [{ delta: { content: ENCRYPTED } }] }),
    ]),
    (t, type) => tokens.push([type, t]),
    null,
    { decryptToken: (hex) => { decrypted.push(hex); return hex === ENCRYPTED ? 'PLAIN' : hex } }
  )
  assert.equal(fullText, 'PLAIN')
  assert.equal(fullReasoning, 'PLAIN')
  assert.equal(decrypted.length, 2)
  assert.deepEqual(tokens, [
    ['start_reasoning', '\n'],
    ['reasoning', 'PLAIN'],
    ['end_reasoning', null],
    ['content', 'PLAIN'],
  ])
})

test('decryptToken option decrypts final message content and array text parts', async () => {
  const finalMessage = await parseSSEStream(
    streamReader([event({ choices: [{ message: { content: ENCRYPTED } }] })]),
    () => {},
    null,
    { decryptToken: () => 'PLAIN' }
  )
  assert.equal(finalMessage.fullText, 'PLAIN')

  const arrayParts = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: [{ type: 'text', text: ENCRYPTED }] } }] })]),
    () => {},
    null,
    { decryptToken: () => 'PLAIN' }
  )
  assert.equal(arrayParts.fullText, 'PLAIN')
})

test('decryptToken mode fails closed on plaintext tokens', async () => {
  const tokens = []
  const calls = []
  await assert.rejects(
    parseSSEStream(
      streamReader([
        event({ choices: [{ delta: { content: 'plain' } }] }),
      ]),
      (t, type) => tokens.push([type, t]),
      null,
      { decryptToken: (hex) => { calls.push(hex); return 'NOPE' } }
    ),
    (err) => err instanceof ApiError && err.retryable === false && /unencrypted chunk/.test(err.message)
  )
  assert.equal(calls.length, 0)
  assert.deepEqual(tokens, [])

  // A plaintext reasoning delta is rejected the same way.
  await assert.rejects(
    parseSSEStream(
      streamReader([event({ choices: [{ delta: { reasoning_content: 'think' } }] })]),
      () => {},
      null,
      { decryptToken: () => 'NOPE' }
    ),
    (err) => /unencrypted chunk/.test(err.message)
  )
})

test('a delta carrying reasoning and content emits both', async () => {
  const tokens = []
  const chunk = event({ choices: [{ delta: { reasoning_content: 'why', content: 'then' } }] })
  const { fullText, fullReasoning } = await parseSSEStream(
    streamReader([chunk]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullReasoning, 'why')
  assert.equal(fullText, 'then')
  assert.deepEqual(tokens, [['start_reasoning', '\n'], ['reasoning', 'why'], ['end_reasoning', null], ['content', 'then']])
})

test('reasoning deltas with an empty content field keep one thinking block', async () => {
  // DeepSeek-family streams put `content: ''` on every reasoning delta; the
  // empty field is not the thinking→content transition, and treating it as
  // one would re-open the block on the next reasoning delta — a start/end
  // cycle per delta, which compact mode renders as a checkpoint per chunk.
  const tokens = []
  const delta = (reasoning) => event({ choices: [{ delta: { content: '', role: 'assistant', reasoning } }] })
  const { fullText, fullReasoning } = await parseSSEStream(
    streamReader([
      delta('H'),
      delta('mm,'),
      delta(' the user'),
      event({ choices: [{ delta: { content: 'Hi!', role: 'assistant' } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullReasoning, 'Hmm, the user')
  assert.equal(fullText, 'Hi!')
  assert.deepEqual(
    tokens,
    [
      ['start_reasoning', '\n'],
      ['reasoning', 'H'],
      ['reasoning', 'mm,'],
      ['reasoning', ' the user'],
      ['end_reasoning', null],
      ['content', 'Hi!'],
    ]
  )
})

test('an empty content parts array does not close the thinking block either', async () => {
  const tokens = []
  const delta = (reasoning) => event({ choices: [{ delta: { content: [], reasoning } }] })
  const { fullReasoning } = await parseSSEStream(
    streamReader([
      delta('think'),
      event({ choices: [{ delta: { content: [{ type: 'text', text: 'answer' }] } }] }),
    ]),
    (t, type) => tokens.push([type, t])
  )
  assert.equal(fullReasoning, 'think')
  assert.deepEqual(
    tokens,
    [
      ['start_reasoning', '\n'],
      ['reasoning', 'think'],
      ['end_reasoning', null],
      ['content', 'answer'],
    ]
  )
})

test('empty keep-alive data events are not counted as malformed chunks', async () => {
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader(['data:\n\n', 'data:\n\n', event({ choices: [{ delta: { content: 'alive' } }] }), '\n']),
    () => {}
  )
  assert.equal(fullText, 'alive')
  assert.equal(skippedChunks, 0)
})

test('a trailing empty data payload when the stream ends is not malformed either', async () => {
  const { fullText, skippedChunks } = await parseSSEStream(
    streamReader([event({ choices: [{ delta: { content: 'end' } }] }), 'data:\n']),
    () => {}
  )
  assert.equal(fullText, 'end')
  assert.equal(skippedChunks, 0)
})

test('stamps the reasoning duration on a reader error thrown mid-reasoning', async () => {
  let first = true
  const reader = {
    read: async () => {
      if (first) {
        first = false
        return { done: false, value: new TextEncoder().encode(event({ choices: [{ delta: { reasoning_content: 'think' } }] })) }
      }
      throw new Error('aborted')
    },
    cancel: async () => {},
  }
  await assert.rejects(
    parseSSEStream(reader, () => {}, null, { now: () => 2300, requestStartedAt: 200 }),
    (err) => err.message === 'aborted' && err.reasoningMs === 2100
  )
})

test('keeps the closed-thinking duration on a reader error after content started', async () => {
  const chunks = [
    event({ choices: [{ delta: { reasoning_content: 'think' } }] }),
    event({ choices: [{ delta: { content: 'Answer' } }] }),
  ]
  let reads = 0
  const reader = {
    read: async () => {
      if (reads < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[reads++]) }
      throw new Error('aborted')
    },
    cancel: async () => {},
  }
  await assert.rejects(
    parseSSEStream(reader, () => {}, null, { now: () => 2300, requestStartedAt: 0 }),
    (err) => err.message === 'aborted' && err.reasoningMs === 2300
  )
})

test('does not stamp a reasoning duration on a content-only reader error', async () => {
  const chunks = [event({ choices: [{ delta: { content: 'Answer' } }] })]
  let reads = 0
  const reader = {
    read: async () => {
      if (reads < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[reads++]) }
      throw new Error('aborted')
    },
    cancel: async () => {},
  }
  // A request clock is supplied and never null in practice, but no reasoning
  // block was opened: the abort must not stamp a fake reasoning duration.
  await assert.rejects(
    parseSSEStream(reader, () => {}, null, { now: () => 2300, requestStartedAt: 200 }),
    (err) => err.message === 'aborted' && err.reasoningMs === undefined
  )
})
