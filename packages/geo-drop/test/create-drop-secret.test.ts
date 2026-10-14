/**
 * Regression test for the 2026-07-09 fix: createDrop() must never persist a
 * plaintext `secret`-method requirement into proof_config. It hashes it into
 * proof_secret_hashes (server-only column) and strips params.secret.
 */
import { describe, it, expect, vi } from 'vitest';

let insertedPayload: Record<string, unknown> | undefined;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'geo_drops') {
        return {
          insert: (payload: Record<string, unknown>) => {
            insertedPayload = payload;
            return {
              select: () => ({
                single: async () => ({ data: { ...payload, id: payload.id }, error: null }),
              }),
            };
          },
        };
      }
      // drop_location_logs and anything else: accept silently
      return { insert: async () => ({ data: null, error: null }) };
    },
  }),
}));

import { createGeoDrop } from '../src/core';

function makeSdk() {
  return createGeoDrop({
    supabaseUrl: 'http://localhost:54321',
    supabaseAnonKey: 'anon-key',
    allowInsecureNoSecret: true,
  });
}

describe('createDrop — secret requirement sanitization', () => {
  it('strips the plaintext secret from proof_config and stores a hash instead', async () => {
    insertedPayload = undefined;
    const sdk = makeSdk();

    await sdk.createDrop(
      {
        title: 'Gate',
        content_type: 'text',
        lat: 35.0,
        lon: 139.0,
        proof_config: {
          mode: 'all',
          requirements: [{ method: 'secret', params: { secret: 'super-secret-value', label: 'Gate code' } }],
        },
      },
      'hello world',
    );

    expect(insertedPayload).toBeDefined();
    const storedProofConfig = insertedPayload!.proof_config as { requirements: Array<{ params: Record<string, unknown> }> };
    expect(storedProofConfig.requirements[0].params.secret).toBeUndefined();
    expect(storedProofConfig.requirements[0].params.label).toBe('Gate code');

    const storedHashes = insertedPayload!.proof_secret_hashes as Record<string, string>;
    expect(storedHashes['0']).toBeTypeOf('string');
    expect(storedHashes['0']).toContain(':'); // salt:hash PBKDF2 format
    expect(storedHashes['0']).not.toContain('super-secret-value');
  });

  it('leaves proof_config untouched when there is no secret requirement', async () => {
    insertedPayload = undefined;
    const sdk = makeSdk();

    await sdk.createDrop(
      { title: 'GPS only', content_type: 'text', lat: 35.0, lon: 139.0 },
      'hello world',
    );

    expect(insertedPayload!.proof_config).toBeNull();
    expect(insertedPayload!.proof_secret_hashes).toBeNull();
  });
});
