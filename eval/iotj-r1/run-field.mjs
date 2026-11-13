// Real-device traces collected for the revision (reviewer cluster C3: R1-6,
// R1-7, R2-1, R2-6, R3-2). Up to four phones were carried together:
//
//   iPhone 16 Pro    iOS 26, Safari, the /collect page     web geolocation
//   POCO X7 Pro      Android 16, MediaTek, GnssLogger      FLP + GPS providers
//   Jelly Star       Android 13 (16 on 11-12), MediaTek    FLP + GPS providers
//   nubia Z80 Ultra  Android 16, Qualcomm, GnssLogger      FLP + GPS providers
//
// The Android fused stream (FLP) is what a browser receives; the GPS stream is
// what a native app can request; on 11-12 (evening) the POCO also ran the
// /collect page in Chrome, and chromeCheck() compares that stream with the
// phone's own FLP. Segments come from the Mark presses on the
// iPhone. A separate home session on the POCO switched a mock-location app on
// and off at several displacements; MockLocation in the log is ground truth.
//
// None of these traces was used to design S2'/S4' or to choose weights or
// thresholds. Raw data holds private coordinates and stays outside the
// repository; this script writes aggregates only (distances are relative).
//
// Usage: node eval/iotj-r1/run-field.mjs [root]   (default F:/data/field-2026-11)
// Writes results/field.json; prints a summary to stderr.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScore, computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';
import { readGnssLogger, providerStream } from './gnsslogger.mjs';
import { makeRng } from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? 'F:/data/field-2026-11';

const THETA_P = [0.7, 0.9];
const THETA_S = 0.3;
const WINDOW_S = 600;
const RADII_M = [25, 50, 100];

// Environment of each Mark-delimited segment, from the collector's notes. On
// 11-08 only "outdoor" vs "indoor" was planned; the segment labels were
// inferred from satellite counts and walking speed and then confirmed by
// the collector (2026-11-10).
const SESSIONS = [
  {
    id: '2026-11-08',
    dir: 'outdoor-2026-11-08',
    iphone: 'trace-honest-walk-iPhone-2026-11-08T04-20-34-622Z.json',
    android: ['gnss_log_2026_11_08_11_28_20.txt'],
    env: ['outdoor walk', 'indoor', 'outdoor walk', 'outdoor walk', 'outdoor walk', 'indoor', 'outdoor walk'],
  },
  {
    id: '2026-11-09',
    dir: 'outdoor-2026-11-09',
    iphone: 'trace-honest-urban-device-2026-11-09T10-09-24-830Z.json',
    android: ['gnss_log_2026_11_09_18_02_21.txt', 'gnss_log_2026_11_09_17_57_37.txt'],
    env: ['urban walk', 'surface platform', 'surface train', 'underground platform', 'underground train', 'surface platform', 'outdoor walk'],
  },
  {
    // The 11-09 route in reverse. The first segment, before the walk, was at a
    // private indoor location and is left out. The nubia Z80 Ultra also
    // logged, but it carried an aluminium bumper and tracked almost no
    // satellites for most of the route, so its log is not used. At a window
    // the same phone tracked about 40 signals without the bumper and none
    // with it (2026-11-12, two 5-8 minute logs).
    id: '2026-11-12',
    dir: 'outdoor-2026-11-12',
    iphone: 'trace-honest-urban-device-2026-11-11T23-48-27-611Z.json',
    android: ['gnss_log_2026_11_12_07_01_04.txt', 'gnss_log_2026_11_12_07_03_40.txt'],
    skipFirst: 1,
    env: ['outdoor walk', 'surface platform', 'mixed train', 'underground platform', 'surface train', 'surface platform', 'urban walk', 'indoor'],
  },
  {
    // The same route back, without the bumper. The last segment ended at a
    // private indoor location and is left out.
    id: '2026-11-12-pm',
    dir: 'outdoor-2026-11-12-pm',
    iphone: 'trace-honest-urban-iPhone16pro-2026-11-12T10-24-34-100Z.json',
    android: ['gnss_log_2026_11_12_17_55_38.txt', 'gnss_log_2026_11_12_17_56_33.txt', 'gnss_log_2026_11_12_17_55_12.txt'],
    skipLast: 1,
    env: ['indoor', 'urban walk', 'surface platform', 'surface train', 'underground platform', 'mixed train', 'surface platform', 'outdoor walk'],
    // Chrome on the POCO, started late; compared with the POCO's FLP.
    chrome: { file: 'trace-honest-urban-device-2026-11-12T10-24-36-654Z.json', log: 'gnss_log_2026_11_12_17_56_33.txt', device: 'POCO X7 Pro' },
  },
];
// Coarser classes used in the manuscript table.
const ENV_CLASS = {
  'outdoor walk': 'outdoor', 'urban walk': 'outdoor', 'surface platform': 'outdoor',
  indoor: 'indoor', 'surface train': 'surface train',
  'underground platform': 'underground', 'underground train': 'underground',
  // A line that runs partly underground; counted only in the totals.
  'mixed train': 'mixed train',
};

