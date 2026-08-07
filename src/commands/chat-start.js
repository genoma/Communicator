import { getProvider } from '../providers/index.js'
import { resolveWebSearchFlag, resolveBudget, resolveWebResultsFlag, resolvePrefOrNull } from '../flags.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { startChat } from '../chat.js'
import { ensureSessionsDir, generateSessionId } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey } from '../config.js'
import { resolveSessionFlags, persistSession, buildSessionContext } from '../session-setup.js'
import { findImageModel } from '../model-selection.js'
import { startImageSession } from './image-session.js'

function imageSessionContext({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, initialMessages, configPath, imageProviderName = null, pricing = null }) {
  return { imageModelId, provider, apiKey, prefs, sessionId, createdAt, initialMessages, configPath, imageProviderName, pricing }
}

async function createSessionContext({ apiKey, opts, prefs, providerType }) {
  const { forcedEffort, forcedTemperature, forcedBudget, budget, forcedWebResults, smoothSpeed, zdr } = resolveSessionFlags(opts, prefs)

  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    const provider = getProvider(result.providerType || providerType)
    const apiKey = getApiKey(result.providerType || providerType)
    // New sessions carry an isImageModel marker, so the resume path only
    // consults the image-model catalog for legacy sessions written before
    // the marker existed.
    let isImageSession = result.isImageModel === true
    if (result.isImageModel === undefined) {
      isImageSession = !!(await findImageModel(provider, apiKey, result.modelId))
    }
    if (isImageSession) {
      return imageSessionContext({
        provider,
        apiKey,
        prefs,
        imageModelId: result.modelId,
        sessionId: result.sessionId,
        createdAt: result.sessionCreatedAt,
        initialMessages: result.initialMessages,
        configPath: opts.config,
        imageProviderName: result.providerName,
        pricing: result.pricing,
      })
    }

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
      contextLength: result.contextLength,
      supportsReasoning: result.supportsReasoning,
      webSearchSupported: result.webSearchSupported,
      initialMessages: result.initialMessages,
      sessionId: result.sessionId,
      sessionCreatedAt: result.sessionCreatedAt,
      provider,
      apiKey,
      modelReasoning: null,
    }
  }

  const provider = getProvider(providerType)

  const { selection, temperature, webSearch, webResults } = await buildSessionContext({
    provider,
    apiKey,
    opts,
    prefs,
    forcedEffort,
    forcedTemperature,
    forcedWebResults,
    zdr,
  })

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)

  if (selection.isImageModel === true) {
    return imageSessionContext({
      provider,
      apiKey,
      prefs,
      imageModelId: selection.modelId,
      sessionId,
      createdAt: new Date().toISOString(),
      initialMessages: [],
      configPath: opts.config,
      imageProviderName: selection.endpointProviderName,
      pricing: selection.pricing,
    })
  }

  return {
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature,
    budget,
    webSearch,
    webResults,
    zdr,
    smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
    smoothSpeed,
    webSearchSupported: selection.webSearchSupported,
    visionSupported: selection.visionSupported,
    fileSupported: selection.fileSupported,
    imageOutputSupported: selection.imageOutputSupported,
    pricing: selection.pricing,
    contextLength: selection.contextLength,
    provider,
    apiKey,
    supportsReasoning: selection.supportsReasoning,
    modelReasoning: selection.modelReasoning,
    sessionId,
    sessionCreatedAt: new Date().toISOString(),
  }
}

// Runs a chat session to completion and persists the final state; used by
// both the new-session path and the image-session /model handoff.
async function runChatToEnd(ctx, { systemPrompt, opts, prefs }) {
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
    contextLength: ctx.contextLength,
    webSearchSupported: ctx.webSearchSupported,
    visionSupported: ctx.visionSupported,
    fileSupported: ctx.fileSupported,
    imageOutputSupported: ctx.imageOutputSupported,
    smoothStreaming: ctx.smoothStreaming,
    smoothSpeed: ctx.smoothSpeed,
    prefs,
    configPath: opts.config,
  })
  await persistSession({ finalState, prefs, config: opts.config })
}

export async function chatStart({ apiKey, opts, prefs, systemPrompt, providerType }) {
  const ctx = await createSessionContext({ apiKey, opts, prefs, providerType })
  if (ctx.imageModelId) {
    const imageResult = await startImageSession({
      provider: ctx.provider,
      apiKey: ctx.apiKey,
      prefs: ctx.prefs,
      imageModelId: ctx.imageModelId,
      sessionId: ctx.sessionId,
      createdAt: ctx.createdAt,
      initialMessages: ctx.initialMessages,
      configPath: ctx.configPath,
      imageProviderName: ctx.imageProviderName,
      pricing: ctx.pricing,
    })
    // /model with a text-model pick transitions the image session into the
    // chat REPL, same session id and history.
    if (!imageResult?.switchToChat) return
    const { selection, messages, sessionId, createdAt } = imageResult.switchToChat
    const { budget, smoothSpeed, zdr } = resolveSessionFlags(opts, prefs)
    await runChatToEnd({
      apiKey,
      provider: ctx.provider,
      modelId: selection.modelId,
      endpointProviderName: selection.endpointProviderName,
      reasoningEffort: selection.reasoningEffort,
      temperature: prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE,
      pricing: selection.pricing,
      initialMessages: messages,
      sessionId,
      sessionCreatedAt: createdAt,
      supportsReasoning: selection.supportsReasoning,
      modelReasoning: selection.modelReasoning,
      budget,
      webSearch: 'off',
      webResults: null,
      zdr,
      contextLength: selection.contextLength,
      webSearchSupported: selection.webSearchSupported,
      visionSupported: selection.visionSupported,
      fileSupported: selection.fileSupported,
      imageOutputSupported: selection.imageOutputSupported,
      smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
      smoothSpeed,
    }, { systemPrompt, opts, prefs })
    return
  }
  await runChatToEnd(ctx, { systemPrompt, opts, prefs })
}
