import { parseSSEStream } from "../sse-parser.js"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"
const CACHE_HEADER = "x-openrouter-cache-status"

export const meta = {
  name: "openrouter",
  baseURL: OPENROUTER_BASE,
  apiKeyEnv: "OPENROUTER_API_KEY",
  hasEndpoints: true,
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
    console.error("Invalid API key. Check your OPENROUTER_API_KEY environment variable.")
    process.exit(1)
  }
  if (status === 429) {
    throw new Error("Rate limited by OpenRouter. Wait a moment and try again.")
  }
  throw new Error(`OpenRouter request failed (${status}): ${body}`)
}

export async function fetchModels(apiKey) {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!res.ok) {
    const body = await res.text()
    handleHttpError(res.status, body)
  }

  const { data } = await res.json()
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.id.split("/")[0],
    contextLength: m.context_length,
    description: m.description,
    reasoning: m.reasoning || null,
  }))
}

export async function fetchEndpoints(apiKey, modelId) {
  const res = await fetch(`${OPENROUTER_BASE}/models/${modelId}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!res.ok) {
    const body = await res.text()
    handleHttpError(res.status, body)
  }

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

export async function chatCompletion({ apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning }) {
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
  }

  if (provider) {
    body.provider = {
      order: [provider],
      allow_fallbacks: false,
    }
  }

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort, exclude: false }
  } else if (reasoningEffort === null) {
    body.reasoning = { enabled: false }
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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

  const cacheStatus = res.headers.get(CACHE_HEADER)
  const reader = res.body.getReader()

  const { fullText, fullReasoning, finalUsage } = await parseSSEStream(reader, onToken)

  const usage = finalUsage

  if (cacheStatus === "HIT" && !usage) {
    return {
      content: fullText,
      reasoning: fullReasoning || undefined,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true },
    }
  }

  if (cacheStatus === "HIT" && usage) {
    usage.cacheHit = true
  }

  return { content: fullText, reasoning: fullReasoning || undefined, usage }
}
