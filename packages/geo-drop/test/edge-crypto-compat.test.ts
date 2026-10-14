/**
 * The Edge Functions (create-drop / unlock-drop) and this SDK must agree
 * byte-for-byte on content encryption, password hashing and location-key
 * derivation, or drops created on one side cannot be opened on the other.
 */
import { describe, it, expect } from 'vitest';
import * as sdk from '../src/crypto';
import * as edge from '../../../supabase/functions/_shared/drop-crypto.ts';

describe('SDK ↔ Edge Function crypto compatibility', () => {
  it('derives identical location keys for v1 and v2', () => {
    for (const version of [1, 2] as const) {
      expect(edge.deriveLocationKey('xn76urx', 'drop-1', 'ab12', 'secret', version))
        .toBe(sdk.deriveLocationKey('xn76urx', 'drop-1', 'ab12', 'secret', version));
    }
    expect(edge.CURRENT_KEY_VERSION).toBe(sdk.CURRENT_KEY_VERSION);
  });

  it('decrypts in either direction', async () => {
    const key = sdk.deriveLocationKey('xn76urx', 'drop-1', 'ab12', 'secret', 2);
    const text = 'こんにちは 🗺️ treasure';
    expect(await sdk.decrypt(await edge.encrypt(text, key), key)).toBe(text);
    expect(await edge.decrypt(await sdk.encrypt(text, key), key)).toBe(text);
  });

  it('verifies password hashes in either direction', async () => {
    expect(await sdk.verifyPassword('pw', await edge.hashPassword('pw'))).toBe(true);
    expect(await edge.verifyPassword('pw', await sdk.hashPassword('pw'))).toBe(true);
    expect(await edge.verifyPassword('nope', await sdk.hashPassword('pw'))).toBe(false);
  });
});
