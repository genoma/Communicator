import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chatCommands, budgetGuard, CHAT_COMMANDS } from '../src/commands/chat/index.js'
import { ChatState } from '../src/chat-state.js'
import { UsageTracker } from '../src/tracker.js'

function fakeProvider(overrides = {}) {
  return {
    meta: { name: 'openrouter', supportsWebSearchOnAll: true },
    async fetchModels() {
      return [
        { id: 'org/model', reasoning: null, pricing: null },
        { id: 'effort-model', reasoning: { supported: true, supportsEffort: true, default_effort: 'low' }, pricing: null },
      ]
    },
    async fetchEndpoints() {
      return []
    },
    ...overrides,
  }
}

function makeCtx(overrides = {}) {
  const state = new ChatState({
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 0.7,
    budget: null,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    supportsReasoning: true,
    webSearch: false,
    webResults: null,
    webSearchSupported: true,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelReasoning: null,
  })
  const savedSessions = []
  const prefsUpdates = []
  let turnCount = 0
  let copied = null

  const ctx = {
    state,
    tracker: new UsageTracker(),
    provider: fakeProvider(),
    apiKey: 'test-key',
    prefs: {},
    systemContent: 'You are a helpful assistant.',
    saveSession: async () => { savedSessions.push(state.messages.length) },
    savePrefs: async (updates) => { prefsUpdates.push(updates) },
    runTurn: async () => { turnCount++ },
    render: { markdown: true, smooth: true, smoothCharsPerTick: 40 },
    newSessionId: async () => '2026-01-02T00-00-00',
    copyText: async (text) => { copied = text; return { ok: true } },
    selectModelAndEndpoint: undefined,
    selectReasoningEffort: undefined,
    ...overrides,
  }

  return {
    ctx,
    savedSessions,
    prefsUpdates,
    get turnCount() { return turnCount },
    get copied() { return copied },
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  return {
    log: (i) => console.log.mock.calls[i]?.arguments[0],
    error: (i) => console.error.mock.calls[i]?.arguments[0],
  }
}

test('/quit returns the exit signal', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx()
  const outcome = await chatCommands['/quit'](ctx)
  assert.deepEqual(outcome, { exit: true })
})

test('/new saves the session, requests a fresh id, resets state', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx, savedSessions } = harness; const { prefsUpdates } = harness
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'hi there' })

  const outcome = await chatCommands['/new'](ctx)

  assert.deepEqual(outcome, { reset: true })
  assert.deepEqual(savedSessions, [3])
  assert.equal(ctx.state.sessionId, '2026-01-02T00-00-00')
  assert.ok(ctx.state.createdAt)
  assert.deepEqual(ctx.state.messages, [{ role: 'system', content: 'You are a helpful assistant.' }])
  assert.equal(ctx.state.budget, null)
  assert.equal(ctx.state.webResults, null)
  assert.deepEqual(prefsUpdates, [])
  assert.equal(consoleSpy.log(0), '\nNew session started.\n')
})

test('/model switches state and saves prefs', async (t) => {
  mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx({
    prefs: { temperature: { 'new/model': 0.3 }, webSearch: { 'new/model': true } },
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'NewProvider',
      pricing: { prompt: 0.000002, completion: 0.000003 },
      reasoningEffort: 'low',
      supportsReasoning: true,
      modelReasoning: { supported: true, supportsEffort: true },
      webSearchSupported: true,
    }),
  })

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.modelId, 'new/model')
  assert.equal(ctx.state.endpointProviderName, 'NewProvider')
  assert.deepEqual(ctx.state.pricing, { prompt: 0.000002, completion: 0.000003 })
  assert.equal(ctx.state.reasoningEffort, 'low')
  assert.equal(ctx.state.supportsReasoning, true)
  assert.deepEqual(ctx.state.modelReasoning, { supported: true, supportsEffort: true })
  assert.equal(ctx.state.temperature, 0.3)
  assert.equal(ctx.state.webSearch, 'auto')
  assert.deepEqual(prefsUpdates, [{
    modelId: 'new/model',
    lastModel: 'new/model',
    lastProvider: 'NewProvider',
    reasoningEffort: 'low',
  }])
})

