// Cross-path display invariants: the canonical formats shared by chat,
// one-shot, history replay and image sessions. See MEMORY.md §Display
// consistency contract.
/* eslint-disable no-control-regex */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamRenderer, renderHistory, printSources, attachmentLine } from '../src/ui/stream.js'
import { printArtifacts, printArtifactsSummary } from '../src/artifacts.js'
import { printImageOutcome } from '../src/commands/image-gen.js'
import { connectedBanner } from '../src/status-line.js'
import { styleText } from 'node:util'

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

test('connectedBanner has one canonical layout for every segments/hints combination', () => {
  assert.equal(
    connectedBanner(['venice / org/model']),
    '\nConnected to venice / org/model\n'
  )
  assert.equal(
    connectedBanner(['venice / org/model', '[zdr]', '[e2ee]']),
    '\nConnected to venice / org/model  [zdr]  [e2ee]\n'
  )
  assert.equal(
    connectedBanner(['venice / org/model'], { hints: ['/quit to exit'] }),
    '\nConnected to venice / org/model\n/quit to exit\n'
  )
  assert.equal(
    connectedBanner(['venice / org/model', '[image]'], { hints: ['Describe an image to generate it.'] }),
    '\nConnected to venice / org/model  [image]\nDescribe an image to generate it.\n'
  )
})

test('live streaming and history replay emit the same reasoning marker block', () => {
  const live = capture()
  const liveRender = createStreamRenderer({ stdout: live.stdout, markdown: false })
  liveRender('', 'start_reasoning')
  liveRender('thinking text', 'reasoning')
  liveRender('', 'end_reasoning')
  liveRender('answer', 'content')

  const history = capture()
  renderHistory([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', reasoning: 'thinking text' },
  ], { markdown: false, stdout: history.stdout })

  assert.equal(live.plain(), '❯ Thinking\nthinking text\n\n❯ Answer\n\nanswer')
  assert.match(history.plain(), /❯ Thinking\nthinking text\n\n❯ Answer\n\nanswer/)
})

test('attachmentLine styles the word, label, meta and note with one dim note', (t) => {
  enableAnsi(t)
  const line = attachmentLine('attached', 'photo.png', { meta: 'image, 7 B', note: 'saved to /tmp/photo.png' })
  assert.equal(
    line.replace(OSC8, ''),
    `${styleText(['dim'], `${styleText('italic', 'attached')}: photo.png`)} ${styleText('dim', '(image, 7 B)')}  ${styleText('dim', 'saved to /tmp/photo.png')}`
  )
})

test('printArtifacts uses the shared line format for image and file parts', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  printArtifacts([
    { part: { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, label: 'photo.png', savedTo: '/tmp/s/photo.png' },
    { part: { type: 'file', file: { filename: 'r.pdf', file_data: 'data:application/pdf;base64,BBBB' } }, label: 'r.pdf', error: '404' },
  ], stdout)
  assert.equal(plain(), 'image: photo.png  saved to /tmp/s/photo.png\nfile: r.pdf  download failed: 404\n')
  assert.match(text(), /\x1b\[2m\x1b\[3mimage\x1b\[23m: photo\.png\x1b\[22m {2}\x1b\[2msaved to \/tmp\/s\/photo\.png\x1b\[22m/)
})

test('printArtifactsSummary dims the malformed-chunk notice and honors the pipe suppressors', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  const apiResult = {
    sources: [{ title: 'S', url: 'https://s.example' }],
    skippedChunks: 2,
  }
  printArtifactsSummary([], apiResult, stdout)
  assert.equal(plain(), '\nSources (1)\n[1] S\n2 malformed stream chunks skipped\n')
  assert.match(text(), /\x1b\[2m2 malformed stream chunks skipped\x1b\[22m/)

  const piped = capture()
  printArtifactsSummary([], apiResult, piped.stdout, { withSources: false, withSkipped: false })
  assert.equal(piped.plain(), '')
})

test('printImageOutcome dims the saved-to lines like text-chat artifact notes', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  printImageOutcome({ savedPaths: ['/tmp/s/img1.webp', '/tmp/s/img2.webp'], sizing: '16:9 · webp', costLine: 'Cost: $0.031 per image × 2 = $0.0620' }, stdout)
  assert.equal(plain(), 'saved to /tmp/s/img1.webp\nsaved to /tmp/s/img2.webp\n16:9 · webp\nCost: $0.031 per image × 2 = $0.0620\n')
  assert.match(text(), /\x1b\[2msaved to \/tmp\/s\/img1\.webp\x1b\[22m/)
  assert.match(text(), /\x1b\[2msaved to \/tmp\/s\/img2\.webp\x1b\[22m/)
})

test('printSources numbering is shared by live turns and history replay', (t) => {
  enableAnsi(t)
  const { stdout, plain } = capture()
  printSources([{ title: 'One', url: 'https://one.example' }], stdout)
  assert.equal(plain(), '\nSources (1)\n[1] One\n')
})
