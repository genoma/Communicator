import { parseSSEStream } from '../sse-parser.js'
import { fetchWithRetry } from '../http.js'
import { ApiError, makeHandleHttpError } from '../errors.js'
import { formatPricePerM, formatImagePrice, imageUnitPrice } from '../ui/format.js'
import { DEFAULT_TEMPERATURE, IMAGE_GEN_TIMEOUT_MS } from '../constants.js'
import { mimeForExt, extForMime } from '../attachments.js'
import { encryptMessages, decryptToken } from '../e2ee.js'

const VENICE_BASE = 'https://api.venice.ai/api/v1'

export const meta = {
  name: 'venice',
  baseURL: VENICE_BASE,
  apiKeyEnv: 'VENICE_API_KEY',
  hasEndpoints: false,
}

export const handleHttpError = makeHandleHttpError({ providerName: 'Venice', providerId: 'venice', apiKeyEnv: 'VENICE_API_KEY' })

export function normalizePricing(raw) {
  if (raw?.input?.usd == null || raw?.output?.usd == null) {
    return { prompt: null, completion: null }
  }
  return {
    prompt: raw.input.usd / 1_000_000,
    completion: raw.output.usd / 1_000_000,
  }
}

function pricingUsd(value) {
  return value && typeof value.usd === 'number' ? value.usd : null
}

export function normalizeImagePricing(raw) {
  if (!raw || typeof raw !== 'object') return { perImage: null, byResolution: null, byQuality: null }

  const perImage = pricingUsd(raw.generation)

  let byResolution = null
  if (raw.resolutions && typeof raw.resolutions === 'object') {
    const entries = Object.entries(raw.resolutions).filter(([, v]) => pricingUsd(v) != null)
    if (entries.length > 0) byResolution = Object.fromEntries(entries.map(([k, v]) => [k, pricingUsd(v)]))
  }

  let byQuality = null
  if (raw.quality && typeof raw.quality === 'object') {
    const tiers = Object.entries(raw.quality)
      .map(([resolution, tier]) => {
        if (!tier || typeof tier !== 'object') return null
        const qualities = Object.entries(tier)
          .filter(([, v]) => pricingUsd(v) != null)
          .map(([q, v]) => [q, pricingUsd(v)])
        if (qualities.length === 0) return null
        return [resolution, Object.fromEntries(qualities)]
      })
      .filter(Boolean)
    if (tiers.length > 0) byQuality = Object.fromEntries(tiers)
  }

  return { perImage, byResolution, byQuality }
}

function imageMetaStr(m) {
  const spec = m.model_spec || {}
  const constraints = spec.constraints || {}
  const parts = [formatImagePrice(normalizeImagePricing(spec.pricing || null))]
  if (constraints.aspectRatios?.length) parts.push(`aspect: ${constraints.aspectRatios.join(', ')}`)
  if (constraints.resolutions?.length) parts.push(`res: ${constraints.resolutions.join(', ')}`)
  if (constraints.qualities?.length) parts.push(`quality: ${constraints.qualities.join(', ')}`)
  if (spec.privacy) parts.push(spec.privacy)
  if (spec.offline) parts.push('offline')
  return parts.join('  |  ')
}

export async function fetchModelsByType(apiKey, type) {
  const headers = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const res = await fetchWithRetry(`${VENICE_BASE}/models?type=${type}`, { headers }, { errorResponse: handleHttpError })

  return res.json()
}

export async function fetchModels(apiKey) {
  const { data } = await fetchModelsByType(apiKey, 'text')

  return (data || []).map((m) => {
    const spec = m.model_spec || {}
    const caps = spec.capabilities || {}
    const pricing = normalizePricing(spec.pricing || null)
    const ctxStr = spec.availableContextTokens
      ? `${spec.availableContextTokens.toLocaleString()} ctx`
      : '? ctx'
    const privacy = spec.privacy || null
    const modelDesc = spec.description || null

    const metaParts = [ctxStr]
    metaParts.push(formatPricePerM(pricing))
    if (caps.supportsReasoningEffort) metaParts.push('reasoning')
    else if (caps.supportsReasoning) metaParts.push('auto-reasoning')
    if (privacy) metaParts.push(privacy)
    const metaStr = metaParts.join('  |  ')

    return {
      id: m.id,
      name: spec.name || m.id,
      provider: 'venice',
      contextLength: spec.availableContextTokens || null,
      visionSupported: typeof caps.supportsVision === 'boolean' ? caps.supportsVision : undefined,
      description: modelDesc ? `${metaStr}\n${modelDesc}` : metaStr,
      reasoning: caps.supportsReasoning
        ? {
            supported: true,
            supportsEffort: caps.supportsReasoningEffort,
            supported_efforts: caps.reasoningEffortOptions,
            default_effort: caps.defaultReasoningEffort,
            mandatory: caps.reasoningEffortOptions ? !caps.reasoningEffortOptions.includes('none') : true,
          }
        : null,
      pricing,
      capabilities: { ...caps, privacy },
      maxCompletionTokens: spec.constraints?.max_tokens || null,
    }
  })
}

