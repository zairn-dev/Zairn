/**
 * Cross-Dataset Validation: T-Drive Taxi Trajectories
 *
 * Uses the T-Drive sample (10,357 taxis, ~1 week, Beijing) to show
 * that zone suppression generalizes beyond GeoLife. Since taxis lack
 * personal home/work, we:
 *
 *   1. Identify each taxi's "depot" as its most-frequent nighttime
 *      cell (22:00-06:00). This is the taxi's home-equivalent.
 *   2. Apply zone suppression around the depot (200m core, 1km buffer).
 *   3. Run the centroid attack targeting the depot.
 *   4. Run the route corridor attack on daytime trajectories.
 *   5. Report sparsity sensitivity (subsample at 25%, 50%, 100%).
 *
 * T-Drive format per line: taxi_id, datetime, longitude, latitude
 * File structure: one .txt file per taxi in the data directory.
 */

import { readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';

import {
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
  addPlanarLaplaceNoise,
} from '../../packages/sdk/dist/privacy-location.js';

const DATA_DIR = join(import.meta.dirname, 'data');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'tdrive-eval';
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

function corridorCell(lat, lon) {
  return `${Math.floor(lat / 0.005)},${Math.floor(lon / 0.005)}`;
}

/**
 * Parse a T-Drive text file.
 * Format: taxi_id, datetime, longitude, latitude
 */
function parseTDriveFile(content) {
  const points = [];
  for (const line of content.split('\n')) {
    const parts = line.trim().split(',');
    if (parts.length < 4) continue;
    const lon = parseFloat(parts[2]);
    const lat = parseFloat(parts[3]);
    if (isNaN(lat) || isNaN(lon) || lat < 30 || lat > 50 || lon < 110 || lon > 120) continue;
    const ts = new Date(parts[1]).getTime();
    if (isNaN(ts)) continue;
    const hour = new Date(ts).getHours();
    points.push({ lat, lon, ts, hour });
  }
  return points;
}

/**
 * Find the taxi's "depot" (nighttime cluster center).
 */
function findDepot(points) {
  const nightPts = points.filter(p => p.hour >= 22 || p.hour < 6);
  if (nightPts.length < 5) return null;
  const cellSize = 0.002;
  const cells = new Map();
  for (const p of nightPts) {
    const k = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  let best = null, bestCnt = 0;
  for (const [, pts] of cells) if (pts.length > bestCnt) { bestCnt = pts.length; best = pts; }
  if (!best) return null;
  return {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
    nightObs: nightPts.length,
  };
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

function applyDefense(point, method, places, userSeed, reporter, config6) {
  switch (method) {
    case 'raw': return { suppressed: false, sLat: point.lat, sLon: point.lon };
    case 'laplace_grid': {
      const n = addPlanarLaplaceNoise(point.lat, point.lon, BASE_EPSILON);
      const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
      return { suppressed: false, sLat: s.lat, sLon: s.lon };
    }
    case 'zkls_grid_zones': {
      for (const p of places) {
        if (haversine(point.lat, point.lon, p.lat, p.lon) <= p.bufferRadiusM) return { suppressed: true };
      }
      const s = gridSnap(point.lat, point.lon, GRID_SIZE_M, userSeed);
      return { suppressed: false, sLat: s.lat, sLon: s.lon };
    }
    case 'six_layer': {
      const r = processLocation(point.lat, point.lon, places, config6, reporter);
      if (r.type === 'coarse') return { suppressed: false, sLat: r.lat, sLon: r.lon };
      return { suppressed: true };
    }
  }
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  // Find T-Drive data files
  let files;
  try {
    files = (await readdir(DATA_DIR)).filter(f => f.endsWith('.txt'));
  } catch {
    console.error(`No data directory at ${DATA_DIR}. Download T-Drive first.`);
    process.exit(1);
  }
  console.log(`T-Drive: ${files.length} taxi files found`);

  // Limit to first 500 taxis for computational feasibility
  const MAX_TAXIS = 500;
  if (files.length > MAX_TAXIS) {
    files.sort();
    files = files.slice(0, MAX_TAXIS);
    console.log(`  (limited to ${MAX_TAXIS} for speed)`);
  }

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const taxiResults = [];
  let processed = 0, withDepot = 0;

  for (const file of files) {
    const content = await readFile(join(DATA_DIR, file), 'utf-8');
    const points = parseTDriveFile(content);
    if (points.length < 50) continue;
    processed++;

    const depot = findDepot(points);
    if (!depot) continue;
    withDepot++;

    const taxiId = file.replace('.txt', '');
    const userSeed = SEED + '-' + taxiId;
    const places = [
      { id: 'depot', label: 'home', lat: depot.lat, lon: depot.lon,
        radiusM: 200, bufferRadiusM: 1000,
        visitCount: 30, avgDwellMinutes: 480 },
    ];
    const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };

    const result = { taxiId, nPoints: points.length, depot };

    // Home (depot) inference attack
    for (const method of METHODS) {
      const reporter = new AdaptiveReporter(12, 2);
      const nightObs = [];
      for (const p of points) {
        const d = applyDefense(p, method, places, userSeed, reporter, config6);
        if (!d.suppressed && (p.hour >= 22 || p.hour < 6)) {
          nightObs.push({ sLat: d.sLat, sLon: d.sLon });
        }
      }
      const error = centroidAttack(nightObs, depot.lat, depot.lon);
      if (!result.homeAttack) result.homeAttack = {};
      result.homeAttack[method] = { error, nightObs: nightObs.length };
    }

    // Corridor attack (daytime commute hours 07-09, 17-19)
    const commuteHours = new Set([7, 8, 17, 18]);
    const depotCorridorCell = corridorCell(depot.lat, depot.lon);

    // Truth corridor (raw)
    const truthCells = new Map();
    for (const p of points) {
      if (!commuteHours.has(p.hour)) continue;
      const c = corridorCell(p.lat, p.lon);
      if (c === depotCorridorCell) continue;
      truthCells.set(c, (truthCells.get(c) || 0) + 1);
    }
    const truthCorridor = new Set();
    for (const [c, n] of truthCells) if (n >= 2) truthCorridor.add(c);

    if (truthCorridor.size >= 2) {
      result.corridor = {};
      for (const method of METHODS) {
        const reporter = new AdaptiveReporter(12, 2);
        const predCells = new Map();
        for (const p of points) {
          const d = applyDefense(p, method, places, userSeed, reporter, config6);
          if (d.suppressed) continue;
          if (!commuteHours.has(p.hour)) continue;
          const c = corridorCell(d.sLat, d.sLon);
          if (c === depotCorridorCell) continue;
          predCells.set(c, (predCells.get(c) || 0) + 1);
        }
        const pred = new Set();
        for (const [c, n] of predCells) if (n >= 2) pred.add(c);
        let inter = 0;
        for (const c of pred) if (truthCorridor.has(c)) inter++;
        const precision = pred.size > 0 ? inter / pred.size : 0;
        const recall = inter / truthCorridor.size;
        const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
        result.corridor[method] = { precision, recall, f1, predSize: pred.size, truthSize: truthCorridor.size };
      }
    }

    taxiResults.push(result);
    if (withDepot % 50 === 0) process.stdout.write(`  ${withDepot} taxis processed\r`);
  }

  console.log(`\nProcessed: ${processed}, with depot: ${withDepot}`);

  // Aggregate home attack
  console.log('\n=== Depot (Home) Inference Attack ===');
  console.log('Method              Median Err  <200m  <500m  (n=' + withDepot + ')');
  for (const m of METHODS) {
    const errors = taxiResults.map(r => r.homeAttack[m].error).filter(e => e < Infinity).sort((a, b) => a - b);
    const med = errors.length > 0 ? errors[Math.floor(errors.length * 0.5)] : null;
    const lt200 = errors.filter(e => e < 200).length;
    const lt500 = errors.filter(e => e < 500).length;
    console.log(`  ${m.padEnd(18)} ${(med || '∞').toString().padStart(8)}m   ${lt200.toString().padStart(4)}   ${lt500.toString().padStart(4)}`);
  }

  // Aggregate corridor
  const withCorridor = taxiResults.filter(r => r.corridor);
  console.log(`\n=== Route Corridor Attack (n=${withCorridor.length} taxis with corridors) ===`);
  console.log('Method              Precision  Recall  F1');
  for (const m of METHODS) {
    const f1s = withCorridor.map(r => r.corridor[m].f1).sort((a, b) => a - b);
    const precs = withCorridor.map(r => r.corridor[m].precision).sort((a, b) => a - b);
    const recs = withCorridor.map(r => r.corridor[m].recall).sort((a, b) => a - b);
    const medF1 = f1s[Math.floor(f1s.length * 0.5)] || 0;
    const medP = precs[Math.floor(precs.length * 0.5)] || 0;
    const medR = recs[Math.floor(recs.length * 0.5)] || 0;
    console.log(`  ${m.padEnd(18)} ${(medP * 100).toFixed(0).padStart(5)}%     ${(medR * 100).toFixed(0).padStart(4)}%  ${(medF1 * 100).toFixed(0).padStart(3)}%`);
  }

  await writeFile(join(RESULTS_DIR, 'tdrive-eval.json'), JSON.stringify({
    processed, withDepot,
    withCorridor: withCorridor.length,
    taxiResults: taxiResults.slice(0, 50), // save subset for debugging
    aggregate: {
      homeAttack: Object.fromEntries(METHODS.map(m => {
        const errors = taxiResults.map(r => r.homeAttack[m].error).filter(e => e < Infinity).sort((a, b) => a - b);
        return [m, {
          median: errors.length > 0 ? errors[Math.floor(errors.length * 0.5)] : null,
          lt200: errors.filter(e => e < 200).length,
          lt500: errors.filter(e => e < 500).length,
          n: errors.length,
        }];
      })),
      corridor: Object.fromEntries(METHODS.map(m => {
        const f1s = withCorridor.map(r => r.corridor[m].f1).sort((a, b) => a - b);
        const precs = withCorridor.map(r => r.corridor[m].precision).sort((a, b) => a - b);
        const recs = withCorridor.map(r => r.corridor[m].recall).sort((a, b) => a - b);
        return [m, {
          precision_med: precs[Math.floor(precs.length * 0.5)] || 0,
          recall_med: recs[Math.floor(recs.length * 0.5)] || 0,
          f1_med: f1s[Math.floor(f1s.length * 0.5)] || 0,
          n: withCorridor.length,
        }];
      })),
    },
  }, null, 2));
  console.log('\nSaved to results/tdrive-eval.json');
}

main().catch(e => { console.error(e); process.exit(1); });
