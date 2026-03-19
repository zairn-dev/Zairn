/**
 * Evaluate trust scorer on real device traces.
 * Reads JSON traces from real-traces/ and scores them with V1/V2.
 */

import { computeTrustScore, computeTrustScoreV2, gateTrustScore } from '../dist/trust-scorer.js';

// ── Real trace data (inlined from collected JSON) ──

const HONEST_WALK_FIXES = [
  {lat:35.6893068,lon:139.7761288,accuracy:11.476,timestamp:"2026-03-19T03:26:43.283Z",speed:null},
  {lat:35.6893068,lon:139.7761288,accuracy:11.476,timestamp:"2026-03-19T03:26:48.535Z",speed:0},
  {lat:35.6893065,lon:139.7761342,accuracy:19.523,timestamp:"2026-03-19T03:26:54.878Z",speed:0.828},
  {lat:35.6893065,lon:139.776133,accuracy:19.517,timestamp:"2026-03-19T03:26:55.518Z",speed:0.827},
  {lat:35.6893065,lon:139.7761305,accuracy:19.514,timestamp:"2026-03-19T03:26:55.654Z",speed:0.827},
  {lat:35.6893105,lon:139.7761536,accuracy:16.842,timestamp:"2026-03-19T03:26:56.155Z",speed:0.731},
  {lat:35.6893125,lon:139.7761575,accuracy:15.221,timestamp:"2026-03-19T03:26:56.916Z",speed:0.757},
  {lat:35.689314,lon:139.7761596,accuracy:14.194,timestamp:"2026-03-19T03:26:57.595Z",speed:0.769},
  {lat:35.6893154,lon:139.7761607,accuracy:13.496,timestamp:"2026-03-19T03:26:58.295Z",speed:0.744},
  {lat:35.6893157,lon:139.7761609,accuracy:13.023,timestamp:"2026-03-19T03:26:58.865Z",speed:0.78},
  {lat:35.6893156,lon:139.776163,accuracy:11.88,timestamp:"2026-03-19T03:26:59.695Z",speed:0.749},
  {lat:35.6893146,lon:139.7761632,accuracy:10.757,timestamp:"2026-03-19T03:27:00.296Z",speed:0.67},
  {lat:35.6893135,lon:139.7761626,accuracy:9.677,timestamp:"2026-03-19T03:27:00.743Z",speed:0.644},
  {lat:35.6893102,lon:139.7761527,accuracy:9.806,timestamp:"2026-03-19T03:27:01.643Z",speed:0.294},
  {lat:35.6893022,lon:139.7761296,accuracy:9.809,timestamp:"2026-03-19T03:27:02.087Z",speed:0.586},
  {lat:35.6893013,lon:139.7761241,accuracy:9.83,timestamp:"2026-03-19T03:27:02.700Z",speed:0.585},
  {lat:35.6893013,lon:139.7761193,accuracy:9.76,timestamp:"2026-03-19T03:27:02.886Z",speed:0.703},
  {lat:35.6893034,lon:139.7761138,accuracy:9.801,timestamp:"2026-03-19T03:27:03.567Z",speed:0.745},
  {lat:35.6893045,lon:139.7760444,accuracy:9.599,timestamp:"2026-03-19T03:27:04.007Z",speed:1.658},
  {lat:35.6893021,lon:139.7759716,accuracy:9.293,timestamp:"2026-03-19T03:27:05.006Z",speed:3.429},
  {lat:35.6893056,lon:139.7758898,accuracy:8.735,timestamp:"2026-03-19T03:27:06.006Z",speed:4.848},
  {lat:35.6893157,lon:139.7758094,accuracy:8.266,timestamp:"2026-03-19T03:27:07.007Z",speed:5.632},
  {lat:35.6893257,lon:139.7757451,accuracy:7.585,timestamp:"2026-03-19T03:27:08.007Z",speed:5.861},
  {lat:35.6893117,lon:139.7757178,accuracy:7.066,timestamp:"2026-03-19T03:27:09.006Z",speed:5.636},
  {lat:35.6892974,lon:139.7756846,accuracy:6.866,timestamp:"2026-03-19T03:27:10.006Z",speed:5.507},
  {lat:35.6892863,lon:139.7756693,accuracy:6.716,timestamp:"2026-03-19T03:27:11.007Z",speed:5.162},
  {lat:35.6892805,lon:139.7756625,accuracy:6.6,timestamp:"2026-03-19T03:27:12.007Z",speed:2.2},
  {lat:35.6892791,lon:139.7756567,accuracy:6.5,timestamp:"2026-03-19T03:27:13.007Z",speed:0.923},
  {lat:35.6892846,lon:139.7756519,accuracy:6.45,timestamp:"2026-03-19T03:27:14.006Z",speed:0.403},
  {lat:35.6892868,lon:139.7756391,accuracy:6.416,timestamp:"2026-03-19T03:27:15.007Z",speed:0.221},
];

