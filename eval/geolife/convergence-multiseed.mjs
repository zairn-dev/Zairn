/**
 * Convergence over time — 5-seed mean ± std
 *
 * Reproduces attack-simulation.mjs's convergence() / day-filtering and per-method
 * defense application, but across NUM_RUNS seeds (run0..run4) following the exact
 * RNG/seed conventions of multi-seed-eval.mjs:
 *   runSeed  = `${SEED_BASE}-run${run}`
 *   userSeed = `${runSeed}-${userId}`
 *
 * Methods (matching the paper's convergence table + the released-artifact extra):
 *   raw, laplace_grid, zkls_grid (deterministic grid, no zones),
 *   zkls_grid_zones (Grid+Zones, default), six_layer (6-Layer), zkls_full (Full)
 *
 * For each (method, dayCheckpoint) we compute the MEDIAN home-inference error
 * using only observations within the first D days (centroidAttack on the night-
 * filtered, day-filtered subset), then report mean ± std of that median across
 * the 5 seeds. Also reports the 90d/7d convergence ratio (mean over seeds).
 *
 * Output: results/convergence-multiseed.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  addPlanarLaplaceNoise, gridSnap, processLocation,
  AdaptiveReporter, DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED_BASE = 'eval-user-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;
const NUM_RUNS = 5;
const DAY_CHECKPOINTS = [1, 7, 14, 30, 60, 90];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Cluster-based centroid attack — identical to attack-simulation.mjs.
function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return { error: Infinity, count: 0 };
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, pts] of cells) {
    if (pts.length > bestCount) { bestCount = pts.length; bestKey = key; }
  }
  if (!bestKey) {
    const aLat = obs.reduce((s, o) => s + o.sLat, 0) / obs.length;
    const aLon = obs.reduce((s, o) => s + o.sLon, 0) / obs.length;
    return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: obs.length };
  }
  const [bRow, bCol] = bestKey.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const nKey = `${bRow + dr},${bCol + dc}`;
    if (cells.has(nKey)) filtered.push(...cells.get(nKey));
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length };
}

// Convergence over time — identical filtering to attack-simulation.mjs (o.day < d).
function convergence(obs, targetLat, targetLon, dayCheckpoints = DAY_CHECKPOINTS) {
  const results = [];
  for (const d of dayCheckpoints) {
    const sub = obs.filter(o => o.day < d);
    const attack = centroidAttack(sub, targetLat, targetLon);
    results.push({ days: d, error: attack.error, count: attack.count });
  }
  return results;
}

// Build the six methods' night-filtered observation sets for one user, given a seed.
// Mirrors attack-simulation.mjs::evaluateUser exactly (sensitive places, filters,
// per-method defense application). The only change is the configurable userSeed.
function buildMethodNightObs(locs, home, work, userSeed) {
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

  // Method 4: ZKLS Grid Only (deterministic per-user grid, no zones)
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

  // Method 6: ZKLS Full (Grid + Zones + Adaptive + coarser buffer grid)
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

  return {
    raw: rawObs.filter(nightFilter),
    laplace_grid: laplaceObs.filter(nightFilter),
    zkls_grid: zklsGridObs.filter(nightFilter),
    zkls_grid_zones: zklsZoneObs.filter(nightFilter),
    six_layer: fullObs.filter(nightFilter),
    zkls_full: zklsFullObs.filter(nightFilter),
  };
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid', 'zkls_grid_zones', 'six_layer', 'zkls_full'];

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Convergence multi-seed: ${usersMeta.length} users, ${NUM_RUNS} runs, checkpoints ${DAY_CHECKPOINTS.join('/')}d\n`);

  // Preload all user traces once.
  const userTraces = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    userTraces.push({ user, locs });
  }

  // perRun[run][method][dayIndex] = median error (over users) at that checkpoint.
  const perRun = [];

  for (let run = 0; run < NUM_RUNS; run++) {
    const runSeed = `${SEED_BASE}-run${run}`;
    // errorsByMethodDay[method] = array (per checkpoint) of arrays (per user) of errors.
    const errorsByMethodDay = {};
    for (const m of METHODS) errorsByMethodDay[m] = DAY_CHECKPOINTS.map(() => []);

    for (const { user, locs } of userTraces) {
      const userSeed = runSeed + '-' + user.userId;
      const methodNightObs = buildMethodNightObs(locs, user.home, user.work, userSeed);
      for (const m of METHODS) {
        const conv = convergence(methodNightObs[m], user.home.lat, user.home.lon);
        conv.forEach((c, di) => {
          if (c.error !== Infinity) errorsByMethodDay[m][di].push(c.error);
        });
      }
    }

    // Reduce to per-method median at each checkpoint (matching attack-simulation's
    // convergenceData reduction: sort finite errors, take floor(n*0.5)).
    const runMedians = {};
    for (const m of METHODS) {
      runMedians[m] = errorsByMethodDay[m].map(errs => {
        if (errs.length === 0) return null;
        errs.sort((a, b) => a - b);
        return errs[Math.floor(errs.length * 0.5)];
      });
    }
    perRun.push(runMedians);
    console.log(`Run ${run + 1}/${NUM_RUNS} done`);
  }

  // Aggregate: mean ± std of the per-run median, for each (method, checkpoint).
  const stats = (arr) => {
    const vals = arr.filter(v => v !== null);
    if (vals.length === 0) return { mean: null, std: null, n: 0, values: arr };
    const n = vals.length;
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return { mean: Math.round(mean), std: Math.round(std), n, values: arr };
  };

  const aggregate = {};
  for (const m of METHODS) {
    aggregate[m] = {};
    DAY_CHECKPOINTS.forEach((d, di) => {
      aggregate[m][d] = stats(perRun.map(r => r[m][di]));
    });
    // 90d/7d ratio per run, then mean.
    const i7 = DAY_CHECKPOINTS.indexOf(7);
    const i90 = DAY_CHECKPOINTS.indexOf(90);
    const ratios = perRun
      .map(r => (r[m][i7] && r[m][i7] !== 0 && r[m][i90] !== null) ? r[m][i90] / r[m][i7] : null)
      .filter(v => v !== null);
    const ratioMean = ratios.length ? ratios.reduce((s, v) => s + v, 0) / ratios.length : null;
    const ratioStd = ratios.length
      ? Math.sqrt(ratios.reduce((s, v) => s + (v - ratioMean) ** 2, 0) / ratios.length) : null;
    aggregate[m].ratio90_7 = {
      mean: ratioMean !== null ? Math.round(ratioMean * 100) / 100 : null,
      std: ratioStd !== null ? Math.round(ratioStd * 100) / 100 : null,
      values: ratios.map(v => Math.round(v * 100) / 100),
    };
  }

  const output = {
    config: { numRuns: NUM_RUNS, seedBase: SEED_BASE, baseEpsilon: BASE_EPSILON, gridSizeM: GRID_SIZE_M, dayCheckpoints: DAY_CHECKPOINTS },
    methods: METHODS,
    aggregate,
    run0: Object.fromEntries(METHODS.map(m => [m, perRun[0][m]])),
    perRunMedians: Object.fromEntries(METHODS.map(m => [m, perRun.map(r => r[m])])),
  };
  await writeFile(join(RESULTS_DIR, 'convergence-multiseed.json'), JSON.stringify(output, null, 2));

  // ---- Console report ----
  const labels = {
    raw: 'Raw', laplace_grid: 'Laplace+Grid', zkls_grid: 'Grid',
    zkls_grid_zones: 'Grid+Zones', six_layer: '6-Layer', zkls_full: 'Full',
  };

  console.log('\n=== 5-seed mean±std median home-inference error (m), by days observed ===');
  console.log('Method'.padEnd(14) + DAY_CHECKPOINTS.map(d => `${d}d`.padStart(14)).join('') + '   90d/7d');
  for (const m of METHODS) {
    const cells = DAY_CHECKPOINTS.map(d => {
      const a = aggregate[m][d];
      return (a.mean === null ? 'n/a' : `${a.mean}±${a.std}`).padStart(14);
    }).join('');
    const r = aggregate[m].ratio90_7;
    console.log(labels[m].padEnd(14) + cells + `   ${r.mean ?? 'n/a'}`);
  }

  console.log('\n=== run0 (single-seed) median errors — sanity-check vs paper table ===');
  console.log('Method'.padEnd(14) + DAY_CHECKPOINTS.map(d => `${d}d`.padStart(8)).join(''));
  for (const m of METHODS) {
    console.log(labels[m].padEnd(14) + perRun[0][m].map(v => String(v ?? 'n/a').padStart(8)).join(''));
  }

  console.log('\nSaved results/convergence-multiseed.json');
}

main().catch(e => { console.error(e); process.exit(1); });
