import { getApiKey, loadPreferences, mergeImageDefaults, loadSystemPrompt, savePreferences } from './config.js'
import { E2EE_AT_REST_WARNING } from './constants.js'
import { getProvider } from './providers/index.js'
import { ApiError, CliError, formatError, isExitPromptError } from './errors.js'
import { sanitizeAnsi } from './ui/hyperlink.js'
import { err, debug } from './ui/io.js'
import { resolveSmoothSpeed, resolveTemperatureFlag, resolveTopPFlag, resolveBudget, resolveWebResultsFlag, resolveReasoningFlag, resolveAspectRatio, resolveImageFormat } from './flags.js'
import { resolveFlagOrExit, fail } from './cli-utils.js'
import { isConfigSetDispatch, validateCliFlags } from './cli-validation.js'
import { parseScrapeUrl, scrapeContext } from './scrape.js'
import { seedModelFetch } from './model-selection.js'
import { loadRpgContext, rpgSessionsDir } from './rpg.js'

// Command modules are loaded lazily at their dispatch points: markdown-it and
// the inquirer pickers live behind one-shot/image/list/export/delete/config
// commands, and lazy imports keep that whole graph (roughly two thirds of a
// cold start) out of exit-mode invocations like --version or --list-sessions.
// chat-start (interactive chat) is the same pattern.

function assertScrapeCapability(provider) {
  if (typeof provider.scrapePage !== 'function') {
    throw new CliError(`Error: --scrape is not supported by provider ${provider.meta.name}.`)
  }
}

// Fetches a page via the Venice web scraping API and normalizes it for
// injection into the session context (validated http(s) URL, truncated to
// MAX_SCRAPE_CHARS). One flat $0.01 per page, tracked by the session.
async function scrapeForSession({ provider, apiKey, url }) {
  if (!parseScrapeUrl(url)) {
    throw new CliError('Error: --scrape expects a valid http(s) URL.')
  }
  assertScrapeCapability(provider)
  const result = await provider.scrapePage({ apiKey, url })
  const { text, sizeLabel } = scrapeContext(result.content)
  // Piped stdout carries the answer alone: a notice there would pollute the
  // stream for `communicator -m <model> "..." > file`.
  const notice = `Scraped ${url} (${sizeLabel}) into context.`
  if (process.stdout.isTTY === true) console.log(notice)
  else console.error(notice)
  return { url, content: text }
}

