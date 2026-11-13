// Numbers ledger for the IoT-J R1 manuscript.
//
// Every number the manuscript quotes from an experiment is a LaTeX macro
// generated here from a results/*.json file, so text, tables and the results
// cannot drift apart. Alongside numbers.tex the script writes a ledger
// (macro, value, file, key) for the pre-submission audit.
//
// Usage: node eval/iotj-r1/make-numbers.mjs [outDir]
//   (default F:/work/latex/zairn/iotl/revision/r1)
// Needs the results of run-baseline, run-shl, run-latch, run-field,
// run-stepup-trials, run-proof-size, run-tradeoff, run-weights, run-shapley.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? 'F:/work/latex/zairn/iotl/revision/r1';
const load = (f) => JSON.parse(readFileSync(join(here, 'results', f), 'utf8'));
const R = {
  baseline: load('baseline.json'), shl: load('shl.json'), latch: load('latch.json'), field: load('field.json'),
  trials: load('stepup-trials.json'), proof: load('proof-size.json'), tradeoff: load('tradeoff.json'),
  weights: load('weights.json'), shapley: load('shapley.json'), dense: load('dense-trace.json'),
};
if (existsSync(join(here, 'results', 'c-scorer.json'))) R.c = load('c-scorer.json');
if (existsSync(join(here, 'results', 'c-scorer-esp32s3.json'))) R.esp = load('c-scorer-esp32s3.json');

/** path: 'a.b.c', or an array when a key itself contains a dot (e.g. '0.9'). */
const get = (file, path) => (Array.isArray(path) ? path : path.split('.')).reduce((o, k) => {
  if (o == null || !(k in o)) throw new Error(`${file}: missing key ${path} (at ${k})`);
  return o[k];
}, R[file]);

