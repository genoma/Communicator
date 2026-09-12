import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ExitPromptError } from '@inquirer/core'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

let searchImpl = async () => { throw new ExitPromptError() }
let checkboxImpl = null
let confirmImpl = async () => true
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => searchImpl(opts),
    select: async () => { throw new ExitPromptError() },
    confirm: async (opts) => confirmImpl(opts),
    checkbox: async (opts) => checkboxImpl(opts),
  },
})

const startChatCalls = []
mock.module(new URL('../src/chat.js', import.meta.url).href, {
  namedExports: {
    startChat: async (apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts) => {
      startChatCalls.push({ apiKey, model, endpointProviderName, reasoningEffort, temperature, pricing, provider, opts })
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
        webSearchExplicit: opts.webSearchExplicit,
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

// Notices route to stdout on a terminal and to stderr when stdout is piped
// (the piped one-shot emits only answer text there); every notice assertion
// pins the stream it expects instead of inheriting the runner's own TTY state.
function withStdoutTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
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

// A headless run reads its prompt from the pipe: a Readable stands in for the
// shell's stdin (and reports no TTY, so the headless gates apply).
function withPipedStdin(t, text = 'Explain this') {
  const stdin = Readable.from([Buffer.from(text)])
  stdin.isTTY = false
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process, 'stdin', original)
    else delete process.stdin
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

function withoutVeniceApiKey(t) {
  const previous = process.env.VENICE_API_KEY
  delete process.env.VENICE_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.VENICE_API_KEY = previous
  })
}

function withoutApiKey(t) {
  const previous = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous
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

// A resumed one-shot resolves its model from the session file, so the only
// request it makes is the completion itself.
function mockOpenRouterCompletion(t, bodies = []) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url)
    if (!u.includes('/chat/completions')) throw new Error(`unexpected fetch: ${u}`)
    if (opts?.body) bodies.push(JSON.parse(opts.body))
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          'data: [DONE]\n\n',
        ]) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
}

// The mocked chat path persists its session in the shared temp home; a test
// that opens a chat but wants no artifact must remove what it wrote, because
// later scrape tests read the newest session file in that shared dir.
async function trackNewSessions(t) {
  const dir = join(tempHome, '.communicator', 'sessions')
  const before = new Set(await readdir(dir).catch(() => []))
  t.after(async () => {
    const after = await readdir(dir).catch(() => [])
    for (const entry of after) {
      if (!before.has(entry)) await rm(join(dir, entry), { recursive: true, force: true })
    }
  })
}

test('--list-sessions prints the seeded session and exits 0', async (t) => {
  await seedSession('2026-01-01T00-00-00', { title: 'My custom title' })
  const { out } = await runAndExit(t, { listSessions: true }, undefined, 0)
  assert.match(out.join('\n'), /2026-01-01 00:00:01/)
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

test('--export with a unique partial id works with piped stdin (no picker involved)', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  await seedSession('2026-01-02T00-00-00')
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const { out } = await runAndExit(t, { export: '2026-01-02', outputDir: outDir }, undefined, 0)
  assert.match(out.join('\n'), /Exported to/)

  const md = await readFile(join(outDir, 'session-2026-01-02T00-00-00', 'session-2026-01-02T00-00-00.md'), 'utf-8')
  assert.match(md, /First question/)
})

test('--export with an unknown id fails gracefully', async (t) => {
  withTTY(t, true)
  const { err } = await runAndExit(t, { export: 'nope' }, undefined, 1)
  assert.match(err.join('\n'), /No session found matching "nope"/)
})

test('--export --export-format jsonl persists the format and a later export reuses it', async (t) => {
  withTTY(t, true)
  await seedSession('2026-04-01T00-00-00')
  await seedSession('2026-04-02T00-00-00')
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))
  const configFile = await tempConfig(t)

  await runAndExit(t, { config: configFile, export: '2026-04-01', outputDir: outDir, exportFormat: 'jsonl' }, undefined, 0)

  const prefs = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(prefs.exportFormat, 'jsonl')
  const first = await readFile(join(outDir, 'session-2026-04-01T00-00-00', 'session-2026-04-01T00-00-00.jsonl'), 'utf-8')
  assert.ok(first.trim().length > 0)

  // The saved default applies to a later export that does not pass the flag.
  await runAndExit(t, { config: configFile, export: '2026-04-02', outputDir: outDir }, undefined, 0)
  const second = await readFile(join(outDir, 'session-2026-04-02T00-00-00', 'session-2026-04-02T00-00-00.jsonl'), 'utf-8')
  assert.ok(second.trim().length > 0)
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

test('--delete with a unique partial id deletes without a prompt when stdin is piped', async (t) => {
  withTTY(t, false)
  const dir = await seedSession('2026-01-03T00-00-00')
  // The confirm prompt cannot render without a TTY; the resolved id is the
  // whole confirmation, so reaching it is the failure this test guards.
  confirmImpl = async () => { throw new Error('unexpected confirm prompt') }
  t.after(() => { confirmImpl = async () => true })

  const { out } = await runAndExit(t, { delete: '2026-01-03' }, undefined, 0)
  assert.match(out.join('\n'), /2026-01-01 00:00:01 {2}test\/model/)
  assert.match(out.join('\n'), /Deleted session 2026-01-03T00-00-00/)

  const { listSessions } = await import('../src/sessions.js')
  const sessions = await listSessions(dir)
  assert.ok(!sessions.some((s) => s.id === '2026-01-03T00-00-00'))
})

test('--delete with an ambiguous prefix and piped stdin fails fast and removes nothing', async (t) => {
  withTTY(t, false)
  // A prefix shared by nothing else seeded in the shared temp home, so the
  // ambiguity count is exact.
  const dir = await seedSession('2026-09-01T00-00-00')
  await seedSession('2026-09-02T00-00-00')

  const { err } = await runAndExit(t, { delete: '2026-09-0' }, undefined, 1)
  assert.ok(err.join('\n').includes('Error: "2026-09-0" matches 2 sessions: 2026-09-02T00-00-00, 2026-09-01T00-00-00. Use a longer id to select one.'))

  const { listSessions } = await import('../src/sessions.js')
  const ids = (await listSessions(dir)).map((s) => s.id)
  assert.ok(ids.includes('2026-09-01T00-00-00'))
  assert.ok(ids.includes('2026-09-02T00-00-00'))
})

test('deleteCmd forwards its interactive override to the resolver', async (t) => {
  // A caller that passes { interactive: false } while stdin is a TTY must get
  // the fail-fast ambiguity error, not a picker: the override is forwarded, so
  // the resolver never falls back to process.stdin.isTTY on its own.
  withTTY(t, true)
  const dir = await seedSession('2026-10-01T00-00-00')
  await seedSession('2026-10-02T00-00-00')
  checkboxImpl = async () => { throw new Error('unexpected picker') }

  const { deleteCmd } = await import('../src/commands/delete-cmd.js')
  await assert.rejects(deleteCmd('2026-10-0', { interactive: false }), /Error: "2026-10-0" matches 2 sessions: .*Use a longer id to select one\./)

  const { listSessions } = await import('../src/sessions.js')
  const ids = (await listSessions(dir)).map((s) => s.id)
  assert.ok(ids.includes('2026-10-01T00-00-00'))
  assert.ok(ids.includes('2026-10-02T00-00-00'))
})

test('--delete bare lists exactly the chosen sessions and deletes only those', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-01-04T00-00-00', { model: 'test/model-chosen' })
  await seedSession('2026-01-05T00-00-00', { model: 'test/model-also-chosen' })
  await seedSession('2026-01-06T00-00-00', { model: 'test/model-kept' })
  checkboxImpl = async () => ['2026-01-04T00-00-00', '2026-01-05T00-00-00']

  const { out } = await runAndExit(t, { delete: true }, undefined, 0)
  const printed = out.join('\n')
  assert.match(printed, /test\/model-chosen/)
  assert.match(printed, /test\/model-also-chosen/)
  assert.ok(!printed.includes('test/model-kept'), 'an unselected session must not be listed')

  const { listSessions } = await import('../src/sessions.js')
  const remaining = await listSessions(dir)
  assert.ok(!remaining.some((s) => s.id === '2026-01-04T00-00-00'))
  assert.ok(!remaining.some((s) => s.id === '2026-01-05T00-00-00'))
  assert.ok(remaining.some((s) => s.id === '2026-01-06T00-00-00'))
})

