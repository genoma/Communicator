import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, truncate } from 'node:fs/promises'
import { mkdirSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../src/constants.js'

class FakeChild {
  constructor() {
    this.listeners = {}
    this.stdin = {
      write: () => {},
      end: () => {},
      listeners: {},
      on: (event, fn) => {
        this.stdin.listeners[event] = fn
        return this.stdin
      },
      emit: (event, ...args) => {
        this.stdin.listeners[event]?.(...args)
      },
    }
    this.stdout = {
      listeners: {},
      on: (event, fn) => {
        this.stdout.listeners[event] = fn
        return this.stdout
      },
      emit: (event, ...args) => {
        this.stdout.listeners[event]?.(...args)
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

  fail(code = 1) {
    this.emit('close', code)
  }

  spawnError(err) {
    this.emit('error', err)
  }

  kill(signal) {
    this.killed = true
    this.killSignals = [...(this.killSignals ?? []), signal]
  }
}

let spawnImpl = null
mock.module('node:child_process', {
  namedExports: {
    spawn: (cmd, args, opts) => spawnImpl(cmd, args, opts),
  },
})

let openImpl = (path, flags) => realFs.openSync(path, flags)
mock.module('node:fs', {
  namedExports: {
    readdirSync: realFs.readdirSync,
    writeFileSync: realFs.writeFileSync,
    writeSync: realFs.writeSync,
    closeSync: realFs.closeSync,
    openSync: (path, flags) => openImpl(path, flags),
  },
})

const { copyText, readClipboardImage } = await import('../src/clipboard.js')

function captureSpawn() {
  const calls = []
  const written = []
  spawnImpl = (cmd, args, opts) => {
    const child = new FakeChild()
    child.stdin.write = (chunk) => written.push(chunk)
    calls.push({ cmd, args, opts, child })
    return child
  }
  return { calls, written }
}

test('copyText writes the text and resolves ok on exit 0 (darwin pbcopy)', async () => {
  const { calls, written } = captureSpawn()

  const promise = copyText('hello', { platform: 'darwin' })
  calls[0].child.succeed()
  const outcome = await promise

  assert.deepEqual(outcome, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'pbcopy')
  assert.deepEqual(calls[0].args, [])
  assert.equal(written.join(''), 'hello')
  assert.equal(calls[0].opts.stdio[0], 'pipe')
})

test('copyText uses clip on Windows', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'win32' })
  calls[0].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'clip')
})

test('copyText falls through the linux toolchain on ENOENT', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  calls[0].child.spawnError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip'])
  assert.deepEqual(calls[1].args, ['-selection', 'clipboard'])
})

test('copyText falls through on a non-zero exit and reports failure when all tools fail', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  for (let i = 0; i < 3; i++) calls[i].child.fail(1)
  const result = await promise

  assert.deepEqual(result, { ok: false, error: 'No clipboard tool found. Install wl-copy, xclip, or xsel.' })
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip', 'xsel'])
})

test('copyText settles once when a later tool errors after an earlier failure', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  calls[0].child.fail(1)
  calls[1].child.spawnError(new Error('ENOENT'))
  calls[2].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.equal(calls[2].cmd, 'xsel')
})

test('copyText defaults to the current platform', async () => {
  const { calls } = captureSpawn()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const promise = copyText('hello')
    calls[0].child.succeed()
    const result = await promise
    assert.deepEqual(result, { ok: true })
    assert.equal(calls[0].cmd, 'pbcopy')
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

test('copyText falls through to the next tool when stdin errors (EPIPE)', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux' })
  calls[0].child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip'])
})

test('copyText settles once when stdin errors after a successful close', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'darwin' })
  calls[0].child.succeed()
  const result = await promise
  calls[0].child.stdin.emit('error', new Error('EPIPE'))

  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
})

test('copyText falls through to the next tool when the first one hangs (timeout)', async () => {
  const { calls } = captureSpawn()

  const promise = copyText('hello', { platform: 'linux', timeoutMs: 50 })
  // The first tool (wl-copy) is stuck — wait for the timeout
  await new Promise((r) => setTimeout(r, 80))
  // After timeout, it should have killed wl-copy and moved to xclip
  calls[1].child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true })
  assert.equal(calls[0].child.killed, true)
  assert.deepEqual(calls.map((c) => c.cmd), ['wl-copy', 'xclip'])
})

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('clipboard')])
const TIFF_BYTES = Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.from('clipboard')])

function captureReadSpawn() {
  const calls = []
  spawnImpl = (cmd, args, opts) => {
    const child = new FakeChild()
    calls.push({ cmd, args, opts, child })
    return child
  }
  return calls
}

async function waitForCall(calls, index = 0) {
  while (calls.length <= index) await new Promise((r) => setImmediate(r))
  return calls[index]
}

