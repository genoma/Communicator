import { getProvider } from '../providers/index.js'
import { resolveWebSearchFlag, webSearchGate, resolveBudget, resolveWebResultsFlag, resolvePrefOrNull } from '../flags.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { startChat } from '../chat.js'
import { ensureSessionsDir, generateSessionId } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey } from '../config.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'
import { resolveSessionFlags, persistSession } from '../session-setup.js'

async function createSessionContext({ apiKey, opts, prefs, providerType }) {
  const { forcedEffort, forcedTemperature, forcedBudget, budget, forcedWebResults, smoothSpeed, zdr } = resolveSessionFlags(opts, prefs)

  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    const provider = getProvider(result.providerType || providerType)
    const resumedEffort = result.reasoningEffort === 'auto' ? undefined : (result.reasoningEffort ?? null)
    return {
      modelId: result.modelId,
      endpointProviderName: result.providerName,
      reasoningEffort: forcedEffort !== undefined ? forcedEffort : resumedEffort,
      temperature: forcedTemperature ?? result.temperature ?? DEFAULT_TEMPERATURE,
      budget: forcedBudget ?? resolvePrefOrNull(resolveBudget, result.budget) ?? null,
      webSearch: resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: result.webSearch }),
      webResults: forcedWebResults ?? resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), result.webResults) ?? null,
      zdr,
      smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
      smoothSpeed,
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

  let selection
  if (opts.model) {
    selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort, zdr })
  } else {
    selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort, zdr })
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
    webResults: forcedWebResults ?? resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), prefs.webResults) ?? null,
    zdr,
    smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
    smoothSpeed,
    webSearchSupported: selection.webSearchSupported,
    visionSupported: selection.visionSupported,
    fileSupported: selection.fileSupported,
    pricing: selection.pricing,
    provider,
    apiKey,
    supportsReasoning: selection.supportsReasoning,
    modelReasoning: selection.modelReasoning,
    sessionId,
    sessionCreatedAt: new Date().toISOString(),
  }
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
    zdr: ctx.zdr,
    webSearchSupported: ctx.webSearchSupported,
    visionSupported: ctx.visionSupported,
    fileSupported: ctx.fileSupported,
    smoothStreaming: ctx.smoothStreaming,
    smoothSpeed: ctx.smoothSpeed,
    prefs,
    configPath: opts.config,
  })
  await persistSession({ finalState, prefs, config: opts.config })
}
