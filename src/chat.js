import { UsageTracker, budgetLine } from './tracker.js'
import { getEffortLabel } from './prompts.js'
import { DEFAULT_TEMPERATURE, cpsToCharsPerTick } from './constants.js'
import { CHAT_COMMANDS, chatCommands, budgetGuard, commandAcceptsArgs } from './commands/chat/index.js'
import { buildContent } from './attachments.js'
import { readInput as defaultReadInput } from './input.js'
import { createStreamRenderer, renderHistory, printSources } from './ui/stream.js'
import { createLoader } from './ui/loader.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { dim, sep } from './ui/style.js'
import { ensureSessionsDir, generateSessionId, saveSession, buildSessionPayload } from './sessions.js'
import { savePreferences, applyPreferenceUpdates } from './config.js'
import { copyText } from './clipboard.js'
import { ChatState } from './chat-state.js'

function defaultOnSignal(handlers) {
  const onSigint = () => handlers.sigint()
  const onBeforeExit = () => handlers.beforeExit()
  const onUncaught = (err) => handlers.uncaughtException(err)
  process.on('SIGINT', onSigint)
  process.on('beforeExit', onBeforeExit)
  process.on('uncaughtException', onUncaught)
  return () => {
    process.off('SIGINT', onSigint)
    process.off('beforeExit', onBeforeExit)
    process.off('uncaughtException', onUncaught)
  }
}

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
    onSignal = defaultOnSignal,
  } = deps

  const saveSessionFile = deps.saveSession ?? (async (sessionIdToSave, payload) => {
    const dir = await ensureSessionsDir()
    await saveSession(dir, sessionIdToSave, payload)
  })

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

  let tracker = new UsageTracker()
  let budgetWarned = false

  if (initialMessages) {
    for (const msg of initialMessages) {
      if (msg.role === 'assistant' && msg.usage) {
        tracker.record(msg.usage, pricing)
      }
    }
  }

  const label = endpointProviderName ? `${endpointProviderName} / ${model}` : model
  const bannerParts = []
  if (reasoningEffort != null) bannerParts.push(`[thinking: ${getEffortLabel(reasoningEffort)}]`)
  if (temperature !== DEFAULT_TEMPERATURE) bannerParts.push(`[temp: ${temperature}]`)
  if (state.webSearch !== 'off') {
    const results = state.webResults != null ? `: ${state.webResults}` : ''
    bannerParts.push(`[web: ${state.webSearch}${results}]`)
  }
  if (bannerParts.length > 0) {
    console.log(`\nConnected to ${label}  ${bannerParts.join('  ')}`)
  } else {
    console.log(`\nConnected to ${label}`)
  }
  console.log('Send with Enter  |  Newline: Ctrl+J  |  /attach <path> to queue files  |  /quit to exit\n')

  if (initialMessages) {
    renderHistory(state.messages, { markdown: state.markdown, stdout })
  }

  if (initialMessages && tracker.requests > 0) {
    console.log(`${dim('Previous session:')} ${tracker.summary()}\n`)
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

  let streaming = false
  let streamController = null
  let interrupted = false

  const cleanupSignals = onSignal({
    sigint: () => {
      if (!streaming) {
        void bestEffortSave().finally(() => exit(130))
        return
      }
      interrupted = true
      streamController?.abort()
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

  const runTurn = async () => {
    let apiResult
    let streamedContent = ''
    let streamedReasoning = ''

    render.sources = []
    streaming = true
    streamController = new AbortController()
    interrupted = false

    try {
      stdout.write('\n')
      if (tty) loader.start(state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response')
      apiResult = await provider.chatCompletion({
        apiKey,
        model: state.modelId,
        messages: state.messages,
        onToken: (token, type) => {
          if (type === 'reasoning' || type === 'content') loader.stop({ done: true })
          if (type === 'reasoning') streamedReasoning += token
          else if (type === 'content') streamedContent += token
          render(token, type)
        },
        onSources: (sources) => {
          render.sources = sources
        },
        provider: state.endpointProviderName,
        reasoningEffort: state.reasoningEffort,
        supportsReasoning: state.supportsReasoning,
        sessionId: state.sessionId,
        temperature: state.temperature,
        webSearch: state.webSearch,
        webResults: state.webResults,
        signal: streamController.signal,
      })
      loader.stop()
      await render.flush()
      stdout.write('\n\n')

      if (apiResult.sources?.length > 0) {
        printSources(apiResult.sources, stdout)
      }

      if (apiResult.usage) {
        tracker.record(apiResult.usage, state.pricing)
        tracker.printTurn(apiResult.usage, state.pricing)
        if (state.budget != null && !budgetWarned) {
          const line = budgetLine(tracker.cost, state.budget)
          if (line) {
            budgetWarned = true
            console.log(line)
          }
        }
      }
    } catch (err) {
      loader.stop()
      if (interrupted) {
        render.flush({ sync: true })
        stdout.write('\n')
        const partial = { role: 'assistant', content: streamedContent }
        if (streamedReasoning) partial.reasoning = streamedReasoning
        if (!partial.content && !partial.reasoning && err.pendingBuffer) {
          const pending = extractPartialToken(err.pendingBuffer)
          if (pending) {
            if (pending.type === 'reasoning') partial.reasoning = pending.text
            else partial.content = pending.text
          }
        }
        if (partial.content || partial.reasoning) {
          state.appendAssistant(partial)
        }
        await saveCurrentSession()
        exit(130)
      }
      render.flush({ sync: true })
      console.error(`\nError: ${formatError(err)}\n`)
      if (err instanceof ApiError && err.retryable) {
        state.messages.pop()
      }
      return
    } finally {
      streaming = false
      streamController = null
    }

    if (apiResult.content) {
      const msg = { role: 'assistant', content: apiResult.content }
      if (apiResult.reasoning) {
        msg.reasoning = apiResult.reasoning
      }
      if (apiResult.usage) {
        msg.usage = apiResult.usage
      }
      state.appendAssistant(msg)
    }
  }

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
  Object.defineProperty(chatCtx, 'tracker', { get: () => tracker, enumerable: true })

  while (true) {
    console.log(sep())
    const result = await readInput({ commands: CHAT_COMMANDS })

    if (result.cancelled) {
      return exitCleanly()
    }

    const input = result.value.trim()
    if (!input) continue

    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ')
      const cmd = spaceIdx === -1 ? input : input.slice(0, spaceIdx)
      const handler = chatCommands[cmd]
      if (!handler || (spaceIdx !== -1 && !commandAcceptsArgs(cmd))) {
        console.log(`Unknown command "${input}". Available: ${CHAT_COMMANDS.join(', ')}\n`)
        continue
      }
      const outcome = await handler({ ...chatCtx, input, args: spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim() })
      if (outcome?.exit) return exitCleanly()
      if (outcome?.reset) {
        tracker = new UsageTracker()
        budgetWarned = false
      }
      if (outcome?.resetBudgetWarning) budgetWarned = false
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
