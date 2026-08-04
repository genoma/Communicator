import { selectModel, selectProvider, selectReasoningEffort, BACK_SENTINEL } from './prompts.js'
import { resolveEffortDefault, isWebSearchSupported } from './reasoning.js'
import { CliError } from './errors.js'

async function zdrGate(provider, zdr) {
  if (zdr !== true || provider.meta.supportsZdr !== true) return false
  if ((await provider.isZdrIndexDegraded?.()) === true) {
    console.error('Warning: could not verify ZDR-capable endpoints; --zdr filtering disabled. The request may still fail if the provider is not ZDR-capable.')
    return false
  }
  return true
}

function capabilityFlags(provider, modelData, endpoint) {
  const isVenice = provider.meta.name === 'venice'
  const capabilities = modelData?.capabilities
  const modalities = modelData?.architecture?.input_modalities
  const supportedParams = modelData?.supportedParameters ?? endpoint?.supportedParameters

  let visionSupported = modelData?.visionSupported
  if (visionSupported === undefined) {
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
  }

  const fileSupported = isVenice ? capabilities?.supportsFileInput !== false : true

  return { visionSupported, fileSupported }
}

export async function selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort, zdr = false }) {
  const models = await provider.fetchModels(apiKey)
  const zdrActive = await zdrGate(provider, zdr)
  const pickable = zdrActive ? models.filter((m) => m.zdr === true) : models
  if (zdrActive && pickable.length === 0) {
    throw new CliError('Error: No zero-retention models available on OpenRouter right now.')
  }

  for (;;) {
    const selected = await selectModel(pickable, prefs.lastModel, zdrActive)
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
      throw new CliError(`Error: No providers found for model: ${modelId}`)
    }

    const zdrEndpoints = zdrActive ? endpoints.filter((ep) => ep.zdr === true) : endpoints
    if (zdrActive && zdrEndpoints.length === 0) {
      console.error(`No zero-retention providers found for model: ${modelId}`)
      continue
    }

    const ep = await selectProvider(zdrEndpoints, zdrActive)
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

export async function selectModelNonInteractive({ provider, apiKey, prefs, modelId, forcedEffort, zdr = false }) {
  const models = await provider.fetchModels(apiKey)
  const zdrActive = await zdrGate(provider, zdr)
  const modelData = models.find((m) => m.id === modelId)
  const reasoning = modelData?.reasoning || null

  const effort = resolveEffortDefault({ reasoning, forcedEffort, prefs, modelId })

  const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
  const zdrEndpoints = zdrActive ? endpoints.filter((ep) => ep.zdr === true) : endpoints
  if (zdrActive && zdrEndpoints.length === 0) {
    throw new CliError(`Error: model ${modelId} has no zero-retention providers. Pick a ZDR-capable model or retry without --zdr.`)
  }
  const ep = provider.meta.hasEndpoints && zdrEndpoints.length > 1
    ? cheapestEndpoint(zdrEndpoints)
    : zdrEndpoints[0]

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
