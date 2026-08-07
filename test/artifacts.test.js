import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMarkdownImageUrls, produceParts, buildPartsContent, printArtifacts, resolveArtifacts } from '../src/artifacts.js'

function capture() {
  const chunks = []
  const stdout = { write: (chunk) => chunks.push(String(chunk)) }
  return { stdout, text: () => chunks.join('') }
}

test('extractMarkdownImageUrls finds only http(s) markdown images', () => {
  assert.deepEqual(
    extractMarkdownImageUrls('see ![alt](https://a.example/x.png) and ![](http://b.example/y.jpg)'),
    ['https://a.example/x.png', 'http://b.example/y.jpg']
  )
  assert.deepEqual(extractMarkdownImageUrls('no images here'), [])
  assert.deepEqual(extractMarkdownImageUrls('![rel](./local.png) ![ftp](ftp://x.example/a.png)'), [])
  assert.deepEqual(extractMarkdownImageUrls('![multi](https://a.example/one.png "title") ![](https://b.example/two.png)'), ['https://a.example/one.png', 'https://b.example/two.png'])
  assert.deepEqual(extractMarkdownImageUrls(null), [])
  assert.deepEqual(extractMarkdownImageUrls(''), [])
})

test('buildPartsContent puts text first and omits it when empty', () => {
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  assert.deepEqual(buildPartsContent('hello', [part]), [
    { type: 'text', text: 'hello' },
    part,
  ])
  assert.deepEqual(buildPartsContent('', [part]), [part])
})

test('produceParts downloads remote parts and replaces the URL', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const part = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
  const { parts, results } = await produceParts([part], { sessionId: null, imageOutputSupported: undefined, fullText: '' })
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.deepEqual(parts, [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` } }])
  assert.equal(results.length, 1)
  assert.equal(results[0].savedTo, null)
})

test('produceParts passes data URLs through without fetching', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const { parts } = await produceParts([part], { sessionId: null, imageOutputSupported: true, fullText: 'x' })
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.deepEqual(parts, [part])
})

test('produceParts extracts markdown images only for image-output models', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const text = 'here: ![](https://example.com/a.png)'
  const gated = await produceParts([], { sessionId: null, imageOutputSupported: true, fullText: text })
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(gated.parts.length, 1)
  assert.equal(gated.parts[0].image_url.url.startsWith('data:image/png;base64,'), true)

  const ungated = await produceParts([], { sessionId: null, imageOutputSupported: false, fullText: text })
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.deepEqual(ungated.parts, [])
})

test('produceParts keeps failed downloads inline with the error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 500 }))
  const part = { type: 'file', file: { filename: 'doc.pdf', file_data: 'https://example.com/doc.pdf' } }
  const { parts, results } = await produceParts([part], { sessionId: null, imageOutputSupported: undefined, fullText: '' })
  assert.deepEqual(parts, [part])
  assert.match(results[0].error, /HTTP 500/)
})

test('printArtifacts renders saved, failed and inline lines', () => {
  const { stdout, text } = capture()
  printArtifacts([
    { part: { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }, savedTo: '/tmp/x/a.png' },
    { part: { type: 'file', file: { filename: 'doc.pdf', file_data: 'https://example.com/doc.pdf' } }, error: 'HTTP 404' },
    { part: { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } } },
  ], stdout)
  assert.match(text(), /image: a\.png/)
  assert.match(text(), /saved to \/tmp\/x\/a\.png/)
  assert.match(text(), /file: doc\.pdf/)
  assert.match(text(), /download failed: HTTP 404/)
  assert.match(text(), /image: image\.png/)
})

test('resolveArtifacts rewrites a parts-bearing result into a parts-array message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const result = { content: 'Here', parts: [part] }
  const results = await resolveArtifacts(result, { sessionId: null, imageOutputSupported: undefined })
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Here' },
    part,
  ])
  assert.equal(results.length, 1)
})

test('resolveArtifacts is a no-op without content or parts', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const result = { content: 'plain' }
  const results = await resolveArtifacts(result, { sessionId: null, imageOutputSupported: true })
  assert.deepEqual(results, [])
  assert.equal(result.content, 'plain')
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('resolveArtifacts runs the markdown-image heuristic only for image-output models', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const gated = { content: 'here: ![](https://example.com/a.png)' }
  const gatedResults = await resolveArtifacts(gated, { sessionId: null, imageOutputSupported: true })
  assert.equal(gatedResults.length, 1)
  assert.equal(Array.isArray(gated.content), true)

  const plain = { content: 'here: ![](https://example.com/a.png)' }
  const plainResults = await resolveArtifacts(plain, { sessionId: null, imageOutputSupported: undefined })
  assert.deepEqual(plainResults, [])
  assert.equal(plain.content, 'here: ![](https://example.com/a.png)')
})
