// assertions intentionally match ANSI-rendered output
/* eslint-disable no-control-regex */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import stringWidth from 'string-width'
import { STREAM_IDLE_DOTS_ARM_MS } from '../src/constants.js'
import { createStreamRenderer } from '../src/ui/stream.js'
import { imageUnitPrice, formatImagePrice, formatElapsedSeconds, formatSessionItem } from '../src/ui/format.js'
import { createMarkdownRenderer } from '../src/ui/markdown.js'
import { createStreamKeyMonitor } from '../src/stream-keys.js'

const ANSI = /\x1b\[[0-9;]*m/g
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]8;;\x1b\\/g
const plain = (s) => s.replace(ANSI, '').replace(OSC8, '')

// Idle dots: the arm timer can elapse while the smooth pacing queue still
// holds content. The renderer must re-arm silently (never paint dots over the
// tail of a draining answer) and the next paced byte re-anchors the countdown.
test('idle dots re-arm silently while the smooth queue is still draining', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const chunks = []
  const stdout = { isTTY: true, columns: 80, write: (c) => chunks.push(String(c)) }
  const render = createStreamRenderer({ stdout, smooth: true, smoothCharsPerTick: 1, smoothTickMs: 500 })
  render('abc def ghi', 'content')
  const tick = (ms) => t.mock.timers.tick(ms)

  tick(500) // first paced byte: the word wrapper holds it, the arm is set
  assert.equal(chunks.join(''), '❯ Answer\n\n')

  tick(STREAM_IDLE_DOTS_ARM_MS) // 900 ms: the arm fires with ten chars queued
  assert.equal(chunks.join(''), '❯ Answer\n\n', 'the arm must re-arm instead of painting mid-drain')

  for (let i = 0; i < 45; i++) tick(100) // paced drain through 5.4 s
  assert.equal(chunks.join(''), '❯ Answer\n\nabc def', 'no dots while the queue is draining')

  tick(100) // last paced byte at 5.5 s: drained, countdown re-anchored
  assert.equal(chunks.join(''), '❯ Answer\n\nabc def')

  tick(STREAM_IDLE_DOTS_ARM_MS - 1)
  assert.equal(chunks.join(''), '❯ Answer\n\nabc def', 'the countdown runs from the last byte, not the mid-drain arm')
  tick(1)
  assert.equal(chunks.join(''), '❯ Answer\n\nabc def.')
})

const QUALITY_PRICING = {
  perImage: null,
  byResolution: null,
  byQuality: { '1K': { low: 0.02, high: 0.26 }, '2K': { low: 0.03, high: 0.5 } },
}

test('imageUnitPrice picks the requested byQuality tier and the cheapest entry otherwise', () => {
  assert.equal(imageUnitPrice(QUALITY_PRICING, { resolution: '1K', quality: 'high' }), 0.26)
  assert.equal(imageUnitPrice(QUALITY_PRICING, { resolution: '2K', quality: 'low' }), 0.03)
  assert.equal(imageUnitPrice(QUALITY_PRICING, { resolution: '1K' }), 0.02)
  assert.equal(imageUnitPrice(QUALITY_PRICING, { resolution: '1K', quality: 'ultra' }), 0.02)
  // A tier with no numeric entry is not a price: fall through to byResolution.
  assert.equal(
    imageUnitPrice({ byQuality: { '1K': { note: 'call for price' } }, byResolution: { '1K': 0.5 } }, { resolution: '1K' }),
    0.5
  )
})

test('formatImagePrice renders the byQuality tier and falls back to the cross-tier floor', () => {
  assert.equal(formatImagePrice(QUALITY_PRICING, { resolution: '1K', quality: 'high' }), '$0.26 per image')
  assert.equal(formatImagePrice(QUALITY_PRICING, { resolution: '2K' }), '$0.03 per image')
  assert.equal(formatImagePrice(QUALITY_PRICING), 'from $0.02 per image')
  assert.equal(formatImagePrice(QUALITY_PRICING, { resolution: '4K' }), 'from $0.02 per image')
  // The floor skips non-numeric tier entries instead of letting them poison it.
  assert.equal(
    formatImagePrice({ byQuality: { '1K': { low: 0.02, note: 'call for price' }, '2K': { high: 0.5 } } }),
    'from $0.02 per image'
  )
})

test('formatElapsedSeconds renders minutes with zero-padded seconds past a minute', () => {
  assert.equal(formatElapsedSeconds(59_000), '59s')
  assert.equal(formatElapsedSeconds(59_500), '1m') // rounds up across the minute boundary
  assert.equal(formatElapsedSeconds(60_000), '1m')
  assert.equal(formatElapsedSeconds(61_000), '1m01s')
  assert.equal(formatElapsedSeconds(119_000), '1m59s')
  assert.equal(formatElapsedSeconds(125_000), '2m05s')
  assert.equal(formatElapsedSeconds(3_600_000), '60m')
})

