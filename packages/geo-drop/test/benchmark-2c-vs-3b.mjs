/**
 * Benchmark: Strategy 2c (stored-digest) vs Strategy 3b (Zairn-ZKP)
 *
 * Measures end-to-end latency, DB operations, and implementation complexity
 * for both binding strategies at a multi-drop venue.
 *
 * For k = 1, 5, 10, 20 overlapping drops at Shibuya:
 *   1. Strategy 2c: k challenge requests (k RTs) + k proofs + k DB-backed verifications
 *   2. Strategy 3b: 1 epoch nonce request (1 RT) + k proofs + k stateless verifications
 *
 * Measures:
 *   - End-to-end wall time (challenge + prove + verify)
 *   - Per-phase breakdown (challenge, prove, verify)
 *   - DB operations count
 *   - Cross-drop transfer resistance (Scenario G)
 *
 * Paper section: §VII-E — Implementation complexity comparison
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as snarkjs from 'snarkjs';

import {
  Strategy2cServer,
  Strategy3bServer,
  complexityComparison,
} from './strategy-2c-implementation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

// ─── Constants ───────────────────────────────────────────────────

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SCALE = 1_000_000;
const toFP = (deg) => BigInt(Math.round(deg * SCALE));
const metersToR2 = (m) => { const r = BigInt(Math.round((m / 111320) * SCALE)); return (r * r).toString(); };
const cosLatS = (lat) => BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

function hashToDecimal(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

// ─── Venue: Shibuya, Tokyo ───────────────────────────────────────
const TARGET_LAT = 35.6586;
const TARGET_LON = 139.7454;
const UNLOCK_RADIUS = 50;
const USER_LAT = 35.6589;
const USER_LON = 139.7457;

const geoInput = {
  targetLat: toFP(TARGET_LAT).toString(),
  targetLon: toFP(TARGET_LON).toString(),
  radiusSquared: metersToR2(UNLOCK_RADIUS),
  cosLatScaled: cosLatS(TARGET_LAT),
};
const userInput = {
  userLat: toFP(USER_LAT).toString(),
  userLon: toFP(USER_LON).toString(),
};

const EPOCH = '100';
const USER_ID = 'user-001';
const POLICY_VERSION = '2';
const MOBILE_RTT_MS = 100; // Simulated mobile round-trip time
const DB_LATENCY_MS = 5;   // Simulated DB latency per operation

// ─── Benchmark: Strategy 2c ─────────────────────────────────────

async function benchmarkStrategy2c(k, wasm, zkey, vkey, server2c) {
  const drops = Array.from({ length: k }, (_, i) => ({
    dropId: `drop-${String(i + 1).padStart(3, '0')}`,
  }));

  // Phase 1: Challenge requests (k round trips)
  const t0_challenge = performance.now();
  const challenges = [];
  for (const drop of drops) {
    // Simulate network RTT for each challenge request
    await new Promise(r => setTimeout(r, MOBILE_RTT_MS));
    const ch = await server2c.issueChallenge(drop.dropId, USER_ID);
    challenges.push(ch);
  }
  const challengeTime = performance.now() - t0_challenge;

  // Phase 2: Proof generation (k proofs)
  // In 2c, the proof contains geo + challengeDigest but NOT context digest
  // We use the same circuit but set contextDigest to a dummy value
  const t0_prove = performance.now();
  const proofs = [];
  for (let i = 0; i < k; i++) {
    const input = {
      ...geoInput,
      ...userInput,
      // In strategy 2c, the proof doesn't bind to drop identity
      // We set contextDigest to a constant — the server checks binding via DB
      contextDigest: hashToDecimal('dummy-context'),
      epoch: EPOCH,
      challengeDigest: challenges[i].challengeDigest,
    };
    const result = await snarkjs.groth16.fullProve(input, wasm, zkey);
    proofs.push(result);
  }
  const proveTime = performance.now() - t0_prove;

  // Phase 3: Verify (k verifications with DB lookup each)
  const t0_verify = performance.now();
  const verifyResults = [];
  for (let i = 0; i < k; i++) {
    const res = await server2c.verifyProof(
      proofs[i].proof,
      proofs[i].publicSignals,
      challenges[i].nonceId,
      { dropId: drops[i].dropId }
    );
    verifyResults.push(res);
  }
  const verifyTime = performance.now() - t0_verify;

  // Scenario G: cross-drop transfer test (both naive and hardened)
  let scenarioG_naive_blocked = false;
  let scenarioG_hardened_blocked = false;
  if (k > 1) {
    // Attack: get fresh nonce for drop 1, submit proof generated for drop 0
    // The Groth16 proof is cryptographically valid (honestly generated for drop 0)
    // but contains drop 0's challengeDigest, not drop 1's

    // Naive 2c: only checks DB mapping, not challengeDigest in proof
    const ch1_naive = await server2c.issueChallenge(drops[1].dropId, USER_ID);
    const naiveResult = await server2c.verifyProofNaive(
      proofs[0].proof,
      proofs[0].publicSignals,
      ch1_naive.nonceId,
      { dropId: drops[1].dropId }
    );
    scenarioG_naive_blocked = !naiveResult.verified;

    // Hardened 2c: also checks publicSignals[7] vs stored challengeDigest
    const ch1_hard = await server2c.issueChallenge(drops[1].dropId, USER_ID);
    const hardenedResult = await server2c.verifyProof(
      proofs[0].proof,
      proofs[0].publicSignals,
      ch1_hard.nonceId,
      { dropId: drops[1].dropId }
    );
    scenarioG_hardened_blocked = !hardenedResult.verified;
  }

  const totalTime = challengeTime + proveTime + verifyTime;
  const allVerified = verifyResults.every(r => r.verified);

  return {
    strategy: '2c',
    k,
    phases: {
      challenge_ms: +challengeTime.toFixed(2),
      prove_ms: +proveTime.toFixed(2),
      verify_ms: +verifyTime.toFixed(2),
      total_ms: +totalTime.toFixed(2),
    },
    roundTrips: k,
    dbOps: server2c.store.stats,
    allVerified,
    scenarioG_naive_blocked,
    scenarioG_hardened_blocked,
  };
}

// ─── Benchmark: Strategy 3b ─────────────────────────────────────

async function benchmarkStrategy3b(k, wasm, zkey, vkey, server3b) {
  const drops = Array.from({ length: k }, (_, i) => ({
    dropId: `drop-${String(i + 1).padStart(3, '0')}`,
  }));

  // Phase 1: Single epoch nonce request (1 round trip)
  const t0_challenge = performance.now();
  await new Promise(r => setTimeout(r, MOBILE_RTT_MS)); // 1 RT
  const { epoch, challengeDigest } = server3b.getEpochNonce(EPOCH, USER_ID);
  const challengeTime = performance.now() - t0_challenge;

  // Phase 2: Proof generation (k proofs with in-proof context binding)
  const t0_prove = performance.now();
  const proofs = [];
  const contexts = [];
  for (let i = 0; i < k; i++) {
    const contextDigest = hashToDecimal(
      lengthPrefixEncode(drops[i].dropId, POLICY_VERSION, String(epoch))
    );
    contexts.push({ contextDigest, epoch, challengeDigest });

    const input = {
      ...geoInput,
      ...userInput,
      contextDigest,
      epoch,
      challengeDigest,
    };
    const result = await snarkjs.groth16.fullProve(input, wasm, zkey);
    proofs.push(result);
  }
  const proveTime = performance.now() - t0_prove;

  // Phase 3: Verify (k stateless verifications, no DB)
  const t0_verify = performance.now();
  const verifyResults = [];
  for (let i = 0; i < k; i++) {
    const res = await server3b.verifyProof(
      proofs[i].proof,
      proofs[i].publicSignals,
      {
        dropId: drops[i].dropId,
        policyVersion: POLICY_VERSION,
        epoch,
        challengeDigest,
      }
    );
    verifyResults.push(res);
  }
  const verifyTime = performance.now() - t0_verify;

  // Scenario G: cross-drop transfer test
  // Try to verify proof[0] against drop[1]'s expected params
  let scenarioG_blocked = false;
  if (k > 1) {
    const crossResult = await server3b.verifyProof(
      proofs[0].proof,
      proofs[0].publicSignals,
      {
        dropId: drops[1].dropId, // different drop
        policyVersion: POLICY_VERSION,
        epoch,
        challengeDigest,
      }
    );
    // 3b blocks this because contextDigest = H(drop-001:2:100) ≠ H(drop-002:2:100)
    scenarioG_blocked = !crossResult.verified;
  }

  const totalTime = challengeTime + proveTime + verifyTime;
  const allVerified = verifyResults.every(r => r.verified);

  return {
    strategy: '3b',
    k,
    phases: {
      challenge_ms: +challengeTime.toFixed(2),
      prove_ms: +proveTime.toFixed(2),
      verify_ms: +verifyTime.toFixed(2),
      total_ms: +totalTime.toFixed(2),
    },
    roundTrips: 1, // single epoch nonce
    dbOps: { inserts: 0, lookups: 0, updates: 0, cleanups: 0, currentSize: 0 },
    allVerified,
    scenarioG_blocked,
  };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Strategy 2c vs 3b: Implementation Complexity Benchmark');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const wasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');
  const vkeyJson = await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8');
  const vkey = JSON.parse(vkeyJson);

  console.log(`Venue: Shibuya (${TARGET_LAT}, ${TARGET_LON}), r=${UNLOCK_RADIUS}m`);
  console.log(`User: (${USER_LAT}, ${USER_LON}), ~30m from target`);
  console.log(`Mobile RTT: ${MOBILE_RTT_MS}ms, DB latency: ${DB_LATENCY_MS}ms\n`);

  // Warm-up
  console.log('Warming up (1 proof)...');
  await snarkjs.groth16.fullProve(
    { ...geoInput, ...userInput,
      contextDigest: hashToDecimal('warmup:2:100'),
      epoch: EPOCH, challengeDigest: hashToDecimal('warmup-nonce') },
    wasm, zkey
  );
  console.log('Warm-up done.\n');

  const kValues = [1, 5, 10, 20];
  const allResults = [];

  for (const k of kValues) {
    console.log(`─── k = ${k} drops ───`);

    // Fresh server instances for each k
    const server2c = new Strategy2cServer(snarkjs, vkey, DB_LATENCY_MS);
    const server3b = new Strategy3bServer(snarkjs, vkey);

    const r2c = await benchmarkStrategy2c(k, wasm, zkey, vkey, server2c);
    const r3b = await benchmarkStrategy3b(k, wasm, zkey, vkey, server3b);

    console.log(`  Strategy 2c (stored-digest):`);
    console.log(`    Challenge: ${r2c.phases.challenge_ms}ms (${k} RTs)`);
    console.log(`    Prove:     ${r2c.phases.prove_ms}ms`);
    console.log(`    Verify:    ${r2c.phases.verify_ms}ms (${r2c.dbOps.lookups} DB lookups)`);
    console.log(`    Total:     ${r2c.phases.total_ms}ms`);
    console.log(`    All valid: ${r2c.allVerified}`);
    if (k > 1) {
      console.log(`    Scenario G (naive):    ${r2c.scenarioG_naive_blocked ? 'BLOCKED' : 'VULNERABLE'}`);
      console.log(`    Scenario G (hardened): ${r2c.scenarioG_hardened_blocked ? 'BLOCKED' : 'VULNERABLE'}`);
    }

    console.log(`  Strategy 3b (Zairn-ZKP):`);
    console.log(`    Challenge: ${r3b.phases.challenge_ms}ms (1 RT)`);
    console.log(`    Prove:     ${r3b.phases.prove_ms}ms`);
    console.log(`    Verify:    ${r3b.phases.verify_ms}ms (0 DB ops)`);
    console.log(`    Total:     ${r3b.phases.total_ms}ms`);
    console.log(`    All valid: ${r3b.allVerified}`);
    if (k > 1) console.log(`    Scenario G blocked: ${r3b.scenarioG_blocked}`);

    const overhead = r2c.phases.total_ms - r3b.phases.total_ms;
    const overheadPct = ((overhead / r3b.phases.total_ms) * 100).toFixed(1);
    console.log(`  Δ (2c - 3b): ${overhead > 0 ? '+' : ''}${overhead.toFixed(0)}ms (${overheadPct}%)\n`);

    allResults.push({ k, r2c, r3b, overhead_ms: +overhead.toFixed(2) });
  }

  // ─── Summary Tables ───────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Summary');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Latency comparison
  console.log('  End-to-end latency (ms)');
  console.log('  k   | 2c total  | 3b total  | Δ (ms)   | Δ (%)');
  console.log('  ' + '─'.repeat(55));
  for (const { k, r2c, r3b, overhead_ms } of allResults) {
    const pct = ((overhead_ms / r3b.phases.total_ms) * 100).toFixed(1);
    console.log(
      `  ${String(k).padStart(3)} | ` +
      `${String(r2c.phases.total_ms.toFixed(0) + 'ms').padStart(9)} | ` +
      `${String(r3b.phases.total_ms.toFixed(0) + 'ms').padStart(9)} | ` +
      `${String((overhead_ms > 0 ? '+' : '') + overhead_ms.toFixed(0) + 'ms').padStart(8)} | ` +
      `${pct}%`
    );
  }

  // Challenge phase breakdown
  console.log('\n  Challenge phase (nonce acquisition)');
  console.log('  k   | 2c (k RTs)  | 3b (1 RT)  | Nonce overhead');
  console.log('  ' + '─'.repeat(55));
  for (const { k, r2c, r3b } of allResults) {
    const overhead = r2c.phases.challenge_ms - r3b.phases.challenge_ms;
    console.log(
      `  ${String(k).padStart(3)} | ` +
      `${String(r2c.phases.challenge_ms.toFixed(0) + 'ms').padStart(10)} | ` +
      `${String(r3b.phases.challenge_ms.toFixed(0) + 'ms').padStart(9)} | ` +
      `${String('+' + overhead.toFixed(0) + 'ms').padStart(10)}`
    );
  }

  // DB operations
  console.log('\n  DB operations per k drops');
  console.log('  k   | 2c inserts | 2c lookups | 3b DB ops');
  console.log('  ' + '─'.repeat(50));
  for (const { k, r2c } of allResults) {
    console.log(
      `  ${String(k).padStart(3)} | ` +
      `${String(r2c.r2c ? r2c.r2c.dbOps.inserts : r2c.dbOps.inserts).padStart(10)} | ` +
      `${String(r2c.r2c ? r2c.r2c.dbOps.lookups : r2c.dbOps.lookups).padStart(10)} | ` +
      `0`
    );
  }

  // Scenario G
  console.log('\n  Scenario G (cross-drop transfer resistance)');
  console.log('  k   | 2c naive  | 2c hardened | 3b');
  console.log('  ' + '─'.repeat(50));
  for (const { k, r2c, r3b } of allResults) {
    if (k > 1) {
      console.log(
        `  ${String(k).padStart(3)} | ` +
        `${(r2c.scenarioG_naive_blocked ? 'BLOCKED' : 'VULN').padStart(8)} | ` +
        `${(r2c.scenarioG_hardened_blocked ? 'BLOCKED' : 'VULN').padStart(10)} | ` +
        `${r3b.scenarioG_blocked ? 'BLOCKED' : 'VULN'}`
      );
    }
  }

  // Implementation complexity
  console.log('\n  Implementation complexity comparison');
  console.log('  Metric                   | 2c               | 3b');
  console.log('  ' + '─'.repeat(60));
  const c = complexityComparison;
  console.log(`  Server endpoints          | ${c['2c'].serverEndpoints}                | ${c['3b'].serverEndpoints}`);
  console.log(`  Additional DB tables      | ${c['2c'].dbTables}                | ${c['3b'].dbTables}`);
  console.log(`  DB ops per verification   | ${c['2c'].dbOperationsPerVerify}                | ${c['3b'].dbOperationsPerVerify}`);
  console.log(`  Server-side LOC           | ${c['2c'].serverLOC.total}              | ${c['3b'].serverLOC.total}`);
  console.log(`  Failure modes             | ${c['2c'].failureModes.length}                | ${c['3b'].failureModes.length}`);
  console.log(`  State per request         | ${c['2c'].statePerRequest}           | ${c['3b'].statePerRequest}`);
  console.log(`  Challenge round trips     | ${c['2c'].challengeRoundTrips}                | ${c['3b'].challengeRoundTrips}`);
  console.log(`  Requires cleanup CRON     | ${c['2c'].requiresCleanupCron ? 'yes' : 'no'}              | ${c['3b'].requiresCleanupCron ? 'yes' : 'no'}`);

  console.log('\n  Strategy 2c failure modes:');
  for (const fm of c['2c'].failureModes) {
    console.log(`    - ${fm}`);
  }
  console.log('  Strategy 3b failure modes:');
  for (const fm of c['3b'].failureModes) {
    console.log(`    - ${fm}`);
  }

  console.log('\n  Key findings:');
  console.log('  1. Strategy 2c requires k RTs vs 1 RT for 3b — at k=10 with 100ms RTT,');
  console.log('     this adds ~900ms of nonce overhead alone.');
  console.log('  2. 2c needs 110 LOC of server code vs 20 LOC for 3b (5.5× more).');
  console.log('  3. 2c introduces 6 failure modes vs 1 for 3b.');
  console.log('  4. 2c requires O(k·U) DB state and a cleanup CRON; 3b is stateless.');
  console.log('  5. CRITICAL: naive 2c is VULNERABLE to Scenario G — a plausible');
  console.log('     implementation that checks only the nonce mapping (not the challenge');
  console.log('     digest in publicSignals[7]) allows cross-drop proof transfer.');
  console.log('  6. Hardened 2c blocks Scenario G but requires an additional server-side');
  console.log('     invariant (F6). In 3b, this binding is inherent in the proof — the');
  console.log('     developer cannot accidentally omit it.');

  // ─── JSON output ───────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const output = {
    experiment: 'strategy-2c-vs-3b-benchmark',
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    venue: { lat: TARGET_LAT, lon: TARGET_LON, radius_m: UNLOCK_RADIUS },
    user: { lat: USER_LAT, lon: USER_LON, approx_distance_m: 30 },
    simulated_rtt_ms: MOBILE_RTT_MS,
    simulated_db_latency_ms: DB_LATENCY_MS,
    complexity: complexityComparison,
    results: allResults,
  };

  const outputPath = path.join(__dirname, `strategy-comparison-${dateStr}.json`);
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
