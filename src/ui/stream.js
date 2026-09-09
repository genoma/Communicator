import { dim, italic, green, you, thinking, answer } from './style.js'
import { createMarkdownRenderer, renderText } from './markdown.js'
import { createWordWrap, wrapWords } from './wrap.js'
import { hyperlink, sanitizeAnsi, sanitizeSingleLine } from './hyperlink.js'
import { SMOOTH_CHARS_PER_TICK, SMOOTH_TICK_MS, STREAM_IDLE_DOTS_ARM_MS, STREAM_IDLE_DOTS_TICK_MS } from '../constants.js'
import { contentText, contentAttachments } from '../attachments.js'
import { createThinkingMeter } from './loader.js'
import { formatCompactCount, formatElapsedSeconds } from './format.js'

// Dim animated dots shown at the cursor once the answer has started and the
// stream goes quiet. Three frames cycling in place, never labeled (the client
// cannot distinguish a search/thinking/slow-generate gap on the wire).
const IDLE_DOT_FRAMES = ['.', '..', '...']

// The one attachment/artifact line format shared by history replay, live
// /attach confirmations, artifact reports and image outcomes: dim italic
// kind word, label, optional dim meta, then the undimmed link (OSC 8 escapes
// must not be styled) and a dim note.
//
// `label`, `meta` and `note` all carry provider- or filesystem-derived text
// (an image label is decoded from a model-controlled URL path, a download
// error embeds a remote hostname), so each is sanitized single-line here: a
// label carrying a real newline would forge an extra row in the artifact
// report and in history replay. `link` is exempt because a hyperlink
// legitimately contains OSC 8 escapes and is sanitized by its caller before
// it is built.
export function attachmentLine(word, label, { meta = null, note = null, link = null } = {}) {
  const head = `${dim(`${italic(word)}: ${sanitizeSingleLine(label)}`)}`
  const metaText = meta != null ? ` ${dim(`(${sanitizeSingleLine(meta)})`)}` : ''
  const noteText = note ? `  ${dim(sanitizeSingleLine(note))}` : ''
  return `${head}${link ?? ''}${metaText}${noteText}`
}

