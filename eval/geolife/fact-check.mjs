/**
 * Comprehensive fact check — verify all paper numbers against eval data.
 */
import { readFile } from 'fs/promises';

const main = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/attack-results.json', 'utf-8'));
const abl = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/ablation.json', 'utf-8'));
const util = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/utility.json', 'utf-8'));
const conv = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/convergence.json', 'utf-8'));
const perf = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/performance.json', 'utf-8'));
const place = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/place-detection.json', 'utf-8'));
const trans = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/transition-attack.json', 'utf-8'));
const e2e = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/end-to-end.json', 'utf-8'));
const sharing = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/results/sharing-utility-comparison.json', 'utf-8'));
const users = JSON.parse(await readFile('F:/work/openZenly/eval/geolife/processed/users.json', 'utf-8'));

const errors = [];
function check(label, paper, data, tol = 0) {
  if (paper === data) return;
  if (typeof paper === 'number' && typeof data === 'number' && Math.abs(paper - data) <= tol) return;
  errors.push(`${label}: paper=${paper} data=${data}`);
}

console.log('=== COMPREHENSIVE FACT CHECK ===\n');

// 1. User count
check('User count', 78, users.length);
console.log('Users: ' + users.length);

// 2. Table 5 (main results)
console.log('\n--- Table 5: Main Results ---');
const methods = ['raw', 'laplace_grid', 'six_layer', 'zkls_grid', 'zkls_grid_zones', 'zkls_full'];
const paperT5 = {
  raw:              { p25: 242, med: 616, p75: 3027, e200: 15, e500: 34 },
  laplace_grid:     { p25: 374, med: 687, p75: 1670, e200: 9, e500: 30 },
  six_layer:        { p25: 5183, med: 9020, p75: 26472, e200: 3, e500: 3 },
  zkls_grid:        { p25: 287, med: 639, p75: 2965, e200: 11, e500: 32 },
  zkls_grid_zones:  { p25: 2896, med: 6535, p75: 22992, e200: 0, e500: 0 },
  zkls_full:        { p25: 1379, med: 3652, p75: 14308, e200: 5, e500: 8 },
};
for (const m of methods) {
  const errs = main.map(r => r.results[m].homeAttack.error).filter(e => e < Infinity).sort((a, b) => a - b);
  const p25 = errs[Math.floor(errs.length * 0.25)];
  const med = errs[Math.floor(errs.length * 0.5)];
  const p75 = errs[Math.floor(errs.length * 0.75)];
  const e200 = main.filter(r => r.results[m].homeAttack.error < 200).length;
  const e500 = main.filter(r => r.results[m].homeAttack.error < 500).length;
  const p = paperT5[m];
  check(m + ' p25', p.p25, p25); check(m + ' med', p.med, med); check(m + ' p75', p.p75, p75);
  check(m + ' e200', p.e200, e200); check(m + ' e500', p.e500, e500);
}
console.log('Table 5 done');

// 3. Table 6 (convergence)
console.log('\n--- Table 6: Convergence ---');
const paperConv = {
  raw: [4352, 1064, 845, 710, 687, 616],
  laplace_grid: [4874, 2012, 1296, 1113, 830, 687],
  six_layer: [10983, 10624, 9020, 9113, 9113, 9113],
  zkls_grid_zones: [5686, 6368, 6606, 5232, 6449, 6535],
  zkls_full: [4836, 4919, 4836, 4778, 4778, 4836],
};
for (const m of Object.keys(paperConv)) {
  for (let i = 0; i < 6; i++) {
    check(m + ' d' + [1, 7, 14, 30, 60, 90][i], paperConv[m][i], conv[m][i].median);
  }
}
console.log('Table 6 done');

// 4. Place detection
console.log('\n--- Table 7: Place Detection ---');
for (const w of [14, 30, 60, 90]) {
  const d = place.find(p => p.windowDays === w);
  console.log(`  ${w}d: homeRate=${d.homeDetectionRate} homeErr=${d.homeMedianError}m workRate=${d.workDetectionRate}`);
}
const pd90 = place.find(p => p.windowDays === 90);
check('90d homeRate', 0.73, pd90.homeDetectionRate);
check('90d homeErr', 75, pd90.homeMedianError);
check('90d workRate', 0.33, pd90.workDetectionRate);
console.log('Table 7 done');

// 5. Utility (Table 8) - updated
console.log('\n--- Table 8: Utility ---');
const us = util.summary;
check('gz presF1', 0.80, us.zkls_grid_zones.presenceF1.median);
check('gz area', 0.89, us.zkls_grid_zones.areaAccuracy.median, 0.01);
check('gz avail (paper=0.80)', 0.80, us.zkls_grid_zones.temporalAvailability.median, 0.02);
check('6l avail (paper=0.28)', 0.28, us.six_layer.temporalAvailability.median, 0.02);
check('laplace F1 (paper=0.09)', 0.09, us.laplace_grid.presenceF1.median, 0.02);
console.log('Table 8 done');

