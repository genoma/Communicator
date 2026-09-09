import { getProvider } from '../providers/index.js'
import { DEFAULT_SYSTEM_PROMPT } from '../constants.js'
import { scrapeMessage } from '../scrape.js'
import { CliError } from '../errors.js'
import { startChat } from '../chat.js'
import { createNewSession } from '../sessions.js'
import { ensureRpgSessionsDir } from '../rpg.js'
import { resumeCmd } from './resume.js'
import { getApiKey } from '../config.js'
import { resolveSessionFlags, persistSession, buildSessionContext, resumeSessionContext } from '../session-setup.js'
import { findImageModel } from '../model-selection.js'
import { startImageSession } from './image-session.js'

function imageSessionContext({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, updatedAt = null, initialMessages, configPath, imageProviderName = null, pricing = null }) {
  return { imageModelId, provider, apiKey, prefs, sessionId, createdAt, updatedAt, initialMessages, configPath, imageProviderName, pricing }
}

async function createSessionContext({ apiKey, opts, prefs, providerType, systemPrompt, rpgFirstMessage = null, rpgCharName = null, rpgUserName = null, rpgHistory = null, rpgPostHistoryInstruction = null, scraped = null, modelsPromise = null, rpgResume = null }) {
  const { forcedEffort, forcedTemperature, forcedTopP, forcedBudget, budget, forcedWebResults, smoothSpeed, compactThinking, zdr, e2ee } = resolveSessionFlags(opts, prefs)

  if (opts.resume !== undefined && (opts.rpg === undefined || rpgResume)) {
    const result = opts.rpg === undefined
      ? await resumeCmd(opts.resume)
      : {
          ...rpgResume,
          initialMessages: [
            { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
            ...rpgResume.turns,
          ],
        }
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
        updatedAt: result.sessionUpdatedAt,
        initialMessages: result.initialMessages,
        configPath: opts.config,
        imageProviderName: result.providerName,
        pricing: result.pricing,
      })
    }

    // Settings precedence is shared with the one-shot resume path: flags win,
    // then the per-model prefs, then the persisted session snapshot.
    const { selection, reasoningEffort, temperature, topP, budget, webSearch, webSearchExplicit, webResults } = await resumeSessionContext({
      result,
      opts,
      prefs,
      forcedEffort,
      forcedTemperature,
      forcedTopP,
      forcedBudget,
      forcedWebResults,
      provider,
      apiKey,
      zdr,
      e2ee,
      modelsPromise,
    })
    return {
      modelId: selection.modelId,
      endpointProviderName: selection.endpointProviderName,
      reasoningEffort,
      temperature,
      topP,
      budget,
      webSearch,
      webSearchExplicit,
      webResults,
      zdr,
      e2ee,
      smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
      smoothSpeed,
      compactThinking,
      pricing: selection.pricing,
      contextLength: selection.contextLength,
      supportsReasoning: selection.supportsReasoning,
      reasoningMandatory: selection.reasoningMandatory,
      webSearchSupported: selection.webSearchSupported,
      visionSupported: selection.visionSupported,
      fileSupported: selection.fileSupported,
      imageOutputSupported: selection.imageOutputSupported,
      initialMessages: result.initialMessages,
      sessionId: result.sessionId,
      sessionCreatedAt: result.sessionCreatedAt,
      sessionUpdatedAt: result.sessionUpdatedAt,
      provider,
      apiKey,
      modelReasoning: null,
      // Seed the tracker's flat scrape cost for resumed sessions exactly like
      // the new-session branch does; without this the counter is reset to 0
      // and the session file permanently loses the scrape history.
      scrapes: result.scrapes ?? 0,
      resumeCostSummary: result.costSummary,
      // RPG chapter identity: the story directory and speaker/opening
      // snapshot so markers, saves and /new survive every resume path. The
      // live story files win over the persisted snapshot (edits apply).
      rpgDir: result.rpgDir ?? opts.rpg ?? null,
      rpgCharName: rpgCharName ?? result.rpgCharName ?? null,
      rpgUserName: rpgUserName ?? result.rpgUserName ?? null,
      rpgFirstMessage: rpgFirstMessage ?? result.rpgFirstMessage ?? null,
      rpgPostHistoryInstruction,
    }
  }

  const provider = getProvider(providerType)

  const { selection, temperature, topP, webSearch, webSearchExplicit, webResults } = await buildSessionContext({
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
    modelsPromise,
  })

  const { sessionId, createdAt } = await createNewSession(opts.rpg !== undefined ? await ensureRpgSessionsDir(opts.rpg) : null)

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
    webSearchExplicit,
    webResults,
    zdr,
    e2ee,
    smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
    smoothSpeed,
    compactThinking,
    webSearchSupported: selection.webSearchSupported,
    visionSupported: selection.visionSupported,
    fileSupported: selection.fileSupported,
    imageOutputSupported: selection.imageOutputSupported,
    pricing: selection.pricing,
    contextLength: selection.contextLength,
    provider,
    apiKey,
    supportsReasoning: selection.supportsReasoning,
    reasoningMandatory: selection.modelReasoning?.mandatory === true,
    modelReasoning: selection.modelReasoning,
    sessionId,
    sessionCreatedAt: createdAt,
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
    updatedAt: ctx.sessionUpdatedAt,
    supportsReasoning: ctx.supportsReasoning,
    reasoningMandatory: ctx.reasoningMandatory,
    modelReasoning: ctx.modelReasoning,
    budget: ctx.budget,
    webSearch: ctx.webSearch,
    webSearchExplicit: ctx.webSearchExplicit,
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
    compactThinking: ctx.compactThinking,
    scrapes: ctx.scrapes,
    resumeCostSummary: ctx.resumeCostSummary,
    rpgDir: ctx.rpgDir ?? opts.rpg,
    rpgDebug: opts.debug === true,
    rpgPostHistoryInstruction: ctx.rpgPostHistoryInstruction ?? null,
    rpgFirstMessage: ctx.rpgFirstMessage ?? null,
    rpgCharName: ctx.rpgCharName ?? null,
    rpgUserName: ctx.rpgUserName ?? null,
    prefs,
    configPath: opts.config,
  })
  await persistSession({ finalState, prefs, config: opts.config, rpgDir: ctx.rpgDir ?? opts.rpg, rpgCharName: ctx.rpgCharName, rpgUserName: ctx.rpgUserName, rpgFirstMessage: ctx.rpgFirstMessage })
}

export async function chatStart({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage = null, rpgCharName = null, rpgUserName = null, rpgHistory = null, rpgPostHistoryInstruction = null, providerType, scraped = null, modelsPromise = null, rpgResume = null }) {
  const ctx = await createSessionContext({ apiKey, opts, prefs, providerType, systemPrompt, rpgFirstMessage, rpgCharName, rpgUserName, rpgHistory, rpgPostHistoryInstruction, scraped, modelsPromise, rpgResume })
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
    const { selection, messages, sessionId, createdAt, updatedAt } = imageResult.switchToChat
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
      sessionUpdatedAt: updatedAt,
      supportsReasoning: selection.supportsReasoning,
      reasoningMandatory: selection.modelReasoning?.mandatory === true,
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
