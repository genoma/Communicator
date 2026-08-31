// assertions intentionally match ANSI-rendered output
/* eslint-disable no-control-regex */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamRenderer, printSources, renderHistory } from '../src/ui/stream.js'

const ANSI = /\x1b\[[0-9;]*m/g
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]8;;\x1b\\/g

function enableAnsi(t) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.stdout.getColorDepth = () => 8
  t.after(() => {
    delete process.stdout.getColorDepth
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  })
}

function capture() {
  const chunks = []
  const stdout = { write: (chunk) => chunks.push(String(chunk)) }
  return {
    stdout,
    text: () => chunks.join(''),
    plain: () => chunks.join('').replace(ANSI, '').replace(OSC8, ''),
  }
}

test('printSources renders clickable italic links with numbered entries', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  printSources([
    { title: 'Samsung in talks', url: 'https://econ.example/a' },
    { title: 'Mistral deal', url: 'https://msft.example/b' },
  ], stdout)
  const out = text()
  assert.equal(plain(), '\nSources (2)\n[1] Samsung in talks\n[2] Mistral deal\n')
  assert.match(out, /\x1b\[2mSources \(2\)\x1b\[22m/)
  assert.match(out, /\x1b\[2m\[1\]\x1b\[22m \x1b\[3m\x1b\]8;;https:\/\/econ\.example\/a\x1b\\Samsung in talks\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.match(out, /\x1b\[2m\[2\]\x1b\[22m \x1b\[3m\x1b\]8;;https:\/\/msft\.example\/b\x1b\\Mistral deal\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('printSources falls back to hostname and dimmed italic URL', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  printSources([
    { title: null, url: 'https://host.example/x' },
    { title: 'No URL', url: '' },
  ], stdout)
  assert.equal(plain(), '\nSources (2)\n[1] host.example\n[2] No URL\n')
  const out = text()
  assert.match(out, /\x1b\[2m\[1\]\x1b\[22m \x1b\[3m\x1b\]8;;https:\/\/host\.example\/x\x1b\\host\.example\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('printSources does nothing without sources', () => {
  const { stdout, plain } = capture()
  printSources([], stdout)
  assert.equal(plain(), '')
})

test('smooth renderer defaults off and writes tokens immediately', () => {
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout })
  assert.equal(render.smooth, false)
  render('x', 'content')
  render('y', 'content')
  assert.equal(plain(), 'xy')
})

test('renderHistory prints attachment lines under parts-based user messages', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
      ],
    },
  ], { markdown: false, stdout })
  assert.match(plain(), /Look at this/)
  assert.match(plain(), /attached: image\.png \(image\)/)
  assert.match(plain(), /attached: report\.pdf \(file\)/)
})

test('renderHistory prints output lines under parts-based assistant messages', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'make an image' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here you go' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
      ],
    },
  ], { markdown: false, stdout })
  assert.match(plain(), /Here you go/)
  assert.match(plain(), /image: image\.png/)
  assert.match(plain(), /file: report\.pdf/)
})

test('renderHistory prints no output lines for string-only assistant messages', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Answer here' },
  ], { markdown: false, stdout })
  assert.match(plain(), /Answer here/)
  assert.doesNotMatch(plain(), /(image|file):/)
})

test('renderHistory skips produced image tokens during streaming', () => {
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout })
  render('hello', 'content')
  render({ type: 'image_url', image_url: { url: 'https://img.example/a.png' } }, 'image')
  render(' world', 'content')
  assert.equal(plain(), 'hello world')
})

test('renderHistory passes plain strings through unchanged', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'plain question' },
  ], { markdown: false, stdout })
  assert.match(plain(), /plain question/)
  assert.doesNotMatch(plain(), /attached:/)
})

test('renderHistory prints reasoning under a thinking header for assistant messages', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Answer here', reasoning: 'thinking text' },
  ], { markdown: false, stdout })
  assert.match(plain(), /❯ Thinking/)
  assert.match(plain(), /thinking text/)
  assert.match(plain(), /❯ Answer/)
  assert.match(plain(), /Answer here/)
})

