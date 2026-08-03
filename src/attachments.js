import { readFile, stat } from 'node:fs/promises'
import { extname, basename, resolve } from 'node:path'
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_FILE_ATTACHMENT_BYTES, MAX_INLINE_TEXT_ATTACHMENT_BYTES } from './constants.js'

const IMAGE_MIMES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

const OFFICE_MIMES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const IMAGE_EXTS = new Set(Object.keys(IMAGE_MIMES))

const OFFICE_EXTS = new Set(Object.keys(OFFICE_MIMES))

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'log',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'sh', 'sql',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'ini',
])

export function splitPathArgs(input) {
  const tokens = []
  let current = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\' && i + 1 < input.length && /\s/.test(input[i + 1])) {
      current += input[i + 1]
      i++
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function classifyPath(path) {
  const ext = extname(path).slice(1).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', mime: IMAGE_MIMES[ext] }
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (OFFICE_EXTS.has(ext)) return { kind: 'office', mime: OFFICE_MIMES[ext] }
  if (TEXT_EXTS.has(ext)) return { kind: 'text', mime: 'text/plain' }
  return { kind: null, mime: null }
}

export async function loadAttachment(path) {
  const { kind, mime } = classifyPath(path)
  if (!kind) throw new Error(`Unsupported file type: ${extname(path).slice(1) || '(none)'}`)

  const fullPath = resolve(path)
  let size
  try {
    size = (await stat(fullPath)).size
  } catch {
    throw new Error(`Cannot read attachment: ${path}`)
  }

  const encoded = Math.ceil(size * 4 / 3) + `data:${mime};base64,`.length

  if (kind === 'image' && encoded > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large: ${basename(fullPath)} (image limit is 20 MB)`)
  }
  if ((kind === 'pdf' || kind === 'office') && encoded > MAX_FILE_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large: ${basename(fullPath)} (file limit is 25 MB)`)
  }
  if (kind === 'text' && size > MAX_FILE_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large: ${basename(fullPath)} (text limit is 25 MB)`)
  }

  let buffer
  try {
    buffer = await readFile(fullPath)
  } catch {
    throw new Error(`Cannot read attachment: ${path}`)
  }

  const filename = basename(fullPath)

  if (kind === 'text') {
    if (buffer.length > MAX_INLINE_TEXT_ATTACHMENT_BYTES) {
      console.warn(`Warning: ${filename} is ${formatBytes(buffer.length)} of inline text and will use significant context.`)
    }
    return { kind, filename, mime, size: buffer.length, data: buffer.toString('utf-8') }
  }

  return { kind, filename, mime, size: buffer.length, data: `data:${mime};base64,${buffer.toString('base64')}` }
}

export function attachmentGate(attachments, { visionSupported, fileSupported, providerName }) {
  for (const att of attachments || []) {
    if (att.kind === 'image' && visionSupported === false) {
      return 'The selected model does not support image input.'
    }
    if (att.kind === 'office' && providerName !== 'venice') {
      return 'xlsx/docx/pptx are only supported on Venice (server-side extraction). OpenRouter supports PDFs and text files.'
    }
    if ((att.kind === 'pdf' || att.kind === 'office') && fileSupported === false) {
      return 'The selected model does not support file attachments.'
    }
  }
  return null
}

function toPart(att) {
  if (att.kind === 'image') {
    return { type: 'image_url', image_url: { url: att.data } }
  }
  if (att.kind === 'text') {
    return { type: 'text', text: att.data }
  }
  return { type: 'file', file: { filename: att.filename, file_data: att.data } }
}

export function buildContent(text, attachments = []) {
  if (!attachments.length) return text
  return [{ type: 'text', text }, ...attachments.map(toPart)]
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === 'text').map((p) => p.text).join('')
  }
  return ''
}

export function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.find((p) => p.type === 'text')?.text ?? ''
  }
  return ''
}

export function contentAttachments(content) {
  if (!Array.isArray(content)) return []
  return content.flatMap((p) => {
    if (p.type === 'file') {
      return [{ filename: p.file?.filename || 'file', kind: 'file' }]
    }
    if (p.type === 'image_url') {
      const mime = /^data:([^;,]+)/.exec(p.image_url?.url || '')?.[1]
      const ext = mime?.split('/')[1]
      return [{ filename: ext ? `image.${ext}` : 'image', kind: 'image' }]
    }
    return []
  })
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
