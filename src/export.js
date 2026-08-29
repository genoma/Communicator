import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatCost, CITATION_GROUP } from './constants.js'
import { computeTurnCost } from './tracker.js'
import { contentText, partLabel, partUrl } from './attachments.js'
import { dataUrlInfo } from './attachment-store.js'
import { formatSessionTime } from './ui/format.js'

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

const CITATION = new RegExp(`\\^${CITATION_GROUP}\\^`, 'g')

const SAFE_LINK_RE = /^https?:\/\//i

// Exported markdown is opened in HTML-capable viewers, so raw HTML from
// model/user content and non-http(s) link schemes are neutralized.
function escapeHtml(text) {
  return String(text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeLink(url) {
  return typeof url === 'string' && SAFE_LINK_RE.test(url) ? url : null
}

// Exported markdown keeps the model's own link syntax, but a clickable
// destination that is not http(s) (javascript:, data:, ...) would run in
// HTML-capable viewers. Such links degrade to their plain label text.
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g

function neutralizeLinkSchemes(text) {
  return String(text ?? '').replace(MARKDOWN_LINK_RE, (match, label, dest) => {
    return /^https?:\/\//i.test(dest) ? match : `[${label}]`
  })
}

function attachmentParts(content) {
  if (!Array.isArray(content)) return []
  return content.filter((p) => p.type === 'image_url' || p.type === 'file')
}

// Attachment names become file paths, so separators and control chars are
// stripped and degenerate names fall back to a fixed label.
function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/]/g, '')
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment'
  return cleaned
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1)
  const stem = dot === -1 ? name : name.slice(0, dot)
  let n = 2
  let candidate = dot === -1 ? `${stem}-2` : `${stem}-2.${ext}`
  while (used.has(candidate)) {
    n++
    candidate = dot === -1 ? `${stem}-${n}` : `${stem}-${n}.${ext}`
  }
  used.add(candidate)
  return candidate
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

export function formatMarkdown(sessionData, attachmentLink = null) {
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
      md += `> ${neutralizeLinkSchemes(escapeHtml(contentText(msg.content)))}\n\n`
      for (const part of attachmentParts(msg.content)) {
        const link = attachmentLink?.(part)
        md += link
          ? `> **Attachment:** [${escapeHtml(partLabel(part))}](${link})\n\n`
          : `> **Attachment:** \`${escapeHtml(partLabel(part))}\`\n\n`
      }
    } else if (msg.role === 'assistant') {
      md += '## Assistant\n\n'
      if (msg.reasoning) {
        md += '### thinking\n\n'
        md += `${escapeHtml(msg.reasoning)}\n\n`
      }
      md += '### Answer\n\n'
      md += `${citationLinks(neutralizeLinkSchemes(escapeHtml(contentText(msg.content))), msg.sources)}\n\n`
      for (const part of attachmentParts(msg.content)) {
        const kind = part.type === 'image_url' ? 'Image' : 'File'
        const label = escapeHtml(partLabel(part))
        const link = attachmentLink?.(part)
        const url = safeLink(partUrl(part))
        if (link) md += `> **${kind}:** [${label}](${link})\n\n`
        else if (url) md += `> **${kind}:** [${label}](${url})\n\n`
        else md += `> **${kind}:** \`${label}\`\n\n`
      }
      const list = sourcesList(msg.sources)
      if (list) md += `${list}\n\n`
    }
    md += '---\n\n'
  }

  return md.trimEnd() + '\n'
}

// One JSON object per line: a `session` header (id, model, provider, pricing,
// createdAt, title, cost summary) followed by one object per message (role,
// content, reasoning, usage, sources, parts). Keeps the whole conversation,
// including system messages, as a machine-readable interchange format.
export function formatJsonl(sessionData, sessionId = null) {
  const { model, providerName, pricing, createdAt, title, messages, costSummary } = sessionData
  const lines = []
  lines.push(JSON.stringify({
    type: 'session',
    id: sessionId || sessionData.sessionId || null,
    model: model || null,
    providerName: providerName || null,
    pricing: pricing ?? null,
    createdAt: createdAt || null,
    title: title || null,
    costSummary: costSummary ?? null,
  }))
  for (const msg of messages || []) {
    const obj = { role: msg.role }
    if (msg.content !== undefined) obj.content = msg.content
    if (msg.reasoning != null) obj.reasoning = msg.reasoning
    if (msg.reasoningMs != null) obj.reasoningMs = msg.reasoningMs
    if (msg.usage != null) obj.usage = msg.usage
    if (msg.sources?.length) obj.sources = msg.sources
    lines.push(JSON.stringify(obj))
  }
  return lines.join('\n') + '\n'
}

// Writes the session export (markdown or jsonl) into <outDir>/session-<id>/,
// returns the created folder path. Markdown additionally materializes every
// decodable data-URL attachment under an attachments/ subfolder; remote
// http(s) parts stay clickable links and a decode/write failure warns and
// skips the part. Jsonl embeds the content parts directly (no materialization).
export async function exportSession(sessionData, outDir, sessionId, format = 'markdown') {
  const folder = join(outDir, `session-${sessionId}`)
  const attachmentsDir = join(folder, 'attachments')
  await mkdir(folder, { recursive: true })

  if (format !== 'markdown') {
    const jsonl = formatJsonl(sessionData, sessionId)
    await writeFile(join(folder, `session-${sessionId}.jsonl`), jsonl)
    return folder
  }

  const links = new Map()
  const used = new Set()
  let attachmentsReady = false

  for (const msg of sessionData.messages || []) {
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== 'image_url' && part?.type !== 'file') continue
      const url = partUrl(part)
      if (typeof url !== 'string' || !url.startsWith('data:')) continue
      const info = dataUrlInfo(url)
      if (!info) {
        console.warn(`Warning: could not decode attachment ${partLabel(part)}; skipped in export`)
        continue
      }
      if (!attachmentsReady) {
        await mkdir(attachmentsDir, { recursive: true })
        attachmentsReady = true
      }
      const name = uniqueName(sanitizeFilename(partLabel(part)), used)
      try {
        await writeFile(join(attachmentsDir, name), Buffer.from(info.base64, 'base64'))
      } catch (err) {
        console.warn(`Warning: could not write attachment ${name}: ${err.message}`)
        continue
      }
      links.set(part, `attachments/${name}`)
    }
  }

  const markdown = formatMarkdown(sessionData, (part) => links.get(part) || null)
  await writeFile(join(folder, `session-${sessionId}.md`), markdown)
  return folder
}
