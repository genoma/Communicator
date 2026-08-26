import { ensureSessionsDir, resolveSessionInteractive, loadSession, saveSession } from '../sessions.js'
import { normalizeWebSearchMode } from '../flags.js'

export async function resumeCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId, { message: 'Select a session to resume' })
  if (!matchedId) return null

  const sessionData = await loadSession(dir, matchedId)
  // Resuming counts as activity: bump updatedAt so the session jumps to the
  // top of the most-recently-used listing even if no new message is sent.
  await saveSession(dir, matchedId, { ...sessionData, updatedAt: new Date().toISOString() })
  return {
    modelId: sessionData.model,
    providerName: sessionData.providerName || null,
    providerType: sessionData.providerType || 'openrouter',
    reasoningEffort: sessionData.reasoningEffort,
    temperature: sessionData.temperature,
    topP: sessionData.topP,
    budget: sessionData.budget ?? null,
    webSearch: normalizeWebSearchMode(sessionData.webSearch),
    webResults: sessionData.webResults ?? null,
    pricing: sessionData.pricing || null,
    contextLength: sessionData.contextLength || null,
    supportsReasoning: sessionData.supportsReasoning ?? true,
    reasoningMandatory: sessionData.reasoningMandatory === true,
    webSearchSupported: sessionData.webSearchSupported ?? undefined,
    visionSupported: sessionData.visionSupported ?? undefined,
    fileSupported: sessionData.fileSupported ?? undefined,
    imageOutputSupported: sessionData.imageOutputSupported ?? undefined,
    isImageModel: sessionData.isImageModel === true,
    e2ee: sessionData.e2ee === true,
    scrapes: sessionData.scrapes ?? 0,
    initialMessages: sessionData.messages,
    sessionId: matchedId,
    sessionCreatedAt: sessionData.createdAt,
  }
}