const SCORERS = {
  V1: (cur, hist) => computeTrustScore(cur, hist),
  V2: (cur, hist, recent) => computeTrustScoreV2(cur, hist, { recentFixes: recent }),
  'V2r': (cur, hist, recent, hint) => computeTrustScoreRevised(cur, hist, { recentFixes: recent, networkHint: hint }),
};

const R = 6371008.8, RAD = Math.PI / 180;
const dist = (a, b) => Math.hypot((b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD), (b.lat - a.lat) * RAD) * R;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : null; };
const pct = (k, n) => (n ? Math.round((k / n) * 1e4) / 100 : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** Score a stream fix by fix (history newest first, last five fixes for S4). */
function scoreStream(points, hintAt = () => undefined) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    const hist = points.slice(Math.max(0, i - 10), i).reverse();
    const recent = points.slice(Math.max(0, i - 4), i + 1);
    const row = { t: cur.t, accuracy: cur.accuracy, mock: cur.mock };
    for (const [name, f] of Object.entries(SCORERS)) row[name] = f(cur, hist, recent).trustScore;
    const rev = computeTrustScoreRevised(cur, hist, { recentFixes: recent });
    row.signals = rev.signals;
    const hint = hintAt(cur.t);
    if (hint) row['V2r+S5'] = SCORERS.V2r(cur, hist, recent, hint).trustScore;
    out.push(row);
  }
  return out;
}

function loadIphone(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const points = [];
  for (const f of j.fixes) {
    const t = Date.parse(f.timestamp);
    if (points.length && t <= points.at(-1).t) continue;
    points.push({ lat: f.lat, lon: f.lon, accuracy: f.accuracy, t, timestamp: new Date(t).toISOString() });
  }
  return { points, marks: j.markers.map((m) => Date.parse(m.timestamp)) };
}

// ---------- honest sessions ----------

const streams = []; // {session, stream, device, scored, bounds, env}
const meta = [];
const chrome = [];

/**
 * Chrome's geolocation stream against the same phone's FLP, inside the session
 * bounds. A Chrome fix matches when an FLP fix has the same time (within
 * 50 ms), position (within 1 cm) and accuracy (within 5 cm).
 */
