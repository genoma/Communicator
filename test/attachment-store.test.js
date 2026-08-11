import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { attachmentDirFor, externalizeAttachments, hydrateAttachments, savedAttachmentPath, REF_PREFIX } from '../src/attachment-store.js'

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
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'not a directory')
  t.mock.method(console, 'warn', () => {})
  const messages = messagesWith([{ type: 'image_url', image_url: { url: PNG_URL } }])
  const externalized = await externalizeAttachments(messages, join(blocker, 'attachments', 'sess'))
  assert.equal(externalized[1].content[0].image_url.url, PNG_URL)
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

test('traversal refs are treated as missing and never read', async (t) => {
  const dir = await tempDir(t)
  const secret = join(dir, 'secret.txt')
  await writeFile(secret, 'top secret')
  const traversal = `${REF_PREFIX}../../secret.txt`

  const messages = messagesWith([
    { type: 'image_url', image_url: { url: traversal } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: `${REF_PREFIX}../../../../etc/passwd` } },
  ])
  const hydrated = await hydrateAttachments(messages, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.missing, [traversal, `${REF_PREFIX}../../../../etc/passwd`])
  assert.deepEqual(hydrated.messages[1].content, [])
  assert.equal(savedAttachmentPath(traversal, 'sess'), null)
})

test('refs not matching the hash.ext shape are treated as missing', async (t) => {
  const dir = await tempDir(t)
  const odd = `${REF_PREFIX}short-name.png`
  const messages = messagesWith([{ type: 'image_url', image_url: { url: odd } }])
  const hydrated = await hydrateAttachments(messages, attachmentDirFor(dir, 'sess'))
  assert.deepEqual(hydrated.missing, [odd])
  assert.equal(savedAttachmentPath(odd, 'sess'), null)
  const valid = `${REF_PREFIX}${'a'.repeat(64)}.png`
  const path = savedAttachmentPath(valid, 'sess')
  assert.ok(path)
  assert.ok(path.endsWith(`${'a'.repeat(64)}.png`))
  assert.ok(!path.includes('..'))
})

test('repeat externalization of the same data URL skips re-writing the blob', async (t) => {
  const { stat } = await import('node:fs/promises')
  const dir = await tempDir(t)
  const messages = messagesWith([{ type: 'image_url', image_url: { url: PNG_URL } }])

  await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const blobDir = attachmentDirFor(dir, 'sess')
  const files = await readdir(blobDir)
  assert.equal(files.length, 1)
  const firstMtime = (await stat(join(blobDir, files[0]))).mtimeMs

  await externalizeAttachments(messages, attachmentDirFor(dir, 'sess'))
  const filesAfter = await readdir(blobDir)
  assert.equal(filesAfter.length, 1)
  assert.equal(filesAfter[0], files[0])
  const secondMtime = (await stat(join(blobDir, filesAfter[0]))).mtimeMs
  assert.equal(secondMtime, firstMtime)
})
