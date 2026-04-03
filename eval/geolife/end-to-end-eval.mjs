/**
 * End-to-End Evaluation (Non-Oracle)
 *
 * Uses detectSensitivePlaces() output instead of ground-truth home/work.
 * Shows what happens when the system runs without manual registration.
 *
 * Two conditions:
 * 1. "detected": uses only auto-detected places (no manual input)
 * 2. "detected+manual": detected places + manual home registration fallback
 *    (models: user manually sets home if auto-detection fails)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  detectSensitivePlaces,
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

function runDefense(locs, sensitivePlaces, userId) {
  const userSeed = SEED + '-' + userId;
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

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`End-to-end evaluation: ${usersMeta.length} users\n`);

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const conditions = ['oracle', 'detected', 'detected+manual'];
  const results = {};

  for (const cond of conditions) {
    const homeErrors = [];
    let exposed200 = 0, exposed500 = 0;
    let placesDetected = 0;

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
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
        // Auto-detect
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
          // If no home detected, manually add ground-truth home (user registers it)
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

      const obs = runDefense(locs, sensitivePlaces, user.userId);
      const nightObs = obs.filter(nightFilter);
      const attack = centroidAttack(nightObs, user.home.lat, user.home.lon);
      homeErrors.push(attack.error);
      if (attack.error < 200) exposed200++;
      if (attack.error < 500) exposed500++;
    }

    homeErrors.sort((a, b) => a - b);
    const finite = homeErrors.filter(e => e < Infinity);
    const med = finite.length > 0 ? finite[Math.floor(finite.length * 0.5)] : null;

    results[cond] = {
      medianError: med,
      exposed200,
      exposed500,
      avgPlaces: cond !== 'oracle' ? (placesDetected / usersMeta.length).toFixed(1) : 'N/A',
    };

    console.log(`${cond.padEnd(20)} median=${med}m <200m=${exposed200} <500m=${exposed500} avgPlaces=${results[cond].avgPlaces}`);
  }

  await writeFile(join(RESULTS_DIR, 'end-to-end.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
