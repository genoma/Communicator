import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlagOrExit, collectFlag, fail } from '../src/cli-utils.js'
import { CliError } from '../src/errors.js'
import { resolveBudget } from '../src/flags.js'

test('collectFlag accumulates repeated --attach values', () => {
  assert.deepEqual(collectFlag('a.png', []), ['a.png'])
  assert.deepEqual(collectFlag('b.pdf', collectFlag('a.png', [])), ['a.png', 'b.pdf'])
  assert.deepEqual(collectFlag('c.txt', ['a.png', 'b.pdf']), ['a.png', 'b.pdf', 'c.txt'])
})

test('resolveFlagOrExit passes valid values through', () => {
  assert.equal(resolveFlagOrExit(resolveBudget, '2.5'), 2.5)
  assert.equal(resolveFlagOrExit(resolveBudget, undefined), null)
})

test('resolveFlagOrExit wraps resolver errors in a CliError with Error prefix', () => {
  assert.throws(
    () => resolveFlagOrExit(resolveBudget, '-1'),
    (err) => err instanceof CliError && err.message === 'Error: Budget must be a positive number (USD).' && err.exitCode === 1
  )
})

test('fail prints the message to stderr and exits with the given code', (t) => {
  const out = []
  t.mock.method(console, 'error', (msg) => out.push(String(msg)))
  let exitCode = null
  t.mock.method(process, 'exit', (code) => { exitCode = code })

  fail('boom')
  fail('warn', 2)

  assert.deepEqual(out, ['boom', 'warn'])
  assert.equal(exitCode, 2)
})
