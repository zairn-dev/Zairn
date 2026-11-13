// Collect the build.sh outputs in c-scorer/build/ into results/c-scorer.json.
// Missing pieces (no MSVC, no phone attached, ...) are left out.
//
// Usage: node eval/iotj-r1/c-scorer/make-report.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const B = join(here, 'build');
const p = (...x) => join(B, ...x);
const json = (f) => {
  if (!existsSync(f)) return undefined;
  const s = readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
  return s ? JSON.parse(s.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()) : undefined;
};
const text = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined);
const node = (script, ...args) => JSON.parse(execFileSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' }));
const r1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- equivalence
function equivalence(v) {
  if (!v) return undefined;
  const configs = {};
  for (const [k, c] of Object.entries(v.configs)) {
    configs[k] = {
      n: c.n, scoreExact: c.scoreExact, scoreExactRate: c.scoreExact / c.n,
      signalsBitExact: c.signalsBitExact, signalsBitExactRate: +(c.signalsBitExact / c.n).toFixed(4),
      rawOnRoundingTie: c['rawWithin1e-9OfRoundingTie'],
      minTieDistanceWhereSignalsDiffer: c.minTieDistanceWhereSignalsDiffer,
      scoresChangedIf: c.scoresChangedIf,
    };
  }
  return { platform: v.platform, traces: v.traces, perSplitTraces: v.perSplitTraces, configs, signalDifferences: v.signalFieldMismatches, nullContextMismatches: v.nullContextMismatches };
}

// ---------------------------------------------------------------- latency
// Each platform is benchmarked RUNS times (<prefix>-1.json, -2, ...); the
// summary is the median over runs of each run's median / p99 / mean.
function latency(prefix, label, extra = {}) {
  const runs = [];
  for (let r = 1; r <= 20; r++) {
    const b = json(p(`${prefix}-${r}.json`));
    if (b) runs.push(b);
  }
  if (!runs.length) return undefined;
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
  const summarize = (group, key) => {
    const xs = runs.map((b) => b[group]?.[key]).filter(Boolean);
    if (!xs.length) return undefined;
    return {
      median_ns: med(xs.map((x) => x.median_ns)), p99_ns: med(xs.map((x) => x.p99_ns)), mean_ns: med(xs.map((x) => x.mean_ns)),
      perRun: xs.map((x) => ({ median_ns: x.median_ns, p99_ns: x.p99_ns })),
    };
  };
  const b = runs[0];
  return {
    label, ...extra, platform: b.platform, runs: runs.length, traces: b.traces, passes: b.passes, chunk: b.chunk,
    chunked: { V2: summarize('chunked', 'V2_full'), V2r: summarize('chunked', 'V2r_full') },
    ...(b.single_call_rdtsc && { singleCallRdtsc: { V2: summarize('single_call_rdtsc', 'V2_full'), V2r: summarize('single_call_rdtsc', 'V2r_full') } }),
  };
}

// ---------------------------------------------------------------- footprint
function sizeSections(f) {
  const t = text(f);
  if (!t) return undefined;
  let code = 0, rodata = 0, data = 0;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^(\.\S+)\s+(\d+)/);
    if (!m) continue;
    const [, sec, n] = m;
    if (/^\.(text|literal)/.test(sec)) code += +n;
    else if (/^\.s?rodata/.test(sec)) rodata += +n;
    else if (/^\.(s?data|s?bss)/.test(sec)) data += +n;
  }
  return { code, rodata, data };
}
function target(dir, { ci = false } = {}) {
  const D = p(dir);
  if (!existsSync(D)) return undefined;
  const out = { compiler: text(join(D, 'version.txt')) };
  for (const opt of ['O2', 'Os']) {
    const obj = sizeSections(join(D, `fp-${opt}.size.txt`));
    if (!obj) continue;
    const graph = ci ? join(D, `fp-${opt}.ci`) : join(D, `fp-${opt}.dis`);
    const su = join(D, `fp-${opt}.su`);
    const stack = existsSync(su) && existsSync(graph) ? node('stack-summary.mjs', su, graph) : undefined;
    const map = join(D, `link-${opt}.map`);
    const undef = text(join(D, `fp-${opt}.undef.txt`));
    out[opt] = {
      object: obj,
      stackBytes: stack && Object.fromEntries(Object.entries(stack.entries).map(([k, v]) => [k, { bytes: v.bytes, path: v.path.join(' > ') }])),
      stackNote: stack && (ci ? 'GCC call graph; tail calls counted as nested (upper bound); libm / soft-float helpers excluded'
        : 'clang relocations; tail calls replace the frame; libm / soft-float helpers excluded'),
      externalCallees: stack?.externalCallees ?? (undef && undef.split(/\r?\n/).map((l) => l.trim().replace(/^U\s+/, ''))),
      ...(existsSync(map) && { linkedClosure: node('map-summary.mjs', map) }),
    };
  }
  return out;
}

