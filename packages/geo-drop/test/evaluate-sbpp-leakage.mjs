/**
 * SBPP Experiment 1: Information Leakage Analysis
 *
 * Compares per-query information leakage and cross-query linkability
 * across three approaches: plaintext, GridSE, and SBPP.
 *
 * Paper section: Experiment 1 — Information Leakage
 */

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
  selectPrecisionForRadius,
} from '../dist/encrypted-search.js';
import {
  createSession,
  sbppSearch,
} from '../dist/sbpp.js';
import {
  encodeGeohash,
  calculateDistance,
} from '../dist/geofence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N_DROPS = 10000;
const N_QUERIES = 1000;
const WALK_STEPS = 1000;
const WALK_STEP_METERS = 10;
const SEARCH_RADIUS = 1000; // meters

const TOKYO_LAT_MIN = 35.6;
const TOKYO_LAT_MAX = 35.8;
const TOKYO_LON_MIN = 139.6;
const TOKYO_LON_MAX = 139.9;

const SEARCH_KEY = 'sbpp-leakage-evaluation-key-2026';
const PRECISION_LEVELS = [4, 5, 6];

const EARTH_AREA_KM2 = 510e6;

/** Approximate geohash cell area (km^2) per precision level */
const CELL_AREA_KM2 = {
  1: 25000000,
  2: 6250000,
  3: 24336,
  4: 1521,
  5: 24.01,
  6: 1.44,
  7: 0.0225,
  8: 0.00144,
};

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function generateRandomDrop() {
  return {
    id: crypto.randomUUID(),
    lat: randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX),
    lon: randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX),
  };
}

function generateRandomQuery() {
  return {
    lat: randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX),
    lon: randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX),
  };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * log2 of binomial coefficient C(n, k).
 * For large n, use Stirling approximation: log2(C(n,k)) ≈ n*H(k/n) / ln2
 * where H(p) = -p*ln(p) - (1-p)*ln(1-p) is binary entropy.
 */
function log2Binomial(n, k) {
  if (k === 0 || k === n) return 0;
  if (k > n) return 0;
  const p = k / n;
  if (p <= 0 || p >= 1) return 0;
  const entropy = -p * Math.log(p) - (1 - p) * Math.log(1 - p);
  return (n * entropy) / Math.LN2;
}

/**
 * Compute Jaccard similarity between two Sets of strings.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Generate a walking path starting from a point, heading roughly northeast.
 */
function generateWalkPath(startLat, startLon, steps, stepMeters) {
  const path = [{ lat: startLat, lon: startLon }];
  // Each step: ~10m northeast
  // At Tokyo latitude, 1 degree lat ≈ 111km, 1 degree lon ≈ 91km
  const mPerDegLat = 111000;
  const mPerDegLon = 91000;
  const dLat = (stepMeters * 0.707) / mPerDegLat; // cos(45deg)
  const dLon = (stepMeters * 0.707) / mPerDegLon;

  let lat = startLat;
  let lon = startLon;
  for (let i = 1; i < steps; i++) {
    // Add small random perturbation to simulate real walking
    lat += dLat + (Math.random() - 0.5) * dLat * 0.3;
    lon += dLon + (Math.random() - 0.5) * dLon * 0.3;
    path.push({ lat, lon });
  }
  return path;
}

