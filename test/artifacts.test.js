import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { extractMarkdownImageUrls, produceParts, buildPartsContent, printArtifacts, resolveArtifacts } from '../src/artifacts.js'
import { ARTIFACT_DOWNLOAD_CONCURRENCY, MAX_PRODUCED_PARTS } from '../src/constants.js'

function capture() {
  const chunks = []
  const stdout = { write: (chunk) => chunks.push(String(chunk)) }
  return { stdout, text: () => chunks.join('') }
}

function nodeResponse({ status = 200, headers = {}, body = null }) {
  const stream = body instanceof ReadableStream
    ? Readable.fromWeb(body)
    : Readable.from(body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  stream.statusCode = status
  stream.headers = headers
  return stream
}

function respond(response) {
  return () => ({
    on(event, listener) {
      if (event === 'response') queueMicrotask(() => listener(response))
      return this
    },
    end() {},
  })
}

const pngBytes = Buffer.from('png-bytes')
const pngResponse = () => nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: pngBytes })

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
  // Malformed shapes must not extract anything and must not blow up: the
  // old regex backtracked quadratically on an unterminated `![x](https://`.
  assert.deepEqual(extractMarkdownImageUrls('![x](https://' + 'a'.repeat(20_000)), [])
  assert.deepEqual(extractMarkdownImageUrls('![a]x](https://u.example/a.png)'), [])
  assert.deepEqual(extractMarkdownImageUrls('![x](no-url)'), [])
  assert.deepEqual(extractMarkdownImageUrls('![x](https://u.example/a.png '), [])
})

test('buildPartsContent puts text first and omits it when empty', () => {
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  assert.deepEqual(buildPartsContent('hello', [part]), [
    { type: 'text', text: 'hello' },
    part,
  ])
  assert.deepEqual(buildPartsContent('', [part]), [part])
})

test('produceParts downloads remote parts and replaces the URL', async () => {
  let calls = 0
  const requestFn = () => {
    calls++
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(pngResponse()))
        return this
      },
      end() {},
    }
  }
  const part = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
  const { parts, results } = await produceParts([part], { sessionId: null, imageOutputSupported: undefined, fullText: '', requestFn })
  assert.equal(calls, 1)
  assert.deepEqual(parts, [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } }])
  assert.equal(results.length, 1)
  assert.equal(results[0].savedTo, null)
})

test('produceParts passes data URLs through without fetching', async () => {
  const requestFn = () => { throw new Error('should not fetch') }
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const { parts } = await produceParts([part], { sessionId: null, imageOutputSupported: true, fullText: 'x', requestFn })
  assert.deepEqual(parts, [part])
})

test('produceParts extracts markdown images only for image-output models', async () => {
  let calls = 0
  const requestFn = () => {
    calls++
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(pngResponse()))
        return this
      },
      end() {},
    }
  }
  const text = 'here: ![](https://example.com/a.png)'
  const gated = await produceParts([], { sessionId: null, imageOutputSupported: true, fullText: text, requestFn })
  assert.equal(calls, 1)
  assert.equal(gated.parts.length, 1)
  assert.equal(gated.parts[0].image_url.url.startsWith('data:image/png;base64,'), true)

  const ungated = await produceParts([], { sessionId: null, imageOutputSupported: false, fullText: text, requestFn })
  assert.equal(calls, 1)
  assert.deepEqual(ungated.parts, [])
})

test('produceParts keeps failed downloads inline with the error', async () => {
  const requestFn = respond(nodeResponse({ status: 500, body: Buffer.from('nope') }))
  const part = { type: 'file', file: { filename: 'doc.pdf', file_data: 'https://example.com/doc.pdf' } }
  const { parts, results } = await produceParts([part], { sessionId: null, imageOutputSupported: undefined, fullText: '', requestFn })
  assert.deepEqual(parts, [part])
  assert.match(results[0].error, /HTTP 500/)
})

