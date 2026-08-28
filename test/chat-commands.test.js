import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExitPromptError } from '@inquirer/core'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createECDH } from 'node:crypto'
import { chatCommands, budgetGuard, CHAT_COMMANDS, visibleChatCommands, commandAcceptsArgs } from '../src/commands/chat/index.js'
import { ChatState } from '../src/chat-state.js'
import { UsageTracker } from '../src/tracker.js'
import { connectedBanner, buildStatusLine } from '../src/status-line.js'
import { renderHistory } from '../src/ui/stream.js'

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
    onResizeRepaint: null,
    selectModelAndEndpoint: undefined,
    selectReasoningEffort: undefined,
    ...overrides,
  }

  // The default hook mirrors chat.js `renderAboveEditor`: banner + transcript
  // onto ctx.stdout, so TTY retry/edit tests exercise the same rebuild the
  // resize path uses (and its own wipe comes from redrawForRetry).
  ctx.onResizeRepaint ??= (opts = {}) => {
    const stdout = ctx.stdout
    if (!stdout?.write) return
    stdout.write(`${connectedBanner(buildStatusLine(ctx.state))}\n`)
    renderHistory(ctx.state.messages, { markdown: ctx.state.markdown, stdout, compactThinking: ctx.state.compactThinking, tailBlank: opts.tailBlank ?? (opts.turnFooter !== false) })
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
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [smooth: on (normal, ~2000 chars/s)]\n')
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

test('/model reports picker cancellation as Aborted and keeps the current model', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    selectModelAndEndpoint: async () => {
      throw new ExitPromptError()
    },
  })
  const before = ctx.state.modelId

  await chatCommands['/model'](ctx)

  assert.equal(consoleSpy.log(0), 'Aborted.')
  assert.equal(ctx.state.modelId, before)
})

test('/model with no zero-retention models prints the error and never exits the process', async (t) => {
  const consoleSpy = mockConsole(t)
  let exitCalled = 0
  t.mock.method(process, 'exit', () => { exitCalled++ })
  const { ctx } = makeCtx({
    state: new ChatState({
      modelId: 'org/model',
      endpointProviderName: 'Provider',
      reasoningEffort: 'high',
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      zdr: true,
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
    provider: fakeProvider({
      meta: { name: 'openrouter', supportsWebSearchOnAll: true, supportsZdr: true },
      isZdrIndexDegraded: async () => false,
      async fetchModels() {
        return []
      },
    }),
  })
  const before = ctx.state.modelId

  const outcome = await chatCommands['/model'](ctx)

  assert.equal(exitCalled, 0)
  assert.equal(outcome, undefined)
  assert.equal(ctx.state.modelId, before)
  assert.equal(consoleSpy.error(0), '\nError: No zero-retention models available on OpenRouter right now.\n')
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

test('/temp default clears the value and the persisted pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/temp']({ ...ctx, args: 'default' })
  assert.equal(ctx.state.temperature, undefined)
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', temperature: null }])
  assert.equal(consoleSpy.log(0), 'Temperature set to default (provider default).\n')
  assert.match(consoleSpy.log(1), /\[temp: default\]/)
})

test('/temp rejects invalid values without changing state', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/temp']({ ...ctx, args: '2.5' })
  assert.equal(consoleSpy.error(0), '\nError: Temperature must be a number between 0 and 2.\n')
  assert.equal(ctx.state.temperature, 0.7)
  assert.deepEqual(prefsUpdates, [])
})

test('/top-p shows the current top-p without args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/top-p'](ctx)
  assert.equal(consoleSpy.log(0), 'Current top-p: default\n')
  assert.deepEqual(prefsUpdates, [])
})

test('/top-p sets a valid top-p, saves the pref and prints the status line', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/top-p']({ ...ctx, args: '0.6' })
  assert.equal(ctx.state.topP, 0.6)
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', topP: 0.6 }])
  assert.equal(consoleSpy.log(0), 'Top-p set to 0.6\n')
  assert.match(consoleSpy.log(1), /\[top-p: 0.6\]/)
})

test('/top-p default clears the value and the persisted pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/top-p']({ ...ctx, args: 'default' })
  assert.equal(ctx.state.topP, undefined)
  assert.deepEqual(prefsUpdates, [{ modelId: 'org/model', topP: null }])
  assert.equal(consoleSpy.log(0), 'Top-p set to default (provider default).\n')
  assert.match(consoleSpy.log(1), /\[top-p: default\]/)
})

test('/top-p rejects invalid values without changing state', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  await chatCommands['/top-p']({ ...ctx, args: '1.5' })
  assert.equal(consoleSpy.error(0), '\nError: Top-p must be a number between 0 and 1.\n')
  assert.equal(ctx.state.topP, undefined)
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
  assert.equal(consoleSpy.error(0), '\nError: Budget must be a positive number (USD).\n')
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
  assert.equal(consoleSpy.log(0), 'The selected model does not support web search.\n')
  assert.equal(ctx.state.webSearch, 'off')
  assert.deepEqual(prefsUpdates, [])
})

