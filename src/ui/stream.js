import { dim, italic, you, thinking, answer } from './style.js'
import { createMarkdownRenderer, renderText } from './markdown.js'
import { hyperlink } from './hyperlink.js'
import { SMOOTH_CHARS_PER_TICK, SMOOTH_TICK_MS } from '../constants.js'
import { contentText, contentAttachments } from '../attachments.js'

export function createStreamRenderer({ markdown = false, stdout = process.stdout, smooth = false, smoothCharsPerTick = SMOOTH_CHARS_PER_TICK, smoothTickMs = SMOOTH_TICK_MS } = {}) {
  const md = createMarkdownRenderer({
    getSources: () => render.sources,
    stdout,
    partialFlushMs: smooth ? smoothTickMs : undefined,
  })

  const queue = []
  let pumpTimer = null
  let drainWaiter = null

  const writeSegment = (type, text) => {
    if (type === 'start_reasoning') {
      stdout.write(`${thinking()}\n`)
      stdout.write(text)
    } else if (type === 'reasoning') {
      stdout.write(dim(text))
    } else if (type === 'end_reasoning') {
      stdout.write(`\n\n${answer()}\n\n`)
    } else if (type === 'content') {
      if (render.markdown) md.write(text)
      else stdout.write(text)
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
    if (!render.smooth) {
      writeSegment(type, token)
      return
    }
    queue.push({ type, text: token, marker: type === 'start_reasoning' || type === 'end_reasoning' })
    schedulePump()
  }
  render.markdown = markdown
  render.smooth = smooth
  render.smoothCharsPerTick = smoothCharsPerTick
  render.smoothTickMs = smoothTickMs
  render.sources = []
  render.flush = ({ sync = false } = {}) => {
    if (sync) {
      if (pumpTimer !== null) {
        clearTimeout(pumpTimer)
        pumpTimer = null
      }
      while (queue.length > 0) {
        const segment = queue.shift()
        writeSegment(segment.type, segment.text)
      }
      if (render.markdown) md.flush()
      return
    }
    if (queue.length === 0) {
      if (render.markdown) md.flush()
      return
    }
    if (drainWaiter) return drainWaiter.promise
    let resolveDrain
    const promise = new Promise((resolve) => { resolveDrain = resolve })
    drainWaiter = {
      promise,
      resolve: () => {
        if (render.markdown) md.flush()
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
    const link = label ? hyperlink(source.url, label) : null
    stdout.write(`${dim(`[${i + 1}]`)} ${italic(link || label || dim(source.url))}\n`)
  })
}

export function renderHistory(messages, { markdown = false, stdout = process.stdout } = {}) {
  if (!messages || messages.length <= 1) return

  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  stdout.write('\n')
  for (const msg of messages) {
    if (msg.role === 'user') {
      stdout.write(`${you()}\n${markdown ? renderText(contentText(msg.content)) : contentText(msg.content)}\n\n`)
      for (const att of contentAttachments(msg.content)) {
        stdout.write(`${dim(`${italic('attached')}: ${att.filename}`)}\n`)
      }
    } else if (msg.role === 'assistant') {
      if (msg.reasoning) {
        stdout.write(`${thinking()}\n\n`)
        stdout.write(`${dim(msg.reasoning)}\n`)
        stdout.write(`\n${answer()}\n\n`)
      }
      stdout.write(`${markdown ? renderText(contentText(msg.content)) : contentText(msg.content)}\n\n`)
    }
  }
}
