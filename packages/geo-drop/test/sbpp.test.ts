import { describe, it, expect } from 'vitest';
import {
  createSession,
  isSessionValid,
  SbppSessionStore,
  buildSbppChallengeDigest,
  verifySbppBinding,
  sbppSearch,
  sbppVerifyBinding,
} from '../src/sbpp';
import type { SbppProofContext, EncryptedSearchConfig } from '../src/sbpp';

const searchConfig: EncryptedSearchConfig = {
  searchKey: 'test-secret-key-for-sbpp',
  precisionLevels: [4, 5, 6],
};

// ---------------------------------------------------------------------------
// 1. Session management
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('generates a session with unique ID and nonce', () => {
    const s = createSession();
    expect(s.sessionId).toMatch(/^[0-9a-f]{32}$/); // 16 bytes = 32 hex chars
    expect(s.nonce).toMatch(/^[0-9a-f]{64}$/);     // 32 bytes = 64 hex chars
    expect(s.createdAt).toBeLessThanOrEqual(Date.now());
    expect(s.expiresAt).toBeGreaterThan(s.createdAt);
  });

  it('generates unique IDs across calls', () => {
    const a = createSession();
    const b = createSession();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('respects configurable TTL', () => {
    const s = createSession({ ttlMs: 1000 });
    expect(s.expiresAt - s.createdAt).toBe(1000);
  });

  it('defaults to 5-minute TTL', () => {
    const s = createSession();
    expect(s.expiresAt - s.createdAt).toBe(5 * 60 * 1000);
  });
});