test('/model gates web search off when the model is unsupported', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx({
    prefs: { webSearch: { 'new/model': true } },
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'NewProvider',
      pricing: null,
      reasoningEffort: undefined,
      supportsReasoning: false,
      modelReasoning: null,
      webSearchSupported: false,
    }),
  })

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.webSearch, 'off')
})

test('/model reports selection failures without crashing', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    provider: fakeProvider({
      async fetchModels() {
        throw new Error('network down')
      },
    }),
  })
  const before = {
    modelId: ctx.state.modelId,
    endpointProviderName: ctx.state.endpointProviderName,
    reasoningEffort: ctx.state.reasoningEffort,
  }

  await chatCommands['/model'](ctx)

  assert.equal(consoleSpy.error(0), '\nError: network down\n')
  assert.equal(ctx.state.modelId, before.modelId)
  assert.equal(ctx.state.endpointProviderName, before.endpointProviderName)
  assert.equal(ctx.state.reasoningEffort, before.reasoningEffort)
})

test('/reasoning sets the effort and saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx({
    provider: fakeProvider({
      async fetchModels() {
        return [
          { id: 'org/model', reasoning: { supported: true, supportsEffort: true, default_effort: 'medium' }, pricing: null },
        ]
      },
    }),
    selectReasoningEffort: async () => 'low',
  })

  await chatCommands['/reasoning'](ctx)

  assert.equal(ctx.state.reasoningEffort, 'low')
  assert.deepEqual(ctx.state.modelReasoning, { supported: true, supportsEffort: true, default_effort: 'medium' })
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', reasoningEffort: 'low' }])
  assert.equal(consoleSpy.log(0), 'Reasoning effort set to Low\n')
})

test('/reasoning reports models without effort control', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.modelReasoning = null

  await chatCommands['/reasoning'](ctx)

  assert.equal(consoleSpy.log(0), 'This model does not support reasoning effort control.\n')
  assert.equal(ctx.state.reasoningEffort, 'high')
  assert.deepEqual(ctx.state.modelReasoning, null)
})

test('/reasoning reports fetch failures without crashing', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    provider: fakeProvider({
      async fetchModels() {
        throw new Error('boom')
      },
    }),
  })

  await chatCommands['/reasoning'](ctx)

  assert.equal(consoleSpy.error(0), '\nError: boom\n')
  assert.equal(ctx.state.reasoningEffort, 'high')
})

test('/temp shows the current temperature without args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/temp'](ctx)
  assert.equal(consoleSpy.log(0), 'Current temperature: 0.7\n')
  assert.deepEqual(prefsUpdates, [])
})

test('/temp sets a valid temperature and saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/temp']({ ...ctx, args: '1.3' })
  assert.equal(ctx.state.temperature, 1.3)
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', temperature: 1.3 }])
  assert.equal(consoleSpy.log(0), 'Temperature set to 1.3\n')
})

test('/temp rejects invalid values without changing state', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/temp']({ ...ctx, args: '2.5' })
  assert.equal(consoleSpy.error(0), '\nError: Temperature must be a number between 0 and 2.\n')
  assert.equal(ctx.state.temperature, 0.7)
  assert.deepEqual(prefsUpdates, [])
})

test('/budget sets a valid budget', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const outcome = await chatCommands['/budget']({ ...ctx, args: '5' })
  assert.equal(ctx.state.budget, 5)
  assert.deepEqual(outcome, { resetBudgetWarning: true })
  assert.equal(consoleSpy.log(0), 'Budget set to $5.000000 for this session.\n')
})

test('/budget rejects non-positive and non-numeric values', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/budget']({ ...ctx, args: '0' })
  assert.equal(consoleSpy.error(0), 'Error: budget must be a positive number (USD).\n')
  assert.equal(ctx.state.budget, null)
  await chatCommands['/budget']({ ...ctx, args: '-3' })
  assert.equal(ctx.state.budget, null)
  await chatCommands['/budget']({ ...ctx, args: 'abc' })
  assert.equal(ctx.state.budget, null)
})

