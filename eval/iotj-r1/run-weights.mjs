// Weight sensitivity and a separate validation protocol for the Table I
// weights (reviewer items R1-8, R2-4, R3-3).
//
//   a. Random weights: 1000 Dirichlet(1,...,1) draws (global) and 1000
//      Dirichlet(50 w_TableI) draws (local, around Table I) for the all-five
//      and the no-network profile. AP and AUC-ROC on test (threshold-free);
//      F1, FAR, FDR on test at the threshold chosen on val, both at max val F1
//      and at the largest theta with val FDR <= 0.1%. Reports the percentile
//      of the Table I weights among the draws.
//   b. Learned weights: non-negative logistic regression fitted on dev,
//      theta chosen on val, metrics on test against Table I, with stratified
//      bootstrap CIs and paired differences.
//   c. Leave-one-attack-out: for each spoofing scenario, theta (and the
//      learned weights) chosen without it; its detection rate and the FDR on
//      test.
// Submitted signals (S1..S5) and revised ones (S2', S4') are both analysed.
// dev = the manuscript's traces, on which Table I was developed; val/test are
// unseen. Scores follow fusion.mjs (renormalised weighted mean, rounded to
// 0.01), which with Table I is exactly the submitted V2.
//
// Usage: node eval/iotj-r1/run-weights.mjs [--draws 1000] [--B 1000]
// Writes results/weights.json; prints a summary to stderr.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, bootstrap, averagePrecision, aucRoc } from './metrics.mjs';
import {
  SIGNALS, TABLE_I, signalMatrices, scoreK, indices, hist, apH, aucH, atK, selectF1, selectFdr,
  dirichlet, fitNonNegLogistic, r4, quantiles, pearson,
} from './fusion.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DRAWS = Number(arg('draws', 1000));
const B = Number(arg('B', 1000));
const FDR_BUDGET = 0.001;
const LOCAL_CONCENTRATION = 50;
const VARIANTS = ['submitted', 'revised'];
const PROFILES = {
  all5: { alpha: [1, 1, 1, 1, 1], features: [0, 1, 2, 3, 4] },
  noNetwork: { alpha: [1, 1, 1, 1, 0], features: [0, 1, 2, 3] },
};
// Orientation of each reported metric (true = higher is better).
const METRICS = { ap: true, auc: true, f1: true, far: false, fdr: false, farAtFdr: false, fdrAtFdr: false };

process.stderr.write('computing signals for dev/val/test...\n');
const mats = { dev: signalMatrices('dev'), val: signalMatrices('val'), test: signalMatrices('test') };
const SPOOFED = [...new Set(mats.test.submitted.scenario.filter((_, i) => mats.test.submitted.pos[i]))];
const LEGIT = [...new Set(mats.test.submitted.scenario.filter((_, i) => !mats.test.submitted.pos[i]))];

// ---------------------------------------------------------------------------
// Checks: fusion.mjs with Table I reproduces the scorers.
// ---------------------------------------------------------------------------
const checks = {};
for (const split of ['dev', 'val', 'test']) {
  for (const v of VARIANTS) {
    const m = mats[split][v];
    const k = scoreK(m, TABLE_I.all5);
    let mismatches = 0;
    for (let i = 0; i < m.n; i++) if (k[i] !== m.refK[i]) mismatches++;
    checks[`${split}/${v}`] = { mismatchesVsScorer: mismatches };
  }
}
{
  // Histogram metrics agree with metrics.mjs; the exact revised scorer (Table I
  // fallback profiles where S4' is unavailable) vs renormalised Table I.
  const m = mats.test.revised;
  const items = (k) => Array.from(k, (x, i) => ({ pos: !!m.pos[i], score: x / 100, scenario: m.scenario[i] }));
  const kRen = scoreK(m, TABLE_I.all5);
  checks.revisedTableI = {
    apRenormalised: r4(apH(hist(kRen, m.pos))), apExactScorer: r4(averagePrecision(items(m.refK))),
    aucRenormalised: r4(aucH(hist(kRen, m.pos))), aucExactScorer: r4(aucRoc(items(m.refK))),
    histogramMatchesMetricsMjs: Math.abs(apH(hist(kRen, m.pos)) - averagePrecision(items(kRen))) < 1e-12
      && Math.abs(aucH(hist(kRen, m.pos)) - aucRoc(items(kRen))) < 1e-12,
  };
}

