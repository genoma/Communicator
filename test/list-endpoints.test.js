import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchModelId } from '../src/commands/list-endpoints.js'

const models = [
  { id: 'deepseek/deepseek-v4-flash-0731' },
  { id: 'deepseek/deepseek-chat' },
  { id: 'deepseek/deepseek-r1' },
  { id: 'openai/gpt-4o' },
]

test('matchModelId resolves an exact id', () => {
  const { model, candidates } = matchModelId(models, 'deepseek/deepseek-chat')
  assert.equal(model.id, 'deepseek/deepseek-chat')
  assert.deepEqual(candidates, [])
})

test('matchModelId resolves a unique prefix', () => {
  const { model } = matchModelId(models, 'deepseek/deepseek-r1')
  assert.equal(model.id, 'deepseek/deepseek-r1')
})

test('matchModelId resolves a unique substring', () => {
  const { model } = matchModelId(models, 'v4-flash')
  assert.equal(model.id, 'deepseek/deepseek-v4-flash-0731')
})

test('matchModelId returns candidates for ambiguous matches, prefix-first', () => {
  const { model, candidates } = matchModelId(models, 'deepseek/deepseek')
  assert.equal(model, null)
  assert.deepEqual(candidates.map((m) => m.id), [
    'deepseek/deepseek-v4-flash-0731',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-r1',
  ])
})

test('matchModelId is case-insensitive', () => {
  const { model } = matchModelId(models, 'GPT-4O')
  assert.equal(model.id, 'openai/gpt-4o')
})

test('matchModelId returns empty candidates for no match', () => {
  const { model, candidates } = matchModelId(models, 'anthropic/claude')
  assert.equal(model, null)
  assert.deepEqual(candidates, [])
})

test('matchModelId does not duplicate matches', () => {
  const modelsWithDup = [...models, { id: 'deepseek/deepseek-chat' }]
  const { candidates } = matchModelId(modelsWithDup, 'deepseek')
  const ids = candidates.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
})
