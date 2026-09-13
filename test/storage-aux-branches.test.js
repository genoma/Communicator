import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as realFs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// src/constants.js resolves SESSIONS_DIR from the home directory at module
// load, so the throwaway home is registered before the dynamic src imports.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-storage-aux-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })

// renameHook injects failures into src/fs-utils.js renames only: the test's
// own renames go through the real binding imported above.
let renameHook = null
const renameCalls = []
mock.module('node:fs/promises', {
  namedExports: {
    ...realFs,
    rename: async (from, to) => {
      renameCalls.push([from, to])
      const err = renameHook?.(from, to)
      if (err) throw err
      return realFs.rename(from, to)
    },
  },
})

const selection = { modelId: 'org/model', webSearchSupported: true, visionSupported: false, fileSupported: false, isImageModel: false }
mock.module(new URL('../src/model-selection.js', import.meta.url).href, {
  namedExports: {
    selectModelAndEndpoint: async () => ({ ...selection }),
    selectModelNonInteractive: async () => ({ ...selection }),
  },
})

let searchImpl = null
let checkboxImpl = null
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => searchImpl(opts),
    select: async () => { throw new Error('unexpected select') },
    checkbox: async (opts) => checkboxImpl(opts),
  },
})

const { resolveSessionFlags, buildSessionContext } = await import('../src/session-setup.js')
const { selectSession } = await import('../src/session-picker.js')
const { attachmentDirFor, externalizeAttachments, downloadRemotePart, REF_PREFIX } = await import('../src/attachment-store.js')
const { swapFileAtomic, writeFileAtomic } = await import('../src/fs-utils.js')
const { produceParts } = await import('../src/artifacts.js')
const { MAX_PRODUCED_PARTS } = await import('../src/constants.js')
const { CliError } = await import('../src/errors.js')

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-storage-aux-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function tmpLeftovers(dir) {
  return readdir(dir).then((names) => names.some((name) => name.includes('.tmp-')))
}

test('resolveSessionFlags wraps a flag validation error in a CliError', () => {
  assert.equal(resolveSessionFlags({ temperature: 1.5 }, {}).forcedTemperature, 1.5)

  let thrown
  try {
    resolveSessionFlags({ temperature: 99 }, {})
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof CliError)
  assert.equal(thrown.message, 'Error: Temperature must be a number between 0 and 2.')
})

test('buildSessionContext refuses a fresh --rpg run on an image model', async () => {
  const base = { provider: { meta: { name: 'openrouter' } }, apiKey: 'k', prefs: {}, opts: { model: 'org/image', rpg: true } }
  selection.isImageModel = true
  try {
    await assert.rejects(
      buildSessionContext(base),
      /Error: --rpg is for text chat models only; the selected model is an image model\./
    )
  } finally {
    selection.isImageModel = false
  }
  // The same run is legal on a text model: the guard is image-model-only.
  assert.equal((await buildSessionContext(base)).selection.modelId, 'org/model')
})

function sessionItem(overrides = {}) {
  return {
    id: '2026-07-30T19-15-22',
    model: 'openai/gpt-4o',
    providerName: 'OpenAI',
    providerType: 'openrouter',
    createdAt: '2026-07-30T19:15:22.000Z',
    updatedAt: '2026-07-30T19:20:00.000Z',
    messageCount: 12,
    title: 'Write a Python script',
    ...overrides,
  }
}

async function capturedChoices(sessions) {
  let choices = null
  searchImpl = async (opts) => {
    choices = await opts.source('')
    return null
  }
  await selectSession(sessions)
  return choices
}

test('selectSession shows the cost column only for a positive cost', async () => {
  const choices = await capturedChoices([
    sessionItem({ id: 'costed', costSummary: { cost: 0.0123 } }),
    sessionItem({ id: 'zero', costSummary: { cost: 0 } }),
    sessionItem({ id: 'uncosted' }),
  ])

  assert.match(choices[0].name, / {2}· \$0\.012300 {2}"Write a Python script"$/)
  assert.equal(choices[1].name.includes('·'), false)
  assert.equal(choices[2].name.includes('·'), false)
})

test('selectSession truncates a preview past 60 characters', async () => {
  const choices = await capturedChoices([
    sessionItem({ id: 'long', title: 'x'.repeat(70) }),
    sessionItem({ id: 'boundary', title: 'y'.repeat(60) }),
  ])

  assert.ok(choices[0].name.includes(`"${'x'.repeat(60)}..."`))
  assert.equal(choices[0].name.includes('x'.repeat(61)), false)
  assert.ok(choices[1].name.includes(`"${'y'.repeat(60)}"`))
  assert.equal(choices[1].name.includes('...'), false)
})

test('selectSession sanitizes escape bytes in the catalog text', async () => {
  const choices = await capturedChoices([
    sessionItem({
      id: 'escape',
      model: 'openai/\u001b[31mgpt-4o',
      title: 'hello\u001b[2Jworld',
      providerName: 'Eve\u001b]8;;http://evil.example\u0007',
    }),
  ])

  assert.equal(choices[0].name.includes('\u001b'), false)
  assert.equal(choices[0].description.includes('\u001b'), false)
  assert.match(choices[0].name, /openai\/gpt-4o/)
  assert.match(choices[0].name, /helloworld/)
  assert.match(choices[0].description, /12 messages {2}• {2}Eve/)
  assert.equal(choices[0].description.includes('evil.example'), false)
})

function messagesWith(urls) {
  return [{ role: 'user', content: urls.map((url) => ({ type: 'image_url', image_url: { url } })) }]
}

async function externalizeOne(url, dir) {
  const out = await externalizeAttachments(messagesWith([url]), dir)
  return out[0].content[0].image_url.url
}

