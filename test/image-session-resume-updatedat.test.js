import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-image-resume-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

let resumeResult = null
mock.module(new URL('../src/commands/resume.js', import.meta.url).href, {
  namedExports: {
    resumeCmd: async () => resumeResult,
  },
})

// The resume under test always routes into the image session: a text REPL here
// would mean the image branch was skipped.
mock.module(new URL('../src/chat.js', import.meta.url).href, {
  namedExports: {
    startChat: async () => { throw new Error('unexpected chat REPL') },
  },
})

// Records the exact options chatStart hands over, then runs the real image
// session with the input scripted to leave without generating.
const imageSessionCalls = []
const scriptedQuit = async () => ({ value: '/quit' })
mock.module(new URL('../src/commands/image-session.js', import.meta.url).href, {
  namedExports: {
    startImageSession: async (opts) => {
      imageSessionCalls.push(opts)
      const { startImageSession: realStartImageSession } = await import('../src/commands/image-session.js?real')
      return realStartImageSession({ ...opts, readInput: scriptedQuit })
    },
  },
})

const { chatStart } = await import('../src/commands/chat-start.js')

const RESULT_UPDATED_AT = '2026-02-01T10:05:00.000Z'
const RESULT_CREATED_AT = '2026-02-01T10:00:00.000Z'
const SESSION_ID = '2026-02-01T10-00-00'

function resumeSession(overrides = {}) {
  return {
    modelId: 'venice-sd35',
    providerName: 'venice',
    providerType: 'venice',
    isImageModel: true,
    pricing: { perImage: 0.02 },
    initialMessages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a red cat' },
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ref://attachments/old.webp' } }] },
    ],
    sessionId: SESSION_ID,
    sessionCreatedAt: RESULT_CREATED_AT,
    sessionUpdatedAt: RESULT_UPDATED_AT,
    ...overrides,
  }
}

function baseOpts(overrides = {}) {
  return {
    model: undefined,
    temperature: undefined,
    budget: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    webResults: undefined,
    attach: [],
    smoothStreaming: true,
    smoothSpeed: undefined,
    config: undefined,
    resume: undefined,
    e2ee: undefined,
    zdr: undefined,
    image: undefined,
    ...overrides,
  }
}

function withVeniceApiKey(t, value = 'venice-key') {
  const previous = process.env.VENICE_API_KEY
  process.env.VENICE_API_KEY = value
  t.after(() => {
    if (previous === undefined) delete process.env.VENICE_API_KEY
    else process.env.VENICE_API_KEY = previous
  })
}

function mockImageCatalog(t) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ id: 'venice-sd35', model_spec: { name: 'SD 3.5', constraints: { aspectRatios: ['1:1'] }, pricing: { generation: { usd: 0.02 } } } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'warn', () => {})
}

function sessionFile(sessionId) {
  return join(tempHome, '.communicator', 'sessions', `${sessionId}.json`)
}

test('chatStart hands the stored session updatedAt to the image session', { timeout: 5000 }, async (t) => {
  mockConsole(t)
  withVeniceApiKey(t)
  mockImageCatalog(t)
  imageSessionCalls.length = 0
  resumeResult = resumeSession()

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: '2026-02-01' }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  assert.equal(imageSessionCalls.length, 1)
  const call = imageSessionCalls[0]
  // The resume's own stamp travels with the context: without it the image
  // session treats the resume as a fresh claim and re-stamps on quit.
  assert.equal(call.updatedAt, RESULT_UPDATED_AT)
  assert.equal(call.createdAt, RESULT_CREATED_AT)
  assert.equal(call.sessionId, SESSION_ID)
})

test('a resumed image session that quits without generating keeps the stored updatedAt on disk', { timeout: 5000 }, async (t) => {
  mockConsole(t)
  withVeniceApiKey(t)
  mockImageCatalog(t)
  imageSessionCalls.length = 0
  resumeResult = resumeSession()

  await chatStart({ apiKey: 'k', opts: baseOpts({ resume: '2026-02-01' }), prefs: {}, systemPrompt: null, providerType: 'venice' })

  const saved = JSON.parse(await readFile(sessionFile(SESSION_ID), 'utf-8'))
  assert.equal(saved.updatedAt, RESULT_UPDATED_AT)
  assert.equal(saved.createdAt, RESULT_CREATED_AT)
  assert.equal(saved.model, 'venice-sd35')
  assert.equal(saved.isImageModel, true)
})
