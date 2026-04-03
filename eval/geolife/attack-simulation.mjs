/**
 * GeoLife-scale Attack Simulation
 *
 * Runs the 6 privacy defense methods against all preprocessed GeoLife users.
 * Outputs per-user results + aggregate statistics for the paper.
 *
 * Prerequisites:
 *   1. Run preprocess.mjs first to generate processed/*.json
 *   2. Build SDK: pnpm --filter @zairn/sdk build
 *
 * Output: eval/geolife/results/
 *   - attack-results.json   — per-user results for all 6 methods
 *   - summary.json           — aggregate stats (median, p25, p75, etc.)
 *   - convergence.json       — convergence data for plotting
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  processLocation,
  detectSensitivePlaces,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

import {
  computeGridParams,
} from '../../packages/geo-drop/dist/zkls.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'eval-user-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// Centroid attack (cluster-based: finds densest 2km cluster)
// A realistic attacker identifies the most-visited area from
// observations, then takes the centroid of that cluster.
// This models the well-known "most frequent location" attack.
// ============================================================
function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return { error: Infinity, count: 0 };

  // Step 1: Grid cluster (0.02° ≈ 2km cells)
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }

  // Step 2: Find densest cell + its neighbors (3x3 block)
  let bestKey = null;
  let bestCount = 0;
  for (const [key, pts] of cells) {
    if (pts.length > bestCount) { bestCount = pts.length; bestKey = key; }
  }

  if (!bestKey) {
    const aLat = obs.reduce((s, o) => s + o.sLat, 0) / obs.length;
    const aLon = obs.reduce((s, o) => s + o.sLon, 0) / obs.length;
    return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: obs.length, totalObs: obs.length };
  }

  const [bRow, bCol] = bestKey.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nKey = `${bRow + dr},${bCol + dc}`;
      if (cells.has(nKey)) filtered.push(...cells.get(nKey));
    }
  }

  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length, totalObs: obs.length };
}

// ============================================================
// Convergence over time
// ============================================================
function convergence(obs, targetLat, targetLon, dayCheckpoints = [1, 7, 14, 30, 60, 90]) {
  const results = [];
  for (const d of dayCheckpoints) {
    const sub = obs.filter(o => o.day < d);
    // Apply same filtered centroid attack per checkpoint
    const attack = centroidAttack(sub, targetLat, targetLon);
    results.push({ days: d, error: attack.error, count: attack.count });
  }
  return results;
}

// ============================================================
// Apply 6 methods to a user's trace
// ============================================================
function evaluateUser(locs, home, work, userId) {
  const userSeed = SEED + '-' + userId;

  // Build sensitive places from ground-truth home/work.
  // This models the realistic scenario where the user registers
  // their home/work in the app (or the app detects them with
  // fine-grained data that we don't have in hourly-resampled GeoLife).
  const sensitivePlaces = [
    {
      id: 'home', label: 'home',
      lat: home.lat, lon: home.lon,
      radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
      bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
      visitCount: 30, avgDwellMinutes: 480,
    },
  ];
  if (work) {
    sensitivePlaces.push({
      id: 'work', label: 'work',
      lat: work.lat, lon: work.lon,
      radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
      bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
      visitCount: 20, avgDwellMinutes: 480,
    });
  }

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const workFilter = o => !o.isWeekend && o.hour >= 9 && o.hour < 17;

  const methods = {};

  // Method 1: Raw
  const rawObs = locs.map(l => ({ ...l, sLat: l.lat, sLon: l.lon }));

  // Method 2: Laplace+Grid
  const laplaceObs = locs.map(l => {
    const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
    const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
    return { ...l, sLat: s.lat, sLon: s.lon, cellId: s.cellId };
  });

  // Method 3: 6-Layer
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
  const reporter6 = new AdaptiveReporter(12, 2);
  const fullObs = [];
  for (const l of locs) {
    const result = processLocation(l.lat, l.lon, sensitivePlaces, config6, reporter6);
    if (result.type === 'coarse') {
      fullObs.push({ ...l, sLat: result.lat, sLon: result.lon, cellId: result.cellId });
    }
  }

  // Method 4: ZKLS Grid Only
  const zklsGridObs = locs.map(l => {
    const cellCenter = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    return { ...l, sLat: cellCenter.lat, sLon: cellCenter.lon, cellId: cellCenter.cellId };
  });

  // Method 5: ZKLS Grid + Zones (buffer = full suppression)
  const zklsZoneObs = [];
  for (const l of locs) {
    let inZone = false;
    for (const place of sensitivePlaces) {
      const dist = haversine(l.lat, l.lon, place.lat, place.lon);
      if (dist <= (place.bufferRadiusM || 1000)) { inZone = true; break; }
    }
    if (inZone) continue;
    const cellCenter = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    zklsZoneObs.push({ ...l, sLat: cellCenter.lat, sLon: cellCenter.lon, cellId: cellCenter.cellId });
  }

  // Method 6: ZKLS Full (Grid + Zones + Adaptive)
  const reporter7 = new AdaptiveReporter(12, 2);
  const zklsFullObs = [];
  for (const l of locs) {
    let inCore = false;
    let inBuffer = false;
    for (const place of sensitivePlaces) {
      const dist = haversine(l.lat, l.lon, place.lat, place.lon);
      if (dist <= place.radiusM) { inCore = true; break; }
      if (dist <= (place.bufferRadiusM || 1000)) { inBuffer = true; }
    }
    if (inCore) continue;
    const gridM = inBuffer ? 2000 : GRID_SIZE_M;
    const cellCenter = gridSnap(l.lat, l.lon, gridM, userSeed);
    if (!reporter7.shouldReport(cellCenter.cellId)) continue;
    reporter7.record(cellCenter.cellId);
    zklsFullObs.push({ ...l, sLat: cellCenter.lat, sLon: cellCenter.lon, cellId: cellCenter.cellId });
  }

  const allMethods = [
    { name: 'raw', obs: rawObs },
    { name: 'laplace_grid', obs: laplaceObs },
    { name: 'six_layer', obs: fullObs },
    { name: 'zkls_grid', obs: zklsGridObs },
    { name: 'zkls_grid_zones', obs: zklsZoneObs },
    { name: 'zkls_full', obs: zklsFullObs },
  ];

  const results = {};
  for (const m of allMethods) {
    const nightObs = m.obs.filter(nightFilter);
    const workObs = m.obs.filter(workFilter);

    results[m.name] = {
      totalObs: m.obs.length,
      homeAttack: centroidAttack(nightObs, home.lat, home.lon),
      workAttack: work ? centroidAttack(workObs, work.lat, work.lon) : null,
      homeConvergence: convergence(nightObs, home.lat, home.lon),
      obsReduction: ((1 - m.obs.length / rawObs.length) * 100).toFixed(1),
    };
  }

  return { sensitivePlacesDetected: sensitivePlaces.length, results };
}

// ============================================================
// Main
// ============================================================
async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Loaded ${usersMeta.length} users`);

  const allResults = [];
  let done = 0;

  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));

    const result = evaluateUser(locs, user.home, user.work, user.userId);
    allResults.push({
      userId: user.userId,
      coverage: user.coverage,
      hourlyPoints: user.hourlyPoints,
      hasWork: !!user.work,
      homeWorkDistM: user.homeWorkDistM,
      ...result,
    });

    done++;
    if (done % 10 === 0) {
      console.log(`  ${done}/${usersMeta.length} users evaluated`);
    }
  }

  // Save per-user results
  await writeFile(join(RESULTS_DIR, 'attack-results.json'), JSON.stringify(allResults, null, 2));

  // Compute aggregate statistics
  const methodNames = ['raw', 'laplace_grid', 'six_layer', 'zkls_grid', 'zkls_grid_zones', 'zkls_full'];
  const summary = {};

  for (const method of methodNames) {
    const homeErrors = allResults.map(r => r.results[method].homeAttack.error).filter(e => e !== Infinity);
    const workErrors = allResults.filter(r => r.results[method].workAttack).map(r => r.results[method].workAttack.error).filter(e => e !== Infinity);
    const obsReductions = allResults.map(r => parseFloat(r.results[method].obsReduction));
    const infiniteHome = allResults.filter(r => r.results[method].homeAttack.error === Infinity).length;
    const infiniteWork = allResults.filter(r => r.results[method].workAttack && r.results[method].workAttack.error === Infinity).length;

    homeErrors.sort((a, b) => a - b);
    workErrors.sort((a, b) => a - b);

    const percentile = (arr, p) => arr.length === 0 ? null : arr[Math.floor(arr.length * p)];

    summary[method] = {
      homeError: {
        median: percentile(homeErrors, 0.5),
        p25: percentile(homeErrors, 0.25),
        p75: percentile(homeErrors, 0.75),
        mean: homeErrors.length > 0 ? Math.round(homeErrors.reduce((s, e) => s + e, 0) / homeErrors.length) : null,
        infiniteCount: infiniteHome,
        totalUsers: allResults.length,
      },
      workError: {
        median: percentile(workErrors, 0.5),
        p25: percentile(workErrors, 0.25),
        p75: percentile(workErrors, 0.75),
        infiniteCount: infiniteWork,
        totalUsersWithWork: allResults.filter(r => r.results[method].workAttack).length,
      },
      obsReduction: {
        median: percentile(obsReductions.sort((a, b) => a - b), 0.5),
        mean: Math.round(obsReductions.reduce((s, r) => s + r, 0) / obsReductions.length * 10) / 10,
      },
    };
  }

  await writeFile(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  // Print summary table
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  AGGREGATE RESULTS (' + allResults.length + ' users)');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Method              | Home Err (median) | Work Err (median) | Obs Reduction');
  console.log('─'.repeat(75));
  for (const method of methodNames) {
    const s = summary[method];
    const homeStr = s.homeError.median !== null ? `${s.homeError.median}m` : `∞ (${s.homeError.infiniteCount} users)`;
    const workStr = s.workError.median !== null ? `${s.workError.median}m` : `∞ (${s.workError.infiniteCount} users)`;
    console.log(`${method.padEnd(20)}| ${homeStr.padStart(17)} | ${workStr.padStart(17)} | ${s.obsReduction.median}%`);
  }

  // Save convergence data for plotting
  const convergenceData = {};
  for (const method of methodNames) {
    convergenceData[method] = [1, 7, 14, 30, 60, 90].map(d => {
      const errors = allResults.map(r => {
        const conv = r.results[method].homeConvergence.find(c => c.days === d);
        return conv ? conv.error : Infinity;
      }).filter(e => e !== Infinity);
      errors.sort((a, b) => a - b);
      return {
        days: d,
        median: errors.length > 0 ? errors[Math.floor(errors.length * 0.5)] : null,
        p25: errors.length > 0 ? errors[Math.floor(errors.length * 0.25)] : null,
        p75: errors.length > 0 ? errors[Math.floor(errors.length * 0.75)] : null,
        count: errors.length,
      };
    });
  }
  await writeFile(join(RESULTS_DIR, 'convergence.json'), JSON.stringify(convergenceData, null, 2));

  console.log('\nResults saved to', RESULTS_DIR);
}

main().catch(console.error);
