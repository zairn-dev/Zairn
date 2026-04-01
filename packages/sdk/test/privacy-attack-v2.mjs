/**
 * Privacy Attack Simulation v2 — Tests the full 6-layer system
 *
 * Compares 5 methods against home/work inference attacks:
 * 1. Raw (no protection)
 * 2. Random Gaussian noise (500m σ)
 * 3. Grid snap only (deterministic, no DP)
 * 4. Planar Laplace + grid snap (formal DP, no zones)
 * 5. Full system (Laplace + grid + zones + adaptive reporting)
 */

import {
  addPlanarLaplaceNoise,
  gridSnap,
  processLocation,
  detectSensitivePlaces,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../dist/privacy-location.js';

const HOME = { lat: 35.6812, lon: 139.7671 };
const WORK = { lat: 35.6580, lon: 139.7016 };
const DAYS = 60;
const SEED = 'victim-user-seed-abc123';
const BASE_EPSILON = Math.LN2 / 500;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function gaussNoise(lat, lon, sigmaM) {
  const u1 = Math.random(), u2 = Math.random();
  const g1 = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
  const g2 = Math.sqrt(-2*Math.log(u1)) * Math.sin(2*Math.PI*u2);
  return { lat: lat + g1*sigmaM/111320, lon: lon + g2*sigmaM/(111320*Math.cos(lat*Math.PI/180)) };
}

// Generate daily pattern
function generateDay(day) {
  const locs = [];
  const d = new Date(2026, 0, day + 1);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  for (let h = 0; h < 24; h++) {
    d.setHours(h, 0, 0, 0);
    let lat, lon;
    if (h >= 0 && h < 7) { lat = HOME.lat + (Math.random()-0.5)*0.0003; lon = HOME.lon + (Math.random()-0.5)*0.0003; }
    else if (h >= 8 && h < 18 && !isWeekend) { lat = WORK.lat + (Math.random()-0.5)*0.0003; lon = WORK.lon + (Math.random()-0.5)*0.0003; }
    else if (h === 7) { lat = HOME.lat + (WORK.lat-HOME.lat)*0.5 + (Math.random()-0.5)*0.005; lon = HOME.lon + (WORK.lon-HOME.lon)*0.5 + (Math.random()-0.5)*0.005; }
    else if (h === 18) { lat = WORK.lat + (HOME.lat-WORK.lat)*0.5 + (Math.random()-0.5)*0.005; lon = WORK.lon + (HOME.lon-WORK.lon)*0.5 + (Math.random()-0.5)*0.005; }
    else { lat = HOME.lat + (Math.random()-0.5)*0.01; lon = HOME.lon + (Math.random()-0.5)*0.01; }
    locs.push({ lat, lon, hour: h, day, isWeekend, timestamp: d.toISOString() });
  }
  return locs;
}

// Generate all data
const allLocs = [];
for (let d = 0; d < DAYS; d++) allLocs.push(...generateDay(d));

// Detect sensitive places
const training = allLocs.filter(l => l.day < 14).map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));
const sensitivePlaces = detectSensitivePlaces(training, { ...DEFAULT_PRIVACY_CONFIG, minVisitsForSensitive: 3, minDwellMinutes: 30 });
console.log(`Detected ${sensitivePlaces.length} sensitive places:`);
sensitivePlaces.forEach(p => console.log(`  ${p.label}: ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`));

// Apply each method
const methods = {};

// 1. Raw
methods.raw = allLocs.map(l => ({ ...l, sLat: l.lat, sLon: l.lon }));

// 2. Gaussian noise
methods.gaussian = allLocs.map(l => { const n = gaussNoise(l.lat, l.lon, 500); return { ...l, sLat: n.lat, sLon: n.lon }; });

// 3. Grid snap only
methods.gridOnly = allLocs.map(l => { const s = gridSnap(l.lat, l.lon, 500, SEED); return { ...l, sLat: s.lat, sLon: s.lon }; });