function chromeCheck(s, bounds) {
  const web = loadIphone(join(root, s.dir, s.chrome.file)).points;
  const a = Math.max(bounds[0], web[0].t), b = Math.min(bounds.at(-1), web.at(-1).t);
  const cw = web.filter((p) => p.t >= a && p.t <= b);
  const flp = providerStream(readGnssLogger(join(root, s.dir, s.chrome.log)).fixes, 'FLP').points.filter((p) => p.t >= a && p.t <= b);
  let k = 0, matched = 0;
  for (const c of cw) {
    while (k < flp.length && flp[k].t < c.t - 50) k++;
    for (let j = k; j < flp.length && flp[j].t <= c.t + 50; j++) {
      if (dist(c, flp[j]) <= 0.01 && Math.abs(c.accuracy - flp[j].accuracy) <= 0.05) { matched++; break; }
    }
  }
  const gaps = (pts) => {
    let n = 0, ms = 0;
    for (let i = 1; i < pts.length; i++) { const d = pts[i].t - pts[i - 1].t; if (d > 30_000) { n++; ms += d; } }
    return { count: n, minutes: r2(ms / 60000) };
  };
  const tail = (pts) => {
    const xs = scoreStream(pts).map((r) => r.V2r);
    return { below09: pct(xs.filter((x) => x < 0.9).length, xs.length), below07: pct(xs.filter((x) => x < 0.7).length, xs.length) };
  };
  return {
    session: s.id, device: s.chrome.device, minutes: r2((b - a) / 60000),
    chromeFixes: cw.length, flpFixes: flp.length, matched: pct(matched, cw.length), unmatched: cw.length - matched,
    gaps: { chrome: gaps(cw), flp: gaps(flp) }, V2r: { chrome: tail(cw), flp: tail(flp) },
  };
}
for (const s of SESSIONS) {
  const iphone = loadIphone(join(root, s.dir, s.iphone));
  const all = [iphone.points[0].t, ...iphone.marks, iphone.points.at(-1).t];
  const bounds = all.slice(s.skipFirst ?? 0, all.length - (s.skipLast ?? 0));
  if (bounds.length - 1 !== s.env.length) throw new Error(`${s.id}: ${bounds.length - 1} segments, ${s.env.length} labels`);
  const add = (stream, device, points, dropped = 0) => {
    const inside = points.filter((p) => p.t >= bounds[0] && p.t <= bounds.at(-1));
    const below1m = pct(inside.filter((p) => p.accuracy < 1).length, inside.length);
    streams.push({ session: s.id, stream, device, bounds, env: s.env, scored: scoreStream(inside), n: inside.length, dropped, below1m });
  };
  add('web (iPhone)', 'iPhone 16 Pro', iphone.points);
  for (const file of s.android) {
    const log = readGnssLogger(join(root, s.dir, file));
    if (log.fixes.some((f) => f.mock)) throw new Error(`${file}: mock fixes in an honest session`);
    const name = { '2412DPC0AG': 'POCO X7 Pro', NX741J: 'nubia Z80 Ultra' }[log.device] ?? log.device;
    for (const provider of ['FLP', 'GPS']) {
      const { points, dropped } = providerStream(log.fixes, provider);
      add(provider === 'FLP' ? 'web-equivalent (Android FLP)' : 'native (Android GPS)', name, points, dropped);
    }
  }
  if (s.chrome) chrome.push(chromeCheck(s, bounds));
  meta.push({ id: s.id, minutes: r2((bounds.at(-1) - bounds[0]) / 60000), segments: s.env.map((env, i) => ({ env, minutes: r2((bounds[i + 1] - bounds[i]) / 60000) })) });
}

const envOf = (st, t) => {
  for (let i = 0; i + 1 < st.bounds.length; i++) if (t >= st.bounds[i] && t < st.bounds[i + 1]) return st.env[i];
  return st.env.at(-1);
};

// Fix-level tails per stream type x environment class.
const byEnv = {};
const bucket = (stream, env) => ((byEnv[stream] ??= {})[env] ??= { rows: [], minutes: 0, noFixMinutes: 0 });
for (const st of streams) {
  for (const row of st.scored) {
    const env = envOf(st, row.t);
    bucket(st.stream, ENV_CLASS[env]).rows.push(row);
    bucket(st.stream, 'all').rows.push(row);
  }
  // Time without any fix (gaps > 30 s), per environment.
  for (let i = 0; i + 1 < st.bounds.length; i++) {
    const [a, b] = [st.bounds[i], st.bounds[i + 1]];
    const ts = [a, ...st.scored.filter((r) => r.t >= a && r.t < b).map((r) => r.t), b];
    let gap = 0;
    for (let k = 1; k < ts.length; k++) if (ts[k] - ts[k - 1] > 30_000) gap += ts[k] - ts[k - 1];
    for (const key of [ENV_CLASS[st.env[i]], 'all']) {
      const bk = bucket(st.stream, key);
      bk.minutes += (b - a) / 60000;
      bk.noFixMinutes += gap / 60000;
    }
  }
}

function tailStats(rows) {
  const out = { fixes: rows.length };
  for (const name of [...Object.keys(SCORERS)]) {
    const xs = rows.map((r) => r[name]);
    out[name] = { below07: pct(xs.filter((x) => x < 0.7).length, xs.length), below09: pct(xs.filter((x) => x < 0.9).length, xs.length), min: xs.length ? Math.min(...xs) : null };
  }
  const acc = rows.map((r) => r.accuracy);
  out.accuracy = { p50: r2(quantile(acc, 0.5)), p95: r2(quantile(acc, 0.95)) };
  // Probability that a fix is too coarse for an R-metre proximity proof.
  out.accuracyAbove = Object.fromEntries(RADII_M.map((rad) => [rad, pct(acc.filter((a) => a > rad).length, acc.length)]));
  // Which V2r signals are below 1 when V2r < 0.9.
  const low = rows.filter((r) => r.V2r < 0.9);
  const causes = {};
  for (const r of low) for (const [k, v] of Object.entries(r.signals)) if (v < 1) causes[k] = (causes[k] ?? 0) + 1;
  out.V2rLowCauses = Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, pct(v, low.length)]));
  return out;
}

