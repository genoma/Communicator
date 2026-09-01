import { MAX_SCRAPE_CHARS } from './constants.js'

// Normalizes scraped page content for injection into the conversation: one
// shared truncation cap and size label for every scrape path (launch-time
// --scrape, /scrape, one-shot).
// Shared /scrape and --scrape URL validation: a valid http(s) URL or null
// (callers format their own error messages).
export function parseScrapeUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null
}

export function scrapeContext(url, content) {
  const full = String(content || '')
  const truncated = full.length > MAX_SCRAPE_CHARS
  const text = truncated ? full.slice(0, MAX_SCRAPE_CHARS) : full
  const sizeLabel = truncated
    ? `${MAX_SCRAPE_CHARS.toLocaleString()} chars (full page truncated)`
    : `${text.length.toLocaleString()} chars`
  return { text, sizeLabel }
}

// The user message shape under which scraped pages enter the session.
export function scrapeMessage(url, content) {
  return `Scraped from ${url}:\n\n${content}`
}
