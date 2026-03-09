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
 * Generate a SHA-256 hash of a password (for DB storage)
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  return toBase64(new Uint8Array(hash));
}

/**
 * Generate a location-based encryption key
 * Combines geohash + drop_id + salt to create a unique encryption key
 */
export function deriveLocationKey(geohash: string, dropId: string, salt: string): string {
  return `geodrop:${geohash}:${dropId}:${salt}`;
}
