import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishNotice } from '../src/ui/format.js'

test('finishNotice returns the truncation line only for a length end with text', () => {
  assert.equal(finishNotice('length', 'partial answer'), 'Output limit reached — the answer above is incomplete.')
  assert.equal(finishNotice('length', ''), null)
  assert.equal(finishNotice('length', null), null)
})

test('finishNotice returns the early-end line for error and content_filter with text', () => {
  assert.equal(finishNotice('error', 'partial answer'), 'The response ended early (finish reason: error).')
  assert.equal(finishNotice('content_filter', 'partial answer'), 'The response ended early (finish reason: content_filter).')
  assert.equal(finishNotice('error', ''), null)
})

test('finishNotice claims nothing for stop, tool_calls or an absent reason', () => {
  assert.equal(finishNotice('stop', 'complete answer'), null)
  assert.equal(finishNotice('tool_calls', 'answer'), null)
  assert.equal(finishNotice(null, 'answer'), null)
  assert.equal(finishNotice(undefined, 'answer'), null)
})
