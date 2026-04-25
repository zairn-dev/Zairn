/**
 * Social Task Benchmark
 *
 * Re-frames the utility evaluation around four explicit social tasks
 * that a location-sharing app must serve. Unlike proxy metrics
 * (presence F1 etc.), each task has a precise success criterion and
 * explicit unanswerable handling.
 *
 * Task 1: "Is my friend at home right now?"
 *   Ground truth: user within 200m of home.
 *   Inference: state='at_place'|'core' -> yes; shared coords within 300m of home -> yes.
 *   Suppressed without state label counts as FAILURE (inclusive accuracy).
 *
 * Task 2: "Has my friend left home recently?"
 *   Ground truth: true home -> outside transition (consecutive hours
 *     where user crosses 200m boundary outbound).
 *   Success: first answerable observation within N hours of true departure
 *     that clearly indicates "not at home".
 *   Reported: fraction detected within 1h / 3h / 6h, median/p95 detection latency.
 *
 * Task 3: "Is my friend in my (2km) neighborhood?"
 *   Ground truth: the 2km grid cell (0.02 deg) containing the true location.
 *   Inference: shared coordinates' 2km cell.
 *     If suppressed with 'at_place'|'core', infer the home 2km cell.
 *     Otherwise unanswerable.
 *   Reported: inclusive cell accuracy (unanswerable = failure).
 *
 * Task 4: "Time to unanswerable (TTU) — how long can a query go unanswered?"
 *   For each user, compute gaps between consecutive ANSWERABLE observations
 *   (non-suppressed OR suppressed-with-state-label). An "unanswerable span"
 *   is the time during which no fresh answerable observation exists.
 *   Reported: median/p95/max unanswerable span (hours), fraction of user-time
 *     spent unanswerable.
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
const SEED = 'social-task-seed';
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

function cell2km(lat, lon) {
  return `${Math.floor(lat / 0.02)},${Math.floor(lon / 0.02)}`;
}

function buildSensitivePlaces(home, work) {
  const places = [{
    id: 'home', label: 'home', lat: home.lat, lon: home.lon,
    radiusM: 200, bufferRadiusM: 1000,
    visitCount: 30, avgDwellMinutes: 480,
  }];
  if (work) {
    places.push({
      id: 'work', label: 'work', lat: work.lat, lon: work.lon,
      radiusM: 200, bufferRadiusM: 1000,
      visitCount: 20, avgDwellMinutes: 480,
    });
  }
  return places;
}

/**
 * For each observation, compute what each defense method outputs.
 * Also precompute ground truth labels needed by the tasks.
 */
