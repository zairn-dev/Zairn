// Exact Shapley values of the five signals, the "S3+S5 beats all five"
// contrast and the dilution lemma (reviewer items R1-1, R2-5).
//
//   a. A coalition S is scored with the Table I all-five weights renormalised
//      over S, as in the submitted ablation (evaluate-signal-ablation.mjs).
//      Exact Shapley values on test for three value functions:
//        AP                    v({}) = prevalence (a constant score ranks nothing)
//        F1 at val-optimal theta of each coalition
//        F1 at the fixed theta = 0.7 of the manuscript
//      For both F1 games v({}) = F1 of flagging every trace, 2p/(1+p) = 0.75 at
//      prevalence p = 0.6: it is what the val rule picks for a constant score
//      and what the ablation script gives an empty coalition (score 0).
//      Setting v({}) = 0 instead adds v({})/5 to every Shapley value.
//      Stratified bootstrap CIs (theta fixed from val). Also reproduces the
//      manuscript's "Shapley-like" values (unweighted mean of F1 increments
//      over non-empty coalitions, theta = 0.7, 200 traces per scenario).
//   b. Dilution: with W = w3 + w5, T_all = W T_pair + (1 - W) T_rest exactly,
//      so an all-five trace is flagged at theta iff
//      T_pair < (theta - (1 - W) T_rest) / W; with blind remaining signals
//      (T_rest = 1) the effective threshold drops by (1-W)(1-theta)/W.
//      Per scenario: traces that flip between S3+S5 and all five at 0.7,
//      their T_rest, and the comparison at each coalition's val theta
//      ("best" coalitions are always picked by their F1 on val).
//   c. Attack x signal AUC: each spoofed scenario vs all legitimate traces.
//   d. Live SDK log-odds scorer (packages/sdk/dist; run `pnpm build` first)
//      and its coalition generalisation (V1 prior over the coalition's
//      S1..S3, S4/S5 as log-odds evidence): AP and F1, all five vs best pair.
//
// Usage: node eval/iotj-r1/run-shapley.mjs [--B 1000]
// Writes results/shapley.json; prints a summary to stderr.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTraces } from '../../packages/geo-drop/test/generate-synthetic-traces.mjs';
import { computeTrustScoreV2 as sdkTrustScoreV2 } from '../../packages/sdk/dist/trust-scorer.js';
import { SPLIT_OFFSETS } from './data.mjs';
import { makeRng, aucRoc } from './metrics.mjs';
import {
  SIGNALS, TABLE_I, signalMatrices, scoreK, maskWeights, maskName, hist, apH, aucH, atK, selectF1,
  resampleIdx, r4, percentileCI,
} from './fusion.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const B = Number(arg('B', 1000));
const THETA_K = 70; // manuscript's fixed theta = 0.7
const PAIR = 0b10100; // S3 + S5
const ALL = 0b11111;
const MASKS = Array.from({ length: 32 }, (_, m) => m);
const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);
const FACT = [1, 1, 2, 6, 24, 120];

/** Exact Shapley values of a 32-entry characteristic function. */
function shapley(v) {
  return SIGNALS.map((_, i) => {
    let phi = 0;
    for (const S of MASKS) {
      if ((S >> i) & 1) continue;
      const s = popcount(S);
      phi += ((FACT[s] * FACT[4 - s]) / FACT[5]) * (v[S | (1 << i)] - v[S]);
    }
    return phi;
  });
}

/** The manuscript's "Shapley-like" value: unweighted mean increment, empty set skipped. */
function shapleyLike(v) {
  return SIGNALS.map((_, i) => {
    let sum = 0, n = 0;
    for (const S of MASKS) {
      if (!((S >> i) & 1) || (S & ~(1 << i)) === 0) continue;
      sum += v[S] - v[S & ~(1 << i)];
      n++;
    }
    return sum / n;
  });
}

const named = (xs) => Object.fromEntries(SIGNALS.map((s, j) => [s, r4(xs[j])]));

