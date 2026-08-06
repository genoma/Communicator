import { UsageTracker, budgetLine } from './tracker.js'
import { formatError, ApiError } from './errors.js'
import { extractPartialToken } from './sse-parser.js'
import { printSources } from './ui/stream.js'
import { dim } from './ui/style.js'
import { debug } from './ui/io.js'

// Shared per-session mutable state: the runner and the signal handlers in
// chat.js both touch these fields, and /new replaces the tracker.
export function createSessionState() {
  return {
    tracker: new UsageTracker(),
    budgetWarned: false,
    streaming: false,
    streamController: null,
    interrupted: false,
  }
}

export function createTurnRunner({ state, provider, apiKey, render, loader, stdout, tty, saveCurrentSession, interruptSave = saveCurrentSession, exit, sessionState }) {
  const runTurn = async () => {
    let apiResult
    let streamedContent = ''
    let streamedReasoning = ''

    render.sources = []
    sessionState.streaming = true
    sessionState.streamController = new AbortController()
    sessionState.interrupted = false

    try {
      stdout.write('\n')
      if (tty) loader.start(state.webSearch === 'always' ? 'Searching the web' : 'Waiting for response')
      apiResult = await provider.chatCompletion({
        apiKey,
        model: state.modelId,
        messages: state.messages,
        onToken: (token, type) => {
          if (type === 'reasoning' || type === 'content') loader.stop({ done: true })
          if (type === 'reasoning') streamedReasoning += token
          else if (type === 'content') streamedContent += token
          render(token, type)
        },
        onSources: (sources) => {
          render.sources = sources
        },
        provider: state.endpointProviderName,
        reasoningEffort: state.reasoningEffort,
        supportsReasoning: state.supportsReasoning,
        sessionId: state.sessionId,
        temperature: state.temperature,
        webSearch: state.webSearch,
        webResults: state.webResults,
        zdr: state.zdr,
        signal: sessionState.streamController.signal,
      })
      loader.stop()
      await render.flush()
      stdout.write('\n\n')

      if (apiResult.sources?.length > 0) {
        printSources(apiResult.sources, stdout)
      }

      if (apiResult.skippedChunks > 0) {
        console.log(`${dim(`${apiResult.skippedChunks} malformed stream chunk${apiResult.skippedChunks > 1 ? 's' : ''} skipped`)}\n`)
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
        sessionState.tracker.printTurn(apiResult.usage, state.pricing, state.contextLength, budgetNote)
      }
    } catch (err) {
      loader.stop()
      if (sessionState.interrupted) {
        render.flush({ sync: true })
        stdout.write('\n')
        const partial = { role: 'assistant', content: streamedContent }
        if (streamedReasoning) partial.reasoning = streamedReasoning
        if (render.sources?.length > 0) partial.sources = render.sources
        if (!partial.content && !partial.reasoning && err.pendingBuffer) {
          const pending = extractPartialToken(err.pendingBuffer)
          if (pending) {
            if (pending.type === 'reasoning') partial.reasoning = pending.text
            else partial.content = pending.text
          }
        }
        if (partial.content || partial.reasoning) {
          state.appendAssistant(partial)
        }
        await interruptSave()
        exit(130)
      }
      render.flush({ sync: true })
      debug(err?.stack)
      console.error(`\nError: ${formatError(err)}\n`)
      if (err instanceof ApiError && err.retryable) {
        state.messages.pop()
      }
      return
    } finally {
      sessionState.streaming = false
      sessionState.streamController = null
    }

    if (apiResult.content) {
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
      state.appendAssistant(msg)
    }
  }

  return { runTurn }
}
