import { parseSSEStream } from '../sse-parser.js'
import { fetchSafeBytes, fetchWithRetry } from '../http.js'
import { ApiError, makeHandleHttpError } from '../errors.js'
import { DEFAULT_WEB_SEARCH_RESULTS, IMAGE_GEN_TIMEOUT_MS, MAX_IMAGE_ATTACHMENT_BYTES } from '../constants.js'
import { getZdrIndex, getProviderPolicies, OPENROUTER_BASE, CACHE_TTL_MS } from './openrouter-meta.js'
import { mimeForExt, extForMime } from '../attachments.js'

const CACHE_HEADER = 'x-openrouter-cache-status'

// OpenRouter translates the top-level cache_control field into automatic
// Anthropic prompt caching on these endpoint providers only (see OpenRouter
// "Prompt Caching" docs); for any other provider it is not forwarded.
const ANTHROPIC_AUTO_CACHE_PROVIDER = /anthropic|bedrock|vertex|azure|aws/i
// Below this prompt size Anthropic does not cache at all, so the TTL choice
// is moot; above it a 1h TTL amortizes repeated writes across human-paced
// turns instead of rewriting the whole prefix whenever the 5m TTL lapses.
const ANTHROPIC_CACHE_MIN_PROMPT_TOKENS = 1024

function anthropicAutoCachingAvailable(model, provider) {
  if (!model.replace(/^~/, '').startsWith('anthropic/')) return false
  if (!provider) return true
  return ANTHROPIC_AUTO_CACHE_PROVIDER.test(provider)
}

function estimatePromptTokens(messages) {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part?.text === 'string') chars += part.text.length
        else if (part?.type === 'image_url') chars += 85 * 4
      }
    }
  }
  return Math.ceil(chars / 4)
}

// Model/endpoint listings are stable within a process: cache them (same
// pattern as openrouter-meta) so repeated selection, resume and listing
// flows do not re-hit the API for the same data.
const imageModelsCache = { fetchedAt: 0, models: null }
const imageEndpointsCache = new Map()
const modelsCache = { fetchedAt: 0, models: null }

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

export function resetModelCaches() {
  modelsCache.fetchedAt = 0
  modelsCache.models = null
}