export function createStreamRenderer({ markdown = false, stdout = process.stdout, smooth = false, smoothCharsPerTick = SMOOTH_CHARS_PER_TICK, smoothTickMs = SMOOTH_TICK_MS, assistantMarker = null, compactThinking = false, now = null } = {}) {
  // Content writes go through this proxy so a transient idle-dots suffix is
  // erased (bare) before the next content byte is written — neither the
  // markdown nor the plain wrapper rewinds, so the erase must happen here.
  // Reasoning is never written after content starts (the parser drops late
  // reasoning), so only the content writers need the proxy.
  const dotStdout = {
    write: (chunk) => { eraseIdleDots(); return stdout.write(chunk) },
    // Mirror the real stream's width onto the proxy so the markdown renderer
    // (which reads stdout.columns for folding and its own freeCols) sees the
    // same terminal width as the raw write path.
    get columns() { return stdout.columns },
  }
  const md = createMarkdownRenderer({
    getSources: () => render.sources,
    stdout: dotStdout,
    partialFlushMs: smooth ? smoothTickMs : undefined,
  })

  // Width is resolved lazily (per write): a mid-stream terminal resize folds
  // new text at the new width instead of the width at renderer creation.
  const cols = () => (typeof stdout.columns === 'number' ? stdout.columns : null)
  const reasoningWrap = createWordWrap({ stdout, cols, style: dim })
  const contentWrap = createWordWrap({ stdout: dotStdout, cols })

  const meter = createThinkingMeter({ stdout, now: now ?? undefined })

  const queue = []
  let pumpTimer = null
  let drainWaiter = null
  let messageStarted = false
  // The Answer marker is written by end_reasoning on reasoning turns; a
  // reasoning-less turn never has one, so the first content write must emit
  // it (with the same one-blank spacing) — otherwise the answer starts right
  // after the `✓ Waiting for response` checkpoint with no `❯ Answer` label,
  // and live/history both float on a bare checkpoint.
  let answerOpen = false

  // Idle-dots state: a transient, TTY-only, dim animated `. `..` `...` suffix
  // shown at the cursor once content has started and the stream goes quiet.
  // Like the answer-wait row it is never checkpointed and never persisted; the
  // erase is a bare `\x1b[<len>D\x1b[0K` so the completed layout stays
  // byte-identical. Pure render-side — the parser and providers are untouched.
  let idleArmTimer = null
  const idleDots = { active: false, tickTimer: null, frame: 0, len: 0 }

  const eraseIdleDots = () => {
    if (!idleDots.active) return
    if (idleDots.tickTimer !== null) {
      clearTimeout(idleDots.tickTimer)
      idleDots.tickTimer = null
    }
    idleDots.active = false
    stdout.write(`\x1b[${idleDots.len}D\x1b[0K`)
    idleDots.len = 0
  }

  const cancelIdleArm = () => {
    if (idleArmTimer !== null) {
      clearTimeout(idleArmTimer)
      idleArmTimer = null
    }
  }

  const showIdleDots = () => {
    idleDots.active = true
    idleDots.frame = 0
    idleDots.len = 1
    stdout.write(dim(IDLE_DOT_FRAMES[0]))
    const scheduleTick = () => {
      idleDots.tickTimer = setTimeout(() => {
        const prevLen = idleDots.len
        stdout.write(`\x1b[${prevLen}D\x1b[0K`)
        idleDots.frame = (idleDots.frame + 1) % IDLE_DOT_FRAMES.length
        const frame = IDLE_DOT_FRAMES[idleDots.frame]
        stdout.write(dim(frame))
        idleDots.len = frame.length
        scheduleTick()
      }, STREAM_IDLE_DOTS_TICK_MS)
      idleDots.tickTimer.unref?.()
    }
    scheduleTick()
  }

  const armIdleDots = () => {
    cancelIdleArm()
    idleArmTimer = setTimeout(fireIdleDots, STREAM_IDLE_DOTS_ARM_MS)
    idleArmTimer.unref?.()
  }

  const fireIdleDots = () => {
    idleArmTimer = null
    if (stdout.isTTY !== true) return
    if (!messageStarted) return
    // Still draining the pacing queue: more content is on its way, re-arm
    // instead of painting dots over the tail of a draining answer.
    if (queue.length > 0 || pumpTimer !== null) {
      armIdleDots()
      return
    }
    const free = render.markdown ? md.freeCols() : contentWrap.freeCols()
    if (free == null || free < IDLE_DOT_FRAMES[IDLE_DOT_FRAMES.length - 1].length) return
    if (idleDots.active) return
    showIdleDots()
  }

  const writeSegment = (type, text) => {
    if (type === 'start_reasoning') {
      // The parser's marker token is a bare '\n'; it must not add a row here
      // (live and history replay then share the exact one-blank layout).
      stdout.write(`${thinking()}\n\n`)
    } else if (type === 'reasoning') {
      reasoningWrap.write(text)
    } else if (type === 'end_reasoning') {
      reasoningWrap.flush()
      // In RPG mode the character marker replaces the Answer label: the turn
      // is spoken by the character, so its marker alone labels it. It is
      // emitted with the first content byte (see 'content') — never here —
      // so a reasoning-only partial (no content) shows no marker at all,
      // exactly as history replay renders it.
      if (assistantMarker) stdout.write('\n\n')
      else stdout.write(`\n\n${answer()}\n\n`)
      answerOpen = true
    } else if (type === 'content') {
      // Compact mode: the transient answer-wait row (post-thinking silent
      // gap) owns this row until the first content byte replaces it. Bare
      // stop erases it (no checkpoint); a stopped/never-started meter is a
      // no-op, so the full-mode path is unaffected.
      meter.stop()
      if (!messageStarted) {
        messageStarted = true
        if (!answerOpen) {
          // Reasoning-less turn: end_reasoning never ran, so the first
          // content byte emits the turn marker (the character marker in
          // RPG mode).
          stdout.write(`${assistantMarker ?? answer()}\n\n`)
          answerOpen = true
        } else if (assistantMarker) {
          // Reasoning turn in RPG mode: end_reasoning only opened the blank
          // row above, so the character marker goes here, right before the
          // content (a reasoning-only partial never reaches it).
          stdout.write(`${assistantMarker}\n\n`)
        }
      }
      if (render.markdown) md.write(text)
      else contentWrap.write(text)
      // The write above went through the content proxy, which erased any
      // active dots first; re-arm the idle countdown from this latest byte.
      armIdleDots()
    }
  }

  // Compact mode: reasoning body is never printed; the meter owns the line.
  // The checkpoint line and the following Answer label keep the same spacing
  // as the full mode (`✓ Thinking · N\n\n❯ Answer\n\n`): one blank line above
  // and below every marker.
  const writeCompact = (type, text) => {
    if (type === 'start_reasoning') {
      // A thinking block that opens after content already rendered is a late
      // burst (OpenRouter web-search delivery can flush reasoning after the
      // answer started): suppress markers entirely — the completed layout
      // must never gain a trailing `✓ Thinking`/`❯ Answer` block.
      if (messageStarted) return
      // The meter was already started by startTurn (waiting phase) when the
      // runner owns the line: flip it to the counting phase without touching
      // the clock, so the checkpoint counts from turn start even when the
      // endpoint flushes the whole reasoning block in one burst. Without a
      // started meter (one-shot / tests) start one anchored at the turn.
      if (meter.isWaiting()) meter.toThinking()
      else meter.start({ startedAt: render.turnStartedAt })
    } else if (type === 'reasoning') {
      if (messageStarted) return
      meter.update(text.length)
    } else if (type === 'end_reasoning') {
      if (messageStarted) return
      meter.stop({ done: true })
      // Same RPG split as writeSegment: in character mode only the blank row
      // opens here; the marker arrives with the first content byte.
      if (assistantMarker) stdout.write('\n')
      else stdout.write(`\n${answer()}\n\n`)
      answerOpen = true
      // Re-arm a TRANSIENT live row on the content row: after the checkpoint
      // the meter is stopped and the timer is gone, and with a bursty
      // OpenRouter web-search stream the first content delta can arrive long
      // after `❯ Answer` — the cursor blinks over an empty row and the turn
      // looks dead. The row is erased (bare stop, never checkpointed) on the
      // first content delta, so the completed layout stays byte-identical.
      meter.beginAnswerWait()
    }
  }

  const pump = () => {
    pumpTimer = null
    let chars = 0
    while (queue.length > 0 && (queue[0].marker || chars < render.smoothCharsPerTick)) {
      const segment = queue.shift()
      if (segment.marker) {
        writeSegment(segment.type, segment.text)
        continue
      }
      const take = Math.min(segment.text.length, render.smoothCharsPerTick - chars)
      writeSegment(segment.type, segment.text.slice(0, take))
      chars += take
      if (take < segment.text.length) {
        queue.unshift({ ...segment, text: segment.text.slice(take) })
        break
      }
    }
    if (queue.length > 0) {
      schedulePump()
    } else if (drainWaiter) {
      const waiter = drainWaiter
      drainWaiter = null
      waiter.resolve()
    }
  }

  const schedulePump = () => {
    if (pumpTimer === null) {
      pumpTimer = setTimeout(pump, render.smoothTickMs)
      if (drainWaiter === null) pumpTimer.unref?.()
    }
  }

  const render = (token, type) => {
    // Produced artifact parts render after the turn (printArtifacts in
    // turn-runner/one-shot); skip them here so the smooth queue never sees
    // object tokens.
    if (type === 'image' || type === 'file') return
    // The parser delivers complete strings, so sanitizing here (once, before
    // the smooth pump can slice them) also covers sequences split across
    // pump chunks.
    const text = type === 'content' || type === 'reasoning' ? sanitizeAnsi(token) : token
    // Compact reasoning bypasses the queue entirely: the meter updates live
    // (and counts sanitized chars) while content keeps its pacing below.
    if (render.compactThinking && (type === 'start_reasoning' || type === 'reasoning' || type === 'end_reasoning')) {
      writeCompact(type, text)
      return
    }
    if (!render.smooth) {
      writeSegment(type, text)
      return
    }
    queue.push({ type, text, marker: type === 'start_reasoning' || type === 'end_reasoning' })
    schedulePump()
  }
  render.markdown = markdown
  render.smooth = smooth
  render.compactThinking = compactThinking
  render.smoothCharsPerTick = smoothCharsPerTick
  render.smoothTickMs = smoothTickMs
  render.sources = []
  render.resetMessage = () => {
    messageStarted = false
    answerOpen = false
    // A fresh turn: a pending idle-dots arm or an on-screen suffix must not
    // survive into the new turn's rendering.
    cancelIdleArm()
    eraseIdleDots()
  }
  // Compact mode: the meter owns the turn's status line, so the runner starts
  // it at turn start (waiting phase) instead of the loader. The clock is
  // anchored at turn start and the wait label is the caller's (Waiting for
  // response / Searching the web), so the reasoning-less checkpoint matches
  // the loader's exactly. Non-compact turns never call this.
  render.startTurn = (waitLabel) => {
    meter.beginWait({ startedAt: render.turnStartedAt, label: waitLabel })
  }
  // Resolves a live waiting meter line to its green checkpoint (`✓ <wait
  // label>`), like the loader's `stop({done:true})`: returns true only when it
  // actually wrote the line (the spinner was visible), so the runner adds the
  // one blank row below exactly once and instant replies never gain a stray
  // one. No-op once reasoning started (the thinking checkpoint already owns
  // the row).
  render.resolveWaitingLine = () => {
    if (!render.compactThinking || !meter.isWaiting()) return false
    return meter.stop({ done: true })
  }
  const flushBodies = () => {
    reasoningWrap.flush()
    if (render.markdown) md.flush()
    else contentWrap.flush()
  }

  render.flush = ({ sync = false } = {}) => {
    // Never leave a live meter line behind (interrupts, errors, aborted
    // streams): the checkpoint only comes from end_reasoning.
    meter.stop()
    // A live idle-dots suffix is transient: erase it bare (never checkpointed)
    // and stop the arm timer, so nothing paints after the completion layout.
    eraseIdleDots()
    cancelIdleArm()
    if (sync) {
      if (pumpTimer !== null) {
        clearTimeout(pumpTimer)
        pumpTimer = null
      }
      while (queue.length > 0) {
        const segment = queue.shift()
        writeSegment(segment.type, segment.text)
      }
      flushBodies()
      cancelIdleArm()
      return
    }
    if (queue.length === 0) {
      flushBodies()
      cancelIdleArm()
      return
    }
    if (drainWaiter) return drainWaiter.promise
    let resolveDrain
    const promise = new Promise((resolve) => { resolveDrain = resolve })
    drainWaiter = {
      promise,
      resolve: () => {
        flushBodies()
        cancelIdleArm()
        resolveDrain()
      },
    }
    if (pumpTimer === null) schedulePump()
    else pumpTimer.ref?.()
    return promise
  }

  return render
}

