import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { SESSIONS_DIR } from './constants.js'
import { selectSession } from './session-picker.js'

const SIDECAR_FILE = '.index.json'

export async function ensureSessionsDir() {
  await mkdir(SESSIONS_DIR, { recursive: true })
  return SESSIONS_DIR
}

export async function resolveSession(dir, partialId) {
  const sessions = await listSessions(dir)
  return sessions.filter((s) => s.id.startsWith(partialId))
}

export async function resolveSessionInteractive(dir, partialId, opts = {}) {
  const { message } = opts
  if (partialId && typeof partialId === 'string') {
    const matches = await resolveSession(dir, partialId)
    if (matches.length === 0) {
      console.error(`No session found matching "${partialId}"`)
      process.exit(1)
    }
    if (matches.length === 1) {
      return matches[0].id
    }
    return selectSession(matches, { message })
  }

  const sessions = await listSessions(dir)
  if (!sessions.length) {
    console.log('No saved sessions found.')
    process.exit(0)
  }
  return selectSession(sessions, { message })
}

function firstUserPreview(messages) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      return String(messages[i].content || '').slice(0, 60)
    }
  }
  return ''
}

export function generateTitle(messages) {
  const first = (messages || []).find((m) => m.role === 'user')
  if (!first) return ''
  const collapsed = String(first.content || '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > 50 ? collapsed.slice(0, 50) + '...' : collapsed
}

export function buildSessionPayload({ messages, modelId, endpointProviderName, providerType, reasoningEffort, temperature, budget, webSearch, webResults, pricing, createdAt }) {
  return {
    model: modelId,
    providerName: endpointProviderName,
    providerType,
    reasoningEffort: reasoningEffort ?? null,
    temperature,
    budget: budget ?? null,
    webSearch,
    webResults: webResults ?? null,
    pricing: pricing ?? null,
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
    await writeFile(join(dir, SIDECAR_FILE), JSON.stringify(index, null, 2) + '\n')
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

async function parseSessionFiles(dir, jsonFiles) {
  const sessions = []
  for (const file of jsonFiles) {
    const id = basename(file, '.json')

    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf-8'))
      const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      if (msgCount <= 1) continue

      sessions.push({
        id,
        model: parsed.model || 'unknown',
        providerName: parsed.providerName || 'unknown',
        providerType: parsed.providerType || 'openrouter',
        createdAt: parsed.createdAt || null,
        updatedAt: parsed.updatedAt || null,
        messageCount: msgCount,
        preview: firstUserPreview(parsed.messages),
        title: parsed.title || '',
      })
    } catch {
      // skip corrupt session files
    }
  }
  return sessions.sort((a, b) => b.id.localeCompare(a.id))
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
    return Object.entries(index)
      .map(([id, meta]) => toSessionItem(id, meta))
      .sort((a, b) => b.id.localeCompare(a.id))
  }

  const sessions = await parseSessionFiles(dir, jsonFiles)
  await writeSidecar(dir, Object.fromEntries(sessions.map((s) => [s.id, s])))
  return sessions
}

export async function saveSession(dir, id, data) {
  if (!data.messages || data.messages.length <= 1) return

  const filePath = join(dir, `${id}.json`)
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n')
    await updateSidecar(dir, id, data)
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
      model: data.model || 'unknown',
      providerName: data.providerName || 'unknown',
      providerType: data.providerType || 'openrouter',
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      messageCount: data.messages.length,
      preview: firstUserPreview(data.messages),
      title: data.title || '',
    }
    await writeSidecar(dir, index)
  } catch {
    // sidecar failures are non-fatal
  }
}

export async function generateSessionId(dir) {
  const baseId = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
  let sessionId = baseId
  let suffix = 1
  const existing = (await listSessions(dir)).map((s) => s.id)
  while (existing.includes(sessionId)) {
    suffix++
    sessionId = `${baseId}-${suffix}`
  }
  return sessionId
}

export async function loadSession(dir, id) {
  const filePath = join(dir, `${id}.json`)
  const raw = await readFile(filePath, 'utf-8')
  const data = JSON.parse(raw)

  if (!data.model || !Array.isArray(data.messages)) {
    throw new Error(`Session file is corrupt: ${filePath}`)
  }

  return data
}

export function formatSessionItem(s) {
  const time = s.id.replace('T', ' ')
  const model = s.model.length > 35 ? s.model.slice(0, 32) + '...' : s.model
  const count = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`
  const preview = s.title || s.preview || ''
  const previewText = preview ? `"${preview}${preview.length >= 60 ? '...' : ''}"` : ''
  const line = `${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${previewText}`
  return { time, model, count, preview, line }
}

export async function deleteSession(dir, id) {
  await rm(join(dir, `${id}.json`), { force: true })
  const index = await readSidecar(dir)
  if (index && index[id]) {
    delete index[id]
    await writeSidecar(dir, index)
  }
}
