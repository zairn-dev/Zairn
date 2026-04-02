/**
 * Performance Benchmark — ZK proof generation time
 *
 * Measures Groth16 proof generation for:
 * 1. Grid Membership (175 constraints)
 * 2. Departure (418 constraints)
 *
 * Uses snarkjs WASM prover in Node.js (approximates browser performance).
 * Runs 20 iterations each and reports P50/P95/mean.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const CIRCUITS_DIR = join(import.meta.dirname, '..', '..', 'packages', 'geo-drop', 'circuits');
const RESULTS_DIR = join(import.meta.dirname, 'results');

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  // Check if snarkjs is available
  let snarkjs;
  try {
    snarkjs = await import('../../packages/geo-drop/node_modules/snarkjs/main.js');
  } catch (e) {
    console.error('snarkjs not available. Install with: pnpm add -w snarkjs');
    console.error('Generating placeholder results from prior benchmarks...');
    await writePlaceholder();
    return;
  }

  const circuits = [
    {
      name: 'grid_membership',
      wasmPath: join(CIRCUITS_DIR, 'build', 'grid_membership_zkp_js', 'grid_membership_zkp.wasm'),
      zkeyPath: join(CIRCUITS_DIR, 'grid_membership_zkp_final.zkey'),
      vkeyPath: join(CIRCUITS_DIR, 'grid_membership_zkp_vkey.json'),
      // GridMembershipZkp inputs:
      //   public: cellRow, cellCol, gridSizeFp, gridOffsetLatFp, gridOffsetLonFp, contextDigest, epoch
      //   private: userLat, userLon
      // lat=35.681200 → 35681200 (×1e6), lon=139.767100 → 139767100
      // gridSizeFp = 500m in lat degrees ×1e6 ≈ 4491
      // shifted lat = 35681200 + 90000000 = 125681200
      // cellRow = floor((125681200 + offset) / gridSizeFp)
      input: (() => {
        const gridSizeFp = 4491; // ~500m in lat degrees ×1e6
        const offsetLat = 1234;
        const offsetLon = 2345;
        const userLat = 35681200;
        const userLon = 139767100;
        const LAT_SHIFT = 90000000;
        const LON_SHIFT = 180000000;
        const cellRow = Math.floor((userLat + LAT_SHIFT + offsetLat) / gridSizeFp);
        const cellCol = Math.floor((userLon + LON_SHIFT + offsetLon) / gridSizeFp);
        return {
          cellRow, cellCol, gridSizeFp,
          gridOffsetLatFp: offsetLat, gridOffsetLonFp: offsetLon,
          contextDigest: 12345, epoch: 1000,
          userLat, userLon,
        };
      })(),
    },
    {
      name: 'departure',
      wasmPath: join(CIRCUITS_DIR, 'build', 'departure_zkp_js', 'departure_zkp.wasm'),
      zkeyPath: join(CIRCUITS_DIR, 'departure_zkp_final.zkey'),
      vkeyPath: join(CIRCUITS_DIR, 'departure_zkp_vkey.json'),
      // DepartureZkp inputs:
      //   public: homeCommitment, minDistanceSquared, cosLatScaled, contextDigest, epoch
      //   private: userLat, userLon, homeLat, homeLon, homeSalt
      input: (() => {
        const homeLat = 35681200;
        const homeLon = 139767100;
        const homeSalt = 42;
        // AlgebraicHash: a*P1 + b*P2 + c*P3 + a*b + b*c + P4
        const P1 = 1000000007n, P2 = 998244353n, P3 = 1000000009n, P4 = 999999937n;
        const a = BigInt(homeLat), b = BigInt(homeLon), c = BigInt(homeSalt);
        const commitment = a*P1 + b*P2 + c*P3 + a*b + b*c + P4;
        // User far from home: 35.658, 139.7016
        const userLat = 35658000;
        const userLon = 139701600;
        // Distance² in fixed-point
        const dLat = userLat - homeLat; // -23200
        const dLon = userLon - homeLon; // -65500
        const cosLat = 809017; // cos(35.68°) × 1e6
        const dLonAdj = Math.floor(dLon * cosLat / 1000000);
        const distSq = dLat * dLat + dLonAdj * dLonAdj;
        const minDistSq = Math.floor(distSq * 0.5); // threshold below actual
        return {
          homeCommitment: commitment.toString(),
          minDistanceSquared: minDistSq,
          cosLatScaled: cosLat,
          contextDigest: 12345, epoch: 1000,
          userLat, userLon, homeLat, homeLon, homeSalt,
        };
      })(),
    },
  ];

  const results = {};
  const WARMUP = 3;
  const RUNS = 20;

  for (const circuit of circuits) {
    console.log(`\nBenchmarking ${circuit.name}...`);

    // Check files exist
    try {
      await readFile(circuit.wasmPath);
      await readFile(circuit.zkeyPath);
    } catch (e) {
      console.log(`  Skipping: ${e.message}`);
      continue;
    }

    const times = [];

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      try {
        const start = performance.now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          circuit.input, circuit.wasmPath, circuit.zkeyPath
        );
        const elapsed = performance.now() - start;
        console.log(`  Warmup ${i + 1}: ${elapsed.toFixed(1)}ms`);
      } catch (e) {
        console.log(`  Warmup error: ${e.message}`);
        break;
      }
    }

    // Timed runs
    for (let i = 0; i < RUNS; i++) {
      try {
        const start = performance.now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          circuit.input, circuit.wasmPath, circuit.zkeyPath
        );
        const elapsed = performance.now() - start;
        times.push(elapsed);
      } catch (e) {
        console.log(`  Run ${i + 1} error: ${e.message}`);
      }
    }

    if (times.length === 0) continue;

    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    const min = times[0];
    const max = times[times.length - 1];

    results[circuit.name] = {
      runs: times.length,
      p50: Math.round(p50 * 10) / 10,
      p95: Math.round(p95 * 10) / 10,
      mean: Math.round(mean * 10) / 10,
      min: Math.round(min * 10) / 10,
      max: Math.round(max * 10) / 10,
    };

    console.log(`  Results (${times.length} runs):`);
    console.log(`    P50: ${p50.toFixed(1)}ms  P95: ${p95.toFixed(1)}ms  Mean: ${mean.toFixed(1)}ms`);
    console.log(`    Min: ${min.toFixed(1)}ms  Max: ${max.toFixed(1)}ms`);

    // Also benchmark verification
    try {
      const vkey = JSON.parse(await readFile(circuit.vkeyPath, 'utf-8'));
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuit.input, circuit.wasmPath, circuit.zkeyPath
      );

      const verifyTimes = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
        verifyTimes.push(performance.now() - start);
      }
      verifyTimes.sort((a, b) => a - b);
      const vp50 = verifyTimes[Math.floor(verifyTimes.length * 0.5)];
      results[circuit.name + '_verify'] = {
        p50: Math.round(vp50 * 10) / 10,
        mean: Math.round(verifyTimes.reduce((s, t) => s + t, 0) / verifyTimes.length * 10) / 10,
      };
      console.log(`  Verify P50: ${vp50.toFixed(1)}ms`);
    } catch (e) {
      console.log(`  Verify error: ${e.message}`);
    }
  }

  // Add metadata
  results.platform = {
    runtime: 'Node.js ' + process.version,
    arch: process.arch,
    platform: process.platform,
  };

  await writeFile(join(RESULTS_DIR, 'performance.json'), JSON.stringify(results, null, 2));
  console.log('\nResults saved to', join(RESULTS_DIR, 'performance.json'));
}

async function writePlaceholder() {
  // Use prior benchmark data from SBPP/TDSC papers
  const results = {
    grid_membership: {
      note: 'Estimated from prior benchmarks (SBPP/TDSC papers)',
      constraints: 175,
      estimated_prove_ms: '20-40',
      estimated_verify_ms: '5-10',
    },
    departure: {
      note: 'Estimated from prior benchmarks (SBPP/TDSC papers)',
      constraints: 418,
      estimated_prove_ms: '50-100',
      estimated_verify_ms: '5-10',
    },
    prior_benchmarks: {
      note: 'From SBPP (TIFS) paper — Groth16 on BN128',
      proximity_474_constraints: {
        desktop_x86: '39.8ms median',
        iphone_16_pro_wasm: '42ms warm',
        poco_x7_pro_wasm: '125ms warm',
      },
      context_bound_474_constraints: {
        desktop_x86: '77.9ms median',
      },
    },
    platform: { runtime: 'Node.js ' + process.version, note: 'snarkjs not available, using estimates' },
  };
  await writeFile(join(RESULTS_DIR, 'performance.json'), JSON.stringify(results, null, 2));
  console.log('Placeholder results saved.');
}

main().catch(console.error);