test('--delete-all-sessions y removes every session and exits 0', async (t) => {
  const dir = await seedSession('2026-01-10T00-00-00')
  await seedSession('2026-01-11T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: 'y' }, undefined, 0)
  assert.match(out.join('\n'), /Deleted \d+ saved session\(s\)\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.deepEqual(await listSessions(dir), [])
})

test('--delete-all-sessions bare on a TTY asks and deletes after confirm', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-01-12T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: true }, undefined, 0)
  assert.match(out.join('\n'), /Deleted 1 saved session\(s\)\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.deepEqual(await listSessions(dir), [])
})

test('--delete-all-sessions bare with piped stdin exits 1 and deletes nothing', async (t) => {
  const dir = await seedSession('2026-01-13T00-00-00')
  const { err } = await runAndExit(t, { deleteAllSessions: true }, undefined, 1)
  assert.match(err.join('\n'), /bare --delete-all-sessions needs a TTY/)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-01-13T00-00-00'))
})

test('--delete-all-sessions y with an unremovable entry reports it and exits 1', async (t) => {
  const dir = await seedSession('2026-01-14T00-00-00')
  await mkdir(join(dir, 'stuck.json'))
  t.after(() => rm(join(dir, 'stuck.json'), { recursive: true, force: true }))
  const { out, err } = await runAndExit(t, { deleteAllSessions: 'y' }, undefined, 1)
  assert.match(out.join('\n'), /Deleted \d+ saved session\(s\)\./)
  assert.match(err.join('\n'), /Error: could not remove 1 item\(s\): stuck\.json/)

  const { listSessions } = await import('../src/sessions.js')
  assert.deepEqual(await listSessions(dir), [])
})

