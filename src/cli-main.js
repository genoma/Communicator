import { ExitPromptError } from '@inquirer/core'
import { getApiKey, loadPreferences, loadSystemPrompt, savePreferences } from './config.js'
import { getProvider } from './providers/index.js'
import { ApiError, CliError, formatError } from './errors.js'
import { err, debug } from './ui/io.js'
import { resolveSmoothSpeed, resolveTemperatureFlag, resolveBudget, resolveWebResultsFlag, resolveReasoningFlag } from './flags.js'
import { resolveFlagOrExit, fail } from './cli-utils.js'
import { isConfigSetter, isPureConfigSetter, hasConfigSetterFlags, validateCliFlags } from './cli-validation.js'
import { scrapeContext } from './scrape.js'
import { loadRpgContext } from './rpg.js'

// Command modules are loaded lazily at their dispatch points: markdown-it and
// the inquirer pickers live behind one-shot/image/list/export/delete/config
// commands, and lazy imports keep that whole graph (roughly two thirds of a
// cold start) out of exit-mode invocations like --version or --list-sessions.
// chat-start (interactive chat) is the same pattern.

// Fetches a page via the Venice web scraping API and normalizes it for
// injection into the session context (validated http(s) URL, truncated to
// MAX_SCRAPE_CHARS). One flat $0.01 per page, tracked by the session.
async function scrapeForSession({ provider, apiKey, url }) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new CliError('Error: --scrape expects a valid http(s) URL.')
  }
  if (typeof provider.scrapePage !== 'function') {
    throw new CliError(`Error: --scrape is not supported by provider ${provider.meta.name}.`)
  }
  const result = await provider.scrapePage({ apiKey, url })
  const { text, sizeLabel } = scrapeContext(url, result.content)
  console.log(`Scraped ${url} (${sizeLabel}) into context.`)
  return { url, content: text }
}

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

  // Numeric session flags are validated up front so an invalid value errors
  // with its own message regardless of the dispatch path (exit modes, image
  // runs, non-TTY invocations). Every chat/config path re-resolves them.
  resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed)
  resolveFlagOrExit(resolveTemperatureFlag, { temperature: opts.temperature })
  resolveFlagOrExit(resolveBudget, opts.budget)
  resolveFlagOrExit(resolveWebResultsFlag, { webResults: opts.webResults })
  resolveFlagOrExit((value) => resolveReasoningFlag({ reasoningEffort: value }), opts.reasoningEffort)

  const validationErrors = validateCliFlags(opts, { promptArg, isTTY: process.stdin.isTTY })
  if (validationErrors.length > 0) {
    throw new CliError(validationErrors[0])
  }

  let rpgContext = null
  if (opts.rpg !== undefined) {
    rpgContext = await loadRpgContext(opts.rpg)
    if (rpgContext.created) {
      console.log(`RPG mode setup: created ${rpgContext.createdFiles.join(', ')} in ${rpgContext.dir}`)
      console.log('Fill in each file, delete the HTML comment at the top, then rerun with the same --rpg directory.')
      process.exit(0)
    }
    if (rpgContext.history?.length > 0) {
      console.log(`Resumed RPG conversation from ${rpgContext.dir}/history.json (${rpgContext.history.length} messages).`)
    }
  }

  if (opts.config === true) {
    const { configViewCmd } = await import('./commands/config-view.js')
    await configViewCmd()
    process.exit(0)
  }

  const provider = getProvider(providerType)
  const apiKeyOptional = process.env[provider.meta.apiKeyEnv]?.trim() || ''

  if (opts.listImageModels) {
    if (typeof provider.fetchImageModels !== 'function') {
      throw new CliError(`Error: --list-image-models is not supported by provider ${providerType}.`)
    }
    const { listImageModelsCmd } = await import('./commands/list-models.js')
    await listImageModelsCmd(provider, apiKeyOptional)
    process.exit(0)
  }

  if (opts.listModels) {
    const { listModelsCmd } = await import('./commands/list-models.js')
    await listModelsCmd(provider, apiKeyOptional)
    process.exit(0)
  }

  if (opts.listEndpoints !== undefined) {
    const prefs = await loadPreferences(opts.config)
    const { listEndpointsCmd } = await import('./commands/list-endpoints.js')
    await listEndpointsCmd(provider, apiKeyOptional, opts.listEndpoints, prefs)
    process.exit(0)
  }

  if (opts.listSessions) {
    const { listSessionsCmd } = await import('./commands/list-sessions.js')
    await listSessionsCmd()
    process.exit(0)
  }

  if (opts.export !== undefined) {
    const prefs = await loadPreferences(opts.config)
    const outputDir = opts.outputDir || prefs.outputDir || null
    const partialId = typeof opts.export === 'string' ? opts.export : null
    const { exportCmd } = await import('./commands/export-cmd.js')
    await exportCmd(partialId, outputDir)
    if (opts.outputDir && opts.outputDir !== prefs.outputDir) {
      try {
        await savePreferences({ ...prefs, outputDir: opts.outputDir }, opts.config)
      } catch (err) {
        fail(`Error: could not save the output directory preference: ${err.message}`)
      }
    }
    process.exit(0)
  }

  if (opts.delete !== undefined) {
    const partialId = typeof opts.delete === 'string' ? opts.delete : null
    const { deleteCmd } = await import('./commands/delete-cmd.js')
    await deleteCmd(partialId)
    process.exit(0)
  }

  if (opts.deleteAllSessions !== undefined) {
    const { deleteAllSessionsCmd } = await import('./commands/delete-all-cmd.js')
    await deleteAllSessionsCmd(opts.deleteAllSessions)
    process.exit(0)
  }

  // --no-safe-mode alone is a chat-launch flag: it flows into the chat path,
  // which persists the pref; combined with other config-setter flags it keeps
  // the save-and-exit config-set behavior.
  const onlySafeModeSetter = opts.safeMode === false && !hasConfigSetterFlags(opts)
  if (isConfigSetter(opts) && !onlySafeModeSetter && opts.rpg === undefined && !promptArg && process.stdin.isTTY && opts.resume === undefined && opts.image !== true) {
    const prefs = await loadPreferences(opts.config)
    const apiKey = opts.model !== undefined ? getApiKey(providerType) : ''
    try {
      const { configSetCmd } = await import('./commands/config-set.js')
      await configSetCmd({ opts, prefs, providerType, apiKey })
    } catch (err) {
      if (err instanceof CliError) throw err
      fail(`Error: ${formatError(err)}`)
    }
    process.exit(0)
  }

  // Pure config-setter flags have no session meaning, so piped stdin can
  // never be a prompt for them: run the config-set path without a TTY.
  // Excluded with -m, where piped stdin means one-shot.
  if (!promptArg && !process.stdin.isTTY && opts.model === undefined && opts.resume === undefined && opts.image !== true && isPureConfigSetter(opts)) {
    const prefs = await loadPreferences(opts.config)
    try {
      const { configSetCmd } = await import('./commands/config-set.js')
      await configSetCmd({ opts, prefs, providerType, apiKey: '' })
    } catch (err) {
      if (err instanceof CliError) throw err
      fail(`Error: ${formatError(err)}`)
    }
    process.exit(0)
  }

  if (opts.image) {
    if (typeof provider.fetchImageModels !== 'function') {
      throw new CliError(`Error: --image is not supported by provider ${providerType}.`)
    }
    const apiKey = getApiKey(providerType)
    const prefs = await loadPreferences(opts.config)
    const { imageGenCmd } = await import('./commands/image-gen.js')
    await imageGenCmd({ apiKey, opts, prefs, providerType, prompt: promptArg })
    process.exit(0)
  }

  if (!process.stdin.isTTY && !opts.model) {
    throw new CliError('Interactive selection needs a TTY. Use -m <model-id> when piping input.')
  }

  const apiKey = getApiKey(providerType)
  const prefs = await loadPreferences(opts.config)
  const systemPrompt = rpgContext?.systemPrompt ?? await loadSystemPrompt(opts.systemPrompt)
  const rpgFirstMessage = rpgContext?.firstMessage ?? null
  const rpgHistory = rpgContext?.history ?? null

  const scraped = opts.scrape !== undefined
    ? await scrapeForSession({ provider, apiKey, url: opts.scrape })
    : null

  // --no-safe-mode persists as a global Venice setting in every launch path
  // (interactive chat, one-shot, piped stdin), per its documented behavior.
  if (opts.safeMode === false) {
    prefs.safeMode = false
    try {
      await savePreferences(prefs, opts.config)
    } catch (err) {
      fail(`Error: could not save the safe mode preference: ${err.message}`)
    }
    console.log('Venice safe mode disabled')
  }

  if (promptArg || !process.stdin.isTTY) {
    const { oneShotCmd } = await import('./commands/one-shot.js')
    await oneShotCmd({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage, rpgHistory, providerType, prompt: promptArg, scraped })
    process.exit(0)
  }

  // chat-start pulls in the streaming renderer, markdown-it and the
  // inquirer pickers; loaded only for interactive chat.
  const { chatStart } = await import('./commands/chat-start.js')
  await chatStart({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage, rpgHistory, providerType, scraped })
}
