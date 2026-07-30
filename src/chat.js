import { createInterface } from "node:readline"
import { chatCompletion } from "./openrouter.js"
import { UsageTracker } from "./tracker.js"
import { ensureSessionsDir, saveSession } from "./sessions.js"

const THIN_SEP = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"

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

export async function startChat(apiKey, model, providerName, reasoningEffort, pricing, {
  systemPrompt = null,
  initialMessages = null,
  sessionId = null,
  createdAt = null,
} = {}) {
  let messages
  if (initialMessages) {
    messages = initialMessages
  } else {
    const systemContent = systemPrompt || "You are a helpful assistant."
    messages = [{ role: "system", content: systemContent }]
  }

  const tracker = new UsageTracker()

  const label = providerName ? `${providerName} / ${model}` : model
  if (reasoningEffort) {
    const { getEffortLabel } = await import("./prompts.js")
    console.log(`\nConnected to ${label}  [thinking: ${getEffortLabel(reasoningEffort)}]`)
  } else {
    console.log(`\nConnected to ${label}`)
  }
  console.log('Type your message and press Enter. "/quit" or Cmd+C/Ctrl+C to exit.\n')

  if (initialMessages) {
    renderHistory(messages)
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  })

  rl.prompt()

  process.once("SIGINT", () => {
    rl.close()
  })

  for await (const line of rl) {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      continue
    }

    if (input === "/quit") {
      rl.close()
      return messages
    }

    messages.push({ role: "user", content: input })

    let result
    let shownThinkingBanner = false

    try {
      process.stdout.write("\n")
      result = await chatCompletion(apiKey, model, messages, (token, type) => {
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
      }, providerName, reasoningEffort)
      process.stdout.write("\n\n")

      if (result.usage) {
        tracker.record(result.usage, pricing)
        tracker.printTurn(result.usage, pricing)
      }
    } catch (err) {
      console.error(`\nError: ${err.message}\n`)
      if (err.message.includes("Rate limited")) {
        messages.pop()
      }
      rl.prompt()
      continue
    }

    if (result.content) {
      const msg = { role: "assistant", content: result.content }
      if (result.reasoning) {
        msg.reasoning = result.reasoning
      }
      if (result.usage) {
        msg.usage = result.usage
      }
      messages.push(msg)
    }

    if (sessionId) {
      try {
        const dir = await ensureSessionsDir()
        await saveSession(dir, sessionId, {
          model,
          providerName,
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

    rl.prompt()
  }

  return messages
}
