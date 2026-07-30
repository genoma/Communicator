#!/usr/bin/env node

import { Command } from "commander"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from "./src/config.js"
import { fetchModels, fetchEndpoints } from "./src/openrouter.js"
import { selectModel, selectProvider, selectReasoningEffort, BACK_SENTINEL } from "./src/prompts.js"
import { startChat } from "./src/chat.js"
import { ensureSessionsDir, resolveSession, loadSession, saveSession, listSessionsForPicker } from "./src/sessions.js"
import { selectSession } from "./src/session-picker.js"

const program = new Command()

program
  .name("communicator")
  .description("OpenRouter CLI chat with interactive model & provider selection")
  .option("-m, --model <id>", "skip model picker, use this model ID directly")
  .option("-p, --provider <name>", "skip provider picker, use this provider name directly")
  .option("-l, --list", "list available models and exit")
  .option("-L, --list-endpoints <model>", "list providers/endpoints for a model and exit")
  .option("-r, --resume [session-id]", "resume a saved session (optional session ID)")
  .option("--list-sessions", "list saved sessions and exit")
  .option("--config <path>", "path to preferences config file")
  .option("--system-prompt <path>", "path to a custom system prompt file")
  .option("--reasoning-effort <level>", "reasoning effort: max, xhigh, high, medium, low, minimal, none")
  .option("--no-reasoning", "disable reasoning entirely")

program.parse()
const opts = program.opts()

const apiKey = getApiKey()

if (opts.list) {
  const models = await fetchModels(apiKey)
  for (const m of models) {
    console.log(
      `${m.name.padEnd(40)} ${m.id.padEnd(50)} ${m.contextLength?.toLocaleString() || "?"} ctx`
    )
  }
  process.exit(0)
}

if (opts.listEndpoints) {
  const endpoints = await fetchEndpoints(apiKey, opts.listEndpoints)
  if (!endpoints.length) {
    console.log(`No endpoints found for ${opts.listEndpoints}`)
    process.exit(0)
  }
  console.log(`${endpoints.length} provider(s) for ${opts.listEndpoints}:\n`)
  for (const ep of endpoints) {
    const promptPrice = ep.pricing?.prompt
      ? `$${(parseFloat(ep.pricing.prompt) * 1_000_000).toFixed(2)}/M`
      : "?"
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : "?"
    console.log(
      `${ep.providerName.padEnd(20)} | prompt ${promptPrice.padEnd(12)} | uptime ${uptime} | tag ${ep.tag}`
    )
  }
  process.exit(0)
}

if (opts.listSessions) {
  const dir = await ensureSessionsDir()
  const sessions = await listSessionsForPicker(dir)
  if (!sessions.length) {
    console.log("No saved sessions found.")
    process.exit(0)
  }
  console.log(`${sessions.length} saved session(s):\n`)
  for (const s of sessions) {
    const time = s.id.replace("T", " ")
    const model = s.model.length > 35 ? s.model.slice(0, 32) + "..." : s.model
    const count = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`
    const preview = s.preview ? `"${s.preview}${s.preview.length >= 60 ? "..." : ""}"` : ""
    console.log(`${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${preview}`)
  }
  process.exit(0)
}

const prefs = await loadPreferences(opts.config)
const systemPrompt = await loadSystemPrompt(opts.systemPrompt)

let modelId, modelName, providerName, reasoningEffort, pricing
let initialMessages = null
let sessionId = null
let sessionCreatedAt = null

function resolveReasoningFlag() {
  if (opts.reasoning === false) return null
  if (opts.reasoningEffort) return opts.reasoningEffort
  return undefined
}

if (opts.resume !== undefined) {
  const dir = await ensureSessionsDir()
  let matchedId

  if (opts.resume && typeof opts.resume === "string") {
    const matches = await resolveSession(dir, opts.resume)
    if (matches.length === 0) {
      console.error(`No session found matching "${opts.resume}"`)
      process.exit(1)
    }
    if (matches.length === 1) {
      matchedId = matches[0].id
    } else {
      matchedId = await selectSession(matches)
    }
  } else {
    const sessions = await listSessionsForPicker(dir)
    if (!sessions.length) {
      console.log("No saved sessions to resume.")
      process.exit(0)
    }
    matchedId = await selectSession(sessions)
  }

  const sessionData = await loadSession(dir, matchedId)
  modelId = sessionData.model
  modelName = modelId
  providerName = sessionData.providerName || null
  reasoningEffort = sessionData.reasoningEffort
  initialMessages = sessionData.messages
  sessionId = matchedId
  sessionCreatedAt = sessionData.createdAt
} else {
  if (opts.model && opts.provider) {
    modelId = opts.model
    modelName = modelId
    providerName = opts.provider
    reasoningEffort = resolveReasoningFlag()
  } else {
    const models = await fetchModels(apiKey)
    reasoningEffort = resolveReasoningFlag()

    for (;;) {
      let selected
      if (opts.model) {
        modelId = opts.model
        modelName = modelId
        selected = null
      } else {
        selected = await selectModel(models, prefs.lastModel)
        modelId = selected.id
        modelName = selected.name
      }

      if (reasoningEffort === undefined) {
        const modelData = models.find((m) => m.id === modelId)
        const lastEffort = prefs.reasoningEffort?.[modelId]
        reasoningEffort = await selectReasoningEffort(modelData?.reasoning, lastEffort)
      }

      if (opts.provider) {
        providerName = opts.provider
        break
      }

      const endpoints = await fetchEndpoints(apiKey, modelId)
      if (!endpoints.length) {
        console.error(`No providers found for model: ${modelId}`)
        process.exit(1)
      }

      const ep = await selectProvider(endpoints)
      if (ep === BACK_SENTINEL) {
        reasoningEffort = undefined
        continue
      }
      providerName = ep.providerName
      pricing = ep.pricing
      break
    }
  }

  const dir = await ensureSessionsDir()
  let baseId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "")
  sessionId = baseId
  let suffix = 1
  while (true) {
    try {
      await access(join(dir, `${sessionId}.json`))
      suffix++
      sessionId = `${baseId}-${suffix}`
    } catch {
      break
    }
  }
  sessionCreatedAt = new Date().toISOString()
}

const finalMessages = await startChat(apiKey, modelId, providerName, reasoningEffort, pricing, {
  systemPrompt,
  initialMessages,
  sessionId,
  createdAt: sessionCreatedAt,
})

if (sessionId && finalMessages && finalMessages.length > 1) {
  try {
    const dir = await ensureSessionsDir()
    await saveSession(dir, sessionId, {
      model: modelId,
      providerName,
      reasoningEffort: reasoningEffort ?? null,
      createdAt: sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      messages: finalMessages,
    })
  } catch {
    // non-fatal
  }
}

const savedPrefs = { lastModel: modelId, lastProvider: providerName }
if (reasoningEffort !== undefined) {
  if (!prefs.reasoningEffort) prefs.reasoningEffort = {}
  prefs.reasoningEffort[modelId] = reasoningEffort
  savedPrefs.reasoningEffort = prefs.reasoningEffort
}
await savePreferences(savedPrefs, opts.config)
