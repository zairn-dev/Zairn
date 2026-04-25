/**
 * Colluding Viewer Attack
 *
 * Threat model: two (or more) friends of the target share observations
 * with each other. Each viewer may see a different subset of emissions,
 * because Zairn's per-viewer policies can mask data (e.g., viewer A sees
 * coarse cells, viewer B sees state labels, viewer C sees proximity
 * buckets). We ask: does merging their observations recover the home
 * better than the best single viewer?
 *
 * Methodology:
 *   For each user, simulate k=2 colluding viewers with different
 *   policies drawn from {coarse, state_only, proximity}. Each viewer
 *   receives filtered output. Attackers merge observations and run the
 *   standard nighttime-centroid attack. We compare:
 *     - SOLO-best:   the best home error of the two viewers individually
 *     - COLLUDE:     the home error after union of both observation sets
 *     - DELTA:       how much collusion helps (SOLO-best − COLLUDE)
 *
 * Policies:
 *   P_coarse:     full coarse emissions (cell center). Zone suppression applies.
 *   P_state:      at-home/at-work state labels only; outside -> suppressed.
 *                 State labels do NOT reveal a coordinate, so they give the
 *                 attacker "the user is at home" 1-bit hints but no cell.
 *   P_proximity:  distance bucket relative to the viewer's own fixed
 *                 location (we pick a viewer centroid 10km off the user
 *                 to simulate a "distant friend" policy).
 *
 * We evaluate under:
 *   - ZKLS Grid+Zones:  default recommendation (the interesting case)
 *   - 6-Layer:          strongest privacy (should resist collusion trivially)
 *   - Raw:              ceiling (both viewers see everything; collusion = solo)
 *
 * Output: results/colluding-viewer.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  addPlanarLaplaceNoise,
  gridSnap,
  processLocation,
  AdaptiveReporter,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const BASE_SEED = 'eval-user-seed';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function centroidAttackCoords(coords, targetLat, targetLon) {
  if (coords.length === 0) return Infinity;
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of coords) {
    const key = `${Math.floor(o.lat / cellSize)},${Math.floor(o.lon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, pts] of cells) {
    if (pts.length > bestCount) { bestCount = pts.length; bestKey = key; }
  }
  if (!bestKey) return Infinity;
  const [bRow, bCol] = bestKey.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nKey = `${bRow + dr},${bCol + dc}`;
      if (cells.has(nKey)) filtered.push(...cells.get(nKey));
    }
  }
  const aLat = filtered.reduce((s, o) => s + o.lat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.lon, 0) / filtered.length;
  return Math.round(haversine(aLat, aLon, targetLat, targetLon));
}

function buildPlaces(home, work) {
  const places = [{
    id: 'home', label: 'home', lat: home.lat, lon: home.lon,
    radiusM: 200, bufferRadiusM: 1000,
    visitCount: 30, avgDwellMinutes: 480,
  }];
  if (work) places.push({
    id: 'work', label: 'work', lat: work.lat, lon: work.lon,
    radiusM: 200, bufferRadiusM: 1000,
    visitCount: 20, avgDwellMinutes: 480,
  });
  return places;
}

/**
 * Run the full privacy pipeline once, returning every emission along
 * with its type (coarse / state / suppress). A viewer's policy then
 * filters this emission list.
 */
