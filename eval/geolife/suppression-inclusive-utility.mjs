/**
 * Suppression-Inclusive Utility Metrics
 *
 * Current utility metrics exclude suppressed observations.
 * This gives an optimistic view for low-availability configs.
 *
 * New metrics:
 * 1. "Overall task success" — includes suppressed as "unanswerable"
 * 2. "Staleness" — average time since last visible observation
 * 3. "Information availability" — what fraction of social queries
 *    can be answered at any given time?
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

function buildPlaces(home, work) {
  const places = [{ lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000 }];
  if (work) places.push({ lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000 });
  return places;
}

function processLoc(l, places, userSeed, reporter, config) {
  let inCore = false, inBuffer = false;
  for (const p of places) {
    const d = haversine(l.lat, l.lon, p.lat, p.lon);
    if (d <= p.radiusM) { inCore = true; break; }
    if (d <= p.bufferRadiusM) { inBuffer = true; }
  }

  switch (config) {
    case 'raw':
      return { type: 'visible', lat: l.lat, lon: l.lon, state: null };
    case 'zkls_grid_zones':
      if (inCore) return { type: 'state', state: 'at_place' };
      if (inBuffer) return { type: 'suppressed' };
      const s1 = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      return { type: 'visible', lat: s1.lat, lon: s1.lon, state: null };
    case 'six_layer':
      if (inCore) return { type: 'state', state: 'at_place' };
      if (inBuffer) return { type: 'suppressed' };
      const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      const s2 = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
      if (!reporter.shouldReport(s2.cellId)) return { type: 'suppressed' };
      reporter.record(s2.cellId);
      return { type: 'visible', lat: s2.lat, lon: s2.lon, state: null };
  }
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  const configs = ['raw', 'zkls_grid_zones', 'six_layer'];

  const results = {};

  for (const cfg of configs) {
    // Suppression-inclusive "at home" task:
    // true positive: correctly says "at home" (state or coords near home)
    // true negative: correctly says "not at home" or "I don't know but they're not"
    // false negative: user IS at home but system says nothing (suppressed without state)
    // unanswerable: suppressed without any state info
    let task_correct = 0, task_wrong = 0, task_unanswerable = 0, task_total = 0;

    // Staleness: hours since last visible observation
    const staleness_values = []; // per-user median staleness

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const userSeed = SEED + '-' + user.userId;
      const places = buildPlaces(user.home, user.work);
      const reporter = new AdaptiveReporter(12, 2);

      let lastVisibleTs = null;
      const user_staleness = [];

      for (const l of locs) {
        const trueAtHome = haversine(l.lat, l.lon, user.home.lat, user.home.lon) < 200;
        const result = processLoc(l, places, userSeed, reporter, cfg);

        // Staleness
        if (result.type === 'visible' || result.type === 'state') {
          lastVisibleTs = l.day * 24 + l.hour;
        }
        if (lastVisibleTs !== null) {
          const currentTs = l.day * 24 + l.hour;
          user_staleness.push(currentTs - lastVisibleTs);
        }

        // Suppression-inclusive task
        task_total++;
        if (result.type === 'suppressed') {
          // Suppressed = unanswerable. If user is at home, this is a missed opportunity.
          task_unanswerable++;
          if (trueAtHome) task_wrong++; // We can't tell them they're safe
        } else if (result.type === 'state') {
          // State says "at place" — if near home, correct
          const inferAtHome = true; // at_place near home
          if (trueAtHome === inferAtHome) task_correct++;
          else task_wrong++;
        } else {
          // Visible coordinates
          const inferAtHome = haversine(result.lat, result.lon, user.home.lat, user.home.lon) < 300;
          if (trueAtHome === inferAtHome) task_correct++;
          else task_wrong++;
        }
      }

      user_staleness.sort((a, b) => a - b);
      if (user_staleness.length > 0) {
        staleness_values.push(user_staleness[Math.floor(user_staleness.length * 0.5)]);
      }
    }

    staleness_values.sort((a, b) => a - b);
    const medStaleness = staleness_values.length > 0 ? staleness_values[Math.floor(staleness_values.length * 0.5)] : null;
    const p95Staleness = staleness_values.length > 0 ? staleness_values[Math.floor(staleness_values.length * 0.95)] : null;

    results[cfg] = {
      taskAccuracy: +(task_correct / task_total * 100).toFixed(1),
      taskUnanswerable: +(task_unanswerable / task_total * 100).toFixed(1),
      taskWrong: +(task_wrong / task_total * 100).toFixed(1),
      medianStalenessHours: medStaleness,
      p95StalenessHours: p95Staleness,
    };

    console.log(`${cfg.padEnd(20)} accuracy=${results[cfg].taskAccuracy}% unanswerable=${results[cfg].taskUnanswerable}% staleness_med=${medStaleness}h p95=${p95Staleness}h`);
  }

  await writeFile(join(RESULTS_DIR, 'suppression-inclusive-utility.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