process.stderr.write('computing signals for dev(200)/dev/val/test...\n');
const mats = {
  dev200: signalMatrices('dev', 200), dev: signalMatrices('dev'),
  val: signalMatrices('val'), test: signalMatrices('test'),
};

// ---------------------------------------------------------------------------
// a. Coalition values and exact Shapley values
// ---------------------------------------------------------------------------

/** Per-coalition scores and metrics for any coalition scorer kOf(mask, split). */
function coalitionTable(kOf, test, val) {
  const rows = MASKS.map((mask) => {
    if (mask === 0) return null;
    const kt = kOf(mask, 'test'), kv = kOf(mask, 'val');
    const ht = hist(kt, test.pos), hv = hist(kv, val.pos);
    const ktF1 = selectF1(hv);
    const a = atK(ht, ktF1), b = atK(ht, THETA_K);
    return { mask, kt, ktF1, f1OnVal: atK(hv, ktF1).f1, ap: apH(ht), auc: aucH(ht), f1Val: a.f1, f1At07: b.f1, recallAt07: b.recall, precisionAt07: b.precision, farVal: a.far, fdrVal: a.fdr };
  });
  return rows;
}

function games(rows, h0) {
  const flagAll = (2 * h0.P) / (2 * h0.P + h0.N);
  const v = (key, empty) => MASKS.map((m) => (m === 0 ? empty : rows[m][key]));
  return { ap: v('ap', h0.P / (h0.P + h0.N)), f1Val: v('f1Val', flagAll), f1At07: v('f1At07', flagAll) };
}

function shapleyWithCI(rows, test, seed) {
  const point = games(rows, hist(rows[ALL].kt, test.pos));
  // Paired contrasts behind the "S3+S5 beats all five" statement.
  const best = MASKS.slice(1).reduce((a, b) => (rows[b].f1OnVal > rows[a].f1OnVal ? b : a));
  const contrastDefs = {
    'f1At07: all - S3+S5': (r) => r[ALL].f1At07 - r[PAIR].f1At07,
    'f1Val: all - S3+S5': (r) => r[ALL].f1Val - r[PAIR].f1Val,
    'ap: all - S3+S5': (r) => r[ALL].ap - r[PAIR].ap,
    [`f1Val: all - best coalition (${maskName(best)})`]: (r) => r[ALL].f1Val - r[best].f1Val,
    [`ap: all - best coalition (${maskName(best)})`]: (r) => r[ALL].ap - r[best].ap,
  };
  const rng = makeRng(seed);
  const boot = { ap: [], f1Val: [], f1At07: [] };
  const bootC = Object.fromEntries(Object.keys(contrastDefs).map((k) => [k, []]));
  for (let b = 0; b < B; b++) {
    const idx = resampleIdx(test, rng);
    const bRows = MASKS.map((m) => {
      if (m === 0) return null;
      const h = hist(rows[m].kt, test.pos, idx);
      return { ap: apH(h), f1Val: atK(h, rows[m].ktF1).f1, f1At07: atK(h, THETA_K).f1, h };
    });
    const g = games(bRows, bRows[ALL].h);
    for (const key of Object.keys(boot)) boot[key].push(shapley(g[key]));
    for (const [k, fn] of Object.entries(contrastDefs)) bootC[k].push(fn(bRows));
  }
  const out = {};
  for (const key of Object.keys(point)) {
    const phi = shapley(point[key]);
    out[key] = {
      emptySetValue: r4(point[key][0]), fullSetValue: r4(point[key][ALL]),
      shapley: Object.fromEntries(SIGNALS.map((s, j) => [s, { point: r4(phi[j]), ...percentileCI(boot[key].map((x) => x[j])) }])),
    };
  }
  const contrasts = Object.fromEntries(Object.entries(contrastDefs).map(([k, fn]) => [k, { point: r4(fn(rows)), ...percentileCI(bootC[k]) }]));
  return { games: out, contrasts };
}

