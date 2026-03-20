/**
 * SBPP Clustered Distribution Evaluation
 *
 * Tests SBPP encrypted search performance under clustered (non-uniform)
 * spatial distribution mimicking real-world POI density, compared against
 * a uniform baseline.
 *
 * Paper section: Spatial distribution sensitivity analysis
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-sbpp-clustered.mjs
 */

import { performance } from 'node:perf_hooks';

import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
} from '../dist/encrypted-search.js';
import {
  calculateDistance,
} from '../dist/geofence.js';

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N_DROPS = 10000;
const DROPS_PER_HOTSPOT = 2000;
const SIGMA_METERS = 500;
const RADII = [100, 500, 1000, 5000];
const QUERIES_PER_RADIUS = 50;

const SEARCH_KEY = 'sbpp-clustered-eval-key-2026';
const PRECISION_LEVELS = [4, 5, 6];
const CONFIG = { searchKey: SEARCH_KEY, precisionLevels: PRECISION_LEVELS };

// Tokyo hotspot centers
const HOTSPOTS = [
  { name: 'Shibuya',    lat: 35.6580, lon: 139.7016 },
  { name: 'Shinjuku',   lat: 35.6938, lon: 139.7034 },
  { name: 'Akihabara',  lat: 35.6984, lon: 139.7731 },
  { name: 'Roppongi',   lat: 35.6627, lon: 139.7307 },
  { name: 'Ikebukuro',  lat: 35.7295, lon: 139.7109 },
];

// Bounding box for uniform distribution (covers all hotspots with margin)
const TOKYO_LAT_MIN = 35.6;
const TOKYO_LAT_MAX = 35.8;
const TOKYO_LON_MIN = 139.65;
const TOKYO_LON_MAX = 139.85;

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/** Box-Muller transform for Gaussian random numbers */
function gaussianRandom() {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Offset a lat/lon by Gaussian noise with given sigma in meters.
 * Approximation: 1 degree lat ~ 111320m, 1 degree lon ~ 111320*cos(lat)m.
 */
function gaussianOffset(centerLat, centerLon, sigmaMeters) {
  const dLatMeters = gaussianRandom() * sigmaMeters;
  const dLonMeters = gaussianRandom() * sigmaMeters;
  const lat = centerLat + dLatMeters / 111320;
  const lon = centerLon + dLonMeters / (111320 * Math.cos(centerLat * Math.PI / 180));
  return { lat, lon };
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ═══════════════════════════════════════════════════════
// Drop generation
// ═══════════════════════════════════════════════════════

function generateClusteredPositions() {
  const positions = [];
  for (const hotspot of HOTSPOTS) {
    for (let i = 0; i < DROPS_PER_HOTSPOT; i++) {
      const { lat, lon } = gaussianOffset(hotspot.lat, hotspot.lon, SIGMA_METERS);
      positions.push({ lat, lon, hotspot: hotspot.name });
    }
  }
  return positions;
}

function generateUniformPositions() {
  const positions = [];
  for (let i = 0; i < N_DROPS; i++) {
    positions.push({
      lat: randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX),
      lon: randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX),
      hotspot: null,
    });
  }
  return positions;
}

async function indexDrops(positions) {
  const drops = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const tokens = await generateIndexTokens(p.lat, p.lon, CONFIG);
    drops.push({ id: `drop-${i}`, lat: p.lat, lon: p.lon, tokens });
    if ((i + 1) % 2000 === 0) {
      process.stderr.write(`  indexed ${i + 1}/${positions.length}\n`);
    }
  }
  return drops;
}

// ═══════════════════════════════════════════════════════
// Evaluation
// ═══════════════════════════════════════════════════════

