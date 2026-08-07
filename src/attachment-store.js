import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extForMime, mimeForExt, partUrl } from './attachments.js'
import { fetchWithRetry } from './http.js'
import { ApiError } from './errors.js'
import { SESSIONS_DIR, MAX_IMAGE_ATTACHMENT_BYTES, MAX_FILE_ATTACHMENT_BYTES } from './constants.js'

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

// Fetches a model-produced artifact (remote URL) and stores it in the
// session's attachment dir, replacing the part's URL with a data URL on
// success. Inline data URLs pass through untouched. Returns
// { part, dataUrl?, savedTo? } on success and { part, error } on failure —
// the original URL stays in the part when download fails.
export async function downloadRemotePart(part, sessionId) {
  const url = partUrl(part)
  if (!url || typeof url !== 'string') return { part, error: 'no URL' }
  if (url.startsWith('data:')) return { part }
  if (!/^https?:\/\//.test(url)) return { part, error: 'unsupported URL' }

  const limit = part.type === 'image_url' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES

  let res
  try {
    res = await fetchWithRetry(url, {}, {
      timeoutMs: 30_000,
      attempts: 2,
      errorResponse: (status) => new ApiError(`HTTP ${status}`, { status, retryable: false }),
    })
  } catch (err) {
    return { part, error: err?.message || 'network error' }
  }

  let bytes
  try {
    const contentLength = Number(res.headers.get('content-length') || 0)
    if (contentLength > limit) {
      return { part, error: `response exceeds ${Math.round(limit / 1024 / 1024)} MB` }
    }
    bytes = Buffer.from(await res.arrayBuffer())
  } catch {
    return { part, error: 'could not read response body' }
  }
  if (bytes.length > limit) {
    return { part, error: `response exceeds ${Math.round(limit / 1024 / 1024)} MB` }
  }

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim()
  let ext = mime ? extForMime(mime) : ''
  if (!ext || ext === 'bin') {
    try {
      const last = new URL(url).pathname.split('/').pop() || ''
      const dot = last.lastIndexOf('.')
      if (dot !== -1 && last.slice(dot + 1).length <= 5) ext = last.slice(dot + 1).toLowerCase()
    } catch { /* invalid URL: keep the mime-derived extension */ }
  }
  if (!ext) ext = 'bin'
  const dataUrl = `data:${mime || mimeForExt(ext)};base64,${bytes.toString('base64')}`
  if (part.type === 'image_url') part.image_url.url = dataUrl
  else if (part.type === 'file') part.file.file_data = dataUrl

  let savedTo = null
  if (sessionId) {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const dir = attachmentDirFor(SESSIONS_DIR, sessionId)
    const file = `${hash}.${ext}`
    try {
      await mkdir(dir, { recursive: true })
      try {
        await writeFile(join(dir, file), bytes, { flag: 'wx' })
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
      savedTo = join(dir, file)
    } catch (err) {
      console.warn(`Warning: could not store produced attachment blob: ${err.message}`)
    }
  }

  return { part, dataUrl, savedTo }
}