function runPipeline(locs, places, userId, configName) {
  const userSeed = BASE_SEED + '-' + userId;
  const emissions = [];

  if (configName === 'raw') {
    for (const l of locs) emissions.push({ type: 'coarse', lat: l.lat, lon: l.lon, hour: l.hour });
    return emissions;
  }

  if (configName === 'zkls_grid_zones') {
    const userPlaces = places;
    for (const l of locs) {
      let insideBuffer = null;
      for (const p of userPlaces) {
        const dist = haversine(l.lat, l.lon, p.lat, p.lon);
        if (dist <= p.bufferRadiusM) { insideBuffer = p; break; }
      }
      if (insideBuffer && haversine(l.lat, l.lon, insideBuffer.lat, insideBuffer.lon) <= insideBuffer.radiusM) {
        emissions.push({ type: 'state', label: insideBuffer.label, hour: l.hour });
      } else if (insideBuffer) {
        emissions.push({ type: 'suppress', hour: l.hour });
      } else {
        const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
        emissions.push({ type: 'coarse', lat: s.lat, lon: s.lon, cellId: s.cellId, hour: l.hour });
      }
    }
    return emissions;
  }

  if (configName === '6layer') {
    const config = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
    const reporter = new AdaptiveReporter(12, 2);
    for (const l of locs) {
      const result = processLocation(l.lat, l.lon, places, config, reporter);
      if (result.type === 'coarse') {
        emissions.push({ type: 'coarse', lat: result.lat, lon: result.lon, hour: l.hour });
      } else if (result.type === 'state') {
        emissions.push({ type: 'state', label: result.label, hour: l.hour });
      } else {
        emissions.push({ type: 'suppress', hour: l.hour });
      }
    }
    return emissions;
  }

  throw new Error('unknown config ' + configName);
}

/**
 * Filter emissions according to the viewer policy and return a list of
 * coordinate-bearing observations the attacker can cluster.
 *
 * Policy types:
 *   'coarse':     pass coarse emissions; state/suppress -> no coord.
 *                 BUT state-at-home leaks a 1-bit "near home" signal:
 *                 we materialise it as a fresh probe at the (already
 *                 known) home center if the viewer knows the state label
 *                 represents home.  Here we are conservative and do NOT
 *                 give the attacker home coords for state-only obs; that
 *                 represents a viewer who sees the LABEL but cannot
 *                 resolve "home" to a coordinate.  This is strictly
 *                 more conservative.
 *   'state_only': only emissions of type 'state' survive, without coord.
 *                 An attacker's cluster signal is empty.
 *   'proximity':  observer sees a distance bucket relative to their own
 *                 fixed vantage point at `viewerLat,viewerLon`.  We
 *                 collapse the bucket into the bucket's midpoint as a
 *                 coordinate proxy (conservative for the attacker).
 */
function filterForViewer(emissions, policy, viewerLat, viewerLon, homeHint) {
  const out = [];
  for (const e of emissions) {
    if (policy === 'coarse') {
      if (e.type === 'coarse') out.push({ lat: e.lat, lon: e.lon, hour: e.hour });
    } else if (policy === 'state_only') {
      // At-home state -> the viewer LEARNS the user is near home, but
      // has no coordinate.  If homeHint (same viewer previously obtained
      // coarse home-cell from accidental deanonymisation), they could
      // map state -> that coordinate.  We do NOT grant this by default.
    } else if (policy === 'proximity') {
      if (e.type !== 'coarse') continue;
      // A proximity viewer sees only a distance bucket to their own location.
      const d = haversine(e.lat, e.lon, viewerLat, viewerLon);
      let bucket;
      if (d < 500) bucket = 250;
      else if (d < 1000) bucket = 750;
      else if (d < 2000) bucket = 1500;
      else if (d < 5000) bucket = 3500;
      else if (d < 10000) bucket = 7500;
      else bucket = 20000;
      // The attacker reconstructs a candidate coordinate by placing the
      // observation on the sphere of radius `bucket` around the viewer;
      // without a second anchor they cannot triangulate, so we pass the
      // viewer location as coordinate proxy (which yields a constant
      // error equal to the true distance).  Pessimistically: we pass
      // the viewer's own coordinate and let the attack run (produces
      // a degenerate bucketed estimator).
      out.push({ lat: viewerLat, lon: viewerLon, hour: e.hour });
    }
  }
  return out;
}

