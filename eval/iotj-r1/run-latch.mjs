// Session latch policies (reviewer cluster C5: R1-3, R3-4).
//
// Honest sessions: 10-minute windows of the SHL Preview data (1 Hz) and of the
// dense trace (60 s cadence). Attack sessions: the same SHL windows with the
// second half replaced by mock-location fixes (semi-synthetic splice; the
// mock fixes keep the original timestamps). Step-up outcomes are not
// simulated: a session counts as "step-up" if the gate ever demands one.
//
// Each recording is scored as one stream and the honest sessions are cut
// from it, so the history carries across sessions, as on a server that
// keeps the device's recent fixes. Only the first fix of a recording has no
// history and is not scored. (Scoring each window on its own would score
// its second fix with the no-history values of S1 and S3, about 0.91, and
// send every session to step-up at thetaP = 1.)
//
// Policies, with thetaP / thetaS the proceed / step-up thresholds:
//   first        submitted manuscript: latch on the first non-PROCEED fix,
//                as DENY if that fix is below thetaS, otherwise as STEP-UP
//   single/k-of-n  STEP-UP latch on any fix below thetaP; DENY only when at
//                least k of the last n fixes are below thetaS (escalates a
//                STEP-UP latch)
//   k-of-n both  STEP-UP when k of the last n fixes are below thetaP, DENY when
//                k of the last n are below thetaS
//   single/no-score-deny  STEP-UP latch on any fix below thetaP; the score
//                never denies, DENY follows only a failed step-up (so honest
//                DENY = alpha x stepUpOrDeny)
//
// Usage: node eval/iotj-r1/run-latch.mjs [shlRoot] [denseTrace]
// Writes results/latch.json; prints a summary to stderr.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScore, computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';
import { loadShl, SHL_DEFAULT_ROOT } from './shl.mjs';
import { makeRng } from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shlRoot = process.argv[2] ?? SHL_DEFAULT_ROOT;
const densePath = resolve(process.argv[3] ?? join(here, '../../../openZenly/eval/dense-trace/raw-2026-04-26.json'));

const SESSION_S = 600;
const SWITCH_S = 300;
const THETA_P = [0.7, 0.9, 1];
const THETA_S = 0.3;
const POLICIES = {
  first: { kind: 'first' },
  'single/2-of-5': { kind: 'single', k: 2, n: 5 },
  'single/3-of-5': { kind: 'single', k: 3, n: 5 },
  '2-of-5 both': { kind: 'both', k: 2, n: 5 },
  'single/no-score-deny': { kind: 'single', k: Infinity, n: 5 },
};
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

/** Returns { state, stepUpAt, denyAt } (fix indices, or null). */
function runPolicy(scores, policy, thetaP, thetaS) {
  let state = 'open', stepUpAt = null, denyAt = null;
  const lowP = [], lowS = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (policy.kind === 'first') {
      if (state === 'open' && s < thetaP) {
        state = s < thetaS ? 'deny' : 'step-up';
        if (state === 'deny') denyAt = i; else stepUpAt = i;
      }
      continue;
    }
    lowP.push(s < thetaP); lowS.push(s < thetaS);
    if (lowP.length > policy.n) { lowP.shift(); lowS.shift(); }
    const nP = lowP.filter(Boolean).length, nS = lowS.filter(Boolean).length;
    const stepUp = policy.kind === 'single' ? s < thetaP : nP >= policy.k;
    if (state !== 'deny' && nS >= policy.k) { state = 'deny'; denyAt = i; }
    else if (state === 'open' && stepUp) { state = 'step-up'; stepUpAt = i; }
  }
  return { state, stepUpAt, denyAt };
}

// --- scoring -----------------------------------------------------------------
const SCORERS = {
  v1: (cur, hist) => computeTrustScore(cur, hist).trustScore,
  v2Paper: (cur, hist, recent) => computeTrustScoreV2(cur, hist, { recentFixes: recent }).trustScore,
  v2Revised: (cur, hist, recent) => computeTrustScoreRevised(cur, hist, { recentFixes: recent }).trustScore,
};
function scoreStream(fixes, from, scorer) {
  const out = [];
  for (let i = from; i < fixes.length; i++) {
    out.push(scorer(fixes[i], fixes.slice(Math.max(0, i - 10), i).reverse(), fixes.slice(Math.max(0, i - 4), i + 1)));
  }
  return out;
}

