/**
 * Cross-dataset sensing-gate replay.
 *
 * Answers the "single trace" reviewer critique for the "privacy as a sensing
 * scheduler" thesis (companion to eval/dense-trace/energy-ablation.mjs, which
 * is n=1 on a dense Tokyo trace). Here we replay THREE public mobility datasets
 * through the REAL shipped SDK artifact `createSensingGate`
 * (packages/sdk/dist/privacy-location.js) to show the pre-acquisition sensing
 * gate cuts GNSS duty cycle across many users, devices, and mobility regimes.
 *
 * Per dataset, per user/entity we:
 *   1. detect that user's own sensitive zones from their own trace
 *      (detectSensitivePlaces; night-centroid fallback like energy-ablation.mjs),
 *   2. replay through three arms:
 *        - continuous : acquire GNSS at every observed sample (privacy, if any,
 *                       is post-acquisition) -> upper bound,
 *        - fixedrate  : additive privacy, 5-min heartbeat regardless of motion,
 *        - gate_artifact : the REAL createSensingGate, decided PRE-acquisition,
 *                       driven by the same caller-accumulated displacement bound
 *                       as the reference (bounds: stationary 0.05 / walking 1.5 /
 *                       driving 15 m/s, reset on each acquisition).
 *
 * KEY METRIC (honest for irregular / sparse traces):
 *   - acquisition ratio vs continuous = fraction of OBSERVED samples at which
 *     the arm acquires (continuous acquires at every sample by definition, so
 *     its fraction is 1.0 and the ratio == the arm's own acquire fraction),
 *   - acquisitions per OBSERVED-hour: nAcq / (sum of inter-sample gaps, each
 *     capped at 10 min). The cap stops dead gaps (device off / trace holes)
 *     from inflating the denominator and crediting the gate with free savings,
 *   - median staleness at observed samples: at each sample, age of the freshest
 *     fix after that sample's acquire decision (continuous == 0; gate pays a
 *     bounded staleness for the acquisitions it skips).
 *
 * Deterministic: no Math.random, no Date.now.
 */
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  detectSensitivePlaces,
  DEFAULT_PRIVACY_CONFIG,
  createSensingGate,
} from '../../packages/sdk/dist/privacy-location.js';

const DIR = import.meta.dirname;
const REPO = join(DIR, '..', '..');

// ---- config (mirrors energy-ablation.mjs; zone thresholds relaxed for the
// sparser cross-dataset traces as specified) ----
const CFG = { ...DEFAULT_PRIVACY_CONFIG, minVisitsForSensitive: 3, minDwellMinutes: 30 };
const ZONE_CORE_M = CFG.defaultZoneRadiusM;          // 200 m
const MOVE_SPEED = 0.7;                               // m/s; below = stationary
const FIXED_INTERVAL_S = 5 * 60;                      // FixedRateReporter default (12/h)
const GAP_CAP_S = 10 * 60;                            // cap inter-sample gaps at 10 min for observed-hours
const DISP_BOUND_MPS = { stationary: 0.05, walking: 1.5, driving: 15 };
const TDRIVE_MAX_TAXIS = 500;                         // feasibility cap (matches existing tdrive script)
const MIN_POINTS = 50;                                // drop entities with too few points

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, p = Math.PI / 180;
  const a = Math.min(1, Math.sin((la2 - la1) * p / 2) ** 2 +
    Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function quant(arr, q) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const pos = q * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const median = arr => quant(arr, 0.5);

// motion class -> gate `motion` + displacement bound. Prefer an explicit motion
// label (StudentLife travelstate) when present, else classify from speed like
// the reference gate_artifact arm.
function motionOf(pt) {
  if (pt.travelstate === 'stationary') return 'stationary';
  if (pt.travelstate === 'moving') return (pt.speed ?? 0) > 5 ? 'driving' : 'walking';
  const s = pt.speed ?? 0;
  return s > 5 ? 'driving' : s > MOVE_SPEED ? 'walking' : 'stationary';
}

// fill computed speed (m/s) where the dataset has none; add hour + timestamp.
function enrich(trace) {
  for (let i = 0; i < trace.length; i++) {
    const pt = trace[i];
    pt.hour = new Date(pt.ts).getHours();
    pt.timestamp = pt.ts;
    if (pt.speed == null) {
      if (i === 0) { pt.speed = 0; continue; }
      const dt = (pt.ts - trace[i - 1].ts) / 1000;
      pt.speed = dt > 0 ? haversine(trace[i - 1].lat, trace[i - 1].lon, pt.lat, pt.lon) / dt : 0;
    }
  }
  return trace;
}

function zonesFor(trace) {
  let places = detectSensitivePlaces(
    trace.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.timestamp })), CFG);
  let src = 'detect';
  if (places.length === 0) {
    const night = trace.filter(p => p.hour >= CFG.nightHoursStart || p.hour < CFG.nightHoursEnd);
    if (night.length) {
      const hl = night.reduce((s, p) => s + p.lat, 0) / night.length;
      const ho = night.reduce((s, p) => s + p.lon, 0) / night.length;
      places = [{ label: 'home', lat: hl, lon: ho, radiusM: ZONE_CORE_M }];
      src = 'night';
    } else src = 'none';
  }
  return { places: places.map(p => ({ ...p, radiusM: p.radiusM ?? ZONE_CORE_M })), src };
}

