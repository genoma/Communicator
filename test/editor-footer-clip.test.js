/* eslint-disable no-control-regex */
// The suite forces NO_COLOR=1, so no real SGR sequence ever reaches the
// clippers in an integration run: these cases drive clipToWidth and wrapWords
// with literal escape sequences instead, which is the only way the escape-run
// branches execute.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { clipToWidth } from '../src/editor/footer.js'
import { wrapWords } from '../src/ui/wrap.js'

const SGR = '\x1b[31mabcdefgh\x1b[39m'

test('clipToWidth copies a literal SGR run whole and enforces the visible width', () => {
  assert.equal(clipToWidth(SGR, 8), SGR)
  assert.equal(clipToWidth(SGR, 4), '\x1b[31mabcd\x1b[39m')
  assert.equal(clipToWidth(SGR, 2), '\x1b[31mab\x1b[39m')
  assert.equal(stringWidth(clipToWidth(SGR, 4)), 4)
  assert.equal(stringWidth(clipToWidth(SGR, 2)), 2)
})

test('clipToWidth keeps both SGR markers when the cut lands inside the styled region', () => {
  const clipped = clipToWidth(SGR, 4)
  assert.equal(clipped, '\x1b[31mabcd\x1b[39m')
  assert.ok(clipped.endsWith('\x1b[39m'), 'the closing SGR survives the cut, so the colour cannot bleed')
  assert.equal(clipped.replace(/\x1b\[[0-9;]*m/g, ''), 'abcd')
  assert.equal(clipToWidth('\x1b[31mabcdefgh', 4), '\x1b[31mabcd')
  assert.equal(clipToWidth('abcdefgh\x1b[39m', 4), 'abcd\x1b[39m')
})

test('clipToWidth budgets wide clusters at two columns and drops them whole', () => {
  const wide = '\x1b[31mあいう\x1b[39m'
  assert.equal(clipToWidth(wide, 5), '\x1b[31mあい\x1b[39m')
  assert.equal(clipToWidth(wide, 3), '\x1b[31mあ\x1b[39m')
  assert.equal(clipToWidth(wide, 1), '\x1b[31m\x1b[39m')
  assert.equal(stringWidth(clipToWidth(wide, 3)), 2)
})

test('wrapWords treats an unterminated CSI run as one atom', () => {
  assert.deepEqual(wrapWords('\x1b[1;2', 2), ['\x1b[1;2'])
  assert.deepEqual(wrapWords('abcd\x1b[1;2', 2), ['ab', 'cd\x1b[1;2'])
})

test('wrapWords swallows an unterminated OSC run instead of measuring it as text', () => {
  const truncated = '\x1b]0;t' + 'a'.repeat(10)
  assert.deepEqual(wrapWords(truncated, 4), [truncated])
  assert.deepEqual(wrapWords(`hi ${truncated}`, 4), [`hi ${truncated}`])
})

test('wrapWords treats a two-byte escape as one atom', () => {
  assert.deepEqual(wrapWords('\x1bM' + 'a'.repeat(6), 2), ['\x1bMaa', 'aa', 'aa'])
  assert.deepEqual(wrapWords('x \x1bMabc', 2), ['x', '\x1bMab', 'c'])
})

test('wrapWords folds after a BEL-terminated OSC 8 hyperlink close', () => {
  const link = '\x1b]8;;https://x.example\x07aa\x1b]8;;\x07'
  assert.deepEqual(wrapWords(`${link} bbbb`, 4), [link, 'bbbb'])
  assert.deepEqual(wrapWords(`x ${link} z`, 4), [`x ${link}`, 'z'])
})

test('wrapWords folds an over-wide BEL-closed hyperlink whole when it starts the line', () => {
  const bel = '\x1b]8;;https://x.example\x07aaaaaa\x1b]8;;\x07'
  const st = '\x1b]8;;https://x.example\x1b\\aaaaaa\x1b]8;;\x1b\\'
  assert.deepEqual(wrapWords(`${bel} z`, 4), [bel, ' z'])
  assert.deepEqual(wrapWords(`${st} z`, 4), [st, ' z'])
})
