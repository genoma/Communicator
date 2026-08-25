import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapWords } from '../src/ui/wrap.js'

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