function applyMethods(locs, home, work, userId) {
  const userSeed = SEED + '-' + userId;
  const sensitivePlaces = buildSensitivePlaces(home, work);

  const reporters = {
    six_layer: new AdaptiveReporter(12, 2),
    zkls_full: new AdaptiveReporter(12, 2),
  };

  const homeCell2km = cell2km(home.lat, home.lon);

  return locs.map(l => {
    const trueDistHome = haversine(l.lat, l.lon, home.lat, home.lon);
    const trueAtHome = trueDistHome < 200;
    const trueCell2km = cell2km(l.lat, l.lon);

    let inCore = false, inBuffer = false;
    for (const place of sensitivePlaces) {
      const dist = haversine(l.lat, l.lon, place.lat, place.lon);
      if (dist <= place.radiusM) { inCore = true; break; }
      if (dist <= (place.bufferRadiusM || 1000)) { inBuffer = true; }
    }
    const inHomeCore = trueDistHome < 200;

    const results = {
      ts: new Date(l.timestamp).getTime(),
      hour: l.hour, day: l.day,
      trueAtHome, trueCell2km,
      homeCell2km,
    };

    // 1. Raw
    results.raw = { lat: l.lat, lon: l.lon, suppressed: false, state: null };

    // 2. Laplace+Grid
    const n1 = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
    const s1 = gridSnap(n1.lat, n1.lon, GRID_SIZE_M, userSeed);
    results.laplace_grid = { lat: s1.lat, lon: s1.lon, suppressed: false, state: null };

    // 3. ZKLS Grid Only
    const gc = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    results.zkls_grid = { lat: gc.lat, lon: gc.lon, suppressed: false, state: null };

    // 4. ZKLS Grid+Zones: core = state-only; buffer = suppressed (no state)
    if (inHomeCore) {
      results.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_home' };
    } else if (inCore) {
      results.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_place' };
    } else if (inBuffer) {
      results.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: null };
    } else {
      results.zkls_grid_zones = { lat: gc.lat, lon: gc.lon, suppressed: false, state: null };
    }

    // 5. 6-Layer (Laplace + grid + zones + adaptive)
    if (inHomeCore) {
      results.six_layer = { lat: null, lon: null, suppressed: true, state: 'at_home' };
    } else if (inCore || inBuffer) {
      results.six_layer = { lat: null, lon: null, suppressed: true, state: null };
    } else {
      const n2 = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      const s2 = gridSnap(n2.lat, n2.lon, GRID_SIZE_M, userSeed);
      if (!reporters.six_layer.shouldReport(s2.cellId)) {
        results.six_layer = { lat: null, lon: null, suppressed: true, state: null };
      } else {
        reporters.six_layer.record(s2.cellId);
        results.six_layer = { lat: s2.lat, lon: s2.lon, suppressed: false, state: null };
      }
    }

    // 6. ZKLS Full
    if (inHomeCore) {
      results.zkls_full = { lat: null, lon: null, suppressed: true, state: 'at_home' };
    } else if (inCore) {
      results.zkls_full = { lat: null, lon: null, suppressed: true, state: 'at_place' };
    } else {
      const gridM = inBuffer ? 2000 : GRID_SIZE_M;
      const gc3 = gridSnap(l.lat, l.lon, gridM, userSeed);
      if (!reporters.zkls_full.shouldReport(gc3.cellId)) {
        results.zkls_full = { lat: null, lon: null, suppressed: true, state: null };
      } else {
        reporters.zkls_full.record(gc3.cellId);
        results.zkls_full = { lat: gc3.lat, lon: gc3.lon, suppressed: false, state: null };
      }
    }

    return results;
  });
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid', 'zkls_grid_zones', 'six_layer', 'zkls_full'];

/** Task 1: "Is my friend at home right now?" — inclusive accuracy */
function task1_presence(obs, home) {
  const out = {};
  for (const m of METHODS) {
    let correct = 0, total = 0, unanswerable = 0;
    for (const o of obs) {
      const def = o[m];
      total++;
      // Answerable check
      const answerable = !def.suppressed || def.state !== null;
      if (!answerable) {
        unanswerable++;
        continue; // counts as failure
      }
      // Inference
      let inferAtHome;
      if (def.suppressed) {
        // State label present
        inferAtHome = (def.state === 'at_home' || def.state === 'core');
        // 'at_place' could be home or work — only positive if it's the home place
        if (def.state === 'at_place') inferAtHome = false; // conservative: don't assume
      } else {
        inferAtHome = haversine(def.lat, def.lon, home.lat, home.lon) < 300;
      }
      if (inferAtHome === o.trueAtHome) correct++;
    }
    out[m] = {
      accuracy: total > 0 ? correct / total : 0,
      unanswerable_rate: total > 0 ? unanswerable / total : 0,
      total,
    };
  }
  return out;
}

/** Task 2: "Has my friend left home recently?" — departure detection latency */
function task2_departure(obs, home) {
  // Find true departure events: consecutive observations where
  // obs[i-1].trueAtHome==true and obs[i].trueAtHome==false
  const departures = [];
  for (let i = 1; i < obs.length; i++) {
    if (obs[i - 1].trueAtHome && !obs[i].trueAtHome) {
      departures.push(i);
    }
  }

  const out = {};
  for (const m of METHODS) {
    const latencies = []; // hours until detection
    let detected1h = 0, detected3h = 0, detected6h = 0, undetected = 0;

    for (const depIdx of departures) {
      const depTs = obs[depIdx].ts;
      // Search forward for first observation where this method says "not at home"
      let detectedIdx = -1;
      for (let j = depIdx; j < obs.length; j++) {
        const def = obs[j][m];
        const answerable = !def.suppressed || def.state !== null;
        if (!answerable) continue;
        let inferAtHome;
        if (def.suppressed) {
          inferAtHome = (def.state === 'at_home' || def.state === 'core');
          if (def.state === 'at_place') inferAtHome = true; // conservative
        } else {
          inferAtHome = haversine(def.lat, def.lon, home.lat, home.lon) < 300;
        }
        if (!inferAtHome) { detectedIdx = j; break; }
      }
      if (detectedIdx === -1) {
        undetected++;
        continue;
      }
      const latencyH = (obs[detectedIdx].ts - depTs) / 3600000;
      latencies.push(latencyH);
      if (latencyH <= 1) detected1h++;
      if (latencyH <= 3) detected3h++;
      if (latencyH <= 6) detected6h++;
    }

    latencies.sort((a, b) => a - b);
    const median = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : null;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;

    out[m] = {
      departures: departures.length,
      detected_within_1h: departures.length > 0 ? detected1h / departures.length : 0,
      detected_within_3h: departures.length > 0 ? detected3h / departures.length : 0,
      detected_within_6h: departures.length > 0 ? detected6h / departures.length : 0,
      undetected_rate: departures.length > 0 ? undetected / departures.length : 0,
      median_latency_h: median,
      p95_latency_h: p95,
    };
  }
  return out;
}

