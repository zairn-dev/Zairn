/**
 * Synthetic GPS trace generator for trust scorer evaluation.
 *
 * Generates labelled traces (legitimate / spoofed) across 10 scenarios.
 * Uses a seeded PRNG so every run is reproducible.
 *
 * Usage:
 *   node generate-synthetic-traces.mjs            # 1000 per scenario -> stdout
 *   node generate-synthetic-traces.mjs --n 500    # 500 per scenario
 *
 * Exported API:
 *   generateTraces(n)               -> all traces (10 * n)
 *   generateScenario(scenario, n)   -> traces for one scenario
 */

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift128+)
// ---------------------------------------------------------------------------

function createRng(seed) {
  // Convert string seed to two 64-bit-ish state values via simple hash.
  let s0 = 0;
  let s1 = 0;
  for (let i = 0; i < seed.length; i++) {
    s0 = (s0 * 31 + seed.charCodeAt(i)) | 0;
    s1 = (s1 * 37 + seed.charCodeAt(i)) | 0;
  }
  // Ensure non-zero state
  if (s0 === 0) s0 = 0x12345678;
  if (s1 === 0) s1 = 0x9abcdef0;

  function next() {
    let a = s0;
    const b = s1;
    s0 = b;
    a ^= a << 23;
    a ^= a >>> 17;
    a ^= b;
    a ^= b >>> 26;
    s1 = a;
    // Map to [0, 1)
    return ((s0 + s1) >>> 0) / 0x100000000;
  }

  return {
    /** Uniform [0, 1) */
    random: next,
    /** Uniform [lo, hi) */
    uniform(lo, hi) {
      return lo + next() * (hi - lo);
    },
    /** Gaussian (Box-Muller), mean=0, std=1 */
    gaussian() {
      const u1 = next() || 1e-10;
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    /** Integer [lo, hi] inclusive */
    randInt(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    /** Pick one from array */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
  };
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

const DEG_PER_METER_LAT = 1 / 111_320;
function degPerMeterLon(lat) {
  return 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
}

/** Haversine distance in meters */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Move `meters` in a random-ish bearing from (lat, lon). */
function offsetMeters(lat, lon, metersLat, metersLon) {
  return {
    lat: lat + metersLat * DEG_PER_METER_LAT,
    lon: lon + metersLon * degPerMeterLon(lat),
  };
}

// ---------------------------------------------------------------------------
// Point builders
// ---------------------------------------------------------------------------

const BASE_LAT = 35.68;
const BASE_LON = 139.76;

function isoTime(baseMs, offsetSec) {
  return new Date(baseMs + offsetSec * 1000).toISOString();
}

function makeLocationPoint(lat, lon, accuracy, timestamp, speed = null) {
  return { lat, lon, accuracy, timestamp, ...(speed != null ? { speed } : {}) };
}

function makeGpsFix(lat, lon, accuracy, timestamp) {
  return { lat, lon, accuracy, timestamp };
}

function makeNetworkHint(lat, lon, accuracy, source) {
  return { lat, lon, accuracy, source };
}

// ---------------------------------------------------------------------------
// Trajectory generators
// ---------------------------------------------------------------------------

/**
 * Build a trajectory of `count` points moving at `speed` m/s along a bearing
 * with Gaussian jitter. Returns newest-first.
 */
function buildTrajectory(rng, opts) {
  const {
    startLat,
    startLon,
    count,
    intervalSec,
    speedRange,
    accuracyRange,
    jitterMeters,
    bearing, // radians
    baseTimeMs,
  } = opts;

  const points = [];
  let lat = startLat;
  let lon = startLon;

  for (let i = 0; i < count; i++) {
    const acc = rng.uniform(accuracyRange[0], accuracyRange[1]);
    const spd = rng.uniform(speedRange[0], speedRange[1]);
    const dt = intervalSec + rng.gaussian() * 2; // slight timing jitter
    const dist = spd * Math.abs(dt);
    const jx = rng.gaussian() * jitterMeters;
    const jy = rng.gaussian() * jitterMeters;

    lat += dist * Math.cos(bearing) * DEG_PER_METER_LAT + jx * DEG_PER_METER_LAT;
    lon += dist * Math.sin(bearing) * degPerMeterLon(lat) + jy * degPerMeterLon(lat);

    const ts = isoTime(baseTimeMs, -i * intervalSec);
    points.push(makeLocationPoint(lat, lon, acc, ts, spd));
  }

  return points; // newest first (index 0 = most recent)
}

/**
 * Generate `count` raw GPS fixes around a point with jitter.
 */
function buildFixes(rng, lat, lon, accuracyRange, baseTimeMs, count = 5) {
  const fixes = [];
  for (let i = 0; i < count; i++) {
    const jx = rng.gaussian() * 3;
    const jy = rng.gaussian() * 3;
    const { lat: fLat, lon: fLon } = offsetMeters(lat, lon, jx, jy);
    const acc = rng.uniform(accuracyRange[0], accuracyRange[1]);
    fixes.push(makeGpsFix(fLat, fLon, acc, isoTime(baseTimeMs, -i * 2)));
  }
  return fixes;
}

/**
 * Generate a consistent network hint near (lat, lon).
 */
function buildNetworkHint(rng, lat, lon) {
  const source = rng.pick(['ip', 'cell', 'wifi']);
  const accMap = { ip: [5000, 20000], cell: [200, 2000], wifi: [20, 100] };
  const acc = rng.uniform(...accMap[source]);
  const jx = rng.gaussian() * acc * 0.3;
  const jy = rng.gaussian() * acc * 0.3;
  const { lat: hLat, lon: hLon } = offsetMeters(lat, lon, jx, jy);
  return makeNetworkHint(hLat, hLon, acc, source);
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

function startPoint(rng) {
  return {
    lat: BASE_LAT + rng.gaussian() * 0.02,
    lon: BASE_LON + rng.gaussian() * 0.02,
  };
}

// --- Legitimate ---

function genWalking(rng, idx) {
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 30);

  const traj = buildTrajectory(rng, {
    startLat: lat,
    startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [1, 2],
    accuracyRange: [5, 15],
    jitterMeters: 1.5,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [5, 15], baseTimeMs);
  const networkHint = buildNetworkHint(rng, current.lat, current.lon);

  return { label: 'legitimate', scenario: 'walking', current, history, recentFixes, networkHint };
}

function genDriving(rng, idx) {
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);

  const traj = buildTrajectory(rng, {
    startLat: lat,
    startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [10, 30],
    accuracyRange: [10, 30],
    jitterMeters: 3,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [10, 30], baseTimeMs);
  const networkHint = buildNetworkHint(rng, current.lat, current.lon);

  return { label: 'legitimate', scenario: 'driving', current, history, recentFixes, networkHint };
}

function genStationary(rng, idx) {
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(15, 30);

  // Near-zero movement — just GPS drift
  const points = [];
  for (let i = 0; i <= count; i++) {
    const jx = rng.gaussian() * 2;
    const jy = rng.gaussian() * 2;
    const { lat: pLat, lon: pLon } = offsetMeters(lat, lon, jx, jy);
    const acc = rng.uniform(3, 10);
    const spd = Math.abs(rng.gaussian() * 0.1);
    points.push(makeLocationPoint(pLat, pLon, acc, isoTime(baseTimeMs, -i * interval), spd));
  }

  const current = points[0];
  const history = points.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [3, 10], baseTimeMs);
  const networkHint = buildNetworkHint(rng, current.lat, current.lon);

  return { label: 'legitimate', scenario: 'stationary', current, history, recentFixes, networkHint };
}

function genTrain(rng, idx) {
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  // Trains run along relatively straight corridors
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);

  const traj = buildTrajectory(rng, {
    startLat: lat,
    startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [20, 80],
    accuracyRange: [10, 50],
    jitterMeters: 5,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [10, 50], baseTimeMs);
  const networkHint = buildNetworkHint(rng, current.lat, current.lon);

  return { label: 'legitimate', scenario: 'train', current, history, recentFixes, networkHint };
}

// --- Spoofed ---

function genTeleportation(rng, idx) {
  // Build a normal walking history, then place current 100-500km away
  // so current→history[0] shows a massive speed spike
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);
  const bearing = rng.uniform(0, 2 * Math.PI);

  const traj = buildTrajectory(rng, {
    startLat: lat, startLon: lon,
    count,
    intervalSec: interval,
    speedRange: [1, 2],
    accuracyRange: [5, 15],
    jitterMeters: 1.5,
    bearing,
    baseTimeMs: baseTimeMs - interval * 1000, // history starts one interval earlier
  });

  // Teleport: current is far from history[0]
  const jumpDist = rng.uniform(100_000, 500_000);
  const jumpBearing = rng.uniform(0, 2 * Math.PI);
  const jumpedLat = traj[0].lat + jumpDist * Math.cos(jumpBearing) * DEG_PER_METER_LAT;
  const jumpedLon = traj[0].lon + jumpDist * Math.sin(jumpBearing) * degPerMeterLon(traj[0].lat);

  const current = makeLocationPoint(jumpedLat, jumpedLon, rng.uniform(5, 15), isoTime(baseTimeMs, 0), 1.5);
  const history = traj;
  const recentFixes = buildFixes(rng, current.lat, current.lon, [5, 15], baseTimeMs);
  const networkHint = buildNetworkHint(rng, lat, lon); // network still at original location

  return { label: 'spoofed', scenario: 'teleportation', current, history, recentFixes, networkHint };
}

function genDrift(rng, idx) {
  // Aggressive drift: each step adds 200-1000m drift on top of walking.
  // This makes consecutive-pair speed ~20-70 m/s, triggering S1 & S3.
  // Network hint stays at true origin, revealing the drift via S5.
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const count = rng.randInt(7, 10);
  const interval = rng.randInt(10, 20);
  const driftPerStep = rng.uniform(200, 1000); // meters per step — aggressive
  const driftBearing = rng.uniform(0, 2 * Math.PI);

  const points = [];
  let curLat = lat;
  let curLon = lon;
  const walkBearing = rng.uniform(0, 2 * Math.PI);

  for (let i = 0; i <= count; i++) {
    const dist = rng.uniform(1, 2) * interval;
    curLat += dist * Math.cos(walkBearing) * DEG_PER_METER_LAT;
    curLon += dist * Math.sin(walkBearing) * degPerMeterLon(curLat);

    curLat += driftPerStep * Math.cos(driftBearing) * DEG_PER_METER_LAT;
    curLon += driftPerStep * Math.sin(driftBearing) * degPerMeterLon(curLat);

    const acc = rng.uniform(5, 15);
    const spd = rng.uniform(1, 2);
    points.push(makeLocationPoint(curLat, curLon, acc, isoTime(baseTimeMs, -i * interval), spd));
  }

  const current = points[0];
  const history = points.slice(1);
  // Fixes match the drifted position (spoofer controls GPS)
  const recentFixes = buildFixes(rng, current.lat, current.lon, [5, 15], baseTimeMs);
  // Network hint at TRUE origin — reveals drift
  const networkHint = buildNetworkHint(rng, lat, lon);

  return { label: 'spoofed', scenario: 'drift', current, history, recentFixes, networkHint };
}

function genAccuracy(rng, idx) {
  // Suspiciously precise accuracy (< 2m), otherwise normal walking
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);

  const traj = buildTrajectory(rng, {
    startLat: lat,
    startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [1, 2],
    accuracyRange: [0.1, 1.9], // suspiciously precise
    jitterMeters: 0.3,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  // Fixes also suspiciously precise
  const recentFixes = buildFixes(rng, current.lat, current.lon, [0.1, 1.5], baseTimeMs);
  const networkHint = buildNetworkHint(rng, current.lat, current.lon);

  return { label: 'spoofed', scenario: 'accuracy', current, history, recentFixes, networkHint };
}

function genReplay(rng, idx) {
  // Replay attack: all timestamps are the SAME (or near-identical), simulating
  // a replayed packet burst. This triggers S3 (temporal consistency) because
  // dt ≤ 0 between consecutive points → violations.
  const legit = genWalking(rng, idx);
  const baseTs = Date.now();

  // All points get the same timestamp ± 0-1 seconds (replayed burst)
  function collapseTimestamp(p, i) {
    const ts = new Date(baseTs + i * rng.randInt(0, 1) * 1000).toISOString();
    return { ...p, timestamp: ts };
  }

  return {
    label: 'spoofed',
    scenario: 'replay',
    current: collapseTimestamp(legit.current, 0),
    history: legit.history.map((p, i) => collapseTimestamp(p, i)),
    recentFixes: legit.recentFixes.map((f, i) => ({
      ...f,
      timestamp: new Date(baseTs + i * 500).toISOString(),
    })),
    networkHint: legit.networkHint,
  };
}

function genNetworkMismatch(rng, idx) {
  // GPS says Tokyo, network hint says Osaka (>400km apart).
  // Force cell/wifi source (high accuracy) so S5 detects the mismatch strongly.
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);

  const traj = buildTrajectory(rng, {
    startLat: lat, startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [1, 2],
    accuracyRange: [5, 15],
    jitterMeters: 1.5,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [5, 15], baseTimeMs);

  // Network hint: Osaka area with cell/wifi accuracy (200-2000m)
  // GPS→network distance ~400km >> accuracy, so S5 gives 0.3
  const osakaLat = 34.69 + rng.gaussian() * 0.01;
  const osakaLon = 135.50 + rng.gaussian() * 0.01;
  const source = rng.pick(['cell', 'wifi']);
  const accMap = { cell: [200, 2000], wifi: [20, 100] };
  const networkHint = makeNetworkHint(osakaLat, osakaLon, rng.uniform(...accMap[source]), source);

  return { label: 'spoofed', scenario: 'network_mismatch', current, history, recentFixes, networkHint };
}

function genCompound(rng, idx) {
  // Accuracy manipulation + network mismatch combined
  const { lat, lon } = startPoint(rng);
  const baseTimeMs = Date.UTC(2026, 0, 1) + idx * 60_000;
  const bearing = rng.uniform(0, 2 * Math.PI);
  const count = rng.randInt(5, 10);
  const interval = rng.randInt(10, 20);

  // Suspiciously precise (accuracy manipulation)
  const traj = buildTrajectory(rng, {
    startLat: lat,
    startLon: lon,
    count: count + 1,
    intervalSec: interval,
    speedRange: [1, 2],
    accuracyRange: [0.1, 1.9],
    jitterMeters: 0.3,
    bearing,
    baseTimeMs,
  });

  const current = traj[0];
  const history = traj.slice(1);
  const recentFixes = buildFixes(rng, current.lat, current.lon, [0.1, 1.5], baseTimeMs);

  // Network mismatch: Osaka with cell/wifi (high accuracy)
  const osakaLat = 34.69 + rng.gaussian() * 0.01;
  const osakaLon = 135.50 + rng.gaussian() * 0.01;
  const source = rng.pick(['cell', 'wifi']);
  const accMap = { cell: [200, 2000], wifi: [20, 100] };
  const networkHint = makeNetworkHint(osakaLat, osakaLon, rng.uniform(...accMap[source]), source);

  return { label: 'spoofed', scenario: 'compound', current, history, recentFixes, networkHint };
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

const SCENARIO_GENERATORS = {
  walking: genWalking,
  driving: genDriving,
  stationary: genStationary,
  train: genTrain,
  teleportation: genTeleportation,
  drift: genDrift,
  accuracy: genAccuracy,
  replay: genReplay,
  network_mismatch: genNetworkMismatch,
  compound: genCompound,
};

const ALL_SCENARIOS = Object.keys(SCENARIO_GENERATORS);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate traces for a single scenario.
 * @param {string} scenario - One of the scenario names
 * @param {number} n - Number of traces to generate
 * @returns {Array} Array of trace objects
 */
export function generateScenario(scenario, n = 1000) {
  const gen = SCENARIO_GENERATORS[scenario];
  if (!gen) {
    throw new Error(`Unknown scenario: ${scenario}. Valid: ${ALL_SCENARIOS.join(', ')}`);
  }

  const traces = [];
  for (let i = 0; i < n; i++) {
    const rng = createRng(`${scenario}-${i}`);
    traces.push(gen(rng, i));
  }
  return traces;
}

/**
 * Generate traces for all scenarios.
 * @param {number} n - Number of traces per scenario
 * @returns {Array} Array of trace objects (10 * n total)
 */
export function generateTraces(n = 1000) {
  const traces = [];
  for (const scenario of ALL_SCENARIOS) {
    traces.push(...generateScenario(scenario, n));
  }
  return traces;
}

/** List of all scenario names */
export { ALL_SCENARIOS };

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('generate-synthetic-traces.mjs') ||
    process.argv[1].replace(/\\/g, '/').endsWith('generate-synthetic-traces.mjs'));

if (isMain) {
  let n = 1000;
  const nIdx = process.argv.indexOf('--n');
  if (nIdx !== -1 && process.argv[nIdx + 1]) {
    n = parseInt(process.argv[nIdx + 1], 10);
    if (isNaN(n) || n < 1) {
      process.stderr.write('Error: --n must be a positive integer\n');
      process.exit(1);
    }
  }

  const traces = generateTraces(n);

  // Summary to stderr so stdout is pure JSON
  const counts = {};
  for (const t of traces) {
    const key = `${t.label}/${t.scenario}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  process.stderr.write(`Generated ${traces.length} traces (${n} per scenario):\n`);
  for (const [key, count] of Object.entries(counts)) {
    process.stderr.write(`  ${key}: ${count}\n`);
  }

  process.stdout.write(JSON.stringify(traces));
}
