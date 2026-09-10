import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'
import { buildRpgSystemPrompt, expandRpgVariables, isPlaceholderName, loadRpgContext, loadRpgHistory, logRpgPrompt, parseRpgName, ensureRpgSessionsDir, importLegacyRpgHistory } from '../src/rpg.js'
import { saveSession } from '../src/sessions.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// Writes the legacy dir-local log the way pre-M5 versions did, as a fixture.
async function saveLegacyHistory(dir, messages, updatedAt = new Date().toISOString()) {
  await writeFile(join(dir, 'history.json'), JSON.stringify({ updatedAt, messages: messages.filter((m) => m.role !== 'system') }, null, 2) + '\n')
}

async function writeFilled(dir) {

  await writeFile(join(dir, 'char.md'), '# Zara\n\n## Personality\nSharp and warm.\n')
  await writeFile(join(dir, 'user.md'), '# Alex\n\n## Description\nThe operator.\n')
  await writeFile(join(dir, 'prompt.md'), '## Tone\nNoir.\n\n## Rules\n- {{user}} decides; {{char}} reacts.\n')
  await writeFile(join(dir, 'scenario.md'), '## Current scene\nA rainy street at midnight.\n')
  await writeFile(join(dir, 'first-message.md'), 'The rain had stopped by the time she arrived.\n')
}

test('loadRpgContext creates missing templates in a missing directory', async (t) => {
  const dir = join(await tempDir(t), 'campaign')
  const result = await loadRpgContext(dir)
  assert.equal(result.created, true)
  assert.deepEqual(result.createdFiles, ['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md', 'post-history-instruction.md'])

  const files = await Promise.all([
    readFile(join(dir, 'char.md'), 'utf8'),
    readFile(join(dir, 'user.md'), 'utf8'),
    readFile(join(dir, 'prompt.md'), 'utf8'),
    readFile(join(dir, 'scenario.md'), 'utf8'),
    readFile(join(dir, 'first-message.md'), 'utf8'),
  ])
  for (const file of files) {
    assert.match(file, /RPG_TEMPLATE/)
    assert.match(file, /<!--/)
  }
  assert.equal(files[0], files[1])
  assert.match(files[0], /must hold the actual name/)
  assert.equal(await readFile(join(dir, 'post-history-instruction.md'), 'utf8'), '')
})

test('loadRpgContext only creates the missing files and never overwrites', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'user.md'), '# Alex\n\nKept as-is.\n')
  const result = await loadRpgContext(dir)
  assert.equal(result.created, true)
  assert.deepEqual(result.createdFiles, ['char.md', 'prompt.md', 'scenario.md', 'first-message.md', 'post-history-instruction.md'])
  assert.equal(await readFile(join(dir, 'user.md'), 'utf8'), '# Alex\n\nKept as-is.\n')
})

test('loadRpgContext loads filled files into one system prompt', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  const result = await loadRpgContext(dir)
  assert.equal(result.created, false)
  assert.equal(result.charName, 'Zara')
  assert.equal(result.userName, 'Alex')
  assert.match(result.systemPrompt, /You are roleplaying as \*\*Zara\*\*\./)
  assert.match(result.systemPrompt, /The user is roleplaying as \*\*Alex\*\*\./)
  assert.match(result.systemPrompt, /## Character\n\n# Zara\n\n## Personality\nSharp and warm\./)
  assert.match(result.systemPrompt, /## User\n\n# Alex\n\n## Description\nThe operator\./)
  assert.match(result.systemPrompt, /## Tone, world, and rules/)
  assert.match(result.systemPrompt, /## Scenario\n\n## Current scene\nA rainy street at midnight\./)
  assert.equal(result.firstMessage, 'The rain had stopped by the time she arrived.')
  assert.doesNotMatch(result.systemPrompt, /The rain had stopped/)
  assert.match(result.systemPrompt, /Alex decides; Zara reacts\./)
  assert.equal(result.postHistoryInstruction, null)
})

test('loadRpgContext loads the optional post-history instruction file', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'post-history-instruction.md'), '<!-- local note -->\nRemember: {{char}} never reveals the address.\n')
  const result = await loadRpgContext(dir)
  assert.equal(result.postHistoryInstruction, 'Remember: Zara never reveals the address.')
  assert.doesNotMatch(result.systemPrompt, /never reveals the address/)
})

