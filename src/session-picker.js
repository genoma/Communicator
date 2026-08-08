import { checkbox } from '@inquirer/prompts'
import { formatSessionItem } from './sessions.js'
import { searchPrompt, pickerTheme } from './prompts.js'
import { sanitizeAnsi } from './ui/hyperlink.js'

export async function selectSession(sessions, { message = 'Select a session to resume' } = {}) {
  const choices = sessions.map((s) => {
    const { time, model, preview } = formatSessionItem(s)
    const previewText = preview ? `  "${preview.slice(0, 60)}${preview.length > 60 ? '...' : ''}"` : ''
    const desc = sanitizeAnsi(`${s.messageCount} messages  •  ${s.providerName}${s.providerType && s.providerType !== 'openrouter' ? ` (${s.providerType})` : ''}`)

    return {
      name: sanitizeAnsi(`${time}  ${model}${previewText}`),
      value: s.id,
      description: desc,
    }
  })

  return searchPrompt(message, choices, (all, input) => {
    const q = input.toLowerCase()
    return all.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q))
    )
  })
}

export async function selectSessions(sessions, { message = 'Select sessions' } = {}) {
  const choices = sessions.map((s) => {
    const { time, model, preview } = formatSessionItem(s)
    const previewText = preview ? `  "${preview.slice(0, 60)}${preview.length > 60 ? '...' : ''}"` : ''
    const desc = sanitizeAnsi(`${s.messageCount} messages  •  ${s.providerName}${s.providerType && s.providerType !== 'openrouter' ? ` (${s.providerType})` : ''}`)

    return {
      name: sanitizeAnsi(`${time}  ${model}${previewText}`),
      value: s.id,
      description: desc,
    }
  })

  return checkbox({ message, theme: pickerTheme, pageSize: 10, shortcuts: { all: 'a', invert: 'i' }, choices })
}
