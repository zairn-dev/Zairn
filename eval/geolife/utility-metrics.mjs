/**
 * Utility Metrics — Measure what users CAN do with each defense level
 *
 * Metrics:
 * 1. Presence accuracy: "Is my friend at home?" — correct state detection
 * 2. Proximity detection: "Is my friend nearby?" — can detect within 1km
 * 3. Area awareness: "Which neighborhood is my friend in?" — correct 2km cell
 * 4. Temporal availability: % of hours where ANY info is shared (not suppressed)
 *
 * For each metric, we compare ground truth (raw location) against what
 * each defense method reveals.
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

function buildSensitivePlaces(home, work) {
  const places = [{
    id: 'home', label: 'home', lat: home.lat, lon: home.lon,
    radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
    bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
    visitCount: 30, avgDwellMinutes: 480,
  }];
  if (work) {
    places.push({
      id: 'work', label: 'work', lat: work.lat, lon: work.lon,
      radiusM: DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM,
      bufferRadiusM: DEFAULT_PRIVACY_CONFIG.defaultBufferRadiusM,
      visitCount: 20, avgDwellMinutes: 480,
    });
  }
  return places;
}

/**
 * For each observation, compute what each defense method outputs:
 * - output coordinates (or null if suppressed)
 * - whether the user is classified as "at home" (state)
 */
function applyMethods(locs, home, work) {
  const userSeed = SEED + '-u' + Math.random().toString(36).slice(2, 8);
  const sensitivePlaces = buildSensitivePlaces(home, work);

  const reporters = {
    six_layer: new AdaptiveReporter(12, 2),
    zkls_full: new AdaptiveReporter(12, 2),
  };

  return locs.map(l => {
    const trueDistHome = haversine(l.lat, l.lon, home.lat, home.lon);
    const trueAtHome = trueDistHome < 200;
    const trueNearHome = trueDistHome < 1000;

    // Ground truth: 2km cell
    const trueCell2km = `${Math.floor(l.lat / 0.02)},${Math.floor(l.lon / 0.02)}`;

    // Check zone membership
    let inCore = false, inBuffer = false;
    for (const place of sensitivePlaces) {
      const dist = haversine(l.lat, l.lon, place.lat, place.lon);
      if (dist <= place.radiusM) { inCore = true; break; }
      if (dist <= (place.bufferRadiusM || 1000)) { inBuffer = true; }
    }

    const results = { hour: l.hour, day: l.day, trueAtHome, trueNearHome, trueCell2km };

    // 1. Raw
    results.raw = { lat: l.lat, lon: l.lon, suppressed: false };

    // 2. Laplace+Grid
    const noisy = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
    const snapped = gridSnap(noisy.lat, noisy.lon, GRID_SIZE_M, userSeed);
    results.laplace_grid = { lat: snapped.lat, lon: snapped.lon, suppressed: false };

    // 3. 6-Layer (simplified: zone check + adaptive)
    if (inCore || inBuffer) {
      results.six_layer = { lat: null, lon: null, suppressed: true, state: inCore ? 'at_place' : 'buffer' };
    } else {
      const n2 = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      const s2 = gridSnap(n2.lat, n2.lon, GRID_SIZE_M, userSeed);
      if (!reporters.six_layer.shouldReport(s2.cellId)) {
        results.six_layer = { lat: null, lon: null, suppressed: true, state: 'budget' };
      } else {
        reporters.six_layer.record(s2.cellId);
        results.six_layer = { lat: s2.lat, lon: s2.lon, suppressed: false };
      }
    }

    // 4. ZKLS Grid Only
    const gc = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    results.zkls_grid = { lat: gc.lat, lon: gc.lon, suppressed: false };

    // 5. ZKLS Grid+Zones (core = state-only "at place", buffer = suppressed)
    if (inCore) {
      results.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_place' };
    } else if (inBuffer) {
      results.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'buffer' };
    } else {
      const gc2 = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      results.zkls_grid_zones = { lat: gc2.lat, lon: gc2.lon, suppressed: false };
    }

    // 6. ZKLS Full
    if (inCore) {
      results.zkls_full = { lat: null, lon: null, suppressed: true, state: 'core' };
    } else {
      const gridM = inBuffer ? 2000 : GRID_SIZE_M;
      const gc3 = gridSnap(l.lat, l.lon, gridM, userSeed);
      if (!reporters.zkls_full.shouldReport(gc3.cellId)) {
        results.zkls_full = { lat: null, lon: null, suppressed: true, state: 'budget' };
      } else {
        reporters.zkls_full.record(gc3.cellId);
        results.zkls_full = { lat: gc3.lat, lon: gc3.lon, suppressed: false };
      }
    }

    return results;
  });
}

