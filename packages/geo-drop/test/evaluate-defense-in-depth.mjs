/**
 * Defense-in-Depth Evaluation: Trust Scorer + ZKP Integration
 *
 * Part 1: Combined decision matrix — shows how the trust scorer complements
 *         ZKP verification to handle GPS spoofing, marginal signals, etc.
 *
 * Part 2: Naive hash baseline — compares privacy/cost tradeoff between
 *         GPS, H(coordinates), and ZKP verification approaches.
 *
 * Part 3: Threshold sensitivity analysis — shows how varying the `proceed`
 *         threshold affects which attacks are caught vs honest users blocked.
 *
 * Paper sections: §7.5 Baseline Comparison, §7.6 Defense-in-Depth Analysis
 */

import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

// ═════════════════════════════════════════════════════════════
// Trust Scorer (inlined from src/trust-scorer.ts)
// Weights and thresholds match the TypeScript implementation exactly.
// ═════════════════════════════════════════════════════════════

const WEIGHT_MOVEMENT = 0.5;
const WEIGHT_ACCURACY = 0.2;
const WEIGHT_TEMPORAL = 0.3;

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2
  );
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreMovement(current, history) {
  if (history.length === 0) return 0.8;
  const prev = history[0];
  const dist = calculateDistance(prev.lat, prev.lon, current.lat, current.lon);
  const dtMs = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();
  if (dtMs <= 0) return 0.0;
  const speed = dist / (dtMs / 1000);
  if (speed <= 50) return 1.0;
  if (speed <= 150) return 1.0 - 0.5 * ((speed - 50) / 100);
  if (speed <= 300) return 0.5 - 0.4 * ((speed - 150) / 150);
  return 0.0;
}

function scoreAccuracy(current) {
  const acc = current.accuracy;
  if (acc === null || acc === undefined) return 0.5;
  if (acc < 2) return 0.3;
  if (acc <= 100) return 1.0;
  if (acc <= 500) return 0.7;
  return 0.4;
}

function scoreTemporalConsistency(current, history) {
  if (history.length < 2) return 0.7;
  const points = [current, ...history.slice(0, 4)];
  let violations = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = calculateDistance(a.lat, a.lon, b.lat, b.lon);
    const dt = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (dt <= 0) { violations++; continue; }
    if (dist / (dt / 1000) > 100) violations++;
  }
  if (violations === 0) return 1.0;
  if (violations === 1) return 0.6;
  if (violations === 2) return 0.3;
  return 0.0;
}

function computeTrustScore(current, history) {
  const movementPlausibility = scoreMovement(current, history);
  const accuracyAnomaly = scoreAccuracy(current);
  const temporalConsistency = scoreTemporalConsistency(current, history);
  const raw =
    WEIGHT_MOVEMENT * movementPlausibility +
    WEIGHT_ACCURACY * accuracyAnomaly +
    WEIGHT_TEMPORAL * temporalConsistency;
  const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals: { movementPlausibility, accuracyAnomaly, temporalConsistency },
  };
}

function gateTrustScore(result, thresholds = {}) {
  const t = { proceed: 0.7, stepUp: 0.3, ...thresholds };
  if (result.trustScore >= t.proceed) return 'proceed';
  if (result.trustScore >= t.stepUp) return 'step-up';
  return 'deny';
}

// ═════════════════════════════════════════════════════════════
// Trust Scorer V2 (inlined from src/trust-scorer.ts)
// Adds RAIM-style fix consistency + network cross-check signals.
// ═════════════════════════════════════════════════════════════

function scoreFixConsistency(recentFixes) {
  if (recentFixes.length < 3) return 0.8;
  const n = recentFixes.length;
  const meanLat = recentFixes.reduce((s, f) => s + f.lat, 0) / n;
  const meanLon = recentFixes.reduce((s, f) => s + f.lon, 0) / n;
  const meanAcc = recentFixes.reduce((s, f) => s + f.accuracy, 0) / n;
  const varLat = recentFixes.reduce((s, f) => s + (f.lat - meanLat) ** 2, 0) / n;
  const varLon = recentFixes.reduce((s, f) => s + (f.lon - meanLon) ** 2, 0) / n;
  const stdLatM = Math.sqrt(varLat) * 111320;
  const stdLonM = Math.sqrt(varLon) * 111320 * Math.cos((meanLat * Math.PI) / 180);
  const maxStd = Math.max(stdLatM, stdLonM);
  if (meanAcc <= 0) return 0.5;
  const ratio = maxStd / meanAcc;
  if (ratio <= 0.5) return 1.0;
  if (ratio <= 1.0) return 1.0 - 0.3 * ((ratio - 0.5) / 0.5);
  if (ratio <= 2.0) return 0.7 - 0.3 * ((ratio - 1.0) / 1.0);
  return 0.2;
}

