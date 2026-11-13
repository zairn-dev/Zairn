// Worst-case static stack depth of the public scorer entry points, from a
// -fstack-usage file plus the call graph: GCC -fcallgraph-info=su (.ci) or,
// for clang, `llvm-objdump -dr` of an object built with -ffunction-sections.
// External callees (libm, soft-float helpers) contribute 0 and are listed.
// objdump input: JUMP relocations are tail calls (callee replaces the frame);
// .ci input cannot tell them apart, so every edge nests (an upper bound).
//
// Usage: node stack-summary.mjs <file.su> <file.ci | objdump.txt>  (prints JSON)

import { readFileSync } from 'node:fs';

const [suFile, graphFile] = process.argv.slice(2);
const norm = (s) => s.replace(/^trust_scorer\.c:/, '').replace(/^\.text\./, '').replace(/[+-]0x[0-9a-f]+$/, '');

const frame = {};
for (const line of readFileSync(suFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/:([^:\s]+)\t(\d+)\t(\S+)/);
  if (m) frame[m[1]] = { bytes: Number(m[2]), kind: m[3] };
}

const edges = {};
const tails = {};
const add = (a, b, tail = false) => (((tail ? tails : edges)[a] ??= new Set()).add(b));
const g = readFileSync(graphFile, 'utf8');
if (graphFile.endsWith('.ci')) {
  for (const m of g.matchAll(/edge: \{ sourcename: "([^"]+)" targetname: "([^"]+)"/g)) add(norm(m[1]), norm(m[2]));
} else {
  let cur = null;
  for (const line of g.split(/\r?\n/)) {
    const h = line.match(/^[0-9a-f]+ <([^>]+)>:/);
    if (h) { cur = h[1]; continue; }
    const r = line.match(/R_\S*(CALL|JUMP)\S*\s+(\S+)/);
    if (r && cur) add(cur, norm(r[2]), r[1] === 'JUMP');
  }
}

const externals = new Set();
const memo = {};
function depth(f, seen = new Set()) {
  if (!(f in frame)) { externals.add(f); return { bytes: 0, path: [] }; }
  if (memo[f]) return memo[f];
  if (seen.has(f)) throw new Error(`recursion at ${f}`);
  seen.add(f);
  let best = { bytes: 0, path: [] };
  for (const c of edges[f] ?? []) {
    if (c === f) continue;
    const d = depth(c, seen);
    if (d.bytes > best.bytes) best = d;
  }
  let res = { bytes: frame[f].bytes + best.bytes, path: [f, ...best.path] };
  for (const c of tails[f] ?? []) {
    if (c === f) continue;
    const d = depth(c, seen);
    if (d.bytes > res.bytes) res = { bytes: d.bytes, path: [`${f}(tail)`, ...d.path] };
  }
  seen.delete(f);
  return (memo[f] = res);
}

const out = { frames: Object.fromEntries(Object.entries(frame).map(([k, v]) => [k, v.bytes])), entries: {} };
for (const e of ['ts_score_v1', 'ts_score_v2', 'ts_score_v2r']) {
  if (frame[e]) out.entries[e] = depth(e);
}
out.externalCallees = [...externals].sort();
console.log(JSON.stringify(out));