test('/web-search always is rejected for unsupported models', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx, prefsUpdates } = makeCtx()
  ctx.state.webSearchSupported = false
  await chatCommands['/web-search']({ ...ctx, args: 'always' })
  assert.equal(consoleSpy.log(0), 'The selected model does not support web search.\n')
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

test('/retry replays the stashed failed turn (attachments included) instead of the previous turn', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  // A previous successful turn...
  ctx.state.appendUser('earlier question')
  ctx.state.appendAssistant({ role: 'assistant', content: 'earlier answer' })
  // ...then a failed turn with an attachment: its content carries the parts.
  const failedContent = [{ type: 'text', text: 'summarize' }, { type: 'file', file: { file_data: 'ref://sha256' } }]
  ctx.state.retryTurn = failedContent

  await chatCommands['/retry'](ctx)

  assert.equal(harness.turnCount, 1)
  assert.deepEqual(ctx.state.messages[3], { role: 'user', content: failedContent })
  assert.equal(ctx.state.retryTurn, null)
  // The earlier answer was NOT replayed and the earlier turn untouched.
  assert.equal(ctx.state.messages[1].role, 'user')
})

test('/retry clears the terminal and redraws history without the old answer after the replacement arrives', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  ctx.runTurn = async () => {
    ctx.state.appendAssistant({ role: 'assistant', content: 'second answer' })
  }
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  const output = writes.join('')
  assert.ok(output.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.match(output, /hello/)
  assert.match(output, /second answer/)
  assert.doesNotMatch(output, /first answer/)
})

test('/retry keeps the banner and the turn metrics when the replacement succeeds', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  ctx.runTurn = async () => {
    stdout.write('\nsecond answer\n\nTokens ↑ 10 prompt  ↓ 5 completion  = 15 total')
    ctx.state.appendAssistant({ role: 'assistant', content: 'second answer' })
    return true
  }
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  const output = writes.join('')
  assert.equal(output.split('\x1b[2J').length - 1, 1, 'a successful rerun is wiped once, before the stream')
  assert.match(output, /Connected to Provider/)
  assert.match(output, /hello/)
  assert.match(output, /second answer/)
  assert.match(output, /Tokens ↑ 10 prompt/)
  assert.doesNotMatch(output, /first answer/)
})

test('/retry wipes the old answer before the replacement starts', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  let beforeRun = ''
  ctx.runTurn = async () => {
    beforeRun = writes.join('')
    ctx.state.appendAssistant({ role: 'assistant', content: 'second answer' })
  }
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  assert.ok(beforeRun.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.match(beforeRun, /hello/)
  assert.doesNotMatch(beforeRun, /first answer/)

  const output = writes.join('')
  assert.match(output, /second answer/)
})

test('/retry clears stale failed output when the last message is a user message', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  ctx.runTurn = async () => {
    ctx.state.appendAssistant({ role: 'assistant', content: 'new answer' })
  }
  ctx.state.appendUser('hello')

  await chatCommands['/retry'](ctx)

  const output = writes.join('')
  assert.ok(output.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.match(output, /hello/)
  assert.match(output, /new answer/)
})

test('/retry rerun leaves exactly one blank row between the rebuilt transcript and the stream', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  ctx.runTurn = async () => {
    // The rerun behaves exactly like a live turn: its '\n\n' owns the blank
    // row below the rebuilt transcript, then the reasoning label streams on
    // the next row.
    stdout.write('\n\n')
    stdout.write('❯ Thinking\n\n')
    ctx.state.appendAssistant({ role: 'assistant', content: 'second answer', reasoning: 're' })
    return true
  }
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  const output = writes.join('')
  assert.match(output, /hello\n\n❯ Thinking/, 'the streamed marker must sit one blank row under the rebuilt transcript')
  assert.doesNotMatch(output, /hello\n\n\n+❯ Thinking/, 'the rerun must not double-blank on the transcript tail')
})

test('/retry redraws the transcript even when no replacement arrives', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout })
  const { ctx } = harness
  ctx.runTurn = async () => {}
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer' })

  await chatCommands['/retry'](ctx)

  const output = writes.join('')
  assert.ok(output.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.match(output, /hello/)
  assert.doesNotMatch(output, /first answer/)
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

test('/edit replaces the last user message, drops the stale answer, and reruns the turn', async (t) => {
  mockConsole(t)
  const edits = []
  const writes = []
  const harness = makeCtx({
    stdout: { isTTY: true, write: (chunk) => writes.push(String(chunk)) },
    readInput: async (opts) => { edits.push(opts); return { value: 'edited prompt' } },
  })
  const { ctx, savedSessions } = harness
  ctx.state.appendUser('original prompt')
  ctx.state.appendAssistant({ role: 'assistant', content: 'old answer' })

  await chatCommands['/edit'](ctx)

  assert.equal(edits.length, 1)
  assert.equal(edits[0].initialValue, 'original prompt')
  assert.equal(typeof edits[0].onResizeRepaint, 'function', 'the resize hook is forwarded to the editor')
  assert.deepEqual(ctx.state.messages, [
    ctx.state.messages[0],
    { role: 'user', content: 'edited prompt' },
  ])
  assert.equal(harness.turnCount, 1)
  assert.deepEqual(savedSessions, [2])
  assert.ok(writes.join('').includes('\x1b[2J'), 'the transcript is redrawn before and after the rerun')
})

test('/edit rerun leaves exactly one blank row between the rebuilt transcript and the stream', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({
    stdout,
    readInput: async () => ({ value: 'edited prompt' }),
  })
  const { ctx } = harness
  ctx.runTurn = async () => {
    stdout.write('\n\n')
    stdout.write('✓ Waiting for response\n\n')
    ctx.state.appendAssistant({ role: 'assistant', content: 'new answer' })
    return true
  }
  ctx.state.appendUser('original prompt')
  ctx.state.appendAssistant({ role: 'assistant', content: 'old answer' })

  await chatCommands['/edit'](ctx)

  const output = writes.join('')
  assert.match(output, /edited prompt\n\n✓ Waiting for response/, 'the checkpoint must sit one blank row under the rebuilt transcript')
  assert.doesNotMatch(output, /edited prompt\n\n\n+✓ Waiting for response/, 'the rerun must not double-blank on the transcript tail')
})

