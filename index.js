#!/usr/bin/env node

import { Command } from 'commander'
import { ExitPromptError } from '@inquirer/core'
import pkg from './package.json' with { type: 'json' }
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from './src/config.js'
import { getProvider } from './src/providers/index.js'
import { listModelsCmd } from './src/commands/list-models.js'
import { listEndpointsCmd } from './src/commands/list-endpoints.js'
import { listSessionsCmd } from './src/commands/list-sessions.js'
import { exportCmd } from './src/commands/export-cmd.js'
import { oneShotCmd } from './src/commands/one-shot.js'
import { deleteCmd } from './src/commands/delete-cmd.js'
import { chatStart } from './src/commands/chat-start.js'

const program = new Command()

program
  .name('communicator')
  .description('AI CLI chat with interactive model & provider selection')
  .version(pkg.version)
  .argument('[prompt]', 'message to send in one-shot mode')
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
  .option('--temperature <0-2>', 'temperature override (0 to 2)')
  .option('--budget <usd>', 'per-session budget cap in USD')
  .option('--web-search', 'enable web search for the session (per-model default persisted)')
  .option('--web-results <n>', 'number of web search results (OpenRouter only, default 10)')
  .option('--delete [session-id]', 'delete a saved session (with confirmation)')

program.parse()
const opts = program.opts()

try {
  await main(opts)
} catch (error) {
  if (error instanceof ExitPromptError) {
    console.log('Aborted.')
    process.exit(0)
  }
  throw error
}

async function main(opts) {
  const providerType = opts.provider || 'openrouter'
  const promptArg = program.args[0]
  const interactiveFlags = opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined
  const exitModeFlags = opts.listModels || opts.listEndpoints || opts.listSessions

  if (opts.resume !== undefined && opts.export !== undefined) {
    console.error('Cannot use --resume and --export together. Use one at a time.')
    process.exit(1)
  }

  if (opts.delete !== undefined && (opts.resume !== undefined || opts.export !== undefined)) {
    console.error('Cannot use --delete with --resume or --export. Use one at a time.')
    process.exit(1)
  }

  if (promptArg && (interactiveFlags || exitModeFlags)) {
    console.error('Cannot combine a prompt argument with --resume, --export, --delete, or --list-* flags.')
    process.exit(1)
  }

  if (!process.stdin.isTTY && interactiveFlags) {
    console.error('Cannot use --resume, --export, or --delete with piped stdin (interactive pickers need a TTY).')
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

  if (opts.delete !== undefined) {
    const partialId = typeof opts.delete === 'string' ? opts.delete : null
    await deleteCmd(partialId)
    process.exit(0)
  }

  if (!process.stdin.isTTY && !opts.model) {
    console.error('Interactive selection needs a TTY. Use -m <model-id> when piping input.')
    process.exit(1)
  }

  const apiKey = getApiKey(providerType)
  const prefs = await loadPreferences(opts.config)
  const systemPrompt = await loadSystemPrompt(opts.systemPrompt)

  if (promptArg || !process.stdin.isTTY) {
    await oneShotCmd({ apiKey, opts, prefs, systemPrompt, providerType, prompt: promptArg })
    process.exit(0)
  }

  await chatStart({ apiKey, opts, prefs, systemPrompt, providerType })
}
