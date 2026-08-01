import { getProvider } from '../providers/index.js'
import { resolveReasoningFlag, resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, resolveBudget } from '../flags.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { startChat } from '../chat.js'
import { ensureSessionsDir, generateSessionId, saveSession, buildSessionPayload } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey, savePreferences, applyPreferenceUpdates } from '../config.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'

function resolveBudgetFlag(value) {
  try {
    return resolveBudget(value)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

function resolveWebResults(value) {
  try {
    return resolveWebResultsFlag({ webResults: value })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

async function createSessionContext({ apiKey, opts, prefs, providerType }) {
  let forcedTemperature
  if (opts.temperature !== undefined && opts.temperature !== null && opts.temperature !== '') {
    try {
      forcedTemperature = resolveTemperatureFlag({ temperature: opts.temperature })
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  }
  const budget = resolveBudgetFlag(opts.budget)
  const forcedWebResults = resolveWebResults(opts.webResults)

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
  if (webSearch && selection.webSearchSupported === false) {
    console.error('Error: The selected model does not support web search.')
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
      await saveSession(dir, finalState.sessionId, buildSessionPayload({
        messages: finalState.messages,
        modelId: finalState.modelId,
        endpointProviderName: finalState.endpointProviderName,
        providerType: finalState.providerType,
        reasoningEffort: finalState.reasoningEffort,
        temperature: finalState.temperature,
        budget: finalState.budget,
        webSearch: finalState.webSearch,
        webResults: finalState.webResults,
        pricing: finalState.pricing,
        createdAt: finalState.createdAt,
      }))
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
    prefs,
    configPath: opts.config,
  })
  await persistSessionEnd({ finalState, opts, prefs })
}
