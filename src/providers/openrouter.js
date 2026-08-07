import { parseSSEStream } from '../sse-parser.js'
import { fetchWithRetry } from '../http.js'
import { ApiError, makeHandleHttpError } from '../errors.js'
import { DEFAULT_TEMPERATURE, DEFAULT_WEB_SEARCH_RESULTS } from '../constants.js'
import { getZdrIndex, getProviderPolicies } from './openrouter-meta.js'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const CACHE_HEADER = 'x-openrouter-cache-status'

export const meta = {
  name: 'openrouter',
  baseURL: OPENROUTER_BASE,
  apiKeyEnv: 'OPENROUTER_API_KEY',
  hasEndpoints: true,
  supportsWebSearchOnAll: true,
  supportsZdr: true,
}

export const handleHttpError = makeHandleHttpError({
  providerName: 'OpenRouter',
  providerId: 'openrouter',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  notFoundMessage: 'Model not found on OpenRouter. Use --list-models to list available models.',
})

export async function isZdrIndexDegraded() {
  return (await getZdrIndex()).degraded === true
}

export function normalizePricing(raw) {
  const prompt = raw?.prompt != null ? parseFloat(raw.prompt) : null
  const completion = raw?.completion != null ? parseFloat(raw.completion) : null
  return {
    prompt: Number.isNaN(prompt) ? null : prompt,
    completion: Number.isNaN(completion) ? null : completion,
  }
}

export async function fetchModels(apiKey) {
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorResponse: handleHttpError })

  const { data } = await res.json()
  const zdr = await getZdrIndex()
  return data.map((m) => {
    const r = m.reasoning
    const aliasTarget = m.alias_target?.slug || null
    const inputModalities = m.architecture?.input_modalities || []
    const outputModalities = m.architecture?.output_modalities || []
    const supportedParams = Array.isArray(m.supported_parameters) ? m.supported_parameters : null

    let visionSupported
    if (inputModalities.includes('image') || supportedParams?.includes('image_url')) {
      visionSupported = true
    } else if (inputModalities.length > 0 || supportedParams?.length > 0) {
      visionSupported = false
    }

    return {
      id: m.id,
      name: m.name,
      provider: m.id.split('/')[0],
      aliasTarget,
      contextLength: m.context_length,
      description: m.description,
      architecture: { input_modalities: inputModalities, output_modalities: outputModalities },
      supportedParameters: supportedParams,
      visionSupported,
      zdr: zdr.modelIds.has(m.id) || (aliasTarget != null && zdr.modelIds.has(aliasTarget)) || undefined,
      reasoning: r
        ? {
            supported: true,
            supportsEffort: Array.isArray(r.supported_efforts) && r.supported_efforts.length > 0,
            supported_efforts: Array.isArray(r.supported_efforts) && r.supported_efforts.length > 0 ? r.supported_efforts : null,
            default_effort: r.default_effort || null,
            mandatory: r.mandatory === true,
            default_enabled: r.default_enabled !== false,
          }
        : null,
      pricing: null,
    }
  })
}

export async function fetchEndpoints(apiKey, modelId, allModels) {
  const model = allModels?.find((m) => m.id === modelId)
  let queryId = model?.aliasTarget || modelId

  const request = () => fetchWithRetry(`${OPENROUTER_BASE}/models/${queryId}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorResponse: handleHttpError })

  let res = await request()
  let { data } = await res.json()

  if (!data?.endpoints?.length && modelId.startsWith('~') && queryId === modelId) {
    const models = await fetchModels(apiKey)
    const aliasTarget = models.find((m) => m.id === modelId)?.aliasTarget
    if (aliasTarget && aliasTarget !== queryId) {
      queryId = aliasTarget
      res = await request()
      ;({ data } = await res.json())
    }
  }

  if (!data?.endpoints?.length) {
    return []
  }

  const [zdrIndex, policies] = await Promise.all([getZdrIndex(), getProviderPolicies()])

  return data.endpoints.map((ep) => ({
    name: ep.name,
    providerName: ep.provider_name,
    tag: ep.tag,
    status: ep.status,
    uptime30m: ep.uptime_last_30m,
    pricing: ep.pricing,
    contextLength: ep.context_length,
    maxCompletionTokens: ep.max_completion_tokens,
    supportedParameters: ep.supported_parameters,
    zdr: zdrIndex.tags.has(ep.tag),
    privacyPolicyURL: policies.get(ep.provider_name)?.privacyPolicyURL || null,
  }))
}

export async function chatCompletion({ apiKey, model, messages, onToken, onSources, provider, reasoningEffort, temperature = DEFAULT_TEMPERATURE, webSearch, webResults, zdr = false, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    temperature,
  }

  if (provider) {
    body.provider = {
      order: [provider],
      allow_fallbacks: false,
      ...(zdr ? { zdr: true } : {}),
    }
  }

  if (webSearch === 'auto') {
    const results = webResults ?? DEFAULT_WEB_SEARCH_RESULTS
    body.tools = [{
      type: 'openrouter:web_search',
      // max_results caps a single search call; max_total_results caps the
      // cumulative total across all search calls in the request, so the model
      // cannot exceed the requested count by searching multiple times.
      parameters: { max_results: results, max_total_results: results },
    }]
  } else if (webSearch === 'always') {
    body.plugins = [{ id: 'web', max_results: webResults ?? DEFAULT_WEB_SEARCH_RESULTS }]
  }

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort, exclude: false }
  } else if (reasoningEffort === null) {
    body.reasoning = { enabled: false }
  }

  let res
  try {
    res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, { errorResponse: handleHttpError, signal })
  } catch (err) {
    if (zdr && err instanceof ApiError && err.status === 400 && /zdr|data retention/i.test(err.message)) {
      throw new ApiError('ZDR request failed: the selected provider does not support zero data retention. Pick a zero-retention endpoint or retry without --zdr.', { status: 400, provider: 'openrouter', retryable: false })
    }
    throw err
  }

  const cacheStatus = res.headers.get(CACHE_HEADER)
  const reader = res.body.getReader()

  const { fullText, fullReasoning, finalUsage, fullSources, skippedChunks, fullParts } = await parseSSEStream(reader, onToken, onSources)

  const usage = finalUsage

  if (cacheStatus === 'HIT' && !usage) {
    return {
      content: fullText,
      reasoning: fullReasoning || undefined,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true },
      sources: fullSources,
      skippedChunks,
      parts: fullParts.length > 0 ? fullParts : undefined,
    }
  }

  if (cacheStatus === 'HIT' && usage) {
    usage.cacheHit = true
  }

  return { content: fullText, reasoning: fullReasoning || undefined, usage, sources: fullSources, skippedChunks, parts: fullParts.length > 0 ? fullParts : undefined }
}