test('/edit keeps attachments and replaces only the message text part', async (t) => {
  mockConsole(t)
  const edits = []
  const textAtt = { type: 'text', text: '<attached .md content>' }
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const harness = makeCtx({
    stdout: { isTTY: true, write: () => {} },
    readInput: async (opts) => { edits.push(opts); return { value: 'new text' } },
  })
  const { ctx } = harness
  ctx.state.appendUser([{ type: 'text', text: 'old text' }, textAtt, image])
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })

  await chatCommands['/edit'](ctx)

  // The pre-fill shows only the message text, never the attachment payloads.
  assert.equal(edits[0].initialValue, 'old text')
  assert.deepEqual(ctx.state.messages[1], {
    role: 'user',
    content: [{ type: 'text', text: 'new text' }, textAtt, image],
  })
  assert.equal(ctx.state.messages.length, 2)
})

test('/edit cancel leaves the session untouched', async (t) => {
  mockConsole(t)
  let asked = false
  const harness = makeCtx({ readInput: async () => { asked = true; return { cancelled: true } } })
  const { ctx } = harness
  ctx.state.appendUser('original prompt')
  ctx.state.appendAssistant({ role: 'assistant', content: 'old answer' })
  const before = structuredClone(ctx.state.messages)

  await chatCommands['/edit'](ctx)

  assert.equal(asked, true)
  assert.deepEqual(ctx.state.messages, before)
  assert.equal(harness.turnCount, 0)
})

test('/edit rejects an empty replacement', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx({ readInput: async () => ({ value: '   ' }) })
  const { ctx } = harness
  ctx.state.appendUser('original prompt')

  await chatCommands['/edit'](ctx)

  assert.equal(consoleSpy.log(0), 'Edit cancelled: the message cannot be empty.\n')
  assert.deepEqual(ctx.state.messages[1], { role: 'user', content: 'original prompt' })
  assert.equal(harness.turnCount, 0)
})

test('/edit reports nothing to edit in a fresh session', async (t) => {
  const consoleSpy = mockConsole(t)
  let asked = false
  const harness = makeCtx({ readInput: async () => { asked = true; return { value: 'x' } } })
  const { ctx } = harness

  await chatCommands['/edit'](ctx)

  assert.equal(consoleSpy.log(0), 'Nothing to edit yet.\n')
  assert.equal(asked, false)
  assert.equal(harness.turnCount, 0)
})

test('/edit edits the stashed failed turn when the last user turn was popped', async (t) => {
  mockConsole(t)
  const edits = []
  const harness = makeCtx({
    stdout: { isTTY: true, write: () => {} },
    readInput: async (opts) => { edits.push(opts); return { value: 'fixed prompt' } },
  })
  const { ctx } = harness
  ctx.state.appendUser('earlier') 
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })
  ctx.state.retryTurn = 'failed prompt'

  await chatCommands['/edit'](ctx)

  assert.equal(edits[0].initialValue, 'failed prompt')
  assert.equal(ctx.state.retryTurn, null)
  assert.deepEqual(ctx.state.messages.at(-1), { role: 'user', content: 'fixed prompt' })
  assert.equal(harness.turnCount, 1)
})

test('/edit is blocked by the budget guard', async (t) => {
  const consoleSpy = mockConsole(t)
  let asked = false
  const harness = makeCtx({ readInput: async () => { asked = true; return { value: 'x' } } })
  const { ctx } = harness
  ctx.state.setBudget(5)
  ctx.tracker.cost = 6
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })

  await chatCommands['/edit'](ctx)

  assert.equal(asked, false)
  assert.equal(harness.turnCount, 0)
  assert.equal(consoleSpy.log(0), 'Budget exhausted ($6.000000 of $5.000000). /new to start fresh or /quit.\n')
})