// ---------------------------------------------------------------------------
// Evaluation of one weight vector: theta on val, metrics on test.
// ---------------------------------------------------------------------------
function evaluate(v, w) {
  const kv = scoreK(mats.val[v], w), kt = scoreK(mats.test[v], w);
  const hv = hist(kv, mats.val[v].pos), ht = hist(kt, mats.test[v].pos);
  const ktF1 = selectF1(hv), ktFdr = selectFdr(hv, FDR_BUDGET);
  const a = atK(ht, ktF1), b = atK(ht, ktFdr);
  return {
    kTest: kt, ktF1, ktFdr,
    m: { ap: apH(ht), auc: aucH(ht), f1: a.f1, far: a.far, fdr: a.fdr, farAtFdr: b.far, fdrAtFdr: b.fdr },
    thetaF1: ktF1 / 100, valF1: atK(hv, ktF1).f1, thetaFdr: ktFdr / 100, f1AtFdr: b.f1,
  };
}
const roundM = (m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, r4(x)]));

/** Mid-rank percentile: share of draws that the reference beats (ties count half). */
function percentile(ref, values, higherBetter) {
  let beats = 0;
  for (const x of values) {
    if (Math.abs(x - ref) < 1e-12) beats += 0.5;
    else if (higherBetter ? ref > x : ref < x) beats++;
  }
  return r4((100 * beats) / values.length);
}

function randomStudy(v, alpha, seed, ref) {
  const rng = makeRng(seed);
  const rows = [];
  for (let d = 0; d < DRAWS; d++) {
    const w = dirichlet(rng, alpha);
    rows.push({ w, ...evaluate(v, w).m });
  }
  const out = { draws: DRAWS, summary: {}, tableIPercentile: {}, shareWithin: {} };
  for (const [key, hb] of Object.entries(METRICS)) {
    const xs = rows.map((r) => r[key]);
    out.summary[key] = quantiles(xs);
    out.tableIPercentile[key] = percentile(ref[key], xs, hb);
  }
  for (const [key, tol] of [['ap', 0.01], ['auc', 0.01], ['f1', 0.01], ['farAtFdr', 0.05]]) {
    out.shareWithin[`${key}±${tol}`] = r4(rows.filter((r) => Math.abs(r[key] - ref[key]) <= tol).length / rows.length);
  }
  const by = (key, hb) => rows.reduce((best, r) => ((hb ? r[key] > best[key] : r[key] < best[key]) ? r : best));
  out.best = {
    ap: { weights: by('ap', true).w.map(r4), value: r4(by('ap', true).ap) },
    farAtFdr: { weights: by('farAtFdr', false).w.map(r4), value: r4(by('farAtFdr', false).farAtFdr) },
  };
  out.weightCorrelation = Object.fromEntries(['ap', 'f1', 'farAtFdr'].map((key) => [key,
    Object.fromEntries(SIGNALS.map((s, j) => [s, alpha[j] > 0 ? r4(pearson(rows.map((r) => r.w[j]), rows.map((r) => r[key]))) : null]))]));
  return out;
}

// ---------------------------------------------------------------------------
// Bootstrap CIs on test (theta fixed from val), paired Table I vs learned.
// ---------------------------------------------------------------------------
function histItems(s, key) {
  const L = new Float64Array(101), S = new Float64Array(101);
  for (const it of s) (it.pos ? S : L)[it[key]]++;
  let P = 0, N = 0;
  for (let b = 0; b < 101; b++) { P += S[b]; N += L[b]; }
  return { L, S, P, N };
}

function pairedCIs(v, evA, evB, seed) {
  const m = mats.test[v];
  const items = Array.from({ length: m.n }, (_, i) => ({ pos: !!m.pos[i], scenario: m.scenario[i], a: evA.kTest[i], b: evB.kTest[i] }));
  const stats = (key, ev) => ({
    ap: (s) => apH(histItems(s, key)),
    auc: (s) => aucH(histItems(s, key)),
    f1: (s) => atK(histItems(s, key), ev.ktF1).f1,
    far: (s) => atK(histItems(s, key), ev.ktF1).far,
    fdr: (s) => atK(histItems(s, key), ev.ktF1).fdr,
    farAtFdr: (s) => atK(histItems(s, key), ev.ktFdr).far,
    fdrAtFdr: (s) => atK(histItems(s, key), ev.ktFdr).fdr,
  });
  const ci = (stat) => {
    const { point, lo, hi } = bootstrap(items, stat, { B, seed });
    return { point: r4(point), lo: r4(lo), hi: r4(hi) };
  };
  const sa = stats('a', evA), sb = stats('b', evB);
  const out = { tableI: {}, learned: {}, learnedMinusTableI: {} };
  for (const key of Object.keys(METRICS)) {
    out.tableI[key] = ci(sa[key]);
    out.learned[key] = ci(sb[key]);
    out.learnedMinusTableI[key] = ci((s) => sb[key](s) - sa[key](s));
  }
  return out;
}

