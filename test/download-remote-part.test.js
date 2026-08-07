import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

test('downloads a remote image into the session attachment dir', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const res = await downloadRemotePart(imagePart('https://img.example/photo.png'), 'sess-1')

  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(res.error, undefined)
  assert.equal(res.part.image_url.url, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
  const dir = sessionDir('sess-1')
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{64}\.png$/)
  assert.deepEqual(await readFile(join(dir, files[0])), Buffer.from('png-bytes'))
  assert.equal(res.savedTo, join(dir, files[0]))
})

test('passes inline data URLs through without fetching', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const part = imagePart('data:image/png;base64,AAAA')
  const res = await downloadRemotePart(part, 'sess-2')
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.deepEqual(res, { part })
})

test('rejects non-http URLs without fetching', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch') })
  const res = await downloadRemotePart(filePart('ftp://files.example/doc.pdf'), 'sess-3')
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(res.error, 'unsupported URL')
  assert.equal(res.dataUrl, undefined)
})

test('reports the status when the remote responds with an error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 404 }))
  const res = await downloadRemotePart(imagePart('https://img.example/missing.png'), 'sess-4')
  assert.equal(res.error, 'HTTP 404')
  assert.equal(res.dataUrl, undefined)
  assert.equal(res.savedTo, undefined)
})

test('reports network failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new ApiError('network down', { retryable: false }) })
  const res = await downloadRemotePart(imagePart('https://img.example/a.png'), 'sess-5')
  assert.equal(res.error, 'network down')
})

test('rejects responses over the size cap', async (t) => {
  const big = new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1)
  t.mock.method(globalThis, 'fetch', async () => new Response(big, { status: 200 }))
  const res = await downloadRemotePart(imagePart('https://img.example/huge.png'), 'sess-6')
  assert.match(res.error, /exceeds 20 MB/)
  assert.equal(res.dataUrl, undefined)
})

test('rejects oversized responses from the content-length header without reading the body', async (t) => {
  let bodyRead = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('small'))
      controller.close()
    },
    pull() {
      bodyRead = true
    },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(MAX_IMAGE_ATTACHMENT_BYTES + 1) },
  }))
  const res = await downloadRemotePart(imagePart('https://img.example/huge.png'), 'sess-10')
  assert.match(res.error, /exceeds 20 MB/)
  assert.equal(res.dataUrl, undefined)
  assert.equal(bodyRead, false)
})

test('infers the extension from the URL when no content-type is sent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('bytes'), { status: 200 }))
  const res = await downloadRemotePart(imagePart('https://img.example/photo.webp'), 'sess-7')
  assert.equal(res.part.image_url.url, `data:image/webp;base64,${Buffer.from('bytes').toString('base64')}`)
})

test('falls back to bin ext and octet-stream when nothing identifies the type', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('bytes'), { status: 200 }))
  const res = await downloadRemotePart(filePart('https://files.example/blob'), 'sess-8')
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
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const res = await downloadRemotePart(imagePart('https://img.example/a.png'), 'sess-9')
  assert.equal(res.part.image_url.url, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
  assert.equal(res.savedTo, null)
  await rm(blockerDir)
})

test('skips the blob write without a session id', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('png-bytes'), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }))
  const res = await downloadRemotePart(imagePart('https://img.example/a.png'), null)
  assert.equal(res.savedTo, null)
  assert.ok(res.dataUrl.startsWith('data:image/png;base64,'))
})