const sessionFor = (model) => ({ updatedAt: '2026-01-01T00:00:00Z', model, messageCount: 1, title: '' })

test('formatSessionItem keeps a 35-column model id and truncates a longer one to 32 + ellipsis', () => {
  assert.equal(formatSessionItem(sessionFor('m'.repeat(35))).model, 'm'.repeat(35))
  assert.equal(formatSessionItem(sessionFor('m'.repeat(36))).model, `${'m'.repeat(32)}...`)
  assert.equal(stringWidth(formatSessionItem(sessionFor('m'.repeat(36))).model), 35)
})

test('formatSessionItem truncates by display width and never splits a grapheme cluster', () => {
  const cjk = formatSessionItem(sessionFor('能'.repeat(30))).model
  assert.equal(cjk, `${'能'.repeat(16)}...`)
  assert.equal(stringWidth(cjk), 35)

  // A VS16 cluster is two code points but two columns: a code-point walk
  // would fit 32 of them where only 16 whole clusters fit here.
  const heart = '❤️'
  const emoji = formatSessionItem(sessionFor(heart.repeat(30))).model
  assert.equal(emoji, `${heart.repeat(16)}...`)
  assert.equal(stringWidth(emoji), 35)
})

// Table pre-roll: lines that precede a pending table inside one parse batch
// are emitted individually before the table (which is emitted as a whole once
// its region is complete), so a one-chunk paragraph+table write keeps the
// paragraph.
test('streaming markdown emits the lines before a pending table within the same batch', () => {
  const chunks = []
  const stdout = { columns: 80, write: (chunk) => chunks.push(String(chunk)) }
  const renderer = createMarkdownRenderer({ stdout })

  renderer.write('intro line\n\na | b\n---|---\n1 | 2\n\n')

  assert.equal(plain(chunks.join('')), 'intro line\n\na  b\n---  ---\n1  2\n\n')
})

const searchCalls = []
const selectCalls = []

mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => {
      searchCalls.push(opts)
      return undefined
    },
    select: async (opts) => {
      selectCalls.push(opts)
      return opts?.default
    },
    checkbox: async () => { throw new Error('unexpected checkbox') },
  },
})

const { BACK_SENTINEL, selectProvider, selectImageProvider, selectReasoningEffort } = await import('../src/prompts.js')

const ENDPOINTS = [
  { providerName: 'Rho', pricing: { prompt: 0.000001, completion: 0.000002 } },
  { providerName: 'Xi', pricing: { prompt: 0.000003, completion: 0.000004 } },
]

test('provider search keeps the no-match empty state and only a targeted back query offers Back', async () => {
  searchCalls.length = 0
  await selectProvider(ENDPOINTS, false)
  const { source } = searchCalls[0]

  assert.equal((await source('zzz')).length, 0)
  assert.equal((await source('a')).length, 0, 'a letter inside "back" is not a back request')
  assert.equal((await source('ack')).length, 0)
  const prefix = await source('b')
  assert.equal(prefix.length, 1)
  assert.equal(prefix[0].value, BACK_SENTINEL)
  const back = await source('back')
  assert.equal(back.length, 1)
  assert.equal(back[0].value, BACK_SENTINEL)
})

test('a provider search without a Back choice never injects one, even for "back"', async () => {
  searchCalls.length = 0
  await selectImageProvider(ENDPOINTS, { withBack: false })
  const { source } = searchCalls[0]

  assert.equal((await source('back')).length, 0)
  assert.equal((await source('zzz')).length, 0)
})

test('selectReasoningEffort clamps a mandatory model default when none is not offered', async () => {
  selectCalls.length = 0
  const answer = await selectReasoningEffort(
    { supportsEffort: true, mandatory: true, supported_efforts: ['high', 'low'] },
    'none'
  )
  assert.equal(answer, 'high')
  assert.equal(selectCalls[0].default, 'high')
  assert.deepEqual(selectCalls[0].choices.map((c) => c.value), ['high', 'low'])
})

// A non-TTY stdin (pipe) has no setRawMode: start/stop must still manage the
// data listener and the resume/pause lifecycle without touching the terminal.
test('the stream key monitor tolerates an input without setRawMode (non-TTY)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const input = new EventEmitter()
  const calls = { resume: 0, pause: 0 }
  input.resume = () => { calls.resume += 1 }
  input.pause = () => { calls.pause += 1 }

  const list = []
  const monitor = createStreamKeyMonitor({
    input,
    onStop: () => list.push('stop'),
    onInterrupt: () => list.push('interrupt'),
  })

  monitor.start()
  input.emit('data', '\x1b')
  await t.mock.timers.tick(50)
  assert.deepEqual(list, ['stop'])

  monitor.stop()
  assert.equal(calls.resume, 1)
  assert.equal(calls.pause, 1)
})
