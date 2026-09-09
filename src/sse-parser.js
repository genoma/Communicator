import { SSE_DONE, STREAM_IDLE_TIMEOUT_MS, STREAM_NO_PROGRESS_TIMEOUT_MS, MAX_STREAM_BYTES } from './constants.js'
import { createHash } from 'node:crypto'
import { ApiError } from './errors.js'
import { isEncryptedHex } from './e2ee.js'

// True when an SSE stream error (a 200-status error event) is transient — an
// upstream rate-limit / at-capacity / congestion condition a /retry could
// recover from — as opposed to a permanent refusal or content filter.
function isTransientStreamError(type) {
  if (!type) return false
  return /rate[-_]?limit|overload|capacity|congestion|temporar|timeout/i.test(String(type))
}

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

export async function parseSSEStream(reader, onToken, onSources = null, { idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS, noProgressTimeoutMs = STREAM_NO_PROGRESS_TIMEOUT_MS, decryptToken = null, maxBytes = MAX_STREAM_BYTES, now = () => performance.now(), requestStartedAt = null } = {}) {
  const decoder = new TextDecoder()
  let receivedBytes = 0
  // Text accumulates in arrays and is joined once at the end: `+=` on the
  // growing string is quadratic in the answer length.
  const fullTextParts = []
  const fullReasoningParts = []
  // Reasoning deltas that arrive AFTER the first visible content (an
  // OpenRouter web-search burst flushes the whole reasoning block at the end)
  // are held here rather than dropped: merged into fullReasoningParts at
  // stream close so the stored/exported/replayed reasoning is complete, while
  // never emitting them through onToken (the thinking block must not re-open
  // mid-stream and print a second `✓ Thinking`/`❯ Answer` cycle).
  const lateReasoningParts = []
  let sawLateReasoning = false
  const fullParts = []
  const seenParts = new Set()
  // Fragments of the trailing line that no newline has terminated yet. Kept
  // as an array instead of a growing string because the parser must never
  // rescan bytes it has already searched: one SSE event larger than the
  // transport chunk size (the normal case for an inline data:image/... part)
  // carries no newline, and both `buffer.split('\n')` and `indexOf` over a
  // re-concatenated buffer re-walk the whole accumulated line on every read.
  // That is quadratic, and this loop is the hot path that runs while the
  // terminal is in raw mode — blocking it also freezes Esc-stop, Ctrl+C and
  // the smooth-streaming pump.
  const pending = []
  const pendingBuffer = () => pending.join('')
  let inThinking = false
  // True once the first visible content text is emitted. A reasoning delta
  // arriving AFTER content has started (OpenRouter web-search burst mode
  // flushes reasoning late) must not re-open the thinking block: the
  // renderer treats each start/end cycle as a full marker block, which
  // compact mode renders as a second `✓ Thinking` checkpoint + `❯ Answer` at
  // the bottom of the message. Late reasoning is dropped outright — never
  // stored, which would inflate the replayed checkpoint count against what
  // the live meter counted.
  let contentStarted = false
  // The thinking clock is anchored at request start (the moment the provider
  // fetch was dispatched, passed by the caller) so a fast/one-burst response
  // still reports the time the user actually waited, not the sub-millisecond
  // span between the first and last reasoning delta. Without a request clock
  // the anchor falls back to the first reasoning delta (byte-identical to the
  // pre-request-anchor behavior).
  let reasoningStartedAt = requestStartedAt ?? null
  let reasoningMs = null
  let finalUsage = null
  let finishReason = null
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

  // The stall guard has two layers. The per-read idle timer (no BYTES at
  // all) keeps its 60s budget; on top of it, keep-alives (`data:` with an
  // empty payload) are bytes but not progress, so a connection that only
  // heartbeats while the provider never answers must still fail loudly —
  // this no-progress timer (reset only by a non-empty data event) bounds
  // that hang. Armed at stream start, re-armed on every real event, cleared
  // in the finally below.
  let noProgressTimer = null
  let failCurrentRead = null
  const armNoProgress = () => {
    if (noProgressTimeoutMs <= 0) return
    if (noProgressTimer !== null) clearTimeout(noProgressTimer)
    noProgressTimer = setTimeout(() => {
      noProgressTimer = null
      const err = new ApiError(`Stream made no progress after ${Math.round(noProgressTimeoutMs / 1000)}s`, { retryable: true })
      err.pendingBuffer = pendingBuffer()
      failCurrentRead?.(err)
    }, noProgressTimeoutMs)
    noProgressTimer.unref?.()
  }

  const readChunk = () => new Promise((resolve, reject) => {
    failCurrentRead = reject
    let timer = null
    const onTimeout = () => {
      timer = null
      const err = new ApiError(`Stream stalled after ${Math.round(idleTimeoutMs / 1000)}s`, { retryable: true })
      err.pendingBuffer = pendingBuffer()
      reject(err)
    }
    reader.read().then(
      (chunk) => {
        if (timer !== null) clearTimeout(timer)
        failCurrentRead = null
        resolve(chunk)
      },
      (err) => {
        if (timer !== null) clearTimeout(timer)
        failCurrentRead = null
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
    reasoningMs = reasoningStartedAt !== null ? now() - reasoningStartedAt : null
    reasoningStartedAt = null
    onToken(null, 'end_reasoning')
  }

  // Content text is emitted through this single gate so the content-started
  // flag and the whitespace-only guard below can never be missed by a
  // final-only or delta-only delivery. The parser never edits visible
  // content: once a token passes the guard it is pushed verbatim, so a
  // leading space on the first content token is preserved exactly as the
  // provider (and model) emitted it.
  const pushContent = (text) => {
    // Before the first visible content, whitespace-only tokens are leading
    // noise (deepseek emits a lone ' '/newline as its very first content
    // token): drop them WITHOUT closing the gate, so a following ' The'
    // is still treated as the first visible content. Once content has
    // started, EVERY token is content — including whitespace-only ones:
    // the same model emits ' ' and '\n' as separate tokens mid-stream, and
    // dropping them merges words ('The"where'), eats newlines
    // ('1978\n- Terminal' → '1978- Terminal'), and corrupts the stored
    // session text.
    if (!contentStarted) {
      if (text.trim() === '') return
      contentStarted = true
    }
    fullTextParts.push(text)
    onToken(text, 'content')
  }

  // Reasoning text is emitted through this single gate (delta AND final
  // message delivery): the early/late split — a reasoning chunk arriving
  // after the first visible content is a burst-mode delivery, buffered for
  // stream close and never emitted live (the thinking block must not
  // re-open) — is identical for both delivery shapes.
  const emitReasoning = (text) => {
    if (!contentStarted) {
      fullReasoningParts.push(text)
      if (!inThinking) {
        inThinking = true
        if (reasoningStartedAt === null) reasoningStartedAt = now()
        onToken('\n', 'start_reasoning')
      }
      onToken(text, 'reasoning')
    } else if (text) {
      lateReasoningParts.push(text)
      sawLateReasoning = true
    }
  }

  let pendingDataLines = []
  const handleDataEvent = (data) => {
    if (data === SSE_DONE) return
    // Legitimate keep-alives arrive as an empty `data:` event; they are not
    // malformed chunks and must not surface in the skipped-chunk report.
    if (data.trim() === '') return
    // Any non-empty data event is progress: re-arm the no-progress timer
    // (clear+set inside armNoProgress), so an endless keep-alive-only stream
    // still fails loudly after the budget instead of hanging forever.
    armNoProgress()
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
      const message = typeof streamError === 'string' ? streamError : (streamError?.message || 'Provider error')
      const errorType = typeof streamError === 'object' && streamError ? (streamError.metadata?.error_type ?? streamError.type ?? null) : null
      const code = typeof streamError === 'object' && streamError?.code != null ? String(streamError.code) : null
      const status = typeof streamError === 'object' && streamError?.status != null ? streamError.status : null
      // Transient stream errors (upstream at-capacity / rate-limit / congestion)
      // are stashable for a user-initiated /retry; permanent errors (a content
      // refusal / filter) are not. Without a typed error the stream error stays
      // non-retryable — a started generation must never be auto-resent.
      throw new ApiError(message, {
        retryable: errorType ? isTransientStreamError(errorType) : false,
        code,
        errorType,
        ...(status != null ? { status } : {}),
      })
    }

    collectSources(parsed, fullSources, seenUrls, onSources)

    // Usage must not short-circuit content extraction: some providers attach
    // the full message on the same final chunk that carries usage.
    if (parsed.usage) finalUsage = parsed.usage

    const choice = parsed.choices?.[0]
    // The last non-null finish_reason (carried on the final chunk) is returned
    // so an empty-content turn can be classified (e.g. 'content_filter'), and
    // reused for the empty-verdict failure message.
    if (choice?.finish_reason != null) finishReason = choice.finish_reason
    const delta = choice?.delta
    const finalContent = choice?.message?.content
    // Some providers attach reasoning only on the final message object (no
    // reasoning deltas at all). Mirror the content dedup gate below: the
    // message snapshot duplicates streamed reasoning, so it is collected
    // only when NOTHING streamed (early or late). It is processed before
    // the content block (so message content closes the block it opens) and
    // before the `!delta` early return, which a message-only final chunk
    // would otherwise hit.
    const finalReasoning =
      (typeof choice?.message?.reasoning_content === 'string' ? choice?.message?.reasoning_content : undefined)
      ?? (typeof choice?.message?.reasoning === 'string' ? choice?.message?.reasoning : undefined)
    let finalReasoningEmitted = false
    if (finalReasoning && fullReasoningParts.length === 0 && lateReasoningParts.length === 0) {
      emitReasoning(maybeDecrypt(finalReasoning))
      finalReasoningEmitted = true
    }

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
            pushContent(maybeDecrypt(part.text))
            finalTextEmitted = true
          }
        } else {
          addPart(part)
        }
      }
    } else if (typeof finalContent === 'string' && fullTextParts.length === 0) {
      closeThinking()
      pushContent(maybeDecrypt(finalContent))
      finalTextEmitted = true
    }

    if (!delta) return

    const reasoningToken = delta.reasoning_content ?? (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
    if (reasoningToken && !finalReasoningEmitted) {
      // No early return here: providers may deliver `reasoning_content` and
      // `content` in the SAME delta (the transition chunk). Returning would
      // drop the content — and the final-message dedup gate would then
      // discard the full text only when no text was streamed, so the dropped
      // content was never recovered.
      // `finalReasoningEmitted` skips a same-chunk delta when the final
      // message already emitted it (a delta and a message snapshot carrying
      // the same reasoning on one chunk mirror the content path's
      // `finalTextEmitted` skip).
      emitReasoning(maybeDecrypt(reasoningToken))
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
          pushContent(maybeDecrypt(contentToken))
        }
      } else if (Array.isArray(contentToken)) {
        for (const part of contentToken) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            if (finalTextEmitted) continue
            pushContent(maybeDecrypt(part.text))
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
    armNoProgress()
    while (true) {
      let chunk
      try {
        chunk = await readChunk()
      } catch (err) {
        if (!err.pendingBuffer) err.pendingBuffer = pendingBuffer()
        // Mirror the clean-path reasoning-duration semantics (closeThinking)
        // for a stream interrupted while reading (Esc stop / Ctrl+C / idle
        // stall): stamp the elapsed reasoning time so the caller's replay
        // shows the same `· Ns` the live compact meter had, never a
        // count-only checkpoint. Reasoning already closed into content keeps
        // the duration captured at closeThinking. The open-thinking branch is
        // gated on `inThinking` because `reasoningStartedAt` is request-
        // anchored (never null when a request clock is supplied), so a
        // content-only abort must not stamp a fake reasoning duration.
        if (inThinking && reasoningStartedAt !== null) err.reasoningMs = now() - reasoningStartedAt
        else if (reasoningMs !== null) err.reasoningMs = reasoningMs
        throw err
      }
      const { done, value } = chunk
      if (done) {
        const tail = decoder.decode()
        if (tail) pending.push(tail)
        break
      }

      // Hard byte cap on the whole stream (slows-drips and newline-less
      // chunk lines included): a provider cannot accumulate text or buffer
      // memory without bound.
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        throw new ApiError(`Stream exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`, { retryable: false })
      }

      // Only the freshly decoded text is searched for newlines; everything
      // already in `pending` is known to hold none, so each byte is scanned
      // once over the whole stream.
      const text = decoder.decode(value, { stream: true })
      let from = 0
      let newline = text.indexOf('\n')
      while (newline !== -1) {
        const piece = text.slice(from, newline)
        if (pending.length === 0) handleLine(piece)
        else {
          pending.push(piece)
          handleLine(pending.join(''))
          pending.length = 0
        }
        from = newline + 1
        newline = text.indexOf('\n', from)
      }
      if (from < text.length) pending.push(text.slice(from))
    }

    for (const line of pendingBuffer().split('\n')) {
      handleLine(line)
    }
    if (pendingDataLines.length > 0) {
      handleDataEvent(pendingDataLines.join('\n'))
    }
    // A stream that ends mid-thinking (reasoning deltas with no content
    // delta) must still close the thinking block for the renderer.
    closeThinking()
    // Late-reasoning bridge (OpenRouter web-search burst): reasoning deltas
    // that arrived after content started were buffered, never emitted live.
    // Fold them into the stored reasoning so the session/export/replay keep
    // the full thinking, and re-stamp the duration from the request anchor
    // (closeThinking may have stamped a too-early value based on only the
    // early reasoning that preceded content).
    if (lateReasoningParts.length > 0) {
      for (const part of lateReasoningParts) fullReasoningParts.push(part)
      // OVERRIDE whatever closeThinking stamped: the real wait covers the
      // whole stream (the late blob arrives at the very end).
      if (reasoningStartedAt != null) reasoningMs = now() - reasoningStartedAt
      else if (requestStartedAt != null) reasoningMs = now() - requestStartedAt
    }
  } finally {
    if (noProgressTimer !== null) clearTimeout(noProgressTimer)
    noProgressTimer = null
    // A stall or stream error must not leave the connection parked until the
    // server closes it; cancelling the reader aborts the fetch. A fully
    // consumed stream cancels as a no-op.
    await reader.cancel?.().catch(() => {})
  }

  return { fullText: fullTextParts.join(''), fullReasoning: fullReasoningParts.join(''), finalUsage, fullSources, skippedChunks, fullParts, reasoningMs, finishReason, lateReasoning: sawLateReasoning }
}