// ---------------------------------------------------------------- op counts and MCU estimate
const ops = json(p('ops.json'));
const OPS = ['add', 'mul', 'div', 'cmp', 'cvt', 'sqrt', 'sin', 'cos', 'atan2', 'floor'];
const opTable = ops && Object.fromEntries(Object.entries(ops.configs).map(([k, c]) => [k, Object.fromEntries(
  [...OPS, 'distance'].map((o) => [o, { mean: c[o].mean, min: c[o].min, max: c[o].max }]))]));

// Cycle costs of double-precision soft-float routines measured on a Cortex-M0
// (LPC11U68) and published in the Qfplib-M0-full README (Mark Owen): the GCC
// library column and Qfplib's own. cmp / cvt / floor are not listed and are
// charged at the cost of an addition.
const COST_MODELS = {
  gccSoftDoubleCortexM0: {
    source: 'Qfplib-M0-full README, "GCC library" column (Cortex-M0, LPC11U68, avg cycles incl. call overhead)',
    add: 168, mul: 377, div: 1190, cmp: 168, cvt: 168, floor: 168, sqrt: 1305, sin: 5854, cos: 6162, atan2: 9973,
  },
  qfplibSoftDoubleCortexM0: {
    source: 'Qfplib-M0-full README, Qfplib column (Cortex-M0, LPC11U68)',
    add: 94, mul: 163, div: 200, cmp: 94, cvt: 94, floor: 94, sqrt: 174, sin: 1624, cos: 1623, atan2: 2187,
  },
};
const CLOCKS_MHZ = { 'nRF52840 (Cortex-M4F)': 64, 'STM32F4 (Cortex-M4F)': 168, 'ESP32-C3 (RV32IMC)': 160, 'ESP32 (Xtensa LX6)': 240 };
function estimate(cfg) {
  if (!ops) return undefined;
  const c = ops.configs[cfg];
  const res = {};
  for (const [name, m] of Object.entries(COST_MODELS)) {
    const parts = Object.fromEntries(OPS.map((o) => [o, Math.round(c[o].mean * m[o])]));
    const cycles = Object.values(parts).reduce((a, b) => a + b, 0);
    const trig = parts.sin + parts.cos + parts.atan2 + parts.sqrt;
    res[name] = {
      cycles, libmShare: +(trig / cycles).toFixed(3),
      ms: Object.fromEntries(Object.entries(CLOCKS_MHZ).map(([k, mhz]) => [k, +(cycles / (mhz * 1e3)).toFixed(2)])),
    };
  }
  return res;
}

