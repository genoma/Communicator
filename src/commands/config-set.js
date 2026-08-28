import { getProvider } from '../providers/index.js'
import { cheapestEndpoint } from '../model-selection.js'
import { isWebSearchSupported } from '../reasoning.js'
import { applyPreferenceUpdates, savePreferences } from '../config.js'
import { resolveFlagValues, normalizeWebSearchMode, webSearchGate, resolveAspectRatio, resolveImageFormat } from '../flags.js'
import { getEffortLabel } from '../prompts.js'
import { formatModelPrice } from '../ui/format.js'
import { sanitizeSingleLine } from '../ui/hyperlink.js'
import { CliError } from '../errors.js'
import { DEFAULT_CONFIG_FILE, formatSmoothSpeed } from '../constants.js'

const PER_MODEL_FLAGS = '--temperature, --reasoning-effort, --web-search and --top-p'

export function resolveConfigValues(opts) {
  const { temperature, topP, budget, webResults, smoothSpeed, reasoningEffort } = resolveFlagValues(opts)
  const webSearch = opts.webSearch !== undefined ? normalizeWebSearchMode(opts.webSearch) : undefined
  const smoothStreaming = opts.smoothStreaming === false ? false : undefined
  const compactThinking = opts.compactThinking === true ? true : undefined
  const hideWatermark = opts.watermark === false ? true : undefined
  const safeMode = opts.safeMode === false ? false : undefined
  const outputDir = opts.outputDir
  const aspectRatio = opts.aspectRatio !== undefined ? resolveAspectRatio(opts.aspectRatio) : undefined
  const imageFormat = opts.imageFormat !== undefined ? resolveImageFormat(opts.imageFormat) : undefined
  const needsModel = temperature !== undefined || topP !== undefined || reasoningEffort !== undefined || webSearch !== undefined
  return { temperature, topP, budget, webResults, smoothSpeed, reasoningEffort, webSearch, smoothStreaming, compactThinking, hideWatermark, safeMode, outputDir, aspectRatio, imageFormat, needsModel }
}

export async function configSetCmd({ opts, prefs, providerType, apiKey }) {
  const values = resolveConfigValues(opts)

  if (values.needsModel && opts.model === undefined) {
    throw new CliError(`Error: ${PER_MODEL_FLAGS} set per-model defaults and require --model <id>.`)
  }

  let provider = null
  let modelData = null
  let endpoint = null
  // Per-model prefs are keyed by the canonical id, so an alias row pick never
  // writes to a second pref slot (mirrors model-selection.js).
  let prefModelId = null

  if (opts.model !== undefined) {
    provider = getProvider(providerType)
    const models = await provider.fetchModels(apiKey)
    modelData = models.find((m) => m.id === opts.model)
    if (!modelData) {
      throw new CliError(`Error: Model "${opts.model}" not found. Use --list-models to list available models.`)
    }
    prefModelId = modelData.aliasTarget || opts.model
    const endpoints = await provider.fetchEndpoints(apiKey, opts.model, models)
    endpoint = provider.meta.hasEndpoints && endpoints.length > 1 ? cheapestEndpoint(endpoints) : endpoints[0]

    if (values.webSearch !== undefined) {
      const gate = webSearchGate(values.webSearch, isWebSearchSupported(provider.meta, modelData))
      if (gate) {
        throw new CliError(`Error: ${gate}`)
      }
    }
  }

  const updates = {
    modelId: prefModelId ?? opts.model,
    lastModel: prefModelId ?? opts.model,
    lastProvider: opts.model !== undefined ? (endpoint?.providerName || provider.meta.name) : undefined,
    temperature: values.temperature,
    topP: values.topP,
    reasoningEffort: values.reasoningEffort,
    webSearch: values.webSearch,
    smoothStreaming: values.smoothStreaming,
    smoothSpeed: values.smoothSpeed,
    compactThinking: values.compactThinking,
    budget: values.budget,
    webResults: values.webResults,
    outputDir: values.outputDir,
    hideWatermark: values.hideWatermark,
    safeMode: values.safeMode,
  }
  if (values.aspectRatio !== undefined || values.imageFormat !== undefined) {
    const providerDefaults = { ...(prefs.imageDefaults?.[providerType] || {}) }
    if (values.aspectRatio !== undefined) providerDefaults.aspectRatio = values.aspectRatio
    if (values.imageFormat !== undefined) providerDefaults.format = values.imageFormat
    updates.imageDefaults = { [providerType]: providerDefaults }
  }

  const updated = applyPreferenceUpdates(prefs, updates)

  await savePreferences(updated, opts.config)

  if (opts.model !== undefined) {
    const label = endpoint ? `${sanitizeSingleLine(opts.model)} via ${sanitizeSingleLine(endpoint.providerName)}` : sanitizeSingleLine(opts.model)
    console.log(`Model: ${label}`)
    if (modelData.contextLength) console.log(`Context: ${modelData.contextLength.toLocaleString()} tokens`)
    const price = endpoint?.pricing
    if (price?.prompt != null || price?.completion != null) {
      console.log(`Pricing: ${formatModelPrice(price.prompt, price.completion)}`)
    }
    if (modelData.reasoning?.supported) {
      console.log(`Reasoning: ${modelData.reasoning.supportsEffort ? 'effort control supported' : 'automatic'}`)
    }
  }
  if (values.outputDir !== undefined) console.log(`Export directory set to ${values.outputDir}`)
  if (values.temperature !== undefined) console.log(`Temperature set to ${values.temperature ?? 'default'} for ${opts.model}`)
  if (values.topP !== undefined) console.log(`Top-p set to ${values.topP ?? 'default'} for ${opts.model}`)
  if (values.reasoningEffort !== undefined) console.log(`Reasoning effort set to ${getEffortLabel(values.reasoningEffort)} for ${opts.model}`)
  if (values.webSearch !== undefined) console.log(`Web search set to ${values.webSearch} for ${opts.model}`)
  if (values.budget !== undefined) console.log(`Budget set to $${values.budget}`)
  if (values.webResults !== undefined) console.log(`Web search results set to ${values.webResults} (OpenRouter only)`)
  if (values.smoothSpeed !== undefined) console.log(`Smooth speed set to ${formatSmoothSpeed(values.smoothSpeed)}`)
  if (values.smoothStreaming === false) console.log('Smooth streaming disabled')
  if (values.compactThinking === true) console.log('Compact thinking enabled')
  if (values.hideWatermark === true) console.log('Venice watermark disabled')
  if (values.safeMode === false) console.log('Venice safe mode disabled')
  if (values.aspectRatio !== undefined) console.log(`Aspect ratio set to ${values.aspectRatio} (${providerType} image defaults)`)
  if (values.imageFormat !== undefined) console.log(`Image format set to ${values.imageFormat} (${providerType} image defaults)`)
  console.log(`Saved to ${opts.config || DEFAULT_CONFIG_FILE}`)
}
