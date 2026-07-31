import { UsageTracker } from './tracker.js'
import { getEffortLabel, selectReasoningEffort } from './prompts.js'
import { readInput } from './input.js'
import { createStreamRenderer, renderHistory } from './ui/stream.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { dim } from './ui/style.js'
import { ensureSessionsDir, generateSessionId, saveSession } from './sessions.js'
import { savePreferences } from './config.js'
import { selectModelAndEndpoint } from './model-selection.js'

const AVAILABLE_COMMANDS = '/quit, /new, /model, /reasoning, /cost'

export async function startChat(apiKey, model, endpointProviderName, reasoningEffort, pricing, provider, {
  systemPrompt = null,
  initialMessages = null,
  sessionId = null,
  createdAt = null,
  supportsReasoning = true,
  modelReasoning = null,
  prefs = {},
  configPath = null,
} = {}) {
  const systemContent = systemPrompt || 'You are a helpful assistant.'

  const state = {
    modelId: model,
    endpointProviderName,
    reasoningEffort,
    pricing,
    supportsReasoning,
    sessionId,
    createdAt,
    modelReasoning,
    messages: initialMessages || [{ role: 'system', content: systemContent }],
  }

  let tracker = new UsageTracker()

  if (initialMessages) {
    for (const msg of initialMessages) {
      if (msg.role === 'assistant' && msg.usage) {
        tracker.record(msg.usage, pricing)
      }
    }
  }

  const label = endpointProviderName ? `${endpointProviderName} / ${model}` : model
  if (reasoningEffort != null) {
    console.log(`\nConnected to ${label}  [thinking: ${getEffortLabel(reasoningEffort)}]`)
  } else {
    console.log(`\nConnected to ${label}`)
  }
  console.log('Send with Enter  |  Newline: Ctrl+J  |  /quit to exit\n')

  if (initialMessages) {
    renderHistory(state.messages)
  }

  if (initialMessages && tracker.requests > 0) {
    console.log(`${dim('Previous session:')} ${tracker.summary()}\n`)
  }

  const render = createStreamRenderer()

  const finalState = () => ({
    messages: state.messages,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    modelId: state.modelId,
    endpointProviderName: state.endpointProviderName,
    reasoningEffort: state.reasoningEffort,
    pricing: state.pricing,
    providerType: provider.meta.name,
  })

  const saveCurrentSession = async () => {
    if (!state.sessionId || state.messages.length <= 1) return
    try {
      const dir = await ensureSessionsDir()
      await saveSession(dir, state.sessionId, {
        model: state.modelId,
        providerName: state.endpointProviderName,
        providerType: provider.meta.name,
        reasoningEffort: state.reasoningEffort ?? null,
        pricing: state.pricing ?? null,
        createdAt: state.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: state.messages,
      })
    } catch {
      // save failures are non-fatal
    }
  }

  const savePrefs = async (changes) => {
    try {
      await savePreferences({ ...prefs, ...changes }, configPath)
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

  const onBeforeExit = () => {
    void bestEffortSave()
  }
  process.on('beforeExit', onBeforeExit)
  process.on('uncaughtException', (err) => {
    console.error(`\nUnhandled error: ${err?.message || err}`)
    void bestEffortSave().finally(() => process.exit(1))
  })

  let streaming = false
  let streamController = null
  let interrupted = false

  process.on('SIGINT', () => {
    if (!streaming) {
      void bestEffortSave().finally(() => process.exit(130))
      return
    }
    interrupted = true
    streamController?.abort()
  })

  const exitCleanly = () => {
    process.off('beforeExit', onBeforeExit)
    process.stdout.write('\n')
    return finalState()
  }

  while (true) {
    const result = await readInput()

    if (result.cancelled) {
      return exitCleanly()
    }

    const input = result.value.trim()
    if (!input) continue

    if (input === '/quit') {
      return exitCleanly()
    }

    if (input === '/new') {
      await saveCurrentSession()
      const dir = await ensureSessionsDir()
      state.sessionId = await generateSessionId(dir)
      state.createdAt = new Date().toISOString()
      state.messages = [{ role: 'system', content: systemContent }]
      tracker = new UsageTracker()
      console.log('\nNew session started.\n')
      continue
    }

    if (input === '/model') {
      await saveCurrentSession()
      let sel
      try {
        sel = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: undefined })
      } catch (err) {
        console.error(`\nError: ${formatError(err)}\n`)
        continue
      }
      state.modelId = sel.modelId
      state.endpointProviderName = sel.endpointProviderName
      state.pricing = sel.pricing
      state.reasoningEffort = sel.reasoningEffort
      state.supportsReasoning = sel.supportsReasoning
      state.modelReasoning = sel.modelReasoning

      const prefsChanges = { lastModel: sel.modelId, lastProvider: sel.endpointProviderName }
      if (sel.reasoningEffort !== undefined) {
        prefsChanges.reasoningEffort = { ...prefs.reasoningEffort, [sel.modelId]: sel.reasoningEffort }
      }
      await savePrefs(prefsChanges)

      const label = sel.endpointProviderName ? `${sel.endpointProviderName} / ${sel.modelId}` : sel.modelId
      console.log(`\nSwitched to ${label}\n`)
      continue
    }

    if (input === '/reasoning') {
      let reasoning = state.modelReasoning
      if (!reasoning) {
        try {
          const models = await provider.fetchModels(apiKey)
          reasoning = models.find((m) => m.id === state.modelId)?.reasoning || null
          state.modelReasoning = reasoning
        } catch (err) {
          console.error(`\nError: ${formatError(err)}\n`)
          continue
        }
      }
      const newEffort = await selectReasoningEffort(reasoning, state.reasoningEffort)
      if (newEffort === undefined) {
        console.log('This model does not support reasoning effort control.\n')
        continue
      }
      state.reasoningEffort = newEffort
      await savePrefs({ reasoningEffort: { ...prefs.reasoningEffort, [state.modelId]: newEffort } })
      console.log(`Reasoning effort set to ${getEffortLabel(newEffort)}\n`)
      continue
    }

    if (input === '/cost') {
      console.log(`${dim('Current session:')} ${tracker.summary()}`)
      console.log(`${dim('Reasoning:')} ${state.reasoningEffort === undefined ? 'auto' : getEffortLabel(state.reasoningEffort)}\n`)
      continue
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command "${input}". Available: ${AVAILABLE_COMMANDS}\n`)
      continue
    }

    state.messages.push({ role: 'user', content: input })

    let apiResult
    let streamedContent = ''
    let streamedReasoning = ''

    streaming = true
    streamController = new AbortController()
    interrupted = false

    try {
      process.stdout.write('\n')
      apiResult = await provider.chatCompletion({
        apiKey,
        model: state.modelId,
        messages: state.messages,
        onToken: (token, type) => {
          if (type === 'reasoning') streamedReasoning += token
          else if (type === 'content') streamedContent += token
          render(token, type)
        },
        provider: state.endpointProviderName,
        reasoningEffort: state.reasoningEffort,
        supportsReasoning: state.supportsReasoning,
        sessionId: state.sessionId,
        signal: streamController.signal,
      })
      process.stdout.write('\n\n')

      if (apiResult.usage) {
        tracker.record(apiResult.usage, state.pricing)
        tracker.printTurn(apiResult.usage, state.pricing)
      }
    } catch (err) {
      if (interrupted) {
        process.stdout.write('\n')
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
          state.messages.push(partial)
        }
        await saveCurrentSession()
        process.exit(130)
      }
      console.error(`\nError: ${formatError(err)}\n`)
      if (err instanceof ApiError && err.retryable) {
        state.messages.pop()
      }
      continue
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
      state.messages.push(msg)
    }
  }
}
