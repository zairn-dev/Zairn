/**
 * Network-in-the-loop benchmark for JSS Paper RQ4
 *
 * Measures the three components of an unlock workflow:
 *   1. Network round-trip (HTTPS fetch to Supabase REST API)
 *   2. Content decryption (AES-GCM via Web Crypto)
 *   3. Proof generation (for comparison, from Experiment A)
 *
 * Run: npx tsx test/benchmark-network.ts
 */

import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from '../src/crypto.js';
import {
  generateZairnZkpProof,
  verifyProximityProof,
} from '../src/index.js';
import type { ZkpConfig, VerificationKey } from '../src/zkp.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repo root
import { readFileSync as readFs } from 'node:fs';
const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
try {
  const envContent = readFs(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* .env not found, rely on existing env */ }

const CIRCUITS_DIR = path.resolve(__dirname, '..', 'circuits');
const BUILD_DIR = path.join(CIRCUITS_DIR, 'build');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
  process.exit(1);
}

const N_NETWORK = 30;
const N_DECRYPT = 50;
const N_PROVE = 10; // fewer for comparison (main stats in Experiment A)

// =====================
// Statistics
// =====================

interface Stats {
  n: number; mean: number; std: number; median: number;
  q1: number; q3: number; iqr: number; p95: number; min: number; max: number;
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const std = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  return { n, mean, std, median, q1, q3, iqr: q3 - q1, p95: sorted[Math.floor(n * 0.95)], min: sorted[0], max: sorted[n - 1] };
}

function fmt(v: number): string { return v.toFixed(2); }

function printStats(label: string, s: Stats) {
  console.log(`  ${label}: median=${fmt(s.median)}ms  mean=${fmt(s.mean)}ms  std=${fmt(s.std)}ms  p95=${fmt(s.p95)}ms  range=[${fmt(s.min)}, ${fmt(s.max)}]`);
}

// =====================
// 1. Network round-trip
// =====================

async function benchNetwork() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`NETWORK ROUND-TRIP (${N_NETWORK} requests to Supabase REST API)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Target: ${SUPABASE_URL}`);

  // Warm up DNS / TLS
  console.log('  Warming up connection...');
  await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { 'apikey': SUPABASE_ANON_KEY!, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
  });

  // Measure: simple GET to REST API (lightweight query)
  const rttTimes: number[] = [];
  for (let i = 0; i < N_NETWORK; i++) {
    const t0 = performance.now();
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { 'apikey': SUPABASE_ANON_KEY!, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    });
    await resp.text(); // consume body
    rttTimes.push(performance.now() - t0);
  }

  console.log(`\n  REST API GET (warm, ${N_NETWORK} runs):`);
  printStats('RTT', computeStats(rttTimes));
  printStats('RTT (excl. first)', computeStats(rttTimes.slice(1)));

  // Also measure a POST-like request (simulate proof submission)
  // Use Supabase RPC or a table query with body
  const postTimes: number[] = [];
  for (let i = 0; i < N_NETWORK; i++) {
    const t0 = performance.now();
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY!,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    await resp.text();
    postTimes.push(performance.now() - t0);
  }

  console.log(`\n  REST API POST (warm, ${N_NETWORK} runs):`);
  printStats('RTT', computeStats(postTimes));

  return {
    get: computeStats(rttTimes),
    getWarm: computeStats(rttTimes.slice(1)),
    post: computeStats(postTimes),
    postWarm: computeStats(postTimes.slice(1)),
  };
}

// =====================
// 2. Content decryption
// =====================

