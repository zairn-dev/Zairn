/**
 * Corridor-Aware Suppression (CAS) — mechanism prototype + first numbers
 * PoPETs 2028.1 rework of the ZKLS commute-corridor leak.
 *
 * BASELINE (reproduced here, Task 1): plain Grid+Zones zone suppression leaks the
 * commute corridor. Canonical metric (route-corridor-attack.mjs): cells visited
 * >=2x in weekday commute hours {7,8,17,18}, ~500m cells, excluding home/work.
 * GeoLife Grid+Zones recall_med = 0.333 (this script re-derives it, must match).
 *
 * MECHANISM (Task 3): CAS closes the corridor leak with two composable, on-device
 * components, ablated here:
 *   DBR  Directional Buffer Reshaping — learn the disk's over-represented
 *        commute-crossing sectors (Reviewer-B angle signal) and extend the
 *        suppression radius (1000m -> 2500m) ONLY along those bearings, during
 *        commute hours. Anisotropic: hides the corridor entrance where it leaks
 *        while leaving the rest of the disk (and all night-time behaviour) intact.
 *   RCC  Reservoir Crossing Cap — during commute hours cap each emitted grid cell
 *        to a single (seeded-reservoir) emission over the whole trace, so no
 *        non-home/work cell can reach the >=2-visit threshold the attacker needs.
 *   CAS = DBR + RCC.
 *
 * For each variant we report (median over corridor-evaluable users):
 *   corridor precision / recall / F1   (leak — lower is better)
 *   home-disk residual crossing angle  (Rbar / circular var / sectors — Reviewer B)
 *   night home-inference error + <500m exposure (home anchor must NOT regress)
 *   at-home T1 accuracy                (usability)
 *   suppression rate                   (cost)
 * six_layer (full suppression) is included as the "recall 0 but 0 utility" anchor.
 *
 * Output: results/corridor-aware-suppression.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  buildPlaces, corridorCell, corridorFromObs, scoreCorridor, streamToObs,
  emitStream, homeCrossings, angularStats, homeNightError, atHomeT1,
  median, mean,
} from './corridor-lib.mjs';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'corridor-seed';           // reproduce route-corridor-attack.mjs exactly

// Variants: name -> emitStream opts (six_layer handled specially = suppress all).
const VARIANTS = {
  baseline:  { dbr: false, rcc: false, adx: false },
  DBR:       { dbr: true,  rcc: false, adx: false },
  RCC:       { dbr: false, rcc: true,  adx: false },
  CAS:       { dbr: true,  rcc: true,  adx: false },
  'CAS+ADX': { dbr: true,  rcc: true,  adx: true  },
};

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const users = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const names = [...Object.keys(VARIANTS), 'six_layer'];
  const rows = Object.fromEntries(names.map(n => [n, []]));
  let corridorUsers = 0;

  for (const u of users) {
    if (!u.work) continue;
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${u.userId}.json`), 'utf-8'));
    const userSeed = `${SEED}-${u.userId}`;
    const places = buildPlaces(u.home, u.work);
    const home = places[0];

    // Ground-truth corridor (from raw), excluding home/work cells.
    const exclude = new Set([corridorCell(u.home.lat, u.home.lon), corridorCell(u.work.lat, u.work.lon)]);
    const rawObs = locs.map(l => ({ lat: l.lat, lon: l.lon, hour: l.hour, isWeekend: l.isWeekend, suppressed: false }));
    const truth = corridorFromObs(rawObs, exclude);
    if (truth.size < 2) continue;
    corridorUsers++;

    for (const name of names) {
      let stream;
      if (name === 'six_layer') {
        // Full-suppression anchor: nothing outside core is emitted (recall 0, no utility).
        stream = locs.map(l => ({ hour: l.hour, isWeekend: l.isWeekend, day: l.day, lat: l.lat, lon: l.lon, inHomeZone: true, suppressed: true, sLat: null, sLon: null, cellId: null }));
      } else {
        stream = emitStream(locs, places, userSeed, VARIANTS[name]);
      }

      const pred = corridorFromObs(streamToObs(stream), exclude);
      const sc = scoreCorridor(pred, truth) || { precision: 0, recall: 0, f1: 0, predSize: 0, truthSize: truth.size };
      // Residual home-disk crossing angle during commute hours (where the leak lives).
      const ang = angularStats(homeCrossings(stream, home, { commuteOnly: true }));
      const angAll = angularStats(homeCrossings(stream, home, { commuteOnly: false }));
      const emitted = stream.filter(r => !r.suppressed && !r.isDecoy).length;
      const decoys = stream.filter(r => r.isDecoy && !r.suppressed).length;

      rows[name].push({
        userId: u.userId,
        precision: sc.precision, recall: sc.recall, f1: sc.f1, predSize: sc.predSize, truthSize: sc.truthSize,
        Rbar: ang.Rbar, circularVariance: ang.circularVariance, sectorsTouched: ang.sectorsTouched, nCrossings: ang.n,
        RbarAll: angAll.Rbar, sectorsTouchedAll: angAll.sectorsTouched, nCrossingsAll: angAll.n,
        homeNightErr: homeNightError(stream, home),
        t1: atHomeT1(locs, stream, home),
        suppressionRate: 1 - emitted / locs.length,
        decoyOverhead: emitted > 0 ? decoys / emitted : 0,
      });
    }
  }

  const finite = arr => arr.filter(v => v !== null && v !== undefined && Number.isFinite(v));
  const summary = {};
  for (const name of names) {
    const R = rows[name];
    const errs = finite(R.map(r => r.homeNightErr));
    summary[name] = {
      n: R.length,
      corridor: {
        precisionMed: median(R.map(r => r.precision)),
        recallMed: median(R.map(r => r.recall)),
        f1Med: median(R.map(r => r.f1)),
        predSizeMed: median(R.map(r => r.predSize)),
      },
      angle: {
        RbarMed: median(finite(R.map(r => r.Rbar))),
        circularVarianceMed: median(finite(R.map(r => r.circularVariance))),
        sectorsTouchedMed: median(finite(R.map(r => r.sectorsTouched))),
        crossingsMed: median(R.map(r => r.nCrossings)),
      },
      homeInference: {
        nightErrorMed: median(errs),
        exposed500: R.filter(r => Number.isFinite(r.homeNightErr) && r.homeNightErr < 500).length,
      },
      utility: { t1Med: median(finite(R.map(r => r.t1))) },
      cost: {
        suppressionRateMed: median(R.map(r => r.suppressionRate)),
        decoyOverheadMean: mean(R.map(r => r.decoyOverhead)),
        usersWithDecoys: R.filter(r => r.decoyOverhead > 0).length,
      },
    };
  }

  await writeFile(join(RESULTS_DIR, 'corridor-aware-suppression.json'), JSON.stringify({
    _note: 'Corridor-Aware Suppression (CAS) prototype + first numbers, PoPETs 2028.1 rework. '
      + 'baseline == plain Grid+Zones zone suppression; recallMed reproduces route-corridor-attack.mjs '
      + '(GeoLife Grid+Zones = 0.333). DBR = Directional Buffer Reshaping (anisotropic, commute-scoped, '
      + '1000m->2500m along learned corridor sectors); RCC = Reservoir Crossing Cap (one seeded emission '
      + 'per grid cell per commute window); CAS = DBR+RCC. Angle = home-disk residual crossing concentration '
      + '(Reviewer B). Home inference = night (22-06) centroid attack (must not regress vs baseline). '
      + 'Utility = inclusive at-home T1. Deterministic: gridSnap + mulberry32 seeded by "corridor-seed-<userId>"; '
      + 'no Math.random / Date.now. Prototype learns corridor sectors from the full trace (a deployment would '
      + 'use a causal window); mechanism is eval-side only (packages/ untouched, gridSnap imported read-only). '
      + 'six_layer = full-suppression anchor (recall 0 but ~0 utility).',
    config: { seed: SEED, gridSizeM: 500, bufferM: 1000, coreM: 200, rExtM: 2500, kappa: 1.5, nSectors: 12, angleWindow: 'commute-hours' },
    corridorUsers, totalUsers: users.length,
    summary,
    perUser: rows,
  }, null, 2));

  // Console report
  const pct = v => v === null ? ' n/a' : (v * 100).toFixed(0) + '%';
  const num = v => v === null ? 'n/a' : Math.round(v);
  console.log(`\ncorridor-evaluable users: ${corridorUsers}/${users.length}`);
  console.log('\n=== Corridor-Aware Suppression — ablation (medians over corridor users) ===');
  console.log('Corridor recall = Reviewer-A cell leak; Rbar/sectors = Reviewer-B commute-hour entry angle.');
  console.log('variant   | recall | prec | F1   | Rbar | sectors | nightErr | <500 | T1   | suppr | decoy');
  console.log('-'.repeat(96));
  for (const name of names) {
    const s = summary[name];
    console.log(
      name.padEnd(9) + '| ' +
      pct(s.corridor.recallMed).padStart(6) + ' | ' +
      pct(s.corridor.precisionMed).padStart(4) + ' | ' +
      pct(s.corridor.f1Med).padStart(4) + ' | ' +
      (s.angle.RbarMed === null ? 'n/a' : s.angle.RbarMed.toFixed(2)).padStart(4) + ' | ' +
      String(num(s.angle.sectorsTouchedMed)).padStart(7) + ' | ' +
      String(num(s.homeInference.nightErrorMed)).padStart(8) + ' | ' +
      String(s.homeInference.exposed500).padStart(4) + ' | ' +
      pct(s.utility.t1Med).padStart(4) + ' | ' +
      pct(s.cost.suppressionRateMed).padStart(5) + ' | ' +
      (pct(s.cost.decoyOverheadMean) + ` (${s.cost.usersWithDecoys}u)`).padStart(9)
    );
  }
  console.log('\ndecoy column = mean added-emission overhead (users receiving >=1 decoy).');
  console.log('Saved results/corridor-aware-suppression.json');
}

main().catch(e => { console.error(e); process.exit(1); });
