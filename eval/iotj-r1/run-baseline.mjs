// Re-runs Tables II, III and V of the submitted manuscript with tie-aware
// metrics and 95% bootstrap CIs, on the dev split (the manuscript's traces)
// and on the unseen val/test splits.
//
// Usage: node eval/iotj-r1/run-baseline.mjs [--splits dev,val,test] [--B 1000]
// Writes results/baseline.json; prints a summary to stderr.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSplit, scoreV1, scoreV2, scoreV2r, toItems } from './data.mjs';
import { aucRoc, averagePrecision, eer, atThreshold, gradedGate, bootstrap } from './metrics.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const splits = arg('splits', 'dev,val,test').split(',');
const B = Number(arg('B', 1000));
const THETA_P = [0.7, 0.8, 0.9, 0.95];
const THETA_S = 0.3;

const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const ci = (items, stat, seed) => {
  const { point, lo, hi } = bootstrap(items, stat, { B, seed });
  return { point: r4(point), lo: r4(lo), hi: r4(hi) };
};

function quantile(sorted, q) {
  return sorted[Math.floor(q * (sorted.length - 1))];
}

function evaluateSplit(name) {
  const traces = syntheticSplit(name);
  const v1 = toItems(traces, scoreV1);
  const v2 = toItems(traces, scoreV2);
  const v2r = toItems(traces, scoreV2r);

  const perScenario = {};
  for (const [label, items] of [['v1', v1], ['v2', v2], ['v2r', v2r]]) {
    for (const it of items) {
      const s = (perScenario[it.scenario] ??= { label: it.pos ? 'spoofed' : 'legitimate' });
      (s[label] ??= []).push(it.score);
    }
  }
  for (const s of Object.values(perScenario)) {
    for (const k of ['v1', 'v2', 'v2r']) s[k] = r4(s[k].reduce((a, b) => a + b, 0) / s[k].length);
  }

  const detection = {};
  for (const [label, items] of [['v1', v1], ['v2', v2], ['v2r', v2r]]) {
    detection[label] = {
      aucRoc: ci(items, aucRoc, `${name}-${label}-auc`),
      ap: ci(items, averagePrecision, `${name}-${label}-ap`),
      eer: ci(items, eer, `${name}-${label}-eer`),
    };
  }

  const distributionOf = (items) => {
    const d = {};
    for (const pos of [false, true]) {
      const xs = items.filter((it) => it.pos === pos).map((it) => it.score).sort((a, b) => a - b);
      d[pos ? 'spoofed' : 'legitimate'] = {
        n: xs.length,
        mean: r4(xs.reduce((a, b) => a + b, 0) / xs.length),
        min: xs[0], p25: quantile(xs, 0.25), max: xs.at(-1),
      };
    }
    return d;
  };
  const distribution = distributionOf(v2);
  const distributionV2r = distributionOf(v2r);

  const sweepOf = (v2) => THETA_P.map((theta) => {
    const bin = atThreshold(v2, theta);
    const grad = gradedGate(v2, theta, THETA_S);
    return {
      thetaP: theta,
      binary: {
        far: ci(v2, (s) => atThreshold(s, theta).far, `${name}-far-${theta}`),
        fdr: ci(v2, (s) => atThreshold(s, theta).fdr, `${name}-fdr-${theta}`),
        f1: r4(bin.f1),
        legitDenied: bin.fp,
      },
      graduatedOracle: { far: r4(grad.far), fdr: r4(grad.fdr), stepUpRate: r4(grad.stepUpRate), mS: r4(grad.mS), mL: r4(grad.mL) },
    };
  });

  const sweep = sweepOf(v2);
  const sweepV2r = sweepOf(v2r);

  return { split: name, n: traces.length, perScenario, detection, distribution, distributionV2r, sweep, sweepV2r };
}

const results = { generated: new Date().toISOString(), bootstrapB: B, thetaS: THETA_S, splits: {} };
for (const name of splits) {
  process.stderr.write(`[${name}] scoring and bootstrapping...\n`);
  results.splits[name] = evaluateSplit(name);
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'baseline.json'), JSON.stringify(results, null, 2));

const fmt = (c) => `${c.point.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]`;
const pct = (c) => `${(100 * c.point).toFixed(2)}% [${(100 * c.lo).toFixed(2)}, ${(100 * c.hi).toFixed(2)}]`;
for (const r of Object.values(results.splits)) {
  process.stderr.write(`\n=== ${r.split} (N=${r.n}) ===\n`);
  for (const v of ['v1', 'v2', 'v2r']) {
    const d = r.detection[v];
    process.stderr.write(`${v.toUpperCase()}: AUC-ROC ${fmt(d.aucRoc)}  AP ${fmt(d.ap)}  EER ${fmt(d.eer)}\n`);
  }
  process.stderr.write('V2 mean by scenario: ' + Object.entries(r.perScenario).map(([k, s]) => `${k}=${s.v2.toFixed(2)}`).join(' ') + '\n');
  for (const [cls, d] of Object.entries(r.distribution)) {
    process.stderr.write(`V2 ${cls}: mean ${d.mean} min ${d.min} p25 ${d.p25} max ${d.max}\n`);
  }
  process.stderr.write('V2r mean by scenario: ' + Object.entries(r.perScenario).map(([k, s]) => `${k}=${s.v2r.toFixed(2)}`).join(' ') + '\n');
  for (const [cls, d] of Object.entries(r.distributionV2r)) {
    process.stderr.write(`V2r ${cls}: mean ${d.mean} min ${d.min} p25 ${d.p25} max ${d.max}\n`);
  }
  for (const [tag, sw] of [['V2', r.sweep], ['V2r', r.sweepV2r]]) for (const s of sw) {
    process.stderr.write(`${tag} thetaP=${s.thetaP}: binary FAR ${pct(s.binary.far)} FDR ${pct(s.binary.fdr)} (legit denied ${s.binary.legitDenied}) F1 ${s.binary.f1}`
      + ` | graduated-oracle FAR ${(100 * s.graduatedOracle.far).toFixed(2)}% FDR ${(100 * s.graduatedOracle.fdr).toFixed(2)}% step-up ${(100 * s.graduatedOracle.stepUpRate).toFixed(1)}% mS ${s.graduatedOracle.mS}\n`);
  }
}
