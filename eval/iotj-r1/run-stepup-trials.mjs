// Step-up prototype trials on real phones (reviewer cluster C1: R1-2, R1-4,
// R1-10, R2-2, R3-1). Inputs are the server logs (outcomes) and the per-device
// JSON exports of the trial page (client-side timings). Neither holds
// coordinates. Each server log is one session at the same site (2026-11-06:
// iPhone, POCO, Jelly Star; 2026-11-12: nubia), with its own calibration.
//
//   legit  the phone scans the venue QR and proves proximity      -> alpha
//   none   no token (forged MAC), i.e. a remote spoofer            -> beta
//   stale  a token at least one minute old (replayed screenshot)   -> beta
//
// alpha/beta come with exact (Clopper-Pearson) 95% intervals. Latency is split
// into session, QR scan, GPS fix, proving and round trip; the first trial of
// each device (cold: circuit download and compile) is reported separately,
// and the first server verification after each start-up is excluded from
// the server verify time (Node/snarkjs warm-up).
//
// Usage: node eval/iotj-r1/run-stepup-trials.mjs [dir]   (default F:/data/field-2026-11/stepup)
// Writes results/stepup-trials.json; prints a summary to stderr.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? 'F:/data/field-2026-11/stepup';

// Device labels typed on the trial page -> names used in the manuscript.
const DEVICE = { iPhone: 'iPhone 16 Pro', iphone16pro: 'iPhone 16 Pro', 'poco-x7-pro': 'POCO X7 Pro', 'jelly-star': 'Jelly Star', nubia: 'nubia Z80 Ultra', 'nubia-z80-ultra': 'nubia Z80 Ultra' };
const deviceName = (d) => DEVICE[d] ?? d;

// Exact binomial (Clopper-Pearson) interval via bisection on the beta CDF.
function lnGamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function binomCdf(k, n, p) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return s;
}
function clopperPearson(k, n, level = 0.95) {
  const a = (1 - level) / 2;
  const solve = (f) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) hi = m; else lo = m; } return (lo + hi) / 2; };
  const lower = k === 0 ? 0 : solve((p) => 1 - binomCdf(k - 1, n, p) >= a);
  const upper = k === n ? 1 : solve((p) => binomCdf(k, n, p) <= a);
  return [lower, upper];
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : null; };
const summary = (xs) => ({ n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: xs.length ? Math.max(...xs) : null });

// ---------- outcomes (server logs) ----------
const sessions = [];
for (const f of readdirSync(dir).filter((f) => f.startsWith('server-trials-') && f.endsWith('.jsonl')).sort()) {
  const events = readFileSync(join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const calibration = events.find((e) => e.event === 'calibrate');
  const verifies = events.filter((e) => e.event === 'verify' && Date.parse(e.ts) > Date.parse(calibration.ts));
  sessions.push({ log: f, calibration, verifies });
}
const verifies = sessions.flatMap((x) => x.verifies);

const outcomes = {};
for (const e of verifies) {
  const key = `${deviceName(e.device)} | ${e.trialType}`;
  const o = (outcomes[key] ??= { device: deviceName(e.device), trialType: e.trialType, n: 0, accepted: 0, reasons: {} });
  o.n++;
  if (e.ok) o.accepted++;
  o.reasons[e.reason] = (o.reasons[e.reason] ?? 0) + 1;
}
for (const o of Object.values(outcomes)) {
  const k = o.trialType === 'legit' ? o.n - o.accepted : o.accepted; // failures for alpha, bypasses for beta
  const [lo, hi] = clopperPearson(k, o.n);
  o.rate = { name: o.trialType === 'legit' ? 'alpha' : 'beta', k, value: r3(k / o.n), ci95: [r3(lo), r3(hi)], ci95Exact: [lo, hi] };
}
const pool = (type) => {
  const os = Object.values(outcomes).filter((o) => o.trialType === type);
  const n = os.reduce((s, o) => s + o.n, 0), k = os.reduce((s, o) => s + o.rate.k, 0);
  const [lo, hi] = clopperPearson(k, n);
  return { n, k, value: r3(k / n), ci95: [r3(lo), r3(hi)], ci95Exact: [lo, hi] };
};
const pooled = { alpha: pool('legit'), betaNoToken: pool('none'), betaStale: pool('stale') };

// Server verification time: Groth16 verify in Node (snarkjs) on the PC.
const verifyMsOf = (x) => x.verifies.map((e) => e.verifyMs).filter((v) => typeof v === 'number');
const server = {
  firstVerifyMs: sessions.map((x) => r3(verifyMsOf(x)[0])),
  warmVerifyMs: summary(sessions.flatMap((x) => verifyMsOf(x).slice(1)).map(r3)),
};

// ---------- client timings (device exports) ----------
const timing = {};
for (const f of readdirSync(dir).filter((f) => f.startsWith('stepup-') && f.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const t of j.trials) {
    if (t.trialType !== 'legit' || !t.ok) continue;
    const d = deviceName(t.device);
    (timing[d] ??= { cold: [], warm: [] })[t.cold ? 'cold' : 'warm'].push(t);
  }
}
const PHASES = ['sessionMs', 'scanMs', 'fixMs', 'proveMs', 'verifyRttMs', 'totalMs'];
const latency = {};
for (const [d, { cold, warm }] of Object.entries(timing)) {
  latency[d] = { warm: {}, cold: cold.map((t) => Object.fromEntries(PHASES.map((p) => [p, t[p]]))) };
  for (const p of PHASES) latency[d].warm[p] = summary(warm.map((t) => t[p]));
  latency[d].warm.fixAccuracyM = summary(warm.map((t) => t.fixAccuracyM));
}

// ---------- artifacts ----------
const art = join(here, 'stepup-proto', 'artifacts');
const size = (p) => { try { return statSync(join(art, p)).size; } catch { return null; } };
const artifacts = { wasmBytes: size('zairn_zkp_js/zairn_zkp.wasm'), zkeyBytes: size('zairn_zkp_final.zkey'), vkeyBytes: size('zairn_zkp_vkey.json') };

const out = {
  generated: new Date().toISOString(),
  sessions: sessions.map((x) => ({ log: x.log, calibrationAccuracyM: r3(x.calibration.accuracy), verifies: x.verifies.length })),
  outcomes, pooled, server, latency, artifacts,
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'stepup-trials.json'), JSON.stringify(out, null, 2));

const log = (...a) => console.error(...a);
for (const o of Object.values(outcomes)) log(`${o.device.padEnd(14)} ${o.trialType.padEnd(6)} ${o.accepted}/${o.n} accepted  ${o.rate.name}=${o.rate.value} [${o.rate.ci95}]  ${JSON.stringify(o.reasons)}`);
log('pooled', JSON.stringify(pooled));
log('server verify', JSON.stringify(server));
for (const [d, l] of Object.entries(latency)) log(`${d}: warm p50 total ${l.warm.totalMs.p50} (scan ${l.warm.scanMs.p50}, fix ${l.warm.fixMs.p50}, prove ${l.warm.proveMs.p50}, rtt ${l.warm.verifyRttMs.p50}) p95 total ${l.warm.totalMs.p95}; cold ${JSON.stringify(l.cold.map((c) => [c.totalMs, c.proveMs]))}`);
log('artifacts', JSON.stringify(artifacts));