test('/delete removes the last complete turn and recomputes the tracker', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx, savedSessions } = harness
  ctx.state.appendUser('first question')
  ctx.state.appendAssistant({ role: 'assistant', content: 'first answer', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })
  ctx.state.appendUser('second question')
  ctx.state.appendAssistant({ role: 'assistant', content: 'second answer', usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 } })
  ctx.tracker.record({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ctx.state.pricing)
  ctx.tracker.record({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, ctx.state.pricing)
  ctx.lastTurnMetrics = { usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, pricing: ctx.state.pricing, contextLength: null, budgetNote: null }

  const outcome = await chatCommands['/delete'](ctx)

  assert.deepEqual(ctx.state.messages, [
    ctx.state.messages[0],
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
  ])
  assert.equal(ctx.state.messages.length, 3)
  assert.deepEqual(savedSessions, [3])
  assert.equal(ctx.tracker.requests, 1)
  assert.equal(ctx.tracker.promptTokens, 100)
  assert.equal(ctx.tracker.completionTokens, 50)
  assert.equal(ctx.tracker.totalTokens, 150)
  assert.ok(Math.abs(ctx.tracker.cost - 0.0002) < 1e-9, 'the deleted turn cost is no longer counted')
  assert.equal(ctx.lastTurnMetrics, null)
  assert.deepEqual(outcome, { resetBudgetWarning: true })
})

test('/delete removes a trailing user message with no response', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx, savedSessions } = harness
  ctx.state.appendUser('hello')

  const outcome = await chatCommands['/delete'](ctx)

  assert.equal(ctx.state.messages.length, 1)
  assert.equal(ctx.state.messages[0].role, 'system')
  assert.deepEqual(savedSessions, [1])
  assert.deepEqual(outcome, { resetBudgetWarning: true })
})

test('/delete drops the stashed failed turn and leaves messages, save, tracker and footer untouched', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx, savedSessions } = harness
  ctx.state.appendUser('earlier')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  ctx.tracker.record({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ctx.state.pricing)
  const footer = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, pricing: ctx.state.pricing, contextLength: null, budgetNote: null }
  ctx.lastTurnMetrics = footer
  ctx.state.retryTurn = 'failed prompt'

  const beforeMessages = structuredClone(ctx.state.messages)
  const beforeRequests = ctx.tracker.requests
  const beforeCost = ctx.tracker.cost
  const outcome = await chatCommands['/delete'](ctx)

  assert.equal(ctx.state.retryTurn, null)
  assert.deepEqual(ctx.state.messages, beforeMessages)
  assert.deepEqual(savedSessions, [])
  assert.equal(ctx.tracker.requests, beforeRequests)
  assert.equal(ctx.tracker.cost, beforeCost)
  assert.equal(ctx.lastTurnMetrics, footer)
  assert.equal(outcome, undefined)
})

test('/delete reports nothing to delete on a fresh session', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx, savedSessions } = harness

  const outcome = await chatCommands['/delete'](ctx)

  assert.equal(consoleSpy.log(0), 'Nothing to delete yet.\n')
  assert.equal(outcome, undefined)
  assert.deepEqual(savedSessions, [], 'the no-op must not persist')
})

test('/delete reports nothing to delete on a TTY without wiping', async (t) => {
  const consoleSpy = mockConsole(t)
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout }); const { ctx } = harness

  await chatCommands['/delete'](ctx)

  assert.equal(consoleSpy.log(0), 'Nothing to delete yet.\n')
  assert.equal(writes.length, 0, 'the no-op must not wipe the screen')
})

test('/delete deletes even when the budget is exhausted (no generation, no guard)', async (t) => {
  mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.setBudget(5)
  ctx.tracker.cost = 6
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })

  const outcome = await chatCommands['/delete'](ctx)

  assert.equal(ctx.state.messages.length, 1)
  assert.equal(ctx.state.messages[0].role, 'system')
  assert.deepEqual(outcome, { resetBudgetWarning: true }, 'deleting reduces cost, so the budget warning latch resets')
})

test('/delete reports nothing to delete on assistant-only history', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.appendAssistant({ role: 'assistant', content: 'open the story' })

  await chatCommands['/delete'](ctx)

  assert.equal(consoleSpy.log(0), 'Nothing to delete yet.\n')
})

test('/delete on a TTY wipes and rebuilds with the footer when dropping the stash', async (t) => {
  mockConsole(t)
  const writes = []
  const resizeOpts = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout }); const { ctx } = harness
  ctx.onResizeRepaint = (opts = {}) => {
    resizeOpts.push(opts)
    stdout.write(`${connectedBanner(buildStatusLine(ctx.state))}\n`)
    renderHistory(ctx.state.messages, { markdown: ctx.state.markdown, stdout, compactThinking: ctx.state.compactThinking, tailBlank: opts.tailBlank ?? (opts.turnFooter !== false) })
    if (opts.turnFooter !== false) stdout.write('TOKENS/COST FOOTER\n')
  }
  ctx.state.appendUser('earlier')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })
  ctx.lastTurnMetrics = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, pricing: ctx.state.pricing, contextLength: null, budgetNote: null }
  ctx.state.retryTurn = 'failed prompt'

  await chatCommands['/delete'](ctx)

  const output = writes.join('')
  assert.ok(output.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.equal(resizeOpts.length, 1)
  assert.deepEqual(resizeOpts[0], { turnFooter: true, loopSep: false, tailBlank: true })
  assert.match(output, /TOKENS\/COST FOOTER/)
})

