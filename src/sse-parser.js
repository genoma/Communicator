import { SSE_DATA_PREFIX, SSE_DONE, STREAM_IDLE_TIMEOUT_MS } from './constants.js'
import { ApiError } from './errors.js'

function unescapeJson(s) {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }
}

// Salvages the tail of an interrupted stream from the last buffered bytes.
// Heuristic, not a parser: scans for an unclosed `"content":"` or
// `"reasoning_content":"` JSON string and unescapes what follows. The
// `"reasoning_content"` match runs first, and the `"content"` pattern cannot
// match inside it (a `"` must directly precede `content`), so the two never
// alias. `unescapeJson` only guarantees \n and \t when the tail is truncated
// mid-escape; that is enough for the interrupted-stream salvage use case.
export function extractPartialToken(buffer) {
  const reasoningMatch = buffer.match(/"reasoning_content":"((?:[^"\\]|\\.)*)/)
  if (reasoningMatch) {
    return { type: 'reasoning', text: unescapeJson(reasoningMatch[1]) }
  }
  const contentMatch = buffer.match(/"content":"((?:[^"\\]|\\.)*)/)
  if (contentMatch) {
    return { type: 'content', text: unescapeJson(contentMatch[1]) }
  }
  return null
}

function collectSources(parsed, fullSources, seenUrls, onSources) {
  const choices = parsed.choices?.[0]
  const citations = parsed.venice_parameters?.web_search_citations
  const annotations = choices?.delta?.annotations ?? choices?.message?.annotations
  if (!citations && !annotations) return
  let found = false

  for (const citation of citations || []) {
    if (citation?.url && !seenUrls.has(citation.url)) {
      seenUrls.add(citation.url)
      fullSources.push({ title: citation.title || null, url: citation.url })
      found = true
    }
  }

  for (const annotation of annotations || []) {
    const urlCitation = annotation?.url_citation
    if (annotation?.type === 'url_citation' && urlCitation?.url && !seenUrls.has(urlCitation.url)) {
      seenUrls.add(urlCitation.url)
      fullSources.push({ title: urlCitation.title || null, url: urlCitation.url })
      found = true
    }
  }

  if (found && onSources) onSources(fullSources)
}

export async function parseSSEStream(reader, onToken, onSources = null, { idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = {}) {
  const decoder = new TextDecoder()
  let fullText = ''
  let fullReasoning = ''
  let buffer = ''
  let inThinking = false
  let finalUsage = null
  let skippedChunks = 0
  const fullSources = []
  const seenUrls = new Set()

  const readChunk = () => new Promise((resolve, reject) => {
    let timer = null
    const onTimeout = () => {
      timer = null
      const err = new ApiError(`Stream stalled after ${Math.round(idleTimeoutMs / 1000)}s`, { retryable: true })
      err.pendingBuffer = buffer
      reject(err)
    }
    reader.read().then(
      (chunk) => {
        if (timer !== null) clearTimeout(timer)
        resolve(chunk)
      },
      (err) => {
        if (timer !== null) clearTimeout(timer)
        reject(err)
      }
    )
    if (idleTimeoutMs > 0) timer = setTimeout(onTimeout, idleTimeoutMs)
  })

  while (true) {
    let chunk
    try {
      chunk = await readChunk()
    } catch (err) {
      if (!err.pendingBuffer) err.pendingBuffer = buffer
      throw err
    }
    const { done, value } = chunk
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith(SSE_DATA_PREFIX)) continue
      const data = trimmed.slice(SSE_DATA_PREFIX.length)
      if (data === SSE_DONE) continue
      try {
        const parsed = JSON.parse(data)

        collectSources(parsed, fullSources, seenUrls, onSources)

        if (parsed.usage) {
          finalUsage = parsed.usage
          continue
        }

        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue

        const reasoningToken = delta.reasoning_content ?? (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
        if (reasoningToken) {
          fullReasoning += reasoningToken
          if (!inThinking) {
            inThinking = true
            onToken('\n', 'start_reasoning')
          }
          onToken(reasoningToken, 'reasoning')
          continue
        }

        const contentToken = delta.content
        if (contentToken) {
          if (inThinking) {
            inThinking = false
            onToken(null, 'end_reasoning')
          }
          fullText += contentToken
          onToken(contentToken, 'content')
        }
      } catch {
        skippedChunks++
      }
    }
  }

  return { fullText, fullReasoning, finalUsage, fullSources, skippedChunks }
}