function perScenarioRates(v, k, kt) {
  const m = mats.test[v];
  const out = {};
  for (let i = 0; i < m.n; i++) {
    const s = (out[m.scenario[i]] ??= { n: 0, flagged: 0 });
    s.n++;
    if (k[i] < kt) s.flagged++;
  }
  return Object.fromEntries(Object.entries(out).map(([s, x]) => [s, r4(x.flagged / x.n)]));
}

// ---------------------------------------------------------------------------
// Leave-one-attack-out.
// ---------------------------------------------------------------------------
function loao(v, features) {
  const rows = [];
  for (const h of SPOOFED) {
    const val = mats.val[v], test = mats.test[v], dev = mats.dev[v];
    const valIdx = indices(val, (i) => val.scenario[i] !== h);
    const heldIdx = indices(test, (i) => test.scenario[i] === h);
    const legitIdx = indices(test, (i) => !test.pos[i]);
    const one = (w) => {
      const hv = hist(scoreK(val, w), val.pos, valIdx);
      const kt = scoreK(test, w);
      const ktF1 = selectF1(hv), ktFdr = selectFdr(hv, FDR_BUDGET);
      const rate = (idx, thr) => idx.filter((i) => kt[i] < thr).length / idx.length;
      return {
        thetaF1: ktF1 / 100, tprHeldOutF1: r4(rate(heldIdx, ktF1)), fdrF1: r4(rate(legitIdx, ktF1)),
        thetaFdr: ktFdr / 100, tprHeldOutFdr: r4(rate(heldIdx, ktFdr)), fdrFdr: r4(rate(legitIdx, ktFdr)),
      };
    };
    const fit = fitNonNegLogistic(dev, features, indices(dev, (i) => dev.scenario[i] !== h));
    rows.push({ heldOut: h, tableI: one(TABLE_I.all5), learned: { weights: fit.weights.map(r4), ...one(fit.weights) } });
  }
  const mean = (sel) => r4(rows.reduce((s, r) => s + sel(r), 0) / rows.length);
  const min = (sel) => r4(Math.min(...rows.map(sel)));
  const summary = {};
  for (const who of ['tableI', 'learned']) {
    summary[who] = {
      meanTprF1: mean((r) => r[who].tprHeldOutF1), minTprF1: min((r) => r[who].tprHeldOutF1),
      meanTprFdr: mean((r) => r[who].tprHeldOutFdr), minTprFdr: min((r) => r[who].tprHeldOutFdr),
      maxFdrF1: r4(Math.max(...rows.map((r) => r[who].fdrF1))), maxFdrFdr: r4(Math.max(...rows.map((r) => r[who].fdrFdr))),
    };
  }
  return { folds: rows, summary };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = {
  generated: new Date().toISOString(),
  config: { draws: DRAWS, bootstrapB: B, fdrBudget: FDR_BUDGET, localConcentration: LOCAL_CONCENTRATION, thetaRule: 'max val F1 (smallest theta on ties); largest theta with val FDR <= budget' },
  checks,
  sets: {},
};

for (const v of VARIANTS) {
  results.sets[v] = {};
  for (const [pname, prof] of Object.entries(PROFILES)) {
    process.stderr.write(`[${v}/${pname}] random weights, learned weights...\n`);
    const tableW = TABLE_I[pname];
    const evT = evaluate(v, tableW);
    const fit = fitNonNegLogistic(mats.dev[v], prof.features);
    const evL = evaluate(v, fit.weights);
    const block = {
      tableI: {
        weights: tableW, ...roundM(evT.m), thetaF1: evT.thetaF1, valF1: r4(evT.valF1), thetaFdr: evT.thetaFdr, f1AtFdr: r4(evT.f1AtFdr),
        perScenarioAtThetaF1: perScenarioRates(v, evT.kTest, evT.ktF1),
        perScenarioAtThetaFdr: perScenarioRates(v, evT.kTest, evT.ktFdr),
      },
      random: randomStudy(v, prof.alpha, `weights-${v}-${pname}-global`, evT.m),
      local: randomStudy(v, tableW.map((x) => LOCAL_CONCENTRATION * x), `weights-${v}-${pname}-local`, evT.m),
      learned: {
        weights: fit.weights.map(r4), intercept: r4(fit.intercept), beta: fit.beta.map(r4),
        fit: { iterations: fit.iterations, projGrad: fit.projGrad, logLoss: r4(fit.logLoss), uniqueRows: fit.uniqueRows },
        ...roundM(evL.m), thetaF1: evL.thetaF1, valF1: r4(evL.valF1), thetaFdr: evL.thetaFdr, f1AtFdr: r4(evL.f1AtFdr),
        perScenarioAtThetaF1: perScenarioRates(v, evL.kTest, evL.ktF1),
        perScenarioAtThetaFdr: perScenarioRates(v, evL.kTest, evL.ktFdr),
      },
      bootstrap: pairedCIs(v, evT, evL, `weights-${v}-${pname}-boot`),
    };
    if (pname === 'all5') {
      process.stderr.write(`[${v}/${pname}] leave-one-attack-out...\n`);
      block.loao = loao(v, prof.features);
    }
    results.sets[v][pname] = block;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'weights.json'), JSON.stringify(results, null, 2));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const f = (x) => (x == null ? ' n/a ' : x.toFixed(3));
const c = (x) => `${f(x.point)} [${f(x.lo)}, ${f(x.hi)}]`;
const w = (ws) => ws.map((x) => x.toFixed(2)).join('/');
process.stderr.write(`\nchecks: ${JSON.stringify(checks)}\n`);
for (const v of VARIANTS) {
  for (const pname of Object.keys(PROFILES)) {
    const b = results.sets[v][pname];
    process.stderr.write(`\n=== ${v} / ${pname} (test; theta from val) ===\n`);
    process.stderr.write(`Table I ${w(b.tableI.weights)}: thetaF1=${b.tableI.thetaF1} thetaFdr=${b.tableI.thetaFdr}\n`);
    for (const key of Object.keys(METRICS)) {
      const r = b.random, l = b.local;
      process.stderr.write(`  ${key.padEnd(9)} TableI ${c(b.bootstrap.tableI[key])}  global P5/P50/P95 ${f(r.summary[key].p5)}/${f(r.summary[key].p50)}/${f(r.summary[key].p95)} pct ${r.tableIPercentile[key]}`
        + `  local P5/P95 ${f(l.summary[key].p5)}/${f(l.summary[key].p95)} pct ${l.tableIPercentile[key]}`
        + `  | learned ${c(b.bootstrap.learned[key])} diff ${c(b.bootstrap.learnedMinusTableI[key])}\n`);
    }
    process.stderr.write(`  learned weights ${w(b.learned.weights)} thetaF1=${b.learned.thetaF1} thetaFdr=${b.learned.thetaFdr} (iters ${b.learned.fit.iterations}, pg ${b.learned.fit.projGrad.toExponential(1)})\n`);
    process.stderr.write(`  best random AP ${b.random.best.ap.value} @ ${w(b.random.best.ap.weights)}; share within AP±0.01 ${b.random.shareWithin['ap±0.01']}\n`);
    process.stderr.write(`  corr(w, AP) ${JSON.stringify(b.random.weightCorrelation.ap)}\n`);
    if (b.loao) {
      process.stderr.write('  LOAO (held-out TPR @thetaF1 / @thetaFdr, test FDR @thetaF1):\n');
      for (const r of b.loao.folds) {
        process.stderr.write(`    ${r.heldOut.padEnd(17)} TableI ${f(r.tableI.tprHeldOutF1)} / ${f(r.tableI.tprHeldOutFdr)} fdr ${f(r.tableI.fdrF1)} (theta ${r.tableI.thetaF1})`
          + `   learned ${f(r.learned.tprHeldOutF1)} / ${f(r.learned.tprHeldOutFdr)} fdr ${f(r.learned.fdrF1)} (theta ${r.learned.thetaF1}) w ${w(r.learned.weights)}\n`);
      }
      process.stderr.write(`    summary ${JSON.stringify(b.loao.summary)}\n`);
    }
  }
}
