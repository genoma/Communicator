import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExitPromptError } from '@inquirer/core'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

let searchImpl = async () => { throw new ExitPromptError() }
let checkboxImpl = null
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => searchImpl(opts),
    select: async () => { throw new ExitPromptError() },
    confirm: async () => true,
    checkbox: async (opts) => checkboxImpl(opts),
  },
})

const startChatCalls = []
mock.module(new URL('../src/chat.js', import.meta.url).href, {
  namedExports: {
    startChat: async (apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts) => {
      startChatCalls.push({ apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, opts })
      return {
        sessionId: opts.sessionId,
        createdAt: opts.createdAt,
        modelId: model,
        endpointProviderName,
        providerType: provider.meta.name,
        reasoningEffort,
        temperature,
        budget: opts.budget,
        webSearch: opts.webSearch,
        webResults: opts.webResults,
        pricing,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
        ],
      }
    },
  },
})

class ExitSignal {
  constructor(code) {
    this.code = code
  }
}

function sessionData(overrides = {}) {
  return {
    model: 'test/model',
    providerName: 'ProviderX',
    providerType: 'openrouter',
    reasoningEffort: 'low',
    temperature: 0.9,
    budget: 5,
    webSearch: 'off',
    webResults: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ],
    ...overrides,
  }
}

const BASE_OPTS = {
  model: undefined,
  provider: 'openrouter',
  listModels: undefined,
  listEndpoints: undefined,
  resume: undefined,
  export: undefined,
  outputDir: undefined,
  listSessions: undefined,
  config: undefined,
  systemPrompt: undefined,
  reasoningEffort: undefined,
  temperature: undefined,
  budget: undefined,
  webSearch: undefined,
  webResults: undefined,
  smoothStreaming: true,
  smoothSpeed: undefined,
  delete: undefined,
  deleteAllSessions: undefined,
  attach: [],
}

function opts(overrides = {}) {
  return { ...BASE_OPTS, ...overrides }
}

async function runAndExit(t, overrides, promptArg, expectedCode) {
  let exitCode = null
  const out = []
  const err = []
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', (msg) => out.push(String(msg)))
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  const { runCli } = await import('../src/cli-main.js')
  await assert.rejects(
    runCli(opts(overrides), promptArg),
    (e) => e instanceof ExitSignal && e.code === expectedCode
  )
  return { exitCode, out, err }
}

async function runCliNoExit(t, overrides, promptArg) {
  const out = []
  const err = []
  t.mock.method(process, 'exit', (code) => {
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', (msg) => out.push(String(msg)))
  t.mock.method(console, 'error', (msg) => err.push(String(msg)))
  const { runCli } = await import('../src/cli-main.js')
  await runCli(opts(overrides), promptArg)
  return { out, err }
}

function withTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original)
    else delete process.stdin.isTTY
  })
}

function withApiKey(t, value = 'test-key') {
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
  })
}

function withVeniceApiKey(t, value = 'venice-test-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

async function seedSession(id, data = {}) {
  const { ensureSessionsDir, saveSession } = await import('../src/sessions.js')
  const dir = await ensureSessionsDir()
  await saveSession(dir, id, sessionData(data))
  return dir
}

test('--list-sessions prints the seeded session and exits 0', async (t) => {
  await seedSession('2026-01-01T00-00-00', { title: 'My custom title' })
  const { out } = await runAndExit(t, { listSessions: true }, undefined, 0)
  assert.match(out.join('\n'), /2026-01-01 00:00:00/)
  assert.match(out.join('\n'), /"My custom title"/)
})

test('--export with a unique partial id writes the markdown file and exits 0', async (t) => {
  withTTY(t, true)
  await seedSession('2026-01-02T00-00-00')
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const { out } = await runAndExit(t, { export: '2026-01-02', outputDir: outDir }, undefined, 0)
  assert.match(out.join('\n'), /Exported to/)

  const md = await readFile(join(outDir, 'session-2026-01-02T00-00-00', 'session-2026-01-02T00-00-00.md'), 'utf-8')
  assert.match(md, /# Chat Session — 2026-01-01 00:00:00 UTC/)
  assert.match(md, /First question/)
})

test('--export with an unknown id fails gracefully', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { export: 'nope' }, undefined, 1)
  assert.match(err.join('\n'), /No session found matching "nope"/)
})

test('--delete with a unique partial id removes the session and exits 0', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-01-03T00-00-00')
  const { out } = await runAndExit(t, { delete: '2026-01-03' }, undefined, 0)
  assert.match(out.join('\n'), /Deleted session 2026-01-03T00-00-00/)

  const { listSessions } = await import('../src/sessions.js')
  const sessions = await listSessions(dir)
  assert.ok(!sessions.some((s) => s.id === '2026-01-03T00-00-00'))
})

