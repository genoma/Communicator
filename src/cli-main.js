import { ExitPromptError } from '@inquirer/core'
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from './config.js'
import { getProvider } from './providers/index.js'
import { ApiError, CliError, formatError } from './errors.js'
import { err, debug } from './ui/io.js'
import { listModelsCmd } from './commands/list-models.js'
import { listEndpointsCmd } from './commands/list-endpoints.js'
import { listSessionsCmd } from './commands/list-sessions.js'
import { exportCmd } from './commands/export-cmd.js'
import { oneShotCmd } from './commands/one-shot.js'
import { deleteCmd } from './commands/delete-cmd.js'
import { chatStart } from './commands/chat-start.js'
import { configViewCmd } from './commands/config-view.js'
import { configSetCmd } from './commands/config-set.js'
import { resolveSmoothSpeed } from './flags.js'
import { resolveFlagOrExit, fail } from './cli-utils.js'
import { isConfigSetter, validateCliFlags } from './cli-validation.js'

export async function runCli(opts, promptArg) {
  try {
    await main(opts, promptArg)
  } catch (error) {
    if (error instanceof ExitPromptError) {
      console.log('Aborted.')
      process.exit(0)
    }
    if (error instanceof ApiError) {
      debug(error.stack)
      err(`Error: ${formatError(error)}`)
      process.exit(1)
    }
    if (error instanceof CliError) {
      debug(error.stack)
      err(error.message)
      process.exit(error.exitCode)
    }
    debug(error?.stack)
    throw error
  }
}

async function main(opts, promptArg) {
  const providerType = opts.provider || 'openrouter'

  resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed)

  const validationErrors = validateCliFlags(opts, { promptArg, isTTY: process.stdin.isTTY })
  if (validationErrors.length > 0) {
    throw new CliError(validationErrors[0])
  }

  if (opts.config === true) {
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

  if (isConfigSetter(opts) && !promptArg && process.stdin.isTTY && opts.resume === undefined) {
    const prefs = await loadPreferences(opts.config)
    const apiKey = opts.model !== undefined ? getApiKey(providerType) : ''
    try {
      await configSetCmd({ opts, prefs, providerType, apiKey })
    } catch (err) {
      if (err instanceof CliError) throw err
      fail(`Error: ${formatError(err)}`)
    }
    process.exit(0)
  }

  if (!process.stdin.isTTY && !opts.model) {
    throw new CliError('Interactive selection needs a TTY. Use -m <model-id> when piping input.')
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