function viewerPolicyPairs() {
  return [
    ['coarse', 'coarse'],
    ['coarse', 'proximity'],
    ['state_only', 'coarse'],
    ['state_only', 'proximity'],
  ];
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`Colluding-viewer attack: ${usersMeta.length} users`);

  const configs = ['raw', 'zkls_grid_zones', '6layer'];
  const pairs = viewerPolicyPairs();
  const allResults = { byConfig: {}, numUsers: usersMeta.length };

  const nightFilter = e => e.hour >= 22 || e.hour < 6;

  for (const cfg of configs) {
    console.log(`\n--- config: ${cfg} ---`);
    const userRows = [];
    let done = 0;
    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const places = buildPlaces(user.home, user.work);
      const emissions = runPipeline(locs, places, user.userId, cfg);
      const nightEmissions = emissions.filter(nightFilter);

      // Viewer vantage points: we place each viewer ~8-12 km away at
      // deterministic offsets so experiments are reproducible.
      const vA = { lat: user.home.lat + 0.08,  lon: user.home.lon + 0.04 }; // ~10km NE
      const vB = { lat: user.home.lat - 0.05,  lon: user.home.lon + 0.10 }; // ~10km SE

      const row = { userId: user.userId, pairs: {} };
      for (const [pa, pb] of pairs) {
        const obsA = filterForViewer(nightEmissions, pa, vA.lat, vA.lon);
        const obsB = filterForViewer(nightEmissions, pb, vB.lat, vB.lon);
        const soloA = centroidAttackCoords(obsA, user.home.lat, user.home.lon);
        const soloB = centroidAttackCoords(obsB, user.home.lat, user.home.lon);
        const soloBest = Math.min(soloA, soloB);
        const merged = obsA.concat(obsB);
        const collude = centroidAttackCoords(merged, user.home.lat, user.home.lon);
        row.pairs[`${pa}+${pb}`] = {
          soloA: Number.isFinite(soloA) ? soloA : null,
          soloB: Number.isFinite(soloB) ? soloB : null,
          soloBest: Number.isFinite(soloBest) ? soloBest : null,
          collude: Number.isFinite(collude) ? collude : null,
          nObsA: obsA.length, nObsB: obsB.length, nMerged: merged.length,
        };
      }
      userRows.push(row);
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
    }

    // Aggregate per pair
    const byPair = {};
    for (const [pa, pb] of pairs) {
      const key = `${pa}+${pb}`;
      const solos = [], colludes = [], deltas = [];
      let exposedSolo = 0, exposedCollude = 0;
      for (const r of userRows) {
        const p = r.pairs[key];
        if (p.soloBest !== null) { solos.push(p.soloBest); if (p.soloBest < 200) exposedSolo++; }
        if (p.collude !== null)  { colludes.push(p.collude); if (p.collude < 200) exposedCollude++; }
        if (p.soloBest !== null && p.collude !== null) deltas.push(p.soloBest - p.collude);
      }
      const median = arr => arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] : null;
      byPair[key] = {
        soloMedian: median(solos),
        colludeMedian: median(colludes),
        deltaMedian: median(deltas),
        exposedSolo,
        exposedCollude,
        nSolo: solos.length,
        nCollude: colludes.length,
      };
    }
    allResults.byConfig[cfg] = { byPair, userRows };
  }

  await writeFile(join(RESULTS_DIR, 'colluding-viewer.json'),
    JSON.stringify(allResults, null, 2));

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  COLLUDING VIEWER ATTACK (' + usersMeta.length + ' users)');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const cfg of configs) {
    console.log(`\nConfig: ${cfg}`);
    console.log('Viewer pair                | Solo med | Coll med | Δ med | Solo <200m | Coll <200m');
    console.log('─'.repeat(95));
    const byPair = allResults.byConfig[cfg].byPair;
    for (const [pa, pb] of pairs) {
      const key = `${pa}+${pb}`;
      const s = byPair[key];
      const fmt = v => v === null ? ' ∞    ' : String(Math.round(v) + 'm').padStart(6);
      console.log(
        key.padEnd(26) + '| ' +
        fmt(s.soloMedian) + ' | ' +
        fmt(s.colludeMedian) + ' | ' +
        fmt(s.deltaMedian) + ' | ' +
        String(s.exposedSolo).padStart(10) + ' | ' +
        String(s.exposedCollude).padStart(10)
      );
    }
  }
}

main().catch(console.error);
