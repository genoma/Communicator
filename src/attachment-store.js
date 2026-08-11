import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { extForMime, mimeForExt, partUrl } from './attachments.js'
import { fetchWithRedirects, fetchWithTimeout, readBodyWithDeadline } from './http.js'
import { SESSIONS_DIR, MAX_IMAGE_ATTACHMENT_BYTES, MAX_FILE_ATTACHMENT_BYTES } from './constants.js'

export const REF_PREFIX = 'ref://attachments/'

// Refs are generated as sha256-hex + a short lowercase alnum extension; any
// other shape (traversal, arbitrary names) is treated as missing.
const REF_NAME_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/

export function attachmentDirFor(sessionsDir, sessionId) {
  return join(sessionsDir, 'attachments', sessionId)
}

export function dataUrlInfo(value) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
  if (!match) return null
  return { mime: match[1], base64: match[2] }
}

function refName(ref) {
  const name = ref.slice(REF_PREFIX.length)
  if (!REF_NAME_RE.test(name)) return null
  const dot = name.lastIndexOf('.')
  return { file: name, ext: name.slice(dot + 1) }
}

export function savedAttachmentPath(ref, sessionId) {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return null
  const parsed = refName(ref)
  if (!parsed) return null
  const base = resolve(attachmentDirFor(SESSIONS_DIR, sessionId))
  const target = resolve(join(base, parsed.file))
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

// Writes a content-addressed blob file (wx: never overwrites, so a hash
// collision or repeat store is a no-op). Returns the stored path or an error
// message; the caller decides how to degrade.
async function storeBlob(dir, file, bytes) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await writeFile(join(dir, file), bytes, { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    return { path: join(dir, file), error: null }
  } catch (err) {
    return { path: null, error: err?.message || 'could not store blob' }
  }
}

async function externalizeDataUrl(value, dir) {
  const info = dataUrlInfo(value)
  if (!info) return value

  // Blobs are content-addressed, so the same data URL in the same session
  // dir always maps to the same ref; remembering it skips re-hashing every
  // attachment on every session save. Keyed by dir because blobs are stored
  // per session, not shared across sessions.
  const cacheKey = `${dir}\u0000${value}`
  const cached = dataUrlRefCache.get(cacheKey)
  if (cached) return cached

  const bytes = Buffer.from(info.base64, 'base64')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const ext = extForMime(info.mime)
  const ref = `${REF_PREFIX}${hash}.${ext}`

  const { path, error } = await storeBlob(dir, `${hash}.${ext}`, bytes)
  if (path) {
    dataUrlRefCache.set(cacheKey, ref)
    return ref
  }
  console.warn(`Warning: could not store attachment blob: ${error}`)
  return value
}

const dataUrlRefCache = new Map()

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
  const parsed = refName(ref)
  if (!parsed) return null
  try {
    const bytes = await readFile(join(dir, parsed.file))
    return `data:${mimeForExt(parsed.ext)};base64,${bytes.toString('base64')}`
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
  const exceedsMsg = `response exceeds ${Math.round(limit / 1024 / 1024)} MB`

  // Redirects are followed manually so every hop is SSRF-checked; fetch
  // would otherwise follow them unchecked.
  const { res, error, url: finalUrl } = await fetchWithRedirects(url, (current) =>
    fetchWithTimeout(current, { redirect: 'manual' }, { timeoutMs: 30_000 })
  )
  if (!res) return { part, error: error || 'could not fetch URL' }
  if (res.status >= 400) return { part, error: `HTTP ${res.status}` }

  let bytes
  try {
    const contentLength = Number(res.headers.get('content-length') || 0)
    if (contentLength > limit) {
      return { part, error: exceedsMsg }
    }
    bytes = await readBodyWithDeadline(res, { limit, timeoutMs: 30_000 })
  } catch (err) {
    return { part, error: err?.message || 'could not read response body' }
  }
  if (!bytes) return { part, error: exceedsMsg }

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim()
  let ext = mime ? extForMime(mime) : ''
  if (!ext || ext === 'bin') {
    try {
      const last = new URL(finalUrl).pathname.split('/').pop() || ''
      const dot = last.lastIndexOf('.')
      if (dot !== -1 && /^[a-z0-9]{1,5}$/.test(last.slice(dot + 1).toLowerCase())) ext = last.slice(dot + 1).toLowerCase()
    } catch { /* invalid URL: keep the mime-derived extension */ }
  }
  if (!ext) ext = 'bin'
  const dataUrl = `data:${mime || mimeForExt(ext)};base64,${bytes.toString('base64')}`
  if (part.type === 'image_url') part.image_url.url = dataUrl
  else if (part.type === 'file') part.file.file_data = dataUrl

  let savedTo = null
  if (sessionId) {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const { path, error: storeError } = await storeBlob(attachmentDirFor(SESSIONS_DIR, sessionId), `${hash}.${ext}`, bytes)
    if (path) savedTo = path
    else console.warn(`Warning: could not store produced attachment blob: ${storeError}`)
  }

  return { part, dataUrl, savedTo }
}
