/**
 * SBPP Leakage Attack Evaluation
 *
 * Quantifies leakage through two inference attacks:
 *
 * Experiment 1: Access-pattern-only inference
 *   Server observes which drops matched a search query, computes the centroid
 *   of matched drops' known locations, and measures localization error.
 *   Evaluated under uniform and clustered drop distributions.
 *
 * Experiment 2: Cross-session reassociation
 *   Attacker tries to link proof contexts across sessions.
 *   V2/V3 (no nonce): linkable by (dropId, pv, epoch).
 *   V4a/V4b (with nonce): unlinkable — nonce prevents matching.
 *
 * Paper section: SBPP — Inference Attack Resilience
 */

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
} from '../dist/encrypted-search.js';
import {
  calculateDistance,
  encodeGeohash,
} from '../dist/geofence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N_DROPS = 10000;
const N_QUERIES = 200;
const N_SESSIONS = 1000;
const SEARCH_RADIUS = 1000; // meters

const searchConfig = {
  searchKey: 'leakage-attack-key',
  precisionLevels: [4, 5, 6],
};

// Tokyo bounding box
const TOKYO_LAT_MIN = 35.6;
const TOKYO_LAT_MAX = 35.8;
const TOKYO_LON_MIN = 139.6;
const TOKYO_LON_MAX = 139.9;

// Clustered hotspots (lat, lon)
const HOTSPOTS = [
  { name: 'Shibuya',    lat: 35.6580, lon: 139.7016 },
  { name: 'Shinjuku',   lat: 35.6896, lon: 139.6922 },
  { name: 'Akihabara',  lat: 35.6984, lon: 139.7731 },
  { name: 'Roppongi',   lat: 35.6627, lon: 139.7307 },
  { name: 'Ikebukuro',  lat: 35.7295, lon: 139.7109 },
];

const CLUSTER_SIGMA_M = 500; // meters

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

/** Box-Muller transform for normal distribution */
function randomGaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Generate a point with Gaussian offset from a center (sigma in meters) */
function gaussianOffset(centerLat, centerLon, sigmaM) {
  const M_PER_DEG_LAT = 111000;
  const M_PER_DEG_LON = 111000 * Math.cos((centerLat * Math.PI) / 180);
  const dLat = (randomGaussian() * sigmaM) / M_PER_DEG_LAT;
  const dLon = (randomGaussian() * sigmaM) / M_PER_DEG_LON;
  return { lat: centerLat + dLat, lon: centerLon + dLon };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function summarize(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    median_km: Number(percentile(sorted, 50).toFixed(4)),
    mean_km: Number(mean(arr).toFixed(4)),
    p25_km: Number(percentile(sorted, 25).toFixed(4)),
    p75_km: Number(percentile(sorted, 75).toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Drop generation
// ═══════════════════════════════════════════════════════

function generateUniformDrops(n) {
  return Array.from({ length: n }, () => ({
    id: crypto.randomUUID(),
    lat: randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX),
    lon: randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX),
  }));
}

function generateClusteredDrops(n) {
  const drops = [];
  for (let i = 0; i < n; i++) {
    const hotspot = HOTSPOTS[i % HOTSPOTS.length];
    const { lat, lon } = gaussianOffset(hotspot.lat, hotspot.lon, CLUSTER_SIGMA_M);
    drops.push({ id: crypto.randomUUID(), lat, lon });
  }
  return drops;
}

// ═══════════════════════════════════════════════════════
// Experiment 1: Access-pattern-only inference
// ═══════════════════════════════════════════════════════

async function runInferenceExperiment(label, drops) {
  process.stderr.write(`\n[Exp1/${label}] Indexing ${drops.length} drops...\n`);

  const indexedDrops = [];
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    const tokens = await generateIndexTokens(d.lat, d.lon, searchConfig);
    indexedDrops.push({ dropId: d.id, tokens, lat: d.lat, lon: d.lon });
    if ((i + 1) % 2000 === 0) {
      process.stderr.write(`  indexed ${i + 1}/${drops.length}\n`);
    }
  }

  process.stderr.write(`[Exp1/${label}] Running ${N_QUERIES} inference attacks...\n`);

  const errors = [];

  for (let q = 0; q < N_QUERIES; q++) {
    // Random user search location within the Tokyo area
    const userLat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX);
    const userLon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX);

    // Generate search tokens and match
    const searchTokens = await generateSearchTokens(userLat, userLon, SEARCH_RADIUS, searchConfig);
    const matches = matchTokens(searchTokens, indexedDrops);

    if (matches.length === 0) {
      // No matches — attacker has no information; skip this query
      continue;
    }

    // Server-side inference: compute centroid of matched drops' known locations
    const matchedDrops = matches.map(m =>
      indexedDrops.find(d => d.dropId === m.dropId)
    ).filter(Boolean);

    const centroidLat = mean(matchedDrops.map(d => d.lat));
    const centroidLon = mean(matchedDrops.map(d => d.lon));

    // Localization error in km
    const errorM = calculateDistance(userLat, userLon, centroidLat, centroidLon);
    errors.push(errorM / 1000);

    if ((q + 1) % 50 === 0) {
      process.stderr.write(`  queries: ${q + 1}/${N_QUERIES}\n`);
    }
  }

  if (errors.length === 0) {
    process.stderr.write(`  WARNING: no queries produced matches — results are empty\n`);
    return { median_km: 0, mean_km: 0, p25_km: 0, p75_km: 0, n_with_matches: 0 };
  }

  const stats = summarize(errors);
  process.stderr.write(
    `  [${label}] n_with_matches=${errors.length}  median=${stats.median_km} km  mean=${stats.mean_km} km  P25=${stats.p25_km}  P75=${stats.p75_km}\n`
  );
  return { ...stats, n_with_matches: errors.length };
}

