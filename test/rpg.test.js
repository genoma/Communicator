import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'
import { buildRpgSystemPrompt, isPlaceholderName, loadRpgContext, loadRpgHistory, parseRpgName, saveRpgHistory } from '../src/rpg.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
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
  assert.deepEqual(result.createdFiles, ['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md'])

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
})

test('loadRpgContext only creates the missing files and never overwrites', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'user.md'), '# Alex\n\nKept as-is.\n')
  const result = await loadRpgContext(dir)
  assert.equal(result.created, true)
  assert.deepEqual(result.createdFiles, ['char.md', 'prompt.md', 'scenario.md', 'first-message.md'])
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
  assert.match(result.systemPrompt, /## Character: Zara/)
  assert.match(result.systemPrompt, /## User: Alex/)
  assert.match(result.systemPrompt, /## Tone, world, and rules/)
  assert.match(result.systemPrompt, /## Scenario\n\n## Current scene\nA rainy street at midnight\./)
  assert.equal(result.firstMessage, 'The rain had stopped by the time she arrived.')
  assert.doesNotMatch(result.systemPrompt, /The rain had stopped/)
  assert.match(result.systemPrompt, /Alex decides; Zara reacts\./)
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
  assert.match(systemPrompt, /Every turn\n\n- The latest user message is Mira's input\./)
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

test('saveRpgHistory stores non-system messages and loadRpgHistory returns them', async (t) => {
  const dir = await tempDir(t)
  const messages = [
    { role: 'system', content: 'fixed system prompt' },
    { role: 'assistant', content: 'The gate creaks open.' },
    { role: 'user', content: 'I step through.' },
    { role: 'assistant', content: 'Shadows shift.', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]
  await saveRpgHistory(dir, messages)

  const raw = JSON.parse(await readFile(join(dir, 'history.json'), 'utf-8'))
  assert.ok(raw.updatedAt)
  assert.deepEqual(raw.messages, messages.slice(1))

  const history = await loadRpgHistory(dir)
  assert.deepEqual(history, messages.slice(1))
})

test('saveRpgHistory skips the write when only the system message is present', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'history.json'), 'previous story\n')
  await saveRpgHistory(dir, [{ role: 'system', content: 'prompt' }])
  assert.equal(await readFile(join(dir, 'history.json'), 'utf-8'), 'previous story\n')
})

test('loadRpgHistory returns null when the history file is missing', async (t) => {
  const dir = await tempDir(t)
  assert.equal(await loadRpgHistory(dir), null)
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

test('loadRpgContext returns the saved history alongside the rebuilt prompt', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveRpgHistory(dir, [{ role: 'assistant', content: 'The gate creaks open.' }])

  const result = await loadRpgContext(dir)
  assert.equal(result.created, false)
  assert.deepEqual(result.history, [{ role: 'assistant', content: 'The gate creaks open.' }])
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
  assert.ok(logs.some((line) => line.includes('created char.md, user.md, prompt.md, scenario.md, first-message.md')))
  assert.match(await readFile(join(dir, 'char.md'), 'utf8'), /RPG_TEMPLATE/)
})

test('--rpg with a saved history announces the resumed conversation', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await saveRpgHistory(dir, [
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
  assert.ok(logs.some((line) => line.includes(`Resumed RPG conversation from ${dir}/history.json (2 messages).`)))
  assert.ok(errors.some((line) => line.includes('OPENROUTER_API_KEY environment variable is not set.')))
})