test('/budget shows the status line when a budget is set', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setBudget(5)
  ctx.tracker.cost = 1
  await chatCommands['/budget'](ctx)
  assert.equal(consoleSpy.log(0), 'Budget: $1.000000 of $5.000000 used (20%). $4.000000 remaining.\n')
})

test('/budget shows the no-budget line without a budget', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/budget'](ctx)
  assert.equal(consoleSpy.log(0), 'No budget set. Use /budget <usd> to cap this session.\n')
})

test('/web-search shows status without args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/web-search'](ctx)
  assert.equal(consoleSpy.log(0), 'Web search is off.\n')
})

test('/web-search status includes the mode and result count when set', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setWebSearch('always')
  ctx.state.setWebResults(3)
  await chatCommands['/web-search'](ctx)
  assert.equal(consoleSpy.log(0), 'Web search is always (3 results).\n')
})

test('/web-search on maps to auto and saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/web-search']({ ...ctx, args: 'on' })
  assert.equal(ctx.state.webSearch, 'auto')
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', webSearch: 'auto' }])
  assert.equal(consoleSpy.log(0), 'Web search set to auto.\n')
})

test('/web-search auto saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/web-search']({ ...ctx, args: 'auto' })
  assert.equal(ctx.state.webSearch, 'auto')
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', webSearch: 'auto' }])
  assert.equal(consoleSpy.log(0), 'Web search set to auto.\n')
})

test('/web-search always saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/web-search']({ ...ctx, args: 'always' })
  assert.equal(ctx.state.webSearch, 'always')
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', webSearch: 'always' }])
  assert.equal(consoleSpy.log(0), 'Web search set to always.\n')
})

test('/web-search off disables web search', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setWebSearch(true)
  await chatCommands['/web-search']({ ...ctx, args: 'off' })
  assert.equal(ctx.state.webSearch, 'off')
  assert.equal(consoleSpy.log(0), 'Web search disabled.\n')
})

test('/web-search on is rejected for unsupported models', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  ctx.state.webSearchSupported = false
  await chatCommands['/web-search']({ ...ctx, args: 'on' })
  assert.equal(consoleSpy.log(0), 'This model does not support web search.\n')
  assert.equal(ctx.state.webSearch, 'off')
  assert.deepEqual(prefsUpdates, [])
})

test('/web-search always is rejected for unsupported models', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  ctx.state.webSearchSupported = false
  await chatCommands['/web-search']({ ...ctx, args: 'always' })
  assert.equal(consoleSpy.log(0), 'This model does not support web search.\n')
  assert.equal(ctx.state.webSearch, 'off')
  assert.deepEqual(prefsUpdates, [])
})

test('/web-search rejects invalid arguments', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/web-search']({ ...ctx, args: 'maybe' })
  assert.equal(consoleSpy.error(0), 'Error: /web-search expects "on", "off", "auto", or "always".\n')
})

test('/web-results shows the default line without args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/web-results'](ctx)
  assert.equal(consoleSpy.log(0), 'Web search results: default (10).\n')
})

test('/web-results shows the current count without args when set', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setWebResults(3)
  await chatCommands['/web-results'](ctx)
  assert.equal(consoleSpy.log(0), 'Web search results: 3.\n')
})

test('/web-results sets a valid count', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/web-results']({ ...ctx, args: '5' })
  assert.equal(ctx.state.webResults, 5)
  assert.equal(consoleSpy.log(0), 'Web search results set to 5.\n')
})

test('/web-results rejects invalid counts', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/web-results']({ ...ctx, args: '0' })
  assert.equal(consoleSpy.error(0), '\nError: --web-results must be a positive integer.\n')
  assert.equal(ctx.state.webResults, null)
})

