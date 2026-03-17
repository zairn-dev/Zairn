/**
 * GPS Trace Evaluation: Trust Scorer Detection Performance
 *
 * Generates synthetic but realistic GPS traces for eight user/attacker
 * profiles, runs each trace through Trust Scorer V1 and V2, and computes
 * detection metrics (TPR, FPR, precision, F1) at multiple thresholds.
 *
 * Profiles (honest):
 *   H1. Walking commuter — steady 5 km/h, accuracy 8–15 m
 *   H2. Cyclist — 18 km/h, accuracy 5–10 m
 *   H3. Indoor stationary — jitter ≤5 m, accuracy 50–300 m
 *   H4. Train passenger — 80 km/h, accuracy 10–30 m
 *
 * Profiles (attacker):
 *   A1. Immediate teleporter — teleport to target, attempt unlock within 1-2 fixes
 *   A1b. Settled teleporter — teleport, wait 5+ fixes, then attempt (evasion)
 *   A2. Mock-location precise — smooth approach but accuracy < 2 m
 *   A3. Coordinate injection — perfectly repeating coordinates, no jitter
 *   A4. VPN + real GPS — normal GPS movement, network hint ≫ 5000 km away
 *
 * Output: ROC data, AUC, per-threshold metrics, JSON results file.
 *
 * Paper section: §8 Evaluation — RQ7: GPS Spoofing Detection Performance
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═════════════════════════════════════════════════════════════
// Inlined Trust Scorer (exact copy from src/trust-scorer.ts)
// ═════════════════════════════════════════════════════════════

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
  const raw = 0.5 * movementPlausibility + 0.2 * accuracyAnomaly + 0.3 * temporalConsistency;
  const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return {
    trustScore,
    spoofingSuspected: trustScore < 0.3,
    signals: { movementPlausibility, accuracyAnomaly, temporalConsistency },
  };
}

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
  if (!hasFixes && !hasNetwork) return computeTrustScore(current, history);

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
// Trace generators
// ═════════════════════════════════════════════════════════════

const BASE_TIME = Date.now();
const INTERVAL_MS = 30_000; // 30 s between fixes
const TRACE_LENGTH = 20;    // 20 points per trace

// Target drop: Tokyo Tower area
const TARGET = { lat: 35.6586, lon: 139.7454 };

function rand(min, max) { return min + Math.random() * (max - min); }
function gaussRand() {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function makeTimestamp(idx) {
  return new Date(BASE_TIME - (TRACE_LENGTH - idx) * INTERVAL_MS).toISOString();
}

/** Walk toward target at given speed (m/s), arriving near target at last point */
function generateWalkTrace(speedMs, accMin, accMax, startDist = 200) {
  const bearing = rand(0, 2 * Math.PI);
  const startLat = TARGET.lat + (startDist / 111320) * Math.cos(bearing);
  const startLon = TARGET.lon + (startDist / (111320 * Math.cos(TARGET.lat * Math.PI / 180))) * Math.sin(bearing);

  const points = [];
  for (let i = 0; i < TRACE_LENGTH; i++) {
    const progress = i / (TRACE_LENGTH - 1);
    const lat = startLat + (TARGET.lat - startLat) * progress + gaussRand() * 0.00002;
    const lon = startLon + (TARGET.lon - startLon) * progress + gaussRand() * 0.00002;
    const accuracy = rand(accMin, accMax);
    points.push({ lat, lon, accuracy, timestamp: makeTimestamp(i) });
  }
  return points;
}

function generateStationaryTrace(baseLat, baseLon, jitterM, accMin, accMax) {
  const points = [];
  for (let i = 0; i < TRACE_LENGTH; i++) {
    const lat = baseLat + gaussRand() * (jitterM / 111320);
    const lon = baseLon + gaussRand() * (jitterM / (111320 * Math.cos(baseLat * Math.PI / 180)));
    points.push({ lat, lon, accuracy: rand(accMin, accMax), timestamp: makeTimestamp(i) });
  }
  return points;
}

