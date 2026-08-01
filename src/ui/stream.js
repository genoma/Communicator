import { dim, italic, you, thinking, answer } from './style.js'
import { createMarkdownRenderer, renderText } from './markdown.js'
import { hyperlink } from './hyperlink.js'

export function createStreamRenderer({ markdown = false, stdout = process.stdout } = {}) {
  const md = createMarkdownRenderer({ getSources: () => render.sources, stdout })

  const render = (token, type) => {
    if (type === 'start_reasoning') {
      stdout.write(`${thinking()}\n`)
      stdout.write(token)
    } else if (type === 'reasoning') {
      stdout.write(dim(token))
    } else if (type === 'end_reasoning') {
      stdout.write(`\n\n${answer()}\n\n`)
    } else if (type === 'content') {
      if (render.markdown) md.write(token)
      else stdout.write(token)
    }
  }
  render.markdown = markdown
  render.sources = []
  render.flush = () => {
    if (render.markdown) md.flush()
  }

  return render
}

export function printSources(sources, stdout = process.stdout) {
  if (!sources?.length) return
  stdout.write('\n')
  stdout.write(`${dim('Sources')}\n`)
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
    stdout.write(`[${i + 1}] ${italic(link || label || dim(source.url))}\n`)
  })
}

export function renderHistory(messages, { markdown = false, stdout = process.stdout } = {}) {
  if (!messages || messages.length <= 1) return

  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  stdout.write('\n')
  for (const msg of messages) {
    if (msg.role === 'user') {
      stdout.write(`${you()}\n${markdown ? renderText(msg.content) : msg.content}\n\n`)
    } else if (msg.role === 'assistant') {
      if (msg.reasoning) {
        stdout.write(`${thinking()}\n\n`)
        stdout.write(`${dim(msg.reasoning)}\n`)
        stdout.write(`\n${answer()}\n\n`)
      }
      stdout.write(`${markdown ? renderText(msg.content) : msg.content}\n\n`)
    }
  }
}