test('externalizeAttachments reuses a blob already stored by another process', async (t) => {
  const dir = await tempDir(t)
  const blobDir = attachmentDirFor(dir, 'sess')
  const bytes = Buffer.from('shared-bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const url = `data:image/png;base64,${bytes.toString('base64')}`
  await realFs.mkdir(blobDir, { recursive: true })
  await writeFile(join(blobDir, `${hash}.png`), bytes)

  const ref = await externalizeOne(url, blobDir)
  assert.equal(ref, `${REF_PREFIX}${hash}.png`)
  assert.deepEqual(await readdir(blobDir), [`${hash}.png`])
  assert.deepEqual(await readFile(join(blobDir, `${hash}.png`)), bytes)
})

test('externalizeAttachments never overwrites an existing blob file', async (t) => {
  const dir = await tempDir(t)
  const blobDir = attachmentDirFor(dir, 'sess')
  const bytes = Buffer.from('shared-bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const url = `data:image/png;base64,${bytes.toString('base64')}`
  await realFs.mkdir(blobDir, { recursive: true })
  await writeFile(join(blobDir, `${hash}.png`), 'foreign content')

  const ref = await externalizeOne(url, blobDir)
  assert.equal(ref, `${REF_PREFIX}${hash}.png`)
  assert.equal(await readFile(join(blobDir, `${hash}.png`), 'utf-8'), 'foreign content')
})

test('the ref cache evicts the oldest entry past 512 distinct blobs', async (t) => {
  const dir = await tempDir(t)
  const blobDir = attachmentDirFor(dir, 'sess')
  const first = 'data:image/png;base64,' + Buffer.from('eviction-first').toString('base64')
  const firstRef = await externalizeOne(first, blobDir)

  for (let i = 0; i < 512; i++) {
    await externalizeOne('data:image/png;base64,' + Buffer.from(`filler-${i}`).toString('base64'), blobDir)
  }
  assert.equal((await readdir(blobDir)).length, 513)

  // A cached mapping is served without touching the blob, so deleting the file
  // makes the eviction observable: it can only come back through a cache miss.
  const firstFile = firstRef.slice(REF_PREFIX.length)
  await rm(join(blobDir, firstFile))
  assert.equal(await externalizeOne(first, blobDir), firstRef)
  assert.equal((await readdir(blobDir)).includes(firstFile), true)
})

function respondErroringBody(value) {
  const stream = new Readable({ read() { process.nextTick(() => this.destroy(value)) } })
  stream.statusCode = 200
  stream.headers = { 'content-type': 'image/png' }
  return () => ({
    on(event, listener) {
      if (event === 'response') queueMicrotask(() => listener(stream))
      return this
    },
    end() {},
  })
}

test('downloadRemotePart reports a throwing body read and keeps the part inline', async () => {
  const part = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
  const res = await downloadRemotePart(part, null, { requestFn: respondErroringBody(new Error('socket hang up')) })
  assert.equal(res.error, 'socket hang up')
  assert.deepEqual(res.part, part)
  assert.equal(res.dataUrl, undefined)
  assert.equal(res.savedTo, undefined)

  // A rejection without a message still surfaces a readable reason.
  const bare = await downloadRemotePart(part, null, { requestFn: respondErroringBody('plain-string') })
  assert.equal(bare.error, 'could not read response body')
})

test('swapFileAtomic swallows a failed restore and keeps the original error', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'x.json')
  const backup = `${file}.conflict`
  await writeFile(file, 'old')
  renameCalls.length = 0
  renameHook = (from, to) => {
    if (from.includes('.tmp-')) return Object.assign(new Error('injected final rename failure'), { code: 'EIO' })
    if (to === file) return Object.assign(new Error('injected restore failure'), { code: 'EBUSY' })
    return null
  }
  t.after(() => { renameHook = null })
  const stageBackup = async () => {
    await rename(file, backup)
    return backup
  }

  await assert.rejects(swapFileAtomic(file, 'new', { stageBackup }), (err) => {
    assert.equal(err.message, 'injected final rename failure')
    assert.equal(err.code, 'EIO')
    return true
  })
  // The restore was attempted and its own failure was swallowed, and the temp
  // payload was cleaned up.
  assert.ok(renameCalls.some(([from, to]) => from === backup && to === file))
  assert.equal(await readFile(backup, 'utf-8'), 'old')
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.equal(await tmpLeftovers(dir), false)
})

test('writeFileAtomic writes the payload and cleans up a failed write', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'x.json')
  await writeFileAtomic(file, 'payload')
  assert.equal(await readFile(file, 'utf-8'), 'payload')
  assert.equal(await tmpLeftovers(dir), false)

  renameHook = (from) => (from.includes('.tmp-') ? new Error('injected rename failure') : null)
  t.after(() => { renameHook = null })
  await assert.rejects(writeFileAtomic(file, 'next'), /injected rename failure/)
  assert.equal(await readFile(file, 'utf-8'), 'payload')
  assert.equal(await tmpLeftovers(dir), false)
})

test('produceParts caps structured streamed parts at MAX_PRODUCED_PARTS', async () => {
  const requestFn = () => { throw new Error('data URLs must not be fetched') }
  const streamed = Array.from({ length: MAX_PRODUCED_PARTS + 4 }, (_, i) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,AAAA${i}` },
  }))

  const { parts, results } = await produceParts(streamed, { sessionId: null, imageOutputSupported: false, fullText: '', requestFn })
  assert.equal(parts.length, MAX_PRODUCED_PARTS)
  assert.equal(results.length, MAX_PRODUCED_PARTS)
  assert.deepEqual(parts, streamed.slice(0, MAX_PRODUCED_PARTS))
})
