import { getProvider } from "../providers/index.js"
import { resolveReasoningFlag } from "../prompts.js"
import { startChat } from "../chat.js"
import { ensureSessionsDir, generateSessionId, saveSession } from "../sessions.js"
import { resumeCmd } from "./resume.js"
import { getApiKey, savePreferences } from "../config.js"
import { selectModelAndEndpoint, selectModelNonInteractive } from "../model-selection.js"

async function createSessionContext({ apiKey, opts, prefs, providerType }) {
  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    const provider = getProvider(result.providerType || providerType)
    return {
      modelId: result.modelId,
      endpointProviderName: result.providerName,
      reasoningEffort: result.reasoningEffort,
      pricing: result.pricing,
      initialMessages: result.initialMessages,
      sessionId: result.sessionId,
      sessionCreatedAt: result.sessionCreatedAt,
      provider,
      apiKey: getApiKey(result.providerType || providerType),
      supportsReasoning: true,
      modelReasoning: null,
    }
  }

  const provider = getProvider(providerType)
  const forcedEffort = resolveReasoningFlag({ reasoning: opts.reasoning, reasoningEffort: opts.reasoningEffort })

  let selection
  if (opts.model) {
    selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model })
  } else {
    selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort })
  }

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)

  return {
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    pricing: selection.pricing,
    provider,
    apiKey,
    supportsReasoning: selection.supportsReasoning,
    modelReasoning: selection.modelReasoning,
    sessionId,
    sessionCreatedAt: new Date().toISOString(),
  }
}

async function persistSessionEnd({ finalState, opts, prefs }) {
  if (finalState.sessionId && finalState.messages && finalState.messages.length > 1) {
    try {
      const dir = await ensureSessionsDir()
      await saveSession(dir, finalState.sessionId, {
        model: finalState.modelId,
        providerName: finalState.endpointProviderName,
        providerType: finalState.providerType,
        reasoningEffort: finalState.reasoningEffort ?? null,
        pricing: finalState.pricing ?? null,
        createdAt: finalState.createdAt,
        updatedAt: new Date().toISOString(),
        messages: finalState.messages,
      })
    } catch {
      // save failures are non-fatal
    }
  }

  const savedPrefs = { lastModel: finalState.modelId, lastProvider: finalState.endpointProviderName }
  if (finalState.reasoningEffort !== undefined) {
    savedPrefs.reasoningEffort = { ...prefs.reasoningEffort, [finalState.modelId]: finalState.reasoningEffort }
  }
  await savePreferences(savedPrefs, opts.config)
}

export async function chatStart({ apiKey, opts, prefs, systemPrompt, providerType }) {
  const ctx = await createSessionContext({ apiKey, opts, prefs, providerType })
  const finalState = await startChat(ctx.apiKey, ctx.modelId, ctx.endpointProviderName, ctx.reasoningEffort, ctx.pricing, ctx.provider, {
    systemPrompt,
    initialMessages: ctx.initialMessages,
    sessionId: ctx.sessionId,
    createdAt: ctx.sessionCreatedAt,
    supportsReasoning: ctx.supportsReasoning,
    modelReasoning: ctx.modelReasoning,
    prefs,
    configPath: opts.config,
  })
  await persistSessionEnd({ finalState, opts, prefs })
}