async function readTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-clipboard-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function scriptTarget(args) {
  return /POSIX file "([^"]+)"/.exec(args[1])[1]
}

async function darwinFileUrlAttempt(calls) {
  return waitForCall(calls, 0)
}

async function failDarwinImageFlavours(calls) {
  const pngAttempt = await waitForCall(calls, 1)
  pngAttempt.child.fail(1)
  const tiffAttempt = await waitForCall(calls, 2)
  tiffAttempt.child.fail(1)
}

test('readClipboardImage reads a PNG written by osascript on darwin', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await waitForCall(calls, 0)
  furlAttempt.child.fail(1)
  const call = await waitForCall(calls, 1)
  writeFileSync(scriptTarget(call.args), PNG_BYTES)
  call.child.succeed()
  const result = await promise

  assert.equal(call.cmd, '/usr/bin/osascript')
  assert.equal(call.args[0], '-e')
  assert.ok(call.args[1].includes('«class PNGf»'))
  assert.equal(call.opts.stdio, 'ignore')
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png' })
  assert.deepEqual(readdirSync(root), [])
})

test('readClipboardImage retries the TIFF flavor when the PNG write fails', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'darwin' })
  const furlAttempt = await waitForCall(calls, 0)
  furlAttempt.child.fail(1)
  const pngAttempt = await waitForCall(calls, 1)
  pngAttempt.child.fail(1)
  const tiffAttempt = await waitForCall(calls, 2)
  writeFileSync(scriptTarget(tiffAttempt.args), TIFF_BYTES)
  tiffAttempt.child.succeed()
  const result = await promise

  assert.ok(pngAttempt.args[1].includes('«class PNGf»'))
  assert.ok(tiffAttempt.args[1].includes('«class TIFF»'))
  assert.deepEqual(result, { ok: true, data: TIFF_BYTES, mime: 'image/tiff' })
})

test('readClipboardImage reads the file URL behind a darwin pasteboard', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'Screenshot 2026-09-26 at 11.35.24.png')
  writeFileSync(target, PNG_BYTES)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(`${target}\n`))
  furlAttempt.child.succeed()
  const result = await promise

  assert.ok(furlAttempt.args[1].includes('clipboard info'))
  assert.ok(furlAttempt.args[1].includes('«class furl»'))
  assert.ok(furlAttempt.args[1].includes('error number -1700'))
  assert.deepEqual(furlAttempt.opts.stdio, ['ignore', 'pipe', 'ignore'])
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png', filename: 'Screenshot 2026-09-26 at 11.35.24.png' })
})

test('readClipboardImage prefers the file URL over the image flavours', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'photo.png')
  writeFileSync(target, PNG_BYTES)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await waitForCall(calls, 0)
  furlAttempt.child.stdout.emit('data', Buffer.from(`${target}\n`))
  furlAttempt.child.succeed()
  const result = await promise

  assert.equal(calls.length, 1, 'no flavour attempt runs once the file URL resolved')
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png', filename: 'photo.png' })
})

test('readClipboardImage falls through when the file URL probe prints nothing', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'darwin' })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage falls back to a flavour when the file URL target is too large', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'huge.png')
  writeFileSync(target, PNG_BYTES)
  await truncate(target, MAX_IMAGE_ATTACHMENT_BYTES + 1)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(target))
  furlAttempt.child.succeed()
  const pngAttempt = await waitForCall(calls, 1)
  writeFileSync(scriptTarget(pngAttempt.args), PNG_BYTES)
  pngAttempt.child.succeed()
  const result = await promise

  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png' })
  assert.equal(result.filename, undefined)
})

test('readClipboardImage ignores darwin file URL output when the probe exits non-zero', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'shot.png')
  writeFileSync(target, PNG_BYTES)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(`${target}\n`))
  furlAttempt.child.fail(1)
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage refuses a relative path from the darwin file URL probe', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'darwin' })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from('furl.png\n'))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage ignores a darwin file URL that is not an image', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'notes.txt')
  writeFileSync(target, 'plain text')

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(target))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage ignores a darwin file URL whose file is gone', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(join(root, 'gone.png')))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage ignores a darwin file URL that cannot be read', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  mkdirSync(join(root, 'blocked.png'))

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(join(root, 'blocked.png')))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage reports the too-large error for an oversized darwin file URL', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'huge.png')
  writeFileSync(target, PNG_BYTES)
  await truncate(target, MAX_IMAGE_ATTACHMENT_BYTES + 1)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(target))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'The clipboard image is larger than 20 MB.' })
})

