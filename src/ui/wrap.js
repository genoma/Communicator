// Word-aware folding of styled terminal lines. Lines are broken at spaces so
// the terminal's own soft-wrap never cuts a word; words longer than the width
// are hard-cut at the width. ANSI escape runs are never split, and OSC 8
// hyperlinks fold only as whole atoms. Widths are measured in display columns
// (string-width) so CJK/emoji and escape sequences stay exact.
import stringWidth from 'string-width'

/** Character at code-unit index i (surrogate pair aware). */
const charAt = (styled, i) => {
  const code = styled.charCodeAt(i)
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < styled.length) return styled.slice(i, i + 2)
  return styled[i]
}

/** Index just past the escape sequence starting at i (CSI/SGR or OSC). */
const escapeRunEnd = (styled, i) => {
  const len = styled.length
  if (styled.charCodeAt(i + 1) === 0x5b) {
    for (let j = i + 2; j < len; j++) {
      const c = styled.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) return j + 1
    }
    return len
  }
  if (styled.charCodeAt(i + 1) === 0x5d) {
    for (let j = i + 2; j < len; j++) {
      const c = styled.charCodeAt(j)
      if (c === 0x1b && j + 1 < len && styled.charCodeAt(j + 1) === 0x5c) return j + 2
      if (c === 0x07) return j + 1
    }
    return len
  }
  return i + 2
}

/** True when the run starting at i is an OSC 8 hyperlink (`\x1b]8;...\x1b\`). */
const isOsc8Block = (styled, i) =>
  styled.charCodeAt(i) === 0x1b &&
  styled.charCodeAt(i + 1) === 0x5d &&
  styled.charCodeAt(i + 2) === 0x38 &&
  styled[i + 3] === ';'

/** OSC 8 open has a non-empty URL part; the close is `\x1b]8;;\x1b\`. */
const isOsc8Open = (styled, i, end) => {
  let termStart = end
  if (styled.charCodeAt(end - 2) === 0x1b && styled.charCodeAt(end - 1) === 0x5c) termStart = end - 2
  else if (styled.charCodeAt(end - 1) === 0x07) termStart = end - 1
  const body = styled.slice(i + 4, termStart)
  const sep = body.lastIndexOf(';')
  return sep !== -1 && body.slice(sep + 1) !== ''
}

/**
 * Index in [from, to) where the visible width first exceeds `limit` (the
 * start of that character). When the very first character would not fit,
 * cut after it so every chunk still makes visible progress (exceptionally
 * over-wide chunks are row-counted by the caller).
 */
const visualCut = (styled, from, to, limit) => {
  let vis = 0
  let i = from
  while (i < to) {
    if (styled.charCodeAt(i) === 0x1b) {
      i = escapeRunEnd(styled, i)
      continue
    }
    const ch = charAt(styled, i)
    const w = stringWidth(ch)
    if (vis + w > limit) return i === from ? i + ch.length : i
    vis += w
    i += ch.length
  }
  return to
}

/**
 * Split a styled single-line string into segments, each no wider than `cols`
 * display columns. Without a positive `cols` the input is returned unchanged
 * (pipes and unknown-width terminals keep byte-identical output).
 */
export function wrapWords(styled, cols) {
  if (!(cols > 0) || styled === '') return [styled]
  const segments = []
  const len = styled.length
  let lineStart = 0
  let lineWidth = 0
  let wordStart = 0
  let wordWidth = 0
  let linkStart = -1
  let linkEnd = -1
  let i = 0
  while (i < len) {
    if (styled.charCodeAt(i) === 0x1b) {
      const end = escapeRunEnd(styled, i)
      if (isOsc8Block(styled, i, end)) {
        if (isOsc8Open(styled, i, end)) {
          linkStart = i
          linkEnd = -1
        } else if (linkStart !== -1) {
          linkEnd = end
          linkStart = -1
        }
      }
      i = end
      continue
    }
    const ch = charAt(styled, i)
    const w = stringWidth(ch)
    const inLink = linkStart !== -1 && linkEnd === -1
    if (ch === ' ' && !inLink) {
      lineWidth += wordWidth + 1
      wordStart = i + 1
      wordWidth = 0
      i += 1
      continue
    }
    if (lineWidth + wordWidth + w > cols) {
      if (wordStart > lineStart && !inLink) {
        // Fold before the current word; the space right before it is dropped.
        const cut = wordStart - 1
        if (lineStart < cut) segments.push(styled.slice(lineStart, cut))
        lineStart = wordStart
        lineWidth = 0
        continue
      }
      // Hard cut inside the overlong word, keeping escape runs and whole
      // hyperlink atoms intact. A link that starts mid-line folds to the next
      // line whole; one that already starts the line stays put as an atom.
      let cut = visualCut(styled, wordStart, i, cols - lineWidth)
      if (inLink) {
        if (linkStart > lineStart) cut = linkStart
        else {
          const close = styled.indexOf('\x1b]8;;\x1b\\', i)
          if (close !== -1) cut = Math.max(cut, close + 7)
        }
      } else if (linkEnd !== -1 && cut > linkStart && cut < linkEnd) {
        cut = linkStart > lineStart ? linkStart : linkEnd
      }
      if (lineStart < cut) segments.push(styled.slice(lineStart, cut))
      if (cut > i) {
        // The cut was extended past the scan position (whole-link move): the
        // segment above already holds everything up to `cut`, so the rest of
        // the link must not be scanned again.
        lineStart = cut
        lineWidth = 0
        wordStart = cut
        wordWidth = 0
        i = cut
        continue
      }
      const cutWidth = stringWidth(styled.slice(wordStart, cut))
      lineStart = cut
      lineWidth = 0
      wordStart = cut
      wordWidth = wordWidth + w - cutWidth
      i += ch.length
      continue
    }
    wordWidth += w
    i += ch.length
  }
  if (lineStart < len) segments.push(styled.slice(lineStart))
  return segments
}
