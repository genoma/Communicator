import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runChatSession } from '../src/chat.js'

function scriptedInput(values) {
  const queue = [...values]
  return async () => {
    if (queue.length === 0) return { cancelled: true }
    const next = queue.shift()
    if (next && typeof next.then === 'function') return next
    return { value: next }
  }
}

function neverResolving() {
  return new Promise(() => {})
}

function fakeProvider(overrides = {}) {
  const calls = []
  const provider = {
    meta: { name: 'openrouter' },
    async chatCompletion(opts) {
      calls.push({ ...opts, messages: opts.messages.slice() })
      return { content: 'Hello!', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
    ...overrides,
  }
  return { provider, calls }
}

function fakeRenderer({ markdown }) {
  const render = () => {}
  render.markdown = markdown
  render.flush = () => {}
  return render
}

function makeDeps(overrides = {}) {
  const saveCalls = []
  const prefsCalls = []
  const exitCodes = []
  let signalHandlers = null
  let cleaned = false

  const deps = {
    readInput: scriptedInput([]),
    renderer: fakeRenderer,
    stdout: { write() {} },
    exit: (code) => exitCodes.push(code),
    saveSession: async (id, payload) => saveCalls.push({ id, payload }),
    savePrefs: async (updates) => prefsCalls.push(updates),
    newSessionId: async () => '2026-01-02T00-00-00',
    onSignal: (handlers) => {
      signalHandlers = handlers
      return () => { cleaned = true }
    },
    ...overrides,
  }

  return { deps, saveCalls, prefsCalls, exitCodes, get signalHandlers() { return signalHandlers }, get cleaned() { return cleaned } }
}

function baseCtx(provider, overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'org/model',
    endpointProviderName: 'Provider',
    reasoningEffort: 'high',
    temperature: 1.1,
    pricing: { prompt: 0.000001, completion: 0.000002 },
    provider,
    sessionId: '2026-01-01T00-00-00',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockConsole(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  return {
    logText: (i) => String(console.log.mock.calls[i]?.arguments[0] ?? ''),
    allLogs: () => console.log.mock.calls.map((c) => String(c.arguments[0] ?? '')),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('happy path runs a turn and saves the final session once', async (t) => {
  mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/quit']) })

  const finalState = await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls.length, 1)
  const opts = calls[0]
  assert.equal(opts.apiKey, 'test-key')
  assert.equal(opts.model, 'org/model')
  assert.equal(opts.provider, 'Provider')
  assert.equal(opts.reasoningEffort, 'high')
  assert.equal(opts.temperature, 1.1)
  assert.equal(opts.webSearch, 'off')
  assert.equal(opts.webResults, null)
  assert.equal(opts.supportsReasoning, true)
  assert.equal(opts.sessionId, '2026-01-01T00-00-00')
  assert.deepEqual(opts.messages.map((m) => m.role), ['system', 'user'])
  assert.ok(opts.signal)

  assert.equal(harness.saveCalls.length, 1)
  const { id, payload } = harness.saveCalls[0]
  assert.equal(id, '2026-01-01T00-00-00')
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['budget', 'createdAt', 'messages', 'model', 'pricing', 'providerName', 'providerType', 'reasoningEffort', 'temperature', 'title', 'updatedAt', 'webResults', 'webSearch']
  )
  assert.equal(payload.model, 'org/model')
  assert.equal(payload.providerName, 'Provider')
  assert.equal(payload.providerType, 'openrouter')
  assert.equal(payload.reasoningEffort, 'high')
  assert.equal(payload.temperature, 1.1)
  assert.equal(payload.title, 'hello')
  assert.deepEqual(payload.messages.map((m) => m.role), ['system', 'user', 'assistant'])
  assert.equal(payload.messages[2].content, 'Hello!')
  assert.deepEqual(payload.messages[2].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

  assert.equal(finalState.sessionId, '2026-01-01T00-00-00')
  assert.equal(finalState.modelId, 'org/model')
  assert.equal(finalState.providerType, 'openrouter')
  assert.equal(finalState.messages.length, 3)
  assert.deepEqual(harness.exitCodes, [])
})

test('/new mid-session resets messages and the tracker and saves the prior session', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({
    readInput: scriptedInput(['hello', '/new', '/cost', 'second', '/quit']),
    newSessionId: async () => 'fresh-2',
  })

  const finalState = await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(harness.saveCalls.length, 2)
  assert.equal(harness.saveCalls[0].id, '2026-01-01T00-00-00')
  assert.equal(harness.saveCalls[1].id, 'fresh-2')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user'])
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['system', 'user'])
  assert.equal(calls[1].messages[1].content, 'second')

  assert.equal(finalState.sessionId, 'fresh-2')
  assert.deepEqual(finalState.messages.map((m) => m.role), ['system', 'user', 'assistant'])
  assert.equal(finalState.messages[1].content, 'second')

  const costLine = consoleSpy.allLogs().find((l) => l.includes('Current session:'))
  assert.ok(costLine)
  assert.match(costLine, /0 request\(s\)/)
})

test('/quit returns the final state and saves exactly once', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hi', '/quit']) })

  const finalState = await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(harness.saveCalls.length, 1)
  assert.equal(harness.cleaned, true)
  assert.deepEqual(harness.exitCodes, [])
  assert.equal(finalState.messages.length, 3)
})

test('exitSaveDone guards against a double save on repeated idle SIGINT', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hi', neverResolving()]) })

  runChatSession(baseCtx(provider), harness.deps)
  await tick()
  harness.signalHandlers.sigint()
  harness.signalHandlers.sigint()
  await tick()
  await tick()

  assert.equal(harness.saveCalls.length, 1)
  assert.deepEqual(harness.exitCodes, [130, 130])
})

