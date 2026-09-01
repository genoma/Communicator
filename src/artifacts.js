import { partLabel, partUrl } from './attachments.js'
import { downloadRemotePart } from './attachment-store.js'
import { mapWithConcurrency } from './http.js'
import { ARTIFACT_DOWNLOAD_CONCURRENCY, MAX_PRODUCED_PARTS } from './constants.js'
import { dim } from './ui/style.js'
import { hyperlink, sanitizeSingleLine } from './ui/hyperlink.js'
import { attachmentLine, printSources } from './ui/stream.js'

// Models that advertise image output often emit the artifact as a markdown
// image in plain text instead of a structured part. The conversion is gated on
// the capability flag so regular text is never misclassified.
//
// One-pass scan (not a regex): the markdown-image shape needs `![` … `](` … `)`
// with the URL immediately after `(`, and a malformed `![x](https://` prefix
// with no closing `)` made the old regex backtrack quadratically over
// model-controlled text.
export function extractMarkdownImageUrls(text) {
  const urls = []
  const s = String(text ?? '')
  let searchFrom = 0
  while (searchFrom < s.length) {
    const open = s.indexOf('![', searchFrom)
    if (open === -1) break
    const close = s.indexOf(']', open + 2)
    if (close === -1) break
    searchFrom = open + 2
    if (s[close + 1] !== '(') continue
    const parenEnd = s.indexOf(')', close + 2)
    if (parenEnd === -1) break
    const url = /^https?:\/\/[^\s)]+/.exec(s.slice(close + 2, parenEnd))?.[0]
    if (url) urls.push(url)
    searchFrom = parenEnd + 1
  }
  return urls
}

// Resolves the parts a model produced: streamed non-text parts plus (for
// image-capable models) markdown images found in the answer text. Remote URLs
// are downloaded to the session's attachment dir and replaced by data URLs in
// the parts; failures keep the original URL. `requestFn` is a test seam for
// the download transport.
export async function produceParts(streamedParts, { sessionId, imageOutputSupported, fullText, requestFn }) {
  const parts = [...streamedParts]
  if (parts.length === 0 && imageOutputSupported === true) {
    // Model-authored text controls both how many URLs appear here and where
    // they point, so repeats are collapsed before they become downloads.
    const seen = new Set()
    for (const url of extractMarkdownImageUrls(fullText)) {
      if (seen.has(url)) continue
      seen.add(url)
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  // Past the cap the extra artifacts are dropped. For the markdown branch
  // that costs nothing — the URLs are still in the answer text, which stays
  // as the leading text part — but a model emitting more than the cap in
  // *structured* parts does lose them from the persisted message. Keeping
  // them undownloaded instead would push every remote URL into the session
  // and re-send it next turn, which is worse.
  if (parts.length > MAX_PRODUCED_PARTS) parts.length = MAX_PRODUCED_PARTS
  const results = await mapWithConcurrency(parts, ARTIFACT_DOWNLOAD_CONCURRENCY, async (part) => {
    // The label is captured before download so the original filename (e.g.
    // photo.png) survives replacement with a generic data-URL-derived one.
    const label = partLabel(part)
    const res = await downloadRemotePart(part, sessionId, { requestFn })
    return { ...res, label }
  })
  return { parts, results }
}

// Shared post-stream step for chat (turn-runner) and one-shot: turns a
// provider result into a message with a parts-array content when the model
// produced artifacts, and returns the download results for printing.
export async function resolveArtifacts(apiResult, { sessionId, imageOutputSupported, requestFn }) {
  if (!apiResult.content && !apiResult.parts?.length) return []
  const { parts, results } = await produceParts(apiResult.parts ?? [], {
    sessionId,
    imageOutputSupported,
    fullText: apiResult.content,
    requestFn,
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
    // The URL is model-controlled and only reaches the terminal when
    // hyperlink() refuses it (it requires a scheme with `//`), so the raw
    // fallback is the one path that could carry escape bytes to stdout.
    const url = sanitizeSingleLine(partUrl(part) ?? '')
    const link = url && /^https?:\/\//i.test(url) ? ` ${hyperlink(url, url) || url}` : null
    const note = res.savedTo ? `saved to ${res.savedTo}` : res.error ? `download failed: ${res.error}` : null
    stdout.write(`${attachmentLine(word, res.label || partLabel(part), { link, note })}\n`)
  }
}

// Shared post-stream printer for chat (turn-runner) and one-shot: artifact
// lines, the sources list and the malformed-chunk notice, all with the same
// styling. `withSources`/`withSkipped` let piped one-shot keep its
// content-only stdout contract (artifact lines go to stderr instead).
export function printArtifactsSummary(results, apiResult, stdout = process.stdout, { withSources = true, withSkipped = true } = {}) {
  let wrote = false
  if (results.length > 0) {
    printArtifacts(results, stdout)
    wrote = true
  }
  if (withSources && apiResult.sources?.length > 0) {
    printSources(apiResult.sources, stdout)
    wrote = true
  }
  if (withSkipped && apiResult.skippedChunks > 0) {
    stdout.write(`${dim(`${apiResult.skippedChunks} malformed stream chunk${apiResult.skippedChunks > 1 ? 's' : ''} skipped`)}\n`)
    wrote = true
  }
  return wrote
}

export async function printPostStreamMetrics(apiResult, { sessionId, imageOutputSupported, stdout = process.stdout, requestFn, withSources = true, withSkipped = true }) {
  const results = await resolveArtifacts(apiResult, { sessionId, imageOutputSupported, requestFn })
  return printArtifactsSummary(results, apiResult, stdout, { withSources, withSkipped })
}