test('/delete on a TTY wipes and rebuilds without the footer after deleting the last turn', async (t) => {
  mockConsole(t)
  const writes = []
  const resizeOpts = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout }); const { ctx } = harness
  ctx.onResizeRepaint = (opts = {}) => {
    resizeOpts.push(opts)
    stdout.write(`${connectedBanner(buildStatusLine(ctx.state))}\n`)
    renderHistory(ctx.state.messages, { markdown: ctx.state.markdown, stdout, compactThinking: ctx.state.compactThinking, tailBlank: opts.tailBlank ?? (opts.turnFooter !== false) })
    if (opts.turnFooter !== false) stdout.write('TOKENS/COST FOOTER\n')
  }
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })
  ctx.lastTurnMetrics = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, pricing: ctx.state.pricing, contextLength: null, budgetNote: null }

  await chatCommands['/delete'](ctx)

  const output = writes.join('')
  assert.ok(output.includes('\x1b[2J\x1b[3J\x1b[H'))
  assert.equal(resizeOpts.length, 1)
  assert.deepEqual(resizeOpts[0], { turnFooter: false, loopSep: false, tailBlank: true })
  assert.doesNotMatch(output, /TOKENS\/COST FOOTER/)
})

test('/delete on a non-TTY does not wipe', async (t) => {
  mockConsole(t)
  const writes = []
  const stdout = { isTTY: false, write(chunk) { writes.push(String(chunk)); return true } }
  const harness = makeCtx({ stdout }); const { ctx } = harness
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({ role: 'assistant', content: 'answer' })
  ctx.lastTurnMetrics = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, pricing: ctx.state.pricing, contextLength: null, budgetNote: null }

  await chatCommands['/delete'](ctx)

  assert.equal(writes.length, 0)
  assert.equal(ctx.state.messages.length, 1)
})

test('/delete is a chat command, visible, and not an arg command', () => {
  assert.ok(CHAT_COMMANDS.includes('/delete'))
  assert.ok(visibleChatCommands({ visionSupported: true, providerName: 'openrouter' }).includes('/delete'))
  assert.ok(visibleChatCommands({ visionSupported: false, providerName: 'venice' }).includes('/delete'))
  assert.equal(commandAcceptsArgs('/delete'), false)
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

test('/copy copies only the message text from a parts-based response', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx(); const { ctx } = harness
  ctx.state.appendUser('hello')
  ctx.state.appendAssistant({
    role: 'assistant',
    content: [
      { type: 'text', text: 'summary here' },
      { type: 'text', text: 'inline text-file contents' },
    ],
  })
  await chatCommands['/copy'](ctx)
  assert.equal(harness.copied, 'summary here')
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

test('/smooth fast enables streaming, sets the speed and saves the canonical cps', async (t) => {
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
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: true, smoothSpeed: 8000 }])
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
  assert.deepEqual(prefsUpdates, [{ smoothStreaming: true, smoothSpeed: 1500 }])
  assert.equal(consoleSpy.log(0), 'Smooth streaming enabled (1500 chars/s).\n')
})

test('/compact-thinking shows the status with no args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/compact-thinking'](ctx)
  assert.equal(consoleSpy.log(0), 'Compact thinking is off (the full reasoning text streams).\n')
})

test('/compact-thinking on updates state, renderer and saves the pref', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness
  ctx.render.compactThinking = false

  await chatCommands['/compact-thinking']({ ...ctx, args: 'on' })

  assert.equal(ctx.state.compactThinking, true)
  assert.equal(ctx.render.compactThinking, true)
  assert.deepEqual(prefsUpdates, [{ compactThinking: true }])
  assert.equal(consoleSpy.log(0), 'Compact thinking enabled.\n')
})

test('/compact-thinking off reverts to the full reasoning text', async (t) => {
  const consoleSpy = mockConsole(t)
  const harness = makeCtx()
  const { ctx, prefsUpdates } = harness
  ctx.state.setCompactThinking(true)
  ctx.render.compactThinking = true

  await chatCommands['/compact-thinking']({ ...ctx, args: 'off' })

  assert.equal(ctx.state.compactThinking, false)
  assert.equal(ctx.render.compactThinking, false)
  assert.deepEqual(prefsUpdates, [{ compactThinking: false }])
  assert.equal(consoleSpy.log(0), 'Compact thinking disabled.\n')
})

test('/compact-thinking rejects invalid values and leaves state unchanged', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/compact-thinking']({ ...ctx, args: 'maybe' })
  assert.equal(consoleSpy.error(0), 'Error: /compact-thinking expects "on" or "off".\n')
  assert.equal(ctx.state.compactThinking, false)
  assert.equal(ctx.render.compactThinking, undefined)
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

test('/attach ignores prose words with a single hint instead of per-word errors', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const png = await writeFixture(t, 'a.png', 'PNGDATA')

  await chatCommands['/attach']({ ...ctx, args: `${png} is this an AI image, quick test have mercy.` })

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].filename, 'a.png')
  assert.equal(consoleSpy.log(0), 'attached: a.png (image, 7 B)\n')
  assert.equal(consoleSpy.log(1), 'note: "is this an AI image, quick test have mercy." is not a file path — /attach takes file paths only; type your message on the next line.\n')
  assert.equal(consoleSpy.error(0), undefined)
})