function scoreNetworkConsistency(current, hint) {
  const dist = calculateDistance(current.lat, current.lon, hint.lat, hint.lon);
  if (dist < hint.accuracy) return 1.0;
  if (dist < 2 * hint.accuracy) return 0.7;
  if (dist < 5 * hint.accuracy) return 0.5;
  return 0.3;
}

function computeTrustScoreV2(current, history, context) {
  const hasFixes = context?.recentFixes && context.recentFixes.length > 0;
  const hasNetwork = context?.networkHint != null;

  if (!hasFixes && !hasNetwork) {
    return computeTrustScore(current, history);
  }

  const movementPlausibility = scoreMovement(current, history);
  const accuracyAnomaly = scoreAccuracy(current);
  const temporalConsistency = scoreTemporalConsistency(current, history);

  let fixConsistency, networkConsistency;
  let wM, wA, wT, wF, wN;

  if (hasFixes && hasNetwork) {
    wM = 0.30; wA = 0.10; wT = 0.15; wF = 0.25; wN = 0.20;
    fixConsistency = scoreFixConsistency(context.recentFixes);
    networkConsistency = scoreNetworkConsistency(current, context.networkHint);
  } else if (hasFixes) {
    wM = 0.35; wA = 0.15; wT = 0.20; wF = 0.30; wN = 0;
    fixConsistency = scoreFixConsistency(context.recentFixes);
  } else {
    wM = 0.40; wA = 0.15; wT = 0.20; wF = 0; wN = 0.25;
    networkConsistency = scoreNetworkConsistency(current, context.networkHint);
  }

  const raw =
    wM * movementPlausibility +
    wA * accuracyAnomaly +
    wT * temporalConsistency +
    wF * (fixConsistency ?? 0) +
    wN * (networkConsistency ?? 0);

  const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;

  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals: {
      movementPlausibility, accuracyAnomaly, temporalConsistency,
      ...(fixConsistency !== undefined && { fixConsistency }),
      ...(networkConsistency !== undefined && { networkConsistency }),
    },
  };
}

// ═════════════════════════════════════════════════════════════
// ZKP helpers
// ═════════════════════════════════════════════════════════════

