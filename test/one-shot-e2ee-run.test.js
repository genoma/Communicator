import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { ExitPromptError } from '@inquirer/core'

const tempHome = await mkdtemp(join(tmpdir(), 'communicator-home-'))
after(() => rm(tempHome, { recursive: true, force: true }))

mock.module('node:os', { namedExports: { homedir: () => tempHome } })
mock.module('@inquirer/prompts', {
  namedExports: {
    search: async () => { throw new ExitPromptError() },
    select: async () => { throw new ExitPromptError() },
    confirm: async () => { throw new ExitPromptError() },
    checkbox: async () => { throw new ExitPromptError() },
  },
})

const { CliError } = await import('../src/errors.js')
const { isEncryptedHex } = await import('../src/e2ee.js')
const { resetModelCaches: resetVeniceModelCaches } = await import('../src/providers/venice.js')

const E2EE_MODEL = 'e2ee-qwen3-5-122b-a10b'
const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function event(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

// The Venice enclave side of the protocol: decryptable only with the client
// key pair the run advertised, so a streamed answer pins the real context.
function serverEncrypt(plaintext, clientPubKeyHex) {
  const ephemeral = createECDH('secp256k1')
  const ephemeralPub = ephemeral.generateKeys()
  const aesKey = hkdfSync('sha256', ephemeral.computeSecret(Buffer.from(clientPubKeyHex, 'hex')), Buffer.alloc(32), HKDF_INFO, 32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([ephemeralPub, nonce, ciphertext]).toString('hex')
}

function e2eeCatalog() {
  return [{ id: E2EE_MODEL, model_spec: { name: 'E2EE Qwen', capabilities: { supportsE2EE: true } } }]
}

function opts(overrides = {}) {
  return {
    model: E2EE_MODEL,
    temperature: undefined,
    reasoningEffort: undefined,
    webSearch: undefined,
    webResults: undefined,
    attach: [],
    smoothStreaming: true,
    smoothSpeed: undefined,
    config: undefined,
    e2ee: true,
    ...overrides,
  }
}

function mockExit(t) {
  let exitCode = null
  t.mock.method(process, 'exit', (code) => { exitCode = code })
  return () => exitCode
}

// Notices route to stdout on a terminal and to stderr when stdout is piped
// (the piped one-shot emits only answer text there); pinning the piped path
// keeps the streamed-answer assertions independent of the runner's TTY state.
function withStdoutTTY(t, value) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  t.after(() => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete process.stdout.isTTY
  })
}

// The piped one-shot writes the answer with process.stdout.write, which is also
// the test child's protocol channel: capturing those writes keeps application
// text off fd 1 (see test/runner-console-guard.test.js). The runner frames its
// results as buffers on that same channel, so they are forwarded untouched.
function mockPipedStdout(t) {
  const writes = []
  const forward = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
    if (typeof chunk !== 'string') return forward(chunk, ...rest)
    writes.push(String(chunk))
    return true
  })
  return writes
}

async function tempConfig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'communicator-config-'))
  const file = join(dir, 'config.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return file
}

async function runOneShot(t, { overrides = {}, prompt = 'Hello' } = {}) {
  const { oneShotCmd } = await import('../src/commands/one-shot.js')
  try {
    await oneShotCmd({ apiKey: 'venice-key', opts: opts(overrides), prefs: {}, systemPrompt: null, providerType: 'venice', prompt })
    return { exited: false }
  } catch (e) {
    if (e instanceof CliError) return { exited: true, exitCode: e.exitCode, message: e.message }
    throw e
  }
}

test('one-shot --e2ee attests the model and sends only ciphertext to the Venice endpoint', async (t) => {
  resetVeniceModelCaches()
  t.after(resetVeniceModelCaches)
  withStdoutTTY(t, false)
  const writes = mockPipedStdout(t)
  const getExitCode = mockExit(t)
  const file = await tempConfig(t)

  const modelKey = createECDH('secp256k1')
  const modelPubKeyHex = modelKey.generateKeys('hex')
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url)
    calls.push({ url: u, headers: init?.headers, body: init?.body })
    if (u.includes('/tee/attestation')) {
      return jsonResponse({ verified: true, nonce: new URL(u).searchParams.get('nonce'), signing_key: modelPubKeyHex })
    }
    if (u.includes('/models?type=text')) return jsonResponse({ data: e2eeCatalog() })
    if (u.includes('/chat/completions')) {
      return sseResponse([
        event({ choices: [{ delta: { content: serverEncrypt('Hello world', init.headers['X-Venice-TEE-Client-Pub-Key']) } }] }),
        event({ choices: [{ delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] }),
        'data: [DONE]\n\n',
      ])
    }
    throw new Error(`unexpected fetch: ${u}`)
  })

  const { exited } = await runOneShot(t, { overrides: { config: file } })

  assert.equal(exited, false)
  assert.equal(getExitCode(), null)

  const attestation = calls.find((c) => c.url.includes('/tee/attestation'))
  assert.ok(attestation, 'the model must be attested before the first turn')
  assert.ok(attestation.url.includes(`model=${E2EE_MODEL}`), `unexpected attestation URL: ${attestation.url}`)

  const chat = calls.find((c) => c.url.includes('/chat/completions'))
  assert.ok(chat, 'an accepted --e2ee run must reach the completion request')
  const body = JSON.parse(chat.body)
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user'])
  assert.ok(body.messages.every((m) => isEncryptedHex(m.content)), 'no message may reach the host in plaintext')
  assert.ok(!chat.body.includes('Hello'), 'the request payload must not carry the plaintext prompt')
  assert.ok(!chat.body.includes('You are a helpful assistant.'), 'the request payload must not carry the plaintext system prompt')
  assert.equal(chat.headers['X-Venice-TEE-Signing-Algo'], 'ecdsa')
  assert.equal(chat.headers['X-Venice-TEE-Model-Pub-Key'], modelPubKeyHex)
  assert.match(chat.headers['X-Venice-TEE-Client-Pub-Key'], /^04[0-9a-f]{128}$/)
  assert.ok(writes.join('').includes('Hello world'), 'the attested client key must decrypt the streamed answer')
})

test('one-shot --e2ee aborts with a CliError and sends no request when the attestation fails', async (t) => {
  resetVeniceModelCaches()
  t.after(resetVeniceModelCaches)
  withStdoutTTY(t, false)
  mockPipedStdout(t)
  mockExit(t)
  const file = await tempConfig(t)

  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/tee/attestation')) {
      return jsonResponse({ verified: false, nonce: new URL(u).searchParams.get('nonce'), signing_key: '04'.repeat(65) })
    }
    if (u.includes('/models?type=text')) return jsonResponse({ data: e2eeCatalog() })
    throw new Error(`unexpected fetch: ${u}`)
  })

  const { exited, message } = await runOneShot(t, { overrides: { config: file } })

  assert.equal(exited, true)
  assert.match(message, /^Error: TEE attestation verification failed on server\.$/)
  assert.ok(calls.some((u) => u.includes('/tee/attestation')), 'the run must attest before sending anything')
  assert.ok(!calls.some((u) => u.includes('/chat/completions')), 'a failed attestation must send no request')
})
