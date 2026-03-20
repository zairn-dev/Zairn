/**
 * SBPP Merkle Tree Evaluation Script
 *
 * Measures Merkle tree overhead and compares state scaling
 * for the SBPP result-set binding mechanism.
 *
 * Usage: node test/evaluate-sbpp-merkle.mjs
 */

import { MerkleResultSet, SbppAuditLog, computeResultSetDigest } from '../dist/sbpp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateDropIds(n) {
  return Array.from({ length: n }, (_, i) => `drop-${String(i).padStart(6, '0')}`);
}

function microtime() {
  return performance.now() * 1000; // microseconds
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// 1. Scaling measurements
// ---------------------------------------------------------------------------

const SIZES = [10, 50, 100, 500, 1000, 5000];
const scaling = [];

for (const size of SIZES) {
  const ids = generateDropIds(size);
  const avgIdLen = ids.reduce((sum, id) => sum + id.length, 0) / ids.length;

  // Tree construction time
  const buildTimes = [];
  for (let trial = 0; trial < 5; trial++) {
    const t0 = microtime();
    const tree = new MerkleResultSet(ids);
    const t1 = microtime();
    buildTimes.push(t1 - t0);
  }
  const tree = new MerkleResultSet(ids);
  const treeBuildUs = median(buildTimes);

  // Proof generation time (sample up to 50 drops)
  const sampleSize = Math.min(size, 50);
  const sampleIds = ids.slice(0, sampleSize);
  const proveTimes = [];
  for (const id of sampleIds) {
    const t0 = microtime();
    tree.prove(id);
    const t1 = microtime();
    proveTimes.push(t1 - t0);
  }
  const proveUs = median(proveTimes);

  // Proof verification time
  const verifyTimes = [];
  for (const id of sampleIds) {
    const proof = tree.prove(id);
    const t0 = microtime();
    MerkleResultSet.verify(proof);
    const t1 = microtime();
    verifyTimes.push(t1 - t0);
  }
  const verifyUs = median(verifyTimes);

  // Proof size (path steps)
  const sampleProof = tree.prove(ids[0]);
  const proofSteps = sampleProof ? sampleProof.path.length : 0;

  // State comparison
  const fullStateBytes = size * avgIdLen;
  const rootOnlyBytes = tree.root.length;

  scaling.push({
    result_set_size: size,
    tree_build_us: Math.round(treeBuildUs * 100) / 100,
    prove_us: Math.round(proveUs * 100) / 100,
    verify_us: Math.round(verifyUs * 100) / 100,
    proof_steps: proofSteps,
    full_state_bytes: Math.round(fullStateBytes),
    root_only_bytes: rootOnlyBytes,
  });
}

// ---------------------------------------------------------------------------
// 2. Offline audit benchmark
// ---------------------------------------------------------------------------

const AUDIT_COUNT = 100;
const auditIds = generateDropIds(AUDIT_COUNT);
const auditTree = new MerkleResultSet(auditIds);
const auditLog = new SbppAuditLog();

for (const id of auditIds) {
  const proof = auditTree.prove(id);
  auditLog.record({
    sessionId: 'eval-session',
    dropId: id,
    challengeDigest: `digest-${id}`,
    merkleRoot: auditTree.root,
    merkleProof: proof,
    timestamp: Date.now(),
    verified: true,
  });
}

const auditT0 = performance.now();
const auditResult = auditLog.audit();
const auditT1 = performance.now();
const auditTimeMs = Math.round((auditT1 - auditT0) * 1000) / 1000;

// ---------------------------------------------------------------------------
// 3. State compression at |R|=1000
// ---------------------------------------------------------------------------

const comp1000 = scaling.find(s => s.result_set_size === 1000);
const stateCompression = {
  description: 'Merkle root replaces full candidate set in session state',
  at_1000_drops: {
    full_bytes: comp1000 ? comp1000.full_state_bytes : 0,
    root_bytes: comp1000 ? comp1000.root_only_bytes : 0,
    compression_ratio: comp1000 && comp1000.root_only_bytes > 0
      ? Math.round((comp1000.full_state_bytes / comp1000.root_only_bytes) * 100) / 100
      : 0,
  },
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const output = {
  timestamp: new Date().toISOString(),
  scaling,
  audit: {
    records: AUDIT_COUNT,
    audit_time_ms: auditTimeMs,
    all_valid: auditResult.invalid === 0,
  },
  state_compression: stateCompression,
};

// JSON to stdout
console.log(JSON.stringify(output, null, 2));

// Summary to stderr
process.stderr.write('\n=== SBPP Merkle Tree Evaluation ===\n\n');
process.stderr.write('Scaling:\n');
process.stderr.write(
  '  |R|   | build(us) | prove(us) | verify(us) | steps | full(B) | root(B)\n',
);
process.stderr.write(
  '  ------|-----------|-----------|------------|-------|---------|--------\n',
);
for (const s of scaling) {
  process.stderr.write(
    `  ${String(s.result_set_size).padStart(5)} | ${String(s.tree_build_us).padStart(9)} | ${String(s.prove_us).padStart(9)} | ${String(s.verify_us).padStart(10)} | ${String(s.proof_steps).padStart(5)} | ${String(s.full_state_bytes).padStart(7)} | ${String(s.root_only_bytes).padStart(6)}\n`,
  );
}

process.stderr.write(`\nAudit: ${AUDIT_COUNT} records in ${auditTimeMs}ms — all valid: ${auditResult.invalid === 0}\n`);
process.stderr.write(
  `State compression at |R|=1000: ${stateCompression.at_1000_drops.full_bytes}B → ${stateCompression.at_1000_drops.root_bytes}B (${stateCompression.at_1000_drops.compression_ratio}x)\n\n`,
);
