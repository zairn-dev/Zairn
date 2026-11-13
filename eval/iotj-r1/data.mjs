// Synthetic splits and scoring helpers for the IoT-J revision.

import { generateTraces } from '../../packages/geo-drop/test/generate-synthetic-traces.mjs';
import { computeTrustScore, computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';

// Each trace is seeded by `${scenario}-${index}`, so disjoint index ranges are
// independent sets. `dev` is exactly the 10,000 traces of the submitted
// manuscript (indices 0..999 per scenario), on which the weights and
// thresholds were developed; `val` and `test` were never seen before the
// revision.
export const SPLIT_OFFSETS = { dev: 0, val: 100_000, test: 200_000 };

export function syntheticSplit(name, perScenario = 1000) {
  const offset = SPLIT_OFFSETS[name];
  if (offset === undefined) throw new Error(`unknown split: ${name}`);
  return generateTraces(perScenario, offset);
}

export const scoreV1 = (t) => computeTrustScore(t.current, t.history);
export const scoreV2 = (t) =>
  computeTrustScoreV2(t.current, t.history, {
    recentFixes: t.recentFixes,
    networkHint: t.networkHint,
  });

/** Revised scorer V2r (S2' and S4', see revised-scorer.mjs), same inputs as V2. */
export const scoreV2r = (t) =>
  computeTrustScoreRevised(t.current, t.history, {
    recentFixes: t.recentFixes,
    networkHint: t.networkHint,
  });

export function toItems(traces, score) {
  return traces.map((t) => {
    const r = score(t);
    return { pos: t.label === 'spoofed', score: r.trustScore, scenario: t.scenario, signals: r.signals };
  });
}