test('loadRpgContext ignores an empty post-history instruction file', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'post-history-instruction.md'), '\n\n')
  const result = await loadRpgContext(dir)
  assert.equal(result.postHistoryInstruction, null)
})

test('loadRpgContext rejects a first-message TODO placeholder', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'first-message.md'), 'RPG_FIRST_MESSAGE_TODO: Write the opening message from Zara here.\n')
  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /first-message\.md still contains the setup placeholder/)
    return true
  })
})

test('loadRpgContext strips Markdown comments before sending them', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'prompt.md'), '## Tone\nNoir.\n<!-- private setup note -->\nStay dark.\n')
  const result = await loadRpgContext(dir)
  assert.doesNotMatch(result.systemPrompt, /private setup note/)
  assert.match(result.systemPrompt, /Stay dark\./)
})

test('loadRpgContext rejects template comments and placeholder names', async (t) => {
  const dir = await tempDir(t)
  await loadRpgContext(dir)

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /char\.md still contains the setup comment/)
    return true
  })

  const fill = (file) => readFile(join(dir, file), 'utf8').then((text) => writeFile(join(dir, file), text.replace(/<!--[\s\S]*?-->/, '')))
  await Promise.all(['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md'].map(fill))

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /char\.md still has placeholder "# Name"/)
    return true
  })
})

test('loadRpgContext requires a real "# <name>" heading in char.md and user.md', async (t) => {
  const dir = await tempDir(t)

  await writeFilled(dir)
  await writeFile(join(dir, 'char.md'), '## Personality\nNo name heading here.\n')
  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /char\.md has no "# <name>" heading/)
    return true
  })

  await writeFilled(dir)
  await writeFile(join(dir, 'user.md'), '## Description\nAlso nameless.\n')
  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /user\.md has no "# <name>" heading/)
    return true
  })
})

test('a heading inside a Markdown comment does not steal the name', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'char.md'), '<!--\n# Name\nold draft notes\n-->\n\n# Zara\n\n## Personality\nSharp.\n')
  const result = await loadRpgContext(dir)
  assert.equal(result.charName, 'Zara')
  assert.match(result.systemPrompt, /You are roleplaying as \*\*Zara\*\*\./)
  assert.doesNotMatch(result.systemPrompt, /old draft notes/)
})

