// Legitimate-side scores on the SHL Preview dataset (Sussex-Huawei
// Locomotion; Huawei Mate 9 phones at four body positions, ~1 Hz satellite
// fixes, transport-mode labels). Positive class does not occur: every fix is
// honest, so the outputs are false-alarm rates by transport mode.
//
// The dataset is distributed for non-profit research use only and is not in
// this repository. Only aggregates are written.
//
// Usage: node eval/iotj-r1/run-shl.mjs [root]   (see shl.mjs for the layout)
// Writes results/shl.json; prints a summary to stderr.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScore, computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';
import { loadShl, modeAt, SHL_DEFAULT_ROOT } from './shl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? SHL_DEFAULT_ROOT;
const SESSION_MIN = 10;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

const SCORERS = {
  v1: (cur, hist) => computeTrustScore(cur, hist).trustScore,
  v2Paper: (cur, hist, recentFixes) => computeTrustScoreV2(cur, hist, { recentFixes }).trustScore,
  v2Revised: (cur, hist, recentFixes) => computeTrustScoreRevised(cur, hist, { recentFixes }).trustScore,
};

const byUser = {};      // user -> scorer -> { n, below07, below09 }
const byMode = {};      // mode -> scorer -> { n, below07, below09, sum }
const sessions = {};    // scorer -> { windows, latched07, latched09 }
let fixCount = 0, accBelow2 = 0;
const traces = [];

for await (const { user, day, position, fixes, labels } of loadShl(root)) {
  traces.push({ user, day, position, fixes: fixes.length });
  const windows = {};
  for (let i = 1; i < fixes.length; i++) {
    const cur = fixes[i];
    const hist = fixes.slice(Math.max(0, i - 10), i).reverse();
    const recentFixes = fixes.slice(Math.max(0, i - 4), i + 1);
    const mode = modeAt(labels, cur.t);
    fixCount++;
    if (cur.accuracy < 2) accBelow2++;
    const w = Math.floor(cur.t / (SESSION_MIN * 60_000));
    for (const [name, score] of Object.entries(SCORERS)) {
      const s = score(cur, hist, recentFixes);
      const m = ((byMode[mode] ??= {})[name] ??= { n: 0, below07: 0, below09: 0, sum: 0 });
      m.n++; m.sum += s;
      if (s < 0.7) m.below07++;
      if (s < 0.9) m.below09++;
      const u = ((byUser[user] ??= {})[name] ??= { n: 0, below07: 0, below09: 0 });
      u.n++;
      if (s < 0.7) u.below07++;
      if (s < 0.9) u.below09++;
      const k = `${name}|${w}`;
      windows[k] = Math.min(windows[k] ?? Infinity, s);
    }
  }
  for (const [k, min] of Object.entries(windows)) {
    const name = k.split('|')[0];
    const s = (sessions[name] ??= { windows: 0, latched07: 0, latched09: 0 });
    s.windows++;
    if (min < 0.7) s.latched07++;
    if (min < 0.9) s.latched09++;
  }
}

const modes = {};
for (const [mode, scorers] of Object.entries(byMode)) {
  modes[mode] = Object.fromEntries(Object.entries(scorers).map(([name, m]) => [name, {
    n: m.n, mean: r4(m.sum / m.n), below07: r4(m.below07 / m.n), below09: r4(m.below09 / m.n),
  }]));
}
const all = Object.fromEntries(Object.keys(SCORERS).map((name) => {
  let n = 0, b07 = 0, b09 = 0;
  for (const m of Object.values(byMode)) { const x = m[name]; n += x.n; b07 += x.below07; b09 += x.below09; }
  return [name, { n, below07: r4(b07 / n), below09: r4(b09 / n) }];
}));
const users = Object.fromEntries(Object.entries(byUser).map(([user, scorers]) => [user, Object.fromEntries(
  Object.entries(scorers).map(([name, u]) => [name, { n: u.n, below07: r4(u.below07 / u.n), below09: r4(u.below09 / u.n) }]))]));
const latch = Object.fromEntries(Object.entries(sessions).map(([name, s]) => [name, {
  windows: s.windows, latched07: r4(s.latched07 / s.windows), latched09: r4(s.latched09 / s.windows),
}]));

const results = {
  generated: new Date().toISOString(), dataset: 'SHL Preview v1', sessionMinutes: SESSION_MIN,
  traces, fixes: fixCount, accuracyBelow2m: r4(accBelow2 / fixCount), all, byUser: users, byMode: modes, latch,
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'shl.json'), JSON.stringify(results, null, 2));
process.stderr.write(JSON.stringify({ fixes: fixCount, accuracyBelow2m: results.accuracyBelow2m, all, byUser: users, latch }, null, 2) + '\n');
for (const [mode, s] of Object.entries(modes)) {
  process.stderr.write(`${mode.padEnd(7)} n=${String(s.v1.n).padStart(6)} | <0.9: V1 ${(100 * s.v1.below09).toFixed(2)}%  V2 ${(100 * s.v2Paper.below09).toFixed(2)}%  V2-rev ${(100 * s.v2Revised.below09).toFixed(2)}%`
    + ` | <0.7: V1 ${(100 * s.v1.below07).toFixed(2)}%  V2 ${(100 * s.v2Paper.below07).toFixed(2)}%  V2-rev ${(100 * s.v2Revised.below07).toFixed(2)}%\n`);
}
