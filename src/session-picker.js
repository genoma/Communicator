import { formatSessionItem } from './sessions.js'
import { searchPrompt } from './prompts.js'
import { sanitizeAnsi } from './ui/hyperlink.js'

export async function selectSession(sessions, { message = 'Select a session to resume' } = {}) {
  const choices = sessions.map((s) => {
    const { line } = formatSessionItem(s)

    return {
      name: sanitizeAnsi(line),
      value: s.id,
      description: sanitizeAnsi(`${s.title ? `"${s.title}"  •  ` : ''}${s.providerName}${s.providerType && s.providerType !== 'openrouter' ? ` (${s.providerType})` : ''}  •  ${s.messageCount} messages`),
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
