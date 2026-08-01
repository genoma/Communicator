import { getProvider } from '../providers/index.js'
import { DEFAULT_TEMPERATURE, formatCost } from '../constants.js'
import { resolveReasoningFlag, resolveTemperatureFlag, resolveWebResultsFlag } from '../prompts.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'
import { ensureSessionsDir, generateSessionId, generateTitle, saveSession } from '../sessions.js'
import { savePreferences } from '../config.js'
import { createStreamRenderer } from '../ui/stream.js'
import { UsageTracker, budgetLine } from '../tracker.js'
import { formatError } from '../errors.js'

const MAX_STDIN_BYTES = 10 * 1024 * 1024

async function readStdin() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > MAX_STDIN_BYTES) {
      console.error('Error: stdin input exceeds the 10MB limit.')
      process.exit(1)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

function resolveBudget(value) {
  if (value === undefined || value === null || value === '') return null
  const budget = Number(value)
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error('Error: --budget must be a positive number (USD).')
    process.exit(1)
  }
  return budget
}

export async function oneShotCmd({ apiKey, opts, prefs, systemPrompt, providerType, prompt }) {
  const provider = getProvider(providerType)
  const stdinPiped = !process.stdin.isTTY

  let text = prompt
  if (!text && stdinPiped) {
    text = await readStdin()
  }
  if (!text) {
    console.error('Error: no prompt provided. Pass a prompt argument or pipe input via stdin.')
    process.exit(1)
  }

  const forcedEffort = resolveReasoningFlag({ reasoningEffort: opts.reasoningEffort })
  const budget = resolveBudget(opts.budget)
  let forcedTemperature
  if (opts.temperature !== undefined && opts.temperature !== '') {
    try {
      forcedTemperature = resolveTemperatureFlag({ temperature: opts.temperature })
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  }
  let forcedWebResults
  try {
    forcedWebResults = resolveWebResultsFlag({ webResults: opts.webResults })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
  const forcedWebSearch = opts.webSearch === true

  let selection
  let temperature
  try {
    if (opts.model) {
      selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort })
    } else if (stdinPiped) {
      console.error('Error: interactive model selection needs a TTY. Use -m <model-id> when piping input.')
      process.exit(1)
    } else {
      selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort })
    }
    temperature = forcedTemperature ?? prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE
  } catch (err) {
    console.error(`Error: ${formatError(err)}`)
    process.exit(1)
  }

  const webSearch = forcedWebResults != null ? true : (forcedWebSearch ?? prefs.webSearch?.[selection.modelId] ?? false)
  if (webSearch && selection.webSearchSupported === false) {
    console.error('Error: The selected model does not support web search.')
    process.exit(1)
  }
  const webResults = forcedWebResults ?? null

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)
  const createdAt = new Date().toISOString()
  const messages = [
    { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
    { role: 'user', content: text },
  ]

  const tracker = new UsageTracker()
  if (budget != null && tracker.cost >= budget) {
    console.error(`Error: budget exhausted (${formatCost(tracker.cost)} of ${formatCost(budget)}).`)
    process.exit(1)
  }
  const ttyOut = process.stdout.isTTY === true
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let result
  try {
    const completionOpts = {
      apiKey,
      model: selection.modelId,
      messages,
      provider: selection.endpointProviderName,
      reasoningEffort: selection.reasoningEffort,
      supportsReasoning: selection.supportsReasoning,
      sessionId,
      temperature,
      webSearch,
      webResults,
      signal: controller.signal,
    }

    if (ttyOut) {
      const label = selection.endpointProviderName ? `${selection.endpointProviderName} / ${selection.modelId}` : selection.modelId
      console.log(`\nConnected to ${label}\n`)
      const render = createStreamRenderer({ markdown: true })
      result = await provider.chatCompletion({ ...completionOpts, onToken: render })
      render.flush?.()
      process.stdout.write('\n\n')
    } else {
      result = await provider.chatCompletion({ ...completionOpts, onToken: () => {} })
    }
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('\nInterrupted.')
      process.exit(130)
    }
    console.error(`Error: ${formatError(err)}`)
    process.exit(1)
  } finally {
    process.off('SIGINT', onSigint)
  }

  if (result.content) {
    const msg = { role: 'assistant', content: result.content }
    if (result.reasoning) msg.reasoning = result.reasoning
    if (result.usage) msg.usage = result.usage
    messages.push(msg)
  }

  if (ttyOut) {
    if (result.usage) {
      tracker.record(result.usage, selection.pricing)
      tracker.printTurn(result.usage, selection.pricing)
      if (budget != null) {
        const line = budgetLine(tracker.cost, budget)
        if (line) console.log(line)
      }
    }
  } else {
    const content = result.content || ''
    process.stdout.write(content)
    if (!content.endsWith('\n')) process.stdout.write('\n')
  }

  await saveSession(dir, sessionId, {
    model: selection.modelId,
    providerName: selection.endpointProviderName,
    providerType: provider.meta.name,
    reasoningEffort: selection.reasoningEffort ?? null,
    temperature,
    budget: budget ?? null,
    webSearch,
    webResults,
    pricing: selection.pricing ?? null,
    createdAt,
    updatedAt: new Date().toISOString(),
    title: generateTitle(messages),
    messages,
  })

  await savePreferences({
    ...prefs,
    lastModel: selection.modelId,
    lastProvider: selection.endpointProviderName,
    temperature: { ...prefs.temperature, [selection.modelId]: temperature },
    webSearch: { ...prefs.webSearch, [selection.modelId]: webSearch },
  }, opts.config)
}
