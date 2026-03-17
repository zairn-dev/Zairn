/**
 * Multi-drop venue simulation: protocol cost and Scenario G at scale.
 *
 * For k = 1, 5, 10, 20 overlapping drops at a single venue (Shibuya, Tokyo):
 *   1. Generate k Zairn-ZKP proofs with distinct context digests, shared epoch nonce
 *   2. Measure total proof generation time
 *   3. Attempt all k(k-1) cross-drop transfers at binding levels (ii) and (iii)
 *   4. Report protocol latency under per-request vs epoch-derived nonces
 *
 * Paper section: §VII-E — Scenario G realism and protocol cost comparison
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToDecimal(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

const SCALE = 1_000_000;
const toFP = (deg) => BigInt(Math.round(deg * SCALE));
const metersToR2 = (m) => { const r = BigInt(Math.round((m / 111320) * SCALE)); return (r * r).toString(); };
const cosLatS = (lat) => BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

// ─── Venue: Shibuya, Tokyo ─────────────────────────────────
const TARGET_LAT = 35.6586;
const TARGET_LON = 139.7454;
const UNLOCK_RADIUS = 50;    // meters
const USER_LAT = 35.6589;    // ~30m from target
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
const SHARED_NONCE = hashToDecimal('user123:epoch100');
const RTT_MS = 100; // Simulated mobile round-trip time (ms)

async function runVenueExperiment(k, wasm, zkey) {
  // Create k drops at identical coordinates, different dropIds
  const drops = Array.from({ length: k }, (_, i) => ({
    dropId: `drop-${String(i + 1).padStart(3, '0')}`,
    policyVersion: '2',
    epoch: EPOCH,
  }));

  // Context digests — all share epoch and nonce, differ only in C
  const contexts = drops.map(d => ({
    contextDigest: hashToDecimal(lengthPrefixEncode(d.dropId, d.policyVersion, String(d.epoch))),
    epoch: d.epoch,
    challengeDigest: SHARED_NONCE,
  }));

  // Generate k proofs (timed)
  const proofs = [];
  const proveTimes = [];
  for (let i = 0; i < k; i++) {
    const t0 = performance.now();
    const proof = await snarkjs.groth16.fullProve(
      { ...geoInput, ...userInput, ...contexts[i] },
      wasm, zkey
    );
    proveTimes.push(performance.now() - t0);
    proofs.push(proof);
  }
  const totalProveTime = proveTimes.reduce((a, b) => a + b, 0);

  // Cross-drop transfer analysis: all k(k-1) pairs
  let levelII_accepts = 0;
  let levelIII_accepts = 0;
  let totalTransfers = 0;

  for (let src = 0; src < k; src++) {
    for (let dst = 0; dst < k; dst++) {
      if (src === dst) continue;
      totalTransfers++;

      const srcPub = proofs[src].publicSignals;
      const dstExpected = [
        '1', geoInput.targetLat, geoInput.targetLon, geoInput.radiusSquared,
        geoInput.cosLatScaled, contexts[dst].contextDigest, contexts[dst].epoch,
        contexts[dst].challengeDigest,
      ];

      // Level (ii): check geo [1..4] + epoch [6] + nonce [7], no context digest
      const geoMatch = srcPub[1] === dstExpected[1] && srcPub[2] === dstExpected[2]
        && srcPub[3] === dstExpected[3] && srcPub[4] === dstExpected[4];
      const epochMatch = srcPub[6] === dstExpected[6];
      const nonceMatch = srcPub[7] === dstExpected[7];
      if (geoMatch && epochMatch && nonceMatch) levelII_accepts++;

      // Level (iii): check ALL 8 signals including C [5]
      const allMatch = dstExpected.every((v, i) => srcPub[i] === v);
      if (allMatch) levelIII_accepts++;
    }
  }

  // Protocol latency comparison
  const perRequestLatency = k * RTT_MS + totalProveTime;
  const epochLatency = 1 * RTT_MS + totalProveTime;

  return {
    k,
    totalProveTime: +totalProveTime.toFixed(2),
    perProofTime: +(totalProveTime / k).toFixed(2),
    proveTimes: proveTimes.map(t => +t.toFixed(2)),
    transfers: {
      total: totalTransfers,
      levelII_accepts,
      levelIII_accepts,
      levelII_rate: totalTransfers > 0 ? +(levelII_accepts / totalTransfers * 100).toFixed(1) : 0,
      levelIII_rate: totalTransfers > 0 ? +(levelIII_accepts / totalTransfers * 100).toFixed(1) : 0,
    },
    protocol: {
      rtt_ms: RTT_MS,
      perRequest_total_ms: +perRequestLatency.toFixed(2),
      epoch_total_ms: +epochLatency.toFixed(2),
      nonce_overhead_ms: +((k - 1) * RTT_MS).toFixed(2),
    },
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Multi-Drop Venue Simulation: Protocol Cost & Scenario G');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const wasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');

  console.log(`Venue: Shibuya (${TARGET_LAT}, ${TARGET_LON}), r=${UNLOCK_RADIUS}m`);
  console.log(`User: (${USER_LAT}, ${USER_LON}), ~30m from target`);
  console.log(`Shared epoch nonce: ${SHARED_NONCE.slice(0, 20)}...`);
  console.log(`Simulated mobile RTT: ${RTT_MS}ms\n`);

  // Warm-up run
  console.log('Warming up (1 proof)...');
  await snarkjs.groth16.fullProve(
    { ...geoInput, ...userInput,
      contextDigest: hashToDecimal('warmup:2:100'),
      epoch: EPOCH, challengeDigest: SHARED_NONCE },
    wasm, zkey
  );
  console.log('Warm-up done.\n');

  const kValues = [1, 5, 10, 20];
  const results = [];

  for (const k of kValues) {
    console.log(`─── k = ${k} drops ───`);
    const r = await runVenueExperiment(k, wasm, zkey);
    results.push(r);

    console.log(`  Prove: ${r.totalProveTime}ms total, ${r.perProofTime}ms/proof`);
    if (k > 1) {
      console.log(`  Cross-transfers (${r.transfers.total} pairs):`);
      console.log(`    Level (ii):  ${r.transfers.levelII_accepts}/${r.transfers.total} ACCEPT (${r.transfers.levelII_rate}%)`);
      console.log(`    Level (iii): ${r.transfers.levelIII_accepts}/${r.transfers.total} ACCEPT (${r.transfers.levelIII_rate}%)`);
    }
    console.log(`  Protocol latency:`);
    console.log(`    Per-request nonces: ${r.protocol.perRequest_total_ms}ms (${k} RTs × ${RTT_MS}ms + prove)`);
    console.log(`    Epoch-derived:      ${r.protocol.epoch_total_ms}ms (1 RT × ${RTT_MS}ms + prove)`);
    console.log(`    Nonce overhead:     ${r.protocol.nonce_overhead_ms}ms\n`);
  }

  // ─── Summary table ───
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Summary');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('  Scenario G: cross-drop transfer acceptance rate');
  console.log('  k   | Level (ii) | Level (iii) | Vulnerable pairs');
  console.log('  ' + '─'.repeat(55));
  for (const r of results) {
    if (r.k > 1) {
      console.log(`  ${String(r.k).padStart(3)} | ${String(r.transfers.levelII_rate + '%').padStart(9)} | ${String(r.transfers.levelIII_rate + '%').padStart(10)} | ${r.transfers.levelII_accepts} / ${r.transfers.total}`);
    }
  }

  console.log('\n  Protocol latency (RTT = 100ms)');
  console.log('  k   | Per-request | Epoch   | Nonce overhead');
  console.log('  ' + '─'.repeat(55));
  for (const r of results) {
    console.log(`  ${String(r.k).padStart(3)} | ${String(r.protocol.perRequest_total_ms + 'ms').padStart(10)} | ${String(r.protocol.epoch_total_ms + 'ms').padStart(7)} | ${String(r.protocol.nonce_overhead_ms + 'ms').padStart(8)}`);
  }

  console.log('\n  Key finding: for k overlapping drops with epoch-derived nonces,');
  console.log('  ALL k(k-1) cross-drop transfers succeed at level (ii) but');
  console.log('  NONE succeed at level (iii). The context digest C is the sole');
  console.log('  distinguishing field in every case.');

  // ─── JSON output ───
  const dateStr = new Date().toISOString().slice(0, 10);
  const output = {
    experiment: 'multi-drop-venue-simulation',
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    venue: { lat: TARGET_LAT, lon: TARGET_LON, radius_m: UNLOCK_RADIUS },
    user: { lat: USER_LAT, lon: USER_LON, approx_distance_m: 30 },
    simulated_rtt_ms: RTT_MS,
    shared_nonce: SHARED_NONCE,
    results,
  };

  const outputPath = path.join(__dirname, `multi-drop-venue-${dateStr}.json`);
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
