import { UsageTracker, contextSegment } from './tracker.js'
import { cpsToCharsPerTick, SCRAPE_COST_USD, DEFAULT_SYSTEM_PROMPT, SESSIONS_DIR } from './constants.js'
import { buildStatusLine, connectedBanner } from './status-line.js'
import { chatCommands, budgetGuard, commandAcceptsArgs, visibleChatCommands } from './commands/chat/index.js'
import { buildContent } from './attachments.js'
import { readInput as defaultReadInput } from './input.js'
import { createStreamRenderer, renderHistory } from './ui/stream.js'
import { createLoader } from './ui/loader.js'
import { dim, sep, you, char } from './ui/style.js'
import { out } from './ui/io.js'
import { ensureSessionsDir, generateSessionId, persistSessionFile, buildSessionPayload, removeEmptySessionClaim } from './sessions.js'
import { saveRpgHistory, logRpgPrompt } from './rpg.js'
import { savePreferences, syncPreferenceUpdates, savePrefsBestEffort } from './config.js'
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
    topP,
    pricing,
    contextLength = null,
    provider,
    systemPrompt = null,
    initialMessages = null,
    sessionId = null,
    createdAt = null,
    updatedAt = null,
    supportsReasoning = true,
    modelReasoning = null,
    reasoningMandatory = false,
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
    compactThinking = false,
    scrapes = 0,
    rpgDir = null,
    rpgDebug = false,
    rpgPostHistoryInstruction = null,
    rpgFirstMessage = null,
    rpgCharName = null,
    rpgUserName = null,
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
    await savePreferences(syncPreferenceUpdates(prefs, updates), configPath)
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
    topP,
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
    compactThinking,
    sessionId,
    createdAt,
    updatedAt,
    modelReasoning,
    reasoningMandatory,
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

  const hintParts = []
  if (state.visionSupported !== false && !state.e2ee) hintParts.push('/attach <path> to queue files')
  hintParts.push('/quit to exit')
  const tty = stdout.isTTY === true

  const rpgMarkers = {
    userMarker: rpgUserName ? you(rpgUserName) : null,
    assistantMarker: rpgCharName ? char(rpgCharName) : null,
  }

  // The single source for the app-owned portion of the screen: the banner, the
  // resumed-session summary and the chat transcript above the prompt. The
  // editor draws its own block after this is called, so this is also the
  // resize repaint path.
  let resumeSummary = null
  const printBanner = () => out(connectedBanner(buildStatusLine(state), { hints: hintParts }))
  const renderAboveEditor = (opts = {}) => {
    printBanner()
    if (resumeSummary) console.log(resumeSummary)
    console.log(sep())
    if (state.messages.length > 1) {
      renderHistory(state.messages, { markdown: state.markdown, stdout, compactThinking: tty && state.compactThinking, tailBlank: opts.turnFooter !== false, ...rpgMarkers })
    }
    // The pre-resize layout ends a completed turn with the loop sep, the
    // printTurn Tokens/Cost footer and the loop sep again (see the chat loop
    // below): the rebuild must reproduce all three, or a resize strands the
    // transcript without its separators and metrics. A session with no turn
    // yet only ever shows the single loop sep, so it must not get a second.
    // /retry and /edit redraw with turnFooter: false instead: their
    // replacement stream owns everything below the transcript, so neither the
    // stale footer nor a closing sep may sit between them.
    if (opts.turnFooter !== false) {
      const metrics = sessionState.lastTurnMetrics
      if (metrics) {
        sessionState.tracker.printTurn(metrics.usage, metrics.pricing, metrics.contextLength, metrics.budgetNote)
      }
      if (state.messages.length > 1 || metrics) console.log(sep())
    }
  }
  if (initialMessages && sessionState.tracker.requests > 0) {
    let summary = sessionState.tracker.summary()
    if (lastUsage) {
      const hit = lastUsage.cacheHit || (lastUsage.prompt_tokens_details?.cached_tokens ?? 0) > 0
      const ctx = contextSegment(sessionState.tracker.peakContext, state.contextLength, hit)
      if (ctx) summary += `  |  ${ctx}`
    }
    resumeSummary = `${dim('Previous session:')} ${summary}\n`
  }
  // The launch frame is the same app-owned frame the resize path rebuilds —
  // banner, summary, separator, transcript — so the first `❯ You` gets the
  // same single blank row above it and a resize never changes the layout
  // (the loop's own separator is the closing one below the transcript).
  printBanner()
  if (resumeSummary) console.log(resumeSummary)
  if (state.messages.length > 1) {
    console.log(sep())
    renderHistory(state.messages, { markdown: state.markdown, stdout, compactThinking: tty && state.compactThinking, ...rpgMarkers })
  }

  const render = renderer({
    markdown: state.markdown,
    stdout,
    smooth: tty && state.smoothStreaming,
    smoothCharsPerTick: cpsToCharsPerTick(state.smoothSpeed),
    assistantMarker: rpgMarkers.assistantMarker,
    compactThinking: tty && state.compactThinking,
  })
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
      if (rpgDir) {
        await saveRpgHistory(rpgDir, state.messages)
      }
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
        topP: finalState.topP,
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
      console.error(`\nUnhandled error: ${formatError(err)}`)
      void bestEffortSave().finally(() => exit(1))
    },
  })

  const exitCleanly = async () => {
    cleanupSignals()
    stdout.write('\n')
    await bestEffortSave()
    return state.toFinalState(provider.meta.name)
  }

  const onRequest = rpgDir && rpgDebug
    ? (body) => {
        void logRpgPrompt(rpgDir, {
          timestamp: new Date().toISOString(),
          model: body.model,
          provider: provider.meta.name,
          request: body,
        })
      }
    : null

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
    onRequest,
    postHistoryInstruction: rpgPostHistoryInstruction,
  })
  const runTurn = runner.runTurn

  const chatCtx = {
    state,
    provider,
    apiKey,
    prefs,
    systemContent,
    rpgFirstMessage,
    rpgMarkers,
    saveSession: saveCurrentSession,
    savePrefs,
    runTurn,
    render,
    readInput,
    // Editor-opening commands (e.g. /edit) re-render the transcript above
    // the editor on resize exactly like the main prompt does; without the
    // hook the editor falls back to the DSR-only path and the rewrapped
    // transcript stays garbled.
    onResizeRepaint: renderAboveEditor,
    newSessionId,
    copyText,
    stdout,
    exit: exitCleanly,
  }
  Object.defineProperty(chatCtx, 'tracker', { get: () => sessionState.tracker, enumerable: true })

  while (true) {
    console.log(sep())
    const result = await readInput({
      commands: visibleChatCommands({ visionSupported: state.visionSupported, e2ee: state.e2ee, providerName: provider.meta.name }),
      // Resize reflow: the caller owns the transcript, so it must rebuild it.
      // The editor clears the screen first, then the hook restores everything
      // above the prompt (session-start layout), then the editor redraws its
      // block at the current cursor position.
      onResizeRepaint: renderAboveEditor,
    })

    if (result.cancelled) {
      return exitCleanly()
    }

    // Command detection uses the trimmed value, but the message body keeps
    // the raw input: intentional leading indentation and trailing whitespace
    // of a pasted multi-line message must survive to the API.
    const rawInput = result.value
    const input = rawInput.trim()
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
        sessionState.lastTurnMetrics = null
      }
      if (outcome?.resetBudgetWarning) sessionState.budgetWarned = false
      // The trailing lines start AFTER the command line in the raw input:
      // leading blank/whitespace lines before the command are not part of
      // the message body (trim() moved the command to line 0).
      const rawLines = rawInput.split('\n')
      const cmdIdx = rawLines.findIndex((line) => line.trim() === lines[0])
      const trailing = rawLines.slice(cmdIdx + 1).join('\n')
      if (trailing.trim()) {
        const guard = budgetGuard(chatCtx)
        if (guard) {
          console.log(guard)
          continue
        }
        const content = buildContent(trailing, state.pendingAttachments)
        state.pendingAttachments = []
        // A fresh user prompt supersedes any failed turn that /retry could
        // have replayed.
        state.retryTurn = null
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

    const content = buildContent(rawInput, state.pendingAttachments)
    state.pendingAttachments = []
    // A fresh user prompt supersedes any failed turn that /retry could
    // have replayed.
    state.retryTurn = null
    state.appendUser(content)
    await runTurn()
  }
}

export function startChat(apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts = {}) {
  return runChatSession({ apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, ...opts })
}