const HONEST_STATIONARY_FIXES = [
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

// Mock teleport: first 27 fixes in Tokyo, then 31 fixes at Miami (25.761681, -80.191788) acc=0.01m
const MOCK_FIXES_TOKYO = HONEST_STATIONARY_FIXES; // same real GPS data
const MOCK_FIX_MIAMI = {lat:25.761681,lon:-80.191788,accuracy:0.01,speed:null};
const MOCK_TELEPORT_FIXES = [
  ...MOCK_FIXES_TOKYO,
  ...Array.from({length:31}, (_,i) => ({
    ...MOCK_FIX_MIAMI,
    timestamp: new Date(Date.parse("2026-03-19T03:29:26.536Z") + i*1000).toISOString(),
  })),
];

// ── Scoring logic ──

function scoreTrace(fixes, label) {
  const results = [];
  for (let i = 1; i < fixes.length; i++) {
    const current = fixes[i];
    const history = fixes.slice(0, i).reverse(); // newest-first
    const recentFixes = fixes.slice(Math.max(0, i-4), i+1).map(f => ({
      lat: f.lat, lon: f.lon, accuracy: f.accuracy, timestamp: f.timestamp,
    }));

    const v1 = computeTrustScore(current, history);
    const v2 = computeTrustScoreV2(current, history, { recentFixes });
    const g = gateTrustScore(v2);

    results.push({
      index: i,
      v1: v1.trustScore,
      v2: v2.trustScore,
      gate: g,
      signals: v2.signals,
    });
  }
  return {
    label,
    fixCount: fixes.length,
    scoredCount: results.length,
    v1Mean: +(results.reduce((s,r) => s+r.v1, 0) / results.length).toFixed(4),
    v2Mean: +(results.reduce((s,r) => s+r.v2, 0) / results.length).toFixed(4),
    v1Min: Math.min(...results.map(r => r.v1)),
    v2Min: Math.min(...results.map(r => r.v2)),
    gateDistribution: {
      proceed: results.filter(r => r.gate === 'proceed').length,
      stepUp: results.filter(r => r.gate === 'step-up').length,
      deny: results.filter(r => r.gate === 'deny').length,
    },
    // For mock teleport: scores after the teleport fix
    postTeleport: label === 'mock-teleport' ? (() => {
      const post = results.filter(r => r.index >= 27); // fix 28+
      return {
        count: post.length,
        v2Mean: +(post.reduce((s,r) => s+r.v2, 0) / post.length).toFixed(4),
        v2Min: Math.min(...post.map(r => r.v2)),
        v2Max: Math.max(...post.map(r => r.v2)),
        allDeny: post.every(r => r.gate === 'deny'),
        allStepUpOrDeny: post.every(r => r.gate !== 'proceed'),
        gateDistribution: {
          proceed: post.filter(r => r.gate === 'proceed').length,
          stepUp: post.filter(r => r.gate === 'step-up').length,
          deny: post.filter(r => r.gate === 'deny').length,
        },
        signals: post[0]?.signals,
      };
    })() : undefined,
    perFix: results,
  };
}

// ── Run ──

const honestWalk = scoreTrace(HONEST_WALK_FIXES, 'honest-walk');
const honestStationary = scoreTrace(HONEST_STATIONARY_FIXES, 'honest-stationary');
const mockTeleport = scoreTrace(MOCK_TELEPORT_FIXES, 'mock-teleport');

const output = {
  timestamp: new Date().toISOString(),
  device: 'Jelly Star (Android 10, armv81)',
  traces: {
    'honest-walk': {
      fixCount: honestWalk.fixCount,
      v1Mean: honestWalk.v1Mean,
      v2Mean: honestWalk.v2Mean,
      v1Min: honestWalk.v1Min,
      v2Min: honestWalk.v2Min,
      gate: honestWalk.gateDistribution,
      allProceed: honestWalk.gateDistribution.proceed === honestWalk.scoredCount,
    },
    'honest-stationary': {
      fixCount: honestStationary.fixCount,
      v1Mean: honestStationary.v1Mean,
      v2Mean: honestStationary.v2Mean,
      v1Min: honestStationary.v1Min,
      v2Min: honestStationary.v2Min,
      gate: honestStationary.gateDistribution,
      allProceed: honestStationary.gateDistribution.proceed === honestStationary.scoredCount,
    },
    'mock-teleport': {
      fixCount: mockTeleport.fixCount,
      v1Mean: mockTeleport.v1Mean,
      v2Mean: mockTeleport.v2Mean,
      v1Min: mockTeleport.v1Min,
      v2Min: mockTeleport.v2Min,
      gate: mockTeleport.gateDistribution,
      postTeleport: mockTeleport.postTeleport,
    },
  },
  summary: {
    legitimate_all_proceed: honestWalk.gateDistribution.proceed === honestWalk.scoredCount
      && honestStationary.gateDistribution.proceed === honestStationary.scoredCount,
    mock_detected: mockTeleport.postTeleport?.allStepUpOrDeny ?? false,
  },
};

process.stdout.write(JSON.stringify(output, null, 2));

// Summary to stderr
process.stderr.write('\n=== Real Device Trace Evaluation ===\n');
process.stderr.write(`Device: Jelly Star (Android 10)\n\n`);
for (const [name, t] of Object.entries(output.traces)) {
  process.stderr.write(`${name}: ${t.fixCount} fixes, V1=${t.v1Mean} V2=${t.v2Mean} V2min=${t.v2Min}\n`);
  process.stderr.write(`  Gate: proceed=${t.gate.proceed} step-up=${t.gate.stepUp} deny=${t.gate.deny}\n`);
  if (t.postTeleport) {
    process.stderr.write(`  Post-teleport (${t.postTeleport.count} fixes): V2=${t.postTeleport.v2Mean} gate: ${JSON.stringify(t.postTeleport.gateDistribution)}\n`);
  }
}
process.stderr.write(`\nLegitimate all proceed: ${output.summary.legitimate_all_proceed}\n`);
process.stderr.write(`Mock teleport detected: ${output.summary.mock_detected}\n`);