test('--delete-all-sessions y removes every session and exits 0', async (t) => {
  const dir = await seedSession('2026-01-10T00-00-00')
  await seedSession('2026-01-11T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: 'y' }, undefined, 0)
  assert.match(out.join('\n'), /Deleted \d+ saved session\(s\)\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.deepEqual(await listSessions(dir), [])
})

test('--delete-all-sessions bare leaves sessions intact and exits 0', async (t) => {
  const dir = await seedSession('2026-01-12T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: true }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-01-12T00-00-00'))
})

test('--delete-all-sessions n leaves sessions intact and exits 0', async (t) => {
  const dir = await seedSession('2026-01-13T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: 'n' }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-01-13T00-00-00'))
})

test('--export bare with checkbox selection exports all chosen sessions and exits 0', async (t) => {
  withTTY(t, true)
  await seedSession('2026-02-01T00-00-00')
  await seedSession('2026-02-02T00-00-00')
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))
  checkboxImpl = async () => ['2026-02-01T00-00-00', '2026-02-02T00-00-00']

  const { out } = await runAndExit(t, { export: true, outputDir: outDir }, undefined, 0)
  const output = out.join('\n')
  assert.match(output, /Exported to .*session-2026-02-01T00-00-00/)
  assert.match(output, /Exported to .*session-2026-02-02T00-00-00/)

  const md1 = await readFile(join(outDir, 'session-2026-02-01T00-00-00', 'session-2026-02-01T00-00-00.md'), 'utf-8')
  assert.match(md1, /First question/)
  const md2 = await readFile(join(outDir, 'session-2026-02-02T00-00-00', 'session-2026-02-02T00-00-00.md'), 'utf-8')
  assert.match(md2, /First question/)
})

test('--export with an ambiguous prefix still uses the single-select search picker', async (t) => {
  withTTY(t, true)
  await seedSession('2026-03-01T00-00-00')
  await seedSession('2026-03-02T00-00-00')
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))
  searchImpl = async (opts) => {
    assert.equal(opts.message, 'Select a session to export')
    const all = await opts.source('')
    assert.equal(all.length, 2)
    return '2026-03-02T00-00-00'
  }
  t.after(() => {
    searchImpl = async () => { throw new ExitPromptError() }
  })

  const { out } = await runAndExit(t, { export: '2026-03', outputDir: outDir }, undefined, 0)
  assert.match(out.join('\n'), /Exported to .*session-2026-03-02T00-00-00/)
})

test('--export bare with an empty checkbox selection cancels and exits 0', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-02-05T00-00-00')
  checkboxImpl = async () => []

  const { out } = await runAndExit(t, { export: true }, undefined, 0)
  assert.match(out.join('\n'), /Export cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-02-05T00-00-00'))
})

test('--delete bare with checkbox selection deletes all chosen sessions and exits 0', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-02-03T00-00-00')
  await seedSession('2026-02-04T00-00-00')
  checkboxImpl = async () => ['2026-02-03T00-00-00', '2026-02-04T00-00-00']

  const { out } = await runAndExit(t, { delete: true }, undefined, 0)
  assert.match(out.join('\n'), /Deleted 2 sessions/)

  const { listSessions } = await import('../src/sessions.js')
  const remaining = await listSessions(dir)
  assert.ok(!remaining.some((s) => s.id === '2026-02-03T00-00-00'))
  assert.ok(!remaining.some((s) => s.id === '2026-02-04T00-00-00'))
})

test('--delete bare with an empty checkbox selection cancels and exits 0', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-02-06T00-00-00')
  checkboxImpl = async () => []

  const { out } = await runAndExit(t, { delete: true }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-02-06T00-00-00'))
})

test('--resume with a unique partial id rebuilds the context from the session', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-04T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-04' }, undefined)

  assert.equal(startChatCalls.length, 1)
  const call = startChatCalls[0]
  assert.equal(call.model, 'test/model')
  assert.equal(call.endpointProviderName, 'ProviderX')
  assert.equal(call.reasoningEffort, 'low')
  assert.equal(call.temperature, 0.9)
  assert.equal(call.opts.budget, 5)
  assert.equal(call.opts.webSearch, 'off')
  assert.equal(call.opts.webResults, null)
  assert.equal(call.opts.sessionId, '2026-01-04T00-00-00')
  assert.equal(call.opts.initialMessages.length, 3)
  assert.equal(call.opts.configPath, configFile)

  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.lastModel, 'test/model')
  assert.equal(saved.lastProvider, 'ProviderX')
  assert.equal(saved.temperature['test/model'], 0.9)
  assert.equal(saved.reasoningEffort['test/model'], 'low')
  assert.equal(saved.webSearch['test/model'], 'off')
})

