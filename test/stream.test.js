import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamRenderer, printSources } from '../src/ui/stream.js'

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
  assert.equal(plain(), '\nSources\n[1] Samsung in talks\n[2] Mistral deal\n')
  assert.match(out, /\x1b\[2mSources\x1b\[22m/)
  assert.match(out, /\[1\] \x1b\[3m\x1b\]8;;https:\/\/econ\.example\/a\x1b\\Samsung in talks\x1b\]8;;\x1b\\\x1b\[23m/)
  assert.match(out, /\[2\] \x1b\[3m\x1b\]8;;https:\/\/msft\.example\/b\x1b\\Mistral deal\x1b\]8;;\x1b\\\x1b\[23m/)
})

test('printSources falls back to hostname and dimmed italic URL', (t) => {
  enableAnsi(t)
  const { stdout, text, plain } = capture()
  printSources([
    { title: null, url: 'https://host.example/x' },
    { title: 'No URL', url: '' },
  ], stdout)
  assert.equal(plain(), '\nSources\n[1] host.example\n[2] No URL\n')
  const out = text()
  assert.match(out, /\[1\] \x1b\[3m\x1b\]8;;https:\/\/host\.example\/x\x1b\\host\.example\x1b\]8;;\x1b\\\x1b\[23m/)
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
  assert.equal(plain(), '[Thinking]\nTH')
  pump()
  pump()
  pump()
  assert.equal(plain(), '[Thinking]\nTHINKING\n\n[Answer]\n\n')
  pump()
  assert.equal(plain(), '[Thinking]\nTHINKING\n\n[Answer]\n\nHE')
  pump()
  pump()
  assert.equal(plain(), '[Thinking]\nTHINKING\n\n[Answer]\n\nHELLO')
  pump()
  pump()
  pump()
  assert.equal(plain(), '[Thinking]\nTHINKING\n\n[Answer]\n\nHELLO')
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
