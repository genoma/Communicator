import { ExitPromptError } from '@inquirer/core'
import { getProvider } from '../providers/index.js'
import { cpsToCharsPerTick, SCRAPE_COST_USD, DEFAULT_SYSTEM_PROMPT } from '../constants.js'
import { scrapeMessage } from '../scrape.js'
import { createNewSession, removeEmptySessionClaim } from '../sessions.js'
import { createStreamRenderer } from '../ui/stream.js'
import { UsageTracker, budgetLine } from '../tracker.js'
import { ChatState } from '../chat-state.js'
import { CliError, formatError } from '../errors.js'
import { fail, readStdin, NO_PROMPT_MESSAGE } from '../cli-utils.js'
import { loadAttachments, buildContent, contentText } from '../attachments.js'
import { resolveArtifacts, printArtifactsSummary } from '../artifacts.js'
import { resolveSessionFlags, attachGateOptions, persistSession, buildSessionContext } from '../session-setup.js'
import { saveRpgHistory, logRpgPrompt } from '../rpg.js'
import { createE2eeSession } from '../e2ee.js'
import { runImageCommand } from './image-gen.js'
import { connectedBanner, buildStatusLine } from '../status-line.js'
import { sanitizeAnsi } from '../ui/hyperlink.js'

export async function oneShotCmd({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage = null, rpgHistory = null, rpgPostHistoryInstruction = null, providerType, prompt, scraped = null }) {
  const provider = getProvider(providerType)
  const stdinPiped = !process.stdin.isTTY

  let text = prompt
  if (!text && stdinPiped) {
    text = await readStdin()
  }
  if (!text) {
    throw new CliError(NO_PROMPT_MESSAGE)
  }

  const { forcedEffort, forcedTemperature, forcedTopP, budget, forcedWebResults, smoothSpeed, zdr, e2ee } = resolveSessionFlags(opts, prefs)

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
      forcedTopP,
      forcedWebResults,
      zdr,
      e2ee,
      allowInteractive: !stdinPiped,
    })
  } catch (err) {
    if (err instanceof CliError || err instanceof ExitPromptError) throw err
    fail(`Error: ${formatError(err)}`)
  }
  const { selection, temperature, topP, webSearch, webResults } = context

  if (selection.isImageModel === true) {
    if (opts.attach?.length) {
      throw new CliError('Error: --attach is not supported with image models.')
    }
    await runImageCommand({ provider, apiKey, opts, prefs, providerType: provider.meta.name, prompt: text, model: selection })
    return
  }

  const attachments = []
  if (opts.attach?.length) {
    const gateOptions = attachGateOptions(selection, provider.meta)
    const loaded = await loadAttachments(opts.attach, gateOptions)
    attachments.push(...loaded.attachments)
  }

  const { dir, sessionId, createdAt } = await createNewSession()
  const messages = [
    { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
    ...(rpgHistory ? rpgHistory : rpgFirstMessage ? [{ role: 'assistant', content: rpgFirstMessage }] : []),
    ...(scraped ? [{ role: 'user', content: scrapeMessage(scraped.url, scraped.content) }] : []),
    { role: 'user', content: buildContent(text, attachments) },
  ]
  // The post-history instruction is a request-only message: it is sent after
  // the latest user turn but never persisted into the global session file.
  const requestMessages = rpgPostHistoryInstruction
    ? [...messages, { role: 'system', content: rpgPostHistoryInstruction }]
    : messages

  // The scrape already happened (and was billed) before this command ran; add
  // its flat cost so the turn/budget lines below account for it.
  if (scraped) tracker.addScrapeCost(SCRAPE_COST_USD)

  // E2EE needs its own client key pair plus the attested model public key
  // before the first turn; any failure aborts rather than sending plaintext.
  let e2eeContext = null
  if (e2ee) {
    try {
      e2eeContext = await createE2eeSession({ apiKey, modelId: selection.modelId })
    } catch (err) {
      throw new CliError(`Error: ${formatError(err)}`)
    }
  }

  const ttyOut = process.stdout.isTTY === true
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigint)

  let result
  try {
    const completionOpts = {
      apiKey,
      model: selection.modelId,
      messages: requestMessages,
      provider: selection.endpointProviderName,
      reasoningEffort: selection.reasoningEffort,
      reasoningMandatory: selection.modelReasoning?.mandatory === true,
      supportsReasoning: selection.supportsReasoning,
      sessionId,
      temperature,
      topP,
      webSearch,
      webResults,
      zdr,
      e2ee,
      e2eeContext,
      signal: controller.signal,
      onRequest: opts.rpg !== undefined && opts.debug === true
        ? (body) => {
            void logRpgPrompt(opts.rpg, {
              timestamp: new Date().toISOString(),
              model: body.model,
              provider: provider.meta.name,
              request: body,
            })
          }
        : null,
    }

    if (ttyOut) {
      // The same banner + snapshot line as the chat REPL (model, context,
      // pricing, thinking/temp/web/zdr/e2ee, budget and smooth streaming).
      const segments = buildStatusLine({
        modelId: selection.modelId,
        endpointProviderName: selection.endpointProviderName,
        contextLength: selection.contextLength,
        pricing: selection.pricing,
        reasoningEffort: selection.reasoningEffort,
        temperature,
        topP,
        webSearch,
        webResults,
        zdr,
        e2ee,
        budget,
        smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
        smoothSpeed,
      })
      console.log(connectedBanner(segments))
      const render = createStreamRenderer({ markdown: true, smooth: opts.smoothStreaming !== false && prefs.smoothStreaming !== false, smoothCharsPerTick: cpsToCharsPerTick(smoothSpeed) })
      result = await provider.chatCompletion({
        ...completionOpts,
        onToken: render,
        onSources: (sources) => {
          render.sources = sources
        },
      })
      await render.flush()
    } else {
      result = await provider.chatCompletion({ ...completionOpts, onToken: () => {} })
    }
  } catch (err) {
    await removeEmptySessionClaim(dir, sessionId)
    if (controller.signal.aborted) {
      console.error('\nInterrupted.')
      process.exit(130)
    }
    if (err instanceof CliError) throw err
    throw new CliError(`Error: ${formatError(err)}`)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigint)
  }

  if (ttyOut) {
    process.stdout.write('\n\n')
  }

  const producedResults = await resolveArtifacts(result, {
    sessionId,
    imageOutputSupported: selection.imageOutputSupported,
  })

  // Artifact lines go to stderr when piped so stdout stays pure content;
  // sources and the malformed-chunk notice are TTY-only (same styling as chat).
  printArtifactsSummary(producedResults, result, ttyOut ? process.stdout : process.stderr, {
    withSources: ttyOut,
    withSkipped: ttyOut,
  })

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
    process.stdout.write(sanitizeAnsi(content))
    if (!content.endsWith('\n')) process.stdout.write('\n')
  }

  const state = new ChatState({
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature,
    topP,
    budget,
    webSearch,
    webResults,
    zdr,
    e2ee,
    pricing: selection.pricing,
    contextLength: selection.contextLength,
    sessionId,
    createdAt,
    messages,
    reasoningMandatory: selection.modelReasoning?.mandatory === true,
    scrapes: scraped ? 1 : 0,
  })
  const finalState = state.toFinalState(provider.meta.name)

  await persistSession({ finalState, prefs, config: opts.config })
  if (opts.rpg !== undefined) {
    await saveRpgHistory(opts.rpg, messages)
  }
}
