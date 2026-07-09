/**
 * SBPP Unlock Integration Tests
 *
 * Verifies that the search-authorized-proof (SAP) verification is wired into
 * the createGeoDrop() flow: unlockDropSbpp runs the P1/P2/P3 authorization
 * gate BEFORE any content unlock, and delegates to the standard unlock path
 * only when the gate passes.
 *
 * Supabase is stubbed so the gate logic can be exercised without a backend:
 * a passing gate falls through to getUserId(), which throws 'Not
 * authenticated' — distinct from the SBPP_AUTHORIZATION_FAILED the gate
 * raises on rejection. This lets us assert gate pass/fail without network.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('no user') }) },
    from: () => ({}),
  }),
}));

import { createGeoDrop } from '../src/core';

function makeSdk() {
  return createGeoDrop({
    supabaseUrl: 'http://localhost:54321',
    supabaseAnonKey: 'anon-key',
    allowInsecureNoSecret: true,
    encryptedSearchConfig: {
      searchKey: 'integration-test-search-key-0123456789abcdef',
      precisionLevels: [4, 5, 6],
    },
  });
}

const LAT = 35.6893;
const LON = 139.7762;

describe('SBPP unlock wiring in createGeoDrop', () => {
  it('exposes the SBPP session/search/authorize/unlock methods', () => {
    const sdk = makeSdk();
    expect(typeof sdk.initSearchSession).toBe('function');
    expect(typeof sdk.findNearbyDropsSbpp).toBe('function');
    expect(typeof sdk.buildSearchAuthorization).toBe('function');
    expect(typeof sdk.unlockDropSbpp).toBe('function');
  });

  it('rejects an unlock whose proof digest does not bind to the session (P1)', async () => {
    const sdk = makeSdk();
    const session = sdk.initSearchSession!();
    await expect(
      sdk.unlockDropSbpp!('drop-1', LAT, LON, 10, session, { challengeDigest: 'not-the-real-digest' }),
    ).rejects.toMatchObject({ code: 'SBPP_AUTHORIZATION_FAILED' });
  });

  it('rejects an unlock against an unknown/never-issued session (P3)', async () => {
    const sdk = makeSdk();
    const fakeSession = { sessionId: 'never-issued', nonce: 'deadbeef', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const auth = sdk.buildSearchAuthorization!(fakeSession, 'drop-1');
    await expect(
      sdk.unlockDropSbpp!('drop-1', LAT, LON, 10, fakeSession, auth),
    ).rejects.toMatchObject({ code: 'SBPP_AUTHORIZATION_FAILED' });
  });

  it('passes the gate for a well-formed authorization, then delegates to unlock', async () => {
    const sdk = makeSdk();
    const session = sdk.initSearchSession!();
    const auth = sdk.buildSearchAuthorization!(session, 'drop-1');
    let err: unknown;
    try {
      await sdk.unlockDropSbpp!('drop-1', LAT, LON, 10, session, auth);
    } catch (e) {
      err = e;
    }
    // Gate passed (would have thrown SBPP_AUTHORIZATION_FAILED otherwise);
    // the standard unlock path then fails at auth with a different error.
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).not.toBe('SBPP_AUTHORIZATION_FAILED');
    expect((err as Error).message).toMatch(/authenticat/i);
  });

  it('consumes the session after a passing gate (single-use, P3)', async () => {
    const sdk = makeSdk();
    const session = sdk.initSearchSession!();
    const auth = sdk.buildSearchAuthorization!(session, 'drop-1');
    // First call passes the gate (then fails at auth downstream)
    await sdk.unlockDropSbpp!('drop-1', LAT, LON, 10, session, auth).catch(() => {});
    // Second call: session already consumed → gate rejects
    await expect(
      sdk.unlockDropSbpp!('drop-1', LAT, LON, 10, session, auth),
    ).rejects.toMatchObject({ code: 'SBPP_AUTHORIZATION_FAILED' });
  });
});
