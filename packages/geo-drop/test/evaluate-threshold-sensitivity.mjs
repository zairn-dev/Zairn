/**
 * Experiment 5: Threshold Sensitivity — Grid Search
 *
 * Sweeps proceed and step-up thresholds to find the optimal pair that
 * maximises accuracy while keeping false_deny_rate below 5%.
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-threshold-sensitivity.mjs
 *   node packages/geo-drop/test/evaluate-threshold-sensitivity.mjs --n 200
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

let N_PER_SCENARIO = 500;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1 && process.argv[nIdx + 1]) {
  N_PER_SCENARIO = parseInt(process.argv[nIdx + 1], 10);
  if (isNaN(N_PER_SCENARIO) || N_PER_SCENARIO < 1) {
    process.stderr.write('Error: --n must be a positive integer\n');
    process.exit(1);
  }
}

const PROCEED_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const STEPUP_THRESHOLDS = [0.1, 0.2, 0.3, 0.4];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(val, decimals) {
  const f = 10 ** decimals;
  return Math.round(val * f) / f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const t0 = performance.now();
  const traces = generateTraces(N_PER_SCENARIO);
  const genMs = performance.now() - t0;
  process.stderr.write(
    `Generated ${traces.length} traces (${N_PER_SCENARIO}/scenario) in ${genMs.toFixed(0)}ms\n`
  );

  // Pre-compute V2 scores and labels
  process.stderr.write('Computing V2 trust scores...\n');
  const scored = traces.map((trace) => {
    const context = {
      recentFixes: trace.recentFixes,
      networkHint: trace.networkHint,
    };
    const result = computeTrustScoreV2(trace.current, trace.history, context);
    return {
      label: trace.label,
      scenario: trace.scenario,
      result,
    };
  });

  const legitimateCount = scored.filter((s) => s.label === 'legitimate').length;
  const spoofedCount = scored.filter((s) => s.label === 'spoofed').length;

  // Grid search
  process.stderr.write(
    `Running grid search: ${PROCEED_THRESHOLDS.length} x ${STEPUP_THRESHOLDS.length} = ${PROCEED_THRESHOLDS.length * STEPUP_THRESHOLDS.length} combinations\n`
  );

  const grid = [];

  for (const proceed of PROCEED_THRESHOLDS) {
    for (const stepUp of STEPUP_THRESHOLDS) {
      if (stepUp >= proceed) continue; // step-up must be below proceed

      let correct = 0;
      let falseDeny = 0;
      let falseAccept = 0;
      let stepUpCount = 0;

      for (const item of scored) {
        const isLegitimate = item.label === 'legitimate';
        const gate = gateTrustScore(item.result, { proceed, stepUp });

        if (gate === 'step-up') stepUpCount++;

        // Resolve step-up: legitimate succeed, spoofers fail
        let finalDecision;
        if (gate === 'proceed') {
          finalDecision = 'accept';
        } else if (gate === 'step-up') {
          finalDecision = isLegitimate ? 'accept' : 'deny';
        } else {
          finalDecision = 'deny';
        }

        if (isLegitimate && finalDecision === 'deny') falseDeny++;
        else if (!isLegitimate && finalDecision === 'accept') falseAccept++;
        else correct++;
      }

      const total = scored.length;
      grid.push({
        proceed,
        stepUp,
        accuracy: round(correct / total, 6),
        false_deny_rate: round(legitimateCount > 0 ? falseDeny / legitimateCount : 0, 6),
        false_accept_rate: round(spoofedCount > 0 ? falseAccept / spoofedCount : 0, 6),
        step_up_rate: round(stepUpCount / total, 6),
      });
    }
  }

  // Find optimal: highest accuracy with false_deny_rate < 5%
  const eligible = grid.filter((g) => g.false_deny_rate < 0.05);
  let optimal;
  if (eligible.length > 0) {
    optimal = eligible.reduce((best, g) =>
      g.accuracy > best.accuracy ? g : best
    );
  } else {
    // Fallback: lowest false_deny_rate
    optimal = grid.reduce((best, g) =>
      g.false_deny_rate < best.false_deny_rate ? g : best
    );
  }

  const output = {
    timestamp: new Date().toISOString(),
    n_per_scenario: N_PER_SCENARIO,
    total_traces: scored.length,
    legitimate_count: legitimateCount,
    spoofed_count: spoofedCount,
    grid,
    optimal: {
      proceed: optimal.proceed,
      stepUp: optimal.stepUp,
      accuracy: optimal.accuracy,
      false_deny_rate: optimal.false_deny_rate,
      false_accept_rate: optimal.false_accept_rate,
    },
  };

  // JSON to stdout
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  // Human-readable summary to stderr
  process.stderr.write('\n=== Experiment 5: Threshold Sensitivity ===\n');
  process.stderr.write(`Traces: ${scored.length} (${legitimateCount} legitimate, ${spoofedCount} spoofed)\n\n`);

  process.stderr.write('Grid results:\n');
  process.stderr.write(
    '  Proceed  StepUp  Accuracy   FDR        FAR        StepUp%\n'
  );
  process.stderr.write(
    '  -------  ------  --------   --------   --------   -------\n'
  );
  for (const g of grid) {
    process.stderr.write(
      `  ${g.proceed.toFixed(1).padStart(7)}  ${g.stepUp.toFixed(1).padStart(6)}  ${(g.accuracy * 100).toFixed(2).padStart(7)}%  ${(g.false_deny_rate * 100).toFixed(2).padStart(7)}%  ${(g.false_accept_rate * 100).toFixed(2).padStart(7)}%  ${(g.step_up_rate * 100).toFixed(2).padStart(6)}%\n`
    );
  }

  process.stderr.write(
    `\nOptimal (accuracy-maximising, FDR < 5%):\n`
  );
  process.stderr.write(`  proceed=${optimal.proceed}, stepUp=${optimal.stepUp}\n`);
  process.stderr.write(`  Accuracy: ${(optimal.accuracy * 100).toFixed(2)}%\n`);
  process.stderr.write(`  FDR:      ${(optimal.false_deny_rate * 100).toFixed(2)}%\n`);
  process.stderr.write(`  FAR:      ${(optimal.false_accept_rate * 100).toFixed(2)}%\n`);
}

run();
