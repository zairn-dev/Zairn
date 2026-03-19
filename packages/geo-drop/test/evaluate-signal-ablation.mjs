/**
 * Experiment 2: Signal Ablation Study
 *
 * Measures each trust-scoring signal's contribution to detection accuracy
 * by systematically removing signals and evaluating F1 across all 31
 * non-empty subsets of {S1, S2, S3, S4, S5}.
 *
 * Usage:
 *   node evaluate-signal-ablation.mjs              # N=200 per scenario
 *   node evaluate-signal-ablation.mjs --n 500      # custom N
 *
 * Output: JSON to stdout, summary table to stderr.
 */

import { generateTraces } from './generate-synthetic-traces.mjs';
import { calculateDistance } from '../dist/geofence.js';

// ═══════════════════════════════════════════════════════════════
// Signal scoring functions (re-implemented from trust-scorer.ts)
// ═══════════════════════════════════════════════════════════════

/** S1: Movement plausibility */
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

/** S2: Accuracy anomaly */
function scoreAccuracy(current) {
  const acc = current.accuracy;
  if (acc === null || acc === undefined) return 0.5;
  if (acc < 2) return 0.3;
  if (acc <= 100) return 1.0;
  if (acc <= 500) return 0.7;
  return 0.4;
}

/** S3: Temporal consistency */
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
    const speed = dist / (dt / 1000);
    if (speed > 100) violations++;
  }
  if (violations === 0) return 1.0;
  if (violations === 1) return 0.6;
  if (violations === 2) return 0.3;
  return 0.0;
}

