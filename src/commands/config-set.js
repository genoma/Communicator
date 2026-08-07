import { getProvider } from '../providers/index.js'
import { cheapestEndpoint } from '../model-selection.js'
import { isWebSearchSupported } from '../reasoning.js'
import { applyPreferenceUpdates, savePreferences } from '../config.js'
import { resolveFlagValues, normalizeWebSearchMode, webSearchGate } from '../flags.js'
import { getEffortLabel } from '../prompts.js'
import { formatModelPrice } from '../ui/format.js'
import { CliError } from '../errors.js'
import { DEFAULT_CONFIG_FILE, formatSmoothSpeed } from '../constants.js'

const PER_MODEL_FLAGS = '--temperature, --reasoning-effort and --web-search'

export function resolveConfigValues(opts) {
  const { temperature, budget, webResults, smoothSpeed, reasoningEffort } = resolveFlagValues(opts)
  const webSearch = opts.webSearch !== undefined ? normalizeWebSearchMode(opts.webSearch) : undefined
  const smoothStreaming = opts.smoothStreaming === false ? false : undefined
  const hideWatermark = opts.watermark === false ? true : undefined
  const outputDir = opts.outputDir
  const needsModel = temperature !== undefined || reasoningEffort !== undefined || webSearch !== undefined
  return { temperature, budget, webResults, smoothSpeed, reasoningEffort, webSearch, smoothStreaming, hideWatermark, outputDir, needsModel }
}

export async function configSetCmd({ opts, prefs, providerType, apiKey }) {
  const values = resolveConfigValues(opts)

  if (values.needsModel && opts.model === undefined) {
    throw new CliError(`Error: ${PER_MODEL_FLAGS} set per-model defaults and require --model <id>.`)
  }

  let provider = null
  let modelData = null
  let endpoint = null

  if (opts.model !== undefined) {
    provider = getProvider(providerType)
    const models = await provider.fetchModels(apiKey)
    modelData = models.find((m) => m.id === opts.model)
    if (!modelData) {
      throw new CliError(`Error: Model "${opts.model}" not found. Use --list-models to list available models.`)
    }
    const endpoints = await provider.fetchEndpoints(apiKey, opts.model, models)
    endpoint = provider.meta.hasEndpoints && endpoints.length > 1 ? cheapestEndpoint(endpoints) : endpoints[0]

    if (values.webSearch !== undefined) {
      const gate = webSearchGate(values.webSearch, isWebSearchSupported(provider.meta, modelData))
      if (gate) {
        throw new CliError(`Error: ${gate}`)
      }
    }
  }

  const updated = applyPreferenceUpdates(prefs, {
    modelId: opts.model,
    lastModel: opts.model,
    lastProvider: opts.model !== undefined ? (endpoint?.providerName || provider.meta.name) : undefined,
    temperature: values.temperature,
    reasoningEffort: values.reasoningEffort,
    webSearch: values.webSearch,
    smoothStreaming: values.smoothStreaming,
    smoothSpeed: values.smoothSpeed,
    budget: values.budget,
    webResults: values.webResults,
    outputDir: values.outputDir,
    hideWatermark: values.hideWatermark,
  })

  await savePreferences(updated, opts.config)

  if (opts.model !== undefined) {
    const label = endpoint ? `${opts.model} via ${endpoint.providerName}` : opts.model
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
  if (values.temperature !== undefined) console.log(`Temperature set to ${values.temperature} for ${opts.model}`)
  if (values.reasoningEffort !== undefined) console.log(`Reasoning effort set to ${getEffortLabel(values.reasoningEffort)} for ${opts.model}`)
  if (values.webSearch !== undefined) console.log(`Web search set to ${values.webSearch} for ${opts.model}`)
  if (values.budget !== undefined) console.log(`Budget set to $${values.budget}`)
  if (values.webResults !== undefined) console.log(`Web search results set to ${values.webResults} (OpenRouter only)`)
  if (values.smoothSpeed !== undefined) console.log(`Smooth speed set to ${formatSmoothSpeed(values.smoothSpeed)}`)
  if (values.smoothStreaming === false) console.log('Smooth streaming disabled')
  if (values.hideWatermark === true) console.log('Venice watermark disabled')
  console.log(`Saved to ${opts.config || DEFAULT_CONFIG_FILE}`)
}