test('buildRpgSystemPrompt keeps identity instructions at both ends', () => {
  const systemPrompt = buildRpgSystemPrompt({
    char: 'Swordmaster.',
    user: 'Traveler.',
    prompt: 'High fantasy.',
    scenario: 'A border tavern at dusk.',
    charName: 'Kael',
    userName: 'Mira',
  })
  assert.match(systemPrompt, /^# Roleplay mode/)
  assert.match(systemPrompt, /You are roleplaying as \*\*Kael\*\*\./)
  assert.match(systemPrompt, /## Scenario\n\nA border tavern at dusk\./)
  assert.match(systemPrompt, /Every turn\n\n- Reply as Kael, in character, under the rules above\./)
  assert.doesNotMatch(systemPrompt, /latest user message/)
})

test('name helpers', () => {
  assert.equal(parseRpgName('# Zara\n\nBody', 'Character'), 'Zara')
  assert.equal(parseRpgName('No heading', 'Fallback'), 'Fallback')
  assert.equal(isPlaceholderName('Name'), true)
  assert.equal(isPlaceholderName('TODO'), true)
  assert.equal(isPlaceholderName('{{char}}'), true)
  assert.equal(isPlaceholderName('{{ user }}'), true)
  assert.equal(isPlaceholderName('Zara'), false)
})

test('expandRpgVariables keeps dollar sequences in names literal', () => {
  assert.equal(expandRpgVariables('Hi {{char}}, meet {{user}}.', { charName: 'R2-$&-D2', userName: '$$Bill' }), 'Hi R2-$&-D2, meet $$Bill.')
})

test('loadRpgHistory returns null when the history file is missing', async (t) => {
  const dir = await tempDir(t)
  assert.equal(await loadRpgHistory(dir), null)
})

test('importLegacyRpgHistory turns a legacy history.json into chapter #1', async (t) => {
  const dir = await tempDir(t)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ], '2026-01-01T00:00:00.000Z')

  const result = await importLegacyRpgHistory({
    rpgDir: dir,
    history: [{ role: 'assistant', content: 'The gate creaks open.' }, { role: 'user', content: 'I step through.' }],
    historyUpdatedAt: '2026-01-01T00:00:00.000Z',
    model: 'test/model',
    providerType: 'openrouter',
    e2ee: true,
    charName: 'Zara',
    userName: 'Alex',
    firstMessage: 'The rain had stopped.',
  })

  assert.ok(result)
  const file = join(dir, 'sessions', `${result.sessionId}.json`)
  const saved = JSON.parse(await readFile(file, 'utf-8'))
  assert.equal(saved.model, 'test/model')
  assert.equal(saved.createdAt, '2026-01-01T00:00:00.000Z')
  // The legacy story has no known endpoint: the name must stay null so the
  // resumed turns are not pinned to a nonexistent provider.
  assert.equal(saved.providerName, null)
  assert.equal(saved.providerType, 'openrouter')
  assert.equal(saved.e2ee, true)
  assert.equal(saved.rpgDir, dir)
  assert.equal(saved.rpgCharName, 'Zara')
  assert.equal(saved.rpgUserName, 'Alex')
  assert.equal(saved.rpgFirstMessage, 'The rain had stopped.')
  assert.deepEqual(saved.messages, [{ role: 'assistant', content: 'The gate creaks open.' }, { role: 'user', content: 'I step through.' }])
})

test('importLegacyRpgHistory only imports once and skips without a model', async (t) => {
  const dir = await tempDir(t)
  await saveLegacyHistory(dir, [{ role: 'user', content: 'I step through.' }, { role: 'assistant', content: 'Shadows shift.' }])

  // No model resolved → nothing to stamp, the legacy fallback stays (and no
  // sessions dir is even created).
  assert.equal(await importLegacyRpgHistory({ rpgDir: dir, history: [{ role: 'user', content: 'I step through.' }, { role: 'assistant', content: 'Shadows shift.' }], providerType: 'openrouter' }), null)
  assert.equal((await readdir(join(dir, 'sessions')).catch(() => [])).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length, 0)

  // A single-message story is not a session and stays on the legacy fallback.
  const tinyDir = await tempDir(t)
  assert.equal(await importLegacyRpgHistory({ rpgDir: tinyDir, history: [{ role: 'user', content: 'I step through.' }], model: 'test/model', providerType: 'openrouter' }), null)

  // First successful import runs once; a second run sees the chapter and
  // does not duplicate.
  const first = await importLegacyRpgHistory({ rpgDir: dir, history: [{ role: 'user', content: 'I step through.' }, { role: 'assistant', content: 'Shadows shift.' }], model: 'test/model', providerType: 'openrouter' })
  assert.ok(first)
  assert.equal(await importLegacyRpgHistory({ rpgDir: dir, history: [{ role: 'user', content: 'I step through.' }, { role: 'assistant', content: 'Shadows shift.' }], model: 'test/model', providerType: 'openrouter' }), null)
  const files = (await readdir(join(dir, 'sessions'))).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  assert.deepEqual(files, [`${first.sessionId}.json`])
})