test('/cost prints the tracker summary and reasoning line', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.tracker.record({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ctx.state.pricing)
  await chatCommands['/cost'](ctx)
  assert.equal(consoleSpy.log(0), 'Current session: ↑ 100 prompt  ↓ 50 completion  = 150 total  |  1 request(s)  |  $0.000200 cost')
  assert.equal(consoleSpy.log(1), 'Reasoning: High\n')
})

test('/cost shows auto for undefined reasoning effort', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setReasoningEffort(undefined)
  await chatCommands['/cost'](ctx)
  assert.equal(consoleSpy.log(1), 'Reasoning: auto\n')
})

test('/retry pops the last assistant message then reruns the turn', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  assert.equal(harness.turnCount, 1)
  assert.equal(ctx.state.messages.length, 2)
  assert.equal(ctx.state.messages[1].role, 'user')
})

test('/retry reruns directly when the last message is a user message', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.appendUser('hello')

  await chatCommands['/retry'](ctx)

  assert.equal(harness.turnCount, 1)
  assert.equal(ctx.state.messages.length, 2)
})

test('/retry reports nothing to retry', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  await chatCommands['/retry'](ctx)
  assert.equal(consoleSpy.log(0), 'Nothing to retry yet.\n')
  assert.equal(harness.turnCount, 0)
})

test('/retry is blocked by the budget guard', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.setBudget(5)
  ctx.tracker.cost = 6
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })

  await chatCommands['/retry'](ctx)

  assert.equal(harness.turnCount, 0)
  assert.equal(consoleSpy.log(0), 'Budget exhausted ($6.000000 of $5.000000). /new to start fresh or /quit.\n')
})

test('/copy reports no response to copy and leaves the clipboard untouched', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  await chatCommands['/copy'](ctx)
  assert.equal(consoleSpy.log(0), 'No assistant response to copy.\n')
  assert.equal(harness.copied, null)
})

test('/copy copies the last assistant response', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer text' })
  await chatCommands['/copy'](ctx)
  assert.equal(harness.copied, 'answer text')
  assert.equal(consoleSpy.log(0), 'Copied last response to clipboard.\n')
})

test('/copy reports clipboard failures', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    copyText: async () => ({ ok: false, error: 'pbcopy missing' }),
  })
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer text' })
  await chatCommands['/copy'](ctx)
  assert.equal(consoleSpy.log(0), 'Copy failed: pbcopy missing\n')
})

test('/markdown toggles state and renderer flags', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/markdown'](ctx)
  assert.equal(ctx.state.markdown, false)
  assert.equal(ctx.render.markdown, false)
  assert.equal(consoleSpy.log(0), 'Markdown rendering disabled.\n')
})

test('/smooth shows the current status with no args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/smooth'](ctx)
  assert.equal(consoleSpy.log(0), 'Smooth streaming is on (normal, ~2000 chars/s).\n')
})

test('/smooth status shows off and the speed label', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setSmoothStreaming(false)
  ctx.state.setSmoothSpeed('fast')
  await chatCommands['/smooth'](ctx)
  assert.equal(consoleSpy.log(0), 'Smooth streaming is off.\n')
})

test('/smooth off updates state, renderer and saves the global pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness
  ctx.render.smooth = true

  await chatCommands['/smooth']({ ...ctx, args: 'off' })

  assert.equal(ctx.state.smoothStreaming, false)
  assert.equal(ctx.render.smooth, false)
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: false }])
  assert.equal(consoleSpy.log(0), 'Smooth streaming disabled.\n')
})

test('/smooth on re-enables smooth streaming and saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness
  ctx.state.setSmoothStreaming(false)
  ctx.render.smooth = false

  await chatCommands['/smooth']({ ...ctx, args: 'on' })

  assert.equal(ctx.state.smoothStreaming, true)
  assert.equal(ctx.render.smooth, true)
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: true }])
  assert.equal(consoleSpy.log(0), 'Smooth streaming enabled.\n')
})

