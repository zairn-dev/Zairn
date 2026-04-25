/**
 * State-sequence leakage evaluation
 *
 * Even when coordinates are fully suppressed, the *sequence* of
 * at-home / outside / suppressed state labels leaks information
 * about a user's temporal presence pattern.  This script measures
 * three state-level leakage metrics that do NOT depend on
 * coordinates, to show that zone suppression's privacy guarantee
 * is against coordinate-recovery class attacks only.
 *
 * Metrics (per user, under each defense):
 *   1. HTF (home-time fraction): fraction of nighttime hours
 *      (22:00-06:00) where the emitted state is "at-home".  Leaks
 *      sleep schedule / regularity of home presence.
 *   2. LAS (longest-away-streak, hours): longest continuous span
 *      during which no "at-home" state is emitted.  Proxy for
 *      vacation / long-absence detection.
 *   3. NAF (nightly-absence fraction): fraction of nights with
 *      zero "at-home" emission during 22:00-06:00.  Proxy for
 *      "nights away from home" inference.
 *
 * For each user and defense, we compute (metric_defense - metric_raw)
 * so the delta captures how much the defense hides the signal
 * relative to perfect-observation raw data.  Smaller |delta|
 * means the defense leaks more of the pattern.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  processLocation,
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
  const places = [{
    id: 'home', label: 'home', lat: home.lat, lon: home.lon,
    radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480,
  }];
  if (work) places.push({
    id: 'work', label: 'work', lat: work.lat, lon: work.lon,
    radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480,
  });
  return places;
}

/**
 * For each observation, return a coarse state label:
 *   'home'       — emitted "at home" state (coordinates suppressed or within core zone)
 *   'outside'    — coordinates (or grid cell) emitted, clearly not inside home zone
 *   'suppressed' — no emission at all
 *   'home-proxy' — Raw / Laplace+Grid / ZKLS Grid: emitted coords are within 200m of true home
 *                  (treated as "home" by an observer who knows the home location)
 */
function labelSequence(locs, home, work, userId, cfg) {
  const userSeed = SEED + '-' + userId;
  const out = [];
  const isNearHome = (lat, lon) => haversine(lat, lon, home.lat, home.lon) <= 200;

  if (cfg === 'raw') {
    for (const l of locs) {
      out.push({ hour: l.hour, h: l.h, state: isNearHome(l.lat, l.lon) ? 'home-proxy' : 'outside' });
    }
    return out;
  }

  if (cfg === 'laplace_grid') {
    for (const l of locs) {
      const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
      out.push({ hour: l.hour, h: l.h,
        state: isNearHome(s.lat, s.lon) ? 'home-proxy' : 'outside' });
    }
    return out;
  }

  const places = buildPlaces(home, work);

  if (cfg === 'zkls_grid_zones') {
    for (const l of locs) {
      let insideBuffer = null;
      for (const p of places) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= p.bufferRadiusM) { insideBuffer = p; break; }
      }
      if (insideBuffer && haversine(l.lat, l.lon, insideBuffer.lat, insideBuffer.lon) <= insideBuffer.radiusM) {
        out.push({ hour: l.hour, h: l.h, state: insideBuffer.label === 'home' ? 'home' : 'outside' });
      } else if (insideBuffer) {
        out.push({ hour: l.hour, h: l.h, state: 'suppressed' });
      } else {
        out.push({ hour: l.hour, h: l.h, state: 'outside' });
      }
    }
    return out;
  }

  if (cfg === '6layer') {
    const config = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
    const reporter = new AdaptiveReporter(12, 2);
    for (const l of locs) {
      const r = processLocation(l.lat, l.lon, places, config, reporter);
      if (r.type === 'state') {
        out.push({ hour: l.hour, h: l.h, state: r.label === 'home' ? 'home' : 'outside' });
      } else if (r.type === 'coarse') {
        out.push({ hour: l.hour, h: l.h, state: 'outside' });
      } else {
        out.push({ hour: l.hour, h: l.h, state: 'suppressed' });
      }
    }
    return out;
  }
  throw new Error('bad cfg ' + cfg);
}

const isNight = h => h >= 22 || h < 6;
const isHomeState = s => s === 'home' || s === 'home-proxy';

/** Home-time fraction on nighttime observations (excluding suppressed) */
function homeTimeFraction(seq) {
  const night = seq.filter(o => isNight(o.hour) && o.state !== 'suppressed');
  if (night.length === 0) return null;
  const home = night.filter(o => isHomeState(o.state)).length;
  return home / night.length;
}

/** Longest continuous span (hours) with no at-home emission.
 *  seq is assumed sorted by h (absolute hour). */