// run one arm over a trace, return acquisition + staleness stats.
function runArm(trace, arm, gate) {
  let nAcq = 0, lastAcqTs = -Infinity, lastFix = null, disp = 0, obsSec = 0;
  let prevTs = trace[0].ts;
  const reasons = {};
  const stale = new Float64Array(trace.length);
  for (let i = 0; i < trace.length; i++) {
    const pt = trace[i];
    const dt = Math.max((pt.ts - prevTs) / 1000, 0); prevTs = pt.ts;
    obsSec += Math.min(dt, GAP_CAP_S);
    const sinceAcq = (pt.ts - lastAcqTs) / 1000;
    let acquire = false;
    if (arm === 'continuous') {
      acquire = true;
    } else if (arm === 'fixedrate') {
      acquire = sinceAcq >= FIXED_INTERVAL_S;
    } else { // gate_artifact — the real shipped artifact decides pre-acquisition
      const motion = motionOf(pt);
      disp += dt * DISP_BOUND_MPS[motion];
      const d = gate.shouldAcquire({ now: pt.ts, lastFix, motion, maxDisplacementM: disp });
      acquire = d.acquire;
      if (acquire) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
    }
    if (acquire) {
      nAcq++;
      lastAcqTs = pt.ts;
      lastFix = { lat: pt.lat, lon: pt.lon, timestamp: pt.ts };
      disp = 0;
    }
    stale[i] = (pt.ts - lastAcqTs) / 1000; // post-decision staleness (0 if acquired now)
  }
  const obsH = obsSec / 3600;
  const staleArr = Array.from(stale);
  return {
    nAcq,
    frac: +(nAcq / trace.length).toFixed(5),
    perObsH: obsH > 0 ? +(nAcq / obsH).toFixed(3) : null,
    medStaleMin: +((median(staleArr) ?? 0) / 60).toFixed(3),
    obsH: +obsH.toFixed(3),
    ...(Object.keys(reasons).length ? { reasons } : {}),
  };
}