test('idle SIGINT saves then exits 130', async (t) => {
  mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hi', neverResolving()]) })

  runChatSession(baseCtx(provider), harness.deps)
  await tick()
  harness.signalHandlers.sigint()
  await tick()
  await tick()

  assert.equal(harness.saveCalls.length, 1)
  assert.deepEqual(harness.exitCodes, [130])
})

test('SIGINT during streaming aborts the request, saves partial content and exits 130', async (t) => {
  mockConsole(t)
  let captured
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const { provider } = fakeProvider({
    async chatCompletion(opts) {
      captured = opts
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"content":"Hel' }))
      })
      return pending
    },
  })
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/quit']) })

  const session = runChatSession(baseCtx(provider), harness.deps)
  await tick()
  harness.signalHandlers.sigint()
  assert.equal(captured.signal.aborted, true)

  const finalState = await session

  assert.ok(harness.exitCodes.includes(130))
  assert.ok(harness.saveCalls.length >= 1)
  const interruptSave = harness.saveCalls.find((s) => s.id === '2026-01-01T00-00-00')
  assert.ok(interruptSave)
  const assistant = interruptSave.payload.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.content, 'Hel')
  assert.equal(finalState.messages[finalState.messages.length - 1].role, 'assistant')
})

test('SIGINT during streaming preserves streamed reasoning in the partial message', async (t) => {
  mockConsole(t)
  let rejectCompletion
  const pending = new Promise((resolve, reject) => { rejectCompletion = reject })
  const { provider } = fakeProvider({
    async chatCompletion(opts) {
      opts.signal.addEventListener('abort', () => {
        rejectCompletion(Object.assign(new Error('aborted'), { pendingBuffer: 'data: {"choices":[{"delta":{"reasoning_content":"think' }))
      })
      return pending
    },
  })
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/quit']) })

  const session = runChatSession(baseCtx(provider), harness.deps)
  await tick()
  harness.signalHandlers.sigint()
  await session

  const interruptSave = harness.saveCalls.find((s) => s.id === '2026-01-01T00-00-00')
  const assistant = interruptSave.payload.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.reasoning, 'think')
})

test('budget-exhausted guard blocks a user message without calling the provider', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hello', 'second', '/quit']) })

  await runChatSession(baseCtx(provider, { budget: 0.00001 }), harness.deps)

  assert.equal(calls.length, 1)
  const guardLine = consoleSpy.allLogs().find((l) => l.includes('Budget exhausted'))
  assert.match(guardLine, /Budget exhausted \(\$0\.000020 of \$0\.000010\)\. \/new to start fresh or \/quit\./)
})

test('unknown command is rejected with the exact message and the provider is not called', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/nope', '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls.length, 0)
  const unknownLine = consoleSpy.allLogs().find((l) => l.startsWith('Unknown command'))
  assert.equal(
    unknownLine,
    'Unknown command "/nope". Available: /quit, /new, /model, /attach, /attachments, /reasoning, /temp, /budget, /web-search, /web-results, /retry, /copy, /markdown, /smooth, /cost\n'
  )
})

