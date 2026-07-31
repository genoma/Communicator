import { SSE_DATA_PREFIX, SSE_DONE } from './constants.js'

function unescapeJson(s) {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }
}

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

export async function parseSSEStream(reader, onToken) {
  const decoder = new TextDecoder()
  let fullText = ''
  let fullReasoning = ''
  let buffer = ''
  let inThinking = false
  let finalUsage = null

  while (true) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (err) {
      err.pendingBuffer = buffer
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
        // skip unparseable chunks
      }
    }
  }

  return { fullText, fullReasoning, finalUsage }
}
