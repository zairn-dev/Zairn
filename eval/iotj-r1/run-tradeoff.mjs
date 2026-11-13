// Graduated vs binary gate with real legitimate traffic (reviewer cluster C1:
// R1-2, R1-10, R2-2, R3-1).
//
// Unit: one location-dependent request, scored at one fix. Spoofed requests
// come from the synthetic test split (the only source with labelled attacks
// of every kind); legitimate requests come from each honest source in turn,
// so the legitimate tail is measured, not synthetic. Everything is scored with
// V2r in the profile a browser can supply (S1-S4, no network position).
//
// With F_S / F_L the spoofed / legitimate score CDFs, F(x) = P(T < x):
//   binary theta:          FAR = 1 - F_S(theta)       FDR = F_L(theta)
//   graduated (tp, ts):    FAR = 1 - F_S(tp) + beta [F_S(tp) - F_S(ts)]
//                          FDR = F_L(ts) + alpha [F_L(tp) - F_L(ts)]
// ts = 0 is the recommended latch policy: no denial on the score alone, DENY
// only after a failed step-up. Against a binary theta < tp the graduated gate
// is no worse on FAR iff beta <= beta* = [F_S(tp) - F_S(theta)] / F_S(tp), and
// no worse on FDR iff alpha <= alpha* = F_L(theta) / F_L(tp).
//
// Operating points. A fixed theta_p favours whichever source happens to have
// its honest tail below it, so each gate is also tuned on the honest source:
//   binary:     largest theta with F_L(theta) <= delta (honest-deny budget);
//   graduated:  largest theta_p with F_L(theta_p) <= L (honest step-up
//               budget), theta_s = 0; then FDR <= alpha_UB * L.
// For both, the attacks that the chosen threshold routes away from PROCEED
// are listed per synthetic scenario.
//
// Usage: node eval/iotj-r1/run-tradeoff.mjs [shlRoot] [denseTrace]
// Needs results/field.json and results/stepup-trials.json (run-field.mjs,
// run-stepup-trials.mjs). Writes results/tradeoff.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScoreRevised } from './revised-scorer.mjs';
import { syntheticSplit } from './data.mjs';
import { loadShl, SHL_DEFAULT_ROOT } from './shl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shlRoot = process.argv[2] ?? SHL_DEFAULT_ROOT;
const densePath = resolve(process.argv[3] ?? join(here, '../../../openZenly/eval/dense-trace/raw-2026-04-26.json'));
const field = JSON.parse(readFileSync(join(here, 'results', 'field.json'), 'utf8'));
const trials = JSON.parse(readFileSync(join(here, 'results', 'stepup-trials.json'), 'utf8'));

const THETA_P = [0.7, 0.9];
const DELTAS = [0.001, 0.01]; // honest-deny budgets for the binary comparator
const BETAS = [0, 0.1, 0.25];
const LOADS = [0.01, 0.05]; // honest step-up budgets for the graduated gate
const ALPHA_UB = trials.pooled.alpha.ci95Exact[1]; // exact 95% upper bound, 0/120 failures

const score = (cur, hist, recent) => computeTrustScoreRevised(cur, hist, { recentFixes: recent }).trustScore;
const histOf = (scores) => { const h = new Array(101).fill(0); for (const s of scores) h[Math.round(s * 100)]++; return h; };
/** F(x) = P(T < x) from a 101-bin histogram of 2-decimal scores. */
const cdf = (h) => {
  const n = h.reduce((a, b) => a + b, 0);
  return (x) => h.slice(0, Math.round(x * 100)).reduce((a, b) => a + b, 0) / n;
};
function scoreSeries(fixes) {
  const out = [];
  for (let i = 1; i < fixes.length; i++) out.push(score(fixes[i], fixes.slice(Math.max(0, i - 10), i).reverse(), fixes.slice(Math.max(0, i - 4), i + 1)));
  return out;
}

