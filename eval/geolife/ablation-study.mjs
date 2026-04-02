/**
 * Ablation Study — Remove each defense layer and measure degradation
 *
 * Tests 7 variants:
 * 0. Full system (baseline)
 * 1. No Laplace noise (grid snap only)
 * 2. No grid snap (Laplace only, raw coords after noise)
 * 3. No sensitive place zones
 * 4. No adaptive reporting
 * 5. No distance bucketing (not measurable in centroid attack, skip)
 * 6. No ZKLS (use noisy coords instead of cell center)
 *
 * Output: eval/geolife/results/ablation.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

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
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nKey = `${bRow + dr},${bCol + dc}`;
      if (cells.has(nKey)) filtered.push(...cells.get(nKey));
    }
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length };
}

function buildSensitivePlaces(home, work) {
  const places = [{
    id: 'home', label: 'home', lat: home.lat, lon: home.lon,
    radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
    bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
    visitCount: 30, avgDwellMinutes: 480,
  }];
  if (work) {
    places.push({
      id: 'work', label: 'work', lat: work.lat, lon: work.lon,
      radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
      bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
      visitCount: 20, avgDwellMinutes: 480,
    });
  }
  return places;
}

function applyDefense(locs, home, work, config) {
  const {
    useLaplace = true,
    useGrid = true,
    useZones = true,
    useAdaptive = true,
  } = config;

  const userSeed = SEED + '-' + Math.random().toString(36).slice(2);
  const sensitivePlaces = useZones ? buildSensitivePlaces(home, work) : [];
  const reporter = new AdaptiveReporter(12, 2);
  const obs = [];

  for (const l of locs) {
    // Zone check
    if (useZones) {
      let inZone = false;
      for (const place of sensitivePlaces) {
        const dist = haversine(l.lat, l.lon, place.lat, place.lon);
        if (dist <= (place.bufferRadiusM || 1000)) { inZone = true; break; }
      }
      if (inZone) continue;
    }

    let sLat = l.lat, sLon = l.lon;

    // Laplace noise
    if (useLaplace) {
      const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      sLat = n.lat;
      sLon = n.lon;
    }

    // Grid snap
    let cellId = 'none';
    if (useGrid) {
      const s = gridSnap(sLat, sLon, GRID_SIZE_M, userSeed);
      sLat = s.lat;
      sLon = s.lon;
      cellId = s.cellId;
    }

    // Adaptive reporting
    if (useAdaptive) {
      if (!reporter.shouldReport(cellId)) continue;
      reporter.record(cellId);
    }

    obs.push({ ...l, sLat, sLon, cellId });
  }

  return obs;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Loaded ${usersMeta.length} users`);

  const variants = [
    { name: 'full',         useLaplace: true,  useGrid: true,  useZones: true,  useAdaptive: true },
    { name: 'no_laplace',   useLaplace: false, useGrid: true,  useZones: true,  useAdaptive: true },
    { name: 'no_grid',      useLaplace: true,  useGrid: false, useZones: true,  useAdaptive: true },
    { name: 'no_zones',     useLaplace: true,  useGrid: true,  useZones: false, useAdaptive: true },
    { name: 'no_adaptive',  useLaplace: true,  useGrid: true,  useZones: true,  useAdaptive: false },
    { name: 'none',         useLaplace: false, useGrid: false, useZones: false, useAdaptive: false },
  ];

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const allResults = {};
  for (const v of variants) allResults[v.name] = [];

  let done = 0;
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    for (const v of variants) {
      const obs = applyDefense(locs, user.home, user.work, v);
      const nightObs = obs.filter(nightFilter);
      const attack = centroidAttack(nightObs, user.home.lat, user.home.lon);
      allResults[v.name].push({
        userId: user.userId,
        homeError: attack.error,
        nightObs: attack.count,
        totalObs: obs.length,
        obsReduction: ((1 - obs.length / locs.length) * 100).toFixed(1),
      });
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
  }

  // Compute summary
  const summary = {};
  for (const v of variants) {
    const errors = allResults[v.name].map(r => r.homeError).filter(e => e < Infinity).sort((a, b) => a - b);
    const obsRed = allResults[v.name].map(r => parseFloat(r.obsReduction)).sort((a, b) => a - b);
    const exposed = allResults[v.name].filter(r => r.homeError < 200).length;
    const risky = allResults[v.name].filter(r => r.homeError < 500).length;
    const p = (arr, pct) => arr.length > 0 ? arr[Math.floor(arr.length * pct)] : null;
    summary[v.name] = {
      medianError: p(errors, 0.5),
      p25Error: p(errors, 0.25),
      p75Error: p(errors, 0.75),
      exposedCount: exposed,
      riskyCount: risky,
      medianObsReduction: p(obsRed, 0.5),
    };
  }

  await writeFile(join(RESULTS_DIR, 'ablation.json'), JSON.stringify({ summary, detail: allResults }, null, 2));

  // Print table
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ABLATION STUDY (' + usersMeta.length + ' users)');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Variant          | Home Err (med) | <200m | <500m | Obs Red | Degradation');
  console.log('─'.repeat(80));
  const fullMedian = summary.full.medianError;
  for (const v of variants) {
    const s = summary[v.name];
    const deg = v.name === 'full' ? '(baseline)' :
      s.medianError < fullMedian ? `${Math.round((1 - s.medianError / fullMedian) * 100)}% better??` :
      `-${Math.round((1 - fullMedian / s.medianError) * 100)}%`;
    console.log(
      v.name.padEnd(17) + '| ' +
      String(s.medianError + 'm').padStart(14) + ' | ' +
      String(s.exposedCount).padStart(5) + ' | ' +
      String(s.riskyCount).padStart(5) + ' | ' +
      String(s.medianObsReduction + '%').padStart(7) + ' | ' +
      deg
    );
  }
}

main().catch(console.error);
