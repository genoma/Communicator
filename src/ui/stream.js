import { THIN_SEP } from '../constants.js'
import { dim, thinking, answer } from './style.js'

export function createStreamRenderer() {
  return (token, type) => {
    if (type === 'start_reasoning') {
      process.stdout.write(`${thinking()}\n`)
      process.stdout.write(dim(token))
    } else if (type === 'reasoning') {
      process.stdout.write(dim(token))
    } else if (type === 'end_reasoning') {
      process.stdout.write(`\n\n${answer()}\n\n`)
    } else if (type === 'content') {
      process.stdout.write(token)
    }
  }
}

export function renderHistory(messages) {
  if (!messages || messages.length <= 1) return

  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  process.stdout.write('\n')
  for (const msg of messages) {
    if (msg.role === 'user') {
      process.stdout.write(`> ${msg.content}\n\n`)
    } else if (msg.role === 'assistant') {
      if (msg.reasoning) {
        process.stdout.write(`${thinking()}\n\n`)
        process.stdout.write(`${dim(msg.reasoning)}\n`)
        process.stdout.write(`\n${answer()}\n\n`)
      }
      process.stdout.write(`${msg.content}\n\n`)
    }
  }

  process.stdout.write(`${dim(THIN_SEP)}\n\n`)
}
