/**
 * Sharing Utility Evaluation
 *
 * Measures whether the privacy-protected location sharing actually
 * provides useful social information:
 *
 * 1. Proximity detection accuracy — can two users tell they're nearby?
 * 2. Departure detection latency — how fast does "left home" propagate?
 * 3. Task success rate — scenario-based social task completion
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
 * Process a location through the 6-layer defense.
 * Returns { type, lat?, lon?, cellId?, label? } or null if suppressed without state.
 */
function processLoc(l, places, userSeed, reporter) {
  let inCore = false, inBuffer = false;
  let coreLabel = null;
  for (const p of places) {
    const d = haversine(l.lat, l.lon, p.lat, p.lon);
    if (d <= p.radiusM) { inCore = true; coreLabel = 'at_place'; break; }
    if (d <= p.bufferRadiusM) { inBuffer = true; }
  }

  if (inCore) return { type: 'state', label: coreLabel };
  if (inBuffer) return { type: 'suppressed' };

  const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
  const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
  if (!reporter.shouldReport(s.cellId)) return { type: 'suppressed' };
  reporter.record(s.cellId);
  return { type: 'coarse', lat: s.lat, lon: s.lon, cellId: s.cellId };
}

// ============================================================
// 1. Proximity Detection Accuracy
// ============================================================
async function evalProximity(usersMeta) {
  console.log('\n=== Proximity Detection ===');

  // Pick user pairs that have overlapping timestamps
  const userTraces = new Map();
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    userTraces.set(user.userId, { locs, meta: user });
  }

  let tp = 0, fp = 0, fn = 0, tn = 0;
  let pairsChecked = 0;
  const NEARBY_THRESHOLD_TRUE = 2000; // ground truth: within 2km
  const NEARBY_THRESHOLD_SHARED = 3000; // inferred from shared: within 3km (wider due to noise)

  // Sample pairs (all unique pairs would be too many)
  const userIds = [...userTraces.keys()];
  const maxPairs = 200;
  let pairCount = 0;

  for (let i = 0; i < userIds.length && pairCount < maxPairs; i++) {
    for (let j = i + 1; j < userIds.length && pairCount < maxPairs; j++) {
      const uA = userTraces.get(userIds[i]);
      const uB = userTraces.get(userIds[j]);

      const placesA = buildPlaces(uA.meta.home, uA.meta.work);
      const placesB = buildPlaces(uB.meta.home, uB.meta.work);
      const seedA = SEED + '-' + userIds[i];
      const seedB = SEED + '-' + userIds[j];
      const repA = new AdaptiveReporter(12, 2);
      const repB = new AdaptiveReporter(12, 2);

      // Find matching hours (same day index + hour)
      const mapA = new Map();
      for (const l of uA.locs) mapA.set(`${l.day}:${l.hour}`, l);

      for (const lB of uB.locs) {
        const key = `${lB.day}:${lB.hour}`;
        const lA = mapA.get(key);
        if (!lA) continue;

        // Ground truth: are they actually nearby?
        const trueDist = haversine(lA.lat, lA.lon, lB.lat, lB.lon);
        const trueNearby = trueDist < NEARBY_THRESHOLD_TRUE;

        // Protected: what can they see?
        const sharedA = processLoc(lA, placesA, seedA, repA);
        const sharedB = processLoc(lB, placesB, seedB, repB);

        // Can they determine proximity?
        let inferNearby = false;
        if (sharedA.type === 'coarse' && sharedB.type === 'coarse') {
          const sharedDist = haversine(sharedA.lat, sharedA.lon, sharedB.lat, sharedB.lon);
          inferNearby = sharedDist < NEARBY_THRESHOLD_SHARED;
        }
        // If either is state-only or suppressed, proximity is unknown → count as negative

        if (trueNearby && inferNearby) tp++;
        else if (!trueNearby && inferNearby) fp++;
        else if (trueNearby && !inferNearby) fn++;
        else tn++;

        pairsChecked++;
      }
      pairCount++;
    }
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  console.log(`  Pairs checked: ${pairCount}, observations: ${pairsChecked}`);
  console.log(`  TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`  Precision=${precision.toFixed(3)} Recall=${recall.toFixed(3)} F1=${f1.toFixed(3)}`);

  return { pairsChecked: pairCount, observations: pairsChecked, tp, fp, fn, tn, precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3) };
}

// ============================================================
// 2. Departure Detection Latency
// ============================================================
async function evalDepartureLatency(usersMeta) {
  console.log('\n=== Departure Detection Latency ===');

  const latencies = [];

  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const home = user.home;
    const places = buildPlaces(home, user.work);
    const userSeed = SEED + '-' + user.userId;
    const reporter = new AdaptiveReporter(12, 2);

    let wasAtHome = false;
    let departureHour = null;

    for (const l of locs) {
      const distToHome = haversine(l.lat, l.lon, home.lat, home.lon);
      const atHome = distToHome < 200;
      const shared = processLoc(l, places, userSeed, reporter);

      if (wasAtHome && !atHome) {
        // True departure happened
        departureHour = l.day * 24 + l.hour;
      }

      if (departureHour !== null && shared.type === 'coarse') {
        // First coarse observation after departure = when friends know you left
        const detectedHour = l.day * 24 + l.hour;
        const latencyHours = detectedHour - departureHour;
        if (latencyHours >= 0 && latencyHours < 24) { // skip multi-day gaps
          latencies.push(latencyHours);
        }
        departureHour = null;
      }

      wasAtHome = atHome;
    }
  }

  latencies.sort((a, b) => a - b);
  const med = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.5)] : null;
  const p25 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.25)] : null;
  const p75 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.75)] : null;
  const p95 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : null;

  console.log(`  Departure events: ${latencies.length}`);
  console.log(`  Latency (hours): median=${med(latencies)} p25=${p25(latencies)} p75=${p75(latencies)} p95=${p95(latencies)}`);
  // Convert to "% detected within N hours"
  const within1h = latencies.filter(l => l <= 1).length;
  const within2h = latencies.filter(l => l <= 2).length;
  const within4h = latencies.filter(l => l <= 4).length;
  console.log(`  Within 1h: ${within1h}/${latencies.length} (${Math.round(within1h/latencies.length*100)}%)`);
  console.log(`  Within 2h: ${within2h}/${latencies.length} (${Math.round(within2h/latencies.length*100)}%)`);
  console.log(`  Within 4h: ${within4h}/${latencies.length} (${Math.round(within4h/latencies.length*100)}%)`);

  return {
    events: latencies.length,
    medianHours: med(latencies),
    p25Hours: p25(latencies),
    p75Hours: p75(latencies),
    p95Hours: p95(latencies),
    within1h: Math.round(within1h / latencies.length * 100),
    within2h: Math.round(within2h / latencies.length * 100),
    within4h: Math.round(within4h / latencies.length * 100),
  };
}

// ============================================================
// 3. Task Success Rate (scenario-based)
// ============================================================
async function evalTaskSuccess(usersMeta) {
  console.log('\n=== Task Success Rate ===');

  // Task 1: "Is my friend at home right now?" (nighttime query)
  // Task 2: "Is my friend at work?" (weekday daytime query)
  // Task 3: "Is my friend in my neighborhood?" (same 2km cell)

  let task1_correct = 0, task1_total = 0;
  let task2_correct = 0, task2_total = 0;
  let task3_correct = 0, task3_total = 0, task3_answerable = 0;

  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const home = user.home;
    const work = user.work;
    const places = buildPlaces(home, work);
    const userSeed = SEED + '-' + user.userId;
    const reporter = new AdaptiveReporter(12, 2);

    for (const l of locs) {
      const shared = processLoc(l, places, userSeed, reporter);
      const distHome = haversine(l.lat, l.lon, home.lat, home.lon);
      const distWork = work ? haversine(l.lat, l.lon, work.lat, work.lon) : Infinity;

      // Task 1: Is friend at home? (query during nighttime)
      if (l.hour >= 22 || l.hour < 6) {
        const trueAtHome = distHome < 200;
        let inferAtHome = false;
        if (shared.type === 'state') inferAtHome = true; // "at place" near home
        else if (shared.type === 'coarse') inferAtHome = haversine(shared.lat, shared.lon, home.lat, home.lon) < 300;
        // suppressed → we don't know → count as "no" (conservative)

        if (trueAtHome === inferAtHome) task1_correct++;
        task1_total++;
      }

      // Task 2: Is friend at work? (weekday daytime)
      if (!l.isWeekend && l.hour >= 9 && l.hour < 17 && work) {
        const trueAtWork = distWork < 200;
        let inferAtWork = false;
        if (shared.type === 'state') inferAtWork = true; // could be work zone
        else if (shared.type === 'coarse') inferAtWork = haversine(shared.lat, shared.lon, work.lat, work.lon) < 300;

        if (trueAtWork === inferAtWork) task2_correct++;
        task2_total++;
      }

      // Task 3: Is friend in my neighborhood? (viewer at a random location)
      // Simulate: viewer is at a fixed reference point, check if shared location matches true 2km cell
      if (shared.type === 'coarse') {
        task3_answerable++;
        const trueCell = `${Math.floor(l.lat / 0.02)},${Math.floor(l.lon / 0.02)}`;
        const sharedCell = `${Math.floor(shared.lat / 0.02)},${Math.floor(shared.lon / 0.02)}`;
        if (trueCell === sharedCell) task3_correct++;
        task3_total++;
      }
    }
  }

  console.log(`  Task 1 (at home?): ${task1_correct}/${task1_total} = ${(task1_correct/task1_total*100).toFixed(1)}%`);
  console.log(`  Task 2 (at work?): ${task2_correct}/${task2_total} = ${(task2_correct/task2_total*100).toFixed(1)}%`);
  console.log(`  Task 3 (same neighborhood?): ${task3_correct}/${task3_total} = ${(task3_correct/task3_total*100).toFixed(1)}% (answerable: ${task3_answerable})`);

  return {
    task1_atHome: { correct: task1_correct, total: task1_total, accuracy: +(task1_correct / task1_total * 100).toFixed(1) },
    task2_atWork: { correct: task2_correct, total: task2_total, accuracy: +(task2_correct / task2_total * 100).toFixed(1) },
    task3_neighborhood: { correct: task3_correct, total: task3_total, answerable: task3_answerable, accuracy: +(task3_correct / task3_total * 100).toFixed(1) },
  };
}

// ============================================================
// Main
// ============================================================
async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Sharing Utility Evaluation: ${usersMeta.length} users`);

  const proximity = await evalProximity(usersMeta);
  const departure = await evalDepartureLatency(usersMeta);
  const tasks = await evalTaskSuccess(usersMeta);

  const results = { proximity, departure, tasks };
  await writeFile(join(RESULTS_DIR, 'sharing-utility.json'), JSON.stringify(results, null, 2));
  console.log('\nResults saved.');
}

main().catch(console.error);
