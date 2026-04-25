/**
 * Deployment Vignette Analysis
 *
 * Analyzes real dense trace data (1-min interval, always-on) through
 * the privacy system. Compares with GeoLife results.
 *
 * Produces:
 * 1. Home/work detection from the trace
 * 2. Privacy attack simulation (same methods as GeoLife eval)
 * 3. Utility metrics (presence, neighborhood, availability)
 * 4. 1-day timeline of disclosure levels
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  processLocation,
  detectSensitivePlaces,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'deployment-user';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return { error: Infinity, count: 0 };
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat/cellSize)},${Math.floor(o.sLon/cellSize)}`;
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
    const nKey = `${bRow+dr},${bCol+dc}`;
    if (cells.has(nKey)) filtered.push(...cells.get(nKey));
  }
  const aLat = filtered.reduce((s,o) => s+o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s,o) => s+o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length };
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });

  // Load trace — choose via TRACE env var (segA, segAB, segABC)
  const traceName = process.env.TRACE || 'segABC';
  const raw = JSON.parse(await readFile(join(import.meta.dirname, `clean-${traceName}.json`), 'utf-8'));
  const trace = raw.trace;
  console.log(`Trace: ${traceName}`);
  console.log(`Loaded ${trace.length} points, ${((trace[trace.length-1].ts - trace[0].ts) / 86400000).toFixed(1)} days`);

  // Convert to hourly format matching GeoLife eval
  const locs = trace.map(p => {
    const d = new Date(p.timestamp);
    return {
      lat: p.lat, lon: p.lon,
      timestamp: p.timestamp,
      hour: d.getHours(),
      day: Math.floor((p.ts - trace[0].ts) / 86400000),
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
      ts: p.ts,
    };
  });

  // ============================================================
  // 1. Home/Work detection
  // ============================================================
  console.log('\n=== Home/Work Detection ===');

  // Nighttime cluster (22:00-06:00)
  const nightPts = locs.filter(l => l.hour >= 22 || l.hour < 6);
  const cellSize = 0.002; // ~200m
  const nightCells = new Map();
  for (const p of nightPts) {
    const key = `${Math.floor(p.lat/cellSize)},${Math.floor(p.lon/cellSize)}`;
    if (!nightCells.has(key)) nightCells.set(key, []);
    nightCells.get(key).push(p);
  }
  let homeCluster = null, homeCount = 0;
  for (const [, pts] of nightCells) {
    if (pts.length > homeCount) { homeCount = pts.length; homeCluster = pts; }
  }
  const home = {
    lat: homeCluster.reduce((s,p) => s+p.lat, 0) / homeCluster.length,
    lon: homeCluster.reduce((s,p) => s+p.lon, 0) / homeCluster.length,
  };
  console.log(`Home: ${home.lat.toFixed(6)}, ${home.lon.toFixed(6)} (${homeCount} night points)`);

  // Daytime weekday cluster (09:00-17:00, Mon-Fri)
  const dayPts = locs.filter(l => !l.isWeekend && l.hour >= 9 && l.hour < 17);
  const dayCells = new Map();
  for (const p of dayPts) {
    const key = `${Math.floor(p.lat/cellSize)},${Math.floor(p.lon/cellSize)}`;
    if (!dayCells.has(key)) dayCells.set(key, []);
    dayCells.get(key).push(p);
  }
  let workCluster = null, workCount = 0;
  for (const [, pts] of dayCells) {
    if (pts.length > workCount) {
      const cLat = pts.reduce((s,p) => s+p.lat, 0) / pts.length;
      const cLon = pts.reduce((s,p) => s+p.lon, 0) / pts.length;
      if (haversine(cLat, cLon, home.lat, home.lon) > 500) {
        workCount = pts.length;
        workCluster = pts;
      }
    }
  }
  const work = workCluster ? {
    lat: workCluster.reduce((s,p) => s+p.lat, 0) / workCluster.length,
    lon: workCluster.reduce((s,p) => s+p.lon, 0) / workCluster.length,
  } : null;
  if (work) {
    console.log(`Work: ${work.lat.toFixed(6)}, ${work.lon.toFixed(6)} (${workCount} day points, ${Math.round(haversine(home.lat, home.lon, work.lat, work.lon))}m from home)`);
  } else {
    console.log('Work: not detected');
  }

  // ============================================================
  // 2. Privacy attack simulation
  // ============================================================
  console.log('\n=== Privacy Attack Simulation ===');

  const sensitivePlaces = [
    { id: 'home', label: 'home', lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 30, avgDwellMinutes: 480 },
    ...(work ? [{ id: 'work', label: 'work', lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000, visitCount: 20, avgDwellMinutes: 480 }] : []),
  ];

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const methods = {};

  // Raw
  const rawObs = locs.map(l => ({ ...l, sLat: l.lat, sLon: l.lon }));

  // Laplace+Grid
  const laplaceObs = locs.map(l => {
    const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
    const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, SEED);
    return { ...l, sLat: s.lat, sLon: s.lon };
  });

  // ZKLS Grid+Zones
  const zklsZoneObs = [];
  for (const l of locs) {
    let inZone = false;
    for (const place of sensitivePlaces) {
      if (haversine(l.lat, l.lon, place.lat, place.lon) <= (place.bufferRadiusM || 1000)) { inZone = true; break; }
    }
    if (inZone) continue;
    const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, SEED);
    zklsZoneObs.push({ ...l, sLat: s.lat, sLon: s.lon });
  }

  // 6-Layer
  const config6 = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: SEED, baseEpsilon: BASE_EPSILON };
  const reporter6 = new AdaptiveReporter(12, 2);
  const fullObs = [];
  for (const l of locs) {
    const result = processLocation(l.lat, l.lon, sensitivePlaces, config6, reporter6);
    if (result.type === 'coarse') fullObs.push({ ...l, sLat: result.lat, sLon: result.lon });
  }

  const allMethods = [
    { name: 'Raw', obs: rawObs },
    { name: 'Laplace+Grid', obs: laplaceObs },
    { name: 'ZKLS Grid+Zones', obs: zklsZoneObs },
    { name: '6-Layer', obs: fullObs },
  ];

  console.log('\nMethod              | Home Err | Night Obs | Obs Red  | Work Err');
  console.log('-'.repeat(72));
  for (const m of allMethods) {
    const nightObs = m.obs.filter(nightFilter);
    const homeAttack = centroidAttack(nightObs, home.lat, home.lon);
    const workObs = work ? m.obs.filter(o => !o.isWeekend && o.hour >= 9 && o.hour < 17) : [];
    const workAttack = work ? centroidAttack(workObs, work.lat, work.lon) : { error: Infinity };
    const obsRed = ((1 - m.obs.length / rawObs.length) * 100).toFixed(1);
    console.log(`${m.name.padEnd(20)}| ${String(homeAttack.error+'m').padStart(8)} | ${String(homeAttack.count).padStart(9)} | ${String(obsRed+'%').padStart(8)} | ${String(workAttack.error+'m').padStart(8)}`);
  }

  // ============================================================
  // 3. Utility metrics
  // ============================================================
  console.log('\n=== Utility Metrics ===');

  for (const m of allMethods) {
    let task1_ok = 0, task1_n = 0;
    let avail = 0;

    for (const l of locs) {
      const trueAtHome = haversine(l.lat, l.lon, home.lat, home.lon) < 200;
      const isInObs = m.obs.some(o => o.ts === l.ts);

      // Check if this is a zone-suppressed state-only
      let inCore = false;
      for (const p of sensitivePlaces) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= p.radiusM) { inCore = true; break; }
      }

      if (l.hour >= 22 || l.hour < 6) {
        let inferAtHome = false;
        if (m.name.includes('Zone') || m.name.includes('Layer')) {
          if (inCore) inferAtHome = true;
          else if (isInObs) {
            const obs = m.obs.find(o => o.ts === l.ts);
            if (obs) inferAtHome = haversine(obs.sLat, obs.sLon, home.lat, home.lon) < 300;
          }
        } else if (isInObs) {
          const obs = m.obs.find(o => o.ts === l.ts);
          if (obs) inferAtHome = haversine(obs.sLat, obs.sLon, home.lat, home.lon) < 300;
        }
        if (trueAtHome === inferAtHome) task1_ok++;
        task1_n++;
      }

      if (isInObs || (inCore && (m.name.includes('Zone') || m.name.includes('Layer')))) avail++;
    }

    console.log(`${m.name.padEnd(20)} At home: ${(task1_ok/task1_n*100).toFixed(1)}%  Avail: ${(avail/locs.length*100).toFixed(1)}%`);
  }

  // ============================================================
  // 4. Timeline (pick one day)
  // ============================================================
  console.log('\n=== 1-Day Timeline (Day 1, full 24h) ===');

  const day1 = locs.filter(l => l.day === 1); // Full day
  const hourly = {};
  for (let h = 0; h < 24; h++) hourly[h] = { raw: 0, zone_state: 0, zone_coarse: 0, suppressed: 0 };

  for (const l of day1) {
    hourly[l.hour].raw++;
    let inCore = false, inBuffer = false;
    for (const p of sensitivePlaces) {
      const d = haversine(l.lat, l.lon, p.lat, p.lon);
      if (d <= p.radiusM) { inCore = true; break; }
      if (d <= p.bufferRadiusM) { inBuffer = true; }
    }
    if (inCore) hourly[l.hour].zone_state++;
    else if (inBuffer) hourly[l.hour].suppressed++;
    else hourly[l.hour].zone_coarse++;
  }

  console.log('Hour | Raw  | State | Coarse | Suppressed | Disclosure');
  for (let h = 0; h < 24; h++) {
    const r = hourly[h];
    const total = r.zone_state + r.zone_coarse + r.suppressed;
    let disc = 'coarse';
    if (r.zone_state > r.zone_coarse && r.zone_state > r.suppressed) disc = 'STATE';
    else if (r.suppressed > r.zone_coarse) disc = 'buffer';
    console.log(`  ${String(h).padStart(2)}  | ${String(r.raw).padStart(4)} | ${String(r.zone_state).padStart(5)} | ${String(r.zone_coarse).padStart(6)} | ${String(r.suppressed).padStart(10)} | ${disc}`);
  }

  // ============================================================
  // 5. Comparison with GeoLife
  // ============================================================
  console.log('\n=== Dense Trace vs GeoLife ===');
  console.log('                    | Dense (this) | GeoLife (median 78 users)');
  console.log('Coverage            | 100% (1min)  | 16% (hourly)');
  console.log('Duration            | 6.9 days     | 90 days');
  console.log('Points/day          | 1440         | ~5-10');

  // Save results
  const results = {
    trace: { points: trace.length, days: (trace[trace.length-1].ts - trace[0].ts) / 86400000, coverage: '100%' },
    home, work,
    attacks: {},
    timeline: hourly,
  };
  for (const m of allMethods) {
    const nightObs = m.obs.filter(nightFilter);
    results.attacks[m.name] = {
      homeError: centroidAttack(nightObs, home.lat, home.lon).error,
      obsReduction: ((1 - m.obs.length / rawObs.length) * 100).toFixed(1),
    };
  }
  await writeFile(join(RESULTS_DIR, 'deployment-vignette.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved to results/deployment-vignette.json');
}

main().catch(console.error);