// BN128 field prime — snarkjs reduces all inputs modulo this value
const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToDecimal(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

function buildStatement({ dropId, policyVersion = '1', epoch, serverNonce }) {
  return {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  };
}

const SCALE = 1_000_000;
const toFP = (deg) => BigInt(Math.round(deg * SCALE));
const metersToR2 = (m) => {
  const r = BigInt(Math.round((m / 111320) * SCALE));
  return (r * r).toString();
};
const cosLatS = (lat) =>
  BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

function makePoint(lat, lon, minutesAgo, accuracy = 10) {
  return {
    lat,
    lon,
    accuracy,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════
// Part 1: Defense-in-Depth — Trust Scorer + ZKP
// ═════════════════════════════════════════════════════════════

async function runDefenseInDepth() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Part 1: Defense-in-Depth — Trust Scorer + ZKP');
  console.log('═══════════════════════════════════════════════════════════\n');

  const TARGET_LAT = 35.6586;
  const TARGET_LON = 139.7454;
  const UNLOCK_RADIUS = 50;

  const zairnWasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zairnZkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');
  const vkey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));

  const context = { dropId: 'defense-test', policyVersion: '1', epoch: 42, serverNonce: 'nonce-defense' };
  const stmt = buildStatement(context);

  const geoInput = {
    targetLat: toFP(TARGET_LAT).toString(),
    targetLon: toFP(TARGET_LON).toString(),
    radiusSquared: metersToR2(UNLOCK_RADIUS),
    cosLatScaled: cosLatS(TARGET_LAT),
  };

  // Attack scenarios
  const scenarios = [
    {
      name: 'Normal user',
      description: 'Steady walk, 30m from drop, accuracy=10m',
      current: makePoint(35.6589, 139.7457, 0, 10),
      history: [
        makePoint(35.65885, 139.74565, 1, 12),
        makePoint(35.6588, 139.7456, 2, 11),
        makePoint(35.65875, 139.74555, 3, 10),
      ],
      userLat: 35.6589,
      userLon: 139.7457,
      withinRange: true,
    },
    {
      name: 'Teleporter (GPS spoof)',
      description: 'Rapid teleportation pattern (Tokyo↔Osaka)',
      current: makePoint(35.6589, 139.7457, 0, null), // Tokyo, null accuracy
      history: [
        makePoint(34.6937, 135.5023, 1, 15), // Osaka 1 min ago
        makePoint(35.6588, 139.7456, 2, 10),  // Tokyo 2 min ago
        makePoint(34.6938, 135.5024, 3, 14),  // Osaka 3 min ago
      ],
      userLat: 35.6589,
      userLon: 139.7457,
      withinRange: true,
    },
    {
      name: 'Marginal GPS (indoor)',
      description: 'High accuracy values, slight jitter',
      current: makePoint(35.6589, 139.7457, 0, 200),
      history: [
        makePoint(35.6590, 139.7458, 1, 250),
        makePoint(35.6588, 139.7456, 2, 180),
        makePoint(35.6591, 139.7459, 3, 300),
      ],
      userLat: 35.6589,
      userLon: 139.7457,
      withinRange: true,
    },
    {
      name: 'Precise spoofer',
      description: 'Realistic speed but suspiciously exact accuracy (<2m)',
      current: makePoint(35.6589, 139.7457, 0, 0.5),
      history: [
        makePoint(35.65885, 139.74565, 1, 0.8),
        makePoint(35.6588, 139.7456, 2, 0.6),
        makePoint(35.65875, 139.74555, 3, 0.7),
      ],
      userLat: 35.6589,
      userLon: 139.7457,
      withinRange: true,
    },
    {
      name: 'Out-of-range honest user',
      description: '100m from drop, good GPS history',
      current: makePoint(35.6595, 139.7465, 0, 10),
      history: [
        makePoint(35.6594, 139.7464, 1, 12),
        makePoint(35.6593, 139.7463, 2, 11),
        makePoint(35.6592, 139.7462, 3, 10),
      ],
      userLat: 35.6595,
      userLon: 139.7465,
      withinRange: false,
    },
    {
      name: 'VPN spoofer',
      description: 'Normal GPS movement, but IP geolocates to San Francisco',
      current: makePoint(35.6589, 139.7457, 0, 10),
      history: [
        makePoint(35.65885, 139.74565, 1, 12),
        makePoint(35.6588, 139.7456, 2, 11),
        makePoint(35.65875, 139.74555, 3, 10),
      ],
      userLat: 35.6589,
      userLon: 139.7457,
      withinRange: true,
      v2Context: {
        recentFixes: [
          { lat: 35.68900, lon: 139.74570, accuracy: 10, timestamp: new Date(Date.now() - 0).toISOString() },
          { lat: 35.68901, lon: 139.74571, accuracy: 10, timestamp: new Date(Date.now() - 30000).toISOString() },
          { lat: 35.68899, lon: 139.74569, accuracy: 10, timestamp: new Date(Date.now() - 60000).toISOString() },
        ],
        networkHint: { lat: 37.7749, lon: -122.4194, accuracy: 5000, source: 'ip' }, // San Francisco
      },
    },
  ];

  const results = [];

  for (const sc of scenarios) {
    // Trust scoring
    const trustT0 = performance.now();
    const trustResult = computeTrustScore(sc.current, sc.history);
    const trustMs = performance.now() - trustT0;
    const gate = gateTrustScore(trustResult);

    // ZKP proving
    let zkpResult = 'N/A';
    let proveMs = 0;
    let verifyMs = 0;

    const zkpInput = {
      ...geoInput,
      userLat: toFP(sc.userLat).toString(),
      userLon: toFP(sc.userLon).toString(),
      contextDigest: stmt.contextDigest,
      epoch: stmt.epoch,
      challengeDigest: stmt.challengeDigest,
    };

    try {
      const pt0 = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        zkpInput,
        zairnWasm,
        zairnZkey
      );
      proveMs = performance.now() - pt0;

      const vt0 = performance.now();
      const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
      verifyMs = performance.now() - vt0;
      zkpResult = ok ? 'valid' : 'invalid';
    } catch {
      zkpResult = 'FAIL (circuit unsatisfiable)';
    }

    // V2 scoring (with context if available)
    const v2Context = sc.v2Context || {
      recentFixes: sc.history.map(h => ({ lat: h.lat, lon: h.lon, accuracy: h.accuracy || 10, timestamp: h.timestamp })),
      networkHint: { lat: sc.current.lat + 0.001, lon: sc.current.lon + 0.001, accuracy: 500, source: 'wifi' },
    };
    const trustV2 = computeTrustScoreV2(sc.current, sc.history, v2Context);
    const gateV2 = gateTrustScore(trustV2);

    // Combined decision (V1)
    let combined;
    if (gate === 'deny') combined = 'BLOCKED (trust)';
    else if (zkpResult !== 'valid') combined = 'BLOCKED (zkp)';
    else if (gate === 'step-up') combined = 'STEP-UP required';
    else combined = 'UNLOCK';

    // Combined decision (V2)
    let combinedV2;
    if (gateV2 === 'deny') combinedV2 = 'BLOCKED (trust)';
    else if (zkpResult !== 'valid') combinedV2 = 'BLOCKED (zkp)';
    else if (gateV2 === 'step-up') combinedV2 = 'STEP-UP required';
    else combinedV2 = 'UNLOCK';

    results.push({
      name: sc.name,
      description: sc.description,
      trustScore: trustResult.trustScore,
      spoofingSuspected: trustResult.spoofingSuspected,
      signals: trustResult.signals,
      gate,
      trustV2: trustV2.trustScore,
      signalsV2: trustV2.signals,
      gateV2,
      zkpResult,
      combined,
      combinedV2,
      latency: {
        trust_ms: trustMs,
        prove_ms: proveMs,
        verify_ms: verifyMs,
        total_ms: trustMs + proveMs + verifyMs,
      },
    });

    console.log(`  ${sc.name}: V1=${trustResult.trustScore}(${gate}) V2=${trustV2.trustScore}(${gateV2}) zkp=${zkpResult} → V1:${combined} V2:${combinedV2}`);
  }

  // Print V1 vs V2 comparison table
  console.log('\n┌─────────────────────────┬───────┬───────┬──────────┬──────────┬────────────────────────────┬──────────────────────┬──────────────────────┐');
  console.log('│ Scenario                │ V1    │ V2    │ Gate V1  │ Gate V2  │ ZKP                        │ Combined V1          │ Combined V2          │');
  console.log('├─────────────────────────┼───────┼───────┼──────────┼──────────┼────────────────────────────┼──────────────────────┼──────────────────────┤');
  for (const r of results) {
    console.log(
      `│ ${r.name.padEnd(23)} │ ${String(r.trustScore).padEnd(5)} │ ${String(r.trustV2).padEnd(5)} │ ${r.gate.padEnd(8)} │ ${r.gateV2.padEnd(8)} │ ${r.zkpResult.padEnd(26)} │ ${r.combined.padEnd(20)} │ ${r.combinedV2.padEnd(20)} │`
    );
  }
  console.log('└─────────────────────────┴───────┴───────┴──────────┴──────────┴────────────────────────────┴──────────────────────┴──────────────────────┘');

  // V2 signal breakdown
  console.log('\nV2 signal breakdown:');
  console.log('  Scenario                  Movement  Accuracy  Temporal  FixConsist  NetConsist');
  for (const r of results) {
    const s = r.signalsV2;
    const fmtSig = v => v == null ? '-'.padStart(10) : v.toFixed(2).padStart(10);
    console.log(
      `  ${r.name.padEnd(26)} ${s.movementPlausibility.toFixed(2).padStart(8)}  ${s.accuracyAnomaly.toFixed(2).padStart(8)}  ${s.temporalConsistency.toFixed(2).padStart(8)}  ${fmtSig(s.fixConsistency)}  ${fmtSig(s.networkConsistency)}`
    );
  }

  console.log('\nLatency breakdown (ms):');
  console.log('  Scenario                  Trust    Prove     Verify    Total');
  for (const r of results) {
    const l = r.latency;
    console.log(
      `  ${r.name.padEnd(26)} ${l.trust_ms.toFixed(3).padStart(7)}  ${l.prove_ms.toFixed(1).padStart(8)}  ${l.verify_ms.toFixed(1).padStart(8)}  ${l.total_ms.toFixed(1).padStart(8)}`
    );
  }

  return results;
}

