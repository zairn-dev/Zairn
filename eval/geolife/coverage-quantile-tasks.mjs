/**
 * Coverage quantile × Social Task Benchmark
 *
 * Bridges the cadence sweep (single dense user) with the GeoLife
 * 78-user evaluation by partitioning users into coverage quartiles
 * and reporting T1-T4 + home/work detection success per quartile.
 *
 * Goal: identify the coverage threshold below which 6-Layer becomes
 * unusable, and confirm that ZKLS Grid+Zones is robust across the
 * full coverage spectrum.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
  detectSensitivePlaces,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'cov-quantile-seed';
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

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

function applyMethods(locs, home, work, userId) {
  const userSeed = SEED + '-' + userId;
  const places = [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480 },
    ...(work ? [{ id: 'work', label: 'work', lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480 }] : []),
  ];
  const reporter6 = new AdaptiveReporter(12, 2);
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
  const homeCell = cell2km(home.lat, home.lon);

  return locs.map(l => {
    const trueDistHome = haversine(l.lat, l.lon, home.lat, home.lon);
    const trueAtHome = trueDistHome < 200;
    const trueCell = cell2km(l.lat, l.lon);

    let inCore = false, inBuffer = false;
    for (const place of places) {
      const d = haversine(l.lat, l.lon, place.lat, place.lon);
      if (d <= place.radiusM) { inCore = true; break; }
      if (d <= place.bufferRadiusM) { inBuffer = true; }
    }
    const inHomeCore = trueDistHome < 200;

    const o = {
      ts: new Date(l.timestamp).getTime(),
      hour: l.hour, day: l.day,
      trueAtHome, trueCell, homeCell,
    };

    o.raw = { lat: l.lat, lon: l.lon, suppressed: false, state: null };

    const n1 = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
    const s1 = gridSnap(n1.lat, n1.lon, GRID_SIZE_M, userSeed);
    o.laplace_grid = { lat: s1.lat, lon: s1.lon, suppressed: false, state: null };

    if (inHomeCore) o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_home' };
    else if (inCore) o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_place' };
    else if (inBuffer) o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: null };
    else {
      const gc = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      o.zkls_grid_zones = { lat: gc.lat, lon: gc.lon, suppressed: false, state: null };
    }

    const r = processLocation(l.lat, l.lon, places, config6, reporter6);
    if (r.type === 'state') o.six_layer = { lat: null, lon: null, suppressed: true, state: inHomeCore ? 'at_home' : 'at_place' };
    else if (r.type === 'coarse') o.six_layer = { lat: r.lat, lon: r.lon, suppressed: false, state: null };
    else o.six_layer = { lat: null, lon: null, suppressed: true, state: null };

    return o;
  });
}

function task1(obs, home) {
  const out = {};
  for (const m of METHODS) {
    let correct = 0, total = 0, unans = 0;
    for (const o of obs) {
      total++;
      const d = o[m];
      const ans = !d.suppressed || d.state !== null;
      if (!ans) { unans++; continue; }
      let infer;
      if (d.suppressed) infer = (d.state === 'at_home');
      else infer = haversine(d.lat, d.lon, home.lat, home.lon) < 300;
      if (infer === o.trueAtHome) correct++;
    }
    out[m] = { acc: total > 0 ? correct / total : 0, unans: total > 0 ? unans / total : 0 };
  }
  return out;
}

function task2(obs, home) {
  const departures = [];
  for (let i = 1; i < obs.length; i++) {
    if (obs[i - 1].trueAtHome && !obs[i].trueAtHome) departures.push(i);
  }
  const out = {};
  for (const m of METHODS) {
    let det1h = 0, undet = 0;
    for (const di of departures) {
      const dts = obs[di].ts;
      let detIdx = -1;
      for (let j = di; j < obs.length; j++) {
        const d = obs[j][m];
        const ans = !d.suppressed || d.state !== null;
        if (!ans) continue;
        let infer;
        if (d.suppressed) infer = (d.state === 'at_home');
        else infer = haversine(d.lat, d.lon, home.lat, home.lon) < 300;
        if (!infer) { detIdx = j; break; }
      }
      if (detIdx === -1) { undet++; continue; }
      const lh = (obs[detIdx].ts - dts) / 3600000;
      if (lh <= 1) det1h++;
    }
    out[m] = {
      n: departures.length,
      det1h: departures.length > 0 ? det1h / departures.length : 0,
      undet: departures.length > 0 ? undet / departures.length : 0,
    };
  }
  return out;
}

function task3(obs) {
  const out = {};
  for (const m of METHODS) {
    let correct = 0, total = 0, unans = 0;
    for (const o of obs) {
      total++;
      const d = o[m];
      let cell = null;
      if (!d.suppressed) cell = cell2km(d.lat, d.lon);
      else if (d.state === 'at_home') cell = o.homeCell;
      else { unans++; continue; }
      if (cell === o.trueCell) correct++;
    }
    out[m] = { acc: correct / total, unans: unans / total };
  }
  return out;
}

function task4(obs) {
  const out = {};
  for (const m of METHODS) {
    const ans = [];
    let unH = 0;
    for (const o of obs) {
      const d = o[m];
      if (!d.suppressed || d.state !== null) ans.push(o.ts);
      else unH++;
    }
    if (ans.length < 2) { out[m] = { p95_h: null }; continue; }
    const gaps = [];
    for (let i = 1; i < ans.length; i++) gaps.push((ans[i] - ans[i - 1]) / 3600000);
    gaps.sort((a, b) => a - b);
    out[m] = { p95_h: gaps[Math.floor(gaps.length * 0.95)] };
  }
  return out;
}

function aggMedian(values) {
  const f = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  if (f.length === 0) return null;
  f.sort((a, b) => a - b);
  return f[Math.floor(f.length * 0.5)];
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const perUser = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const obs = applyMethods(locs, user.home, user.work, user.userId);
    perUser.push({
      userId: user.userId,
      coverage: user.coverage,
      hasWork: !!user.work,
      task1: task1(obs, user.home),
      task2: task2(obs, user.home),
      task3: task3(obs),
      task4: task4(obs),
    });
  }

  // Sort by coverage and partition into quartiles
  perUser.sort((a, b) => a.coverage - b.coverage);
  const n = perUser.length;
  const buckets = [
    { label: 'Q1', start: 0, end: Math.floor(n * 0.25) },
    { label: 'Q2', start: Math.floor(n * 0.25), end: Math.floor(n * 0.5) },
    { label: 'Q3', start: Math.floor(n * 0.5), end: Math.floor(n * 0.75) },
    { label: 'Q4', start: Math.floor(n * 0.75), end: n },
  ];

  const out = {};
  for (const b of buckets) {
    const slice = perUser.slice(b.start, b.end);
    const cmin = (slice[0].coverage * 100).toFixed(0);
    const cmax = (slice[slice.length - 1].coverage * 100).toFixed(0);
    out[b.label] = { covMin: +cmin, covMax: +cmax, n: slice.length, methods: {} };
    for (const m of METHODS) {
      out[b.label].methods[m] = {
        t1_acc: aggMedian(slice.map(u => u.task1[m].acc)),
        t1_unans: aggMedian(slice.map(u => u.task1[m].unans)),
        t2_det1h: aggMedian(slice.map(u => u.task2[m].det1h)),
        t2_undet: aggMedian(slice.map(u => u.task2[m].undet)),
        t3_acc: aggMedian(slice.map(u => u.task3[m].acc)),
        t3_unans: aggMedian(slice.map(u => u.task3[m].unans)),
        t4_p95: aggMedian(slice.map(u => u.task4[m].p95_h)),
      };
    }
  }

  // Print
  console.log('Coverage quantile × social tasks:');
  console.log('='.repeat(95));
  for (const m of METHODS) {
    console.log(`\n--- ${m} ---`);
    console.log('Quartile  Cov range  T1Acc  T1Unans  T2-1h  T2Undet  T3Acc  T3Unans  T4p95(h)');
    for (const b of buckets) {
      const r = out[b.label].methods[m];
      const cov = `${out[b.label].covMin}--${out[b.label].covMax}%`;
      console.log(`  ${b.label}     ${cov.padEnd(10)} ${(r.t1_acc * 100).toFixed(0).padStart(3)}%   ${(r.t1_unans * 100).toFixed(0).padStart(3)}%    ${(r.t2_det1h * 100).toFixed(0).padStart(3)}%   ${(r.t2_undet * 100).toFixed(0).padStart(3)}%    ${(r.t3_acc * 100).toFixed(0).padStart(3)}%   ${(r.t3_unans * 100).toFixed(0).padStart(3)}%    ${(r.t4_p95 !== null ? r.t4_p95.toFixed(1) : '-').padStart(6)}`);
    }
  }

  await writeFile(join(RESULTS_DIR, 'coverage-quantile-tasks.json'), JSON.stringify({ buckets: out, perUser }, null, 2));
  console.log('\nSaved to results/coverage-quantile-tasks.json');
}

main().catch(e => { console.error(e); process.exit(1); });
