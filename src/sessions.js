import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, basename, extname } from "node:path"

const SESSIONS_DIR = join(homedir(), ".communicator", "sessions")

export async function ensureSessionsDir() {
  await mkdir(SESSIONS_DIR, { recursive: true })
  return SESSIONS_DIR
}

export async function resolveSession(dir, partialId) {
  const sessions = await listSessions(dir)
  return sessions.filter((s) => s.id.startsWith(partialId))
}

export async function listSessions(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const jsonFiles = entries.filter((f) => extname(f) === ".json")
  const sessions = []

  for (const file of jsonFiles) {
    const id = basename(file, ".json")
    const filePath = join(dir, file)

    try {
      const raw = await readFile(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0

      if (msgCount <= 1) continue

      sessions.push({
        id,
        model: parsed.model || "unknown",
        providerName: parsed.providerName || "unknown",
        createdAt: parsed.createdAt || null,
        updatedAt: parsed.updatedAt || null,
        messageCount: msgCount,
      })
    } catch {
      continue
    }
  }

  return sessions.sort((a, b) => b.id.localeCompare(a.id))
}

export async function listSessionsForPicker(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const jsonFiles = entries.filter((f) => extname(f) === ".json")
  const sessions = []

  for (const file of jsonFiles) {
    const id = basename(file, ".json")
    const filePath = join(dir, file)

    try {
      const raw = await readFile(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0

      if (msgCount <= 1) continue

      let preview = ""
      const msgs = parsed.messages
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].role === "user") {
          preview = String(msgs[i].content || "").slice(0, 60)
          break
        }
      }

      sessions.push({
        id,
        model: parsed.model || "unknown",
        providerName: parsed.providerName || "unknown",
        createdAt: parsed.createdAt || null,
        updatedAt: parsed.updatedAt || null,
        messageCount: msgCount,
        preview,
      })
    } catch {
      continue
    }
  }

  return sessions.sort((a, b) => b.id.localeCompare(a.id))
}

export async function saveSession(dir, id, data) {
  if (!data.messages || data.messages.length <= 1) return

  const filePath = join(dir, `${id}.json`)
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2) + "\n")
  } catch (err) {
    if (err.code === "ENOSPC") {
      console.error("Warning: disk full, could not save session")
      return
    }
    console.error(`Warning: could not save session: ${err.message}`)
  }
}

export async function loadSession(dir, id) {
  const filePath = join(dir, `${id}.json`)
  const raw = await readFile(filePath, "utf-8")
  const data = JSON.parse(raw)

  if (!data.model || !Array.isArray(data.messages)) {
    throw new Error(`Session file is corrupt: ${filePath}`)
  }

  return data
}