export function printSources(sources, stdout = process.stdout) {
  stdout.write(sourcesText(sources))
}

function sourcesText(sources) {
  if (!sources?.length) return ''
  let out = '\n'
  out += `${dim(`Sources (${sources.length})`)}\n`
  sources.forEach((source, i) => {
    let label = source.title
    if (!label) {
      try {
        label = new URL(source.url).hostname
      } catch {
        label = null
      }
    }
    label = sanitizeAnsi(label)
    const cleanUrl = sanitizeAnsi(source.url)
    const link = label && cleanUrl ? hyperlink(cleanUrl, label) : null
    out += `${dim(`[${i + 1}]`)} ${italic(link || label || dim(cleanUrl))}\n`
  })
  // One blank row below the list — the same spacing the block gets above it —
  // so the follower (metrics separator, next turn's marker, malformed-chunks
  // note) never sits glued to the last entry. Shared by live, replay and
  // one-shot, so live == replay stays byte-identical.
  out += '\n'
  return out
}

export function renderHistory(messages, { markdown = false, stdout = process.stdout, userMarker = null, assistantMarker = null, compactThinking = false, tailBlank = true } = {}) {
  if (!messages || messages.length <= 1) return

  const cols = typeof stdout.columns === 'number' ? stdout.columns : null
  const wrapPlain = (text) => text.split('\n').map((line) => wrapWords(line, cols).join('\n')).join('\n')
  const hasVisible = messages.some((m) => m.role !== 'system')
  if (!hasVisible) return

  let out = '\n'
  for (const msg of messages) {
    if (msg.role === 'user') {
      // One blank line above and below the marker, then the body.
      out += `${userMarker ?? you()}\n\n${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`
      for (const att of contentAttachments(msg.content)) {
        out += `${attachmentLine('attached', att.filename, { meta: att.kind })}\n`
      }
    } else if (msg.role === 'assistant') {
      // A reasoning-only partial (Esc/Ctrl+C stopped before any content) is
      // the truncated form of a live stream that never opened an answer row:
      // full mode left the thinking block open and never wrote `❯ Answer`,
      // compact mode cleared the meter without resolving it to `✓ Thinking ·
      // N`. Replay exactly that — raw thinking block (full), no `✓` checkpoint
      // (compact), no `❯ Answer` — instead of a phantom closed block.
      const hasAnswer = !!contentText(msg.content) || contentAttachments(msg.content).length > 0
      if (msg.reasoning && !hasAnswer) {
        if (!compactThinking) {
          out += `${thinking()}\n\n`
          // Match live: a mid-reasoning stop left the thinking block open and
          // the runner's blank row under it; replay the same trailing blank so
          // a resize rebuild keeps one blank row below the block, never fewer.
          out += `${dim(wrapPlain(sanitizeAnsi(msg.reasoning)))}\n\n`
        }
        out += sourcesText(msg.sources)
        continue
      }
      // Same marker sequence as the live stream (writeSegment): one blank
      // line above and below every marker.
      // Compact mode replays the live checkpoint (`✓ Thinking · N`) with the
      // count derived from the stored reasoning, never the body. Seconds are
      // suppressed when the stored duration renders as `0s` (a one-burst /
      // instant reasoning block), so a resumed session shows the same
      // count-only line the live stream did and never a misleading `· 0s`.
      if (msg.reasoning) {
        if (compactThinking) {
          const count = formatCompactCount(sanitizeAnsi(msg.reasoning).length)
          let duration = ''
          if (msg.reasoningMs != null) {
            const seconds = formatElapsedSeconds(msg.reasoningMs)
            if (seconds !== '0s') duration = ` · ${seconds}`
          }
          out += `${green('✓')} Thinking · ${count}${duration}\n\n${assistantMarker ?? answer()}\n\n`
        } else {
          out += `${thinking()}\n\n`
          out += `${dim(wrapPlain(sanitizeAnsi(msg.reasoning)))}\n`
          out += `\n${assistantMarker ?? answer()}\n\n`
        }
      }
      // A reasoning-less turn resolved its loader row to a green checkpoint
      // (`✓ Waiting for response`/`✓ Searching the web`): replay it exactly
      // as the live stream showed it — one blank row between the checkpoint
      // and the answer, the same one-blank-above-and-below marker spacing the
      // thinking markers get. Never stored on reasoning turns — the thinking
      // marker or the compact meter checkpoint owns that row instead.
      if (msg.waitLine) {
        out += `${green('✓')} ${sanitizeSingleLine(msg.waitLine)}\n\n`
      }
      // Every completed content-bearing turn carries the turn marker — the
      // character marker in RPG mode (`❯ <char>` replaces `❯ Answer`, exactly
      // as the live stream renders it, so a turn never shows both), `❯
      // Answer` otherwise; live writeSegment emits it on the first content
      // byte when no end_reasoning preceded it, and replay must match, or a
      // resumed session shows a bare checkpoint before the answer. Reasoning
      // turns already wrote it above.
      if (!msg.reasoning) {
        out += `${assistantMarker ?? answer()}\n\n`
      }
      out += `${markdown ? renderText(sanitizeAnsi(contentText(msg.content)), msg.sources || [], cols) : wrapPlain(sanitizeAnsi(contentText(msg.content)))}\n\n`
      for (const att of contentAttachments(msg.content)) {
        out += `${attachmentLine(att.kind, att.filename)}\n`
      }
      out += sourcesText(msg.sources)
    }
  }
  // Continuation redraws (/retry, /edit) end the transcript flush so the
  // rerun's leading '\n\n' leaves exactly one blank row under the last
  // message — the same one the live submitted line gets — never a doubled
  // gap from the transcript's own trailing blank.
  if (!tailBlank) out = out.replace(/\n+$/, '')
  stdout.write(out)
}
