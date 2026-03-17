/**
 * Controlled comparison: nonce policy held constant, binding location varies.
 *
 * Isolates two factors that the 2c-vs-3b comparison conflates:
 *   (1) binding location: off-circuit (2c-hardened, 2d) vs. in-proof (3a, 3b)
 *   (2) nonce policy: epoch-derived vs. per-request
 *
 * For each (strategy × nonce-policy) pair, reports:
 *   - Scenario F (cross-session) result
 *   - Scenario G (same-epoch, cross-drop) result
 *   - Operational assumption count |A_op|
 *   - Server state complexity
 *   - Additional network round trips
 *   - Median E2E latency (k=10, RTT=100ms)
 *
 * Paper section: §VII-E — Controlled same-policy comparison
 */

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Parameters ──────────────────────────────────────────────────

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function hashToField(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

const RTT_MS = 100;
const DB_LATENCY_MS = 5;
const PROVE_TIME_MS = 65;
const VERIFY_TIME_MS = 10;
const SIG_VERIFY_MS = 2;   // ECDSA verify ≈ 1-3ms
const K = 10;

// ─── Strategy Definitions (static config) ────────────────────────

const STRATEGIES = {
  '2c-hardened': {
    label: '2c-hard.',
    bindingLocation: 'off-circuit',
    opsAssumptions: 4,
    stateClass: 'O(k·U)',
    // 2c checks: nonce-to-drop DB mapping + pub[7] challenge digest
    // Failure modes: F1-F6
  },
  '2d': {
    label: '2d',
    bindingLocation: 'off-circuit',
    opsAssumptions: 5,
    stateClass: 'O(1)',
    // 2d: signed token covers session nonce, NOT per-drop context
    // Signature-key secrecy adds one more ops assumption
  },
  '3a': {
    label: '3a',
    bindingLocation: 'in-proof',
    opsAssumptions: 4,
    stateClass: 'O(1)',
    // 3a: session nonce in proof (binding level ii), no context digest
  },
  '3b': {
    label: '3b',
    bindingLocation: 'in-proof',
    opsAssumptions: 2,
    stateClass: 'O(1)',
    // 3b: context digest + nonce in proof (binding level iii)
  },
};

// ─── Nonce Policy Definitions ────────────────────────────────────

const NONCE_POLICIES = {
  'epoch': {
    label: 'epoch',
    roundTrips: 1,
    // One nonce per epoch, shared across all drops
  },
  'per-request': {
    label: 'per-req.',
    roundTrips: K,
    // One unique nonce per drop
  },
};

// ─── Security Analysis (deterministic) ───────────────────────────

/**
 * Determine Scenario F/G outcomes for each (strategy, nonce-policy) pair.
 *
 * Scenario F (cross-session): attacker replays proof from a different session.
 *   - Different session → different nonce → all strategies reject.
 *
 * Scenario G (same-epoch, cross-drop): attacker reuses proof for different drop
 *   in the same epoch with shared nonce.
 *   - Epoch-derived nonce: all drops share the same nonce within an epoch.
 *     - 2c-hardened: REJECT — pub[7] check catches cross-drop (digest is per-drop)
 *     - 2d: ACCEPT — signed token covers session nonce, not drop identity;
 *           token is valid for any drop in the epoch
 *     - 3a: ACCEPT — no context digest; pub = (1, geo, epoch, N) is identical
 *           for co-located drops (Lemma 1)
 *     - 3b: REJECT — context digest C differs per drop
 *   - Per-request nonce: each drop gets a unique nonce.
 *     - All strategies: REJECT — nonces differ, so replay is caught
 */
function securityOutcome(strategyId, noncePolicy) {
  // Scenario F: always reject (cross-session → different nonce)
  const scenarioF = 'REJECT';

  // Scenario G: depends on strategy + nonce policy
  let scenarioG;
  if (noncePolicy === 'per-request') {
    // Per-request nonces make Scenario G irrelevant for all strategies
    scenarioG = 'REJECT';
  } else {
    // Epoch-derived: Scenario G depends on binding location + mechanism
    switch (strategyId) {
      case '2c-hardened':
        // pub[7] is drop-specific challenge digest → catches cross-drop
        scenarioG = 'REJECT';
        break;
      case '2d':
        // Signed token covers (session_nonce, epoch) but NOT drop identity
        // All drops share the same signed token within an epoch
        scenarioG = 'ACCEPT';
        break;
      case '3a':
        // Level (ii): no context digest → Lemma 1 indistinguishability
        scenarioG = 'ACCEPT';
        break;
      case '3b':
        // Level (iii): context digest C differs → rejected
        scenarioG = 'REJECT';
        break;
    }
  }
  return { scenarioF, scenarioG };
}

// ─── Latency Model ───────────────────────────────────────────────

/**
 * Compute E2E latency for k drops under given strategy and nonce policy.
 *
 * Phases:
 *   1. Challenge: obtain nonces (1 RT for epoch, k RTs for per-request)
 *   2. Prove: k sequential proofs (mobile, single-threaded)
 *   3. Verify: k verifications (strategy-dependent overhead)
 */
function computeLatency(strategyId, noncePolicy, k, rtt) {
  // Challenge phase
  const challengeRTs = noncePolicy === 'epoch' ? 1 : k;
  const challenge = challengeRTs * rtt;

  // Prove phase: always k sequential proofs
  const prove = k * PROVE_TIME_MS;

  // Verify phase: depends on strategy
  let verifyPerDrop;
  switch (strategyId) {
    case '2c-hardened':
      // Groth16 verify + 2 DB ops (claim nonce + lookup mapping)
      verifyPerDrop = VERIFY_TIME_MS + 2 * DB_LATENCY_MS;
      break;
    case '2d':
      // Groth16 verify + signature verification (no DB)
      verifyPerDrop = VERIFY_TIME_MS + SIG_VERIFY_MS;
      break;
    case '3a':
    case '3b':
      // Groth16 verify only (context check is pure computation)
      verifyPerDrop = VERIFY_TIME_MS;
      break;
  }
  const verify = k * verifyPerDrop;

  return {
    challenge,
    prove,
    verify,
    total: challenge + prove + verify,
  };
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Controlled Comparison: Nonce Policy Held Constant');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`Parameters: k=${K}, RTT=${RTT_MS}ms, prove=${PROVE_TIME_MS}ms, verify=${VERIFY_TIME_MS}ms\n`);

  const results = [];

  // Print header
  const hdr = '  Strategy   | Nonce   | Sc.F   | Sc.G   | |A_op| | State   | RTs | E2E (ms)';
  console.log(hdr);
  console.log('  ' + '─'.repeat(hdr.length - 2));

  for (const noncePolicy of ['epoch', 'per-request']) {
    for (const [strategyId, strategy] of Object.entries(STRATEGIES)) {
      const { scenarioF, scenarioG } = securityOutcome(strategyId, noncePolicy);
      const latency = computeLatency(strategyId, noncePolicy, K, RTT_MS);
      const noncePolicyDef = NONCE_POLICIES[noncePolicy];

      const row = {
        strategy: strategyId,
        bindingLocation: strategy.bindingLocation,
        noncePolicy,
        scenarioF,
        scenarioG,
        opsAssumptions: strategy.opsAssumptions,
        stateClass: noncePolicy === 'per-request' && strategyId !== '2c-hardened'
          ? (strategyId === '2d' ? 'O(1)' : strategy.stateClass)
          : strategy.stateClass,
        roundTrips: noncePolicyDef.roundTrips,
        latency,
      };
      results.push(row);

      // Format row
      const scGMark = scenarioG === 'ACCEPT' ? '⚠ ACCEPT' : '  REJECT';
      console.log(
        `  ${strategy.label.padEnd(10)} | ${noncePolicyDef.label.padEnd(7)} | REJECT | ${scGMark} |   ${strategy.opsAssumptions}   | ${strategy.stateClass.padEnd(7)} |  ${String(noncePolicyDef.roundTrips).padStart(2)} | ${latency.total}`
      );
    }
    if (noncePolicy === 'epoch') {
      console.log('  ' + '─'.repeat(hdr.length - 2));
    }
  }

  // ─── Key findings ──────────────────────────────────────────────
  console.log('\nKey findings:');
  console.log('  1. Under epoch-derived nonces, only 2c-hardened and 3b resist Scenario G.');
  console.log('     2d and 3a both accept cross-drop transfer (ACCEPT).');
  console.log('  2. Under per-request nonces, ALL strategies resist Scenario G.');
  console.log('     The security difference vanishes, but latency/state costs increase.');
  console.log('  3. Holding nonce policy constant (epoch):');
  console.log('     - 2c-hardened: |A_op|=4, O(k·U) state, REJECT Scenario G');
  console.log('     - 3b:          |A_op|=2, O(1) state,   REJECT Scenario G');
  console.log('     → Binding location drives assumption surface (4→2) and state (O(k·U)→O(1)).');
  console.log('  4. Holding nonce policy constant (per-request):');
  console.log('     - All strategies reject Scenario G, but latency increases by ~(k-1)×RTT.');
  console.log('     → Nonce policy drives latency and state; binding location drives assumptions.');
  console.log('  5. 2d (signed-token) is stateless like 3b but does NOT resist Scenario G');
  console.log('     under epoch nonces because the signed token does not cover drop identity.');

  // ─── Epoch-only comparison (for paper table) ───────────────────
  console.log('\n─── Epoch-derived comparison (paper table) ─────────────────');
  console.log('  Strategy    | Bind.    | Sc.G   | |A_op| | State   | E2E');
  console.log('  ' + '─'.repeat(60));
  for (const row of results.filter(r => r.noncePolicy === 'epoch')) {
    const scG = row.scenarioG === 'ACCEPT' ? '⚠ ACC.' : 'REJECT';
    console.log(
      `  ${STRATEGIES[row.strategy].label.padEnd(11)} | ${row.bindingLocation.padEnd(8)} | ${scG.padEnd(6)} |   ${row.opsAssumptions}   | ${row.stateClass.padEnd(7)} | ${row.latency.total}ms`
    );
  }

  console.log('\n─── Per-request comparison (paper table) ───────────────────');
  console.log('  Strategy    | Bind.    | Sc.G   | |A_op| | State   | E2E');
  console.log('  ' + '─'.repeat(60));
  for (const row of results.filter(r => r.noncePolicy === 'per-request')) {
    const scG = row.scenarioG === 'ACCEPT' ? '⚠ ACC.' : 'REJECT';
    console.log(
      `  ${STRATEGIES[row.strategy].label.padEnd(11)} | ${row.bindingLocation.padEnd(8)} | ${scG.padEnd(6)} |   ${row.opsAssumptions}   | ${row.stateClass.padEnd(7)} | ${row.latency.total}ms`
    );
  }

  // ─── JSON output ───────────────────────────────────────────────
  const output = {
    experiment: 'same-policy-comparison',
    date: new Date().toISOString(),
    parameters: { k: K, rtt_ms: RTT_MS, prove_ms: PROVE_TIME_MS, verify_ms: VERIFY_TIME_MS },
    results,
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `same-policy-comparison-${dateStr}.json`);
  writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

main();
