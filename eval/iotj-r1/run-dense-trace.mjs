// Legitimate-side behaviour of the paper scorer on a 22-day always-on Android
// trace (60 s cadence), and the binary/graduated trade-off when the spoofed
// side comes from the synthetic test split.
//
// The trace holds private coordinates (home, work) and is not in this
// repository. Only aggregates are written.
//
// Usage: node eval/iotj-r1/run-dense-trace.mjs [path/to/raw-trace.json]
//   default path: ../openZenly/eval/dense-trace/raw-2026-04-26.json
// Writes results/dense-trace.json; prints a summary to stderr.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScore, computeTrustScoreV2 } from './paper-scorer.mjs';
import { syntheticSplit } from './data.mjs';
import { atThreshold, gradedGate } from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tracePath = resolve(process.argv[2] ?? join(here, '../../../openZenly/eval/dense-trace/raw-2026-04-26.json'));
const raw = JSON.parse(readFileSync(tracePath, 'utf8'));

// `timestamp` in the raw file is local time without an offset; `ts` is epoch ms.
const fixes = raw.trace.map((p) => ({
  lat: p.lat, lon: p.lon, accuracy: p.accuracy, timestamp: new Date(p.ts).toISOString(),
}));

const SESSION_GAP_MS = 5 * 60_000;
const WINDOW_MINUTES = [10, 30];
const THETAS = [0.3, 0.5, 0.7, 0.8, 0.9, 0.95];

// Same windowing as packages/geo-drop/test/evaluate-real-traces.mjs:
// history = all earlier fixes (newest first), recentFixes = last 5 incl. current.
function scoreAll() {
  const out = [];
  for (let i = 1; i < fixes.length; i++) {
    const current = fixes[i];
    const history = fixes.slice(Math.max(0, i - 10), i).reverse();
    const recentFixes = fixes.slice(Math.max(0, i - 4), i + 1);
    const v1 = computeTrustScore(current, history);
    const v2 = computeTrustScoreV2(current, history, { recentFixes });
    const gapMs = Date.parse(current.timestamp) - Date.parse(fixes[i - 1].timestamp);
    out.push({ t: Date.parse(current.timestamp), gapMs, v1: v1.trustScore, v2: v2.trustScore, signals: v2.signals });
  }
  return out;
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const quantiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.floor(p * (s.length - 1))];
  return { n: s.length, mean: r4(s.reduce((a, b) => a + b, 0) / s.length), min: s[0], p01: q(0.01), p05: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5) };
};
const below = (xs) => Object.fromEntries(THETAS.map((th) => [th, r4(xs.filter((x) => x < th).length / xs.length)]));

const scored = scoreAll();

// Which signal pulls a legitimate fix below 0.9?
const SIGNALS = ['movementPlausibility', 'accuracyAnomaly', 'temporalConsistency', 'fixConsistency'];
const lowV2 = scored.filter((s) => s.v2 < 0.9);
const causes = Object.fromEntries(SIGNALS.map((k) => [k, r4(lowV2.filter((s) => s.signals[k] < 1).length / Math.max(1, lowV2.length))]));

// Fixes right after a recording gap carry stale history; report them apart.
const afterGap = scored.filter((s) => s.gapMs > SESSION_GAP_MS);
const steady = scored.filter((s) => s.gapMs <= SESSION_GAP_MS);

// Session latch false-trigger rate: share of app sessions (fixed windows of
// consecutive fixes) in which any fix falls below thetaP, i.e. the latch
// would have forced a step-up or deny for an honest user.
function latchRates(key) {
  const res = {};
  for (const minutes of WINDOW_MINUTES) {
    const windows = new Map();
    for (const s of steady) {
      const w = Math.floor(s.t / (minutes * 60_000));
      const cur = windows.get(w) ?? Infinity;
      windows.set(w, Math.min(cur, s[key]));
    }
    const mins = [...windows.values()];
    res[`${minutes}min`] = { windows: mins.length, ...Object.fromEntries([0.3, 0.7, 0.9].map((th) => [th, r4(mins.filter((m) => m < th).length / mins.length)])) };
  }
  return res;
}

// Trade-off with a realistic legitimate tail: dense-trace legit vs synthetic
// test-split spoofed traces scored with the same profile (S1-S4, no network).
const spoof = syntheticSplit('test').filter((t) => t.label === 'spoofed').map((t) => ({
  pos: true, scenario: t.scenario,
  score: computeTrustScoreV2(t.current, t.history, { recentFixes: t.recentFixes }).trustScore,
}));
// V1 is the profile the scorer falls back to when neither fixes nor a network
// hint are available, which is the realistic case at a 60 s cadence.
const spoofV1 = syntheticSplit('test').filter((t) => t.label === 'spoofed').map((t) => ({
  pos: true, scenario: t.scenario, score: computeTrustScore(t.current, t.history).trustScore,
}));
function tradeoffFor(key, spoofItems) {
  const mixed = [...steady.map((s) => ({ pos: false, scenario: 'dense', score: s[key] })), ...spoofItems];
  return [0.7, 0.8, 0.9, 0.95].map((thetaP) => {
    const bin = atThreshold(mixed, thetaP);
    const grad = gradedGate(mixed, thetaP, 0.3);
    return {
      thetaP,
      binary: { far: r4(bin.far), fdr: r4(bin.fdr) },
      graduated: { farOracle: r4(grad.far), fdrOracle: r4(grad.fdr), mL: r4(grad.mL), mS: r4(grad.mS) },
    };
  });
}
const tradeoff = { v1: tradeoffFor('v1', spoofV1), v2NoNetwork: tradeoffFor('v2', spoof) };

const results = {
  generated: new Date().toISOString(),
  trace: { device: raw.meta.device, intervalSeconds: raw.meta.intervalSeconds, fixes: fixes.length, days: r4((fixes.at(-1) && (Date.parse(fixes.at(-1).timestamp) - Date.parse(fixes[0].timestamp)) / 86_400_000)) },
  scored: scored.length, afterGap: afterGap.length,
  v1: { all: quantiles(scored.map((s) => s.v1)), below: below(steady.map((s) => s.v1)) },
  v2: { all: quantiles(scored.map((s) => s.v2)), steady: quantiles(steady.map((s) => s.v2)), below: below(steady.map((s) => s.v2)), belowAfterGap: below(afterGap.map((s) => s.v2)) },
  lowV2Causes: { n: lowV2.length, shareWithSignalBelow1: causes },
  latch: { v1: latchRates('v1'), v2: latchRates('v2') },
  syntheticSpoofProfile: 'test split; v1 = S1-S3, v2NoNetwork = S1-S4',
  tradeoff,
};

mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'dense-trace.json'), JSON.stringify(results, null, 2));
process.stderr.write(JSON.stringify(results, null, 2) + '\n');
