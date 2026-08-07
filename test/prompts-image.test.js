import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Separator } from '@inquirer/core'

let searchCalls = []
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async (opts) => {
      searchCalls.push(opts)
      return { id: 'flux-1-1', name: 'Flux 1.1' }
    },
    select: async () => undefined,
  },
})

const { orderImageModelChoices, orderModelWithImages, selectImageModel, selectModelWithImages, filterModelChoices } = await import('../src/prompts.js')

const MODELS = [
  {
    id: 'flux-1-1',
    name: 'Flux 1.1',
    description: '$0.02 per image  |  aspect: 1:1, 16:9\nFast diffusion',
    offline: false,
  },
  { id: 'last-image-model', name: 'Last Used', description: 'desc', offline: true },
  { id: 'gamma', name: 'Gamma', description: 'no price shown', offline: false },
]

const TEXT_MODELS = [
  { id: 'venice/llama', name: 'Llama', description: 'd1', visionSupported: undefined },
  { id: 'venice/deepseek', name: 'DeepSeek', description: 'd2', visionSupported: undefined },
]

test('orderImageModelChoices moves the last-used model first', () => {
  const ordered = orderImageModelChoices(MODELS, 'last-image-model')
  assert.deepEqual(ordered.map((c) => c.value.id), ['last-image-model', 'flux-1-1', 'gamma'])
})

test('orderImageModelChoices keeps the original order when the last model is missing', () => {
  const ordered = orderImageModelChoices(MODELS, 'gone')
  assert.deepEqual(ordered.map((c) => c.value.id), ['flux-1-1', 'last-image-model', 'gamma'])
})

test('orderImageModelChoices tags image and offline models and keeps descriptions', () => {
  const ordered = orderImageModelChoices(MODELS)
  assert.equal(ordered[0].name, 'Flux 1.1  (flux-1-1)  [image]')
  assert.equal(ordered[1].name, 'Last Used  (last-image-model)  [image]  [offline]')
  assert.equal(ordered[0].description, MODELS[0].description)
  assert.equal(ordered[2].description, 'no price shown')
})

test('orderImageModelChoices falls back to the id when no description exists', () => {
  const ordered = orderImageModelChoices([{ id: 'plain', name: 'Plain', offline: false }])
  assert.equal(ordered[0].description, 'plain')
})

test('filterModelChoices matches image models by name and id', () => {
  const ordered = orderImageModelChoices(MODELS)
  assert.deepEqual(filterModelChoices(ordered, 'flux').map((c) => c.value.id), ['flux-1-1'])
  assert.deepEqual(filterModelChoices(ordered, 'LAST').map((c) => c.value.id), ['last-image-model'])
  assert.deepEqual(filterModelChoices(ordered, 'zzz'), [])
})

test('orderModelWithImages merges text choices, a separator and tagged image choices', () => {
  const merged = orderModelWithImages(TEXT_MODELS, MODELS, 'venice/deepseek', 'flux-1-1')
  assert.equal(merged.length, 6)
  assert.deepEqual(merged[0].value.id, 'venice/deepseek')
  assert.deepEqual(merged[1].value.id, 'venice/llama')
  assert.ok(merged[2] instanceof Separator, 'third entry is the image separator')
  assert.equal(merged[2].separator, 'Image models')
  assert.equal(merged[3].value.id, 'flux-1-1')
  assert.equal(merged[3].name, 'Flux 1.1  (flux-1-1)  [image]')
  assert.equal(merged[5].value.id, 'gamma')
})

test('filterModelChoices skips separator entries', () => {
  const merged = orderModelWithImages(TEXT_MODELS, MODELS)
  const filtered = filterModelChoices(merged, 'flux')
  assert.deepEqual(filtered.map((c) => c.value.id), ['flux-1-1'])
  const empty = filterModelChoices(merged, 'zzz')
  assert.deepEqual(empty, [])
})

test('selectModelWithImages runs a single merged search prompt', async () => {
  searchCalls = []
  const chosen = await selectModelWithImages(TEXT_MODELS, MODELS, 'venice/llama', 'gamma')

  assert.equal(chosen.id, 'flux-1-1')
  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].message, 'Select a model')
  const choices = await searchCalls[0].source('')
  assert.equal(choices[2].separator, 'Image models')
})

test('selectImageModel runs a search prompt for image models', async () => {
  searchCalls = []
  const chosen = await selectImageModel(MODELS, 'flux-1-1')

  assert.equal(chosen.id, 'flux-1-1')
  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].message, 'Select an image model')
})
