/**
 * Experiment 4: Trust Scorer Performance Benchmark
 *
 * Compares V1 (computeTrustScore) vs V2 (computeTrustScoreV2) latency
 * across synthetic traces. Reports median, mean, p95, p99, min, max.
 *
 * Usage:
 *   node packages/geo-drop/test/benchmark-trust-scorer.mjs
 *   node packages/geo-drop/test/benchmark-trust-scorer.mjs --n 50
 */

import { performance } from 'node:perf_hooks';
import { generateTraces } from './generate-synthetic-traces.mjs';
import {
  computeTrustScore,
  computeTrustScoreV2,
} from '../dist/trust-scorer.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

let N_PER_SCENARIO = 10;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1 && process.argv[nIdx + 1]) {
  N_PER_SCENARIO = parseInt(process.argv[nIdx + 1], 10);
  if (isNaN(N_PER_SCENARIO) || N_PER_SCENARIO < 1) {
    process.stderr.write('Error: --n must be a positive integer\n');
    process.exit(1);
  }
}

const WARMUP_ITERS = 100;
const BENCH_ITERS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    median_us: round(percentile(sorted, 50) * 1000, 3),
    mean_us: round((sum / sorted.length) * 1000, 3),
    p95_us: round(percentile(sorted, 95) * 1000, 3),
    p99_us: round(percentile(sorted, 99) * 1000, 3),
    min_us: round(sorted[0] * 1000, 3),
    max_us: round(sorted[sorted.length - 1] * 1000, 3),
  };
}

function round(val, decimals) {
  const f = 10 ** decimals;
  return Math.round(val * f) / f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const traces = generateTraces(N_PER_SCENARIO);
  process.stderr.write(
    `Generated ${traces.length} traces (${N_PER_SCENARIO}/scenario)\n`
  );

  // Build input pairs
  const inputs = traces.map((t) => ({
    current: t.current,
    history: t.history,
    context: {
      recentFixes: t.recentFixes,
      networkHint: t.networkHint,
    },
  }));

  // --- Warm-up ---
  process.stderr.write(`Warming up (${WARMUP_ITERS} iterations each)...\n`);
  for (let i = 0; i < WARMUP_ITERS; i++) {
    const inp = inputs[i % inputs.length];
    computeTrustScore(inp.current, inp.history);
    computeTrustScoreV2(inp.current, inp.history, inp.context);
  }

  // --- Benchmark V1 ---
  process.stderr.write(`Benchmarking V1 (${BENCH_ITERS} iterations)...\n`);
  const v1Times = [];
  for (let i = 0; i < BENCH_ITERS; i++) {
    const inp = inputs[i % inputs.length];
    const t0 = performance.now();
    computeTrustScore(inp.current, inp.history);
    v1Times.push(performance.now() - t0);
  }

  // --- Benchmark V2 ---
  process.stderr.write(`Benchmarking V2 (${BENCH_ITERS} iterations)...\n`);
  const v2Times = [];
  for (let i = 0; i < BENCH_ITERS; i++) {
    const inp = inputs[i % inputs.length];
    const t0 = performance.now();
    computeTrustScoreV2(inp.current, inp.history, inp.context);
    v2Times.push(performance.now() - t0);
  }

  const v1Stats = stats(v1Times);
  const v2Stats = stats(v2Times);
  const overheadPct = v1Stats.median_us > 0
    ? round(((v2Stats.median_us - v1Stats.median_us) / v1Stats.median_us) * 100, 2)
    : 0;

  const output = {
    timestamp: new Date().toISOString(),
    iterations: BENCH_ITERS,
    warmup: WARMUP_ITERS,
    traces_used: inputs.length,
    v1: v1Stats,
    v2: v2Stats,
    overhead_pct: overheadPct,
  };

  // JSON to stdout
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  // Human-readable summary to stderr
  process.stderr.write('\n=== Experiment 4: Trust Scorer Benchmark ===\n');
  process.stderr.write(`Iterations: ${BENCH_ITERS} (warmup: ${WARMUP_ITERS})\n\n`);

  process.stderr.write('V1 (computeTrustScore):\n');
  process.stderr.write(`  Median: ${v1Stats.median_us} us\n`);
  process.stderr.write(`  Mean:   ${v1Stats.mean_us} us\n`);
  process.stderr.write(`  P95:    ${v1Stats.p95_us} us\n`);
  process.stderr.write(`  P99:    ${v1Stats.p99_us} us\n`);
  process.stderr.write(`  Range:  ${v1Stats.min_us} - ${v1Stats.max_us} us\n\n`);

  process.stderr.write('V2 (computeTrustScoreV2):\n');
  process.stderr.write(`  Median: ${v2Stats.median_us} us\n`);
  process.stderr.write(`  Mean:   ${v2Stats.mean_us} us\n`);
  process.stderr.write(`  P95:    ${v2Stats.p95_us} us\n`);
  process.stderr.write(`  P99:    ${v2Stats.p99_us} us\n`);
  process.stderr.write(`  Range:  ${v2Stats.min_us} - ${v2Stats.max_us} us\n\n`);

  process.stderr.write(`V2 overhead: ${overheadPct}% (median)\n`);
}

run();
