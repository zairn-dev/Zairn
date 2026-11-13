// Graduated gate under an imperfect step-up verifier (reviewer cluster C1).
//
// alpha = P(legitimate user fails step-up), beta = P(spoofer passes step-up).
// For a graduated gate (thetaP, thetaS) on V2 scores:
//   FAR_g = FAR_b(thetaP) + beta * m_S,   FDR_g = FDR_b(thetaS) + alpha * m_L,
// where m_S / m_L are the spoofed / legitimate shares in [thetaS, thetaP).
// Against a binary threshold thetaB the graduated gate is no worse on FAR iff
// beta <= beta* = (FAR_b(thetaB) - FAR_b(thetaP)) / m_S, and no worse on FDR iff
// alpha <= alpha* = (FDR_b(thetaB) - FDR_b(thetaS)) / m_L.
//
// Usage: node eval/iotj-r1/run-stepup.mjs [--splits dev,test] [--B 1000]
// Writes results/stepup.json; prints a summary to stderr.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSplit, scoreV2, toItems } from './data.mjs';
import { makeRng } from './metrics.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const splits = arg('splits', 'dev,test').split(',');
const B = Number(arg('B', 1000));

const ALPHAS = [0, 0.01, 0.02, 0.05, 0.1, 0.2];
const BETAS = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
const FDR_BUDGETS = [0.005, 0.01, 0.02, 0.05];
// Cap on the legitimate step-up share m_L; without one, "step up everyone"
// (thetaP > 1) is always admissible and FAR collapses to beta.
const FRICTION_CAPS = [0.05, 0.2, 1];

// Step-up mechanisms discussed in the revision. Values are assumptions to be
// replaced by measurements where marked.
const MECHANISMS = [
  { name: 'oracle (submitted manuscript)', alpha: 0, beta: 0 },
  { name: 'ZK proximity proof alone (proves the claimed fix, not presence)', alpha: 0, beta: 1 },
  { name: 'identity step-up (OTP/passkey) vs self-spoofing owner', alpha: 0.02, beta: 1 },
  { name: 'on-site QR presence token (to be measured)', alpha: 0.05, beta: 0.1 },
];

const r4 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1e4) / 1e4);

// Scores are multiples of 0.01, so the gate is fully described by histograms
// over k = 0..100 and thresholds theta = k / 100, k = 0..101.
const K = 101;
function histograms(items) {
  const legit = new Array(K).fill(0), spoof = new Array(K).fill(0);
  for (const it of items) {
    const k = Math.round(it.score * 100);
    (it.pos ? spoof : legit)[k]++;
  }
  return { legit, spoof };
}

/** below[k] = share of the class with score < k/100, k = 0..101. */
function cdfBelow(h) {
  const n = h.reduce((a, b) => a + b, 0);
  const out = [0];
  for (let k = 0; k < K; k++) out.push(out[k] + h[k] / n);
  return out;
}

function gate(cdf) {
  const { L, S } = cdf;
  const binary = (kb) => ({ far: 1 - S[kb], fdr: L[kb] });
  const graduated = (kp, ks, alpha, beta) => {
    const mS = S[kp] - S[ks], mL = L[kp] - L[ks];
    return { far: 1 - S[kp] + beta * mS, fdr: L[ks] + alpha * mL, mS, mL };
  };
  return { binary, graduated };
}

/** beta*, alpha* of graduated (kp, ks) against binary kb. */
function breakEven(cdf, kp, ks, kb) {
  const { binary, graduated } = gate(cdf);
  const g = graduated(kp, ks, 0, 0), b = binary(kb);
  return {
    betaStar: g.mS > 0 ? (b.far - g.far) / g.mS : null,
    alphaStar: g.mL > 0 ? (b.fdr - g.fdr) / g.mL : null,
    mS: g.mS, mL: g.mL,
  };
}

/** Best FAR subject to FDR <= eps (and m_L <= cap for the graduated gate). */
function bestAtBudget(cdf, eps, alpha, beta, cap) {
  const { binary, graduated } = gate(cdf);
  let bin = null;
  for (let kb = 0; kb <= K; kb++) {
    const b = binary(kb);
    if (b.fdr <= eps + 1e-12 && (!bin || b.far < bin.far)) bin = { ...b, thetaB: kb / 100 };
  }
  let grad = null;
  for (let kp = 0; kp <= K; kp++) {
    for (let ks = 0; ks <= kp; ks++) {
      const g = graduated(kp, ks, alpha, beta);
      if (g.fdr > eps + 1e-12 || g.mL > cap + 1e-12) continue;
      if (!grad || g.far < grad.far - 1e-12 || (Math.abs(g.far - grad.far) <= 1e-12 && g.mL < grad.mL)) {
        grad = { ...g, thetaP: kp / 100, thetaS: ks / 100 };
      }
    }
  }
  return { binary: bin, graduated: grad };
}

function resample(items, rng) {
  const strata = new Map();
  for (const it of items) {
    if (!strata.has(it.scenario)) strata.set(it.scenario, []);
    strata.get(it.scenario).push(it);
  }
  const out = [];
  for (const s of strata.values()) for (let i = 0; i < s.length; i++) out.push(s[Math.floor(rng() * s.length)]);
  return out;
}

function percentileCI(values) {
  const xs = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!xs.length) return { lo: null, hi: null };
  return { lo: xs[Math.floor(0.025 * (xs.length - 1))], hi: xs[Math.ceil(0.975 * (xs.length - 1))] };
}

