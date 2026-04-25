/**
 * POI-Prior Auxiliary Information Attack
 *
 * Threat model: the attacker has auxiliary information in the form of
 * a list of candidate POIs (transit stations, landmarks, commercial
 * buildings) and snaps the cluster centroid to the nearest POI in the
 * list.  This models a realistic attacker who knows the user lives
 * somewhere in a specific city and has a public POI database.
 *
 * We build the POI list from the ground truth homes themselves with a
 * small amount of spatial jitter — this is a *pessimistic* (strong)
 * attacker model that simulates complete knowledge of plausible home
 * candidates.  We also report against a much larger random-sampled
 * POI list (one POI per 2 km grid cell across Beijing) as a more
 * realistic attacker.
 *
 * For each of the four main defence configurations we run:
 *   (a) plain centroid attack (baseline, from main results)
 *   (b) POI-snapped attack using a strong POI list (all GT homes)
 *   (c) POI-snapped attack using a wide POI list (~2 km grid)
 *
 * We then compute:
 *   - median home error under each attack
 *   - exposed users <200m / <500m
 *   - delta vs. baseline (how much does POI prior help the attacker?)
 *
 * Output: results/poi-prior.json
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
const SEED = 'eval-user-seed';
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

// -------- centroid attack (same as main) --------
function clusterCentroid(obs) {
  if (obs.length === 0) return null;
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, pts] of cells) {
    if (pts.length > bestCount) { bestCount = pts.length; bestKey = key; }
  }
  if (!bestKey) return null;
  const [bRow, bCol] = bestKey.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nKey = `${bRow + dr},${bCol + dc}`;
      if (cells.has(nKey)) filtered.push(...cells.get(nKey));
    }
  }
  return {
    lat: filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length,
    lon: filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length,
  };
}

function snapToPOI(lat, lon, poiList) {
  let best = null, bestD = Infinity;
  for (const p of poiList) {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function buildSensitivePlaces(home, work) {
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

function runDefense(locs, home, work, userId, cfg) {
  const userSeed = SEED + '-' + userId;
  const obs = [];

  if (cfg === 'raw') {
    for (const l of locs) obs.push({ ...l, sLat: l.lat, sLon: l.lon });
    return obs;
  }

  if (cfg === 'laplace_grid') {
    for (const l of locs) {
      const n = addPlanarLaplaceNoise(l.lat, l.lon, BASE_EPSILON);
      const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, userSeed);
      obs.push({ ...l, sLat: s.lat, sLon: s.lon });
    }
    return obs;
  }

  const places = buildSensitivePlaces(home, work);

  if (cfg === 'zkls_grid_zones') {
    for (const l of locs) {
      let inside = false;
      for (const p of places) {
        if (haversine(l.lat, l.lon, p.lat, p.lon) <= p.bufferRadiusM) { inside = true; break; }
      }
      if (inside) continue;
      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      obs.push({ ...l, sLat: s.lat, sLon: s.lon });
    }
    return obs;
  }

  if (cfg === '6layer') {
    const config = { ...DEFAULT_PRIVACY_CONFIG, gridSeed: userSeed, baseEpsilon: BASE_EPSILON };
    const reporter = new AdaptiveReporter(12, 2);
    for (const l of locs) {
      const r = processLocation(l.lat, l.lon, places, config, reporter);
      if (r.type === 'coarse') obs.push({ ...l, sLat: r.lat, sLon: r.lon });
    }
    return obs;
  }

  throw new Error('bad cfg ' + cfg);
}

function buildGridPOIs(homes) {
  // One POI at each 2km grid cell covering the bounding box of all homes,
  // expanded slightly.  This is ~500-2000 POIs for the Beijing area.
  let latMin=90,latMax=-90,lonMin=180,lonMax=-180;
  for (const h of homes) {
    if (h.lat < latMin) latMin = h.lat;
    if (h.lat > latMax) latMax = h.lat;
    if (h.lon < lonMin) lonMin = h.lon;
    if (h.lon > lonMax) lonMax = h.lon;
  }
  const padDeg = 0.05;
  latMin -= padDeg; latMax += padDeg; lonMin -= padDeg; lonMax += padDeg;
  const step = 0.02; // ~2km
  const out = [];
  for (let lat = latMin; lat <= latMax; lat += step) {
    for (let lon = lonMin; lon <= lonMax; lon += step) {
      out.push({ lat, lon });
    }
  }
  return out;
}

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const usersMeta = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  console.log(`POI-prior attack: ${usersMeta.length} users`);

  // --- Build two POI lists ---
  const strongPOIs = usersMeta.map(u => u.home); // strong: all 78 true homes
  const widePOIs   = buildGridPOIs(strongPOIs);   // wide: 2 km grid across bbox
  console.log(`POI lists: strong=${strongPOIs.length}, wide=${widePOIs.length}`);

  const configs = ['raw', 'laplace_grid', 'zkls_grid_zones', '6layer'];
  const attacks = ['baseline', 'poi_strong', 'poi_wide'];

  const nightFilter = o => o.hour >= 22 || o.hour < 6;
  const results = {};
  for (const c of configs) results[c] = {};
  for (const c of configs) for (const a of attacks) results[c][a] = [];

  let done = 0;
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
    for (const c of configs) {
      const obs = runDefense(locs, user.home, user.work, user.userId, c);
      const nightObs = obs.filter(nightFilter);
      const centroid = clusterCentroid(nightObs);

      const attackErrs = { baseline: null, poi_strong: null, poi_wide: null };
      if (centroid !== null) {
        attackErrs.baseline = Math.round(haversine(centroid.lat, centroid.lon, user.home.lat, user.home.lon));

        const snapStrong = snapToPOI(centroid.lat, centroid.lon, strongPOIs);
        attackErrs.poi_strong = Math.round(haversine(snapStrong.lat, snapStrong.lon, user.home.lat, user.home.lon));

        const snapWide = snapToPOI(centroid.lat, centroid.lon, widePOIs);
        attackErrs.poi_wide = Math.round(haversine(snapWide.lat, snapWide.lon, user.home.lat, user.home.lon));
      }

      for (const a of attacks) {
        results[c][a].push({ userId: user.userId, err: attackErrs[a] });
      }
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${usersMeta.length}`);
  }

  // --- Summarise ---
  const median = arr => {
    const xs = arr.filter(x => x !== null && Number.isFinite(x)).sort((a,b) => a-b);
    return xs.length ? xs[Math.floor(xs.length * 0.5)] : null;
  };
  const summary = {};
  for (const c of configs) {
    summary[c] = {};
    for (const a of attacks) {
      const rows = results[c][a];
      const errs = rows.map(r => r.err);
      summary[c][a] = {
        median: median(errs),
        exposed200: rows.filter(r => r.err !== null && r.err < 200).length,
        exposed500: rows.filter(r => r.err !== null && r.err < 500).length,
        n: errs.filter(e => e !== null).length,
      };
    }
  }

  await writeFile(join(RESULTS_DIR, 'poi-prior.json'),
    JSON.stringify({ summary, poiCounts: { strong: strongPOIs.length, wide: widePOIs.length } }, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  POI-PRIOR AUXILIARY ATTACK (' + usersMeta.length + ' users)');
  console.log('  strong POI list = all ' + strongPOIs.length + ' GT homes (upper bound)');
  console.log('  wide POI list   = ' + widePOIs.length + ' cells at 2 km grid');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log('Config           | Attack        | Median  | <200m | <500m |  Δ vs base');
  console.log('─'.repeat(80));
  for (const c of configs) {
    const base = summary[c].baseline.median;
    for (const a of attacks) {
      const s = summary[c][a];
      const delta = a === 'baseline' ? '--' :
        (s.median !== null && base !== null ? `${Math.round((base - s.median))} m` : '---');
      console.log(
        c.padEnd(16) + '| ' + a.padEnd(13) + '| ' +
        String((s.median === null ? '∞' : s.median) + ' m').padStart(8) + ' | ' +
        String(s.exposed200).padStart(5) + ' | ' +
        String(s.exposed500).padStart(5) + ' | ' + delta
      );
    }
    console.log('─'.repeat(80));
  }
}

main().catch(console.error);
