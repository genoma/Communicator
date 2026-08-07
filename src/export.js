import { writeFile } from 'node:fs/promises'
import { formatCost } from './constants.js'
import { computeTurnCost } from './tracker.js'
import { contentText, contentAttachments } from './attachments.js'
import { formatSessionTime } from './sessions.js'

function calculateCost(pricing, messages) {
  if (pricing?.prompt == null || pricing?.completion == null) return null

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

const CITATION = /\^(\d+(?:,\d+)*)\^/g

const SAFE_LINK_RE = /^https?:\/\//i

// Exported markdown is opened in HTML-capable viewers, so raw HTML from
// model/user content and non-http(s) link schemes are neutralized.
function escapeHtml(text) {
  return String(text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeLink(url) {
  return typeof url === 'string' && SAFE_LINK_RE.test(url) ? url : null
}

function citationLinks(text, sources) {
  const raw = String(text ?? '')
  if (!sources || sources.length === 0) return raw
  return raw.replace(CITATION, (marker, nums) => {
    return nums.split(',').map((n) => {
      const source = sources[Number(n) - 1]
      const url = safeLink(source?.url)
      return url ? `[${n}](${url})` : `^${n}^`
    }).join(' ')
  })
}

function sourcesList(sources) {
  if (!sources || sources.length === 0) return ''
  const lines = ['**Sources:**']
  for (const source of sources) {
    const url = safeLink(source?.url)
    let parsed
    try {
      parsed = url ? new URL(url) : null
    } catch {
      parsed = null
    }
    const label = escapeHtml(source?.title) || (parsed ? parsed.hostname : null)
    if (parsed && label) lines.push(`- [${label}](${url})`)
    else if (label) lines.push(`- ${label}`)
    else lines.push(`- ${escapeHtml(source?.url || '')}`)
  }
  return lines.join('\n')
}

export function formatMarkdown(sessionData) {
  const { model, providerName, reasoningEffort, pricing, createdAt, messages, title } = sessionData
  const visibleMessages = (messages || []).filter((m) => m.role !== 'system')
  const cost = calculateCost(pricing, messages)

  let md = ''

  const time = formatSessionTime(createdAt, { utc: true })
  md += `# Chat Session — ${time}\n\n`
  if (title) md += `**Title:** ${escapeHtml(title)}\n\n`
  md += `**Model:** \`${escapeHtml(model) || 'unknown'}\``
  if (providerName) md += ` | **Provider:** ${escapeHtml(providerName)}`
  md += ` | **Messages:** ${visibleMessages.length}`
  if (reasoningEffort) md += ` | **Reasoning:** ${escapeHtml(reasoningEffort)}`
  md += ` | **Cost:** ${formatCost(cost)}`
  md += '\n\n---\n\n'

  for (const msg of visibleMessages) {
    if (msg.role === 'user') {
      md += '## You\n\n'
      md += `> ${escapeHtml(contentText(msg.content))}\n\n`
      for (const att of contentAttachments(msg.content)) {
        md += `> **Attachment:** \`${escapeHtml(att.filename)}\`\n\n`
      }
    } else if (msg.role === 'assistant') {
      md += '## Assistant\n\n'
      if (msg.reasoning) {
        md += '### thinking\n\n'
        md += `${escapeHtml(msg.reasoning)}\n\n`
      }
      md += '### Answer\n\n'
      md += `${citationLinks(escapeHtml(contentText(msg.content)), msg.sources)}\n\n`
      for (const att of contentAttachments(msg.content)) {
        const kind = att.kind === 'image' ? 'Image' : 'File'
        md += att.url
          ? `> **${kind}:** [${escapeHtml(att.filename)}](${att.url})\n\n`
          : `> **${kind}:** \`${escapeHtml(att.filename)}\`\n\n`
      }
      const list = sourcesList(msg.sources)
      if (list) md += `${list}\n\n`
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
