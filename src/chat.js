import { UsageTracker, contextSegment } from './tracker.js'
import { cpsToCharsPerTick, SCRAPE_COST_USD, DEFAULT_SYSTEM_PROMPT, SESSIONS_DIR } from './constants.js'
import { buildStatusBadges, connectedBanner } from './status-line.js'
import { sessionLabel } from './ui/format.js'
import { chatCommands, budgetGuard, commandAcceptsArgs, visibleChatCommands } from './commands/chat/index.js'
import { buildContent } from './attachments.js'
import { readInput as defaultReadInput } from './input.js'
import { createStreamRenderer, renderHistory } from './ui/stream.js'
import { createLoader } from './ui/loader.js'
import { dim, sep } from './ui/style.js'
import { out } from './ui/io.js'
import { ensureSessionsDir, generateSessionId, persistSessionFile, buildSessionPayload, removeEmptySessionClaim } from './sessions.js'
import { savePreferences, applyPreferenceUpdates, savePrefsBestEffort } from './config.js'
import { copyText } from './clipboard.js'
import { ChatState } from './chat-state.js'
import { createE2eeSession } from './e2ee.js'
import { CliError, formatError, commandErrorLine } from './errors.js'
import { registerSignalHandlers } from './signals.js'
import { createSessionState, createTurnRunner } from './turn-runner.js'
import { ExitPromptError } from '@inquirer/core'

