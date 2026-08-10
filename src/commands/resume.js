import { ensureSessionsDir, resolveSessionInteractive, loadSession } from '../sessions.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { normalizeWebSearchMode } from '../flags.js'

export async function resumeCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId, { message: 'Select a session to resume' })
  if (!matchedId) return null

  const sessionData = await loadSession(dir, matchedId)
  return {
    modelId: sessionData.model,
    modelName: sessionData.model,
    providerName: sessionData.providerName || null,
    providerType: sessionData.providerType || 'openrouter',
    reasoningEffort: sessionData.reasoningEffort,
    temperature: sessionData.temperature ?? DEFAULT_TEMPERATURE,
    budget: sessionData.budget ?? null,
    webSearch: normalizeWebSearchMode(sessionData.webSearch),
    webResults: sessionData.webResults ?? null,
    pricing: sessionData.pricing || null,
    contextLength: sessionData.contextLength || null,
    supportsReasoning: sessionData.supportsReasoning ?? true,
    webSearchSupported: sessionData.webSearchSupported ?? undefined,
    isImageModel: sessionData.isImageModel === true,
    e2ee: sessionData.e2ee === true,
    scrapes: sessionData.scrapes ?? 0,
    initialMessages: sessionData.messages,
    sessionId: matchedId,
    sessionCreatedAt: sessionData.createdAt,
  }
}