// ═════════════════════════════════════════════════════════════
// Part 2: Naive Hash Baseline
// ═════════════════════════════════════════════════════════════

async function runHashBaseline() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Part 2: Naive Hash Baseline — Privacy/Cost Tradeoff');
  console.log('═══════════════════════════════════════════════════════════\n');

  const TARGET_LAT = 35.6586;
  const TARGET_LON = 139.7454;
  const USER_LAT = 35.6589;
  const USER_LON = 139.7457;
  const UNLOCK_RADIUS = 50;

  // ─── GPS baseline ───
  const GPS_ITERS = 10000;
  const gpsTimes = [];
  for (let i = 0; i < GPS_ITERS; i++) {
    const t = performance.now();
    calculateDistance(TARGET_LAT, TARGET_LON, USER_LAT, USER_LON);
    gpsTimes.push(performance.now() - t);
  }
  const gpsAvg = gpsTimes.reduce((s, v) => s + v, 0) / GPS_ITERS;

  // ─── Naive hash verification ───
  // Client sends H(round(lat,4)||round(lon,4))
  // Server precomputes hashes for grid cells within radius and checks match
  const HASH_ITERS = 10000;
  const hashTimes = [];

  function naiveHashVerify(userLat, userLon, targetLat, targetLon, radius) {
    const precision = 4; // ~11m resolution
    const userHash = createHash('sha256')
      .update(`${userLat.toFixed(precision)}:${userLon.toFixed(precision)}`)
      .digest('hex');

    // Server-side: generate grid hashes within radius
    const step = 0.0001; // ~11m
    const latRange = radius / 111320;
    const lonRange = radius / (111320 * Math.cos((targetLat * Math.PI) / 180));

    for (let dlat = -latRange; dlat <= latRange; dlat += step) {
      for (let dlon = -lonRange; dlon <= lonRange; dlon += step) {
        const cellHash = createHash('sha256')
          .update(
            `${(targetLat + dlat).toFixed(precision)}:${(targetLon + dlon).toFixed(precision)}`
          )
          .digest('hex');
        if (cellHash === userHash) return true;
      }
    }
    return false;
  }

  // Single verification timing
  const hashSingleT0 = performance.now();
  const hashMatch = naiveHashVerify(USER_LAT, USER_LON, TARGET_LAT, TARGET_LON, UNLOCK_RADIUS);
  const hashSingleMs = performance.now() - hashSingleT0;

  // Hash comparison timing (just the compare, not grid generation)
  for (let i = 0; i < HASH_ITERS; i++) {
    const t = performance.now();
    const h = createHash('sha256')
      .update(`${USER_LAT.toFixed(4)}:${USER_LON.toFixed(4)}`)
      .digest('hex');
    // Compare to one stored hash
    h === createHash('sha256')
      .update(`${TARGET_LAT.toFixed(4)}:${TARGET_LON.toFixed(4)}`)
      .digest('hex');
    hashTimes.push(performance.now() - t);
  }
  const hashCompareAvg = hashTimes.reduce((s, v) => s + v, 0) / HASH_ITERS;

  // ─── ZKP verification timing ───
  const vkey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));
  const proof = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_proof.json'), 'utf8'));
  const pubSignals = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_public.json'), 'utf8'));

  const ZKP_ITERS = 50;
  const zkpTimes = [];
  for (let i = 0; i < ZKP_ITERS; i++) {
    const t = performance.now();
    await snarkjs.groth16.verify(vkey, pubSignals, proof);
    zkpTimes.push(performance.now() - t);
  }
  const zkpAvg = zkpTimes.reduce((s, v) => s + v, 0) / ZKP_ITERS;

  // ─── Dictionary attack analysis ───
  // Tokyo 23 wards: ~620 km²
  // At 4-decimal precision (~11m grid): each degree ≈ 9091 cells
  // Lat range ~0.08° → ~800 cells; Lon range ~0.15° → ~1500 cells
  // Full Tokyo: ~0.15° lat × 0.25° lon → 1500 × 2500 = 3.75M cells
  const TOKYO_AREA_KM2 = 620;
  const CELL_SIZE_M = 11; // ~0.0001° ≈ 11m
  const cellsPerKm2 = (1000 / CELL_SIZE_M) ** 2;
  const totalCells = Math.round(TOKYO_AREA_KM2 * cellsPerKm2);

  // Measure time to hash 100K entries
  const DICT_SAMPLE = 100_000;
  const dictT0 = performance.now();
  for (let i = 0; i < DICT_SAMPLE; i++) {
    createHash('sha256').update(`35.${i}:139.${i}`).digest('hex');
  }
  const dictSampleMs = performance.now() - dictT0;
  const hashesPerSec = (DICT_SAMPLE / dictSampleMs) * 1000;
  const fullDictSec = totalCells / hashesPerSec;

  // ─── Print results ───

  console.log('Verification cost comparison:');
  console.log('┌──────────────────┬─────────────┬────────────────────────────┬──────────────────────┐');
  console.log('│ Method           │ Verify (ms) │ Privacy                    │ Replay Resistance    │');
  console.log('├──────────────────┼─────────────┼────────────────────────────┼──────────────────────┤');
  console.log(`│ GPS (Haversine)  │ ${gpsAvg.toFixed(6).padStart(11)} │ None (exact coords sent)   │ None                 │`);
  console.log(`│ H(coords) check  │ ${hashCompareAvg.toFixed(6).padStart(11)} │ Weak (dictionary attack)   │ None                 │`);
  console.log(`│ H(coords) full*  │ ${hashSingleMs.toFixed(3).padStart(11)} │ Weak (dictionary attack)   │ None                 │`);
  console.log(`│ ZKP (Groth16)    │ ${zkpAvg.toFixed(3).padStart(11)} │ Strong (zero-knowledge)    │ With context binding │`);
  console.log('└──────────────────┴─────────────┴────────────────────────────┴──────────────────────┘');
  console.log(`  * Full grid verification for ${UNLOCK_RADIUS}m radius (match=${hashMatch})`);

  console.log('\nDictionary attack analysis (Tokyo 23 wards, ~620 km²):');
  console.log(`  Grid cells at 4-decimal precision (~11m): ${(totalCells / 1e6).toFixed(1)}M`);
  console.log(`  SHA-256 throughput: ${(hashesPerSec / 1e6).toFixed(2)}M hashes/sec`);
  console.log(`  Full dictionary build time: ${fullDictSec.toFixed(1)}s`);
  console.log(`  → Attacker can locate user's grid cell in ${fullDictSec.toFixed(1)}s`);
  console.log(`  → ZKP: zero information leaked (zero-knowledge property)`);

  console.log('\nPrivacy cost ratio:');
  console.log(`  ZKP verification overhead vs GPS: ${(zkpAvg / gpsAvg).toFixed(0)}×`);
  console.log(`  ZKP verification overhead vs hash: ${(zkpAvg / hashCompareAvg).toFixed(0)}×`);
  console.log(`  Absolute ZKP verify cost: ${zkpAvg.toFixed(2)}ms (negligible for interactive use)`);

  return {
    gps: { avg_ms: gpsAvg, iters: GPS_ITERS },
    hash: { compare_avg_ms: hashCompareAvg, full_verify_ms: hashSingleMs, match: hashMatch },
    zkp: { avg_ms: zkpAvg, iters: ZKP_ITERS },
    dictionary: { totalCells, hashesPerSec, fullDictSec },
  };
}