test('produceParts dedupes repeated markdown image URLs', async () => {
  let calls = 0
  const requestFn = () => {
    calls++
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(pngResponse()))
        return this
      },
      end() {},
    }
  }
  const text = '![](https://example.com/a.png) ![](https://example.com/a.png) ![](https://example.com/b.png)'
  const { parts } = await produceParts([], { sessionId: null, imageOutputSupported: true, fullText: text, requestFn })
  assert.equal(parts.length, 2)
  assert.equal(calls, 2)
})

test('produceParts caps the artifact list and bounds download concurrency', async () => {
  let inFlight = 0
  let peak = 0
  const requestFn = () => ({
    on(event, listener) {
      if (event === 'response') {
        inFlight++
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight--
          listener(pngResponse())
        }, 5)
      }
      return this
    },
    end() {},
  })
  const text = Array.from({ length: 500 }, (_, i) => `![](https://example.com/${i}.png)`).join(' ')
  const { parts, results } = await produceParts([], { sessionId: null, imageOutputSupported: true, fullText: text, requestFn })
  assert.equal(parts.length, MAX_PRODUCED_PARTS)
  assert.equal(results.length, MAX_PRODUCED_PARTS)
  assert.ok(peak <= ARTIFACT_DOWNLOAD_CONCURRENCY, `peak in-flight ${peak} exceeded ${ARTIFACT_DOWNLOAD_CONCURRENCY}`)
})

test('printArtifacts strips escape bytes from a URL hyperlink() refuses', () => {
  const { stdout, text } = capture()
  printArtifacts([{
    part: { type: 'image_url', image_url: { url: 'https:\u001b[2J\u001b[1;31mFAKE' } },
    error: 'unsupported URL',
    label: 'x.png',
  }], stdout)
  assert.equal(text().includes('\u001b[2J'), false)
  assert.equal(text().includes('\u001b[1;31m'), false)
  assert.match(text(), /download failed: unsupported URL/)
})

test('printArtifacts sanitizes escape bytes carried by a download error note', () => {
  const { stdout, text } = capture()
  printArtifacts([{
    part: { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    error: 'getaddrinfo ENOTFOUND \u001b[2Jspoofed',
    label: 'a.png',
  }], stdout)
  assert.equal(text().includes('\u001b[2J'), false)
  assert.match(text(), /download failed: getaddrinfo ENOTFOUND spoofed/)
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

test('resolveArtifacts rewrites a parts-bearing result into a parts-array message', async () => {
  const requestFn = () => { throw new Error('should not fetch') }
  const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const result = { content: 'Here', parts: [part] }
  const results = await resolveArtifacts(result, { sessionId: null, imageOutputSupported: undefined, requestFn })
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Here' },
    part,
  ])
  assert.equal(results.length, 1)
})

test('resolveArtifacts is a no-op without content or parts', async () => {
  const requestFn = () => { throw new Error('should not fetch') }
  const result = { content: 'plain' }
  const results = await resolveArtifacts(result, { sessionId: null, imageOutputSupported: true, requestFn })
  assert.deepEqual(results, [])
  assert.equal(result.content, 'plain')
})

test('resolveArtifacts runs the markdown-image heuristic only for image-output models', async () => {
  const requestFn = respond(nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: pngBytes }))
  const gated = { content: 'here: ![](https://example.com/a.png)' }
  const gatedResults = await resolveArtifacts(gated, { sessionId: null, imageOutputSupported: true, requestFn })
  assert.equal(gatedResults.length, 1)
  assert.equal(Array.isArray(gated.content), true)

  const plain = { content: 'here: ![](https://example.com/a.png)' }
  const plainResults = await resolveArtifacts(plain, { sessionId: null, imageOutputSupported: undefined, requestFn })
  assert.deepEqual(plainResults, [])
  assert.equal(plain.content, 'here: ![](https://example.com/a.png)')
})
