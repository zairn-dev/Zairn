/**
 * Auto-detection failure analysis
 *
 * Identifies the users who are exposed (<200m home inference) under
 * the "detected only" e2e condition, and characterizes them along:
 *   - overall coverage
 *   - night coverage (22-06)
 *   - cluster confidence (number of clusters detected, dwell time)
 *   - whether any home cluster was detected at all
 *   - false positive count
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  gridSnap,
  detectSensitivePlaces,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'eval-user-seed'; // match end-to-end-eval.mjs to reproduce its 7-user count
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

function runDefense(locs, places, userSeed) {
  const reporter = new AdaptiveReporter(12, 2);
  const obs = [];
  for (const l of locs) {
    let inCore = false, inBuffer = false;
    for (const p of places) {
      const d = haversine(l.lat, l.lon, p.lat, p.lon);
      if (d <= p.radiusM) { inCore = true; break; }
      if (d <= p.bufferRadiusM) { inBuffer = true; }
    }
    if (inCore || inBuffer) continue;
    const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
    if (!reporter.shouldReport(s.cellId)) continue;
    reporter.record(s.cellId);
    obs.push({ ...l, sLat: s.lat, sLon: s.lon });
  }
  return obs;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const perUser = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));

    // Coverage profile
    const totalHours = 90 * 24;
    let nightCnt = 0;
    for (const l of locs) {
      if (l.hour >= 22 || l.hour < 6) nightCnt++;
    }
    const overall = locs.length / totalHours;
    const nightCov = nightCnt / (90 * 8);

    // Auto-detect places using first 30 days (matching e2e eval)
    const training = locs.filter(l => l.day < 30).map(l => ({
      lat: l.lat, lon: l.lon, timestamp: l.timestamp,
    }));
    const detected = detectSensitivePlaces(training, {
      ...DEFAULT_PRIVACY_CONFIG,
      minVisitsForSensitive: 3,
      minDwellMinutes: 30,
    });

    // Did detection find a cluster within 1km of home?
    const homeFound = detected.some(p =>
      haversine(p.lat, p.lon, user.home.lat, user.home.lon) < 1000
    );
    // Number of false positives (clusters not near home or work)
    let falsePositives = 0;
    for (const d of detected) {
      const distToHome = haversine(d.lat, d.lon, user.home.lat, user.home.lon);
      const distToWork = user.work ? haversine(d.lat, d.lon, user.work.lat, user.work.lon) : Infinity;
      if (distToHome >= 1000 && distToWork >= 1000) falsePositives++;
    }
    const totalDwellMin = detected.reduce((s, d) => s + (d.avgDwellMinutes || 0) * (d.visitCount || 1), 0);
    const totalVisits = detected.reduce((s, d) => s + (d.visitCount || 0), 0);

    const places = detected.map(p => ({
      lat: p.lat, lon: p.lon,
      radiusM: p.radiusM, bufferRadiusM: p.bufferRadiusM,
    }));
    const obs = runDefense(locs, places, SEED + '-' + user.userId);
    const nightObs = obs.filter(o => o.hour >= 22 || o.hour < 6);
    const homeError = centroidAttack(nightObs, user.home.lat, user.home.lon);

    perUser.push({
      userId: user.userId,
      coverage: overall,
      nightCoverage: nightCov,
      hasWork: !!user.work,
      detectedCount: detected.length,
      homeFound,
      falsePositives,
      totalVisits,
      totalDwellMinutes: totalDwellMin,
      homeErrorAutoOnly: homeError,
      exposed200: homeError < 200,
      exposed500: homeError < 500,
    });
  }

  const exposed = perUser.filter(u => u.exposed200);
  const safe = perUser.filter(u => !u.exposed200);

  console.log('=== Auto-detection failure analysis ===');
  console.log(`Total users: ${perUser.length}`);
  console.log(`Exposed at <200m (auto-detect only): ${exposed.length}`);
  console.log(`Safe: ${safe.length}\n`);

  // Compare exposed vs safe
  const med = (arr, key) => {
    const vs = arr.map(u => u[key]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    return vs.length > 0 ? vs[Math.floor(vs.length * 0.5)] : null;
  };
  const meanRate = (arr, key) => arr.filter(u => u[key]).length / arr.length;

  console.log('Property                      Exposed (n=' + exposed.length + ')   Safe (n=' + safe.length + ')');
  console.log(`  Coverage (med)              ${(med(exposed, 'coverage') * 100).toFixed(1)}%             ${(med(safe, 'coverage') * 100).toFixed(1)}%`);
  console.log(`  Night coverage (med)        ${(med(exposed, 'nightCoverage') * 100).toFixed(1)}%             ${(med(safe, 'nightCoverage') * 100).toFixed(1)}%`);
  console.log(`  Detected place count (med)  ${med(exposed, 'detectedCount')}                ${med(safe, 'detectedCount')}`);
  console.log(`  Home found (rate)           ${(meanRate(exposed, 'homeFound') * 100).toFixed(0)}%              ${(meanRate(safe, 'homeFound') * 100).toFixed(0)}%`);
  console.log(`  False positives (med)       ${med(exposed, 'falsePositives')}                ${med(safe, 'falsePositives')}`);
  console.log(`  Total visits (med)          ${med(exposed, 'totalVisits')}                ${med(safe, 'totalVisits')}`);

  console.log('\nExposed users — detail:');
  console.log('user  cov   night  detCnt  homeFnd  fp  visits  err(m)');
  for (const u of exposed) {
    console.log(`  ${u.userId}   ${(u.coverage * 100).toFixed(0)}%    ${(u.nightCoverage * 100).toFixed(0)}%     ${u.detectedCount}        ${u.homeFound ? 'Y' : 'N'}      ${u.falsePositives}    ${u.totalVisits}     ${u.homeErrorAutoOnly}`);
  }

  await writeFile(join(RESULTS_DIR, 'auto-detection-failure.json'), JSON.stringify({
    perUser,
    exposed,
    summary: {
      totalUsers: perUser.length,
      exposedCount: exposed.length,
      exposedHomeFound: exposed.filter(u => u.homeFound).length,
      exposedNoHomeFound: exposed.filter(u => !u.homeFound).length,
    },
  }, null, 2));
  console.log('\nSaved to results/auto-detection-failure.json');
}

main().catch(e => { console.error(e); process.exit(1); });
