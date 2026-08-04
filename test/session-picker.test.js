import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

let searchImpl = null
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => searchImpl(opts),
    select: async () => { throw new Error('unexpected select') },
  },
})

const { selectSession } = await import('../src/session-picker.js')

function sessionItem(overrides = {}) {
  return {
    id: '2026-07-30T19-15-22',
    model: 'openai/gpt-4o',
    providerName: 'OpenAI',
    providerType: 'openrouter',
    createdAt: '2026-07-30T19:15:22.000Z',
    updatedAt: '2026-07-30T19:20:00.000Z',
    messageCount: 12,
    preview: 'Write a Python script that...',
    title: 'Write a Python script',
    ...overrides,
  }
}

test('selectSession resolves the chosen session id', async () => {
  const sessions = [sessionItem(), sessionItem({ id: '2026-07-29T10-00-00', title: 'Other' })]
  searchImpl = async (opts) => {
    assert.equal(opts.message, 'Select a session to resume')
    assert.ok(opts.theme)
    return '2026-07-29T10-00-00'
  }

  assert.equal(await selectSession(sessions), '2026-07-29T10-00-00')
})

test('selectSession returns all choices without an input filter', async () => {
  const sessions = [sessionItem(), sessionItem({ id: '2026-07-29T10-00-00' })]
  searchImpl = async (opts) => {
    const all = await opts.source('')
    assert.equal(all.length, 2)
    assert.match(all[0].name, /2026-07-30 19:15:22/)
    assert.equal(all[0].value, '2026-07-30T19-15-22')
    assert.match(all[0].description, /"Write a Python script"  •  OpenAI/)
    return all[0].value
  }

  assert.equal(await selectSession(sessions), '2026-07-30T19-15-22')
})

test('selectSession filters by id, line, and description case-insensitively', async () => {
  const sessions = [
    sessionItem({ id: '2026-07-30T19-15-22', title: 'Python script' }),
    sessionItem({ id: '2026-07-29T10-00-00', title: 'Rust borrow checker', providerType: 'venice', providerName: 'venice' }),
  ]
  let seen = []
  searchImpl = async (opts) => {
    seen = [await opts.source('rust'), await opts.source('2026-07-30'), await opts.source('venice'), await opts.source('nope')]
    return null
  }

  await selectSession(sessions)

  assert.deepEqual(seen[0].map((c) => c.value), ['2026-07-29T10-00-00'])
  assert.deepEqual(seen[1].map((c) => c.value), ['2026-07-30T19-15-22'])
  assert.deepEqual(seen[2].map((c) => c.value), ['2026-07-29T10-00-00'])
  assert.deepEqual(seen[3], [])
})
