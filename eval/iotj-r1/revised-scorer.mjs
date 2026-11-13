// Candidate fix for S4 (RAIM-style fix consistency) found during the revision.
//
// The submitted S4 compares the raw scatter of the last five fixes with their
// reported accuracy. That silently assumes the fixes are a ~1 Hz burst taken
// while the device barely moves: at a 60 s cadence, or at 1 Hz while driving,
// genuine motion inflates the scatter and S4 penalises honest users.
//
// S4' (this file):
//   - uses only fixes from the last WINDOW_S seconds; with fewer than three,
//     S4 is unavailable and the scorer falls back to the Table I profile
//     without fixes;
//   - removes a constant-velocity trend (least squares per axis) before
//     measuring scatter, so motion no longer counts as inconsistency.
//
// Fix for S2 (accuracy anomaly), S2':
//   - the submitted S2 calls any reported accuracy below 2 m "suspiciously
//     precise". Honest phones report 1-2 m (the dense trace has 187 honest
//     1 m reports), so S2' lowers the cutoff to ACC_CUTOFF_M = 1 m. Mock apps
//     that report a fixed sub-metre accuracy are still flagged. Pass
//     context.accCutoff = 2 to get the submitted S2 back.
//   - the synthetic "accuracy" scenario draws accuracies from [0.1, 1.9] m,
//     i.e. it was built around the submitted cutoff, so it cannot arbitrate
//     between cutoffs.
// Everything else (S1, S3, S5, Table I weights, rounding) is the submitted V2.

import { computeTrustScoreV2 } from './paper-scorer.mjs';

export const WINDOW_S = 15;
export const ACC_CUTOFF_M = 1;

const WEIGHTS = {
  both: { movementPlausibility: 0.30, accuracyAnomaly: 0.10, temporalConsistency: 0.15, fixConsistency: 0.25, networkConsistency: 0.20 },
  fixesOnly: { movementPlausibility: 0.35, accuracyAnomaly: 0.15, temporalConsistency: 0.20, fixConsistency: 0.30 },
  networkOnly: { movementPlausibility: 0.40, accuracyAnomaly: 0.15, temporalConsistency: 0.20, networkConsistency: 0.25 },
  none: { movementPlausibility: 0.50, accuracyAnomaly: 0.20, temporalConsistency: 0.30 },
};

/** Submitted S2 piecewise map with a configurable "suspiciously precise" cutoff. */
export function scoreAccuracyRevised(current, cutoff = ACC_CUTOFF_M) {
  const acc = current.accuracy;
  if (acc === null || acc === undefined) return 0.5;
  if (acc < cutoff) return 0.3;
  if (acc <= 100) return 1.0;
  if (acc <= 500) return 0.7;
  return 0.4;
}

/** Residual scatter (m) after a constant-velocity fit, or null if unavailable. */
export function detrendedScatter(fixes) {
  const n = fixes.length;
  const lat0 = fixes.reduce((s, f) => s + f.lat, 0) / n;
  const lon0 = fixes.reduce((s, f) => s + f.lon, 0) / n;
  const kLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const t0 = Date.parse(fixes[0].timestamp);
  const pts = fixes.map((f) => ({ t: (Date.parse(f.timestamp) - t0) / 1000, x: (f.lon - lon0) * kLon, y: (f.lat - lat0) * 111320 }));
  const tm = pts.reduce((s, p) => s + p.t, 0) / n;
  const stt = pts.reduce((s, p) => s + (p.t - tm) ** 2, 0);
  const axisStd = (key) => {
    const m = pts.reduce((s, p) => s + p[key], 0) / n;
    const slope = stt > 0 ? pts.reduce((s, p) => s + (p.t - tm) * (p[key] - m), 0) / stt : 0;
    const sse = pts.reduce((s, p) => s + (p[key] - m - slope * (p.t - tm)) ** 2, 0);
    return Math.sqrt(sse / Math.max(1, n - (stt > 0 ? 2 : 1)));
  };
  return Math.max(axisStd('x'), axisStd('y'));
}

/** Same piecewise map as the submitted S4, applied to the detrended scatter. */
export function scoreFixConsistencyRevised(current, recentFixes) {
  const tNow = Date.parse(current.timestamp);
  const fixes = recentFixes.filter((f) => {
    const dt = (tNow - Date.parse(f.timestamp)) / 1000;
    return dt >= 0 && dt <= WINDOW_S;
  });
  if (fixes.length < 3) return null;
  const meanAcc = fixes.reduce((s, f) => s + f.accuracy, 0) / fixes.length;
  if (meanAcc <= 0) return 0.5;
  const ratio = detrendedScatter(fixes) / meanAcc;
  if (ratio <= 0.5) return 1.0;
  if (ratio <= 1.0) return 1.0 - 0.3 * ((ratio - 0.5) / 0.5);
  if (ratio <= 2.0) return 0.7 - 0.3 * ((ratio - 1.0) / 1.0);
  return 0.2;
}

export function computeTrustScoreRevised(current, history, context = {}) {
  const s4 = context.recentFixes?.length ? scoreFixConsistencyRevised(current, context.recentFixes) : null;
  const hasNet = context.networkHint != null;
  // S1, S3 and S5 come from the submitted scorer; S2 and S4 are replaced.
  const base = computeTrustScoreV2(current, history, { networkHint: context.networkHint });
  const signals = { ...base.signals, accuracyAnomaly: scoreAccuracyRevised(current, context.accCutoff) };
  if (s4 != null) signals.fixConsistency = s4;
  const w = s4 != null ? (hasNet ? WEIGHTS.both : WEIGHTS.fixesOnly) : (hasNet ? WEIGHTS.networkOnly : WEIGHTS.none);
  const raw = Object.entries(w).reduce((s, [k, wk]) => s + wk * signals[k], 0);
  const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return { trustScore, spoofingSuspected: trustScore < 0.3, signals };
}
