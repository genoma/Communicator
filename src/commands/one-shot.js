import { getProvider } from '../providers/index.js'
import { cpsToCharsPerTick } from '../constants.js'
import { ensureSessionsDir, generateSessionId } from '../sessions.js'
import { createStreamRenderer, printSources } from '../ui/stream.js'
import { sessionLabel } from '../ui/format.js'
import { UsageTracker, budgetLine } from '../tracker.js'
import { ChatState } from '../chat-state.js'
import { CliError, formatError } from '../errors.js'
import { fail, readStdin } from '../cli-utils.js'
import { loadAttachments, buildContent, contentText } from '../attachments.js'
import { resolveArtifacts, printArtifacts } from '../artifacts.js'
import { resolveSessionFlags, attachGateOptions, persistSession, buildSessionContext } from '../session-setup.js'
import { runImageGeneration, finalizeImageSession } from './image-gen.js'

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

  let context
  try {
    context = await buildSessionContext({
      provider,
      apiKey,
      opts,
      prefs,
      forcedEffort,
      forcedTemperature,
      forcedWebResults,
      zdr,
      allowInteractive: !stdinPiped,
    })
  } catch (err) {
    if (err instanceof CliError) throw err
    fail(`Error: ${formatError(err)}`)
  }
  const { selection, temperature, webSearch, webResults } = context

  if (selection.isImageModel === true) {
    if (opts.attach?.length) {
      throw new CliError('Error: --attach is not supported with image models.')
    }
    const dir = await ensureSessionsDir()
    const sessionId = await generateSessionId(dir)
    const createdAt = new Date().toISOString()

    let outcome
    try {
      outcome = await runImageGeneration({ provider, apiKey, prompt: text, opts, prefs, sessionId, model: selection, stdout: process.stdout })
    } catch (err) {
      if (err instanceof CliError) throw err
      throw new CliError(`Error: ${formatError(err)}`)
    }

    await finalizeImageSession({
      prefs,
      opts,
      config: opts.config,
      sessionId,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: text },
        outcome.message,
      ],
      outcome,
      createdAt,
      providerName: provider.meta.name,
    })
    return
  }

  const attachments = []
  if (opts.attach?.length) {
    const gateOptions = attachGateOptions(selection, provider.meta)
    const loaded = await loadAttachments(opts.attach, gateOptions)
    attachments.push(...loaded.attachments)
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
      const label = sessionLabel(selection.endpointProviderName, selection.modelId)
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

  if (ttyOut) {
    process.stdout.write('\n\n')
  }

  const producedResults = await resolveArtifacts(result, {
    sessionId,
    imageOutputSupported: selection.imageOutputSupported,
  })

  if (producedResults.length > 0) {
    printArtifacts(producedResults, ttyOut ? process.stdout : process.stderr)
  }

  if (ttyOut) {
    if (result.sources?.length > 0) {
      printSources(result.sources, process.stdout)
    }
    if (result.skippedChunks > 0) {
      process.stdout.write(`${result.skippedChunks} malformed stream chunk${result.skippedChunks > 1 ? 's' : ''} skipped\n`)
    }
  }

  if (result.content || result.parts?.length > 0) {
    const msg = { role: 'assistant', content: result.content }
    if (result.reasoning) msg.reasoning = result.reasoning
    if (result.usage) msg.usage = result.usage
    if (result.sources?.length > 0) msg.sources = result.sources
    messages.push(msg)
  }

  if (ttyOut) {
    if (result.usage) {
      tracker.record(result.usage, selection.pricing)
      tracker.printTurn(result.usage, selection.pricing, selection.contextLength)
      if (budget != null) {
        const line = budgetLine(tracker.cost, budget)
        if (line) console.log(`  ${line}`)
      }
    }
  } else {
    const content = Array.isArray(result.content) ? contentText(result.content) : (result.content || '')
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
    contextLength: selection.contextLength,
    sessionId,
    createdAt,
    messages,
  })
  const finalState = state.toFinalState(provider.meta.name)

  await persistSession({ finalState, prefs, config: opts.config })
}