// ═══════════════════════════════════════════════════════
// Experiment 2: Cross-session reassociation
// ═══════════════════════════════════════════════════════

function runReassociationExperiment() {
  process.stderr.write(`\n[Exp2] Simulating ${N_SESSIONS} sessions for reassociation attack...\n`);

  // Simulate sessions: each session has a location L, a result set R,
  // and a proof context (dropId, pv, epoch).
  // "pv" = protocol version identifier for the proof
  // "epoch" = time bucket (e.g. 5-minute window)

  // Shared pool of drops that sessions draw from (simulates a real system
  // where many users query the same set of existing drops)
  const N_POOL = 500;
  const dropPool = Array.from({ length: N_POOL }, () => crypto.randomUUID());

  const sessions = [];
  const epochBase = Math.floor(Date.now() / 300000); // 5-minute epochs

  for (let i = 0; i < N_SESSIONS; i++) {
    const lat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX);
    const lon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX);

    // Simulate a result set of 5-20 drops drawn from the shared pool
    const nResults = 5 + Math.floor(Math.random() * 16);
    const resultDropIds = Array.from({ length: nResults }, () =>
      dropPool[Math.floor(Math.random() * N_POOL)]
    );

    // Pick a random drop from the result set for the proof context
    const chosenDrop = resultDropIds[Math.floor(Math.random() * nResults)];
    const pv = 'v1.0';
    const epoch = epochBase + Math.floor(i / 50); // sessions grouped into epochs

    // V4a/V4b: proof includes a random nonce bound to this session
    const nonce = crypto.randomUUID();

    sessions.push({
      lat, lon,
      resultDropIds: new Set(resultDropIds),
      proofContext: { dropId: chosenDrop, pv, epoch },
      nonce,
    });
  }

  // V2/V3 reassociation: attacker tries to match (dropId, pv, epoch)
  // across sessions. For session i, check if any other session j (j != i)
  // has a result set containing the same dropId AND shares (pv, epoch).
  let v2v3Successes = 0;

  for (let i = 0; i < N_SESSIONS; i++) {
    const ctx = sessions[i].proofContext;
    for (let j = 0; j < N_SESSIONS; j++) {
      if (i === j) continue;
      // Attacker checks: does session j's result set contain the same drop,
      // and does it share (pv, epoch)?
      if (
        sessions[j].resultDropIds.has(ctx.dropId) &&
        sessions[j].proofContext.pv === ctx.pv &&
        sessions[j].proofContext.epoch === ctx.epoch
      ) {
        v2v3Successes++;
        break; // count at most one success per session
      }
    }
  }

  const v2v3Rate = v2v3Successes / N_SESSIONS;

  // V4a/V4b reassociation: attacker also needs the exact nonce.
  // Since nonces are random UUIDs, the probability of collision is negligible.
  let v4Successes = 0;

  for (let i = 0; i < N_SESSIONS; i++) {
    const ctx = sessions[i].proofContext;
    const nonce = sessions[i].nonce;
    for (let j = 0; j < N_SESSIONS; j++) {
      if (i === j) continue;
      if (
        sessions[j].resultDropIds.has(ctx.dropId) &&
        sessions[j].proofContext.pv === ctx.pv &&
        sessions[j].proofContext.epoch === ctx.epoch &&
        sessions[j].nonce === nonce
      ) {
        v4Successes++;
        break;
      }
    }
  }

  const v4Rate = v4Successes / N_SESSIONS;

  process.stderr.write(`  V2/V3 reassociation success rate: ${(v2v3Rate * 100).toFixed(2)}%\n`);
  process.stderr.write(`  V4a/V4b reassociation success rate: ${(v4Rate * 100).toFixed(2)}%\n`);

  return {
    v2v3_success_rate: Number(v2v3Rate.toFixed(6)),
    v4_success_rate: Number(v4Rate.toFixed(6)),
    n_sessions: N_SESSIONS,
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();
  process.stderr.write('=== SBPP Leakage Attack Evaluation ===\n');

  // Experiment 1: Access-pattern-only inference
  const uniformDrops = generateUniformDrops(N_DROPS);
  const clusteredDrops = generateClusteredDrops(N_DROPS);

  const uniformResult = await runInferenceExperiment('uniform', uniformDrops);
  const clusteredResult = await runInferenceExperiment('clustered', clusteredDrops);

  // Experiment 2: Cross-session reassociation
  const reassocResult = runReassociationExperiment();

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`\nDone in ${elapsed}s.\n`);

  const results = {
    timestamp: new Date().toISOString(),
    inference: {
      uniform: uniformResult,
      clustered: clusteredResult,
    },
    reassociation: reassocResult,
  };

  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
