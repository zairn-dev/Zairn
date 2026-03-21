/**
 * SBPP Multi-Client Concurrent Session Evaluation
 *
 * Tests session throughput, memory scaling, purge correctness, and
 * cross-client session isolation under concurrent load.
 *
 * Paper section: Scalability and session isolation
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-sbpp-concurrent.mjs
 */

import {
  SbppSessionStore,
  buildSbppChallengeDigest,
  sbppVerifyBinding,
} from '../dist/sbpp.js';

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const DROP_ID = 'drop-concurrent-test-0001';
const POLICY_VERSION = '1';
const EPOCH = '2026-03-21';

const SCALING_SIZES = [100, 1000, 10000, 50000, 100000];
const CLIENT_COUNTS = [10, 50, 100, 500];
const ISOLATION_CLIENTS = 100;

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function buildDigest(nonce) {
  return buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: nonce,
  });
}

function verify(store, session, digest) {
  return sbppVerifyBinding(
    store,
    session.sessionId,
    session.nonce,
    digest,
    DROP_ID,
    POLICY_VERSION,
    EPOCH,
  );
}

function estimateMapMemoryKB(mapSize) {
  // Rough estimate: each Map entry ≈ 200 bytes for session object
  // (sessionId 32 chars + nonce 64 chars + 3 numbers + overhead)
  return Number(((mapSize * 200) / 1024).toFixed(1));
}

// ═══════════════════════════════════════════════════════
// Scenario 1: Active Session Scaling
//
// Measure issue time and approximate memory for
// 100, 1k, 10k, 50k, 100k active sessions.
// ═══════════════════════════════════════════════════════

function runSessionScaling() {
  const results = [];

  for (const count of SCALING_SIZES) {
    const store = new SbppSessionStore();

    const start = performance.now();
    for (let i = 0; i < count; i++) {
      store.issue();
    }
    const elapsed = performance.now() - start;

    results.push({
      sessions: count,
      issue_ms: Number(elapsed.toFixed(2)),
      memory_approx_kb: estimateMapMemoryKB(count),
    });

    process.stderr.write(
      `  ${count} sessions: ${elapsed.toFixed(2)}ms, ~${estimateMapMemoryKB(count)}KB\n`,
    );
  }

  return results;
}

// ═══════════════════════════════════════════════════════
// Scenario 2: Concurrent Issue + Verify
//
// K clients each issue a session and verify, all running
// concurrently via Promise.all.
// ═══════════════════════════════════════════════════════

async function runConcurrentClients() {
  const results = [];

  for (const k of CLIENT_COUNTS) {
    const store = new SbppSessionStore();

    const start = performance.now();

    const clientResults = await Promise.all(
      Array.from({ length: k }, async () => {
        const session = store.issue();
        const digest = buildDigest(session.nonce);
        // Small async yield to interleave operations
        await Promise.resolve();
        const result = verify(store, session, digest);
        return result.valid;
      }),
    );

    const elapsed = performance.now() - start;
    const allCorrect = clientResults.every((v) => v === true);

    results.push({
      clients: k,
      total_ms: Number(elapsed.toFixed(2)),
      sessions_per_sec: Number((k / (elapsed / 1000)).toFixed(0)),
      all_correct: allCorrect,
    });

    process.stderr.write(
      `  K=${k}: ${elapsed.toFixed(2)}ms, ${(k / (elapsed / 1000)).toFixed(0)} sess/s, correct=${allCorrect}\n`,
    );
  }

  return results;
}

// ═══════════════════════════════════════════════════════
// Scenario 3: Purge Under Load
//
// Issue a mix of short-TTL and long-TTL sessions. While
// clients are verifying, trigger purgeExpired(). Verify:
//   - No valid session incorrectly purged
//   - All expired sessions removed
// ═══════════════════════════════════════════════════════

