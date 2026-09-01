// Word-aware folding of styled terminal lines. Lines are broken at spaces so
// the terminal's own soft-wrap never cuts a word; words longer than the width
// are hard-cut at the width. ANSI escape runs are never split, and OSC 8
// hyperlinks fold only as whole atoms. Widths are measured in display columns
// (string-width) so CJK/emoji and escape sequences stay exact.
import stringWidth from 'string-width'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Cluster-annotated view of a styled string, so widths are measured per
// grapheme cluster. string-width is cluster-aware on whole strings but not
// per code point: an emoji with a VS16 variation selector sums to 1 column
// char-by-char yet occupies 2, and a ZWJ family sums to 6 — the per-code-point sums
// hard-cut clusters in half and emit rows wider than the terminal, which
// soft-wrap and desync. Escape sequences are control characters (grapheme
// boundaries), so the index list stays valid when a walker skips a whole
// escape run.
function clusterWidths(styled) {
  const out = []
  for (const { index, segment } of graphemeSegmenter.segment(styled)) {
    out.push({ index, text: segment, width: stringWidth(segment) })
  }
  return out
}

/**
 * Index just past the escape sequence starting at i (CSI/SGR or OSC). */
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
const visualCut = (styled, from, to, limit, clusters) => {
  let vis = 0
  let i = from
  let ci = 0
  while (i < to) {
    if (styled.charCodeAt(i) === 0x1b) {
      i = escapeRunEnd(styled, i)
      continue
    }
    while (ci < clusters.length && clusters[ci].index < i) ci++
    const cluster = clusters[ci]
    const ch = cluster.text
    const w = cluster.width
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
  const clusters = clusterWidths(styled)
  const segments = []
  const len = styled.length
  let lineStart = 0
  let lineWidth = 0
  let wordStart = 0
  let wordWidth = 0
  let linkStart = -1
  let linkEnd = -1
  let i = 0
  let ci = 0
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
    while (ci < clusters.length && clusters[ci].index < i) ci++
    const ch = clusters[ci].text
    const w = clusters[ci].width
    const inLink = linkStart !== -1 && linkEnd === -1
    if (ch === ' ' && !inLink) {
      if (lineWidth + wordWidth + 1 > cols) {
        // The space itself would push the row over the width: it is the fold
        // point — drop it and let the next word start a fresh row (the row
        // must never exceed the terminal width; an over-wide row soft-wraps
        // and desyncs the history replay above the editor).
        if (lineStart < i) segments.push(styled.slice(lineStart, i))
        lineStart = i + 1
        lineWidth = 0
        wordStart = i + 1
        wordWidth = 0
        i += 1
        continue
      }
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
      let cut = visualCut(styled, wordStart, i, cols - lineWidth, clusters)
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

/**
 * Streaming word wrapper for plain (already escaped-stripped) text: pieces
 * arrive through `write(text)` and are emitted immediately, except the current
 * word which is held until its fit is known (a space/newline/overflow decides
 * it). Lines fold at spaces so the terminal's own soft-wrap never cuts a word;
 * words longer than the width are chunked at the exact width. Every text piece
 * goes through `style` (raw when null); fold newlines stay unstyled. Without a
 * positive `cols` everything is passed through unchanged, so piped output is
 * byte-identical.
 */
export function createWordWrap({ stdout, cols, style = null }) {
  const emit = (piece) => stdout.write(style ? style(piece) : piece)
  const newline = () => stdout.write('\n')

  // `cols` may be a number or a getter: the width is re-resolved on every
  // write so a terminal resize mid-stream folds at the new width instead of
  // the width captured when the renderer was created (the markdown renderer
  // already re-reads the width per line; this keeps plain output consistent).
  const colsOf = typeof cols === 'function' ? cols : () => cols

  // Longest prefix of `text` no wider than `width` (first code point always
  // included, so a wider-than-width char still makes progress).
  const sliceAtWidth = (text, width) => {
    let end = 0
    let w = 0
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const cw = stringWidth(segment)
      if (end > 0 && w + cw > width) break
      w += cw
      end += segment.length
    }
    return { text: text.slice(0, end), width: w }
  }

  let lineW = 0
  let held = ''
  let heldW = 0
  let sepCount = 0
  let overflow = false

  const emitChunks = (text, width) => {
    let rest = text
    let first = true
    while (rest !== '') {
      const chunk = sliceAtWidth(rest, width)
      if (!first) newline()
      emit(chunk.text)
      lineW = chunk.width
      rest = rest.slice(chunk.text.length)
      first = false
    }
  }

  const flushWord = (width) => {
    if (overflow) {
      held = ''
      heldW = 0
      sepCount = 0
      return
    }
    if (held !== '' || sepCount > 0) {
      if (lineW + sepCount + heldW <= width) {
        emit(`${' '.repeat(sepCount)}${held}`)
        lineW += sepCount + heldW
      } else {
        if (lineW > 0) newline()
        lineW = 0
        if (held !== '') emitChunks(held, width)
      }
    }
    held = ''
    heldW = 0
    sepCount = 0
  }

  const write = (text) => {
    const width = colsOf()
    if (!(width > 0)) {
      if (text !== '') emit(text)
      return
    }
    for (const { segment: ch } of graphemeSegmenter.segment(text)) {
      if (ch === '\n' || ch === '\r\n') {
        flushWord(width)
        newline()
        lineW = 0
        overflow = false
        continue
      }
      if (ch === ' ') {
        if (held !== '') flushWord(width)
        overflow = false
        sepCount += 1
        continue
      }
      const w = stringWidth(ch)
      if (overflow) {
        if (lineW + w > width) {
          newline()
          lineW = 0
        }
        emit(ch)
        lineW += w
        continue
      }
      if (held === '') {
        if (lineW + sepCount + w > width) {
          if (lineW > 0) newline()
          lineW = 0
          sepCount = 0
        }
        held = ch
        heldW = w
        continue
      }
      if (lineW + sepCount + heldW + w > width) {
        // The word cannot fit on the line: fold it over and stream the rest.
        if (lineW > 0) newline()
        lineW = 0
        sepCount = 0
        emitChunks(held, width)
        held = ''
        heldW = 0
        overflow = true
        if (lineW + w > width) {
          newline()
          lineW = 0
        }
        emit(ch)
        lineW += w
        continue
      }
      held += ch
      heldW += w
    }
  }

  const flush = () => {
    flushWord(colsOf())
    overflow = false
  }

  return { write, flush }
}