const shapleyResults = {};
const coalitionResults = {};
const rowsBy = {};
for (const v of ['submitted', 'revised']) {
  process.stderr.write(`[${v}] coalitions and Shapley bootstrap...\n`);
  const kCache = new Map();
  const kOf = (mask, split) => {
    const key = `${split}/${mask}`;
    if (!kCache.has(key)) kCache.set(key, scoreK(mats[split][v], maskWeights(mask)));
    return kCache.get(key);
  };
  const rows = coalitionTable(kOf, mats.test[v], mats.val[v]);
  rowsBy[v] = { rows, kOf };
  shapleyResults[v] = shapleyWithCI(rows, mats.test[v], `shapley-${v}`);

  // F1 at the fixed theta = 0.7 for all 31 coalitions, on the manuscript's
  // 200-per-scenario set, the full dev set and test.
  const at07 = {};
  for (const split of v === 'submitted' ? ['dev200', 'dev', 'test'] : ['test']) {
    for (const mask of MASKS.slice(1)) {
      const r = atK(hist(kOf(mask, split), mats[split][v].pos), THETA_K);
      (at07[maskName(mask)] ??= {})[split] = { f1: r4(r.f1), precision: r4(r.precision), recall: r4(r.recall) };
    }
  }
  coalitionResults[v] = {
    perCoalition: Object.fromEntries(rows.slice(1).map((r) => [maskName(r.mask), {
      apTest: r4(r.ap), aucTest: r4(r.auc), thetaVal: r.ktF1 / 100, f1TestAtThetaVal: r4(r.f1Val),
      farTestAtThetaVal: r4(r.farVal), fdrTestAtThetaVal: r4(r.fdrVal), ...at07[maskName(r.mask)],
    }])),
  };
}

// The manuscript's "Shapley-like" table and the exact Shapley values of the
// same game (F1 at 0.7) on its 200-per-scenario set.
const paperGame = (() => {
  const m = mats.dev200.submitted;
  const hs = MASKS.map((mask) => (mask ? hist(scoreK(m, maskWeights(mask)), m.pos) : null));
  const flagAll = (2 * hs[ALL].P) / (2 * hs[ALL].P + hs[ALL].N);
  const v = MASKS.map((mask) => (mask ? atK(hs[mask], THETA_K).f1 : flagAll));
  return {
    manuscriptTableIV: { S5: 0.103, S4: 0.082, S1: 0.019, S2: -0.019, S3: -0.040 },
    shapleyLikeReproduced: named(shapleyLike(v)),
    exactShapleyF1At07: named(shapley(v)),
    exactShapleyF1At07EmptyZero: named(shapley(v.map((x, i) => (i === 0 ? 0 : x)))),
    f1PairAt07: r4(v[PAIR]), f1AllAt07: r4(v[ALL]), f1FlagAll: r4(flagAll),
  };
})();

