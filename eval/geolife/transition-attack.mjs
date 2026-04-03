/**
 * Transition-Time Attack
 *
 * An attacker who sees only state transitions ("at home" → "not at home")
 * can infer home location from departure/arrival TIMES + first observed
 * coarse location after departure. This is a self-critical evaluation
 * of the state abstraction's limitations.
 *
 * Attack strategy:
 * 1. Observe when user transitions from "at home" to "coarse location"
 * 2. The first coarse observation after departure is likely near home
 * 3. Centroid of these first-after-departure observations
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

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Transition-time attack: ${usersMeta.length} users`);

  const transitionErrors = [];
  const firstAfterDepartureErrors = [];

  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const userSeed = SEED + '-' + user.userId;
    const home = user.home;

    const places = [
      { lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000 },
      ...(user.work ? [{ lat: user.work.lat, lon: user.work.lon, radiusM: 200, bufferRadiusM: 1000 }] : []),
    ];

    // Simulate the 6-layer defense and track state transitions
    const reporter = new AdaptiveReporter(12, 2);
    let prevState = 'unknown'; // 'home', 'outside', 'suppressed'
    const firstAfterDeparture = []; // first coarse obs after leaving home

    for (const l of locs) {
      let inCore = false, inBuffer = false;
      for (const p of places) {
        const d = haversine(l.lat, l.lon, p.lat, p.lon);
        if (d <= p.radiusM) { inCore = true; break; }
        if (d <= p.bufferRadiusM) { inBuffer = true; }
      }

      let state;
      if (inCore) {
        state = haversine(l.lat, l.lon, home.lat, home.lon) <= 200 ? 'home' : 'other_zone';
      } else if (inBuffer) {
        state = 'buffer'; // suppressed
      } else {
        const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
        const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
        if (!reporter.shouldReport(s.cellId)) {
          state = 'budget';
        } else {
          reporter.record(s.cellId);
          state = 'coarse';
          // Track first coarse observation after home departure
          if (prevState === 'home' || prevState === 'buffer') {
            firstAfterDeparture.push({ sLat: s.lat, sLon: s.lon });
          }
        }
      }
      prevState = state;
    }

    // Attack: centroid of first-after-departure observations
    const attack = centroidAttack(firstAfterDeparture, home.lat, home.lon);
    transitionErrors.push(attack.error);
    if (attack.count > 0) {
      firstAfterDepartureErrors.push(attack.error);
    }
  }

  transitionErrors.sort((a, b) => a - b);
  firstAfterDepartureErrors.sort((a, b) => a - b);
  const med = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.5)] : null;
  const p25 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.25)] : null;
  const p75 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.75)] : null;

  const finite = firstAfterDepartureErrors.filter(e => e < Infinity);
  const result = {
    usersWithTransitions: finite.length,
    totalUsers: usersMeta.length,
    medianError: med(finite),
    p25Error: p25(finite),
    p75Error: p75(finite),
    exposed200: finite.filter(e => e < 200).length,
    exposed500: finite.filter(e => e < 500).length,
  };

  console.log('\n=== Transition-Time Attack ===');
  console.log(`Users with departure transitions: ${result.usersWithTransitions}/${result.totalUsers}`);
  console.log(`Median home error: ${result.medianError}m`);
  console.log(`p25: ${result.p25Error}m, p75: ${result.p75Error}m`);
  console.log(`<200m: ${result.exposed200}, <500m: ${result.exposed500}`);

  await writeFile(join(RESULTS_DIR, 'transition-attack.json'), JSON.stringify(result, null, 2));
}

main().catch(console.error);
