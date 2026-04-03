/**
 * PLONK vs Groth16 Benchmark
 * Compares proving time and proof size for both protocols.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';

const snarkjs = await import('../../packages/geo-drop/node_modules/snarkjs/main.js');
const CIRCUITS_DIR = join(import.meta.dirname, '..', '..', 'packages', 'geo-drop', 'circuits');

// Grid Membership input (same as performance-bench)
const gridSizeFp = 4491;
const offsetLat = 1234, offsetLon = 2345;
const userLat = 35681200, userLon = 139767100;
const LAT_SHIFT = 90000000, LON_SHIFT = 180000000;
const cellRow = Math.floor((userLat + LAT_SHIFT + offsetLat) / gridSizeFp);
const cellCol = Math.floor((userLon + LON_SHIFT + offsetLon) / gridSizeFp);

const gridInput = {
  cellRow: String(cellRow), cellCol: String(cellCol),
  gridSizeFp: String(gridSizeFp),
  gridOffsetLatFp: String(offsetLat), gridOffsetLonFp: String(offsetLon),
  contextDigest: '12345', epoch: '1000',
  userLat: String(userLat), userLon: String(userLon),
};

// Departure input
const homeLat = 35681200n, homeLon = 139767100n, homeSalt = 42n;
const P1 = 1000000007n, P2 = 998244353n, P3 = 1000000009n, P4 = 999999937n;
const commitment = homeLat*P1 + homeLon*P2 + homeSalt*P3 + homeLat*homeLon + homeLon*homeSalt + P4;
const dLat = 35658000 - 35681200, dLon = 139701600 - 139767100;
const cosLat = 809017;
const dLonAdj = Math.floor(dLon * cosLat / 1000000);
const distSq = dLat * dLat + dLonAdj * dLonAdj;

const depInput = {
  homeCommitment: commitment.toString(),
  minDistanceSquared: String(Math.floor(distSq * 0.5)),
  cosLatScaled: String(cosLat),
  contextDigest: '12345', epoch: '1000',
  userLat: '35658000', userLon: '139701600',
  homeLat: '35681200', homeLon: '139767100', homeSalt: '42',
};

const WARMUP = 3;
const RUNS = 10;

async function bench(name, wasm, zkey, vkey, input, protocol) {
  console.log(`\n=== ${name} (${protocol}) ===`);

  const proveMethod = protocol === 'plonk' ? snarkjs.plonk : snarkjs.groth16;
  const times = [];

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const t0 = performance.now();
    await proveMethod.fullProve(input, wasm, zkey);
    console.log(`  Warmup ${i + 1}: ${(performance.now() - t0).toFixed(1)}ms`);
  }

  // Timed
  let lastProof, lastSignals;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const { proof, publicSignals } = await proveMethod.fullProve(input, wasm, zkey);
    times.push(performance.now() - t0);
    lastProof = proof; lastSignals = publicSignals;
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  console.log(`  P50: ${p50.toFixed(1)}ms  Mean: ${mean.toFixed(1)}ms`);

  // Proof size
  const proofJson = JSON.stringify(lastProof);
  console.log(`  Proof size: ${proofJson.length} chars (JSON)`);

  // Verify
  const vkeyData = JSON.parse(await readFile(vkey, 'utf-8'));
  const t0 = performance.now();
  const valid = await proveMethod.verify(vkeyData, lastSignals, lastProof);
  console.log(`  Verify: ${(performance.now() - t0).toFixed(1)}ms (valid=${valid})`);

  return { protocol, p50: +p50.toFixed(1), mean: +mean.toFixed(1), proofChars: proofJson.length };
}

console.log('=== PLONK vs Groth16 Benchmark ===');

// Grid Membership
const gridGroth = await bench('Grid Membership',
  join(CIRCUITS_DIR, 'build/grid_membership_zkp_js/grid_membership_zkp.wasm'),
  join(CIRCUITS_DIR, 'grid_membership_zkp_final.zkey'),
  join(CIRCUITS_DIR, 'grid_membership_zkp_vkey.json'),
  gridInput, 'groth16');

const gridPlonk = await bench('Grid Membership',
  join(CIRCUITS_DIR, 'build/grid_membership_zkp_js/grid_membership_zkp.wasm'),
  join(CIRCUITS_DIR, 'grid_membership_zkp_plonk.zkey'),
  join(CIRCUITS_DIR, 'grid_membership_zkp_plonk_vkey.json'),
  gridInput, 'plonk');

// Departure
const depGroth = await bench('Departure',
  join(CIRCUITS_DIR, 'build/departure_zkp_js/departure_zkp.wasm'),
  join(CIRCUITS_DIR, 'departure_zkp_final.zkey'),
  join(CIRCUITS_DIR, 'departure_zkp_vkey.json'),
  depInput, 'groth16');

const depPlonk = await bench('Departure',
  join(CIRCUITS_DIR, 'build/departure_zkp_js/departure_zkp.wasm'),
  join(CIRCUITS_DIR, 'departure_zkp_plonk.zkey'),
  join(CIRCUITS_DIR, 'departure_zkp_plonk_vkey.json'),
  depInput, 'plonk');

console.log('\n=== COMPARISON ===');
console.log('Circuit          | Groth16 P50 | PLONK P50 | Slowdown');
console.log('-'.repeat(60));
console.log(`Grid Membership  | ${gridGroth.p50}ms`.padEnd(30) + `| ${gridPlonk.p50}ms`.padEnd(15) + `| ${(gridPlonk.p50/gridGroth.p50).toFixed(1)}x`);
console.log(`Departure        | ${depGroth.p50}ms`.padEnd(30) + `| ${depPlonk.p50}ms`.padEnd(15) + `| ${(depPlonk.p50/depGroth.p50).toFixed(1)}x`);
