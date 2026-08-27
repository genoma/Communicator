import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hyperlink, sanitizeAnsi } from '../src/ui/hyperlink.js'

test('hyperlink wraps a plain url and label in OSC 8 escapes', () => {
  assert.equal(hyperlink('https://example.com', 'Example'), '\x1b]8;;https://example.com\x1b\\Example\x1b]8;;\x1b\\')
})

test('hyperlink strips SGR escape sequences from the url', () => {
  assert.equal(hyperlink('https://example.com\x1b[31m\x1b[0m', 'x'), '\x1b]8;;https://example.com\x1b\\x\x1b]8;;\x1b\\')
})

test('hyperlink strips SGR and OSC 8 sequences from the label', () => {
  const label = '\x1b[1mbold\x1b[0m \x1b]8;;https://evil.test\x1b\\hidden\x1b]8;;\x1b\\rest'
  assert.equal(hyperlink('https://example.com', label), '\x1b]8;;https://example.com\x1b\\bold hiddenrest\x1b]8;;\x1b\\')
})

test('hyperlink strips raw escape, newline and carriage return bytes', () => {
  assert.equal(hyperlink('https://example.com/\x1b\n\rx', 'l'), '\x1b]8;;https://example.com/x\x1b\\l\x1b]8;;\x1b\\')
})

test('hyperlink returns null for empty or nullish urls', () => {
  assert.equal(hyperlink('', 'label'), null)
  assert.equal(hyperlink(null, 'label'), null)
  assert.equal(hyperlink(undefined, 'label'), null)
})

test('hyperlink coerces non-string urls and labels', () => {
  assert.equal(hyperlink('https://example.com', 7), '\x1b]8;;https://example.com\x1b\\7\x1b]8;;\x1b\\')
})

test('hyperlink returns null for non-http(s) schemes', () => {
  assert.equal(hyperlink(42, 7), null)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi']) {
    assert.equal(hyperlink(url, 'x'), null)
  }
  assert.ok(hyperlink('http://example.com', 'x'))
})

test('sanitizeAnsi strips C1 controls (U+009B is 8-bit CSI)', () => {
  assert.equal(sanitizeAnsi('hello\u009b2Jworld'), 'hello2Jworld')
})

test('sanitizeAnsi strips bare C0 controls but keeps newline and tab', () => {
  assert.equal(sanitizeAnsi('a\u0007b'), 'ab') // BEL
  assert.equal(sanitizeAnsi('a\rb'), 'ab') // CR
  assert.equal(sanitizeAnsi('a\r\nb'), 'a\nb') // CRLF collapses to LF
  assert.equal(sanitizeAnsi('a\nb\tc'), 'a\nb\tc') // LF/tab preserved
  assert.equal(sanitizeAnsi('x\u007f\u009b'), 'x') // DEL + C1
})
