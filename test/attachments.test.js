import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_FILE_ATTACHMENT_BYTES, MAX_INLINE_TEXT_ATTACHMENT_BYTES } from '../src/constants.js'
import {
  classifyPath,
  splitPathArgs,
  loadAttachment,
  loadAttachments,
  attachmentGate,
  buildContent,
  contentText,
  messageText,
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

test('splitPathArgs splits on whitespace but keeps backslash-escaped spaces', () => {
  assert.deepEqual(splitPathArgs('a.png b.txt'), ['a.png', 'b.txt'])
  assert.deepEqual(splitPathArgs('/Users/x/Screenshot\\ 2026-07-23\\ at\\ 07.47.31.png'), ['/Users/x/Screenshot 2026-07-23 at 07.47.31.png'])
  assert.deepEqual(splitPathArgs('C:\\Users\\me\\file.png'), ['C:\\Users\\me\\file.png'])
  assert.deepEqual(splitPathArgs('/path\\ with\\ spaces/x.png /plain.png'), ['/path with spaces/x.png', '/plain.png'])
  assert.deepEqual(splitPathArgs(''), [])
  assert.deepEqual(splitPathArgs('   '), [])
})

test('splitPathArgs strips matched double quotes around paths with spaces', () => {
  assert.deepEqual(splitPathArgs('"my notes.txt"'), ['my notes.txt'])
  assert.deepEqual(splitPathArgs('/a.png "my notes.txt" /b.png'), ['/a.png', 'my notes.txt', '/b.png'])
  assert.deepEqual(splitPathArgs('"folder with spaces/file.txt" "other file.txt"'), ['folder with spaces/file.txt', 'other file.txt'])
  assert.deepEqual(splitPathArgs('"unclosed quote'), ['unclosed quote'])
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

test('loadAttachment gates images on the raw file size, not the encoded size', async (t) => {
  const raw = MAX_IMAGE_ATTACHMENT_BYTES * 3 / 4 + 1
  assert.ok(raw < MAX_IMAGE_ATTACHMENT_BYTES)
  const file = await writeFixture(t, 'borderline.png', Buffer.alloc(raw))
  const att = await loadAttachment(file)
  assert.equal(att.kind, 'image')
  assert.equal(att.size, raw)
  assert.ok(att.data.length > MAX_IMAGE_ATTACHMENT_BYTES)
})

test('loadAttachment uses a shrinking image transform and its mime', async (t) => {
  const file = await writeFixture(t, 'photo.png', 'PNGDATA')
  const calls = []
  const att = await loadAttachment(file, {
    transformImage: async (buffer, options) => {
      calls.push({ buffer, options })
      return { buffer: Buffer.from('SMALL'), mime: 'image/webp', resized: true }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].buffer.toString(), 'PNGDATA')
  assert.equal(calls[0].options.mime, 'image/png')
  assert.equal(att.kind, 'image')
  assert.equal(att.mime, 'image/webp')
  assert.equal(att.size, 5)
  assert.equal(att.data, `data:image/webp;base64,${Buffer.from('SMALL').toString('base64')}`)
})

test('loadAttachment keeps the original bytes when the transform returns null', async (t) => {
  const file = await writeFixture(t, 'a.png', 'PNGDATA')
  const att = await loadAttachment(file, { transformImage: async () => null })
  assert.equal(att.mime, 'image/png')
  assert.equal(att.size, 7)
  assert.equal(att.data, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
})

test('loadAttachment keeps the original bytes when the transform exceeds the image limit', async (t) => {
  const file = await writeFixture(t, 'a.png', 'PNGDATA')
  const transformImage = async () => ({ buffer: Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1), mime: 'image/webp', resized: false })
  const att = await loadAttachment(file, { transformImage })
  assert.equal(att.mime, 'image/png')
  assert.equal(att.size, 7)
  assert.equal(att.data, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
})

test('loadAttachment does not transform non-images', async (t) => {
  const pdf = await writeFixture(t, 'report.pdf', '%PDF-1.4')
  const text = await writeFixture(t, 'notes.txt', 'hello')
  let calls = 0
  const transformImage = async () => { calls += 1; return null }
  await loadAttachment(pdf, { transformImage })
  await loadAttachment(text, { transformImage })
  assert.equal(calls, 0)
})

test('loadAttachments threads the image transform through to loadAttachment', async (t) => {
  const first = await writeFixture(t, 'a.png', 'PNGDATA')
  const second = await writeFixture(t, 'b.png', 'PNGDATA2')
  const transformImage = async () => ({ buffer: Buffer.from('X'), mime: 'image/webp', resized: true })
  const { attachments } = await loadAttachments([first, second], {}, { transformImage })
  assert.deepEqual(attachments.map((att) => att.mime), ['image/webp', 'image/webp'])
  assert.deepEqual(attachments.map((att) => att.size), [1, 1])
  assert.deepEqual(attachments.map((att) => att.data), ['data:image/webp;base64,WA==', 'data:image/webp;base64,WA=='])
})

test('loadAttachment rejects pdfs over the 25 MB limit', async (t) => {
  const file = await writeFixture(t, 'huge.pdf', Buffer.alloc(MAX_FILE_ATTACHMENT_BYTES + 1))
  await assert.rejects(loadAttachment(file), /file limit is 25 MB/)
})

test('loadAttachment rejects office files over the 25 MB limit', async (t) => {
  const file = await writeFixture(t, 'huge.xlsx', Buffer.alloc(MAX_FILE_ATTACHMENT_BYTES + 1))
  await assert.rejects(loadAttachment(file), /file limit is 25 MB/)
})

test('loadAttachment rejects text files over the 25 MB limit', async (t) => {
  const file = await writeFixture(t, 'huge.log', Buffer.alloc(MAX_FILE_ATTACHMENT_BYTES + 1))
  await assert.rejects(loadAttachment(file), /text limit is 25 MB/)
})

test('loadAttachment warns about context usage for inline text over 256 KB', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const file = await writeFixture(t, 'big.md', Buffer.alloc(MAX_INLINE_TEXT_ATTACHMENT_BYTES + 1))
  const att = await loadAttachment(file)
  assert.equal(att.kind, 'text')
  assert.equal(att.size, MAX_INLINE_TEXT_ATTACHMENT_BYTES + 1)
  assert.equal(console.warn.mock.calls.length, 1)
  assert.match(console.warn.mock.calls[0].arguments[0], /Warning: big\.md is 256\.0 KB of inline text/)
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

test('contentText passes strings through and joins text parts with newlines', () => {
  assert.equal(contentText('plain'), 'plain')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentText(null), '')
  assert.equal(contentText(undefined), '')
})

test('messageText returns the plain string or only the first text part', () => {
  assert.equal(messageText('plain'), 'plain')
  assert.equal(messageText([{ type: 'text', text: 'msg' }, { type: 'text', text: 'file content' }, { type: 'image_url', image_url: { url: 'x' } }]), 'msg')
  assert.equal(messageText([{ type: 'text', text: 'msg' }, { type: 'image_url', image_url: { url: 'x' } }]), 'msg')
  assert.equal(messageText([{ type: 'image_url', image_url: { url: 'x' } }]), '')
  assert.equal(messageText([]), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText(undefined), '')
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

test('contentAttachments synthesizes image.<ext> names from the data-URL mime', () => {
  assert.deepEqual(contentAttachments([{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AA==' } }]), [
    { filename: 'image.webp', kind: 'image' },
  ])
  assert.deepEqual(contentAttachments([{ type: 'image_url', image_url: { url: 'no-mime' } }]), [
    { filename: 'image', kind: 'image' },
  ])
})

test('contentAttachments derives filenames from remote URLs and keeps the url', () => {
  assert.deepEqual(contentAttachments([{ type: 'image_url', image_url: { url: 'https://img.example/photo.png' } }]), [
    { filename: 'photo.png', kind: 'image', url: 'https://img.example/photo.png' },
  ])
  assert.deepEqual(contentAttachments([{ type: 'file', file: { filename: 'doc.pdf', file_data: 'https://files.example/doc.pdf' } }]), [
    { filename: 'doc.pdf', kind: 'file', url: 'https://files.example/doc.pdf' },
  ])
  assert.deepEqual(contentAttachments([{ type: 'image_url', image_url: { url: 'https://img.example/noext' } }]), [
    { filename: 'image', kind: 'image', url: 'https://img.example/noext' },
  ])
  assert.deepEqual(contentAttachments([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]), [
    { filename: 'image.png', kind: 'image' },
  ])
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
