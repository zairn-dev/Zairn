/**
 * Multi-seed ablation study — run the 6 variants 5 times with different
 * seeds for the Laplace RNG, report mean/std of each metric.
 *
 * The Laplace mechanism is the only source of randomness across runs;
 * grid snap and adaptive reporting are deterministic per user.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  processLocation,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const BASE_SEED = 'eval-user-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;
const NUM_SEEDS = 5;

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

function applyDefenseFull(locs, home, work, userId, seedSuffix) {
  const userSeed = BASE_SEED + '-' + userId + '-' + seedSuffix;
  const sensitivePlaces = buildSensitivePlaces(home, work);
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
  const reporter = new AdaptiveReporter(12, 2);
  const obs = [];
  for (const l of locs) {
    const result = processLocation(l.lat, l.lon, sensitivePlaces, config6, reporter);
    if (result.type === 'coarse') {
      obs.push({ ...l, sLat: result.lat, sLon: result.lon, cellId: result.cellId });
    }
  }
  return obs;
}

function applyDefense(locs, home, work, config, seedSuffix) {
  if (config.name === 'full') return applyDefenseFull(locs, home, work, config.userId, seedSuffix);
  if (config.name === 'none') return locs.map(l => ({ ...l, sLat: l.lat, sLon: l.lon, cellId: 'none' }));

  const { useLaplace = true, useGrid = true, useZones = true, useAdaptive = true } = config;

  const userSeed = BASE_SEED + '-' + (config.userId ?? 'default') + '-' + seedSuffix;
  const sensitivePlaces = useZones ? buildSensitivePlaces(home, work) : [];
  const reporter = new AdaptiveReporter(12, 2);
  const obs = [];

  for (const l of locs) {
    if (useZones) {
      let inZone = false;
      for (const place of sensitivePlaces) {
        const dist = haversine(l.lat, l.lon, place.lat, place.lon);
        if (dist <= (place.bufferRadiusM || 1000)) { inZone = true; break; }
      }
      if (inZone) continue;
    }

    let sLat = l.lat, sLon = l.lon;

    if (useLaplace) {
      const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      sLat = n.lat;
      sLon = n.lon;
    }

    let cellId = 'none';
    if (useGrid) {
      const s = gridSnap(sLat, sLon, GRID_SIZE_M, userSeed);
      sLat = s.lat;
      sLon = s.lon;
      cellId = s.cellId;
    }

    if (useAdaptive) {
      if (!reporter.shouldReport(cellId)) continue;
      reporter.record(cellId);
    }

    obs.push({ ...l, sLat, sLon, cellId });
  }

  return obs;
}

function stats(arr) {
  if (arr.length === 0) return { mean: null, std: null, min: null, max: null };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const vari = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  const std = Math.sqrt(vari);
  return {
    mean: Math.round(mean),
    std: Math.round(std),
    min: Math.round(Math.min(...arr)),
    max: Math.round(Math.max(...arr)),
  };
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Multi-seed ablation: ${usersMeta.length} users x ${NUM_SEEDS} seeds`);

  const variants = [
    { name: 'full',         useLaplace: true,  useGrid: true,  useZones: true,  useAdaptive: true },
    { name: 'no_laplace',   useLaplace: false, useGrid: true,  useZones: true,  useAdaptive: true },
    { name: 'no_grid',      useLaplace: true,  useGrid: false, useZones: true,  useAdaptive: true },
    { name: 'no_zones',     useLaplace: true,  useGrid: true,  useZones: false, useAdaptive: true },
    { name: 'no_adaptive',  useLaplace: true,  useGrid: true,  useZones: true,  useAdaptive: false },
    { name: 'none',         useLaplace: false, useGrid: false, useZones: false, useAdaptive: false },
  ];

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  // perSeed[variant][seed] = { medianError, exposed200, exposed500, medianObsRed }
  const perSeed = {};
  for (const v of variants) perSeed[v.name] = [];

  for (let seedIdx = 0; seedIdx < NUM_SEEDS; seedIdx++) {
    console.log(`\n--- seed ${seedIdx + 1}/${NUM_SEEDS} ---`);
    const bucket = {};
    for (const v of variants) bucket[v.name] = [];

    let done = 0;
    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      for (const v of variants) {
        const obs = applyDefense(locs, user.home, user.work, { ...v, userId: user.userId }, String(seedIdx));
        const nightObs = obs.filter(nightFilter);
        const attack = centroidAttack(nightObs, user.home.lat, user.home.lon);
        bucket[v.name].push({
          userId: user.userId,
          homeError: attack.error,
          obsReduction: parseFloat(((1 - obs.length / locs.length) * 100).toFixed(1)),
        });
      }
      done++;
      if (done % 40 === 0) console.log(`  ${done}/${usersMeta.length}`);
    }

    for (const v of variants) {
      const rows = bucket[v.name];
      const errs = rows.map(r => r.homeError).filter(e => Number.isFinite(e)).sort((a, b) => a - b);
      const red = rows.map(r => r.obsReduction).sort((a, b) => a - b);
      const median = errs.length ? errs[Math.floor(errs.length * 0.5)] : Infinity;
      const exposed200 = rows.filter(r => r.homeError < 200).length;
      const exposed500 = rows.filter(r => r.homeError < 500).length;
      const medRed = red.length ? red[Math.floor(red.length * 0.5)] : 0;
      perSeed[v.name].push({ seed: seedIdx, median, exposed200, exposed500, medRed });
    }
  }

  // Summarise across seeds
  const summary = {};
  for (const v of variants) {
    const runs = perSeed[v.name];
    summary[v.name] = {
      medianError: stats(runs.map(r => r.median).filter(Number.isFinite)),
      exposed200: stats(runs.map(r => r.exposed200)),
      exposed500: stats(runs.map(r => r.exposed500)),
      medRed: stats(runs.map(r => r.medRed)),
      runs,
    };
  }

  await writeFile(join(RESULTS_DIR, 'ablation-multiseed.json'),
    JSON.stringify({ summary, numSeeds: NUM_SEEDS, numUsers: usersMeta.length }, null, 2));

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  MULTI-SEED ABLATION STUDY (' + usersMeta.length + ' users, ' + NUM_SEEDS + ' seeds)');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Variant       | Median (mean±std) | <200m mean | <500m mean | Obs Red |  Degrad');
  console.log('─'.repeat(90));
  const fullMean = summary.full.medianError.mean;
  for (const v of variants) {
    const s = summary[v.name];
    const deg = v.name === 'full' ? '  --- ' :
      s.medianError.mean < fullMean ? `-${Math.round((1 - s.medianError.mean / fullMean) * 100)}%` :
      `+${Math.round(s.medianError.mean / fullMean - 1) * 100}%`;
    console.log(
      v.name.padEnd(14) + '| ' +
      String(`${s.medianError.mean}±${s.medianError.std}m`).padStart(17) + ' | ' +
      String(`${s.exposed200.mean}±${s.exposed200.std}`).padStart(10) + ' | ' +
      String(`${s.exposed500.mean}±${s.exposed500.std}`).padStart(10) + ' | ' +
      String(`${s.medRed.mean}%`).padStart(7) + ' | ' + deg
    );
  }
}

main().catch(console.error);
