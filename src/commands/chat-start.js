import { getProvider } from '../providers/index.js'
import { resolveWebSearchFlag, resolveBudget, resolveWebResultsFlag, resolvePrefOrNull } from '../flags.js'
import { DEFAULT_SYSTEM_PROMPT } from '../constants.js'
import { scrapeMessage } from '../scrape.js'
import { CliError } from '../errors.js'
import { startChat } from '../chat.js'
import { createNewSession } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey } from '../config.js'
import { resolveSessionFlags, persistSession, buildSessionContext } from '../session-setup.js'
import { findImageModel } from '../model-selection.js'
import { startImageSession } from './image-session.js'

function imageSessionContext({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, initialMessages, configPath, imageProviderName = null, pricing = null }) {
  return { imageModelId, provider, apiKey, prefs, sessionId, createdAt, initialMessages, configPath, imageProviderName, pricing }
}

async function createSessionContext({ apiKey, opts, prefs, providerType, systemPrompt, rpgFirstMessage = null, rpgCharName = null, rpgUserName = null, rpgHistory = null, rpgPostHistoryInstruction = null, scraped = null }) {
  const { forcedEffort, forcedTemperature, forcedTopP, forcedBudget, budget, forcedWebResults, smoothSpeed, zdr, e2ee } = resolveSessionFlags(opts, prefs)

  if (opts.resume !== undefined && opts.rpg === undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    // E2EE sessions never silently degrade: an encrypted session may only be
    // resumed with --e2ee, and --e2ee refuses to resume an unencrypted one.
    if (e2ee && result.e2ee !== true) {
      throw new CliError('Error: this session was not created with --e2ee; refusing to resume it unencrypted.')
    }
    if (result.e2ee === true && !e2ee) {
      throw new CliError('Error: this session was created with --e2ee; resume it with --e2ee to keep it encrypted.')
    }

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
      temperature: forcedTemperature ?? result.temperature,
      topP: forcedTopP ?? result.topP,
      budget: forcedBudget ?? resolvePrefOrNull(resolveBudget, result.budget) ?? null,
      webSearch: e2ee ? 'off' : resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: result.webSearch }),
      webResults: e2ee ? null : forcedWebResults ?? resolvePrefOrNull((v) => resolveWebResultsFlag({ webResults: v }), result.webResults) ?? null,
      zdr,
      e2ee,
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
      // Seed the tracker's flat scrape cost for resumed sessions exactly like
      // the new-session branch does; without this the counter is reset to 0
      // and the session file permanently loses the scrape history.
      scrapes: result.scrapes ?? 0,
    }
  }

  const provider = getProvider(providerType)

  const { selection, temperature, topP, webSearch, webResults } = await buildSessionContext({
    provider,
    apiKey,
    opts,
    prefs,
    forcedEffort,
    forcedTemperature,
    forcedTopP,
    forcedWebResults,
    zdr,
    e2ee,
  })

  const { sessionId, createdAt } = await createNewSession()

  if (selection.isImageModel === true) {
    return imageSessionContext({
      provider,
      apiKey,
      prefs,
      imageModelId: selection.modelId,
      sessionId,
      createdAt,
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
    topP,
    budget,
    webSearch,
    webResults,
    zdr,
    e2ee,
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
    // A launch-time --scrape injects its page as the first user turn so it
    // persists in the session like any other message; the flat cost rides on
    // the scrapes counter (chat.js seeds the tracker from it once).
    scrapes: scraped ? 1 : 0,
    rpgPostHistoryInstruction,
    // Speaker markers for the RPG transcript (replay + live replies); names
    // come from the char.md/user.md H1s. Only non-null for RPG runs.
    rpgCharName: rpgCharName ?? null,
    rpgUserName: rpgUserName ?? null,
    // Carried even when history is resumed so /new can restart the story
    // from the opening message instead of a blank page. Only non-null when
    // cli-main loaded an RPG context.
    rpgFirstMessage: rpgFirstMessage ?? null,
    initialMessages: rpgHistory
      ? [
          { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
          ...rpgHistory,
          ...(scraped ? [{ role: 'user', content: scrapeMessage(scraped.url, scraped.content) }] : []),
        ]
      : scraped || rpgFirstMessage
        ? [
            { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
            ...(rpgFirstMessage ? [{ role: 'assistant', content: rpgFirstMessage }] : []),
            ...(scraped ? [{ role: 'user', content: scrapeMessage(scraped.url, scraped.content) }] : []),
          ]
        : undefined,
  }
}

// Runs a chat session to completion and persists the final state; used by
// both the new-session path and the image-session /model handoff.
async function runChatToEnd(ctx, { systemPrompt, opts, prefs }) {
  const finalState = await startChat(ctx.apiKey, ctx.modelId, ctx.endpointProviderName, ctx.reasoningEffort, ctx.temperature, ctx.pricing, ctx.provider, {
    topP: ctx.topP,
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
    e2ee: ctx.e2ee,
    contextLength: ctx.contextLength,
    webSearchSupported: ctx.webSearchSupported,
    visionSupported: ctx.visionSupported,
    fileSupported: ctx.fileSupported,
    imageOutputSupported: ctx.imageOutputSupported,
    smoothStreaming: ctx.smoothStreaming,
    smoothSpeed: ctx.smoothSpeed,
    scrapes: ctx.scrapes,
    rpgDir: opts.rpg,
    rpgDebug: opts.debug === true,
    rpgPostHistoryInstruction: ctx.rpgPostHistoryInstruction ?? null,
    rpgFirstMessage: ctx.rpgFirstMessage ?? null,
    rpgCharName: ctx.rpgCharName ?? null,
    rpgUserName: ctx.rpgUserName ?? null,
    prefs,
    configPath: opts.config,
  })
  await persistSession({ finalState, prefs, config: opts.config })
}

export async function chatStart({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage = null, rpgCharName = null, rpgUserName = null, rpgHistory = null, rpgPostHistoryInstruction = null, providerType, scraped = null }) {
  const ctx = await createSessionContext({ apiKey, opts, prefs, providerType, systemPrompt, rpgFirstMessage, rpgCharName, rpgUserName, rpgHistory, rpgPostHistoryInstruction, scraped })
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
    const { budget, smoothSpeed, zdr, e2ee } = resolveSessionFlags(opts, prefs)
    await runChatToEnd({
      apiKey,
      provider: ctx.provider,
      modelId: selection.modelId,
      endpointProviderName: selection.endpointProviderName,
      reasoningEffort: selection.reasoningEffort,
      temperature: prefs.temperature?.[selection.modelId],
      topP: prefs.topP?.[selection.modelId],
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
      e2ee,
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
