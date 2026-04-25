/**
 * Coverage sweep on the dense Android trace
 *
 * Resamples the 6.34d clean Seg A+B trace to 1, 5, 15, 30, 60 minute
 * cadences and re-runs the social task benchmark + centroid attack
 * for each cadence x method combination.
 *
 * Goal: show that 6-Layer's GeoLife failure (95% of departures
 * undetected) is a *sparse-cadence artifact*. As cadence becomes
 * coarser, 6-Layer should degrade rapidly while ZKLS Grid+Zones
 * degrades gracefully.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
} from '../../packages/sdk/dist/privacy-location.js';

const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'coverage-sweep';
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

function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return Infinity;
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const k = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  let best = null, bestCnt = 0;
  for (const [k, pts] of cells) if (pts.length > bestCnt) { bestCnt = pts.length; best = k; }
  if (!best) return Infinity;
  const [br, bc] = best.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const k = `${br + dr},${bc + dc}`;
    if (cells.has(k)) filtered.push(...cells.get(k));
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return Math.round(haversine(aLat, aLon, targetLat, targetLon));
}

/**
 * Resample trace to a target cadence (in minutes).
 * Uses time-bucket selection: for each `intervalMin`-minute bucket,
 * keep the first observation. Approximates real device cadence.
 */
function resample(trace, intervalMin) {
  if (intervalMin <= 1) return trace;
  const intervalMs = intervalMin * 60 * 1000;
  const out = [];
  let nextBucket = trace[0].ts;
  for (const p of trace) {
    if (p.ts >= nextBucket) {
      out.push(p);
      nextBucket = p.ts + intervalMs;
    }
  }
  return out;
}

function applyMethods(trace, places, userSeed) {
  const reporter6 = new AdaptiveReporter(12, 2);
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
  const homeCell2km = cell2km(places[0].lat, places[0].lon);

  return trace.map(p => {
    const trueDistHome = haversine(p.lat, p.lon, places[0].lat, places[0].lon);
    const trueAtHome = trueDistHome < 200;
    const trueCell = cell2km(p.lat, p.lon);

    let inCore = false, inBuffer = false;
    for (const place of places) {
      const d = haversine(p.lat, p.lon, place.lat, place.lon);
      if (d <= place.radiusM) { inCore = true; break; }
      if (d <= place.bufferRadiusM) { inBuffer = true; }
    }
    const inHomeCore = trueDistHome < 200;

    const o = {
      ts: p.ts, lat: p.lat, lon: p.lon,
      hour: new Date(p.ts).getHours(),
      trueAtHome, trueCell, homeCell2km,
    };

    // Raw
    o.raw = { lat: p.lat, lon: p.lon, suppressed: false, state: null };

    // Laplace+Grid
    const n1 = addPlanarLaplaceNoise(p.lat, p.lon, BASE_EPSILON);
    const s1 = gridSnap(n1.lat, n1.lon, GRID_SIZE_M, userSeed);
    o.laplace_grid = { lat: s1.lat, lon: s1.lon, suppressed: false, state: null };

    // ZKLS Grid+Zones
    if (inHomeCore) {
      o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_home' };
    } else if (inCore) {
      o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: 'at_place' };
    } else if (inBuffer) {
      o.zkls_grid_zones = { lat: null, lon: null, suppressed: true, state: null };
    } else {
      const gc = gridSnap(p.lat, p.lon, GRID_SIZE_M, userSeed);
      o.zkls_grid_zones = { lat: gc.lat, lon: gc.lon, suppressed: false, state: null };
    }

    // 6-Layer (with adaptive reporter)
    const r = processLocation(p.lat, p.lon, places, config6, reporter6);
    if (r.type === 'state') {
      o.six_layer = { lat: null, lon: null, suppressed: true, state: inHomeCore ? 'at_home' : 'at_place' };
    } else if (r.type === 'coarse') {
      o.six_layer = { lat: r.lat, lon: r.lon, suppressed: false, state: null };
    } else {
      o.six_layer = { lat: null, lon: null, suppressed: true, state: null };
    }

    return o;
  });
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

function task1(obs, home) {
  const out = {};
  for (const m of METHODS) {
    let correct = 0, total = 0, unans = 0;
    for (const o of obs) {
      total++;
      const d = o[m];
      const answerable = !d.suppressed || d.state !== null;
      if (!answerable) { unans++; continue; }
      let infer;
      if (d.suppressed) infer = (d.state === 'at_home');
      else infer = haversine(d.lat, d.lon, home.lat, home.lon) < 300;
      if (infer === o.trueAtHome) correct++;
    }
    out[m] = { acc: correct / total, unans: unans / total };
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
    let det1h = 0, det3h = 0, det6h = 0, undet = 0;
    const lats = [];
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
      lats.push(lh);
      if (lh <= 1) det1h++;
      if (lh <= 3) det3h++;
      if (lh <= 6) det6h++;
    }
    out[m] = {
      n: departures.length,
      det1h: departures.length > 0 ? det1h / departures.length : 0,
      det3h: departures.length > 0 ? det3h / departures.length : 0,
      det6h: departures.length > 0 ? det6h / departures.length : 0,
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
      else if (d.state === 'at_home') cell = o.homeCell2km;
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
    if (ans.length < 2) { out[m] = { p50_h: null, p95_h: null, max_h: null, unans: unH / obs.length }; continue; }
    const gaps = [];
    for (let i = 1; i < ans.length; i++) gaps.push((ans[i] - ans[i - 1]) / 3600000);
    gaps.sort((a, b) => a - b);
    out[m] = {
      p50_h: gaps[Math.floor(gaps.length * 0.5)],
      p95_h: gaps[Math.floor(gaps.length * 0.95)],
      max_h: gaps[gaps.length - 1],
      unans: unH / obs.length,
    };
  }
  return out;
}

