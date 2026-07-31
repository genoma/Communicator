import { writeFile } from 'node:fs/promises'
import { formatCost } from './constants.js'
import { computeTurnCost } from './tracker.js'

function formatTimestamp(iso) {
  if (!iso) return 'Unknown'
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '') + ' UTC'
}

function calculateCost(pricing, messages) {
  if (!pricing?.prompt || !pricing?.completion) return null

  let totalCost = 0
  let hasUsage = false

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.usage) {
      hasUsage = true
      totalCost += computeTurnCost(msg.usage, pricing)
    }
  }

  if (!hasUsage) return null
  return totalCost
}

export function formatMarkdown(sessionData) {
  const { model, providerName, reasoningEffort, pricing, createdAt, messages } = sessionData
  const visibleMessages = (messages || []).filter((m) => m.role !== 'system')
  const cost = calculateCost(pricing, messages)

  let md = ''

  const time = formatTimestamp(createdAt)
  md += `# Chat Session — ${time}\n\n`
  md += `**Model:** \`${model || 'unknown'}\``
  if (providerName) md += ` | **Provider:** ${providerName}`
  md += ` | **Messages:** ${visibleMessages.length}`
  if (reasoningEffort) md += ` | **Reasoning:** ${reasoningEffort}`
  md += ` | **Cost:** ${formatCost(cost)}`
  md += '\n\n---\n\n'

  for (const msg of visibleMessages) {
    if (msg.role === 'user') {
      md += '## You\n\n'
      md += `> ${msg.content}\n\n`
    } else if (msg.role === 'assistant') {
      md += '## Assistant\n\n'
      if (msg.reasoning) {
        md += '### thinking\n\n'
        md += `${msg.reasoning}\n\n`
      }
      md += '### Answer\n\n'
      md += `${msg.content}\n\n`
    }
    md += '---\n\n'
  }

  return md.trimEnd() + '\n'
}

export async function exportSession(sessionData, outputPath) {
  const markdown = formatMarkdown(sessionData)
  await writeFile(outputPath, markdown)
  return outputPath
}
