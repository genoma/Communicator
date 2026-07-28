const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export async function fetchModels(apiKey) {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      console.error("Invalid API key. Check your ~/.openrouter-key file.");
      process.exit(1);
    }
    throw new Error(`OpenRouter models fetch failed (${res.status}): ${body}`);
  }

  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.id.split("/")[0],
    contextLength: m.context_length,
    description: m.description,
  }));
}

export async function fetchEndpoints(apiKey, modelId) {
  const res = await fetch(`${OPENROUTER_BASE}/models/${modelId}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Endpoints fetch failed (${res.status}): ${body}`);
  }

  const { data } = await res.json();
  if (!data?.endpoints?.length) {
    return [];
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
  }));
}

export async function chatCompletion(apiKey, model, messages, onToken, providerName) {
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
  };

  if (providerName) {
    body.provider = {
      order: [providerName],
      allow_fallbacks: false,
    };
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      console.error("Invalid API key. Check your ~/.openrouter-key file.");
      process.exit(1);
    }
    if (res.status === 429) {
      throw new Error("Rate limited by OpenRouter. Wait a moment and try again.");
    }
    throw new Error(`OpenRouter chat failed (${res.status}): ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onToken(delta);
        }
      } catch {
        // skip unparseable chunks
      }
    }
  }

  return fullText;
}
