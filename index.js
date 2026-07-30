#!/usr/bin/env node

import { Command } from "commander"
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from "./src/config.js"
import { listModelsCmd } from "./src/commands/list-models.js"
import { listEndpointsCmd } from "./src/commands/list-endpoints.js"
import { listSessionsCmd } from "./src/commands/list-sessions.js"
import { exportCmd } from "./src/commands/export-cmd.js"
import { chatStart } from "./src/commands/chat-start.js"

const program = new Command()

program
  .name("communicator")
  .description("OpenRouter CLI chat with interactive model & provider selection")
  .option("-m, --model <id>", "skip model picker, use this model ID directly")
  .option("-p, --provider <name>", "skip provider picker, use this provider name directly")
  .option("--lm, --list-models", "list available models and exit")
  .option("--le, --list-endpoints <model>", "list providers/endpoints for a model and exit")
  .option("-r, --resume [session-id]", "resume a saved session (optional session ID)")
  .option("-e, --export [session-id]", "export a saved session as markdown")
  .option("--od, --output-dir <path>", "custom directory for exported markdown files")
  .option("--ls, --list-sessions", "list saved sessions and exit")
  .option("--cfg, --config <path>", "path to preferences config file")
  .option("--sp, --system-prompt <path>", "path to a custom system prompt file")
  .option("--re, --reasoning-effort <level>", "reasoning effort: max, xhigh, high, medium, low, minimal, none")
  .option("--nr, --no-reasoning", "disable reasoning entirely")

program.parse()
const opts = program.opts()

const apiKey = getApiKey()

if (opts.listModels) {
  await listModelsCmd(apiKey)
  process.exit(0)
}

if (opts.listEndpoints) {
  await listEndpointsCmd(apiKey, opts.listEndpoints)
  process.exit(0)
}

if (opts.listSessions) {
  await listSessionsCmd()
  process.exit(0)
}

if (opts.export !== undefined) {
  const prefs = await loadPreferences(opts.config)
  const outputDir = opts.outputDir || prefs.outputDir || null
  const partialId = typeof opts.export === "string" ? opts.export : null
  await exportCmd(partialId, outputDir)
  if (opts.outputDir && opts.outputDir !== prefs.outputDir) {
    await savePreferences({ ...prefs, outputDir: opts.outputDir }, opts.config)
  }
  process.exit(0)
}

const prefs = await loadPreferences(opts.config)
const systemPrompt = await loadSystemPrompt(opts.systemPrompt)

await chatStart({ apiKey, opts, prefs, systemPrompt })
