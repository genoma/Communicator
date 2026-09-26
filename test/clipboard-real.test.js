// The suite's only real pasteboard round trip, and the only test that clobbers
// the clipboard: it is opt-in through COMMUNICATOR_CLIPBOARD_TEST=1 (CI sets it
// on the macOS leg) and skips wherever the pasteboard cannot be driven.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClipboardImage } from '../src/clipboard.js'

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('communicator clipboard round trip')])

function runOsascript(script) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.on('error', () => resolve({ code: 1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

async function setClipboardPng(path) {
  const script = [
    `set imageData to (read (POSIX file "${path}") as «class PNGf»)`,
    'set the clipboard to imageData',
  ].join('\n')
  const { code } = await runOsascript(script)
  return code
}

async function setClipboardFileUrl(path) {
  const { code } = await runOsascript(`set the clipboard to (POSIX file "${path}")`)
  return code
}

async function clipboardInfo() {
  const { code, stdout } = await runOsascript('return (clipboard info as text)')
  return code === 0 ? stdout : ''
}

test('reads back the exact PNG bytes written to the pasteboard (darwin only)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS pasteboard only')
  if (process.env.COMMUNICATOR_CLIPBOARD_TEST !== '1') return t.skip('set COMMUNICATOR_CLIPBOARD_TEST=1 to run the clobbering round trip')
  const dir = await mkdtemp(join(tmpdir(), 'communicator-clipboard-real-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'fixture.png')
  await writeFile(source, PNG_BYTES)
  if (await setClipboardPng(source) !== 0) return t.skip('osascript cannot write the pasteboard here')

  const result = await readClipboardImage()

  assert.ok(result.ok, `clipboard read failed: ${result.error}`)
  assert.deepEqual(result.data, PNG_BYTES)
  assert.equal(result.mime, 'image/png')
})

test('reads a file URL clipboard back as the file itself (darwin only)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS pasteboard only')
  if (process.env.COMMUNICATOR_CLIPBOARD_TEST !== '1') return t.skip('set COMMUNICATOR_CLIPBOARD_TEST=1 to run the clobbering round trip')
  const dir = await mkdtemp(join(tmpdir(), 'communicator-clipboard-real-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'fixture.png')
  await writeFile(source, PNG_BYTES)
  if (await setClipboardFileUrl(source) !== 0) return t.skip('osascript cannot write the pasteboard here')
  const info = await clipboardInfo()
  // The file-URL attempt runs first, so a coexisting image flavour is harmless;
  // only a pasteboard that lost the furl flavour entirely is unusable here.
  if (!info.includes('furl')) return t.skip('the pasteboard did not keep the file URL')

  const result = await readClipboardImage()

  assert.ok(result.ok, `clipboard read failed: ${result.error}`)
  assert.deepEqual(result.data, PNG_BYTES)
  assert.equal(result.mime, 'image/png')
  assert.equal(result.filename, 'fixture.png')
})
