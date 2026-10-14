/**
 * corridor-lib.mjs — shared primitives for the corridor-leak rework (PoPETs 2028.1)
 *
 * Pure eval-side library (NOT part of the SDK). Imports gridSnap from the built
 * SDK READ-ONLY; everything else is local so the mechanism can be prototyped and
 * measured without touching packages/. All randomness is a seeded mulberry32
 * (no Math.random / Date.now).
 *
 * It provides:
 *  - deterministic PRNG (mulberry32 + fnv1a string->int seed)
 *  - geo helpers (haversine, bearing) and angular statistics (R-bar, circular
 *    variance, sectors touched) for the disk-entry-angle analysis (Reviewer B)
 *  - the canonical commute-corridor metric, reproduced byte-for-byte from
 *    route-corridor-attack.mjs (GeoLife Grid+Zones recall_med = 0.333)
 *  - a single configurable emitter `emitStream()` implementing plain zone
 *    suppression plus the two Corridor-Aware Suppression (CAS) components:
 *       DBR  Directional Buffer Reshaping (anisotropic, bearing-adaptive zone)
 *       RCC  Reservoir Crossing Cap (per-cell single commute-hour emission)
 *  - crossing extraction + home-inference (centroid) + at-home T1 helpers so the
 *    two entry scripts stay thin.
 */