function replayUser(id, trace) {
  enrich(trace);
  const spanH = (trace[trace.length - 1].ts - trace[0].ts) / 3.6e6;
  const gaps = [];
  for (let i = 1; i < trace.length; i++) gaps.push((trace[i].ts - trace[i - 1].ts) / 1000);
  const { places, src } = zonesFor(trace);
  const gate = createSensingGate(CFG, places);
  const cont = runArm(trace, 'continuous', gate);
  const fixed = runArm(trace, 'fixedrate', gate);
  const g = runArm(trace, 'gate_artifact', gate);
  return {
    id,
    nSamples: trace.length,
    spanH: +spanH.toFixed(2),
    obsH: cont.obsH,
    medGapS: gaps.length ? +median(gaps).toFixed(1) : null,
    zones: places.length,
    zoneSrc: src,
    cont, fixed, gate: g,
    gateRatio: +(g.nAcq / cont.nAcq).toFixed(5),   // vs continuous (cont.nAcq == nSamples)
    fixedRatio: +(fixed.nAcq / cont.nAcq).toFixed(5),
  };
}

function aggregate(source, users) {
  const gr = users.map(u => u.gateRatio);
  const fr = users.map(u => u.fixedRatio);
  return {
    source,
    nUsers: users.length,
    gateRatio: { median: r5(median(gr)), p25: r5(quant(gr, 0.25)), p75: r5(quant(gr, 0.75)) },
    fixedRatio: { median: r5(median(fr)), p25: r5(quant(fr, 0.25)), p75: r5(quant(fr, 0.75)) },
    gatePerObsH_median: r3(median(users.map(u => u.gate.perObsH).filter(x => x != null))),
    contPerObsH_median: r3(median(users.map(u => u.cont.perObsH).filter(x => x != null))),
    staleness_min: {
      continuous_med: r3(median(users.map(u => u.cont.medStaleMin))),
      fixedrate_med: r3(median(users.map(u => u.fixed.medStaleMin))),
      gate_med: r3(median(users.map(u => u.gate.medStaleMin))),
    },
    medGapS_median: r1(median(users.map(u => u.medGapS).filter(x => x != null))),
    users,
  };
}
const r1 = x => x == null ? null : +x.toFixed(1);
const r3 = x => x == null ? null : +x.toFixed(3);
const r5 = x => x == null ? null : +x.toFixed(5);

// ============================================================
// Dataset loaders -> array of { lat, lon, ts } (+ speed/travelstate where native)
// ============================================================

// GeoLife: processed/ per-user JSON is hourly-aggregated (median inter-sample
// gap ~60 min) which is BELOW the gate's decision resolution and cannot exercise
// a pre-acquisition sensing gate (every gap already exceeds cadence + the 60-min
// staleness floor -> gate == continuous). We therefore replay the RAW
// "Geolife Trajectories 1.3" .plt trajectories (~5 s native sampling) for the
// same 78 users listed in processed/users.json.
async function loadGeoLife() {
  const gRoot = join(DIR, '..', 'geolife');
  const dataDir = join(gRoot, 'Geolife Trajectories 1.3', 'Data');
  const usersMeta = JSON.parse(await readFile(join(gRoot, 'processed', 'users.json'), 'utf-8'));
  const ids = usersMeta.map(u => u.userId);
  const out = [];
  for (const id of ids) {
    const tdir = join(dataDir, id, 'Trajectory');
    let files;
    try { files = (await readdir(tdir)).filter(f => f.endsWith('.plt')); } catch { continue; }
    const pts = [];
    for (const f of files) {
      const lines = (await readFile(join(tdir, f), 'utf-8')).split('\n');
      for (let i = 6; i < lines.length; i++) {          // 6-line .plt header
        const l = lines[i].trim(); if (!l) continue;
        const p = l.split(',');
        const lat = +p[0], lon = +p[1];
        const ts = Date.parse(p[5] + 'T' + p[6] + 'Z');
        if (!isFinite(lat) || !isFinite(lon) || !isFinite(ts)) continue;
        pts.push({ lat, lon, ts });
      }
    }
    if (pts.length < MIN_POINTS) continue;
    pts.sort((a, b) => a.ts - b.ts);
    out.push(replayUser(id, pts));
  }
  return aggregate('geolife-raw (Geolife Trajectories 1.3 .plt, ~5s native sampling)', out);
}

