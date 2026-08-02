import { parseSSEStream } from '../sse-parser.js'
import { fetchWithRetry } from '../http.js'
import { ApiError } from '../errors.js'
import { DEFAULT_TEMPERATURE, DEFAULT_WEB_SEARCH_RESULTS } from '../constants.js'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const CACHE_HEADER = 'x-openrouter-cache-status'

export const meta = {
  name: 'openrouter',
  baseURL: OPENROUTER_BASE,
  apiKeyEnv: 'OPENROUTER_API_KEY',
  hasEndpoints: true,
  supportsWebSearchOnAll: true,
}

export function normalizePricing(raw) {
  const prompt = raw?.prompt != null ? parseFloat(raw.prompt) : null
  const completion = raw?.completion != null ? parseFloat(raw.completion) : null
  return {
    prompt: Number.isNaN(prompt) ? null : prompt,
    completion: Number.isNaN(completion) ? null : completion,
  }
}

export function handleHttpError(status, body) {
  if (status === 401) {
    throw new ApiError('Invalid API key. Check your OPENROUTER_API_KEY environment variable.', { status, provider: 'openrouter', retryable: false })
  }
  if (status === 429) {
    throw new ApiError('Rate limited by OpenRouter. Wait a moment and try again.', { status, provider: 'openrouter', retryable: true })
  }
  if (status === 404) {
    throw new ApiError('Model not found on OpenRouter. Use --list-models to list available models.', { status, provider: 'openrouter', retryable: false })
  }
  throw new ApiError(`OpenRouter request failed (${status}): ${body}`, { status, provider: 'openrouter', retryable: status >= 500 })
}

export async function fetchModels(apiKey) {
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorResponse: handleHttpError })

  const { data } = await res.json()
  return data.map((m) => {
    const r = m.reasoning
    return {
      id: m.id,
      name: m.name,
      provider: m.id.split('/')[0],
      contextLength: m.context_length,
      description: m.description,
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

export async function fetchEndpoints(apiKey, modelId) {
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/models/${modelId}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorResponse: handleHttpError })

  const { data } = await res.json()
  if (!data?.endpoints?.length) {
    return []
  }

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
  }))
}

export async function chatCompletion({ apiKey, model, messages, onToken, onSources, provider, reasoningEffort, temperature = DEFAULT_TEMPERATURE, webSearch, webResults, signal }) {
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
    }
  }

  if (webSearch === 'auto') {
    body.tools = [{ type: 'openrouter:web_search', parameters: { max_results: webResults ?? DEFAULT_WEB_SEARCH_RESULTS } }]
  } else if (webSearch === 'always') {
    body.plugins = [{ id: 'web', max_results: webResults ?? DEFAULT_WEB_SEARCH_RESULTS }]
  }

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort, exclude: false }
  } else if (reasoningEffort === null) {
    body.reasoning = { enabled: false }
  }

  const res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { errorResponse: handleHttpError, signal })

  const cacheStatus = res.headers.get(CACHE_HEADER)
  const reader = res.body.getReader()

  const { fullText, fullReasoning, finalUsage, fullSources } = await parseSSEStream(reader, onToken, onSources)

  const usage = finalUsage

  if (cacheStatus === 'HIT' && !usage) {
    return {
      content: fullText,
      reasoning: fullReasoning || undefined,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true },
      sources: fullSources,
    }
  }

  if (cacheStatus === 'HIT' && usage) {
    usage.cacheHit = true
  }

  return { content: fullText, reasoning: fullReasoning || undefined, usage, sources: fullSources }
}
