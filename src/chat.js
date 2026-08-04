import { UsageTracker } from './tracker.js'
import { getEffortLabel } from './prompts.js'
import { DEFAULT_TEMPERATURE, cpsToCharsPerTick } from './constants.js'
import { sessionLabel } from './ui/format.js'
import { chatCommands, budgetGuard, commandAcceptsArgs, visibleChatCommands } from './commands/chat/index.js'
import { buildContent } from './attachments.js'
import { readInput as defaultReadInput } from './input.js'
import { createStreamRenderer, renderHistory } from './ui/stream.js'
import { createLoader } from './ui/loader.js'
import { dim, sep } from './ui/style.js'
import { out } from './ui/io.js'
import { ensureSessionsDir, generateSessionId, persistSessionFile, buildSessionPayload } from './sessions.js'
import { savePreferences, applyPreferenceUpdates } from './config.js'
import { copyText } from './clipboard.js'
import { ChatState } from './chat-state.js'
import { registerSignalHandlers } from './signals.js'
import { createSessionState, createTurnRunner } from './turn-runner.js'

export async function runChatSession(ctx = {}, deps = {}) {
  const {
    apiKey,
    model,
    endpointProviderName,
    reasoningEffort,
    temperature,
    pricing,
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
    webSearchSupported = undefined,
    visionSupported = undefined,
    fileSupported = undefined,
    smoothStreaming = true,
    smoothSpeed,
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

  const systemContent = systemPrompt || 'You are a helpful assistant.'

  const state = new ChatState({
    modelId: model,
    endpointProviderName,
    reasoningEffort,
    temperature,
    budget,
    pricing,
    supportsReasoning,
    webSearch,
    webResults,
    zdr,
    webSearchSupported,
    visionSupported,
    fileSupported,
    smoothStreaming,
    smoothSpeed,
    sessionId,
    createdAt,
    modelReasoning,
    messages: initialMessages || undefined,
    systemContent,
  })

  const sessionState = createSessionState()

  if (initialMessages) {
    for (const msg of initialMessages) {
      if (msg.role === 'assistant' && msg.usage) {
        sessionState.tracker.record(msg.usage, pricing)
      }
    }
  }

  const label = sessionLabel(endpointProviderName, model)
  const bannerParts = []
  if (reasoningEffort != null) bannerParts.push(`[thinking: ${getEffortLabel(reasoningEffort)}]`)
  if (temperature !== DEFAULT_TEMPERATURE) bannerParts.push(`[temp: ${temperature}]`)
  if (state.zdr) bannerParts.push('[zdr]')
  if (state.webSearch !== 'off') {
    const results = state.webResults != null ? `: ${state.webResults}` : ''
    bannerParts.push(`[web: ${state.webSearch}${results}]`)
  }
  if (bannerParts.length > 0) {
    out(`\nConnected to ${label}  ${bannerParts.join('  ')}`)
  } else {
    out(`\nConnected to ${label}`)
  }
  const hintParts = ['Send with Enter']
  if (state.visionSupported !== false) hintParts.push('/attach <path> to queue files')
  hintParts.push('/quit to exit')
  out(`${hintParts.join('  |  ')}\n`)

  if (initialMessages) {
    renderHistory(state.messages, { markdown: state.markdown, stdout })
  }

  if (initialMessages && sessionState.tracker.requests > 0) {
    console.log(`${dim('Previous session:')} ${sessionState.tracker.summary()}\n`)
  }

  const tty = stdout.isTTY === true

  const render = renderer({ markdown: state.markdown, stdout, smooth: tty && state.smoothStreaming, smoothCharsPerTick: cpsToCharsPerTick(state.smoothSpeed) })
  const loader = createLoader({ stdout })

  const saveCurrentSession = async () => {
    if (!state.sessionId || state.messages.length <= 1) return
    try {
      await saveSessionFile(state.sessionId, buildSessionPayload(state.toFinalState(provider.meta.name)))
    } catch {
      // save failures are non-fatal
    }
  }

  const savePrefs = async (updates) => {
    try {
      await savePrefsFile(updates)
    } catch {
      // prefs save failures are non-fatal
    }
  }

  let exitSaveDone = false
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
      }),
    ])
  }

  const cleanupSignals = onSignal({
    sigint: () => {
      if (!sessionState.streaming) {
        void bestEffortExitSave().finally(() => exit(130))
        return
      }
      sessionState.interrupted = true
      sessionState.streamController?.abort()
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
    exit: exitCleanly,
  }
  Object.defineProperty(chatCtx, 'tracker', { get: () => sessionState.tracker, enumerable: true })

  while (true) {
    console.log(sep())
    const result = await readInput({ commands: visibleChatCommands({ visionSupported: state.visionSupported }) })

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
        console.log(`Unknown command "${firstLine}". Available: ${visibleChatCommands({ visionSupported: state.visionSupported }).join(', ')}\n`)
        continue
      }
      const outcome = await handler({ ...chatCtx, input, args: spaceIdx === -1 ? '' : firstLine.slice(spaceIdx + 1).trim() })
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
