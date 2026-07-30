import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, basename, extname } from "node:path"
import { SESSIONS_DIR } from "./constants.js"
import { selectSession } from "./session-picker.js"

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
  if (partialId && typeof partialId === "string") {
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

  const sessions = await listSessions(dir, { withPreview: true })
  if (!sessions.length) {
    console.log("No saved sessions found.")
    process.exit(0)
  }
  return selectSession(sessions, { message })
}

export async function listSessions(dir, { withPreview = false } = {}) {
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
      if (withPreview) {
        const msgs = parsed.messages
        for (let i = 1; i < msgs.length; i++) {
          if (msgs[i].role === "user") {
            preview = String(msgs[i].content || "").slice(0, 60)
            break
          }
        }
      }

      sessions.push({
        id,
        model: parsed.model || "unknown",
        providerName: parsed.providerName || "unknown",
        providerType: parsed.providerType || "openrouter",
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

export function formatSessionItem(s) {
  const time = s.id.replace("T", " ")
  const model = s.model.length > 35 ? s.model.slice(0, 32) + "..." : s.model
  const count = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`
  const preview = s.preview ? `"${s.preview}${s.preview.length >= 60 ? "..." : ""}"` : ""
  const line = `${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${preview}`
  return { time, model, count, preview, line }
}