test('/smooth rejects invalid values', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/smooth']({ ...ctx, args: 'maybe' })
  assert.equal(consoleSpy.error(0), '\nError: Smooth speed must be "slow", "normal", "fast", or a positive number of chars per second.\n')
  assert.equal(ctx.state.smoothStreaming, true)
  assert.equal(ctx.state.smoothSpeed, 2000)
  assert.equal(ctx.render.smoothCharsPerTick, 40)
})

test('/smooth fast enables streaming, sets the speed and saves the raw value', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness
  ctx.state.setSmoothStreaming(false)
  ctx.render.smooth = false

  await chatCommands['/smooth']({ ...ctx, args: 'fast' })

  assert.equal(ctx.state.smoothStreaming, true)
  assert.equal(ctx.state.smoothSpeed, 8000)
  assert.equal(ctx.render.smooth, true)
  assert.equal(ctx.render.smoothCharsPerTick, 160)
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: true, smoothSpeed: 'fast' }])
  assert.equal(consoleSpy.log(0), 'Smooth streaming enabled (fast, ~8000 chars/s).\n')
})

test('/smooth with a numeric cps sets the speed and saves the raw value', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness

  await chatCommands['/smooth']({ ...ctx, args: '1500' })

  assert.equal(ctx.state.smoothStreaming, true)
  assert.equal(ctx.state.smoothSpeed, 1500)
  assert.equal(ctx.render.smooth, true)
  assert.equal(ctx.render.smoothCharsPerTick, 30)
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: true, smoothSpeed: '1500' }])
  assert.equal(consoleSpy.log(0), 'Smooth streaming enabled (1500 chars/s).\n')
})

test('budgetGuard blocks when cost meets the budget', () => {
  const { ctx } = makeCtx()
  ctx.state.setBudget(5)
  ctx.tracker.cost = 5
  assert.equal(budgetGuard(ctx), 'Budget exhausted ($5.000000 of $5.000000). /new to start fresh or /quit.\n')
  ctx.tracker.cost = 4.99
  assert.equal(budgetGuard(ctx), null)
})

test('budgetGuard passes when no budget is set', () => {
  const { ctx } = makeCtx()
  assert.equal(budgetGuard(ctx), null)
})

async function writeFixture(t, name, bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  await writeFile(file, bytes)
  return file
}

test('/attach queues files with per-file result lines', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const png = await writeFixture(t, 'a.png', 'PNGDATA')
  const txt = await writeFixture(t, 'notes.txt', 'hello')

  await chatCommands['/attach']({ ...ctx, args: `${png} ${txt}` })

  assert.equal(ctx.state.pendingAttachments.length, 2)
  assert.equal(ctx.state.pendingAttachments[0].kind, 'image')
  assert.equal(ctx.state.pendingAttachments[0].filename, 'a.png')
  assert.match(ctx.state.pendingAttachments[0].data, /^data:image\/png;base64,/)
  assert.equal(ctx.state.pendingAttachments[1].kind, 'text')
  assert.equal(ctx.state.pendingAttachments[1].data, 'hello')
  assert.equal(consoleSpy.log(0), 'attached: a.png (image, 7 B)\n')
  assert.equal(consoleSpy.log(1), 'attached: notes.txt (text, 5 B)\n')
})

test('/attach reports per-file errors without aborting the rest', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const txt = await writeFixture(t, 'ok.txt', 'fine')

  await chatCommands['/attach']({ ...ctx, args: `${txt} missing.exe` })

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].filename, 'ok.txt')
  assert.equal(consoleSpy.log(0), 'attached: ok.txt (text, 4 B)\n')
  assert.equal(consoleSpy.error(0), 'Error: Unsupported file type: exe\n')
})

test('/attach rejects missing files', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/attach']({ ...ctx, args: 'no-such-file.png' })

  assert.deepEqual(ctx.state.pendingAttachments, [])
  assert.equal(consoleSpy.error(0), 'Error: Cannot read attachment: no-such-file.png\n')
})

test('/attach rejects images when the model lacks vision', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.visionSupported = false
  const png = await writeFixture(t, 'a.png', 'PNGDATA')

  await chatCommands['/attach']({ ...ctx, args: png })

  assert.deepEqual(ctx.state.pendingAttachments, [])
  assert.equal(consoleSpy.error(0), 'Error: The selected model does not support image input.\n')
})