const fixTails = {};
// Score histograms (scores are rounded to 0.01, so 101 integer bins are exact)
// for run-tradeoff.mjs.
const histograms = {};
for (const [stream, envs] of Object.entries(byEnv)) {
  fixTails[stream] = {};
  for (const [env, b] of Object.entries(envs)) {
    fixTails[stream][env] = { ...tailStats(b.rows), minutes: r2(b.minutes), noFixMinutes: r2(b.noFixMinutes) };
  }
  histograms[stream] = {};
  for (const name of ['V2', 'V2r']) {
    const h = new Array(101).fill(0);
    for (const r of envs.all.rows) h[Math.round(r[name] * 100)]++;
    histograms[stream][name] = h;
  }
}

// Session level: complete 10-minute windows from the start of each session;
// the shorter remainder at the end of a session is counted but not scored.
function windowOutcomes(rows, score, thetaP) {
  let stepUp = false, denyFirst = false, denyK = false, firstSeen = false;
  const lastS = [];
  for (const r of rows) {
    const x = r[score];
    if (!firstSeen && x < thetaP) { firstSeen = true; stepUp = true; denyFirst = x < THETA_S; }
    lastS.push(x < THETA_S);
    if (lastS.length > 5) lastS.shift();
    if (lastS.filter(Boolean).length >= 3) denyK = true;
  }
  return { stepUp, denyFirst, denyK };
}
const windows = {};
for (const st of streams) {
  for (const key of [st.stream, `${st.stream} | ${st.session}`]) {
    const w = (windows[key] ??= { windows: 0, partial: 0 });
    for (let a = st.bounds[0]; a < st.bounds.at(-1); a += WINDOW_S * 1000) {
      if (a + WINDOW_S * 1000 > st.bounds.at(-1)) { w.partial++; continue; }
      const rows = st.scored.filter((r) => r.t >= a && r.t < a + WINDOW_S * 1000);
      if (!rows.length) continue;
      w.windows++;
      for (const score of ['V1', 'V2', 'V2r']) for (const thetaP of THETA_P) {
        const o = windowOutcomes(rows, score, thetaP);
        const k2 = `${score}@${thetaP}`;
        const acc = (w[k2] ??= { stepUp: 0, denyFirst: 0, denyK: 0 });
        for (const k of Object.keys(acc)) acc[k] += o[k] ? 1 : 0;
      }
    }
  }
}
for (const w of Object.values(windows)) {
  for (const [k, v] of Object.entries(w)) if (k !== 'windows' && k !== 'partial') for (const kk of Object.keys(v)) v[kk] = pct(v[kk], w.windows);
}

// ---------- home mock session (POCO) ----------

// Seconds from the first fix during which the mock point slipped and the
// stage was redone (see notes.txt in the data folder); excluded.
const MOCK_EXCLUDE_S = [1388, 1426];
const DETECT_S = 10;