test('--delete-all-sessions n leaves sessions intact and exits 0', async (t) => {
  const dir = await seedSession('2026-01-15T00-00-00')
  const { out } = await runAndExit(t, { deleteAllSessions: 'n' }, undefined, 0)
  assert.match(out.join('\n'), /Deletion cancelled\./)

  const { listSessions } = await import('../src/sessions.js')
  assert.ok((await listSessions(dir)).some((s) => s.id === '2026-01-15T00-00-00'))
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

test('--delete with an unremovable entry deletes the rest and exits 1', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-02-07T00-00-00')
  await mkdir(join(dir, 'stuck.json'))
  t.after(() => rm(join(dir, 'stuck.json'), { recursive: true, force: true }))
  checkboxImpl = async () => ['2026-02-07T00-00-00', 'stuck']

  const { out, err } = await runAndExit(t, { delete: true }, undefined, 1)
  assert.match(out.join('\n'), /Deleted 1 of 2 sessions/)
  assert.match(err.join('\n'), /Error: could not remove 1 session\(s\): stuck/)

  const { listSessions } = await import('../src/sessions.js')
  const remaining = await listSessions(dir)
  assert.ok(!remaining.some((s) => s.id === '2026-02-07T00-00-00'))
  assert.ok((await readdir(dir)).includes('stuck.json'))
})

test('--export with a corrupt selected session exports the rest and exits 1', async (t) => {
  withTTY(t, true)
  const dir = await seedSession('2026-03-02T00-00-00')
  await writeFile(join(dir, '2026-03-01T00-00-00.json'), '{ not json')
  t.after(() => rm(join(dir, '2026-03-01T00-00-00.json'), { force: true }))
  checkboxImpl = async () => ['2026-03-01T00-00-00', '2026-03-02T00-00-00']
  const outDir = await mkdtemp(join(tmpdir(), 'communicator-export-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const { out, err } = await runAndExit(t, { export: true, outputDir: outDir }, undefined, 1)
  assert.match(out.join('\n'), /Exported to .*session-2026-03-02T00-00-00/)
  assert.match(err.join('\n'), /Error: could not export 1 session\(s\): 2026-03-01T00-00-00/)

  assert.ok((await readdir(outDir)).some((name) => name.includes('session-2026-03-02T00-00-00')))
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
  // The resumed session never explicitly set web search, so its default/restored
  // 'off' must not pollute the per-model pref.
  assert.equal(saved.webSearch, undefined)
})

test('--resume with a unique partial id runs headless and extends the same session file', async (t) => {
  withPipedStdin(t, 'Explain this')
  withStdoutTTY(t, false)
  withApiKey(t)
  const configFile = await tempConfig(t)
  const pricing = { prompt: 1e-6, completion: 2e-6 }
  const sessionsDir = await seedSession('2026-01-20T00-00-00', {
    isImageModel: false,
    pricing,
    scrapes: 2,
    messages: [
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
    ],
  })
  const bodies = []
  mockOpenRouterCompletion(t, bodies)
  const writes = []
  t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true })
  const before = (await readdir(sessionsDir)).sort()

  // No -m: the session carries its own model, so a headless resume must not
  // demand one.
  await runAndExit(t, { config: configFile, resume: '2026-01-20' }, undefined, 0)

  assert.ok(writes.join('').includes('Hello world'), 'the piped answer still streams to stdout')
  assert.equal(bodies[0].model, 'test/model')
  // The stored system message is what gets sent, never a fresh prompt.
  assert.deepEqual(bodies[0].messages[0], { role: 'system', content: 'You are a terse assistant.' })
  assert.equal(bodies[0].messages[1].content, 'First question')
  assert.equal(bodies[0].messages[3].content, 'Explain this')

  // The run rewrites its own file in place: no new session file, no 0-byte claim.
  assert.deepEqual((await readdir(sessionsDir)).sort(), before)
  const saved = JSON.parse(await readFile(join(sessionsDir, '2026-01-20T00-00-00.json'), 'utf-8'))
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(saved.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant'])
  assert.equal(saved.messages[4].content, 'Hello world')
  assert.equal(saved.scrapes, 2)
  // Cumulative like the interactive resume: the stored turn's usage stays in
  // the totals and this run is added on top.
  assert.equal(saved.costSummary.requests, 2)
  assert.equal(saved.costSummary.promptTokens, 1010)
  assert.equal(saved.costSummary.completionTokens, 505)
  assert.equal(saved.costSummary.totalTokens, 1515)
  assert.equal(saved.costSummary.promptTokens, 1010)
  assert.equal(saved.costSummary.completionTokens, 505)
  assert.equal(saved.costSummary.totalTokens, 1515)
})

test('--resume of an image session fails loudly when stdin is piped', async (t) => {
  withPipedStdin(t, 'Make it blue')
  withApiKey(t)
  await seedSession('2026-01-21T00-00-00', { model: 'openai/gpt-image-2', isImageModel: true })
  t.mock.method(globalThis, 'fetch', async (url) => { throw new Error(`unexpected fetch: ${url}`) })

  const { err } = await runAndExit(t, { resume: '2026-01-21' }, undefined, 1)
  // An image session is a REPL of its own: it must never degrade into a text chat.
  assert.ok(err.join('\n').includes('Error: resuming an image session needs a TTY (image sessions are interactive).'))
})

test('--resume runs on the session provider, not the flag provider', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  withoutVeniceApiKey(t)
  await seedSession('2026-01-07T00-00-00', { isImageModel: false })
  const configFile = await tempConfig(t)

  await runCliNoExit(t, { config: configFile, resume: '2026-01-07', provider: 'venice' }, undefined)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.model, 'test/model')
  // The session's own provider and key win over -p venice, so no Venice key is
  // demanded for a run that never sends one to Venice.
  assert.equal(call.provider.meta.name, 'openrouter')
  assert.equal(call.apiKey, 'test-key')
})

test('--resume still demands the key of the provider the session actually uses', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  withoutVeniceApiKey(t)
  await seedSession('2026-01-08T00-00-00', {
    providerType: 'venice',
    providerName: 'Venice',
    model: 'venice/model',
    isImageModel: false,
  })
  const configFile = await tempConfig(t)

  const { err } = await runAndExit(t, { config: configFile, resume: '2026-01-08' }, undefined, 1)
  assert.match(err.join('\n'), /VENICE_API_KEY environment variable is not set/)

  withVeniceApiKey(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-08' }, undefined)
  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.provider.meta.name, 'venice')
  assert.equal(call.apiKey, 'venice-test-key')
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

test('--resume --temperature overrides the stored session value', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-07T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, {
    config: configFile,
    resume: '2026-01-07',
    temperature: '0.5',
  }, undefined)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.temperature, 0.5)
  // budget has no flag any more (4.0.0): the stored session cap comes back.
  assert.equal(call.opts.budget, 5)
})

test('--resume --web-search always overrides the stored mode', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-01-08T00-00-00')
  const configFile = await tempConfig(t)
  await runCliNoExit(t, { config: configFile, resume: '2026-01-08', webSearch: 'always' }, undefined, 0)

  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.opts.webSearch, 'always')

  // The explicit --web-search flag marks the choice as deliberate, so the
  // exit snapshot must persist it to the per-model pref.
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.webSearch['test/model'], 'always')
})

test('--resume with no matching sessions exits 1 with a friendly error', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const { err } = await runAndExit(t, { resume: 'zzz' }, undefined, 1)
  assert.match(err.join('\n'), /No session found matching "zzz"/)
})

test('--system-prompt with a missing file exits 1 with a clear error', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-system-prompt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const missing = join(dir, 'prompt.md')
  const { err } = await runAndExit(t, { systemPrompt: missing }, undefined, 1)
  assert.ok(err.join('\n').includes(`system prompt file not found: ${missing}`))
})

test('--system-prompt with a missing file next to -m exits 1 instead of config-setting', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const configFile = await tempConfig(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-system-prompt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const missing = join(dir, 'prompt.md')
  // The set-and-exit dispatch would fetch the catalog and exit 0 without ever
  // reading the path; a fetch here is the regression this test guards.
  t.mock.method(globalThis, 'fetch', async (url) => { throw new Error(`unexpected fetch: ${url}`) })

  const { err } = await runAndExit(t, { model: 'test/model-a', systemPrompt: missing, config: configFile }, undefined, 1)

  assert.ok(err.join('\n').includes(`system prompt file not found: ${missing}`))
  assert.ok(!err.join('\n').includes('Saved to'))
})

