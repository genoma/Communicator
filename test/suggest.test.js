import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_COMMANDS } from '../src/commands/chat/index.js'
import { matchCommands, nextMatchIndex, shouldSuggest } from '../src/suggest.js'
import { updateSuggestionSession } from '../src/vendor/read-multiline/rendering.js'
import { nextSuggestionMove } from '../src/vendor/read-multiline/editing.js'

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

test('CHAT_COMMANDS has 17 commands', () => {
  assert.equal(CHAT_COMMANDS.length, 17)
  assert.deepEqual(CHAT_COMMANDS, [
    '/quit',
    '/exit',
    '/new',
    '/model',
    '/attach',
    '/attachments',
    '/reasoning',
    '/temp',
    '/budget',
    '/web-search',
    '/web-results',
    '/scrape',
    '/retry',
    '/copy',
    '/markdown',
    '/smooth',
    '/cost',
  ])
})

function sessionFor(value, previousSession) {
  const state = {
    lines: [value],
    row: 0,
    col: value.length,
    suggest: ({ value: v }) => matchCommands(v, CHAT_COMMANDS),
    suggestSession: previousSession ?? null,
  }
  updateSuggestionSession(state)
  return state.suggestSession
}

test('updateSuggestionSession: "/" alone opens a session with all commands', () => {
  const session = sessionFor('/')
  assert.deepEqual(session, { prefix: '/', matches: CHAT_COMMANDS, index: 0 })
})

test('updateSuggestionSession: non-exact prefix opens a session', () => {
  const session = sessionFor('/m')
  assert.deepEqual(session, { prefix: '/m', matches: ['/model', '/markdown'], index: 0 })
})

test('updateSuggestionSession: exact match typed by hand has no session', () => {
  assert.equal(sessionFor('/model'), null)
  assert.equal(sessionFor('/quit'), null)
})

test('updateSuggestionSession: exact match within an active session keeps it and tracks the index', () => {
  const previous = sessionFor('/m')
  const session = sessionFor('/markdown', previous)
  assert.deepEqual(session, { prefix: '/m', matches: ['/model', '/markdown'], index: 1 })
})

test('updateSuggestionSession: no matching commands clears the session', () => {
  assert.equal(sessionFor('/foo'), null)
})

test('updateSuggestionSession: cursor not at line end clears the session', () => {
  const state = {
    lines: ['/m'],
    row: 0,
    col: 1,
    suggest: ({ value }) => matchCommands(value, CHAT_COMMANDS),
    suggestSession: { prefix: '/m', matches: ['/model', '/markdown'], index: 0 },
  }
  updateSuggestionSession(state)
  assert.equal(state.suggestSession, null)
})

test('updateSuggestionSession: multi-line buffer clears the session', () => {
  const state = {
    lines: ['/m', 'second'],
    row: 1,
    col: 6,
    suggest: ({ value }) => matchCommands(value, CHAT_COMMANDS),
    suggestSession: { prefix: '/m', matches: ['/model', '/markdown'], index: 0 },
  }
  updateSuggestionSession(state)
  assert.equal(state.suggestSession, null)
})

test('nextSuggestionMove: forward from a typed prefix selects the first match', () => {
  const session = sessionFor('/m')
  assert.deepEqual(nextSuggestionMove(session, '/m', 1), { line: '/model', index: 0 })
})

test('nextSuggestionMove: backward from a typed prefix wraps to the last match', () => {
  const session = sessionFor('/m')
  assert.deepEqual(nextSuggestionMove(session, '/m', -1), { line: '/markdown', index: 1 })
})

test('nextSuggestionMove: cycles forward from a filled match (Tab no longer dead-ends)', () => {
  const session = sessionFor('/m')
  const first = nextSuggestionMove(session, '/m', 1)
  assert.deepEqual(nextSuggestionMove(session, first.line, 1), { line: '/markdown', index: 1 })
})

test('nextSuggestionMove: wraps around at the edges', () => {
  const session = sessionFor('/m')
  assert.deepEqual(nextSuggestionMove(session, '/markdown', 1), { line: '/model', index: 0 })
  assert.deepEqual(nextSuggestionMove(session, '/model', -1), { line: '/markdown', index: 1 })
})

test('nextSuggestionMove: single-match session fills the match, then no longer changes the line', () => {
  const session = sessionFor('/mo')
  assert.deepEqual(nextSuggestionMove(session, '/mo', 1), { line: '/model', index: 0 })
  assert.deepEqual(nextSuggestionMove(session, '/mo', -1), { line: '/model', index: 0 })
  assert.equal(nextSuggestionMove(session, '/model', 1), null)
  assert.equal(nextSuggestionMove(session, '/model', -1), null)
})

test('nextSuggestionMove: no session returns null', () => {
  assert.equal(nextSuggestionMove(null, '/m', 1), null)
})