function longestAwayStreak(seq) {
  if (seq.length === 0) return 0;
  const byH = [...seq].sort((a, b) => a.h - b.h);
  let longest = 0;
  let startH = null;
  for (const o of byH) {
    if (isHomeState(o.state)) {
      if (startH !== null) {
        const span = o.h - startH;
        if (span > longest) longest = span;
      }
      startH = o.h;
    }
  }
  // open tail: from last home emission to end
  if (startH !== null && byH.length > 0) {
    const span = byH[byH.length - 1].h - startH;
    if (span > longest) longest = span;
  }
  return longest;
}

/** Fraction of nights (grouped by day-of-observation-year) with zero at-home emissions. */
function nightlyAbsenceFraction(seq) {
  const nights = new Map(); // dayKey -> { anyHome: bool, any: bool }
  for (const o of seq) {
    if (!isNight(o.hour) || o.state === 'suppressed') continue;
    // Day key: (h-6)/24 coarse bucketing so 22-06 night groups under one "day"
    const dayKey = Math.floor((o.h + 2) / 24);
    const cur = nights.get(dayKey) || { anyHome: false, any: false };
    cur.any = true;
    if (isHomeState(o.state)) cur.anyHome = true;
    nights.set(dayKey, cur);
  }
  const counted = [...nights.values()].filter(n => n.any);
  if (counted.length === 0) return null;
  const absent = counted.filter(n => !n.anyHome).length;
  return absent / counted.length;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`State-sequence leakage: ${usersMeta.length} users`);

  const configs = ['raw', 'laplace_grid', 'zkls_grid_zones', '6layer'];
  const per = {};
  for (const c of configs) per[c] = [];

  let done = 0;
  for (const user of usersMeta) {
    const locsRaw = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    // Make sure observations have an absolute hour index (h) for streak calc
    const locs = locsRaw.map((l, i) => ({ ...l, h: l.h ?? i }));

    for (const c of configs) {
      const seq = labelSequence(locs, user.home, user.work, user.userId, c);
      per[c].push({
        userId: user.userId,
        HTF: homeTimeFraction(seq),
        LAS: longestAwayStreak(seq),
        NAF: nightlyAbsenceFraction(seq),
      });
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
  }

  const median = arr => {
    const xs = arr.filter(x => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length * 0.5)] : null;
  };
  const mae = (a, b) => {
    const xs = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== null && b[i] !== null && Number.isFinite(a[i]) && Number.isFinite(b[i])) xs.push(Math.abs(a[i] - b[i]));
    }
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };

  const summary = {};
  const rawHTF = per.raw.map(r => r.HTF);
  const rawLAS = per.raw.map(r => r.LAS);
  const rawNAF = per.raw.map(r => r.NAF);
  for (const c of configs) {
    const htf = per[c].map(r => r.HTF);
    const las = per[c].map(r => r.LAS);
    const naf = per[c].map(r => r.NAF);
    summary[c] = {
      medianHTF: median(htf),
      medianLAS: median(las),
      medianNAF: median(naf),
      MAE_HTF: c === 'raw' ? 0 : mae(htf, rawHTF),
      MAE_LAS: c === 'raw' ? 0 : mae(las, rawLAS),
      MAE_NAF: c === 'raw' ? 0 : mae(naf, rawNAF),
    };
  }

  await writeFile(join(RESULTS_DIR, 'state-sequence-leakage.json'),
    JSON.stringify({ summary, perUser: per }, null, 2));

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STATE-SEQUENCE LEAKAGE (n=' + usersMeta.length + ')');
  console.log('  MAE vs raw: smaller = the defense reveals more of the raw pattern');
  console.log('══════════════════════════════════════════════════════════════════\n');
  console.log('Config           | med HTF  | med LAS | med NAF | MAE(HTF) | MAE(LAS,h) | MAE(NAF)');
  console.log('─'.repeat(95));
  for (const c of configs) {
    const s = summary[c];
    const fmt = (v, d=2) => v === null ? '  ---' : v.toFixed(d);
    console.log(
      c.padEnd(16) + '| ' +
      fmt(s.medianHTF, 3).padStart(8) + ' | ' +
      fmt(s.medianLAS, 0).padStart(7) + ' | ' +
      fmt(s.medianNAF, 3).padStart(7) + ' | ' +
      fmt(s.MAE_HTF, 3).padStart(8) + ' | ' +
      fmt(s.MAE_LAS, 1).padStart(10) + ' | ' +
      fmt(s.MAE_NAF, 3).padStart(8)
    );
  }
}

main().catch(console.error);