// Spoofed and synthetic-legitimate requests (test split, no network position).
const test = syntheticSplit('test');
const synth = { spoofed: [], legit: [], byScenario: {} };
for (const t of test) {
  const s = score(t.current, t.history, t.recentFixes);
  synth[t.label === 'spoofed' ? 'spoofed' : 'legit'].push(s);
  if (t.label === 'spoofed') (synth.byScenario[t.scenario] ??= []).push(s);
}
const FS = cdf(histOf(synth.spoofed));
// Adaptive A1: the recent fixes repeat the reported point (one per second),
// so the detrended scatter is zero and S4' = 1, as for a static mock app.
const fixedPoint = (t) => [0, 1, 2, 3].map((d) => ({ ...t.current, timestamp: new Date(Date.parse(t.current.timestamp) - d * 1000).toISOString() }));
const adaptive = test.filter((t) => t.label === 'spoofed').map((t) => score(t.current, t.history, fixedPoint(t)));
const FSa = cdf(histOf(adaptive));

// Honest sources.
const sources = { 'synthetic legitimate (test)': histOf(synth.legit) };
const shlScores = [];
for await (const { fixes } of loadShl(shlRoot)) shlScores.push(...scoreSeries(fixes));
sources['SHL (1 Hz, Mate 9)'] = histOf(shlScores);
const raw = JSON.parse(readFileSync(densePath, 'utf8'));
const dense = raw.trace.map((p) => ({ lat: p.lat, lon: p.lon, accuracy: p.accuracy, timestamp: new Date(p.ts).toISOString() }));
sources['dense trace (60 s, POCO)'] = histOf(scoreSeries(dense));
for (const [stream, h] of Object.entries(field.histograms)) sources[`field: ${stream}`] = h.V2r;

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const GRID = [0.3, 0.5, 0.7, 0.8, 0.9, 1];
const routed = (theta) => Object.fromEntries(Object.entries(synth.byScenario).map(([k, v]) => [k, r4(v.filter((s) => s < theta).length / v.length)]));
/** Largest threshold on the 0.01 grid with F(theta) <= budget. */
const largestWithin = (F, budget) => { let t = 0; for (let k = 0; k <= 100; k++) if (F(k / 100) <= budget) t = k / 100; return t; };
const out = {
  generated: new Date().toISOString(),
  scorer: 'V2r, no-network profile', alphaUpperBound: ALPHA_UB,
  spoofed: { n: synth.spoofed.length, F: Object.fromEntries(GRID.map((x) => [x, r4(FS(x))])),
    detectedByScenario: Object.fromEntries(Object.entries(synth.byScenario).map(([k, v]) => [k, Object.fromEntries(THETA_P.map((tp) => [tp, r4(v.filter((s) => s < tp).length / v.length)]))])) },
  adaptive: { n: adaptive.length, F: Object.fromEntries(GRID.map((x) => [x, r4(FSa(x))])) },
  sources: {},
};
for (const [name, h] of Object.entries(sources)) {
  const FL = cdf(h);
  const n = h.reduce((a, b) => a + b, 0);
  const src = { n, F: Object.fromEntries(GRID.map((x) => [x, r4(FL(x))])), binary: {}, graduated: {} };
  for (const delta of DELTAS) {
    // Strictest binary threshold that keeps honest denials within delta.
    const thetaB = largestWithin(FL, delta);
    src.binary[delta] = { theta: thetaB, FAR: r4(1 - FS(thetaB)), FDR: r4(FL(thetaB)), routed: routed(thetaB) };
  }
  src.tuned = {};
  for (const L of LOADS) {
    const tp = largestWithin(FL, L);
    src.tuned[L] = {
      thetaP: tp, stepUpLegit: r4(FL(tp)), stepUpSpoofed: r4(FS(tp)), FDRatAlphaUB: r4(ALPHA_UB * FL(tp)),
      FAR: Object.fromEntries(BETAS.map((b) => [b, r4(1 - FS(tp) + b * FS(tp))])),
      FARadaptive: r4(1 - FSa(tp)), // beta = 0
      routed: routed(tp),
      betaStar: Object.fromEntries(DELTAS.map((delta) => {
        const tb = src.binary[delta].theta;
        return [delta, tb >= tp ? null : r4((FS(tp) - FS(tb)) / FS(tp))];
      })),
    };
  }
  // Largest load whose FDR bound alpha_UB * L still meets delta.
  src.tunedToDelta = Object.fromEntries(DELTAS.map((delta) => {
    const L = delta / ALPHA_UB;
    const tp = largestWithin(FL, L);
    return [delta, { load: r4(L), thetaP: tp, stepUpLegit: r4(FL(tp)), FDRatAlphaUB: r4(ALPHA_UB * FL(tp)),
      FAR: Object.fromEntries(BETAS.map((b) => [b, r4(1 - FS(tp) + b * FS(tp))])) }];
  }));
  // Binary threshold range from the block bootstrap in run-field.mjs.
  const boot = name.startsWith('field: ') ? field.binaryBootstrap?.[name.slice(7)] : null;
  if (boot) {
    for (const delta of DELTAS) {
      const th = boot.theta[delta];
      src.binary[delta].bootstrap = { theta: [th.p2_5, th.p97_5], FAR: [r4(1 - FS(th.p97_5)), r4(1 - FS(th.p2_5))] };
    }
  }
  for (const tp of THETA_P) {
    const g = { stepUpLegit: r4(FL(tp)), stepUpSpoofed: r4(FS(tp)), FDRatAlphaUB: r4(ALPHA_UB * FL(tp)), FAR: {} };
    for (const b of BETAS) g.FAR[b] = r4(1 - FS(tp) + b * FS(tp));
    g.vsBinary = Object.fromEntries(DELTAS.map((delta) => {
      const tb = src.binary[delta].theta;
      return [delta, { thetaB: tb, betaStar: tb >= tp ? null : r4((FS(tp) - FS(tb)) / FS(tp)), alphaStar: FL(tp) ? r4(FL(tb) / FL(tp)) : null }];
    }));
    src.graduated[tp] = g;
  }
  out.sources[name] = src;
}
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'tradeoff.json'), JSON.stringify(out, null, 2));

