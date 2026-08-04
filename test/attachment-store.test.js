import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { attachmentDirFor, externalizeAttachments, hydrateAttachments, REF_PREFIX } from '../src/attachment-store.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-attachments-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function dataUrl(mime, text) {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`
}

function messagesWith(parts) {
  return [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: parts },
  ]
}

const PNG_URL = dataUrl('image/png', 'png-bytes')
const JPEG_URL = dataUrl('image/jpeg', 'jpeg-bytes')
const WEBP_URL = dataUrl('image/webp', 'webp-bytes')
const PDF_URL = dataUrl('application/pdf', 'pdf-bytes')
const XLSX_URL = dataUrl('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx-bytes')

test('externalize then hydrate round-trips image_url and file parts to the original data URLs', async (t) => {
  const dir = await tempDir(t)
  const messages = messagesWith([
    { type: 'text', text: 'look at these' },
    { type: 'image_url', image_url: { url: PNG_URL } },
    { type: 'image_url', image_url: { url: JPEG_URL } },
    { type: 'image_url', image_url: { url: WEBP_URL } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: PDF_URL } },
    { type: 'file', file: { filename: 'sheet.xlsx', file_data: XLSX_URL } },
  ])

  const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const refs = externalized[1].content.slice(1).map((p) => (p.type === 'image_url' ? p.image_url.url : p.file.file_data))
  for (const ref of refs) assert.ok(ref.startsWith(REF_PREFIX))

  const files = await readdir(attachmentDirFor(dir, 'sess'))
  assert.equal(files.length, 5)

  const hydrated = await hydrateAttachments(externalized, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.messages, messages)
  assert.deepEqual(hydrated.missing, [])
})

test('extensions on refs are canonical and match the source mime', async (t) => {
  const dir = await tempDir(t)
  const messages = messagesWith([
    { type: 'image_url', image_url: { url: JPEG_URL } },
    { type: 'file', file: { filename: 'a.pdf', file_data: PDF_URL } },
    { type: 'file', file: { filename: 'b.xlsx', file_data: XLSX_URL } },
  ])

  const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const refs = externalized[1].content.map((p) => (p.type === 'image_url' ? p.image_url.url : p.file.file_data))
  assert.match(refs[0], /^ref:\/\/attachments\/[a-f0-9]{64}\.jpg$/)
  assert.match(refs[1], /^ref:\/\/attachments\/[a-f0-9]{64}\.pdf$/)
  assert.match(refs[2], /^ref:\/\/attachments\/[a-f0-9]{64}\.xlsx$/)

  const hydrated = await hydrateAttachments(externalized, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.messages, messages)
})

test('same bytes attached twice dedupe to a single blob file', async (t) => {
  const dir = await tempDir(t)
  const messages = messagesWith([
    { type: 'image_url', image_url: { url: PNG_URL } },
    { type: 'image_url', image_url: { url: PNG_URL } },
  ])

  const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const urls = externalized[1].content.map((p) => p.image_url.url)
  assert.equal(urls[0], urls[1])
  assert.equal((await readdir(attachmentDirFor(dir, 'sess'))).length, 1)
})

test('externalize and hydrate never mutate their input', async (t) => {
  const dir = await tempDir(t)
  const original = messagesWith([
    { type: 'image_url', image_url: { url: PNG_URL } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: PDF_URL } },
    { type: 'text', text: 'plain' },
  ])
  const snapshot = structuredClone(original)

  const externalized = await externalizeAttachments(original, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(original, snapshot)

  const hydratedSnapshot = structuredClone(externalized)
  await hydrateAttachments(externalized, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(externalized, hydratedSnapshot)
})

test('blob write failure keeps the part inline and does not throw', async (t) => {
  const dir = await tempDir(t)
  await chmod(dir, 0o555)
  try {
    const messages = messagesWith([{ type: 'image_url', image_url: { url: PNG_URL } }])
    const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
    assert.equal(externalized[1].content[0].image_url.url, PNG_URL)
  } finally {
    await chmod(dir, 0o755)
  }
})

test('missing blob on hydrate drops the part, reports it, and keeps the rest', async (t) => {
  const dir = await tempDir(t)
  const ref = `${REF_PREFIX}${'ab'.repeat(32)}.png`
  const messages = messagesWith([
    { type: 'text', text: 'still here' },
    { type: 'image_url', image_url: { url: ref } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: `${REF_PREFIX}${'cd'.repeat(32)}.pdf` } },
  ])

  const hydrated = await hydrateAttachments(messages, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.missing, [ref, `${REF_PREFIX}${'cd'.repeat(32)}.pdf`])
  assert.deepEqual(hydrated.messages[1].content, [{ type: 'text', text: 'still here' }])
})

test('inline and non-data values pass through unchanged', async (t) => {
  const dir = await tempDir(t)
  const messages = messagesWith([
    { type: 'text', text: 'raw text' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: 'not-a-data-url' } },
  ])

  const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(externalized, messages)

  const hydrated = await hydrateAttachments(externalized, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.messages, messages)
  assert.deepEqual(hydrated.missing, [])
})

test('unknown mime falls back to bin ext and hydrates as octet-stream', async (t) => {
  const dir = await tempDir(t)
  const url = dataUrl('application/x-weird', 'weird-bytes')
  const messages = messagesWith([{ type: 'file', file: { filename: 'weird.dat', file_data: url } }])

  const externalized = await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  assert.match(externalized[1].content[0].file.file_data, /\.bin$/)

  const hydrated = await hydrateAttachments(externalized, attachmentDirFor(dir, 'sess'))
  assert.equal(hydrated.messages[1].content[0].file.file_data, `data:application/octet-stream;base64,${Buffer.from('weird-bytes').toString('base64')}`)
})

test('blob on disk contains the raw decoded bytes', async (t) => {
  const dir = await tempDir(t)
  const messages = messagesWith([{ type: 'image_url', image_url: { url: PNG_URL } }])

  await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const files = await readdir(attachmentDirFor(dir, 'sess'))
  assert.equal(files.length, 1)
  assert.deepEqual(await readFile(join(attachmentDirFor(dir, 'sess'), files[0])), Buffer.from('png-bytes'))
})