/** S4: Fix consistency (RAIM) */
function scoreFixConsistency(recentFixes) {
  if (!recentFixes || recentFixes.length < 3) return 0.8;
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

/** S5: Network consistency */
function scoreNetworkConsistency(current, hint) {
  if (!hint) return 0.8; // no hint available
  const dist = calculateDistance(current.lat, current.lon, hint.lat, hint.lon);
  if (dist < hint.accuracy) return 1.0;
  if (dist < 2 * hint.accuracy) return 0.7;
  if (dist < 5 * hint.accuracy) return 0.5;
  return 0.3;
}

// ═══════════════════════════════════════════════════════════════
// Signal definitions and base weights
// ═══════════════════════════════════════════════════════════════

const SIGNAL_NAMES = ['S1', 'S2', 'S3', 'S4', 'S5'];
const SIGNAL_LABELS = {
  S1: 'S1_movement',
  S2: 'S2_accuracy',
  S3: 'S3_temporal',
  S4: 'S4_fix',
  S5: 'S5_network',
};

// Base weights when all 5 signals are active (V2 full profile)
const BASE_WEIGHTS = {
  S1: 0.30,
  S2: 0.10,
  S3: 0.15,
  S4: 0.25,
  S5: 0.20,
};

/**
 * Compute individual signal values for a trace.
 */
function computeSignalValues(trace) {
  return {
    S1: scoreMovement(trace.current, trace.history),
    S2: scoreAccuracy(trace.current),
    S3: scoreTemporalConsistency(trace.current, trace.history),
    S4: scoreFixConsistency(trace.recentFixes),
    S5: scoreNetworkConsistency(trace.current, trace.networkHint),
  };
}

/**
 * Compute trust score for a trace using only the given active signals.
 * Redistributes disabled signal weights proportionally to remaining signals.
 */
function computeAblatedScore(signalValues, activeSignals) {
  // Sum of base weights for active signals
  const totalWeight = activeSignals.reduce((sum, s) => sum + BASE_WEIGHTS[s], 0);
  if (totalWeight === 0) return 0;

  let score = 0;
  for (const s of activeSignals) {
    // Normalize: redistribute disabled weight proportionally
    const normalizedWeight = BASE_WEIGHTS[s] / totalWeight;
    score += normalizedWeight * signalValues[s];
  }

  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
// Enumeration of all 31 non-empty signal subsets
// ═══════════════════════════════════════════════════════════════

function enumerateSubsets() {
  const subsets = [];
  // bitmask 1..31 (skip 0 = empty set)
  for (let mask = 1; mask < 32; mask++) {
    const active = [];
    const disabled = [];
    for (let i = 0; i < 5; i++) {
      if (mask & (1 << i)) {
        active.push(SIGNAL_NAMES[i]);
      } else {
        disabled.push(SIGNAL_NAMES[i]);
      }
    }
    subsets.push({ mask, active, disabled });
  }
  return subsets;
}

// ═══════════════════════════════════════════════════════════════
// Evaluation metrics
// ═══════════════════════════════════════════════════════════════

function evaluateCombination(traces, activeSignals, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let sumLegitScore = 0, nLegit = 0;
  let sumSpoofScore = 0, nSpoof = 0;

  for (const trace of traces) {
    const signalValues = computeSignalValues(trace);
    const score = computeAblatedScore(signalValues, activeSignals);
    const isLegit = trace.label === 'legitimate';
    // Detection: score < threshold => classified as spoofed
    const predictedSpoof = score < threshold;

    if (isLegit) {
      sumLegitScore += score;
      nLegit++;
      if (predictedSpoof) fp++; else tn++;
    } else {
      sumSpoofScore += score;
      nSpoof++;
      if (predictedSpoof) tp++; else fn++;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    f1: Math.round(f1 * 10000) / 10000,
    precision: Math.round(precision * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    mean_legit_score: nLegit > 0 ? Math.round((sumLegitScore / nLegit) * 10000) / 10000 : 0,
    mean_spoof_score: nSpoof > 0 ? Math.round((sumSpoofScore / nSpoof) * 10000) / 10000 : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Shapley-like signal importance
// ═══════════════════════════════════════════════════════════════

/**
 * For each signal, compute the average F1 drop when that signal is removed.
 * This iterates over all subsets that contain the signal, and compares F1
 * with the signal vs without it.
 */
function computeSignalImportance(combinationResults) {
  // Index results by bitmask for fast lookup
  const byMask = {};
  for (const r of combinationResults) {
    byMask[r._mask] = r;
  }

  const importance = {};

  for (let si = 0; si < 5; si++) {
    const signalBit = 1 << si;
    let totalDrop = 0;
    let count = 0;

    // Iterate all subsets that CONTAIN this signal
    for (let mask = 1; mask < 32; mask++) {
      if (!(mask & signalBit)) continue; // signal not in this subset
      const withoutMask = mask & ~signalBit;
      if (withoutMask === 0) continue; // can't remove the only signal

      const f1With = byMask[mask].f1;
      const f1Without = byMask[withoutMask].f1;
      totalDrop += f1With - f1Without;
      count++;
    }

    importance[SIGNAL_LABELS[SIGNAL_NAMES[si]]] =
      count > 0 ? Math.round((totalDrop / count) * 10000) / 10000 : 0;
  }

  return importance;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

function main() {
  let n = 200;
  const nIdx = process.argv.indexOf('--n');
  if (nIdx !== -1 && process.argv[nIdx + 1]) {
    n = parseInt(process.argv[nIdx + 1], 10);
    if (isNaN(n) || n < 1) {
      process.stderr.write('Error: --n must be a positive integer\n');
      process.exit(1);
    }
  }

  const threshold = 0.7;
  const subsets = enumerateSubsets();

  process.stderr.write(`Generating traces: ${n} per scenario (10 scenarios)...\n`);
  const traces = generateTraces(n);
  process.stderr.write(`Total traces: ${traces.length}\n`);
  process.stderr.write(`Evaluating ${subsets.length} signal combinations at threshold=${threshold}...\n\n`);

  const combinations = [];

  for (const subset of subsets) {
    const metrics = evaluateCombination(traces, subset.active, threshold);
    combinations.push({
      signals: subset.active,
      disabled: subset.disabled,
      _mask: subset.mask,
      ...metrics,
    });
  }

  const signal_importance = computeSignalImportance(combinations);

  // Clean up internal _mask field for output
  const outputCombinations = combinations
    .sort((a, b) => b.f1 - a.f1)
    .map(({ _mask, ...rest }) => rest);

  const result = {
    timestamp: new Date().toISOString(),
    n_per_scenario: n,
    combinations: outputCombinations,
    signal_importance,
  };

  // ── Summary table to stderr ──────────────────────────────────

  process.stderr.write('Signal Importance (avg F1 gain from adding signal):\n');
  process.stderr.write('─'.repeat(50) + '\n');
  const sortedImportance = Object.entries(signal_importance)
    .sort((a, b) => b[1] - a[1]);
  for (const [name, value] of sortedImportance) {
    const bar = value > 0 ? '█'.repeat(Math.round(value * 100)) : '';
    process.stderr.write(`  ${name.padEnd(16)} ${value >= 0 ? '+' : ''}${value.toFixed(4)}  ${bar}\n`);
  }

  process.stderr.write('\n');
  process.stderr.write('Top-10 Combinations by F1:\n');
  process.stderr.write('─'.repeat(80) + '\n');
  process.stderr.write(
    '  ' +
    'Signals'.padEnd(28) +
    'F1'.padStart(8) +
    'Prec'.padStart(8) +
    'Rec'.padStart(8) +
    'Legit'.padStart(8) +
    'Spoof'.padStart(8) +
    '\n'
  );
  process.stderr.write('─'.repeat(80) + '\n');

  for (const c of outputCombinations.slice(0, 10)) {
    const sigStr = c.signals.join('+');
    process.stderr.write(
      '  ' +
      sigStr.padEnd(28) +
      c.f1.toFixed(4).padStart(8) +
      c.precision.toFixed(4).padStart(8) +
      c.recall.toFixed(4).padStart(8) +
      c.mean_legit_score.toFixed(4).padStart(8) +
      c.mean_spoof_score.toFixed(4).padStart(8) +
      '\n'
    );
  }

  process.stderr.write('\n');
  process.stderr.write('Bottom-5 Combinations by F1:\n');
  process.stderr.write('─'.repeat(80) + '\n');

  for (const c of outputCombinations.slice(-5)) {
    const sigStr = c.signals.join('+');
    process.stderr.write(
      '  ' +
      sigStr.padEnd(28) +
      c.f1.toFixed(4).padStart(8) +
      c.precision.toFixed(4).padStart(8) +
      c.recall.toFixed(4).padStart(8) +
      c.mean_legit_score.toFixed(4).padStart(8) +
      c.mean_spoof_score.toFixed(4).padStart(8) +
      '\n'
    );
  }

  process.stderr.write('\nDone.\n');

  // ── JSON to stdout ───────────────────────────────────────────
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
