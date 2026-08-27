import { SSE_DONE, STREAM_IDLE_TIMEOUT_MS } from './constants.js'
import { createHash } from 'node:crypto'
import { ApiError } from './errors.js'
import { isEncryptedHex } from './e2ee.js'

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

function safeSourceUrl(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function collectSources(parsed, fullSources, seenUrls, onSources) {
  const choices = parsed.choices?.[0]
  const citations = parsed.venice_parameters?.web_search_citations
  const annotations = choices?.delta?.annotations ?? choices?.message?.annotations
  if (!citations && !annotations) return
  let found = false

  for (const citation of citations || []) {
    const url = safeSourceUrl(citation?.url)
    if (url && !seenUrls.has(url)) {
      seenUrls.add(url)
      fullSources.push({ title: citation.title || null, url })
      found = true
    }
  }

  for (const annotation of annotations || []) {
    const urlCitation = annotation?.url_citation
    const url = safeSourceUrl(urlCitation?.url)
    if (annotation?.type === 'url_citation' && url && !seenUrls.has(url)) {
      seenUrls.add(url)
      fullSources.push({ title: urlCitation.title || null, url })
      found = true
    }
  }

  if (found && onSources) onSources(fullSources)
}

export async function parseSSEStream(reader, onToken, onSources = null, { idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS, decryptToken = null } = {}) {
  const decoder = new TextDecoder()
  // Text accumulates in arrays and is joined once at the end: `+=` on the
  // growing string is quadratic in the answer length.
  const fullTextParts = []
  const fullReasoningParts = []
  const fullParts = []
  const seenParts = new Set()
  let buffer = ''
  let inThinking = false
  let reasoningStartedAt = null
  let reasoningMs = null
  let finalUsage = null
  let skippedChunks = 0
  const fullSources = []
  const seenUrls = new Set()

  // Non-text content parts (image_url / file) are surfaced as typed tokens so
  // the caller can save and render produced artifacts. Deduped by part shape
  // because some providers repeat parts between delta and final message.
  const addPart = (part) => {
    if (!part || typeof part !== 'object') return
    let rawKey = null
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      rawKey = `image:${part.image_url.url}`
    } else if (part.type === 'file' && typeof part.file?.file_data === 'string') {
      rawKey = `file:${part.file.file_data}`
    }
    if (rawKey === null) return
    const key = createHash('sha256').update(rawKey).digest('hex')
    if (seenParts.has(key)) return
    seenParts.add(key)
    fullParts.push(part)
    onToken(part, part.type === 'image_url' ? 'image' : 'file')
  }

  // E2EE providers deliver each delta as a hex-encrypted chunk; decryption
  // happens here so the caller only ever sees plaintext. E2EE mode fails
  // closed: a plaintext delta would mean the host silently downgraded the
  // stream, which the session contract forbids.
  const maybeDecrypt = (token) => {
    if (!decryptToken) return token
    if (!isEncryptedHex(token)) {
      throw new ApiError('E2EE stream delivered an unencrypted chunk — aborting.', { retryable: false })
    }
    return decryptToken(token)
  }

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

  // One start/end cycle per thinking block; the elapsed time feeds the
  // compact-thinking meter checkpoint and session replay.
  const closeThinking = () => {
    if (!inThinking) return
    inThinking = false
    reasoningMs = reasoningStartedAt !== null ? performance.now() - reasoningStartedAt : null
    reasoningStartedAt = null
    onToken(null, 'end_reasoning')
  }

  let pendingDataLines = []
  const handleDataEvent = (data) => {
    if (data === SSE_DONE) return
    // Legitimate keep-alives arrive as an empty `data:` event; they are not
    // malformed chunks and must not surface in the skipped-chunk report.
    if (data.trim() === '') return
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      skippedChunks++
      return
    }

    // Some providers surface errors as 200-status SSE events; without this
    // they would silently end the stream as an empty success.
    const streamError = parsed.error ?? parsed.choices?.[0]?.error
    if (streamError) {
      throw new ApiError(typeof streamError === 'string' ? streamError : (streamError?.message || 'Provider error'), { retryable: false })
    }

    collectSources(parsed, fullSources, seenUrls, onSources)

    // Usage must not short-circuit content extraction: some providers attach
    // the full message on the same final chunk that carries usage.
    if (parsed.usage) finalUsage = parsed.usage

    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    const finalContent = choice?.message?.content

    // Some providers attach the full message only on the final chunk; its
    // text duplicates what deltas already streamed, so non-text parts are
    // always collected but text is only emitted when nothing was streamed.
    // The delta may be an empty object on the final chunk, so the dedup
    // gate is based solely on the streamed text, never on the delta shape.
    let finalTextEmitted = false
    if (Array.isArray(finalContent)) {
      const noTextYet = fullTextParts.length === 0
      for (const part of finalContent) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          if (noTextYet) {
            closeThinking()
            const text = maybeDecrypt(part.text)
            fullTextParts.push(text)
            onToken(text, 'content')
            finalTextEmitted = true
          }
        } else {
          addPart(part)
        }
      }
    } else if (typeof finalContent === 'string' && fullTextParts.length === 0) {
      closeThinking()
      const text = maybeDecrypt(finalContent)
      fullTextParts.push(text)
      onToken(text, 'content')
      finalTextEmitted = true
    }

    if (!delta) return

    const reasoningToken = delta.reasoning_content ?? (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
    if (reasoningToken) {
      // No early return here: providers may deliver `reasoning_content` and
      // `content` in the SAME delta (the transition chunk). Returning would
      // drop the content — and the final-message dedup gate would then
      // discard the full text only when no text was streamed, so the dropped
      // content was never recovered.
      const text = maybeDecrypt(reasoningToken)
      fullReasoningParts.push(text)
      if (!inThinking) {
        inThinking = true
        reasoningStartedAt = performance.now()
        onToken('\n', 'start_reasoning')
      }
      onToken(text, 'reasoning')
    }

    const contentToken = delta.content
    // An EMPTY content payload (`content: ''`, `content: []`) is not the
    // thinking→content transition: reasoning streams commonly carry an empty
    // content field on every delta, and closing the block there would re-open
    // it on the next reasoning delta — a start/end cycle per delta, which
    // compact mode renders as a checkpoint line per reasoning chunk.
    const hasContent = contentToken != null &&
      (typeof contentToken === 'string' ? contentToken !== '' : Array.isArray(contentToken) ? contentToken.length > 0 : true)
    if (hasContent) {
      closeThinking()
      if (typeof contentToken === 'string' && contentToken) {
        // Skip delta text when the same chunk already emitted the final
        // message content (it duplicates it exactly).
        if (!finalTextEmitted) {
          const text = maybeDecrypt(contentToken)
          fullTextParts.push(text)
          onToken(text, 'content')
        }
      } else if (Array.isArray(contentToken)) {
        for (const part of contentToken) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            if (finalTextEmitted) continue
            const text = maybeDecrypt(part.text)
            fullTextParts.push(text)
            onToken(text, 'content')
          } else {
            addPart(part)
          }
        }
      }
    }
  }

  const handleLine = (line) => {
    const trimmed = line.trim()
    const match = trimmed.match(/^data: ?(.*)$/)
    if (match) {
      // Per the SSE spec consecutive `data:` lines form ONE event whose
      // payload is the lines joined with \n; parsing each line alone would
      // drop events split across multiple lines (e.g. a delta containing an
      // embedded newline). The event is only parsed at the boundary (a blank
      // line or EOF), when the data: sequence ends.
      pendingDataLines.push(match[1])
      return
    }
    if (trimmed === '' && pendingDataLines.length > 0) {
      const data = pendingDataLines.join('\n')
      pendingDataLines = []
      handleDataEvent(data)
    }
  }

  try {
    while (true) {
      let chunk
      try {
        chunk = await readChunk()
      } catch (err) {
        if (!err.pendingBuffer) err.pendingBuffer = buffer
        throw err
      }
      const { done, value } = chunk
      if (done) {
        buffer += decoder.decode()
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        handleLine(line)
      }
    }

    for (const line of buffer.split('\n')) {
      handleLine(line)
    }
    if (pendingDataLines.length > 0) {
      handleDataEvent(pendingDataLines.join('\n'))
    }
    // A stream that ends mid-thinking (reasoning deltas with no content
    // delta) must still close the thinking block for the renderer.
    closeThinking()
  } finally {
    // A stall or stream error must not leave the connection parked until the
    // server closes it; cancelling the reader aborts the fetch. A fully
    // consumed stream cancels as a no-op.
    await reader.cancel?.().catch(() => {})
  }

  return { fullText: fullTextParts.join(''), fullReasoning: fullReasoningParts.join(''), finalUsage, fullSources, skippedChunks, fullParts, reasoningMs }
}