// 6. Sharing (Table 9)
console.log('\n--- Table 9: Sharing ---');
const sh = sharing;
check('gz atHome', 94, Math.round(sh.zkls_grid_zones.task1_atHome), 1);
check('gz neigh', 88, Math.round(sh.zkls_grid_zones.task3_neighborhood), 1);
check('gz avail', 77, Math.round(sh.zkls_grid_zones.availability), 1);
check('6l neigh', 37, Math.round(sh.six_layer.task3_neighborhood), 1);
check('6l avail', 27, Math.round(sh.six_layer.availability), 1);
check('laplace neigh', 35, Math.round(sh.laplace_grid.task3_neighborhood), 1);
check('zkls_grid neigh', 86, Math.round(sh.zkls_grid.task3_neighborhood), 1);
console.log('Table 9 done');

// 7. E2E (Table E2E)
console.log('\n--- Table E2E ---');
check('oracle med', 6739, e2e.oracle.medianError);
check('detected med', 4926, e2e.detected.medianError);
check('det+manual med', 5622, e2e['detected+manual'].medianError);
check('det e200', 7, e2e.detected.exposed200);
check('det+manual e200', 0, e2e['detected+manual'].exposed200);
check('det+manual e500', 1, e2e['detected+manual'].exposed500);
console.log('E2E done');

// 8. Ablation (Table 10)
console.log('\n--- Table 10: Ablation ---');
const ab = abl.summary;
check('full', 10669, ab.full.medianError);
check('no_laplace', 6739, ab.no_laplace.medianError);
check('no_grid', 4592, ab.no_grid.medianError);
check('no_zones', 3083, ab.no_zones.medianError);
check('no_zones e500', 5, ab.no_zones.riskyCount);
check('no_adaptive', 5448, ab.no_adaptive.medianError);
check('none', 616, ab.none.medianError);
console.log('Table 10 done');

// 9. Performance
console.log('\n--- Performance ---');
check('grid p50', 65.6, perf.grid_membership?.p50);
check('dep p50', 81.3, perf.departure?.p50);
console.log('Performance done');

// 10. Transition attack
console.log('\n--- Transition ---');
check('trans med', 4352, trans.medianError);
check('trans e500', 0, trans.exposed500);
check('trans users', 64, trans.usersWithTransitions);
console.log('Transition done');

// 11. Abstract specific claims
console.log('\n--- Abstract Claims ---');
// "zone-suppressed configurations maintain stable 5,000-10,000m"
const gz90 = conv.zkls_grid_zones[5].median;
const sl90 = conv.six_layer[5].median;
check('GZ 90d in 5k-10k', true, gz90 >= 5000 && gz90 <= 10000);
check('6L 90d in 5k-10k', true, sl90 >= 5000 && sl90 <= 10000);
// "71% degradation on removal"
const deg = Math.round((1 - ab.no_zones.medianError / ab.full.medianError) * 100);
check('zone deg%', 71, deg);
// "17x improvement"
const ratio = Math.round(ab.full.medianError / ab.none.medianError);
check('full/none ratio', 17, ratio);
console.log('Abstract done');

// 12. Body text specific
console.log('\n--- Body Text ---');
// "94% at-home query"
check('at home task', 94, Math.round(sh.zkls_grid_zones.task1_atHome), 1);
// "76% departures within 1h" (six_layer)
check('dep 1h', 77, sh.six_layer.depWithin1h, 2);
// "Laplace destroys neighborhood (35%)"
check('lap neigh', 35, Math.round(sh.laplace_grid.task3_neighborhood), 1);
// "ZKLS Grid 86% neighborhood"
check('zkls_grid neigh', 86, Math.round(sh.zkls_grid.task3_neighborhood), 1);
// "detected+manual within 16% of oracle"
const oracleErr = e2e.oracle.medianError;
const manualErr = e2e['detected+manual'].medianError;
const pctDiff = Math.round((1 - manualErr / oracleErr) * 100);
console.log('Oracle vs manual: ' + oracleErr + ' vs ' + manualErr + ' = ' + pctDiff + '% diff (paper says 16%)');
check('e2e pct diff', 16, pctDiff, 2);

console.log('\n=== SUMMARY ===');
if (errors.length === 0) {
  console.log('ALL CHECKS PASSED ✓');
} else {
  console.log(errors.length + ' ISSUES:');
  for (const e of errors) console.log('  ✗ ' + e);
}
