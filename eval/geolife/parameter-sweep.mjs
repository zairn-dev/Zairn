/**
 * Parameter Sweep — Privacy-Utility Frontier
 *
 * Sweeps core zone radius, buffer radius, and grid size to map
 * the design space and show how parameters affect the tradeoff.
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
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const nKey = `${bRow + dr},${bCol + dc}`;
    if (cells.has(nKey)) filtered.push(...cells.get(nKey));
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length };
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  // Parameter configurations to sweep
  const configs = [
    // Vary core zone radius (buffer = 2x core, grid = 500m)
    { name: 'core=100m', coreR: 100, bufferR: 200, gridM: 500 },
    { name: 'core=200m', coreR: 200, bufferR: 1000, gridM: 500 },
    { name: 'core=400m', coreR: 400, bufferR: 1500, gridM: 500 },
    { name: 'core=800m', coreR: 800, bufferR: 2000, gridM: 500 },
    // Vary buffer radius (core = 200m, grid = 500m)
    { name: 'buf=500m', coreR: 200, bufferR: 500, gridM: 500 },
    { name: 'buf=1000m', coreR: 200, bufferR: 1000, gridM: 500 },
    { name: 'buf=2000m', coreR: 200, bufferR: 2000, gridM: 500 },
    // Vary grid size (core = 200m, buffer = 1000m)
    { name: 'grid=250m', coreR: 200, bufferR: 1000, gridM: 250 },
    { name: 'grid=500m', coreR: 200, bufferR: 1000, gridM: 500 },
    { name: 'grid=1000m', coreR: 200, bufferR: 1000, gridM: 1000 },
    { name: 'grid=2000m', coreR: 200, bufferR: 1000, gridM: 2000 },
  ];

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const results = [];

  for (const cfg of configs) {
    const homeErrors = [];
    const presenceF1s = [];
    const areaAccs = [];
    const availabilities = [];
    let exposed200 = 0, exposed500 = 0;

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const userSeed = SEED + '-' + user.userId;

      const places = [
        { lat: user.home.lat, lon: user.home.lon, radiusM: cfg.coreR, bufferRadiusM: cfg.bufferR },
        ...(user.work ? [{ lat: user.work.lat, lon: user.work.lon, radiusM: cfg.coreR, bufferRadiusM: cfg.bufferR }] : []),
      ];

      const reporter = new AdaptiveReporter(12, 2);
      const obs = [];
      let presTP = 0, presFP = 0, presFN = 0, presTN = 0;
      let areaOk = 0, areaTotal = 0;
      let available = 0;

      for (const l of locs) {
        const trueAtHome = haversine(l.lat, l.lon, user.home.lat, user.home.lon) < 200;
        let inCore = false, inBuffer = false;
        for (const p of places) {
          const d = haversine(l.lat, l.lon, p.lat, p.lon);
          if (d <= p.radiusM) { inCore = true; break; }
          if (d <= p.bufferRadiusM) { inBuffer = true; }
        }

        if (inCore) {
          // State-only: presence TP/FN
          if (trueAtHome) presTP++;
          else presFP++;
          available++;
          continue;
        }
        if (inBuffer) continue; // suppressed

        const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
        const s = gridSnap(n.lat, n.lon, cfg.gridM, userSeed);
        if (!reporter.shouldReport(s.cellId)) {
          if (trueAtHome) presFN++; else presTN++;
          continue;
        }
        reporter.record(s.cellId);
        available++;

        const inferAtHome = haversine(s.lat, s.lon, user.home.lat, user.home.lon) < 300;
        if (trueAtHome && inferAtHome) presTP++;
        else if (!trueAtHome && inferAtHome) presFP++;
        else if (trueAtHome && !inferAtHome) presFN++;
        else presTN++;

        const trueCell = `${Math.floor(l.lat / 0.02)},${Math.floor(l.lon / 0.02)}`;
        const sharedCell = `${Math.floor(s.lat / 0.02)},${Math.floor(s.lon / 0.02)}`;
        if (trueCell === sharedCell) areaOk++;
        areaTotal++;

        obs.push({ ...l, sLat: s.lat, sLon: s.lon });
      }

      // Home attack
      const nightObs = obs.filter(nightFilter);
      const attack = centroidAttack(nightObs, user.home.lat, user.home.lon);
      homeErrors.push(attack.error);
      if (attack.error < 200) exposed200++;
      if (attack.error < 500) exposed500++;

      const prec = (presTP + presFP) > 0 ? presTP / (presTP + presFP) : 0;
      const rec = (presTP + presFN) > 0 ? presTP / (presTP + presFN) : 0;
      const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
      presenceF1s.push(Math.round(f1 * 1000) / 1000);
      areaAccs.push(areaTotal > 0 ? Math.round(areaOk / areaTotal * 1000) / 1000 : 0);
      availabilities.push(Math.round(available / locs.length * 1000) / 1000);
    }

    homeErrors.sort((a, b) => a - b);
    presenceF1s.sort((a, b) => a - b);
    areaAccs.sort((a, b) => a - b);
    availabilities.sort((a, b) => a - b);
    const med = arr => arr[Math.floor(arr.length * 0.5)];

    const r = {
      config: cfg.name,
      coreR: cfg.coreR, bufferR: cfg.bufferR, gridM: cfg.gridM,
      homeMedian: med(homeErrors.filter(e => e < Infinity)),
      exposed200, exposed500,
      presF1: med(presenceF1s),
      areaAcc: med(areaAccs),
      availability: med(availabilities),
    };
    results.push(r);
    console.log(`${cfg.name.padEnd(15)} home=${r.homeMedian}m <500=${exposed500} F1=${r.presF1} area=${r.areaAcc} avail=${r.availability}`);
  }

  await writeFile(join(RESULTS_DIR, 'parameter-sweep.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved to results/parameter-sweep.json');
}

main().catch(console.error);
