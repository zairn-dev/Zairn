// Shared helpers for the weight-sensitivity and Shapley analyses
// (run-weights.mjs, run-shapley.mjs; reviewer items R1-8/R2-4/R3-3, R1-1/R2-5).
//
// The five signals are computed once per trace with the frozen scorers
// (paper-scorer.mjs for the submitted S1..S5, revised-scorer.mjs for S2'/S4';
// both already return every signal in `signals`, so neither file is touched)
// and kept as an n x 5 matrix. Any weight vector w is then applied the way
// the submitted ablation (packages/geo-drop/test/evaluate-signal-ablation.mjs)
// does: the score is the weighted mean of the active, available signals with
// weights renormalised to sum 1, rounded to 0.01. With the Table I all-five
// weights this is the submitted V2 score bit for bit (checked by the scripts).
//
// Rounded scores are integers k = 0..100 (score = k / 100), a trace is
// flagged as spoofed when k < kTheta, and all metrics below run on per-class
// histograms over k. They agree with metrics.mjs (tie-aware AP and AUC).

import { generateTraces } from '../../packages/geo-drop/test/generate-synthetic-traces.mjs';
import { SPLIT_OFFSETS } from './data.mjs';
import { computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';

export const SIGNALS = ['S1', 'S2', 'S3', 'S4', 'S5'];
const KEYS = ['movementPlausibility', 'accuracyAnomaly', 'temporalConsistency', 'fixConsistency', 'networkConsistency'];

export const TABLE_I = {
  all5: [0.30, 0.10, 0.15, 0.25, 0.20],
  noNetwork: [0.35, 0.15, 0.20, 0.30, 0],
};

// Score of a trace none of whose active signals is available. This only
// happens for the coalition {S4} on revised signals, where S4' is undefined
// for every replay trace (its fixes postdate the current point); the value is
// the submitted S4's "insufficient data" score.
export const EMPTY_SCORE = 0.8;

const K = 101; // score bins k = 0..100

/**
 * Signal matrices for one split: { submitted, revised }, each
 * { n, X (n*5, NaN = unavailable), pos, scenario, refK (scorer's own score) }.
 */
export function signalMatrices(split, perScenario = 1000) {
  const traces = generateTraces(perScenario, SPLIT_OFFSETS[split]);
  const n = traces.length;
  const make = (variant) => ({
    split, variant, n,
    X: new Float64Array(n * 5), refK: new Uint8Array(n),
    pos: new Uint8Array(n), scenario: new Array(n),
  });
  const out = { submitted: make('submitted'), revised: make('revised') };
  traces.forEach((t, i) => {
    const ctx = { recentFixes: t.recentFixes, networkHint: t.networkHint };
    const r = {
      submitted: computeTrustScoreV2(t.current, t.history, ctx),
      revised: computeTrustScoreRevised(t.current, t.history, ctx),
    };
    for (const v of ['submitted', 'revised']) {
      const m = out[v];
      KEYS.forEach((key, j) => { m.X[i * 5 + j] = r[v].signals[key] ?? NaN; });
      m.refK[i] = Math.round(r[v].trustScore * 100);
      m.pos[i] = t.label === 'spoofed' ? 1 : 0;
      m.scenario[i] = t.scenario;
    }
  });
  return out;
}

/** Rounded weighted-mean score k (0..100) per trace for weights w (length 5). */
export function scoreK(m, w) {
  const k = new Uint8Array(m.n);
  for (let i = 0; i < m.n; i++) {
    let total = 0;
    for (let j = 0; j < 5; j++) if (w[j] > 0 && !Number.isNaN(m.X[i * 5 + j])) total += w[j];
    let s = EMPTY_SCORE;
    if (total > 0) {
      s = 0;
      for (let j = 0; j < 5; j++) {
        const x = m.X[i * 5 + j];
        if (w[j] > 0 && !Number.isNaN(x)) s += (w[j] / total) * x;
      }
    }
    k[i] = Math.round(Math.max(0, Math.min(1, s)) * 100);
  }
  return k;
}

/** Weights of the subset `mask` (bit j = signal j) with base weights w. */
export function maskWeights(mask, w = TABLE_I.all5) {
  return w.map((x, j) => ((mask >> j) & 1 ? x : 0));
}

export const maskName = (mask) => SIGNALS.filter((_, j) => (mask >> j) & 1).join('+') || '{}';

/** Indices of traces satisfying pred(i). */
export function indices(m, pred) {
  const out = [];
  for (let i = 0; i < m.n; i++) if (pred(i)) out.push(i);
  return out;
}

/** Per-class histograms over k, optionally over an index list. */
export function hist(k, pos, idx = null) {
  const L = new Float64Array(K), S = new Float64Array(K);
  if (idx) for (const i of idx) (pos[i] ? S : L)[k[i]]++;
  else for (let i = 0; i < k.length; i++) (pos[i] ? S : L)[k[i]]++;
  let P = 0, N = 0;
  for (let b = 0; b < K; b++) { P += S[b]; N += L[b]; }
  return { L, S, P, N };
}

export function apH({ L, S, P }) {
  let tp = 0, fp = 0, prevR = 0, ap = 0;
  for (let b = 0; b < K; b++) {
    if (S[b] + L[b] === 0) continue;
    tp += S[b]; fp += L[b];
    const r = tp / P;
    ap += (r - prevR) * (tp / (tp + fp));
    prevR = r;
  }
  return ap;
}

export function aucH({ L, S, P, N }) {
  let legitAbove = N, auc = 0;
  for (let b = 0; b < K; b++) {
    legitAbove -= L[b];
    auc += S[b] * (legitAbove + 0.5 * L[b]);
  }
  return auc / (P * N);
}

/** Decision "spoofed iff k < kt", kt = 0..101. */
export function atK({ L, S, P, N }, kt) {
  let tp = 0, fp = 0;
  for (let b = 0; b < Math.min(kt, K); b++) { tp += S[b]; fp += L[b]; }
  const fn = P - tp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = P ? tp / P : 0;
  return {
    tp, fp, precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    far: P ? fn / P : 0,
    fdr: N ? fp / N : 0,
  };
}

/** kt maximising F1 (smallest on ties). */
export function selectF1(h) {
  let best = { kt: 0, f1: -1 };
  for (let kt = 0; kt <= K; kt++) {
    const f1 = atK(h, kt).f1;
    if (f1 > best.f1 + 1e-12) best = { kt, f1 };
  }
  return best.kt;
}

/** Largest kt with FDR <= eps. */
export function selectFdr(h, eps) {
  let best = 0;
  for (let kt = 0; kt <= K; kt++) if (atK(h, kt).fdr <= eps + 1e-12) best = kt;
  return best;
}

/** Stratified (per scenario) bootstrap resample of all indices of m. */
export function resampleIdx(m, rng) {
  const strata = new Map();
  for (let i = 0; i < m.n; i++) {
    if (!strata.has(m.scenario[i])) strata.set(m.scenario[i], []);
    strata.get(m.scenario[i]).push(i);
  }
  const out = [];
  for (const s of strata.values()) for (let i = 0; i < s.length; i++) out.push(s[Math.floor(rng() * s.length)]);
  return out;
}

// ---------------------------------------------------------------------------
// Random weights
// ---------------------------------------------------------------------------

function gaussian(rng) {
  const u1 = rng() || 1e-12, u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(alpha, 1), Marsaglia-Tsang. */
function gamma(rng, alpha) {
  if (alpha < 1) return gamma(rng, alpha + 1) * Math.pow(rng() || 1e-12, 1 / alpha);
  if (alpha === 1) return -Math.log(rng() || 1e-12);
  const d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Dirichlet draw; alpha[j] = 0 keeps weight j at 0. */
export function dirichlet(rng, alpha) {
  const g = alpha.map((a) => (a > 0 ? gamma(rng, a) : 0));
  const s = g.reduce((a, b) => a + b, 0);
  return g.map((x) => x / s);
}

// ---------------------------------------------------------------------------
// Non-negative logistic regression
// ---------------------------------------------------------------------------

/**
 * logit P(legitimate) = a + sum_j b_j s_j with b >= 0 over the signals in
 * `features`, fitted by accelerated projected gradient (FISTA with adaptive
 * restart) on the mean log-loss. Unavailable signals are imputed with
 * EMPTY_SCORE for training only. Returns weights b / sum(b).
 */
export function fitNonNegLogistic(m, features, idx = null, { maxIter = 200_000, tol = 1e-7 } = {}) {
  const rows = new Map();
  const add = (i) => {
    const x = features.map((j) => { const v = m.X[i * 5 + j]; return Number.isNaN(v) ? EMPTY_SCORE : v; });
    const key = x.join(',');
    const r = rows.get(key) ?? { x, legit: 0, total: 0 };
    r.total++;
    if (!m.pos[i]) r.legit++;
    rows.set(key, r);
  };
  if (idx) for (const i of idx) add(i); else for (let i = 0; i < m.n; i++) add(i);
  const data = [...rows.values()];
  const n = data.reduce((s, r) => s + r.total, 0);
  const d = features.length + 1;

  const loss = (th) => {
    let l = 0;
    for (const r of data) {
      let z = th[0];
      for (let j = 1; j < d; j++) z += th[j] * r.x[j - 1];
      const lse = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
      l += r.total * lse - r.legit * z;
    }
    return l / n;
  };
  const grad = (th) => {
    const g = new Array(d).fill(0);
    for (const r of data) {
      let z = th[0];
      for (let j = 1; j < d; j++) z += th[j] * r.x[j - 1];
      const e = (r.total / (1 + Math.exp(-z)) - r.legit) / n;
      g[0] += e;
      for (let j = 1; j < d; j++) g[j] += e * r.x[j - 1];
    }
    return g;
  };
  const step = 1 / (0.25 * d); // features in [0, 1]: Lipschitz bound 0.25 * d
  let th = new Array(d).fill(0), y = th.slice(), t = 1, it = 0, pg = Infinity;
  for (; it < maxIter; it++) {
    const g = grad(y);
    const next = y.map((v, j) => v - step * g[j]);
    for (let j = 1; j < d; j++) next[j] = Math.max(0, next[j]);
    // Gradient-based adaptive restart.
    let dot = 0;
    for (let j = 0; j < d; j++) dot += g[j] * (next[j] - th[j]);
    const tNext = dot > 0 ? 1 : (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const mom = dot > 0 ? 0 : (t - 1) / tNext;
    y = next.map((v, j) => v + mom * (v - th[j]));
    th = next; t = tNext;
    if (it % 200 === 0) {
      const gt = grad(th);
      pg = Math.abs(gt[0]);
      for (let j = 1; j < d; j++) pg = Math.max(pg, th[j] > 0 ? Math.abs(gt[j]) : Math.max(0, -gt[j]));
      if (pg < tol) break;
    }
  }
  const b = th.slice(1);
  const sb = b.reduce((s, v) => s + v, 0);
  const weights = new Array(5).fill(0);
  features.forEach((j, q) => { weights[j] = sb > 0 ? b[q] / sb : 1 / features.length; });
  return { weights, intercept: th[0], beta: b, iterations: it, projGrad: pg, logLoss: loss(th), uniqueRows: data.length };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export const r4 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1e4) / 1e4);

export function quantiles(values, qs = [0.05, 0.5, 0.95]) {
  const xs = [...values].sort((a, b) => a - b);
  const q = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))];
  return { min: r4(xs[0]), ...Object.fromEntries(qs.map((p) => [`p${Math.round(p * 100)}`, r4(q(p))])), max: r4(xs.at(-1)) };
}

export function percentileCI(values, level = 0.95) {
  const xs = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return { lo: r4(xs[Math.floor(((1 - level) / 2) * (xs.length - 1))]), hi: r4(xs[Math.ceil((1 - (1 - level) / 2) * (xs.length - 1))]) };
}

export function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
