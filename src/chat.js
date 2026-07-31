import { UsageTracker } from "./tracker.js"
import { getEffortLabel } from "./prompts.js"
import { readInput } from "./input.js"
import { createStreamRenderer, renderHistory } from "./ui/stream.js"
import { formatError, ApiError } from "./errors.js"
import { dim } from "./ui/style.js"

export async function startChat(apiKey, model, endpointProviderName, reasoningEffort, pricing, provider, {
  systemPrompt = null,
  initialMessages = null,
  sessionId = null,
  createdAt = null,
  supportsReasoning = true,
} = {}) {
  let messages
  if (initialMessages) {
    messages = initialMessages
  } else {
    const systemContent = systemPrompt || "You are a helpful assistant."
    messages = [{ role: "system", content: systemContent }]
  }

  const tracker = new UsageTracker()

  if (initialMessages) {
    for (const msg of initialMessages) {
      if (msg.role === "assistant" && msg.usage) {
        tracker.record(msg.usage, pricing)
      }
    }
  }

  const label = endpointProviderName ? `${endpointProviderName} / ${model}` : model
  if (reasoningEffort) {
    console.log(`\nConnected to ${label}  [thinking: ${getEffortLabel(reasoningEffort)}]`)
  } else {
    console.log(`\nConnected to ${label}`)
  }
  console.log(`Send with Enter  |  Newline: Ctrl+J  |  /quit to exit\n`)

  if (initialMessages) {
    renderHistory(messages)
  }

  if (initialMessages && tracker.requests > 0) {
    console.log(`${dim("Previous session:")} ${tracker.summary()}\n`)
  }

  const render = createStreamRenderer()

  while (true) {
    const result = await readInput()

    if (result.quit) {
      process.stdout.write("\n")
      return messages
    }

    if (result.cancelled) {
      process.stdout.write("\n")
      return messages
    }

    const input = result.value.trim()
    if (!input) continue

    messages.push({ role: "user", content: input })

    let apiResult

    try {
      process.stdout.write("\n")
      apiResult = await provider.chatCompletion({ apiKey, model, messages, onToken: render, provider: endpointProviderName, reasoningEffort, supportsReasoning, sessionId })
      process.stdout.write("\n\n")

      if (apiResult.usage) {
        tracker.record(apiResult.usage, pricing)
        tracker.printTurn(apiResult.usage, pricing)
      }
    } catch (err) {
      console.error(`\nError: ${formatError(err)}\n`)
      if (err instanceof ApiError && err.retryable) {
        messages.pop()
      }
      continue
    }

    if (apiResult.content) {
      const msg = { role: "assistant", content: apiResult.content }
      if (apiResult.reasoning) {
        msg.reasoning = apiResult.reasoning
      }
      if (apiResult.usage) {
        msg.usage = apiResult.usage
      }
      messages.push(msg)
    }
  }
}