test('--resume --reasoning-effort overrides the stored session effort', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-05T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-05', reasoningEffort: 'high' }, undefined, 0)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.reasoningEffort, 'high')
})

test('--resume --reasoning-effort none disables reasoning on resume', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-06T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-06', reasoningEffort: 'none' }, undefined, 0)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.reasoningEffort, null)
})

test('--resume --temperature and --budget override the stored session values', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-07T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, {
    config: configFile,
    resume: '2026-01-07',
    temperature: '0.5',
    budget: '2',
  }, undefined)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.temperature, 0.5)
  assert.equal(call.opts.budget, 2)
})

test('--resume --web-search always overrides the stored mode', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-08T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-08', webSearch: 'always' }, undefined, 0)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.opts.webSearch, 'always')
})

test('--resume with no matching sessions exits 1 with a friendly error', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const { err } = await runAndExit(t, { resume: 'zzz' }, undefined, 1)
  assert.match(err.join('\n'), /No session found matching "zzz"/)
})

function mockVeniceScrapeFetch(t) {
  const models = [{ id: 'venice-model', model_spec: { name: 'V', capabilities: {}, constraints: {} } }]
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/augment/scrape')) {
      return new Response(JSON.stringify({ url: 'https://example.com/article', content: '# Article body', format: 'markdown' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/chat/completions')) {
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of [
            'data: {"choices":[{"delta":{"content":"Summary"}}]}\n\n',
            'data: {"choices":[{"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}]}\n\n',
            'data: [DONE]\n\n',
          ]) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (u.includes('/models?type=text')) {
      return new Response(JSON.stringify({ data: models }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  return calls
}

test('--scrape with an invalid URL exits 1 before any API call', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const calls = mockVeniceScrapeFetch(t)
  const { err } = await runAndExit(t, { provider: 'venice', scrape: 'not-a-url' }, 'Summarize', 1)
  assert.match(err.join('\n'), /--scrape expects a valid http\(s\) URL/)
  assert.equal(calls.length, 0)
})

test('--scrape with a prompt scrapes the page, injects it, and answers', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  const { out } = await runAndExit(t, {
    provider: 'venice',
    model: 'venice-model',
    config: configFile,
    scrape: 'https://example.com/article',
  }, 'Summarize', 0)

  assert.ok(calls.some((u) => u.includes('/augment/scrape')))
  assert.match(out.join('\n'), /Scraped https:\/\/example\.com\/article \(\d+ chars\) into context\./)

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const saved = JSON.parse(await readFile(join(sessionsDir, files[files.length - 1]), 'utf-8'))
  assert.equal(saved.scrapes, 1)
  assert.equal(saved.messages[1].content, 'Scraped from https://example.com/article:\n\n# Article body')
  assert.equal(saved.messages[2].content, 'Summarize')
})

test('bare --scrape opens a chat with the page already in context', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  const previousSearch = searchImpl
  searchImpl = async () => ({ id: 'venice-model', name: 'V' })
  t.after(() => { searchImpl = previousSearch })

  const { out } = await runCliNoExit(t, {
    provider: 'venice',
    config: configFile,
    scrape: 'https://example.com/article',
  }, undefined)

  assert.ok(calls.some((u) => u.includes('/augment/scrape')))
  assert.match(out.join('\n'), /Scraped https:\/\/example\.com\/article \(\d+ chars\) into context\./)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.opts.scrapes, 1)
  assert.equal(call.opts.initialMessages[1].role, 'user')
  assert.equal(call.opts.initialMessages[1].content, 'Scraped from https://example.com/article:\n\n# Article body')
})

test('--no-safe-mode alone opens the chat and persists the pref', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out } = await runAndExit(t, { provider: 'venice', config: configFile, safeMode: false }, undefined, 0)

  assert.ok(out.join('\n').includes('Venice safe mode disabled'))
  assert.ok(out.join('\n').includes('Aborted.'))
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.safeMode, false)
})

test('--no-safe-mode with --resume persists the pref before the chat resumes', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-09T00-00-00')
  const configFile = await tempConfig(t)
  const callsBefore = startChatCalls.length
  await runCliNoExit(t, { config: configFile, resume: '2026-01-09', safeMode: false }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.safeMode, false)
})