test('--system-prompt with a valid file next to -m opens the chat with that prompt', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-system-prompt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const promptFile = join(dir, 'prompt.md')
  await writeFile(promptFile, 'Speak like a pirate.\n')
  mockVeniceScrapeFetch(t)
  await trackNewSessions(t)
  const callsBefore = startChatCalls.length

  await runCliNoExit(t, { provider: 'venice', model: 'venice-model', config: configFile, systemPrompt: promptFile }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1, 'the flag-bearing run must reach the chat')
  assert.equal(startChatCalls[startChatCalls.length - 1].opts.systemPrompt, 'Speak like a pirate.')
})

test('-m <id> alone opens the chat with that model instead of validating and exiting', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  mockVeniceScrapeFetch(t)
  await trackNewSessions(t)
  const callsBefore = startChatCalls.length

  const { out } = await runCliNoExit(t, { provider: 'venice', model: 'venice-model', config: configFile }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1, 'a bare -m must open the chat, not validate and exit')
  assert.equal(startChatCalls[startChatCalls.length - 1].model, 'venice-model')
  assert.ok(!out.join('\n').includes('Saved to'), 'no set-and-exit confirmation may be printed')
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
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
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
    if (u.includes('/models?type=image')) {
      // The image picker is not stubbed here; an empty listing keeps the flow
      // on the text-model path (a non-empty one would open the image picker).
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
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
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  const { out, err } = await runAndExit(t, {
    provider: 'venice',
    model: 'venice-model',
    config: configFile,
    scrape: 'https://example.com/article',
  }, 'Summarize', 0)

  assert.ok(calls.some((u) => u.includes('/augment/scrape')))
  assert.ok(!out.join('\n').includes('Scraped '), 'the scrape notice must stay off piped stdout')
  assert.match(err.join('\n'), /Scraped https:\/\/example\.com\/article \(\d+ chars\) into context\./)

  const sessionsDir = join(tempHome, '.communicator', 'sessions')
  const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const saved = JSON.parse(await readFile(join(sessionsDir, files[files.length - 1]), 'utf-8'))
  assert.equal(saved.scrapes, 1)
  assert.equal(saved.messages[1].content, 'Scraped from https://example.com/article:\n\n# Article body')
  assert.equal(saved.messages[2].content, 'Summarize')
})

test('bare --scrape opens a chat with the page already in context', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
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

test('--scrape next to -m opens the chat with the page in context instead of config-setting', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)
  await trackNewSessions(t)
  const callsBefore = startChatCalls.length

  const { out } = await runCliNoExit(t, {
    provider: 'venice',
    model: 'venice-model',
    config: configFile,
    scrape: 'https://example.com/article',
  }, undefined)

  assert.ok(calls.some((u) => u.includes('/augment/scrape')))
  assert.match(out.join('\n'), /Scraped https:\/\/example\.com\/article \(\d+ chars\) into context\./)
  assert.equal(startChatCalls.length, callsBefore + 1, 'the flag-bearing run must reach the chat')
  assert.equal(startChatCalls[startChatCalls.length - 1].opts.scrapes, 1)
  assert.ok(!out.join('\n').includes('Saved to'))
})

test('--no-safe-mode alone opens the chat and persists the pref', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  const modelCalls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.includes('/models')) modelCalls.push(u)
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const { out } = await runAndExit(t, { provider: 'venice', config: configFile, safeMode: false }, undefined, 0)

  assert.ok(out.join('\n').includes('Venice safe mode disabled'))
  assert.ok(out.join('\n').includes('Aborted.'))
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.safeMode, false)
  // Cold caches: the launch seeds the text listing and the selection path adds
  // the image catalog, so each catalog is fetched exactly once. The caches are
  // reset here instead of relying on tests that ran before this one.
  const textCalls = modelCalls.filter((u) => u.includes('type=text'))
  const imageCalls = modelCalls.filter((u) => u.includes('type=image'))
  assert.equal(textCalls.length, 1, `expected one text listing request, saw ${textCalls.length}`)
  assert.equal(imageCalls.length, 1, `expected one image listing request, saw ${imageCalls.length}`)
})

test('--no-save --no-safe-mode prints the notice without persisting the pref', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  // An empty listing fails the run right after the notice, so the assertions
  // cover the notice routing and the write that must NOT happen.
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, safeMode: false, save: false }, 'Hi', 1)

  assert.match(err.join('\n'), /^Venice safe mode disabled$/m)
  assert.ok(!out.join('\n').includes('Venice safe mode disabled'), 'the notice must stay off piped stdout')
  await assert.rejects(readFile(configFile, 'utf-8'), /ENOENT/)
})

test('--no-safe-mode notice goes to stderr when stdout is piped', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  // The Venice text catalog is process-cached: an empty listing would leak
  // into the later scrape test's model lookup.
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  // An empty listing fails the run right after the notice, so the assertion
  // covers the notice routing alone and leaves no session artifact behind.
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, safeMode: false }, 'Hi', 1)

  assert.ok(!out.join('\n').includes('Venice safe mode disabled'), 'the safe mode notice must stay off piped stdout')
  assert.match(err.join('\n'), /^Venice safe mode disabled$/m)
})

test('--image --no-safe-mode notice goes to stderr when stdout is piped', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', config: configFile, image: true, imageModel: 'flux-1-1', safeMode: false }, 'a red cat', 1)

  assert.ok(!out.join('\n').includes('Venice safe mode disabled'), 'the image path safe mode notice must stay off piped stdout')
  assert.match(err.join('\n'), /^Venice safe mode disabled$/m)
  // The image branch exits before the shared notice site: the model lookup
  // failing is what proves the notice came from the --image path.
  assert.match(err.join('\n'), /image model flux-1-1 not found/)
})

test('--image --no-watermark prints the notice and persists the pref before the run', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', config: configFile, image: true, imageModel: 'flux-1-1', watermark: false }, 'a red cat', 1)

  assert.ok(!out.join('\n').includes('Venice watermark disabled'), 'the image path watermark notice must stay off piped stdout')
  assert.match(err.join('\n'), /^Venice watermark disabled$/m)
  assert.match(err.join('\n'), /image model flux-1-1 not found/)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.hideWatermark, true)
})

