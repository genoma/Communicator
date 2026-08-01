import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_COMMANDS } from '../src/commands.js'
import { matchCommands, nextMatchIndex, shouldSuggest } from '../src/suggest.js'

test('matchCommands filters commands by prefix', () => {
  assert.deepEqual(matchCommands('/', CHAT_COMMANDS), CHAT_COMMANDS)
  assert.deepEqual(matchCommands('/m', CHAT_COMMANDS), ['/model', '/markdown'])
  assert.deepEqual(matchCommands('/mo', CHAT_COMMANDS), ['/model'])
  assert.deepEqual(matchCommands('/nope', CHAT_COMMANDS), [])
  assert.deepEqual(matchCommands('', CHAT_COMMANDS), CHAT_COMMANDS)
})

test('shouldSuggest: "/" alone matches all commands', () => {
  assert.equal(shouldSuggest({ value: '/', cursor: 1 }, CHAT_COMMANDS), true)
})

test('shouldSuggest: "/mo" suggests because it is a non-exact prefix', () => {
  assert.equal(shouldSuggest({ value: '/mo', cursor: 3 }, CHAT_COMMANDS), true)
})

test('shouldSuggest: "/m" suggests with multiple matches', () => {
  assert.equal(shouldSuggest({ value: '/m', cursor: 2 }, CHAT_COMMANDS), true)
})

test('shouldSuggest: no leading slash returns false', () => {
  assert.equal(shouldSuggest({ value: 'mo', cursor: 2 }, CHAT_COMMANDS), false)
  assert.equal(shouldSuggest({ value: 'hello', cursor: 5 }, CHAT_COMMANDS), false)
})

test('shouldSuggest: cursor not at line end returns false', () => {
  assert.equal(shouldSuggest({ value: '/mo', cursor: 1 }, CHAT_COMMANDS), false)
})

test('shouldSuggest: multi-line buffer returns false', () => {
  assert.equal(shouldSuggest({ value: '/new\nnext', cursor: 10 }, CHAT_COMMANDS), false)
})

test('shouldSuggest: exact match hides the list', () => {
  assert.equal(shouldSuggest({ value: '/model', cursor: 6 }, CHAT_COMMANDS), false)
  assert.equal(shouldSuggest({ value: '/quit', cursor: 5 }, CHAT_COMMANDS), false)
})

test('shouldSuggest: prefix of nothing returns false', () => {
  assert.equal(shouldSuggest({ value: '/foo', cursor: 4 }, CHAT_COMMANDS), false)
})

test('nextMatchIndex wraps forward from no exact match', () => {
  const matches = ['/model', '/markdown']
  assert.equal(nextMatchIndex('/m', matches, 1), 0)
  assert.equal(nextMatchIndex('/m', matches, -1), 1)
})

test('nextMatchIndex wraps around at the edges', () => {
  const matches = ['/a', '/b', '/c']
  assert.equal(nextMatchIndex('/a', matches, 1), 1)
  assert.equal(nextMatchIndex('/c', matches, 1), 0)
  assert.equal(nextMatchIndex('/a', matches, -1), 2)
})

test('nextMatchIndex starts from the exact match when present', () => {
  const matches = ['/model', '/markdown']
  assert.equal(nextMatchIndex('/model', matches, 1), 1)
  assert.equal(nextMatchIndex('/markdown', matches, -1), 0)
})

test('nextMatchIndex returns -1 for an empty match list', () => {
  assert.equal(nextMatchIndex('/mo', [], 1), -1)
})

test('CHAT_COMMANDS has 10 commands', () => {
  assert.equal(CHAT_COMMANDS.length, 10)
  assert.deepEqual(CHAT_COMMANDS, [
    '/quit',
    '/new',
    '/model',
    '/reasoning',
    '/temp',
    '/budget',
    '/retry',
    '/copy',
    '/markdown',
    '/cost',
  ])
})
