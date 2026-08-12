import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { ApiError } from '../src/errors.js'

// Do not statically import src modules that pull in constants.js here: the
// homedir mock below must be registered before constants computes SESSIONS_DIR.
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-download-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { downloadRemotePart } = await import('../src/attachment-store.js')

after(() => rm(tempHome, { recursive: true, force: true }))

function imagePart(url) {
  return { type: 'image_url', image_url: { url } }
}

function filePart(url) {
  return { type: 'file', file: { filename: 'doc.pdf', file_data: url } }
}

function sessionDir(sessionId) {
  return join(tempHome, '.communicator', 'sessions', 'attachments', sessionId)
}

// Fakes the pinned-fetch transport (http.js): a request function shaped like
// node's http(s).request that answers with a fixed Node-Readable response.
function nodeResponse({ status = 200, headers = {}, body = null }) {
  let stream
  if (body == null) stream = Readable.from([])
  else if (body instanceof ReadableStream) stream = Readable.fromWeb(body)
  else if (typeof body.pipe === 'function') stream = body
  else stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)])
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

function failWith(err) {
  return () => ({
    on(event, listener) {
      if (event === 'error') queueMicrotask(() => listener(err))
      return this
    },
    end() {},
  })
}

function spyRequest(response) {
  let calls = 0
  const requestFn = () => {
    calls++
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(response))
        return this
      },
      end() {},
    }
  }
  requestFn.calls = () => calls
  return requestFn
}

test('downloads a remote image into the session attachment dir', async () => {
  const requestFn = spyRequest(nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: Buffer.from('png-bytes') }))
  const res = await downloadRemotePart(imagePart('https://example.com/photo.png'), 'sess-1', { requestFn })

  assert.equal(requestFn.calls(), 1)
  assert.equal(res.error, undefined)
  assert.equal(res.part.image_url.url, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
  const dir = sessionDir('sess-1')
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{64}\.png$/)
  assert.deepEqual(await readFile(join(dir, files[0])), Buffer.from('png-bytes'))
  assert.equal(res.savedTo, join(dir, files[0]))
})

test('passes inline data URLs through without fetching', async () => {
  const requestFn = failWith(new Error('should not fetch'))
  const part = imagePart('data:image/png;base64,AAAA')
  const res = await downloadRemotePart(part, 'sess-2', { requestFn })
  assert.deepEqual(res, { part })
})

test('rejects non-http URLs without fetching', async () => {
  const requestFn = failWith(new Error('should not fetch'))
  const res = await downloadRemotePart(filePart('ftp://example.com/doc.pdf'), 'sess-3', { requestFn })
  assert.equal(res.error, 'unsupported URL')
  assert.equal(res.dataUrl, undefined)
})

test('reports the status when the remote responds with an error', async () => {
  const requestFn = respond(nodeResponse({ status: 404, body: Buffer.from('nope') }))
  const res = await downloadRemotePart(imagePart('https://example.com/missing.png'), 'sess-4', { requestFn })
  assert.equal(res.error, 'HTTP 404')
  assert.equal(res.dataUrl, undefined)
  assert.equal(res.savedTo, undefined)
})

test('reports network failures', async () => {
  const requestFn = failWith(new ApiError('network down', { retryable: false }))
  const res = await downloadRemotePart(imagePart('https://example.com/a.png'), 'sess-5', { requestFn })
  assert.equal(res.error, 'network down')
})

test('rejects responses over the size cap', async () => {
  const big = new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1)
  const requestFn = respond(nodeResponse({ body: big }))
  const res = await downloadRemotePart(imagePart('https://example.com/huge.png'), 'sess-6', { requestFn })
  assert.match(res.error, /exceeds 20 MB/)
  assert.equal(res.dataUrl, undefined)
})

test('rejects oversized responses from the content-length header without reading the body', async () => {
  let bodyRead = false
  async function* trackedBody() {
    bodyRead = true
    yield Buffer.from('small')
  }
  const requestFn = respond(nodeResponse({
    headers: { 'Content-Length': String(MAX_IMAGE_ATTACHMENT_BYTES + 1) },
    body: Readable.from(trackedBody()),
  }))
  const res = await downloadRemotePart(imagePart('https://example.com/huge.png'), 'sess-10', { requestFn })
  assert.match(res.error, /exceeds 20 MB/)
  assert.equal(res.dataUrl, undefined)
  assert.equal(bodyRead, false)
})