function mockHome() {
  const log = readGnssLogger(join(root, 'mock-home', 'gnss_log_2026_11_08_10_42_01.txt'));
  const t0 = log.fixes[0].t;
  const nlp = providerStream(log.fixes, 'NLP').points;
  if (nlp.some((p) => p.mock)) throw new Error('NLP fixes flagged as mock');
  // Most recent network fix no older than 30 s (S5 hint; NLP is never mocked here).
  const hintAt = (t) => {
    let h;
    for (const p of nlp) { if (p.t > t) break; h = p; }
    return h && t - h.t <= 30_000 ? { lat: h.lat, lon: h.lon, accuracy: h.accuracy, source: 'wifi' } : undefined;
  };
  const excluded = (t) => (t - t0) / 1000 >= MOCK_EXCLUDE_S[0] && (t - t0) / 1000 < MOCK_EXCLUDE_S[1];
  const result = { device: 'POCO X7 Pro', providerFlags: {}, streams: {} };
  for (const f of log.fixes) result.providerFlags[`${f.provider}/${f.mock ? 'mock' : 'real'}`] = (result.providerFlags[`${f.provider}/${f.mock ? 'mock' : 'real'}`] ?? 0) + 1;
  for (const provider of ['FLP', 'GPS']) {
    const { points } = providerStream(log.fixes, provider);
    const scored = scoreStream(points, hintAt);
    const runs = [];
    for (let i = 0; i < points.length; i++) {
      if (!points[i].mock) continue;
      if (i > 0 && points[i - 1].mock) runs.at(-1).end = i;
      else runs.push({ start: i, end: i });
    }
    const stages = [];
    for (const run of runs) {
      const ts = points[run.start].t, te = points[run.end].t;
      if (excluded(ts) || excluded(te)) continue;
      const before = points.filter((p) => !p.mock && p.t >= ts - 60_000 && p.t < ts);
      const mockPts = points.slice(run.start, run.end + 1);
      const ref = { lat: median(before.map((p) => p.lat)), lon: median(before.map((p) => p.lon)) };
      const pos = { lat: median(mockPts.map((p) => p.lat)), lon: median(mockPts.map((p) => p.lon)) };
      const rows = scored.filter((r) => r.t >= ts && r.t <= te);
      const early = rows.filter((r) => r.t < ts + DETECT_S * 1000);
      const steady = rows.filter((r) => r.t >= ts + DETECT_S * 1000);
      const stage = {
        startS: Math.round((ts - t0) / 1000), seconds: Math.round((te - ts) / 1000),
        displacementM: Math.round(dist(ref, pos)), mockAccuracyM: median(mockPts.map((p) => p.accuracy)),
      };
      for (const name of ['V1', 'V2', 'V2r', 'V2r+S5']) {
        const e = early.map((r) => r[name]).filter((x) => x != null);
        const s = steady.map((r) => r[name]).filter((x) => x != null);
        stage[name] = {
          switchScore: rows[0]?.[name] ?? null,
          minFirst10s: e.length ? Math.min(...e) : null,
          steadyMedian: median(s),
          steadyBelow07: pct(s.filter((x) => x < 0.7).length, s.length),
          steadyBelow09: pct(s.filter((x) => x < 0.9).length, s.length),
          hintCoverage: name === 'V2r+S5' ? pct(s.length, steady.length) : undefined,
        };
      }
      stages.push(stage);
    }
    // Honest fixes at home, away from switches (60 s after a stop, 10 s before a start).
    const nearSwitch = (t) => runs.some((run) => t >= points[run.start].t - 10_000 && t <= points[run.end].t + 60_000);
    const honest = scored.filter((r) => !r.mock && !excluded(r.t) && !nearSwitch(r.t));
    const honestStats = { fixes: honest.length };
    for (const name of ['V1', 'V2', 'V2r', 'V2r+S5']) {
      const xs = honest.map((r) => r[name]).filter((x) => x != null);
      honestStats[name] = { n: xs.length, below07: pct(xs.filter((x) => x < 0.7).length, xs.length), below09: pct(xs.filter((x) => x < 0.9).length, xs.length) };
    }
    result.streams[provider] = { stages, honest: honestStats };
  }
  return result;
}

const mock = mockHome();

// ---------- binary threshold under resampling ----------
// At delta = 0.1% the binary threshold rests on the lowest few honest scores,
// and low scores cluster in time (underground, trains). Resample whole
// 10-minute blocks of each stream type with replacement and recompute the
// largest theta with F_L(theta) <= delta (same 0.01 grid as run-tradeoff.mjs).
const BOOT_DELTAS = [0.001, 0.01];
const BOOT_N = 2000;
const thetaWithin = (h, n, budget) => {
  let below = 0, t = 0;
  for (let k = 0; k <= 100; k++) { if (below / n <= budget) t = k / 100; below += h[k]; }
  return t;
};
const binaryBootstrap = {};
const bootRng = makeRng('field-binary-bootstrap');
for (const type of Object.keys(byEnv)) {
  const blocks = [];
  for (const st of streams.filter((x) => x.stream === type)) {
    for (let a = st.bounds[0]; a < st.bounds.at(-1); a += WINDOW_S * 1000) {
      const h = new Array(101).fill(0);
      let n = 0;
      for (const r of st.scored) if (r.t >= a && r.t < a + WINDOW_S * 1000) { h[Math.round(r.V2r * 100)]++; n++; }
      if (n) blocks.push({ h, n });
    }
  }
  const draws = Object.fromEntries(BOOT_DELTAS.map((d) => [d, []]));
  for (let b = 0; b < BOOT_N; b++) {
    const h = new Array(101).fill(0);
    let n = 0;
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[Math.floor(bootRng() * blocks.length)];
      for (let k = 0; k <= 100; k++) h[k] += blk.h[k];
      n += blk.n;
    }
    for (const d of BOOT_DELTAS) draws[d].push(thetaWithin(h, n, d));
  }
  binaryBootstrap[type] = {
    blocks: blocks.length, resamples: BOOT_N,
    theta: Object.fromEntries(BOOT_DELTAS.map((d) => [d, { p2_5: quantile(draws[d], 0.025), p50: quantile(draws[d], 0.5), p97_5: quantile(draws[d], 0.975) }])),
  };
}

