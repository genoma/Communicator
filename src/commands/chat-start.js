import { getProvider } from '../providers/index.js'
import { resolveReasoningFlag, resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, webSearchGate, resolveBudget, resolveSmoothSpeed, normalizeSmoothSpeed } from '../flags.js'
import { resolveFlagOrExit } from '../cli-utils.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { startChat } from '../chat.js'
import { ensureSessionsDir, generateSessionId, saveSession, buildSessionPayload } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey, savePreferences, applyPreferenceUpdates } from '../config.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'

async function createSessionContext({ apiKey, opts, prefs, providerType }) {
  const forcedTemperature = resolveFlagOrExit((v) => resolveTemperatureFlag({ temperature: v }), opts.temperature)
  const budget = resolveFlagOrExit(resolveBudget, opts.budget)
  const forcedWebResults = resolveFlagOrExit((v) => resolveWebResultsFlag({ webResults: v }), opts.webResults)
  const forcedSmoothSpeed = resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed)

  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    const provider = getProvider(result.providerType || providerType)
    return {
      modelId: result.modelId,
      endpointProviderName: result.providerName,
      reasoningEffort: result.reasoningEffort,
      temperature: forcedTemperature ?? result.temperature ?? DEFAULT_TEMPERATURE,
      budget: budget ?? result.budget ?? null,
      webSearch: resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: result.webSearch }),
      webResults: forcedWebResults ?? result.webResults ?? null,
      smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
      smoothSpeed: forcedSmoothSpeed ?? normalizeSmoothSpeed(prefs.smoothSpeed),
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
  const forcedEffort = resolveReasoningFlag({ reasoningEffort: opts.reasoningEffort })

  let selection
  if (opts.model) {
    selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort })
  } else {
    selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort })
  }

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)

  const webSearch = resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: prefs.webSearch?.[selection.modelId] })
  const webSearchGateError = webSearchGate(webSearch, selection.webSearchSupported)
  if (webSearchGateError) {
    console.error(`Error: ${webSearchGateError}`)
    process.exit(1)
  }

  return {
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature: forcedTemperature ?? prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE,
    budget,
    webSearch,
    webResults: forcedWebResults ?? null,
    smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
    smoothSpeed: forcedSmoothSpeed ?? normalizeSmoothSpeed(prefs.smoothSpeed),
    webSearchSupported: selection.webSearchSupported,
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
      await saveSession(dir, finalState.sessionId, buildSessionPayload(finalState))
    } catch {
      // save failures are non-fatal
    }
  }

  await savePreferences(applyPreferenceUpdates(prefs, {
    modelId: finalState.modelId,
    lastModel: finalState.modelId,
    lastProvider: finalState.endpointProviderName,
    reasoningEffort: finalState.reasoningEffort,
    temperature: finalState.temperature,
    webSearch: finalState.webSearch,
  }), opts.config)
}

export async function chatStart({ apiKey, opts, prefs, systemPrompt, providerType }) {
  const ctx = await createSessionContext({ apiKey, opts, prefs, providerType })
  const finalState = await startChat(ctx.apiKey, ctx.modelId, ctx.endpointProviderName, ctx.reasoningEffort, ctx.temperature, ctx.pricing, ctx.provider, {
    systemPrompt,
    initialMessages: ctx.initialMessages,
    sessionId: ctx.sessionId,
    createdAt: ctx.sessionCreatedAt,
    supportsReasoning: ctx.supportsReasoning,
    modelReasoning: ctx.modelReasoning,
    budget: ctx.budget,
    webSearch: ctx.webSearch,
    webResults: ctx.webResults,
    webSearchSupported: ctx.webSearchSupported,
    smoothStreaming: ctx.smoothStreaming,
    smoothSpeed: ctx.smoothSpeed,
    prefs,
    configPath: opts.config,
  })
  await persistSessionEnd({ finalState, opts, prefs })
}
