import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../src/errors.js'
import { loadRpgContext, loadRpgHistory } from '../src/rpg.js'
import { exportSession, formatMarkdown } from '../src/export.js'
import { UsageTracker, computeTurnCost } from '../src/tracker.js'
import { green } from '../src/ui/style.js'

class FakeChild {
  constructor() {
    this.listeners = {}
    this.stdin = {
      listeners: {},
      write: () => {},
      end: () => {},
      on: (event, fn) => {
        this.stdin.listeners[event] = fn
        return this.stdin
      },
      emit: (event, ...args) => {
        this.stdin.listeners[event]?.(...args)
      },
    }
    this.killed = false
  }

  on(event, fn) {
    this.listeners[event] = fn
    return this
  }

  emit(event, ...args) {
    this.listeners[event]?.(...args)
  }

  succeed() {
    this.emit('close', 0)
  }

  kill() {
    this.killed = true
  }
}

let spawnImpl = null
mock.module('node:child_process', {
  namedExports: {
    spawn: (cmd, args, opts) => spawnImpl(cmd, args, opts),
  },
})

const { copyText } = await import('../src/clipboard.js')

// hooks(index) returns per-child stdin overrides (write/end) for the tool
// spawned at that position.
function captureSpawn(hooks = () => ({})) {
  const calls = []
  spawnImpl = (cmd, args, opts) => {
    const child = new FakeChild()
    Object.assign(child.stdin, hooks(calls.length))
    calls.push({ cmd, args, opts, child })
    return child
  }
  return calls
}

test('copyText falls through to the next tool when stdin.write throws', async () => {
  const calls = captureSpawn((index) => (index === 0 ? { write: () => { throw new Error('EPIPE') } } : {}))

  const promise = copyText('hello', { platform: 'linux' })
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((call) => call.cmd), ['wl-copy', 'xclip'])
  assert.deepEqual(calls[1].args, ['-selection', 'clipboard'])
})

test('copyText falls through to the next tool when stdin.end throws', async () => {
  const calls = captureSpawn((index) => (index === 0 ? { end: () => { throw new Error('EPIPE') } } : {}))

  const promise = copyText('hello', { platform: 'linux' })
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((call) => call.cmd), ['wl-copy', 'xclip'])
})

test('copyText ignores a write failure after the child already settled', async () => {
  // A synchronously delivered spawn error inside write is what makes the
  // catch see settled=true; the failing child must not advance past the tool
  // the error already moved on to.
  const calls = captureSpawn((index) => index === 0
    ? {
        write: () => {
          calls[0].child.emit('error', new Error('ENOENT'))
          throw new Error('EPIPE')
        },
      }
    : {})

  const promise = copyText('hello', { platform: 'linux' })
  for (const call of calls) call.child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((call) => call.cmd), ['wl-copy', 'xclip'])
})

async function tempDir(t, prefix = 'communicator-aux-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
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

test('loadRpgContext reports a directory that cannot be created', async (t) => {
  const dir = await tempDir(t)
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'not a directory')

  await assert.rejects(loadRpgContext(join(blocker, 'campaign')), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: could not create RPG directory .*campaign: /)
    return true
  })
})

test('loadRpgContext reports a story file it cannot create', { skip: process.platform === 'win32' }, async (t) => {
  const dir = join(await tempDir(t), 'campaign')
  await mkdir(dir, { mode: 0o500 })
  await chmod(dir, 0o500)

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: could not create .*char\.md: EACCES/)
    return true
  })

  await chmod(dir, 0o700)
  assert.deepEqual(await readdir(dir), [])
})

test('loadRpgContext reports a story file deleted after setup', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await rm(join(dir, 'char.md'))
  await symlink(join(dir, 'deleted-after-setup.md'), join(dir, 'char.md'))

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: char\.md is missing; run --rpg .* again to create it\.$/)
    return true
  })
})

test('loadRpgContext rejects a story file left empty', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'prompt.md'), '   \n')

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: prompt\.md is empty\. Fill it in, then delete the setup comment at the top\.$/)
    return true
  })
})

test('loadRpgContext rejects a placeholder user name', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await writeFile(join(dir, 'user.md'), '# Name\n\n## Description\nNot filled in yet.\n')

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: user\.md still has placeholder "# Name"\. Replace it with the user's name\.$/)
    return true
  })
})

test('loadRpgContext reports an unreadable post-history instruction', async (t) => {
  const dir = await tempDir(t)
  await writeFilled(dir)
  await mkdir(join(dir, 'post-history-instruction.md'))

  await assert.rejects(loadRpgContext(dir), (err) => {
    assert.ok(err instanceof CliError)
    assert.match(err.message, /^Error: could not read .*post-history-instruction\.md: EISDIR/)
    return true
  })
})

test('loadRpgHistory warns and returns null when the history file cannot be read', async (t) => {
  const dir = await tempDir(t)
  await mkdir(join(dir, 'history.json'))
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  assert.equal(await loadRpgHistory(dir), null)
  assert.ok(warnings.some((w) => w.includes('could not read RPG history') && w.includes('history.json')), `warnings: ${JSON.stringify(warnings)}`)
})

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

