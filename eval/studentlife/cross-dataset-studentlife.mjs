/**
 * Cross-Dataset Validation: StudentLife (Dartmouth)
 *
 * 48 students, 10 weeks (1 academic term), ~10 min GPS cadence.
 * Dartmouth College, Hanover NH, USA.
 *
 * This is the strongest cross-dataset candidate:
 *   - Personal smartphone GPS (not taxi fleet)
 *   - 10-week duration (comparable to GeoLife's 90 days)
 *   - 48 users (larger than CenceMe's 19)
 *   - Includes travelstate for motion context
 *
 * GPS format: sensing/gps/gps_uXX.csv
 *   time_stamp, latitude, longitude, travelstate
 *
 * Evaluation: same pipeline as GeoLife — home inference attack,
 * social task T1 (at-home?), and observation reduction.
 */

import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
} from '../../packages/sdk/dist/privacy-location.js';

const DATA_DIR = 'F:/dataset/sensing/gps';
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'studentlife-eval';
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

function corridorCell(lat, lon) {
  return `${Math.floor(lat / 0.005)},${Math.floor(lon / 0.005)}`;
}

function parseCSV(content) {
  const points = [];
  const lines = content.split('\n');
  // Header: time,provider,network_type,accuracy,latitude,longitude,altitude,bearing,speed,travelstate
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const ts = parseInt(parts[0]) * 1000; // Unix seconds -> ms
    const lat = parseFloat(parts[4]);
    const lon = parseFloat(parts[5]);
    if (isNaN(ts) || isNaN(lat) || isNaN(lon)) continue;
    if (lat === 0 || lon === 0) continue;
    // Sanity: Dartmouth is around 43.7, -72.3
    if (lat < 20 || lat > 70 || lon < -130 || lon > -50) continue;
    const d = new Date(ts);
    points.push({
      ts, lat, lon,
      hour: d.getHours(),
      day: Math.floor(ts / 86400000),
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
    });
  }
  return points;
}