test('/attach rejects office files on openrouter', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const xlsx = await writeFixture(t, 'book.xlsx', 'xlsx-bytes')

  await chatCommands['/attach']({ ...ctx, args: xlsx })

  assert.deepEqual(ctx.state.pendingAttachments, [])
  assert.equal(consoleSpy.error(0), 'Error: xlsx/docx/pptx are only supported on Venice (server-side extraction). OpenRouter supports PDFs and text files.\n')
})

test('/attach allows office files on venice', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    provider: fakeProvider({ meta: { name: 'venice' } }),
  })
  const xlsx = await writeFixture(t, 'book.xlsx', 'xlsx-bytes')

  await chatCommands['/attach']({ ...ctx, args: xlsx })

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].kind, 'office')
  assert.equal(consoleSpy.log(0), 'attached: book.xlsx (office, 10 B)\n')
})

test('/attach with no args lists the queue like /attachments', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/attach'](ctx)

  assert.equal(consoleSpy.log(0), 'No attachments queued. Use /attach <path> to add one.\n')
})

test('/attachments lists the queue with name, kind and size', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.pendingAttachments.push(
    { kind: 'image', filename: 'a.png', size: 1536, data: 'x' },
    { kind: 'pdf', filename: 'b.pdf', size: 2048 * 1024, data: 'y' },
  )

  await chatCommands['/attachments'](ctx)

  assert.equal(consoleSpy.log(0), 'Pending attachments (2):')
  assert.equal(consoleSpy.log(1), 'a.png  image  1.5 KB\n')
  assert.equal(consoleSpy.log(2), 'b.pdf  pdf  2.0 MB\n')
})

test('/attachments clear empties the queue', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.pendingAttachments.push({ kind: 'image', filename: 'a.png', size: 1, data: 'x' })

  await chatCommands['/attachments']({ ...ctx, args: 'clear' })

  assert.deepEqual(ctx.state.pendingAttachments, [])
  assert.equal(consoleSpy.log(0), 'Attachment queue cleared.\n')
})

test('/attachments rejects unknown arguments', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/attachments']({ ...ctx, args: 'bogus' })

  assert.equal(consoleSpy.error(0), 'Error: /attachments expects "clear" or no argument.\n')
})

test('/model drops queued attachments the new model cannot accept', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'NewProvider',
      pricing: null,
      reasoningEffort: undefined,
      supportsReasoning: false,
      modelReasoning: null,
      webSearchSupported: true,
      visionSupported: false,
    }),
  })
  ctx.state.pendingAttachments.push(
    { kind: 'image', filename: 'a.png', size: 1, data: 'x' },
    { kind: 'text', filename: 'b.txt', size: 1, data: 'y' },
  )

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].filename, 'b.txt')
  assert.equal(consoleSpy.log(0), 'Dropped attachment a.png: The selected model does not support image input.\n')
  assert.equal(consoleSpy.log(1), '\nSwitched to NewProvider / new/model\n')
})

test('/model keeps compatible attachments on switch', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'NewProvider',
      pricing: null,
      reasoningEffort: undefined,
      supportsReasoning: false,
      modelReasoning: null,
      webSearchSupported: true,
      visionSupported: true,
    }),
  })
  ctx.state.pendingAttachments.push({ kind: 'image', filename: 'a.png', size: 1, data: 'x' })

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].filename, 'a.png')
  assert.equal(consoleSpy.log(0), '\nSwitched to NewProvider / new/model\n')
})

test('CHAT_COMMANDS keeps the 15-command order', () => {
  assert.deepEqual(CHAT_COMMANDS, [
    '/quit',
    '/new',
    '/model',
    '/attach',
    '/attachments',
    '/reasoning',
    '/temp',
    '/budget',
    '/web-search',
    '/web-results',
    '/retry',
    '/copy',
    '/markdown',
    '/smooth',
    '/cost',
  ])
})