function homeAttack(obs, home) {
  const out = {};
  for (const m of METHODS) {
    const nightObs = [];
    for (const o of obs) {
      const d = o[m];
      if (d.suppressed) continue;
      if (o.hour >= 22 || o.hour < 6) nightObs.push({ sLat: d.lat, sLon: d.lon });
    }
    out[m] = { error: centroidAttack(nightObs, home.lat, home.lon), nObs: nightObs.length };
  }
  return out;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  const traceFile = process.env.TRACE || 'clean-segABC.json';
  const raw = JSON.parse(await readFile(join(import.meta.dirname, traceFile), 'utf-8'));
  const trace = raw.trace;
  console.log(`Trace: ${traceFile}, ${trace.length} points (1-min cadence baseline)`);

  // Auto-detect home and work (same as systems-eval / vignette)
  const nightPts = trace.filter(p => {
    const h = new Date(p.ts).getHours();
    return h >= 22 || h < 6;
  });
  const cellSize = 0.002;
  const nc = new Map();
  for (const p of nightPts) {
    const k = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!nc.has(k)) nc.set(k, []);
    nc.get(k).push(p);
  }
  let best = null, bc = 0;
  for (const [, pts] of nc) if (pts.length > bc) { bc = pts.length; best = pts; }
  const home = {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
  };

  const dayPts = trace.filter(p => {
    const d = new Date(p.ts);
    const h = d.getHours();
    const dow = d.getDay();
    return dow !== 0 && dow !== 6 && h >= 9 && h < 17;
  });
  const dc = new Map();
  for (const p of dayPts) {
    const k = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!dc.has(k)) dc.set(k, []);
    dc.get(k).push(p);
  }
  let workBest = null, workCnt = 0;
  for (const [, pts] of dc) {
    if (pts.length > workCnt) {
      const cLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const cLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
      if (haversine(cLat, cLon, home.lat, home.lon) > 500) {
        workCnt = pts.length;
        workBest = pts;
      }
    }
  }
  const work = workBest ? {
    lat: workBest.reduce((s, p) => s + p.lat, 0) / workBest.length,
    lon: workBest.reduce((s, p) => s + p.lon, 0) / workBest.length,
  } : null;

  const places = [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480 },
    ...(work ? [{ id: 'work', label: 'work', lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480 }] : []),
  ];
  console.log(`Home: ${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}`);
  if (work) console.log(`Work: ${work.lat.toFixed(4)}, ${work.lon.toFixed(4)} (${Math.round(haversine(home.lat, home.lon, work.lat, work.lon))}m from home)`);

  const cadences = [1, 5, 15, 30, 60]; // minutes
  const all = {};

  for (const intervalMin of cadences) {
    const sub = resample(trace, intervalMin);
    console.log(`\n=== Cadence ${intervalMin} min — ${sub.length} points ===`);

    const obs = applyMethods(sub, places, SEED + '-' + intervalMin);

    const t1 = task1(obs, home);
    const t2 = task2(obs, home);
    const t3 = task3(obs);
    const t4 = task4(obs);
    const ha = homeAttack(obs, home);

    all[intervalMin] = { n: sub.length, t1, t2, t3, t4, homeAttack: ha };

    console.log('Method            T1Acc  T1Unans  T2-1h  T2-3h  T2-Undet  T3Acc  T4p95(h)  HomeErr');
    for (const m of METHODS) {
      const a1 = t1[m], a2 = t2[m], a3 = t3[m], a4 = t4[m], ah = ha[m];
      const he = ah.error === Infinity ? '∞' : ah.error + 'm';
      console.log(`  ${m.padEnd(16)} ${(a1.acc * 100).toFixed(0).padStart(3)}%  ${(a1.unans * 100).toFixed(0).padStart(3)}%   ${(a2.det1h * 100).toFixed(0).padStart(3)}%  ${(a2.det3h * 100).toFixed(0).padStart(3)}%   ${(a2.undet * 100).toFixed(0).padStart(3)}%    ${(a3.acc * 100).toFixed(0).padStart(3)}%  ${(a4.p95_h !== null ? a4.p95_h.toFixed(1) : '-').padStart(6)}    ${he.padStart(8)}`);
    }
  }

  await writeFile(join(RESULTS_DIR, 'coverage-sweep.json'), JSON.stringify({ home, work, cadences, results: all }, null, 2));
  console.log('\nSaved to results/coverage-sweep.json');
}

main().catch(e => { console.error(e); process.exit(1); });
