// Export the synthetic dev/val/test traces and the JS scores for the C
// equivalence test (ts_driver verify) and the C benchmark (ts_driver bench).
//
// One line per trace, space-separated; doubles are written as the 16 hex
// digits of their IEEE-754 bit pattern so the C side reads them exactly,
// timestamps as Date.parse() epoch milliseconds, absent values as "-":
//
//   split scenario label
//   cur.lat cur.lon cur.acc cur.t
//   nHist  (lat lon acc t) x nHist          newest first
//   nFix   (lat lon acc t) x nFix           recentFixes as given
//   hasNet [lat lon acc]
//   S1 S2 S2' S3 S4 S4' S5                  JS signal values
//   (score mask) x 10                       JS trustScore + signal bitmask
//
// Configurations (all on the same trace):
//   0 V1                       computeTrustScore
//   1-4 V2  both|fixes|net|none computeTrustScoreV2 with that context
//   5-8 V2' both|fixes|net|none computeTrustScoreRevised with that context
//   9 V2' both, accCutoff = 2
//
// Usage: node eval/iotj-r1/c-scorer/export-inputs.mjs [outDir]
// Writes <outDir>/inputs-{dev,val,test}.txt (default outDir: c-scorer/build).

import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSplit } from '../data.mjs';
import { computeTrustScore, computeTrustScoreV2 } from '../paper-scorer.mjs';
import { computeTrustScoreRevised } from '../revised-scorer.mjs';
import { ALL_SCENARIOS } from '../../../packages/geo-drop/test/generate-synthetic-traces.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, 'build'));
mkdirSync(outDir, { recursive: true });

const dv = new DataView(new ArrayBuffer(8));
function hx(x) {
  if (x === undefined) return '-';
  dv.setFloat64(0, x === null ? NaN : x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
}
const ms = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isInteger(t)) throw new Error(`bad timestamp ${iso}`);
  return String(t);
};
const pt = (p) => `${hx(p.lat)} ${hx(p.lon)} ${hx(p.accuracy)} ${ms(p.timestamp)}`;

const SIG_BITS = {
  movementPlausibility: 1, accuracyAnomaly: 2, temporalConsistency: 4,
  fixConsistency: 8, networkConsistency: 16,
};
const mask = (signals) => Object.keys(signals).reduce((m, k) => m | SIG_BITS[k], 0);

const ctx = {
  both: (t) => ({ recentFixes: t.recentFixes, networkHint: t.networkHint }),
  fixes: (t) => ({ recentFixes: t.recentFixes }),
  net: (t) => ({ networkHint: t.networkHint }),
  none: () => ({}),
};
const CONFIGS = [
  ['V1', (t) => computeTrustScore(t.current, t.history)],
  ...['both', 'fixes', 'net', 'none'].map((k) => [`V2/${k}`, (t) => computeTrustScoreV2(t.current, t.history, ctx[k](t))]),
  ...['both', 'fixes', 'net', 'none'].map((k) => [`V2r/${k}`, (t) => computeTrustScoreRevised(t.current, t.history, ctx[k](t))]),
  ['V2r/both/cut2', (t) => computeTrustScoreRevised(t.current, t.history, { ...ctx.both(t), accCutoff: 2 })],
];

for (const split of ['dev', 'val', 'test']) {
  const traces = syntheticSplit(split);
  const file = join(outDir, `inputs-${split}.txt`);
  const out = createWriteStream(file);
  out.write(`# split=${split} n=${traces.length} scenarios=${ALL_SCENARIOS.join(',')} configs=${CONFIGS.map((c) => c[0]).join(',')}\n`);
  const splitId = { dev: 0, val: 1, test: 2 }[split];
  let lines = 0;
  for (const t of traces) {
    const res = CONFIGS.map(([, f]) => f(t));
    const [v1, v2both] = res;
    const v2rBoth = res[5];
    const sig = {
      m: v1.signals.movementPlausibility,
      a2: v1.signals.accuracyAnomaly,
      a1: v2rBoth.signals.accuracyAnomaly,
      t: v1.signals.temporalConsistency,
      f: v2both.signals.fixConsistency,
      fr: v2rBoth.signals.fixConsistency,
      n: v2both.signals.networkConsistency,
    };
    // Every configuration must reuse these signal values (checked here so the
    // C side can compare signals per configuration against one set).
    res.forEach((r, i) => {
      const s = r.signals;
      const revised = i >= 5;
      const expA = revised && i !== 9 ? sig.a1 : sig.a2;
      const expF = revised ? sig.fr : sig.f;
      if (s.movementPlausibility !== sig.m || s.temporalConsistency !== sig.t || s.accuracyAnomaly !== expA ||
          (s.fixConsistency !== undefined && s.fixConsistency !== expF) ||
          (s.networkConsistency !== undefined && s.networkConsistency !== sig.n)) {
        throw new Error(`signal reuse assumption broken: ${CONFIGS[i][0]} ${t.scenario}`);
      }
    });
    const fixes = t.recentFixes ?? [];
    const fields = [
      splitId, ALL_SCENARIOS.indexOf(t.scenario), t.label === 'spoofed' ? 1 : 0,
      pt(t.current),
      t.history.length, ...t.history.map(pt),
      fixes.length, ...fixes.map(pt),
      t.networkHint ? `1 ${hx(t.networkHint.lat)} ${hx(t.networkHint.lon)} ${hx(t.networkHint.accuracy)}` : '0',
      hx(sig.m), hx(sig.a2), hx(sig.a1), hx(sig.t), hx(sig.f), hx(sig.fr), hx(sig.n),
      ...res.map((r) => `${hx(r.trustScore)} ${mask(r.signals)}`),
    ];
    out.write(fields.join(' ') + '\n');
    lines++;
  }
  await new Promise((ok) => out.end(ok));
  process.stderr.write(`${split}: ${lines} traces -> ${file}\n`);
}
