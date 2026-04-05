/**
 * Cell Transition Sequence Attack
 *
 * An attacker observes the sequence of grid cells a user visits.
 * Even without knowing the exact position within each cell, the
 * transition pattern (which cells, in what order, at what times)
 * can reveal home/work/commute patterns.
 *
 * Attack: identify the most-visited cell during nighttime hours
 * and use its center as the home estimate.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'eval-user-seed';
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

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Cell transition attack: ${usersMeta.length} users\n`);

  const methods = {
    // No defense: raw cell IDs
    raw: (l, _places, userSeed, _reporter) => {
      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      return { cellId: s.cellId, lat: s.lat, lon: s.lon };
    },
    // ZKLS Grid+Zones: suppress in zones
    zkls_grid_zones: (l, places, userSeed, _reporter) => {
      for (const p of places) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= (p.bufferRadiusM || 1000)) return null;
      }
      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      return { cellId: s.cellId, lat: s.lat, lon: s.lon };
    },
    // Full: zones + adaptive
    full: (l, places, userSeed, reporter) => {
      for (const p of places) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= (p.bufferRadiusM || 1000)) return null;
      }
      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      if (!reporter.shouldReport(s.cellId)) return null;
      reporter.record(s.cellId);
      return { cellId: s.cellId, lat: s.lat, lon: s.lon };
    },
  };

  const results = {};

  for (const [methodName, applyMethod] of Object.entries(methods)) {
    const homeErrors = [];
    let exposed200 = 0, exposed500 = 0;

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const userSeed = SEED + '-' + user.userId;
      const places = buildPlaces(user.home, user.work);
      const reporter = new AdaptiveReporter(12, 2);

      // Collect cell visit counts during nighttime
      const nightCells = new Map(); // cellId → { count, lat, lon }

      for (const l of locs) {
        if (!(l.hour >= 22 || l.hour < 6)) continue;
        const result = applyMethod(l, places, userSeed, reporter);
        if (!result) continue;
        const existing = nightCells.get(result.cellId) || { count: 0, lat: result.lat, lon: result.lon };
        existing.count++;
        nightCells.set(result.cellId, existing);
      }

      // Attack: most-visited night cell = home estimate
      let bestCell = null, bestCount = 0;
      for (const [cellId, data] of nightCells) {
        if (data.count > bestCount) { bestCount = data.count; bestCell = data; }
      }

      if (bestCell) {
        const error = Math.round(haversine(bestCell.lat, bestCell.lon, user.home.lat, user.home.lon));
        homeErrors.push(error);
        if (error < 200) exposed200++;
        if (error < 500) exposed500++;
      } else {
        homeErrors.push(Infinity);
      }
    }

    homeErrors.sort((a, b) => a - b);
    const finite = homeErrors.filter(e => e < Infinity);
    const med = finite.length > 0 ? finite[Math.floor(finite.length * 0.5)] : null;

    results[methodName] = { median: med, exposed200, exposed500, usersWithData: finite.length };
    console.log(`${methodName.padEnd(20)} median=${med}m <200m=${exposed200} <500m=${exposed500} users=${finite.length}`);
  }

  // Also: commute corridor attack (most frequent transition pair)
  console.log('\n--- Commute Corridor ---');
  for (const user of usersMeta.slice(0, 5)) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const userSeed = SEED + '-' + user.userId;
    const places = buildPlaces(user.home, user.work);

    let prevCell = null;
    const transitions = new Map(); // "cellA→cellB" → count
    for (const l of locs) {
      let inZone = false;
      for (const p of places) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= (p.bufferRadiusM || 1000)) { inZone = true; break; }
      }
      if (inZone) { prevCell = null; continue; }

      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      if (prevCell && s.cellId !== prevCell) {
        const key = `${prevCell}->${s.cellId}`;
        transitions.set(key, (transitions.get(key) || 0) + 1);
      }
      prevCell = s.cellId;
    }

    const sorted = [...transitions.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`User ${user.userId}: ${transitions.size} unique transitions, top: ${sorted.slice(0, 3).map(([k, v]) => `${v}x`).join(', ')}`);
  }

  await writeFile(join(RESULTS_DIR, 'cell-transition-attack.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
