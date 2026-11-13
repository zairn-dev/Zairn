// Detection and gate metrics for the IoT-J revision.
//
// Conventions used everywhere in this directory:
//   - items are { pos, score, scenario }, pos = true for a spoofed trace
//   - a trace is predicted spoofed when its trust score is below the threshold
//   - FAR = spoofed traces accepted / spoofed traces
//   - FDR = legitimate traces denied / legitimate traces
// Scores are rounded to 0.01 by the scorer, so ties are common; every metric
// here groups tied scores instead of splitting them.

/** Seeded PRNG (mulberry32 over a string hash). */
export function makeRng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function counts(items) {
  let P = 0;
  for (const it of items) if (it.pos) P++;
  return { P, N: items.length - P };
}

/** Score groups in ascending trust order (= descending suspicion). */
function groups(items) {
  const m = new Map();
  for (const it of items) {
    const g = m.get(it.score) ?? { s: it.score, p: 0, n: 0 };
    if (it.pos) g.p++; else g.n++;
    m.set(it.score, g);
  }
  return [...m.values()].sort((a, b) => a.s - b.s);
}

/** Mann-Whitney AUC-ROC: P(spoof score < legit score) + 0.5 P(tie). */
export function aucRoc(items) {
  const { P, N } = counts(items);
  let legitAbove = N, auc = 0;
  for (const g of groups(items)) {
    legitAbove -= g.n;
    auc += g.p * (legitAbove + 0.5 * g.n);
  }
  return auc / (P * N);
}

/** Step-wise average precision over every distinct threshold. */
export function averagePrecision(items) {
  const { P } = counts(items);
  let tp = 0, fp = 0, prevR = 0, ap = 0;
  for (const g of groups(items)) {
    tp += g.p; fp += g.n;
    const r = tp / P;
    ap += (r - prevR) * (tp / (tp + fp));
    prevR = r;
  }
  return ap;
}

/** Equal-error rate, linearly interpolated where FPR crosses FNR. */
export function eer(items) {
  const { P, N } = counts(items);
  let tp = 0, fp = 0, prev = { fpr: 0, fnr: 1 };
  for (const g of groups(items)) {
    tp += g.p; fp += g.n;
    const cur = { fpr: fp / N, fnr: 1 - tp / P };
    const da = prev.fpr - prev.fnr, db = cur.fpr - cur.fnr;
    if (da <= 0 && db >= 0) {
      const t = db === da ? 0 : -da / (db - da);
      return prev.fpr + t * (cur.fpr - prev.fpr);
    }
    prev = cur;
  }
  return null;
}

/** Binary decision at one threshold. */
export function atThreshold(items, theta) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const it of items) {
    const flagged = it.score < theta;
    if (it.pos) { if (flagged) tp++; else fn++; } else if (flagged) fp++; else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    tp, fp, tn, fn, precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    far: fn / (tp + fn),
    fdr: fp / (fp + tn),
  };
}

/**
 * Expected outcome of the three-action gate when the step-up verifier is
 * imperfect: a legitimate user fails step-up with probability alpha, a
 * spoofer passes it with probability beta. alpha = beta = 0 is the oracle
 * of the submitted manuscript.
 */
export function gradedGate(items, thetaP, thetaS, { alpha = 0, beta = 0 } = {}) {
  let legit = 0, spoof = 0;
  const band = { legitDeny: 0, legitStep: 0, spoofStep: 0, spoofProceed: 0 };
  for (const it of items) {
    if (it.pos) {
      spoof++;
      if (it.score >= thetaP) band.spoofProceed++;
      else if (it.score >= thetaS) band.spoofStep++;
    } else {
      legit++;
      if (it.score < thetaS) band.legitDeny++;
      else if (it.score < thetaP) band.legitStep++;
    }
  }
  const mL = band.legitStep / legit, mS = band.spoofStep / spoof;
  return {
    far: band.spoofProceed / spoof + beta * mS,
    fdr: band.legitDeny / legit + alpha * mL,
    stepUpRate: (band.legitStep + band.spoofStep) / items.length,
    mL, mS,
  };
}

/** Percentile bootstrap CI, resampling within each scenario. */
export function bootstrap(items, stat, { B = 1000, seed = 'bootstrap', level = 0.95 } = {}) {
  const rng = makeRng(seed);
  const strata = new Map();
  for (const it of items) {
    if (!strata.has(it.scenario)) strata.set(it.scenario, []);
    strata.get(it.scenario).push(it);
  }
  const values = [];
  const sample = new Array(items.length);
  for (let b = 0; b < B; b++) {
    let k = 0;
    for (const s of strata.values()) {
      for (let i = 0; i < s.length; i++) sample[k++] = s[Math.floor(rng() * s.length)];
    }
    values.push(stat(sample));
  }
  values.sort((x, y) => x - y);
  const lo = values[Math.floor(((1 - level) / 2) * (B - 1))];
  const hi = values[Math.ceil((1 - (1 - level) / 2) * (B - 1))];
  return { point: stat(items), lo, hi };
}
