import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { SESSIONS_DIR } from './constants.js'
import { selectSession, selectSessions } from './session-picker.js'
import { messageText } from './attachments.js'
import { attachmentDirFor, externalizeAttachments, hydrateAttachments } from './attachment-store.js'
import { CliError } from './errors.js'
import { computeCostSummary } from './tracker.js'
import { writeFileAtomic } from './fs-utils.js'
import { readSidecar, writeSidecar, sidecarStale, updateSidecar, dropSidecarEntry, dropSidecarEntries, SIDECAR_FILE } from './session-sidecar.js'

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

export function buildSessionPayload({ messages, modelId, endpointProviderName, providerType, reasoningEffort, temperature, topP, budget, webSearch, webResults, pricing, contextLength, supportsReasoning, reasoningMandatory = false, webSearchSupported, visionSupported, fileSupported, imageOutputSupported, isImageModel = false, e2ee = false, scrapes = 0, createdAt, updatedAt, costSummary = null }) {
  return {
    model: modelId,
    providerName: endpointProviderName,
    providerType,
    reasoningEffort: reasoningEffort === undefined ? 'auto' : reasoningEffort,
    temperature,
    topP,
    budget: budget ?? null,
    webSearch,
    webResults: webResults ?? null,
    pricing: pricing ?? null,
    contextLength: contextLength ?? null,
    supportsReasoning: supportsReasoning ?? null,
    reasoningMandatory,
    webSearchSupported: webSearchSupported ?? null,
    visionSupported: visionSupported ?? null,
    fileSupported: fileSupported ?? null,
    imageOutputSupported: imageOutputSupported ?? null,
    isImageModel,
    e2ee,
    scrapes,
    costSummary: costSummary ?? null,
    createdAt: createdAt || new Date().toISOString(),
    // Carried by ChatState (and the image REPL): stamped only when new turn
    // content was added, never by an unchanged resume.
    updatedAt: updatedAt || new Date().toISOString(),
    title: generateTitle(messages),
    messages,
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
    costSummary: meta.costSummary || null,
  }
}

const byIdDesc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

function sessionRecency(item) {
  const value = item.updatedAt || item.createdAt || item.id
  if (!value) return 0
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  // Legacy ids and timestamps write the UTC clock as dashes (2026-01-01T00-00-00)
  // instead of ISO colons, so Date.parse rejects them; normalize before parsing.
  const legacy = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(String(value))
  return legacy ? Date.parse(`${legacy[1]}T${legacy[2]}:${legacy[3]}:${legacy[4]}Z`) : 0
}

// Most recently active first: updatedAt (bumped on every save and on resume),
// falling back to createdAt, then the creation-time id for legacy sessions.
const byActivityDesc = (a, b) => sessionRecency(b) - sessionRecency(a) || byIdDesc(a, b)

// Reads a single session file and replays its usage for a sidecar entry that
// predates the cost-summary schema, so the list/picker fast path shows the
// same cost the slow path (parseSessionFiles) would.
async function costFromFile(dir, id) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8'))
    if (!Array.isArray(parsed.messages) || parsed.messages.length <= 1) return null
    return computeCostSummary({ pricing: parsed.pricing, messages: parsed.messages, scrapes: parsed.scrapes ?? 0 })
  } catch {
    // corrupt/unreadable session file: nothing to compute
    return null
  }
}

async function parseSessionFiles(dir, jsonFiles) {
  const sessions = await Promise.all(jsonFiles.map(async (file) => {
    const id = basename(file, '.json')

    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf-8'))
      const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      if (msgCount <= 1) return null

      return toSessionItem(id, {
        model: parsed.model,
        providerName: parsed.providerName,
        providerType: parsed.providerType,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        messageCount: msgCount,
        preview: firstUserPreview(parsed.messages),
        title: parsed.title,
        // Legacy files before the cost summary existed: replay usage so the
        // list still shows a cost; the next save backfills the summary.
        costSummary: parsed.costSummary ?? computeCostSummary({ pricing: parsed.pricing, messages: parsed.messages, scrapes: parsed.scrapes ?? 0 }),
      })
    } catch {
      // skip corrupt session files
      return null
    }
  }))
  return sessions.filter(Boolean).sort(byActivityDesc)
}

export async function listSessions(dir) {
  let entries
  try {
    // One readdir sweep for existence and mtime checks: the sidecar fast path
    // and the file listing share it, so the picker stays cheap on hundreds
    // of sessions.
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const jsonFiles = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && extname(e.name) === '.json')
    .map((e) => e.name)
  const index = await readSidecar(dir)

  if (index && Object.keys(index).length > 0 && !(await sidecarStale(dir, jsonFiles))) {
    // A session file deleted outside the app (or a stale sidecar key) leaves
    // a ghost entry: drop entries whose files no longer exist so the picker
    // never offers a resume that fails. Ghosts are collected and dropped in
    // one batched sidecar rewrite (a Set keeps the membership check O(1)).
    const present = new Set(jsonFiles)
    const valid = []
    const ghosts = []
    for (const [id, meta] of Object.entries(index)) {
      if (present.has(`${id}.json`)) {
        const item = toSessionItem(id, meta)
        // A legacy sidecar entry has no cost summary; recompute from the
        // session file so the list and picker show a consistent cost (the
        // session is backfilled on its next save).
        if (!item.costSummary) item.costSummary = await costFromFile(dir, id)
        valid.push(item)
      } else ghosts.push(id)
    }
    if (ghosts.length > 0) await dropSidecarEntries(dir, ghosts)
    return valid.sort(byActivityDesc)
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
  if (!validSessionId(id)) {
    throw new CliError(`Error: Invalid session id "${id}".`)
  }
  const filePath = join(dir, `${id}.json`)
  if (!data.messages || data.messages.length <= 1) {
    // The id may have been claimed by generateSessionId (empty wx file) but
    // never filled in; drop the placeholder so it does not linger.
    await removeEmptySessionClaim(dir, id)
    return
  }

  try {
    const payload = { ...data, messages: await externalizeAttachments(data.messages, attachmentDirFor(dir, id)) }
    await writeFileAtomic(filePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    await updateSidecarEntry(dir, id, payload)
  } catch (err) {
    if (err.code === 'ENOSPC') {
      console.error('Warning: disk full, could not save session')
      return
    }
    console.error(`Warning: could not save session: ${err.message}`)
  }
}

async function updateSidecarEntry(dir, id, data) {
  await updateSidecar(dir, toSessionItem(id, {
    model: data.model,
    providerName: data.providerName,
    providerType: data.providerType,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: data.messages.length,
    preview: firstUserPreview(data.messages),
    title: data.title,
    costSummary: data.costSummary || null,
  }))
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