test('renderHistory prints a Sources block with OSC 8 links for assistant messages with sources', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'Answer here',
      sources: [
        { title: 'Example', url: 'https://example.com/a' },
        { title: 'Other', url: 'https://other.example/b' },
      ],
    },
  ], { markdown: false, stdout })
  assert.match(plain(), /Sources \(2\)\n\[1\] Example\n\[2\] Other/)
  assert.match(text(), /\x1b\[2m\[1\]\x1b\[22m \x1b\[3m\x1b\]8;;https:\/\/example\.com\/a\x1b\\Example\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('renderHistory links inline citations when the assistant message has sources', (t) => {
  enableAnsi(t)
  const { stdout, plain, text } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'See ^1^ and ^2^.',
      sources: [
        { title: 'One', url: 'https://one.example' },
        { title: 'Two', url: 'https://two.example' },
      ],
    },
  ], { markdown: true, stdout })
  assert.match(plain(), /See \[1\] and \[2\]\./)
  assert.match(text(), /\x1b\]8;;https:\/\/one\.example\x1b\\\[1\]/)
  assert.match(plain(), /Sources \(2\)\n\[1\] One\n\[2\] Two/)
})

test('renderHistory leaves assistant messages without sources unchanged', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Plain answer ^1^' },
  ], { markdown: true, stdout })
  assert.match(plain(), /Plain answer \^1\^/)
  assert.doesNotMatch(plain(), /Sources/)
})

test('renderHistory substitutes named RPG speaker markers for user and assistant', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Answer here' },
  ], { markdown: false, stdout, userMarker: '❯ Kael', assistantMarker: '❯ Zara' })
  assert.equal(plain(), '\n❯ Kael\n\nquestion\n\n❯ Zara\n\nAnswer here\n\n')
  assert.doesNotMatch(plain(), /❯ You/)
})

test('renderHistory keeps Thinking/Answer and puts the char marker before content', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Answer here', reasoning: 'thinking text' },
  ], { markdown: false, stdout, userMarker: '❯ Kael', assistantMarker: '❯ Zara' })
  assert.equal(plain(), '\n❯ Kael\n\nquestion\n\n❯ Thinking\n\nthinking text\n\n❯ Answer\n\n❯ Zara\n\nAnswer here\n\n')
})

test('renderHistory puts the waitLine checkpoint one blank above and below the RPG char marker', (t) => {
  // A reasoning-less turn in RPG mode resolves the loader row to the green
  // checkpoint BEFORE the char marker, mirroring the live writeSegment order
  // (checkpoint + one blank row, then assistantMarker). Pins the real
  // renderHistory path with waitLine + assistantMarker together.
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'Answer here', waitLine: 'Waiting for response' },
  ], { markdown: false, stdout, userMarker: '❯ Kael', assistantMarker: '❯ Zara' })
  assert.equal(plain(), '\n❯ Kael\n\nquestion\n\n✓ Waiting for response\n\n❯ Zara\n\nAnswer here\n\n')
})

test('smooth renderer writes nothing before the first tick and paces at the char cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 10, smoothTickMs: 20 })
  render('abcdefghij', 'content')
  render('klmnopqrst', 'content')
  assert.equal(plain(), '')
  t.mock.timers.tick(19)
  assert.equal(plain(), '')
  t.mock.timers.tick(1)
  assert.equal(plain(), 'abcdefghij')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghijklmnopqrst')
  t.mock.timers.tick(100)
  assert.equal(plain(), 'abcdefghijklmnopqrst')
})

test('smooth flush waits for the queue to drain at the paced rate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 3, smoothTickMs: 20 })
  render('hello ', 'content')
  render('world', 'content')
  const done = render.flush()
  assert.equal(plain(), '')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'hel')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'hello ')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'hello wor')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'hello world')
  await done
  t.mock.timers.tick(100)
  assert.equal(plain(), 'hello world')
})

test('smooth flush resolves immediately when the queue is empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 3, smoothTickMs: 20 })
  const done = render.flush()
  assert.equal(plain(), '')
  await done
  t.mock.timers.tick(100)
  assert.equal(plain(), '')
})

test('smooth flush with sync drains the queue immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 3, smoothTickMs: 20 })
  render('hello ', 'content')
  render('world', 'content')
  render.flush({ sync: true })
  assert.equal(plain(), 'hello world')
  t.mock.timers.tick(100)
  assert.equal(plain(), 'hello world')
})

