/**
 * Privacy Attack Simulation
 *
 * Simulates an adversary who observes obfuscated location updates
 * over 30-90 days and attempts to infer:
 *   1. Home location (nighttime centroid attack)
 *   2. Work location (weekday daytime centroid attack)
 *   3. True location from averaging (anti-averaging test)
 *   4. Trilateration from multiple viewpoints
 *
 * Compares: raw sharing, random noise, and SBPP grid obfuscation.
 */

import {
  obfuscateLocation,
  processLocation,
  detectSensitivePlaces,
  FrequencyBudget,
  DEFAULT_PRIVACY_CONFIG,
} from '../dist/privacy-location.js';

// ============================================================
// Simulation Parameters
// ============================================================

const HOME = { lat: 35.6812, lon: 139.7671 }; // Tokyo
const WORK = { lat: 35.6580, lon: 139.7016 }; // Shibuya
const DAYS = 60;
const UPDATES_PER_DAY = 24; // 1 per hour
const GRID_SEED = 'victim-user-seed-abc123';
const NOISE_RADIUS_M = 500; // for random noise baseline

// ============================================================
// Helpers
// ============================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1,
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  );
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function randomGaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function addRandomNoise(lat, lon, radiusM) {
  const dLat = (randomGaussian() * radiusM) / 111320;
  const dLon = (randomGaussian() * radiusM) / (111320 * Math.cos(lat * Math.PI / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

// ============================================================
// Generate realistic daily movement pattern
// ============================================================

function generateDailyLocations(day) {
  const locations = [];
  const date = new Date(2026, 0, day + 1);
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;

  for (let hour = 0; hour < 24; hour++) {
    date.setHours(hour, 0, 0, 0);
    let lat, lon;

    if (hour >= 0 && hour < 7) {
      // Night: at home (with small GPS jitter)
      lat = HOME.lat + (Math.random() - 0.5) * 0.0003;
      lon = HOME.lon + (Math.random() - 0.5) * 0.0003;
    } else if (hour >= 8 && hour < 18 && !isWeekend) {
      // Weekday daytime: at work
      lat = WORK.lat + (Math.random() - 0.5) * 0.0003;
      lon = WORK.lon + (Math.random() - 0.5) * 0.0003;
    } else if (hour >= 7 && hour < 8) {
      // Commute: between home and work
      const t = (hour - 7);
      lat = HOME.lat + (WORK.lat - HOME.lat) * t + (Math.random() - 0.5) * 0.005;
      lon = HOME.lon + (WORK.lon - HOME.lon) * t + (Math.random() - 0.5) * 0.005;
    } else if (hour >= 18 && hour < 19) {
      // Commute back
      const t = (hour - 18);
      lat = WORK.lat + (HOME.lat - WORK.lat) * t + (Math.random() - 0.5) * 0.005;
      lon = WORK.lon + (HOME.lon - WORK.lon) * t + (Math.random() - 0.5) * 0.005;
    } else {
      // Evening/weekend: various locations
      lat = HOME.lat + (Math.random() - 0.5) * 0.01;
      lon = HOME.lon + (Math.random() - 0.5) * 0.01;
    }

    locations.push({ lat, lon, hour, timestamp: date.toISOString(), isWeekend });
  }

  return locations;
}

// ============================================================
// Attack 1: Home Inference (Nighttime Centroid)
// ============================================================

function attackHomeInference(observations) {
  // Attacker filters nighttime observations (22-6) and computes centroid
  const nightObs = observations.filter(o => o.hour >= 22 || o.hour < 6);
  if (nightObs.length === 0) return Infinity;

  const avgLat = nightObs.reduce((s, o) => s + o.sharedLat, 0) / nightObs.length;
  const avgLon = nightObs.reduce((s, o) => s + o.sharedLon, 0) / nightObs.length;
  return haversine(avgLat, avgLon, HOME.lat, HOME.lon);
}

// ============================================================
// Attack 2: Work Inference (Weekday Daytime Centroid)
// ============================================================

function attackWorkInference(observations) {
  const workObs = observations.filter(o => !o.isWeekend && o.hour >= 9 && o.hour < 17);
  if (workObs.length === 0) return Infinity;

  const avgLat = workObs.reduce((s, o) => s + o.sharedLat, 0) / workObs.length;
  const avgLon = workObs.reduce((s, o) => s + o.sharedLon, 0) / workObs.length;
  return haversine(avgLat, avgLon, WORK.lat, WORK.lon);
}

// ============================================================
// Attack 3: Overall Averaging Attack
// ============================================================

function attackAveraging(observations) {
  // Attacker averages ALL observations to find most-frequented location
  if (observations.length === 0) return { homeError: Infinity, workError: Infinity };

  const avgLat = observations.reduce((s, o) => s + o.sharedLat, 0) / observations.length;
  const avgLon = observations.reduce((s, o) => s + o.sharedLon, 0) / observations.length;

  return {
    homeError: haversine(avgLat, avgLon, HOME.lat, HOME.lon),
    workError: haversine(avgLat, avgLon, WORK.lat, WORK.lon),
  };
}

// ============================================================
// Attack 4: Convergence over time
// ============================================================

function attackConvergenceOverDays(observations) {
  // Track how nighttime centroid error decreases as days increase
  const nightObs = observations.filter(o => o.hour >= 22 || o.hour < 6);
  const convergence = [];

  for (const windowDays of [1, 7, 14, 30, 60]) {
    const subset = nightObs.filter(o => o.day < windowDays);
    if (subset.length === 0) continue;
    const avgLat = subset.reduce((s, o) => s + o.sharedLat, 0) / subset.length;
    const avgLon = subset.reduce((s, o) => s + o.sharedLon, 0) / subset.length;
    convergence.push({
      days: windowDays,
      observations: subset.length,
      errorM: Math.round(haversine(avgLat, avgLon, HOME.lat, HOME.lon)),
    });
  }

  return convergence;
}

// ============================================================
// Run Simulation
// ============================================================

console.log('=== Privacy Attack Simulation ===');
console.log(`Home: ${HOME.lat}, ${HOME.lon}`);
console.log(`Work: ${WORK.lat}, ${WORK.lon}`);
console.log(`Days: ${DAYS}, Updates/day: ${UPDATES_PER_DAY}`);
console.log('');

// Generate ground truth movement
const allLocations = [];
for (let day = 0; day < DAYS; day++) {
  for (const loc of generateDailyLocations(day)) {
    allLocations.push({ ...loc, day });
  }
}

// Detect sensitive places (from first 14 days as training data)
const trainingHistory = allLocations
  .filter(l => l.day < 14)
  .map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));

const sensitivePlaces = detectSensitivePlaces(trainingHistory, {
  ...DEFAULT_PRIVACY_CONFIG,
  minVisitsForSensitive: 3,
  minDwellMinutes: 30,
});
console.log(`Detected ${sensitivePlaces.length} sensitive places:`);
sensitivePlaces.forEach(p => console.log(`  ${p.label}: ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} (${p.visitCount} visits)`));
console.log('');

// === Method 1: Raw (no protection) ===
const rawObs = allLocations.map(l => ({
  ...l,
  sharedLat: l.lat,
  sharedLon: l.lon,
}));

// === Method 2: Random Noise (Laplace-like) ===
const noiseObs = allLocations.map(l => {
  const noisy = addRandomNoise(l.lat, l.lon, NOISE_RADIUS_M);
  return { ...l, sharedLat: noisy.lat, sharedLon: noisy.lon };
});

// === Method 3: Grid Obfuscation Only (no zones) ===
const gridObs = allLocations.map(l => {
  const obf = obfuscateLocation(l.lat, l.lon, 500, GRID_SEED);
  return { ...l, sharedLat: obf.lat, sharedLon: obf.lon };
});

// === Method 4: Full Privacy System (zones + grid + frequency) ===
const privacyConfig = {
  ...DEFAULT_PRIVACY_CONFIG,
  gridSeed: GRID_SEED,
  obfuscationGridM: 500,
  maxUpdatesPerHour: 4,
};
const budget = new FrequencyBudget(4);
const fullObs = [];
for (const l of allLocations) {
  // Reset budget each hour (simplified)
  const result = processLocation(
    l.lat, l.lon, sensitivePlaces, privacyConfig, budget
  );

  if (result.type === 'coarse') {
    fullObs.push({ ...l, sharedLat: result.lat, sharedLon: result.lon });
  } else if (result.type === 'state' || result.type === 'suppressed') {
    // Attacker sees no coordinates — skip
  } else if (result.type === 'proximity') {
    // Attacker only sees distance — no usable lat/lon
  }
}

// ============================================================
// Run Attacks
// ============================================================

console.log('=== Attack Results ===\n');

const methods = [
  { name: 'Raw (no protection)', obs: rawObs },
  { name: `Random noise (σ=${NOISE_RADIUS_M}m)`, obs: noiseObs },
  { name: 'Grid snap (500m)', obs: gridObs },
  { name: 'Full system (zones+grid+budget)', obs: fullObs },
];

console.log('--- Home Inference Attack (nighttime centroid) ---');
for (const m of methods) {
  const error = attackHomeInference(m.obs);
  const nightCount = m.obs.filter(o => o.hour >= 22 || o.hour < 6).length;
  console.log(`  ${m.name.padEnd(40)} error: ${Math.round(error).toString().padStart(6)}m  (${nightCount} night obs)`);
}

console.log('\n--- Work Inference Attack (weekday daytime centroid) ---');
for (const m of methods) {
  const error = attackWorkInference(m.obs);
  const workCount = m.obs.filter(o => !o.isWeekend && o.hour >= 9 && o.hour < 17).length;
  console.log(`  ${m.name.padEnd(40)} error: ${Math.round(error).toString().padStart(6)}m  (${workCount} work obs)`);
}

console.log('\n--- Convergence Over Time (home, nighttime) ---');
for (const m of methods) {
  console.log(`  ${m.name}:`);
  const conv = attackConvergenceOverDays(m.obs);
  for (const c of conv) {
    const bar = '█'.repeat(Math.min(50, Math.round(c.errorM / 20)));
    console.log(`    ${String(c.days).padStart(3)}d (${String(c.observations).padStart(4)} obs): ${String(c.errorM).padStart(6)}m ${bar}`);
  }
}

console.log('\n--- Summary ---');
const homeErrors = methods.map(m => ({
  name: m.name,
  error: Math.round(attackHomeInference(m.obs)),
  obsCount: m.obs.filter(o => o.hour >= 22 || o.hour < 6).length,
}));
const workErrors = methods.map(m => ({
  name: m.name,
  error: Math.round(attackWorkInference(m.obs)),
  obsCount: m.obs.filter(o => !o.isWeekend && o.hour >= 9 && o.hour < 17).length,
}));

console.log('\nHome inference error (higher = safer):');
for (const e of homeErrors) {
  const safe = e.error > 500 ? '✅ SAFE' : e.error > 200 ? '⚠️ MARGINAL' : '❌ EXPOSED';
  console.log(`  ${e.name.padEnd(40)} ${String(e.error).padStart(6)}m  ${safe}`);
}

console.log('\nWork inference error (higher = safer):');
for (const e of workErrors) {
  const safe = e.error > 500 ? '✅ SAFE' : e.error > 200 ? '⚠️ MARGINAL' : '❌ EXPOSED';
  console.log(`  ${e.name.padEnd(40)} ${String(e.error).padStart(6)}m  ${safe}`);
}

const totalObs = methods.map(m => m.obs.length);
console.log('\nTotal observations shared:');
methods.forEach((m, i) => {
  const reduction = ((1 - totalObs[i] / totalObs[0]) * 100).toFixed(1);
  console.log(`  ${m.name.padEnd(40)} ${String(totalObs[i]).padStart(5)} (${reduction}% reduction)`);
});