test('/attach accepts shell-escaped paths with spaces', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  const png = await writeFixture(t, 'Screenshot 2026-07-23 at 07.47.31.png', 'PNGDATA')

  await chatCommands['/attach']({ ...ctx, args: png.replace(/ /g, '\\ ') })

  assert.equal(ctx.state.pendingAttachments.length, 1)
  assert.equal(ctx.state.pendingAttachments[0].filename, 'Screenshot 2026-07-23 at 07.47.31.png')
  assert.equal(ctx.state.pendingAttachments[0].kind, 'image')
  assert.equal(consoleSpy.error(0), undefined)
  assert.equal(consoleSpy.log(0), 'attached: Screenshot 2026-07-23 at 07.47.31.png (image, 7 B)\n')
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

test('CHAT_COMMANDS keeps the 21-command order', () => {
  assert.deepEqual(CHAT_COMMANDS, [
    '/quit',
    '/status',
    '/new',
    '/model',
    '/attach',
    '/attachments',
    '/reasoning',
    '/temp',
    '/top-p',
    '/budget',
    '/web-search',
    '/web-results',
    '/scrape',
    '/retry',
    '/edit',
    '/delete',
    '/copy',
    '/markdown',
    '/smooth',
    '/compact-thinking',
    '/cost',
  ])
})

test('visibleChatCommands hides /attach and /attachments only when vision is known unsupported', () => {
  const hidden = visibleChatCommands({ visionSupported: false, providerName: 'venice' })
  assert.ok(!hidden.includes('/attach'))
  assert.ok(!hidden.includes('/attachments'))
  assert.deepEqual(hidden, CHAT_COMMANDS.filter((c) => c !== '/attach' && c !== '/attachments'))

  assert.deepEqual(visibleChatCommands({ visionSupported: true, providerName: 'venice' }), CHAT_COMMANDS)
  assert.deepEqual(visibleChatCommands({ visionSupported: undefined, providerName: 'venice' }), CHAT_COMMANDS)
})

test('visibleChatCommands hides /scrape outside Venice', () => {
  const hidden = visibleChatCommands({ visionSupported: true, providerName: 'openrouter' })
  assert.deepEqual(hidden, CHAT_COMMANDS.filter((c) => c !== '/scrape'))
})

test('visibleChatCommands hides attach and web commands under e2ee', () => {
  const hidden = visibleChatCommands({ visionSupported: true, e2ee: true, providerName: 'venice' })
  assert.deepEqual(hidden, CHAT_COMMANDS.filter((c) => !['/attach', '/attachments', '/web-search', '/web-results', '/scrape'].includes(c)))
  for (const cmd of ['/attach', '/attachments', '/web-search', '/web-results', '/scrape']) {
    assert.ok(!hidden.includes(cmd), `${cmd} must be hidden under e2ee`)
  }
})

test('e2ee blocks /attach, /attachments, /web-search and /web-results', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx({
    state: new ChatState({
      modelId: 'e2ee-model',
      endpointProviderName: 'venice',
      reasoningEffort: null,
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      e2ee: true,
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
  })

  await chatCommands['/attach']({ ...ctx, args: 'a.png' })
  await chatCommands['/attachments']({ ...ctx, args: '' })
  await chatCommands['/web-search']({ ...ctx, args: 'auto' })
  await chatCommands['/web-results']({ ...ctx, args: '5' })

  const errors = console.error.mock.calls.map((c) => String(c.arguments[0]))
  assert.equal(errors.filter((e) => e.includes('E2EE does not support file uploads')).length, 2)
  assert.equal(errors.filter((e) => e.includes('E2EE does not support web search')).length, 2)
  assert.equal(ctx.state.pendingAttachments.length, 0)
  assert.equal(ctx.state.webSearch, 'off')
})

function veniceCtx(t, overrides = {}) {
  return makeCtx({
    provider: fakeProvider({
      meta: { name: 'venice' },
      async scrapePage({ url }) {
        return { url, content: `# ${url}\n\nPage body for ${url}`, format: 'markdown' }
      },
    }),
    ...overrides,
  })
}

test('/scrape shows usage without args', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = veniceCtx(t)
  await chatCommands['/scrape']({ ...ctx, args: '' })
  assert.equal(consoleSpy.error(0), 'Usage: /scrape <url>\n')
  assert.equal(ctx.state.messages.length, 1)
})

test('/scrape rejects a non-http(s) URL without calling the provider', async (t) => {
  const consoleSpy = mockConsole(t)
  let called = false
  const { ctx } = veniceCtx(t, {
    provider: fakeProvider({
      meta: { name: 'venice' },
      async scrapePage() {
        called = true
        return { url: '', content: '' }
      },
    }),
  })
  await chatCommands['/scrape']({ ...ctx, args: 'ftp://example.com/file' })
  assert.equal(consoleSpy.error(0), 'Error: /scrape expects a valid http(s) URL.\n')
  assert.equal(called, false)
})

test('/scrape injects the page as a context turn and tracks its flat cost', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = veniceCtx(t)
  ctx.state.messages.push({ role: 'user', content: 'hello' })

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com/article' })

  assert.equal(ctx.state.messages.length, 3)
  assert.equal(ctx.state.messages[2].role, 'user')
  assert.equal(ctx.state.messages[2].content, 'Scraped from https://example.com/article:\n\n# https://example.com/article\n\nPage body for https://example.com/article')
  assert.equal(ctx.state.scrapes, 1)
  assert.equal(ctx.tracker.cost, 0.01)
  assert.equal(ctx.tracker.scrapes, 1)
  assert.match(consoleSpy.log(0), /^Scraped https:\/\/example\.com\/article \(\d+ chars, \$0\.01\) into context — session cost \$0\.010000\.\n$/)
})