test('infers the extension from the URL when no content-type is sent', async () => {
  const requestFn = respond(nodeResponse({ body: Buffer.from('bytes') }))
  const res = await downloadRemotePart(imagePart('https://example.com/photo.webp'), 'sess-7', { requestFn })
  assert.equal(res.part.image_url.url, `data:image/webp;base64,${Buffer.from('bytes').toString('base64')}`)
})

test('falls back to bin ext and octet-stream when nothing identifies the type', async () => {
  const requestFn = respond(nodeResponse({ body: Buffer.from('bytes') }))
  const res = await downloadRemotePart(filePart('https://example.com/blob'), 'sess-8', { requestFn })
  assert.equal(res.part.file.file_data, `data:application/octet-stream;base64,${Buffer.from('bytes').toString('base64')}`)
  const files = await readdir(sessionDir('sess-8'))
  assert.match(files[0], /\.bin$/)
})

test('keeps the data URL when the blob write fails', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const homeDir = join(tempHome, '.communicator')
  await rm(homeDir, { recursive: true, force: true })
  await mkdir(join(homeDir, 'sessions'), { recursive: true })
  const blockerDir = join(homeDir, 'sessions', 'attachments')
  await writeFile(blockerDir, 'not a dir')
  const requestFn = respond(nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: Buffer.from('png-bytes') }))
  const res = await downloadRemotePart(imagePart('https://example.com/a.png'), 'sess-9', { requestFn })
  assert.equal(res.part.image_url.url, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
  assert.equal(res.savedTo, null)
  await rm(blockerDir)
})

test('skips the blob write without a session id', async () => {
  const requestFn = respond(nodeResponse({ headers: { 'Content-Type': 'image/png' }, body: Buffer.from('png-bytes') }))
  const res = await downloadRemotePart(imagePart('https://example.com/a.png'), null, { requestFn })
  assert.equal(res.savedTo, null)
  assert.ok(res.dataUrl.startsWith('data:image/png;base64,'))
})

test('blocks loopback and private address literals without fetching', async () => {
  const requestFn = failWith(new Error('should not fetch'))
  for (const url of ['http://127.0.0.1/x.png', 'http://10.0.0.5/x.png', 'http://192.168.1.10/x.png', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x.png']) {
    const res = await downloadRemotePart(imagePart(url), 'sess-blocked', { requestFn })
    assert.match(res.error, /blocked URL/)
    assert.equal(res.dataUrl, undefined)
  }
})

test('blocks hosts resolving to loopback addresses without fetching', async () => {
  const requestFn = failWith(new Error('should not fetch'))
  const res = await downloadRemotePart(imagePart('http://localhost/x.png'), 'sess-local', { requestFn })
  assert.match(res.error, /blocked URL/)
})

test('re-validates redirect targets and blocks hops to private addresses', async () => {
  const requestFn = spyRequest(nodeResponse({ status: 302, headers: { Location: 'http://127.0.0.1/internal.png' } }))
  const res = await downloadRemotePart(imagePart('https://example.com/redir.png'), 'sess-redir', { requestFn })
  assert.match(res.error, /blocked URL/)
  assert.equal(requestFn.calls(), 1)
})

test('follows safe redirects and downloads the final target', async () => {
  let calls = 0
  const requestFn = () => {
    calls++
    const response = calls === 1
      ? nodeResponse({ status: 302, headers: { Location: 'https://example.com/final.png' } })
      : nodeResponse({ status: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.from('final-bytes') })
    return {
      on(event, listener) {
        if (event === 'response') queueMicrotask(() => listener(response))
        return this
      },
      end() {},
    }
  }
  const res = await downloadRemotePart(imagePart('https://example.com/start.png'), 'sess-redir2', { requestFn })
  assert.equal(calls, 2)
  assert.equal(res.error, undefined)
  assert.equal(res.part.image_url.url, `data:image/png;base64,${Buffer.from('final-bytes').toString('base64')}`)
})

test('aborts the body read once the size cap is crossed mid-stream', async () => {
  const chunk = new Uint8Array(1024 * 1024)
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 22; i++) controller.enqueue(chunk)
      controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const requestFn = respond(nodeResponse({ body }))
  const res = await downloadRemotePart(imagePart('https://example.com/streamed.png'), 'sess-cap', { requestFn })
  assert.match(res.error, /exceeds 20 MB/)
  assert.equal(res.dataUrl, undefined)
  assert.equal(cancelled, true)
})
