import { ensureSessionsDir, resolveSessionInteractive, loadSession } from '../sessions.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'

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
    pricing: sessionData.pricing || null,
    initialMessages: sessionData.messages,
    sessionId: matchedId,
    sessionCreatedAt: sessionData.createdAt,
  }
}