test('/scrape truncates oversized pages with a notice', async (t) => {
  const consoleSpy = mockConsole(t)
  const big = 'x'.repeat(300_000)
  const { ctx } = veniceCtx(t, {
    provider: fakeProvider({
      meta: { name: 'venice' },
      async scrapePage() {
        return { url: 'https://example.com/big', content: big, format: 'markdown' }
      },
    }),
  })

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com/big' })

  assert.equal(ctx.state.messages[1].content.length, 'Scraped from https://example.com/big:\n\n'.length + 200_000)
  assert.match(consoleSpy.log(0), /full page truncated/)
})

test('/scrape surfaces provider errors and keeps state unchanged', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = veniceCtx(t, {
    provider: fakeProvider({
      meta: { name: 'venice' },
      async scrapePage() {
        throw new Error('Cannot scrape this page')
      },
    }),
  })

  await chatCommands['/scrape']({ ...ctx, args: 'https://x.com/post' })

  assert.match(consoleSpy.error(0), /Error: Cannot scrape this page/)
  assert.equal(ctx.state.messages.length, 1)
  assert.equal(ctx.state.scrapes, 0)
  assert.equal(ctx.tracker.cost, 0)
})

test('/scrape is refused outside Venice', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com' })
  assert.equal(consoleSpy.error(0), 'Web scraping is only supported on Venice.\n')
  assert.equal(ctx.state.scrapes, 0)
})

test('/scrape is refused under e2ee', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = veniceCtx(t, {
    state: new ChatState({
      modelId: 'org/model',
      endpointProviderName: 'venice',
      reasoningEffort: 'high',
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      e2ee: true,
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
  })

  await chatCommands['/scrape']({ ...ctx, args: 'https://example.com' })

  assert.equal(consoleSpy.error(0), 'E2EE does not support web scraping.\n')
  assert.equal(ctx.state.scrapes, 0)
})

test('/model under e2ee refreshes the attested model key and keeps e2ee state', async (t) => {
  mockConsole(t)
  const e2eeContext = { clientPubKeyHex: '04'.repeat(65), modelPubKeyHex: 'old-key' }
  const { ctx, prefsUpdates } = makeCtx({
    state: new ChatState({
      modelId: 'org/model',
      endpointProviderName: 'Provider',
      reasoningEffort: 'high',
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      e2ee: true,
      e2eeContext,
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
    prefs: { webSearch: { 'new/model': true } },
    selectModelAndEndpoint: async (opts) => {
      assert.equal(opts.e2ee, true)
      return {
        modelId: 'new/model',
        endpointProviderName: 'venice',
        pricing: null,
        reasoningEffort: undefined,
        supportsReasoning: true,
        modelReasoning: null,
        webSearchSupported: true,
        supportsE2EE: true,
      }
    },
  })

  const model = createECDH('secp256k1')
  const modelPubKeyHex = model.generateKeys('hex')
  t.mock.method(globalThis, 'fetch', async (url) => new Response(JSON.stringify({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: modelPubKeyHex,
  })))

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.modelId, 'new/model')
  assert.equal(ctx.state.e2ee, true)
  assert.equal(ctx.state.webSearch, 'off')
  assert.equal(e2eeContext.modelPubKeyHex, modelPubKeyHex)
  assert.deepEqual(prefsUpdates, [{ modelId: 'new/model', lastModel: 'new/model', lastProvider: 'venice', reasoningEffort: undefined }])
})

test('/model under e2ee refuses models without E2EE support and keeps the current model', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    state: new ChatState({
      modelId: 'org/model',
      endpointProviderName: 'Provider',
      reasoningEffort: 'high',
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      e2ee: true,
      e2eeContext: { modelPubKeyHex: 'old-key' },
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
    selectModelAndEndpoint: async () => ({
      modelId: 'plain/model',
      endpointProviderName: 'venice',
      pricing: null,
      reasoningEffort: undefined,
      supportsReasoning: true,
      modelReasoning: null,
      webSearchSupported: true,
      supportsE2EE: false,
    }),
  })

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.modelId, 'org/model')
  assert.equal(consoleSpy.error(0), '\nError: the selected model does not support E2EE; staying on the current model.\n')
})

