/**
 * ROC and PR curve evaluation for trust scorer V1 vs V2.
 *
 * Generates synthetic traces, scores them with both versions,
 * sweeps thresholds to produce ROC / PR curves, and computes
 * AUC-ROC, AUC-PR, and EER.
 *
 * Usage:
 *   node evaluate-roc-curve.mjs              # default N=1000 per scenario
 *   node evaluate-roc-curve.mjs --n 500      # 500 per scenario
 *
 * Output: JSON to stdout, summary to stderr.
 * No external dependencies.
 */

import { computeTrustScore, computeTrustScoreV2 } from '../dist/trust-scorer.js';
import { generateTraces } from './generate-synthetic-traces.mjs';

// ---------------------------------------------------------------------------
// CLI args
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
// Generate and score traces
// ---------------------------------------------------------------------------

process.stderr.write(`Generating ${N} traces per scenario (${N * 10} total)...\n`);
const traces = generateTraces(N);

process.stderr.write('Scoring traces...\n');

const scored = traces.map((t) => {
  const isPositive = t.label === 'spoofed'; // positive = spoofed

  const v1Result = computeTrustScore(t.current, t.history);
  const v2Result = computeTrustScoreV2(t.current, t.history, {
    recentFixes: t.recentFixes,
    networkHint: t.networkHint,
  });

  return {
    isPositive,
    scenario: t.scenario,
    v1Score: v1Result.trustScore,
    v2Score: v2Result.trustScore,
  };
});

// ---------------------------------------------------------------------------
// Threshold sweep
// ---------------------------------------------------------------------------

const THRESHOLDS = [];
for (let i = 0; i <= 100; i++) {
  THRESHOLDS.push(Math.round(i * 0.01 * 100) / 100); // 0.00 .. 1.00
}

/**
 * Given an array of { isPositive, score } and a threshold,
 * classify: score < threshold -> predicted positive (spoofed)
 *           score >= threshold -> predicted negative (legitimate)
 *
 * Returns { tp, fp, tn, fn }
 */
function confusionMatrix(items, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { isPositive, score } of items) {
    const predictedPositive = score < threshold;
    if (isPositive && predictedPositive) tp++;
    else if (!isPositive && predictedPositive) fp++;
    else if (!isPositive && !predictedPositive) tn++;
    else fn++; // isPositive && !predictedPositive
  }
  return { tp, fp, tn, fn };
}

/**
 * Compute ROC and PR curves for one version.
 * items: [{ isPositive, score }]
 */
function computeCurves(items) {
  const totalPositive = items.filter((x) => x.isPositive).length;
  const totalNegative = items.length - totalPositive;

  const rocCurve = [];
  const prCurve = [];

  for (const threshold of THRESHOLDS) {
    const { tp, fp, fn } = confusionMatrix(items, threshold);

    const tpr = totalPositive > 0 ? tp / totalPositive : 0;           // recall
    const fpr = totalNegative > 0 ? fp / totalNegative : 0;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;             // no predictions -> precision=1 by convention

    rocCurve.push({
      threshold,
      tpr: Math.round(tpr * 1e6) / 1e6,
      fpr: Math.round(fpr * 1e6) / 1e6,
    });

    prCurve.push({
      threshold,
      precision: Math.round(precision * 1e6) / 1e6,
      recall: Math.round(tpr * 1e6) / 1e6,
    });
  }

  return { rocCurve, prCurve };
}

// ---------------------------------------------------------------------------
// Trapezoidal AUC
// ---------------------------------------------------------------------------

/**
 * Compute AUC via trapezoidal rule.
 * points: [{ x, y }] — need NOT be sorted; will sort by x ascending.
 */
function trapezoidalAUC(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  let area = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dx = sorted[i].x - sorted[i - 1].x;
    const avgY = (sorted[i].y + sorted[i - 1].y) / 2;
    area += dx * avgY;
  }
  return Math.round(area * 1e6) / 1e6;
}

function aucROC(rocCurve) {
  // ROC: x=FPR, y=TPR
  const points = rocCurve.map((p) => ({ x: p.fpr, y: p.tpr }));
  return trapezoidalAUC(points);
}

function aucPR(prCurve) {
  // PR: x=Recall, y=Precision
  const points = prCurve.map((p) => ({ x: p.recall, y: p.precision }));
  return trapezoidalAUC(points);
}

