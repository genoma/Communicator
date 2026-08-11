import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The history file path is derived from the home dir at module load, so the
// os mock must be registered before input.js is imported.
const tempHome = await mkdtemp(join(tmpdir(), 'communicator-vendor-home-'))
mock.module('node:os', { namedExports: { homedir: () => tempHome } })
after(() => rm(tempHome, { recursive: true, force: true }))

const { readInput } = await import('../src/input.js')
const { _resetKittyDetection } = await import('../src/vendor/read-multiline/footer.js')

function fakeStdin() {
  const stdin = new EventEmitter()
  stdin.isTTY = true
  stdin.readableEnded = false
  stdin.destroyed = false
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  return stdin
}

function installFakeStdin(t, stdin) {
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  t.after(() => {
    delete process.stdin
  })
}

async function submitInput(t, stdin, ...chunks) {
  const pending = readInput({ commands: ['/quit', '/smooth', '/status'] })
  for (const chunk of chunks) stdin.emit('data', chunk)
  return pending
}

test('arrow-up recalls the persisted prompt history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)
  const historyDir = join(tempHome, '.communicator')
  await mkdir(historyDir, { recursive: true })
  await writeFile(join(historyDir, 'history.json'), JSON.stringify(['first prompt', 'second prompt']))

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, '\x1b[A', '\r')
  const result = await pending
  assert.deepEqual(result, { value: 'second prompt' })
})

test('Tab cycles the command suggestion list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, '/s', '\t', '\r')
  const result = await pending
  assert.deepEqual(result, { value: '/smooth' })
})

test('arrow-down restores the draft after recall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(process.stdout, 'write', () => true)
  _resetKittyDetection(false)

  const stdin = fakeStdin()
  installFakeStdin(t, stdin)

  const pending = submitInput(t, stdin, 'draft text', '\x1b[A', '\x1b[B', '\r')
  const result = await pending
  assert.deepEqual(result, { value: 'draft text' })
})
