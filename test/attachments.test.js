import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../src/constants.js'
import {
  classifyPath,
  loadAttachment,
  attachmentGate,
  buildContent,
  contentText,
  contentAttachments,
  formatBytes,
} from '../src/attachments.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeFixture(t, name, bytes) {
  const dir = await tempDir(t)
  const file = join(dir, name)
  await writeFile(file, bytes)
  return file
}

test('classifyPath maps extensions to kinds and mimes', () => {
  assert.deepEqual(classifyPath('a.png'), { kind: 'image', mime: 'image/png' })
  assert.deepEqual(classifyPath('A.JPEG'), { kind: 'image', mime: 'image/jpeg' })
  assert.deepEqual(classifyPath('a.gif'), { kind: 'image', mime: 'image/gif' })
  assert.deepEqual(classifyPath('a.webp'), { kind: 'image', mime: 'image/webp' })
  assert.deepEqual(classifyPath('a.bmp'), { kind: 'image', mime: 'image/bmp' })
  assert.deepEqual(classifyPath('a.pdf'), { kind: 'pdf', mime: 'application/pdf' })
  assert.deepEqual(classifyPath('a.xlsx'), { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  assert.deepEqual(classifyPath('a.xls'), { kind: 'office', mime: 'application/vnd.ms-excel' })
  assert.deepEqual(classifyPath('a.docx'), { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  assert.deepEqual(classifyPath('a.pptx'), { kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  assert.deepEqual(classifyPath('a.txt'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyPath('a.md'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyPath('a.json'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyPath('a.py'), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(classifyPath('a.exe'), { kind: null, mime: null })
  assert.deepEqual(classifyPath('Makefile'), { kind: null, mime: null })
})

test('loadAttachment encodes images as base64 data URLs', async (t) => {
  const file = await writeFixture(t, 'shot.png', 'PNGDATA')
  const att = await loadAttachment(file)
  assert.equal(att.kind, 'image')
  assert.equal(att.filename, 'shot.png')
  assert.equal(att.mime, 'image/png')
  assert.equal(att.size, 7)
  assert.equal(att.data, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
})

test('loadAttachment encodes pdfs as base64 data URLs with filename', async (t) => {
  const file = await writeFixture(t, 'report.pdf', '%PDF-1.4')
  const att = await loadAttachment(file)
  assert.equal(att.kind, 'pdf')
  assert.equal(att.mime, 'application/pdf')
  assert.equal(att.data, `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`)
})

test('loadAttachment inlines text files as utf-8 strings', async (t) => {
  const file = await writeFixture(t, 'notes.txt', 'hello world')
  const att = await loadAttachment(file)
  assert.equal(att.kind, 'text')
  assert.equal(att.mime, 'text/plain')
  assert.equal(att.data, 'hello world')
  assert.equal(att.size, 11)
})

test('loadAttachment throws for unsupported extensions', async (t) => {
  const file = await writeFixture(t, 'malware.exe', 'x')
  await assert.rejects(loadAttachment(file), /Unsupported file type: exe/)
})

test('loadAttachment throws for missing files', async (t) => {
  await assert.rejects(loadAttachment(join(await tempDir(t), 'nope.png')), /Cannot read attachment/)
})

test('loadAttachment rejects images over the 20 MB limit', async (t) => {
  const file = await writeFixture(t, 'huge.png', Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1))
  await assert.rejects(loadAttachment(file), /image limit is 20 MB/)
})

test('buildContent returns the plain string when there are no attachments', () => {
  assert.equal(buildContent('hello'), 'hello')
  assert.equal(buildContent('hello', []), 'hello')
})

test('buildContent builds a parts array with text plus wire parts', () => {
  const content = buildContent('look', [
    { kind: 'image', filename: 'a.png', mime: 'image/png', size: 1, data: 'data:image/png;base64,AA==' },
    { kind: 'pdf', filename: 'b.pdf', mime: 'application/pdf', size: 1, data: 'data:application/pdf;base64,BB==' },
    { kind: 'text', filename: 'c.txt', mime: 'text/plain', size: 1, data: 'file text' },
  ])
  assert.deepEqual(content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    { type: 'file', file: { filename: 'b.pdf', file_data: 'data:application/pdf;base64,BB==' } },
    { type: 'text', text: 'file text' },
  ])
})

test('contentText passes strings through and concatenates text parts', () => {
  assert.equal(contentText('plain'), 'plain')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(contentText(null), '')
  assert.equal(contentText(undefined), '')
})

test('contentAttachments lists file and image parts', () => {
  const content = [
    { type: 'text', text: 'hi' },
    { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,AA==' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BB==' } },
  ]
  assert.deepEqual(contentAttachments(content), [
    { filename: 'report.pdf', kind: 'file' },
    { filename: 'image.png', kind: 'image' },
  ])
  assert.deepEqual(contentAttachments('plain'), [])
})

test('attachmentGate blocks images when vision is explicitly unsupported', () => {
  const err = attachmentGate([{ kind: 'image' }], { visionSupported: false, fileSupported: true, providerName: 'openrouter' })
  assert.equal(err, 'The selected model does not support image input.')
})

test('attachmentGate blocks office files outside venice', () => {
  const err = attachmentGate([{ kind: 'office' }], { visionSupported: undefined, fileSupported: true, providerName: 'openrouter' })
  assert.equal(err, 'xlsx/docx/pptx are only supported on Venice (server-side extraction). OpenRouter supports PDFs and text files.')
})

test('attachmentGate blocks file parts when file support is explicitly off', () => {
  const pdfErr = attachmentGate([{ kind: 'pdf' }], { visionSupported: undefined, fileSupported: false, providerName: 'venice' })
  assert.equal(pdfErr, 'The selected model does not support file attachments.')
  const officeErr = attachmentGate([{ kind: 'office' }], { visionSupported: undefined, fileSupported: false, providerName: 'venice' })
  assert.equal(officeErr, 'The selected model does not support file attachments.')
})

test('attachmentGate allows unknown capabilities and supported models', () => {
  assert.equal(attachmentGate([{ kind: 'image' }], { visionSupported: undefined, fileSupported: true, providerName: 'openrouter' }), null)
  assert.equal(attachmentGate([{ kind: 'image' }], { visionSupported: true, fileSupported: true, providerName: 'openrouter' }), null)
  assert.equal(attachmentGate([{ kind: 'pdf' }], { visionSupported: undefined, fileSupported: true, providerName: 'openrouter' }), null)
  assert.equal(attachmentGate([{ kind: 'office' }], { visionSupported: undefined, fileSupported: true, providerName: 'venice' }), null)
  assert.equal(attachmentGate([], { visionSupported: false, fileSupported: false, providerName: 'openrouter' }), null)
})

test('formatBytes renders byte, KB and MB sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')
})
