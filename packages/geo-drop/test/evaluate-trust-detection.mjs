/**
 * Experiment 1: Spoofing Detection Accuracy Evaluation
 *
 * Evaluates the trust scorer's ability to detect GPS spoofing across
 * 10 scenarios (4 legitimate, 6 spoofed) using synthetic traces.
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-trust-detection.mjs
 *   node packages/geo-drop/test/evaluate-trust-detection.mjs --n 500
 *
 * Outputs JSON results to stdout and a human-readable summary to stderr.
 */

import { generateTraces } from './generate-synthetic-traces.mjs';
import { computeTrustScore, computeTrustScoreV2, gateTrustScore } from '../dist/trust-scorer.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

let N = 1000;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1 && process.argv[nIdx + 1]) {
  N = parseInt(process.argv[nIdx + 1], 10);
  if (isNaN(N) || N < 1) {
    process.stderr.write('Error: --n must be a positive integer\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

const THRESHOLDS = [0.3, 0.5, 0.7];

function computeGateDistribution(decisions) {
  const dist = { proceed: 0, 'step-up': 0, deny: 0 };
  for (const d of decisions) {
    dist[d]++;
  }
  return {
    proceed: dist.proceed,
    stepUp: dist['step-up'],
    deny: dist.deny,
  };
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

process.stderr.write(`Generating ${N} traces per scenario (${N * 10} total)...\n`);
const traces = generateTraces(N);
process.stderr.write(`Generated ${traces.length} traces. Evaluating...\n`);

// Accumulators per version
function createAccumulator() {
  return {
    perScenario: {},  // scenario -> { scores: [], labels: [], gates: { 0.3: [], 0.5: [], 0.7: [] } }
    allScores: [],
    allLabels: [],
    allGates: Object.fromEntries(THRESHOLDS.map(t => [t, []])),
  };
}

const v1Acc = createAccumulator();
const v2Acc = createAccumulator();

for (const trace of traces) {
  const { current, history, recentFixes, networkHint, label, scenario } = trace;

  // V1
  const v1Result = computeTrustScore(current, history);
  const v1Score = v1Result.trustScore;

  // V2
  const v2Context = { recentFixes };
  if (networkHint != null) {
    v2Context.networkHint = networkHint;
  }
  const v2Result = computeTrustScoreV2(current, history, v2Context);
  const v2Score = v2Result.trustScore;

  for (const [acc, result, score] of [[v1Acc, v1Result, v1Score], [v2Acc, v2Result, v2Score]]) {
    if (!acc.perScenario[scenario]) {
      acc.perScenario[scenario] = {
        scores: [],
        labels: [],
        gates: Object.fromEntries(THRESHOLDS.map(t => [t, []])),
      };
    }
    const ps = acc.perScenario[scenario];
    ps.scores.push(score);
    ps.labels.push(label);
    acc.allScores.push(score);
    acc.allLabels.push(label);

    for (const threshold of THRESHOLDS) {
      const gate = gateTrustScore(result, { proceed: threshold, stepUp: threshold * 0.5 });
      ps.gates[threshold].push(gate);
      acc.allGates[threshold].push(gate);
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

/**
 * Classification logic:
 *   - label='spoofed' + score < threshold => TP (correctly detected spoof)
 *   - label='spoofed' + score >= threshold => FN (missed spoof)
 *   - label='legitimate' + score >= threshold => TN (correctly allowed)
 *   - label='legitimate' + score < threshold => FP (false alarm)
 */
function computeClassificationMetrics(scores, labels, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < scores.length; i++) {
    const isSpoofed = labels[i] === 'spoofed';
    const belowThreshold = scores[i] < threshold;

    if (isSpoofed && belowThreshold) tp++;
    else if (isSpoofed && !belowThreshold) fn++;
    else if (!isSpoofed && !belowThreshold) tn++;
    else fp++; // legitimate but below threshold
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    tp,
    fp,
    tn,
    fn,
  };
}

function buildVersionResult(acc) {
  // Per-scenario
  const perScenario = {};
  for (const [scenario, data] of Object.entries(acc.perScenario)) {
    const gateDistByThreshold = {};
    for (const t of THRESHOLDS) {
      gateDistByThreshold[`threshold_${t}`] = computeGateDistribution(data.gates[t]);
    }
    perScenario[scenario] = {
      mean_score: round4(mean(data.scores)),
      std_score: round4(std(data.scores)),
      gate_distribution: gateDistByThreshold,
    };
  }

  // Overall
  const overall = {};
  for (const t of THRESHOLDS) {
    overall[`threshold_${t}`] = computeClassificationMetrics(acc.allScores, acc.allLabels, t);
  }

  return { per_scenario: perScenario, overall };
}

const result = {
  timestamp: new Date().toISOString(),
  n_per_scenario: N,
  total_traces: traces.length,
  v1: buildVersionResult(v1Acc),
  v2: buildVersionResult(v2Acc),
};

// ---------------------------------------------------------------------------
// Output JSON to stdout
// ---------------------------------------------------------------------------

process.stdout.write(JSON.stringify(result, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Human-readable summary to stderr
// ---------------------------------------------------------------------------

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function printSummary(label, vResult) {
  process.stderr.write(`\n${'='.repeat(72)}\n`);
  process.stderr.write(`  ${label}\n`);
  process.stderr.write(`${'='.repeat(72)}\n\n`);

  // Per-scenario table
  process.stderr.write('Per-Scenario Breakdown:\n');
  const header = `  ${pad('Scenario', 20)} ${padL('Mean', 8)} ${padL('Std', 8)} ${padL('Proceed', 9)} ${padL('StepUp', 9)} ${padL('Deny', 9)}`;
  process.stderr.write(header + '\n');
  process.stderr.write('  ' + '-'.repeat(header.length - 2) + '\n');

  const scenarios = Object.keys(vResult.per_scenario).sort();
  for (const sc of scenarios) {
    const d = vResult.per_scenario[sc];
    // Use threshold 0.5 for gate distribution display
    const g = d.gate_distribution['threshold_0.5'];
    const line = `  ${pad(sc, 20)} ${padL(d.mean_score.toFixed(4), 8)} ${padL(d.std_score.toFixed(4), 8)} ${padL(g.proceed, 9)} ${padL(g.stepUp, 9)} ${padL(g.deny, 9)}`;
    process.stderr.write(line + '\n');
  }

  // Classification metrics table
  process.stderr.write('\nClassification Metrics (overall):\n');
  const mHeader = `  ${pad('Threshold', 12)} ${padL('Precision', 10)} ${padL('Recall', 10)} ${padL('F1', 10)} ${padL('TP', 8)} ${padL('FP', 8)} ${padL('TN', 8)} ${padL('FN', 8)}`;
  process.stderr.write(mHeader + '\n');
  process.stderr.write('  ' + '-'.repeat(mHeader.length - 2) + '\n');

  for (const t of THRESHOLDS) {
    const m = vResult.overall[`threshold_${t}`];
    const line = `  ${pad(t.toFixed(1), 12)} ${padL(m.precision.toFixed(4), 10)} ${padL(m.recall.toFixed(4), 10)} ${padL(m.f1.toFixed(4), 10)} ${padL(m.tp, 8)} ${padL(m.fp, 8)} ${padL(m.tn, 8)} ${padL(m.fn, 8)}`;
    process.stderr.write(line + '\n');
  }
}

process.stderr.write(`\nEvaluation complete: ${traces.length} traces, ${N} per scenario\n`);
printSummary('Trust Scorer V1 (3 signals)', result.v1);
printSummary('Trust Scorer V2 (5 signals)', result.v2);
process.stderr.write('\n');
