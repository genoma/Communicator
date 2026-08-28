import { ensureSessionsDir, resolveSessionInteractive, loadSession } from '../sessions.js'
import { normalizeWebSearchMode } from '../flags.js'

export async function resumeCmd(partialId) {
  const dir = await ensureSessionsDir()
  const matchedId = await resolveSessionInteractive(dir, partialId, { message: 'Select a session to resume' })
  if (!matchedId) return null

  const sessionData = await loadSession(dir, matchedId)
  return {
    modelId: sessionData.model,
    providerName: sessionData.providerName || null,
    providerType: sessionData.providerType || 'openrouter',
    reasoningEffort: sessionData.reasoningEffort,
    temperature: sessionData.temperature,
    topP: sessionData.topP,
    budget: sessionData.budget ?? null,
    webSearch: normalizeWebSearchMode(sessionData.webSearch),
    // Raw snapshot presence: legacy sessions saved before the field existed have
    // no webSearch, so normalizeWebSearchMode(undefined) would report 'off'. The
    // caller prefers the per-model pref and only falls back to the snapshot when
    // it is actually present.
    webSearchSnapshot: sessionData.webSearch ?? null,
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
    sessionUpdatedAt: sessionData.updatedAt ?? null,
  }
}
