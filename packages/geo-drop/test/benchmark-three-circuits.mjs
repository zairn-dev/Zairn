/**
 * Three-circuit benchmark: isolating V2 fix vs context binding overhead.
 *
 * Circuits:
 *   1. Prototype     — original circuit (V2 bug, no context binding)
 *   2. Sound geo-only — V2-fixed arithmetic, no context binding
 *   3. Zairn-ZKP     — V2-fixed arithmetic + context binding
 *
 * This separates the cost of bounded arithmetic (prototype → sound geo)
 * from the cost of context binding (sound geo → Zairn-ZKP).
 *
 * Paper section: §8 RQ3 — Performance overhead decomposition
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import * as snarkjs from 'snarkjs';
import { createHash } from 'node:crypto';

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

const SCALE = 1_000_000;
const toFP = (deg) => BigInt(Math.round(deg * SCALE));
const metersToR2 = (m) => { const r = BigInt(Math.round((m / 111320) * SCALE)); return (r * r).toString(); };
const cosLatS = (lat) => BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

const N_RUNS = 50;

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

const contextInput = {
  contextDigest: hashToDecimal('drop-bench:2:42'),
  epoch: '42',
  challengeDigest: hashToDecimal('nonce-bench'),
};

const circuits = [
  {
    name: 'Prototype (V2 bug)',
    wasm: path.join(buildDir, 'proximity_js', 'proximity.wasm'),
    zkey: path.join(circuitsDir, 'proximity_final.zkey'),
    input: { ...geoInput, ...userInput },
  },
  {
    name: 'Sound geo-only (V2 fixed)',
    wasm: path.join(buildDir, 'sound_geo_only_js', 'sound_geo_only.wasm'),
    zkey: path.join(circuitsDir, 'sound_geo_only_final.zkey'),
    input: { ...geoInput, ...userInput },
  },
  {
    name: 'Zairn-ZKP (V2 fixed + context)',
    wasm: path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm'),
    zkey: path.join(circuitsDir, 'zairn_zkp_final.zkey'),
    input: { ...geoInput, ...userInput, ...contextInput },
  },
];

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { mean: +mean.toFixed(2), std: +std.toFixed(2), median: +median.toFixed(2), p95: +p95.toFixed(2) };
}

async function benchCircuit(circuit) {
  // Warm-up run
  await snarkjs.groth16.fullProve(circuit.input, circuit.wasm, circuit.zkey);

  const proveTimes = [];
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now();
    await snarkjs.groth16.fullProve(circuit.input, circuit.wasm, circuit.zkey);
    proveTimes.push(performance.now() - t0);
  }

  return { name: circuit.name, prove: stats(proveTimes), n: N_RUNS };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Three-Circuit Benchmark: V2 Fix vs Context Binding');
  console.log(`  ${N_RUNS} warm runs per circuit`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = [];
  for (const circuit of circuits) {
    console.log(`Benchmarking: ${circuit.name}...`);
    const r = await benchCircuit(circuit);
    console.log(`  Prove median: ${r.prove.median} ms, mean±std: ${r.prove.mean}±${r.prove.std} ms, p95: ${r.prove.p95} ms`);
    results.push(r);
  }

  // Overhead analysis
  const proto = results[0].prove.median;
  const sound = results[1].prove.median;
  const zairn = results[2].prove.median;

  console.log('\n─── Overhead Decomposition ───');
  console.log(`  Prototype → Sound geo-only: +${(sound - proto).toFixed(2)} ms (V2 fix cost)`);
  console.log(`  Sound geo-only → Zairn-ZKP: +${(zairn - sound).toFixed(2)} ms (context binding cost)`);
  console.log(`  Prototype → Zairn-ZKP:      +${(zairn - proto).toFixed(2)} ms (total)`);
  console.log(`  V2 fix fraction:            ${(((sound - proto) / (zairn - proto)) * 100).toFixed(1)}%`);
  console.log(`  Context binding fraction:   ${(((zairn - sound) / (zairn - proto)) * 100).toFixed(1)}%`);

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `three-circuit-benchmark-${dateStr}.json`);
  await writeFile(outputPath, JSON.stringify({
    experiment: 'three-circuit-benchmark',
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    n: N_RUNS,
    results,
    decomposition: {
      v2FixCost: +(sound - proto).toFixed(2),
      contextBindingCost: +(zairn - sound).toFixed(2),
      totalOverhead: +(zairn - proto).toFixed(2),
    },
  }, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