export async function runCli(opts, promptArg) {
  try {
    await main(opts, promptArg)
  } catch (error) {
    if (isExitPromptError(error)) {
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
      // CliError messages interpolate provider- and user-supplied fragments
      // (model ids, file names, URLs). Every other error sink sanitizes;
      // this one is the CLI's last write before exit.
      err(sanitizeAnsi(error.message))
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
  resolveFlagOrExit(resolveTopPFlag, { topP: opts.topP })
  resolveFlagOrExit(resolveBudget, opts.budget)
  resolveFlagOrExit(resolveWebResultsFlag, { webResults: opts.webResults })
  resolveFlagOrExit((value) => resolveReasoningFlag({ reasoningEffort: value }), opts.reasoningEffort)

  const validationErrors = validateCliFlags(opts, { promptArg, isTTY: process.stdin.isTTY })
  if (validationErrors.length > 0) {
    throw new CliError(validationErrors[0])
  }

  // The image-default flags are resolved here — after flag validation, whose
  // errors keep precedence, and before the billed scrape or any prefs write —
  // so a bad or empty value fails for free and the persist/notice block below
  // works on resolved values only.
  const aspectRatio = resolveFlagOrExit(resolveAspectRatio, opts.aspectRatio)
  const imageFormat = resolveFlagOrExit(resolveImageFormat, opts.imageFormat)

  let rpgContext = null
  let rpgResume = null
  // Notices and warnings about the run that is about to start are held back
  // until the resolved-provider guard below has accepted it: a refused run
  // must not announce a resume (or warn about session storage) that never
  // happens — the F8/F11 "notice before a rejected dispatch" shape.
  const rpgNotices = []
  const rpgWarnings = []
  // Warnings go to stderr; notices follow the stdout-is-TTY gate so a piped
  // one-shot's stdout stays pure content.
  const printRpgOutput = () => {
    for (const line of rpgWarnings) console.warn(line)
    for (const line of rpgNotices) {
      if (process.stdout.isTTY === true) console.log(line)
      else console.error(line)
    }
  }
  if (opts.rpg !== undefined) {
    rpgContext = await loadRpgContext(opts.rpg)
    if (opts.e2ee === true) {
      const localFiles = opts.debug === true ? 'the chapter session, prompt-log.jsonl and any legacy history.json' : 'the chapter session and any legacy history.json'
      rpgWarnings.push(`Warning: --e2ee encrypts messages sent to the API, but RPG ${localFiles} store them unencrypted.`)
    }
    if (rpgContext.created) {
      console.log(`RPG mode setup: created ${rpgContext.createdFiles.join(', ')} in ${rpgContext.dir}`)
      console.log('Fill in the story files, delete the HTML comment at the top of each, then rerun with the same --rpg directory. post-history-instruction.md starts empty and is optional — leave it empty to skip it.')
      process.exit(0)
    }
    // A story dir that only holds the legacy history.json log gets it
    // imported once as chapter #1; afterwards history.json is read-only
    // (and no longer written), and every run saves one chapter session.
    const { importLegacyRpgHistory } = await import('./rpg.js')
    const migrated = await importLegacyRpgHistory({
      rpgDir: rpgContext.dir,
      history: rpgContext.history,
      historyUpdatedAt: rpgContext.historyUpdatedAt,
      model: opts.model,
      providerType,
      e2ee: opts.e2ee === true,
      charName: rpgContext.charName,
      userName: rpgContext.userName,
      firstMessage: rpgContext.firstMessage,
    })
    if (migrated) {
      const notice = `Migrated the saved story (${migrated.messages} messages) into ${rpgContext.dir}/sessions/${migrated.sessionId}.json; history.json is no longer written.`
      if (process.stdout.isTTY === true) console.log(notice)
      else console.error(notice)
    }
    // A bare --resume (no session id) is the only way to continue a story;
    // without it the same directory starts a brand-new one.
    if (opts.resume === true) {
      // Chapter sessions take precedence over the legacy history.json: the
      // only chapter resumes directly, more than one opens the same picker
      // a normal -r uses (piped one-shots fall back to the most recent
      // chapter), and no chapters yet falls back to the history.json story.
      const { resolveRpgResume } = await import('./commands/rpg-resume.js')
      rpgResume = await resolveRpgResume(rpgContext.dir)
      if (rpgResume) {
        const saved = rpgResume.sessionUpdatedAt ? `, saved ${new Date(rpgResume.sessionUpdatedAt).toISOString().slice(0, 10)}` : ''
        rpgNotices.push(`Resumed RPG conversation from ${rpgContext.dir}/sessions/${rpgResume.sessionId}.json (${rpgResume.turns.length} messages${saved}).`)
      } else if (rpgContext.history?.length > 0) {
        const saved = rpgContext.historyUpdatedAt ? `, saved ${new Date(rpgContext.historyUpdatedAt).toISOString().slice(0, 10)}` : ''
        rpgNotices.push(`Resumed RPG conversation from ${rpgContext.dir}/history.json (${rpgContext.history.length} messages${saved}).`)
      }
    } else {
      // Every run saves its own chapter session under <dir>/sessions/, so a
      // fresh start never destroys an earlier one. Count what is available to
      // resume: chapter sessions take precedence, and a legacy dir that only
      // has history.json still has one earlier story.
      // Piped stdout must stay pure content (one-shot): send the notice to
      // stderr there, like the artifact lines do.
      const { listSessions } = await import('./sessions.js')
      const chapters = await listSessions(rpgSessionsDir(rpgContext.dir))
      const available = chapters.length > 0 ? chapters.length : (rpgContext.history?.length > 0 ? 1 : 0)
      if (available > 0) {
        rpgNotices.push(`Starting a new story in ${rpgContext.dir} (${available} earlier session${available === 1 ? '' : 's'} available; use --rpg ${rpgContext.dir} --resume to continue one).`)
      }
      // A fresh RPG run has no provider guard to wait for.
      printRpgOutput()
    }
  } else if (opts.e2ee === true && opts.resume === undefined) {
    // Plain --e2ee chats persist their transcript to the sessions dir just
    // like any other session; encryption only covers the messages sent to
    // the API, so the on-disk copy must not surprise the user. A resume waits
    // for the resolved provider (src/commands/chat-start.js), which may
    // refuse the run outright.
    console.warn(E2EE_AT_REST_WARNING)
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
    const exportFormat = opts.exportFormat || 'markdown'
    const { exportCmd } = await import('./commands/export-cmd.js')
    await exportCmd(partialId, outputDir, exportFormat)
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
  const configSetRun = isConfigSetDispatch(opts, { promptArg, isTTY: process.stdin.isTTY })
  if (configSetRun && process.stdin.isTTY) {
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

  if (configSetRun && !process.stdin.isTTY) {
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
    // --no-safe-mode persists as a global Venice setting in every launch
    // path (chat, one-shot, image), per its documented behavior; the image
    // path exits before the shared notice below, so say it here.
    if (opts.safeMode === false) {
      prefs.safeMode = false
      try {
        await savePreferences(prefs, opts.config)
      } catch (err) {
        fail(`Error: could not save the safe mode preference: ${err.message}`)
      }
      if (process.stdout.isTTY === true) console.log('Venice safe mode disabled')
      else console.error('Venice safe mode disabled')
    }
    // --no-watermark is the same global-preference shape as --no-safe-mode:
    // its image-run writer persists only after a successful generation, so
    // save it (and announce it) before the run like safe mode does.
    if (opts.watermark === false) {
      prefs.hideWatermark = true
      try {
        await savePreferences(prefs, opts.config)
      } catch (err) {
        fail(`Error: could not save the watermark preference: ${err.message}`)
      }
      if (process.stdout.isTTY === true) console.log('Venice watermark disabled')
      else console.error('Venice watermark disabled')
    }
    const { imageGenCmd } = await import('./commands/image-gen.js')
    await imageGenCmd({ apiKey, opts, prefs, providerType, prompt: promptArg })
    process.exit(0)
  }

  // A piped run without -m normally needs a TTY for model selection; a
  // resumed RPG chapter carries its own model, so it is exempt.
  if (!process.stdin.isTTY && !opts.model && !rpgResume) {
    throw new CliError('Interactive selection needs a TTY. Use -m <model-id> when piping input.')
  }

  // A resumed session brings its own provider, so the key must follow it (the
  // run's default provider is only for fresh runs): an RPG chapter carries it
  // in rpgResume, and a plain --resume resolves it in chat-start once the
  // session loads — demanding the flag's provider key here would fail a run
  // that never uses it. Only --rpg --resume with nothing saved to resume still
  // takes the fresh-run branch, which does need the flag's key.
  const resumesSession = opts.resume !== undefined && (opts.rpg === undefined || rpgResume)
  const prefs = await loadPreferences(opts.config)

  // An RPG resume executes on the chapter's saved provider, or on the flag's
  // when there is no chapter to resume (a legacy history.json story is a fresh
  // run). Validation defers the provider-only gates to that resolved provider,
  // so they are answered here — before the key lookup, the billed scrape and
  // the --no-safe-mode persist, none of which a refused run should reach.
  if (opts.rpg !== undefined && opts.resume !== undefined) {
    const { assertResolvedProviderFlags, assertResumeFlags, resolveSessionFlags } = await import('./session-setup.js')
    const { zdr, e2ee, forcedWebResults } = resolveSessionFlags(opts, prefs)
    const providerName = (rpgResume ? getProvider(rpgResume.providerType ?? providerType) : provider).meta.name
    // A chapter is also matched against the run's --e2ee.
    if (rpgResume) assertResumeFlags({ result: rpgResume, providerName, zdr, e2ee, forcedWebResults })
    else assertResolvedProviderFlags({ providerName, zdr, e2ee, forcedWebResults })
  }

  // Accepted: a resumed RPG run announces itself only now (its notes were held
  // back so a refused resume stays silent). Fresh runs already printed theirs.
  if (opts.rpg !== undefined && opts.resume === true) printRpgOutput()

  const scrapeProvider = opts.scrape !== undefined
    ? (rpgResume ? getProvider(rpgResume.providerType ?? providerType) : provider)
    : null
  // The provider limitation must beat the key error, like the --zdr/--e2ee
  // guards above (F17): a missing key is not the reason the run cannot scrape.
  if (scrapeProvider) assertScrapeCapability(scrapeProvider)

  const apiKey = rpgResume
    ? getApiKey(rpgResume.providerType ?? providerType)
    : resumesSession ? '' : getApiKey(providerType)
  const systemPrompt = rpgContext?.systemPrompt ?? await loadSystemPrompt(opts.systemPrompt)
  const rpgFirstMessage = rpgContext?.firstMessage ?? null
  const rpgCharName = rpgContext?.charName ?? null
  const rpgUserName = rpgContext?.userName ?? null
  const rpgHistory = opts.rpg !== undefined && opts.resume === true ? (rpgResume?.turns ?? rpgContext?.history ?? null) : null
  const rpgPostHistoryInstruction = rpgContext?.postHistoryInstruction ?? null

  const scraped = opts.scrape !== undefined
    ? await scrapeForSession({ provider: scrapeProvider, apiKey, url: opts.scrape })
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
    if (process.stdout.isTTY === true) console.log('Venice safe mode disabled')
    else console.error('Venice safe mode disabled')
  }

  // --no-watermark is the same global-preference shape and follows the same
  // rule on every other launch path; the image branch saves and announces it
  // itself and has already exited above.
  if (opts.watermark === false) {
    prefs.hideWatermark = true
    try {
      await savePreferences(prefs, opts.config)
    } catch (err) {
      fail(`Error: could not save the watermark preference: ${err.message}`)
    }
    if (process.stdout.isTTY === true) console.log('Venice watermark disabled')
    else console.error('Venice watermark disabled')
  }

  // --aspect-ratio/--image-format keep their documented setter meaning next to
  // a chat run: the set-and-exit dispatch (their other writer) is not reached,
  // so persist them here instead of dropping the flags.
  if (aspectRatio !== undefined || imageFormat !== undefined) {
    const merged = mergeImageDefaults(prefs, providerType, { aspectRatio, format: imageFormat })
    prefs.imageDefaults = merged.imageDefaults
    try {
      await savePreferences(prefs, opts.config)
    } catch (err) {
      fail(`Error: could not save the image defaults preference: ${err.message}`)
    }
    if (aspectRatio !== undefined) {
      const notice = `Aspect ratio set to ${aspectRatio} (${providerType} image defaults)`
      if (process.stdout.isTTY === true) console.log(notice)
      else console.error(notice)
    }
    if (imageFormat !== undefined) {
      const notice = `Image format set to ${imageFormat} (${providerType} image defaults)`
      if (process.stdout.isTTY === true) console.log(notice)
      else console.error(notice)
    }
  }

  if (promptArg || !process.stdin.isTTY) {
    const { oneShotCmd } = await import('./commands/one-shot.js')
    await oneShotCmd({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage, rpgHistory, rpgPostHistoryInstruction, rpgCharName, rpgUserName, providerType, prompt: promptArg, scraped, rpgResume })
    process.exit(0)
  }

  // chat-start pulls in the streaming renderer, markdown-it and the
  // inquirer pickers; loaded only for interactive chat. The model listing is
  // started BEFORE the import so its network round-trip overlaps the module
  // load instead of serializing behind it. A resume loads its model from the
  // session file, so the seeding (and its response) would be wasted there.
  const modelsPromise = opts.resume === undefined
    ? seedModelFetch({ provider: getProvider(providerType), apiKey, zdr: opts.zdr === true })
    : null
  const { chatStart } = await import('./commands/chat-start.js')
  await chatStart({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage, rpgCharName, rpgUserName, rpgHistory, rpgPostHistoryInstruction, providerType, scraped, modelsPromise, rpgResume })
}
