import { selectModel, selectModelWithImages, selectProvider, selectImageProvider, selectReasoningEffort, BACK_SENTINEL } from './prompts.js'
import { resolveEffortDefault, isWebSearchSupported, endpointSupportsReasoning } from './reasoning.js'
import { CliError, formatError } from './errors.js'

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

  // Venice advertises file input via its capabilities object. OpenRouter
  // reports the `file` parameter through supported_parameters; when the
  // list is present (non-empty) it is authoritative, otherwise file support
  // stays assumed so the attachment gate keeps its current behavior.
  const fileSupported = isVenice
    ? capabilities?.supportsFileInput !== false
    : Array.isArray(supportedParams) && supportedParams.length > 0
      ? supportedParams.includes('file')
      : true

  const supportsE2EE = isVenice ? capabilities?.supportsE2EE === true : undefined

  const outputModalities = modelData?.architecture?.output_modalities ?? modelData?.outputModalities ?? null
  const imageOutputSupported = Array.isArray(outputModalities) && outputModalities.includes('image') ? true : undefined

  return { visionSupported, fileSupported, imageOutputSupported, supportsE2EE }
}

export async function findImageModel(provider, apiKey, modelId) {
  if (typeof provider.fetchImageModels !== 'function') return null
  const models = await provider.fetchImageModels(apiKey)
  return models.find((m) => m.id === modelId) || null
}

function imageModelSelection(model, provider, endpoint = null) {
  return {
    modelId: model.id,
    isImageModel: true,
    endpointProviderName: endpoint?.providerName || provider.meta.name,
    pricing: endpoint?.pricing || model.pricing || null,
    imageProvider: endpoint?.slug || endpoint?.providerName || null,
    contextLength: null,
    reasoningEffort: null,
    supportsReasoning: false,
    modelReasoning: null,
    webSearchSupported: false,
    visionSupported: false,
    fileSupported: false,
    imageOutputSupported: undefined,
  }
}

// Image providers route through their own endpoints API; picks a provider
// interactively (or the cheapest when non-interactive), mirroring the text
// flow. Returns BACK_SENTINEL when the user backs out of the picker.
export async function selectImageEndpoint({ provider, apiKey, model, interactive = true }) {
  if (typeof provider.fetchImageModelEndpoints !== 'function') return null
  const endpoints = await provider.fetchImageModelEndpoints(apiKey, model.id)
  if (endpoints.length === 0) return null
  if (!interactive) {
    const price = (ep) => ep.pricing?.perImage ?? ep.pricing?.perToken ?? Infinity
    return endpoints.reduce((best, ep) => (price(ep) < price(best) ? ep : best))
  }
  return selectImageProvider(endpoints)
}

