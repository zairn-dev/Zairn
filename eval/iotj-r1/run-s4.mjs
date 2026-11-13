// Submitted S4 vs the revised S4' (revised-scorer.mjs).
//
// 1. Synthetic dev/test as generated: detection metrics with both scorers.
// 2. Kinematic stress test: the generator places the five recent fixes around
//    the current point even for driving and trains. Here the legitimate
//    traces get 1 Hz fixes that follow the motion implied by current and
//    history[0], with 3 m Gaussian jitter, as a moving phone would report.
// 3. Optional: the dense trace (60 s cadence), aggregates only.
//
// Usage: node eval/iotj-r1/run-s4.mjs [path/to/dense-trace.json]
// Writes results/s4.json; prints a summary to stderr.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrustScoreV2 } from './paper-scorer.mjs';
import { computeTrustScoreRevised } from './revised-scorer.mjs';
import { syntheticSplit, scoreV2, toItems } from './data.mjs';
import { aucRoc, averagePrecision, eer, atThreshold, gradedGate, makeRng } from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

const scoreRevised = (t) =>
  computeTrustScoreRevised(t.current, t.history, { recentFixes: t.recentFixes, networkHint: t.networkHint });

function summary(items) {
  const at = (th) => { const a = atThreshold(items, th); return { far: r4(a.far), fdr: r4(a.fdr) }; };
  const g = gradedGate(items, 0.9, 0.3);
  return {
    aucRoc: r4(aucRoc(items)), ap: r4(averagePrecision(items)), eer: r4(eer(items)),
    binary07: at(0.7), binary09: at(0.9),
    graduated09Oracle: { far: r4(g.far), fdr: r4(g.fdr), mL: r4(g.mL), mS: r4(g.mS) },
  };
}

// --- 2. kinematic recent fixes -------------------------------------------
function gaussian(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function kinematicFixes(t, rng) {
  const cur = t.current, prev = t.history[0];
  const dt = (Date.parse(cur.timestamp) - Date.parse(prev.timestamp)) / 1000;
  const kLon = 111320 * Math.cos((cur.lat * Math.PI) / 180);
  const vx = dt > 0 ? ((cur.lon - prev.lon) * kLon) / dt : 0;
  const vy = dt > 0 ? ((cur.lat - prev.lat) * 111320) / dt : 0;
  return t.recentFixes.map((f, i) => {
    const x = -vx * i + gaussian(rng) * 3, y = -vy * i + gaussian(rng) * 3;
    return {
      lat: cur.lat + y / 111320, lon: cur.lon + x / kLon, accuracy: f.accuracy,
      timestamp: new Date(Date.parse(cur.timestamp) - i * 1000).toISOString(),
    };
  });
}

function evaluateSplit(name) {
  const traces = syntheticSplit(name);
  const paper = toItems(traces, scoreV2);
  const revised = toItems(traces, scoreRevised);
  const changed = paper.filter((p, i) => p.score !== revised[i].score).length;

  const rng = makeRng(`${name}-kinematic`);
  const moved = traces.map((t) => (t.label === 'legitimate' ? { ...t, recentFixes: kinematicFixes(t, rng) } : t));
  const perScenario = {};
  for (const t of moved.filter((x) => x.label === 'legitimate')) {
    const s = (perScenario[t.scenario] ??= { n: 0, s4Paper: 0, s4Revised: 0, belowP09Paper: 0, belowP09Revised: 0 });
    const p = computeTrustScoreV2(t.current, t.history, { recentFixes: t.recentFixes, networkHint: t.networkHint });
    const r = scoreRevised(t);
    s.n++;
    s.s4Paper += p.signals.fixConsistency;
    s.s4Revised += r.signals.fixConsistency ?? 1;
    if (p.trustScore < 0.9) s.belowP09Paper++;
    if (r.trustScore < 0.9) s.belowP09Revised++;
  }
  for (const s of Object.values(perScenario)) {
    for (const k of ['s4Paper', 's4Revised']) s[k] = r4(s[k] / s.n);
    for (const k of ['belowP09Paper', 'belowP09Revised']) s[k] = r4(s[k] / s.n);
  }

  return {
    split: name,
    asGenerated: { paper: summary(paper), revised: summary(revised), scoresChanged: changed },
    kinematic: {
      paper: summary(toItems(moved, scoreV2)),
      revised: summary(toItems(moved, scoreRevised)),
      legitimateByScenario: perScenario,
    },
  };
}

// --- 3. dense trace --------------------------------------------------------
function denseTrace(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const fixes = raw.trace.map((p) => ({ lat: p.lat, lon: p.lon, accuracy: p.accuracy, timestamp: new Date(p.ts).toISOString() }));
  const out = { paper: [], revised: [] };
  for (let i = 1; i < fixes.length; i++) {
    const history = fixes.slice(Math.max(0, i - 10), i).reverse();
    const recentFixes = fixes.slice(Math.max(0, i - 4), i + 1);
    out.paper.push(computeTrustScoreV2(fixes[i], history, { recentFixes }).trustScore);
    out.revised.push(computeTrustScoreRevised(fixes[i], history, { recentFixes }).trustScore);
  }
  const share = (xs, th) => r4(xs.filter((x) => x < th).length / xs.length);
  return Object.fromEntries(Object.entries(out).map(([k, xs]) => [k, { n: xs.length, below07: share(xs, 0.7), below09: share(xs, 0.9) }]));
}

const results = { generated: new Date().toISOString(), splits: {} };
for (const name of ['dev', 'test']) {
  process.stderr.write(`[${name}]\n`);
  results.splits[name] = evaluateSplit(name);
}
const densePath = resolve(process.argv[2] ?? join(here, '../../../openZenly/eval/dense-trace/raw-2026-04-26.json'));
if (existsSync(densePath)) results.denseTrace = denseTrace(densePath);

mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 's4.json'), JSON.stringify(results, null, 2));
process.stderr.write(JSON.stringify(results, null, 2) + '\n');
