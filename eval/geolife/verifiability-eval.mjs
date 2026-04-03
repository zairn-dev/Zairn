/**
 * Verifiability Evaluation — Why ZK proofs matter for state sharing
 *
 * Scenario: A user claims "At home" (state-only) but is actually elsewhere.
 * Without ZK: the server/friends trust the state label blindly.
 * With ZK: the departure proof cryptographically verifies the claim.
 *
 * We evaluate:
 * 1. How often could a cheating user fake "at home" without ZK?
 * 2. What attack surface does unverified state sharing create?
 * 3. How does ZK verification close this gap?
 *
 * Attack model: "Alibi attack" — user claims to be at home while
 * actually at a different location (e.g., sneaking out, faking presence).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Verifiability evaluation: ${usersMeta.length} users\n`);

  // For each user, count observations where:
  // - User is NOT at home (>200m from home)
  // - But COULD falsely claim "at home" in a state-only system (no ZK)
  // - ZK grid membership proof would CATCH the lie (wrong cell)
  // - ZK departure proof would CATCH the lie (distance > threshold)

  let totalObs = 0;
  let outsideHome = 0;       // truly not at home
  let couldFakeState = 0;    // could claim "at home" without detection (no ZK)
  let zkGridCatches = 0;     // ZK grid membership would detect (different cell)
  let zkDepartureCatches = 0; // ZK departure proof would detect (distance > D)
  let nightFakeOpportunity = 0; // nighttime fake opportunities (most suspicious)
  let nightZkCatches = 0;

  const GRID_SIZE_M = 500;
  const HOME_THRESHOLD = 200;   // "at home" core zone
  const DEPARTURE_THRESHOLD = 1000; // departure proof threshold

  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    const home = user.home;

    // Compute home grid cell (deterministic)
    const gridSizeLat = GRID_SIZE_M / 111320;
    const gridSizeLon = GRID_SIZE_M / (111320 * Math.cos(home.lat * Math.PI / 180));
    const homeCellRow = Math.floor(home.lat / gridSizeLat);
    const homeCellCol = Math.floor(home.lon / gridSizeLon);

    for (const l of locs) {
      totalObs++;
      const dist = haversine(l.lat, l.lon, home.lat, home.lon);

      if (dist > HOME_THRESHOLD) {
        outsideHome++;

        // Without ZK: user can claim any state label. Server trusts it.
        // This is a "fake opportunity".
        couldFakeState++;

        // With ZK grid membership: user must prove they're in the home cell.
        // If they're in a different cell, the proof fails.
        const userCellRow = Math.floor(l.lat / gridSizeLat);
        const userCellCol = Math.floor(l.lon / gridSizeLon);
        const differentCell = (userCellRow !== homeCellRow || userCellCol !== homeCellCol);
        if (differentCell) zkGridCatches++;

        // With ZK departure proof: user must prove distance < D.
        // If distance > D, they can't produce the proof.
        if (dist > DEPARTURE_THRESHOLD) zkDepartureCatches++;

        // Nighttime fakes are most suspicious
        if (l.hour >= 22 || l.hour < 6) {
          nightFakeOpportunity++;
          if (differentCell) nightZkCatches++;
        }
      }
    }
  }

  const results = {
    totalObservations: totalObs,
    outsideHome,
    fakeOpportunities: couldFakeState,
    fakeRate: +(couldFakeState / totalObs * 100).toFixed(1),
    zkGridDetectionRate: +(zkGridCatches / couldFakeState * 100).toFixed(1),
    zkDepartureDetectionRate: +(zkDepartureCatches / couldFakeState * 100).toFixed(1),
    nighttimeFakeOpportunities: nightFakeOpportunity,
    nighttimeZkDetectionRate: nightFakeOpportunity > 0
      ? +(nightZkCatches / nightFakeOpportunity * 100).toFixed(1) : 0,
    summary: {
      withoutZk: 'User can fake any state label at any time. ' +
        couldFakeState + ' opportunities across ' + usersMeta.length + ' users.',
      withZkGrid: 'Grid membership proof catches ' + zkGridCatches + '/' +
        couldFakeState + ' (' + (zkGridCatches / couldFakeState * 100).toFixed(1) +
        '%) of fake attempts.',
      withZkDeparture: 'Departure proof catches ' + zkDepartureCatches + '/' +
        couldFakeState + ' (' + (zkDepartureCatches / couldFakeState * 100).toFixed(1) +
        '%) of fake attempts (>1km from home).',
    },
  };

  console.log('=== Verifiability Evaluation ===\n');
  console.log(`Total observations: ${totalObs}`);
  console.log(`Outside home (>200m): ${outsideHome} (${results.fakeRate}%)`);
  console.log('');
  console.log('WITHOUT ZK:');
  console.log(`  Fake "at home" opportunities: ${couldFakeState}`);
  console.log(`  (User can claim any state; server trusts blindly)`);
  console.log('');
  console.log('WITH ZK Grid Membership:');
  console.log(`  Detected: ${zkGridCatches}/${couldFakeState} (${results.zkGridDetectionRate}%)`);
  console.log(`  (User must prove they are in the home grid cell)`);
  console.log('');
  console.log('WITH ZK Departure Proof:');
  console.log(`  Detected: ${zkDepartureCatches}/${couldFakeState} (${results.zkDepartureDetectionRate}%)`);
  console.log(`  (User must prove distance < 1km; catches those farther away)`);
  console.log('');
  console.log('NIGHTTIME (22:00-06:00):');
  console.log(`  Fake opportunities: ${nightFakeOpportunity}`);
  console.log(`  ZK grid catches: ${results.nighttimeZkDetectionRate}%`);

  await writeFile(join(RESULTS_DIR, 'verifiability.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved.');
}

main().catch(console.error);
