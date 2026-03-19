/**
 * Evaluate session-latch gate vs per-fix gate on real mock-teleport trace.
 * Also runs binary threshold sweep for fair comparison.
 */

import { computeTrustScoreV2, gateTrustScore, createTrustSession } from '../dist/trust-scorer.js';
import { generateTraces } from './generate-synthetic-traces.mjs';

// ── Real mock-teleport trace (inlined) ──
const TOKYO_FIXES = [
  {lat:35.6892938,lon:139.7761222,accuracy:11.626,timestamp:"2026-03-19T03:27:47.321Z",speed:null},
  {lat:35.6892938,lon:139.7761222,accuracy:11.626,timestamp:"2026-03-19T03:27:52.976Z",speed:0},
  {lat:35.6893679,lon:139.7760349,accuracy:9.563,timestamp:"2026-03-19T03:27:55.834Z",speed:1.848},
  {lat:35.6893385,lon:139.7760018,accuracy:8.675,timestamp:"2026-03-19T03:27:56.833Z",speed:1.378},
  {lat:35.6893809,lon:139.7760285,accuracy:8.106,timestamp:"2026-03-19T03:27:57.833Z",speed:2.061},
  {lat:35.689394,lon:139.77606,accuracy:6.775,timestamp:"2026-03-19T03:27:58.833Z",speed:2.411},
  {lat:35.6893957,lon:139.7760796,accuracy:6.66,timestamp:"2026-03-19T03:27:59.834Z",speed:2.529},
  {lat:35.6893957,lon:139.7760864,accuracy:6.566,timestamp:"2026-03-19T03:28:00.833Z",speed:2.484},
  {lat:35.6893498,lon:139.7760811,accuracy:6.3,timestamp:"2026-03-19T03:28:01.833Z",speed:1.829},
  {lat:35.6893197,lon:139.7760816,accuracy:6.1,timestamp:"2026-03-19T03:28:02.334Z",speed:1.633},
  {lat:35.6892957,lon:139.7760837,accuracy:6.014,timestamp:"2026-03-19T03:28:02.834Z",speed:1.518},
  {lat:35.689275,lon:139.7760974,accuracy:5.871,timestamp:"2026-03-19T03:28:03.333Z",speed:1.537},
  {lat:35.6892573,lon:139.7761122,accuracy:5.787,timestamp:"2026-03-19T03:28:03.834Z",speed:1.592},
  {lat:35.689255,lon:139.7761407,accuracy:5.65,timestamp:"2026-03-19T03:28:04.834Z",speed:1.535},
  {lat:35.6892646,lon:139.7761493,accuracy:5.512,timestamp:"2026-03-19T03:28:05.833Z",speed:1.384},
  {lat:35.689273,lon:139.7761645,accuracy:5.387,timestamp:"2026-03-19T03:28:06.833Z",speed:1.225},
  {lat:35.6892742,lon:139.7761667,accuracy:5.228,timestamp:"2026-03-19T03:28:07.833Z",speed:0.078},
  {lat:35.6892777,lon:139.7761851,accuracy:5.133,timestamp:"2026-03-19T03:28:08.833Z",speed:0.016},
  {lat:35.6892782,lon:139.7761935,accuracy:5.116,timestamp:"2026-03-19T03:28:09.834Z",speed:0.007},
  {lat:35.6892783,lon:139.7761948,accuracy:5.1,timestamp:"2026-03-19T03:28:10.834Z",speed:0.002},
  {lat:35.6892783,lon:139.7761948,accuracy:6.293,timestamp:"2026-03-19T03:28:11.012Z",speed:0.002},
  {lat:35.6892938,lon:139.7762049,accuracy:6.122,timestamp:"2026-03-19T03:28:11.834Z",speed:0.026},
  {lat:35.6892963,lon:139.7762065,accuracy:6.122,timestamp:"2026-03-19T03:28:12.833Z",speed:0.004},
  {lat:35.6892966,lon:139.7762067,accuracy:6.137,timestamp:"2026-03-19T03:28:13.834Z",speed:0.001},
  {lat:35.6893037,lon:139.776218,accuracy:6.151,timestamp:"2026-03-19T03:28:14.833Z",speed:0.011},
  {lat:35.6893048,lon:139.7762211,accuracy:6.165,timestamp:"2026-03-19T03:28:15.834Z",speed:0.004},
  {lat:35.6893008,lon:139.7762216,accuracy:5.166,timestamp:"2026-03-19T03:28:16.833Z",speed:0.001},
];
const MIAMI_FIX = {lat:25.761681,lon:-80.191788,accuracy:0.01,speed:null};
const MOCK_FIXES = [
  ...TOKYO_FIXES,
  ...Array.from({length:31}, (_,i) => ({
    ...MIAMI_FIX,
    timestamp: new Date(Date.parse("2026-03-19T03:29:26.536Z") + i*1000).toISOString(),
  })),
];

// ── Part 1: Session latch vs per-fix gate on real trace ──