// ---------------------------------------------------------------------------
// b. Dilution
// ---------------------------------------------------------------------------
const W = TABLE_I.all5[2] + TABLE_I.all5[4]; // 0.35
function dilution(m, kPair, kAll, theta = THETA_K / 100) {
  const w = TABLE_I.all5;
  const per = {};
  for (let i = 0; i < m.n; i++) {
    const x = (j) => m.X[i * 5 + j];
    // Only available signals count (S4' is undefined on replay traces).
    const avail = (j) => !Number.isNaN(x(j));
    const wRest = [0, 1, 3].filter(avail).reduce((s, j) => s + w[j], 0);
    const wi = W / (W + wRest);
    const tPair = (w[2] * x(2) + w[4] * x(4)) / W;
    const tRest = wRest > 0 ? [0, 1, 3].filter(avail).reduce((s, j) => s + w[j] * x(j), 0) / wRest : 1;
    const thetaEff = (theta - (1 - wi) * tRest) / wi;
    const pairFlag = kPair[i] < THETA_K, allFlag = kAll[i] < THETA_K;
    const predicted = tPair < thetaEff;
    const s = (per[m.scenario[i]] ??= { label: m.pos[i] ? 'spoofed' : 'legitimate', n: 0, pairFlag: 0, allFlag: 0, lost: 0, gained: 0, lemmaAgree: 0, lostTPair: 0, lostTRest: 0, lostBlind: 0, lostThetaEff: 0, allAt09: 0 });
    s.n++;
    if (pairFlag) s.pairFlag++;
    if (allFlag) s.allFlag++;
    if (kAll[i] < 90) s.allAt09++;
    if (predicted === allFlag) s.lemmaAgree++;
    if (pairFlag && !allFlag) {
      s.lost++; s.lostTPair += tPair; s.lostTRest += tRest; s.lostThetaEff += thetaEff;
      if (tRest >= 0.999) s.lostBlind++;
    }
    if (!pairFlag && allFlag) s.gained++;
  }
  return Object.fromEntries(Object.entries(per).map(([k, s]) => [k, {
    label: s.label, n: s.n,
    pairFlagRateAt07: r4(s.pairFlag / s.n), allFlagRateAt07: r4(s.allFlag / s.n), allFlagRateAt09: r4(s.allAt09 / s.n),
    flaggedByPairOnly: s.lost, flaggedByAllOnly: s.gained,
    lostMeanTPair: s.lost ? r4(s.lostTPair / s.lost) : null, lostMeanTRest: s.lost ? r4(s.lostTRest / s.lost) : null,
    lostShareBlindRest: s.lost ? r4(s.lostBlind / s.lost) : null,
    lostMeanEffectiveTheta: s.lost ? r4(s.lostThetaEff / s.lost) : null,
    lemmaAgreement: r4(s.lemmaAgree / s.n),
  }]));
}

function perScenarioFlag(m, k, kt) {
  const out = {};
  for (let i = 0; i < m.n; i++) {
    const s = (out[m.scenario[i]] ??= [0, 0]);
    s[0]++;
    if (k[i] < kt) s[1]++;
  }
  return Object.fromEntries(Object.entries(out).map(([k2, [n, f]]) => [k2, r4(f / n)]));
}

const dilutionResults = {};
for (const v of ['submitted', 'revised']) {
  const { rows, kOf } = rowsBy[v];
  const pairs = MASKS.filter((m) => popcount(m) === 2);
  const bestPairVal = pairs.reduce((a, b) => (rows[b].f1OnVal > rows[a].f1OnVal ? b : a));
  const bestPairAp = pairs.reduce((a, b) => (rows[b].ap > rows[a].ap ? b : a));
  const bestAnyVal = MASKS.slice(1).reduce((a, b) => (rows[b].f1OnVal > rows[a].f1OnVal ? b : a));
  dilutionResults[v] = {
    lemma: {
      W, rest: 1 - W,
      effectiveThetaOnPairWhenRestBlind: r4((THETA_K / 100 - (1 - W)) / W),
      shift: r4(((1 - W) * (1 - THETA_K / 100)) / W),
      equivalentAllFiveTheta: r4(1 - W * (1 - THETA_K / 100)),
    },
    test: dilution(mats.test[v], kOf(PAIR, 'test'), kOf(ALL, 'test')),
    ...(v === 'submitted' ? { dev200: dilution(mats.dev200[v], scoreK(mats.dev200[v], maskWeights(PAIR)), scoreK(mats.dev200[v], TABLE_I.all5)) } : {}),
    perCoalitionTheta: {
      pair: { thetaVal: rows[PAIR].ktF1 / 100, f1: r4(rows[PAIR].f1Val), ap: r4(rows[PAIR].ap), perScenario: perScenarioFlag(mats.test[v], rows[PAIR].kt, rows[PAIR].ktF1) },
      all: { thetaVal: rows[ALL].ktF1 / 100, f1: r4(rows[ALL].f1Val), ap: r4(rows[ALL].ap), perScenario: perScenarioFlag(mats.test[v], rows[ALL].kt, rows[ALL].ktF1) },
      bestPairByValF1: { coalition: maskName(bestPairVal), thetaVal: rows[bestPairVal].ktF1 / 100, f1: r4(rows[bestPairVal].f1Val), ap: r4(rows[bestPairVal].ap) },
      bestPairByAp: { coalition: maskName(bestPairAp), ap: r4(rows[bestPairAp].ap) },
      bestCoalitionByValF1: { coalition: maskName(bestAnyVal), thetaVal: rows[bestAnyVal].ktF1 / 100, f1: r4(rows[bestAnyVal].f1Val), ap: r4(rows[bestAnyVal].ap) },
      allAt07: { f1: r4(rows[ALL].f1At07) }, pairAt07: { f1: r4(rows[PAIR].f1At07) },
    },
  };
}

