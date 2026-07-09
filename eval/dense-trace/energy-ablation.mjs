/**
 * De-risk ablation (PC-only, no device) for the IMWUT "privacy as a sensing
 * scheduler" thesis. Question: does moving the privacy decision BEFORE GNSS
 * acquisition (a sensing gate) meaningfully cut GNSS duty cycle on a real
 * always-on trace, and does additive privacy (fixed-rate heartbeat) cost more?
 *
 * Primary metric = GNSS acquisitions/hour (exact, device-independent).
 * Energy = modeled overlay calibrated to the measured 37.6h baseline
 *   (GNSS = 70.9% of 129.4 mAh/h = 91.7 mAh/h when effectively continuous).
 * Absolute energy/thermal needs device confirmation (future work) — this
 * ablation only decides whether the duty-cycle lever exists and is large.
 *
 * Trace: eval/dense-trace/clean-segABC.json (30,516 pts, ~1/min, Tokyo).
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { detectSensitivePlaces, DEFAULT_PRIVACY_CONFIG, createSensingGate } from '../../packages/sdk/dist/privacy-location.js';

const DIR = import.meta.dirname;

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, p = Math.PI / 180;
  const a = Math.min(1, Math.sin((la2-la1)*p/2)**2 + Math.cos(la1*p)*Math.cos(la2*p)*Math.sin((lo2-lo1)*p/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- energy model (calibrated to measured baseline) ---
const GNSS_CONT_MAH_PER_H = 91.7;        // measured: 70.9% of 129.4 mAh/h, effectively-continuous (~1/min keeps engine warm)
const TTFF_S = 30;                        // modeled cold time-to-first-fix per gated acquisition
const E_PER_COLD_FIX = GNSS_CONT_MAH_PER_H * (TTFF_S / 3600); // mAh per gated acquisition

// adaptive cadence params (from DEFAULT_PRIVACY_CONFIG: 12/h moving, 2/h stationary)
const MOVE_SPEED = 0.7;                   // m/s; below = stationary (cheap accelerometer/step proxy)
const MOVE_INTERVAL_S = 3600 / DEFAULT_PRIVACY_CONFIG.maxReportsPerHourMoving;       // 300s
const STAT_MAX_INTERVAL_S = 3600 / DEFAULT_PRIVACY_CONFIG.maxReportsPerHourStationary; // 1800s
const ZONE_CORE_M = DEFAULT_PRIVACY_CONFIG.defaultZoneRadiusM; // 200m
const ZONE_EXIT_CHECK_S = 3600;           // while in a suppressed zone, 1 cheap GNSS departure-check/h (conservative)
const FIXED_INTERVAL_S = 5 * 60;          // FixedRateReporter default = 5min (12/h) regardless of motion

// upper-bound speeds for the caller-side displacement accumulator (m/s);
// stationary ≈ accelerometer-verified non-movement (GPS-jitter allowance only)
const DISP_BOUND_MPS = { stationary: 0.05, walking: 1.5, driving: 15 };

function simulate(trace, places, policy, gate = null) {
  let nAcq = 0, inZoneTime = 0, statTime = 0, movTime = 0;
  let lastAcqTs = -Infinity, stationaryStreak = 0, prevTs = trace[0].ts;
  let lastFix = null;                                    // for gate_artifact: last ACQUIRED fix only
  let dispBoundM = 0;                                    // caller-accumulated movement bound since lastFix
  const gaps = []; // inter-acquisition gaps (s) for gated policies
  const gateReasons = {};

  for (const pt of trace) {
    const dtPrev = (pt.ts - prevTs) / 1000; prevTs = pt.ts;
    const moving = (pt.speed ?? 0) > MOVE_SPEED;
    if (moving) movTime += dtPrev; else statTime += dtPrev;
    const inZone = places.some(pl => haversine(pt.lat, pt.lon, pl.lat, pl.lon) <= ZONE_CORE_M);
    if (inZone) inZoneTime += dtPrev;
    const sinceAcq = (pt.ts - lastAcqTs) / 1000;

    let acquire = false;
    if (policy === 'gate_artifact') {
      // the REAL shipped artifact: SDK createSensingGate decides pre-acquisition
      const motion = !moving ? 'stationary' : (pt.speed ?? 0) > 5 ? 'driving' : 'walking';
      dispBoundM += dtPrev * DISP_BOUND_MPS[motion];     // cheap-sensor movement bound
      const d = gate.shouldAcquire({ now: pt.ts, lastFix, motion, maxDisplacementM: dispBoundM });
      acquire = d.acquire;
      if (acquire) gateReasons[d.reason] = (gateReasons[d.reason] ?? 0) + 1;
    } else if (policy === 'continuous' || policy === 'naive') {
      acquire = true;                                    // acquire every sample (privacy, if any, is post-acquisition)
    } else if (policy === 'fixedrate') {
      acquire = sinceAcq >= FIXED_INTERVAL_S;            // additive privacy: fixed heartbeat regardless of motion
    } else { // adaptive  |  adaptive_zones
      if (policy === 'adaptive_zones' && inZone && !moving) {
        acquire = sinceAcq >= ZONE_EXIT_CHECK_S;         // sensing-gate: skip GNSS in suppressed zone (cheap exit-check only)
      } else if (moving) {
        acquire = sinceAcq >= MOVE_INTERVAL_S;
      } else {
        const backoff = Math.min(MOVE_INTERVAL_S * 2 ** Math.min(stationaryStreak, 6), STAT_MAX_INTERVAL_S);
        acquire = sinceAcq >= backoff;
      }
    }

    if (acquire) {
      if (lastAcqTs > -Infinity) gaps.push(sinceAcq);
      nAcq++;
      if (moving) stationaryStreak = 0; else stationaryStreak++;
      lastAcqTs = pt.ts;
      lastFix = { lat: pt.lat, lon: pt.lon, timestamp: pt.ts };
      dispBoundM = 0;
    }
  }

  const spanH = (trace[trace.length-1].ts - trace[0].ts) / 3.6e6;
  const acqPerH = nAcq / spanH;
  // energy: continuous/naive hold GNSS warm => flat; gated => per-cold-fix
  const mahPerH = (policy === 'continuous' || policy === 'naive')
    ? GNSS_CONT_MAH_PER_H
    : acqPerH * E_PER_COLD_FIX;
  return {
    policy, nAcq, acqPerH: +acqPerH.toFixed(2),
    gnss_mAh_per_day: +(mahPerH * 24).toFixed(1),
    medianGapMin: gaps.length ? +(gaps.sort((a,b)=>a-b)[gaps.length>>1]/60).toFixed(1) : null,
    ...(Object.keys(gateReasons).length ? { gateReasons } : {}),
  };
}

async function main() {
  const raw = JSON.parse(await readFile(join(DIR, 'clean-segABC.json'), 'utf-8'));
  const trace = Array.isArray(raw) ? raw : raw.trace;
  const spanH = (trace[trace.length-1].ts - trace[0].ts) / 3.6e6;

  // detect home/work on-device from the trace itself (the real code path)
  const cfg = { ...DEFAULT_PRIVACY_CONFIG };
  let places = detectSensitivePlaces(trace.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.timestamp })), cfg);
  if (places.length === 0) {
    // fallback: night-time centroid as home
    const night = trace.filter(p => p.hour >= 22 || p.hour < 6);
    const hl = night.reduce((s,p)=>s+p.lat,0)/night.length, ho = night.reduce((s,p)=>s+p.lon,0)/night.length;
    places = [{ label: 'home', lat: hl, lon: ho, radiusM: ZONE_CORE_M }];
  }

  // % of trace time spent in a detected core zone (explains the gate's win)
  let inZ = 0, prev = trace[0].ts;
  for (const pt of trace) { const dt=(pt.ts-prev)/1000; prev=pt.ts; if (places.some(pl=>haversine(pt.lat,pt.lon,pl.lat,pl.lon)<=ZONE_CORE_M)) inZ+=dt; }
  const totSec = (trace[trace.length-1].ts - trace[0].ts)/1000;

  const gate = createSensingGate(cfg, places.map(p => ({ ...p, radiusM: p.radiusM ?? ZONE_CORE_M })));
  const policies = ['continuous','naive','fixedrate','adaptive','adaptive_zones','gate_artifact'];
  const rows = policies.map(p => simulate(trace, places, p, gate));
  const cont = rows.find(r=>r.policy==='continuous');
  for (const r of rows) {
    r.pct_of_continuous_acq = +(100*r.acqPerH/cont.acqPerH).toFixed(1);
    r.energy_reduction_vs_continuous_pct = +(100*(1 - r.gnss_mAh_per_day/cont.gnss_mAh_per_day)).toFixed(1);
  }

  const out = {
    _trace: { points: trace.length, span_hours: +spanH.toFixed(1), sample_per_h: +(trace.length/spanH).toFixed(1) },
    _detected_places: places.map(p=>({label:p.label, visitCount:p.visitCount, lat:+p.lat.toFixed(4), lon:+p.lon.toFixed(4)})),
    _pct_time_in_core_zone: +(100*inZ/totSec).toFixed(1),
    _energy_model: { GNSS_CONT_MAH_PER_H, TTFF_S, note: 'continuous holds GNSS warm; gated pays per-cold-fix; absolute mAh needs device confirmation' },
    results: rows,
  };
  await writeFile(join(DIR, 'results', 'energy-ablation.json'), JSON.stringify(out, null, 2));

  console.log(`trace: ${trace.length} pts, ${spanH.toFixed(1)}h, ${(trace.length/spanH).toFixed(1)}/h sampling`);
  console.log(`detected zones: ${out._detected_places.map(p=>p.label).join(', ')||'(none→night centroid)'}; time in core zone: ${out._pct_time_in_core_zone}%`);
  console.log('\npolicy            acq/h   %ofCont   GNSS mAh/day   E-reduction   medGap(min)');
  for (const r of rows) {
    console.log(
      r.policy.padEnd(16),
      String(r.acqPerH).padStart(6),
      String(r.pct_of_continuous_acq+'%').padStart(8),
      String(r.gnss_mAh_per_day).padStart(12),
      String(r.energy_reduction_vs_continuous_pct+'%').padStart(12),
      String(r.medianGapMin??'-').padStart(11),
    );
  }
  console.log('\nSaved results/energy-ablation.json');
}
main().catch(e=>{console.error(e);process.exit(1)});
