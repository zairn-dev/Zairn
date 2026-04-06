/**
 * Multi-seed evaluation — run main attack simulation 5 times
 * with different Laplace noise seeds to report mean ± std.
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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return Infinity;
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat/cellSize)},${Math.floor(o.sLon/cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }
  let best = null, bc = 0;
  for (const [,pts] of cells) { if (pts.length > bc) { bc = pts.length; best = pts; } }
  if (!best) return Infinity;
  const [br, bcc] = [...cells.entries()].find(([,v]) => v === best)[0].split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const k = `${br+dr},${bcc+dc}`;
    if (cells.has(k)) filtered.push(...cells.get(k));
  }
  const aLat = filtered.reduce((s,o) => s+o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s,o) => s+o.sLon, 0) / filtered.length;
  return Math.round(haversine(aLat, aLon, targetLat, targetLon));
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Multi-seed evaluation: ${usersMeta.length} users, ${NUM_RUNS} runs\n`);

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const methods = ['zkls_grid_zones', 'six_layer'];
  const allRunResults = {};
  for (const m of methods) allRunResults[m] = { medians: [], exposed200: [], exposed500: [] };

  for (let run = 0; run < NUM_RUNS; run++) {
    const runSeed = `${SEED_BASE}-run${run}`;
    for (const method of methods) {
      const homeErrors = [];
      let e200 = 0, e500 = 0;

      for (const user of usersMeta) {
        const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
        const userSeed = runSeed + '-' + user.userId;
        const places = [
          { lat: user.home.lat, lon: user.home.lon, radiusM: 200, bufferRadiusM: 1000 },
          ...(user.work ? [{ lat: user.work.lat, lon: user.work.lon, radiusM: 200, bufferRadiusM: 1000 }] : []),
        ];

        const obs = [];
        if (method === 'zkls_grid_zones') {
          for (const l of locs) {
            let inZone = false;
            for (const p of places) {
              if (haversine(l.lat, l.lon, p.lat, p.lon) <= (p.bufferRadiusM || 1000)) { inZone = true; break; }
            }
            if (inZone) continue;
            const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
            obs.push({ ...l, sLat: s.lat, sLon: s.lon });
          }
        } else {
          const config = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
          const reporter = new AdaptiveReporter(12, 2);
          for (const l of locs) {
            const result = processLocation(l.lat, l.lon, places, config, reporter);
            if (result.type === 'coarse') obs.push({ ...l, sLat: result.lat, sLon: result.lon });
          }
        }

        const nightObs = obs.filter(nightFilter);
        const error = centroidAttack(nightObs, user.home.lat, user.home.lon);
        homeErrors.push(error);
        if (error < 200) e200++;
        if (error < 500) e500++;
      }

      homeErrors.sort((a,b) => a-b);
      const finite = homeErrors.filter(e => e < Infinity);
      const median = finite.length > 0 ? finite[Math.floor(finite.length * 0.5)] : null;
      allRunResults[method].medians.push(median);
      allRunResults[method].exposed200.push(e200);
      allRunResults[method].exposed500.push(e500);
    }
    console.log(`Run ${run+1}/${NUM_RUNS} done`);
  }

  // Compute mean ± std
  const stats = (arr) => {
    const n = arr.length;
    const mean = arr.reduce((s,v) => s+v, 0) / n;
    const std = Math.sqrt(arr.reduce((s,v) => s + (v-mean)**2, 0) / n);
    return { mean: Math.round(mean), std: Math.round(std), min: Math.min(...arr), max: Math.max(...arr), values: arr };
  };

  const results = {};
  for (const m of methods) {
    results[m] = {
      median: stats(allRunResults[m].medians),
      exposed200: stats(allRunResults[m].exposed200),
      exposed500: stats(allRunResults[m].exposed500),
    };
    const r = results[m];
    console.log(`\n${m}:`);
    console.log(`  Median home error: ${r.median.mean} ± ${r.median.std}m (range: ${r.median.min}-${r.median.max})`);
    console.log(`  <200m exposed: ${r.exposed200.mean} ± ${r.exposed200.std} (range: ${r.exposed200.min}-${r.exposed200.max})`);
    console.log(`  <500m exposed: ${r.exposed500.mean} ± ${r.exposed500.std} (range: ${r.exposed500.min}-${r.exposed500.max})`);
  }

  await writeFile(join(RESULTS_DIR, 'multi-seed.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