test('--image --no-watermark prints the notice on stdout when stdout is a terminal', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', config: configFile, image: true, imageModel: 'flux-1-1', watermark: false }, 'a red cat', 1)

  assert.match(out.join('\n'), /^Venice watermark disabled$/m)
  assert.ok(!err.join('\n').includes('Venice watermark disabled'))
})

test('--no-watermark with a prompt persists the pref and prints the notice on stdout', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  // The Venice text catalog is process-cached: an empty listing would leak
  // into the later scrape test's model lookup.
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  // An empty listing fails the run right after the notice, so the assertion
  // covers the notice itself and the pref write that precedes it.
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, watermark: false }, 'Hi', 1)

  assert.match(out.join('\n'), /Venice watermark disabled/)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.hideWatermark, true)
})

test('--no-watermark notice goes to stderr when stdout is piped', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, watermark: false }, 'Hi', 1)

  assert.ok(!out.join('\n').includes('Venice watermark disabled'), 'the watermark notice must stay off piped stdout')
  assert.match(err.join('\n'), /^Venice watermark disabled$/m)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.hideWatermark, true)
})

test('--aspect-ratio on a chat run persists the per-provider default instead of dropping it', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  // An empty listing fails the run right after the persist block, so the
  // assertions cover the notices and the write that precedes them.
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, aspectRatio: '16:9', imageFormat: 'png' }, 'Hi', 1)

  assert.ok(!out.join('\n').includes('Aspect ratio set to'), 'the image-defaults notices must stay off piped stdout')
  assert.match(err.join('\n'), /^Aspect ratio set to 16:9 \(venice image defaults\)$/m)
  assert.match(err.join('\n'), /^Image format set to png \(venice image defaults\)$/m)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.imageDefaults.venice.aspectRatio, '16:9')
  assert.equal(saved.imageDefaults.venice.format, 'png')
})

test('--aspect-ratio notices print on stdout on a terminal', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, aspectRatio: '16:9' }, 'Hi', 1)

  assert.match(out.join('\n'), /^Aspect ratio set to 16:9 \(venice image defaults\)$/m)
  assert.ok(!err.join('\n').includes('Aspect ratio set to'))
})

test('--image --aspect-ratio persists the default and prints the notice', async (t) => {
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', config: configFile, image: true, imageModel: 'flux-1-1', aspectRatio: '16:9', imageFormat: 'png' }, 'a red cat', 1)

  assert.ok(!out.join('\n').includes('Aspect ratio set to'), 'the image-path notices must stay off piped stdout')
  assert.match(err.join('\n'), /^Aspect ratio set to 16:9 \(venice image defaults\)$/m)
  assert.match(err.join('\n'), /^Image format set to png \(venice image defaults\)$/m)
  const saved = JSON.parse(await readFile(configFile, 'utf-8'))
  assert.equal(saved.imageDefaults.venice.aspectRatio, '16:9')
  assert.equal(saved.imageDefaults.venice.format, 'png')
})

test('--aspect-ratio with a bad value fails loudly instead of being persisted', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  t.mock.method(globalThis, 'fetch', async (url) => { throw new Error(`unexpected fetch: ${url}`) })

  const { err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, aspectRatio: 'bogus' }, 'Hi', 1)

  assert.match(err.join('\n'), /--aspect-ratio must be in the form W:H/)
  await assert.rejects(readFile(configFile, 'utf-8'), /ENOENT/)
})

test('an empty --aspect-ratio/--image-format value is ignored instead of crashing', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  // The Venice text catalog is process-cached: an empty listing would leak
  // into a later test's model lookup.
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out, err } = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, aspectRatio: '', imageFormat: '' }, 'Hi', 1)

  assert.ok(!`${out.join('\n')}\n${err.join('\n')}`.includes('image defaults'), 'an empty value gets no notice')
  assert.ok(!err.join('\n').includes('TypeError'), 'an empty value must not crash')
  await assert.rejects(readFile(configFile, 'utf-8'), /ENOENT/)
})

test('an empty Venice catalog stub cannot leak into a later model lookup', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  // Same cold start as the empty-listing tests: in file order this test may
  // follow one that cached a good listing.
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  let listing = { data: [] }
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.includes('/models?type=text')) {
      return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/models?type=image')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${u}`)
  })

  const empty = await runAndExit(t, { provider: 'venice', model: 'venice-model', config: configFile, aspectRatio: '', imageFormat: '' }, 'Hi', 1)
  assert.match(empty.err.join('\n'), /model venice-model not found/)

  // The empty-catalog tests hand a cold cache to whatever runs next through
  // t.after(resetModelCaches); this call stands in for that hand-off, so the
  // hazard is pinned here instead of by whichever test happens to follow.
  resetModelCaches()
  listing = { data: [{ id: 'venice-model', model_spec: { name: 'V', capabilities: {}, constraints: {} } }] }
  await trackNewSessions(t)
  const callsBefore = startChatCalls.length

  await runCliNoExit(t, { provider: 'venice', model: 'venice-model', config: configFile }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1, 'the good catalog must resolve after the empty-listing run')
})

test('--scrape with a bad --aspect-ratio fails before the page is billed', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  const { err } = await runAndExit(t, { config: configFile, provider: 'venice', model: 'venice-model', scrape: 'https://example.com/article', aspectRatio: 'bogus' }, 'Hi', 1)

  assert.match(err.join('\n'), /--aspect-ratio must be in the form W:H/)
  assert.ok(!calls.some((u) => u.includes('/augment/scrape')), 'a bad flag must not bill a scrape')
})

test('Ctrl+C at the picker in one-shot (prompt arg) aborts cleanly with Aborted.', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  // The aborted picker has already fetched both OpenRouter listings: an empty
  // one stays cached and would answer every later model lookup.
  const { resetModelCaches, resetImageModelCaches } = await import('../src/providers/openrouter.js')
  resetModelCaches()
  resetImageModelCaches()
  t.after(() => {
    resetModelCaches()
    resetImageModelCaches()
  })
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const { out } = await runAndExit(t, { provider: 'openrouter' }, '.', 0)

  assert.ok(out.join('\n').includes('Aborted.'))
})

