/**
 * ZKP Benchmark Suite for JSS Paper Evaluation
 *
 * Experiment A: Proof generation statistics (50 runs, first-run separated)
 * Experiment B: Context binding ablation (single-element mutation)
 * Experiment C: Dense boundary sweep (48–52m × 0.5m × 4 bearings × 2 latitudes)
 *
 * Run: npx tsx test/benchmark-zkp.ts
 * Or:  ZKP_BENCH_ITERS=30 npx tsx test/benchmark-zkp.ts
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateProximityProof,
  generateZairnZkpProof,
  verifyProximityProof,
  validatePublicSignals,
  buildZkStatementBinding,
  toFixedPoint,
  metersToRadiusSquared,
  cosLatScaled,
} from '../src/index.js';
import type { ZkpConfig, ZkContextBinding, ZkStatementBinding, VerificationKey } from '../src/zkp.js';

// =====================
// Configuration
// =====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CIRCUITS_DIR = path.resolve(__dirname, '..', 'circuits');
const BUILD_DIR = path.join(CIRCUITS_DIR, 'build');

const N = Math.max(10, Number.parseInt(process.env.ZKP_BENCH_ITERS ?? '50', 10));

const prototypeConfig: ZkpConfig = {
  artifacts: {
    wasmUrl: path.join(BUILD_DIR, 'proximity_js', 'proximity.wasm'),
    zkeyUrl: path.join(CIRCUITS_DIR, 'proximity_final.zkey'),
  },
};

const zairnConfig: ZkpConfig = {
  artifacts: {
    wasmUrl: path.join(BUILD_DIR, 'zairn_zkp_js', 'zairn_zkp.wasm'),
    zkeyUrl: path.join(CIRCUITS_DIR, 'zairn_zkp_final.zkey'),
  },
};

const protoVkey: VerificationKey = JSON.parse(
  readFileSync(path.join(CIRCUITS_DIR, 'proximity_verification_key.json'), 'utf8')
);
const zairnVkey: VerificationKey = JSON.parse(
  readFileSync(path.join(CIRCUITS_DIR, 'verification_key.json'), 'utf8')
);

const TARGET_LAT = 35.6586;
const TARGET_LON = 139.7454;
const UNLOCK_RADIUS = 50;

const baseContext: ZkContextBinding = {
  dropId: 'bench-drop-001',
  policyVersion: '2',
  epoch: 100,
  serverNonce: 'bench-nonce-xyz',
};

// =====================
// Statistics helpers
// =====================

interface Stats {
  n: number;
  mean: number;
  std: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  p95: number;
  min: number;
  max: number;
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const std = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const p95 = sorted[Math.floor(n * 0.95)];
  return { n, mean, std, median, q1, q3, iqr, p95, min: sorted[0], max: sorted[n - 1] };
}

function fmt(v: number): string {
  return v.toFixed(2);
}

function printStats(label: string, s: Stats) {
  console.log(`  ${label}:`);
  console.log(`    n=${s.n}  mean=${fmt(s.mean)}ms  std=${fmt(s.std)}ms  median=${fmt(s.median)}ms`);
  console.log(`    IQR=[${fmt(s.q1)}, ${fmt(s.q3)}] (${fmt(s.iqr)}ms)  p95=${fmt(s.p95)}ms  range=[${fmt(s.min)}, ${fmt(s.max)}]`);
}

// =====================
// Bearing offset helper
// =====================

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_320;

function offsetByBearing(lat: number, lon: number, distMeters: number, bearingDeg: number): [number, number] {
  const bearingRad = bearingDeg * DEG2RAD;
  const dLatDeg = (distMeters * Math.cos(bearingRad)) / METERS_PER_DEG_LAT;
  const dLonDeg = (distMeters * Math.sin(bearingRad)) / (METERS_PER_DEG_LAT * Math.cos(lat * DEG2RAD));
  return [lat + dLatDeg, lon + dLonDeg];
}

// =====================
// Experiment A: Proof generation statistics
// =====================

async function experimentA() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`EXPERIMENT A: Proof Generation Statistics (${N} runs)`);
  console.log(`${'='.repeat(60)}`);

  const [userLat, userLon] = offsetByBearing(TARGET_LAT, TARGET_LON, 30, 45);

  async function benchCircuit(
    label: string,
    proveFn: () => Promise<{ proof: any; publicSignals: string[] }>,
    vkey: VerificationKey
  ) {
    console.log(`\n--- ${label} ---`);
    const proveTimes: number[] = [];
    const verifyTimes: number[] = [];

    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const result = await proveFn();
      proveTimes.push(performance.now() - t0);

      const tv0 = performance.now();
      const ok = await verifyProximityProof(result.proof, result.publicSignals, vkey);
      verifyTimes.push(performance.now() - tv0);
      if (!ok) throw new Error(`verification failed at run ${i + 1}`);

      if (i === 0 || (i + 1) % 10 === 0) {
        process.stdout.write(`  Run ${i + 1}/${N} — prove: ${fmt(proveTimes[i])}ms  verify: ${fmt(verifyTimes[i])}ms\n`);
      }
    }

    const proofSize = Buffer.byteLength(JSON.stringify(
      (await proveFn()).proof
    ));
    const lastResult = await proveFn();
    const payloadSize = Buffer.byteLength(JSON.stringify({
      proof: lastResult.proof,
      publicSignals: lastResult.publicSignals,
    }));

    console.log(`\n  Proof JSON size: ${proofSize} bytes`);
    console.log(`  Full payload size (proof + public signals): ${payloadSize} bytes`);
    console.log(`  Proof generation:`);
    console.log(`    First run (cold): ${fmt(proveTimes[0])}ms`);
    printStats('All runs', computeStats(proveTimes));
    printStats('Warm runs (2..N)', computeStats(proveTimes.slice(1)));
    console.log(`  Verification:`);
    console.log(`    First run (cold): ${fmt(verifyTimes[0])}ms`);
    printStats('All runs', computeStats(verifyTimes));
    printStats('Warm runs (2..N)', computeStats(verifyTimes.slice(1)));

    return {
      prove: computeStats(proveTimes),
      proveWarm: computeStats(proveTimes.slice(1)),
      verify: computeStats(verifyTimes),
      verifyWarm: computeStats(verifyTimes.slice(1)),
      proofSize,
      payloadSize,
    };
  }

  const proto = await benchCircuit(
    'Prototype (proximity circuit)',
    () => generateProximityProof(userLat, userLon, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, prototypeConfig),
    protoVkey
  );

  const zairn = await benchCircuit(
    'Zairn-ZKP (context-bound circuit)',
    () => generateZairnZkpProof(userLat, userLon, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, baseContext, zairnConfig),
    zairnVkey
  );

  return { prototype: proto, zairn };
}

// =====================
// Experiment B: Context Binding Ablation
// =====================

async function experimentB() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('EXPERIMENT B: Context Binding Ablation');
  console.log(`${'='.repeat(60)}`);

  const [userLat, userLon] = offsetByBearing(TARGET_LAT, TARGET_LON, 30, 45);

  // Generate valid proofs for both circuits
  const zairnResult = await generateZairnZkpProof(
    userLat, userLon, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, baseContext, zairnConfig
  );
  const protoResult = await generateProximityProof(
    userLat, userLon, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, prototypeConfig
  );

  const validCrypto = await verifyProximityProof(zairnResult.proof, zairnResult.publicSignals, zairnVkey);
  const validSignal = validatePublicSignals(
    zairnResult.publicSignals, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, zairnResult.statement
  );
  console.log(`\n  Zairn-ZKP valid proof — crypto: ${validCrypto}, signal: ${validSignal}`);

  const protoCrypto = await verifyProximityProof(protoResult.proof, protoResult.publicSignals, protoVkey);
  const protoSignal = validatePublicSignals(protoResult.publicSignals, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS);
  console.log(`  Prototype valid proof — crypto: ${protoCrypto}, signal: ${protoSignal}`);

  // Ablation: mutate one context element at a time, check signal validation
  const ablations: { name: string; mutatedContext: ZkContextBinding; description: string }[] = [
    {
      name: 'drop_id',
      mutatedContext: { ...baseContext, dropId: 'different-drop-999' },
      description: 'Cross-drop replay',
    },
    {
      name: 'policy_version',
      mutatedContext: { ...baseContext, policyVersion: '99' },
      description: 'Policy downgrade/upgrade',
    },
    {
      name: 'epoch',
      mutatedContext: { ...baseContext, epoch: 9999 },
      description: 'Stale context reuse',
    },
    {
      name: 'server_nonce',
      mutatedContext: { ...baseContext, serverNonce: 'tampered-nonce' },
      description: 'Session hijacking',
    },
  ];

  console.log('\n  Ablation: Reuse a valid Zairn-ZKP proof with one context element changed');
  console.log('  ┌──────────────────┬─────────────────────────┬──────────┬──────────┐');
  console.log('  │ Mutated element   │ Attack simulated         │ Proto    │ Zairn    │');
  console.log('  ├──────────────────┼─────────────────────────┼──────────┼──────────┤');

  const results: any[] = [];

  for (const abl of ablations) {
    const mutatedStatement = await buildZkStatementBinding(abl.mutatedContext);

    // Zairn-ZKP: signal validation should reject
    const zairnReject = validatePublicSignals(
      zairnResult.publicSignals, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS, mutatedStatement
    );

    // Prototype: has no context binding, so signal validation always passes
    const protoAccept = validatePublicSignals(
      protoResult.publicSignals, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS
    );

    results.push({
      element: abl.name,
      attack: abl.description,
      prototypeBlocked: !protoAccept,
      zairnBlocked: !zairnReject,
    });

    const protoStatus = protoAccept ? 'ACCEPT' : 'REJECT';
    const zairnStatus = zairnReject ? 'ACCEPT' : 'REJECT';
    console.log(`  │ ${abl.name.padEnd(16)} │ ${abl.description.padEnd(23)} │ ${protoStatus.padEnd(8)} │ ${zairnStatus.padEnd(8)} │`);
  }

  console.log('  └──────────────────┴─────────────────────────┴──────────┴──────────┘');
  console.log('\n  Proto ACCEPT = proof reuse succeeds (vulnerability)');
  console.log('  Zairn REJECT = context mismatch detected (defense works)');

  return results;
}

// =====================
// Experiment C: Dense Boundary Sweep
// =====================

async function experimentC() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('EXPERIMENT C: Dense Boundary Sweep');
  console.log(`${'='.repeat(60)}`);

  const distances = [48.0, 48.5, 49.0, 49.5, 50.0, 50.5, 51.0, 51.5, 52.0];
  const bearings = [
    { name: 'N', deg: 0 },
    { name: 'E', deg: 90 },
    { name: 'S', deg: 180 },
    { name: 'W', deg: 270 },
  ];

  const sites = [
    { name: 'Tokyo (35.66°N)', lat: TARGET_LAT, lon: TARGET_LON },
    { name: 'Helsinki (60.17°N)', lat: 60.1699, lon: 24.9384 },
  ];

  const allResults: any[] = [];

  for (const site of sites) {
    console.log(`\n--- Site: ${site.name} ---`);
    console.log(`  cos(lat) × 1e6 = ${cosLatScaled(site.lat).toString()}`);
    console.log(`  radiusSquared   = ${metersToRadiusSquared(UNLOCK_RADIUS).toString()}`);

    // Header
    console.log(`\n  ${'Dist(m)'.padEnd(10)} ${'Bearing'.padEnd(8)} ${'Proto'.padEnd(8)} ${'Zairn'.padEnd(8)}`);
    console.log(`  ${'-'.repeat(38)}`);

    for (const dist of distances) {
      for (const bearing of bearings) {
        const [userLat, userLon] = offsetByBearing(site.lat, site.lon, dist, bearing.deg);

        let protoResult: string;
        try {
          const pr = await generateProximityProof(
            userLat, userLon, site.lat, site.lon, UNLOCK_RADIUS, prototypeConfig
          );
          const ok = await verifyProximityProof(pr.proof, pr.publicSignals, protoVkey);
          protoResult = ok ? 'ACCEPT' : 'REJECT';
        } catch {
          protoResult = 'FAIL';
        }

        let zairnResult: string;
        try {
          const zr = await generateZairnZkpProof(
            userLat, userLon, site.lat, site.lon, UNLOCK_RADIUS, baseContext, zairnConfig
          );
          const ok = await verifyProximityProof(zr.proof, zr.publicSignals, zairnVkey);
          zairnResult = ok ? 'ACCEPT' : 'REJECT';
        } catch {
          zairnResult = 'FAIL';
        }

        allResults.push({
          site: site.name,
          lat: site.lat,
          distance: dist,
          bearing: bearing.name,
          prototype: protoResult,
          zairn: zairnResult,
        });

        console.log(`  ${dist.toFixed(1).padStart(8)}m ${bearing.name.padEnd(8)} ${protoResult.padEnd(8)} ${zairnResult.padEnd(8)}`);
      }
    }
  }

  return allResults;
}

// =====================
// Main
// =====================

async function main() {
  console.log('ZKP Benchmark Suite — JSS Paper Evaluation');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Iterations: ${N}`);
  console.log(`Target: (${TARGET_LAT}, ${TARGET_LON}), radius=${UNLOCK_RADIUS}m`);

  const resultsA = await experimentA();
  const resultsB = await experimentB();
  const resultsC = await experimentC();

  const output = {
    meta: {
      date: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      iterations: N,
      target: { lat: TARGET_LAT, lon: TARGET_LON, radius: UNLOCK_RADIUS },
    },
    experimentA: resultsA,
    experimentB: resultsB,
    experimentC: resultsC,
  };

  const outPath = path.join(__dirname, `benchmark-results-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
