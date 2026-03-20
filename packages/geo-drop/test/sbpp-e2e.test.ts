/**
 * SBPP End-to-End Integration Tests
 *
 * Tests the full flow: session creation → encrypted search → ZKP context
 * binding → server-side verification, ensuring all components work together.
 */

import { describe, it, expect } from 'vitest';
import {
  createSession,
  isSessionValid,
  SbppSessionStore,
  buildSbppChallengeDigest,
  verifySbppBinding,
  sbppVerifyBinding,
  sbppMatch,
  computeResultSetDigest,
  MerkleResultSet,
  SbppAuditLog,
} from '../src/sbpp';
import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
} from '../src/encrypted-search';
import { lengthPrefixEncode } from '../src/zkp';
import type { EncryptedSearchConfig, LocationIndexTokens } from '../src/encrypted-search';

const searchConfig: EncryptedSearchConfig = {
  searchKey: 'e2e-test-key-sbpp',
  precisionLevels: [4, 5, 6],
};

// Tokyo area test coordinates
const TOKYO = { lat: 35.6893, lon: 139.7762 };
const NEARBY = { lat: 35.6895, lon: 139.7764 }; // ~25m away
const OSAKA = { lat: 34.69, lon: 135.50 }; // ~400km away

describe('SBPP End-to-End Flow', () => {
  it('completes the full search → match → bind → verify flow', async () => {
    const store = new SbppSessionStore();

    // Step 1: Server issues a session
    const session = store.issue({ ttlMs: 60_000 });
    expect(session.nonce).toHaveLength(64); // 32 bytes hex

    // Step 2: Drop creator indexed a drop at TOKYO
    const dropTokens = await generateIndexTokens(
      TOKYO.lat, TOKYO.lon, searchConfig,
    );
    expect(dropTokens.tokens).toHaveLength(3);

    // Step 3: Client searches from NEARBY (within range)
    const searchTokens = await generateSearchTokens(
      NEARBY.lat, NEARBY.lon, 1000, searchConfig,
    );

    // Step 4: Server matches tokens
    const matches = matchTokens(searchTokens, [
      { dropId: 'drop-001', tokens: dropTokens },
    ]);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].dropId).toBe('drop-001');

    // Step 5: Client builds SBPP challenge digest with session nonce
    const digest = buildSbppChallengeDigest({
      dropId: 'drop-001',
      policyVersion: '1',
      epoch: '42',
      sessionNonce: session.nonce,
    });
    expect(typeof digest).toBe('string');
    expect(digest.length).toBeGreaterThan(0);

    // Step 6: Server verifies binding
    const result = sbppVerifyBinding(
      store,
      session.sessionId,
      session.nonce,
      digest,
      'drop-001',
      '1',
      '42',
    );
    expect(result.valid).toBe(true);

    // Step 7: Session is consumed — second attempt fails
    const result2 = sbppVerifyBinding(
      store,
      session.sessionId,
      session.nonce,
      digest,
      'drop-001',
      '1',
      '42',
    );
    expect(result2.valid).toBe(false);
    expect(result2.reason).toBe('invalid_session');
  });

  it('rejects proof from a different search session', async () => {
    const store = new SbppSessionStore();

    // Two sessions
    const session1 = store.issue();
    const session2 = store.issue();

    // Digest built with session1's nonce
    const digest1 = buildSbppChallengeDigest({
      dropId: 'drop-001',
      policyVersion: '1',
      epoch: '42',
      sessionNonce: session1.nonce,
    });

    // Attempt to verify against session2
    const result = sbppVerifyBinding(
      store,
      session2.sessionId,
      session2.nonce,
      digest1, // ← built with session1's nonce
      'drop-001',
      '1',
      '42',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('rejects proof after session expiry', async () => {
    const store = new SbppSessionStore();
    const session = store.issue({ ttlMs: 1 }); // 1ms TTL

    // Wait for expiry
    await new Promise(r => setTimeout(r, 10));

    const digest = buildSbppChallengeDigest({
      dropId: 'drop-001',
      policyVersion: '1',
      epoch: '42',
      sessionNonce: session.nonce,
    });

    const result = sbppVerifyBinding(
      store,
      session.sessionId,
      session.nonce,
      digest,
      'drop-001',
      '1',
      '42',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_session');
  });

  it('search does not match far-away drops', async () => {
    // Index a drop at OSAKA
    const osakaTokens = await generateIndexTokens(
      OSAKA.lat, OSAKA.lon, searchConfig,
    );

    // Search from TOKYO
    const searchTokens = await generateSearchTokens(
      TOKYO.lat, TOKYO.lon, 1000, searchConfig,
    );

    const matches = matchTokens(searchTokens, [
      { dropId: 'drop-osaka', tokens: osakaTokens },
    ]);
    expect(matches).toHaveLength(0);
  });

  it('digest includes session nonce in LP encoding', () => {
    const nonce1 = 'aabbccdd';
    const nonce2 = 'eeff0011';

    const digest1 = buildSbppChallengeDigest({
      dropId: 'drop-001', policyVersion: '1', epoch: '42',
      sessionNonce: nonce1,
    });
    const digest2 = buildSbppChallengeDigest({
      dropId: 'drop-001', policyVersion: '1', epoch: '42',
      sessionNonce: nonce2,
    });

    expect(digest1).not.toBe(digest2);

    // Verify LP encoding includes domain separator + nonce
    const expected1 = lengthPrefixEncode('SBPP-v1', 'drop-001', '1', '42', nonce1);
    const expected2 = lengthPrefixEncode('SBPP-v1', 'drop-001', '1', '42', nonce2);
    expect(digest1).toBe(expected1);
    expect(digest2).toBe(expected2);

    // Verify SBPP digest differs from non-SBPP digest (downgrade prevention)
    const nonSbpp = lengthPrefixEncode('drop-001', '1', '42', nonce1);
    expect(digest1).not.toBe(nonSbpp);
  });

  it('multiple drops at same location: session binds to specific drop', async () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    // Two drops at same location
    const tokens1 = await generateIndexTokens(TOKYO.lat, TOKYO.lon, searchConfig);
    const tokens2 = await generateIndexTokens(TOKYO.lat, TOKYO.lon, searchConfig);

    const searchTokens = await generateSearchTokens(
      NEARBY.lat, NEARBY.lon, 1000, searchConfig,
    );

    const matches = matchTokens(searchTokens, [
      { dropId: 'drop-A', tokens: tokens1 },
      { dropId: 'drop-B', tokens: tokens2 },
    ]);
    expect(matches.length).toBeGreaterThanOrEqual(2);

    // Build digest for drop-A
    const digestA = buildSbppChallengeDigest({
      dropId: 'drop-A', policyVersion: '1', epoch: '42',
      sessionNonce: session.nonce,
    });

    // Verify for drop-A → succeeds
    const resultA = sbppVerifyBinding(
      store, session.sessionId, session.nonce,
      digestA, 'drop-A', '1', '42',
    );
    expect(resultA.valid).toBe(true);

    // Session consumed → new session needed for drop-B
    const session2 = store.issue();
    const digestB = buildSbppChallengeDigest({
      dropId: 'drop-B', policyVersion: '1', epoch: '42',
      sessionNonce: session2.nonce,
    });
    const resultB = sbppVerifyBinding(
      store, session2.sessionId, session2.nonce,
      digestB, 'drop-B', '1', '42',
    );
    expect(resultB.valid).toBe(true);
  });
});

describe('SBPP Result-Set Binding', () => {
  it('binds proof to the result set via sbppMatch', async () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    // Index a drop and search
    const tokens = await generateIndexTokens(TOKYO.lat, TOKYO.lon, searchConfig);
    const searchTokens = await generateSearchTokens(NEARBY.lat, NEARBY.lon, 1000, searchConfig);

    // sbppMatch records the result-set digest in the session
    const matches = sbppMatch(
      searchTokens,
      [{ dropId: 'drop-001', tokens }],
      store,
      session.sessionId,
      session.nonce,
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // Get the stored result digest
    const resultDigest = store.getResultDigest(session.sessionId);
    expect(resultDigest).toBeDefined();

    // Build challenge digest WITH result-set binding
    const digest = buildSbppChallengeDigest({
      dropId: 'drop-001',
      policyVersion: '1',
      epoch: '42',
      sessionNonce: session.nonce,
      resultSetDigest: resultDigest,
    });

    // Verify — should succeed
    const result = sbppVerifyBinding(
      store, session.sessionId, session.nonce,
      digest, 'drop-001', '1', '42',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects proof with wrong result-set digest', async () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    const tokens = await generateIndexTokens(TOKYO.lat, TOKYO.lon, searchConfig);
    const searchTokens = await generateSearchTokens(NEARBY.lat, NEARBY.lon, 1000, searchConfig);

    sbppMatch(
      searchTokens,
      [{ dropId: 'drop-001', tokens }],
      store,
      session.sessionId,
      session.nonce,
    );

    // Build digest with WRONG result-set digest (attacker fabricates)
    const digest = buildSbppChallengeDigest({
      dropId: 'drop-001',
      policyVersion: '1',
      epoch: '42',
      sessionNonce: session.nonce,
      resultSetDigest: 'fake-result-digest',
    });

    const result = sbppVerifyBinding(
      store, session.sessionId, session.nonce,
      digest, 'drop-001', '1', '42',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('computeResultSetDigest is order-independent', () => {
    const d1 = computeResultSetDigest('session-1', ['drop-B', 'drop-A', 'drop-C'], 5);
    const d2 = computeResultSetDigest('session-1', ['drop-A', 'drop-C', 'drop-B'], 5);
    expect(d1).toBe(d2); // sorted internally
  });

  it('computeResultSetDigest differs for different result sets', () => {
    const d1 = computeResultSetDigest('session-1', ['drop-A', 'drop-B'], 5);
    const d2 = computeResultSetDigest('session-1', ['drop-A', 'drop-C'], 5);
    expect(d1).not.toBe(d2);
  });
});

describe('SBPP Merkle Result Set', () => {
  it('builds tree and generates valid proof', () => {
    const tree = new MerkleResultSet(['drop-A', 'drop-B', 'drop-C']);
    const proof = tree.prove('drop-B');
    expect(proof).not.toBeNull();
    expect(MerkleResultSet.verify(proof!)).toBe(true);
  });

  it('rejects non-member', () => {
    const tree = new MerkleResultSet(['drop-A', 'drop-B']);
    const proof = tree.prove('drop-C');
    expect(proof).toBeNull();
  });

  it('root is deterministic regardless of input order', () => {
    const tree1 = new MerkleResultSet(['drop-B', 'drop-A', 'drop-C']);
    const tree2 = new MerkleResultSet(['drop-A', 'drop-B', 'drop-C']);
    expect(tree1.root).toBe(tree2.root);
  });

  it('single-element tree works', () => {
    const tree = new MerkleResultSet(['drop-only']);
    const proof = tree.prove('drop-only');
    expect(proof).not.toBeNull();
    expect(MerkleResultSet.verify(proof!)).toBe(true);
  });

  it('empty tree', () => {
    const tree = new MerkleResultSet([]);
    expect(tree.root).toBe('');
  });

  it('large tree', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `drop-${String(i).padStart(4, '0')}`);
    const tree = new MerkleResultSet(ids);
    for (const id of ids) {
      const proof = tree.prove(id);
      expect(proof).not.toBeNull();
      expect(MerkleResultSet.verify(proof!)).toBe(true);
    }
  });
});

describe('SBPP Audit Log', () => {
  it('records and audits successfully', () => {
    const tree = new MerkleResultSet(['drop-A', 'drop-B', 'drop-C']);
    const proof = tree.prove('drop-B')!;
    expect(proof).not.toBeNull();

    const log = new SbppAuditLog();
    log.record({
      sessionId: 'session-1',
      dropId: 'drop-B',
      challengeDigest: 'digest-placeholder',
      merkleRoot: tree.root,
      merkleProof: proof,
      timestamp: Date.now(),
      verified: true,
    });

    const result = log.audit();
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.details[0].ok).toBe(true);
  });

  it('detects tampered Merkle proof', () => {
    const tree = new MerkleResultSet(['drop-A', 'drop-B', 'drop-C']);
    const proof = tree.prove('drop-B')!;
    expect(proof).not.toBeNull();

    // Tamper with a sibling in the proof path
    const tampered = {
      ...proof,
      path: proof.path.map((step, i) =>
        i === 0 ? { ...step, sibling: 'tampered-hash' } : step,
      ),
    };

    const log = new SbppAuditLog();
    log.record({
      sessionId: 'session-1',
      dropId: 'drop-B',
      challengeDigest: 'digest-placeholder',
      merkleRoot: tree.root,
      merkleProof: tampered,
      timestamp: Date.now(),
      verified: true,
    });

    const result = log.audit();
    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(1);
    expect(result.details[0].ok).toBe(false);
  });

  it('audit works without server state', () => {
    // Build tree and proofs entirely client-side
    const tree = new MerkleResultSet(['drop-X', 'drop-Y', 'drop-Z']);
    const log = new SbppAuditLog();

    for (const id of ['drop-X', 'drop-Y', 'drop-Z']) {
      const proof = tree.prove(id)!;
      log.record({
        sessionId: 'offline-session',
        dropId: id,
        challengeDigest: `digest-${id}`,
        merkleRoot: tree.root,
        merkleProof: proof,
        timestamp: Date.now(),
        verified: true,
      });
    }

    // audit() uses only transcript data — no SbppSessionStore needed
    const result = log.audit();
    expect(result.valid).toBe(3);
    expect(result.invalid).toBe(0);
    expect(result.details).toHaveLength(3);
    expect(result.details.every(d => d.ok)).toBe(true);
  });
});
