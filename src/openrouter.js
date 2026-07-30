import { OPENROUTER_BASE, SSE_DATA_PREFIX, SSE_DONE, CACHE_HEADER } from "./constants.js"

function handleHttpError(status, body) {
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

async function parseSSEStream(reader, onToken) {
  const decoder = new TextDecoder()
  let fullText = ""
  let fullReasoning = ""
  let buffer = ""
  let inThinking = false
  let finalUsage = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith(SSE_DATA_PREFIX)) continue
      const data = trimmed.slice(SSE_DATA_PREFIX.length)
      if (data === SSE_DONE) continue
      try {
        const parsed = JSON.parse(data)

        if (parsed.usage) {
          finalUsage = parsed.usage
          continue
        }

        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue

        const reasoningToken = delta.reasoning_content ?? (typeof delta.reasoning === "string" ? delta.reasoning : undefined)
        if (reasoningToken) {
          fullReasoning += reasoningToken
          if (!inThinking) {
            inThinking = true
            onToken("\n", "start_reasoning")
          }
          onToken(reasoningToken, "reasoning")
          continue
        }

        const contentToken = delta.content
        if (contentToken) {
          if (inThinking) {
            inThinking = false
            onToken(null, "end_reasoning")
          }
          fullText += contentToken
          onToken(contentToken, "content")
        }
      } catch {
        // skip unparseable chunks
      }
    }
  }

  return { fullText, fullReasoning, finalUsage }
}

export async function chatCompletion({ apiKey, model, messages, onToken, provider, reasoningEffort }) {
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
    const body = await res.text()
    handleHttpError(res.status, body)
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