test('smooth keeps reasoning markers ordered behind paced text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 2, smoothTickMs: 20 })
  render('', 'start_reasoning')
  render('THINKING', 'reasoning')
  render('', 'end_reasoning')
  render('HELLO', 'content')
  const pump = () => t.mock.timers.tick(20)

  pump()
  assert.equal(plain(), '❯ Thinking\n\nTH')
  pump()
  pump()
  pump()
  assert.equal(plain(), '❯ Thinking\n\nTHINKING\n\n❯ Answer\n\n')
  pump()
  assert.equal(plain(), '❯ Thinking\n\nTHINKING\n\n❯ Answer\n\nHE')
  pump()
  pump()
  assert.equal(plain(), '❯ Thinking\n\nTHINKING\n\n❯ Answer\n\nHELLO')
  pump()
  pump()
  pump()
  assert.equal(plain(), '❯ Thinking\n\nTHINKING\n\n❯ Answer\n\nHELLO')
})

test('stream renderer prints the assistant marker before the first content token of each message', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, assistantMarker: '❯ Zara' })
  render('Hel', 'content')
  render('lo', 'content')
  assert.equal(plain(), '❯ Zara\n\nHello')
  render.resetMessage()
  render('!', 'content')
  assert.equal(plain(), '❯ Zara\n\nHello❯ Zara\n\n!')
})

test('stream renderer puts the assistant marker after the Answer label when reasoning precedes content', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, assistantMarker: '❯ Zara' })
  render('\n', 'start_reasoning')
  render('thinking', 'reasoning')
  render('', 'end_reasoning')
  render('Hi', 'content')
  assert.equal(plain(), '❯ Thinking\n\nthinking\n\n❯ Answer\n\n❯ Zara\n\nHi')
})

test('stream renderer prints no assistant marker for a reasoning-only message', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, assistantMarker: '❯ Zara' })
  render('\n', 'start_reasoning')
  render('thinking', 'reasoning')
  render('', 'end_reasoning')
  assert.doesNotMatch(plain(), /Zara/)
})

test('toggling render.smooth off mid-stream drains the residual on the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 10, smoothTickMs: 20 })
  render('pending', 'content')
  render.smooth = false
  t.mock.timers.tick(20)
  assert.equal(plain(), 'pending')
  render(' now', 'content')
  assert.equal(plain(), 'pending now')
  t.mock.timers.tick(100)
  assert.equal(plain(), 'pending now')
})

test('mutating render.smoothCharsPerTick mid-stream changes the pacing of the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 10, smoothTickMs: 20 })
  render('abcdefghij', 'content')
  render('klmnopqrst', 'content')
  assert.equal(plain(), '')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghij')
  render.smoothCharsPerTick = 2
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghijkl')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghijklmn')
  t.mock.timers.tick(100)
  assert.equal(plain(), 'abcdefghijklmnop')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghijklmnopqr')
  t.mock.timers.tick(20)
  assert.equal(plain(), 'abcdefghijklmnopqrst')
  assert.equal(render.smoothCharsPerTick, 2)
  assert.equal(render.smoothTickMs, 20)
})

test('strips ANSI escape sequences from model content and reasoning', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, markdown: false })
  render('\x1b]52;c;c2VjcmV0\x1b\\hello', 'content')
  render('\x1b[31mred\x1b[0m', 'reasoning')
  render('\n', 'start_reasoning')
  render('\x1b[1mthought\x1b[0m', 'reasoning')
  render(null, 'end_reasoning')
  render(' done', 'content')
  assert.match(plain(), /^hellored/)
  assert.match(plain(), /thought/)
  assert.match(plain(), / done$/)
  assert.doesNotMatch(plain(), /\x1b]52/)
  assert.doesNotMatch(plain(), /c2VjcmV0/)
})

test('renderHistory strips ANSI escape sequences from replayed text', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '\x1b]52;c;base64\x1b\\ask' },
    { role: 'assistant', content: '\x1b[1manswer\x1b[0m', reasoning: '\x1b[31mwhy\x1b[0m' },
  ], { stdout })
  assert.match(plain(), /ask/)
  assert.match(plain(), /answer/)
  assert.doesNotMatch(plain(), /\x1b/) 
})

test('compact renderer hides reasoning and emits the checkpoint with the final count', () => {
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render('', 'start_reasoning')
  render('thinking text', 'reasoning')
  render('', 'end_reasoning')
  render('Answer here', 'content')
  // A constant 0 clock means the thinking had no elapsed time, so the
  // checkpoint reports count-only (`✓ Thinking · N`), never a misleading `0s`.
  assert.equal(plain(), '\r✓ Thinking · 13\x1b[K\n\n❯ Answer\n\nAnswer here')
})

