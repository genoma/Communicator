import { getProvider } from '../providers/index.js'
import { DEFAULT_TEMPERATURE, cpsToCharsPerTick, formatCost } from '../constants.js'
import { resolveWebSearchFlag, webSearchGate } from '../flags.js'
import { selectModelAndEndpoint, selectModelNonInteractive } from '../model-selection.js'
import { ensureSessionsDir, generateSessionId } from '../sessions.js'
import { createStreamRenderer, printSources } from '../ui/stream.js'
import { UsageTracker, budgetLine } from '../tracker.js'
import { ChatState } from '../chat-state.js'
import { CliError, formatError } from '../errors.js'
import { extname } from 'node:path'
import { classifyPath, loadAttachment, attachmentGate, buildContent } from '../attachments.js'
import { resolveSessionFlags, attachGateOptions, persistSession } from '../session-setup.js'

const MAX_STDIN_BYTES = 10 * 1024 * 1024

async function readStdin() {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    total += chunk.length
    if (total > MAX_STDIN_BYTES) {
      throw new CliError('Error: stdin input exceeds the 10MB limit.')
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
    throw new CliError('Error: no prompt provided. Pass a prompt argument or pipe input via stdin.')
  }

  const { forcedEffort, forcedTemperature, budget, forcedWebResults, smoothSpeed, zdr } = resolveSessionFlags(opts, prefs)

  const tracker = new UsageTracker()
  if (budget != null && tracker.cost >= budget) {
    throw new CliError(`Error: Budget exhausted (${formatCost(tracker.cost)} of ${formatCost(budget)}).`)
  }

  let selection
  let temperature
  try {
    if (opts.model) {
      selection = await selectModelNonInteractive({ provider, apiKey, prefs, modelId: opts.model, forcedEffort, zdr })
    } else if (stdinPiped) {
      throw new CliError('Error: interactive model selection needs a TTY. Use -m <model-id> when piping input.')
    } else {
      selection = await selectModelAndEndpoint({ provider, apiKey, prefs, reasoningEffort: forcedEffort, zdr })
    }
    temperature = forcedTemperature ?? prefs.temperature?.[selection.modelId] ?? DEFAULT_TEMPERATURE
  } catch (err) {
    if (err instanceof CliError) throw err
    console.error(`Error: ${formatError(err)}`)
    process.exit(1)
  }

  const webSearch = resolveWebSearchFlag({ webSearch: opts.webSearch, webResults: forcedWebResults, prefValue: prefs.webSearch?.[selection.modelId] })
  const webSearchGateError = webSearchGate(webSearch, selection.webSearchSupported)
  if (webSearchGateError) {
    throw new CliError(`Error: ${webSearchGateError}`)
  }
  const webResults = forcedWebResults ?? prefs.webResults ?? null

  const attachments = []
  if (opts.attach?.length) {
    const gateOptions = attachGateOptions(selection, provider.meta)
    for (const path of opts.attach) {
      const { kind } = classifyPath(path)
      if (!kind) {
        throw new CliError(`Error: Unsupported file type: ${extname(path).slice(1) || '(none)'}`)
      }
      const gateError = attachmentGate([{ kind }], gateOptions)
      if (gateError) {
        throw new CliError(`Error: ${gateError}`)
      }
      try {
        attachments.push(await loadAttachment(path))
      } catch (err) {
        throw new CliError(`Error: ${err.message}`)
      }
    }
  }

  const dir = await ensureSessionsDir()
  const sessionId = await generateSessionId(dir)
  const createdAt = new Date().toISOString()
  const messages = [
    { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
    { role: 'user', content: buildContent(text, attachments) },
  ]

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
      zdr,
      signal: controller.signal,
    }

    if (ttyOut) {
      const label = selection.endpointProviderName ? `${selection.endpointProviderName} / ${selection.modelId}` : selection.modelId
      console.log(`\nConnected to ${label}${zdr ? '  [zdr]' : ''}\n`)
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
      if (result.skippedChunks > 0) {
        process.stdout.write(`${result.skippedChunks} malformed stream chunk${result.skippedChunks > 1 ? 's' : ''} skipped\n`)
      }
    } else {
      result = await provider.chatCompletion({ ...completionOpts, onToken: () => {} })
    }
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('\nInterrupted.')
      process.exit(130)
    }
    if (err instanceof CliError) throw err
    throw new CliError(`Error: ${formatError(err)}`)
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

  const state = new ChatState({
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature,
    budget,
    webSearch,
    webResults,
    zdr,
    pricing: selection.pricing,
    sessionId,
    createdAt,
    messages,
  })
  const finalState = state.toFinalState(provider.meta.name)

  await persistSession({ finalState, prefs, config: opts.config })
}
