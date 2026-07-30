import { getProvider } from "../providers/index.js"
import { selectModel, selectProvider, selectReasoningEffort, resolveReasoningFlag, BACK_SENTINEL } from "../prompts.js"
import { startChat } from "../chat.js"
import { ensureSessionsDir, listSessions, saveSession } from "../sessions.js"
import { resumeCmd } from "./resume.js"
import { getApiKey, savePreferences } from "../config.js"

export async function chatStart({ apiKey, opts, prefs, systemPrompt, providerType }) {
  let modelId, modelName, endpointProviderName, reasoningEffort, pricing
  let supportsReasoning = true
  let initialMessages = null
  let sessionId = null
  let sessionCreatedAt = null

  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    modelId = result.modelId
    modelName = result.modelName
    endpointProviderName = result.providerName
    reasoningEffort = result.reasoningEffort
    pricing = result.pricing
    initialMessages = result.initialMessages
    sessionId = result.sessionId
    sessionCreatedAt = result.sessionCreatedAt
    providerType = result.providerType || providerType
    apiKey = getApiKey(providerType)
  } else {
    reasoningEffort = resolveReasoningFlag({ reasoning: opts.reasoning, reasoningEffort: opts.reasoningEffort })
  }

  const provider = getProvider(providerType)

  if (!opts.resume) {
    const models = await provider.fetchModels(apiKey)

    for (;;) {
      if (opts.model) {
        modelId = opts.model
        modelName = modelId
      } else {
        const selected = await selectModel(models, prefs.lastModel)
        modelId = selected.id
        modelName = selected.name
      }

      if (reasoningEffort === undefined) {
        const modelData = models.find((m) => m.id === modelId)
        const lastEffort = prefs.reasoningEffort?.[modelId]
        if (modelData?.reasoning?.supportsEffort === false) {
          // Venice models that reason automatically without effort control
          reasoningEffort = undefined
        } else {
          reasoningEffort = await selectReasoningEffort(modelData?.reasoning, lastEffort)
        }
      }

      if (!provider.meta.hasEndpoints) {
        const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
        endpointProviderName = endpoints[0]?.providerName || "venice"
        pricing = endpoints[0]?.pricing || null
        supportsReasoning = !!(endpoints[0]?.supportedParameters?.supportsReasoningEffort)
        break
      }

      const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
      if (!endpoints.length) {
        console.error(`No providers found for model: ${modelId}`)
        process.exit(1)
      }

      const ep = await selectProvider(endpoints)
      if (ep === BACK_SENTINEL) {
        reasoningEffort = undefined
        continue
      }
      endpointProviderName = ep.providerName
      pricing = ep.pricing
      break
    }

    const dir = await ensureSessionsDir()
    const baseId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "")
    sessionId = baseId
    let suffix = 1
    const existing = (await listSessions(dir)).map((s) => s.id)
    while (existing.includes(sessionId)) {
      suffix++
      sessionId = `${baseId}-${suffix}`
    }
    sessionCreatedAt = new Date().toISOString()
  }

  const finalMessages = await startChat(apiKey, modelId, endpointProviderName, reasoningEffort, pricing, provider, {
    systemPrompt,
    initialMessages,
    sessionId,
    createdAt: sessionCreatedAt,
    supportsReasoning,
  })

  if (sessionId && finalMessages && finalMessages.length > 1) {
    try {
      const dir = await ensureSessionsDir()
      await saveSession(dir, sessionId, {
        model: modelId,
        providerName: endpointProviderName,
        providerType: providerType,
        reasoningEffort: reasoningEffort ?? null,
        pricing: pricing ?? null,
        createdAt: sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages: finalMessages,
      })
    } catch {
      // non-fatal
    }
  }

  const savedPrefs = { lastModel: modelId, lastProvider: endpointProviderName }
  if (reasoningEffort !== undefined) {
    savedPrefs.reasoningEffort = { ...prefs.reasoningEffort, [modelId]: reasoningEffort }
  }
  await savePreferences(savedPrefs, opts.config)
}
