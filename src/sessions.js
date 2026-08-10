import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { SESSIONS_DIR } from './constants.js'
import { selectSession, selectSessions } from './session-picker.js'
import { messageText } from './attachments.js'
import { attachmentDirFor, externalizeAttachments, hydrateAttachments } from './attachment-store.js'
import { CliError } from './errors.js'

const SIDECAR_FILE = '.index.json'

// Session ids are app-generated timestamps; anything else (path separators,
// dots, other characters) is rejected so ids can never escape the sessions dir.
function validSessionId(id) {
  return typeof id === 'string' && id.length > 0 && /^[\w:+-]+$/.test(id) && !id.includes('..')
}

export async function ensureSessionsDir() {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 })
  return SESSIONS_DIR
}

export async function createNewSession(dir = null) {
  const d = dir || await ensureSessionsDir()
  const sessionId = await generateSessionId(d)
  return { dir: d, sessionId, createdAt: new Date().toISOString() }
}

async function resolveSession(dir, partialId) {
  const sessions = await listSessions(dir)
  return sessions.filter((s) => s.id.startsWith(partialId))
}

export async function resolveSessionInteractive(dir, partialId, opts = {}) {
  const { message } = opts
  if (partialId && typeof partialId === 'string') {
    const matches = await resolveSession(dir, partialId)
    if (matches.length === 0) {
      throw new CliError(`Error: No session found matching "${partialId}"`)
    }
    if (matches.length === 1) {
      return matches[0].id
    }
    return selectSession(matches, { message })
  }

  const sessions = await listSessions(dir)
  if (!sessions.length) {
    throw new CliError('Error: No saved sessions found.')
  }
  return selectSession(sessions, { message })
}

export async function resolveSessionsInteractive(dir, partialId, opts = {}) {
  const { message } = opts
  if (partialId && typeof partialId === 'string') {
    const matches = await resolveSession(dir, partialId)
    if (matches.length === 0) {
      throw new CliError(`Error: No session found matching "${partialId}"`)
    }
    if (matches.length === 1) {
      return [matches[0].id]
    }
    return [await selectSession(matches, { message })]
  }

  const sessions = await listSessions(dir)
  if (!sessions.length) {
    throw new CliError('Error: No saved sessions found.')
  }
  return selectSessions(sessions, { message })
}

function firstUserText(messages) {
  const first = (messages || []).find((m) => m.role === 'user')
  return first ? String(messageText(first.content) || '') : ''
}

function firstUserPreview(messages) {
  return firstUserText(messages).slice(0, 60)
}

export function generateTitle(messages) {
  const collapsed = firstUserText(messages).replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > 50 ? collapsed.slice(0, 50) + '...' : collapsed
}

export function formatSessionTime(value, { utc = false } = {}) {
  if (!value) return 'Unknown'
  let time = String(value).replace('T', ' ')
  time = time.replace(/^(\d{4}-\d{2}-\d{2} )(\d{2})-(\d{2})-(\d{2})/, '$1$2:$3:$4')
  if (utc) time = time.replace(/\.\d+Z$/, '') + ' UTC'
  return time
}

export function buildSessionPayload({ messages, modelId, endpointProviderName, providerType, reasoningEffort, temperature, budget, webSearch, webResults, pricing, contextLength, supportsReasoning, webSearchSupported, isImageModel = false, e2ee = false, createdAt }) {
  return {
    model: modelId,
    providerName: endpointProviderName,
    providerType,
    reasoningEffort: reasoningEffort === undefined ? 'auto' : reasoningEffort,
    temperature,
    budget: budget ?? null,
    webSearch,
    webResults: webResults ?? null,
    pricing: pricing ?? null,
    contextLength: contextLength ?? null,
    supportsReasoning: supportsReasoning ?? null,
    webSearchSupported: webSearchSupported ?? null,
    isImageModel,
    e2ee,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: generateTitle(messages),
    messages,
  }
}