import { gridSnap } from '../../packages/sdk/dist/privacy-location.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (seeded; no Math.random / Date.now)
// ─────────────────────────────────────────────────────────────────────────────
export function hashSeed(str) {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing (degrees, [0,360)) from point 1 towards point 2. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const phi1 = lat1 * p, phi2 = lat2 * p, dl = (lon2 - lon1) * p;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export const N_SECTORS = 12;             // 30-degree sectors
export const SECTOR_DEG = 360 / N_SECTORS;
export const sectorOf = (deg) => Math.floor((((deg % 360) + 360) % 360) / SECTOR_DEG);

/**
 * Circular concentration statistics for a list of bearings (degrees).
 *   Rbar  mean resultant length in [0,1]; 1 = all crossings same bearing.
 *   circularVariance = 1 - Rbar; 0 = perfectly concentrated (corridor).
 *   sectorsTouched  distinct 30-degree sectors that received >=1 crossing (of 12).
 *   meanBearing  circular mean direction (degrees).
 */
export function angularStats(bearings) {
  const n = bearings.length;
  if (n === 0) return { n: 0, Rbar: null, circularVariance: null, sectorsTouched: 0, meanBearing: null };
  let sc = 0, ss = 0;
  const sectors = new Set();
  for (const b of bearings) {
    const r = b * Math.PI / 180;
    sc += Math.cos(r); ss += Math.sin(r);
    sectors.add(sectorOf(b));
  }
  const C = sc / n, S = ss / n;
  const Rbar = Math.sqrt(C * C + S * S);
  return {
    n,
    Rbar,
    circularVariance: 1 - Rbar,
    sectorsTouched: sectors.size,
    meanBearing: (Math.atan2(S, C) * 180 / Math.PI + 360) % 360,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical commute-corridor metric (identical to route-corridor-attack.mjs)
//   corridor cell = ~500m lat/lon cell; commute = weekday hours {7,8,17,18};
//   a cell counts if it is (non-home/work) and visited >= 2 times in commute hrs.
// ─────────────────────────────────────────────────────────────────────────────
export const COMMUTE_HOURS = new Set([7, 8, 17, 18]);
export const MIN_VISITS_FOR_CORRIDOR = 2;
export const corridorCell = (lat, lon) => `${Math.floor(lat / 0.005)},${Math.floor(lon / 0.005)}`;
export const isCommuteHour = (h) => (h >= 7 && h <= 9) || (h >= 17 && h <= 19);

export function buildPlaces(home, work) {
  return [
    { id: 'home', lat: home.lat, lon: home.lon, radiusM: 200, bufferRadiusM: 1000 },
    ...(work ? [{ id: 'work', lat: work.lat, lon: work.lon, radiusM: 200, bufferRadiusM: 1000 }] : []),
  ];
}

/** Set of corridor cells implied by a list of observations. obs: {lat,lon,hour,isWeekend,suppressed}. */
export function corridorFromObs(obs, excludeCells) {
  const cnt = new Map();
  for (const o of obs) {
    if (o.suppressed) continue;
    if (!COMMUTE_HOURS.has(o.hour)) continue;
    if (o.isWeekend) continue;
    const c = corridorCell(o.lat, o.lon);
    if (excludeCells.has(c)) continue;
    cnt.set(c, (cnt.get(c) || 0) + 1);
  }
  const cells = new Set();
  for (const [c, n] of cnt) if (n >= MIN_VISITS_FOR_CORRIDOR) cells.add(c);
  return cells;
}

export function scoreCorridor(pred, truth) {
  if (truth.size === 0) return null;
  let inter = 0;
  for (const c of pred) if (truth.has(c)) inter++;
  const precision = pred.size > 0 ? inter / pred.size : 0;
  const recall = inter / truth.size;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, predSize: pred.size, truthSize: truth.size, intersection: inter };
}

// ─────────────────────────────────────────────────────────────────────────────
// Corridor-Aware Suppression parameters
// ─────────────────────────────────────────────────────────────────────────────
export const GRID_SIZE_M = 500;
export const BASE_BUFFER_M = 1000;
export const CORE_M = 200;
export const R_EXT_M = 2500;      // DBR extended radius along corridor bearings
export const KAPPA = 1.5;         // sector is "corridor" if crossings >= KAPPA * mean
export const MIN_SECTOR_CROSSINGS = 2;

/**
 * Learn a place's corridor sectors from the user's own raw history: the 30-degree
 * bearing sectors that receive disproportionately many disk boundary crossings.
 * The disk is the base (1000m) buffer; bearings are place -> outside raw fix.
 * Corridor sectors = sectors carrying >= KAPPA * mean crossings, PLUS the dominant
 * travel cone (arg-max sector and its two neighbours), so the commute cone — which
 * spans ~1-3 adjacent sectors — is always covered. Learned over all crossings (the
 * home<->work axis dominates day and night); DBR then applies the extension only
 * during commute hours. Eval prototype uses the full trace; a deployment would use
 * a causal rolling window.
 */
export function learnCorridorSectors(locs, place) {
  const inDisk = (l) => haversine(l.lat, l.lon, place.lat, place.lon) <= BASE_BUFFER_M;
  const counts = new Array(N_SECTORS).fill(0);
  const pushCross = (pt) => { counts[sectorOf(bearing(place.lat, place.lon, pt.lat, pt.lon))]++; };
  let prev = null;
  for (const l of locs) {
    const cur = inDisk(l);
    if (prev !== null) {
      if (prev.in && !cur) pushCross(l);          // exit: cur is the crossing point
      if (!prev.in && cur) pushCross(prev.l);     // entry: prev is the crossing point
    }
    prev = { in: cur, l };
  }
  const total = counts.reduce((s, c) => s + c, 0);
  if (total < 4) return new Set();
  const nonEmpty = counts.filter(c => c > 0);
  const mean = nonEmpty.reduce((s, c) => s + c, 0) / nonEmpty.length;
  const sectors = new Set();
  for (let s = 0; s < N_SECTORS; s++) {
    if (counts[s] >= MIN_SECTOR_CROSSINGS && counts[s] >= KAPPA * mean) sectors.add(s);
  }
  let arg = 0;
  for (let s = 1; s < N_SECTORS; s++) if (counts[s] > counts[arg]) arg = s;
  if (counts[arg] >= MIN_SECTOR_CROSSINGS) {
    sectors.add(arg);
    sectors.add((arg + 1) % N_SECTORS);
    sectors.add((arg + N_SECTORS - 1) % N_SECTORS);
  }
  return sectors;
}

/** Destination point given a start, initial bearing (deg) and distance (m). */
export function destPoint(lat, lon, bearingDeg, distM) {
  const R = 6371000, p = Math.PI / 180;
  const br = bearingDeg * p, la1 = lat * p, lo1 = lon * p, dr = distM / R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1),
    Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 / p, lon: (((lo2 / p + 540) % 360) - 180) };
}