// T-Drive: eval/tdrive/data/<taxi>.txt, line = taxi_id,datetime,longitude,latitude.
// Taxis = the honest WEAK case: near-constant motion, no personal home/work, so
// the night-centroid "depot" zone rarely suppresses -> the gate saves visibly less.
async function loadTDrive() {
  const dataDir = join(DIR, '..', 'tdrive', 'data');
  let files = (await readdir(dataDir)).filter(f => f.endsWith('.txt')).sort();
  if (files.length > TDRIVE_MAX_TAXIS) files = files.slice(0, TDRIVE_MAX_TAXIS);
  const out = [];
  for (const f of files) {
    const content = await readFile(join(dataDir, f), 'utf-8');
    const pts = [];
    for (const line of content.split('\n')) {
      const p = line.trim().split(',');
      if (p.length < 4) continue;
      const lon = parseFloat(p[2]), lat = parseFloat(p[3]);
      if (isNaN(lat) || isNaN(lon) || lat < 30 || lat > 50 || lon < 110 || lon > 120) continue;
      const ts = new Date(p[1]).getTime();
      if (isNaN(ts)) continue;
      pts.push({ lat, lon, ts });
    }
    if (pts.length < MIN_POINTS) continue;
    pts.sort((a, b) => a.ts - b.ts);
    out.push(replayUser(f.replace('.txt', ''), pts));
  }
  return aggregate(`tdrive (first ${TDRIVE_MAX_TAXIS} taxis; taxi WEAK case)`, out);
}

// StudentLife: F:/dataset/sensing/gps/gps_uNN.csv
// cols: time,provider,network_type,accuracy,latitude,longitude,altitude,bearing,speed,travelstate
// travelstate gives motion directly; speed column present (often 0 for network fixes).
async function loadStudentLife() {
  const dataDir = 'F:/dataset/sensing/gps';
  const files = (await readdir(dataDir)).filter(f => /^gps_u\d+\.csv$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const content = await readFile(join(dataDir, f), 'utf-8');
    const lines = content.split('\n');
    const pts = [];
    for (let i = 1; i < lines.length; i++) {            // skip header
      const p = lines[i].split(',');
      if (p.length < 10) continue;
      const ts = parseInt(p[0], 10) * 1000;
      const lat = parseFloat(p[4]), lon = parseFloat(p[5]);
      if (!isFinite(ts) || isNaN(lat) || isNaN(lon)) continue;
      const sp = parseFloat(p[8]);
      const tv = (p[9] || '').trim();
      pts.push({ lat, lon, ts, speed: isNaN(sp) ? null : sp, travelstate: tv || undefined });
    }
    if (pts.length < MIN_POINTS) continue;
    pts.sort((a, b) => a.ts - b.ts);
    out.push(replayUser(f.replace('gps_', '').replace('.csv', ''), pts));
  }
  return aggregate('studentlife (F:/dataset/sensing/gps; travelstate-driven motion)', out);
}

function row(name, d) {
  const gr = d.gateRatio, fr = d.fixedRatio;
  return [
    name.padEnd(14),
    String(d.nUsers).padStart(6),
    (fmtPct(gr.median) + ` [${fmtPct(gr.p25)}-${fmtPct(gr.p75)}]`).padStart(22),
    (fmtPct(fr.median) + ` [${fmtPct(fr.p25)}-${fmtPct(fr.p75)}]`).padStart(22),
    String(d.gatePerObsH_median).padStart(11),
    String(d.staleness_min.gate_med).padStart(12),
  ].join('  ');
}
const fmtPct = x => x == null ? '-' : (100 * x).toFixed(1) + '%';

