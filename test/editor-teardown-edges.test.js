// Teardown and defensive-branch tests for the frame-diffing editor: timers
// armed by a resize must not repaint a closed editor, the custom footer and
// the help footer compose in order, provider lookups that throw degrade to a
// no-op, the removed option surface is rejected loudly, and the stale-state
// guards stay in force.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readEditor } from '../src/editor/index.js'
import { _resetKittyDetection } from '../src/editor/footer.js'

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

function fakeOutput({ columns = 80, rows = 24 } = {}) {
  const writes = []
  const listeners = {}
  const output = {
    columns,
    rows,
    isTTY: true,
    write: (chunk) => {
      writes.push(String(chunk))
      return true
    },
    on: (event, fn) => {
      listeners[event] = fn
    },
    removeListener: (event) => {
      delete listeners[event]
    },
  }
  return { output, writes, listeners }
}

function openEditor(options = {}) {
  const { columns, rows, ...editorOptions } = options
  _resetKittyDetection(false)
  const { output, writes, listeners } = fakeOutput({ columns, rows })
  const stdin = fakeStdin()
  const pending = readEditor('', {
    input: stdin,
    output,
    prefix: '',
    linePrefix: '❯ ',
    helpFooter: false,
    maxLines: 50,
    theme: { linePrefix: { pending: 'cyan', submitted: 'dim', cancelled: 'dim' } },
    ...editorOptions,
  })
  return { pending, stdin, output, writes, listeners }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function replacementSpelling() {
  return {
    onUpdate: null,
    getTypoRanges: () => undefined,
    getWordReplacements: async (lines, row) => ({ line: row, startCol: 0, endCol: 3, items: ['baz'] }),
  }
}

// --- Teardown with a pending resize / DSR timer ---

test('a pending DSR fallback cannot repaint after the editor closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { pending, stdin, output, writes, listeners } = openEditor({ rows: 24 })
  stdin.emit('data', 'one line')
  writes.length = 0
  output.columns = 50
  output.rows = 16
  listeners.resize()
  await t.mock.timers.tick(80)
  assert.ok(writes.join('').includes('\x1b[6n'), 'the DSR query went out with no DSR reply')

  // Submit (not cancel): the submitted block stays painted, so the shadow is
  // still set and an uncleared DSR fallback would repaint it after the exit.
  stdin.emit('data', '\r')
  assert.deepEqual(await pending, ['one line', null])
  const afterClose = writes.length
  await t.mock.timers.tick(500)
  assert.equal(writes.length, afterClose, 'the cleared DSR fallback never repaints the closed block')
})

test('a resize debounce pending at teardown never fires its handler', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { pending, stdin, output, writes, listeners } = openEditor({ rows: 24 })
  stdin.emit('data', 'one line')
  writes.length = 0
  output.columns = 50
  output.rows = 16
  listeners.resize()
  await t.mock.timers.tick(40) // still inside the 80 ms debounce
  stdin.emit('data', '\x03')
  const [, error] = await pending
  assert.equal(error?.kind, 'cancel')

  const afterClose = writes.length
  await t.mock.timers.tick(500)
  assert.equal(writes.length, afterClose, 'no repaint after the editor closed')
  assert.ok(!writes.join('').includes('\x1b[6n'), 'the cleared debounce never queried DSR')
})

// --- Footer composition ---

test('a custom footer is kept when the help footer renders nothing', async () => {
  const { pending, stdin, writes } = openEditor({
    footer: 'custom footer line',
    helpFooter: { items: [] },
  })
  const painted = writes.join('')
  assert.ok(painted.includes('custom footer line'))
  assert.ok(!painted.includes('Enter: submit'), 'no help row is painted for an empty item list')

  stdin.emit('data', '\x03')
  const [, error] = await pending
  assert.equal(error?.kind, 'cancel')
})

test('a custom footer is followed by the help footer when both render', async () => {
  const { pending, stdin, writes } = openEditor({ footer: 'custom footer line', helpFooter: true })
  const painted = writes.join('')
  assert.ok(painted.includes('custom footer line'), 'the custom row is painted')
  assert.ok(painted.includes('Enter: submit'), 'the help rows are painted')
  assert.ok(
    painted.indexOf('custom footer line') < painted.indexOf('Enter: submit'),
    'the custom row comes before the help rows'
  )

  stdin.emit('data', '\r')
  const [value] = await pending
  assert.equal(value, '')
})

