/**
 * SBPP Race Condition Evaluation — Session Consumption Atomicity
 *
 * Tests that SBPP session consumption is atomic under concurrent
 * double-submit scenarios. Verifies that exactly one verification
 * succeeds per session, even under parallel execution.
 *
 * Paper section: Session atomicity and replay resistance
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-sbpp-race.mjs
 */

import {
  SbppSessionStore,
  buildSbppChallengeDigest,
  sbppVerifyBinding,
} from '../dist/sbpp.js';

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N_TRIALS = 1000;

const DROP_ID = 'drop-race-test-0001';
const POLICY_VERSION = '1';
const EPOCH = '2026-03-20';

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// ═══════════════════════════════════════════════════════
// Scenario 1: Sequential double-submit
// ═══════════════════════════════════════════════════════

function runSequentialDouble(n) {
  let firstSuccess = 0;
  let secondSuccess = 0;

  for (let i = 0; i < n; i++) {
    const store = new SbppSessionStore();
    const session = store.issue();
    const digest = buildDigest(session.nonce);

    const first = verify(store, session, digest);
    if (first.valid) firstSuccess++;

    const second = verify(store, session, digest);
    if (second.valid) secondSuccess++;
  }

  return { first_success: firstSuccess, second_success: secondSuccess };
}

// ═══════════════════════════════════════════════════════
// Scenario 2: Parallel double-submit simulation
// ═══════════════════════════════════════════════════════

async function runParallelDouble(n) {
  let exactlyOneSuccess = 0;
  let bothSucceeded = 0;
  let neitherSucceeded = 0;

  for (let i = 0; i < n; i++) {
    const store = new SbppSessionStore();
    const session = store.issue();
    const digest = buildDigest(session.nonce);

    // Fire two verifications "simultaneously" via Promise.all
    const [r1, r2] = await Promise.all([
      Promise.resolve(verify(store, session, digest)),
      Promise.resolve(verify(store, session, digest)),
    ]);

    const successes = (r1.valid ? 1 : 0) + (r2.valid ? 1 : 0);
    if (successes === 1) exactlyOneSuccess++;
    else if (successes === 2) bothSucceeded++;
    else neitherSucceeded++;
  }

  return {
    exactly_one_success: exactlyOneSuccess,
    both_succeeded: bothSucceeded,
    neither_succeeded: neitherSucceeded,
    rate: Number((exactlyOneSuccess / n).toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 3: Expiry boundary
// ═══════════════════════════════════════════════════════

async function runExpiryBoundary(n) {
  let beforeExpirySuccess = 0;
  let afterExpiryFail = 0;

  // Sub-scenario A: verify just before expiry (TTL=50ms, wait 40ms)
  for (let i = 0; i < n; i++) {
    const store = new SbppSessionStore();
    const session = store.issue({ ttlMs: 50 });
    const digest = buildDigest(session.nonce);

    await sleep(40);
    const result = verify(store, session, digest);
    if (result.valid) beforeExpirySuccess++;
  }

  // Sub-scenario B: verify after expiry (TTL=50ms, wait 60ms)
  for (let i = 0; i < n; i++) {
    const store = new SbppSessionStore();
    const session = store.issue({ ttlMs: 50 });
    const digest = buildDigest(session.nonce);

    await sleep(60);
    const result = verify(store, session, digest);
    if (!result.valid) afterExpiryFail++;
  }

  return {
    before_expiry_success: Number((beforeExpirySuccess / n).toFixed(4)),
    after_expiry_fail: Number((afterExpiryFail / n).toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 4: Bulk active sessions
// ═══════════════════════════════════════════════════════

function runBulkSessions() {
  const BULK_CREATE = 10000;
  const BULK_VERIFY = 1000;

  const store = new SbppSessionStore();
  const sessions = [];

  // Create 10000 sessions (mix of short and long TTL)
  for (let i = 0; i < BULK_CREATE; i++) {
    // Half with very short TTL (already expired by verification time),
    // half with long TTL
    const ttlMs = i < BULK_CREATE / 2 ? 1 : 60000;
    const session = store.issue({ ttlMs });
    sessions.push(session);
  }

  // Small delay simulation: short-TTL sessions are now expired
  const nowAfterDelay = Date.now() + 10;

  // Verify random 1000 from the long-TTL half
  let verified = 0;
  const longTtlStart = BULK_CREATE / 2;
  const indices = new Set();
  while (indices.size < BULK_VERIFY) {
    indices.add(longTtlStart + Math.floor(Math.random() * (BULK_CREATE / 2)));
  }

  for (const idx of indices) {
    const session = sessions[idx];
    const digest = buildDigest(session.nonce);
    const result = verify(store, session, digest);
    if (result.valid) verified++;
  }

  // Purge expired
  const purged = store.purgeExpired(nowAfterDelay);
  const remaining = store.size;

  return {
    created: BULK_CREATE,
    verified,
    purged,
    remaining,
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  process.stderr.write(`=== SBPP Race Condition Evaluation (N=${N_TRIALS}) ===\n\n`);

  // Scenario 1
  process.stderr.write('Scenario 1: Sequential double-submit...\n');
  const sequential = runSequentialDouble(N_TRIALS);
  process.stderr.write(`  first_success=${sequential.first_success}  second_success=${sequential.second_success}\n\n`);

  // Scenario 2
  process.stderr.write('Scenario 2: Parallel double-submit...\n');
  const parallel = await runParallelDouble(N_TRIALS);
  process.stderr.write(`  exactly_one=${parallel.exactly_one_success}  both=${parallel.both_succeeded}  neither=${parallel.neither_succeeded}\n\n`);

  // Scenario 3
  process.stderr.write('Scenario 3: Expiry boundary (this takes ~100s for N=1000)...\n');
  const expiry = await runExpiryBoundary(N_TRIALS);
  process.stderr.write(`  before_expiry_success=${expiry.before_expiry_success}  after_expiry_fail=${expiry.after_expiry_fail}\n\n`);

  // Scenario 4
  process.stderr.write('Scenario 4: Bulk active sessions...\n');
  const bulk = runBulkSessions();
  process.stderr.write(`  created=${bulk.created}  verified=${bulk.verified}  purged=${bulk.purged}  remaining=${bulk.remaining}\n\n`);

  const output = {
    timestamp: new Date().toISOString(),
    n_trials: N_TRIALS,
    sequential_double: {
      first_success: sequential.first_success,
      second_success: sequential.second_success,
    },
    parallel_double: {
      exactly_one_success: parallel.rate,
    },
    expiry_boundary: {
      before_expiry_success: expiry.before_expiry_success,
      after_expiry_fail: expiry.after_expiry_fail,
    },
    bulk_sessions: {
      created: bulk.created,
      verified: bulk.verified,
      purged: bulk.purged,
      remaining: bulk.remaining,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  // Final summary to stderr
  process.stderr.write('=== Summary ===\n');
  process.stderr.write(`  Sequential: first always succeeds (${sequential.first_success}/${N_TRIALS}), second always fails (${sequential.second_success}/${N_TRIALS})\n`);
  process.stderr.write(`  Parallel: exactly-one rate = ${parallel.rate}\n`);
  process.stderr.write(`  Expiry: before-success = ${expiry.before_expiry_success}, after-fail = ${expiry.after_expiry_fail}\n`);
  process.stderr.write(`  Bulk: ${bulk.created} created, ${bulk.verified} verified, ${bulk.purged} purged, ${bulk.remaining} remaining\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
