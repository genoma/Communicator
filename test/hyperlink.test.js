import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hyperlink } from '../src/ui/hyperlink.js'

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
  assert.equal(hyperlink(42, 7), '\x1b]8;;42\x1b\\7\x1b]8;;\x1b\\')
})
