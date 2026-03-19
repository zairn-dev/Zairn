/**
 * Experiment 3: Graduated Response Evaluation
 *
 * Compares binary gate (accept/deny at threshold=0.5) vs graduated gate
 * (proceed/step-up/deny) for trust-based location verification.
 *
 * For graduated gate, step-up is assumed to always succeed for legitimate
 * users (they can prove location) and always fail for spoofers.
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-graduated-response.mjs
 *   node packages/geo-drop/test/evaluate-graduated-response.mjs --n 200
 */

import { performance } from 'node:perf_hooks';
import { generateTraces } from './generate-synthetic-traces.mjs';
import {
  computeTrustScoreV2,
  gateTrustScore,
} from '../dist/trust-scorer.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

let N_PER_SCENARIO = 100;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1 && process.argv[nIdx + 1]) {
  N_PER_SCENARIO = parseInt(process.argv[nIdx + 1], 10);
  if (isNaN(N_PER_SCENARIO) || N_PER_SCENARIO < 1) {
    process.stderr.write('Error: --n must be a positive integer\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const t0 = performance.now();
  const traces = generateTraces(N_PER_SCENARIO);
  const elapsed = performance.now() - t0;
  process.stderr.write(
    `Generated ${traces.length} traces (${N_PER_SCENARIO}/scenario) in ${elapsed.toFixed(0)}ms\n`
  );

  // Accumulators
  const binary = { false_deny: 0, false_accept: 0, correct: 0 };
  const graduated = { false_deny: 0, false_accept: 0, correct: 0, step_up: 0, legitimate_direct: 0 };
  let legitimateCount = 0;
  let spoofedCount = 0;

  const BINARY_THRESHOLD = 0.5;

  for (const trace of traces) {
    const isLegitimate = trace.label === 'legitimate';
    if (isLegitimate) legitimateCount++;
    else spoofedCount++;

    // Compute V2 trust score
    const context = {
      recentFixes: trace.recentFixes,
      networkHint: trace.networkHint,
    };
    const result = computeTrustScoreV2(trace.current, trace.history, context);
    const score = result.trustScore;

    // --- Binary gate ---
    const binaryDecision = score >= BINARY_THRESHOLD ? 'accept' : 'deny';
    if (isLegitimate && binaryDecision === 'deny') binary.false_deny++;
    else if (!isLegitimate && binaryDecision === 'accept') binary.false_accept++;
    else binary.correct++;

    // --- Graduated gate ---
    const gate = gateTrustScore(result); // default: proceed>=0.7, step-up>=0.3
    const inStepUp = gate === 'step-up';
    if (inStepUp) graduated.step_up++;

    // Determine final outcome after step-up resolution
    let gradFinal;
    if (gate === 'proceed') {
      gradFinal = 'accept';
      if (isLegitimate) graduated.legitimate_direct++;
    } else if (gate === 'step-up') {
      // Legitimate users succeed step-up; spoofers fail
      gradFinal = isLegitimate ? 'accept' : 'deny';
    } else {
      // gate === 'deny'
      gradFinal = 'deny';
    }

    if (isLegitimate && gradFinal === 'deny') graduated.false_deny++;
    else if (!isLegitimate && gradFinal === 'accept') graduated.false_accept++;
    else graduated.correct++;
  }

  const total = traces.length;

  const binaryFDR = legitimateCount > 0 ? binary.false_deny / legitimateCount : 0;
  const binaryFAR = spoofedCount > 0 ? binary.false_accept / spoofedCount : 0;
  const binaryAccuracy = total > 0 ? binary.correct / total : 0;

  const graduatedFDR = legitimateCount > 0 ? graduated.false_deny / legitimateCount : 0;
  const graduatedFAR = spoofedCount > 0 ? graduated.false_accept / spoofedCount : 0;
  const graduatedAccuracy = total > 0 ? graduated.correct / total : 0;
  const stepUpRate = total > 0 ? graduated.step_up / total : 0;
  const legitimateDirectRate = legitimateCount > 0
    ? graduated.legitimate_direct / legitimateCount
    : 0;

  const fdrReduction = binaryFDR > 0
    ? ((binaryFDR - graduatedFDR) / binaryFDR) * 100
    : 0;

  const output = {
    timestamp: new Date().toISOString(),
    n_per_scenario: N_PER_SCENARIO,
    total_traces: total,
    legitimate_count: legitimateCount,
    spoofed_count: spoofedCount,
    binary: {
      false_deny_rate: round(binaryFDR, 6),
      false_accept_rate: round(binaryFAR, 6),
      accuracy: round(binaryAccuracy, 6),
    },
    graduated: {
      false_deny_rate: round(graduatedFDR, 6),
      false_accept_rate: round(graduatedFAR, 6),
      accuracy: round(graduatedAccuracy, 6),
      step_up_rate: round(stepUpRate, 6),
      legitimate_direct_proceed_rate: round(legitimateDirectRate, 6),
    },
    improvement: {
      false_deny_reduction_pct: round(fdrReduction, 2),
    },
  };

  // JSON to stdout
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  // Human-readable summary to stderr
  process.stderr.write('\n=== Experiment 3: Graduated Response ===\n');
  process.stderr.write(`Traces: ${total} (${legitimateCount} legitimate, ${spoofedCount} spoofed)\n\n`);

  process.stderr.write('Binary gate (threshold=0.5):\n');
  process.stderr.write(`  False deny rate:   ${(binaryFDR * 100).toFixed(2)}%\n`);
  process.stderr.write(`  False accept rate: ${(binaryFAR * 100).toFixed(2)}%\n`);
  process.stderr.write(`  Accuracy:          ${(binaryAccuracy * 100).toFixed(2)}%\n\n`);

  process.stderr.write('Graduated gate (proceed>=0.7, step-up>=0.3):\n');
  process.stderr.write(`  False deny rate:   ${(graduatedFDR * 100).toFixed(2)}%\n`);
  process.stderr.write(`  False accept rate: ${(graduatedFAR * 100).toFixed(2)}%\n`);
  process.stderr.write(`  Accuracy:          ${(graduatedAccuracy * 100).toFixed(2)}%\n`);
  process.stderr.write(`  Step-up rate:      ${(stepUpRate * 100).toFixed(2)}%\n`);
  process.stderr.write(`  Legit direct proceed: ${(legitimateDirectRate * 100).toFixed(2)}%\n\n`);

  process.stderr.write(`FDR reduction: ${fdrReduction.toFixed(2)}%\n`);
}

function round(val, decimals) {
  const f = 10 ** decimals;
  return Math.round(val * f) / f;
}

run();
