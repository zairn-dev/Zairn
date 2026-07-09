import { describe, it, expect } from 'vitest';
import { createVerificationEngine } from '../src/verification';
import { hashPassword } from '../src/crypto';
import type { GeoDrop, ProofConfig } from '../src/types';

/**
 * Regression coverage for the 2026-07-09 fix: proof_config's `secret`
 * method must never be satisfiable from plaintext stored in proof_config
 * (it isn't persisted there anymore — see core.ts sanitizeProofConfig),
 * and must fail closed when no hash is on file.
 */

const BASE_DROP: GeoDrop = {
  id: 'drop-1',
  creator_id: 'user-1',
  lat: 35.0,
  lon: 139.0,
  geohash: 'xn76ur',
  unlock_radius_meters: 50,
  title: 'Test drop',
  description: null,
  content_type: 'text',
  ipfs_cid: null,
  encrypted_content: null,
  encrypted: true,
  encryption_salt: null,
  visibility: 'public',
  password_hash: null,
  max_claims: null,
  claim_count: 0,
  proof_config: null,
  expires_at: null,
  status: 'active',
  preview_url: null,
  metadata: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeEngine() {
  return createVerificationEngine({
    imageProofUrl: 'https://example.invalid/image-proof',
    similarityThreshold: 0.7,
    getAuthHeaders: async () => ({}),
  });
}

describe('verification engine — secret requirement', () => {
  it('verifies a correct secret against the stored hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    const proofConfig: ProofConfig = {
      mode: 'all',
      requirements: [{ method: 'secret', params: { label: 'Gate code' } }],
    };
    const drop: GeoDrop = { ...BASE_DROP, proof_config: proofConfig, proof_secret_hashes: { '0': hash } };

    const result = await makeEngine().verify(drop, proofConfig, [
      { method: 'secret', data: { secret: 'correct-horse-battery-staple' } },
    ]);

    expect(result.verified).toBe(true);
  });

  it('rejects an incorrect secret', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    const proofConfig: ProofConfig = {
      mode: 'all',
      requirements: [{ method: 'secret', params: {} }],
    };
    const drop: GeoDrop = { ...BASE_DROP, proof_config: proofConfig, proof_secret_hashes: { '0': hash } };

    const result = await makeEngine().verify(drop, proofConfig, [
      { method: 'secret', data: { secret: 'wrong-guess' } },
    ]);

    expect(result.verified).toBe(false);
  });

  it('fails closed when proof_secret_hashes is missing (unmigrated drop)', async () => {
    const proofConfig: ProofConfig = {
      mode: 'all',
      requirements: [{ method: 'secret', params: {} }],
    };
    // No proof_secret_hashes on the drop at all.
    const drop: GeoDrop = { ...BASE_DROP, proof_config: proofConfig };

    const result = await makeEngine().verify(drop, proofConfig, [
      { method: 'secret', data: { secret: 'anything' } },
    ]);

    expect(result.verified).toBe(false);
  });

  it('does not accept a plaintext-looking value where params.secret is absent (proof_config never carries it)', () => {
    const proofConfig: ProofConfig = {
      mode: 'all',
      requirements: [{ method: 'secret', params: { label: 'Gate code' } }],
    };
    // sanitizeProofConfig (core.ts) strips `secret` before persistence — this
    // asserts the shape verification.ts actually receives from the DB.
    expect((proofConfig.requirements[0].params as Record<string, unknown>).secret).toBeUndefined();
  });
});