// 4. Planar Laplace + grid snap (no zones)
methods.laplace = allLocs.map(l => {
  const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
  const s = gridSnap(n.lat, n.lon, 500, SEED);
  return { ...l, sLat: s.lat, sLon: s.lon };
});

// 5. Full system
const config = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: SEED, baseEpsilon: BASE_EPSILON };
const reporter = new AdaptiveReporter(12, 2);
methods.full = [];
for (const l of allLocs) {
  const result = processLocation(l.lat, l.lon, sensitivePlaces, config, reporter);
  if (result.type === 'coarse') {
    methods.full.push({ ...l, sLat: result.lat, sLon: result.lon });
  }
  // state/suppressed/proximity → no coordinates shared
}

// Attack functions
function centroidAttack(obs, filterFn, targetLat, targetLon) {
  const filtered = obs.filter(filterFn);
  if (filtered.length === 0) return { error: Infinity, count: 0 };
  const avgLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const avgLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(avgLat, avgLon, targetLat, targetLon)), count: filtered.length };
}

function convergenceTest(obs, filterFn, targetLat, targetLon) {
  const filtered = obs.filter(filterFn);
  const results = [];
  for (const d of [1, 3, 7, 14, 30, 60]) {
    const sub = filtered.filter(o => o.day < d);
    if (sub.length === 0) { results.push({ days: d, error: Infinity, count: 0 }); continue; }
    const aLat = sub.reduce((s, o) => s + o.sLat, 0) / sub.length;
    const aLon = sub.reduce((s, o) => s + o.sLon, 0) / sub.length;
    results.push({ days: d, error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: sub.length });
  }
  return results;
}

// Run attacks
console.log('\n=== HOME INFERENCE (nighttime centroid, hours 22-6) ===\n');
const nightFilter = o => o.hour >= 22 || o.hour < 6;
for (const [name, obs] of Object.entries(methods)) {
  const { error, count } = centroidAttack(obs, nightFilter, HOME.lat, HOME.lon);
  const safe = error > 500 ? '✅ SAFE' : error > 200 ? '⚠️ MARGINAL' : '❌ EXPOSED';
  console.log(`${name.padEnd(15)} ${String(error).padStart(7)}m  (${count} obs)  ${safe}`);
}

console.log('\n=== WORK INFERENCE (weekday 9-17 centroid) ===\n');
const workFilter = o => !o.isWeekend && o.hour >= 9 && o.hour < 17;
for (const [name, obs] of Object.entries(methods)) {
  const { error, count } = centroidAttack(obs, workFilter, WORK.lat, WORK.lon);
  const safe = error > 500 ? '✅ SAFE' : error > 200 ? '⚠️ MARGINAL' : '❌ EXPOSED';
  console.log(`${name.padEnd(15)} ${String(error).padStart(7)}m  (${count} obs)  ${safe}`);
}

console.log('\n=== CONVERGENCE OVER TIME (home, nighttime) ===\n');
for (const [name, obs] of Object.entries(methods)) {
  console.log(`${name}:`);
  const conv = convergenceTest(obs, nightFilter, HOME.lat, HOME.lon);
  for (const c of conv) {
    const bar = '█'.repeat(Math.min(50, Math.round(c.error / 50)));
    console.log(`  ${String(c.days).padStart(3)}d  ${String(c.count).padStart(4)} obs  ${String(c.error).padStart(7)}m  ${bar}`);
  }
}

console.log('\n=== OBSERVATION COUNTS ===\n');
for (const [name, obs] of Object.entries(methods)) {
  const total = obs.length;
  const night = obs.filter(nightFilter).length;
  const work = obs.filter(workFilter).length;
  const reduction = ((1 - total / methods.raw.length) * 100).toFixed(1);
  console.log(`${name.padEnd(15)} total: ${String(total).padStart(5)}  night: ${String(night).padStart(4)}  work: ${String(work).padStart(4)}  (${reduction}% reduction)`);
}
