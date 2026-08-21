import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { fetchWithRetry } from './http.js'
import { ApiError } from './errors.js'
import { VENICE_BASE } from './constants.js'

// Venice E2EE protocol (TEE attestation + client-side encryption):
// ECDH on secp256k1 for key agreement, HKDF-SHA256 for key derivation and
// AES-256-GCM for bulk encryption. Encrypted values are hex strings laid out
// as ephemeral public key (65 bytes, uncompressed) || nonce (12 bytes) ||
// ciphertext (with the 16-byte GCM tag appended). Only user and system role
// messages are encrypted; the response stream delivers one encrypted chunk
// per delta that decrypts with the client's session private key.

const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption')
const HKDF_SALT = Buffer.alloc(32)
const EPHEMERAL_PUB_BYTES = 65
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const MIN_ENCRYPTED_BYTES = EPHEMERAL_PUB_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES

function e2eeError(message) {
  return new ApiError(message, { retryable: false })
}

// E2EE response chunks and encrypted message content are hex strings of at
// least 93 bytes (65 + 12 + 16). Anything shorter or non-hex is plaintext.
export function isEncryptedHex(value) {
  return typeof value === 'string' && value.length >= 2 * MIN_ENCRYPTED_BYTES && /^[0-9a-fA-F]+$/.test(value)
}

// Creates the per-session client key pair. The private key lives in the
// returned ECDH object for the whole session; it is never persisted.
export function createE2eeClient() {
  const clientKey = createECDH('secp256k1')
  const clientPubKeyHex = clientKey.generateKeys('hex')
  return { clientKey, clientPubKeyHex }
}

function normalizeModelPubKey(hex) {
  if (typeof hex !== 'string') return null
  if (!hex.startsWith('04') && hex.length === 128) return `04${hex}`
  return hex.startsWith('04') ? hex : null
}

// Fetches and verifies the TEE attestation for a model and returns the
// enclave's public key. Verification failures are non-retryable: an
// unverified attestation must abort the session, never fall back to plaintext.
export async function fetchModelPubKey({ apiKey, modelId }) {
  const nonce = randomBytes(32).toString('hex')
  const url = `${VENICE_BASE}/tee/attestation?model=${encodeURIComponent(modelId)}&nonce=${nonce}`
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, {
    errorResponse: (status, body) => {
      let message = `TEE attestation request failed (HTTP ${status}).`
      try {
        const parsed = JSON.parse(body)
        message = `TEE attestation request failed: ${parsed?.error?.message || parsed?.message || `HTTP ${status}`}`
      } catch {
        // keep the generic message
      }
      return new ApiError(message, { retryable: false })
    },
  })
  const attestation = await res.json()
  if (attestation.verified !== true) {
    throw e2eeError('TEE attestation verification failed on server.')
  }
  if (attestation.nonce !== nonce) {
    throw e2eeError('TEE attestation nonce mismatch — possible replay attack.')
  }
  const modelPubKeyHex = normalizeModelPubKey(attestation.signing_key ?? attestation.signing_public_key)
  if (!modelPubKeyHex) {
    throw e2eeError('No signing key in TEE attestation response.')
  }
  return modelPubKeyHex
}

// Creates the full E2EE session context: one client key pair plus the model
// public key from the attested enclave. modelPubKeyHex must be refreshed
// when the active model changes.
export async function createE2eeSession({ apiKey, modelId }) {
  const { clientKey, clientPubKeyHex } = createE2eeClient()
  const modelPubKeyHex = await fetchModelPubKey({ apiKey, modelId })
  return { clientKey, clientPubKeyHex, modelPubKeyHex }
}

function deriveAesKey(clientKey, peerPubKey) {
  const sharedSecret = clientKey.computeSecret(peerPubKey)
  return hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, 32)
}

// Encrypts one message with a fresh ephemeral key pair, so the same plaintext
// never produces the same ciphertext and the client's session key is never
// used for the outbound ECDH.
export function encryptMessage(plaintext, modelPubKeyHex) {
  const ephemeral = createECDH('secp256k1')
  const ephemeralPub = ephemeral.generateKeys()
  const aesKey = deriveAesKey(ephemeral, Buffer.from(modelPubKeyHex, 'hex'))
  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([ephemeralPub, nonce, ciphertext]).toString('hex')
}

// Encrypts user and system messages in place. Assistant messages are the
// model's own output: the client keeps them decrypted (the per-chunk
// ciphertext is not persisted), so they are the only replayable form and are
// sent back as-is. User and system role content is always encrypted; on a
// resumed session only the historical assistant text is seen plaintext by
// the host.
export function encryptMessages(messages, modelPubKeyHex) {
  return messages.map((msg) => {
    if (msg.role !== 'user' && msg.role !== 'system') return msg
    if (typeof msg.content !== 'string') {
      throw e2eeError('E2EE cannot encrypt non-text message content.')
    }
    return { ...msg, content: encryptMessage(msg.content, modelPubKeyHex) }
  })
}

// Decrypts one hex-encoded response chunk using the client's session private
// key and the chunk's own ephemeral server public key.
export function decryptToken(encryptedHex, clientKey) {
  const raw = Buffer.from(encryptedHex, 'hex')
  if (raw.length < MIN_ENCRYPTED_BYTES) {
    throw e2eeError('E2EE response chunk is too short to decrypt.')
  }
  const serverEphemeralPub = raw.subarray(0, EPHEMERAL_PUB_BYTES)
  const nonce = raw.subarray(EPHEMERAL_PUB_BYTES, EPHEMERAL_PUB_BYTES + GCM_NONCE_BYTES)
  const ciphertext = raw.subarray(EPHEMERAL_PUB_BYTES + GCM_NONCE_BYTES)
  const aesKey = deriveAesKey(clientKey, serverEphemeralPub)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES)), decipher.final()]).toString('utf8')
}