test('compact renderer checkpoints once per thinking block, not per reasoning delta', () => {
  // A DeepSeek-family stream may cross back and forth but the parser emits
  // one start/end cycle per block; the meter must not replay the checkpoint
  // (and the Answer label) for each reasoning chunk.
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render('', 'start_reasoning')
  render('H', 'reasoning')
  render('mm,', 'reasoning')
  render('', 'end_reasoning')
  render('Hi!', 'content')
  assert.equal(plain(), '\r✓ Thinking · 4\x1b[K\n\n❯ Answer\n\nHi!')
})

test('compact renderer puts the assistant marker after the Answer label', () => {
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, assistantMarker: '❯ Zara', now: () => 0 })
  render('', 'start_reasoning')
  render('thinking text', 'reasoning')
  render('', 'end_reasoning')
  render('Hi', 'content')
  assert.equal(plain(), '\r✓ Thinking · 13\x1b[K\n\n❯ Answer\n\n❯ Zara\n\nHi')
})

test('compact renderer keeps content paced while the checkpoint is immediate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, smooth: true, smoothCharsPerTick: 10, smoothTickMs: 20, now: () => 0 })
  render('', 'start_reasoning')
  render('thinking text', 'reasoning')
  render('', 'end_reasoning')
  render('HELLO', 'content')
  assert.equal(plain(), '\r✓ Thinking · 13\x1b[K\n\n❯ Answer\n\n')
  t.mock.timers.tick(20)
  assert.equal(plain(), '\r✓ Thinking · 13\x1b[K\n\n❯ Answer\n\nHELLO')
  t.mock.timers.tick(1000)
  assert.equal(plain(), '\r✓ Thinking · 13\x1b[K\n\n❯ Answer\n\nHELLO')
})

test('compact renderer paints the live count on each meter tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render('', 'start_reasoning')
  render('x'.repeat(1234), 'reasoning')
  t.mock.timers.tick(200)
  assert.equal(text(), '\rThinking · 1.2k · 0s ⠋\x1b[K')
  render('y'.repeat(56), 'reasoning')
  t.mock.timers.tick(150)
  assert.equal(text(), '\rThinking · 1.2k · 0s ⠋\x1b[K\rThinking · 1.3k · 0s ⠙\x1b[K')
  render('', 'end_reasoning')
  assert.equal(text(), '\rThinking · 1.2k · 0s ⠋\x1b[K\rThinking · 1.3k · 0s ⠙\x1b[K\r✓ Thinking · 1.3k\x1b[K\n\n❯ Answer\n\n')
})

test('compact renderer flush clears a live meter line (interrupt path)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render('', 'start_reasoning')
  render('long thinking', 'reasoning')
  t.mock.timers.tick(200)
  assert.equal(text(), '\rThinking · 13 · 0s ⠋\x1b[K')
  render.flush({ sync: true })
  assert.equal(text(), '\rThinking · 13 · 0s ⠋\x1b[K\r\x1b[K')
})

test('compact renderer toggling off between turns restores the thinking text', () => {
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render('', 'start_reasoning')
  render('hidden', 'reasoning')
  render('', 'end_reasoning')
  render.resetMessage()
  render.compactThinking = false
  render('', 'start_reasoning')
  render('now visible', 'reasoning')
  render('', 'end_reasoning')
  render('done', 'content')
  assert.equal(plain(), '\r✓ Thinking · 6\x1b[K\n\n❯ Answer\n\n❯ Thinking\n\nnow visible\n\n❯ Answer\n\ndone')
})

test('compact renderer reports honest seconds from the turn clock on a one-burst reasoning block', () => {
  // The regression: an endpoint that flushes the whole reasoning block in a
  // single burst (start + all deltas + end in one tick) used to yield a
  // checkpoint of `✓ Thinking · N · 0s`. With the clock anchored at turn start,
  // the checkpoint reflects the time the user actually waited.
  let nowMs = 0
  const { stdout, plain } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => nowMs })
  render.turnStartedAt = 0
  nowMs = 2400
  render('', 'start_reasoning')
  render('thinking text', 'reasoning')
  render('', 'end_reasoning')
  render('Answer here', 'content')
  assert.equal(plain(), '\r✓ Thinking · 13 · 2.4s\x1b[K\n\n❯ Answer\n\nAnswer here')
})