const out = {
  generated: new Date().toISOString(),
  note: 'Aggregates only. Raw traces stay outside the repository. V2r = V2 with S2 (1 m cutoff) and S4 (15 s window, detrended) revised.',
  thetaP: THETA_P, thetaS: THETA_S, windowS: WINDOW_S,
  sessions: meta,
  streams: streams.map((s) => ({ session: s.session, stream: s.stream, device: s.device, fixes: s.n, scoredFixes: s.scored.length, droppedDuplicateTimestamps: s.dropped, accuracyBelow1m: s.below1m })),
  fixTails, windows, histograms, binaryBootstrap, chrome, mock,
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'field.json'), JSON.stringify(out, null, 2));

// ---------- summary ----------
const log = (...a) => console.error(...a);
for (const [stream, envs] of Object.entries(fixTails)) {
  log(`\n${stream}`);
  for (const [env, s] of Object.entries(envs)) {
    log(`  ${env.padEnd(14)} ${String(s.minutes).padStart(6)} min (no fix ${s.noFixMinutes}) n=${s.fixes} acc p50/p95 ${s.accuracy.p50}/${s.accuracy.p95}` +
      ` | <0.9 V1 ${s.V1.below09}% V2 ${s.V2.below09}% V2r ${s.V2r.below09}% | <0.7 V1 ${s.V1.below07}% V2 ${s.V2.below07}% V2r ${s.V2r.below07}% | acc>50m ${s.accuracyAbove[50]}%`);
  }
}
log('\ncomplete 10-minute windows (step-up / deny-first / deny-3of5, %)');
for (const [stream, w] of Object.entries(windows)) {
  log(`  ${stream} (${w.windows}, ${w.partial} partial)  ` + ['V2@0.7', 'V2@0.9', 'V2r@0.7', 'V2r@0.9'].map((k) => `${k} ${w[k].stepUp}/${w[k].denyFirst}/${w[k].denyK}`).join('  '));
}
for (const c of chrome) {
  log(`\nChrome vs FLP (${c.device}, ${c.session}): ${c.minutes} min, ${c.chromeFixes} Chrome / ${c.flpFixes} FLP fixes, matched ${c.matched}%,` +
    ` gaps ${JSON.stringify(c.gaps)}, V2r ${JSON.stringify(c.V2r)}`);
}
for (const [type, b] of Object.entries(binaryBootstrap)) log(`binary theta, block bootstrap (${type}, ${b.blocks} blocks): ${JSON.stringify(b.theta)}`);
log('\naccuracy < 1 m (%):', streams.map((s) => `${s.session} ${s.device} ${s.stream.split(' ')[0]} ${s.below1m}`).join('; '));
log('\nhome mock (POCO)', JSON.stringify(mock.providerFlags));
for (const [provider, s] of Object.entries(mock.streams)) {
  log(`  ${provider}: honest <0.9 V2 ${s.honest.V2.below09}% V2r ${s.honest.V2r.below09}% V2r+S5 ${s.honest['V2r+S5'].below09}% (n=${s.honest['V2r+S5'].n})`);
  for (const st of s.stages) {
    log(`    t=${st.startS}s ${st.seconds}s d=${st.displacementM} m acc=${st.mockAccuracyM} | switch V2 ${st.V2.switchScore} V2r ${st.V2r.switchScore} min10s V2r ${st.V2r.minFirst10s} | steady V2r ${st.V2r.steadyMedian} V2r+S5 ${st['V2r+S5'].steadyMedian} (<0.7 ${st['V2r+S5'].steadyBelow07}%, hint ${st['V2r+S5'].hintCoverage}%)`);
  }
}
