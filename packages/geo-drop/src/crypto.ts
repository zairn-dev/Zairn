/**
 * 暗号化・復号ユーティリティ
 * ジオフェンス検証後にのみ復号キーを渡す仕組みの基盤
 */
import type { EncryptedPayload } from './types';

// Web Crypto API ベースの暗号化（ブラウザ + Node.js 互換）
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

/**
 * パスワードから暗号鍵を導出（PBKDF2）
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
 * ランダムバイト生成
 */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * バイト配列をBase64に変換
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64をバイト配列に変換
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * データを暗号化
 * @param data 暗号化するデータ（文字列）
 * @param password 暗号化パスワード（ジオフェンス検証トークンや位置ベースのキー）
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
 * データを復号
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
 * パスワードのSHA-256ハッシュを生成（DB保存用）
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(password));
  return toBase64(new Uint8Array(hash));
}

/**
 * 位置ベースの暗号化キーを生成
 * geohash + drop_id + salt を組み合わせてユニークな暗号鍵を作る
 */
export function deriveLocationKey(geohash: string, dropId: string, salt: string): string {
  return `geodrop:${geohash}:${dropId}:${salt}`;
}
