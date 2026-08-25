import { dim, italic, green, you, thinking, answer } from './style.js'
import { createMarkdownRenderer, renderText } from './markdown.js'
import { createWordWrap, wrapWords } from './wrap.js'
import { hyperlink, sanitizeAnsi } from './hyperlink.js'
import { SMOOTH_CHARS_PER_TICK, SMOOTH_TICK_MS } from '../constants.js'
import { contentText, contentAttachments } from '../attachments.js'
import { createThinkingMeter } from './loader.js'
import { formatCompactCount } from './format.js'

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

export function createStreamRenderer({ markdown = false, stdout = process.stdout, smooth = false, smoothCharsPerTick = SMOOTH_CHARS_PER_TICK, smoothTickMs = SMOOTH_TICK_MS, assistantMarker = null, compactThinking = false } = {}) {
  const md = createMarkdownRenderer({
    getSources: () => render.sources,
    stdout,
    partialFlushMs: smooth ? smoothTickMs : undefined,
  })

  const cols = typeof stdout.columns === 'number' ? stdout.columns : null
  const reasoningWrap = createWordWrap({ stdout, cols, style: dim })
  const contentWrap = createWordWrap({ stdout, cols })

  const meter = createThinkingMeter({ stdout })

  const queue = []
  let pumpTimer = null
  let drainWaiter = null
  let messageStarted = false

  const writeSegment = (type, text) => {
    if (type === 'start_reasoning') {
      stdout.write(`${thinking()}\n`)
      stdout.write(text)
    } else if (type === 'reasoning') {
      reasoningWrap.write(text)
    } else if (type === 'end_reasoning') {
      reasoningWrap.flush()
      stdout.write(`\n\n${answer()}\n\n`)
    } else if (type === 'content') {
      if (!messageStarted) {
        messageStarted = true
        if (assistantMarker) stdout.write(`${assistantMarker}\n`)
      }
      if (render.markdown) md.write(text)
      else contentWrap.write(text)
    }
  }

  // Compact mode: reasoning body is never printed; the meter owns the line.
  // The checkpoint line and the following Answer label keep the same spacing
  // as the full mode (`✓ Thinking · N\n\n❯ Answer\n\n`).
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
  if (!sources?.length) return
  stdout.write('\n')
  stdout.write(`${dim(`Sources (${sources.length})`)}\n`)
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
    stdout.write(`${dim(`[${i + 1}]`)} ${italic(link || label || dim(cleanUrl))}\n`)
  })
}

export function renderHistory(messages, { markdown = false, stdout = process.stdout, userMarker = null, assistantMarker = null, compactThinking = false } = {}) {
  if (!messages || messages.length <= 1) return

  const cols = typeof stdout.columns === 'number' ? stdout.columns : null
  const wrapPlain = (text) => text.split('\n').map((line) => wrapWords(line, cols).join('\n')).join('\n')
  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  stdout.write('\n')
  for (const msg of messages) {
    if (msg.role === 'user') {
      stdout.write(`${userMarker ?? you()}\n${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`)
      for (const att of contentAttachments(msg.content)) {
        stdout.write(`${attachmentLine('attached', att.filename, { meta: att.kind })}\n`)
      }
    } else if (msg.role === 'assistant') {
      // Same marker sequence as the live stream (writeSegment): one newline
      // after the thinking label, one blank line before the answer label.
      // Compact mode replays the live checkpoint (`✓ Thinking · N`) with the
      // count derived from the stored reasoning, never the body.
      if (msg.reasoning) {
        if (compactThinking) {
          const count = formatCompactCount(sanitizeAnsi(msg.reasoning).length)
          stdout.write(`${green('✓')} Thinking · ${count}\n\n${answer()}\n\n`)
        } else {
          stdout.write(`${thinking()}\n`)
          stdout.write(`${dim(wrapPlain(sanitizeAnsi(msg.reasoning)))}\n`)
          stdout.write(`\n${answer()}\n\n`)
        }
      }
      if (assistantMarker) stdout.write(`${assistantMarker}\n`)
      stdout.write(`${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), msg.sources || [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`)
      for (const att of contentAttachments(msg.content)) {
        stdout.write(`${attachmentLine(att.kind, att.filename)}\n`)
      }
      if (msg.sources?.length) {
        printSources(msg.sources, stdout)
      }
    }
  }
}