function evaluateGates(fixes) {
  const perFix = [];
  const session = createTrustSession();
  const sessionResults = [];

  for (let i = 1; i < fixes.length; i++) {
    const current = fixes[i];
    const history = fixes.slice(0, i).reverse();
    const recentFixes = fixes.slice(Math.max(0, i-4), i+1).map(f => ({
      lat: f.lat, lon: f.lon, accuracy: f.accuracy, timestamp: f.timestamp,
    }));
    const result = computeTrustScoreV2(current, history, { recentFixes });
    const pfGate = gateTrustScore(result);
    const sessGate = session.gate(result);
    perFix.push({ index: i, score: result.trustScore, perFixGate: pfGate });
    sessionResults.push({ index: i, score: result.trustScore, sessionGate: sessGate, latched: session.latched });
  }

  const postTeleport = i => i >= 27;
  return {
    perFix: {
      postTeleportProceed: perFix.filter(r => postTeleport(r.index) && r.perFixGate === 'proceed').length,
      postTeleportStepUp: perFix.filter(r => postTeleport(r.index) && r.perFixGate === 'step-up').length,
      postTeleportDeny: perFix.filter(r => postTeleport(r.index) && r.perFixGate === 'deny').length,
    },
    session: {
      latchedAt: sessionResults.findIndex(r => r.latched) + 1,
      latchedState: session.latchedState,
      postTeleportProceed: sessionResults.filter(r => postTeleport(r.index) && r.sessionGate === 'proceed').length,
      postTeleportStepUp: sessionResults.filter(r => postTeleport(r.index) && r.sessionGate === 'step-up').length,
      postTeleportDeny: sessionResults.filter(r => postTeleport(r.index) && r.sessionGate === 'deny').length,
    },
  };
}

// ── Part 2: Binary threshold sweep vs graduated gate on synthetic traces ──

function sweepThresholds(traces) {
  const results = [];
  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

  for (const threshold of thresholds) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const trace of traces) {
      const result = computeTrustScoreV2(trace.current, trace.history, {
        recentFixes: trace.recentFixes,
        networkHint: trace.networkHint || undefined,
      });
      const isSpoofed = trace.label === 'spoofed';

      // Binary gate: score < threshold → reject (positive = spoofed detected)
      if (result.trustScore < threshold) {
        if (isSpoofed) tp++; else fp++;
      } else {
        if (isSpoofed) fn++; else tn++;
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const far = fn / (tp + fn); // spoofed that got through
    const fdr = fp / (tn + fp); // legitimate that got blocked

    results.push({
      threshold: +threshold.toFixed(2),
      mode: 'binary',
      tp, fp, tn, fn,
      precision: +precision.toFixed(4),
      recall: +recall.toFixed(4),
      f1: +f1.toFixed(4),
      far: +far.toFixed(4),
      fdr: +fdr.toFixed(4),
    });
  }

  // Graduated gate with idealized step-up
  for (const thetaP of thresholds.filter(t => t >= 0.5)) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const trace of traces) {
      const result = computeTrustScoreV2(trace.current, trace.history, {
        recentFixes: trace.recentFixes,
        networkHint: trace.networkHint || undefined,
      });
      const isSpoofed = trace.label === 'spoofed';
      const score = result.trustScore;

      if (score >= thetaP) {
        // proceed
        if (isSpoofed) fn++; else tn++;
      } else if (score >= 0.3) {
        // step-up: legitimate succeed, spoofers fail
        if (isSpoofed) tp++; else tn++;
      } else {
        // deny
        if (isSpoofed) tp++; else fp++;
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const far = fn / (tp + fn);
    const fdr = fp / (tn + fp);

    results.push({
      threshold: +thetaP.toFixed(2),
      mode: 'graduated',
      tp, fp, tn, fn,
      precision: +precision.toFixed(4),
      recall: +recall.toFixed(4),
      f1: +f1.toFixed(4),
      far: +far.toFixed(4),
      fdr: +fdr.toFixed(4),
    });
  }

  return results;
}

// ── Run ──

const latchResults = evaluateGates(MOCK_FIXES);

let n = 1000;
const nIdx = process.argv.indexOf('--n');
if (nIdx !== -1) n = parseInt(process.argv[nIdx + 1], 10);
const traces = generateTraces(n);
const sweepResults = sweepThresholds(traces);

const output = {
  timestamp: new Date().toISOString(),
  sessionLatch: {
    description: 'Per-fix gate vs session-latch gate on real mock-teleport trace (58 fixes)',
    perFix: latchResults.perFix,
    session: latchResults.session,
  },
  thresholdSweep: {
    description: `Binary vs graduated gate sweep on ${traces.length} synthetic traces`,
    n_per_scenario: n,
    results: sweepResults,
  },
};

process.stdout.write(JSON.stringify(output, null, 2));

// Summary
process.stderr.write('\n=== Session Latch (Real Mock Teleport) ===\n');
process.stderr.write(`Per-fix gate post-teleport: proceed=${latchResults.perFix.postTeleportProceed} step-up=${latchResults.perFix.postTeleportStepUp} deny=${latchResults.perFix.postTeleportDeny}\n`);
process.stderr.write(`Session gate post-teleport: proceed=${latchResults.session.postTeleportProceed} step-up=${latchResults.session.postTeleportStepUp} deny=${latchResults.session.postTeleportDeny}\n`);
process.stderr.write(`Session latched at fix #${latchResults.session.latchedAt} → ${latchResults.session.latchedState}\n\n`);

process.stderr.write('=== Threshold Sweep ===\n');
process.stderr.write('Mode       θ     FAR     FDR     F1\n');
for (const r of sweepResults) {
  process.stderr.write(`${r.mode.padEnd(11)} ${r.threshold.toFixed(2)}  ${r.far.toFixed(4)}  ${r.fdr.toFixed(4)}  ${r.f1.toFixed(4)}\n`);
}
