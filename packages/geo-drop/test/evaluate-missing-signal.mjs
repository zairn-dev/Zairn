/**
 * Experiment: Missing Signal Robustness
 *
 * Evaluates trust scorer V2 behaviour when device signals are degraded
 * or unavailable — common in IoT deployments where devices have varying
 * sensor capabilities (airplane mode, indoor GPS loss, cheap receivers).
 *
 * Scenarios:
 *   1. all_signals        — baseline with recentFixes + networkHint
 *   2. no_network         — airplane mode (networkHint = undefined)
 *   3. no_fixes           — no raw GPS fixes (recentFixes = undefined)
 *   4. v1_fallback        — neither fixes nor network (V1 path)
 *   5. degraded_gps       — accuracy inflated to 100-500m
 *   6. intermittent_fixes — only 1-2 fixes instead of 5
 *
 * Usage:
 *   node evaluate-missing-signal.mjs              # N=500 per scenario
 *   node evaluate-missing-signal.mjs --n 200      # custom N
 *
 * Output: JSON to stdout, summary table to stderr.
 */

import { computeTrustScoreV2 } from '../dist/trust-scorer.js';
import { generateTraces } from './generate-synthetic-traces.mjs';

// ═══════════════════════════════════════════════════════════════
// CLI argument parsing
// ═══════════════════════════════════════════════════════════════

let N = 500;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1 && process.argv[nIdx + 1]) {
  N = parseInt(process.argv[nIdx + 1], 10);
  if (isNaN(N) || N < 1) {
    process.stderr.write('Error: --n must be a positive integer\n');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// Trace transformers — one per degradation scenario
// ═══════════════════════════════════════════════════════════════

/** Seeded PRNG for deterministic degradation (xorshift128+). */
function createRng(seed) {
  let s0 = 0;
  let s1 = 0;
  for (let i = 0; i < seed.length; i++) {
    s0 = (s0 * 31 + seed.charCodeAt(i)) | 0;
    s1 = (s1 * 37 + seed.charCodeAt(i)) | 0;
  }
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
    return ((s0 + s1) >>> 0) / 0x100000000;
  }

  return {
    random: next,
    uniform(lo, hi) { return lo + next() * (hi - lo); },
  };
}

/**
 * Return context object for computeTrustScoreV2 from a trace,
 * applying the specified degradation transform.
 */
function buildContext(trace, scenario, idx) {
  switch (scenario) {
    case 'all_signals':
      return {
        recentFixes: trace.recentFixes,
        networkHint: trace.networkHint,
      };

    case 'no_network':
      return {
        recentFixes: trace.recentFixes,
        networkHint: undefined,
      };

    case 'no_fixes':
      return {
        recentFixes: undefined,
        networkHint: trace.networkHint,
      };

    case 'v1_fallback':
      return {
        recentFixes: undefined,
        networkHint: undefined,
      };

    case 'degraded_gps': {
      // Inflate accuracy of each fix to 100-500m
      const rng = createRng(`degraded-${idx}`);
      const degraded = trace.recentFixes
        ? trace.recentFixes.map(f => ({
            ...f,
            accuracy: rng.uniform(100, 500),
          }))
        : undefined;
      return {
        recentFixes: degraded,
        networkHint: trace.networkHint,
      };
    }

    case 'intermittent_fixes': {
      // Truncate fixes to 1-2 instead of the full set
      const rng = createRng(`intermittent-${idx}`);
      const keep = Math.round(rng.uniform(1, 2));
      const truncated = trace.recentFixes
        ? trace.recentFixes.slice(0, keep)
        : undefined;
      return {
        recentFixes: truncated,
        networkHint: trace.networkHint,
      };
    }

    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Metrics computation
// ═══════════════════════════════════════════════════════════════

function computeMetrics(scores, labels, threshold = 0.7) {
  const legitScores = [];
  const spoofScores = [];
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const isLegit = labels[i] === 'legitimate';

    if (isLegit) {
      legitScores.push(s);
    } else {
      spoofScores.push(s);
    }

    // For classification: score >= threshold → predict legitimate
    const predictLegit = s >= threshold;
    if (isLegit && predictLegit) tp++;
    else if (isLegit && !predictLegit) fn++;
    else if (!isLegit && predictLegit) fp++;
    else tn++;
  }

  const legitMean = legitScores.length > 0
    ? legitScores.reduce((a, b) => a + b, 0) / legitScores.length
    : 0;
  const spoofMean = spoofScores.length > 0
    ? spoofScores.reduce((a, b) => a + b, 0) / spoofScores.length
    : 0;

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  // False deny rate: fraction of legitimate traces scored below threshold
  const falseDenies = legitScores.filter(s => s < threshold).length;
  const fdr = legitScores.length > 0 ? falseDenies / legitScores.length : 0;

  return {
    legit_mean: round4(legitMean),
    spoof_mean: round4(spoofMean),
    separation: round4(legitMean - spoofMean),
    f1: round4(f1),
    fdr: round4(fdr),
  };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ═══════════════════════════════════════════════════════════════
// Main evaluation
// ═══════════════════════════════════════════════════════════════

const SCENARIOS = [
  'all_signals',
  'no_network',
  'no_fixes',
  'v1_fallback',
  'degraded_gps',
  'intermittent_fixes',
];

process.stderr.write(`Generating ${N} traces per scenario (${N * 10} total)...\n`);
const traces = generateTraces(N);

const results = {};

for (const scenario of SCENARIOS) {
  const scores = [];
  const labels = [];

  for (let i = 0; i < traces.length; i++) {
    const trace = traces[i];
    const context = buildContext(trace, scenario, i);
    const result = computeTrustScoreV2(trace.current, trace.history, context);
    scores.push(result.trustScore);
    labels.push(trace.label);
  }

  results[scenario] = computeMetrics(scores, labels);
}

// ═══════════════════════════════════════════════════════════════
// Output
// ═══════════════════════════════════════════════════════════════

const output = {
  timestamp: new Date().toISOString(),
  n_per_scenario: N,
  scenarios: results,
};

// JSON to stdout
process.stdout.write(JSON.stringify(output, null, 2) + '\n');

// Summary table to stderr
const sep = '-'.repeat(82);
process.stderr.write('\n' + sep + '\n');
process.stderr.write(
  'Scenario'.padEnd(22) +
  'Legit'.padStart(8) +
  'Spoof'.padStart(8) +
  'Sep'.padStart(8) +
  'F1'.padStart(8) +
  'FDR'.padStart(8) +
  '\n'
);
process.stderr.write(sep + '\n');

for (const scenario of SCENARIOS) {
  const m = results[scenario];
  process.stderr.write(
    scenario.padEnd(22) +
    m.legit_mean.toFixed(4).padStart(8) +
    m.spoof_mean.toFixed(4).padStart(8) +
    m.separation.toFixed(4).padStart(8) +
    m.f1.toFixed(4).padStart(8) +
    m.fdr.toFixed(4).padStart(8) +
    '\n'
  );
}

process.stderr.write(sep + '\n');
process.stderr.write(`\nDone. ${N} traces x ${SCENARIOS.length} scenarios evaluated.\n`);
