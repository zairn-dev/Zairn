/**
 * Cross-Dataset Validation: CenceMe (Dartmouth)
 *
 * 20 users, ~2 weeks (2008-07-28 to 2008-08-11), Nokia N95 phones,
 * GPS ~3 min cadence. Dartmouth College area (NH, USA).
 *
 * Purpose: human dense corroboration — shows that zone suppression
 * works on personal smartphone GPS from a completely different
 * geography, device, and population than GeoLife (Beijing/academic)
 * or T-Drive (Beijing/taxi).
 *
 * Data format per GPS line:
 *   Timestamp DATA (0) - GPS: alt,lat,lon,hdop,speed*alt,lat,lon,hdop,speed*...
 *   Samples separated by *, multiple per line possible.
 *   Timestamps in Java time (Unix ms).
 *   Also: "GPS-Skipped: user sitting" lines (no GPS data).
 *
 * Files: CenceMeLiteLogXX.txt (XX = user number 1-20)
 * Located in: eval/cenceme/data/
 */

import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
  processLocation,
} from '../../packages/sdk/dist/privacy-location.js';

const DATA_DIR = 'F:/cence';
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'cenceme-eval';
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

/**
 * Parse GPS points from a CenceMeLiteLog file (streaming for large files).
 * Only keeps GPS DATA lines. Returns array of {ts, lat, lon, hour}.
 */
async function parseGPSFromLog(filePath) {
  const points = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });

  for await (const line of rl) {
    // Match GPS DATA lines
    if (!line.includes('DATA') || !line.includes('GPS:')) continue;
    if (line.includes('GPS-Skipped')) continue;

    // Format: Timestamp DATA (0) - GPS: alt,lat,lon,hdop,speed*alt,lat,lon,hdop,speed*...
    const gpsMatch = line.match(/^(\d+)\s+DATA\s+\(\d+\)\s+-\s+GPS:\s*(.+)$/);
    if (!gpsMatch) continue;

    const ts = parseInt(gpsMatch[1]);
    const samplesStr = gpsMatch[2].trim();
    // Split by * to get individual samples
    const samples = samplesStr.split('*').filter(s => s.trim().length > 0);

    for (const sample of samples) {
      const parts = sample.split(',').map(s => s.trim());
      if (parts.length < 3) continue;
      // Format: altitude, latitude(NMEA DDmm.mmmmm), longitude(NMEA DDDmm.mmmmm), [hdop, speed]
      const latNmea = parseFloat(parts[1]);
      const lonNmea = parseFloat(parts[2]);
      if (isNaN(latNmea) || isNaN(lonNmea) || latNmea === 0 || lonNmea === 0) continue;
      // Convert NMEA DDmm.mmmmm to decimal degrees
      const latDeg = Math.floor(latNmea / 100);
      const latMin = latNmea - latDeg * 100;
      const lat = latDeg + latMin / 60;
      const lonDeg = Math.floor(lonNmea / 100);
      const lonMin = lonNmea - lonDeg * 100;
      const lon = -(lonDeg + lonMin / 60); // Dartmouth is western hemisphere
      // Sanity: Dartmouth is around lat 43.7, lon -72.3
      if (lat < 20 || lat > 70 || lon < -130 || lon > -50) continue;

      const d = new Date(ts);
      points.push({ ts, lat, lon, hour: d.getHours(), day: Math.floor(ts / 86400000) });
    }
  }

  return points;
}

/**
 * Resample to ~3 min intervals (keep one point per 3-min bucket).
 */
function resample(points, intervalMs = 180000) {
  if (points.length === 0) return [];
  points.sort((a, b) => a.ts - b.ts);
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].ts - out[out.length - 1].ts >= intervalMs) {
      out.push(points[i]);
    }
  }
  return out;
}