test('readClipboardImage treats darwin file URL output over the stdout cap as a failed attempt', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)
  const target = join(root, 'shot.png')
  writeFileSync(target, PNG_BYTES)

  const promise = readClipboardImage({ platform: 'darwin', tmpdir: root })
  const furlAttempt = await darwinFileUrlAttempt(calls)
  furlAttempt.child.stdout.emit('data', Buffer.from(`${target}\n${' '.repeat(8192)}`))
  furlAttempt.child.succeed()
  await failDarwinImageFlavours(calls)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage pipes wl-paste and xclip stdout into the temp file on linux', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'linux' })
  const wlPaste = await waitForCall(calls, 0)
  wlPaste.child.spawnError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  const xclip = await waitForCall(calls, 1)
  writeSync(xclip.opts.stdio[1], PNG_BYTES)
  xclip.child.succeed()
  const result = await promise

  assert.deepEqual(calls.map((c) => c.cmd), ['wl-paste', 'xclip'])
  assert.deepEqual(wlPaste.args, ['--type', 'image/png'])
  assert.deepEqual(xclip.args, ['-selection', 'clipboard', '-t', 'image/png', '-o'])
  assert.equal(typeof wlPaste.opts.stdio[1], 'number')
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png' })
})

test('readClipboardImage reads through Windows PowerShell with the output path in the environment', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'win32' })
  const call = await waitForCall(calls)
  writeFileSync(call.opts.env.COMMUNICATOR_CLIP_OUT, PNG_BYTES)
  call.child.succeed()
  const result = await promise

  assert.equal(call.cmd, 'powershell.exe')
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-STA', '-Command'])
  assert.ok(call.args[3].includes('Get-Clipboard -Format Image'))
  assert.ok(call.args[3].includes('$env:COMMUNICATOR_CLIP_OUT'))
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png' })
})

test('readClipboardImage reports no image when every tool runs without one', async (t) => {
  const calls = captureReadSpawn()
  const root = await readTempRoot(t)

  const promise = readClipboardImage({ platform: 'linux', tmpdir: root })
  for (let i = 0; i < 2; i++) {
    const call = await waitForCall(calls, i)
    call.child.fail(1)
  }

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
  assert.deepEqual(readdirSync(root), [])
})

test('readClipboardImage names the tools only when they are missing', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'linux' })
  for (let i = 0; i < 2; i++) {
    const call = await waitForCall(calls, i)
    call.child.spawnError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  }

  assert.deepEqual(await promise, { ok: false, error: 'No clipboard image tool found. Install wl-paste (wl-clipboard) or xclip.' })
})

test('readClipboardImage reports no image when one tool ran and the other is missing', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'linux' })
  const first = await waitForCall(calls, 0)
  first.child.fail(1)
  const second = await waitForCall(calls, 1)
  second.child.spawnError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage rejects bytes a failed attempt left behind', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'darwin' })
  const furlAttempt = await waitForCall(calls, 0)
  furlAttempt.child.fail(1)
  const pngAttempt = await waitForCall(calls, 1)
  writeFileSync(scriptTarget(pngAttempt.args), PNG_BYTES)
  pngAttempt.child.fail(1)
  const tiffAttempt = await waitForCall(calls, 2)
  tiffAttempt.child.fail(1)

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage rejects empty and wrong-magic output', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'linux' })
  const empty = await waitForCall(calls, 0)
  writeSync(empty.opts.stdio[1], Buffer.alloc(0))
  empty.child.succeed()
  const wrongMagic = await waitForCall(calls, 1)
  writeSync(wrongMagic.opts.stdio[1], Buffer.from('not a png'))
  wrongMagic.child.succeed()

  assert.deepEqual(await promise, { ok: false, error: 'No image in the clipboard.' })
})

test('readClipboardImage rejects output over the image attachment limit', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'win32' })
  const call = await waitForCall(calls)
  writeFileSync(call.opts.env.COMMUNICATOR_CLIP_OUT, Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES)]))
  call.child.succeed()

  assert.deepEqual(await promise, { ok: false, error: 'The clipboard image is larger than 20 MB.' })
})

test('readClipboardImage reports an unopenable temp target as a read error', async () => {
  openImpl = () => {
    throw new Error('EACCES')
  }
  try {
    assert.deepEqual(await readClipboardImage({ platform: 'linux' }), { ok: false, error: 'Cannot read the clipboard image.' })
  } finally {
    openImpl = (path, flags) => realFs.openSync(path, flags)
  }
})

test('readClipboardImage kills a hanging attempt with SIGKILL and tries the next tool', async () => {
  const calls = captureReadSpawn()

  const promise = readClipboardImage({ platform: 'linux', timeoutMs: 50 })
  const wlPaste = await waitForCall(calls, 0)
  const xclip = await waitForCall(calls, 1)
  writeSync(xclip.opts.stdio[1], PNG_BYTES)
  xclip.child.succeed()
  const result = await promise

  assert.deepEqual(wlPaste.child.killSignals, ['SIGKILL'])
  assert.deepEqual(result, { ok: true, data: PNG_BYTES, mime: 'image/png' })
})
