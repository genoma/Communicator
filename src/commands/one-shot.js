import { getProvider } from '../providers/index.js'
import { cpsToCharsPerTick, SCRAPE_COST_USD, DEFAULT_SYSTEM_PROMPT, E2EE_AT_REST_WARNING } from '../constants.js'
import { scrapeMessage } from '../scrape.js'
import { createNewSession, ensureSessionsDir, removeEmptySessionClaim } from '../sessions.js'
import { createStreamRenderer } from '../ui/stream.js'
import { UsageTracker, seedTracker, budgetLine, trackerCostSummary } from '../tracker.js'
import { ChatState } from '../chat-state.js'
import { CliError, formatError, isExitPromptError } from '../errors.js'
import { fail, readStdin, NO_PROMPT_MESSAGE } from '../cli-utils.js'
import { loadAttachments, buildContent } from '../attachments.js'
import { resolveArtifacts, printArtifactsSummary } from '../artifacts.js'
import { resolveSessionFlags, attachGateOptions, persistSession, buildSessionContext, resumeSessionContext, assertResumeFlags } from '../session-setup.js'
import { logRpgPrompt, ensureRpgSessionsDir, rpgSessionsDir } from '../rpg.js'
import { getApiKey } from '../config.js'
import { createE2eeSession } from '../e2ee.js'
import { resumeCmd } from './resume.js'
import { findImageModel } from '../model-selection.js'
import { runImageCommand } from './image-gen.js'
import { connectedBanner, buildStatusLine } from '../status-line.js'
import { sanitizeAnsi } from '../ui/hyperlink.js'
import { char } from '../ui/style.js'