// ---------------------------------------------------------------------------
// c. Attack x signal discrimination (AUC vs all legitimate traces, test)
// ---------------------------------------------------------------------------
function aucMatrix() {
  const sub = mats.test.submitted, rev = mats.test.revised;
  const cols = {
    S1: (i) => sub.X[i * 5], S2: (i) => sub.X[i * 5 + 1], S3: (i) => sub.X[i * 5 + 2], S4: (i) => sub.X[i * 5 + 3], S5: (i) => sub.X[i * 5 + 4],
    "S2'": (i) => rev.X[i * 5 + 1], "S4'": (i) => rev.X[i * 5 + 3],
  };
  const kAll = scoreK(sub, TABLE_I.all5), kPair = scoreK(sub, maskWeights(PAIR));
  cols['all five (Table I)'] = (i) => kAll[i] / 100;
  cols['S3+S5'] = (i) => kPair[i] / 100;
  const legit = [], byScenario = new Map();
  for (let i = 0; i < sub.n; i++) {
    if (!sub.pos[i]) legit.push(i);
    else (byScenario.get(sub.scenario[i]) ?? byScenario.set(sub.scenario[i], []).get(sub.scenario[i])).push(i);
  }
  const matrix = {};
  for (const [scn, idx] of byScenario) {
    matrix[scn] = {};
    for (const [name, f] of Object.entries(cols)) {
      const items = [...idx, ...legit].map((i) => ({ pos: !!sub.pos[i], score: f(i) }));
      matrix[scn][name] = items.some((it) => Number.isNaN(it.score)) ? null : r4(aucRoc(items));
    }
  }
  // Legitimate-side tail: share of each legitimate scenario with a signal below 1.
  const legitTail = {};
  for (const i of legit) {
    const s = (legitTail[sub.scenario[i]] ??= { n: 0, ...Object.fromEntries(Object.keys(cols).slice(0, 7).map((c) => [c, 0])) });
    s.n++;
    for (const c of Object.keys(cols).slice(0, 7)) if (cols[c](i) < 1) s[c]++;
  }
  for (const s of Object.values(legitTail)) for (const c of Object.keys(s)) if (c !== 'n') s[c] = r4(s[c] / s.n);
  return { matrix, legitShareBelowOne: legitTail };
}

// ---------------------------------------------------------------------------
// d. SDK log-odds scorer and its coalition generalisation
// ---------------------------------------------------------------------------
const EPS = 0.01, MAX_CORROBORATING = 0.54;
const V1_W = [0.5, 0.2, 0.3];
const EVIDENCE_W = { 3: 1.5, 4: 2 }; // temporal-raim, network-cross-check
const logit = (p) => { const q = Math.min(1 - EPS, Math.max(EPS, p)); return Math.log(q / (1 - q)); };
const calibrate = (s) => (s <= 0.5 ? EPS + (s / 0.5) * (0.5 - EPS) : 0.5 + ((s - 0.5) / 0.5) * (MAX_CORROBORATING - 0.5));
const round2 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;