test('unknown command list omits /attach and /attachments when the model lacks vision', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/nope', '/quit']) })

  await runChatSession(baseCtx(provider, { visionSupported: false }), harness.deps)

  assert.equal(calls.length, 0)
  const unknownLine = consoleSpy.allLogs().find((l) => l.startsWith('Unknown command'))
  assert.equal(
    unknownLine,
    'Unknown command "/nope". Available: /quit, /new, /model, /reasoning, /temp, /budget, /web-search, /web-results, /retry, /copy, /markdown, /smooth, /cost\n'
  )
})

test('autocomplete commands omit /attach and /attachments when the model lacks vision', async (t) => {
  mockConsole(t)
  const commandsSeen = []
  const inner = scriptedInput(['/quit'])
  const capturing = async (opts) => {
    commandsSeen.push(opts?.commands)
    return inner()
  }
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: capturing })

  await runChatSession(baseCtx(provider, { visionSupported: false }), harness.deps)

  assert.ok(commandsSeen.length > 0)
  for (const commands of commandsSeen) {
    assert.ok(!commands.includes('/attach'))
    assert.ok(!commands.includes('/attachments'))
  }
})

test('banner shows no badges for default temperature without reasoning or web search', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(baseCtx(provider, { reasoningEffort: null, temperature: 0.7, webSearch: false }), harness.deps)

  assert.equal(consoleSpy.logText(0), '\nConnected to Provider / org/model')
})

test('banner shows reasoning and web badges when active', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(
    baseCtx(provider, { reasoningEffort: 'high', temperature: 1.1, webSearch: 'auto', webResults: 3 }),
    harness.deps
  )

  assert.equal(consoleSpy.logText(0), '\nConnected to Provider / org/model  [thinking: High]  [temp: 1.1]  [web: auto: 3]')
})

test('banner shows a bare web badge when results are not set', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(
    baseCtx(provider, { reasoningEffort: null, temperature: 0.7, webSearch: 'auto', webResults: null }),
    harness.deps
  )

  assert.equal(consoleSpy.logText(0), '\nConnected to Provider / org/model  [web: auto]')
})

test('banner shows the always badge', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(
    baseCtx(provider, { reasoningEffort: null, temperature: 0.7, webSearch: 'always', webResults: null }),
    harness.deps
  )

  assert.equal(consoleSpy.logText(0), '\nConnected to Provider / org/model  [web: always]')
})

test('banner shows the always badge with a result count', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(
    baseCtx(provider, { reasoningEffort: null, temperature: 0.7, webSearch: 'always', webResults: 5 }),
    harness.deps
  )

  assert.equal(consoleSpy.logText(0), '\nConnected to Provider / org/model  [web: always: 5]')
})

test('startup hint includes /attach when vision capability is unknown', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  const hint = consoleSpy.allLogs().find((l) => l.startsWith('Send with Enter'))
  assert.equal(hint, 'Send with Enter  |  /attach <path> to queue files  |  /quit to exit\n')
})

test('startup hint omits /attach when the model lacks vision', async (t) => {
  const consoleSpy = mockConsole(t)
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/quit']) })

  await runChatSession(baseCtx(provider, { visionSupported: false }), harness.deps)

  const hint = consoleSpy.allLogs().find((l) => l.startsWith('Send with Enter'))
  assert.equal(hint, 'Send with Enter  |  /quit to exit\n')
})

test('retry pops the assistant message and resends the same user message', async (t) => {
  mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/retry', '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user'])
  assert.equal(calls[0].messages[1].content, 'hello')
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['system', 'user'])
  assert.equal(calls[1].messages[1].content, 'hello')
})

test('resume path renders history, seeds the tracker and shows the previous session summary', async (t) => {
  const consoleSpy = mockConsole(t)
  const stdoutWrites = []
  const stdout = { write(chunk) { stdoutWrites.push(String(chunk)); return true } }
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['next question', '/quit']), stdout })

  const initialMessages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]

  await runChatSession(
    baseCtx(provider, { initialMessages, createdAt: '2026-01-01T00:00:00.000Z' }),
    harness.deps
  )

  const summaryLine = consoleSpy.allLogs().find((l) => l.includes('Previous session:'))
  assert.ok(summaryLine)
  assert.match(summaryLine, /1 request\(s\)/)

  assert.ok(stdoutWrites.some((w) => w.includes('old question')))
  assert.ok(stdoutWrites.some((w) => w.includes('old answer')))

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(calls[0].messages[3].content, 'next question')
})

