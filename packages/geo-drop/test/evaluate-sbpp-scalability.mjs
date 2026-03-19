/**
 * SBPP Experiment 4: Scalability Analysis
 *
 * Tests how SBPP scales with number of drops (N) and search radius.
 * Measures token matching time, match counts, precision/recall/F1,
 * and index storage overhead.
 *
 * Paper section: Experiment 4 — Scalability
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
  calculateDistance,
} from '../dist/geofence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N_VALUES = [100, 500, 1000, 5000, 10000, 50000, 100000];
const RADIUS_VALUES = [100, 500, 1000, 5000]; // meters
const QUERIES_PER_COMBO = 50;

const TOKYO_LAT_MIN = 35.6;
const TOKYO_LAT_MAX = 35.8;
const TOKYO_LON_MIN = 139.6;
const TOKYO_LON_MAX = 139.9;

const SEARCH_KEY = 'sbpp-scalability-evaluation-key-2026';
const PRECISION_LEVELS = [4, 5, 6];

// Index storage: 3 precision levels × 64 hex chars = 192 bytes per drop
const INDEX_BYTES_PER_DROP = 3 * 64;

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ═══════════════════════════════════════════════════════
// Drop pool generation with caching
// ═══════════════════════════════════════════════════════

/**
 * Generate N drops and their index tokens.
 * We generate the largest pool once and slice for smaller N values.
 */
async function generateDropPool(maxN, config) {
  const drops = [];
  for (let i = 0; i < maxN; i++) {
    const lat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX);
    const lon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX);
    drops.push({ id: `drop-${i}`, lat, lon, tokens: null });
  }

  process.stderr.write(`Indexing ${maxN} drops...\n`);
  for (let i = 0; i < maxN; i++) {
    const d = drops[i];
    d.tokens = await generateIndexTokens(d.lat, d.lon, config);
    if ((i + 1) % 10000 === 0) {
      process.stderr.write(`  indexed ${i + 1}/${maxN}\n`);
    }
  }

  return drops;
}

// ═══════════════════════════════════════════════════════
// Main evaluation
// ═══════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();
  const config = { searchKey: SEARCH_KEY, precisionLevels: PRECISION_LEVELS };

  const maxN = Math.max(...N_VALUES);
  const allDrops = await generateDropPool(maxN, config);

  const grid = [];

  for (const n of N_VALUES) {
    // Slice the pool to size n
    const drops = allDrops.slice(0, n);
    const indexedDrops = drops.map((d) => ({
      dropId: d.id,
      tokens: d.tokens,
    }));

    for (const radius of RADIUS_VALUES) {
      process.stderr.write(`N=${n}, radius=${radius}m: running ${QUERIES_PER_COMBO} queries...\n`);

      const matchTimes = [];
      const matchCounts = [];
      let totalTP = 0;
      let totalFP = 0;
      let totalFN = 0;

      for (let q = 0; q < QUERIES_PER_COMBO; q++) {
        const qLat = randomInRange(TOKYO_LAT_MIN, TOKYO_LAT_MAX);
        const qLon = randomInRange(TOKYO_LON_MIN, TOKYO_LON_MAX);

        // Generate search tokens
        const searchTokens = await generateSearchTokens(qLat, qLon, radius, config);

        // Measure token matching time
        const tStart = performance.now();
        const matches = matchTokens(searchTokens, indexedDrops);
        const tEnd = performance.now();
        matchTimes.push(tEnd - tStart);
        matchCounts.push(matches.length);

        // Ground truth: exact distance check
        const matchedIds = new Set(matches.map((m) => m.dropId));
        const truePositiveIds = new Set();

        for (const d of drops) {
          const dist = calculateDistance(qLat, qLon, d.lat, d.lon);
          const isWithinRadius = dist <= radius;
          const isMatched = matchedIds.has(d.id);

          if (isWithinRadius && isMatched) {
            totalTP++;
            truePositiveIds.add(d.id);
          } else if (!isWithinRadius && isMatched) {
            totalFP++;
          } else if (isWithinRadius && !isMatched) {
            totalFN++;
          }
          // true negative: !isWithinRadius && !isMatched — not tracked
        }
      }

      const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
      const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      grid.push({
        n,
        radius,
        match_time_ms: Number(mean(matchTimes).toFixed(4)),
        avg_matches: Number(mean(matchCounts).toFixed(2)),
        precision: Number(precision.toFixed(6)),
        recall: Number(recall.toFixed(6)),
        f1: Number(f1.toFixed(6)),
        index_bytes_per_drop: INDEX_BYTES_PER_DROP,
      });
    }
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`Done in ${elapsed}s. Writing JSON to stdout.\n`);

  const storageFor100k = INDEX_BYTES_PER_DROP * 100000;

  const results = {
    timestamp: new Date().toISOString(),
    grid,
    storage_overhead: {
      bytes_per_drop: INDEX_BYTES_PER_DROP,
      overhead_for_100k: formatBytes(storageFor100k),
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