test('/model under e2ee keeps the current model when attestation fails', async (t) => {
  mockConsole(t)
  const { ctx } = makeCtx({
    state: new ChatState({
      modelId: 'org/model',
      endpointProviderName: 'Provider',
      reasoningEffort: 'high',
      temperature: 0.7,
      budget: null,
      pricing: null,
      supportsReasoning: true,
      webSearch: false,
      webResults: null,
      webSearchSupported: true,
      e2ee: true,
      e2eeContext: { modelPubKeyHex: 'old-key' },
      sessionId: '2026-01-01T00-00-00',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelReasoning: null,
    }),
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'venice',
      pricing: null,
      reasoningEffort: undefined,
      supportsReasoning: true,
      modelReasoning: null,
      webSearchSupported: true,
      supportsE2EE: true,
    }),
  })

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ verified: false })))

  await chatCommands['/model'](ctx)

  assert.equal(ctx.state.modelId, 'org/model')
  assert.ok(console.error.mock.calls.some((c) => String(c.arguments[0]).includes('TEE attestation verification failed')))
})

test('/new prints the status line and drops the web results count', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setWebSearch('auto')
  ctx.state.setWebResults(3)

  await chatCommands['/new'](ctx)

  assert.equal(ctx.state.webResults, null)
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [web: auto]  [smooth: on (normal, ~2000 chars/s)]\n')
})

test('/status prints the full settings snapshot', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()
  ctx.state.setTemperature(1.1)
  ctx.state.setWebSearch('auto')
  ctx.state.setWebResults(3)
  ctx.state.setBudget(5)

  await chatCommands['/status'](ctx)

  assert.equal(
    consoleSpy.log(0),
    'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 1.1]  [top-p: default]  [web: auto: 3]  [budget: $5.000000]  [smooth: on (normal, ~2000 chars/s)]\n'
  )
})

test('/status always shows the sampling badges with defaults', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({ state: new ChatState({
    modelId: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: null,
    temperature: 0.7,
    budget: null,
    pricing: null,
    supportsReasoning: true,
    webSearch: false,
    webResults: null,
    webSearchSupported: true,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelReasoning: null,
  }) })

  await chatCommands['/status'](ctx)

  assert.equal(consoleSpy.log(0), 'Current settings: Provider / org/model  [temp: 0.7]  [top-p: default]  [smooth: on (normal, ~2000 chars/s)]\n')
})

test('/temp prints the updated status line after setting', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/temp']({ ...ctx, args: '1.3' })

  assert.equal(consoleSpy.log(0), 'Temperature set to 1.3\n')
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 1.3]  [top-p: default]  [smooth: on (normal, ~2000 chars/s)]\n')
})

test('/web-search prints the updated status line after setting', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/web-search']({ ...ctx, args: 'auto' })
  await chatCommands['/web-results']({ ...ctx, args: '5' })

  assert.equal(consoleSpy.log(0), 'Web search set to auto.\n')
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [web: auto]  [smooth: on (normal, ~2000 chars/s)]\n')
  assert.equal(consoleSpy.log(2), 'Web search results set to 5.\n')
  assert.equal(consoleSpy.log(3), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [web: auto: 5]  [smooth: on (normal, ~2000 chars/s)]\n')
})

test('/smooth off prints the updated status line', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/smooth']({ ...ctx, args: 'off' })

  assert.equal(consoleSpy.log(0), 'Smooth streaming disabled.\n')
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [smooth: off]\n')
})

test('/budget prints the updated status line after setting', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx()

  await chatCommands['/budget']({ ...ctx, args: '2' })

  assert.equal(consoleSpy.log(0), 'Budget set to $2.000000 for this session.\n')
  assert.equal(consoleSpy.log(1), 'Current settings: Provider / org/model  [in $1.00 / out $2.00/M]  [thinking: High]  [temp: 0.7]  [top-p: default]  [budget: $2.000000]  [smooth: on (normal, ~2000 chars/s)]\n')
})

test('/model prints the updated status line with the new model values', async (t) => {
  const consoleSpy = mockConsole(t)
  const { ctx } = makeCtx({
    prefs: { temperature: { 'new/model': 0.3 }, webSearch: { 'new/model': true } },
    selectModelAndEndpoint: async () => ({
      modelId: 'new/model',
      endpointProviderName: 'NewProvider',
      pricing: null,
      reasoningEffort: 'low',
      supportsReasoning: true,
      modelReasoning: { supported: true, supportsEffort: true },
      webSearchSupported: true,
    }),
  })

  await chatCommands['/model'](ctx)

  assert.equal(consoleSpy.log(0), '\nSwitched to NewProvider / new/model\n')
  assert.equal(consoleSpy.log(1), 'Current settings: NewProvider / new/model  [thinking: Low]  [temp: 0.3]  [top-p: default]  [web: auto]  [smooth: on (normal, ~2000 chars/s)]\n')
})
