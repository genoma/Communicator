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

function setClipboardPng(path) {
  return new Promise((resolve) => {
    const script = [
      `set imageData to (read (POSIX file "${path}") as «class PNGf»)`,
      'set the clipboard to imageData',
    ].join('\n')
    const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
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