export async function selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort, zdr = false, e2ee = false }) {
  const zdrActive = await zdrGate(provider, zdr)
  // Model and image-model listings are independent: fetch them concurrently
  // to cut startup latency. Image pricing is intentionally not requested
  // here — the picker does not display it and the selected model's endpoint
  // fetch already carries the price.
  const [models, imageModels] = await Promise.all([
    provider.fetchModels(apiKey),
    (async () => {
      if (zdrActive || e2ee || typeof provider.fetchImageModels !== 'function') return null
      try {
        return await provider.fetchImageModels(apiKey)
      } catch (err) {
        console.error(`Warning: could not load image models; showing text models only. (${formatError(err)})`)
        return null
      }
    })(),
  ])
  const withImages = imageModels !== null
  let pickable = zdrActive ? models.filter((m) => m.zdr === true) : models
  if (e2ee) pickable = pickable.filter((m) => m.capabilities?.supportsE2EE === true)
  if (zdrActive && pickable.length === 0) {
    throw new CliError('Error: No zero-retention models available on OpenRouter right now.')
  }
  if (e2ee && pickable.length === 0) {
    throw new CliError('Error: No E2EE-capable models available on Venice right now.')
  }

  for (;;) {
    const selected = withImages
      ? await selectModelWithImages(pickable, imageModels, prefs.lastModel, prefs.lastImageModel, zdrActive)
      : await selectModel(pickable, prefs.lastModel, zdrActive)
    const modelId = selected.id

    const imageModel = withImages ? (imageModels.find((m) => m.id === modelId) || null) : null
    if (imageModel) {
      const endpoint = await selectImageEndpoint({ provider, apiKey, model: imageModel })
      if (endpoint === BACK_SENTINEL) continue
      return imageModelSelection(imageModel, provider, endpoint)
    }

    const modelData = models.find((m) => m.id === modelId)

    const endpoints = await provider.fetchEndpoints(apiKey, modelId, models)
    if (provider.meta.hasEndpoints && endpoints.length === 0) {
      throw new CliError(`Error: No providers found for model: ${modelId}`)
    }

    const zdrEndpoints = zdrActive ? endpoints.filter((ep) => ep.zdr === true) : endpoints
    if (zdrActive && zdrEndpoints.length === 0) {
      console.error(`No zero-retention providers found for model: ${modelId}`)
      continue
    }

    let ep
    if (provider.meta.hasEndpoints) {
      ep = await selectProvider(zdrEndpoints, zdrActive)
      if (ep === BACK_SENTINEL) {
        continue
      }
    } else {
      ep = zdrEndpoints[0]
    }

    let effort = reasoningEffort
    if (effort === undefined) {
      const lastEffort = prefs.reasoningEffort?.[modelId]
      if (modelData?.reasoning?.supportsEffort === false) {
        // models that reason automatically without effort control
        effort = undefined
      } else {
        effort = await selectReasoningEffort(modelData?.reasoning, lastEffort, { withBack: true })
        if (effort === BACK_SENTINEL) {
          continue
        }
      }
    }

    // Endpoint capabilities differ per provider: OpenRouter reports a raw
    // parameter array, Venice a capability object.
    const endpointSupportsEffort = endpointSupportsReasoning(ep)

    return {
      modelId,
      reasoningEffort: effort,
      endpointProviderName: ep?.providerName || provider.meta.name,
      pricing: ep?.pricing || null,
      contextLength: ep?.contextLength ?? modelData?.contextLength ?? null,
      supportsReasoning: endpointSupportsEffort,
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

export async function selectImageModelNonInteractive({ provider, apiKey, imageModelId }) {
  const models = await provider.fetchImageModels(apiKey)
  const model = models.find((m) => m.id === imageModelId) || null
  if (!model) {
    throw new CliError(`Error: image model ${imageModelId} not found. Use --list-image-models to see available models.`)
  }
  return model
}

export async function selectModelNonInteractive({ provider, apiKey, prefs, modelId, forcedEffort, zdr = false, e2ee = false }) {
  const models = await provider.fetchModels(apiKey)
  const zdrActive = await zdrGate(provider, zdr)
  const modelData = models.find((m) => m.id === modelId)
  if (!modelData) {
    if (!zdrActive && !e2ee) {
      const imageModel = await findImageModel(provider, apiKey, modelId)
      if (imageModel) {
        const endpoint = await selectImageEndpoint({ provider, apiKey, model: imageModel, interactive: false })
        return imageModelSelection(imageModel, provider, endpoint)
      }
      throw new CliError(`Error: model ${modelId} not found. Use --list-models to see available models.`)
    }
    if (e2ee) {
      throw new CliError(`Error: model ${modelId} is not an E2EE-capable model. Pick an E2EE-capable model or retry without --e2ee.`)
    }
    // Under zdr the model may only exist as an image model which has no
    // ZDR endpoints; let the downstream fetchEndpoints/zdr-filter error
    // surface the correct message.
  }
  if (e2ee && modelData.capabilities?.supportsE2EE !== true) {
    throw new CliError(`Error: model ${modelId} does not support E2EE. Pick an E2EE-capable model or retry without --e2ee.`)
  }
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
    contextLength: ep?.contextLength ?? modelData?.contextLength ?? null,
    supportsReasoning: endpointSupportsReasoning(ep),
    modelReasoning: reasoning,
    webSearchSupported: isWebSearchSupported(provider.meta, modelData),
    ...capabilityFlags(provider, modelData, ep),
  }
}
