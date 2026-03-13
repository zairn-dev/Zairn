/**
 * Encryption/decryption utilities
 * Foundation for the mechanism that only provides decryption keys after geofence verification
 */
import type { EncryptedPayload } from './types';

// Web Crypto API based encryption (browser + Node.js compatible)
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

/**
 * Derive an encryption key from a password (PBKDF2)
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const raw = encoder.encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate random bytes
 */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Convert byte array to Base64
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Convert Base64 to byte array
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt data
 * @param data Data to encrypt (string)
 * @param password Encryption password (geofence verification token or location-based key)
 */
export async function encrypt(data: string, password: string): Promise<EncryptedPayload> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(password, salt);

  const encoder = new TextEncoder();
  const plainBytes = encoder.encode(data);
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
    key,
    plainBytes.buffer as ArrayBuffer
  );

  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
    salt: toBase64(salt),
  };
}

/**
 * Decrypt data
 */
export async function decrypt(payload: EncryptedPayload, password: string): Promise<string> {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);
  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Generate a salted PBKDF2-SHA256 hash of a password (for DB storage)
 * Format: "salt_base64:hash_base64"
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `${toBase64(salt)}:${toBase64(new Uint8Array(hash))}`;
}

/**
 * Constant-time byte array comparison (prevents timing attacks)
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

/**
 * Verify a password against a salted hash (constant-time comparison)
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  if (!storedHash.includes(':')) {
    // Legacy unsalted SHA-256 — constant-time compare on raw bytes
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password)));
    return constantTimeEqual(hash, fromBase64(storedHash));
  }
  const [saltB64, hashB64] = storedHash.split(':');
  const saltBytes = fromBase64(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  ));
  return constantTimeEqual(hash, fromBase64(hashB64));
}

/**
 * Generate a location-based encryption key.
 * Combines geohash + drop_id + salt + server secret to create a unique encryption key.
 * The serverSecret should be an environment variable (GEODROP_ENCRYPTION_SECRET)
 * that is only available server-side, making client-side decryption impossible
 * even if all DB columns are known.
 *
 * Exported for advanced use cases (custom unlock flows, testing).
 * In production, prefer the server-side unlock Edge Function.
 */
export function deriveLocationKey(geohash: string, dropId: string, salt: string, serverSecret?: string): string {
  const base = `geodrop:${geohash}:${dropId}:${salt}`;
  if (serverSecret) {
    return `${base}:${serverSecret}`;
  }
  // Fallback without server secret (development/self-hosted only)
  return base;
}