// ---------------------------------------------------------------- assemble
const hostCpu = json(p('host-cpu.json'));
const android = json(p('android-device.json'));
const msvcVer = text(p('host-msvc', 'version.txt'));
const report = {
  generated: new Date().toISOString(),
  description: 'C99 port of the IoT-J trust scorers (V1, submitted V2, revised V2\'): JS equivalence, latency, footprint, operation counts. See c-scorer/README.md.',
  host: {
    cpu: hostCpu?.Name?.trim(), cores: hostCpu?.NumberOfCores, threads: hostCpu?.NumberOfLogicalProcessors, os: 'Windows 11 Pro',
    gcc: json(p('verify-host-gcc.json'))?.platform?.compiler, msvc: msvcVer, node: json(p('bench-js-1.json'))?.platform?.node,
  },
  android: android ?? 'no device attached during the run',
  equivalence: {
    method: 'export-inputs.mjs writes dev/val/test (10,000 traces each) with the JS signals and trustScores of 10 configurations; ts_driver verify compares bit for bit.',
    'x86_64-gcc': equivalence(json(p('verify-host-gcc.json'))),
    'x86_64-msvc': equivalence(json(p('verify-host-msvc.json'))),
    'aarch64-android': equivalence(json(p('verify-android.json'))),
    'x86_64-gcc-fma-contracted': (() => { const v = json(p('verify-host-gcc-fma.json')); return v && Object.fromEntries(Object.entries(v.configs).map(([k, c]) => [k, { scoreExact: c.scoreExact, signalsBitExact: c.signalsBitExact }])); })(),
    libmVsV8: { 'x86_64-gcc (mingw-w64)': json(p('libm-host-gcc.json')), 'x86_64-msvc (UCRT)': json(p('libm-host-msvc.json')), 'aarch64 (bionic)': json(p('libm-android.json')) },
  },
  latency: {
    method: 'dev split, full context (fixes + network), 2 warm-up passes, 30 timed passes, per-score latency = time of 32 consecutive calls / 32; median and p99 over chunks. x86 also times single calls with lfence+rdtsc (10 ns TSC granularity on Zen 2) minus the empty-pair overhead.',
    'x86_64-msvc': latency('bench-host-msvc', `${msvcVer ?? 'MSVC'} /O2 /fp:precise, UCRT libm; pinned to one core, high priority`),
    'x86_64-gcc': latency('bench-host-gcc', 'w64devkit gcc -O2 -ffp-contract=off, mingw-w64 libm (x87 fpatan for atan2); pinned, high priority'),
    'node-v8': latency('bench-js', 'paper-scorer.mjs / revised-scorer.mjs in Node, high priority (JS also parses ISO timestamps)'),
    'aarch64-android': latency('bench-android', 'NDK clang -O2 -ffp-contract=off -static, unpinned'),
    'aarch64-android-bigcore': latency('bench-android-bigcore', 'same, pinned to the fastest core with taskset'),
  },
  footprint: {
    sizeof: json(p('sizes-host.json'))?.sizeof,
    note: 'object = scorer only (code incl. Xtensa literals; rodata = constants); linkedClosure = scorer + newlib libm + libgcc soft-float helpers pulled in by a --gc-sections link of V2 and V2\' (mcu_entry.c), bytes',
    'x86_64-gcc': (() => {
      const t = text(p('host-gcc', 'sections.txt')) ?? '';
      const sec = (re) => [...t.matchAll(/^\s*\d+\s+(\S+)\s+([0-9a-f]+)\s/gm)]
        .filter((m) => re.test(m[1])).reduce((s, m) => s + parseInt(m[2], 16), 0);
      const su = p('host-gcc', 'trust_scorer.su'), ci = p('host-gcc', 'trust_scorer.ci');
      const st = existsSync(su) && existsSync(ci) ? node('stack-summary.mjs', su, ci) : undefined;
      return {
        compiler: json(p('verify-host-gcc.json'))?.platform?.compiler,
        O2: {
          object: { code: sec(/^\.text/), rodata: sec(/^\.rdata/) },
          stackBytes: st && Object.fromEntries(Object.entries(st.entries).map(([k, v]) => [k, { bytes: v.bytes, path: v.path.join(' > ') }])),
          stackNote: 'Win64 ABI frames include the 32-byte shadow space and callee-saved XMM spills',
        },
      };
    })(),
    'aarch64-android': target('aarch64'),
    esp32: target('esp32', { ci: true }),
    esp32c3: target('esp32c3', { ci: true }),
    'cortex-m4f': target('cortex-m4f'),
  },
  operationCounts: {
    method: 'TS_COUNT_OPS build; per-block annotations count double operations as compiled (x/2 and x/0.5 as multiplications, x/1 folded); libm calls counted at the call. Mean [min-max] per score over dev+val+test.',
    configs: opTable,
  },
  mcuEstimate: {
    label: 'ESTIMATE, not a measurement: mean operation counts x published per-operation cycle costs of software double precision on a Cortex-M0. Cores with a 32x32->64 multiplier (Cortex-M4, Xtensa LX6, RV32IMC) should be faster; a double-precision FPU (Cortex-M7 FPv5-D16) far faster.',
    costModels: COST_MODELS,
    clocksMHz: CLOCKS_MHZ,
    V2_full: estimate('V2/both'),
    V2r_full: estimate('V2r/both'),
    V1: estimate('V1'),
  },
};
mkdirSync(join(here, '..', 'results'), { recursive: true });
const outFile = join(here, '..', 'results', 'c-scorer.json');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
process.stderr.write(`wrote ${outFile}\n`);