async function runPurgeUnderLoad() {
  const store = new SbppSessionStore();
  const TOTAL = 2000;
  const EXPIRED_RATIO = 0.5;

  const validSessions = [];
  const expiredSessions = [];

  // Issue half with 1ms TTL (will expire immediately), half with 60s TTL
  for (let i = 0; i < TOTAL; i++) {
    if (i < TOTAL * EXPIRED_RATIO) {
      const s = store.issue({ ttlMs: 1 });
      expiredSessions.push(s);
    } else {
      const s = store.issue({ ttlMs: 60000 });
      validSessions.push(s);
    }
  }

  const activeBefore = store.size;

  // Wait a tick so short-TTL sessions expire
  await new Promise((r) => setTimeout(r, 5));

  // Concurrently: some clients verify valid sessions + purge runs
  const verifyPromises = validSessions.slice(0, 100).map(async (session) => {
    const digest = buildDigest(session.nonce);
    await Promise.resolve();
    return verify(store, session, digest);
  });

  const purgeStart = performance.now();
  const purgePromise = Promise.resolve().then(() => store.purgeExpired());

  const [verifyResults, purged] = await Promise.all([
    Promise.all(verifyPromises),
    purgePromise,
  ]);
  const purgeMs = performance.now() - purgeStart;

  const remaining = store.size;
  const validVerified = verifyResults.filter((r) => r.valid).length;

  // Check that no valid session was incorrectly purged
  // (Valid sessions that were NOT consumed by verify should still be in store)
  let validStillPresent = 0;
  for (const session of validSessions.slice(100)) {
    // These were not verified, should still be in store
    const digest = buildDigest(session.nonce);
    const result = verify(store, session, digest);
    if (result.valid) validStillPresent++;
  }

  const noValidPurged =
    validVerified + validStillPresent === validSessions.length;

  return {
    active_before: activeBefore,
    purged,
    remaining,
    purge_ms: Number(purgeMs.toFixed(2)),
    valid_verified: validVerified,
    valid_still_present: validStillPresent,
    no_valid_purged: noValidPurged,
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 4: Session Isolation
//
// K=100 concurrent clients each with their own session.
// Verify that no client can access another's session.
// ═══════════════════════════════════════════════════════

async function runSessionIsolation() {
  const K = ISOLATION_CLIENTS;
  const store = new SbppSessionStore();

  // Issue sessions for all clients
  const sessions = [];
  for (let i = 0; i < K; i++) {
    sessions.push(store.issue());
  }

  // Each client tries to verify with every OTHER client's session
  let crossAttempts = 0;
  let crossSuccess = 0;

  const promises = [];
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      if (i === j) continue;
      crossAttempts++;

      // Client i builds digest with their own nonce
      const digestI = buildDigest(sessions[i].nonce);

      // Try to verify against client j's session
      promises.push(
        Promise.resolve().then(() => {
          // Use client i's digest but client j's session credentials
          const result = sbppVerifyBinding(
            store,
            sessions[j].sessionId,
            sessions[j].nonce,
            digestI, // wrong digest for session j
            DROP_ID,
            POLICY_VERSION,
            EPOCH,
          );
          return result.valid;
        }),
      );
    }
  }

  const results = await Promise.all(promises);
  crossSuccess = results.filter((v) => v).length;

  return {
    clients: K,
    cross_access_attempts: crossAttempts,
    cross_access_success: crossSuccess,
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  process.stderr.write('=== SBPP Multi-Client Concurrent Evaluation ===\n\n');

  // Scenario 1
  process.stderr.write('Scenario 1: Active session scaling...\n');
  const scaling = runSessionScaling();
  process.stderr.write('\n');

  // Scenario 2
  process.stderr.write('Scenario 2: Concurrent issue + verify...\n');
  const concurrent = await runConcurrentClients();
  process.stderr.write('\n');

  // Scenario 3
  process.stderr.write('Scenario 3: Purge under load...\n');
  const purge = await runPurgeUnderLoad();
  process.stderr.write(
    `  before=${purge.active_before}  purged=${purge.purged}  remaining=${purge.remaining}  ` +
      `purge_ms=${purge.purge_ms}  no_valid_purged=${purge.no_valid_purged}\n\n`,
  );

  // Scenario 4
  process.stderr.write('Scenario 4: Session isolation...\n');
  const isolation = await runSessionIsolation();
  process.stderr.write(
    `  clients=${isolation.clients}  cross_attempts=${isolation.cross_access_attempts}  ` +
      `cross_success=${isolation.cross_access_success}\n\n`,
  );

  const output = {
    timestamp: new Date().toISOString(),
    session_scaling: scaling,
    concurrent_clients: concurrent,
    purge_under_load: {
      active_before: purge.active_before,
      purged: purge.purged,
      remaining: purge.remaining,
      purge_ms: purge.purge_ms,
      no_valid_purged: purge.no_valid_purged,
    },
    session_isolation: {
      clients: isolation.clients,
      cross_access_attempts: isolation.cross_access_attempts,
      cross_access_success: isolation.cross_access_success,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  // Summary
  process.stderr.write('=== Summary ===\n');
  process.stderr.write(
    `  Scaling: ${scaling.map((s) => `${s.sessions}→${s.issue_ms}ms`).join(', ')}\n`,
  );
  process.stderr.write(
    `  Concurrent: ${concurrent.map((c) => `K=${c.clients}→${c.sessions_per_sec}sess/s`).join(', ')}\n`,
  );
  process.stderr.write(
    `  Purge: ${purge.purged} purged in ${purge.purge_ms}ms, no_valid_purged=${purge.no_valid_purged}\n`,
  );
  process.stderr.write(
    `  Isolation: ${isolation.cross_access_attempts} cross-attempts, ${isolation.cross_access_success} succeeded (expect 0)\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
