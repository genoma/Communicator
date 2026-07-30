import { UsageTracker } from "./tracker.js"
import { ensureSessionsDir, saveSession } from "./sessions.js"
import { THIN_SEP } from "./constants.js"
import { getEffortLabel } from "./prompts.js"
import { readInput } from "./input.js"

function renderHistory(messages) {
  if (!messages || messages.length <= 1) return

  const hasVisible = messages.some((m) => m.role !== "system")
  if (!hasVisible) return

  process.stdout.write("\n")
  for (const msg of messages) {
    if (msg.role === "user") {
      process.stdout.write(`> ${msg.content}\n\n`)
    } else if (msg.role === "assistant") {
      if (msg.reasoning) {
        process.stdout.write("\x1b[90m[Thinking]\x1b[0m\n\n")
        process.stdout.write(`\x1b[90m${msg.reasoning}\x1b[0m\n`)
        process.stdout.write("\n\x1b[1m[Answer]\x1b[0m\n\n")
      }
      process.stdout.write(`${msg.content}\n\n`)
    }
  }

  process.stdout.write(`\x1b[90m${THIN_SEP}\x1b[0m\n\n`)
}

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
    console.log(`\x1b[90mPrevious session:\x1b[0m ${tracker.summary()}\n`)
  }

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
    let shownThinkingBanner = false

    try {
      process.stdout.write("\n")
      apiResult = await provider.chatCompletion({ apiKey, model, messages, onToken: (token, type) => {
        if (type === "start_reasoning") {
          shownThinkingBanner = true
          process.stdout.write("\x1b[90m[Thinking]\x1b[0m\n")
          process.stdout.write(token)
        } else if (type === "reasoning") {
          process.stdout.write(`\x1b[90m${token}\x1b[0m`)
        } else if (type === "end_reasoning") {
          process.stdout.write("\n\n\x1b[1m[Answer]\x1b[0m\n\n")
        } else if (type === "content") {
          process.stdout.write(token)
        }
      }, provider: endpointProviderName, reasoningEffort, supportsReasoning, sessionId })
      process.stdout.write("\n\n")

      if (apiResult.usage) {
        tracker.record(apiResult.usage, pricing)
        tracker.printTurn(apiResult.usage, pricing)
      }
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      if (err.message.includes("Rate limited")) {
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

    if (sessionId) {
      try {
        const dir = await ensureSessionsDir()
        await saveSession(dir, sessionId, {
          model,
          providerName: endpointProviderName,
          providerType: provider.meta.name,
          reasoningEffort: reasoningEffort ?? null,
          pricing: pricing ?? null,
          createdAt: createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages,
        })
      } catch {
        // save failures are non-fatal
      }
    }
  }
}
