import * as openrouter from './openrouter.js'
import * as venice from './venice.js'
import { CliError } from '../errors.js'

/**
 * Common provider contract (providers may ignore options they do not support):
 * - meta: { name, apiKeyEnv, hasEndpoints, supportsWebSearchOnAll? }
 * - fetchModels(apiKey) -> model list
 * - fetchEndpoints(apiKey, modelId, allModels?) -> endpoint list
 * - chatCompletion({ apiKey, model, messages, onToken, onSources, provider, reasoningEffort, reasoningMandatory, supportsReasoning, sessionId, temperature, topP, webSearch, webResults, signal }) where webSearch is a mode string 'off' | 'auto' | 'always' (auto = model decides, always = force search every request) and reasoningMandatory marks models whose reasoning cannot be disabled
 * - normalizePricing(raw) -> { prompt, completion }
 * - handleHttpError(status, body)
 */
const registry = { openrouter, venice }

export function getProvider(name) {
  const p = registry[name]
  if (!p) throw new CliError(`Error: Unknown provider: ${name}. Valid providers: ${Object.keys(registry).join(', ')}`)
  return p
}
