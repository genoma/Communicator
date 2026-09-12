import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { CliError } from '../src/errors.js'

mock.module('node:os', { namedExports: { homedir: () => '/tmp/read-stdin-home' } })

const { readStdin, MAX_STDIN_BYTES } = await import('../src/cli-utils.js')

function mockStdin(t, stream) {
  const original = process.stdin
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
  t.after(() => {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true })
  })
}

test('MAX_STDIN_BYTES is 10MB', () => {
  assert.equal(MAX_STDIN_BYTES, 10 * 1024 * 1024)
})

test('readStdin preserves piped whitespace and drops only the trailing newline', async (t) => {
  mockStdin(t, Readable.from([Buffer.from('  hello '), Buffer.from(' world\n')]))

  const text = await readStdin()

  assert.equal(text, '  hello  world')
})

test('readStdin keeps a diff\'s indentation and blank lines intact', async (t) => {
  mockStdin(t, Readable.from([Buffer.from('@@ -1 +1 @@\n-  old\n+  new\n\n')]))

  const text = await readStdin()

  assert.equal(text, '@@ -1 +1 @@\n-  old\n+  new\n')
})

test('readStdin treats whitespace-only input as empty', async (t) => {
  mockStdin(t, Readable.from([Buffer.from('  \n\t\n')]))

  const text = await readStdin()

  assert.equal(text, '')
})

test('readStdin drops a trailing CRLF and keeps the rest of the line', async (t) => {
  mockStdin(t, Readable.from([Buffer.from('line one\r\nline two\r\n')]))

  const text = await readStdin()

  assert.equal(text, 'line one\r\nline two')
})

test('readStdin returns an empty string for empty input', async (t) => {
  mockStdin(t, Readable.from([]))

  const text = await readStdin()

  assert.equal(text, '')
})

test('readStdin enforces the default 10MB limit with a CliError', async (t) => {
  mockStdin(t, Readable.from([Buffer.alloc(11 * 1024 * 1024)]))

  await assert.rejects(
    readStdin(),
    (e) => e instanceof CliError && e.message === 'Error: stdin input exceeds the 10MB limit.'
  )
})

test('readStdin honors a custom maxBytes in the error message', async (t) => {
  mockStdin(t, Readable.from([Buffer.alloc(3 * 1024)]))

  await assert.rejects(
    readStdin({ maxBytes: 1024 }),
    (e) => e instanceof CliError && e.message === 'Error: stdin input exceeds the 1KB limit.'
  )
})