describe('isSessionValid', () => {
  it('returns true for a fresh session', () => {
    const s = createSession();
    expect(isSessionValid(s)).toBe(true);
  });

  it('returns false for an expired session', () => {
    const s = createSession({ ttlMs: 1 });
    // Check at a time well past expiry
    expect(isSessionValid(s, s.expiresAt + 1000)).toBe(false);
  });

  it('returns false when checked exactly at expiresAt boundary', () => {
    const s = createSession({ ttlMs: 100 });
    // At exactly expiresAt, (now < expiresAt) is false
    expect(isSessionValid(s, s.expiresAt)).toBe(false);
  });

  it('returns true just before expiry', () => {
    const s = createSession({ ttlMs: 100 });
    expect(isSessionValid(s, s.expiresAt - 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. SbppSessionStore
// ---------------------------------------------------------------------------

describe('SbppSessionStore', () => {
  it('issue() creates and stores a session', () => {
    const store = new SbppSessionStore();
    const s = store.issue();
    expect(s.sessionId).toBeTruthy();
    expect(store.size).toBe(1);
  });

  it('validate() returns true for valid session + nonce pair', () => {
    const store = new SbppSessionStore();
    const s = store.issue();
    expect(store.validate(s.sessionId, s.nonce)).toBe(true);
  });

  it('validate() returns false for wrong nonce', () => {
    const store = new SbppSessionStore();
    const s = store.issue();
    expect(store.validate(s.sessionId, 'wrong-nonce')).toBe(false);
  });

  it('validate() returns false for expired session', () => {
    const store = new SbppSessionStore();
    const s = store.issue({ ttlMs: 1 });
    // Validate at a time past expiry
    expect(store.validate(s.sessionId, s.nonce, s.expiresAt + 1000)).toBe(false);
    // Expired session should be purged from the store
    expect(store.size).toBe(0);
  });

  it('validate() returns false for unknown session ID', () => {
    const store = new SbppSessionStore();
    expect(store.validate('nonexistent-id', 'any-nonce')).toBe(false);
  });

  it('consume() removes the session', () => {
    const store = new SbppSessionStore();
    const s = store.issue();
    expect(store.consume(s.sessionId)).toBe(true);
    expect(store.size).toBe(0);
    // Session should no longer validate
    expect(store.validate(s.sessionId, s.nonce)).toBe(false);
  });

  it('consume() returns false for already-consumed session', () => {
    const store = new SbppSessionStore();
    const s = store.issue();
    store.consume(s.sessionId);
    expect(store.consume(s.sessionId)).toBe(false);
  });

  it('purgeExpired() removes expired sessions', () => {
    const store = new SbppSessionStore();
    const s1 = store.issue({ ttlMs: 1 });
    const s2 = store.issue({ ttlMs: 1 });
    store.issue({ ttlMs: 60_000 }); // long-lived session

    expect(store.size).toBe(3);

    // Purge at a time past the short-lived sessions' expiry
    const futureTime = Math.max(s1.expiresAt, s2.expiresAt) + 1000;
    const purged = store.purgeExpired(futureTime);

    expect(purged).toBe(2);
    expect(store.size).toBe(1);
  });

  it('purgeExpired() returns 0 when no sessions are expired', () => {
    const store = new SbppSessionStore();
    store.issue({ ttlMs: 60_000 });
    expect(store.purgeExpired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Challenge digest / binding
// ---------------------------------------------------------------------------

describe('buildSbppChallengeDigest', () => {
  const baseCtx: SbppProofContext = {
    dropId: 'drop-001',
    policyVersion: 'v1',
    epoch: '2026-03-19',
    sessionNonce: 'a'.repeat(64),
  };

  it('is deterministic (same inputs produce same output)', () => {
    const a = buildSbppChallengeDigest(baseCtx);
    const b = buildSbppChallengeDigest(baseCtx);
    expect(a).toBe(b);
  });

  it('differs when dropId changes', () => {
    const a = buildSbppChallengeDigest(baseCtx);
    const b = buildSbppChallengeDigest({ ...baseCtx, dropId: 'drop-002' });
    expect(a).not.toBe(b);
  });

  it('differs when policyVersion changes', () => {
    const a = buildSbppChallengeDigest(baseCtx);
    const b = buildSbppChallengeDigest({ ...baseCtx, policyVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it('differs when epoch changes', () => {
    const a = buildSbppChallengeDigest(baseCtx);
    const b = buildSbppChallengeDigest({ ...baseCtx, epoch: '2026-03-20' });
    expect(a).not.toBe(b);
  });

  it('differs when sessionNonce changes', () => {
    const a = buildSbppChallengeDigest(baseCtx);
    const b = buildSbppChallengeDigest({ ...baseCtx, sessionNonce: 'b'.repeat(64) });
    expect(a).not.toBe(b);
  });
});

describe('verifySbppBinding', () => {
  const ctx: SbppProofContext = {
    dropId: 'drop-001',
    policyVersion: 'v1',
    epoch: '2026-03-19',
    sessionNonce: 'c'.repeat(64),
  };

  it('returns true for matching context', () => {
    const digest = buildSbppChallengeDigest(ctx);
    expect(verifySbppBinding(digest, ctx)).toBe(true);
  });

  it('returns false for mismatched nonce (KEY security property)', () => {
    const digest = buildSbppChallengeDigest(ctx);
    const altCtx = { ...ctx, sessionNonce: 'd'.repeat(64) };
    expect(verifySbppBinding(digest, altCtx)).toBe(false);
  });

  it('returns false for mismatched dropId', () => {
    const digest = buildSbppChallengeDigest(ctx);
    const altCtx = { ...ctx, dropId: 'drop-999' };
    expect(verifySbppBinding(digest, altCtx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Search flow
// ---------------------------------------------------------------------------

describe('sbppSearch', () => {
  it('generates search tokens for a valid session', async () => {
    const session = createSession();
    const result = await sbppSearch(35.68, 139.76, 5000, session, searchConfig);

    expect(result.session).toBe(session);
    expect(result.searchTokens.tokens.length).toBeGreaterThanOrEqual(1);
    for (const token of result.searchTokens.tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('throws for expired session', async () => {
    const session = createSession({ ttlMs: 1 });
    // Force expiry by manipulating expiresAt
    session.expiresAt = Date.now() - 1000;

    await expect(
      sbppSearch(35.68, 139.76, 5000, session, searchConfig),
    ).rejects.toThrow('SBPP session expired');
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end binding verification
// ---------------------------------------------------------------------------

describe('sbppVerifyBinding', () => {
  const dropId = 'drop-e2e';
  const pv = 'v1';
  const epoch = '2026-03-19';

  it('returns valid for correct session + digest', () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    const digest = buildSbppChallengeDigest({
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: session.nonce,
    });

    const result = sbppVerifyBinding(
      store, session.sessionId, session.nonce, digest, dropId, pv, epoch,
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns invalid for wrong session ID', () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    const digest = buildSbppChallengeDigest({
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: session.nonce,
    });

    const result = sbppVerifyBinding(
      store, 'wrong-session-id', session.nonce, digest, dropId, pv, epoch,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_session');
  });

  it('returns invalid for wrong nonce', () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    const digest = buildSbppChallengeDigest({
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: session.nonce,
    });

    const result = sbppVerifyBinding(
      store, session.sessionId, 'wrong-nonce', digest, dropId, pv, epoch,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_session');
  });

  it('returns invalid for wrong dropId in digest', () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    // Build digest with a DIFFERENT dropId than what we verify against
    const digest = buildSbppChallengeDigest({
      dropId: 'wrong-drop-id',
      policyVersion: pv,
      epoch,
      sessionNonce: session.nonce,
    });

    const result = sbppVerifyBinding(
      store, session.sessionId, session.nonce, digest, dropId, pv, epoch,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('consumes the session (second call fails)', () => {
    const store = new SbppSessionStore();
    const session = store.issue();

    const digest = buildSbppChallengeDigest({
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: session.nonce,
    });

    const first = sbppVerifyBinding(
      store, session.sessionId, session.nonce, digest, dropId, pv, epoch,
    );
    expect(first.valid).toBe(true);

    const second = sbppVerifyBinding(
      store, session.sessionId, session.nonce, digest, dropId, pv, epoch,
    );
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('invalid_session');
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-session isolation (CRITICAL)
// ---------------------------------------------------------------------------

describe('cross-session isolation', () => {
  const dropId = 'drop-isolation';
  const pv = 'v1';
  const epoch = '2026-03-19';

  it('proof context from session S1 is rejected in session S2', () => {
    const store = new SbppSessionStore();
    const s1 = store.issue();
    const s2 = store.issue();

    // Build digest with S1's nonce
    const digestS1 = buildSbppChallengeDigest({
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: s1.nonce,
    });

    // Try to verify using S2's credentials but S1's digest
    const result = sbppVerifyBinding(
      store, s2.sessionId, s2.nonce, digestS1, dropId, pv, epoch,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('binding_mismatch');
  });

  it('same drop, different sessions produce different challenge digests', () => {
    const s1 = createSession();
    const s2 = createSession();

    const ctx1: SbppProofContext = {
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: s1.nonce,
    };
    const ctx2: SbppProofContext = {
      dropId,
      policyVersion: pv,
      epoch,
      sessionNonce: s2.nonce,
    };

    const d1 = buildSbppChallengeDigest(ctx1);
    const d2 = buildSbppChallengeDigest(ctx2);

    expect(d1).not.toBe(d2);
  });
});
