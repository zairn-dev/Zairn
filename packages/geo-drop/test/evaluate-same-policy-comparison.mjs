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
 * Determine Scenario F/G outcomes for each (strategy, nonce-policy) pair,
 * under the single consistent adversary model of the paper (§III-F, Def. 2):
 * the adversary holds a recorded transcript AND has a challenge oracle —
 * it can legitimately request fresh challenges/tokens for the target drop.
 *
 * Binding mechanics per strategy:
 *   - 2c-hardened (HYBRID): the issued challenge digest is a Groth16 public
 *     signal (pub[7]); the server checks nonce→drop mapping + pub[7] against
 *     the stored digest. Session binding is in-statement; drop binding is
 *     operational (per-request nonce uniqueness + mapping).
 *   - 2d (purely off-circuit): geo-only proof + signed token; NOTHING binds
 *     the transcript to the token, so a freshly issued token for the target
 *     drop pairs cleanly with a replayed proof — under EITHER nonce policy.
 *   - 3a: nonce digest in-statement (level ii), no context digest.
 *   - 3b: context digest + nonce in-statement (level iii).
 *
 * Scenario F (cross-session): attacker replays a transcript from a prior
 *   session against the target drop.
 *   - 2c-hardened: REJECT — pub[7] = old digest ≠ digest stored for any
 *     currently valid issuance.
 *   - 2d: ACCEPT — adversary requests a fresh token for the target drop;
 *     the geo-only proof carries no nonce to mismatch.
 *   - 3a/3b: REJECT — in-statement N differs across sessions.
 *
 * Scenario G (same-epoch, cross-drop): attacker reuses a transcript for a
 *   co-located drop in the same epoch.
 *   - Epoch-derived nonce (shared within epoch):
 *     - 2c-hardened: ACCEPT — the epoch-shared digest is NOT drop-unique, so
 *       the pub[7] check cannot distinguish co-located drops.
 *     - 2d: ACCEPT — token does not cover drop identity (and is unbound).
 *     - 3a: ACCEPT — pub = (1, geo, epoch, N) identical (Lemma 1).
 *     - 3b: REJECT — context digest C differs per drop.
 *   - Per-request nonce (unique per issuance):
 *     - 2c-hardened: REJECT — pub[7] pins the transcript to one issuance,
 *       and the mapping pins that issuance to one drop.
 *     - 2d: ACCEPT — fresh valid token for the target drop; the per-request
 *       nonce is not in the proof, so uniqueness buys nothing.
 *     - 3a/3b: REJECT — in-statement N differs per issuance.
 */
function securityOutcome(strategyId, noncePolicy) {
  // Scenario F: 2d accepts (fresh token acquirable, transcript unbound);
  // every strategy with an in-statement challenge value rejects.
  const scenarioF = strategyId === '2d' ? 'ACCEPT' : 'REJECT';

  // Scenario G: depends on strategy + nonce policy
  let scenarioG;
  if (noncePolicy === 'per-request') {
    // Per-request nonces block G only where the challenge is in-statement
    scenarioG = strategyId === '2d' ? 'ACCEPT' : 'REJECT';
  } else {
    // Epoch-derived: shared nonce/digest within the epoch
    switch (strategyId) {
      case '2c-hardened':
        // Epoch-shared digest is not drop-unique → pub[7] check passes
        scenarioG = 'ACCEPT';
        break;
      case '2d':
        // Signed token covers (session_nonce, epoch) but NOT drop identity
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
      const scFMark = scenarioF === 'ACCEPT' ? '⚠ ACC.' : 'REJECT';
      const scGMark = scenarioG === 'ACCEPT' ? '⚠ ACCEPT' : '  REJECT';
      console.log(
        `  ${strategy.label.padEnd(10)} | ${noncePolicyDef.label.padEnd(7)} | ${scFMark} | ${scGMark} |   ${strategy.opsAssumptions}   | ${strategy.stateClass.padEnd(7)} |  ${String(noncePolicyDef.roundTrips).padStart(2)} | ${latency.total}`
      );
    }
    if (noncePolicy === 'epoch') {
      console.log('  ' + '─'.repeat(hdr.length - 2));
    }
  }

  // ─── Key findings ──────────────────────────────────────────────
  console.log('\nKey findings (adversary = recorded transcript + challenge oracle):');
  console.log('  1. Under epoch-derived nonces, ONLY 3b resists Scenario G.');
  console.log('     2c-hardened\'s epoch-shared digest is not drop-unique; 2d and 3a');
  console.log('     bind no drop identity.');
  console.log('  2. Under per-request nonces, the strategies whose challenge value is');
  console.log('     in-statement (2c-hardened, 3a, 3b) reject Scenario G; 2d still');
  console.log('     accepts, because nothing binds the geo-only transcript to a token.');
  console.log('  3. Holding nonce policy constant (per-request):');
  console.log('     - 2c-hardened: |A_op|=4, O(k·U) state, REJECT Scenario G');
  console.log('     - 3b:          |A_op|=2, O(1) state,   REJECT Scenario G');
  console.log('     → Binding location drives assumption surface (4→2) and state (O(k·U)→O(1)).');
  console.log('  4. Nonce policy can substitute for context binding only where the');
  console.log('     challenge is already bound in-statement, at ~(k-1)×RTT extra latency.');
  console.log('     → Nonce policy drives latency and state; binding location drives');
  console.log('       assumptions and whether G is blockable at O(1) state at all.');
  console.log('  5. 2d (signed-token) is stateless like 3b but never resists Scenario F/G:');
  console.log('     the token is not bound to the proof, so a fresh token for the target');
  console.log('     drop pairs with a replayed proof under either nonce policy.');

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