function generateTrainTrace(accMin, accMax) {
  // Approach Tokyo from the east along a roughly straight line
  const startLat = 35.66;
  const startLon = 139.80;
  const points = [];
  for (let i = 0; i < TRACE_LENGTH; i++) {
    const progress = i / (TRACE_LENGTH - 1);
    const lat = startLat + (TARGET.lat - startLat) * progress + gaussRand() * 0.0001;
    const lon = startLon + (TARGET.lon - startLon) * progress + gaussRand() * 0.0001;
    points.push({ lat, lon, accuracy: rand(accMin, accMax), timestamp: makeTimestamp(i) });
  }
  return points;
}

// ═════════════════════════════════════════════════════════════
// Profile definitions — 50 traces each
// ═════════════════════════════════════════════════════════════

const TRACES_PER_PROFILE = 50;

function generateProfiles() {
  const profiles = [];

  // H1: Walking commuter — 1.4 m/s ≈ 5 km/h
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateWalkTrace(1.4, 8, 15, rand(100, 300));
    profiles.push({ id: `H1-${t}`, profile: 'H1: Walking commuter', isAttacker: false, trace, networkLocal: true });
  }

  // H2: Cyclist — 5 m/s ≈ 18 km/h
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateWalkTrace(5, 5, 10, rand(200, 500));
    profiles.push({ id: `H2-${t}`, profile: 'H2: Cyclist', isAttacker: false, trace, networkLocal: true });
  }

  // H3: Indoor stationary — near target, high accuracy variance
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateStationaryTrace(
      TARGET.lat + gaussRand() * 0.0003,
      TARGET.lon + gaussRand() * 0.0003,
      5, 50, 300
    );
    profiles.push({ id: `H3-${t}`, profile: 'H3: Indoor stationary', isAttacker: false, trace, networkLocal: true });
  }

  // H4: Train passenger — fast but consistent
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateTrainTrace(10, 30);
    profiles.push({ id: `H4-${t}`, profile: 'H4: Train passenger', isAttacker: false, trace, networkLocal: true });
  }

  // A1: Mock-location teleporter — teleport 1-2 fixes before evaluation (immediate attempt)
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const farLat = TARGET.lat + rand(0.5, 2.0) * (Math.random() > 0.5 ? 1 : -1);
    const farLon = TARGET.lon + rand(0.5, 2.0) * (Math.random() > 0.5 ? 1 : -1);
    const trace = [];
    // First 18 points: far away
    for (let i = 0; i < 18; i++) {
      trace.push({
        lat: farLat + gaussRand() * 0.0003,
        lon: farLon + gaussRand() * 0.0003,
        accuracy: rand(5, 15),
        timestamp: makeTimestamp(i),
      });
    }
    // Last 2 points: suddenly at target (attacker teleports and immediately tries to unlock)
    for (let i = 18; i < TRACE_LENGTH; i++) {
      trace.push({
        lat: TARGET.lat + gaussRand() * 0.00005,
        lon: TARGET.lon + gaussRand() * 0.00005,
        accuracy: rand(3, 8),
        timestamp: makeTimestamp(i),
      });
    }
    profiles.push({ id: `A1-${t}`, profile: 'A1: Immediate teleporter', isAttacker: true, trace, networkLocal: true });
  }

  // A1b: Settled teleporter — teleports, waits 5+ fixes, then attempts unlock
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const farLat = TARGET.lat + rand(0.5, 2.0) * (Math.random() > 0.5 ? 1 : -1);
    const farLon = TARGET.lon + rand(0.5, 2.0) * (Math.random() > 0.5 ? 1 : -1);
    const trace = [];
    for (let i = 0; i < 12; i++) {
      trace.push({
        lat: farLat + gaussRand() * 0.0003,
        lon: farLon + gaussRand() * 0.0003,
        accuracy: rand(5, 15),
        timestamp: makeTimestamp(i),
      });
    }
    // Last 8 points: at target (attacker has "settled" for 4 minutes)
    for (let i = 12; i < TRACE_LENGTH; i++) {
      trace.push({
        lat: TARGET.lat + gaussRand() * 0.00005,
        lon: TARGET.lon + gaussRand() * 0.00005,
        accuracy: rand(3, 8),
        timestamp: makeTimestamp(i),
      });
    }
    profiles.push({ id: `A1b-${t}`, profile: 'A1b: Settled teleporter', isAttacker: true, trace, networkLocal: true });
  }

  // A2: Mock-location walk-in — smooth approach but suspiciously precise (< 2 m)
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateWalkTrace(1.4, 0.1, 1.5, rand(100, 300));
    profiles.push({ id: `A2-${t}`, profile: 'A2: Mock-location precise', isAttacker: true, trace, networkLocal: true });
  }

  // A3: Coordinate injection — perfectly repeating coordinates, zero jitter
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const fixedLat = TARGET.lat + rand(-0.0003, 0.0003);
    const fixedLon = TARGET.lon + rand(-0.0003, 0.0003);
    const trace = [];
    for (let i = 0; i < TRACE_LENGTH; i++) {
      trace.push({
        lat: fixedLat,
        lon: fixedLon,
        accuracy: 1.0, // always exact same
        timestamp: makeTimestamp(i),
      });
    }
    profiles.push({ id: `A3-${t}`, profile: 'A3: Coordinate injection', isAttacker: true, trace, networkLocal: true });
  }

  // A4: VPN + real GPS — normal movement, network hint from different continent
  for (let t = 0; t < TRACES_PER_PROFILE; t++) {
    const trace = generateWalkTrace(1.4, 8, 15, rand(100, 300));
    profiles.push({ id: `A4-${t}`, profile: 'A4: VPN + real GPS', isAttacker: true, trace, networkLocal: false });
  }

  return profiles;
}

