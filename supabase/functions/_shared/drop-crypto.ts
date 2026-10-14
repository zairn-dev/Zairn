/**
 * GeoDrop content crypto for Edge Functions. MUST stay byte-compatible with
 * packages/geo-drop/src/crypto.ts — drops encrypted by one side are decrypted
 * by the other (packages/geo-drop/test/edge-crypto-compat.test.ts checks it).
 *
 *   payload  = { ciphertext, iv, salt } (base64); AES-256-GCM, 12-byte IV,
 *              key = PBKDF2-SHA256(password, 16-byte salt, 100k iterations)
 *   password = "salt_b64:hash_b64", PBKDF2-SHA256 100k, 256-bit; legacy
 *              unsalted SHA-256 hashes are still accepted for old drops
 *
 * Uses only Web Crypto + atob/btoa (no Deno APIs), so Node can import it too.
 */

export interface EncryptedPayload {
  ciphertext: string
  iv: string
  salt: string
}

export type KeyDerivationVersion = 1 | 2
export const CURRENT_KEY_VERSION: KeyDerivationVersion = 2

const PBKDF2_ITERATIONS = 100_000
const SALT_LENGTH = 16
const IV_LENGTH = 12

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Random hex string, as the SDK uses for geo_drops.encryption_salt. */
export function randomHex(byteLength: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Location key derivation, identical to the SDK's deriveLocationKey:
 *   v1: geodrop:{geohash}:{dropId}:{salt}:{secret}
 *   v2: geodrop-v2:{len:field|...}:{secret}   (length-prefixed, delimiter-safe)
 */
export function deriveLocationKey(
  geohash: string,
  dropId: string,
  salt: string,
  serverSecret: string,
  version: number,
): string {
  if (version >= 2) {
    const encoded = [geohash, dropId, salt].map((f) => `${f.length}:${f}`).join('|')
    return `geodrop-v2:${encoded}:${serverSecret}`
  }
  return `geodrop:${geohash}:${dropId}:${salt}:${serverSecret}`
}

async function pbkdf2AesKey(password: string, salt: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  )
}

export async function encrypt(plaintext: string, password: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await pbkdf2AesKey(password, salt, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext) as BufferSource,
  ))
  return { ciphertext: bytesToBase64(ciphertext), iv: bytesToBase64(iv), salt: bytesToBase64(salt) }
}

export async function decrypt(payload: EncryptedPayload, password: string): Promise<string> {
  const key = await pbkdf2AesKey(password, base64ToBytes(payload.salt), ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) as BufferSource },
    key,
    base64ToBytes(payload.ciphertext) as BufferSource,
  )
  return new TextDecoder().decode(plaintext)
}

async function pbkdf2Bits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  ))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  return `${bytesToBase64(salt)}:${bytesToBase64(await pbkdf2Bits(password, salt))}`
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.includes(':')) {
    // Legacy unsalted SHA-256 — constant-time compare
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password)))
    return constantTimeEqual(hash, base64ToBytes(storedHash))
  }
  const [saltB64, hashB64] = storedHash.split(':')
  return constantTimeEqual(await pbkdf2Bits(password, base64ToBytes(saltB64)), base64ToBytes(hashB64))
}