test('Ctrl+C at the picker with a foreign ExitPromptError-named error still aborts (cross-instance guard)', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  // Same as the picker test above: the aborted picker leaves both OpenRouter
  // listings cached empty unless they are reset.
  const { resetModelCaches, resetImageModelCaches } = await import('../src/providers/openrouter.js')
  resetModelCaches()
  resetImageModelCaches()
  t.after(() => {
    resetModelCaches()
    resetImageModelCaches()
  })
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  )
  // A generic Error that is NOT an instanceof the imported ExitPromptError class,
  // simulating a duplicate @inquirer/core module instance where instanceof fails;
  // only the name identifies it as a prompt abort. The guard must still catch it.
  const foreign = Object.assign(new Error('aborted'), { name: 'ExitPromptError' })
  assert.equal(foreign instanceof ExitPromptError, false, 'fixture must not be an instanceof ExitPromptError')
  searchImpl = async () => { throw foreign }
  t.after(() => { searchImpl = async () => { throw new ExitPromptError() } })

  const { out } = await runAndExit(t, { provider: 'openrouter' }, '.', 0)

  assert.ok(out.join('\n').includes('Aborted.'))
})

test('an empty OpenRouter catalog stub cannot leak into a later model lookup', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const configFile = await tempConfig(t)
  // Same cold start as the picker tests above: in file order this test may
  // follow one that cached a good listing.
  const { resetModelCaches, resetImageModelCaches } = await import('../src/providers/openrouter.js')
  resetModelCaches()
  resetImageModelCaches()
  t.after(() => {
    resetModelCaches()
    resetImageModelCaches()
  })
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  let textListing = { data: [] }
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    if (u.endsWith('/images/models')) return reply({ data: [] })
    if (u.endsWith('/models')) return reply(textListing)
    if (u.endsWith('/endpoints')) return reply({ data: { endpoints: [] } })
    throw new Error(`unexpected fetch: ${u}`)
  })

  const empty = await runAndExit(t, { provider: 'openrouter', model: 'openrouter-model', config: configFile }, 'Hi', 1)
  assert.match(empty.err.join('\n'), /model openrouter-model not found/)

  // The picker tests above dirty both caches the same way and hand the next
  // test a cold one through their t.after(reset*ModelCaches); this call stands
  // in for that hand-off, so the hazard is pinned here instead of by whichever
  // test happens to follow.
  resetModelCaches()
  resetImageModelCaches()
  textListing = { data: [{ id: 'openrouter-model', name: 'M', context_length: 1000, architecture: {} }] }
  await trackNewSessions(t)
  const callsBefore = startChatCalls.length

  await runCliNoExit(t, { provider: 'openrouter', model: 'openrouter-model', config: configFile }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1, 'the good catalog must resolve after the empty-listing run')
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

// Item 32: a --resume run executes on the provider saved in the session, so
// the --e2ee provider gate must follow the resolved provider, not -p. Pre-fix
// the gate read opts.provider, falsely refusing a Venice session resumed with
// -p openrouter and silently accepting an OpenRouter session under -p venice.
test('--resume -p openrouter of a Venice --e2ee session runs on the Venice provider', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  // The stored e2ee marker is what assertResumeE2eeMatch checks on resume; the
  // gate under test is the provider check that runs after it.
  await seedSession('2026-04-01T00-00-00', {
    providerType: 'venice',
    providerName: 'Venice',
    model: 'venice/model',
    isImageModel: false,
    e2ee: true,
  })
  const configFile = await tempConfig(t)
  const callsBefore = startChatCalls.length
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  await runCliNoExit(t, {
    config: configFile,
    resume: '2026-04-01',
    provider: 'openrouter',
    e2ee: true,
  }, undefined)

  assert.equal(startChatCalls.length, callsBefore + 1)
  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.model, 'venice/model')
  assert.equal(call.endpointProviderName, 'Venice')
  assert.equal(call.provider.meta.name, 'venice')
  assert.equal(call.apiKey, 'venice-test-key')
  assert.ok(warnings.some((l) => /encrypts messages sent to the API, but the session file stores them unencrypted/.test(l)), 'an accepted e2ee resume still warns')
})

test('--e2ee resuming an OpenRouter session is refused without -p', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-04-02T00-00-00', { isImageModel: false, e2ee: true })
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  const { err } = await runAndExit(t, { resume: '2026-04-02', e2ee: true }, undefined, 1)
  assert.match(err.join('\n'), /Error: --e2ee is only available with --provider venice\./)
  assert.deepEqual(warnings, [])
})

test('--e2ee resuming an OpenRouter session is refused even with -p venice', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  await seedSession('2026-04-03T00-00-00', { isImageModel: false, e2ee: true })
  const configFile = await tempConfig(t)
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  // -p venice satisfies the flag-level gate, so pre-fix this was accepted even
  // though the run resolves to the session's OpenRouter provider.
  const { err } = await runAndExit(t, {
    config: configFile,
    resume: '2026-04-03',
    provider: 'venice',
    e2ee: true,
  }, undefined, 1)
  assert.match(err.join('\n'), /Error: --e2ee is only available with --provider venice\./)
  assert.deepEqual(warnings, [])
})

test('--e2ee resuming an OpenRouter session reports the provider, not the encryption mismatch', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  // No stored e2ee marker: the mismatch guard would also fire, so this pins
  // that the provider limitation is the message the user actually sees.
  await seedSession('2026-04-04T00-00-00', { isImageModel: false })

  const { err } = await runAndExit(t, { resume: '2026-04-04', e2ee: true }, undefined, 1)
  assert.match(err.join('\n'), /Error: --e2ee is only available with --provider venice\./)
  assert.ok(!err.some((l) => /not created with --e2ee/.test(l)))
})

test('--e2ee resuming an OpenRouter session reports the provider before the missing key', async (t) => {
  withTTY(t, true)
  withoutApiKey(t)
  // No stored e2ee marker either, so all three guards would fire: the
  // actionable provider limitation must be the one the user sees.
  await seedSession('2026-04-05T00-00-00', { isImageModel: false })

  const { err } = await runAndExit(t, { resume: '2026-04-05', provider: 'venice', e2ee: true }, undefined, 1)
  assert.match(err.join('\n'), /Error: --e2ee is only available with --provider venice\./)
  assert.ok(!err.some((l) => /OPENROUTER_API_KEY environment variable is not set/.test(l)))
  assert.ok(!err.some((l) => /not created with --e2ee/.test(l)))
})