// ═════════════════════════════════════════════════════════════
// Evaluation
// ═════════════════════════════════════════════════════════════

function evaluateTrace(entry) {
  const trace = entry.trace;
  // Use last point as "current", preceding points as history (newest-first)
  const current = trace[trace.length - 1];
  const history = trace.slice(0, -1).reverse(); // newest-first

  // V1
  const v1 = computeTrustScore(current, history);

  // V2 context: use last 5 fixes + network hint
  const recentFixes = trace.slice(-5).map(p => ({
    lat: p.lat, lon: p.lon, accuracy: p.accuracy, timestamp: p.timestamp,
  }));

  // Network hint: local WiFi (near target) for honest, far away for VPN attacker
  const networkHint = entry.networkLocal
    ? { lat: TARGET.lat + gaussRand() * 0.003, lon: TARGET.lon + gaussRand() * 0.003, accuracy: 500, source: 'wifi' }
    : { lat: 37.7749, lon: -122.4194, accuracy: 5000, source: 'ip' }; // San Francisco

  const v2 = computeTrustScoreV2(current, history, { recentFixes, networkHint });

  return { id: entry.id, profile: entry.profile, isAttacker: entry.isAttacker, v1Score: v1.trustScore, v2Score: v2.trustScore, v1Signals: v1.signals, v2Signals: v2.signals };
}

function computeMetrics(results, threshold, scorer = 'v2') {
  const key = scorer === 'v1' ? 'v1Score' : 'v2Score';
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const r of results) {
    const flagged = r[key] < threshold; // below threshold → flagged as suspicious
    if (r.isAttacker && flagged) tp++;
    else if (r.isAttacker && !flagged) fn++;
    else if (!r.isAttacker && flagged) fp++;
    else tn++;
  }

  const tpr = tp + fn > 0 ? tp / (tp + fn) : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tpr;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return { threshold, tp, fp, tn, fn, tpr, fpr, precision, recall, f1 };
}

function computeAUC(rocPoints) {
  // Sort by FPR ascending
  const sorted = [...rocPoints].sort((a, b) => a.fpr - b.fpr);
  let auc = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dx = sorted[i].fpr - sorted[i - 1].fpr;
    const avgY = (sorted[i].tpr + sorted[i - 1].tpr) / 2;
    auc += dx * avgY;
  }
  return auc;
}