export async function fetchImageModels(apiKey) {
  const { data } = await fetchModelsByType(apiKey, 'image')
  return (data || []).map((m) => {
    const spec = m.model_spec || {}
    const constraints = spec.constraints || {}
    const metaStr = imageMetaStr(m)
    const modelDesc = spec.description || null
    return {
      id: m.id,
      name: spec.name || m.id,
      provider: 'venice',
      description: modelDesc ? `${metaStr}\n${modelDesc}` : metaStr,
      privacy: spec.privacy || null,
      pricing: normalizeImagePricing(spec.pricing || null),
      constraints: {
        aspectRatios: constraints.aspectRatios || null,
        formats: ['png', 'jpeg', 'webp'],
        resolutions: constraints.resolutions || null,
        qualities: constraints.qualities || null,
        widthHeightDivisor: constraints.widthHeightDivisor || null,
        maxN: null,
        defaultAspectRatio: constraints.defaultAspectRatio || null,
      },
      offline: spec.offline === true,
    }
  })
}

export async function generateImage({ apiKey, model, prompt, format = 'webp', variants = 1, safeMode = true, hideWatermark = false, aspectRatio, resolution, quality, seed, width, height, pricing, signal, timeoutMs = IMAGE_GEN_TIMEOUT_MS }) {
  const body = {
    model,
    prompt,
    format,
    variants,
    safe_mode: safeMode,
  }
  if (hideWatermark) body.hide_watermark = true
  if (aspectRatio) body.aspect_ratio = aspectRatio
  if (resolution) body.resolution = resolution
  if (quality) body.quality = quality
  if (seed !== undefined && seed !== null) body.seed = seed
  if (width !== undefined && width !== null && !aspectRatio) body.width = width
  if (height !== undefined && height !== null && !aspectRatio) body.height = height

  const res = await fetchWithRetry(`${VENICE_BASE}/image/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { errorResponse: handleHttpError, signal, timeoutMs })
  const parsed = await res.json()
  const rawImages = Array.isArray(parsed.images) ? parsed.images : []
  if (rawImages.length === 0) {
    throw new ApiError('Venice returned no images.', { provider: 'venice', retryable: false })
  }

  const mime = mimeForExt(format)
  const ext = extForMime(mime)
  const images = rawImages.map((b64) => ({
    bytes: Buffer.from(b64, 'base64'),
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    ext,
  }))

  return {
    id: parsed.id,
    images,
    blurred: res.headers.get('x-venice-is-blurred') === 'true',
    cost: imageUnitPrice(pricing, { resolution, quality }),
  }
}

export async function fetchEndpoints(apiKey, modelId, allModels) {
  const models = allModels || await fetchModels(apiKey)
  const model = models.find((m) => m.id === modelId)
  if (!model) return []

  return [{
    name: model.name,
    providerName: 'venice',
    tag: model.id,
    status: 'available',
    uptime30m: null,
    pricing: model.pricing,
    contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens,
    supportedParameters: model.capabilities,
  }]
}

export async function chatCompletion({ apiKey, model, messages, onToken, onSources, reasoningEffort, supportsReasoning, sessionId, temperature = DEFAULT_TEMPERATURE, webSearch, signal, e2ee = false, e2eeContext = null }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  let sentMessages = messages
  if (e2ee) {
    sentMessages = encryptMessages(messages, e2eeContext.modelPubKeyHex)
    headers['X-Venice-TEE-Client-Pub-Key'] = e2eeContext.clientPubKeyHex
    headers['X-Venice-TEE-Model-Pub-Key'] = e2eeContext.modelPubKeyHex
    headers['X-Venice-TEE-Signing-Algo'] = 'ecdsa'
  }

  const body = {
    model,
    messages: sentMessages,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    venice_parameters: { include_venice_system_prompt: false },
  }

  // E2EE cannot be combined with web search: the host must never see query
  // or result content. Prompt caching is disabled too because the host
  // cannot key a cache on ciphertext.
  const webMode = e2ee ? 'off' : (webSearch === 'always' ? 'on' : (webSearch || 'off'))
  body.venice_parameters.enable_web_search = webMode
  if (webMode !== 'off') {
    body.venice_parameters.enable_web_citations = true
    // Venice only includes venice_parameters.web_search_citations in a
    // streaming response when this experimental flag is set; without it the
    // citations are only present in the non-streaming response.
    body.venice_parameters.include_search_results_in_stream = true
  }

  if (sessionId && !e2ee) {
    body.prompt_cache_key = sessionId
  }

  if (reasoningEffort && supportsReasoning !== false) {
    body.reasoning_effort = reasoningEffort
  } else if (reasoningEffort === null && supportsReasoning !== false) {
    body.reasoning_effort = 'none'
  }

  const res = await fetchWithRetry(`${VENICE_BASE}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, { errorResponse: handleHttpError, signal })

  const reader = res.body.getReader()
  const streamOptions = e2ee ? { decryptToken: (hex) => decryptToken(hex, e2eeContext.clientKey) } : undefined
  const { fullText, fullReasoning, finalUsage, fullSources, skippedChunks, fullParts } = await parseSSEStream(reader, onToken, onSources, streamOptions)

  return { content: fullText, reasoning: fullReasoning || undefined, usage: finalUsage, sources: fullSources, skippedChunks, parts: fullParts.length > 0 ? fullParts : undefined }
}
