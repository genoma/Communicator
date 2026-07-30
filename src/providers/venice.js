import { parseSSEStream } from "../sse-parser.js"

const VENICE_BASE = "https://api.venice.ai/api/v1"

export const meta = {
  name: "venice",
  baseURL: VENICE_BASE,
  apiKeyEnv: "VENICE_API_KEY",
  hasEndpoints: false,
}

export function normalizePricing(raw) {
  if (raw?.input?.usd == null || raw?.output?.usd == null) {
    return { prompt: null, completion: null }
  }
  return {
    prompt: raw.input.usd / 1_000_000,
    completion: raw.output.usd / 1_000_000,
  }
}

export function handleHttpError(status, body) {
  if (status === 401) {
    console.error("Invalid API key. Check your VENICE_API_KEY environment variable.")
    process.exit(1)
  }
  if (status === 429) {
    throw new Error("Rate limited by Venice. Wait a moment and try again.")
  }
  throw new Error(`Venice request failed (${status}): ${body}`)
}

export async function fetchModels(apiKey) {
  const headers = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const res = await fetch(`${VENICE_BASE}/models?type=text`, { headers })

  if (!res.ok) {
    const body = await res.text()
    handleHttpError(res.status, body)
  }

  const { data } = await res.json()

  return (data || []).map((m) => {
    const spec = m.model_spec || {}
    const caps = spec.capabilities || {}
    const pricing = normalizePricing(spec.pricing || null)
    const ctxStr = spec.availableContextTokens
      ? `${spec.availableContextTokens.toLocaleString()} ctx`
      : "? ctx"
    const inPrice = pricing.prompt != null
      ? `$${(pricing.prompt * 1_000_000).toFixed(2)}`
      : "?"
    const outPrice = pricing.completion != null
      ? `$${(pricing.completion * 1_000_000).toFixed(2)}`
      : "?"
    const privacy = spec.privacy || null
    const modelDesc = spec.description || null

    const metaParts = [ctxStr]
    metaParts.push(`in ${inPrice} / out ${outPrice} per 1M`)
    if (caps.supportsReasoningEffort) metaParts.push("reasoning")
    else if (caps.supportsReasoning) metaParts.push("auto-reasoning")
    if (privacy) metaParts.push(privacy)
    const metaStr = metaParts.join("  |  ")

    return {
      id: m.id,
      name: spec.name || m.id,
      provider: "venice",
      contextLength: spec.availableContextTokens || null,
      description: modelDesc ? `${metaStr}\n${modelDesc}` : metaStr,
      reasoning: caps.supportsReasoning
        ? {
            supported: true,
            supportsEffort: caps.supportsReasoningEffort,
            supported_efforts: caps.reasoningEffortOptions,
            default_effort: caps.defaultReasoningEffort,
            mandatory: caps.reasoningEffortOptions ? !caps.reasoningEffortOptions.includes("none") : true,
          }
        : null,
      _rawPricing: spec.pricing || null,
      privacy,
      capabilities: caps,
      maxCompletionTokens: spec.constraints?.max_tokens || null,
    }
  })
}

export async function fetchEndpoints(apiKey, modelId, allModels) {
  const models = allModels || await fetchModels(apiKey)
  const model = models.find((m) => m.id === modelId)
  if (!model) return []

  const pricing = normalizePricing(model._rawPricing)

  return [{
    name: model.name,
    providerName: "venice",
    tag: model.id,
    status: "available",
    uptime30m: null,
    pricing,
    contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens,
    supportedParameters: model.capabilities,
  }]
}

export async function chatCompletion({ apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning, sessionId }) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    venice_parameters: { include_venice_system_prompt: false },
  }

  if (sessionId) {
    body.prompt_cache_key = sessionId
  }

  if (reasoningEffort && supportsReasoning !== false) {
    body.reasoning_effort = reasoningEffort
  } else if (reasoningEffort === null && supportsReasoning !== false) {
    body.reasoning_effort = "none"
  }

  const res = await fetch(`${VENICE_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const bodyText = await res.text()
    handleHttpError(res.status, bodyText)
  }

  const reader = res.body.getReader()
  const { fullText, fullReasoning, finalUsage } = await parseSSEStream(reader, onToken)

  return { content: fullText, reasoning: fullReasoning || undefined, usage: finalUsage }
}
