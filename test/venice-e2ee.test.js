import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import * as venice from '../src/providers/venice.js'
import { createE2eeClient, isEncryptedHex } from '../src/e2ee.js'
import { ApiError } from '../src/errors.js'

const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption')

function serverEncrypt(plaintext, clientPubKeyHex) {
  const ephemeral = createECDH('secp256k1')
  const ephemeralPub = ephemeral.generateKeys()
  const sharedSecret = ephemeral.computeSecret(Buffer.from(clientPubKeyHex, 'hex'))
  const aesKey = hkdfSync('sha256', sharedSecret, Buffer.alloc(32), HKDF_INFO, 32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([ephemeralPub, nonce, ciphertext]).toString('hex')
}

function event(data) {
  return `data: ${JSON.stringify(data)}\n\n`
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

test('chatCompletion with e2ee encrypts messages and sets the TEE headers', async (t) => {
  const calls = []
  const client = createE2eeClient()
  const modelKey = createECDH('secp256k1')
  const modelPubKeyHex = modelKey.generateKeys('hex')
  const e2eeContext = { clientKey: client.clientKey, clientPubKeyHex: client.clientPubKeyHex, modelPubKeyHex }

  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers })
    return sseResponse([event({ choices: [{ delta: { content: serverEncrypt('ok', client.clientPubKeyHex) } }] }), 'data: [DONE]\n\n'])
  })

  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'prior turn' },
  ]
  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'e2ee-qwen3-5-122b-a10b',
    messages,
    onToken: () => {},
    webSearch: 'always',
    sessionId: 'sess-1',
    e2ee: true,
    e2eeContext,
  })

  assert.equal(result.content, 'ok')
  assert.equal(calls.length, 1)
  const { body, headers } = calls[0]
  assert.ok(calls[0].url.endsWith('/chat/completions'))

  assert.equal(headers['X-Venice-TEE-Client-Pub-Key'], client.clientPubKeyHex)
  assert.equal(headers['X-Venice-TEE-Model-Pub-Key'], modelPubKeyHex)
  assert.equal(headers['X-Venice-TEE-Signing-Algo'], 'ecdsa')

  // user and system content is ciphertext; assistant content passes through
  assert.ok(isEncryptedHex(body.messages[0].content))
  assert.ok(isEncryptedHex(body.messages[1].content))
  assert.equal(body.messages[2].content, 'prior turn')

  // web search is forced off and prompt caching is disabled under e2ee
  assert.equal(body.venice_parameters.enable_web_search, 'off')
  assert.equal(body.venice_parameters.include_venice_system_prompt, false)
  assert.equal(body.prompt_cache_key, undefined)
  assert.equal(body.stream, true)
})

test('chatCompletion without e2ee sends plaintext and no TEE headers', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers })
    return sseResponse([event({ choices: [{ delta: { content: 'plain' } }] }), 'data: [DONE]\n\n'])
  })

  const messages = [{ role: 'user', content: 'hello' }]
  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'm',
    messages,
    onToken: () => {},
    webSearch: 'always',
    sessionId: 'sess-1',
  })

  assert.equal(result.content, 'plain')
  assert.equal(calls[0].body.messages[0].content, 'hello')
  assert.equal(calls[0].headers['X-Venice-TEE-Signing-Algo'], undefined)
  assert.equal(calls[0].body.prompt_cache_key, 'sess-1')
  assert.equal(calls[0].body.venice_parameters.enable_web_search, 'on')
})

test('chatCompletion decrypts encrypted streamed deltas end to end', async (t) => {
  const client = createE2eeClient()
  const modelKey = createECDH('secp256k1')
  const modelPubKeyHex = modelKey.generateKeys('hex')
  const e2eeContext = { clientKey: client.clientKey, clientPubKeyHex: client.clientPubKeyHex, modelPubKeyHex }

  const encryptedHello = serverEncrypt('Hello', client.clientPubKeyHex)
  const encryptedWorld = serverEncrypt(' world', client.clientPubKeyHex)

  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    event({ choices: [{ delta: { content: encryptedHello } }] }),
    event({ choices: [{ delta: { content: encryptedWorld } }] }),
    'data: [DONE]\n\n',
  ]))

  const tokens = []
  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'e2ee-qwen3-5-122b-a10b',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (token, type) => tokens.push([type, token]),
    e2ee: true,
    e2eeContext,
  })

  assert.equal(result.content, 'Hello world')
  assert.deepEqual(tokens, [['content', 'Hello'], ['content', ' world']])
})

test('chatCompletion decrypts encrypted reasoning deltas', async (t) => {
  const client = createE2eeClient()
  const modelKey = createECDH('secp256k1')
  const modelPubKeyHex = modelKey.generateKeys('hex')
  const e2eeContext = { clientKey: client.clientKey, clientPubKeyHex: client.clientPubKeyHex, modelPubKeyHex }

  const encryptedReasoning = serverEncrypt('think', client.clientPubKeyHex)

  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    event({ choices: [{ delta: { reasoning_content: encryptedReasoning } }] }),
    event({ choices: [{ delta: { content: serverEncrypt('answer', client.clientPubKeyHex) } }] }),
    'data: [DONE]\n\n',
  ]))

  const result = await venice.chatCompletion({
    apiKey: 'key',
    model: 'e2ee-qwen3-5-122b-a10b',
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
    e2ee: true,
    e2eeContext,
  })

  assert.equal(result.reasoning, 'think')
  assert.equal(result.content, 'answer')
})

test('chatCompletion fails closed on plaintext deltas under e2ee', async (t) => {
  const client = createE2eeClient()
  const modelKey = createECDH('secp256k1')
  const modelPubKeyHex = modelKey.generateKeys('hex')
  const e2eeContext = { clientKey: client.clientKey, clientPubKeyHex: client.clientPubKeyHex, modelPubKeyHex }

  t.mock.method(globalThis, 'fetch', async () => sseResponse([
    event({ choices: [{ delta: { content: 'plain' } }] }),
    'data: [DONE]\n\n',
  ]))

  await assert.rejects(
    venice.chatCompletion({
      apiKey: 'key',
      model: 'e2ee-qwen3-5-122b-a10b',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: () => {},
      e2ee: true,
      e2eeContext,
    }),
    (err) => err instanceof ApiError && /unencrypted chunk/.test(err.message)
  )
})