function computeUtility(observations, home) {
  const methods = ['raw', 'laplace_grid', 'six_layer', 'zkls_grid', 'zkls_grid_zones', 'zkls_full'];
  const utility = {};

  for (const m of methods) {
    let presenceTP = 0, presenceFP = 0, presenceFN = 0, presenceTN = 0;
    let proximityTP = 0, proximityFP = 0, proximityFN = 0, proximityTN = 0;
    let areaCorrect = 0, areaTotal = 0;
    let available = 0;

    for (const obs of observations) {
      const def = obs[m];

      // Temporal availability
      if (!def.suppressed) available++;

      // Presence: "at home" detection
      // For suppressed with state 'at_place' or 'core', infer at-home if it's a home zone
      const inferAtHome = def.suppressed
        ? (def.state === 'at_place' || def.state === 'core')
        : (haversine(def.lat, def.lon, home.lat, home.lon) < 300);

      if (obs.trueAtHome && inferAtHome) presenceTP++;
      else if (!obs.trueAtHome && inferAtHome) presenceFP++;
      else if (obs.trueAtHome && !inferAtHome) presenceFN++;
      else presenceTN++;

      // Proximity: "within 1km" detection (only if not suppressed)
      if (!def.suppressed) {
        const sharedDist = haversine(def.lat, def.lon, home.lat, home.lon);
        const inferNear = sharedDist < 1500; // use 1.5km threshold on shared coords
        if (obs.trueNearHome && inferNear) proximityTP++;
        else if (!obs.trueNearHome && inferNear) proximityFP++;
        else if (obs.trueNearHome && !inferNear) proximityFN++;
        else proximityTN++;
      }

      // Area awareness: correct 2km cell (only if not suppressed)
      if (!def.suppressed) {
        const sharedCell = `${Math.floor(def.lat / 0.02)},${Math.floor(def.lon / 0.02)}`;
        if (sharedCell === obs.trueCell2km) areaCorrect++;
        areaTotal++;
      }
    }

    const total = observations.length;
    const presPrec = (presenceTP + presenceFP) > 0 ? presenceTP / (presenceTP + presenceFP) : 0;
    const presRecall = (presenceTP + presenceFN) > 0 ? presenceTP / (presenceTP + presenceFN) : 0;
    const presF1 = (presPrec + presRecall) > 0 ? 2 * presPrec * presRecall / (presPrec + presRecall) : 0;

    utility[m] = {
      presencePrecision: Math.round(presPrec * 1000) / 1000,
      presenceRecall: Math.round(presRecall * 1000) / 1000,
      presenceF1: Math.round(presF1 * 1000) / 1000,
      areaAccuracy: areaTotal > 0 ? Math.round(areaCorrect / areaTotal * 1000) / 1000 : 0,
      temporalAvailability: Math.round(available / total * 1000) / 1000,
    };
  }

  return utility;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Loaded ${usersMeta.length} users`);

  const methods = ['raw', 'laplace_grid', 'six_layer', 'zkls_grid', 'zkls_grid_zones', 'zkls_full'];
  const allUtility = [];

  let done = 0;
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const observations = applyMethods(locs, user.home, user.work);
    const utility = computeUtility(observations, user.home);
    allUtility.push({ userId: user.userId, ...utility });
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
  }

  // Aggregate
  const summary = {};
  for (const m of methods) {
    const vals = (field) => allUtility.map(u => u[m][field]).sort((a, b) => a - b);
    const med = (arr) => arr[Math.floor(arr.length * 0.5)];
    const mean = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 1000) / 1000;

    summary[m] = {
      presenceF1: { median: med(vals('presenceF1')), mean: mean(vals('presenceF1')) },
      presencePrecision: { median: med(vals('presencePrecision')), mean: mean(vals('presencePrecision')) },
      presenceRecall: { median: med(vals('presenceRecall')), mean: mean(vals('presenceRecall')) },
      areaAccuracy: { median: med(vals('areaAccuracy')), mean: mean(vals('areaAccuracy')) },
      temporalAvailability: { median: med(vals('temporalAvailability')), mean: mean(vals('temporalAvailability')) },
    };
  }

  await writeFile(join(RESULTS_DIR, 'utility.json'), JSON.stringify({ summary, detail: allUtility }, null, 2));

  // Print table
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  UTILITY METRICS (' + usersMeta.length + ' users)');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log('Method              | Pres. F1 | Pres. Prec | Pres. Recall | Area Acc | Avail');
  console.log('─'.repeat(80));
  for (const m of methods) {
    const s = summary[m];
    console.log(
      m.padEnd(20) + '| ' +
      String(s.presenceF1.median).padStart(8) + ' | ' +
      String(s.presencePrecision.median).padStart(10) + ' | ' +
      String(s.presenceRecall.median).padStart(12) + ' | ' +
      String(s.areaAccuracy.median).padStart(8) + ' | ' +
      String(s.temporalAvailability.median).padStart(5)
    );
  }
}

main().catch(console.error);
