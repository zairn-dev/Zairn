/**
 * Static-geofence baseline (reviewer-requested comparison).
 * Geofence: suppress ALL observations within the buffer of a sensitive place;
 * OUTSIDE the buffer emit the RAW coordinate (no grid, no noise, no state label).
 * Isolates whether Grid+Zones' grid/labels add home privacy beyond a plain
 * binary geofence hole. Reuses the exact attack + seed conventions of
 * multi-seed-eval.mjs. Grid+Zones included for side-by-side.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { gridSnap } from '../../packages/sdk/dist/privacy-location.js';

const PROCESSED_DIR = join(import.meta.dirname, 'processed');
const RESULTS_DIR = join(import.meta.dirname, 'results');
const SEED_BASE = 'eval-user-seed';
const GRID_SIZE_M = 500;
const BUFFER_M = 1000;
const NUM_RUNS = 5;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function centroidAttack(obs, tLat, tLon) {
  if (obs.length === 0) return Infinity;
  const cs = 0.02, cells = new Map();
  for (const o of obs) { const k = `${Math.floor(o.sLat/cs)},${Math.floor(o.sLon/cs)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(o); }
  let best = null, bc = 0;
  for (const [,p] of cells) if (p.length > bc) { bc = p.length; best = p; }
  if (!best) return Infinity;
  const [br,bcc] = [...cells.entries()].find(([,v]) => v === best)[0].split(',').map(Number);
  const f = [];
  for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) { const k = `${br+dr},${bcc+dc}`; if (cells.has(k)) f.push(...cells.get(k)); }
  const aLat = f.reduce((s,o)=>s+o.sLat,0)/f.length, aLon = f.reduce((s,o)=>s+o.sLon,0)/f.length;
  return Math.round(haversine(aLat, aLon, tLat, tLon));
}
const stats = a => { const n=a.length, m=a.reduce((s,v)=>s+v,0)/n; return { mean: Math.round(m), std: Math.round(Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/n)), min: Math.min(...a), max: Math.max(...a) }; };

async function main() {
  await mkdir(RESULTS_DIR, { recursive: true });
  const users = JSON.parse(await readFile(join(PROCESSED_DIR, 'users.json'), 'utf-8'));
  const night = o => o.hour >= 22 || o.hour < 6;
  const methods = ['geofence', 'zkls_grid_zones'];
  const acc = {}; for (const m of methods) acc[m] = { medians: [], e200: [], e500: [] };

  for (let run = 0; run < NUM_RUNS; run++) {
    const runSeed = `${SEED_BASE}-run${run}`;
    for (const method of methods) {
      const errs = []; let e2 = 0, e5 = 0;
      for (const u of users) {
        const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${u.userId}.json`), 'utf-8'));
        const userSeed = `${runSeed}-${u.userId}`;
        const places = [ { lat: u.home.lat, lon: u.home.lon, bufferRadiusM: BUFFER_M }, ...(u.work ? [{ lat: u.work.lat, lon: u.work.lon, bufferRadiusM: BUFFER_M }] : []) ];
        const obs = [];
        for (const l of locs) {
          let inZone = false;
          for (const p of places) if (haversine(l.lat, l.lon, p.lat, p.lon) <= p.bufferRadiusM) { inZone = true; break; }
          if (inZone) continue;                 // both methods withhold inside buffer
          if (method === 'geofence') obs.push({ ...l, sLat: l.lat, sLon: l.lon });   // RAW outside
          else { const s = gridSnap(l.lat, l.lon, GRID_SIZE_M, userSeed); obs.push({ ...l, sLat: s.lat, sLon: s.lon }); }
        }
        const err = centroidAttack(obs.filter(night), u.home.lat, u.home.lon);
        errs.push(err); if (err < 200) e2++; if (err < 500) e5++;
      }
      const fin = errs.filter(e => e < Infinity).sort((a,b)=>a-b);
      acc[method].medians.push(fin.length ? fin[Math.floor(fin.length*0.5)] : null);
      acc[method].e200.push(e2); acc[method].e500.push(e5);
    }
    console.log(`run ${run+1}/${NUM_RUNS} done`);
  }
  const out = {};
  for (const m of methods) {
    out[m] = { median: stats(acc[m].medians), exposed200: stats(acc[m].e200), exposed500: stats(acc[m].e500) };
    const r = out[m];
    console.log(`\n${m}: median ${r.median.mean}±${r.median.std}m (range ${r.median.min}-${r.median.max}); <200 ${r.exposed200.mean}±${r.exposed200.std}; <500 ${r.exposed500.mean}±${r.exposed500.std}`);
  }
  await writeFile(join(RESULTS_DIR, 'geofence-baseline.json'), JSON.stringify(out, null, 2));
  console.log('\nSaved results/geofence-baseline.json');
}
main().catch(e => { console.error(e); process.exit(1); });
