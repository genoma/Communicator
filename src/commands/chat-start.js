import { getProvider } from '../providers/index.js'
import { resolveReasoningFlag, resolveTemperatureFlag } from '../prompts.js'
import { DEFAULT_TEMPERATURE } from '../constants.js'
import { startChat } from '../chat.js'
import { ensureSessionsDir, generateSessionId, saveSession } from '../sessions.js'
import { resumeCmd } from './resume.js'
import { getApiKey, savePreferences } from '../config.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'

function resolveBudget(value) {
  if (value === undefined || value === null || value === '') return null
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error('Error: --budget must be a positive number (USD).')
    process.exit(1)
  }
  return budget
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
  const budget = resolveBudget(opts.budget)

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

  return {
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature: forcedTemperature ?? prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE,
    budget,
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
        temperature: finalState.temperature,
        budget: finalState.budget ?? null,
        pricing: finalState.pricing ?? null,
        createdAt: finalState.createdAt,
        updatedAt: new Date().toISOString(),
        messages: finalState.messages,
      })
    } catch {
      // save failures are non-fatal
    }
  }

  const savedPrefs = {
    ...prefs,
    lastModel: finalState.modelId,
    lastProvider: finalState.endpointProviderName,
  }
  if (finalState.reasoningEffort !== undefined) {
    savedPrefs.reasoningEffort = { ...prefs.reasoningEffort, [finalState.modelId]: finalState.reasoningEffort }
  }
  if (finalState.temperature !== undefined) {
    savedPrefs.temperature = { ...prefs.temperature, [finalState.modelId]: finalState.temperature }
  }
  await savePreferences(savedPrefs, opts.config)
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
    prefs,
    configPath: opts.config,
  })
  await persistSessionEnd({ finalState, opts, prefs })
}