// ---------- formatting ----------
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '{,}');
const dec = (x, d) => x.toFixed(d);
/** Fraction -> percent string with d decimals. */
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}\\%`;
/** Value already in percent. */
const pctRaw = (x, d = 1) => `${Number(x).toFixed(d)}\\%`;

const macros = [];
const ledger = [];
function def(name, value, file, key, note = '') {
  if (!/^[A-Za-z]+$/.test(name)) throw new Error(`bad macro name ${name}`);
  if (macros.some((m) => m.name === name)) throw new Error(`duplicate macro ${name}`);
  macros.push({ name, value });
  ledger.push({ name, value, file, key, note });
}
/** Define from a JSON key with a formatter. */
// Result file of each R key, for the ledger (keys that differ from the file name).
const FILE_OF = { trials: 'stepup-trials', proof: 'proof-size', dense: 'dense-trace', c: 'c-scorer', esp: 'c-scorer-esp32s3' };
const from = (name, file, key, fmt = (x) => String(x), note) => def(name, fmt(get(file, key)), `${FILE_OF[file] ?? file}.json`, [].concat(key).join('.'), note);

// ---------- data sources ----------
from('nShlFixes', 'shl', 'fixes', thousands);
from('nDenseFixes', 'dense', 'scored', thousands);
def('nDenseDays', String(Math.round(get('dense', 'trace.days'))), 'dense-trace.json', 'trace.days', 'rounded');
const streams = get('field', 'streams');
const sumFixes = (s) => streams.filter((x) => x.stream === s).reduce((a, b) => a + b.fixes, 0);
def('nFieldIphoneFixes', thousands(sumFixes('web (iPhone)')), 'field.json', 'streams[web (iPhone)].fixes', 'sum over sessions');
def('nFieldFlpFixes', thousands(sumFixes('web-equivalent (Android FLP)')), 'field.json', 'streams[Android FLP].fixes', 'sum over sessions and devices');
def('nFieldGpsFixes', thousands(sumFixes('native (Android GPS)')), 'field.json', 'streams[Android GPS].fixes', 'sum over sessions and devices');
const sessions = get('field', 'sessions');
def('nTotalHonestFixes', thousands(get('shl', 'fixes') + get('dense', 'scored') + streams.reduce((a, b) => a + b.scoredFixes, 0)), 'shl.json, dense-trace.json, field.json', 'fixes + scored + streams[].scoredFixes', 'sum of all scored real honest fixes');
def('nFieldMinutes', String(Math.round(sessions.reduce((a, s) => a + s.minutes, 0))), 'field.json', 'sessions[].minutes', 'sum');
const envMinutes = (pred) => Math.round(sessions.flatMap((s) => s.segments).filter((g) => pred(g.env)).reduce((a, g) => a + g.minutes, 0));
def('nFieldUndergroundMinutes', String(envMinutes((e) => e.startsWith('underground'))), 'field.json', 'sessions[].segments[underground*]', 'sum');
def('nFieldTrainMinutes', String(envMinutes((e) => e === 'surface train' || e === 'surface platform')), 'field.json', 'sessions[].segments[surface*]', 'sum');
// Chrome on the POCO against the same phone's fused stream (one trip).
const chrome = get('field', 'chrome');
if (chrome.length !== 1) throw new Error(`expected one Chrome check, got ${chrome.length}`);
def('nChromeMinutes', String(Math.round(chrome[0].minutes)), 'field.json', 'chrome[0].minutes');
def('nChromeFixes', thousands(chrome[0].chromeFixes), 'field.json', 'chrome[0].chromeFixes');
def('nChromeUnmatched', String(chrome[0].unmatched), 'field.json', 'chrome[0].unmatched', 'no FLP fix with the same time, position and accuracy');
// The 11-12 recordings came after S2' was fixed: share of fixes that report
// an accuracy below its 1 m cutoff.
const blind = streams.filter((s) => s.session.startsWith('2026-11-12'));
const blindWeb = Math.max(...blind.filter((s) => s.stream !== 'native (Android GPS)').map((s) => s.accuracyBelow1m));
if (blindWeb !== 0) throw new Error(`browser or fused fixes below 1 m on 11-12: ${blindWeb}%`);
def('nBlindFixes', thousands(blind.reduce((a, s) => a + s.fixes, 0)), 'field.json', 'streams[2026-11-12*].fixes', 'sum');
def('nBlindBelowOneMax', pctRaw(Math.max(...blind.map((s) => s.accuracyBelow1m))), 'field.json', 'max streams[2026-11-12*].accuracyBelow1m', 'browser and fused streams are 0 (asserted)');

// ---------- synthetic detection (test split) ----------
const det = (v, m) => get('baseline', `splits.test.detection.${v}.${m}`);
const ci3 = (c) => `${dec(c.point, 3)} [${dec(c.lo, 3)}, ${dec(c.hi, 3)}]`;
for (const [v, tag] of [['v1', 'Vone'], ['v2', 'Vtwo'], ['v2r', 'Vtwor']]) {
  def(`nAp${tag}`, dec(det(v, 'ap').point, 3), 'baseline.json', `splits.test.detection.${v}.ap.point`);
  def(`nAuc${tag}`, dec(det(v, 'aucRoc').point, 3), 'baseline.json', `splits.test.detection.${v}.aucRoc.point`);
  def(`nEer${tag}`, dec(det(v, 'eer').point, 3), 'baseline.json', `splits.test.detection.${v}.eer.point`);
  def(`nApCi${tag}`, ci3(det(v, 'ap')), 'baseline.json', `splits.test.detection.${v}.ap`);
}
const scen = get('baseline', 'splits.test.perScenario');
const SCEN_NAMES = { walking: 'Walking', driving: 'Driving', stationary: 'Stationary', train: 'Train', teleportation: 'Teleport', drift: 'Drift', accuracy: 'Accuracy', replay: 'Replay', network_mismatch: 'Net.\\ mismatch', compound: 'Compound' };
{
  const legit = Object.entries(scen).filter(([, s]) => s.label === 'legitimate');
  const spoof = Object.entries(scen).filter(([, s]) => s.label === 'spoofed');
  const rows = [];
  for (let i = 0; i < Math.max(legit.length, spoof.length); i++) {
    const L = legit[i], S = spoof[i];
    const l = L ? `${SCEN_NAMES[L[0]]} & ${dec(L[1].v1, 2)} & ${dec(L[1].v2, 2)} & ${dec(L[1].v2r, 2)}` : '& & &';
    const s = S ? `${SCEN_NAMES[S[0]]} & ${dec(S[1].v1, 2)} & ${dec(S[1].v2, 2)} & ${dec(S[1].v2r, 2)}` : '& & &';
    rows.push(`${l} & ${s} \\\\`);
  }
  def('tabScenarioRows', rows.join('\n'), 'baseline.json', 'splits.test.perScenario.*.{v1,v2,v2r}', 'table rows');
}
from('nSynthLegitMinVtwo', 'baseline', 'splits.test.distribution.legitimate.min', (x) => dec(x, 2));
from('nSynthLegitMinVtwor', 'baseline', 'splits.test.distributionV2r.legitimate.min', (x) => dec(x, 2));
from('nSynthAccuracyVtwo', 'baseline', 'splits.test.perScenario.accuracy.v2', (x) => dec(x, 2));
from('nSynthAccuracyVtwor', 'baseline', 'splits.test.perScenario.accuracy.v2r', (x) => dec(x, 2));
// Submitted Table V operating point re-run on the dev split (the manuscript's traces).
const devSweep = (theta) => get('baseline', 'splits.dev.sweep').find((s) => s.thetaP === theta);
def('nDevBinaryFdrNine', pct(devSweep(0.9).binary.fdr.point, 2), 'baseline.json', 'splits.dev.sweep[0.9].binary.fdr.point');
def('nDevLegitDeniedNine', String(devSweep(0.9).binary.legitDenied), 'baseline.json', 'splits.dev.sweep[0.9].binary.legitDenied');
// Corrected submitted Tables II and III (dev split = the submitted traces), for the response letter.
for (const [v, tag] of [['v1', 'Vone'], ['v2', 'Vtwo']]) {
  from(`nDevAp${tag}`, 'baseline', `splits.dev.detection.${v}.ap.point`, (x) => dec(x, 3));
  from(`nDevAuc${tag}`, 'baseline', `splits.dev.detection.${v}.aucRoc.point`, (x) => dec(x, 3));
  from(`nDevEer${tag}`, 'baseline', `splits.dev.detection.${v}.eer.point`, (x) => dec(x, 3));
}
from('nDevLegitMin', 'baseline', 'splits.dev.distribution.legitimate.min', (x) => dec(x, 2));
from('nDevSpoofMin', 'baseline', 'splits.dev.distribution.spoofed.min', (x) => dec(x, 2));
from('nDevLegitPtwentyfive', 'baseline', 'splits.dev.distribution.legitimate.p25', (x) => dec(x, 2));

// ---------- honest tails ----------
const tails = get('field', 'fixTails');
const ft = (stream, env, scorer, k) => tails[stream][env][scorer][k];
{
  const rows = [];
  const shlAll = get('shl', 'all');
  rows.push(`SHL, all modes & ${thousands(get('shl', 'fixes'))} & ${pct(shlAll.v2Paper.below09)} & ${pct(shlAll.v2Revised.below07, 2)} & ${pct(shlAll.v2Revised.below09, 2)} \\\\`);
  for (const [mode, label] of [['car', 'SHL, car'], ['train', 'SHL, train'], ['subway', 'SHL, subway']]) {
    const m = get('shl', `byMode.${mode}`);
    rows.push(`${label} & ${thousands(m.v2Revised.n)} & ${pct(m.v2Paper.below09)} & ${pct(m.v2Revised.below07, 2)} & ${pct(m.v2Revised.below09, 2)} \\\\`);
  }
  const dF = get('tradeoff', 'sources').dense ?? get('tradeoff', 'sources')['dense trace (60 s, POCO)'];
  rows.push(`Long-term, 60\\,s & ${thousands(get('dense', 'scored'))} & ${pct(get('dense', ['v2', 'below', '0.9']))} & ${pct(dF.F['0.7'], 2)} & ${pct(dF.F['0.9'], 2)} \\\\`);
  rows.push('\\midrule');
  const ENV = [['outdoor', 'outdoor'], ['indoor', 'indoor'], ['surface train', 'surface train'], ['underground', 'underground']];
  for (const [stream, label] of [['web (iPhone)', 'iPhone, browser'], ['web-equivalent (Android FLP)', 'Android, fused'], ['native (Android GPS)', 'Android, GPS']]) {
    for (const [env, envLabel] of ENV) {
      const t = tails[stream][env];
      rows.push(`${label}: ${envLabel} & ${thousands(t.fixes)} & ${pctRaw(t.V2.below09)} & ${pctRaw(t.V2r.below07, 2)} & ${pctRaw(t.V2r.below09, 2)} \\\\`);
    }
  }
  def('tabHonestRows', rows.join('\n'), 'shl.json, dense-trace.json, tradeoff.json, field.json', 'all.*, byMode.*, v2.below, sources.dense.F, fixTails.*', 'table rows');
}
from('nShlVtwoBelowNine', 'shl', 'all.v2Paper.below09', (x) => pct(x));
from('nShlVtworBelowNine', 'shl', 'all.v2Revised.below09', (x) => pct(x, 2));
from('nShlCarVtwoBelowNine', 'shl', 'byMode.car.v2Paper.below09', (x) => pct(x));
from('nDenseVtwoBelowNine', 'dense', ['v2', 'below', '0.9'], (x) => pct(x));
def('nIphoneUgBelowSeven', pctRaw(ft('web (iPhone)', 'underground', 'V2r', 'below07')), 'field.json', 'fixTails[web (iPhone)].underground.V2r.below07');
def('nIphoneUgBelowNine', pctRaw(ft('web (iPhone)', 'underground', 'V2r', 'below09')), 'field.json', 'fixTails[web (iPhone)].underground.V2r.below09');
def('nIphoneUgAccMedian', String(Math.round(tails['web (iPhone)'].underground.accuracy.p50)), 'field.json', 'fixTails[web (iPhone)].underground.accuracy.p50', 'metres');
def('nIphoneUgAccAboveFifty', pctRaw(tails['web (iPhone)'].underground.accuracyAbove['50'], 0), 'field.json', 'fixTails[web (iPhone)].underground.accuracyAbove.50');
def('nIphoneLowCauseAcc', pctRaw(tails['web (iPhone)'].all.V2rLowCauses.accuracyAnomaly, 0), 'field.json', 'fixTails[web (iPhone)].all.V2rLowCauses.accuracyAnomaly');
def('nIphoneLowCauseTemporal', pctRaw(tails['web (iPhone)'].all.V2rLowCauses.temporalConsistency, 0), 'field.json', 'fixTails[web (iPhone)].all.V2rLowCauses.temporalConsistency');
def('nFlpUgNoFixMinutes', String(Math.round(tails['web-equivalent (Android FLP)'].underground.noFixMinutes)), 'field.json', 'fixTails[Android FLP].underground.noFixMinutes');
def('nFlpUgMinutes', String(Math.round(tails['web-equivalent (Android FLP)'].underground.minutes)), 'field.json', 'fixTails[Android FLP].underground.minutes', 'device-minutes, two phones');
def('nGpsOutdoorVtwoBelowNine', pctRaw(ft('native (Android GPS)', 'outdoor', 'V2', 'below09'), 0), 'field.json', 'fixTails[Android GPS].outdoor.V2.below09');
def('nGpsOutdoorVoneBelowNine', pctRaw(ft('native (Android GPS)', 'outdoor', 'V1', 'below09'), 0), 'field.json', 'fixTails[Android GPS].outdoor.V1.below09');
def('nGpsOutdoorVtworBelowNine', pctRaw(ft('native (Android GPS)', 'outdoor', 'V2r', 'below09'), 2), 'field.json', 'fixTails[Android GPS].outdoor.V2r.below09');
def('nGpsAccMedian', dec(tails['native (Android GPS)'].all.accuracy.p50, 1), 'field.json', 'fixTails[Android GPS].all.accuracy.p50', 'metres');

// ---------- step-up trials and cost ----------
const P = get('trials', 'pooled');
const ciPct = (c) => `[${pct(c[0], 0)}, ${pct(c[1], 1)}]`;
def('nAlphaTrials', String(P.alpha.n), 'stepup-trials.json', 'pooled.alpha.n');
def('nAlphaFails', String(P.alpha.k), 'stepup-trials.json', 'pooled.alpha.k');
def('nAlphaUB', pct(P.alpha.ci95[1], 1), 'stepup-trials.json', 'pooled.alpha.ci95[1]');
def('nAlphaUBfrac', dec(P.alpha.ci95[1], 2), 'stepup-trials.json', 'pooled.alpha.ci95[1]');
def('nAlphaDeviceUB', pct(get('trials', 'outcomes')['POCO X7 Pro | legit'].rate.ci95[1], 1), 'stepup-trials.json', 'outcomes[*|legit].rate.ci95[1]', 'same for each device (0/30)');
def('nBetaNoneTrials', String(P.betaNoToken.n), 'stepup-trials.json', 'pooled.betaNoToken.n');
def('nBetaNoneUB', pct(P.betaNoToken.ci95[1], 1), 'stepup-trials.json', 'pooled.betaNoToken.ci95[1]');
def('nBetaStaleTrials', String(P.betaStale.n), 'stepup-trials.json', 'pooled.betaStale.n');
def('nBetaStaleUB', pct(P.betaStale.ci95[1], 1), 'stepup-trials.json', 'pooled.betaStale.ci95[1]');
from('nServerVerifyMedian', 'trials', 'server.warmVerifyMs.p50', (x) => dec(x, 1));
from('nServerVerifyPninetyfive', 'trials', 'server.warmVerifyMs.p95', (x) => dec(x, 1));
{
  const acc = get('trials', 'sessions').map((s) => Math.round(s.calibrationAccuracyM));
  const [lo, hi] = [Math.min(...acc), Math.max(...acc)];
  def('nCalibrationAcc', lo === hi ? String(lo) : `${lo}--${hi}`, 'stepup-trials.json', 'sessions[].calibrationAccuracyM', 'metres, one calibration per session');
}
{
  const L = get('trials', 'latency');
  const ANDROID = ['POCO X7 Pro', 'Jelly Star', 'nubia Z80 Ultra'];
  const PHONES = ['iPhone 16 Pro', ...ANDROID];
  const rows = [];
  for (const d of PHONES) {
    const w = L[d].warm, c = L[d].cold[0];
    const o = get('trials', 'outcomes')[`${d} | legit`];
    rows.push(`${d} & ${o.accepted}/${o.n} & ${w.scanMs.p50} & ${w.fixMs.p50} & ${w.proveMs.p50} & ${w.verifyRttMs.p50} & ${w.totalMs.p50} (${w.totalMs.p95}) & ${c.totalMs} \\\\`);
  }
  def('tabStepupRows', rows.join('\n'), 'stepup-trials.json', 'latency.*.warm.*.p50, latency.*.cold[0], outcomes.*|legit', 'table rows');
  def('nStepupTotalIphone', String(L['iPhone 16 Pro'].warm.totalMs.p50), 'stepup-trials.json', 'latency.iPhone 16 Pro.warm.totalMs.p50', 'ms');
  // Ranges of the per-phone medians (ms).
  const range = (name, ds, phase) => {
    const v = ds.map((d) => L[d].warm[phase].p50);
    def(`${name}Min`, String(Math.min(...v)), 'stepup-trials.json', `min latency[${ds.join(', ')}].warm.${phase}.p50`, 'ms');
    def(`${name}Max`, String(Math.max(...v)), 'stepup-trials.json', `max latency[${ds.join(', ')}].warm.${phase}.p50`, 'ms');
  };
  range('nStepupTotalAndroid', ANDROID, 'totalMs');
  range('nStepupFixAndroid', ANDROID, 'fixMs');
  range('nStepupProve', PHONES, 'proveMs');
}
from('nProofJsonBytes', 'proof', 'proof.jsonBytes');
from('nProofRawBytes', 'proof', 'proof.bn254UncompressedBytes');
from('nProofCompressedBytes', 'proof', 'proof.bn254CompressedBytes');
from('nPublicSignals', 'proof', 'publicSignals.count');
from('nVerifyBodyBytes', 'proof', 'verifyRequestBodyBytes', thousands);
from('nWasmKB', 'trials', 'artifacts.wasmBytes', (x) => String(Math.round(x / 1000)));
from('nZkeyKB', 'trials', 'artifacts.zkeyBytes', (x) => String(Math.round(x / 1000)));
from('nVkeyKB', 'trials', 'artifacts.vkeyBytes', (x) => dec(x / 1000, 1));
from('nNodeProveMedian', 'proof', 'nodeProveMs.p50', (x) => String(Math.round(x)));

// ---------- trade-off ----------
const T = get('tradeoff', 'sources');
const SRC = [
  ['synthetic legitimate (test)', 'Synthetic honest'],
  ['SHL (1 Hz, Mate 9)', 'SHL'],
  ['dense trace (60 s, POCO)', 'Long-term trace'],
  ['field: web (iPhone)', 'Field: iPhone, browser'],
  ['field: web-equivalent (Android FLP)', 'Field: Android, fused'],
  ['field: native (Android GPS)', 'Field: Android, GPS'],
];
{
  const rows = [];
  for (const [k, label] of SRC) {
    const s = T[k], b = s.binary['0.001'], g = s.tuned['0.05'];
    const bs = g.betaStar['0.001'];
    rows.push(`${label} & ${dec(b.theta, 2)} & ${pct(b.FAR, 0)} & ${dec(g.thetaP, 2)} & ${pct(g.stepUpLegit, 2)} & ${pct(g.FAR['0'], 0)} & ${pct(g.FAR['0.1'], 0)} & ${bs == null ? '---' : dec(bs, 2)} \\\\`);
  }
  def('tabTradeoffRows', rows.join('\n'), 'tradeoff.json', 'sources.*.binary.0.001, sources.*.tuned.0.05', 'table rows');
}
const ip = T['field: web (iPhone)'];
def('nIphoneBinThetaOne', dec(ip.binary['0.01'].theta, 2), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.01.theta');
def('nIphoneBinFarOne', pct(ip.binary['0.01'].FAR, 0), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.01.FAR');
def('nIphoneBinThetaTenth', dec(ip.binary['0.001'].theta, 2), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.001.theta');
def('nIphoneGradTheta', dec(ip.tuned['0.05'].thetaP, 2), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.thetaP');
def('nIphoneGradLoad', pct(ip.tuned['0.05'].stepUpLegit, 1), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.stepUpLegit');
def('nIphoneGradFar', pct(ip.tuned['0.05'].FAR['0'], 0), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.FAR.0');
def('nAdaptIphoneFar', pct(ip.tuned['0.05'].FARadaptive, 0), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.FARadaptive', 'A1 that reports a fixed point, so S4r = 1; beta = 0');
def('nIphoneGradFdr', pct(ip.tuned['0.05'].FDRatAlphaUB, 2), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.FDRatAlphaUB');
// FDR bound alpha_UB * L at L = 5%, and the load that meets delta = 0.1% at alpha_UB.
{
  const fdrs = SRC.map(([k]) => T[k].tuned['0.05'].FDRatAlphaUB);
  def('nFdrBoundMax', pct(Math.max(...fdrs), 2), 'tradeoff.json', 'max sources.*.tuned.0.05.FDRatAlphaUB');
  const over = fdrs.filter((x) => x > 0.001).length;
  def('nFdrAboveDelta', ['none', 'one', 'two', 'three', 'four', 'five', 'six'][over], 'tradeoff.json', 'count sources.*.tuned.0.05.FDRatAlphaUB > 0.001', 'of the six sources');
  const td = ip.tunedToDelta['0.001'];
  def('nLoadAtDelta', pct(td.load, 1), 'tradeoff.json', 'sources[field: web (iPhone)].tunedToDelta.0.001.load', 'delta / alpha_UB');
  def('nIphoneDeltaTheta', dec(td.thetaP, 2), 'tradeoff.json', 'sources[field: web (iPhone)].tunedToDelta.0.001.thetaP');
  def('nIphoneDeltaFar', pct(td.FAR['0'], 0), 'tradeoff.json', 'sources[field: web (iPhone)].tunedToDelta.0.001.FAR.0');
  const bt = ip.binary['0.001'].bootstrap;
  def('nIphoneBinThetaTenthHi', dec(bt.theta[1], 2), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.001.bootstrap.theta[1]', 'block bootstrap 97.5th percentile');
  def('nIphoneBinThetaTenthLo', dec(bt.theta[0], 2), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.001.bootstrap.theta[0]', 'block bootstrap 2.5th percentile');
  def('nIphoneBinFarTenthLo', pct(bt.FAR[0], 0), 'tradeoff.json', 'sources[field: web (iPhone)].binary.0.001.bootstrap.FAR[0]', 'FAR at the 97.5th-percentile theta');
  const hI = get('field', 'histograms')['web (iPhone)'].V2r;
  def('nIphoneAtThetaB', String(hI.slice(0, Math.round(ip.binary['0.001'].theta * 100) + 1).reduce((a, b) => a + b, 0)), 'field.json', 'histograms[web (iPhone)].V2r[0..theta_b]', 'fixes scoring at or below theta_b at delta = 0.1%');
}
def('nIphoneBetaStarOne', dec(ip.tuned['0.05'].betaStar['0.01'], 2), 'tradeoff.json', 'sources[field: web (iPhone)].tuned.0.05.betaStar.0.01');
const shlT = T['SHL (1 Hz, Mate 9)'];
def('nShlBinTheta', dec(shlT.binary['0.001'].theta, 2), 'tradeoff.json', 'sources[SHL].binary.0.001.theta');
def('nShlBinFar', pct(shlT.binary['0.001'].FAR, 0), 'tradeoff.json', 'sources[SHL].binary.0.001.FAR');
def('nShlGradFar', pct(shlT.tuned['0.05'].FAR['0'], 0), 'tradeoff.json', 'sources[SHL].tuned.0.05.FAR.0');
def('nShlGradLoad', pct(shlT.tuned['0.05'].stepUpLegit, 2), 'tradeoff.json', 'sources[SHL].tuned.0.05.stepUpLegit');
def('nShlBetaStar', dec(shlT.tuned['0.05'].betaStar['0.001'], 2), 'tradeoff.json', 'sources[SHL].tuned.0.05.betaStar.0.001');
const FS = get('tradeoff', 'spoofed.F');
def('nSpoofAtOne', pct(1 - FS['1'], 0), 'tradeoff.json', 'spoofed.F.1', '1 - F_S(1): spoofs scoring exactly 1.00');
from('nDriftDetNine', 'tradeoff', ['spoofed', 'detectedByScenario', 'drift', '0.9'], (x) => pct(x, 1));
def('nSpoofN', thousands(get('tradeoff', 'spoofed.n')), 'tradeoff.json', 'spoofed.n');

// Ten-minute windows of the field streams (V2r).
{
  const Wn = get('field', 'windows');
  def('nIphoneWindows', String(Wn['web (iPhone)'].windows), 'field.json', 'windows[web (iPhone)].windows');
  def('nIphoneWinStepupSeven', pctRaw(Wn['web (iPhone)']['V2r@0.7'].stepUp, 0), 'field.json', 'windows[web (iPhone)][V2r@0.7].stepUp');
  def('nIphoneWinStepupNine', pctRaw(Wn['web (iPhone)']['V2r@0.9'].stepUp, 0), 'field.json', 'windows[web (iPhone)][V2r@0.9].stepUp');
  def('nIphoneWinDenyK', pctRaw(Wn['web (iPhone)']['V2r@0.7'].denyK, 0), 'field.json', 'windows[web (iPhone)][V2r@0.7].denyK', '3-of-5 below theta_s');
  def('nFlpWinStepupSevenVtwo', pctRaw(Wn['web-equivalent (Android FLP)']['V2@0.7'].stepUp, 0), 'field.json', 'windows[Android FLP][V2@0.7].stepUp');
  def('nFlpWinStepupSevenVtwor', pctRaw(Wn['web-equivalent (Android FLP)']['V2r@0.7'].stepUp, 0), 'field.json', 'windows[Android FLP][V2r@0.7].stepUp');
}

// ---------- latch ----------
const H = get('latch', 'honest');
const hp = (src, tp, pol, k) => H[`${src}|v2Revised|${tp}`][pol][k];
from('nShlSessions', 'latch', 'shlSessions', thousands);
from('nDenseSessions', 'latch', 'denseSessions', thousands);
{
  const rows = [];
  for (const [src, label] of [['shl', 'SHL, 1\\,Hz'], ['dense', 'Long-term, 60\\,s']]) {
    for (const tp of [0.7, 0.9, 1]) {
      rows.push(`${label} & ${dec(tp, 1)} & ${pct(hp(src, tp, 'first', 'stepUpOrDeny'))} & ${pct(hp(src, tp, 'single/3-of-5', 'deny'))} & ${pct(hp(src, tp, 'single/no-score-deny', 'deny'))} \\\\`);
    }
  }
  def('tabLatchHonestRows', rows.join('\n'), 'latch.json', 'honest[*|v2Revised|*].{first,single/3-of-5,single/no-score-deny}', 'table rows');
}
def('nShlSessionStepupNine', pct(hp('shl', 0.9, 'first', 'stepUpOrDeny')), 'latch.json', 'honest[shl|v2Revised|0.9].first.stepUpOrDeny');
def('nShlSessionStepupOne', pct(hp('shl', 1, 'first', 'stepUpOrDeny'), 0), 'latch.json', 'honest[shl|v2Revised|1].first.stepUpOrDeny');
def('nShlSessionStepupSeven', pct(hp('shl', 0.7, 'first', 'stepUpOrDeny')), 'latch.json', 'honest[shl|v2Revised|0.7].first.stepUpOrDeny');
def('nShlSessionDenyKofn', pct(hp('shl', 0.7, 'single/3-of-5', 'deny')), 'latch.json', 'honest[shl|v2Revised|0.7].single/3-of-5.deny');
def('nShlSessionStepupPaperNine', pct(H['shl|v2Paper|0.9'].first.stepUpOrDeny, 0), 'latch.json', 'honest[shl|v2Paper|0.9].first.stepUpOrDeny');
{
  const A = get('latch', 'attacks');
  const rows = [];
  const NAMES = [['teleport (acc 5 m)', 'Teleport'], ['static mock 10 m', 'Static, 10\\,m'], ['static mock 25 m', 'Static, 25\\,m'], ['static mock 50 m', 'Static, 50\\,m'], ['static mock 100 m', 'Static, 100\\,m'], ['static mock 550 m', 'Static, 550\\,m'], ['route mock 1.4 m/s', 'Route, 1.4\\,m/s']];
  for (const [k, label] of NAMES) {
    const cell = (tp) => pct(A[k][`v2Revised|${tp}`]['single/no-score-deny'].detected, 0);
    rows.push(`${label} & & ${cell(0.7)} & ${cell(0.9)} & ${cell(1)} \\\\`);
  }
  def('tabLatchAttackRows', rows.join('\n'), 'latch.json', 'attacks.*[v2Revised|*].single/no-score-deny.detected', 'table rows');
  def('nMockTenNine', pct(A['static mock 10 m']['v2Revised|0.9']['single/no-score-deny'].detected, 0), 'latch.json', 'attacks[static mock 10 m][v2Revised|0.9].single/no-score-deny.detected');
  def('nMockHundredSeven', pct(A['static mock 100 m']['v2Revised|0.7']['single/no-score-deny'].detected, 0), 'latch.json', 'attacks[static mock 100 m][v2Revised|0.7].single/no-score-deny.detected');
  def('nMockFiftyNine', pct(A['static mock 50 m']['v2Revised|0.9']['single/no-score-deny'].detected, 0), 'latch.json', 'attacks[static mock 50 m][v2Revised|0.9].single/no-score-deny.detected');
  def('nMockRouteNine', pct(A['route mock 1.4 m/s']['v2Revised|0.9']['single/no-score-deny'].detected, 0), 'latch.json', 'attacks[route mock 1.4 m/s][v2Revised|0.9].single/no-score-deny.detected');
  // Smallest detection at θp = 0.9 among static mocks of 50 m or more.
  const big = ['static mock 50 m', 'static mock 100 m', 'static mock 200 m', 'static mock 550 m'];
  def('nMockFiftyPlusMinNine', pct(Math.min(...big.map((k) => A[k]['v2Revised|0.9']['single/no-score-deny'].detected)), 0), 'latch.json', 'min over static mock ≥50 m [v2Revised|0.9].single/no-score-deny.detected');
  def('nMockHundredSevenBoth', pct(A['static mock 100 m']['v2Revised|0.7']['2-of-5 both'].detected, 0), 'latch.json', 'attacks[static mock 100 m][v2Revised|0.7].2-of-5 both.detected');
}
// Real mock location at home (POCO X7 Pro), score at the switch.
{
  const st = get('field', 'mock.streams');
  const rows = [];
  for (let i = 0; i < st.FLP.stages.length; i++) {
    const f = st.FLP.stages[i], g = st.GPS?.stages?.[i];
    rows.push(`${thousands(f.displacementM)} & ${dec(f.V2r.switchScore, 2)} & ${dec(f.V2r.steadyMedian, 2)} & ${dec(f['V2r+S5'].steadyMedian, 2)} & ${g ? dec(g.V2r.switchScore, 2) : '---'} & ${g ? dec(g['V2r+S5'].steadyMedian, 2) : '---'} \\\\`);
  }
  def('tabMockRows', rows.join('\n'), 'field.json', 'mock.streams.{FLP,GPS}.stages[].{V2r,V2r+S5}', 'table rows');
  def('nMockSmallDisp', String(st.FLP.stages[0].displacementM), 'field.json', 'mock.streams.FLP.stages[0].displacementM');
  def('nMockSmallSwitch', dec(st.FLP.stages[0].V2r.switchScore, 2), 'field.json', 'mock.streams.FLP.stages[0].V2r.switchScore');
  def('nMockSmallSwitchGps', dec(st.GPS.stages[0].V2r.switchScore, 2), 'field.json', 'mock.streams.GPS.stages[0].V2r.switchScore');
}

// ---------- weights and Shapley ----------
from('nTableOneAp', 'weights', 'sets.submitted.all5.tableI.ap', (x) => dec(x, 3));
from('nTableOneApPercentile', 'weights', 'sets.submitted.all5.random.tableIPercentile.ap', (x) => String(Math.round(x)), 'percentile among Dirichlet draws');
from('nTableOneFarPercentile', 'weights', 'sets.submitted.all5.random.tableIPercentile.farAtFdr', (x) => String(Math.round(x)), 'share of Dirichlet draws that Table I beats on FAR at FDR<=0.1% (higher = better)');
from('nRandomApPfive', 'weights', 'sets.submitted.all5.random.summary.ap.p5', (x) => dec(x, 3));
from('nRandomApPfifty', 'weights', 'sets.submitted.all5.random.summary.ap.p50', (x) => dec(x, 3));
from('nRandomFarMedian', 'weights', 'sets.submitted.all5.random.summary.farAtFdr.p50', (x) => pct(x, 0));
from('nTableOneFarAtFdr', 'weights', 'sets.submitted.all5.tableI.farAtFdr', (x) => pct(x, 1));
from('nLearnedAp', 'weights', 'sets.submitted.all5.learned.ap', (x) => dec(x, 3));
def('nLearnedWeights', get('weights', 'sets.submitted.all5.learned.weights').map((w) => dec(w, 2)).join('/'), 'weights.json', 'sets.submitted.all5.learned.weights');
{
  // Leave-one-attack-out with the revised signals: the held-out accuracy attack.
  const fold = get('weights', 'sets.revised.all5.loao.folds').find((f) => f.heldOut === 'accuracy');
  def('nLoaoAccLearned', dec(fold.learned.tprHeldOutFdr, 2), 'weights.json', 'sets.revised.all5.loao.folds[accuracy].learned.tprHeldOutFdr');
  def('nLoaoAccTableOne', dec(fold.tableI.tprHeldOutFdr, 2), 'weights.json', 'sets.revised.all5.loao.folds[accuracy].tableI.tprHeldOutFdr');
}
const Sh = get('shapley', 'shapley.submitted.games');
for (const [i, s] of ['S1', 'S2', 'S3', 'S4', 'S5'].entries()) {
  def(`nShapAp${['One', 'Two', 'Three', 'Four', 'Five'][i]}`, dec(Sh.ap.shapley[s].point, 3), 'shapley.json', `shapley.submitted.games.ap.shapley.${s}.point`);
  def(`nShapSeven${['One', 'Two', 'Three', 'Four', 'Five'][i]}`, dec(Sh.f1At07.shapley[s].point, 3), 'shapley.json', `shapley.submitted.games.f1At07.shapley.${s}.point`);
  def(`nShapVal${['One', 'Two', 'Three', 'Four', 'Five'][i]}`, dec(Sh.f1Val.shapley[s].point, 3), 'shapley.json', `shapley.submitted.games.f1Val.shapley.${s}.point`);
}
from('nDilutionW', 'shapley', 'dilution.submitted.lemma.W', (x) => dec(x, 2));
from('nDilutionTheta', 'shapley', 'dilution.submitted.lemma.effectiveThetaOnPairWhenRestBlind', (x) => dec(x, 2));
from('nDilutionEquivTheta', 'shapley', 'dilution.submitted.lemma.equivalentAllFiveTheta', (x) => dec(x, 3));
{
  // Traces whose all-five decision at θ = 0.7 the lemma predicts (test split).
  const D = Object.values(get('shapley', 'dilution.submitted.test'));
  const agree = D.reduce((s, d) => s + Math.round(d.lemmaAgreement * d.n), 0);
  const total = D.reduce((s, d) => s + d.n, 0);
  def('nLemmaAgree', thousands(agree), 'shapley.json', 'dilution.submitted.test[*].lemmaAgreement×n', 'sum');
  def('nLemmaTotal', thousands(total), 'shapley.json', 'dilution.submitted.test[*].n', 'sum');
}
from('nAllMinusPairSeven', 'shapley', 'shapley.submitted.contrasts.f1At07: all - S3+S5.point', (x) => dec(x, 3));
from('nAllMinusPairVal', 'shapley', 'shapley.submitted.contrasts.f1Val: all - S3+S5.point', (x) => dec(x, 3));
from('nLogOddsFoneSeven', 'shapley', 'logOdds.allFive.f1At07', (x) => dec(x, 2));
from('nLogOddsPairFoneSeven', 'shapley', 'logOdds.pairS3S5.f1At07', (x) => dec(x, 2));

// ---------- C port (run by c-scorer/build.sh) ----------
if (R.c) {
  const eq = get('c', 'equivalence');
  const cfgs = get('c', 'equivalence.x86_64-gcc.configs');
  for (const [tc, e] of Object.entries(eq)) {
    if (!e.configs) continue;
    for (const [k, c] of Object.entries(e.configs)) {
      if (c.scoreExact !== c.n) throw new Error(`c-scorer: ${tc} ${k} not score-exact`);
    }
  }
  from('nCTraces', 'c', 'equivalence.x86_64-gcc.traces', thousands);
  def('nCConfigs', String(Object.keys(cfgs).length), 'c-scorer.json', 'equivalence.x86_64-gcc.configs', 'count; every config score-exact (asserted)');
  from('nCLatV', 'c', 'latency.x86_64-msvc.chunked.V2.median_ns', (x) => dec(x, 0), 'ns, MSVC /O2, full context');
  from('nCLatVr', 'c', 'latency.x86_64-msvc.chunked.V2r.median_ns', (x) => dec(x, 0), 'ns, MSVC /O2, full context');
  from('nJsLatV', 'c', 'latency.node-v8.chunked.V2.median_ns', (x) => dec(x / 1000, 1), 'us, Node 24, includes ISO timestamp parsing');
  const fp = get('c', 'footprint');
  const objs = [], linked = [], stacks = [];
  for (const [t, f] of Object.entries(fp)) {
    for (const o of ['O2', 'Os']) {
      if (!f?.[o]) continue;
      objs.push(f[o].object.code);
      if (f[o].linkedClosure) linked.push(f[o].linkedClosure.total.code);
      if (t !== 'x86_64-gcc') stacks.push(...Object.values(f[o].stackBytes).map((s) => s.bytes));
    }
  }
  def('nCCodeMin', dec(Math.min(...objs) / 1000, 1), 'c-scorer.json', 'footprint.*.{O2,Os}.object.code', 'min over targets, kB');
  def('nCCodeMax', dec(Math.max(...objs) / 1000, 1), 'c-scorer.json', 'footprint.*.{O2,Os}.object.code', 'max over targets, kB');
  def('nCLinkedMin', dec(Math.min(...linked) / 1000, 0), 'c-scorer.json', 'footprint.esp32*.linkedClosure.total.code', 'kB, with libm and soft-float helpers');
  def('nCLinkedMax', dec(Math.max(...linked) / 1000, 0), 'c-scorer.json', 'footprint.esp32*.linkedClosure.total.code', 'kB, with libm and soft-float helpers');
  def('nCStackMax', dec(Math.max(...stacks) / 1000, 1), 'c-scorer.json', 'footprint.*.stackBytes', 'kB, embedded targets, libm excluded');
  const sz = get('c', 'footprint.sizeof');
  def('nCStateBytes', String(sz.ts_point + sz.ts_history + sz.ts_context), 'c-scorer.json', 'footprint.sizeof', 'ts_point + ts_history + ts_context');
  const ops = get('c', ['operationCounts', 'configs', 'V2/both']);
  const arith = ['add', 'mul', 'div', 'cmp', 'cvt', 'floor'].reduce((a, k) => a + ops[k].mean, 0);
  def('nCOpsArith', String(Math.round(arith / 10) * 10), 'c-scorer.json', 'operationCounts.configs.V2/both', 'mean add+mul+div+cmp+cvt+floor, rounded to 10');
  def('nCOpsTrans', String(['sqrt', 'sin', 'cos', 'atan2'].reduce((a, k) => a + ops[k].mean, 0)), 'c-scorer.json', 'operationCounts.configs.V2/both', 'mean sqrt+sin+cos+atan2');
  const mcu = get('c', 'mcuEstimate.V2_full.gccSoftDoubleCortexM0');
  def('nCMcuCycles', `\\ensuremath{${dec(mcu.cycles / 1e5, 1)}\\times10^{5}}`, 'c-scorer.json', 'mcuEstimate.V2_full.gccSoftDoubleCortexM0.cycles', 'ESTIMATE: op counts x Qfplib README GCC-column cycles');
  def('nCMcuMs', dec(mcu.ms['nRF52840 (Cortex-M4F)'], 1), 'c-scorer.json', 'mcuEstimate.V2_full.gccSoftDoubleCortexM0.ms.nRF52840', 'ESTIMATE, ms at 64 MHz');
  const net = cfgs['V2/net'];
  def('nCTieShare', pct(net.rawOnRoundingTie / net.n, 0), 'c-scorer.json', 'equivalence.x86_64-gcc.configs.V2/net.rawOnRoundingTie', 'profile without S4 (network, no fixes)');
  def('nCTieCount', thousands(net.rawOnRoundingTie), 'c-scorer.json', 'equivalence.x86_64-gcc.configs.V2/net.rawOnRoundingTie');
  def('nCFloatFlips', thousands(net.scoresChangedIf.float32Sum['gate0.9/0.3']), 'c-scorer.json', 'equivalence.x86_64-gcc.configs.V2/net.scoresChangedIf.float32Sum.gate0.9/0.3');
}

// ---------- C port on an ESP32-S3 board (c-scorer/esp32s3) ----------
if (R.esp) {
  const eq = get('esp', 'equivalence');
  if (!eq.allScoresExact) throw new Error('esp32s3: not every score exact');
  if (R.c && (eq.traces !== get('c', 'equivalence.x86_64-gcc.traces') || eq.configs !== Object.keys(get('c', 'equivalence.x86_64-gcc.configs')).length)) {
    throw new Error('esp32s3: traces or configurations differ from the desktop run');
  }
  from('nEspMhz', 'esp', 'platform.cpu_mhz_config', String, 'configured; measured clock in platform.cpu_hz_measured');
  from('nEspLatV', 'esp', 'latency.V2.median_us', (x) => dec(x, 0), 'us, single call, full context, dev split, median of 3 pass medians');
  from('nEspLatVr', 'esp', 'latency.V2r.median_us', (x) => dec(x, 0), 'us, single call, full context, dev split');
  from('nEspPninetyNineV', 'esp', 'latency.V2.p99_us', (x) => dec(x, 0), 'us, p99 over the dev split');
  from('nEspCyclesV', 'esp', 'latency.V2.median_cycles', (x) => `\\ensuremath{${dec(x / 1e5, 2)}\\times10^{5}}`, 'CCOUNT cycles, median');
}

// ---------- equal weights (make-equal-weights.mjs, then the run-* scripts in eval/iotj-r1-equal) ----------
{
  const eqDir = join(here, '..', 'iotj-r1-equal', 'results');
  if (!existsSync(join(eqDir, 'tradeoff.json'))) throw new Error(`missing ${eqDir}; run make-equal-weights.mjs and the run-* scripts there first`);
  const E = (f) => JSON.parse(readFileSync(join(eqDir, f), 'utf8'));
  const eb = E('baseline.json'), et = E('tradeoff.json'), el = E('latch.json'), ef = E('field.json');
  const src = 'iotj-r1-equal/results/';
  def('nEqApVtwo', dec(eb.splits.test.detection.v2.ap.point, 3), `${src}baseline.json`, 'splits.test.detection.v2.ap.point');
  const eip = et.sources['field: web (iPhone)'];
  def('nEqIphoneBinThetaTenth', dec(eip.binary['0.001'].theta, 2), `${src}tradeoff.json`, 'sources[field: web (iPhone)].binary.0.001.theta');
  def('nEqIphoneBinFarTenth', pct(eip.binary['0.001'].FAR, 0), `${src}tradeoff.json`, 'sources[field: web (iPhone)].binary.0.001.FAR');
  def('nEqDenseBetaStar', dec(et.sources['dense trace (60 s, POCO)'].tuned['0.05'].betaStar['0.001'], 2), `${src}tradeoff.json`, 'sources[dense trace (60 s, POCO)].tuned.0.05.betaStar.0.001');
  const EA = el.attacks;
  const big = ['static mock 50 m', 'static mock 100 m', 'static mock 200 m', 'static mock 550 m'];
  def('nEqMockFiftyPlusMinNine', pct(Math.min(...big.map((k) => EA[k]['v2Revised|0.9']['single/no-score-deny'].detected)), 0), `${src}latch.json`, 'min over static mock ≥50 m [v2Revised|0.9].single/no-score-deny.detected');
  def('nEqMockHundredSeven', pct(EA['static mock 100 m']['v2Revised|0.7']['single/no-score-deny'].detected, 0), `${src}latch.json`, 'attacks[static mock 100 m][v2Revised|0.7].single/no-score-deny.detected');
  def('nEqMockSmallSteady', dec(ef.mock.streams.FLP.stages[0].V2r.steadyMedian, 2), `${src}field.json`, 'mock.streams.FLP.stages[0].V2r.steadyMedian');
}
def('nMockSmallSteady', dec(get('field', 'mock.streams').FLP.stages[0].V2r.steadyMedian, 2), 'field.json', 'mock.streams.FLP.stages[0].V2r.steadyMedian');
def('nDenseBetaStar', dec(T['dense trace (60 s, POCO)'].tuned['0.05'].betaStar['0.001'], 2), 'tradeoff.json', 'sources[dense trace (60 s, POCO)].tuned.0.05.betaStar.0.001');

// ---------- write ----------
const header = `% Generated by eval/iotj-r1/make-numbers.mjs on ${new Date().toISOString()}. Do not edit.\n`;
const body = macros.map((m) => `\\newcommand{\\${m.name}}{${m.value.includes('\n') ? `%\n${m.value}%\n` : m.value}}`).join('\n');
writeFileSync(join(outDir, 'numbers.tex'), `${header}${body}\n`);
const md = ['# Numbers ledger (generated, do not edit)', '', `Generated ${new Date().toISOString()} by eval/iotj-r1/make-numbers.mjs.`, '', '| macro | value | file | key | note |', '|---|---|---|---|---|',
  ...ledger.map((l) => `| \\${l.name} | ${l.value.includes('\n') ? '(table rows)' : l.value.replace(/\|/g, '/')} | ${l.file} | ${l.key.replace(/\|/g, '/')} | ${l.note} |`)].join('\n');
writeFileSync(join(outDir, 'numbers-ledger.md'), `${md}\n`);
console.error(`wrote ${macros.length} macros to ${join(outDir, 'numbers.tex')}`);