function findHome(points) {
  const nightPts = points.filter(p => p.hour >= 22 || p.hour < 6);
  if (nightPts.length < 5) return null;
  const cellSize = 0.002;
  const cells = new Map();
  for (const p of nightPts) {
    const k = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  let best = null, bestCnt = 0;
  for (const [, pts] of cells) if (pts.length > bestCnt) { bestCnt = pts.length; best = pts; }
  if (!best) return null;
  return {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
    nightObs: nightPts.length,
  };
}

function findWork(points, home) {
  const dayPts = points.filter(p => !p.isWeekend && p.hour >= 9 && p.hour < 17);
  if (dayPts.length < 5) return null;
  const cellSize = 0.002;
  const cells = new Map();
  for (const p of dayPts) {
    const k = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  let best = null, bestCnt = 0;
  for (const [, pts] of cells) {
    if (pts.length > bestCnt) {
      const cLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const cLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
      if (haversine(cLat, cLon, home.lat, home.lon) > 300) {
        bestCnt = pts.length;
        best = pts;
      }
    }
  }
  if (!best) return null;
  return {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
  };
}

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

function runEval(points, home, work, userId) {
  const userSeed = SEED + '-' + userId;
  const places = [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon,
      radiusM: 200, bufferRadiusM: 1000,
      visitCount: 30, avgDwellMinutes: 480 },
    ...(work ? [{ id: 'work', label: 'work', lat: work.lat, lon: work.lon,
      radiusM: 200, bufferRadiusM: 1000,
      visitCount: 20, avgDwellMinutes: 480 }] : []),
  ];
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };

  const result = { userId, nPoints: points.length, home, work, homeAttack: {}, task1: {} };
  const nightFilter = p => p.hour >= 22 || p.hour < 6;
  const commuteHours = new Set([7, 8, 17, 18]);
  const homeCorCell = corridorCell(home.lat, home.lon);
  const workCorCell = work ? corridorCell(work.lat, work.lon) : null;

  for (const method of METHODS) {
    const reporter = new AdaptiveReporter(12, 2);
    const nightObs = [];
    let t1_correct = 0, t1_total = 0, t1_unans = 0;

    for (const p of points) {
      const trueAtHome = haversine(p.lat, p.lon, home.lat, home.lon) < 200;
      let inCore = false, inBuffer = false, inHomeCore = trueAtHome;
      for (const pl of places) {
        const d = haversine(p.lat, p.lon, pl.lat, pl.lon);
        if (d <= pl.radiusM) { inCore = true; break; }
        if (d <= pl.bufferRadiusM) { inBuffer = true; }
      }

      let out, answerable, inferAtHome;
      switch (method) {
        case 'raw':
          out = { suppressed: false, sLat: p.lat, sLon: p.lon };
          inferAtHome = haversine(p.lat, p.lon, home.lat, home.lon) < 300;
          answerable = true;
          break;
        case 'laplace_grid': {
          const n = addPlanarLaplaceNoise(p.lat, p.lon, BASE_EPSILON);
          const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
          out = { suppressed: false, sLat: s.lat, sLon: s.lon };
          inferAtHome = haversine(s.lat, s.lon, home.lat, home.lon) < 300;
          answerable = true;
          break;
        }
        case 'zkls_grid_zones':
          if (inHomeCore) {
            out = { suppressed: true }; inferAtHome = true; answerable = true;
          } else if (inCore) {
            out = { suppressed: true }; inferAtHome = false; answerable = true;
          } else if (inBuffer) {
            out = { suppressed: true }; answerable = false;
          } else {
            const s = gridSnap(p.lat, p.lon, GRID_SIZE_M, userSeed);
            out = { suppressed: false, sLat: s.lat, sLon: s.lon };
            inferAtHome = haversine(s.lat, s.lon, home.lat, home.lon) < 300;
            answerable = true;
          }
          break;
        case 'six_layer': {
          const r = processLocation(p.lat, p.lon, places, config6, reporter);
          if (r.type === 'state') {
            out = { suppressed: true }; inferAtHome = inHomeCore; answerable = true;
          } else if (r.type === 'coarse') {
            out = { suppressed: false, sLat: r.lat, sLon: r.lon };
            inferAtHome = haversine(r.lat, r.lon, home.lat, home.lon) < 300;
            answerable = true;
          } else {
            out = { suppressed: true }; answerable = false;
          }
          break;
        }
      }

      if (!out.suppressed && nightFilter(p)) {
        nightObs.push({ sLat: out.sLat, sLon: out.sLon });
      }

      t1_total++;
      if (!answerable) { t1_unans++; continue; }
      if (inferAtHome === trueAtHome) t1_correct++;
    }

    result.homeAttack[method] = {
      error: centroidAttack(nightObs, home.lat, home.lon),
      nightObs: nightObs.length,
    };
    result.task1[method] = {
      acc: t1_correct / t1_total,
      unans: t1_unans / t1_total,
    };
  }
  return result;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  let files;
  try {
    files = (await readdir(DATA_DIR)).filter(f => f.match(/gps_u\d+\.csv/i));
  } catch (e) {
    console.error(`GPS directory not found at ${DATA_DIR}`);
    console.error('Download and extract dataset.tar.bz2 first.');
    console.error(e.message);
    process.exit(1);
  }

  console.log(`StudentLife: ${files.length} GPS files found`);
  files.sort();

  const userResults = [];
  for (const file of files) {
    const userId = file.match(/u(\d+)/)[1];
    const content = await readFile(join(DATA_DIR, file), 'utf-8');
    const pts = parseCSV(content);
    if (pts.length < 50) { console.log(`  User ${userId}: ${pts.length} points (skipped)`); continue; }

    const spanDays = (pts[pts.length - 1].ts - pts[0].ts) / 86400000;
    const home = findHome(pts);
    if (!home) { console.log(`  User ${userId}: ${pts.length} points, no home (skipped)`); continue; }

    const work = findWork(pts, home);
    console.log(`  User ${userId}: ${pts.length} pts, ${spanDays.toFixed(0)}d, home ${home.lat.toFixed(4)},${home.lon.toFixed(4)}${work ? ', work ' + work.lat.toFixed(4) : ''}`);

    const result = runEval(pts, home, work, userId);
    result.spanDays = spanDays;
    userResults.push(result);
  }

  console.log(`\nUsers with evaluation: ${userResults.length}`);
  const medSpan = userResults.map(r => r.spanDays).sort((a, b) => a - b);
  console.log(`Median span: ${medSpan[Math.floor(medSpan.length * 0.5)].toFixed(0)} days`);

  // Aggregate
  console.log('\n=== Home Inference Attack ===');
  console.log('Method              Median Err  <200m  <500m');
  for (const m of METHODS) {
    const errors = userResults.map(r => r.homeAttack[m].error).filter(e => e < Infinity).sort((a, b) => a - b);
    const med = errors.length > 0 ? errors[Math.floor(errors.length * 0.5)] : null;
    const lt200 = errors.filter(e => e < 200).length;
    const lt500 = errors.filter(e => e < 500).length;
    console.log(`  ${m.padEnd(18)} ${(med || '∞').toString().padStart(8)}m   ${lt200.toString().padStart(4)}   ${lt500.toString().padStart(4)}`);
  }

  console.log('\n=== T1: "Is my friend at home?" ===');
  console.log('Method              Acc(med)  Unans(med)');
  for (const m of METHODS) {
    const accs = userResults.map(r => r.task1[m].acc).sort((a, b) => a - b);
    const unanss = userResults.map(r => r.task1[m].unans).sort((a, b) => a - b);
    console.log(`  ${m.padEnd(18)} ${(accs[Math.floor(accs.length * 0.5)] * 100).toFixed(0).padStart(4)}%     ${(unanss[Math.floor(unanss.length * 0.5)] * 100).toFixed(0).padStart(4)}%`);
  }

  await writeFile(join(RESULTS_DIR, 'studentlife-eval.json'), JSON.stringify({
    usersEvaluated: userResults.length,
    medianSpanDays: medSpan[Math.floor(medSpan.length * 0.5)],
    userResults,
  }, null, 2));
  console.log('\nSaved to results/studentlife-eval.json');
}

main().catch(e => { console.error(e); process.exit(1); });
