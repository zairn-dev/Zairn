import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, hashPassword, deriveLocationKey } from '../src/crypto';

describe('encrypt / decrypt round-trip', () => {
  it('encrypts and decrypts a short string', async () => {
    const plaintext = 'hello geo-drop';
    const password = 'test-password-123';
    const encrypted = await encrypt(plaintext, password);

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();
    expect(encrypted.ciphertext).not.toBe(plaintext);

    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts a long string', async () => {
    const plaintext = 'A'.repeat(10_000);
    const password = 'long-content-password';
    const encrypted = await encrypt(plaintext, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts unicode content', async () => {
    const plaintext = '日本語テスト 🌍🔐';
    const password = 'unicode-pw';
    const encrypted = await encrypt(plaintext, password);
    const decrypted = await decrypt(encrypted, password);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong password', async () => {
    const encrypted = await encrypt('secret', 'correct-password');
    await expect(decrypt(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('produces different ciphertexts for the same plaintext (random IV/salt)', async () => {
    const plaintext = 'same input';
    const password = 'same password';
    const a = await encrypt(plaintext, password);
    const b = await encrypt(plaintext, password);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
  });
});

describe('hashPassword', () => {
  it('produces a salted hash in salt:hash format', async () => {
    const hash = await hashPassword('my-password');
    expect(hash).toContain(':');
    const [salt, h] = hash.split(':');
    expect(salt.length).toBeGreaterThan(0);
    expect(h.length).toBeGreaterThan(0);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});

describe('deriveLocationKey', () => {
  it('produces deterministic key from inputs', () => {
    const key = deriveLocationKey('xn76ur', 'drop-123', 'salt-abc');
    expect(key).toBe('geodrop:xn76ur:drop-123:salt-abc');
  });

  it('includes server secret when provided', () => {
    const key = deriveLocationKey('xn76ur', 'drop-123', 'salt-abc', 'server-secret');
    expect(key).toBe('geodrop:xn76ur:drop-123:salt-abc:server-secret');
  });

  it('different inputs produce different keys', () => {
    const a = deriveLocationKey('xn76ur', 'drop-1', 'salt');
    const b = deriveLocationKey('xn76ur', 'drop-2', 'salt');
    expect(a).not.toBe(b);
  });
});
