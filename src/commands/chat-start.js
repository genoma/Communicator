import { fetchModels, fetchEndpoints } from "../openrouter.js"
import { selectModel, selectProvider, selectReasoningEffort, resolveReasoningFlag, BACK_SENTINEL } from "../prompts.js"
import { startChat } from "../chat.js"
import { ensureSessionsDir, listSessions, saveSession } from "../sessions.js"
import { resumeCmd } from "./resume.js"
import { savePreferences } from "../config.js"

export async function chatStart({ apiKey, opts, prefs, systemPrompt }) {
  let modelId, modelName, providerName, reasoningEffort, pricing
  let initialMessages = null
  let sessionId = null
  let sessionCreatedAt = null

  if (opts.resume !== undefined) {
    const result = await resumeCmd(opts.resume)
    if (!result) process.exit(0)

    modelId = result.modelId
    modelName = result.modelName
    providerName = result.providerName
    reasoningEffort = result.reasoningEffort
    pricing = result.pricing
    initialMessages = result.initialMessages
    sessionId = result.sessionId
    sessionCreatedAt = result.sessionCreatedAt
  } else {
    reasoningEffort = resolveReasoningFlag({ reasoning: opts.reasoning, reasoningEffort: opts.reasoningEffort })

    if (opts.model && opts.provider) {
      modelId = opts.model
      modelName = modelId
      providerName = opts.provider
    } else {
      const models = await fetchModels(apiKey)

      for (;;) {
        let selected
        if (opts.model) {
          modelId = opts.model
          modelName = modelId
          selected = null
        } else {
          selected = await selectModel(models, prefs.lastModel)
          modelId = selected.id
          modelName = selected.name
        }

        if (reasoningEffort === undefined) {
          const modelData = models.find((m) => m.id === modelId)
          const lastEffort = prefs.reasoningEffort?.[modelId]
          reasoningEffort = await selectReasoningEffort(modelData?.reasoning, lastEffort)
        }

        if (opts.provider) {
          providerName = opts.provider
          break
        }

        const endpoints = await fetchEndpoints(apiKey, modelId)
        if (!endpoints.length) {
          console.error(`No providers found for model: ${modelId}`)
          process.exit(1)
        }

        const ep = await selectProvider(endpoints)
        if (ep === BACK_SENTINEL) {
          reasoningEffort = undefined
          continue
        }
        providerName = ep.providerName
        pricing = ep.pricing
        break
      }
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

  const finalMessages = await startChat(apiKey, modelId, providerName, reasoningEffort, pricing, {
    systemPrompt,
    initialMessages,
    sessionId,
    createdAt: sessionCreatedAt,
  })

  if (sessionId && finalMessages && finalMessages.length > 1) {
    try {
      const dir = await ensureSessionsDir()
      await saveSession(dir, sessionId, {
        model: modelId,
        providerName,
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

  const savedPrefs = { lastModel: modelId, lastProvider: providerName }
  if (reasoningEffort !== undefined) {
    savedPrefs.reasoningEffort = { ...prefs.reasoningEffort, [modelId]: reasoningEffort }
  }
  await savePreferences(savedPrefs, opts.config)
}
