import { selectModel, selectProvider, selectReasoningEffort, BACK_SENTINEL } from './prompts.js'
import { resolveEffortDefault, isWebSearchSupported } from './reasoning.js'

function capabilityFlags(provider, modelData, endpoint) {
  const isVenice = provider.meta.name === 'venice'
  const capabilities = modelData?.capabilities
  const modalities = modelData?.architecture?.input_modalities
  const supportedParams = modelData?.supportedParameters ?? endpoint?.supportedParameters

  let visionSupported
  if (isVenice && capabilities?.supportsVision === true) {
    visionSupported = true
  } else if (isVenice && capabilities?.supportsVision === false) {
    visionSupported = false
  } else if (Array.isArray(modalities) && modalities.includes('image')) {
    visionSupported = true
  } else if (Array.isArray(supportedParams) && supportedParams.includes('image_url')) {
    visionSupported = true
  } else if ((Array.isArray(modalities) && modalities.length > 0) || (Array.isArray(supportedParams) && supportedParams.length > 0)) {
    visionSupported = false
  }

  const fileSupported = isVenice ? capabilities?.supportsFileInput !== false : true

  return { visionSupported, fileSupported }
}

export async function selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort }) {
  const models = await provider.fetchModels(apiKey)

  for (;;) {
    const selected = await selectModel(models, prefs.lastModel)
    const modelId = selected.id
    const modelData = models.find((m) => m.id === modelId)
    let effort = reasoningEffort

    if (effort === undefined) {
      const lastEffort = prefs.reasoningEffort?.[modelId]
      if (modelData?.reasoning?.supportsEffort === false) {
        // models that reason automatically without effort control
        effort = undefined
      } else {
        effort = await selectReasoningEffort(modelData?.reasoning, lastEffort)
      }
    }

    if (!provider.meta.hasEndpoints) {
      const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
      const ep = endpoints[0]
      return {
        modelId,
        reasoningEffort: effort,
        endpointProviderName: ep?.providerName || provider.meta.name,
        pricing: ep?.pricing || null,
        supportsReasoning: !!ep?.supportedParameters?.supportsReasoningEffort,
        modelReasoning: modelData?.reasoning || null,
        webSearchSupported: isWebSearchSupported(provider.meta, modelData),
        ...capabilityFlags(provider, modelData, ep),
      }
    }

    const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
    if (!endpoints.length) {
      console.error(`No providers found for model: ${modelId}`)
      process.exit(1)
    }

    const ep = await selectProvider(endpoints)
    if (ep === BACK_SENTINEL) {
      effort = undefined
      continue
    }
    return {
      modelId,
      reasoningEffort: effort,
      endpointProviderName: ep.providerName,
      pricing: ep.pricing,
      supportsReasoning: !!ep.supportedParameters?.supportsReasoningEffort,
      modelReasoning: modelData?.reasoning || null,
      webSearchSupported: isWebSearchSupported(provider.meta, modelData),
      ...capabilityFlags(provider, modelData, ep),
    }
  }
}

export function cheapestEndpoint(endpoints) {
  let best = endpoints[0]
  let bestTotal = Infinity
  for (const ep of endpoints) {
    const p = ep.pricing
    if (p?.prompt == null || p?.completion == null) continue
    const total = Number(p.prompt) + Number(p.completion)
    if (total < bestTotal) {
      bestTotal = total
      best = ep
    }
  }
  return best
}

export async function selectModelNonInteractive({ provider, apiKey, prefs, modelId, forcedEffort }) {
  const models = await provider.fetchModels(apiKey)
  const modelData = models.find((m) => m.id === modelId)
  const reasoning = modelData?.reasoning || null

  const effort = resolveEffortDefault({ reasoning, forcedEffort, prefs, modelId })

  const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
  const ep = provider.meta.hasEndpoints && endpoints.length > 1
    ? cheapestEndpoint(endpoints)
    : endpoints[0]

  return {
    modelId,
    reasoningEffort: effort,
    endpointProviderName: ep?.providerName || provider.meta.name,
    pricing: ep?.pricing || null,
    supportsReasoning: !!ep?.supportedParameters?.supportsReasoningEffort,
    modelReasoning: reasoning,
    webSearchSupported: isWebSearchSupported(provider.meta, modelData),
    ...capabilityFlags(provider, modelData, ep),
  }
}