test('loadRpgHistory returns null for an empty messages array', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), JSON.stringify({ updatedAt: new Date().toISOString(), messages: [] }))
  assert.equal(await loadRpgHistory(dir), null)
})

test('loadRpgHistory warns and starts fresh on a corrupt history file', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), '{not json')
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  assert.equal(await loadRpgHistory(dir), null)
  assert.ok(warnings.some((w) => w.includes('history.json') && w.includes('corrupt')))
})

test('loadRpgHistory drops malformed messages and warns about them', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), JSON.stringify({
    updatedAt: '2026-08-15T10:00:00.000Z',
    messages: [
      { role: 'user', content: 'I step through.' },
      { role: 'assistant', content: null },
      { role: 'assistant' },
      'not an object',
      { role: 'user', content: 'Again.' },
    ],
  }))
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  const history = await loadRpgHistory(dir)
  assert.deepEqual(history, {
    updatedAt: '2026-08-15T10:00:00.000Z',
    messages: [
      { role: 'user', content: 'I step through.' },
      { role: 'user', content: 'Again.' },
    ],
  })
  assert.ok(warnings.some((w) => w.includes('3 malformed message(s)')))
})

test('loadRpgHistory returns null when every message is malformed', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }))
  t.mock.method(console, 'warn', () => {})
  assert.equal(await loadRpgHistory(dir), null)
})

test('loadRpgHistory ignores a garbage updatedAt', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), JSON.stringify({ updatedAt: 'not a date', messages: [{ role: 'user', content: 'Hi.' }] }))
  const history = await loadRpgHistory(dir)
  assert.deepEqual(history.messages, [{ role: 'user', content: 'Hi.' }])
  assert.equal(history.updatedAt, null)
})

test('logRpgPrompt appends one JSON entry per request with a stderr notice', async (t) => {
  const dir = await tempDir(t)
  const notices = []
  t.mock.method(console, 'error', (msg) => notices.push(String(msg)))

  await logRpgPrompt(dir, { timestamp: '2026-08-16T10:00:00.000Z', model: 'org/model', provider: 'openrouter', request: { model: 'org/model', messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'hi' }], stream: true } })
  await logRpgPrompt(dir, { timestamp: '2026-08-16T10:01:00.000Z', model: 'org/model', provider: 'openrouter', request: { model: 'org/model', messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'again' }], stream: true } })

  const raw = await readFile(join(dir, 'prompt-log.jsonl'), 'utf-8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.model, 'org/model')
  assert.equal(first.provider, 'openrouter')
  assert.equal(first.request.messages[1].content, 'hi')
  assert.equal(JSON.parse(lines[1]).request.messages[1].content, 'again')
  assert.equal(notices.length, 2)
  assert.ok(notices[0].includes('prompt logged:') && notices[0].includes('prompt-log.jsonl'))
})

// Windows ignores the POSIX mode on open: stat always reports 0o666, so the
// owner-only permission check only holds on POSIX platforms (see sessions.test.js).
test('logRpgPrompt locks the prompt log to owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t)
  await logRpgPrompt(dir, { timestamp: '2026-08-16T10:00:00.000Z', request: { messages: [{ role: 'user', content: 'hi' }] } })
  assert.equal((await stat(join(dir, 'prompt-log.jsonl'))).mode & 0o777, 0o600)
})

test('logRpgPrompt warns without throwing when the write fails', async (t) => {
  const dir = await tempDir(t)
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  t.mock.method(console, 'error', () => {})

  await logRpgPrompt(join(dir, 'missing'), { request: {} })
  assert.ok(warnings.some((w) => w.includes('could not log prompt') && w.includes('prompt-log.jsonl')))
})

