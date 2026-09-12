import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LINE_LENGTH, isCheckableLine, isProseRange, isProseWord } from '../src/spelling/mask.js'

test('prose words are accepted, including Italian and Russian', () => {
  for (const word of ['mispelled', 'wrold', 'freind', 'typoo', 'erore', 'battitura', 'тест', 'привет', 'café', 'hello,', 'hello!', 'teh.', '"wrold"', "don't", 'e-mail']) {
    assert.equal(isProseWord(word), true, `${word} must be prose`)
  }
})

test('code-ish, numeric and emoji tokens are rejected', () => {
  const words = [
    '', '   ',
    'src/chat.js', 'github.com', 'https://example.com', 'file_name', 'a=b', 'x:y', 'a\\b', 'a@b', 'ns#x', '~tmp', '$PATH', '50%', '{x}', '[x]', '<x>',
    '--rpg', '-x', '+x', '(--rpg)',
    'gpt-4o', 'gpt4', 'model2',
    'camelCase', 'openAI',
    '😀', '🎉', '💰', '👨‍👩‍👧', '...', '--',
  ]
  for (const word of words) {
    assert.equal(isProseWord(word), false, `${word} must not be prose`)
  }
})

test('a range is judged by the token around it', () => {
  assert.equal(isProseRange('Fix teh quick brown fox.', 4, 7), true)
  assert.equal(isProseRange('This is a mispelled word.', 10, 19), true)
  assert.equal(isProseRange('use the --rpg flag', 10, 13), false)
  assert.equal(isProseRange('read src/chat.js now', 9, 16), false)
  assert.equal(isProseRange('visit github.com please', 6, 16), false)
  assert.equal(isProseRange('model openai/gpt-4o is good', 6, 12), false)
  assert.equal(isProseRange('a wrold, indeed', 2, 7), true)
})

test('lines that must never be checked', () => {
  assert.equal(isCheckableLine('hello wrold'), true)
  assert.equal(isCheckableLine('   hello   '), true)
  assert.equal(isCheckableLine(''), false)
  assert.equal(isCheckableLine('   '), false)
  assert.equal(isCheckableLine('/settings typo on'), false)
  assert.equal(isCheckableLine('  /quit'), false)
  assert.equal(isCheckableLine('a'.repeat(MAX_LINE_LENGTH)), true)
  assert.equal(isCheckableLine('a'.repeat(MAX_LINE_LENGTH + 1)), false)
  assert.equal(isCheckableLine(null), false)
  assert.equal(isCheckableLine(undefined), false)
})