/** Task 3: "Is my friend in my neighborhood (2km cell)?" — inclusive cell accuracy */
function task3_neighborhood(obs, home) {
  const out = {};
  for (const m of METHODS) {
    let correct = 0, total = 0, unanswerable = 0;
    for (const o of obs) {
      const def = o[m];
      total++;
      // Answerable: non-suppressed, or suppressed with 'at_home'/'core' (we know home cell)
      let sharedCell = null;
      if (!def.suppressed) {
        sharedCell = cell2km(def.lat, def.lon);
      } else if (def.state === 'at_home' || def.state === 'core') {
        sharedCell = o.homeCell2km;
      } else {
        unanswerable++;
        continue; // failure
      }
      if (sharedCell === o.trueCell2km) correct++;
    }
    out[m] = {
      accuracy: total > 0 ? correct / total : 0,
      unanswerable_rate: total > 0 ? unanswerable / total : 0,
      total,
    };
  }
  return out;
}

/** Task 4: "TTU — how long is the system socially unanswerable?" */
function task4_ttu(obs) {
  const out = {};
  for (const m of METHODS) {
    // Build a sequence of answerable timestamps; compute gaps
    const answerableTs = [];
    let unansHours = 0;
    for (const o of obs) {
      const def = o[m];
      const answerable = !def.suppressed || def.state !== null;
      if (answerable) answerableTs.push(o.ts);
      else unansHours++;
    }
    if (answerableTs.length < 2) {
      out[m] = { median_gap_h: null, p95_gap_h: null, max_gap_h: null, frac_unanswerable: unansHours / obs.length };
      continue;
    }
    const gaps = [];
    for (let i = 1; i < answerableTs.length; i++) {
      gaps.push((answerableTs[i] - answerableTs[i - 1]) / 3600000);
    }
    gaps.sort((a, b) => a - b);
    out[m] = {
      median_gap_h: gaps[Math.floor(gaps.length * 0.5)],
      p95_gap_h: gaps[Math.floor(gaps.length * 0.95)],
      max_gap_h: gaps[gaps.length - 1],
      frac_unanswerable: unansHours / obs.length,
    };
  }
  return out;
}

