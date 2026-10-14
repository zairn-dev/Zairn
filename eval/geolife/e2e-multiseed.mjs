/**
 * Deployment (end-to-end) — 5-seed mean ± std
 *
 * Reproduces end-to-end-eval.mjs's three Grid+Zones conditions across NUM_RUNS
 * seeds (run0..run4), using the exact RNG/seed conventions of multi-seed-eval.mjs:
 *   runSeed  = `${SEED_BASE}-run${run}`
 *   userSeed = `${runSeed}-${userId}`
 *
 * Conditions (paper Table tab:e2e):
 *   oracle           — ground-truth home/work places ("Oracle (ground truth)")
 *   detected         — auto-detected places only        ("Auto-detected only")
 *   detected+manual  — detect, then confirm ground-truth ("Detect-then-confirm")
 *
 * For each condition: median error, <200m exposed, <500m exposed — each as
 * mean ± std across the 5 seeds. Defense application (runDefense) is identical
 * to end-to-end-eval.mjs (core/buffer suppression + 500m grid + AdaptiveReporter).
 *
 * Output: results/e2e-multiseed.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  gridSnap,
  detectSensitivePlaces,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
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
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Identical to end-to-end-eval.mjs.
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
  if (!bestKey) return { error: Infinity, count: 0 };
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

// Identical to end-to-end-eval.mjs::runDefense, seed parameterised per run.
function runDefense(locs, sensitivePlaces, userSeed) {
  const reporter = new AdaptiveReporter(12, 2);
  const obs = [];
  for (const l of locs) {
    let inCore = false, inBuffer = false;
    for (const p of sensitivePlaces) {
      const d = haversine(l.lat, l.lon, p.lat, p.lon);
      if (d <= p.radiusM) { inCore = true; break; }
      if (d <= p.bufferRadiusM) { inBuffer = true; }
    }
    if (inCore || inBuffer) continue;
    const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    if (!reporter.shouldReport(s.cellId)) continue;
    reporter.record(s.cellId);
    obs.push({ ...l, sLat: s.lat, sLon: s.lon });
  }
  return obs;
}

const CONDITIONS = ['oracle', 'detected', 'detected+manual'];

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`E2E multi-seed: ${usersMeta.length} users, ${NUM_RUNS} runs\n`);

  // Preload traces once.
  const userTraces = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    userTraces.push({ user, locs });
  }

  const nightFilter = o => o.hour >= 22 || o.hour < 6;

  // perRun[run][cond] = { median, exposed200, exposed500, avgPlaces }
  const perRun = [];

  for (let run = 0; run < NUM_RUNS; run++) {
    const runSeed = `${SEED_BASE}-run${run}`;
    const runResult = {};

    for (const cond of CONDITIONS) {
      const homeErrors = [];
      let exposed200 = 0, exposed500 = 0;
      let placesDetected = 0;

      for (const { user, locs } of userTraces) {
        const userSeed = runSeed + '-' + user.userId;

        const training = locs.filter(l => l.day < 30).map(l => ({
          lat: l.lat, lon: l.lon, timestamp: l.timestamp,
        }));

        let sensitivePlaces;
        if (cond === 'oracle') {
          sensitivePlaces = [
            { lat: user.home.lat, lon: user.home.lon, radiusM: 200, bufferRadiusM: 1000 },
            ...(user.work ? [{ lat: user.work.lat, lon: user.work.lon, radiusM: 200, bufferRadiusM: 1000 }] : []),
          ];
        } else {
          const detected = detectSensitivePlaces(training, {
            ...DEFAULT_PRIVACY_CONFIG,
            minVisitsForSensitive: 3,
            minDwellMinutes: 30,
          });
          sensitivePlaces = detected.map(p => ({
            lat: p.lat, lon: p.lon,
            radiusM: p.radiusM,
            bufferRadiusM: p.bufferRadiusM,
          }));

          if (cond === 'detected+manual') {
            const hasHome = detected.some(p =>
              haversine(p.lat, p.lon, user.home.lat, user.home.lon) < 1000
            );
            if (!hasHome) {
              sensitivePlaces.push({
                lat: user.home.lat, lon: user.home.lon,
                radiusM: 200, bufferRadiusM: 1000,
              });
            }
          }
          placesDetected += sensitivePlaces.length;
        }

        const obs = runDefense(locs, sensitivePlaces, userSeed);
        const nightObs = obs.filter(nightFilter);
        const attack = centroidAttack(nightObs, user.home.lat, user.home.lon);
        homeErrors.push(attack.error);
        if (attack.error < 200) exposed200++;
        if (attack.error < 500) exposed500++;
      }

      homeErrors.sort((a, b) => a - b);
      const finite = homeErrors.filter(e => e < Infinity);
      const med = finite.length > 0 ? finite[Math.floor(finite.length * 0.5)] : null;

      runResult[cond] = {
        median: med,
        exposed200,
        exposed500,
        avgPlaces: cond !== 'oracle' ? Number((placesDetected / usersMeta.length).toFixed(1)) : null,
      };
    }

    perRun.push(runResult);
    console.log(`Run ${run + 1}/${NUM_RUNS} done`);
  }

  // Aggregate mean ± std across runs.
  const stats = (arr) => {
    const vals = arr.filter(v => v !== null && v !== undefined);
    if (vals.length === 0) return { mean: null, std: null, values: arr };
    const n = vals.length;
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return { mean: Math.round(mean), std: Math.round(std), min: Math.min(...vals), max: Math.max(...vals), values: arr };
  };

  const aggregate = {};
  for (const cond of CONDITIONS) {
    aggregate[cond] = {
      median: stats(perRun.map(r => r[cond].median)),
      exposed200: stats(perRun.map(r => r[cond].exposed200)),
      exposed500: stats(perRun.map(r => r[cond].exposed500)),
    };
  }

  const output = {
    config: { numRuns: NUM_RUNS, seedBase: SEED_BASE, baseEpsilon: BASE_EPSILON, gridSizeM: GRID_SIZE_M },
    conditions: CONDITIONS,
    aggregate,
    run0: Object.fromEntries(CONDITIONS.map(c => [c, perRun[0][c]])),
    perRun,
  };
  await writeFile(join(RESULTS_DIR, 'e2e-multiseed.json'), JSON.stringify(output, null, 2));

  // ---- Console report ----
  const labels = {
    oracle: 'Oracle (ground truth)',
    detected: 'Auto-detected only',
    'detected+manual': 'Detect-then-confirm',
  };

  console.log('\n=== Deployment (Grid+Zones), 5-seed mean±std ===');
  console.log('Condition'.padEnd(24) + 'Median'.padStart(14) + '<200'.padStart(12) + '<500'.padStart(12));
  for (const cond of CONDITIONS) {
    const a = aggregate[cond];
    console.log(
      labels[cond].padEnd(24) +
      `${a.median.mean}±${a.median.std}`.padStart(14) +
      `${a.exposed200.mean}±${a.exposed200.std}`.padStart(12) +
      `${a.exposed500.mean}±${a.exposed500.std}`.padStart(12)
    );
  }

  console.log('\n=== run0 (single-seed) — sanity-check vs paper table ===');
  console.log('Condition'.padEnd(24) + 'Median'.padStart(10) + '<200'.padStart(8) + '<500'.padStart(8));
  for (const cond of CONDITIONS) {
    const r = perRun[0][cond];
    console.log(labels[cond].padEnd(24) + String(r.median).padStart(10) + String(r.exposed200).padStart(8) + String(r.exposed500).padStart(8));
  }

  console.log('\nSaved results/e2e-multiseed.json');
}

main().catch(e => { console.error(e); process.exit(1); });