/**
 * Single configurable emitter.
 *   opts = { dbr:false, rcc:false, adx:false, homeOnly:false, rExt:R_EXT_M }
 * Returns a per-fix stream (time-ordered). Real fixes align 1:1 with locs; ADX
 * decoy fixes (isDecoy:true) are appended.
 *   { hour, isWeekend, day, lat, lon,          // raw (decoys carry synthetic coords)
 *     inHomeZone,                              // inside the (possibly reshaped) HOME disk
 *     suppressed,                              // final withhold decision (any reason)
 *     sLat, sLon, cellId,                      // emitted grid cell (null if suppressed)
 *     isDecoy }                                // ADX angular decoy (default false)
 * Determinism: gridSnap seeded by userSeed; RCC + ADX use mulberry32(userSeed).
 */
export function emitStream(locs, places, userSeed, opts = {}) {
  const { dbr = false, rcc = false, adx = false, homeOnly = false, rExt = R_EXT_M } = opts;
  const active = homeOnly ? places.filter(p => p.id === 'home') : places;
  const home = places.find(p => p.id === 'home') || places[0];

  // DBR: learn corridor sectors per active place.
  const sectorsByPlace = new Map();
  if (dbr) for (const p of active) sectorsByPlace.set(p, learnCorridorSectors(locs, p));

  const effRadius = (l, p) => {
    if (!dbr) return p.bufferRadiusM;
    if (!isCommuteHour(l.hour)) return p.bufferRadiusM;       // DBR is commute-scoped
    const s = sectorOf(bearing(p.lat, p.lon, l.lat, l.lon));
    return sectorsByPlace.get(p).has(s) ? rExt : p.bufferRadiusM;
  };

  // Pass 1: geometric suppression + emitted candidate.
  const stream = locs.map((l) => {
    let suppressed = false;
    for (const p of active) {
      const d = haversine(l.lat, l.lon, p.lat, p.lon);
      if (d <= p.radiusM) { suppressed = true; break; }
      if (d <= effRadius(l, p)) { suppressed = true; }
    }
    // Inside the (possibly DBR-reshaped) home disk. effRadius >= core, so this
    // subsumes the core radius; used only for boundary-crossing / angle analysis.
    const inHomeZone = haversine(l.lat, l.lon, home.lat, home.lon) <= effRadius(l, home);
    let sLat = null, sLon = null, cellId = null;
    if (!suppressed) {
      const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed);
      sLat = s.lat; sLon = s.lon; cellId = s.cellId;
    }
    return { hour: l.hour, isWeekend: l.isWeekend, day: l.day, lat: l.lat, lon: l.lon, inHomeZone, suppressed, sLat, sLon, cellId };
  });

  // Pass 2: RCC — reservoir-cap each grid cell to a single commute-hour emission.
  if (rcc) {
    const rng = mulberry32(hashSeed(userSeed + '::rcc'));
    const seen = new Map(); // cellId -> { count, keptIndex }
    stream.forEach((r, i) => {
      if (r.suppressed || !isCommuteHour(r.hour)) return;
      const rec = seen.get(r.cellId);
      if (!rec) { seen.set(r.cellId, { count: 1, keptIndex: i }); return; }
      rec.count++;
      // reservoir: keep index i with prob 1/count (uniform single survivor per cell)
      if (rng() < 1 / rec.count) rec.keptIndex = i;
    });
    // withhold every commute-hour emission that is not its cell's survivor
    const survivors = new Set([...seen.values()].map(v => v.keptIndex));
    stream.forEach((r, i) => {
      if (r.suppressed || !isCommuteHour(r.hour)) return;
      if (!survivors.has(i)) { r.suppressed = true; r.sLat = r.sLon = r.cellId = null; }
    });
  }

  stream.forEach(r => { r.isDecoy = false; });

  // Pass 3: ADX — angular decoys. Radial suppression cannot rotate the crossing
  // bearing, so for every real commute crossing in an over-represented sector we
  // emit one seeded decoy near-disk fix in an under-represented sector, flattening
  // the entry-angle histogram the attacker observes. Decoys land in fresh 500m
  // cells (each visited once) so they never form >=2-visit corridor cells; they
  // are commute-hour only (night home-inference untouched) and are excluded from
  // the genuine at-home social task.
  if (adx) {
    for (const d of injectAngularDecoys(stream, home, userSeed)) stream.push(d);
  }

  return stream;
}

