// Merge the per-split ESP32-S3 results (build/esp32s3/result-<split>.json,
// written by run.py) into results/c-scorer-esp32s3.json.
//
// Equivalence is summed over the three splits. Latency is reported for the
// dev split, as on the desktop: per pass the median / p99 / mean over the
// 10,000 traces, then the median of the three passes.
//
// Usage: node eval/iotj-r1/c-scorer/esp32s3/make-report.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPLITS = ['dev', 'val', 'test'];
const runs = Object.fromEntries(SPLITS.map((s) => [s, JSON.parse(readFileSync(join(here, '..', 'build', 'esp32s3', `result-${s}.json`), 'utf8'))]));
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

const configs = {};
for (const name of Object.keys(runs.dev.configs)) {
  const sum = (k) => SPLITS.reduce((a, s) => a + runs[s].configs[name][k], 0);
  configs[name] = { n: sum('n'), scoreExact: sum('scoreExact'), signalsBitExact: sum('signalsBitExact'), maskEqual: sum('maskEqual') };
}
const signalFieldMismatches = {};
for (const sig of Object.keys(runs.dev.signalFieldMismatches)) {
  const xs = SPLITS.map((s) => runs[s].signalFieldMismatches[sig]);
  signalFieldMismatches[sig] = { count: xs.reduce((a, x) => a + x.count, 0), maxUlp: Math.max(...xs.map((x) => x.maxUlp)), maxAbs: Math.max(...xs.map((x) => x.maxAbs)) };
}
const traces = SPLITS.reduce((a, s) => a + runs[s].traces, 0);
const allExact = Object.values(configs).every((c) => c.scoreExact === c.n && c.maskEqual === c.n)
  && SPLITS.every((s) => runs[s].nullContextMismatches === 0);
if (!allExact) throw new Error('score or mask mismatches on the ESP32-S3; see build/esp32s3/result-*.json');

const latency = {};
for (const [name, passes] of Object.entries(runs.dev.bench)) {
  const pick = (k) => med(passes.map((p) => p[k]));
  latency[name] = {
    passes: passes.length, samplesPerPass: passes[0].samples,
    median_cycles: pick('median_cycles'), p99_cycles: pick('p99_cycles'), mean_cycles: pick('mean_cycles'),
    min_cycles: Math.min(...passes.map((p) => p.min_cycles)), max_cycles: Math.max(...passes.map((p) => p.max_cycles)),
    median_us: pick('median_us'), p99_us: pick('p99_us'), mean_us: pick('mean_us'),
  };
}

const result = {
  platform: runs.dev.platform,
  note: 'Measured on the board, not estimated. Equivalence: all splits; latency: dev split, single calls, interrupts masked, CCOUNT overhead subtracted.',
  equivalence: { traces, configs: Object.keys(configs).length, allScoresExact: allExact, perConfig: configs, signalFieldMismatches },
  latency,
  verifySeconds: Object.fromEntries(SPLITS.map((s) => [s, runs[s].verifySeconds])),
};
const out = join(here, '..', '..', 'results', 'c-scorer-esp32s3.json');
writeFileSync(out, JSON.stringify(result, null, 1));
process.stderr.write(`${out}\n`);
for (const [k, v] of Object.entries(latency)) process.stderr.write(`  ${k}: median ${v.median_us} us (${v.median_cycles} cycles), p99 ${v.p99_us} us\n`);