test('a retryable error pops the last user message', async (t) => {
  mockConsole(t)
  const { ApiError } = await import('../src/errors.js')
  const callRoles = []
  const { provider } = fakeProvider()
  let fail = true
  provider.chatCompletion = async (opts) => {
    callRoles.push(opts.messages.map((m) => m.role))
    if (fail) {
      fail = false
      throw new ApiError('Rate limited', { status: 429, retryable: true })
    }
    return { content: 'recovered', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }
  }
  const harness = makeDeps({ readInput: scriptedInput(['hello', 'again', '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(callRoles.length, 2)
  assert.deepEqual(callRoles[0], ['system', 'user'])
  assert.deepEqual(callRoles[1], ['system', 'user'])
})

test('onSources populates render.sources and the next turn resets it', async (t) => {
  mockConsole(t)
  let liveRender
  const renderer = (opts) => {
    liveRender = fakeRenderer(opts)
    return liveRender
  }
  let firstTurn = true
  const { provider } = fakeProvider()
  provider.chatCompletion = async (opts) => {
    assert.ok(opts.onSources)
    if (firstTurn) {
      firstTurn = false
      opts.onSources([{ title: 'One', url: 'https://one.example' }])
      assert.equal(liveRender.sources.length, 1)
    } else {
      assert.equal(liveRender.sources.length, 0)
    }
    return { content: 'ok' }
  }
  const harness = makeDeps({ readInput: scriptedInput(['one', 'two', '/quit']), renderer })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(firstTurn, false)
})

test('renderer receives smooth only for TTY sessions with smoothStreaming on', async (t) => {
  mockConsole(t)
  const optsSeen = []
  const renderer = (opts) => {
    optsSeen.push(opts)
    return fakeRenderer(opts)
  }
  const { provider } = fakeProvider()
  const ttyStdout = { write() {}, isTTY: true }

  await runChatSession(
    baseCtx(provider),
    makeDeps({ readInput: scriptedInput(['/quit']), renderer }).deps
  )
  await runChatSession(
    baseCtx(provider),
    makeDeps({ readInput: scriptedInput(['/quit']), renderer, stdout: ttyStdout }).deps
  )
  await runChatSession(
    baseCtx(provider, { smoothStreaming: false }),
    makeDeps({ readInput: scriptedInput(['/quit']), renderer, stdout: ttyStdout }).deps
  )

  assert.deepEqual(optsSeen.map((o) => o.smooth), [false, true, false])
  assert.deepEqual(optsSeen.map((o) => o.smoothCharsPerTick), [40, 40, 40])
})

test('renderer receives smoothCharsPerTick derived from the smooth speed', async (t) => {
  mockConsole(t)
  const optsSeen = []
  const renderer = (opts) => {
    optsSeen.push(opts)
    return fakeRenderer(opts)
  }
  const { provider } = fakeProvider()
  const ttyStdout = { write() {}, isTTY: true }

  await runChatSession(
    baseCtx(provider, { smoothSpeed: 'fast' }),
    makeDeps({ readInput: scriptedInput(['/quit']), renderer, stdout: ttyStdout }).deps
  )
  await runChatSession(
    baseCtx(provider, { smoothSpeed: 500 }),
    makeDeps({ readInput: scriptedInput(['/quit']), renderer, stdout: ttyStdout }).deps
  )

  assert.deepEqual(optsSeen.map((o) => o.smoothCharsPerTick), [160, 10])
})

test('loader shows frames during a delayed response and clears on the first token', async (t) => {
  mockConsole(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = []
  const stdout = { isTTY: true, write(chunk) { writes.push(String(chunk)); return true } }
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { provider } = fakeProvider()
  provider.chatCompletion = async (opts) => {
    await gate
    opts.onToken('Hi', 'content')
    opts.onToken(' there', 'content')
    return { content: 'Hi there' }
  }
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/quit']), stdout })
  const session = runChatSession(baseCtx(provider), harness.deps)
  const step = () => new Promise((resolve) => setImmediate(resolve))

  await step()
  await step()
  t.mock.timers.tick(199)
  assert.ok(!writes.some((w) => w.includes('Waiting for response')))
  t.mock.timers.tick(1)
  assert.ok(writes.some((w) => w.includes('Waiting for response')))
  t.mock.timers.tick(150)
  assert.ok(writes.some((w) => w.includes('Waiting for response ⠙')))

  release()
  await session
  assert.ok(writes.some((w) => w.includes('✓ Waiting for response')))
  assert.ok(!writes.some((w) => w === '\r\x1b[K'))
})

test('/smooth shows status and /smooth off saves the pref and updates the renderer', async (t) => {
  const consoleSpy = mockConsole(t)
  let liveRender
  const renderer = (opts) => {
    liveRender = fakeRenderer(opts)
    return liveRender
  }
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/smooth', '/smooth off', '/quit']), renderer })

  await runChatSession(baseCtx(provider), harness.deps)

  const statusLine = consoleSpy.allLogs().find((l) => l.startsWith('Smooth streaming is'))
  assert.equal(statusLine, 'Smooth streaming is on (normal, ~2000 chars/s).\n')
  const disableLine = consoleSpy.allLogs().find((l) => l === 'Smooth streaming disabled.\n')
  assert.ok(disableLine)
  assert.ok(harness.prefsCalls.some((p) => p.smoothStreaming === false))
  assert.equal(liveRender.smooth, false)
})

test('/smooth with a speed enables streaming, sets the speed and saves the raw pref', async (t) => {
  const consoleSpy = mockConsole(t)
  let liveRender
  const renderer = (opts) => {
    liveRender = fakeRenderer(opts)
    return liveRender
  }
  const { provider } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['/smooth fast', '/quit']), renderer })

  await runChatSession(baseCtx(provider), harness.deps)

  const enableLine = consoleSpy.allLogs().find((l) => l.startsWith('Smooth streaming enabled'))
  assert.equal(enableLine, 'Smooth streaming enabled (fast, ~8000 chars/s).\n')
  assert.ok(harness.prefsCalls.some((p) => p.smoothStreaming === true && p.smoothSpeed === 'fast'))
  assert.equal(liveRender.smooth, true)
  assert.equal(liveRender.smoothCharsPerTick, 160)
})

test('attachments queued via /attach are flushed as parts with the next message', async (t) => {
  mockConsole(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  const file = join(dir, 'shot.png')
  await writeFile(file, 'PNGDATA')
  t.after(() => rm(dir, { recursive: true, force: true }))

  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput([`/attach ${file}`, 'look at this', '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls.length, 1)
  const content = calls[0].messages[1].content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[0], { type: 'text', text: 'look at this' })
  assert.equal(content[1].type, 'image_url')
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user'])
})

test('multi-line input uses the first line as the command and sends the rest as a message', async (t) => {
  mockConsole(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  const file = join(dir, 'shot.png')
  await writeFile(file, 'PNGDATA')
  t.after(() => rm(dir, { recursive: true, force: true }))

  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput([`/attach ${file}\nIs this an AI image, quick test`, '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls.length, 1)
  const content = calls[0].messages[1].content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[0], { type: 'text', text: 'Is this an AI image, quick test' })
  assert.equal(content[1].type, 'image_url')
  assert.deepEqual(calls[0].messages.map((m) => m.role), ['system', 'user'])
})

test('messages without attachments keep the plain string shape', async (t) => {
  mockConsole(t)
  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput(['hello', '/quit']) })

  await runChatSession(baseCtx(provider), harness.deps)

  assert.equal(calls[0].messages[1].content, 'hello')
})

test('typed /attach still works on a non-vision model while hidden from the UI', async (t) => {
  mockConsole(t)
  const dir = await mkdtemp(join(tmpdir(), 'communicator-test-'))
  const file = join(dir, 'notes.txt')
  await writeFile(file, 'hello')
  t.after(() => rm(dir, { recursive: true, force: true }))

  const { provider, calls } = fakeProvider()
  const harness = makeDeps({ readInput: scriptedInput([`/attach ${file}`, 'read it', '/quit']) })

  await runChatSession(baseCtx(provider, { visionSupported: false }), harness.deps)

  assert.equal(calls.length, 1)
  const content = calls[0].messages[1].content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content[0], { type: 'text', text: 'read it' })
  assert.deepEqual(content[1], { type: 'text', text: 'hello' })
})
