import { test } from 'node:test'
import assert from 'node:assert/strict'
import { printSources } from '../src/ui/stream.js'

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
