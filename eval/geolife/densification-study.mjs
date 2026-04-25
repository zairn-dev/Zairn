/**
 * Densification robustness study
 *
 * Addresses the "GeoLife is old and sparse" critique by subsampling
 * the denser GeoLife users to varying coverage levels and re-running
 * the main home-inference attack. Shows whether privacy conclusions
 * are robust to coverage.
 *
 * Approach:
 *   1. Keep only users with coverage >= 40% (candidates for subsampling).
 *   2. For each target coverage in {10%, 25%, 50%, 100%}, uniformly
 *      subsample each user's observations to achieve that coverage.
 *   3. Run the centroid attack under Raw, Laplace+Grid, ZKLS Grid+Zones,
 *      6-Layer for each coverage level.
 *   4. Report median home error + exposed counts per condition.
 *
 * Result interpretation: if privacy metrics are stable across coverage,
 * then GeoLife's median 16% coverage is not a threat to our conclusions.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'densification-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;
// Fractions of each user's native observations to retain. 1.00 = native.
const RETAIN_FRACS = [0.25, 0.50, 1.00];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return Infinity;
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const k = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  let best = null, bestCnt = 0;
  for (const [k, pts] of cells) if (pts.length > bestCnt) { bestCnt = pts.length; best = k; }
  if (!best) return Infinity;
  const [br, bc] = best.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const k = `${br + dr},${bc + dc}`;
    if (cells.has(k)) filtered.push(...cells.get(k));
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return Math.round(haversine(aLat, aLon, targetLat, targetLon));
}

// Deterministic pseudo-random shuffle via Fisher-Yates with seeded LCG
function seededRng(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) & 0xffffffff;
  let state = h || 1;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return ((state >>> 0) / 4294967296);
  };
}

function subsampleUniform(locs, targetFrac, seed) {
  if (targetFrac >= 1) return locs;
  const rng = seededRng(seed);
  // Keep each observation with prob = targetFrac (unbiased thinning)
  return locs.filter(() => rng() < targetFrac);
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  const candidates = usersMeta; // all 78 users
  console.log(`Sparsity sensitivity: ${candidates.length} users, fractions ${RETAIN_FRACS.join(', ')}`);

  const nightFilter = o => o.hour >= 22 || o.hour < 6;

  const results = {}; // results[fraction][method] = { median, exposed200, exposed500 }

  for (const target of RETAIN_FRACS) {
    console.log(`\n=== Retain fraction: ${(target * 100).toFixed(0)}% of native obs ===`);
    const errors = { raw: [], laplace_grid: [], zkls_grid_zones: [], six_layer: [] };
    let exposed200 = { raw: 0, laplace_grid: 0, zkls_grid_zones: 0, six_layer: 0 };
    let exposed500 = { raw: 0, laplace_grid: 0, zkls_grid_zones: 0, six_layer: 0 };

    for (const user of candidates) {
      const locsFull = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const userSeed = SEED + '-' + user.userId + '-t' + target;
      const locs = subsampleUniform(locsFull, target, userSeed);
      if (locs.length < 30) continue;

      const places = [
        { id: 'home', label: 'home', lat: user.home.lat, lon: user.home.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480 },
        ...(user.work ? [{ id: 'work', label: 'work', lat: user.work.lat, lon: user.work.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480 }] : []),
      ];

      // Raw
      const rawObs = locs.map(l => ({ ...l, sLat: l.lat, sLon: l.lon }));

      // Laplace+Grid
      const lgObs = locs.map(l => {
        const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
        const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
        return { ...l, sLat: s.lat, sLon: s.lon };
      });

      // ZKLS Grid+Zones
      const zgzObs = [];
      for (const l of locs) {
        let inZone = false;
        for (const p of places) {
          if (haversine(l.lat, l.lon, p.lat, p.lon) <= p.bufferRadiusM) { inZone = true; break; }
        }
        if (inZone) continue;
        const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
        zgzObs.push({ ...l, sLat: s.lat, sLon: s.lon });
      }

      // 6-Layer
      const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
      const reporter6 = new AdaptiveReporter(12, 2);
      const slObs = [];
      for (const l of locs) {
        const r = processLocation(l.lat, l.lon, places, config6, reporter6);
        if (r.type === 'coarse') slObs.push({ ...l, sLat: r.lat, sLon: r.lon });
      }

      const methodObs = { raw: rawObs, laplace_grid: lgObs, zkls_grid_zones: zgzObs, six_layer: slObs };
      for (const [m, obs] of Object.entries(methodObs)) {
        const nightObs = obs.filter(nightFilter);
        const err = centroidAttack(nightObs, user.home.lat, user.home.lon);
        if (err < Infinity) errors[m].push(err);
        if (err < 200) exposed200[m]++;
        if (err < 500) exposed500[m]++;
      }
    }

    results[target] = {};
    for (const m of Object.keys(errors)) {
      errors[m].sort((a, b) => a - b);
      const med = errors[m].length > 0 ? errors[m][Math.floor(errors[m].length * 0.5)] : null;
      results[target][m] = {
        median: med,
        exposed200: exposed200[m],
        exposed500: exposed500[m],
        finite_n: errors[m].length,
      };
      console.log(`  ${m.padEnd(18)} median=${med}m  <200m=${exposed200[m]}  <500m=${exposed500[m]}  (n=${errors[m].length})`);
    }
  }

  await writeFile(join(RESULTS_DIR, 'densification.json'), JSON.stringify({
    candidates: candidates.length,
    retain_fracs: RETAIN_FRACS,
    results,
  }, null, 2));
  console.log('\nSaved to results/densification.json');
}

main().catch(e => { console.error(e); process.exit(1); });
