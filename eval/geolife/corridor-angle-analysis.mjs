/**
 * Disk-entry-angle analysis (Reviewer B, PoPETs 2028.1 rework)
 *
 * Reviewer B asked whether a suppressed home disk is inferable from the ANGLES
 * of its boundary crossings: do the emitted fixes that bracket each home-zone
 * exit/entry arrive from diverse bearings, or only from the commute corridor?
 *
 * For each user we run PLAIN zone suppression with the home disk as the sole
 * sensitive place (base 1000m buffer; isolates the home disk, no work-zone
 * confound). We take every boundary-crossing event under that suppression:
 *   - exit  : first emitted fix AFTER the trace leaves the disk
 *   - entry : last emitted fix BEFORE the trace re-enters the disk
 * and compute the bearing home-centre -> crossing point. We then report, per
 * user, the angular concentration of those bearings:
 *   - Rbar               mean resultant length in [0,1] (1 = single bearing)
 *   - circularVariance   1 - Rbar (0 = perfectly corridor-concentrated)
 *   - sectorsTouched     distinct 30-degree sectors hit (of 12)
 * plus the population summary. High Rbar / few sectors == the disk's location
 * and orientation leak through crossing angles (a corridor signature); low
 * Rbar / many sectors == crossings are diffuse and the disk is angle-robust.
 *
 * Output: results/corridor-angle-analysis.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  buildPlaces, emitStream, homeCrossings, angularStats,
  median, mean, quantile,
} from './corridor-lib.mjs';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED = 'corridor-seed';           // same seed family as route-corridor-attack.mjs
const MIN_CROSSINGS = 4;                 // need a few crossings for a stable angle stat

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const users = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));

  const perUser = [];
  for (const u of users) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${u.userId}.json`), 'utf-8'));
    const userSeed = `${SEED}-${u.userId}`;
    const home = { id: 'home', lat: u.home.lat, lon: u.home.lon, radiusM: 200, bufferRadiusM: 1000 };
    // Home-only plain zone suppression.
    const stream = emitStream(locs, [home], userSeed, { homeOnly: true });

    const allB = homeCrossings(stream, home, { commuteOnly: false });
    const comB = homeCrossings(stream, home, { commuteOnly: true });
    const all = angularStats(allB);
    const com = angularStats(comB);
    perUser.push({
      userId: u.userId,
      all: { nCrossings: all.n, Rbar: all.Rbar, circularVariance: all.circularVariance, sectorsTouched: all.sectorsTouched, meanBearing: all.meanBearing },
      commute: { nCrossings: com.n, Rbar: com.Rbar, circularVariance: com.circularVariance, sectorsTouched: com.sectorsTouched, meanBearing: com.meanBearing },
    });
  }

  const summarize = (key) => {
    const rows = perUser.filter(u => u[key].nCrossings >= MIN_CROSSINGS);
    const R = rows.map(u => u[key].Rbar);
    const CV = rows.map(u => u[key].circularVariance);
    const SEC = rows.map(u => u[key].sectorsTouched);
    return {
      nUsers: rows.length,
      medianCrossings: median(rows.map(u => u[key].nCrossings)),
      Rbar: { median: median(R), mean: mean(R), q25: quantile(R, 0.25), q75: quantile(R, 0.75) },
      circularVariance: { median: median(CV), mean: mean(CV) },
      sectorsTouched: { median: median(SEC), mean: mean(SEC), min: Math.min(...SEC), max: Math.max(...SEC) },
      // corridor-concentrated share: how many users look like a single-direction corridor
      fracRbarGe0_5: rows.filter(u => u[key].Rbar >= 0.5).length / rows.length,
      fracRbarGe0_7: rows.filter(u => u[key].Rbar >= 0.7).length / rows.length,
      fracSectorsLe4: rows.filter(u => u[key].sectorsTouched <= 4).length / rows.length,
    };
  };

  const summary = { allHours: summarize('all'), commuteHours: summarize('commute') };

  await writeFile(join(RESULTS_DIR, 'corridor-angle-analysis.json'), JSON.stringify({
    _note: 'Reviewer-B disk-entry-angle analysis (PoPETs 2028.1 rework). Home disk in '
      + 'isolation, plain zone suppression (1000m buffer). Per home-disk boundary crossing '
      + '(exit=first emitted fix after leaving; entry=last emitted fix before entering) we '
      + 'take the bearing home-centre->crossing point and report circular concentration. '
      + 'Rbar=mean resultant length (1=one bearing=corridor); circularVariance=1-Rbar; '
      + `sectorsTouched of ${'12'} 30-degree sectors. Users with >=${MIN_CROSSINGS} crossings only. `
      + 'Deterministic: gridSnap seeded by userSeed="' + SEED + '-<userId>"; no Math.random. '
      + 'Read-only import of gridSnap from packages/sdk/dist; mechanism lives in eval/geolife/corridor-lib.mjs.',
    config: { seed: SEED, minCrossings: MIN_CROSSINGS, nSectors: 12, bufferM: 1000 },
    summary,
    perUser,
  }, null, 2));

  // Console report
  const pct = v => (v * 100).toFixed(0) + '%';
  console.log('\n=== Disk-entry-angle analysis (home disk, plain zone suppression) ===');
  for (const [k, s] of Object.entries(summary)) {
    console.log(`\n[${k}]  users(>=${MIN_CROSSINGS} crossings)=${s.nUsers}  median crossings=${s.medianCrossings}`);
    console.log(`  Rbar            median=${s.Rbar.median.toFixed(3)}  mean=${s.Rbar.mean.toFixed(3)}  IQR=[${s.Rbar.q25.toFixed(3)}, ${s.Rbar.q75.toFixed(3)}]`);
    console.log(`  circular var    median=${s.circularVariance.median.toFixed(3)}`);
    console.log(`  sectors (of 12) median=${s.sectorsTouched.median}  mean=${s.sectorsTouched.mean.toFixed(1)}  range=[${s.sectorsTouched.min}, ${s.sectorsTouched.max}]`);
    console.log(`  corridor-concentrated: Rbar>=0.5 ${pct(s.fracRbarGe0_5)}  Rbar>=0.7 ${pct(s.fracRbarGe0_7)}  <=4 sectors ${pct(s.fracSectorsLe4)}`);
  }
  console.log('\nSaved results/corridor-angle-analysis.json');
}

main().catch(e => { console.error(e); process.exit(1); });
