import { dim, italic, green, you, thinking, answer } from './style.js'
import { createMarkdownRenderer, renderText } from './markdown.js'
import { createWordWrap, wrapWords } from './wrap.js'
import { hyperlink, sanitizeAnsi, sanitizeSingleLine } from './hyperlink.js'
import { SMOOTH_CHARS_PER_TICK, SMOOTH_TICK_MS } from '../constants.js'
import { contentText, contentAttachments } from '../attachments.js'
import { createThinkingMeter } from './loader.js'
import { formatCompactCount, formatElapsedSeconds } from './format.js'

// The one attachment/artifact line format shared by history replay, live
// /attach confirmations, artifact reports and image outcomes: dim italic
// kind word, label, optional dim meta, then the undimmed link (OSC 8 escapes
// must not be styled) and a dim note.
export function attachmentLine(word, label, { meta = null, note = null, link = null } = {}) {
  const head = `${dim(`${italic(word)}: ${sanitizeAnsi(label)}`)}`
  const metaText = meta != null ? ` ${dim(`(${meta})`)}` : ''
  const noteText = note ? `  ${dim(note)}` : ''
  return `${head}${link ?? ''}${metaText}${noteText}`
}

export function createStreamRenderer({ markdown = false, stdout = process.stdout, smooth = false, smoothCharsPerTick = SMOOTH_CHARS_PER_TICK, smoothTickMs = SMOOTH_TICK_MS, assistantMarker = null, compactThinking = false, now = null } = {}) {
  const md = createMarkdownRenderer({
    getSources: () => render.sources,
    stdout,
    partialFlushMs: smooth ? smoothTickMs : undefined,
  })

  // Width is resolved lazily (per write): a mid-stream terminal resize folds
  // new text at the new width instead of the width at renderer creation.
  const cols = () => (typeof stdout.columns === 'number' ? stdout.columns : null)
  const reasoningWrap = createWordWrap({ stdout, cols, style: dim })
  const contentWrap = createWordWrap({ stdout, cols })

  const meter = createThinkingMeter({ stdout, now: now ?? undefined })

  const queue = []
  let pumpTimer = null
  let drainWaiter = null
  let messageStarted = false

  const writeSegment = (type, text) => {
    if (type === 'start_reasoning') {
      // The parser's marker token is a bare '\n'; it must not add a row here
      // (live and history replay then share the exact one-blank layout).
      stdout.write(`${thinking()}\n\n`)
    } else if (type === 'reasoning') {
      reasoningWrap.write(text)
    } else if (type === 'end_reasoning') {
      reasoningWrap.flush()
      stdout.write(`\n\n${answer()}\n\n`)
    } else if (type === 'content') {
      if (!messageStarted) {
        messageStarted = true
        if (assistantMarker) stdout.write(`${assistantMarker}\n\n`)
      }
      if (render.markdown) md.write(text)
      else contentWrap.write(text)
    }
  }

  // Compact mode: reasoning body is never printed; the meter owns the line.
  // The checkpoint line and the following Answer label keep the same spacing
  // as the full mode (`✓ Thinking · N\n\n❯ Answer\n\n`): one blank line above
  // and below every marker.
  const writeCompact = (type, text) => {
    if (type === 'start_reasoning') {
      meter.start()
    } else if (type === 'reasoning') {
      meter.update(text.length)
    } else if (type === 'end_reasoning') {
      meter.stop({ done: true })
      stdout.write(`\n${answer()}\n\n`)
    }
  }

  const pump = () => {
    pumpTimer = null
    let chars = 0
    while (queue.length > 0 && (queue[0].marker || chars < render.smoothCharsPerTick)) {
      const segment = queue.shift()
      if (segment.marker) {
        writeSegment(segment.type, segment.text)
        continue
      }
      const take = Math.min(segment.text.length, render.smoothCharsPerTick - chars)
      writeSegment(segment.type, segment.text.slice(0, take))
      chars += take
      if (take < segment.text.length) {
        queue.unshift({ ...segment, text: segment.text.slice(take) })
        break
      }
    }
    if (queue.length > 0) {
      schedulePump()
    } else if (drainWaiter) {
      const waiter = drainWaiter
      drainWaiter = null
      waiter.resolve()
    }
  }

  const schedulePump = () => {
    if (pumpTimer === null) {
      pumpTimer = setTimeout(pump, render.smoothTickMs)
      if (drainWaiter === null) pumpTimer.unref?.()
    }
  }

  const render = (token, type) => {
    // Produced artifact parts render after the turn (printArtifacts in
    // turn-runner/one-shot); skip them here so the smooth queue never sees
    // object tokens.
    if (type === 'image' || type === 'file') return
    // The parser delivers complete strings, so sanitizing here (once, before
    // the smooth pump can slice them) also covers sequences split across
    // pump chunks.
    const text = type === 'content' || type === 'reasoning' ? sanitizeAnsi(token) : token
    // Compact reasoning bypasses the queue entirely: the meter updates live
    // (and counts sanitized chars) while content keeps its pacing below.
    if (render.compactThinking && (type === 'start_reasoning' || type === 'reasoning' || type === 'end_reasoning')) {
      writeCompact(type, text)
      return
    }
    if (!render.smooth) {
      writeSegment(type, text)
      return
    }
    queue.push({ type, text, marker: type === 'start_reasoning' || type === 'end_reasoning' })
    schedulePump()
  }
  render.markdown = markdown
  render.smooth = smooth
  render.compactThinking = compactThinking
  render.smoothCharsPerTick = smoothCharsPerTick
  render.smoothTickMs = smoothTickMs
  render.sources = []
  render.resetMessage = () => {
    messageStarted = false
  }
  const flushBodies = () => {
    reasoningWrap.flush()
    if (render.markdown) md.flush()
    else contentWrap.flush()
  }

  render.flush = ({ sync = false } = {}) => {
    // Never leave a live meter line behind (interrupts, errors, aborted
    // streams): the checkpoint only comes from end_reasoning.
    meter.stop()
    if (sync) {
      if (pumpTimer !== null) {
        clearTimeout(pumpTimer)
        pumpTimer = null
      }
      while (queue.length > 0) {
        const segment = queue.shift()
        writeSegment(segment.type, segment.text)
      }
      flushBodies()
      return
    }
    if (queue.length === 0) {
      flushBodies()
      return
    }
    if (drainWaiter) return drainWaiter.promise
    let resolveDrain
    const promise = new Promise((resolve) => { resolveDrain = resolve })
    drainWaiter = {
      promise,
      resolve: () => {
        flushBodies()
        resolveDrain()
      },
    }
    if (pumpTimer === null) schedulePump()
    else pumpTimer.ref?.()
    return promise
  }

  return render
}

