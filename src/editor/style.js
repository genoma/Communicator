// Theme/style resolution (stateful prefixes, prompt header).
import { styleText } from 'node:util'

/** Resolve a Stateful value to its concrete value for the given state */
export function resolveStateful(value, state) {
  if (value !== null && typeof value === 'object' && 'pending' in value && 'submitted' in value) {
    if (state === 'cancelled') {
      return value.cancelled ?? value.pending
    }
    if (state === 'error') {
      return value.error ?? value.pending
    }
    return value[state]
  }
  return value
}

/** Apply a styleText format to text. Returns the text unchanged if no format is provided. */
export function applyStyle(text, format) {
  if (!format || text === '') return text
  return styleText(format, text)
}

/** Build the styled prompt header line (prefix + prompt) for a given state */
export function buildPromptHeader(prefixOption, prompt, theme, state) {
  const prefix = resolveStateful(prefixOption, state)
  const styledPrefix = applyStyle(
    prefix,
    theme?.prefix ? resolveStateful(theme.prefix, state) : undefined
  )
  const styledPrompt = applyStyle(prompt, theme?.prompt)
  return styledPrefix + styledPrompt
}

/**
 * Compute the number of terminal lines the prompt header occupies.
 * Returns 0 when both prefix and prompt are empty (no header line is rendered).
 */
export function computeHeaderHeight(builtHeader) {
  if (builtHeader === '') return 0
  return builtHeader.split('\n').length
}

/** Build the styled line prefix for a given state */
export function buildStyledLinePrefix(linePrefixOption, theme, state) {
  const linePrefix = resolveStateful(linePrefixOption, state)
  const style = theme?.linePrefix ? resolveStateful(theme.linePrefix, state) : undefined
  return applyStyle(linePrefix, style)
}