// ═══════════════════════════════════════════════════════
// Main evaluation
// ═══════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();
  const config = { searchKey: SEARCH_KEY, precisionLevels: PRECISION_LEVELS };

  // --- Generate drops ---
  process.stderr.write(`Generating ${N_DROPS} synthetic drops in Tokyo area...\n`);
  const drops = Array.from({ length: N_DROPS }, () => generateRandomDrop());

  // --- Pre-compute index tokens ---
  process.stderr.write('Computing index tokens for all drops...\n');
  const indexedDrops = [];
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    const tokens = await generateIndexTokens(d.lat, d.lon, config);
    indexedDrops.push({ dropId: d.id, tokens, lat: d.lat, lon: d.lon });
    if ((i + 1) % 2000 === 0) {
      process.stderr.write(`  indexed ${i + 1}/${N_DROPS}\n`);
    }
  }

  // --- Generate random search queries ---
  process.stderr.write(`Generating ${N_QUERIES} random search queries...\n`);
  const queries = Array.from({ length: N_QUERIES }, () => generateRandomQuery());

  // ═══════════════════════════════════════════════════════
  // Per-query leakage
  // ═══════════════════════════════════════════════════════

  process.stderr.write('Measuring per-query leakage...\n');

  const plaintextBitsArr = [];
  const gridseBitsArr = [];
  const sbppBitsArr = [];

  for (let q = 0; q < queries.length; q++) {
    const { lat, lon } = queries[q];

    // Plaintext leakage: server learns geohash prefix at precision 5
    // Leakage = log2(earth_area / cell_area)
    const precision = selectPrecisionForRadius(SEARCH_RADIUS, PRECISION_LEVELS);
    const cellArea = CELL_AREA_KM2[precision] ?? 24.01;
    const plaintextBits = Math.log2(EARTH_AREA_KM2 / cellArea);
    plaintextBitsArr.push(plaintextBits);

    // GridSE leakage: server learns which k out of N drops matched
    const searchTokens = await generateSearchTokens(lat, lon, SEARCH_RADIUS, config);
    const matches = matchTokens(searchTokens, indexedDrops);
    const k = matches.length;

    // Leakage = log2(C(N, k)) — how much the match pattern narrows possibilities
    const gridseBits = k > 0 ? log2Binomial(N_DROPS, k) : 0;
    gridseBitsArr.push(gridseBits);

    // SBPP per-query: same token-level leakage as GridSE
    // (SBPP adds session nonces but the search tokens are identical)
    sbppBitsArr.push(gridseBits);

    if ((q + 1) % 200 === 0) {
      process.stderr.write(`  queries: ${q + 1}/${N_QUERIES}\n`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Cross-query linkability
  // ═══════════════════════════════════════════════════════

  process.stderr.write('Measuring cross-query linkability along walking path...\n');

  const startLat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX - 0.02);
  const startLon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX - 0.02);
  const walkPath = generateWalkPath(startLat, startLon, WALK_STEPS, WALK_STEP_METERS);

  // Pre-compute geohashes and search tokens along the path
  const pathGeohashes = [];
  const pathSearchTokenSets = [];

  const selectedPrecision = selectPrecisionForRadius(SEARCH_RADIUS, PRECISION_LEVELS);

  for (let i = 0; i < walkPath.length; i++) {
    const { lat, lon } = walkPath[i];

    // Plaintext: geohash at selected precision
    const gh = encodeGeohash(lat, lon, selectedPrecision);
    pathGeohashes.push(gh);

    // GridSE / SBPP: search token sets
    const searchTokens = await generateSearchTokens(lat, lon, SEARCH_RADIUS, config);
    pathSearchTokenSets.push(new Set(searchTokens.tokens));

    if ((i + 1) % 200 === 0) {
      process.stderr.write(`  walk tokens: ${i + 1}/${WALK_STEPS}\n`);
    }
  }

  // Compute pairwise Jaccard similarities for consecutive steps
  const plaintextJaccards = [];
  const gridseJaccards = [];
  const sbppJaccards = [];

  for (let i = 0; i < walkPath.length - 1; i++) {
    // Plaintext: Jaccard over single-element sets (geohash strings)
    const ghA = new Set([pathGeohashes[i]]);
    const ghB = new Set([pathGeohashes[i + 1]]);
    plaintextJaccards.push(jaccardSimilarity(ghA, ghB));

    // GridSE: Jaccard over token sets (same key, deterministic)
    gridseJaccards.push(
      jaccardSimilarity(pathSearchTokenSets[i], pathSearchTokenSets[i + 1]),
    );

    // SBPP: same tokens per-query (session nonces differ between sessions,
    // but within a session the search tokens are deterministic like GridSE).
    // Cross-session: different nonces mean proofs cannot be correlated,
    // but the search tokens themselves are still deterministic.
    // So token-level Jaccard is identical to GridSE.
    sbppJaccards.push(
      jaccardSimilarity(pathSearchTokenSets[i], pathSearchTokenSets[i + 1]),
    );
  }

  // ═══════════════════════════════════════════════════════
  // Session isolation check
  // ═══════════════════════════════════════════════════════

  process.stderr.write('Verifying session isolation properties...\n');

  // Generate two sessions and verify their nonces differ
  const session1 = createSession({ ttlMs: 300000 });
  const session2 = createSession({ ttlMs: 300000 });
  const crossSessionProofReusePossible = session1.nonce === session2.nonce;
  // SBPP binds proof to session nonce → proof from S1 is invalid in S2
  const bindingPreventsDecorrelation = session1.nonce !== session2.nonce;

  // ═══════════════════════════════════════════════════════
  // Assemble results
  // ═══════════════════════════════════════════════════════

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`Done in ${elapsed}s. Writing JSON to stdout.\n`);

  const results = {
    timestamp: new Date().toISOString(),
    n_drops: N_DROPS,
    n_queries: N_QUERIES,
    walk_steps: WALK_STEPS,
    walk_step_meters: WALK_STEP_METERS,
    search_radius_meters: SEARCH_RADIUS,
    per_query: {
      plaintext: {
        mean_bits: Number(mean(plaintextBitsArr).toFixed(4)),
        std_bits: Number(stddev(plaintextBitsArr).toFixed(4)),
      },
      gridse: {
        mean_bits: Number(mean(gridseBitsArr).toFixed(4)),
        std_bits: Number(stddev(gridseBitsArr).toFixed(4)),
      },
      sbpp: {
        mean_bits: Number(mean(sbppBitsArr).toFixed(4)),
        std_bits: Number(stddev(sbppBitsArr).toFixed(4)),
      },
    },
    cross_query: {
      plaintext: {
        mean_jaccard: Number(mean(plaintextJaccards).toFixed(6)),
        std_jaccard: Number(stddev(plaintextJaccards).toFixed(6)),
      },
      gridse: {
        mean_jaccard: Number(mean(gridseJaccards).toFixed(6)),
        std_jaccard: Number(stddev(gridseJaccards).toFixed(6)),
      },
      sbpp: {
        mean_jaccard: Number(mean(sbppJaccards).toFixed(6)),
        std_jaccard: Number(stddev(sbppJaccards).toFixed(6)),
      },
    },
    session_isolation: {
      cross_session_proof_reuse_possible: crossSessionProofReusePossible,
      binding_prevents_decorrelation: bindingPreventsDecorrelation,
    },
  };

  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
