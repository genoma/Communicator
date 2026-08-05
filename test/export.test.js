import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatMarkdown, exportSession } from '../src/export.js'

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

test('exports a cost when the prompt price is zero', () => {
  const md = formatMarkdown(session({ pricing: { prompt: 0, completion: 0.5 } }))
  assert.match(md, /\*\*Cost:\*\* \$2\.500000/)
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

test('exports a Sources list with markdown links and converts inline citations', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Search something' },
      {
        role: 'assistant',
        content: 'Result from ^1^ and ^2^ plus ^3^.',
        sources: [
          { title: 'First', url: 'https://first.example/a' },
          { title: null, url: 'https://second.example/b' },
        ],
      },
    ],
  }))
  assert.match(md, /Result from \[1\]\(https:\/\/first\.example\/a\) and \[2\]\(https:\/\/second\.example\/b\) plus \^3\^\./)
  assert.match(md, /\*\*Sources:\*\*\n- \[First\]\(https:\/\/first\.example\/a\)\n- \[second\.example\]\(https:\/\/second\.example\/b\)/)
})

test('exports sources with hostname fallback and plain text for invalid URLs', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'ok',
        sources: [
          { title: null, url: 'https://host.example/x' },
          { title: 'Broken', url: 'not a url' },
        ],
      },
    ],
  }))
  assert.match(md, /- \[host\.example\]\(https:\/\/host\.example\/x\)/)
  assert.match(md, /- Broken\n/)
  assert.doesNotMatch(md, /- Broken\(/)
})

test('exports sources with neither title nor a parseable url as plain text', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'ok',
        sources: [
          { title: null, url: 'not a url' },
          { title: null, url: '' },
        ],
      },
    ],
  }))
  assert.match(md, /- not a url\n/)
  assert.match(md, /- \n/)
})

test('emits no Sources block and keeps citations literal without sources', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Plain ^1^' },
    ],
  }))
  assert.doesNotMatch(md, /\*\*Sources:\*\*/)
  assert.match(md, /Plain \^1\^/)
})

test('exportSession writes the markdown file and overwrites it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'session.md')

  await exportSession(session(), file)
  const first = await readFile(file, 'utf-8')
  assert.match(first, /^# Chat Session/)

  await exportSession(session({ model: 'other/model' }), file)
  const second = await readFile(file, 'utf-8')
  assert.match(second, /\*\*Model:\*\* `other\/model`/)
})

test('exportSession rejects when the target path is not writable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(
    exportSession(session(), join(dir, 'missing', 'out.md')),
    { code: 'ENOENT' }
  )
})