function findHome(points) {
  const nightPts = points.filter(p => p.hour >= 22 || p.hour < 6);
  if (nightPts.length < 3) return null;
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

const METHODS = ['raw', 'laplace_grid', 'zkls_grid_zones', 'six_layer'];

function cell2km(lat, lon) {
  return `${Math.floor(lat / 0.02)},${Math.floor(lon / 0.02)}`;
}

function runEval(points, home, userId) {
  const userSeed = SEED + '-' + userId;
  const places = [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon,
      radiusM: 200, bufferRadiusM: 1000,
      visitCount: 30, avgDwellMinutes: 480 },
  ];
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
  const homeCell = cell2km(home.lat, home.lon);
  const nightFilter = p => p.hour >= 22 || p.hour < 6;

  const result = { userId, nPoints: points.length, home };

  // Home inference attack
  result.homeAttack = {};
  for (const method of METHODS) {
    const reporter = new AdaptiveReporter(12, 2);
    const nightObs = [];
    for (const p of points) {
      let out;
      switch (method) {
        case 'raw': out = { suppressed: false, sLat: p.lat, sLon: p.lon }; break;
        case 'laplace_grid': {
          const n = addPlanarLaplaceNoise(p.lat, p.lon, BASE_EPSILON);
          const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
          out = { suppressed: false, sLat: s.lat, sLon: s.lon }; break;
        }
        case 'zkls_grid_zones': {
          let inZone = false;
          for (const pl of places) if (haversine(p.lat, p.lon, pl.lat, pl.lon) <= pl.bufferRadiusM) { inZone = true; break; }
          if (inZone) { out = { suppressed: true }; break; }
          const s = gridSnap(p.lat, p.lon, GRID_SIZE_M, userSeed);
          out = { suppressed: false, sLat: s.lat, sLon: s.lon }; break;
        }
        case 'six_layer': {
          const r = processLocation(p.lat, p.lon, places, config6, reporter);
          if (r.type === 'coarse') out = { suppressed: false, sLat: r.lat, sLon: r.lon };
          else out = { suppressed: true };
          break;
        }
      }
      if (!out.suppressed && nightFilter(p)) {
        nightObs.push({ sLat: out.sLat, sLon: out.sLon });
      }
    }
    result.homeAttack[method] = {
      error: centroidAttack(nightObs, home.lat, home.lon),
      nightObs: nightObs.length,
    };
  }

  // Social task T1: "Is my friend at home?"
  result.task1 = {};
  for (const method of METHODS) {
    const reporter = new AdaptiveReporter(12, 2);
    let correct = 0, total = 0, unans = 0;
    for (const p of points) {
      const trueAtHome = haversine(p.lat, p.lon, home.lat, home.lon) < 200;
      total++;
      let inferAtHome, answerable;
      const inHomeCore = trueAtHome;
      let inCore = false, inBuffer = false;
      for (const pl of places) {
        const d = haversine(p.lat, p.lon, pl.lat, pl.lon);
        if (d <= pl.radiusM) { inCore = true; break; }
        if (d <= pl.bufferRadiusM) { inBuffer = true; }
      }

      switch (method) {
        case 'raw':
          inferAtHome = haversine(p.lat, p.lon, home.lat, home.lon) < 300;
          answerable = true; break;
        case 'laplace_grid': {
          const n = addPlanarLaplaceNoise(p.lat, p.lon, BASE_EPSILON);
          const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
          inferAtHome = haversine(s.lat, s.lon, home.lat, home.lon) < 300;
          answerable = true; break;
        }
        case 'zkls_grid_zones':
          if (inHomeCore) { inferAtHome = true; answerable = true; }
          else if (inCore) { inferAtHome = false; answerable = true; }
          else if (inBuffer) { answerable = false; }
          else {
            const s = gridSnap(p.lat, p.lon, GRID_SIZE_M, userSeed);
            inferAtHome = haversine(s.lat, s.lon, home.lat, home.lon) < 300;
            answerable = true;
          }
          break;
        case 'six_layer': {
          const r = processLocation(p.lat, p.lon, places, config6, reporter);
          if (r.type === 'state') { inferAtHome = inHomeCore; answerable = true; }
          else if (r.type === 'coarse') {
            inferAtHome = haversine(r.lat, r.lon, home.lat, home.lon) < 300;
            answerable = true;
          } else { answerable = false; }
          break;
        }
      }
      if (!answerable) { unans++; continue; }
      if (inferAtHome === trueAtHome) correct++;
    }
    result.task1[method] = { acc: correct / total, unans: unans / total };
  }

  return result;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  let files;
  try {
    files = (await readdir(DATA_DIR)).filter(f => f.match(/CenceMeLiteLog\d+\.txt/i));
  } catch {
    console.error(`No data directory at ${DATA_DIR}.`);
    console.error('Download CenceMe from IEEE DataPort:');
    console.error('  https://ieee-dataport.org/open-access/crawdad-dartmouthcenceme');
    console.error('Extract RAR files and place CenceMeLiteLogXX.txt in eval/cenceme/data/');
    process.exit(1);
  }

  if (files.length === 0) {
    console.error('No CenceMeLiteLogXX.txt files found in ' + DATA_DIR);
    process.exit(1);
  }

  console.log(`CenceMe: ${files.length} user files found`);
  files.sort((a, b) => {
    const na = parseInt(a.match(/\d+/)[0]);
    const nb = parseInt(b.match(/\d+/)[0]);
    return na - nb;
  });

  const userResults = [];

  for (const file of files) {
    const userId = file.match(/\d+/)[0];
    console.log(`  Parsing user ${userId}...`);
    const raw = await parseGPSFromLog(join(DATA_DIR, file));
    console.log(`    Raw GPS points: ${raw.length}`);
    if (raw.length < 20) { console.log('    (skipping — too few GPS)'); continue; }

    const pts = resample(raw, 180000); // 3 min
    console.log(`    Resampled (3min): ${pts.length}`);
    const spanDays = (pts[pts.length - 1].ts - pts[0].ts) / 86400000;
    console.log(`    Span: ${spanDays.toFixed(1)} days`);

    const home = findHome(pts);
    if (!home) { console.log('    (skipping — no home cluster)'); continue; }
    console.log(`    Home: ${home.lat.toFixed(4)}, ${home.lon.toFixed(4)} (${home.nightObs} night obs)`);

    const result = runEval(pts, home, userId);
    userResults.push(result);
  }

  console.log(`\nUsers with evaluation: ${userResults.length}`);

  // Aggregate home attack
  console.log('\n=== Home Inference Attack ===');
  console.log('Method              Median Err  <200m  <500m');
  for (const m of METHODS) {
    const errors = userResults.map(r => r.homeAttack[m].error).filter(e => e < Infinity).sort((a, b) => a - b);
    const med = errors.length > 0 ? errors[Math.floor(errors.length * 0.5)] : null;
    const lt200 = errors.filter(e => e < 200).length;
    const lt500 = errors.filter(e => e < 500).length;
    console.log(`  ${m.padEnd(18)} ${(med || '∞').toString().padStart(8)}m   ${lt200.toString().padStart(4)}   ${lt500.toString().padStart(4)}`);
  }

  // Aggregate T1
  console.log('\n=== T1: "Is my friend at home?" ===');
  console.log('Method              Acc(med)  Unans(med)');
  for (const m of METHODS) {
    const accs = userResults.map(r => r.task1[m].acc).sort((a, b) => a - b);
    const unanss = userResults.map(r => r.task1[m].unans).sort((a, b) => a - b);
    const medAcc = accs[Math.floor(accs.length * 0.5)];
    const medUn = unanss[Math.floor(unanss.length * 0.5)];
    console.log(`  ${m.padEnd(18)} ${(medAcc * 100).toFixed(0).padStart(4)}%     ${(medUn * 100).toFixed(0).padStart(4)}%`);
  }

  await writeFile(join(RESULTS_DIR, 'cenceme-eval.json'), JSON.stringify({
    usersEvaluated: userResults.length,
    userResults,
  }, null, 2));
  console.log('\nSaved to results/cenceme-eval.json');
}

main().catch(e => { console.error(e); process.exit(1); });