test('loadRpgContext returns the saved history alongside the rebuilt prompt', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'user', content: 'I step through.' },
    { role: 'assistant', content: 'The gate creaks open.' },
  ])

  const result = await loadRpgContext(dir)
  assert.equal(result.created, false)
  assert.deepEqual(result.history, [
    { role: 'user', content: 'I step through.' },
    { role: 'assistant', content: 'The gate creaks open.' },
  ])
  assert.ok(result.historyUpdatedAt)
  assert.doesNotMatch(JSON.stringify(result.history), /system/)
})

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.code = code
  }
}

test('--rpg setup exits 0 without an API key', async (t) => {
  const dir = join(await tempDir(t), 'campaign')
  const logs = []
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))

  const { runCli } = await import('../src/cli-main.js')
  const opts = {
    model: undefined,
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal && err.code === 0)
  assert.equal(exitCode, 0)
  assert.ok(logs.some((line) => line.includes('created char.md, user.md, prompt.md, scenario.md, first-message.md, post-history-instruction.md')))
  assert.ok(logs.some((line) => line.includes('post-history-instruction.md starts empty and is optional')))
  assert.match(await readFile(join(dir, 'char.md'), 'utf8'), /RPG_TEMPLATE/)
  assert.equal(await readFile(join(dir, 'post-history-instruction.md'), 'utf8'), '')
})

test('--rpg --resume with a single chapter announces the chapter session', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ])
  await saveSession(await ensureRpgSessionsDir(dir), '2026-01-01T00-00-00', {
    model: 'test/model',
    providerName: 'openrouter',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are Kael.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'The gate creaks open.' },
    ],
  })

  const logs = []
  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: true,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  // The chapter session wins over the legacy history.json story.
  assert.ok(errors.some((line) => line.includes(`Resumed RPG conversation from ${dir}/sessions/2026-01-01T00-00-00.json (2 messages, saved 2026-01-02)`)), `notice missing; errors: ${JSON.stringify(errors)}`)
  assert.ok(errors.every((line) => !line.includes('history.json')))
  assert.ok(logs.every((line) => !line.includes('Resumed RPG conversation')))
})

test('--rpg --resume migrates a legacy history-only dir and resumes the imported chapter', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ])

  const logs = []
  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: true,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  // The legacy log is imported once as chapter #1, then resumed as a chapter.
  assert.ok(errors.some((line) => line.includes(`Migrated the saved story (2 messages) into ${dir}/sessions/`)), `migration notice missing; errors: ${JSON.stringify(errors)}`)
  assert.ok(errors.some((line) => line.includes(`Resumed RPG conversation from ${dir}/sessions/`) && line.includes('(2 messages, saved ')), `chapter resume notice missing; errors: ${JSON.stringify(errors)}`)
  assert.ok(errors.every((line) => !line.includes('history.json') || line.includes('Migrated the saved story')))
})

test('--rpg --resume with a legacy saved story migrates and resumes it', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ])

  const logs = []
  const errors = []
  const warnings = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: true,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  assert.ok(errors.some((line) => line.includes(`Migrated the saved story (2 messages) into ${dir}/sessions/`)))
  assert.ok(errors.some((line) => line.includes(`Resumed RPG conversation from ${dir}/sessions/`) && line.includes('(2 messages, saved ')))
  assert.ok(warnings.every((line) => !line.includes('starting a new story')))
  assert.ok(errors.some((line) => line.includes('OPENROUTER_API_KEY environment variable is not set.')))
})

test('--rpg without --resume starts fresh and announces the single saved story', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ])

  const logs = []
  const errors = []
  const warnings = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  assert.ok(logs.every((line) => !line.includes('Resumed RPG conversation')))
  assert.ok(errors.every((line) => !line.includes('Resumed RPG conversation')))
  assert.ok(logs.every((line) => !line.includes('Starting a new story')))
  assert.ok(errors.some((line) => line.includes(`Starting a new story in ${dir} (1 earlier session available; use --rpg ${dir} --resume to continue one).`)))
  assert.ok(warnings.every((line) => !line.includes('will be replaced on save')))
  assert.ok(errors.some((line) => line.includes('OPENROUTER_API_KEY environment variable is not set.')))
})