const log = (...a) => console.error(...a);
log(`spoofed (synthetic test, n=${out.spoofed.n}) F_S: ${JSON.stringify(out.spoofed.F)}  alpha UB ${ALPHA_UB}`);
for (const [name, s] of Object.entries(out.sources)) {
  log(`\n${name} (n=${s.n})  F_L ${JSON.stringify(s.F)}`);
  for (const d of DELTAS) log(`  binary @ FDR<=${d}: theta ${s.binary[d].theta} FAR ${s.binary[d].FAR} FDR ${s.binary[d].FDR}` + (s.binary[d].bootstrap ? ` bootstrap ${JSON.stringify(s.binary[d].bootstrap)}` : ''));
  for (const d of DELTAS) { const g = s.tunedToDelta[d]; log(`  graduated meeting delta=${d} at alpha UB: L ${g.load} theta_p ${g.thetaP} step-up ${g.stepUpLegit} FDR<=${g.FDRatAlphaUB} FAR ${Object.values(g.FAR).join('/')}`); }
  for (const L of LOADS) { const g = s.tuned[L]; log(`  graduated @ step-up<=${L}: theta_p ${g.thetaP} legit step-up ${g.stepUpLegit} FDR<=${g.FDRatAlphaUB} FAR ${Object.values(g.FAR).join('/')} beta* ${JSON.stringify(g.betaStar)}`); }
  for (const tp of THETA_P) {
    const g = s.graduated[tp];
    log(`  graduated (${tp}, 0): legit step-up ${g.stepUpLegit}, FDR<=${g.FDRatAlphaUB}, FAR beta0/.1/.25 ${Object.values(g.FAR).join('/')}; vs binary ${JSON.stringify(g.vsBinary)}`);
  }
}