/** SDK fusion restricted to a coalition; the full coalition is the SDK scorer. */
function logOddsScore(x, mask) {
  let tot = 0;
  for (let j = 0; j < 3; j++) if ((mask >> j) & 1) tot += V1_W[j];
  let base = null;
  if (tot > 0) {
    let s = 0;
    for (let j = 0; j < 3; j++) if ((mask >> j) & 1) s += (V1_W[j] / tot) * x[j];
    base = round2(s);
  }
  const ev = [3, 4].filter((j) => (mask >> j) & 1);
  if (!ev.length) return base;
  let lo = logit(base == null ? 0.5 : 0.1 + 0.8 * base);
  for (const j of ev) lo += EVIDENCE_W[j] * logit(calibrate(x[j]));
  const post = 1 / (1 + Math.exp(-lo));
  return round2(base == null ? post : Math.min(base, post));
}

function sdkStudy() {
  const load = (split) => {
    const traces = generateTraces(1000, SPLIT_OFFSETS[split]);
    const X = [], ref = [], pos = new Uint8Array(traces.length), scenario = [];
    traces.forEach((t, i) => {
      const r = sdkTrustScoreV2(t.current, t.history, { recentFixes: t.recentFixes, networkHint: t.networkHint });
      const s = r.signals;
      X.push([s.movementPlausibility, s.accuracyAnomaly, s.temporalConsistency, s.fixConsistency, s.networkConsistency]);
      ref.push(Math.round(r.trustScore * 100));
      pos[i] = t.label === 'spoofed' ? 1 : 0;
      scenario.push(t.scenario);
    });
    return { n: traces.length, X, ref, pos, scenario };
  };
  const d = { val: load('val'), test: load('test') };
  const kCache = new Map();
  const kOf = (mask, split) => {
    const key = `${split}/${mask}`;
    if (!kCache.has(key)) kCache.set(key, Uint8Array.from(d[split].X, (x) => Math.round(logOddsScore(x, mask) * 100)));
    return kCache.get(key);
  };
  let mismatches = 0;
  for (const split of ['val', 'test']) {
    const k = kOf(ALL, split);
    for (let i = 0; i < d[split].n; i++) if (k[i] !== d[split].ref[i]) mismatches++;
  }
  const rows = coalitionTable(kOf, d.test, d.val);
  const g = games(rows, hist(rows[ALL].kt, d.test.pos));
  const pairs = MASKS.filter((m) => popcount(m) === 2);
  const bestPair = pairs.reduce((a, b) => (rows[b].f1OnVal > rows[a].f1OnVal ? b : a));
  const bestPairAp = pairs.reduce((a, b) => (rows[b].ap > rows[a].ap ? b : a));
  const sum = (m) => ({ coalition: maskName(m), ap: r4(rows[m].ap), auc: r4(rows[m].auc), thetaVal: rows[m].ktF1 / 100, f1AtThetaVal: r4(rows[m].f1Val), f1At07: r4(rows[m].f1At07), recallAt07: r4(rows[m].recallAt07) });
  return {
    reproducesSdkScorer: { mismatches },
    allFive: sum(ALL), pairS3S5: sum(PAIR), bestPairByValF1: sum(bestPair), bestPairByAp: sum(bestPairAp),
    perScenarioAt07: { all: perScenarioFlag(d.test, rows[ALL].kt, THETA_K), pair: perScenarioFlag(d.test, rows[PAIR].kt, THETA_K) },
    shapley: { ap: named(shapley(g.ap)), f1Val: named(shapley(g.f1Val)), f1At07: named(shapley(g.f1At07)) },
    perCoalition: Object.fromEntries(rows.slice(1).map((r) => [maskName(r.mask), { ap: r4(r.ap), f1AtThetaVal: r4(r.f1Val), f1At07: r4(r.f1At07) }])),
  };
}

