import { ensureSessionsDir, resolveSessionInteractive, loadSession } from "../sessions.js"

export async function resumeCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId)
  if (!matchedId) return null

  const sessionData = await loadSession(dir, matchedId)
  return {
    modelId: sessionData.model,
    modelName: sessionData.model,
    providerName: sessionData.providerName || null,
    reasoningEffort: sessionData.reasoningEffort,
    pricing: sessionData.pricing || null,
    initialMessages: sessionData.messages,
    sessionId: matchedId,
    sessionCreatedAt: sessionData.createdAt,
  }
}
