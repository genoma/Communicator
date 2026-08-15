import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'
import { buildRpgSystemPrompt, isPlaceholderName, loadRpgContext, parseRpgName } from '../src/rpg.js'

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-rpg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeFilled(dir) {
  await writeFile(join(dir, 'char.md'), '# Zara\n\n## Personality\nSharp and warm.\n')
  await writeFile(join(dir, 'user.md'), '# Alex\n\n## Description\nThe operator.\n')
  await writeFile(join(dir, 'prompt.md'), '## Tone\nNoir.\n\n## Rules\n- {{user}} decides; {{char}} reacts.\n')
}

test('loadRpgContext creates missing templates in a missing directory', async (t) => {
  const dir = join(await tempDir(t), 'campaign')
  const result = await loadRpgContext(dir)
  assert.equal(result.created, true)
  assert.deepEqual(result.createdFiles, ['char.md', 'user.md', 'prompt.md'])

  const files = await Promise.all([
    readFile(join(dir, 'char.md'), 'utf8'),
    readFile(join(dir, 'user.md'), 'utf8'),
    readFile(join(dir, 'prompt.md'), 'utf8'),
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
  assert.deepEqual(result.createdFiles, ['char.md', 'prompt.md'])
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
  assert.match(result.systemPrompt, /Alex decides; Zara reacts\./)
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
  await Promise.all(['char.md', 'user.md', 'prompt.md'].map(fill))

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
    charName: 'Kael',
    userName: 'Mira',
  })
  assert.match(systemPrompt, /^# Roleplay mode/)
  assert.match(systemPrompt, /You are roleplaying as \*\*Kael\*\*\./)
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
  assert.ok(logs.some((line) => line.includes('created char.md, user.md, prompt.md')))
  assert.match(await readFile(join(dir, 'char.md'), 'utf8'), /RPG_TEMPLATE/)
})
