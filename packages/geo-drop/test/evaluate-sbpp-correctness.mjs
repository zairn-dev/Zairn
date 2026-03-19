/**
 * SBPP Correctness Evaluation — Binding Property Tests
 *
 * Tests the core security property of Search-Bound Proximity Proofs:
 * cross-session proofs must be rejected. Runs 8 scenarios N times each
 * and reports pass/fail rates.
 *
 * Paper section: §7 Evaluation — SBPP binding correctness
 *
 * Usage:
 *   node evaluate-sbpp-correctness.mjs [--n 100]
 */

import {
  createSession,
  isSessionValid,
  SbppSessionStore,
  buildSbppChallengeDigest,
  verifySbppBinding,
  sbppVerifyBinding,
} from '../dist/sbpp.js';

// ─── CLI args ───────────────────────────────────────────
const args = process.argv.slice(2);
let N = 100;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--n' && args[i + 1]) {
    N = parseInt(args[i + 1], 10);
    if (!Number.isFinite(N) || N < 1) {
      console.error('--n must be a positive integer');
      process.exit(1);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────
const DROP_ID = 'drop-test-0001';
const POLICY_VERSION = '1';
const EPOCH = '2026-03-19';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function counter() {
  return { pass: 0, fail: 0 };
}

function rate(c) {
  return { pass: c.pass, fail: c.fail, rate: +(c.pass / (c.pass + c.fail)).toFixed(4) };
}

// ─── Scenarios ──────────────────────────────────────────

/** 1. Valid binding: digest matches same session nonce */
function scenarioValidBinding() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  const result = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 2. Cross-session rejection: proof from S1 verified against S2 */
function scenarioCrossSession() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const s2 = store.issue();
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  const result = sbppVerifyBinding(
    store, s2.sessionId, s2.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 3. Expired session: TTL=1ms, wait 10ms */
async function scenarioExpired() {
  const store = new SbppSessionStore();
  const s1 = store.issue({ ttlMs: 1 });
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  await sleep(10);
  const result = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 4. Wrong nonce: modify one character of nonce */
function scenarioWrongNonce() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const wrongNonce = s1.nonce.slice(0, -1) + (s1.nonce.slice(-1) === '0' ? '1' : '0');
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: wrongNonce,
  });
  const result = sbppVerifyBinding(
    store, s1.sessionId, wrongNonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 5. Wrong dropId: correct nonce but different drop */
function scenarioWrongDropId() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  const result = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digest, 'drop-WRONG-9999', POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 6. Session consumption: verify once (success), verify again (should fail) */
function scenarioConsumption() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  // First verify should succeed
  const first = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  if (!first.valid) return 'first_failed';
  // Second verify should fail (session consumed)
  const second = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return second.valid;
}

/** 7. Nonce replay: use S1's nonce when verifying against S2 */
function scenarioNonceReplay() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const s2 = store.issue();
  const digest = buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  // Attempt to use S1's nonce with S2's session ID
  const result = sbppVerifyBinding(
    store, s2.sessionId, s1.nonce, digest, DROP_ID, POLICY_VERSION, EPOCH,
  );
  return result.valid;
}

/** 8. Parallel sessions: two sessions, two drops, each verified correctly */
function scenarioParallelSessions() {
  const store = new SbppSessionStore();
  const s1 = store.issue();
  const s2 = store.issue();
  const dropA = 'drop-parallel-A';
  const dropB = 'drop-parallel-B';

  const digestA = buildSbppChallengeDigest({
    dropId: dropA,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s1.nonce,
  });
  const digestB = buildSbppChallengeDigest({
    dropId: dropB,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: s2.nonce,
  });

  const resultA = sbppVerifyBinding(
    store, s1.sessionId, s1.nonce, digestA, dropA, POLICY_VERSION, EPOCH,
  );
  const resultB = sbppVerifyBinding(
    store, s2.sessionId, s2.nonce, digestB, dropB, POLICY_VERSION, EPOCH,
  );
  return resultA.valid && resultB.valid;
}

// ─── Runner ─────────────────────────────────────────────

async function run() {
  const scenarios = {
    valid_binding:      { fn: scenarioValidBinding,     expectPass: true,  ...counter() },
    cross_session:      { fn: scenarioCrossSession,     expectPass: false, ...counter() },
    expired:            { fn: scenarioExpired,           expectPass: false, ...counter(), async: true },
    wrong_nonce:        { fn: scenarioWrongNonce,        expectPass: false, ...counter() },
    wrong_dropId:       { fn: scenarioWrongDropId,       expectPass: false, ...counter() },
    consumption:        { fn: scenarioConsumption,       expectPass: false, ...counter() },
    nonce_replay:       { fn: scenarioNonceReplay,       expectPass: false, ...counter() },
    parallel_sessions:  { fn: scenarioParallelSessions,  expectPass: true,  ...counter() },
  };

  for (let i = 0; i < N; i++) {
    for (const [name, s] of Object.entries(scenarios)) {
      let result;
      if (s.async) {
        result = await s.fn();
      } else {
        result = s.fn();
      }
      // For consumption scenario, 'first_failed' means unexpected failure
      if (result === 'first_failed') {
        s.fail++;
      } else if (result === true) {
        s.pass++;
      } else {
        s.fail++;
      }
    }
  }

  // Build output
  const scenarioResults = {};
  let allCorrect = true;

  for (const [name, s] of Object.entries(scenarios)) {
    const r = rate(s);
    scenarioResults[name] = r;

    const expectedRate = s.expectPass ? 1.0 : 0.0;
    if (r.rate !== expectedRate) {
      allCorrect = false;
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    n: N,
    scenarios: scenarioResults,
    all_correct: allCorrect,
  };

  // JSON to stdout
  console.log(JSON.stringify(output, null, 2));

  // Summary to stderr
  console.error(`\n=== SBPP Correctness Evaluation (N=${N}) ===`);
  for (const [name, r] of Object.entries(scenarioResults)) {
    const expected = scenarios[name].expectPass ? 'pass' : 'fail';
    const actual = r.rate === (scenarios[name].expectPass ? 1.0 : 0.0) ? 'OK' : 'FAIL';
    console.error(`  ${name.padEnd(22)} pass=${String(r.pass).padStart(4)} fail=${String(r.fail).padStart(4)} rate=${r.rate.toFixed(4)}  expected=${expected}  [${actual}]`);
  }
  console.error(`\n  all_correct: ${allCorrect}`);

  if (!allCorrect) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