export async function oneShotCmd({ apiKey, opts, prefs, systemPrompt, rpgFirstMessage = null, rpgHistory = null, rpgPostHistoryInstruction = null, rpgCharName = null, rpgUserName = null, providerType, prompt, scraped = null, rpgResume = null }) {
  const stdinPiped = !process.stdin.isTTY

  let text = prompt
  if (!text && stdinPiped) {
    text = await readStdin()
  }
  if (!text) {
    throw new CliError(NO_PROMPT_MESSAGE)
  }

  const { forcedEffort, forcedTemperature, forcedTopP, budget, forcedWebResults, smoothSpeed, compactThinking, zdr, e2ee } = resolveSessionFlags(opts, prefs)

  // A plain -r replays the stored session (settings, identity and its own
  // system message) instead of picking a fresh model, exactly like the
  // interactive resume branch (src/commands/chat-start.js).
  let plainResume = null
  if (opts.resume !== undefined && opts.rpg === undefined && !rpgResume) {
    plainResume = await resumeCmd(opts.resume)
    if (!plainResume) return
  }

  // A resumed session (plain or chapter) brings its own provider and key; the
  // run's default provider only applies to fresh runs.
  const resumed = rpgResume ?? plainResume
  const provider = getProvider(resumed?.providerType ?? providerType)

  // E2EE sessions never silently degrade, exactly like the chat resume path;
  // the provider-only flags answer first so a session whose provider cannot
  // run --e2ee reports that, not the encryption mismatch or a missing key.
  if (resumed) assertResumeFlags({ result: resumed, providerName: provider.meta.name, zdr, e2ee, forcedWebResults })
  // The at-rest warning belongs to a run that proceeds: the guard above may
  // refuse this resume. Chapters take the RPG-worded notice from
  // src/cli-main.js after the same guard.
  if (plainResume && e2ee) console.warn(E2EE_AT_REST_WARNING)
  const runApiKey = resumed ? getApiKey(resumed.providerType ?? providerType) : apiKey

  // An image session is a REPL of its own, so a headless resume must refuse it
  // instead of silently running it as a text chat. Only legacy payloads without
  // the marker need the catalog lookup (same as src/commands/chat-start.js).
  if (plainResume) {
    const isImageSession = plainResume.isImageModel === true
      || (plainResume.isImageModel === undefined && !!(await findImageModel(provider, runApiKey, plainResume.modelId)))
    if (isImageSession) {
      throw new CliError('Error: resuming an image session needs a TTY (image sessions are interactive).')
    }
  }

  const tracker = new UsageTracker()

  let context
  try {
    context = resumed
      ? await resumeSessionContext({ result: resumed, opts, prefs, forcedEffort, forcedTemperature, forcedTopP, forcedWebResults, provider, apiKey: runApiKey, zdr, e2ee })
      : await buildSessionContext({
          provider,
          apiKey: runApiKey,
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
    if (err instanceof CliError || isExitPromptError(err)) throw err
    fail(`Error: ${formatError(err)}`)
  }
  const { selection, temperature, topP, webSearch, webSearchExplicit, webResults, budget: resumeBudget } = context
  // A resumed session restores its own budget (null stays null); a fresh run is
  // uncapped (4.0.0: the standing prefs.budget default is gone).
  const runBudget = resumed ? resumeBudget : budget
  // A resumed session extends its own session file, so its persisted cost
  // summary must stay cumulative: replay the stored turns' usage and flat scrape
  // cost exactly like the interactive resume path seeds its tracker
  // (src/chat.js, from the same messages). The new scrape below is added on top.
  seedTracker(tracker, plainResume ? plainResume.initialMessages : rpgHistory, selection.pricing, resumed?.scrapes ?? 0)

  if (selection.isImageModel === true) {
    if (opts.attach?.length) {
      throw new CliError('Error: --attach is not supported with image models.')
    }
    await runImageCommand({ provider, apiKey: runApiKey, opts, prefs, providerType: provider.meta.name, prompt: text, model: selection })
    return
  }

  const attachments = []
  if (opts.attach?.length) {
    const gateOptions = attachGateOptions(selection, provider.meta)
    const loaded = await loadAttachments(opts.attach, gateOptions)
    attachments.push(...loaded.attachments)
  }

  // A resumed session (plain or chapter) continues its own session file so the
  // transcript stays one session; a fresh or legacy history.json run claims a
  // new session id. updatedAt is deliberately not carried: the one-shot always
  // adds a turn, so the payload stamps the save time (never an
  // untouched-resume value).
  const { dir, sessionId, createdAt } = rpgResume
    ? { dir: rpgSessionsDir(rpgResume.rpgDir ?? opts.rpg), sessionId: rpgResume.sessionId, createdAt: rpgResume.sessionCreatedAt ?? new Date().toISOString() }
    : plainResume
      ? { dir: await ensureSessionsDir(), sessionId: plainResume.sessionId, createdAt: plainResume.sessionCreatedAt ?? new Date().toISOString() }
      : await createNewSession(opts.rpg !== undefined ? await ensureRpgSessionsDir(opts.rpg) : null)
  // A plain resume sends its stored history verbatim — the persisted system
  // message is the session's own prompt, never rewritten from --system-prompt —
  // and appends the new user turn; --attach and --scrape cannot be combined
  // with it (validation).
  const messages = [
    ...(plainResume
      ? plainResume.initialMessages
      : [
          { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
          ...(rpgHistory ? rpgHistory : rpgFirstMessage ? [{ role: 'assistant', content: rpgFirstMessage }] : []),
          ...(scraped ? [{ role: 'user', content: scrapeMessage(scraped.url, scraped.content) }] : []),
        ]),
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
      e2eeContext = await createE2eeSession({ apiKey: runApiKey, modelId: selection.modelId })
    } catch (err) {
      throw new CliError(`Error: ${formatError(err)}`)
    }
  }

  const ttyOut = process.stdout.isTTY === true
  // Piped stdout buffers nothing: content deltas stream to stdout as they
  // arrive. Track the last emitted char so the trailing-newline contract is
  // preserved exactly (a bare newline for an empty answer).
  let pipedLastChar = ''
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigint)

  let result
  try {
    const completionOpts = {
      apiKey: runApiKey,
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
        budget: runBudget,
        smoothStreaming: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
        smoothSpeed,
        compactThinking: compactThinking && ttyOut,
      })
      console.log(connectedBanner(segments))
      const render = createStreamRenderer({
        markdown: true,
        smooth: opts.smoothStreaming !== false && prefs.smoothStreaming !== false,
        smoothCharsPerTick: cpsToCharsPerTick(smoothSpeed),
        compactThinking: compactThinking && ttyOut,
        // RPG one-shot: the reply is spoken by the character, so the
        // character marker labels it instead of `❯ Answer` (same replacement
        // as the chat REPL, see MEMORY.md §Display consistency contract).
        assistantMarker: rpgCharName ? char(rpgCharName) : null,
      })
      // Anchor the compact-thinking meter clock at request start so the
      // checkpoint reports the real wait even when the endpoint flushes the
      // reasoning in one burst.
      render.turnStartedAt = performance.now()
      result = await provider.chatCompletion({
        ...completionOpts,
        onToken: render,
        onSources: (sources) => {
          render.sources = sources
        },
      })
      await render.flush()
    } else {
      result = await provider.chatCompletion({
        ...completionOpts,
        onToken: (text, type) => {
          // Piped stdout stays raw answer-only: stream content deltas, sanitize
          // each chunk (same per-chunk level as the TTY renderer), and never
          // emit reasoning, markers, sources or non-text parts.
          if (type !== 'content') return
          const clean = sanitizeAnsi(text)
          if (!clean) return
          process.stdout.write(clean)
          pipedLastChar = clean.slice(-1)
        },
      })
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
    sessionsDir: dir,
  })

  // Artifact lines go to stderr when piped so stdout stays pure content;
  // sources and the malformed-chunk notice are TTY-only (same styling as chat).
  printArtifactsSummary(producedResults, result, ttyOut ? process.stdout : process.stderr, {
    withSources: ttyOut,
    withSkipped: ttyOut,
  })

  if (result.content || result.parts?.length > 0) {
    const msg = { role: 'assistant', content: result.content }
    if (result.reasoning) {
      msg.reasoning = result.reasoning
      if (result.reasoningMs != null) msg.reasoningMs = result.reasoningMs
    }
    if (result.usage) msg.usage = result.usage
    if (result.sources?.length > 0) msg.sources = result.sources
    messages.push(msg)
  }

  // Record usage in both the TTY and piped paths so the persisted
  // cost summary below is authoritative (the resume/list/export paths
  // prefer it over replay); the turn metrics footer stays TTY-only.
  if (result.usage) {
    tracker.record(result.usage, selection.pricing)
  }
  if (ttyOut) {
    if (result.usage) {
      tracker.printTurn(result.usage, selection.pricing, selection.contextLength)
      if (runBudget != null) {
        const line = budgetLine(tracker.cost, runBudget)
        if (line) console.log(`  ${line}`)
      }
    }
  } else {
    // The content was already streamed to stdout as the deltas arrived; only
    // guarantee the trailing-newline contract (a bare newline for an empty
    // answer, matching the pre-stream behavior).
    if (pipedLastChar !== '\n') process.stdout.write('\n')
  }

  const state = new ChatState({
    modelId: selection.modelId,
    endpointProviderName: selection.endpointProviderName,
    reasoningEffort: selection.reasoningEffort,
    temperature,
    topP,
    budget: runBudget,
    webSearch,
    webSearchExplicit,
    webResults,
    zdr,
    e2ee,
    pricing: selection.pricing,
    contextLength: selection.contextLength,
    sessionId,
    createdAt,
    messages,
    reasoningMandatory: selection.modelReasoning?.mandatory === true,
    // A resumed session rewrites its own file, so the persisted count must
    // survive exactly like the interactive resume path.
    scrapes: (resumed?.scrapes ?? 0) + (scraped ? 1 : 0),
  })
  // --no-save leaves no file behind: the claim this run created is removed
  // instead of filled in. A resumed run never claimed one, and its own file
  // must stay untouched.
  if (opts.save === false) {
    if (!resumed) await removeEmptySessionClaim(dir, sessionId)
    return
  }

  // Persist the authoritative cost summary with the session file.
  state.costSummary = trackerCostSummary(tracker)
  const finalState = state.toFinalState(provider.meta.name)

  await persistSession({ finalState, prefs, config: opts.config, rpgDir: opts.rpg, rpgCharName, rpgUserName, rpgFirstMessage })
}