/** Build ADX decoy fixes for the home disk from an emitted stream. */
export function injectAngularDecoys(stream, home, userSeed) {
  const rng = mulberry32(hashSeed(userSeed + '::adx'));
  // Real commute crossings (bearing + hour) from the home-disk trajectory.
  const crossings = [];
  const ok = (r) => !r.suppressed && r.sLat !== null;
  const commute = (r) => COMMUTE_HOURS.has(r.hour) && !r.isWeekend;
  const real = stream.filter(r => !r.isDecoy);
  for (let i = 1; i < real.length; i++) {
    const prev = real[i - 1], cur = real[i];
    if (prev.inHomeZone && !cur.inHomeZone && ok(cur) && commute(cur)) {
      crossings.push({ b: bearing(home.lat, home.lon, cur.sLat, cur.sLon), hour: cur.hour });
    }
    if (!prev.inHomeZone && cur.inHomeZone && ok(prev) && commute(prev)) {
      crossings.push({ b: bearing(home.lat, home.lon, prev.sLat, prev.sLon), hour: prev.hour });
    }
  }
  if (crossings.length < 4) return [];
  const counts = new Array(N_SECTORS).fill(0);
  for (const c of crossings) counts[sectorOf(c.b)]++;
  const nonEmpty = counts.filter(c => c > 0);
  const meanC = nonEmpty.reduce((s, c) => s + c, 0) / nonEmpty.length;
  const cur = counts.slice();
  const decoys = [];
  for (const c of crossings) {
    const s = sectorOf(c.b);
    if (counts[s] < KAPPA * meanC) continue;            // only balance over-represented sectors
    // pick a currently least-populated sector (seeded tie-break)
    const minv = Math.min(...cur);
    const cand = [];
    for (let k = 0; k < N_SECTORS; k++) if (cur[k] === minv) cand.push(k);
    const tgt = cand[Math.floor(rng() * cand.length)];
    cur[tgt]++;
    const brng = (tgt * SECTOR_DEG) + SECTOR_DEG / 2 + (rng() * 2 - 1) * (SECTOR_DEG / 2 - 2);
    const rad = BASE_BUFFER_M + rng() * 500;            // annulus 1000-1500m
    const pt = destPoint(home.lat, home.lon, brng, rad);
    const g = gridSnap(pt.lat, pt.lon, GRID_SIZE_M, userSeed);
    decoys.push({
      hour: c.hour, isWeekend: false, day: null, lat: pt.lat, lon: pt.lon,
      inHomeZone: false, suppressed: false, sLat: g.lat, sLon: g.lon, cellId: g.cellId, isDecoy: true,
    });
  }
  return decoys;
}

/** Corridor observations (for corridorFromObs) from an emitted stream. */
export function streamToObs(stream) {
  return stream.map(r => r.suppressed
    ? { suppressed: true, hour: r.hour, isWeekend: r.isWeekend }
    : { suppressed: false, lat: r.sLat, lon: r.sLon, hour: r.hour, isWeekend: r.isWeekend });
}

/**
 * Home-disk boundary crossings observed in an emitted stream.
 * Returns the list of bearings (home -> emitted outside fix) for every
 * exit (first emitted fix after leaving the disk) and entry (last emitted
 * fix before entering the disk). commuteOnly restricts to weekday commute hrs.
 */