test('compact renderer startTurn owns the line with a live wait clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let nowMs = 0
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => nowMs })
  render.turnStartedAt = 0
  render.startTurn('Waiting for response')
  nowMs = 2300
  t.mock.timers.tick(200)
  assert.equal(text(), '\rWaiting for response · 2.3s ⠋\x1b[K')
  // The burst lands: the meter flips to the counting phase without losing
  // the anchored clock.
  render('', 'start_reasoning')
  render('thinking text', 'reasoning')
  render('', 'end_reasoning')
  render('Answer here', 'content')
  assert.equal(text(), '\rWaiting for response · 2.3s ⠋\x1b[K\r✓ Thinking · 13 · 2.3s\x1b[K\n\n❯ Answer\n\nAnswer here')
})

test('compact renderer resolveWaitingLine checkpoints the wait label when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let nowMs = 0
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => nowMs })
  render.turnStartedAt = 0
  render.startTurn('Waiting for response')
  nowMs = 500
  t.mock.timers.tick(200)
  assert.equal(text(), '\rWaiting for response · 0.5s ⠋\x1b[K')
  const wrote = render.resolveWaitingLine()
  assert.equal(wrote, true)
  assert.equal(text(), '\rWaiting for response · 0.5s ⠋\x1b[K\r✓ Waiting for response\x1b[K\n')
})

test('compact renderer resolveWaitingLine returns false for instant replies', () => {
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => 0 })
  render.turnStartedAt = 0
  render.startTurn('Waiting for response')
  const wrote = render.resolveWaitingLine()
  assert.equal(wrote, false)
  assert.equal(text(), '')
})

test('compact renderer resolveWaitingLine no-ops when reasoning already owned the line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let nowMs = 0
  const { stdout, text } = capture()
  const render = createStreamRenderer({ stdout, compactThinking: true, now: () => nowMs })
  render.turnStartedAt = 0
  render.startTurn('Waiting for response')
  nowMs = 500
  t.mock.timers.tick(200)
  render('', 'start_reasoning')
  render('thinking', 'reasoning')
  render('', 'end_reasoning')
  assert.equal(render.resolveWaitingLine(), false)
  assert.equal(text(), '\rWaiting for response · 0.5s ⠋\x1b[K\r✓ Thinking · 8 · 0.5s\x1b[K\n\n❯ Answer\n\n')
})

test('renderHistory compact replays the checkpoint derived from stored reasoning', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', reasoning: 'thinking text' },
  ], { markdown: false, stdout, compactThinking: true })
  assert.equal(plain(), '\n❯ You\n\nquestion\n\n✓ Thinking · 13\n\n❯ Answer\n\nanswer\n\n')
})

test('renderHistory compact suppresses the seconds token when stored duration renders as 0s', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', reasoning: 'thinking text', reasoningMs: 14 },
  ], { markdown: false, stdout, compactThinking: true })
  // 14ms rounds to 0s, so replay shows count-only, never `· 0s`.
  assert.equal(plain(), '\n❯ You\n\nquestion\n\n✓ Thinking · 13\n\n❯ Answer\n\nanswer\n\n')
})

test('renderHistory compact replays the real seconds for a substantive thinking duration', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', reasoning: 'thinking text', reasoningMs: 5678 },
  ], { markdown: false, stdout, compactThinking: true })
  assert.equal(plain(), '\n❯ You\n\nquestion\n\n✓ Thinking · 13 · 5.7s\n\n❯ Answer\n\nanswer\n\n')
})

test('renderHistory emits no Answer header for a reasoning-only stopped partial', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', reasoning: 'thinking text' },
  ], { markdown: false, stdout })
  assert.match(plain(), /❯ Thinking\n\nthinking text/)
  assert.doesNotMatch(plain(), /❯ Answer/)
})

test('renderHistory compact shows nothing for a reasoning-only stopped partial', () => {
  const { stdout, plain } = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', reasoning: 'thinking text' },
  ], { markdown: false, stdout, compactThinking: true })
  // Live compact never printed the reasoning body and the stop cleared the
  // meter without resolving it to a checkpoint, so replay shows the same
  // silence instead of a phantom `✓ Thinking · N` + `❯ Answer`.
  assert.doesNotMatch(plain(), /Thinking/)
  assert.doesNotMatch(plain(), /❯ Answer/)
})
