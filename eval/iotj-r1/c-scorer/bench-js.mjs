// Same-machine JS baseline for the C benchmark (ts_driver bench): per-score
// latency of the frozen V2 and the revised V2' with full context (fixes +
// network) over the dev traces in order, timed in chunks of 32 calls,
// alternating scorers pass by pass, after two warm-up passes. Runs at high
// process priority where permitted (ts_driver also pins itself to one core).
//
// Usage: node eval/iotj-r1/c-scorer/bench-js.mjs [passes=30] [chunk=32]
// Prints JSON to stdout, a summary to stderr.

import os from 'node:os';
import { syntheticSplit } from '../data.mjs';
import { computeTrustScoreV2 } from '../paper-scorer.mjs';
import { computeTrustScoreRevised } from '../revised-scorer.mjs';

try { os.setPriority(os.constants.priority.PRIORITY_HIGH); } catch {}

const passes = Number(process.argv[2] ?? 30);
const chunk = Number(process.argv[3] ?? 32);
const traces = syntheticSplit('dev');
const inputs = traces.map((t) => [t.current, t.history, { recentFixes: t.recentFixes, networkHint: t.networkHint }]);
const fns = { V2_full: computeTrustScoreV2, V2r_full: computeTrustScoreRevised };

let sink = 0;
for (let p = 0; p < 2; p++) for (const f of Object.values(fns)) for (const [c, h, x] of inputs) sink += f(c, h, x).trustScore;

const samples = { V2_full: [], V2r_full: [] };
const nChunks = Math.floor(inputs.length / chunk);
for (let p = 0; p < passes; p++) {
  for (const [name, f] of Object.entries(fns)) {
    for (let k = 0; k < nChunks; k++) {
      let acc = 0;
      const t0 = process.hrtime.bigint();
      for (let i = k * chunk; i < (k + 1) * chunk; i++) acc += f(inputs[i][0], inputs[i][1], inputs[i][2]).trustScore;
      const t1 = process.hrtime.bigint();
      sink += acc;
      samples[name].push(Number(t1 - t0) / chunk);
    }
  }
}

const pct = (s, p) => s[Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length))) - 1];
const out = {
  mode: 'bench-js',
  platform: { node: process.version, v8: process.versions.v8, cpu: os.cpus()[0]?.model.trim(), arch: process.arch },
  traces: inputs.length, passes, chunk, chunked: {}, checksum: sink,
};
process.stderr.write(`bench-js: ${inputs.length} dev traces, ${passes} passes, chunk ${chunk}, node ${process.version}\n`);
for (const [name, s] of Object.entries(samples)) {
  s.sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  out.chunked[name] = {
    samples: s.length, median_ns: +pct(s, 50).toFixed(2), p99_ns: +pct(s, 99).toFixed(2),
    p999_ns: +pct(s, 99.9).toFixed(2), mean_ns: +mean.toFixed(2), min_ns: +s[0].toFixed(2), max_ns: +s[s.length - 1].toFixed(2),
  };
  process.stderr.write(`  ${name.padEnd(10)} median ${pct(s, 50).toFixed(1)} ns  p99 ${pct(s, 99).toFixed(1)} ns  mean ${mean.toFixed(1)} ns\n`);
}
process.stdout.write(JSON.stringify(out) + '\n');