// ---------------------------------------------------------------------------
// Equal Error Rate
// ---------------------------------------------------------------------------

/**
 * EER: threshold where FPR ~ FNR (= 1 - TPR).
 * Returns { threshold, eer }.
 */
function computeEER(rocCurve) {
  let bestThreshold = 0;
  let bestDiff = Infinity;
  let bestEER = 0;

  for (const { threshold, tpr, fpr } of rocCurve) {
    const fnr = 1 - tpr;
    const diff = Math.abs(fpr - fnr);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestThreshold = threshold;
      bestEER = (fpr + fnr) / 2; // average as EER estimate
    }
  }

  return {
    threshold: bestThreshold,
    eer: Math.round(bestEER * 1e6) / 1e6,
  };
}

// ---------------------------------------------------------------------------
// Run evaluation
// ---------------------------------------------------------------------------

function evaluate(version, items) {
  const { rocCurve, prCurve } = computeCurves(items);
  const auc_roc = aucROC(rocCurve);
  const auc_pr = aucPR(prCurve);
  const eer = computeEER(rocCurve);

  return { auc_roc, auc_pr, eer, roc_curve: rocCurve, pr_curve: prCurve };
}

const v1Items = scored.map((s) => ({ isPositive: s.isPositive, score: s.v1Score }));
const v2Items = scored.map((s) => ({ isPositive: s.isPositive, score: s.v2Score }));

process.stderr.write('Computing curves...\n');

const v1 = evaluate('V1', v1Items);
const v2 = evaluate('V2', v2Items);

const result = {
  timestamp: new Date().toISOString(),
  n_per_scenario: N,
  v1: {
    auc_roc: v1.auc_roc,
    auc_pr: v1.auc_pr,
    eer: v1.eer,
    roc_curve: v1.roc_curve,
    pr_curve: v1.pr_curve,
  },
  v2: {
    auc_roc: v2.auc_roc,
    auc_pr: v2.auc_pr,
    eer: v2.eer,
    roc_curve: v2.roc_curve,
    pr_curve: v2.pr_curve,
  },
  improvement: {
    auc_roc_delta: Math.round((v2.auc_roc - v1.auc_roc) * 1e6) / 1e6,
    auc_pr_delta: Math.round((v2.auc_pr - v1.auc_pr) * 1e6) / 1e6,
  },
};

// ---------------------------------------------------------------------------
// Summary to stderr
// ---------------------------------------------------------------------------

process.stderr.write('\n========== ROC / PR Evaluation ==========\n');
process.stderr.write(`Traces: ${scored.length} (${N} per scenario x 10 scenarios)\n`);
process.stderr.write(`  Positive (spoofed):    ${v1Items.filter((x) => x.isPositive).length}\n`);
process.stderr.write(`  Negative (legitimate): ${v1Items.filter((x) => !x.isPositive).length}\n\n`);

process.stderr.write('V1 (3-signal):\n');
process.stderr.write(`  AUC-ROC: ${v1.auc_roc.toFixed(4)}\n`);
process.stderr.write(`  AUC-PR:  ${v1.auc_pr.toFixed(4)}\n`);
process.stderr.write(`  EER:     ${v1.eer.eer.toFixed(4)} @ threshold=${v1.eer.threshold.toFixed(2)}\n\n`);

process.stderr.write('V2 (5-signal):\n');
process.stderr.write(`  AUC-ROC: ${v2.auc_roc.toFixed(4)}\n`);
process.stderr.write(`  AUC-PR:  ${v2.auc_pr.toFixed(4)}\n`);
process.stderr.write(`  EER:     ${v2.eer.eer.toFixed(4)} @ threshold=${v2.eer.threshold.toFixed(2)}\n\n`);

process.stderr.write('Improvement (V2 - V1):\n');
process.stderr.write(`  AUC-ROC: ${result.improvement.auc_roc_delta >= 0 ? '+' : ''}${result.improvement.auc_roc_delta.toFixed(4)}\n`);
process.stderr.write(`  AUC-PR:  ${result.improvement.auc_pr_delta >= 0 ? '+' : ''}${result.improvement.auc_pr_delta.toFixed(4)}\n`);
process.stderr.write('=========================================\n');

// ---------------------------------------------------------------------------
// JSON to stdout
// ---------------------------------------------------------------------------

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