// Default comparisons: the manuscript's graduated operating points against
// the binary thresholds that keep FDR at (or near) zero.
const COMPARISONS = [
  { kp: 90, ks: 30, kb: 80 },
  { kp: 90, ks: 30, kb: 70 },
  { kp: 80, ks: 30, kb: 70 },
  { kp: 70, ks: 30, kb: 70 },
];

function evaluateSplit(name) {
  const items = toItems(syntheticSplit(name), scoreV2);
  const h = histograms(items);
  const cdf = { L: cdfBelow(h.legit), S: cdfBelow(h.spoof) };
  const { binary, graduated } = gate(cdf);

  const rng = makeRng(`${name}-stepup`);
  const boot = Array.from({ length: B }, () => {
    const s = histograms(resample(items, rng));
    return { L: cdfBelow(s.legit), S: cdfBelow(s.spoof) };
  });

  const comparisons = COMPARISONS.map(({ kp, ks, kb }) => {
    const be = breakEven(cdf, kp, ks, kb);
    const bs = boot.map((c) => breakEven(c, kp, ks, kb));
    return {
      graduated: { thetaP: kp / 100, thetaS: ks / 100, ...Object.fromEntries(Object.entries(graduated(kp, ks, 0, 0)).map(([k, v]) => [k, r4(v)])) },
      binary: { thetaB: kb / 100, far: r4(binary(kb).far), fdr: r4(binary(kb).fdr) },
      betaStar: { point: r4(be.betaStar), ...Object.fromEntries(Object.entries(percentileCI(bs.map((x) => x.betaStar))).map(([k, v]) => [k, r4(v)])) },
      alphaStar: { point: r4(be.alphaStar), ...Object.fromEntries(Object.entries(percentileCI(bs.map((x) => x.alphaStar))).map(([k, v]) => [k, r4(v)])) },
    };
  });

  const mechanisms = MECHANISMS.map((m) => ({
    ...m,
    atManuscriptDefault: Object.fromEntries(Object.entries(graduated(70, 30, m.alpha, m.beta)).map(([k, v]) => [k, r4(v)])),
    atThetaP09: Object.fromEntries(Object.entries(graduated(90, 30, m.alpha, m.beta)).map(([k, v]) => [k, r4(v)])),
  }));

  // FAR advantage of the best graduated gate over the best binary gate at a
  // given FDR budget, over the (alpha, beta) grid. Positive = graduated better.
  const heatmaps = [];
  for (const eps of FDR_BUDGETS) {
    for (const cap of FRICTION_CAPS) {
      const cells = [];
      for (const alpha of ALPHAS) {
        for (const beta of BETAS) {
          const best = bestAtBudget(cdf, eps, alpha, beta, cap);
          cells.push({
            alpha, beta,
            binaryFar: r4(best.binary?.far), thetaB: best.binary?.thetaB,
            graduatedFar: r4(best.graduated?.far), thetaP: best.graduated?.thetaP, thetaS: best.graduated?.thetaS,
            mL: r4(best.graduated?.mL), mS: r4(best.graduated?.mS),
            advantage: best.binary && best.graduated ? r4(best.binary.far - best.graduated.far) : null,
          });
        }
      }
      heatmaps.push({ fdrBudget: eps, frictionCap: cap, cells });
    }
  }

  return { split: name, n: items.length, comparisons, mechanisms, heatmaps };
}

const results = { generated: new Date().toISOString(), bootstrapB: B, alphas: ALPHAS, betas: BETAS, splits: {} };
for (const name of splits) {
  process.stderr.write(`[${name}] scoring...\n`);
  results.splits[name] = evaluateSplit(name);
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'stepup.json'), JSON.stringify(results, null, 2));

const pct = (x) => (x == null ? '  n/a ' : `${(100 * x).toFixed(2).padStart(6)}%`);
for (const r of Object.values(results.splits)) {
  process.stderr.write(`\n=== ${r.split} (N=${r.n}) ===\n`);
  for (const c of r.comparisons) {
    const g = c.graduated, b = c.binary;
    process.stderr.write(`graduated (${g.thetaP}, ${g.thetaS}) vs binary ${b.thetaB}: `
      + `FAR ${pct(g.far)} vs ${pct(b.far)}, FDR ${pct(g.fdr)} vs ${pct(b.fdr)}, mS ${pct(g.mS)} mL ${pct(g.mL)} | `
      + `beta* ${c.betaStar.point} [${c.betaStar.lo}, ${c.betaStar.hi}]  alpha* ${c.alphaStar.point} [${c.alphaStar.lo}, ${c.alphaStar.hi}]\n`);
  }
  for (const m of r.mechanisms) {
    process.stderr.write(`${m.name} (a=${m.alpha}, b=${m.beta}): `
      + `@0.7/0.3 FAR ${pct(m.atManuscriptDefault.far)} FDR ${pct(m.atManuscriptDefault.fdr)} | `
      + `@0.9/0.3 FAR ${pct(m.atThetaP09.far)} FDR ${pct(m.atThetaP09.fdr)}\n`);
  }
  for (const hm of r.heatmaps.filter((x) => x.fdrBudget === 0.01)) {
    process.stderr.write(`\nFAR advantage (binary - graduated), FDR <= 1%, legit step-up <= ${hm.frictionCap * 100}%\n`);
    process.stderr.write('alpha\\beta ' + BETAS.map((b) => String(b).padStart(7)).join('') + '\n');
    for (const alpha of ALPHAS) {
      const row = hm.cells.filter((c) => c.alpha === alpha);
      process.stderr.write(String(alpha).padEnd(11) + row.map((c) => (c.advantage == null ? '    n/a' : (100 * c.advantage).toFixed(1).padStart(7))).join('') + '\n');
    }
  }
}