// --- Throwing provider lookups ---

test('a replacement lookup that throws leaves the editor usable', async () => {
  const spelling = {
    onUpdate: null,
    getTypoRanges: () => undefined,
    getWordReplacements: async () => {
      throw new Error('replacement lookup exploded')
    },
  }
  const { pending, stdin } = openEditor({ spelling })
  let settled = false
  void pending.then(() => {
    settled = true
  })

  stdin.emit('data', 'foo')
  stdin.emit('data', '\x1b[46;5u') // Ctrl+.
  await delay(5)
  assert.equal(settled, false, 'the editor stays open after the failed lookup')

  stdin.emit('data', '\r')
  assert.deepEqual(await pending, ['foo', null])
})

test('an autocorrection lookup that throws leaves the editor usable', async () => {
  const spelling = {
    onUpdate: null,
    getTypoRanges: () => undefined,
    getAutocorrection: async () => {
      throw new Error('autocorrection lookup exploded')
    },
  }
  const { pending, stdin } = openEditor({ spelling })
  let settled = false
  void pending.then(() => {
    settled = true
  })

  stdin.emit('data', 'm')
  stdin.emit('data', 'i')
  stdin.emit('data', 's')
  await delay(5)
  assert.equal(settled, false, 'the editor stays open after the failed lookup')

  stdin.emit('data', '\r')
  assert.deepEqual(await pending, ['mis', null])
})

// --- Removed option surface ---

test('editor-only options are rejected loudly on a TTY input', () => {
  const { output } = fakeOutput()
  for (const option of ['validate', 'transform', 'highlight', 'inlinePrompt']) {
    assert.throws(
      () => readEditor('', { input: fakeStdin(), output, [option]: () => {} }),
      (error) => error.message === `readEditor: the "${option}" option is not supported by editor-bufferdiff-v2`,
      `${option} must be rejected`
    )
  }
})

test('theme.submitRender is rejected loudly on a TTY input', () => {
  const { output } = fakeOutput()
  assert.throws(
    () => readEditor('', { input: fakeStdin(), output, theme: { submitRender: () => '' } }),
    (error) => error.message === 'readEditor: the theme.submitRender option is not supported by editor-bufferdiff-v2'
  )
})

// --- Stale-state and history-attempt guards ---

test('a replacement list is dropped when a paste changes the line under it', async () => {
  const { pending, stdin, writes } = openEditor({ spelling: replacementSpelling() })
  stdin.emit('data', 'foo bar')
  stdin.emit('data', '\x1b[46;5u') // Ctrl+.
  await delay(5)
  assert.ok(writes.join('').includes('baz'), 'the replacement list is open')

  const opened = writes.length
  // The paste edits the line without a repaint in between: the list opened
  // for the previous line must not survive onto the changed line.
  stdin.emit('data', '\x1b[200~more\x1b[201~')
  await delay(5)
  assert.ok(!writes.slice(opened).join('').includes('baz'), 'the stale list is gone')

  stdin.emit('data', '\r')
  assert.deepEqual(await pending, ['foo barmore', null])
})

test('a key that does not touch history clears the pending double-arrow attempt', async () => {
  const { pending, stdin, writes } = openEditor({
    history: ['alpha', 'beta'],
    historyArrowNavigation: 'double',
  })
  stdin.emit('data', '\x1b[A') // first Up: attempt 1, not enough to recall in double mode
  stdin.emit('data', '\x1b[3~') // Delete: a no-op escape key that does not touch history
  stdin.emit('data', '\x1b[A') // must be attempt 1 again: the empty draft stays
  assert.ok(!writes.join('').includes('beta'), 'the draft is not replaced by a history entry')

  stdin.emit('data', '\x1b[A') // attempt 2: the previous entry is recalled
  assert.ok(writes.join('').includes('beta'))
  stdin.emit('data', '\r')
  assert.deepEqual(await pending, ['beta', null])
})