test('--rpg without --resume counts every earlier chapter session', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  const sessionsDir = join(dir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const payload = (id, text) => JSON.stringify({
    model: 'test/model',
    providerName: 'openrouter',
    createdAt: `${id}T00:00:00.000Z`,
    updatedAt: `${id}T00:00:01.000Z`,
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: text },
      { role: 'assistant', content: 'A reply.' },
    ],
  })
  await writeFile(join(sessionsDir, '2026-01-01T00-00-00.json'), payload('2026-01-01', 'first'))
  await writeFile(join(sessionsDir, '2026-01-02T00-00-00.json'), payload('2026-01-02', 'second'))
  // A legacy history.json alongside the chapters must not be double-counted:
  // the chapters win, so the count stays 2, not 3.
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
  ])

  const logs = []
  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  assert.ok(logs.every((line) => !line.includes('Starting a new story')))
  assert.ok(errors.some((line) => line.includes(`Starting a new story in ${dir} (2 earlier sessions available; use --rpg ${dir} --resume to continue one).`)))
})

test('--rpg without --resume counts a legacy history-only dir as one earlier session', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveLegacyHistory(dir, [
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
    { role: 'assistant', content: 'Shadows shift.' },
  ])

  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: undefined,
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  // No -m: the import is skipped and the legacy count branch announces one
  // earlier session; no migration notice appears.
  assert.ok(errors.some((line) => line.includes(`Starting a new story in ${dir} (1 earlier session available; use --rpg ${dir} --resume to continue one).`)), `errors: ${JSON.stringify(errors)}`)
  assert.ok(errors.every((line) => !line.includes('Migrated')))
})

test('--rpg fresh notice goes to stdout when stdout is a TTY', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveSession(await ensureRpgSessionsDir(dir), '2026-01-01T00-00-00', {
    model: 'test/model',
    providerName: 'openrouter',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'You are Kael.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'The gate creaks open.' },
    ],
  })

  const logs = []
  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'log', (msg) => logs.push(String(msg)))
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })
  // A TTY stdout (with piped stdin) must receive the notice on stdout: the
  // answer stream stays clean and the notice is not mixed into it.
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  t.after(() => {
    if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    else delete process.stdout.isTTY
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  assert.ok(logs.some((line) => line.includes(`Starting a new story in ${dir} (1 earlier session available`)), `logs: ${JSON.stringify(logs)}`)
  assert.ok(errors.every((line) => !line.includes('Starting a new story')))
})

test('--rpg without --resume stays silent when nothing was saved yet', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)

  const errors = []
  const previousKey = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => {
    exitCode = code
    throw new ExitSignal(code)
  })

  const { runCli } = await import(`../src/cli-main.js?t=${Date.now()}`)
  const opts = {
    model: 'test/model',
    provider: 'openrouter',
    listModels: undefined,
    listImageModels: undefined,
    listEndpoints: undefined,
    resume: undefined,
    export: undefined,
    outputDir: undefined,
    listSessions: undefined,
    config: undefined,
    systemPrompt: undefined,
    rpg: dir,
    reasoningEffort: undefined,
    temperature: undefined,
    budget: undefined,
    webSearch: undefined,
    webResults: undefined,
    smoothStreaming: true,
    smoothSpeed: undefined,
    zdr: undefined,
    e2ee: undefined,
    image: undefined,
    imageModel: undefined,
    safeMode: true,
    watermark: true,
    delete: undefined,
    deleteAllSessions: undefined,
    attach: [],
  }

  await assert.rejects(runCli(opts, undefined), (err) => err instanceof ExitSignal)
  assert.equal(exitCode, 1)
  assert.ok(errors.every((line) => !line.includes('Starting a new story')))
})