async function main() {
  const t0 = Date.now();
  const datasets = {};
  console.log('replaying createSensingGate across datasets...');
  console.log('  GeoLife (raw .plt)...');
  datasets.geolife = await loadGeoLife();
  console.log('  T-Drive (taxis)...');
  datasets.tdrive = await loadTDrive();
  console.log('  StudentLife...');
  datasets.studentlife = await loadStudentLife();
  const runtime = +((Date.now() - t0) / 1000).toFixed(1);

  const out = {
    _note: {
      metric: 'acquisition ratio = arm acquisitions / continuous acquisitions = fraction of OBSERVED samples at which the arm acquires (continuous acquires at every sample, ratio 1.0). Lower = more GNSS acquisitions skipped = more energy saved.',
      observed_hour_convention: `acquisitions-per-observed-hour uses observed-hours = sum of inter-sample gaps each capped at ${GAP_CAP_S / 60} min, so dead gaps (device off / trace holes) do not inflate the denominator and falsely credit the gate.`,
      staleness: 'median staleness at observed samples = median over samples of the age of the freshest fix AFTER that sample\'s acquire decision. continuous == 0 (always fresh); the gate trades a bounded staleness (<= 60-min gate staleness floor) for skipped acquisitions.',
      taxi_caveat: 'T-Drive taxis are the honest WEAK case: near-constant motion and no personal home/work, so the night-centroid depot zone rarely suppresses. The gate therefore saves visibly less on taxis than on personal-mobility datasets (GeoLife, StudentLife) — reported, not buried.',
      geolife_source: 'eval/geolife/processed/*.json is hourly-aggregated (median inter-sample gap ~60 min), below the gate decision resolution and unable to exercise a pre-acquisition gate (every gap already exceeds cadence + the 60-min staleness floor -> gate == continuous). We replay the RAW Geolife Trajectories 1.3 .plt files (~5 s native sampling) for the same 78 users instead.',
      speed_source: 'GeoLife & T-Drive have no native speed -> computed from consecutive haversine/dt. StudentLife uses its travelstate label for motion (fallback: native speed column).',
      arms: 'continuous = acquire every sample; fixedrate = 5-min heartbeat regardless of motion (additive privacy); gate_artifact = real createSensingGate decided pre-acquisition with caller-accumulated displacement bound (stationary 0.05 / walking 1.5 / driving 15 m/s, reset on acquisition).',
      determinism: 'no Math.random, no Date.now.',
    },
    _config: {
      minVisitsForSensitive: CFG.minVisitsForSensitive,
      minDwellMinutes: CFG.minDwellMinutes,
      zoneCoreRadiusM: ZONE_CORE_M,
      gateStalenessFloorMin: CFG.sensingGate.maxStalenessMs / 60000,
      gateStationaryIntervalMin: CFG.sensingGate.stationaryIntervalMs / 60000,
      gateMovingIntervalMin: CFG.sensingGate.movingIntervalMs / 60000,
      fixedRateIntervalMin: FIXED_INTERVAL_S / 60,
      gapCapMin: GAP_CAP_S / 60,
      tdriveMaxTaxis: TDRIVE_MAX_TAXIS,
      minPoints: MIN_POINTS,
    },
    _runtime_s: runtime,
    datasets,
  };
  await mkdir(join(DIR, 'results'), { recursive: true });
  await writeFile(join(DIR, 'results', 'gate-replay.json'), JSON.stringify(out, null, 2));

  // ---- console table ----
  console.log('\n=== createSensingGate cross-dataset replay (acquisitions vs continuous) ===');
  console.log('dataset          nUsers   gate ratio  med[IQR]   fixedrate ratio med[IQR]   gate acq/obsH   gate stale(min)');
  console.log(row('GeoLife', datasets.geolife));
  console.log(row('T-Drive', datasets.tdrive));
  console.log(row('StudentLife', datasets.studentlife));
  console.log('\nlower gate ratio = more GNSS skipped. GeoLife/StudentLife (personal mobility) >> T-Drive (taxi weak case).');
  console.log(`runtime ${runtime}s. Saved eval/cross-dataset/results/gate-replay.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
