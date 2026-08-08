import { partLabel, partUrl } from './attachments.js'
import { downloadRemotePart } from './attachment-store.js'
import { dim } from './ui/style.js'
import { hyperlink } from './ui/hyperlink.js'
import { printSources } from './ui/stream.js'

// Models that advertise image output often emit the artifact as a markdown
// image in plain text instead of a structured part. The conversion is gated on
// the capability flag so regular text is never misclassified.
export function extractMarkdownImageUrls(text) {
  const urls = []
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)[^)]*\)/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    urls.push(match[1])
  }
  return urls
}

// Resolves the parts a model produced: streamed non-text parts plus (for
// image-capable models) markdown images found in the answer text. Remote URLs
// are downloaded to the session's attachment dir and replaced by data URLs in
// the parts; failures keep the original URL.
export async function produceParts(streamedParts, { sessionId, imageOutputSupported, fullText }) {
  const parts = [...streamedParts]
  if (parts.length === 0 && imageOutputSupported === true) {
    for (const url of extractMarkdownImageUrls(fullText)) {
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  const results = await Promise.all(parts.map(async (part) => {
    // The label is captured before download so the original filename (e.g.
    // photo.png) survives replacement with a generic data-URL-derived one.
    const label = partLabel(part)
    const res = await downloadRemotePart(part, sessionId)
    return { ...res, label }
  }))
  return { parts, results }
}

// Shared post-stream step for chat (turn-runner) and one-shot: turns a
// provider result into a message with a parts-array content when the model
// produced artifacts, and returns the download results for printing.
export async function resolveArtifacts(apiResult, { sessionId, imageOutputSupported }) {
  if (!apiResult.content && !apiResult.parts?.length) return []
  const { parts, results } = await produceParts(apiResult.parts ?? [], {
    sessionId,
    imageOutputSupported,
    fullText: apiResult.content,
  })
  if (parts.length > 0) {
    apiResult.content = buildPartsContent(apiResult.content, parts)
  }
  return results
}

export function buildPartsContent(text, parts) {
  const content = []
  if (text) content.push({ type: 'text', text })
  content.push(...parts)
  return content
}

export function printArtifacts(results, stdout = process.stdout) {
  for (const res of results) {
    const part = res.part
    if (!part) continue
    const word = part.type === 'image_url' ? 'image' : 'file'
    const url = partUrl(part)
    const link = url && /^https?:/.test(url) ? ` ${hyperlink(url, url) || url}` : ''
    const note = res.savedTo ? `saved to ${res.savedTo}` : res.error ? `download failed: ${res.error}` : ''
    stdout.write(`${dim(`${word}: ${res.label || partLabel(part)}`)}${link}${note ? `  ${dim(note)}` : ''}\n`)
  }
}

export async function printPostStreamMetrics(apiResult, { sessionId, imageOutputSupported, stdout = process.stdout }) {
  const results = await resolveArtifacts(apiResult, { sessionId, imageOutputSupported })
  if (results.length > 0) printArtifacts(results, stdout)

  if (apiResult.sources?.length > 0) {
    printSources(apiResult.sources, stdout)
  }

  if (apiResult.skippedChunks > 0) {
    stdout.write(`${dim(`${apiResult.skippedChunks} malformed stream chunk${apiResult.skippedChunks > 1 ? 's' : ''} skipped`)}\n`)
  }
}