export async function fetchModels(apiKey, { zdr = false } = {}) {
  let models = modelsCache.models
  if (!models || Date.now() - modelsCache.fetchedAt >= CACHE_TTL_MS) {
    const res = await fetchWithRetry(`${OPENROUTER_BASE}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, { errorResponse: handleHttpError })

    const { data } = await res.json()
    models = data.map((m) => {
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
    modelsCache.models = models
    modelsCache.fetchedAt = Date.now()
  }

  // The ZDR index is only consulted when zero-retention filtering was
  // requested; the plain listing never pays for the extra fetch.
  if (!zdr) return models
  const index = await getZdrIndex()
  return models.map((m) => ({ ...m, zdr: index.modelIds.has(m.id) || (m.aliasTarget != null && index.modelIds.has(m.aliasTarget)) || undefined }))
}

function imageModelConstraints(m) {
  const sp = m.supported_parameters || {}
  const enumValues = (d) => (Array.isArray(d?.values) && d.values.length > 0 ? [...d.values] : Array.isArray(d?.enum?.values) && d.enum.values.length > 0 ? [...d.enum.values] : null)
  return {
    aspectRatios: enumValues(sp.aspect_ratio),
    formats: enumValues(sp.output_format),
    resolutions: enumValues(sp.resolution),
    qualities: enumValues(sp.quality),
    widthHeightDivisor: null,
    maxN: sp.n?.max ?? sp.n?.range?.max ?? null,
    defaultAspectRatio: null,
  }
}

function cheapestImagePrice(prices) {
  const noVariant = prices.filter((p) => !p.variant)
  const chosen = noVariant.length > 0 ? noVariant : prices
  return chosen.length === 0 ? null : Math.min(...chosen.map((p) => p.cost_usd))
}

function imagePricingFromEntries(entries) {
  const perImage = []
  const perToken = []
  for (const p of entries) {
    if (p.billable !== 'output_image' || typeof p.cost_usd !== 'number') continue
    if (p.unit === 'token') perToken.push(p)
    else if (p.unit === undefined || p.unit === 'image') perImage.push(p)
  }
  return { perImage: cheapestImagePrice(perImage), perToken: cheapestImagePrice(perToken), byResolution: null, byQuality: null }
}

export async function fetchImageModelEndpoints(apiKey, modelId) {
  const cached = imageEndpointsCache.get(modelId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.endpoints
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/images/models/${modelId}/endpoints`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, { errorResponse: handleHttpError })
  const parsed = await res.json()
  const endpoints = Array.isArray(parsed.data) ? parsed.data : parsed.endpoints || parsed.data?.endpoints || []
  const mapped = endpoints.map((ep) => ({
    providerName: ep.provider_name,
    slug: ep.provider_slug || null,
    tag: ep.provider_tag || null,
    pricing: imagePricingFromEntries(ep.pricing || []),
  }))
  imageEndpointsCache.set(modelId, { fetchedAt: Date.now(), endpoints: mapped })
  return mapped
}

async function fetchImageModelPricing(apiKey, modelId) {
  const endpoints = await fetchImageModelEndpoints(apiKey, modelId)
  const perImage = endpoints.map((ep) => ep.pricing.perImage).filter((v) => v != null)
  const perToken = endpoints.map((ep) => ep.pricing.perToken).filter((v) => v != null)
  return {
    perImage: perImage.length > 0 ? Math.min(...perImage) : null,
    perToken: perToken.length > 0 ? Math.min(...perToken) : null,
    byResolution: null,
    byQuality: null,
  }
}

export async function fetchImageModels(apiKey, { withPricing = false } = {}) {
  let models = imageModelsCache.models
  if (!models || Date.now() - imageModelsCache.fetchedAt >= CACHE_TTL_MS) {
    const res = await fetchWithRetry(`${OPENROUTER_BASE}/images/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, { errorResponse: handleHttpError })
    const { data } = await res.json()
    models = (data || []).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.id.split('/')[0],
      description: m.description || null,
      privacy: null,
      pricing: null,
      constraints: imageModelConstraints(m),
      offline: false,
    }))
    imageModelsCache.fetchedAt = Date.now()
    imageModelsCache.models = models
  }
  if (!withPricing) return models
  // The pricing fan-out (one endpoints request per model) is capped so a
  // large catalog cannot burst the API; only --list-image-models uses it.
  return mapWithConcurrency(models, 8, async (m) => ({ ...m, pricing: await fetchImageModelPricing(apiKey, m.id) }))
}

export function resetImageModelCaches() {
  imageModelsCache.fetchedAt = 0
  imageModelsCache.models = null
  imageEndpointsCache.clear()
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function generateImage({ apiKey, model, prompt, format, variants = 1, aspectRatio, resolution, quality, seed, width, height, provider, signal, timeoutMs = IMAGE_GEN_TIMEOUT_MS, requestFn }) {
  const body = { model, prompt, n: variants }
  if (provider) {
    body.provider = { order: [provider], allow_fallbacks: false }
  }
  if (aspectRatio) body.aspect_ratio = aspectRatio
  if (format) body.output_format = format
  if (resolution) body.resolution = resolution
  if (quality) body.quality = quality
  if (seed !== undefined && seed !== null) body.seed = seed
  if (width !== undefined && width !== null && height !== undefined && height !== null && !aspectRatio) {
    body.size = `${width}x${height}`
  }

  const res = await fetchWithRetry(`${OPENROUTER_BASE}/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { errorResponse: handleHttpError, signal, timeoutMs })
  const parsed = await res.json()
  const rawImages = Array.isArray(parsed.data) ? parsed.data : []
  if (rawImages.length === 0) {
    throw new ApiError('OpenRouter returned no images.', { provider: 'openrouter', retryable: false })
  }

  const images = await Promise.all(rawImages.map(async (d) => {
    let b64 = d.b64_json || d.b64
    if (!b64 && typeof d.url === 'string') {
      // URL-only responses (no base64 payload) are downloaded the same way
      // produced artifacts are: SSRF-checked, redirect re-validated, size-capped.
      const fetched = await fetchSafeBytes(d.url, { maxBytes: MAX_IMAGE_ATTACHMENT_BYTES, requestFn })
      if (fetched) b64 = fetched.toString('base64')
    }
    if (!b64) {
      throw new ApiError('OpenRouter returned an image without base64 data or a usable URL.', { provider: 'openrouter', retryable: false })
    }
    const mime = d.media_type || mimeForExt(format || 'png')
    const ext = extForMime(mime)
    return {
      bytes: Buffer.from(b64, 'base64'),
      dataUrl: `data:${mime};base64,${b64}`,
      mime,
      ext,
    }
  }))

  const count = images.length
  const cost = parsed.usage?.cost != null ? parsed.usage.cost / count : null

  return {
    id: parsed.id || null,
    images,
    blurred: false,
    cost,
  }
}

export async function fetchEndpoints(apiKey, modelId, allModels) {
  const model = allModels?.find((m) => m.id === modelId)
  let queryId = model?.aliasTarget || modelId

  const request = () => fetchWithRetry(`${OPENROUTER_BASE}/models/${queryId}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { errorResponse: handleHttpError })

  let res = await request()
  let { data } = await res.json()

  if (!data?.endpoints?.length && modelId.startsWith('~') && queryId === modelId && !allModels?.length) {
    // The alias target was not resolvable from the supplied model list (the
    // caller did not pass one); only then is a fresh listing worth fetching.
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

export async function chatCompletion({ apiKey, model, messages, onToken, onSources, provider, reasoningEffort, reasoningMandatory = false, supportsReasoning, temperature, topP, webSearch, webResults, zdr = false, signal, onRequest = null, sessionId = null }) {
  const body = {
    model,
    messages,
    stream: true,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
  }

  if (anthropicAutoCachingAvailable(model, provider)) {
    body.cache_control = estimatePromptTokens(messages) >= ANTHROPIC_CACHE_MIN_PROMPT_TOKENS
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' }
  }
  // Sticky routing is disabled by an explicit provider order, so the
  // session_id routing key is only useful on unpinned requests.
  if (sessionId && !provider) {
    body.session_id = sessionId
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
  } else if (reasoningEffort === null && !reasoningMandatory && supportsReasoning !== false) {
    // `effort: "none"` is OpenRouter's documented disable ("Disables
    // reasoning entirely"). `exclude: true` only strips reasoning from the
    // response while the model still thinks — the reason "disabled" requests
    // used to take forever with no visible output — so it is never used as
    // the disable signal. Mandatory-reasoning models reject `effort: "none"`
    // with a 400, so for those (and endpoints without the reasoning param)
    // the field is omitted entirely and the model keeps its default.
    body.reasoning = { effort: 'none' }
  }

  onRequest?.(body)

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
