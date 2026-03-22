/**
 * SBPP Evaluation with OpenStreetMap POI Data
 *
 * Downloads real POI locations from OpenStreetMap (Overpass API)
 * for the Tokyo metropolitan area and evaluates SBPP performance
 * under real-world spatial distribution.
 *
 * Metrics:
 *   1. Token matching time, precision, recall (vs synthetic baseline)
 *   2. Result-set size distribution (real vs uniform vs clustered)
 *   3. Centroid inference error under real distribution
 *   4. Cross-session re-association rate
 *
 * Paper section: Evaluation — Real-World Distribution
 */

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
  selectPrecisionForRadius,
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

// Tokyo bounding box (same as other eval scripts)
const BBOX = {
  south: 35.6, north: 35.8,
  west: 139.6, east: 139.9,
};

const SEARCH_KEY = 'sbpp-osm-evaluation-key-2026';
const PRECISION_LEVELS = [4, 5, 6];
const SEARCH_RADIUS = 1000; // meters
const N_QUERIES = 200;
const N_SESSIONS = 1000;
const INDEX_BYTES_PER_DROP = 3 * 64;

const CACHE_FILE = path.join(__dirname, 'osm-tokyo-pois.json');

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

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function iqr(arr) {
  return [percentile(arr, 25), percentile(arr, 75)];
}

// ═══════════════════════════════════════════════════════
// OSM Data Fetching
// ═══════════════════════════════════════════════════════

/**
 * Fetch POIs from Overpass API.
 * Queries amenities (restaurants, cafes, shops, etc.) and tourism
 * nodes within the bounding box.
 */
