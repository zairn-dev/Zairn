#!/usr/bin/env node
// Analyze continuity and gaps in a dense trace.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || 'F:/work/openZenly/eval/dense-trace/raw-2026-04-23.json';
const raw = JSON.parse(readFileSync(path, 'utf8'));
const trace = raw.trace;
const meta = raw.meta;

console.log('=== Trace overview ===');
console.log(`Device: ${meta.device}`);
console.log(`Points: ${trace.length}`);
console.log(`Start:  ${meta.startTime}`);
console.log(`End:    ${meta.endTime}`);
console.log(`Nominal cadence: ${meta.intervalSeconds}s`);

const tsMin = trace[0].ts;
const tsMax = trace[trace.length - 1].ts;
const spanSec = (tsMax - tsMin) / 1000;
const spanDays = spanSec / 86400;
const expectedAt60s = Math.round(spanSec / 60);
console.log(`Span: ${spanSec.toFixed(0)}s = ${spanDays.toFixed(3)} days`);
console.log(`Expected points @60s: ${expectedAt60s}`);
console.log(`Actual points:       ${trace.length}  (coverage ${(100*trace.length/expectedAt60s).toFixed(2)}%)`);

// Compute per-sample delta
const deltas = [];
for (let i = 1; i < trace.length; i++) {
  deltas.push((trace[i].ts - trace[i-1].ts) / 1000);
}
deltas.sort((a,b) => a-b);
const p = q => deltas[Math.max(0, Math.min(deltas.length - 1, Math.floor(q * deltas.length)))];
console.log('\n=== Inter-sample intervals (seconds) ===');
console.log(`min    = ${p(0).toFixed(2)}`);
console.log(`p50    = ${p(0.5).toFixed(2)}`);
console.log(`p90    = ${p(0.9).toFixed(2)}`);
console.log(`p99    = ${p(0.99).toFixed(2)}`);
console.log(`max    = ${p(1.0).toFixed(2)}`);

// Find gaps > threshold
const GAPS = [120, 300, 600, 1800, 3600, 7200, 14400, 28800];
const gapCounts = {};
for (const g of GAPS) gapCounts[g] = 0;
const gapList = [];
for (let i = 1; i < trace.length; i++) {
  const dSec = (trace[i].ts - trace[i-1].ts) / 1000;
  for (const g of GAPS) if (dSec > g) gapCounts[g]++;
  if (dSec > 600) {
    gapList.push({
      idx: i,
      from: trace[i-1].timestamp,
      to:   trace[i].timestamp,
      gapSec: dSec,
      gapHours: dSec / 3600,
    });
  }
}
console.log('\n=== Gap counts (> threshold) ===');
for (const g of GAPS) {
  console.log(`> ${g.toString().padStart(5)}s (${(g/60).toFixed(1).padStart(5)}m): ${gapCounts[g]}`);
}

console.log('\n=== Gaps longer than 10 minutes ===');
gapList.sort((a,b) => b.gapSec - a.gapSec);
for (const g of gapList.slice(0, 30)) {
  console.log(`  ${g.from} -> ${g.to}   (${g.gapHours.toFixed(2)}h)`);
}
console.log(`Total 10min+ gaps: ${gapList.length}`);

// Find longest continuous segments (no gap > 120s)
const GAP_TOL = 180; // seconds tolerance
let segs = [];
let segStart = 0;
for (let i = 1; i < trace.length; i++) {
  const dSec = (trace[i].ts - trace[i-1].ts) / 1000;
  if (dSec > GAP_TOL) {
    segs.push({ startIdx: segStart, endIdx: i-1,
      startTs: trace[segStart].ts, endTs: trace[i-1].ts,
      count: i - segStart });
    segStart = i;
  }
}
segs.push({ startIdx: segStart, endIdx: trace.length-1,
  startTs: trace[segStart].ts, endTs: trace[trace.length-1].ts,
  count: trace.length - segStart });

segs.sort((a,b) => b.count - a.count);
console.log(`\n=== Longest continuous segments (gap tolerance = ${GAP_TOL}s) ===`);
for (const s of segs.slice(0, 10)) {
  const spanHr = (s.endTs - s.startTs) / 3600000;
  const t0 = new Date(s.startTs).toISOString();
  const t1 = new Date(s.endTs).toISOString();
  console.log(`  idx ${s.startIdx}..${s.endIdx}  N=${s.count}  span=${spanHr.toFixed(2)}h  ${t0} -> ${t1}`);
}

// Day-by-day coverage
console.log('\n=== Per-day coverage ===');
const dayMap = new Map();
for (const p of trace) {
  const d = p.timestamp.slice(0, 10);
  dayMap.set(d, (dayMap.get(d) || 0) + 1);
}
const days = [...dayMap.keys()].sort();
for (const d of days) {
  const n = dayMap.get(d);
  const pct = (100 * n / 1440).toFixed(1);
  const bar = '#'.repeat(Math.round(n / 1440 * 40));
  console.log(`  ${d}  N=${n.toString().padStart(4)}  cov=${pct.padStart(5)}%  ${bar}`);
}
