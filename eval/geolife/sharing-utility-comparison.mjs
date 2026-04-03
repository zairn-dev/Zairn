/**
 * Sharing Utility Comparison — All defense configurations
 *
 * Runs departure latency + task success for all 6 configs to show
 * which configuration provides the best sharing experience.
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

/**
 * Apply a specific defense configuration and return per-observation results.
 */
function processTrace(locs, home, work, configName, userId) {
  const userSeed = SEED + '-' + userId;
  const places = buildPlaces(home, work);
  const reporter = new AdaptiveReporter(12, 2);
  const results = [];

  for (const l of locs) {
    const distHome = haversine(l.lat, l.lon, home.lat, home.lon);
    const distWork = work ? haversine(l.lat, l.lon, work.lat, work.lon) : Infinity;

    let inCore = false, inBuffer = false;
    for (const p of places) {
      const d = haversine(l.lat, l.lon, p.lat, p.lon);
      if (d <= p.radiusM) { inCore = true; break; }
      if (d <= p.bufferRadiusM) { inBuffer = true; }
    }

    let shared;
    switch (configName) {
      case 'raw':
        shared = { type: 'coarse', lat: l.lat, lon: l.lon };
        break;
      case 'laplace_grid': {
        const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
        const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
        shared = { type: 'coarse', lat: s.lat, lon: s.lon };
        break;
      }
      case 'zkls_grid': {
        const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
        shared = { type: 'coarse', lat: s.lat, lon: s.lon };
        break;
      }
      case 'zkls_grid_zones': {
        if (inCore) { shared = { type: 'state', label: 'at_place' }; }
        else if (inBuffer) { shared = { type: 'suppressed' }; }
        else {
          const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
          shared = { type: 'coarse', lat: s.lat, lon: s.lon };
        }
        break;
      }
      case 'six_layer': {
        if (inCore) { shared = { type: 'state', label: 'at_place' }; }
        else if (inBuffer) { shared = { type: 'suppressed' }; }
        else {
          const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
          const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
          if (!reporter.shouldReport(s.cellId)) { shared = { type: 'suppressed' }; }
          else { reporter.record(s.cellId); shared = { type: 'coarse', lat: s.lat, lon: s.lon }; }
        }
        break;
      }
      case 'zkls_full': {
        if (inCore) { shared = { type: 'state', label: 'at_place' }; }
        else if (inBuffer) { shared = { type: 'suppressed' }; }
        else {
          const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
          if (!reporter.shouldReport(s.cellId)) { shared = { type: 'suppressed' }; }
          else { reporter.record(s.cellId); shared = { type: 'coarse', lat: s.lat, lon: s.lon }; }
        }
        break;
      }
    }

    results.push({ ...l, distHome, distWork, shared });
  }
  return results;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const configs = ['raw', 'laplace_grid', 'zkls_grid', 'zkls_grid_zones', 'six_layer', 'zkls_full'];
  const allResults = {};

  for (const cfg of configs) {
    let task1_ok = 0, task1_n = 0;
    let task2_ok = 0, task2_n = 0;
    let task3_ok = 0, task3_n = 0;
    let available = 0, total = 0;
    const depLatencies = [];

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const trace = processTrace(locs, user.home, user.work, cfg, user.userId);

      let wasAtHome = false;
      let depHour = null;

      for (const r of trace) {
        total++;
        if (r.shared.type !== 'suppressed') available++;

        // Task 1: at home? (nighttime)
        if (r.hour >= 22 || r.hour < 6) {
          const trueAtHome = r.distHome < 200;
          let inferAtHome = false;
          if (r.shared.type === 'state') inferAtHome = true;
          else if (r.shared.type === 'coarse') inferAtHome = haversine(r.shared.lat, r.shared.lon, user.home.lat, user.home.lon) < 300;
          if (trueAtHome === inferAtHome) task1_ok++;
          task1_n++;
        }

        // Task 2: at work? (weekday day)
        if (!r.isWeekend && r.hour >= 9 && r.hour < 17 && user.work) {
          const trueAtWork = r.distWork < 200;
          let inferAtWork = false;
          if (r.shared.type === 'state') inferAtWork = true;
          else if (r.shared.type === 'coarse') inferAtWork = haversine(r.shared.lat, r.shared.lon, user.work.lat, user.work.lon) < 300;
          if (trueAtWork === inferAtWork) task2_ok++;
          task2_n++;
        }

        // Task 3: neighborhood (when visible)
        if (r.shared.type === 'coarse') {
          const trueCell = `${Math.floor(r.lat / 0.02)},${Math.floor(r.lon / 0.02)}`;
          const sharedCell = `${Math.floor(r.shared.lat / 0.02)},${Math.floor(r.shared.lon / 0.02)}`;
          if (trueCell === sharedCell) task3_ok++;
          task3_n++;
        }

        // Departure latency
        const atHome = r.distHome < 200;
        if (wasAtHome && !atHome) depHour = r.day * 24 + r.hour;
        if (depHour !== null && r.shared.type === 'coarse') {
          const lat = r.day * 24 + r.hour - depHour;
          if (lat >= 0 && lat < 24) depLatencies.push(lat);
          depHour = null;
        }
        wasAtHome = atHome;
      }
    }

    depLatencies.sort((a, b) => a - b);
    const med = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.5)] : null;

    allResults[cfg] = {
      task1_atHome: task1_n > 0 ? +(task1_ok / task1_n * 100).toFixed(1) : null,
      task2_atWork: task2_n > 0 ? +(task2_ok / task2_n * 100).toFixed(1) : null,
      task3_neighborhood: task3_n > 0 ? +(task3_ok / task3_n * 100).toFixed(1) : null,
      availability: +(available / total * 100).toFixed(1),
      depLatencyMedian: med(depLatencies),
      depWithin1h: depLatencies.length > 0 ? Math.round(depLatencies.filter(l => l <= 1).length / depLatencies.length * 100) : null,
      depEvents: depLatencies.length,
    };
  }

  // Print comparison table
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  SHARING UTILITY COMPARISON');
  console.log('══════════════════════════════════════════════════════════════════\n');
  console.log('Config            | At home? | At work? | Neighborhood | Avail  | Dep ≤1h');
  console.log('─'.repeat(75));
  for (const cfg of configs) {
    const r = allResults[cfg];
    console.log(
      cfg.padEnd(18) + '| ' +
      String(r.task1_atHome + '%').padStart(8) + ' | ' +
      String(r.task2_atWork + '%').padStart(8) + ' | ' +
      String(r.task3_neighborhood + '%').padStart(12) + ' | ' +
      String(r.availability + '%').padStart(6) + ' | ' +
      (r.depWithin1h !== null ? r.depWithin1h + '%' : 'N/A')
    );
  }

  await writeFile(join(RESULTS_DIR, 'sharing-utility-comparison.json'), JSON.stringify(allResults, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