process.stderr.write('attack x signal AUC, SDK log-odds...\n');
const results = {
  generated: new Date().toISOString(),
  config: { bootstrapB: B, thetaFixed: THETA_K / 100, weights: TABLE_I.all5, emptyCoalition: 'AP: prevalence; F1: flag every trace' },
  shapley: shapleyResults,
  manuscriptGame: paperGame,
  coalitions: coalitionResults,
  dilution: dilutionResults,
  attackSignalAuc: aucMatrix(),
  logOdds: sdkStudy(),
};

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'shapley.json'), JSON.stringify(results, null, 2));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const f = (x) => (x == null ? ' n/a ' : (x >= 0 ? '+' : '') + x.toFixed(3));
const out = (s) => process.stderr.write(s + '\n');
for (const v of ['submitted', 'revised']) {
  out(`\n=== exact Shapley, ${v} signals (test; 95% CI) ===`);
  for (const [game, r] of Object.entries(results.shapley[v].games)) {
    out(`${game.padEnd(7)} v({})=${r.emptySetValue} v(all)=${r.fullSetValue}: ` + SIGNALS.map((s) => `${s} ${f(r.shapley[s].point)} [${f(r.shapley[s].lo)}, ${f(r.shapley[s].hi)}]`).join('  '));
  }
  for (const [k, x] of Object.entries(results.shapley[v].contrasts)) out(`  ${k}: ${f(x.point)} [${f(x.lo)}, ${f(x.hi)}]`);
}
const pg = results.manuscriptGame;
out(`\nmanuscript game (dev, 200/scenario, F1@0.7): pair ${pg.f1PairAt07} all ${pg.f1AllAt07} flag-all ${pg.f1FlagAll}`);
out(`  Shapley-like (reproduced) ${JSON.stringify(pg.shapleyLikeReproduced)}`);
out(`  exact Shapley             ${JSON.stringify(pg.exactShapleyF1At07)}`);
const c = results.coalitions.submitted.perCoalition;
out(`\nF1@0.7 S3+S5 dev200/dev/test ${c['S3+S5'].dev200.f1}/${c['S3+S5'].dev.f1}/${c['S3+S5'].test.f1}; all five ${c['S1+S2+S3+S4+S5'].dev200.f1}/${c['S1+S2+S3+S4+S5'].dev.f1}/${c['S1+S2+S3+S4+S5'].test.f1}`);
for (const v of ['submitted', 'revised']) {
  const d = results.dilution[v];
  out(`\n=== dilution, ${v} (test) === lemma ${JSON.stringify(d.lemma)}`);
  for (const [scn, s] of Object.entries(d.test)) {
    out(`  ${scn.padEnd(17)} pair@0.7 ${s.pairFlagRateAt07.toFixed(3)} all@0.7 ${s.allFlagRateAt07.toFixed(3)} all@0.9 ${s.allFlagRateAt09.toFixed(3)} pairOnly ${s.flaggedByPairOnly} allOnly ${s.flaggedByAllOnly}`
      + (s.flaggedByPairOnly ? ` | lost: T_pair ${s.lostMeanTPair} T_rest ${s.lostMeanTRest} blind ${s.lostShareBlindRest} theta_eff ${s.lostMeanEffectiveTheta}` : '') + ` lemma agree ${s.lemmaAgreement}`);
  }
  out(`  per-coalition theta: ${JSON.stringify(d.perCoalitionTheta, (k, x) => (k === 'perScenario' ? undefined : x))}`);
}
out('\n=== attack x signal AUC (test) ===');
for (const [scn, row] of Object.entries(results.attackSignalAuc.matrix)) {
  out(`  ${scn.padEnd(17)} ` + Object.entries(row).map(([k, x]) => `${k} ${x == null ? 'n/a' : x.toFixed(2)}`).join('  '));
}
out(`  legit share < 1: ${JSON.stringify(results.attackSignalAuc.legitShareBelowOne)}`);
const lo = results.logOdds;
out(`\n=== SDK log-odds (test) === reproduces SDK: ${JSON.stringify(lo.reproducesSdkScorer)}`);
for (const k of ['allFive', 'pairS3S5', 'bestPairByValF1', 'bestPairByAp']) out(`  ${k.padEnd(16)} ${JSON.stringify(lo[k])}`);
out(`  per scenario @0.7 all ${JSON.stringify(lo.perScenarioAt07.all)}\n                   pair ${JSON.stringify(lo.perScenarioAt07.pair)}`);
out(`  Shapley ${JSON.stringify(lo.shapley)}`);
