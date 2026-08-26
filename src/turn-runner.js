import { UsageTracker, budgetLine } from './tracker.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { isEncryptedHex, decryptToken } from './e2ee.js'
import { debug } from './ui/io.js'
import { printPostStreamMetrics } from './artifacts.js'

// Shared per-session mutable state: the runner and the signal handlers in
// chat.js both touch these fields, and /new replaces the tracker.
export function createSessionState() {
  return {
    tracker: new UsageTracker(),
    budgetWarned: false,
    streaming: false,
    streamController: null,
    interrupted: false,
    // Arguments of the last turn-metrics footer (printTurn Tokens/Cost block)
    // on screen: the resize repaint rebuilds that footer from this snapshot.
    // null after /new and before the first successful turn.
    lastTurnMetrics: null,
  }
}

export function createTurnRunner({ state, provider, apiKey, render, loader, stdout, tty, saveCurrentSession, interruptSave = saveCurrentSession, exit, sessionState, requestFn, onRequest = null, postHistoryInstruction = null }) {
  const apiResultMessage = (apiResult) => {
    const msg = { role: 'assistant', content: apiResult.content }
    if (apiResult.reasoning) {
      msg.reasoning = apiResult.reasoning
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

    render.sources = []
    render.resetMessage()
    sessionState.streaming = true
    sessionState.streamController = new AbortController()
    sessionState.interrupted = false

    // Ctrl+C is also honored while the stream is draining (slow smooth
    // rendering, artifact downloads): save the response produced so far,
    // persist and exit 130.
    const interruptedExit = async (message) => {
      loader.stop()
      render.flush({ sync: true })
      stdout.write('\n')
      if (message.content || message.reasoning) {
        state.appendAssistant(message)
      }
      await interruptSave()
      exit(130)
    }

    try {
      stdout.write('\n')
      if (tty) {
        // One blank row between the submitted user line and the marker row,
        // so every marker keeps exactly one blank line above it: the loader
        // line (or the compact meter checkpoint on it) is the first row of
        // the marker block, never glued to the user line.
        stdout.write('\n')
        loader.start(state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response')
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
          // BOTH modes: bare stop, no checkmark, so the `❯ Thinking` label
          // (or the compact meter checkpoint) is never appended to a live
          // spinner row and the waiting checkmark never leaks into a
          // reasoning transcript. Reasoning tokens arrive after
          // start_reasoning, so they never stop the loader again; only
          // content resolves the waiting line when no reasoning intervened.
          if (type === 'start_reasoning') {
            if (tty) loader.stop()
          } else if (type === 'content') {
            loader.stop({ done: true })
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
      loader.stop()
      await render.flush()
      if (sessionState.interrupted) {
        await interruptedExit(apiResultMessage(apiResult))
        return
      }
      stdout.write('\n\n')

      await printPostStreamMetrics(apiResult, {
        sessionId: state.sessionId,
        imageOutputSupported: state.imageOutputSupported,
        stdout,
        requestFn,
      })

      if (sessionState.interrupted) {
        await interruptedExit(apiResultMessage(apiResult))
        return
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
      loader.stop()
      if (sessionState.interrupted) {
        render.flush({ sync: true })
        stdout.write('\n')
        const partial = { role: 'assistant', content: contentParts.join('') }
        if (reasoningParts.length > 0) partial.reasoning = reasoningParts.join('')
        if (render.sources?.length > 0) partial.sources = render.sources
        if (!partial.content && !partial.reasoning && err.pendingBuffer) {
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
        await interruptedExit(partial)
        return
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
      sessionState.streaming = false
      sessionState.streamController = null
    }

    // The verdict is what /retry and /edit need: true only when an assistant
    // message was appended, so callers can tell a successful replacement
    // (already rendered live, plus its metrics footer) from a failed turn
    // whose stale error/partial view still needs a screen wipe.
    if (apiResult.content) {
      const message = apiResultMessage(apiResult)
      // A reasoning-less turn owns the loader row: it resolved to the green
      // checkpoint (`✓ Waiting for response` / `✓ Searching the web`) and the
      // answer started on the next row. Stash the label on the message so
      // history replay (resize rebuild, resume) shows the same line instead
      // of silently dropping it. With reasoning, the thinking marker (or the
      // compact meter checkpoint) owns that row and no label is stored.
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
