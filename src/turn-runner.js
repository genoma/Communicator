import { UsageTracker, budgetLine } from './tracker.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { isEncryptedHex, decryptToken } from './e2ee.js'
import { debug } from './ui/io.js'
import { dim } from './ui/style.js'
import { printPostStreamMetrics } from './artifacts.js'
import { createStreamKeyMonitor as defaultStreamKeyMonitor } from './stream-keys.js'

// Shared per-session mutable state: the runner and the signal handlers in
// chat.js both touch these fields, and /new replaces the tracker.
export function createSessionState() {
  return {
    tracker: new UsageTracker(),
    budgetWarned: false,
    streaming: false,
    streamController: null,
    streamKeys: null,
    interrupted: false,
    stopped: false,
    stopping: false,
    // Arguments of the last turn-metrics footer (printTurn Tokens/Cost block)
    // on screen: the resize repaint rebuilds that footer from this snapshot.
    // null after /new and before the first successful turn.
    lastTurnMetrics: null,
  }
}

export function createTurnRunner({ state, provider, apiKey, render, loader, stdout, tty, saveCurrentSession, interruptSave = saveCurrentSession, exit, sessionState, requestFn, onRequest = null, postHistoryInstruction = null, input = process.stdin, createStreamKeyMonitor = defaultStreamKeyMonitor }) {
  const apiResultMessage = (apiResult) => {
    const msg = { role: 'assistant', content: apiResult.content }
    if (apiResult.reasoning) {
      msg.reasoning = apiResult.reasoning
      if (apiResult.reasoningMs != null) msg.reasoningMs = apiResult.reasoningMs
    }
    if (apiResult.usage) {
      msg.usage = apiResult.usage
    }
    if (apiResult.sources?.length > 0) {
      msg.sources = apiResult.sources
    }
    return msg
  }

  const runTurn = async () => {
    let apiResult
    // Tokens are accumulated as arrays and joined on demand: `+=` on the
    // growing string is quadratic in the answer length.
    const contentParts = []
    const reasoningParts = []
    // Streaming-phase raw-mode key listener (Esc stop / \x03 interrupt), torn
    // down in the finally and before exit so the terminal is never left raw.
    // Mirrored onto sessionState.streamKeys so the process-level
    // uncaughtException teardown can stop it even when the turn is mid-stream.
    let streamKeys = null

    render.sources = []
    render.resetMessage()
    // Anchor the compact-thinking meter clock at turn start (the user pressed
    // send): the checkpoint then reports the real wait even when the endpoint
    // flushes the reasoning in one burst. The renderer falls back to its own
    // clock when this is absent (one-shot / tests).
    render.turnStartedAt = performance.now()
    sessionState.streaming = true
    sessionState.streamController = new AbortController()
    sessionState.interrupted = false
    sessionState.stopped = false
    sessionState.stopping = false

    // Ctrl+C (SIGINT while streaming, or the \x03 byte once raw mode disables
    // ISIG) aborts the stream; the runner salvages the partial and exits 130.
    const requestInterrupt = () => {
      // A Ctrl+C landing while an Esc stop is finalizing must not flip the
      // catch to the interrupted/exit-130 branch: first keypress intent wins.
      if (!sessionState.streaming || sessionState.stopping) return
      sessionState.interrupted = true
      sessionState.streamController?.abort()
    }

    // Esc stops the generation: abort the fetch and finalize the delivered
    // partial as the turn result, returning to the prompt instead of exiting.
    // `stopping` guards against a second Esc while the stop is finalizing.
    const requestStop = () => {
      if (!sessionState.streaming || sessionState.stopping) return
      sessionState.stopping = true
      sessionState.stopped = true
      sessionState.streamController?.abort()
    }

    // Ctrl+C is also honored while the stream is draining (slow smooth
    // rendering, artifact downloads): save the response produced so far,
    // persist and exit 130.
    const interruptedExit = async (message) => {
      stopLoader()
      render.flush({ sync: true })
      stdout.write('\n')
      if (message.content || message.reasoning) {
        state.appendAssistant(message)
      }
      // Tear the raw mode down before the best-effort save so the terminal is
      // not left raw if that save is slow (or the process exits mid-save).
      streamKeys?.stop()
      await interruptSave()
      exit(130)
    }

    // Esc stop finalizes the delivered partial as the turn result and returns
    // to the prompt. With no output delivered the triggering user message is
    // popped so the next prompt is clean and /retry can replay it.
    const finishStopped = async (partial) => {
      const hasContent = partial.content || partial.reasoning
      if (hasContent) {
        state.appendAssistant(partial)
      } else if (state.messages[state.messages.length - 1]?.role === 'user') {
        state.retryTurn = state.messages.pop().content
      }
      await saveCurrentSession()
      return Boolean(hasContent)
    }

    const buildPartial = (err) => {
      const partial = { role: 'assistant', content: contentParts.join('') }
      if (reasoningParts.length > 0) partial.reasoning = reasoningParts.join('')
      // Mirror the success-path reasoning timestamp (see apiResultMessage) so
      // a stopped compact turn replays the `· Ns` duration the live meter
      // showed, never a count-only checkpoint.
      if (err?.reasoningMs != null && partial.reasoning) partial.reasoningMs = err.reasoningMs
      if (render.sources?.length > 0) partial.sources = render.sources
      if (!partial.content && !partial.reasoning && err?.pendingBuffer) {
        const pending = extractPartialToken(err.pendingBuffer)
        if (pending) {
          let text = pending.text
          if (state.e2ee && isEncryptedHex(text)) {
            try {
              text = decryptToken(text, state.e2eeContext.clientKey)
            } catch {
              text = null
            }
          }
          if (text != null) {
            if (pending.type === 'reasoning') partial.reasoning = text
            else partial.content = text
          }
        }
      }
      // A reasoning-less stopped turn resolved its loader/meter row to a green
      // checkpoint before the stop (exactly the success-path condition, see
      // the verdict block below): stash the label so history replay shows the
      // same line the live stream did, instead of dropping it.
      if (tty && contentParts.length > 0 && !partial.reasoning) {
        partial.waitLine = state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response'
      }
      return partial
    }

    // The wait indicator is the loader in full mode, the meter's waiting
    // phase in compact mode: the loader is only ever started (and therefore
    // only ever stopped) on the non-compact path — in compact mode the meter
    // owns the line and the subsequent render.flush() clears it.
    const stopLoader = () => {
      if (!render.compactThinking) loader.stop()
    }

    try {
      stdout.write('\n')
      if (tty) {
        // One blank row between the submitted user line and the marker row,
        // so every marker keeps exactly one blank line above it: the loader
        // line (or the compact meter checkpoint on it) is the first row of
        // the marker block, never glued to the user line.
        stdout.write('\n')
        if (render.compactThinking) {
          // Compact mode: the meter owns the line from turn start, showing
          // the wait label with a live clock (`Waiting for response · 2.3s`),
          // so a burst-delivered reasoning block never leaves the row frozen
          // on the plain spinner and the checkpoint counts from the send.
          render.startTurn(state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response')
        } else {
          loader.start(state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response')
        }
      }
      if (tty && input.isTTY) {
        streamKeys = createStreamKeyMonitor({ input, onStop: requestStop, onInterrupt: requestInterrupt })
        streamKeys.start()
        sessionState.streamKeys = streamKeys
      }
      apiResult = await provider.chatCompletion({
        apiKey,
        model: state.modelId,
        // The post-history instruction is injected at request time (never
        // stored in state.messages), so it stays out of the persisted
        // history while reaching the model after the latest user message.
        messages: postHistoryInstruction
          ? [...state.messages, { role: 'system', content: postHistoryInstruction }]
          : state.messages,
        onToken: (token, type) => {
          // When a thought block opens, the marker owns the loader's line in
          // FULL mode: bare stop, no checkmark, so the `❯ Thinking` label is
          // never appended to a live spinner row and the waiting checkmark
          // never leaks into a reasoning transcript. Reasoning tokens arrive
          // after start_reasoning, so they never stop the loader again; only
          // content resolves the waiting line when no reasoning intervened.
          // In compact mode the meter owns the line from turn start (startTurn
          // instead of loader.start), so the loader is never touched and
          // `start_reasoning` flips the meter to the counting phase inside the
          // renderer (keep the clock anchored); content with no reasoning
          // resolves the waiting phase through the renderer.
          if (type === 'start_reasoning') {
            if (tty && !render.compactThinking) loader.stop()
          } else if (type === 'content') {
            // Resolve the waiting row to the green checkpoint, then add
            // exactly one blank row before the answer — the same
            // one-blank-above-and-below marker spacing the thinking markers
            // get. The stop returns true only when it actually wrote the
            // checkpoint (spinner was visible), so an instant reply (nothing
            // within the grace window) and non-TTY output never gain a stray
            // blank row.
            if (render.compactThinking) {
              if (render.resolveWaitingLine()) stdout.write('\n')
            } else if (loader.stop({ done: true })) {
              stdout.write('\n')
            }
          }
          if (type === 'reasoning') reasoningParts.push(token)
          else if (type === 'content') contentParts.push(token)
          render(token, type)
        },
        onSources: (sources) => {
          render.sources = sources
        },
        provider: state.endpointProviderName,
        reasoningEffort: state.reasoningEffort,
        reasoningMandatory: state.reasoningMandatory === true,
        supportsReasoning: state.supportsReasoning,
        sessionId: state.sessionId,
        temperature: state.temperature,
        topP: state.topP,
        webSearch: state.webSearch,
        webResults: state.webResults,
        zdr: state.zdr,
        e2ee: state.e2ee,
        e2eeContext: state.e2eeContext,
        signal: sessionState.streamController.signal,
        onRequest,
      })
      stopLoader()
      await render.flush()
      if (sessionState.interrupted) {
        await interruptedExit(apiResultMessage(apiResult))
        return
      }
      if (sessionState.stopped) {
        stdout.write('\n\n')
        stdout.write(`${dim('Stopped')}\n\n`)
        return await finishStopped(buildPartial(null))
      }
      stdout.write('\n\n')

      const wroteMetrics = await printPostStreamMetrics(apiResult, {
        sessionId: state.sessionId,
        imageOutputSupported: state.imageOutputSupported,
        stdout,
        requestFn,
      })

      if (sessionState.interrupted) {
        await interruptedExit(apiResultMessage(apiResult))
        return
      }
      if (sessionState.stopped) {
        // The post-stream separator already provides the blank row above when
        // the metrics block printed nothing.
        if (wroteMetrics) stdout.write('\n\n')
        stdout.write(`${dim('Stopped')}\n\n`)
        return await finishStopped(buildPartial(null))
      }

      if (apiResult.usage) {
        sessionState.tracker.record(apiResult.usage, state.pricing)
        let budgetNote = null
        if (state.budget != null && !sessionState.budgetWarned) {
          const line = budgetLine(sessionState.tracker.cost, state.budget)
          if (line) {
            sessionState.budgetWarned = true
            budgetNote = line
          }
        }
        // Snapshot the footer arguments at turn time (pricing can change via
        // /model) so the resize repaint can reproduce the exact block.
        sessionState.lastTurnMetrics = {
          usage: apiResult.usage,
          pricing: state.pricing,
          contextLength: state.contextLength,
          budgetNote,
        }
        sessionState.tracker.printTurn(apiResult.usage, state.pricing, state.contextLength, budgetNote)
      }
    } catch (err) {
      stopLoader()
      if (sessionState.interrupted) {
        render.flush({ sync: true })
        stdout.write('\n')
        await interruptedExit(buildPartial(err))
        return
      }
      if (sessionState.stopped) {
        render.flush({ sync: true })
        stdout.write('\n\n')
        stdout.write(`${dim('Stopped')}\n\n`)
        return await finishStopped(buildPartial(err))
      }
      render.flush({ sync: true })
      debug(err?.stack)
      console.error(`\nError: ${formatError(err)}\n`)
      // A retryable failure drops the user message that triggered this turn
      // whenever it is still the last one, so it is never silently re-sent
      // with the next prompt (the /retry path re-runs an existing message
      // without appending a new one). The popped message (attachments
      // embedded in its content) is stashed as `retryTurn`: /retry replays
      // exactly this turn instead of re-running the previous one.
      if (err instanceof ApiError && err.retryable && state.messages[state.messages.length - 1]?.role === 'user') {
        state.retryTurn = state.messages.pop().content
      }
      return
    } finally {
      streamKeys?.stop()
      streamKeys = null
      sessionState.streamKeys = null
      sessionState.streaming = false
      sessionState.streamController = null
      sessionState.interrupted = false
      sessionState.stopped = false
      sessionState.stopping = false
    }

    // The verdict is what /retry and /edit need: true only when an assistant
    // message was appended, so callers can tell a successful replacement
    // (already rendered live, plus its metrics footer) from a failed turn
    // whose stale error/partial view still needs a screen wipe.
    if (apiResult.content) {
      const message = apiResultMessage(apiResult)
      // A reasoning-less turn owns the loader row: it resolved to the green
      // checkpoint (`✓ Waiting for response` / `✓ Searching the web`) with
      // one blank row below it before the answer. Stash the label on the
      // message so history replay (resize rebuild, resume) shows the same
      // line instead of silently dropping it. With reasoning, the thinking
      // marker (or the compact meter checkpoint) owns that row and no label
      // is stored.
      if (tty && !apiResult.reasoning) {
        message.waitLine = state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response'
      }
      state.appendAssistant(message)
      return true
    }
    return false
  }

  return { runTurn }
}
