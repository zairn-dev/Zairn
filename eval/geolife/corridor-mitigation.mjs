/**
 * Corridor-hardened ZKLS Grid+Zones evaluation
 *
 * The route-corridor-attack.mjs shows \zkls{} Grid+Zones leaks 33%
 * of the true commute corridor on GeoLife and 50% on T-Drive.  This
 * script evaluates two deployable mitigations that a corridor-sensitive
 * user could opt into:
 *
 *  1. Commute-hour buffer expansion (CBE): during 07:00-09:00 and
 *     17:00-19:00, widen the buffer around home AND work from 1000m
 *     to 2500m so the corridor entrance/exit is hidden further back.
 *
 *  2. Commute-hour cadence throttle (CCT): during commute hours,
 *     report at most one observation per cell per hour.  This directly
 *     disrupts frequency-based corridor reconstruction.
 *
 *  3. Combined (CBE+CCT): both mitigations together.
 *
 * We compare all three variants against the baseline ZKLS Grid+Zones
 * on (a) corridor precision/recall/F1 and (b) social task T1 at-home
 * accuracy (to ensure usability isn't destroyed).
 *
 * Output: results/corridor-mitigation.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  gridSnap,
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

const isCommuteHour = h => (h >= 7 && h <= 9) || (h >= 17 && h <= 19);

function emit(locs, places, userId, { bufferBoostCommute = false, cadenceThrottleCommute = false }) {
  const userSeed = SEED + '-' + userId;
  const out = [];
  const lastReport = new Map(); // cellId -> last hour reported

  for (const l of locs) {
    const inCommuteWin = isCommuteHour(l.hour);
    const bufferFactor = (bufferBoostCommute && inCommuteWin) ? 2.5 : 1.0;

    let inBuffer = false;
    for (const p of places) {
      const buf = (p.bufferRadiusM || 1000) * bufferFactor;
      if (haversine(l.lat, l.lon, p.lat, p.lon) <= buf) { inBuffer = true; break; }
    }
    if (inBuffer) continue;

    const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);

    if (cadenceThrottleCommute && inCommuteWin) {
      const key = s.cellId;
      const last = lastReport.get(key);
      if (last !== undefined && l.hour === last) continue;
      lastReport.set(key, l.hour);
    }

    out.push({ lat: s.lat, lon: s.lon, cellId: s.cellId, hour: l.hour });
  }

  return out;
}

function buildPlaces(home, work) {
  const places = [{ lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000 }];
  if (work) places.push({ lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000 });
  return places;
}

function groundTruthCorridor(locs, home, work) {
  // Commute-hour 500m cells that are not home or work cells.
  const cellSizeDeg = 500 / 111000;
  const cellOf = (lat, lon) => `${Math.floor(lat / cellSizeDeg)},${Math.floor(lon / cellSizeDeg)}`;
  const counts = new Map();
  const homeCell = cellOf(home.lat, home.lon);
  const workCell = work ? cellOf(work.lat, work.lon) : null;
  for (const l of locs) {
    if (!isCommuteHour(l.hour)) continue;
    const c = cellOf(l.lat, l.lon);
    if (c === homeCell || c === workCell) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const corridor = new Set();
  for (const [c, n] of counts) if (n >= 2) corridor.add(c);
  return corridor;
}

function attackerCorridor(obs, homeEstLat, homeEstLon, workEstLat, workEstLon) {
  // Attacker filters to commute-hour shared cells minus best guesses
  // for home and work (we pass in the user's real home/work as a
  // conservative "perfect detector" for the attacker).
  const cellSizeDeg = 500 / 111000;
  const cellOf = (lat, lon) => `${Math.floor(lat / cellSizeDeg)},${Math.floor(lon / cellSizeDeg)}`;
  const homeCell = cellOf(homeEstLat, homeEstLon);
  const workCell = workEstLat !== null ? cellOf(workEstLat, workEstLon) : null;
  const counts = new Map();
  for (const o of obs) {
    if (!isCommuteHour(o.hour)) continue;
    const c = cellOf(o.lat, o.lon);
    if (c === homeCell || c === workCell) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const pred = new Set();
  for (const [c, n] of counts) if (n >= 2) pred.add(c);
  return pred;
}

function prF1(pred, truth) {
  if (truth.size === 0) return null; // no corridor to evaluate
  let tp = 0;
  for (const p of pred) if (truth.has(p)) tp++;
  const precision = pred.size === 0 ? 0 : tp / pred.size;
  const recall = truth.size === 0 ? 0 : tp / truth.size;
  const f1 = (precision + recall) === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { precision, recall, f1, predSize: pred.size, truthSize: truth.size };
}

function atHomeT1(locs, obs, home) {
  // Inclusive T1: every hour, compute ground truth (within 200m of home)
  // and defense answer (if the emitted cell center falls within 200m of
  // home).  Suppressed-without-state counts as failure.
  // obs have hour and coord; ground truth uses locs.
  const emitByHour = new Map();
  for (const o of obs) emitByHour.set(o.hour, o);
  let correct = 0, total = 0;
  // Group locs by hour
  const locsByHour = new Map();
  for (const l of locs) {
    if (!locsByHour.has(l.hour)) locsByHour.set(l.hour, []);
    locsByHour.get(l.hour).push(l);
  }
  for (const [h, hrLocs] of locsByHour) {
    // ground truth: user is at home this hour if any loc is within 200m
    const truth = hrLocs.some(l => haversine(l.lat, l.lon, home.lat, home.lon) <= 200);
    const emit = emitByHour.get(h);
    let defenseSaysAtHome;
    if (!emit) defenseSaysAtHome = false; // suppressed without state = "no"
    else defenseSaysAtHome = haversine(emit.lat, emit.lon, home.lat, home.lon) <= 200;
    total++;
    if (defenseSaysAtHome === truth) correct++;
  }
  return total > 0 ? correct / total : null;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const configs = [
    { name: 'baseline',  bufferBoostCommute: false, cadenceThrottleCommute: false },
    { name: 'CBE',       bufferBoostCommute: true,  cadenceThrottleCommute: false },
    { name: 'CCT',       bufferBoostCommute: false, cadenceThrottleCommute: true  },
    { name: 'CBE+CCT',   bufferBoostCommute: true,  cadenceThrottleCommute: true  },
  ];

  const rows = {};
  for (const c of configs) rows[c.name] = [];

  let done = 0;
  let corridorUsers = 0;
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const places = buildPlaces(user.home, user.work);
    const truth = groundTruthCorridor(locs, user.home, user.work);
    if (truth.size === 0) { done++; continue; }
    corridorUsers++;
    for (const c of configs) {
      const obs = emit(locs, places, user.userId, c);
      const pred = attackerCorridor(obs,
        user.home.lat, user.home.lon,
        user.work ? user.work.lat : null,
        user.work ? user.work.lon : null);
      const pr = prF1(pred, truth);
      const t1 = atHomeT1(locs, obs, user.home);
      rows[c.name].push({ userId: user.userId, ...pr, t1 });
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
  }
  console.log(`\ncorridor-evaluable users: ${corridorUsers}/${usersMeta.length}`);

  const median = arr => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : null;
  const summary = {};
  for (const c of configs) {
    const R = rows[c.name];
    summary[c.name] = {
      precMed: median(R.map(r => r.precision)),
      recallMed: median(R.map(r => r.recall)),
      f1Med: median(R.map(r => r.f1)),
      predSizeMed: median(R.map(r => r.predSize)),
      truthSizeMed: median(R.map(r => r.truthSize)),
      t1Med: median(R.filter(r => r.t1 !== null).map(r => r.t1)),
      n: R.length,
    };
  }

  await writeFile(join(RESULTS_DIR, 'corridor-mitigation.json'),
    JSON.stringify({ summary, corridorUsers, totalUsers: usersMeta.length }, null, 2));

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  CORRIDOR MITIGATION ({} corridor-evaluable users)'.replace('{}', corridorUsers));
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Config    | Recall | Precis | F1   | |Pred| | T1 acc');
  console.log('─'.repeat(70));
  for (const c of configs) {
    const s = summary[c.name];
    const pct = v => v === null ? ' ---' : `${Math.round(v*100)}%`;
    console.log(
      c.name.padEnd(10) + '| ' +
      pct(s.recallMed).padStart(6) + ' | ' +
      pct(s.precMed).padStart(6) + ' | ' +
      pct(s.f1Med).padStart(4) + ' | ' +
      String(s.predSizeMed).padStart(6) + ' | ' +
      pct(s.t1Med)
    );
  }
}

main().catch(console.error);