export function homeCrossings(stream, home, { commuteOnly = false } = {}) {
  const bearings = [];
  const ok = (r) => !r.suppressed && r.sLat !== null;
  const passFilter = (r) => !commuteOnly || (COMMUTE_HOURS.has(r.hour) && !r.isWeekend);
  // ADX decoys are standalone near-disk emissions the attacker observes as crossings.
  for (const r of stream) {
    if (r.isDecoy && ok(r) && passFilter(r)) bearings.push(bearing(home.lat, home.lon, r.sLat, r.sLon));
  }
  const seq = stream.filter(r => !r.isDecoy);
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1], cur = seq[i];
    if (prev.inHomeZone && !cur.inHomeZone && ok(cur) && passFilter(cur)) {
      bearings.push(bearing(home.lat, home.lon, cur.sLat, cur.sLon));
    }
    if (!prev.inHomeZone && cur.inHomeZone && ok(prev) && passFilter(prev)) {
      bearings.push(bearing(home.lat, home.lon, prev.sLat, prev.sLon));
    }
  }
  return bearings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Home-inference (cluster centroid attack — identical to convergence-multiseed.mjs)
// ─────────────────────────────────────────────────────────────────────────────
export function centroidAttack(obs, targetLat, targetLon) {
  if (obs.length === 0) return { error: Infinity, count: 0 };
  const cellSize = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const key = `${Math.floor(o.sLat / cellSize)},${Math.floor(o.sLon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(o);
  }
  let bestKey = null, bestCount = 0;
  for (const [key, pts] of cells) if (pts.length > bestCount) { bestCount = pts.length; bestKey = key; }
  if (!bestKey) {
    const aLat = obs.reduce((s, o) => s + o.sLat, 0) / obs.length;
    const aLon = obs.reduce((s, o) => s + o.sLon, 0) / obs.length;
    return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: obs.length };
  }
  const [bRow, bCol] = bestKey.split(',').map(Number);
  const filtered = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const nKey = `${bRow + dr},${bCol + dc}`;
    if (cells.has(nKey)) filtered.push(...cells.get(nKey));
  }
  const aLat = filtered.reduce((s, o) => s + o.sLat, 0) / filtered.length;
  const aLon = filtered.reduce((s, o) => s + o.sLon, 0) / filtered.length;
  return { error: Math.round(haversine(aLat, aLon, targetLat, targetLon)), count: filtered.length };
}

/** Night-time (22:00-06:00) home-inference error from an emitted stream. */
export function homeNightError(stream, home) {
  const nightObs = stream
    .filter(r => !r.suppressed && (r.hour >= 22 || r.hour < 6))
    .map(r => ({ sLat: r.sLat, sLon: r.sLon }));
  return centroidAttack(nightObs, home.lat, home.lon).error;
}

/**
 * Inclusive at-home T1 accuracy (identical definition to corridor-mitigation.mjs):
 * for each hour bucket, did the defense's answer (emitted cell within 200m of home,
 * or "no" if suppressed) match ground truth (any raw fix within 200m of home)?
 */
export function atHomeT1(locs, stream, home) {
  const emitByHour = new Map();
  for (const r of stream) if (!r.suppressed && !r.isDecoy) emitByHour.set(r.hour, r);
  const locsByHour = new Map();
  for (const l of locs) {
    if (!locsByHour.has(l.hour)) locsByHour.set(l.hour, []);
    locsByHour.get(l.hour).push(l);
  }
  let correct = 0, total = 0;
  for (const [h, hrLocs] of locsByHour) {
    const truth = hrLocs.some(l => haversine(l.lat, l.lon, home.lat, home.lon) <= 200);
    const emit = emitByHour.get(h);
    const saysHome = emit ? haversine(emit.sLat, emit.sLon, home.lat, home.lon) <= 200 : false;
    total++;
    if (saysHome === truth) correct++;
  }
  return total > 0 ? correct / total : null;
}

export const median = (arr) => {
  const a = arr.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length * 0.5)] : null;
};
export const mean = (arr) => {
  const a = arr.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
};
export const quantile = (arr, q) => {
  const a = arr.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null;
};