async function evaluateDistribution(label, drops) {
  const indexedDrops = drops.map((d) => ({ dropId: d.id, tokens: d.tokens }));
  const results = [];

  for (const radius of RADII) {
    process.stderr.write(`  ${label} radius=${radius}m: ${QUERIES_PER_RADIUS} queries...\n`);

    const matchCountsArr = [];
    let totalTP = 0;
    let totalFP = 0;
    let totalFN = 0;

    for (let q = 0; q < QUERIES_PER_RADIUS; q++) {
      // Pick a random search location from within the drop area
      // For clustered: pick near a random hotspot; for uniform: random in bbox
      let qLat, qLon;
      if (label === 'clustered') {
        const h = HOTSPOTS[Math.floor(Math.random() * HOTSPOTS.length)];
        const offset = gaussianOffset(h.lat, h.lon, SIGMA_METERS * 1.5);
        qLat = offset.lat;
        qLon = offset.lon;
      } else {
        qLat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX);
        qLon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX);
      }

      const searchTokens = await generateSearchTokens(qLat, qLon, radius, CONFIG);
      const matches = matchTokens(searchTokens, indexedDrops);
      matchCountsArr.push(matches.length);

      // Ground truth
      const matchedIds = new Set(matches.map((m) => m.dropId));

      for (const d of drops) {
        const dist = calculateDistance(qLat, qLon, d.lat, d.lon);
        const isWithin = dist <= radius;
        const isMatched = matchedIds.has(d.id);

        if (isWithin && isMatched) totalTP++;
        else if (!isWithin && isMatched) totalFP++;
        else if (isWithin && !isMatched) totalFN++;
      }
    }

    const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
    const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;

    results.push({
      radius,
      avg_matches: Number(mean(matchCountsArr).toFixed(2)),
      precision: Number(precision.toFixed(6)),
      recall: Number(recall.toFixed(6)),
      fp_count: totalFP,
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();

  // Generate clustered drops
  process.stderr.write(`Generating ${N_DROPS} clustered drops (5 hotspots, sigma=${SIGMA_METERS}m)...\n`);
  const clusteredPositions = generateClusteredPositions();
  const clusteredDrops = await indexDrops(clusteredPositions);

  // Generate uniform drops
  process.stderr.write(`Generating ${N_DROPS} uniform drops...\n`);
  const uniformPositions = generateUniformPositions();
  const uniformDrops = await indexDrops(uniformPositions);

  // Evaluate both distributions
  process.stderr.write(`\nEvaluating clustered distribution...\n`);
  const clusteredResults = await evaluateDistribution('clustered', clusteredDrops);

  process.stderr.write(`\nEvaluating uniform distribution...\n`);
  const uniformResults = await evaluateDistribution('uniform', uniformDrops);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  const output = {
    timestamp: new Date().toISOString(),
    n_drops: N_DROPS,
    hotspots: HOTSPOTS.map((h) => ({ name: h.name, lat: h.lat, lon: h.lon })),
    sigma_meters: SIGMA_METERS,
    queries_per_radius: QUERIES_PER_RADIUS,
    clustered: clusteredResults,
    uniform: uniformResults,
    comparison: {
      description: 'Clustered has higher match density near hotspots, more false positives at small radii due to geohash cell granularity mismatch with dense clusters',
    },
  };

  console.log(JSON.stringify(output, null, 2));

  // Summary to stderr
  process.stderr.write(`\n=== SBPP Clustered Distribution Evaluation (N=${N_DROPS}) ===\n`);
  process.stderr.write(`Elapsed: ${elapsed}s\n\n`);

  process.stderr.write('Clustered:\n');
  for (const r of clusteredResults) {
    process.stderr.write(`  radius=${String(r.radius).padStart(5)}m  avg_matches=${String(r.avg_matches).padStart(8)}  precision=${r.precision.toFixed(4)}  recall=${r.recall.toFixed(4)}  FP=${r.fp_count}\n`);
  }

  process.stderr.write('\nUniform:\n');
  for (const r of uniformResults) {
    process.stderr.write(`  radius=${String(r.radius).padStart(5)}m  avg_matches=${String(r.avg_matches).padStart(8)}  precision=${r.precision.toFixed(4)}  recall=${r.recall.toFixed(4)}  FP=${r.fp_count}\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