async function readSidecar(dir) {
  try {
    return JSON.parse(await readFile(join(dir, SIDECAR_FILE), 'utf-8'))
  } catch {
    return null
  }
}

async function writeSidecar(dir, index) {
  try {
    await writeFile(join(dir, SIDECAR_FILE), JSON.stringify(index, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // sidecar failures are non-fatal
  }
}

async function sidecarStale(dir, sidecarPath) {
  try {
    const sidecarStat = await stat(sidecarPath)
    const entries = await readdir(dir)
    for (const file of entries) {
      if (!file.startsWith('.') && extname(file) === '.json') {
        const fileStat = await stat(join(dir, file))
        if (fileStat.mtimeMs > sidecarStat.mtimeMs) return true
      }
    }
    return false
  } catch {
    return true
  }
}

function toSessionItem(id, meta) {
  return {
    id,
    model: meta.model || 'unknown',
    providerName: meta.providerName || 'unknown',
    providerType: meta.providerType || 'openrouter',
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null,
    messageCount: meta.messageCount || 0,
    preview: meta.preview || '',
    title: meta.title || '',
  }
}

const byIdDesc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

async function parseSessionFiles(dir, jsonFiles) {
  const sessions = []
  for (const file of jsonFiles) {
    const id = basename(file, '.json')

    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf-8'))
      const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      if (msgCount <= 1) continue

      sessions.push(toSessionItem(id, {
        model: parsed.model,
        providerName: parsed.providerName,
        providerType: parsed.providerType,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        messageCount: msgCount,
        preview: firstUserPreview(parsed.messages),
        title: parsed.title,
      }))
    } catch {
      // skip corrupt session files
    }
  }
  return sessions.sort(byIdDesc)
}

export async function listSessions(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const jsonFiles = entries.filter((f) => !f.startsWith('.') && extname(f) === '.json')
  const sidecarPath = join(dir, SIDECAR_FILE)
  const index = await readSidecar(dir)

  if (index && Object.keys(index).length > 0 && !(await sidecarStale(dir, sidecarPath))) {
    // A session file deleted outside the app (or a stale sidecar key) leaves
    // a ghost entry: drop entries whose files no longer exist so the picker
    // never offers a resume that fails.
    const valid = []
    for (const [id, meta] of Object.entries(index)) {
      if (await sessionFileExists(dir, id)) valid.push(toSessionItem(id, meta))
      else await dropSidecarEntry(dir, id)
    }
    return valid.sort(byIdDesc)
  }

  const sessions = await parseSessionFiles(dir, jsonFiles)
  await writeSidecar(dir, Object.fromEntries(sessions.map((s) => [s.id, s])))
  return sessions
}

export async function persistSessionFile(id, payload) {
  try {
    const dir = await ensureSessionsDir()
    await saveSession(dir, id, payload)
  } catch {
    // saveSession already logs its own warnings
  }
}

// Removes the 0-byte placeholder left by generateSessionId when the flow
// that claimed the id fails before saving; content-bearing files are never
// touched.
export async function removeEmptySessionClaim(dir, id) {
  try {
    const file = join(dir, `${id}.json`)
    const info = await stat(file)
    if (info.size === 0) await rm(file, { force: true })
  } catch {
    // file missing or unreadable: nothing to clean
  }
}

export async function saveSession(dir, id, data) {
  const filePath = join(dir, `${id}.json`)
  if (!data.messages || data.messages.length <= 1) {
    // The id may have been claimed by generateSessionId (empty wx file) but
    // never filled in; drop the placeholder so it does not linger.
    await removeEmptySessionClaim(dir, id)
    return
  }

  try {
    const payload = { ...data, messages: await externalizeAttachments(data.messages, attachmentDirFor(dir, id)) }
    await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    await updateSidecar(dir, id, payload)
  } catch (err) {
    if (err.code === 'ENOSPC') {
      console.error('Warning: disk full, could not save session')
      return
    }
    console.error(`Warning: could not save session: ${err.message}`)
  }
}

async function updateSidecar(dir, id, data) {
  try {
    const index = (await readSidecar(dir)) || {}
    index[id] = {
      ...toSessionItem(id, {
        model: data.model,
        providerName: data.providerName,
        providerType: data.providerType,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: data.messages.length,
        preview: firstUserPreview(data.messages),
        title: data.title,
      }),
    }
    delete index[id].id
    await writeSidecar(dir, index)
  } catch {
    // sidecar failures are non-fatal
  }
}

async function dropSidecarEntry(dir, id) {
  try {
    const index = (await readSidecar(dir)) || {}
    if (index[id]) {
      delete index[id]
      await writeSidecar(dir, index)
    }
  } catch {
    // sidecar failures are non-fatal
  }
}

async function sessionFileExists(dir, id) {
  try {
    await access(join(dir, `${id}.json`))
    return true
  } catch {
    return false
  }
}

export async function generateSessionId(dir) {
  const baseId = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
  let sessionId = baseId
  let suffix = 1
  // Claim the id by creating the file exclusively: check-then-create would
  // race between two processes starting in the same second.
  while (true) {
    try {
      await writeFile(join(dir, `${sessionId}.json`), '', { flag: 'wx', mode: 0o600 })
      return sessionId
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      suffix++
      sessionId = `${baseId}-${suffix}`
    }
  }
}

export async function loadSession(dir, id) {
  if (!validSessionId(id)) {
    throw new CliError(`Error: Invalid session id "${id}".`)
  }
  const filePath = join(dir, `${id}.json`)
  let data
  try {
    const raw = await readFile(filePath, 'utf-8')
    data = JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') {
      await dropSidecarEntry(dir, id)
      throw new CliError(`Error: Session file "${id}" is missing. It may have been deleted.`)
    }
    if (err instanceof SyntaxError) {
      throw new CliError(`Error: Session file is corrupt: ${filePath}`)
    }
    throw new CliError(`Error: Could not read session file: ${filePath} (${err.message})`)
  }

  if (!data || !data.model || !Array.isArray(data.messages)) {
    throw new CliError(`Error: Session file is corrupt: ${filePath}`)
  }

  const { messages, missing } = await hydrateAttachments(data.messages, attachmentDirFor(dir, id))
  for (const ref of missing) {
    console.warn(`Warning: missing attachment ${ref}`)
  }
  data.messages = messages

  return data
}