export async function runChatSession(ctx = {}, deps = {}) {
  const {
    apiKey,
    model,
    endpointProviderName,
    reasoningEffort,
    temperature,
    pricing,
    contextLength = null,
    provider,
    systemPrompt = null,
    initialMessages = null,
    sessionId = null,
    createdAt = null,
    supportsReasoning = true,
    modelReasoning = null,
    budget = null,
    webSearch = 'off',
    webResults = null,
    zdr = false,
    e2ee = false,
    webSearchSupported = undefined,
    visionSupported = undefined,
    fileSupported = undefined,
    imageOutputSupported = undefined,
    smoothStreaming = true,
    smoothSpeed,
    scrapes = 0,
    prefs = {},
    configPath = null,
  } = ctx

  const {
    readInput = defaultReadInput,
    renderer = createStreamRenderer,
    stdout = process.stdout,
    exit = (code) => process.exit(code),
    onSignal = registerSignalHandlers,
  } = deps

  const saveSessionFile = deps.saveSession ?? persistSessionFile

  const savePrefsFile = deps.savePrefs ?? (async (updates) => {
    await savePreferences(applyPreferenceUpdates(prefs, updates), configPath)
  })

  const newSessionId = deps.newSessionId ?? (async () => {
    const dir = await ensureSessionsDir()
    return generateSessionId(dir)
  })

  const systemContent = systemPrompt || DEFAULT_SYSTEM_PROMPT

  // An E2EE session needs its own client key pair plus the attested model
  // public key before the first turn. Any attestation failure aborts the
  // session: never fall back to sending plaintext when --e2ee was requested.
  const e2eeContext = e2ee === true
    ? await createE2eeSession({ apiKey, modelId: model }).catch((err) => {
        throw new CliError(`Error: ${formatError(err)}`)
      })
    : null

  const state = new ChatState({
    modelId: model,
    endpointProviderName,
    reasoningEffort,
    temperature,
    budget,
    pricing,
    contextLength,
    supportsReasoning,
    webSearch,
    webResults,
    zdr,
    e2ee,
    e2eeContext,
    webSearchSupported,
    visionSupported,
    fileSupported,
    imageOutputSupported,
    smoothStreaming,
    smoothSpeed,
    sessionId,
    createdAt,
    modelReasoning,
    messages: initialMessages || undefined,
    systemContent,
    scrapes,
  })

  const sessionState = createSessionState()

  let lastUsage = null
  if (initialMessages) {
    for (const msg of initialMessages) {
      if (msg.role === 'assistant' && msg.usage) {
        sessionState.tracker.record(msg.usage, pricing)
        lastUsage = msg.usage
      }
    }
  }

  // Flat-fee scrapes are not token usage: a launch-time --scrape and resumed
  // sessions both carry the count on state, so seed it here exactly once
  // (interactive /scrape calls add cost live and increment the counter).
  if (state.scrapes > 0) {
    sessionState.tracker.addScrapeCost(SCRAPE_COST_USD * state.scrapes, state.scrapes)
  }

  const label = sessionLabel(endpointProviderName, model)
  const hintParts = []
  if (state.visionSupported !== false && !state.e2ee) hintParts.push('/attach <path> to queue files')
  hintParts.push('/quit to exit')
  out(connectedBanner(label, { badges: buildStatusBadges(state), hints: hintParts }))

  if (initialMessages) {
    renderHistory(state.messages, { markdown: state.markdown, stdout })
  }

  if (initialMessages && sessionState.tracker.requests > 0) {
    let summary = sessionState.tracker.summary()
    if (lastUsage) {
      const hit = lastUsage.cacheHit || (lastUsage.prompt_tokens_details?.cached_tokens ?? 0) > 0
      const ctx = contextSegment(sessionState.tracker.peakContext, state.contextLength, hit)
      if (ctx) summary += `  |  ${ctx}`
    }
    console.log(`${dim('Previous session:')} ${summary}\n`)
  }

  const tty = stdout.isTTY === true

  const render = renderer({ markdown: state.markdown, stdout, smooth: tty && state.smoothStreaming, smoothCharsPerTick: cpsToCharsPerTick(state.smoothSpeed) })
  const loader = createLoader({ stdout })

  const saveCurrentSession = async () => {
    if (!state.sessionId) return
    if (state.messages.length <= 1) {
      // Nothing worth saving: drop the empty claim file generateSessionId
      // created so it does not linger on disk.
      await removeEmptySessionClaim(SESSIONS_DIR, state.sessionId)
      return
    }
    try {
      await saveSessionFile(state.sessionId, buildSessionPayload(state.toFinalState(provider.meta.name)))
    } catch {
      // save failures are non-fatal
    }
  }

  // prefs save failures are non-fatal (shared wrapper, same warning wording
  // as the other persistence paths)
  const savePrefs = savePrefsBestEffort((updates) => savePrefsFile(updates))

  let exitSaveDone = false
  let exitSavePromise = null
  const bestEffortSave = async () => {
    if (exitSaveDone) return
    exitSaveDone = true
    await saveCurrentSession()
  }

  const bestEffortExitSave = async () => {
    if (exitSaveDone) return
    exitSaveDone = true
    const finalState = state.toFinalState(provider.meta.name)
    await Promise.all([
      saveCurrentSession(),
      savePrefs({
        modelId: finalState.modelId,
        lastModel: finalState.modelId,
        lastProvider: finalState.endpointProviderName,
        reasoningEffort: finalState.reasoningEffort,
        temperature: finalState.temperature,
        webSearch: finalState.webSearch,
        webResults: finalState.webResults,
      }),
    ])
  }

  const cleanupSignals = onSignal({
    sigint: () => {
      if (sessionState.streaming) {
        sessionState.interrupted = true
        sessionState.streamController?.abort()
        return
      }
      // A second Ctrl+C while the exit save is in flight must not call
      // exit(130) early and truncate the write; the first press chains the
      // exit onto the save, so repeat presses are no-ops.
      exitSavePromise ??= bestEffortExitSave().finally(() => exit(130))
    },
    beforeExit: () => {
      void bestEffortSave()
    },
    uncaughtException: (err) => {
      console.error(`\nUnhandled error: ${err?.message || err}`)
      void bestEffortSave().finally(() => exit(1))
    },
  })

  const exitCleanly = async () => {
    cleanupSignals()
    stdout.write('\n')
    await bestEffortSave()
    return state.toFinalState(provider.meta.name)
  }

  const runner = createTurnRunner({
    state,
    provider,
    apiKey,
    render,
    loader,
    stdout,
    tty,
    saveCurrentSession,
    interruptSave: bestEffortExitSave,
    exit,
    sessionState,
  })
  const runTurn = runner.runTurn

  const chatCtx = {
    state,
    provider,
    apiKey,
    prefs,
    systemContent,
    saveSession: saveCurrentSession,
    savePrefs,
    runTurn,
    render,
    newSessionId,
    copyText,
    stdout,
    exit: exitCleanly,
  }
  Object.defineProperty(chatCtx, 'tracker', { get: () => sessionState.tracker, enumerable: true })

  while (true) {
    console.log(sep())
    const result = await readInput({ commands: visibleChatCommands({ visionSupported: state.visionSupported, e2ee: state.e2ee, providerName: provider.meta.name }) })

    if (result.cancelled) {
      return exitCleanly()
    }

    const input = result.value.trim()
    if (!input) continue

    if (input.startsWith('/')) {
      const lines = input.split('\n')
      const firstLine = lines[0]
      const spaceIdx = firstLine.indexOf(' ')
      const cmd = spaceIdx === -1 ? firstLine : firstLine.slice(0, spaceIdx)
      const handler = chatCommands[cmd]
      if (!handler || (spaceIdx !== -1 && !commandAcceptsArgs(cmd))) {
        console.log(`Unknown command "${firstLine}". Available: ${visibleChatCommands({ visionSupported: state.visionSupported, e2ee: state.e2ee, providerName: provider.meta.name }).join(', ')}\n`)
        continue
      }
      // A failing command must not take the whole session down: picker
      // aborts just return to the prompt, other errors are printed and the
      // loop continues.
      let outcome
      try {
        outcome = await handler({ ...chatCtx, input, args: spaceIdx === -1 ? '' : firstLine.slice(spaceIdx + 1).trim() })
      } catch (err) {
        if (err instanceof ExitPromptError) {
          console.log('Aborted.')
          continue
        }
        console.error(commandErrorLine(err))
        continue
      }
      if (outcome?.exit) return exitCleanly()
      if (outcome?.reset) {
        sessionState.tracker = new UsageTracker()
        sessionState.budgetWarned = false
      }
      if (outcome?.resetBudgetWarning) sessionState.budgetWarned = false
      const trailing = lines.slice(1).join('\n').trim()
      if (trailing) {
        const guard = budgetGuard(chatCtx)
        if (guard) {
          console.log(guard)
          continue
        }
        const content = buildContent(trailing, state.pendingAttachments)
        state.pendingAttachments = []
        state.appendUser(content)
        await runTurn()
      }
      continue
    }

    const guard = budgetGuard(chatCtx)
    if (guard) {
      console.log(guard)
      continue
    }

    const content = buildContent(input, state.pendingAttachments)
    state.pendingAttachments = []
    state.appendUser(content)
    await runTurn()
  }
}

export function startChat(apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts = {}) {
  return runChatSession({ apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, ...opts })
}
