import { checkbox } from '@inquirer/prompts'
import { formatSessionItem } from './ui/format.js'
import { formatCost } from './constants.js'
import { searchPrompt, pickerTheme } from './prompts.js'
import { sanitizeAnsi } from './ui/hyperlink.js'

function buildSessionChoices(sessions) {
  return sessions.map((s) => {
    const { time, model, preview, costSummary } = formatSessionItem(s)
    const previewText = preview ? `  "${preview.slice(0, 60)}${preview.length > 60 ? '...' : ''}"` : ''
    const costText = costSummary?.cost > 0 ? `  · ${formatCost(costSummary.cost)}` : ''
    const desc = sanitizeAnsi(`${s.messageCount} messages  •  ${s.providerName}${s.providerType && s.providerType !== 'openrouter' ? ` (${s.providerType})` : ''}`)

    return {
      name: sanitizeAnsi(`${time}  ${model}${costText}${previewText}`),
      value: s.id,
      description: desc,
    }
  })
}

export async function selectSession(sessions, { message = 'Select a session to resume' } = {}) {
  const choices = buildSessionChoices(sessions)

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
  return checkbox({ message, theme: pickerTheme, pageSize: 10, shortcuts: { all: 'a', invert: 'i' }, choices: buildSessionChoices(sessions) })
}
