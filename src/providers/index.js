import * as openrouter from './openrouter.js'
import * as venice from './venice.js'

/**
 * Common provider contract (providers may ignore options they do not support):
 * - meta: { name, apiKeyEnv, hasEndpoints, supportsWebSearchOnAll? }
 * - fetchModels(apiKey) -> model list
 * - fetchEndpoints(apiKey, modelId, allModels?) -> endpoint list
 * - chatCompletion({ apiKey, model, messages, onToken, onSources, provider, reasoningEffort, supportsReasoning, sessionId, temperature, webSearch, webResults, signal }) where webSearch is a mode string 'off' | 'auto' | 'always' (auto = model decides, always = force search every request)
 * - normalizePricing(raw) -> { prompt, completion }
 * - handleHttpError(status, body)
 */
const registry = { openrouter, venice }

export function getProvider(name) {
  const p = registry[name]
  if (!p) throw new Error(`Unknown provider: ${name}. Valid providers: ${Object.keys(registry).join(', ')}`)
  return p
}