async function fetchOsmPois() {
  // Check cache first
  try {
    const cached = await fs.readFile(CACHE_FILE, 'utf-8');
    const data = JSON.parse(cached);
    process.stderr.write(`Loaded ${data.length} cached POIs from ${CACHE_FILE}\n`);
    return data;
  } catch {
    // Cache miss — fetch from Overpass
  }

  process.stderr.write('Fetching POIs from Overpass API...\n');

  const query = `
[out:json][timeout:60];
(
  node["amenity"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["shop"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["tourism"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["leisure"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out body;
`.trim();

  const url = 'https://overpass-api.de/api/interpreter';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!resp.ok) {
    throw new Error(`Overpass API error: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  const pois = json.elements
    .filter((e) => e.type === 'node' && e.lat && e.lon)
    .map((e, i) => ({
      id: `osm-${e.id}`,
      lat: e.lat,
      lon: e.lon,
      type: e.tags?.amenity || e.tags?.shop || e.tags?.tourism || e.tags?.leisure || 'unknown',
    }));

  process.stderr.write(`Fetched ${pois.length} POIs from Overpass\n`);

  // Cache for future runs
  await fs.writeFile(CACHE_FILE, JSON.stringify(pois));
  process.stderr.write(`Cached to ${CACHE_FILE}\n`);

  return pois;
}

// ═══════════════════════════════════════════════════════
// Generate synthetic comparison pools
// ═══════════════════════════════════════════════════════

function generateUniformDrops(n) {
  const drops = [];
  for (let i = 0; i < n; i++) {
    drops.push({
      id: `uniform-${i}`,
      lat: randomInRange(BBOX.south, BBOX.north),
      lon: randomInRange(BBOX.west, BBOX.east),
    });
  }
  return drops;
}

// ═══════════════════════════════════════════════════════
// Evaluation: Token matching + precision/recall
// ═══════════════════════════════════════════════════════

async function evaluateMatching(drops, config, label) {
  process.stderr.write(`\n[${label}] Indexing ${drops.length} drops...\n`);

  const indexedDrops = [];
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    const tokens = await generateIndexTokens(d.lat, d.lon, config);
    indexedDrops.push({ dropId: d.id, tokens });
    if ((i + 1) % 5000 === 0) {
      process.stderr.write(`  indexed ${i + 1}/${drops.length}\n`);
    }
  }

  process.stderr.write(`[${label}] Running ${N_QUERIES} queries (radius=${SEARCH_RADIUS}m)...\n`);

  const matchTimes = [];
  const matchCounts = [];
  let totalTP = 0, totalFP = 0, totalFN = 0;

  for (let q = 0; q < N_QUERIES; q++) {
    // Query from a random drop location (realistic: user is near a POI)
    const pivot = drops[Math.floor(Math.random() * drops.length)];
    const qLat = pivot.lat + (Math.random() - 0.5) * 0.001; // ~50m jitter
    const qLon = pivot.lon + (Math.random() - 0.5) * 0.001;

    const searchTokens = await generateSearchTokens(qLat, qLon, SEARCH_RADIUS, config);

    const tStart = performance.now();
    const matches = matchTokens(searchTokens, indexedDrops);
    const tEnd = performance.now();
    matchTimes.push(tEnd - tStart);
    matchCounts.push(matches.length);

    const matchedIds = new Set(matches.map((m) => m.dropId));
    for (const d of drops) {
      const dist = calculateDistance(qLat, qLon, d.lat, d.lon);
      const inRadius = dist <= SEARCH_RADIUS;
      const matched = matchedIds.has(d.id);
      if (inRadius && matched) totalTP++;
      else if (!inRadius && matched) totalFP++;
      else if (inRadius && !matched) totalFN++;
    }
  }

  const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
  const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 1;

  return {
    label,
    n_drops: drops.length,
    radius: SEARCH_RADIUS,
    n_queries: N_QUERIES,
    match_time_ms: {
      median: Number(median(matchTimes).toFixed(4)),
      mean: Number(mean(matchTimes).toFixed(4)),
      p95: Number(percentile(matchTimes, 95).toFixed(4)),
    },
    avg_matches: Number(mean(matchCounts).toFixed(1)),
    match_count_median: Number(median(matchCounts).toFixed(0)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Evaluation: Centroid inference error
// ═══════════════════════════════════════════════════════

async function evaluateInference(drops, config, label) {
  process.stderr.write(`[${label}] Centroid inference (${N_QUERIES} queries)...\n`);

  const indexedDrops = [];
  for (const d of drops) {
    const tokens = await generateIndexTokens(d.lat, d.lon, config);
    indexedDrops.push({ dropId: d.id, tokens, lat: d.lat, lon: d.lon });
  }

  const errors = [];

  for (let q = 0; q < N_QUERIES; q++) {
    const qLat = randomInRange(BBOX.south, BBOX.north);
    const qLon = randomInRange(BBOX.west, BBOX.east);

    const searchTokens = await generateSearchTokens(qLat, qLon, SEARCH_RADIUS, config);
    const matches = matchTokens(searchTokens, indexedDrops);

    if (matches.length === 0) continue;

    // Centroid of matched drops
    const matchedDrops = matches.map((m) =>
      indexedDrops.find((d) => d.dropId === m.dropId)
    ).filter(Boolean);

    const centLat = mean(matchedDrops.map((d) => d.lat));
    const centLon = mean(matchedDrops.map((d) => d.lon));

    const error = calculateDistance(qLat, qLon, centLat, centLon);
    errors.push(error / 1000); // km
  }

  errors.sort((a, b) => a - b);

  return {
    label,
    n_queries_with_matches: errors.length,
    localization_error_km: {
      median: Number(median(errors).toFixed(3)),
      mean: Number(mean(errors).toFixed(3)),
      iqr: iqr(errors).map((v) => Number(v.toFixed(3))),
      p95: Number(percentile(errors, 95).toFixed(3)),
    },
  };
}

// ═══════════════════════════════════════════════════════
// Evaluation: POI type distribution
// ═══════════════════════════════════════════════════════

function analyzeDistribution(pois) {
  const typeCounts = {};
  for (const p of pois) {
    typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
  }

  // Top 10 types
  const sorted = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Spatial stats
  const lats = pois.map((p) => p.lat);
  const lons = pois.map((p) => p.lon);

  return {
    total_pois: pois.length,
    top_types: Object.fromEntries(sorted),
    spatial: {
      lat: { min: Math.min(...lats).toFixed(4), max: Math.max(...lats).toFixed(4), mean: mean(lats).toFixed(4) },
      lon: { min: Math.min(...lons).toFixed(4), max: Math.max(...lons).toFixed(4), mean: mean(lons).toFixed(4) },
    },
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();
  const config = { searchKey: SEARCH_KEY, precisionLevels: PRECISION_LEVELS };

  // 1. Fetch OSM data
  const osmPois = await fetchOsmPois();
  const distribution = analyzeDistribution(osmPois);

  // 2. Generate uniform comparison pool (same size)
  const uniformDrops = generateUniformDrops(osmPois.length);

  // 3. Token matching evaluation
  const osmMatching = await evaluateMatching(osmPois, config, 'osm');
  const uniformMatching = await evaluateMatching(uniformDrops, config, 'uniform');

  // 4. Centroid inference evaluation
  const osmInference = await evaluateInference(osmPois, config, 'osm');
  const uniformInference = await evaluateInference(uniformDrops, config, 'uniform');

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`\nDone in ${elapsed}s.\n`);

  const results = {
    timestamp: new Date().toISOString(),
    description: 'SBPP evaluation with OpenStreetMap POI data (Tokyo metropolitan area)',
    osm_distribution: distribution,
    matching: {
      osm: osmMatching,
      uniform: uniformMatching,
    },
    inference: {
      osm: osmInference,
      uniform: uniformInference,
    },
    parameters: {
      bbox: BBOX,
      search_radius_m: SEARCH_RADIUS,
      n_queries: N_QUERIES,
      precision_levels: PRECISION_LEVELS,
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