// --- mock-location splices -----------------------------------------------------
function offset(lat, lon, dx, dy) {
  return { lat: lat + dy / 111320, lon: lon + dx / (111320 * Math.cos((lat * Math.PI) / 180)) };
}
const ATTACKS = {
  'teleport (acc 0.01 m)': (last) => () => ({ lat: 25.761681, lon: -80.191788, accuracy: 0.01 }),
  'teleport (acc 5 m)': (last) => () => ({ lat: 25.761681, lon: -80.191788, accuracy: 5 }),
  ...Object.fromEntries([10, 25, 50, 100, 200, 550].map((d) => [`static mock ${d} m`, (last, rng) => {
    const a = 2 * Math.PI * rng();
    const p = offset(last.lat, last.lon, d * Math.cos(a), d * Math.sin(a));
    return () => ({ ...p, accuracy: 5 });
  }])),
  'route mock 1.4 m/s': (last, rng) => {
    const a = 2 * Math.PI * rng();
    return (dt) => ({ ...offset(last.lat, last.lon, 1.4 * dt * Math.cos(a), 1.4 * dt * Math.sin(a)), accuracy: 5 });
  },
};
/** Scores of window w, cut from the stream scored by scoreStream(fixes, 1, ...). */
const windowScores = (stream, w) => stream.slice(Math.max(w.start, 1) - 1, w.start + w.length - 1);

function splice(fixes, sw, attack, rng) {
  const last = fixes[sw - 1];
  const at = attack(last, rng);
  return fixes.map((f, i) => (i < sw ? f : { ...at((f.t - last.t) / 1000), t: f.t, timestamp: f.timestamp }));
}

// --- sessions --------------------------------------------------------------------
function windows(fixes, lengthS, minFixes) {
  const out = [];
  let start = 0;
  while (start < fixes.length) {
    let end = start;
    while (end < fixes.length && fixes[end].t - fixes[start].t < lengthS * 1000) end++;
    const w = fixes.slice(start, end);
    if (w.length >= minFixes) { w.start = start; out.push(w); }
    start = end;
  }
  return out;
}

const tally = () => ({ n: 0, stepUp: 0, deny: 0, latency: [], leaked: 0, spoofFixes: 0 });
const honest = {}, attacks = {};
const rng = makeRng('latch-splices');

let shlSessions = 0;
if (existsSync(join(shlRoot, 'SHLDataset_preview_v1'))) {
  for await (const { fixes } of loadShl(shlRoot)) {
    const streams = {};
    for (const name of ['v1', 'v2Paper', 'v2Revised']) streams[name] = scoreStream(fixes, 1, SCORERS[name]);
    for (const w of windows(fixes, SESSION_S, 540)) {
      shlSessions++;
      const sw = w.findIndex((f) => f.t - w[0].t >= SWITCH_S * 1000);
      for (const name of ['v1', 'v2Paper', 'v2Revised']) {
        const scores = windowScores(streams[name], w);
        for (const thetaP of THETA_P) {
          for (const [pName, policy] of Object.entries(POLICIES)) {
            const r = runPolicy(scores, policy, thetaP, THETA_S);
            const t = ((honest[`shl|${name}|${thetaP}`] ??= {})[pName] ??= tally());
            t.n++; if (r.state !== 'open') t.stepUp++; if (r.state === 'deny') t.deny++;
          }
        }
      }
      for (const [aName, attack] of Object.entries(ATTACKS)) {
        const spliced = splice(w, sw, attack, rng);
        for (const name of ['v2Paper', 'v2Revised']) {
          // Scores from the switch onward; earlier fixes are honest and are
          // evaluated in the honest tally above.
          const scores = scoreStream(spliced, sw, SCORERS[name]);
          for (const thetaP of THETA_P) {
            for (const [pName, policy] of Object.entries(POLICIES)) {
              const r = runPolicy(scores, policy, thetaP, THETA_S);
              const t = (((attacks[aName] ??= {})[`${name}|${thetaP}`] ??= {})[pName] ??= tally());
              t.n++;
              if (r.state !== 'open') t.stepUp++;
              if (r.state === 'deny') t.deny++;
              const first = [r.stepUpAt, r.denyAt].filter((x) => x != null);
              const at = first.length ? Math.min(...first) : scores.length;
              if (first.length) t.latency.push(at);
              t.leaked += at; t.spoofFixes += scores.length;
            }
          }
        }
      }
    }
  }
}

