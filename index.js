#!/usr/bin/env node

import { Command } from 'commander'
import { ExitPromptError } from '@inquirer/core'
import pkg from './package.json' with { type: 'json' }
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from './src/config.js'
import { getProvider } from './src/providers/index.js'
import { ApiError, formatError } from './src/errors.js'
import { listModelsCmd } from './src/commands/list-models.js'
import { listEndpointsCmd } from './src/commands/list-endpoints.js'
import { listSessionsCmd } from './src/commands/list-sessions.js'
import { exportCmd } from './src/commands/export-cmd.js'
import { oneShotCmd } from './src/commands/one-shot.js'
import { deleteCmd } from './src/commands/delete-cmd.js'
import { chatStart } from './src/commands/chat-start.js'
import { configViewCmd } from './src/commands/config-view.js'
import { configSetCmd } from './src/commands/config-set.js'
import { resolveSmoothSpeed } from './src/flags.js'
import { resolveFlagOrExit } from './src/cli-utils.js'

const program = new Command()

program
  .name('communicator')
  .description('AI CLI chat with interactive model & provider selection')
  .version(pkg.version)
  .argument('[prompt]', 'message to send in one-shot mode')
  .option('-m, --model <id>', 'skip all pickers, use this model ID directly')
  .option('-p, --provider <name>', 'AI provider backend: openrouter or venice', 'openrouter')
  .option('--list-models', 'list available models and exit')
  .option('--list-endpoints [model]', 'list providers/endpoints for a model (interactive picker when omitted)')
  .option('-r, --resume [session-id]', 'resume a saved session (optional session ID)')
  .option('-x, --export [session-id]', 'export a saved session as markdown')
  .option('--output-dir <path>', 'custom directory for exported markdown files (bare use saves it as the default)')
  .option('--list-sessions', 'list saved sessions and exit')
  .option('--config [path]', 'path to preferences config file (bare flag prints the current config)')
  .option('--system-prompt <path>', 'path to a custom system prompt file')
  .option('--reasoning-effort <level>', 'reasoning effort: max, xhigh, high, medium, low, minimal, none')
  .option('--temperature <0-2>', 'temperature override (0 to 2)')
  .option('--budget <usd>', 'per-session budget cap in USD')
  .option('--web-search [mode]', 'web search mode: auto, always, off (bare flag = auto; per-model default persisted)')
  .option('--web-results <n>', 'number of web search results (OpenRouter only, default 10)')
  .option('--no-smooth-streaming', 'disable smooth streaming (default: on in interactive sessions)')
  .option('--smooth-speed <level|cps>', 'smooth streaming speed: slow, normal, fast, or chars per second')
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
  if (error instanceof ApiError) {
    console.error(`Error: ${formatError(error)}`)
    process.exit(1)
  }
  throw error
}

async function main(opts) {
  const providerType = opts.provider || 'openrouter'
  const promptArg = program.args[0]
  const interactiveFlags = opts.resume !== undefined || opts.export !== undefined || opts.delete !== undefined
  const exitModeFlags = opts.listModels || opts.listEndpoints !== undefined || opts.listSessions

  const WEB_SEARCH_MODES = new Set(['auto', 'always', 'off'])
  if (opts.webSearch !== undefined && opts.webSearch !== true && !WEB_SEARCH_MODES.has(opts.webSearch)) {
    console.error('Error: --web-search expects "auto", "always", or "off" (bare flag = auto).')
    process.exit(1)
  }

  resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed)

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

  const sessionOnlyFlags =
    opts.temperature !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false ||
    opts.systemPrompt !== undefined

  if (exitModeFlags && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    console.error('Error: --model, --output-dir, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming) cannot be combined with --list-* flags.')
    process.exit(1)
  }

  if (opts.export !== undefined && (sessionOnlyFlags || opts.model !== undefined)) {
    console.error('Error: --model, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming) cannot be combined with --export.')
    process.exit(1)
  }

  if (opts.delete !== undefined && (sessionOnlyFlags || opts.model !== undefined || opts.outputDir !== undefined)) {
    console.error('Error: --model, --output-dir, --system-prompt and the session flags (--temperature, --budget, --reasoning-effort, --web-search, --web-results, --smooth-speed, --no-smooth-streaming) cannot be combined with --delete.')
    process.exit(1)
  }

  if (opts.resume !== undefined && (opts.model !== undefined || opts.outputDir !== undefined)) {
    console.error('Error: --model and --output-dir cannot be combined with --resume (resumed sessions keep their own model; --output-dir only applies to --export).')
    process.exit(1)
  }

  if (opts.outputDir !== undefined && opts.export === undefined && (promptArg || !process.stdin.isTTY)) {
    console.error('Error: --output-dir sets the default export directory. Use it alone (with a TTY) or with --export.')
    process.exit(1)
  }

  if (opts.config === true) {
    const hasOther =
      promptArg ||
      opts.model !== undefined ||
      opts.provider !== 'openrouter' ||
      opts.listModels ||
      opts.listEndpoints !== undefined ||
      opts.resume !== undefined ||
      opts.export !== undefined ||
      opts.outputDir !== undefined ||
      opts.listSessions ||
      opts.systemPrompt !== undefined ||
      opts.reasoningEffort !== undefined ||
      opts.temperature !== undefined ||
      opts.budget !== undefined ||
      opts.webSearch !== undefined ||
      opts.webResults !== undefined ||
      opts.smoothStreaming === false ||
      opts.smoothSpeed !== undefined ||
      opts.delete !== undefined
    if (hasOther) {
      console.error('Error: bare --config (config view) cannot be combined with other flags.')
      process.exit(1)
    }
    await configViewCmd()
    process.exit(0)
  }

  const provider = getProvider(providerType)
  const apiKeyOptional = process.env[provider.meta.apiKeyEnv]?.trim() || ''

  if (opts.listModels) {
    await listModelsCmd(provider, apiKeyOptional)
    process.exit(0)
  }

  if (opts.listEndpoints !== undefined) {
    const prefs = await loadPreferences(opts.config)
    await listEndpointsCmd(provider, apiKeyOptional, opts.listEndpoints, prefs)
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

  const configSetterFlags =
    opts.model !== undefined ||
    opts.outputDir !== undefined ||
    opts.temperature !== undefined ||
    opts.budget !== undefined ||
    opts.reasoningEffort !== undefined ||
    opts.webSearch !== undefined ||
    opts.webResults !== undefined ||
    opts.smoothSpeed !== undefined ||
    opts.smoothStreaming === false

  if (configSetterFlags && !promptArg && process.stdin.isTTY) {
    const prefs = await loadPreferences(opts.config)
    const apiKey = opts.model !== undefined ? getApiKey(providerType) : ''
    try {
      await configSetCmd({ opts, prefs, providerType, apiKey })
    } catch (err) {
      console.error(`Error: ${formatError(err)}`)
      process.exit(1)
    }
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
