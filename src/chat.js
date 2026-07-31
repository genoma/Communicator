import { UsageTracker, budgetLine, budgetStatus } from './tracker.js'
import { getEffortLabel, resolveTemperatureFlag, selectReasoningEffort } from './prompts.js'
import { DEFAULT_TEMPERATURE, formatCost } from './constants.js'
import { readInput } from './input.js'
import { createStreamRenderer, renderHistory } from './ui/stream.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { dim, sep } from './ui/style.js'
import { ensureSessionsDir, generateSessionId, generateTitle, saveSession } from './sessions.js'
import { savePreferences } from './config.js'
import { selectModelAndEndpoint } from './model-selection.js'

const AVAILABLE_COMMANDS = '/quit, /new, /model, /reasoning, /cost'

export async function startChat(apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, {
  systemPrompt = null,
  initialMessages = null,
  sessionId = null,
  createdAt = null,
  supportsReasoning = true,
  modelReasoning = null,
  budget = null,
  prefs = {},
  configPath = null,
} = {}) {
  const systemContent = systemPrompt || 'You are a helpful assistant.'

  const state = {
    modelId: model,
    endpointProviderName,
    reasoningEffort,
    temperature,
    budget,
    pricing,
    supportsReasoning,
    sessionId,
    createdAt,
    modelReasoning,
    messages: initialMessages || [{ role: 'system', content: systemContent }],
  }

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
  if (bannerParts.length > 0) {
    console.log(`\nConnected to ${label}  ${bannerParts.join('  ')}`)
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
    temperature: state.temperature,
    budget: state.budget,
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
        temperature: state.temperature,
        budget: state.budget ?? null,
        pricing: state.pricing ?? null,
        createdAt: state.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: generateTitle(state.messages),
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

  const runTurn = async () => {
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
        temperature: state.temperature,
        signal: streamController.signal,
      })
      process.stdout.write('\n\n')

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
      state.messages.push(msg)
    }
  }

  while (true) {
    console.log(sep())
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
      state.budget = null
      budgetWarned = false
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
      state.temperature = prefs.temperature?.[sel.modelId] ?? DEFAULT_TEMPERATURE

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

    if (input.startsWith('/temp')) {
      const value = input.slice('/temp'.length).trim()
      if (!value) {
        console.log(`Current temperature: ${state.temperature}\n`)
        continue
      }
      let parsed
      try {
        parsed = resolveTemperatureFlag({ temperature: value })
      } catch (err) {
        console.error(`\nError: ${err.message}\n`)
        continue
      }
      state.temperature = parsed
      await savePrefs({ temperature: { ...prefs.temperature, [state.modelId]: parsed } })
      console.log(`Temperature set to ${parsed}\n`)
      continue
    }

    if (input.startsWith('/budget')) {
      const value = input.slice('/budget'.length).trim()
      if (value) {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error('Error: budget must be a positive number (USD).\n')
          continue
        }
        state.budget = parsed
        budgetWarned = false
        console.log(`Budget set to ${formatCost(parsed)} for this session.\n`)
        continue
      }
      if (state.budget == null) {
        console.log('No budget set. Use /budget <usd> to cap this session.\n')
        continue
      }
      const { pct, remaining } = budgetStatus(tracker.cost, state.budget)
      console.log(`Budget: ${formatCost(tracker.cost)} of ${formatCost(state.budget)} used (${pct.toFixed(0)}%). ${formatCost(remaining)} remaining.\n`)
      continue
    }

    if (input === '/cost') {
      console.log(`${dim('Current session:')} ${tracker.summary()}`)
      console.log(`${dim('Reasoning:')} ${state.reasoningEffort === undefined ? 'auto' : getEffortLabel(state.reasoningEffort)}\n`)
      continue
    }

    if (input === '/retry') {
      if (state.budget != null && tracker.cost >= state.budget) {
        console.log(`Budget exhausted (${formatCost(tracker.cost)} of ${formatCost(state.budget)}). /new to start fresh or /quit.\n`)
        continue
      }
      const last = state.messages[state.messages.length - 1]
      if (last?.role === 'assistant') {
        state.messages.pop()
        await runTurn()
      } else if (last?.role === 'user') {
        await runTurn()
      } else {
        console.log('Nothing to retry yet.\n')
      }
      continue
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command "${input}". Available: ${AVAILABLE_COMMANDS}\n`)
      continue
    }

    if (state.budget != null && tracker.cost >= state.budget) {
      console.log(`Budget exhausted (${formatCost(tracker.cost)} of ${formatCost(state.budget)}). /new to start fresh or /quit.\n`)
      continue
    }

    state.messages.push({ role: 'user', content: input })
    await runTurn()
  }
}
