import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatMarkdown, exportSession, formatJsonl } from '../src/export.js'

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

test('formatJsonl emits a session header and one object per message', () => {
  const jsonl = formatJsonl(session(), 'sess-1')
  const lines = jsonl.trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 4) // header + system + user + assistant
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[0].id, 'sess-1')
  assert.equal(lines[0].model, 'test/model')
  assert.equal(lines[0].providerName, 'TestProvider')
  assert.equal(lines[0].costSummary, null)
  assert.deepEqual(lines[1], { role: 'system', content: 'You are helpful.' })
  assert.deepEqual(lines[2], { role: 'user', content: 'What is the capital of France?' })
  assert.deepEqual(lines[3], { role: 'assistant', content: 'Paris.', reasoning: 'The user asks a geography question.', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })
})

test('formatMarkdown prefers the persisted costSummary over the replay calculation', () => {
  // The replay from usage would be 12*2.5e-6 + 5*1e-5 = 0.00008, but the
  // persisted summary (the authoritative total incl. scrapes) is preferred.
  const md = formatMarkdown(session({
    costSummary: { promptTokens: 12, completionTokens: 5, totalTokens: 17, cost: 0.99, requests: 1, cacheHits: 0, cachedTokens: 0, scrapes: 0 },
  }))
  assert.match(md, /\*\*Cost:\*\* \$0\.990000/)
})

test('formatJsonl escapes embedded newlines/control char keeping one object per line', () => {
  const jsonl = formatJsonl(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'line one\nline two\u0007\u001b[31mred\u001b[0m' },
      { role: 'assistant', content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ],
  }), 'sess-esc')
  const lines = jsonl.trim().split('\n')
  assert.equal(lines.length, 4) // header + system + user + assistant, never split by content
  const parsed = lines.map(JSON.parse)
  assert.ok(parsed.every((l) => typeof l === 'object'))
  assert.equal(parsed[2].content, 'line one\nline two\u0007\u001b[31mred\u001b[0m')
})

test('jsonl export writes a .jsonl file and does not materialize attachments', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = session({
    costSummary: { promptTokens: 12, completionTokens: 5, totalTokens: 17, cost: 0.00008, requests: 1, cacheHits: 0, cachedTokens: 0, scrapes: 0 },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ],
  })
  const folder = await exportSession(data, dir, 'sess-1', 'jsonl')
  const folderEntries = await readdir(folder)
  assert.ok(folderEntries.includes('session-sess-1.jsonl'))
  assert.ok(!folderEntries.includes('attachments'), 'jsonl does not materialize attachments')
  const raw = await readFile(join(folder, 'session-sess-1.jsonl'), 'utf-8')
  const lines = raw.trim().split('\n').map(JSON.parse)
  assert.equal(lines[0].costSummary.cost, 0.00008)
  assert.equal(lines[3].content, 'hello')
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

test('exports produced image and file parts under assistant answers', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Make an image' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'file', file: { filename: 'out.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
        ],
      },
    ],
  }))
  assert.match(md, /Done\./)
  assert.doesNotMatch(md, /\[object Object\]/)
  assert.match(md, /> \*\*Image:\*\* `image\.png`/)
  assert.match(md, /> \*\*File:\*\* `out\.pdf`/)
})

test('exports remote artifact URLs as markdown links', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Make an image' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done.' },
          { type: 'image_url', image_url: { url: 'https://img.example/photo.png' } },
        ],
      },
    ],
  }))
  assert.match(md, /> \*\*Image:\*\* \[photo\.png\]\(https:\/\/img\.example\/photo\.png\)/)
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

test('exportSession writes the markdown file into a session folder and overwrites it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = '2026-07-30T19-11-45'
  const file = join(dir, `session-${id}`, `session-${id}.md`)

  const folder = await exportSession(session(), dir, id)
  assert.equal(folder, join(dir, `session-${id}`))

  const first = await readFile(file, 'utf-8')
  assert.match(first, /^# Chat Session/)

  await exportSession(session({ model: 'other/model' }), dir, id)
  const second = await readFile(file, 'utf-8')
  assert.match(second, /\*\*Model:\*\* `other\/model`/)
})

test('exportSession rejects when the target directory is not writable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'not a directory')
  await assert.rejects(
    exportSession(session(), blocker, '2026-07-30T19-11-45'),
    { code: 'ENOTDIR' }
  )
})

