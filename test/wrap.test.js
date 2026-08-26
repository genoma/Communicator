import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWordWrap, wrapWords } from '../src/ui/wrap.js'

test('wrapWords passes through without a usable width', () => {
  assert.deepEqual(wrapWords('abc def', null), ['abc def'])
  assert.deepEqual(wrapWords('abc def', 0), ['abc def'])
  assert.deepEqual(wrapWords('abc def', undefined), ['abc def'])
})

test('wrapWords folds at word boundaries', () => {
  assert.deepEqual(wrapWords('aaa bbb ccc ddd eee fff', 20), ['aaa bbb ccc ddd eee', 'fff'])
  assert.deepEqual(wrapWords('aaa bbb', 20), ['aaa bbb'])
})

test('wrapWords hard-cuts words longer than the width', () => {
  assert.deepEqual(wrapWords('abcdefghijklm ddd', 10), ['abcdefghij', 'klm ddd'])
  assert.deepEqual(wrapWords('a'.repeat(25), 10), ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
})

test('wrapWords folds a word that exactly fills the line', () => {
  assert.deepEqual(wrapWords('aaaaaaaaaa bbb', 10), ['aaaaaaaaaa', 'bbb'])
})

test('wrapWords never splits surrogate pairs', () => {
  assert.deepEqual(wrapWords('😀😀😀', 4), ['😀😀', '😀'])
  assert.deepEqual(wrapWords('xx 😀😀', 4), ['xx', '😀😀'])
})

test('wrapWords hard-cuts wide chars on width boundaries', () => {
  assert.deepEqual(wrapWords('あ'.repeat(6), 10), ['あああああ', 'あ'])
})

test('wrapWords keeps escape runs intact across folds', () => {
  assert.deepEqual(wrapWords('\x1b[1mbold text here\x1b[22m', 10), ['\x1b[1mbold text', 'here\x1b[22m'])
  assert.deepEqual(wrapWords('\x1b[2mdim and long text\x1b[22m', 8), ['\x1b[2mdim and', 'long', 'text\x1b[22m'])
})

test('wrapWords keeps OSC 8 hyperlinks as whole atoms', () => {
  const link = '\x1b]8;;https://x.example\x1b\\aa bb\x1b]8;;\x1b\\'
  const segments = wrapWords(`x ${link} z`, 4)
  assert.equal(segments[0], 'x ')
  assert.equal(segments[1], link)
  assert.equal(segments[2], ' z')
})

test('wrapWords drops only the space at the fold point', () => {
  assert.deepEqual(wrapWords('aa  bb c', 4), ['aa ', 'bb c'])
})

test('wrapWords returns the empty input unchanged', () => {
  assert.deepEqual(wrapWords('', 10), [''])
})

const streamed = (text, cols, style = null) => {
  const chunks = []
  const wrap = createWordWrap({ stdout: { write: (c) => chunks.push(String(c)) }, cols, style })
  wrap.write(text)
  wrap.flush()
  return chunks.join('')
}

test('createWordWrap folds at word boundaries', () => {
  assert.equal(streamed('aaa bbb ccc ddd', 10), 'aaa bbb\nccc ddd')
  assert.equal(streamed('aaa bbb\nccc', 10), 'aaa bbb\nccc')
})

test('createWordWrap chunks overlong words at the exact width', () => {
  assert.equal(streamed('a'.repeat(25) + ' y', 10), `${'a'.repeat(10)}\n${'a'.repeat(10)}\n${'a'.repeat(5)} y`)
})

test('createWordWrap never splits wide characters or surrogate pairs', () => {
  assert.equal(streamed('あいあいあい', 4), 'あい\nあい\nあい')
  assert.equal(streamed('😀😀😀', 4), '😀😀\n😀')
})

test('createWordWrap styles each piece and keeps fold newlines raw', () => {
  const chunks = []
  const wrap = createWordWrap({ stdout: { write: (c) => chunks.push(String(c)) }, cols: 5, style: (s) => `[${s}]` })
  wrap.write('ab cd')
  wrap.write(' ef')
  wrap.flush()
  assert.equal(chunks.join(''), '[ab][ cd]\n[ef]')
})

test('createWordWrap passes through unchanged without a width', () => {
  assert.equal(streamed('aaa bbb ccc ddd eee fff ggg hhh', null), 'aaa bbb ccc ddd eee fff ggg hhh')
})

test('wrapWords folds at a space that would cross the exact row width', () => {
  // A space after a word that already fills the row is the fold point: it is
  // dropped, so no segment is ever wider than the terminal (an over-wide row
  // would soft-wrap in the shell). Regression for the wrapSegments 5846a7e
  // bug class in the plain-word wrapper.
  assert.deepEqual(wrapWords('ab  cd', 2), ['ab', 'cd'])
  assert.deepEqual(wrapWords('abc  def', 3), ['abc', 'def'])
  assert.deepEqual(wrapWords('aaaa bbbbb', 5), ['aaaa', 'bbbbb'])
  assert.deepEqual(wrapWords('x  y', 2), ['x ', 'y']) // committed space stays, fold space dropped
})

test('createWordWrap resolves the width lazily per write', () => {
  const out = []
  const stdout = { write: (s) => out.push(s) }
  let cols = 10
  const w = createWordWrap({ stdout, cols: () => cols })
  w.write('aaaa bbbb cccc')
  w.flush()
  cols = 4
  w.write('yy yy')
  w.flush()
  assert.equal(out.join(''), 'aaaa bbbb\ncccc\nyy\nyy') // width 4: 'yy yy' folds to two rows
})

test('createWordWrap passes through when the width getter yields no width', () => {
  const out = []
  const stdout = { write: (s) => out.push(s) }
  const w = createWordWrap({ stdout, cols: () => undefined })
  w.write('unchanged text  there')
  w.flush()
  assert.equal(out.join(''), 'unchanged text  there')
})