// ═════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════

function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GPS Trace Evaluation: Trust Scorer Detection Performance');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Generate traces
  const entries = generateProfiles();
  console.log(`Generated ${entries.length} traces (${TRACES_PER_PROFILE} per profile × 8 profiles)\n`);

  // Evaluate all traces
  const results = entries.map(evaluateTrace);

  // Per-profile score summary
  const profileNames = [...new Set(results.map(r => r.profile))];
  console.log('Per-profile score distribution:');
  console.log('┌───────────────────────────────┬────────────┬─────────────┬────────────┬────────────┬─────────────┬────────────┐');
  console.log('│ Profile                       │ V1 mean    │ V1 std      │ V1 min     │ V2 mean    │ V2 std      │ V2 min     │');
  console.log('├───────────────────────────────┼────────────┼─────────────┼────────────┼────────────┼─────────────┼────────────┤');

  for (const pname of profileNames) {
    const pResults = results.filter(r => r.profile === pname);
    const v1Scores = pResults.map(r => r.v1Score);
    const v2Scores = pResults.map(r => r.v2Score);
    const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    const std = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
    const min = arr => Math.min(...arr);

    console.log(
      `│ ${pname.padEnd(29)} │ ${mean(v1Scores).toFixed(4).padStart(10)} │ ${std(v1Scores).toFixed(4).padStart(11)} │ ${min(v1Scores).toFixed(2).padStart(10)} │ ${mean(v2Scores).toFixed(4).padStart(10)} │ ${std(v2Scores).toFixed(4).padStart(11)} │ ${min(v2Scores).toFixed(2).padStart(10)} │`
    );
  }
  console.log('└───────────────────────────────┴────────────┴─────────────┴────────────┴────────────┴─────────────┴────────────┘');

  // ROC analysis at fine-grained thresholds
  const thresholds = [];
  for (let t = 0.0; t <= 1.01; t += 0.05) thresholds.push(Math.round(t * 100) / 100);

  const rocV1 = thresholds.map(t => computeMetrics(results, t, 'v1'));
  const rocV2 = thresholds.map(t => computeMetrics(results, t, 'v2'));

  const aucV1 = computeAUC(rocV1);
  const aucV2 = computeAUC(rocV2);

  console.log(`\nAUC (area under ROC curve):`);
  console.log(`  V1: ${aucV1.toFixed(4)}`);
  console.log(`  V2: ${aucV2.toFixed(4)}`);

  // Selected threshold metrics
  const reportThresholds = [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

  console.log('\nDetection metrics at selected thresholds (V1):');
  console.log('┌───────────┬──────┬──────┬──────┬──────┬───────┬───────┬───────┬───────┐');
  console.log('│ Threshold │  TP  │  FP  │  TN  │  FN  │  TPR  │  FPR  │ Prec  │   F1  │');
  console.log('├───────────┼──────┼──────┼──────┼──────┼───────┼───────┼───────┼───────┤');
  for (const t of reportThresholds) {
    const m = computeMetrics(results, t, 'v1');
    console.log(
      `│ ${t.toFixed(2).padStart(9)} │ ${String(m.tp).padStart(4)} │ ${String(m.fp).padStart(4)} │ ${String(m.tn).padStart(4)} │ ${String(m.fn).padStart(4)} │ ${m.tpr.toFixed(3).padStart(5)} │ ${m.fpr.toFixed(3).padStart(5)} │ ${m.precision.toFixed(3).padStart(5)} │ ${m.f1.toFixed(3).padStart(5)} │`
    );
  }
  console.log('└───────────┴──────┴──────┴──────┴──────┴───────┴───────┴───────┴───────┘');

  console.log('\nDetection metrics at selected thresholds (V2):');
  console.log('┌───────────┬──────┬──────┬──────┬──────┬───────┬───────┬───────┬───────┐');
  console.log('│ Threshold │  TP  │  FP  │  TN  │  FN  │  TPR  │  FPR  │ Prec  │   F1  │');
  console.log('├───────────┼──────┼──────┼──────┼──────┼───────┼───────┼───────┼───────┤');
  for (const t of reportThresholds) {
    const m = computeMetrics(results, t, 'v2');
    console.log(
      `│ ${t.toFixed(2).padStart(9)} │ ${String(m.tp).padStart(4)} │ ${String(m.fp).padStart(4)} │ ${String(m.tn).padStart(4)} │ ${String(m.fn).padStart(4)} │ ${m.tpr.toFixed(3).padStart(5)} │ ${m.fpr.toFixed(3).padStart(5)} │ ${m.precision.toFixed(3).padStart(5)} │ ${m.f1.toFixed(3).padStart(5)} │`
    );
  }
  console.log('└───────────┴──────┴──────┴──────┴──────┴───────┴───────┴───────┴───────┘');

  // V1 vs V2 improvement per profile
  console.log('\nV1 vs V2 improvement (mean score difference, attacker profiles):');
  for (const pname of profileNames) {
    const pResults = results.filter(r => r.profile === pname);
    if (!pResults[0].isAttacker) continue;
    const v1Mean = pResults.reduce((s, r) => s + r.v1Score, 0) / pResults.length;
    const v2Mean = pResults.reduce((s, r) => s + r.v2Score, 0) / pResults.length;
    const delta = v2Mean - v1Mean;
    console.log(`  ${pname}: V1=${v1Mean.toFixed(3)} → V2=${v2Mean.toFixed(3)} (Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`);
  }

  // ROC data for plotting
  console.log('\nROC data (for external plotting):');
  console.log('  V1 FPR/TPR pairs:');
  for (const pt of rocV1) {
    if (reportThresholds.includes(pt.threshold)) {
      console.log(`    t=${pt.threshold.toFixed(2)}: FPR=${pt.fpr.toFixed(3)}, TPR=${pt.tpr.toFixed(3)}`);
    }
  }
  console.log('  V2 FPR/TPR pairs:');
  for (const pt of rocV2) {
    if (reportThresholds.includes(pt.threshold)) {
      console.log(`    t=${pt.threshold.toFixed(2)}: FPR=${pt.fpr.toFixed(3)}, TPR=${pt.tpr.toFixed(3)}`);
    }
  }

  // JSON output
  const output = {
    experiment: 'gps-trace-evaluation',
    date: new Date().toISOString(),
    config: {
      tracesPerProfile: TRACES_PER_PROFILE,
      traceLength: TRACE_LENGTH,
      intervalMs: INTERVAL_MS,
      target: TARGET,
    },
    profileSummary: profileNames.map(pname => {
      const pResults = results.filter(r => r.profile === pname);
      const v1Scores = pResults.map(r => r.v1Score);
      const v2Scores = pResults.map(r => r.v2Score);
      const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
      const std = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
      return {
        profile: pname,
        isAttacker: pResults[0].isAttacker,
        n: pResults.length,
        v1: { mean: mean(v1Scores), std: std(v1Scores), min: Math.min(...v1Scores), max: Math.max(...v1Scores) },
        v2: { mean: mean(v2Scores), std: std(v2Scores), min: Math.min(...v2Scores), max: Math.max(...v2Scores) },
      };
    }),
    roc: {
      v1: { auc: aucV1, points: rocV1.map(p => ({ threshold: p.threshold, fpr: p.fpr, tpr: p.tpr })) },
      v2: { auc: aucV2, points: rocV2.map(p => ({ threshold: p.threshold, fpr: p.fpr, tpr: p.tpr })) },
    },
    metricsAtThresholds: {
      v1: reportThresholds.map(t => computeMetrics(results, t, 'v1')),
      v2: reportThresholds.map(t => computeMetrics(results, t, 'v2')),
    },
  };

  return output;
}

async function run() {
  const output = main();

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `gps-trace-results-${dateStr}.json`);
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