// ═════════════════════════════════════════════════════════════
// Part 3: Threshold Sensitivity Analysis
// ═════════════════════════════════════════════════════════════

function runThresholdSensitivity(part1Results) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Part 3: Threshold Sensitivity Analysis');
  console.log('═══════════════════════════════════════════════════════════\n');

  const thresholds = [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

  // Classify scenarios into honest vs attacker for summary stats
  const honestNames = new Set(['Normal user', 'Marginal GPS (indoor)', 'Out-of-range honest user']);
  const attackerNames = new Set(['Teleporter (GPS spoof)', 'Precise spoofer', 'VPN spoofer']);

  // For each scenario, compute gate decision at each threshold
  const rows = part1Results.map((r) => {
    const decisions = thresholds.map((t) => {
      const gate = gateTrustScore({ trustScore: r.trustV2 }, { proceed: t, stepUp: 0.3 });
      // Combined: trust gate + ZKP result
      let combined;
      if (gate === 'deny') combined = 'BLOCKED';
      else if (r.zkpResult !== 'valid') combined = 'BLOCKED';
      else if (gate === 'step-up') combined = 'STEP-UP';
      else combined = 'UNLOCK';
      return { gate, combined };
    });
    return { name: r.name, v2Score: r.trustV2, zkpResult: r.zkpResult, decisions };
  });

  // ─── Print trust gate table ───
  const colW = 6;
  const nameCol = 25;
  const hdrThresholds = thresholds.map((t) => t.toFixed(2).padStart(colW)).join(' │');
  const sep = thresholds.map(() => '─'.repeat(colW)).join('─┼');

  console.log('Threshold Sensitivity (V2 Trust Scorer — gate decision only):');
  console.log(`┌${'─'.repeat(nameCol)}┬─${sep}─┐`);
  console.log(`│ ${'Scenario (V2 score)'.padEnd(nameCol - 2)} │${hdrThresholds} │`);
  console.log(`├${'─'.repeat(nameCol)}┼─${sep}─┤`);
  for (const row of rows) {
    const label = `${row.name} (${row.v2Score.toFixed(2)})`.padEnd(nameCol - 2);
    const cells = row.decisions.map((d) => d.gate.slice(0, colW).padStart(colW)).join(' │');
    console.log(`│ ${label} │${cells} │`);
  }
  console.log(`└${'─'.repeat(nameCol)}┘`);

  // ─── Print combined decision table ───
  const combColW = 8;
  const hdrThresholds2 = thresholds.map((t) => t.toFixed(2).padStart(combColW)).join(' │');
  const sep2 = thresholds.map(() => '─'.repeat(combColW)).join('─┼');

  console.log('\nCombined Decision (V2 Trust Gate + ZKP):');
  console.log(`┌${'─'.repeat(nameCol)}┬─${sep2}─┐`);
  console.log(`│ ${'Scenario (V2 score)'.padEnd(nameCol - 2)} │${hdrThresholds2} │`);
  console.log(`├${'─'.repeat(nameCol)}┼─${sep2}─┤`);
  for (const row of rows) {
    const label = `${row.name} (${row.v2Score.toFixed(2)})`.padEnd(nameCol - 2);
    const cells = row.decisions.map((d) => d.combined.padStart(combColW)).join(' │');
    console.log(`│ ${label} │${cells} │`);
  }
  console.log(`└${'─'.repeat(nameCol)}┘`);

  // ─── Summary per threshold ───
  console.log('\nSummary per threshold:');
  const summaryRows = thresholds.map((t, ti) => {
    let honestDenied = 0;
    let attackersCaught = 0; // deny or step-up
    let honestTotal = 0;
    let attackerTotal = 0;

    for (const row of rows) {
      const d = row.decisions[ti];
      if (honestNames.has(row.name)) {
        honestTotal++;
        if (d.combined === 'BLOCKED') honestDenied++;
      }
      if (attackerNames.has(row.name)) {
        attackerTotal++;
        if (d.combined === 'BLOCKED' || d.combined === 'STEP-UP') attackersCaught++;
      }
    }

    console.log(
      `  At threshold ${t.toFixed(2)}: ${honestDenied} honest users blocked, ${attackersCaught}/${attackerTotal} attackers blocked/step-up'd`
    );

    return {
      threshold: t,
      honestDenied,
      honestTotal,
      attackersCaught,
      attackerTotal,
    };
  });

  // Return data for JSON output
  return {
    thresholds,
    scenarios: rows.map((r) => ({
      name: r.name,
      v2Score: r.v2Score,
      zkpResult: r.zkpResult,
      decisions: Object.fromEntries(
        thresholds.map((t, i) => [t.toFixed(2), r.decisions[i]])
      ),
    })),
    summary: summaryRows,
  };
}

// ═════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════

async function main() {
  const part1 = await runDefenseInDepth();
  const part2 = await runHashBaseline();
  const part3 = runThresholdSensitivity(part1);

  // JSON output
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `defense-in-depth-results-${dateStr}.json`);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        experiment: 'defense-in-depth',
        date: new Date().toISOString(),
        version: 'v2',
        part1_trust_zkp_integration: part1,
        part2_hash_baseline: part2,
        part3_threshold_sensitivity: part3,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
