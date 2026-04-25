/**
 * Route Corridor Attack
 *
 * Stronger attacker that goes beyond the home/work centroid attack:
 * tries to recover the user's *commute corridor* — the sequence of
 * cells they pass through repeatedly. This is a more sophisticated
 * threat model: even if home and work are hidden, the attacker may
 * learn the commute path itself, which can re-identify a user
 * via auxiliary data (city street networks, public transit lines,
 * social check-ins along the route).
 *
 * Method:
 *   1. For each user, compute the ground-truth commute corridor:
 *      cells the user visits at least N times during weekday daytime
 *      transit hours (07:00-09:00 and 17:00-19:00), excluding home
 *      and work cells.
 *   2. For each defense, replay observations through the privacy
 *      pipeline and have the attacker compute their best estimate
 *      of the corridor (cells visited >= N times during commute hours).
 *   3. Score: precision = |attack ∩ truth| / |attack|
 *             recall    = |attack ∩ truth| / |truth|
 *             F1
 *      Plus: corridor coverage = fraction of true corridor cells
 *      that the attacker correctly identifies.
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
const SEED = 'corridor-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;
const COMMUTE_HOURS = new Set([7, 8, 17, 18]); // morning + evening commute
const MIN_VISITS_FOR_CORRIDOR = 2; // a cell must be visited at least N times to count

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 500m corridor cell (smaller than 2km neighborhood, finer route resolution)
function corridorCell(lat, lon) {
  return `${Math.floor(lat / 0.005)},${Math.floor(lon / 0.005)}`;
}

function homeCorridorCell(home) { return corridorCell(home.lat, home.lon); }
function workCorridorCell(work) { return work ? corridorCell(work.lat, work.lon) : null; }

function buildPlaces(home, work) {
  return [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480 },
    ...(work ? [{ id: 'work', label: 'work', lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480 }] : []),
  ];
}

function applyMethod(loc, method, places, userSeed, reporter, config6) {
  let inCore = false, inBuffer = false;
  for (const p of places) {
    const d = haversine(loc.lat, loc.lon, p.lat, p.lon);
    if (d <= p.radiusM) { inCore = true; break; }
    if (d <= p.bufferRadiusM) { inBuffer = true; }
  }
  switch (method) {
    case 'raw': return { suppressed: false, lat: loc.lat, lon: loc.lon };
    case 'laplace_grid': {
      const n = addPlanarLaplaceNoise(loc.lat, loc.lon, BASE_EPSILON);
      const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
      return { suppressed: false, lat: s.lat, lon: s.lon };
    }
    case 'zkls_grid_zones': {
      if (inCore || inBuffer) return { suppressed: true };
      const s = gridSnap(loc.lat, loc.lon, GRID_SIZE_M, userSeed);
      return { suppressed: false, lat: s.lat, lon: s.lon };
    }
    case 'six_layer': {
      const r = processLocation(loc.lat, loc.lon, places, config6, reporter);
      if (r.type === 'coarse') return { suppressed: false, lat: r.lat, lon: r.lon };
      return { suppressed: true };
    }
  }
}

function corridorFromObs(obs, excludeCells) {
  const cnts = new Map();
  for (const o of obs) {
    if (o.suppressed) continue;
    if (!COMMUTE_HOURS.has(o.hour)) continue;
    if (o.isWeekend) continue;
    const c = corridorCell(o.lat, o.lon);
    if (excludeCells.has(c)) continue;
    cnts.set(c, (cnts.get(c) || 0) + 1);
  }
  const cells = new Set();
  for (const [c, n] of cnts) if (n >= MIN_VISITS_FOR_CORRIDOR) cells.add(c);
  return cells;
}

function score(predicted, truth) {
  if (truth.size === 0) return null;
  let inter = 0;
  for (const c of predicted) if (truth.has(c)) inter++;
  const precision = predicted.size > 0 ? inter / predicted.size : 0;
  const recall = inter / truth.size;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, predictedSize: predicted.size, truthSize: truth.size, intersection: inter };
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const perUser = [];
  let usersWithCorridor = 0;

  for (const user of usersMeta) {
    if (!user.work) continue;
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const userSeed = SEED + '-' + user.userId;
    const places = buildPlaces(user.home, user.work);
    const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };

    // Build the ground-truth corridor: cells visited >= N times during commute hours,
    // excluding the home and work cells themselves
    const exclude = new Set([homeCorridorCell(user.home), workCorridorCell(user.work)]);
    // Ground truth uses raw locations
    const rawObs = locs.map(l => ({
      lat: l.lat, lon: l.lon, hour: l.hour, isWeekend: l.isWeekend, suppressed: false,
    }));
    const truthCorridor = corridorFromObs(rawObs, exclude);
    if (truthCorridor.size < 2) continue; // need at least 2 corridor cells
    usersWithCorridor++;

    const userResult = { userId: user.userId, truthSize: truthCorridor.size, methods: {} };

    for (const method of METHODS) {
      const reporter = new AdaptiveReporter(12, 2);
      const obs = locs.map(l => {
        const r = applyMethod(l, method, places, userSeed, reporter, config6);
        return { ...r, hour: l.hour, isWeekend: l.isWeekend };
      });
      const predicted = corridorFromObs(obs, exclude);
      userResult.methods[method] = score(predicted, truthCorridor);
    }
    perUser.push(userResult);
  }

  console.log(`Users with detectable commute corridor: ${usersWithCorridor}`);

  // Aggregate
  const agg = {};
  for (const m of METHODS) {
    const f1s = perUser.map(u => u.methods[m].f1).filter(v => v !== null && !Number.isNaN(v));
    const precs = perUser.map(u => u.methods[m].precision).filter(v => v !== null && !Number.isNaN(v));
    const recs = perUser.map(u => u.methods[m].recall).filter(v => v !== null && !Number.isNaN(v));
    const sizes = perUser.map(u => u.methods[m].predictedSize).filter(v => v !== null && !Number.isNaN(v));
    f1s.sort((a, b) => a - b);
    precs.sort((a, b) => a - b);
    recs.sort((a, b) => a - b);
    sizes.sort((a, b) => a - b);
    agg[m] = {
      precision_med: precs[Math.floor(precs.length * 0.5)] || 0,
      recall_med: recs[Math.floor(recs.length * 0.5)] || 0,
      f1_med: f1s[Math.floor(f1s.length * 0.5)] || 0,
      predicted_size_med: sizes[Math.floor(sizes.length * 0.5)] || 0,
    };
  }

  console.log('\n=== Route Corridor Attack ===');
  console.log('Attacker tries to recover commute corridor (cells visited >= 2 times');
  console.log('during 07-09 + 17-19, weekdays, excluding home/work cells)');
  console.log('Higher recall = attacker recovers more of the true corridor.');
  console.log('');
  console.log('Method              Precision   Recall   F1      |Pred|');
  for (const m of METHODS) {
    const a = agg[m];
    console.log(`  ${m.padEnd(18)} ${(a.precision_med * 100).toFixed(0).padStart(5)}%      ${(a.recall_med * 100).toFixed(0).padStart(4)}%   ${(a.f1_med * 100).toFixed(0).padStart(3)}%    ${a.predicted_size_med.toString().padStart(4)}`);
  }
  // Truth size summary
  const truthSizes = perUser.map(u => u.truthSize).sort((a, b) => a - b);
  const medTruth = truthSizes[Math.floor(truthSizes.length * 0.5)];
  console.log(`\nTrue corridor median size: ${medTruth} cells (each cell ~500m)`);

  await writeFile(join(RESULTS_DIR, 'route-corridor.json'), JSON.stringify({
    usersWithCorridor,
    medianTruthSize: medTruth,
    aggregate: agg,
    perUser,
  }, null, 2));
  console.log('\nSaved to results/route-corridor.json');
}

main().catch(e => { console.error(e); process.exit(1); });