export function printSources(sources, stdout = process.stdout) {
  stdout.write(sourcesText(sources))
}

function sourcesText(sources) {
  if (!sources?.length) return ''
  let out = '\n'
  out += `${dim(`Sources (${sources.length})`)}\n`
  sources.forEach((source, i) => {
    let label = source.title
    if (!label) {
      try {
        label = new URL(source.url).hostname
      } catch {
        label = null
      }
    }
    label = sanitizeAnsi(label)
    const cleanUrl = sanitizeAnsi(source.url)
    const link = label && cleanUrl ? hyperlink(cleanUrl, label) : null
    out += `${dim(`[${i + 1}]`)} ${italic(link || label || dim(cleanUrl))}\n`
  })
  return out
}

export function renderHistory(messages, { markdown = false, stdout = process.stdout, userMarker = null, assistantMarker = null, compactThinking = false, tailBlank = true } = {}) {
  if (!messages || messages.length <= 1) return

  const cols = typeof stdout.columns === 'number' ? stdout.columns : null
  const wrapPlain = (text) => text.split('\n').map((line) => wrapWords(line, cols).join('\n')).join('\n')
  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  let out = '\n'
  for (const msg of messages) {
    if (msg.role === 'user') {
      // One blank line above and below the marker, then the body.
      out += `${userMarker ?? you()}\n\n${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`
      for (const att of contentAttachments(msg.content)) {
        out += `${attachmentLine('attached', att.filename, { meta: att.kind })}\n`
      }
    } else if (msg.role === 'assistant') {
      // Same marker sequence as the live stream (writeSegment): one blank
      // line above and below every marker.
      // Compact mode replays the live checkpoint (`✓ Thinking · N`) with the
      // count derived from the stored reasoning, never the body.
      if (msg.reasoning) {
        if (compactThinking) {
          const count = formatCompactCount(sanitizeAnsi(msg.reasoning).length)
          const duration = msg.reasoningMs != null ? ` · ${formatElapsedSeconds(msg.reasoningMs)}` : ''
          out += `${green('✓')} Thinking · ${count}${duration}\n\n${answer()}\n\n`
        } else {
          out += `${thinking()}\n\n`
          out += `${dim(wrapPlain(sanitizeAnsi(msg.reasoning)))}\n`
          out += `\n${answer()}\n\n`
        }
      }
      // A reasoning-less turn resolved its loader row to a green checkpoint
      // (`✓ Waiting for response`/`✓ Searching the web`): replay it exactly
      // as the live stream showed it — one blank row between the checkpoint
      // and the answer, the same one-blank-above-and-below marker spacing the
      // thinking markers get. Never stored on reasoning turns — the thinking
      // marker or the compact meter checkpoint owns that row instead.
      if (msg.waitLine) {
        out += `${green('✓')} ${sanitizeSingleLine(msg.waitLine)}\n\n`
      }
      if (assistantMarker) out += `${assistantMarker}\n\n`
      out += `${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), msg.sources || [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`
      for (const att of contentAttachments(msg.content)) {
        out += `${attachmentLine(att.kind, att.filename)}\n`
      }
      out += sourcesText(msg.sources)
    }
  }
  // Continuation redraws (/retry, /edit) end the transcript flush so the
  // rerun's leading '\n\n' leaves exactly one blank row under the last
  // message — the same one the live submitted line gets — never a doubled
  // gap from the transcript's own trailing blank.
  if (!tailBlank) out = out.replace(/\n+$/, '')
  stdout.write(out)
}