// The five story files of a filled-in --rpg directory (no chapter: a story
// directory that has never been played, whether fresh or holding only a legacy
// history.json).
async function writeRpgStoryFiles(dir) {
  await writeFile(join(dir, 'char.md'), '# Zara\n\n## Personality\nSharp and warm.\n')
  await writeFile(join(dir, 'user.md'), '# Alex\n\n## Description\nThe operator.\n')
  await writeFile(join(dir, 'prompt.md'), '## Tone\nNoir.\n')
  await writeFile(join(dir, 'scenario.md'), '## Current scene\nA rainy street.\n')
  await writeFile(join(dir, 'first-message.md'), 'The rain had stopped by the time she arrived.\n')
}

// --scrape's deferred path reaches scrapeForSession (src/cli-main.js), which
// rejects a provider with no scrapePage; the resolved-provider guard runs
// earlier still, so a refused run never bills the page. Both RPG resume routes
// are covered below: a chapter (judged by its saved provider) and a legacy
// story directory with no chapters (judged by the flag's provider, like a
// fresh run).
async function seedRpgChapter(t, { providerType = 'venice', providerName = 'Venice', model = 'venice/model', e2ee = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeRpgStoryFiles(dir)
  const { ensureRpgSessionsDir, rpgSessionsDir } = await import('../src/rpg.js')
  const { saveSession } = await import('../src/sessions.js')
  await ensureRpgSessionsDir(dir)
  await saveSession(rpgSessionsDir(dir), '2026-05-01T00-00-00', sessionData({
    providerType,
    providerName,
    model,
    isImageModel: false,
    e2ee,
  }))
  return dir
}

test('--rpg --resume --scrape without -p scrapes via the chapter Venice provider', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const dir = await seedRpgChapter(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)
  const callsBefore = startChatCalls.length

  await runCliNoExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    scrape: 'https://example.com/article',
  }, undefined)

  assert.ok(calls.some((u) => u.includes('/augment/scrape')))
  assert.equal(startChatCalls.length, callsBefore + 1)
  const call = startChatCalls[startChatCalls.length - 1]
  assert.equal(call.provider.meta.name, 'venice')
  assert.equal(call.apiKey, 'venice-test-key')
  // The page is billed, so it must reach the run: injected after the stored
  // turns — which must survive — and counted in the flat scrape cost, like the
  // fresh-session path.
  assert.equal(call.opts.initialMessages.length, 4)
  assert.equal(call.opts.initialMessages[0].role, 'system')
  assert.equal(call.opts.initialMessages[1].content, 'First question')
  assert.equal(call.opts.initialMessages[2].content, 'First answer')
  assert.match(call.opts.initialMessages.at(-1).content, /Scraped from https:\/\/example\.com\/article/)
  assert.equal(call.opts.scrapes, 1)
})

test('--rpg --resume --scrape does not pay for the page when the run is refused', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const dir = await seedRpgChapter(t)
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  // --zdr defers to the chapter's resolved provider, which cannot run it. The
  // page is billed before dispatch, so the refusal must land before the fetch.
  const { err } = await runAndExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    provider: 'venice',
    scrape: 'https://example.com/article',
    zdr: true,
  }, undefined, 1)

  assert.match(err.join('\n'), /Error: --zdr is only available with --provider openrouter\./)
  assert.ok(!calls.some((u) => u.includes('/augment/scrape')), 'a refused run must not bill a scrape')
})

test('--rpg --resume --scrape without a chapter does not pay for the page when the run is refused', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'char.md'), '# Zara\n\n## Personality\nSharp and warm.\n')
  await writeFile(join(dir, 'user.md'), '# Alex\n\n## Description\nThe operator.\n')
  await writeFile(join(dir, 'prompt.md'), '## Tone\nNoir.\n')
  await writeFile(join(dir, 'scenario.md'), '## Current scene\nA rainy street.\n')
  await writeFile(join(dir, 'first-message.md'), 'The rain had stopped by the time she arrived.\n')
  const configFile = await tempConfig(t)
  const calls = mockVeniceScrapeFetch(t)

  // No chapter sessions and no history.json: rpgResume resolves to null, so the
  // run is a fresh one on the flag's provider and only the provider gates apply.
  const { err } = await runAndExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    provider: 'venice',
    model: 'venice-model',
    scrape: 'https://example.com/article',
    zdr: true,
  }, undefined, 1)

  assert.match(err.join('\n'), /Error: --zdr is only available with --provider openrouter\./)
  assert.ok(!calls.some((u) => u.includes('/augment/scrape')), 'a refused run must not bill a scrape')
})

test('--rpg --resume --e2ee reports the chapter provider before the missing key', async (t) => {
  withTTY(t, true)
  withoutApiKey(t)
  // The chapter's provider is OpenRouter, and its key is the one that is
  // missing: the actionable limitation must win over the key error.
  const dir = await seedRpgChapter(t, { providerType: 'openrouter', providerName: 'ProviderX', model: 'test/model' })
  const configFile = await tempConfig(t)
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  const { out, err } = await runAndExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    provider: 'venice',
    e2ee: true,
  }, undefined, 1)

  assert.match(err.join('\n'), /Error: --e2ee is only available with --provider venice\./)
  assert.ok(!err.some((l) => /OPENROUTER_API_KEY environment variable is not set/.test(l)))
  // F28: a refused resume announces nothing and warns about nothing.
  assert.deepEqual(warnings, [])
  assert.ok(!`${out.join('\n')}\n${err.join('\n')}`.includes('Resumed RPG conversation from'))
})

test('--rpg --resume --e2ee warns for the chapter files once the run is accepted', async (t) => {
  withTTY(t, true)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const dir = await seedRpgChapter(t, { e2ee: true })
  const configFile = await tempConfig(t)
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  const callsBefore = startChatCalls.length

  const { out, err } = await runCliNoExit(t, { rpg: dir, resume: true, provider: 'venice', config: configFile, e2ee: true }, undefined)

  assert.ok(warnings.some((l) => /RPG .*store them unencrypted/.test(l)), `RPG e2ee warning missing: ${JSON.stringify(warnings)}`)
  assert.equal(startChatCalls.length, callsBefore + 1)
  assert.match(err.join('\n'), /Resumed RPG conversation from/)
  assert.ok(!out.join('\n').includes('Resumed RPG conversation'), 'the notice must stay off piped stdout')
})

