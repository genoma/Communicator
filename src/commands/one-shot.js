import { getProvider } from '../providers/index.js'
import { DEFAULT_TEMPERATURE, cpsToCharsPerTick } from '../constants.js'
import { resolveReasoningFlag, resolveTemperatureFlag, resolveWebResultsFlag, resolveWebSearchFlag, webSearchGate, resolveBudget, resolveSmoothSpeed, normalizeSmoothSpeed } from '../flags.js'
import { resolveFlagOrExit } from '../cli-utils.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'
import { ensureSessionsDir, generateSessionId, saveSession, buildSessionPayload } from '../sessions.js'
import { savePreferences, applyPreferenceUpdates } from '../config.js'
import { createStreamRenderer, printSources } from '../ui/stream.js'
import { UsageTracker, budgetLine } from '../tracker.js'
import { formatError } from '../errors.js'
import { loadAttachment, attachmentGate, buildContent } from '../attachments.js'

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
  const budget = resolveFlagOrExit(resolveBudget, opts.budget) ?? prefs.budget ?? null
  const forcedTemperature = resolveFlagOrExit((v) => resolveTemperatureFlag({ temperature: v }), opts.temperature)
  const forcedWebResults = resolveFlagOrExit((v) => resolveWebResultsFlag({ webResults: v }), opts.webResults)
  const smoothSpeed = resolveFlagOrExit(resolveSmoothSpeed, opts.smoothSpeed) ?? normalizeSmoothSpeed(prefs.smoothSpeed)

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

  const webSearch = resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: prefs.webSearch?.[selection.modelId] })
  const webSearchGateError = webSearchGate(webSearch, selection.webSearchSupported)
  if (webSearchGateError) {
    console.error(`Error: ${webSearchGateError}`)
    process.exit(1)
  }
  const webResults = forcedWebResults ?? prefs.webResults ?? null

  const attachments = []
  if (opts.attach?.length) {
    for (const path of opts.attach) {
      try {
        attachments.push(await loadAttachment(path))
      } catch (err) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    }
    const gateError = attachmentGate(attachments, {
      visionSupported: selection.visionSupported,
      fileSupported: selection.fileSupported,
      providerName: provider.meta.name,
    })
    if (gateError) {
      console.error(`Error: ${gateError}`)
      process.exit(1)
    }
  }

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)
  const createdAt = new Date().toISOString()
  const messages = [
    { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
    { role: 'user', content: buildContent(text, attachments) },
  ]

  const tracker = new UsageTracker()
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
      const render = createStreamRenderer({ markdown: true, smooth: opts.smoothStreaming !== false && prefs.smoothStreaming !== false, smoothCharsPerTick: cpsToCharsPerTick(smoothSpeed) })
      result = await provider.chatCompletion({
        ...completionOpts,
        onToken: render,
        onSources: (sources) => {
          render.sources = sources
        },
      })
      await render.flush?.()
      process.stdout.write('\n\n')
      if (result.sources?.length > 0) {
        printSources(result.sources, process.stdout)
      }
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

  const finalState = {
    messages,
    sessionId,
    createdAt,
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    providerType: provider.meta.name,
    reasoningEffort: selection.reasoningEffort,
    temperature,
    budget,
    webSearch,
    webResults,
    pricing: selection.pricing,
  }

  await saveSession(dir, sessionId, buildSessionPayload(finalState))

  await savePreferences(applyPreferenceUpdates(prefs, {
    modelId: selection.modelId,
    lastModel: selection.modelId,
    lastProvider: selection.endpointProviderName,
    temperature,
    webSearch,
  }), opts.config)
}