export function formatSessionItem(s) {
  const time = formatSessionTime(s.id)
  const model = s.model.length > 35 ? s.model.slice(0, 32) + '...' : s.model
  const count = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`
  const preview = s.title || s.preview || ''
  const previewText = preview ? `"${preview}${preview.length >= 60 ? '...' : ''}"` : ''
  const line = `${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${previewText}`
  return { time, model, count, preview, line }
}

export async function deleteSession(dir, id) {
  if (!validSessionId(id)) {
    throw new CliError(`Error: Invalid session id "${id}".`)
  }
  await rm(join(dir, `${id}.json`), { force: true })
  await rm(attachmentDirFor(dir, id), { recursive: true, force: true })
  const index = await readSidecar(dir)
  if (index && index[id]) {
    delete index[id]
    await writeSidecar(dir, index)
  }
}

// Wipes the whole sessions dir: every session JSON file (including corrupt
// files and empty claims — the sweep does not rely on listSessions parsing),
// the .index.json sidecar and the attachments dir. Returns the count of
// non-hidden .json files removed; a missing dir yields 0.
export async function deleteAllSessions(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  let removed = 0
  for (const file of entries) {
    if (file.startsWith('.') || extname(file) !== '.json') continue
    const id = basename(file, '.json')
    if (!validSessionId(id)) continue
    await rm(join(dir, file), { force: true })
    removed++
  }
  await rm(join(dir, SIDECAR_FILE), { force: true })
  await rm(join(dir, 'attachments'), { recursive: true, force: true })
  return removed
}
