import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMarkdown } from '../src/export.js'

function session(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'TestProvider',
    reasoningEffort: 'high',
    pricing: { prompt: 0.0000025, completion: 0.00001 },
    createdAt: '2026-07-30T19:11:45.000Z',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'What is the capital of France?' },
      {
        role: 'assistant',
        content: 'Paris.',
        reasoning: 'The user asks a geography question.',
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    ],
    ...overrides,
  }
}

test('formats a full session with thinking block and cost line', () => {
  const md = formatMarkdown(session())

  assert.match(md, /^# Chat Session — 2026-07-30 19:11:45 UTC/)
  assert.match(md, /\*\*Model:\*\* `test\/model`/)
  assert.match(md, /\*\*Provider:\*\* TestProvider/)
  assert.match(md, /\*\*Messages:\*\* 2/)
  assert.match(md, /\*\*Reasoning:\*\* high/)
  assert.match(md, /\*\*Cost:\*\* \$0\.000080/)
  assert.match(md, /## You/)
  assert.match(md, /> What is the capital of France\?/)
  assert.match(md, /### thinking/)
  assert.match(md, /The user asks a geography question\./)
  assert.match(md, /### Answer/)
  assert.match(md, /Paris\./)
})

test('hides system messages and omits cost when pricing is missing', () => {
  const md = formatMarkdown(session({ pricing: null, reasoningEffort: null }))
  assert.doesNotMatch(md, /You are helpful\./)
  assert.match(md, /\*\*Cost:\*\* N\/A/)
  assert.doesNotMatch(md, /\*\*Reasoning:\*\*/)
})

test('formats user attachments as blockquoted attachment lines', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
        ],
      },
      { role: 'assistant', content: 'I see it.' },
    ],
  }))
  assert.match(md, /> Look at this/)
  assert.match(md, /> \*\*Attachment:\*\* `image\.png`/)
  assert.match(md, /> \*\*Attachment:\*\* `report\.pdf`/)
})
