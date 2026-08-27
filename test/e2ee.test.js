import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { encryptMessage, encryptMessages, decryptToken, isEncryptedHex, createE2eeClient, fetchModelPubKey, createE2eeSession } from '../src/e2ee.js'

const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption')

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockFetch(t, impl) {
  t.mock.method(globalThis, 'fetch', impl)
}

// Simulates the Venice enclave side of the protocol: a static model key
// (from the attestation) and per-chunk ephemeral keys, encrypting exactly
// like the documented server does.
function serverKeypair() {
  const key = createECDH('secp256k1')
  return { key, pubKeyHex: key.generateKeys('hex') }
}

function deriveAesKey(privateKey, peerPubKey) {
  const sharedSecret = privateKey.computeSecret(peerPubKey)
  return hkdfSync('sha256', sharedSecret, Buffer.alloc(32), HKDF_INFO, 32)
}

function serverEncrypt(plaintext, peerPubKey) {
  const ephemeral = createECDH('secp256k1')
  const ephemeralPub = ephemeral.generateKeys()
  const aesKey = deriveAesKey(ephemeral, peerPubKey)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([ephemeralPub, nonce, ciphertext]).toString('hex')
}

test('isEncryptedHex accepts only long hex strings', () => {
  assert.equal(isEncryptedHex('04'.repeat(93)), true)
  assert.equal(isEncryptedHex('04'.repeat(92)), false)
  assert.equal(isEncryptedHex('zz'.repeat(100)), false)
  assert.equal(isEncryptedHex('plain text'), false)
  assert.equal(isEncryptedHex(null), false)
  assert.equal(isEncryptedHex(undefined), false)
})

test('createE2eeClient exposes an uncompressed secp256k1 public key', () => {
  const { clientKey, clientPubKeyHex } = createE2eeClient()
  assert.equal(clientPubKeyHex.length, 130)
  assert.ok(clientPubKeyHex.startsWith('04'))
  assert.ok(clientKey.getPrivateKey())
})

test('encryptMessage produces a decryptable hex blob (client + model keys)', () => {
  const model = serverKeypair()

  const encrypted = encryptMessage('secret prompt', model.pubKeyHex)
  assert.ok(isEncryptedHex(encrypted))
  assert.notEqual(encrypted, encryptMessage('secret prompt', model.pubKeyHex), 'ephemeral key must randomize ciphertext')

  // The server side derives the same AES key from the model private key and
  // the ephemeral public key embedded in the blob.
  const raw = Buffer.from(encrypted, 'hex')
  const ephemeralPub = raw.subarray(0, 65)
  const nonce = raw.subarray(65, 77)
  const ciphertext = raw.subarray(77)
  const aesKey = deriveAesKey(model.key, ephemeralPub)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]).toString('utf8')
  assert.equal(plaintext, 'secret prompt')
})

test('decryptToken decrypts a server chunk using the client session key', () => {
  const client = createE2eeClient()

  // The server encrypts the response chunk with an ephemeral key and the
  // client's public key (the one sent in the header).
  const wire = serverEncrypt('response text', Buffer.from(client.clientPubKeyHex, 'hex'))

  const decrypted = decryptToken(wire, client.clientKey)
  assert.equal(decrypted, 'response text')
})

test('decryptToken rejects chunks that are too short', () => {
  const client = createE2eeClient()
  assert.throws(() => decryptToken('abcd', client.clientKey), /too short/)
})

test('decryptToken rejects tampered chunks', () => {
  const client = createE2eeClient()
  const wire = serverEncrypt('hello', Buffer.from(client.clientPubKeyHex, 'hex'))
  const flipped = `${wire.slice(0, wire.length - 2)}00`
  assert.throws(() => decryptToken(flipped, client.clientKey), /unable to authenticate data/)
})

test('encryptMessages encrypts user and system roles only', () => {
  const model = serverKeypair()
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'prior answer' },
  ]
  const encrypted = encryptMessages(messages, model.pubKeyHex)
  assert.ok(isEncryptedHex(encrypted[0].content))
  assert.ok(isEncryptedHex(encrypted[1].content))
  assert.equal(encrypted[2].content, 'prior answer')
})

test('encryptMessages rejects non-string content', () => {
  const model = serverKeypair()
  assert.throws(
    () => encryptMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }], model.pubKeyHex),
    /non-text/
  )
})

test('fetchModelPubKey verifies the attestation and normalizes the signing key', async (t) => {
  const calls = []
  const model = serverKeypair()
  mockFetch(t, async (url) => {
    calls.push(String(url))
    return jsonResponse({
      verified: true,
      nonce: new URL(String(url)).searchParams.get('nonce'),
      signing_key: model.pubKeyHex.slice(2), // 128 hex chars, no 04 prefix
    })
  })

  const pubKey = await fetchModelPubKey({ apiKey: 'key', modelId: 'e2ee-qwen3-5-122b-a10b' })
  assert.equal(pubKey, model.pubKeyHex)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('/tee/attestation?model=e2ee-qwen3-5-122b-a10b&nonce='))
})

test('fetchModelPubKey accepts an 04-prefixed uncompressed signing key', async (t) => {
  const model = serverKeypair()
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: model.pubKeyHex,
  }))

  const pubKey = await fetchModelPubKey({ apiKey: 'k', modelId: 'm' })
  assert.equal(pubKey, model.pubKeyHex)
})

test('fetchModelPubKey rejects an off-curve signing key', async (t) => {
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: `04${'ab'.repeat(64)}`,
  }))

  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /Invalid signing key/)
})

test('fetchModelPubKey rejects a malformed signing key', async (t) => {
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: 'ab'.repeat(60), // wrong length
  }))

  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /No signing key/)
})

test('fetchModelPubKey rejects a non-hex signing key', async (t) => {
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: `04${'zz'.repeat(64)}`,
  }))

  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /No signing key/)
})

test('fetchModelPubKey rejects a non-hex nonce', async (t) => {
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: 'g'.repeat(64),
    signing_key: '04'.repeat(65),
  }))

  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /nonce mismatch/)
})

test('fetchModelPubKey rejects a nonce mismatch', async (t) => {
  mockFetch(t, async () => jsonResponse({ verified: true, nonce: 'deadbeef', signing_key: 'ab'.repeat(65) }))
  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /nonce mismatch/)
})

test('fetchModelPubKey rejects a server-side verification failure', async (t) => {
  mockFetch(t, async () => jsonResponse({ verified: false, nonce: 'x', signing_key: 'ab'.repeat(65) }))
  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /verification failed/)
})

test('fetchModelPubKey rejects an attestation without a signing key', async (t) => {
  mockFetch(t, async (url) => jsonResponse({ verified: true, nonce: new URL(String(url)).searchParams.get('nonce') }))
  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /No signing key/)
}) 
test('fetchModelPubKey surfaces HTTP errors', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 }))
  await assert.rejects(fetchModelPubKey({ apiKey: 'k', modelId: 'm' }), /unauthorized/)
})

test('createE2eeSession returns the client key pair and the attested model key', async (t) => {
  const model = serverKeypair()
  mockFetch(t, async (url) => jsonResponse({
    verified: true,
    nonce: new URL(String(url)).searchParams.get('nonce'),
    signing_key: model.pubKeyHex,
  }))
  const session = await createE2eeSession({ apiKey: 'k', modelId: 'm' })
  assert.ok(session.clientKey)
  assert.equal(session.clientPubKeyHex.length, 130)
  assert.equal(session.modelPubKeyHex, model.pubKeyHex)
})
