import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { decodeHeic } from '../src/heic-decode.js'

function fakeSpawn(run) {
  const calls = []
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter()
    const kills = []
    child.kill = (...killArgs) => kills.push(killArgs)
    calls.push({ command, args, options, child, kills })
    if (run) setImmediate(() => run(child, args))
    return child
  }
  return { spawnFn, calls }
}

function tempDirOf(call) {
  return dirname(call.args.at(-1))
}

test('returns null off darwin without spawning', async () => {
  const { spawnFn, calls } = fakeSpawn()
  assert.equal(await decodeHeic(Buffer.from('HEICDATA'), { platform: 'linux', spawnFn }), null)
  assert.equal(await decodeHeic(Buffer.from('HEICDATA'), { platform: 'win32', spawnFn }), null)
  assert.equal(calls.length, 0)
})

test('decodes through sips and returns the produced jpeg on darwin', async () => {
  let sourceBytes = null
  const { spawnFn, calls } = fakeSpawn((child, args) => {
    try {
      sourceBytes = readFileSync(args.at(-1)).toString()
      writeFileSync(args[args.indexOf('--out') + 1], 'JPEGDATA')
      child.emit('close', 0)
    } catch (err) {
      child.emit('error', err)
    }
  })
  const out = await decodeHeic(Buffer.from('HEICDATA'), { platform: 'darwin', spawnFn })
  assert.equal(out.toString(), 'JPEGDATA')
  assert.equal(sourceBytes, 'HEICDATA')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/bin/sips')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-s', 'format', 'jpeg'])
  assert.deepEqual(calls[0].options.stdio, 'ignore')
  assert.equal(existsSync(tempDirOf(calls[0])), false)
})

test('returns null when sips exits non-zero and removes the temp dir', async () => {
  const { spawnFn, calls } = fakeSpawn((child) => child.emit('close', 1))
  assert.equal(await decodeHeic(Buffer.from('HEICDATA'), { platform: 'darwin', spawnFn }), null)
  assert.equal(existsSync(tempDirOf(calls[0])), false)
})

test('returns null when the spawn errors and removes the temp dir', async () => {
  const { spawnFn, calls } = fakeSpawn((child) => child.emit('error', new Error('spawn failed')))
  assert.equal(await decodeHeic(Buffer.from('HEICDATA'), { platform: 'darwin', spawnFn }), null)
  assert.equal(existsSync(tempDirOf(calls[0])), false)
})

test('kills sips and returns null on timeout, removing the temp dir', async () => {
  const { spawnFn, calls } = fakeSpawn()
  assert.equal(await decodeHeic(Buffer.from('HEICDATA'), { platform: 'darwin', spawnFn, timeoutMs: 20 }), null)
  assert.deepEqual(calls[0].kills, [['SIGKILL']])
  assert.equal(existsSync(tempDirOf(calls[0])), false)
})

test('decodes a real heic produced by sips (darwin only)', async (t) => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sips')) return t.skip('macOS sips unavailable')
  let sharp
  try {
    ({ default: sharp } = await import('sharp'))
  } catch {
    return t.skip('sharp unavailable')
  }
  const dir = await mkdtemp(join(tmpdir(), 'communicator-heic-fixture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pngPath = join(dir, 'fixture.png')
  const heicPath = join(dir, 'fixture.heic')
  await writeFile(pngPath, await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366aa' } }).png().toBuffer())
  const code = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sips', ['-s', 'format', 'heic', '--out', heicPath, pngPath], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0)
  const decoded = await decodeHeic(await readFile(heicPath))
  assert.equal(decoded.subarray(0, 3).toString('hex'), 'ffd8ff')
  const meta = await sharp(decoded).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, 64)
  assert.equal(meta.height, 48)
})
