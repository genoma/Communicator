#!/usr/bin/env node

import { Command } from 'commander'
import pkg from './package.json' with { type: 'json' }
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from './src/config.js'
import { getProvider } from './src/providers/index.js'
import { listModelsCmd } from './src/commands/list-models.js'
import { listEndpointsCmd } from './src/commands/list-endpoints.js'
import { listSessionsCmd } from './src/commands/list-sessions.js'
import { exportCmd } from './src/commands/export-cmd.js'
import { chatStart } from './src/commands/chat-start.js'

const program = new Command()

program
  .name('communicator')
  .description('AI CLI chat with interactive model & provider selection')
  .version(pkg.version)
  .option('-m, --model <id>', 'skip all pickers, use this model ID directly')
  .option('-p, --provider <name>', 'AI provider backend: openrouter or venice', 'openrouter')
  .option('--list-models', 'list available models and exit')
  .option('--list-endpoints <model>', 'list providers/endpoints for a model and exit')
  .option('-r, --resume [session-id]', 'resume a saved session (optional session ID)')
  .option('-x, --export [session-id]', 'export a saved session as markdown')
  .option('--output-dir <path>', 'custom directory for exported markdown files')
  .option('--list-sessions', 'list saved sessions and exit')
  .option('--config <path>', 'path to preferences config file')
  .option('--system-prompt <path>', 'path to a custom system prompt file')
  .option('--reasoning-effort <level>', 'reasoning effort: max, xhigh, high, medium, low, minimal, none')
  .option('--no-reasoning', 'disable reasoning entirely')

program.parse()
const opts = program.opts()

const providerType = opts.provider || 'openrouter'

if (opts.resume !== undefined && opts.export !== undefined) {
  console.error('Cannot use --resume and --export together. Use one at a time.')
  process.exit(1)
}

const provider = getProvider(providerType)
const apiKeyOptional = process.env[provider.meta.apiKeyEnv]?.trim() || ''

if (opts.listModels) {
  await listModelsCmd(provider, apiKeyOptional)
  process.exit(0)
}

if (opts.listEndpoints) {
  await listEndpointsCmd(provider, apiKeyOptional, opts.listEndpoints)
  process.exit(0)
}

if (opts.listSessions) {
  await listSessionsCmd()
  process.exit(0)
}

if (opts.export !== undefined) {
  const prefs = await loadPreferences(opts.config)
  const outputDir = opts.outputDir || prefs.outputDir || null
  const partialId = typeof opts.export === 'string' ? opts.export : null
  await exportCmd(partialId, outputDir)
  if (opts.outputDir && opts.outputDir !== prefs.outputDir) {
    await savePreferences({ ...prefs, outputDir: opts.outputDir }, opts.config)
  }
  process.exit(0)
}

const apiKey = getApiKey(providerType)
const prefs = await loadPreferences(opts.config)
const systemPrompt = await loadSystemPrompt(opts.systemPrompt)

await chatStart({ apiKey, opts, prefs, systemPrompt, providerType })