test('materializes user attachment parts as files with relative links', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const png = Buffer.from('png-bytes')
  const pdf = Buffer.from('pdf-bytes')
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          { type: 'file', file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } },
        ],
      },
      { role: 'assistant', content: 'I see it.' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.deepEqual(await readFile(join(folder, 'attachments', 'image.png')), png)
  assert.deepEqual(await readFile(join(folder, 'attachments', 'report.pdf')), pdf)

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /> \*\*Attachment:\*\* \[image\.png\]\(attachments\/image\.png\)/)
  assert.match(md, /> \*\*Attachment:\*\* \[report\.pdf\]\(attachments\/report\.pdf\)/)
})

test('materializes assistant-produced image and file parts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const png = Buffer.from('gen-image-bytes')
  const pdf = Buffer.from('gen-pdf-bytes')
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Make an image and a pdf' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          { type: 'file', file: { filename: 'out.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } },
        ],
      },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.deepEqual(await readFile(join(folder, 'attachments', 'image.png')), png)
  assert.deepEqual(await readFile(join(folder, 'attachments', 'out.pdf')), pdf)

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /> \*\*Image:\*\* \[image\.png\]\(attachments\/image\.png\)/)
  assert.match(md, /> \*\*File:\*\* \[out\.pdf\]\(attachments\/out\.pdf\)/)
})

test('dedupes attachment filenames within a session with distinct files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = Buffer.from('first-png')
  const second = Buffer.from('second-png')
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'two images' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${first.toString('base64')}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${second.toString('base64')}` } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.deepEqual(await readFile(join(folder, 'attachments', 'image.png')), first)
  assert.deepEqual(await readFile(join(folder, 'attachments', 'image-2.png')), second)

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /\[image\.png\]\(attachments\/image\.png\)/)
  assert.match(md, /\[image\.png\]\(attachments\/image-2\.png\)/)
})

test('leaves remote http(s) parts as absolute links and writes no file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Make an image' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done.' },
          { type: 'image_url', image_url: { url: 'https://img.example/photo.png' } },
        ],
      },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /> \*\*Image:\*\* \[photo\.png\]\(https:\/\/img\.example\/photo\.png\)/)
  assert.deepEqual(await readdir(folder), ['session-2026-07-30T19-11-45.md'])
})

test('keeps text-file attachments inline and writes no file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this file' },
          { type: 'text', text: 'some inline file contents' },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.ok(md.includes('Read this file'))
  assert.ok(md.includes('some inline file contents'))
  assert.deepEqual(await readdir(folder), ['session-2026-07-30T19-11-45.md'])
})

test('warns and renders the backtick fallback for corrupt data URLs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png,not-base64-payload' } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.equal(warnings.length, 1)
  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /> \*\*Attachment:\*\* `image\.png`/)
  assert.deepEqual(await readdir(folder), ['session-2026-07-30T19-11-45.md'])
})

test('formatMarkdown renders materialized attachment links via the callback', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  }), () => 'attachments/x.png')
  assert.match(md, /> \*\*Attachment:\*\* \[image\.png\]\(attachments\/x\.png\)/)
  assert.match(md, /> \*\*Attachment:\*\* \[doc\.pdf\]\(attachments\/x\.png\)/)
})

test('escapes raw HTML in user and assistant content', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: '<img src=x onerror=alert(1)>' },
      { role: 'assistant', content: '<script>alert(2)</script> done' },
    ],
  }))
  assert.match(md, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(md, /&lt;script&gt;alert\(2\)&lt;\/script&gt; done/)
  assert.doesNotMatch(md, /<script>alert/)
})

test('does not linkify non-http(s) source urls', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'see ^1^', sources: [{ title: 'evil', url: 'javascript:alert(1)' }] },
    ],
  }))
  assert.doesNotMatch(md, /\(javascript:/)
  assert.match(md, /see \^1\^/)
  assert.match(md, /- evil/)
  assert.doesNotMatch(md, /\[evil\]/)
})

test('neutralizes non-http(s) markdown link destinations in message text', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'click [me](javascript:alert(1))' },
      { role: 'assistant', content: '[ok](https://example.com/a) [bad](data:text/html,evil) [off](vbscript:foo)' },
    ],
  }))
  assert.doesNotMatch(md, /\(javascript:/)
  assert.doesNotMatch(md, /\(data:/)
  assert.doesNotMatch(md, /\(vbscript:/)
  assert.match(md, /\[me\]/)
  assert.match(md, /\[ok\]\(https:\/\/example\.com\/a\)/)
  assert.match(md, /\[bad\] \[off\]/)
})