function dataImage(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

test('exportSession names the third duplicate attachment image-3.png', async (t) => {
  const dir = await tempDir(t, 'communicator-aux-export-')
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'three images' },
          { type: 'image_url', image_url: { url: dataImage('first-png') } },
          { type: 'image_url', image_url: { url: dataImage('second-png') } },
          { type: 'image_url', image_url: { url: dataImage('third-png') } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.deepEqual(await readFile(join(folder, 'attachments', 'image.png')), Buffer.from('first-png'))
  assert.deepEqual(await readFile(join(folder, 'attachments', 'image-2.png')), Buffer.from('second-png'))
  assert.deepEqual(await readFile(join(folder, 'attachments', 'image-3.png')), Buffer.from('third-png'))

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /\[image\.png\]\(attachments\/image\.png\)/)
  assert.match(md, /\[image\.png\]\(attachments\/image-2\.png\)/)
  assert.match(md, /\[image\.png\]\(attachments\/image-3\.png\)/)
})

test('exportSession dedupes extension-less attachment names without splitting a stem', async (t) => {
  const dir = await tempDir(t, 'communicator-aux-export-')
  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'three readmes' },
          { type: 'file', file: { filename: 'README', file_data: dataImage('first-readme') } },
          { type: 'file', file: { filename: 'README', file_data: dataImage('second-readme') } },
          { type: 'file', file: { filename: 'README', file_data: dataImage('third-readme') } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, '2026-07-30T19-11-45')

  assert.deepEqual(await readFile(join(folder, 'attachments', 'README')), Buffer.from('first-readme'))
  assert.deepEqual(await readFile(join(folder, 'attachments', 'README-2')), Buffer.from('second-readme'))
  assert.deepEqual(await readFile(join(folder, 'attachments', 'README-3')), Buffer.from('third-readme'))

  const md = await readFile(join(folder, 'session-2026-07-30T19-11-45.md'), 'utf-8')
  assert.match(md, /\[README\]\(attachments\/README\)/)
  assert.match(md, /\[README\]\(attachments\/README-2\)/)
  assert.match(md, /\[README\]\(attachments\/README-3\)/)
})

test('exports sources whose url cannot be parsed as plain text', () => {
  const md = formatMarkdown(session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'ok',
        sources: [
          { title: 'Broken host', url: 'https://' },
          { title: null, url: 'https://' },
        ],
      },
    ],
  }))

  assert.match(md, /\*\*Sources:\*\*\n- Broken host\n- https:\/\/\n/)
  assert.doesNotMatch(md, /\[Broken host\]/)
})

test('exportSession warns and skips an attachment it cannot write', async (t) => {
  const dir = await tempDir(t, 'communicator-aux-export-')
  const id = '2026-07-30T19-11-45'
  // A directory squats on the first attachment's file name inside the folder
  // the export is about to reuse, so only its write can fail.
  await mkdir(join(dir, `session-${id}`, 'attachments', 'image.png'), { recursive: true })
  const warnings = []
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)))

  const data = session({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'two files' },
          { type: 'image_url', image_url: { url: dataImage('blocked-png') } },
          { type: 'file', file: { filename: 'photo.png', file_data: dataImage('saved-png') } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
  })
  const folder = await exportSession(data, dir, id)

  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('could not write attachment image.png'), `warnings: ${JSON.stringify(warnings)}`)
  assert.deepEqual(await readFile(join(folder, 'attachments', 'photo.png')), Buffer.from('saved-png'))

  const md = await readFile(join(folder, `session-${id}.md`), 'utf-8')
  assert.match(md, /> \*\*Attachment:\*\* `image\.png`/)
  assert.match(md, /> \*\*Attachment:\*\* \[photo\.png\]\(attachments\/photo\.png\)/)
  assert.doesNotMatch(md, /\[image\.png\]/)
})

test('computeTurnCost ignores non-numeric prices', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 500 }

  assert.equal(computeTurnCost(usage, { prompt: 'free', completion: '0.000006' }), 0)
  assert.equal(computeTurnCost(usage, { prompt: '0.0000015', completion: 'n/a' }), 0)
  assert.equal(computeTurnCost(usage, { prompt: '', completion: '0.000006' }), 0)

  const tracker = new UsageTracker()
  tracker.record(usage, { prompt: 'free', completion: 'n/a' })
  assert.equal(tracker.cost, 0)
  assert.equal(tracker.requests, 1)
})

test('printTurn spells out a response cache hit with no cached tokens', (t) => {
  const logs = []
  t.mock.method(console, 'log', (line) => logs.push(String(line)))

  new UsageTracker().printTurn({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cacheHit: true }, { prompt: 0.0000015, completion: 0.000006 })
  assert.equal(logs.find((line) => line.includes('⚡')), green('  Cache  ⚡ response cache hit'))

  logs.length = 0
  new UsageTracker().printTurn(
    { prompt_tokens: 200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 }, cacheHit: true },
    { prompt: 0.0000015, completion: 0.000006 }
  )
  assert.equal(logs.find((line) => line.includes('⚡')), green('  Cache  ⚡ 100 cached tokens (50% of prompt), response cache hit'))
})
