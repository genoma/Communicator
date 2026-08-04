import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extForMime, mimeForExt } from './attachments.js'

export const REF_PREFIX = 'ref://attachments/'

export function attachmentDirFor(sessionsDir, sessionId) {
  return join(sessionsDir, 'attachments', sessionId)
}

function dataUrlInfo(value) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
  if (!match) return null
  return { mime: match[1], base64: match[2] }
}

function refName(ref) {
  const name = ref.slice(REF_PREFIX.length)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? { file: name, ext: 'bin' } : { file: name, ext: name.slice(dot + 1) }
}

async function externalizeDataUrl(value, dir) {
  const info = dataUrlInfo(value)
  if (!info) return value

  const bytes = Buffer.from(info.base64, 'base64')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const ext = extForMime(info.mime)
  const ref = `${REF_PREFIX}${hash}.${ext}`

  try {
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(join(dir, `${hash}.${ext}`), bytes, { flag: 'wx' })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    return ref
  } catch (err) {
    console.warn(`Warning: could not store attachment blob: ${err.message}`)
    return value
  }
}

export async function externalizeAttachments(messages, dir) {
  const cloned = structuredClone(messages)
  for (const message of cloned) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:')) {
        part.image_url.url = await externalizeDataUrl(part.image_url.url, dir)
      } else if (part?.type === 'file' && typeof part.file?.file_data === 'string' && part.file.file_data.startsWith('data:')) {
        part.file.file_data = await externalizeDataUrl(part.file.file_data, dir)
      }
    }
  }
  return cloned
}

async function hydrateRef(ref, dir) {
  const { file, ext } = refName(ref)
  try {
    const bytes = await readFile(join(dir, file))
    return `data:${mimeForExt(ext)};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

export async function hydrateAttachments(messages, dir) {
  const missing = []
  const cloned = structuredClone(messages)
  for (const message of cloned) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    const kept = []
    for (const part of content) {
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith(REF_PREFIX)) {
        const url = await hydrateRef(part.image_url.url, dir)
        if (url === null) {
          missing.push(part.image_url.url)
          continue
        }
        part.image_url.url = url
      } else if (part?.type === 'file' && typeof part.file?.file_data === 'string' && part.file.file_data.startsWith(REF_PREFIX)) {
        const url = await hydrateRef(part.file.file_data, dir)
        if (url === null) {
          missing.push(part.file.file_data)
          continue
        }
        part.file.file_data = url
      }
      kept.push(part)
    }
    message.content = kept
  }
  return { messages: cloned, missing }
}