test('--debug reaches the interactive RPG chat and is off by default', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const dir = await seedRpgChapter(t)
  const configFile = await tempConfig(t)
  const callsBefore = startChatCalls.length

  await runCliNoExit(t, { rpg: dir, resume: true, provider: 'venice', config: configFile }, undefined)
  assert.equal(startChatCalls.length, callsBefore + 1)
  assert.equal(startChatCalls.at(-1).opts.rpgDebug, false)

  await runCliNoExit(t, { rpg: dir, resume: true, provider: 'venice', config: configFile, debug: true }, undefined)
  assert.equal(startChatCalls.length, callsBefore + 2)
  assert.equal(startChatCalls.at(-1).opts.rpgDebug, true)
})

test('--rpg setup exit does not warn about e2ee at rest', async (t) => {
  withTTY(t, true)
  withVeniceApiKey(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  const { out } = await runAndExit(t, { rpg: dir, e2ee: true, provider: 'venice' }, undefined, 0)

  assert.match(out.join('\n'), /RPG mode setup: created/)
  assert.deepEqual(warnings, [])
})

test('--no-save --rpg on a fresh directory writes the templates and stops at the setup notice', async (t) => {
  // The templates are an artifact the run was asked for, so --no-save writes
  // them and stops at the setup notice like any other fresh --rpg launch.
  withTTY(t, false)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const { out } = await runAndExit(t, { rpg: dir, save: false }, 'Hello', 0)

  assert.match(out.join('\n'), /RPG mode setup: created/)
  for (const file of ['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md']) {
    assert.match(await readFile(join(dir, file), 'utf-8'), /RPG_TEMPLATE/, `${file} must be a fill-in template`)
  }
  assert.equal(await readFile(join(dir, 'post-history-instruction.md'), 'utf-8'), '')
  // The launch exited before generating, so no chapter session was claimed.
  const chapters = await readdir(join(dir, 'sessions')).catch(() => [])
  assert.deepEqual(chapters.filter((f) => f.endsWith('.json')), [])
})

test('--no-save skips the legacy RPG import: the answer lands, no chapter and no notice', async (t) => {
  // The import writes a chapter, so --no-save leaves it for a run that may
  // save; the story directory keeps its legacy history.json and gains no
  // chapter, while the run itself answers exactly as it would otherwise.
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeRpgStoryFiles(dir)
  await writeFile(join(dir, 'history.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    messages: [
      { role: 'assistant', content: 'The gate creaks open.' },
      { role: 'user', content: 'I step through.' },
    ],
  }, null, 2) + '\n')
  const configFile = await tempConfig(t)
  // The Venice text catalog is process-cached: a listing mocked empty by an
  // earlier test would leak into this model lookup.
  const { resetModelCaches } = await import('../src/providers/venice.js')
  resetModelCaches()
  t.after(resetModelCaches)
  mockVeniceScrapeFetch(t)
  const writes = []
  t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true })

  const { out, err } = await runAndExit(t, {
    provider: 'venice',
    model: 'venice-model',
    config: configFile,
    rpg: dir,
    save: false,
  }, 'Explain this', 0)

  assert.ok(writes.join('').includes('Summary'), 'the run still answers')
  assert.ok([...out, ...err].every((line) => !line.includes('Migrated')), `no migration notice: ${JSON.stringify([...out, ...err])}`)
  // The legacy story still counts as the one earlier session, exactly as
  // without --no-save.
  assert.ok(err.some((line) => line.includes(`Starting a new story in ${dir} (1 earlier session available`)), `errors: ${JSON.stringify(err)}`)
  // The 0-byte chapter claim this run made is removed again: nothing to resume.
  const chapters = await readdir(join(dir, 'sessions')).catch(() => [])
  assert.deepEqual(chapters.filter((f) => f.endsWith('.json')), [])
})

test('an explicitly empty --rpg --resume= continues the story like the bare flag', async (t) => {
  // Commander keeps --resume= as '': no id was given, so it is the bare flag's
  // chapter fallback rather than a new story in the same directory.
  withTTY(t, false)
  withStdoutTTY(t, false)
  withVeniceApiKey(t)
  const dir = await seedRpgChapter(t, { providerType: 'venice', providerName: 'Venice', model: 'venice/model' })
  const configFile = await tempConfig(t)
  mockVeniceScrapeFetch(t)
  const writes = []
  t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true })

  const { err } = await runAndExit(t, { provider: 'venice', config: configFile, rpg: dir, resume: '' }, 'Hello', 0)

  assert.ok(writes.join('').includes('Summary'))
  assert.ok(err.some((line) => line.includes(`Resumed RPG conversation from ${dir}/sessions/`)), `errors: ${JSON.stringify(err)}`)
  assert.ok(err.every((line) => !line.includes('Starting a new story')))
})

test('--rpg --resume --scrape of an OpenRouter chapter fails loudly, never silently', async (t) => {
  withTTY(t, true)
  withApiKey(t)
  const dir = await seedRpgChapter(t, { providerType: 'openrouter', providerName: 'ProviderX', model: 'test/model' })
  const configFile = await tempConfig(t)

  // -p venice passes the flag gate; the chapter's OpenRouter provider has no
  // scrapePage, so scrapeForSession rejects it instead of dropping the flag.
  const { err } = await runAndExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    provider: 'venice',
    scrape: 'https://example.com/article',
  }, undefined, 1)
  assert.match(err.join('\n'), /Error: --scrape is not supported by provider openrouter\./)
})

test('--rpg --resume --scrape reports the chapter provider before the missing key', async (t) => {
  withTTY(t, true)
  withoutApiKey(t)
  const dir = await seedRpgChapter(t, { providerType: 'openrouter', providerName: 'ProviderX', model: 'test/model' })
  const configFile = await tempConfig(t)

  const { err } = await runAndExit(t, {
    config: configFile,
    rpg: dir,
    resume: true,
    provider: 'venice',
    scrape: 'https://example.com/article',
  }, undefined, 1)

  assert.match(err.join('\n'), /Error: --scrape is not supported by provider openrouter\./)
  assert.ok(!err.join('\n').includes('OPENROUTER_API_KEY'), 'the provider limitation must beat the key error')
})