async function benchDecryption() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CONTENT DECRYPTION (AES-256-GCM, ${N_DECRYPT} runs per size)`);
  console.log(`${'='.repeat(60)}`);

  const sizes = [
    { label: '1 KB', bytes: 1_000 },
    { label: '10 KB', bytes: 10_000 },
    { label: '100 KB', bytes: 100_000 },
    { label: '1 MB', bytes: 1_000_000 },
  ];

  const password = 'geodrop:xn77h3c:drop-123:salt-abc:server-secret';
  const results: Record<string, { encrypt: Stats; decrypt: Stats }> = {};

  for (const size of sizes) {
    // Generate random plaintext of given size
    const plaintext = 'A'.repeat(size.bytes);

    // Pre-encrypt once
    const encrypted = await encrypt(plaintext, password);

    const encTimes: number[] = [];
    const decTimes: number[] = [];

    for (let i = 0; i < N_DECRYPT; i++) {
      const t0 = performance.now();
      await encrypt(plaintext, password);
      encTimes.push(performance.now() - t0);

      const t1 = performance.now();
      await decrypt(encrypted, password);
      decTimes.push(performance.now() - t1);
    }

    console.log(`\n  ${size.label}:`);
    printStats('Encrypt', computeStats(encTimes));
    printStats('Decrypt', computeStats(decTimes));

    results[size.label] = {
      encrypt: computeStats(encTimes),
      decrypt: computeStats(decTimes),
    };
  }

  return results;
}

// =====================
// 3. Proof generation (reference)
// =====================

async function benchProofRef() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROOF GENERATION reference (${N_PROVE} runs)`);
  console.log(`${'='.repeat(60)}`);

  const zairnConfig: ZkpConfig = {
    artifacts: {
      wasmUrl: path.join(BUILD_DIR, 'zairn_zkp_js', 'zairn_zkp.wasm'),
      zkeyUrl: path.join(CIRCUITS_DIR, 'zairn_zkp_final.zkey'),
    },
  };
  const zairnVkey: VerificationKey = JSON.parse(
    readFileSync(path.join(CIRCUITS_DIR, 'verification_key.json'), 'utf8')
  );

  const context = { dropId: 'net-bench-drop', policyVersion: '2', epoch: 200, serverNonce: 'net-bench-nonce' };
  const DEG2RAD = Math.PI / 180;
  const targetLat = 35.6586, targetLon = 139.7454, radius = 50;
  const userLat = targetLat + (30 * Math.cos(45 * DEG2RAD)) / 111320;
  const userLon = targetLon + (30 * Math.sin(45 * DEG2RAD)) / (111320 * Math.cos(targetLat * DEG2RAD));

  const proveTimes: number[] = [];
  const verifyTimes: number[] = [];

  for (let i = 0; i < N_PROVE; i++) {
    const t0 = performance.now();
    const result = await generateZairnZkpProof(userLat, userLon, targetLat, targetLon, radius, context, zairnConfig);
    proveTimes.push(performance.now() - t0);

    const tv0 = performance.now();
    await verifyProximityProof(result.proof, result.publicSignals, zairnVkey);
    verifyTimes.push(performance.now() - tv0);
  }

  console.log(`\n  Prove:`);
  printStats('All', computeStats(proveTimes));
  printStats('Warm (2..N)', computeStats(proveTimes.slice(1)));
  console.log(`  Verify:`);
  printStats('All', computeStats(verifyTimes));

  return {
    prove: computeStats(proveTimes),
    proveWarm: computeStats(proveTimes.slice(1)),
    verify: computeStats(verifyTimes),
  };
}

// =====================
// Main
// =====================

async function main() {
  console.log('Network-in-the-loop Benchmark — JSS Paper RQ4');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Node.js: ${process.version}`);

  const networkResults = await benchNetwork();
  const decryptResults = await benchDecryption();
  const proofResults = await benchProofRef();

  // Summary comparison
  console.log(`\n${'='.repeat(60)}`);
  console.log('COMPONENT BREAKDOWN (median values)');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Proof generation:     ${fmt(proofResults.proveWarm.median)} ms`);
  console.log(`  Proof verification:   ${fmt(proofResults.verify.median)} ms`);
  console.log(`  Network RTT (GET):    ${fmt(networkResults.getWarm.median)} ms`);
  console.log(`  Network RTT (POST):   ${fmt(networkResults.postWarm.median)} ms`);
  console.log(`  Decrypt 1 KB:         ${fmt(decryptResults['1 KB'].decrypt.median)} ms`);
  console.log(`  Decrypt 10 KB:        ${fmt(decryptResults['10 KB'].decrypt.median)} ms`);
  console.log(`  Decrypt 100 KB:       ${fmt(decryptResults['100 KB'].decrypt.median)} ms`);
  console.log(`  Decrypt 1 MB:         ${fmt(decryptResults['1 MB'].decrypt.median)} ms`);

  // Simulated end-to-end: 2 × RTT + prove + verify + decrypt
  const simE2e = 2 * networkResults.postWarm.median + proofResults.proveWarm.median + proofResults.verify.median + decryptResults['10 KB'].decrypt.median;
  const proveShare = proofResults.proveWarm.median / simE2e * 100;
  console.log(`\n  Simulated E2E (2×POST RTT + prove + verify + decrypt 10KB): ${fmt(simE2e)} ms`);
  console.log(`  Proof generation share: ${fmt(proveShare)}%`);
  console.log(`  Network share: ${fmt(2 * networkResults.postWarm.median / simE2e * 100)}%`);

  const output = {
    meta: {
      date: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      supabaseRegion: SUPABASE_URL,
    },
    network: networkResults,
    decryption: decryptResults,
    proof: proofResults,
    summary: {
      proveMedian: proofResults.proveWarm.median,
      verifyMedian: proofResults.verify.median,
      networkGetMedian: networkResults.getWarm.median,
      networkPostMedian: networkResults.postWarm.median,
      decrypt10kbMedian: decryptResults['10 KB'].decrypt.median,
      simulatedE2e: simE2e,
      proveSharePercent: proveShare,
    },
  };

  const outPath = path.join(__dirname, `network-benchmark-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
