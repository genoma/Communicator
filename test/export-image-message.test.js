import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-export-image-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })

const { listSessions, loadSession } = await import('../src/sessions.js')
const { formatMarkdown } = await import('../src/export.js')

const IMG = Buffer.from('exported image bytes')
const HASH = createHash('sha256').update(IMG).digest('hex')

async function seedImageSession() {
  const dir = join(tempHome, '.communicator', 'sessions')
  await mkdir(join(dir, 'attachments', '2026-01-01T00-00-00'), { recursive: true })
  await writeFile(join(dir, 'attachments', '2026-01-01T00-00-00', `${HASH}.png`), IMG)
  await writeFile(join(dir, '2026-01-01T00-00-00.json'), JSON.stringify({
    model: 'flux-1-1',
    providerName: 'venice',
    providerType: 'venice',
    createdAt: '2026-01-01T00:00:00.000Z',
    title: 'a red cat',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a red cat' },
      {
        role: 'assistant',
        content: [{ type: 'image_url', image_url: { url: `ref://attachments/${HASH}.png` } }],
      },
    ],
  }, null, 2) + '\n')
  return dir
}

test('resume rehydrates assistant image refs into data URLs', async () => {
  const dir = await seedImageSession()

  const data = await loadSession(dir, '2026-01-01T00-00-00')

  const parts = data.messages[2].content
  assert.equal(parts.length, 1)
  assert.equal(parts[0].image_url.url, `data:image/png;base64,${IMG.toString('base64')}`)
})

test('export renders assistant image parts from a ref-hydrated session', async () => {
  const dir = await seedImageSession()
  const data = await loadSession(dir, '2026-01-01T00-00-00')

  const md = formatMarkdown(data)

  assert.ok(md.includes('# Chat Session'), md)
  assert.ok(md.includes('**Model:** `flux-1-1`'))
  assert.ok(md.includes('> **Image:** `image.png`'), md)
})

test('--list-sessions shows the image-gen session', async () => {
  const dir = await seedImageSession()

  const sessions = await listSessions(dir)

  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, '2026-01-01T00-00-00')
  assert.equal(sessions[0].title, 'a red cat')
  assert.equal(sessions[0].providerType, 'venice')
})