let denseSessions = 0;
if (existsSync(densePath)) {
  const raw = JSON.parse(readFileSync(densePath, 'utf8'));
  const fixes = raw.trace.map((p) => ({ t: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy, timestamp: new Date(p.ts).toISOString() }));
  const streams = {};
  for (const name of ['v1', 'v2Paper', 'v2Revised']) streams[name] = scoreStream(fixes, 1, SCORERS[name]);
  for (const w of windows(fixes, SESSION_S, 9)) {
    denseSessions++;
    for (const name of ['v1', 'v2Paper', 'v2Revised']) {
      const scores = windowScores(streams[name], w);
      for (const thetaP of THETA_P) {
        for (const [pName, policy] of Object.entries(POLICIES)) {
          const r = runPolicy(scores, policy, thetaP, THETA_S);
          const t = ((honest[`dense|${name}|${thetaP}`] ??= {})[pName] ??= tally());
          t.n++; if (r.state !== 'open') t.stepUp++; if (r.state === 'deny') t.deny++;
        }
      }
    }
  }
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const fmtHonest = (t) => ({ sessions: t.n, stepUpOrDeny: r4(t.stepUp / t.n), deny: r4(t.deny / t.n) });
const fmtAttack = (t) => ({
  sessions: t.n, detected: r4(t.stepUp / t.n), denied: r4(t.deny / t.n),
  medianFixesToLatch: median(t.latency), proceededSpoofFixes: r4(t.leaked / t.spoofFixes),
});
const results = {
  generated: new Date().toISOString(), sessionSeconds: SESSION_S, switchSeconds: SWITCH_S, thetaS: THETA_S,
  shlSessions, denseSessions,
  honest: Object.fromEntries(Object.entries(honest).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([p, t]) => [p, fmtHonest(t)]))])),
  attacks: Object.fromEntries(Object.entries(attacks).map(([a, v]) => [a, Object.fromEntries(Object.entries(v).map(([k, ps]) => [k, Object.fromEntries(Object.entries(ps).map(([p, t]) => [p, fmtAttack(t)]))]))])),
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'latch.json'), JSON.stringify(results, null, 2));

const pct = (x) => (x == null ? '  n/a' : `${(100 * x).toFixed(1).padStart(5)}%`);
process.stderr.write(`SHL sessions ${shlSessions}, dense sessions ${denseSessions}\n\nHONEST (step-up-or-deny / deny)\n`);
for (const [k, v] of Object.entries(results.honest)) {
  process.stderr.write(k.padEnd(24) + Object.entries(v).map(([p, t]) => `${p}: ${pct(t.stepUpOrDeny)} /${pct(t.deny)}`).join('  ') + '\n');
}
process.stderr.write('\nATTACKS, v2Revised (detected / denied / median fixes to latch / spoof fixes proceeded)\n');
for (const [a, v] of Object.entries(results.attacks)) {
  for (const thetaP of THETA_P) {
    const ps = v[`v2Revised|${thetaP}`];
    process.stderr.write(`${a.padEnd(24)} thetaP=${thetaP} ` + Object.entries(ps).map(([p, t]) => `${p}: ${pct(t.detected)}/${pct(t.denied)}/${t.medianFixesToLatch ?? '-'}/${pct(t.proceededSpoofFixes)}`).join('  ') + '\n');
  }
}
