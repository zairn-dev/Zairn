/**
 * Build clean-segABC.json from raw-2026-04-26.json by concatenating
 * the three contiguous segments (A, B, C) and discarding the two
 * operational gaps (13.25h between A-B, 1.99h between B-C).
 *
 * Result: 21.82-day trace with 30,516 fixes, 97.10% nominal cadence
 * coverage, 2 acknowledged gaps totalling 15.24h.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'F:/work/openZenly/eval/dense-trace/raw-2026-04-26.json';
const DST = 'F:/work/openZenly/eval/dense-trace/clean-segABC.json';

const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const trace = raw.trace;

// Re-discover segment boundaries the same way analyze-gaps.mjs does:
// split on any inter-sample gap > 180 s.
const GAP_TOL_SEC = 180;
const segments = [];
let start = 0;
for (let i = 1; i < trace.length; i++) {
  const dSec = (trace[i].ts - trace[i - 1].ts) / 1000;
  if (dSec > GAP_TOL_SEC) {
    segments.push({ startIdx: start, endIdx: i - 1, count: i - start });
    start = i;
  }
}
segments.push({ startIdx: start, endIdx: trace.length - 1, count: trace.length - start });

console.log('Segments:');
for (const s of segments) {
  const t0 = trace[s.startIdx].timestamp;
  const t1 = trace[s.endIdx].timestamp;
  const span = (trace[s.endIdx].ts - trace[s.startIdx].ts) / 1000 / 86400;
  console.log(`  N=${s.count}  span=${span.toFixed(2)}d  ${t0} -> ${t1}`);
}

// Concatenate all segments (A, B, C). The boundary timestamps are
// preserved so consumers can detect the operational gaps if needed.
const merged = [];
for (const s of segments) {
  for (let i = s.startIdx; i <= s.endIdx; i++) merged.push(trace[i]);
}

const meta = {
  device: raw.meta.device,
  startTime: trace[0].timestamp,
  endTime:   trace[trace.length - 1].timestamp,
  spanSeconds: (trace[trace.length - 1].ts - trace[0].ts) / 1000,
  spanDays:    (trace[trace.length - 1].ts - trace[0].ts) / 1000 / 86400,
  intervalSeconds: 60,
  segments: segments.map(s => ({
    startTime: trace[s.startIdx].timestamp,
    endTime:   trace[s.endIdx].timestamp,
    count: s.count,
  })),
  gaps: [],
  totalPoints: merged.length,
  source: SRC,
};
for (let i = 1; i < segments.length; i++) {
  const aEnd = trace[segments[i - 1].endIdx];
  const bStart = trace[segments[i].startIdx];
  meta.gaps.push({
    from: aEnd.timestamp,
    to:   bStart.timestamp,
    seconds: (bStart.ts - aEnd.ts) / 1000,
    hours:   (bStart.ts - aEnd.ts) / 3600000,
  });
}

writeFileSync(DST, JSON.stringify({ meta, trace: merged }));
console.log(`\nWritten: ${DST}`);
console.log(`Total points: ${merged.length}`);
console.log(`Span: ${meta.spanDays.toFixed(2)} days`);
console.log(`Operational gaps: ${meta.gaps.length}`);
for (const g of meta.gaps) console.log(`  ${g.from} -> ${g.to} (${g.hours.toFixed(2)}h)`);