function aggregate(perUser, task, field) {
  const out = {};
  for (const m of METHODS) {
    const values = perUser.map(u => u[task][m][field]).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    values.sort((a, b) => a - b);
    if (values.length === 0) { out[m] = null; continue; }
    out[m] = {
      median: values[Math.floor(values.length * 0.5)],
      p25: values[Math.floor(values.length * 0.25)],
      p75: values[Math.floor(values.length * 0.75)],
      mean: values.reduce((s, v) => s + v, 0) / values.length,
      n: values.length,
    };
  }
  return out;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Social task benchmark: ${usersMeta.length} users`);

  const perUser = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const obs = applyMethods(locs, user.home, user.work, user.userId);
    perUser.push({
      userId: user.userId,
      task1: task1_presence(obs, user.home),
      task2: task2_departure(obs, user.home),
      task3: task3_neighborhood(obs, user.home),
      task4: task4_ttu(obs),
    });
  }

  // Aggregate across users
  const agg = {
    task1_presence: {
      accuracy: aggregate(perUser, 'task1', 'accuracy'),
      unanswerable_rate: aggregate(perUser, 'task1', 'unanswerable_rate'),
    },
    task2_departure: {
      detected_within_1h: aggregate(perUser, 'task2', 'detected_within_1h'),
      detected_within_3h: aggregate(perUser, 'task2', 'detected_within_3h'),
      detected_within_6h: aggregate(perUser, 'task2', 'detected_within_6h'),
      median_latency_h: aggregate(perUser, 'task2', 'median_latency_h'),
      p95_latency_h: aggregate(perUser, 'task2', 'p95_latency_h'),
      undetected_rate: aggregate(perUser, 'task2', 'undetected_rate'),
    },
    task3_neighborhood: {
      accuracy: aggregate(perUser, 'task3', 'accuracy'),
      unanswerable_rate: aggregate(perUser, 'task3', 'unanswerable_rate'),
    },
    task4_ttu: {
      median_gap_h: aggregate(perUser, 'task4', 'median_gap_h'),
      p95_gap_h: aggregate(perUser, 'task4', 'p95_gap_h'),
      max_gap_h: aggregate(perUser, 'task4', 'max_gap_h'),
      frac_unanswerable: aggregate(perUser, 'task4', 'frac_unanswerable'),
    },
  };

  // Print summary
  console.log('\n=== Task 1: "Is my friend at home?" (inclusive accuracy) ===');
  console.log('Method              Accuracy(med)  Unanswerable(med)');
  for (const m of METHODS) {
    const a = agg.task1_presence.accuracy[m];
    const u = agg.task1_presence.unanswerable_rate[m];
    console.log(`  ${m.padEnd(18)} ${(a.median * 100).toFixed(1).padStart(5)}%       ${(u.median * 100).toFixed(1).padStart(5)}%`);
  }

  console.log('\n=== Task 2: "Departure detected within N hours" (fraction) ===');
  console.log('Method              <=1h    <=3h    <=6h    Median(h)  p95(h)  Undetected');
  for (const m of METHODS) {
    const d1 = agg.task2_departure.detected_within_1h[m];
    const d3 = agg.task2_departure.detected_within_3h[m];
    const d6 = agg.task2_departure.detected_within_6h[m];
    const ml = agg.task2_departure.median_latency_h[m];
    const p95 = agg.task2_departure.p95_latency_h[m];
    const un = agg.task2_departure.undetected_rate[m];
    console.log(`  ${m.padEnd(18)} ${(d1.median * 100).toFixed(0).padStart(3)}%   ${(d3.median * 100).toFixed(0).padStart(3)}%   ${(d6.median * 100).toFixed(0).padStart(3)}%   ${(ml ? ml.median : 0).toFixed(1).padStart(6)}    ${(p95 ? p95.median : 0).toFixed(1).padStart(5)}   ${(un.median * 100).toFixed(0).padStart(3)}%`);
  }

  console.log('\n=== Task 3: "Is my friend in my 2km neighborhood?" (inclusive accuracy) ===');
  console.log('Method              Accuracy(med)  Unanswerable(med)');
  for (const m of METHODS) {
    const a = agg.task3_neighborhood.accuracy[m];
    const u = agg.task3_neighborhood.unanswerable_rate[m];
    console.log(`  ${m.padEnd(18)} ${(a.median * 100).toFixed(1).padStart(5)}%       ${(u.median * 100).toFixed(1).padStart(5)}%`);
  }

  console.log('\n=== Task 4: TTU "Time to unanswerable" (hours between answerable obs) ===');
  console.log('Method              Median(h)  p95(h)   Max(h)   Unans(med%)');
  for (const m of METHODS) {
    const med = agg.task4_ttu.median_gap_h[m];
    const p95 = agg.task4_ttu.p95_gap_h[m];
    const mx = agg.task4_ttu.max_gap_h[m];
    const fu = agg.task4_ttu.frac_unanswerable[m];
    console.log(`  ${m.padEnd(18)} ${(med ? med.median : 0).toFixed(1).padStart(6)}    ${(p95 ? p95.median : 0).toFixed(1).padStart(5)}   ${(mx ? mx.median : 0).toFixed(0).padStart(5)}    ${(fu.median * 100).toFixed(1).padStart(5)}%`);
  }

  await writeFile(join(RESULTS_DIR, 'social-tasks.json'), JSON.stringify({ perUser, agg }, null, 2));
  console.log('\nSaved to results/social-tasks.json');
}

main().catch(e => { console.error(e); process.exit(1); });
