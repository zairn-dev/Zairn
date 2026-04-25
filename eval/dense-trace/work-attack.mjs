import { readFile } from 'fs/promises';
import { join } from 'path';
import { addPlanarLaplaceNoise, gridSnap, processLocation, AdaptiveReporter, DEFAULT_PRIVACY_CONFIG } from '../../packages/sdk/dist/privacy-location.js';

const SEED = 'deployment-user';
const BASE_EPSILON = Math.LN2 / 500;
const GRID_SIZE_M = 500;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1, Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function centroidAttack(obs, tLat, tLon) {
  if (!obs.length) return Infinity;
  const cs = 0.02;
  const cells = new Map();
  for (const o of obs) {
    const k = `${Math.floor(o.sLat/cs)},${Math.floor(o.sLon/cs)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  let bk=null, bc=0;
  for (const [k,p] of cells) if (p.length>bc) { bc=p.length; bk=k; }
  if (!bk) return Infinity;
  const [r,c] = bk.split(',').map(Number);
  const f = [];
  for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) {
    const nk = `${r+dr},${c+dc}`;
    if (cells.has(nk)) f.push(...cells.get(nk));
  }
  const aLat = f.reduce((s,o)=>s+o.sLat,0)/f.length;
  const aLon = f.reduce((s,o)=>s+o.sLon,0)/f.length;
  return Math.round(haversine(aLat,aLon,tLat,tLon));
}

const raw = JSON.parse(await readFile(join(import.meta.dirname, 'clean-segABC.json'), 'utf8'));
const trace = raw.trace;

const nightPts = trace.filter(p => { const h=new Date(p.ts).getHours(); return h>=22||h<6; });
const cs2 = 0.002;
const ncells = new Map();
for (const p of nightPts) {
  const k = `${Math.floor(p.lat/cs2)},${Math.floor(p.lon/cs2)}`;
  if (!ncells.has(k)) ncells.set(k,[]);
  ncells.get(k).push(p);
}
let best=null, bc=0;
for (const [,ps] of ncells) if (ps.length>bc) { bc=ps.length; best=ps; }
const home = { lat: best.reduce((s,p)=>s+p.lat,0)/best.length, lon: best.reduce((s,p)=>s+p.lon,0)/best.length };

const dayPts = trace.filter(p => { const d=new Date(p.ts); const h=d.getHours(); const dow=d.getDay(); return dow!==0&&dow!==6&&h>=9&&h<17; });
const dcells = new Map();
for (const p of dayPts) {
  const k = `${Math.floor(p.lat/cs2)},${Math.floor(p.lon/cs2)}`;
  if (!dcells.has(k)) dcells.set(k,[]);
  dcells.get(k).push(p);
}
let work = null, wc = 0;
for (const [,ps] of dcells) {
  const cl = ps.reduce((s,p)=>s+p.lat,0)/ps.length;
  const co = ps.reduce((s,p)=>s+p.lon,0)/ps.length;
  if (haversine(cl,co,home.lat,home.lon) > 500 && ps.length>wc) { wc=ps.length; work={lat:cl,lon:co}; }
}
console.log('home:', home, 'work:', work);

const isWorkHr = p => { const d=new Date(p.ts); const h=d.getHours(); const dow=d.getDay(); return dow!==0 && dow!==6 && h>=9 && h<17; };
const wlocs = trace.filter(isWorkHr);
console.log('weekday-daytime obs:', wlocs.length);

const obsRaw = wlocs.map(p => ({...p, sLat:p.lat, sLon:p.lon}));
console.log('Raw work err:', centroidAttack(obsRaw, work.lat, work.lon));

const obsLap = wlocs.map(p => {
  const n = addPlanarLaplaceNoise(p.lat, p.lon, BASE_EPSILON);
  const s = gridSnap(n.lat, n.lon, GRID_SIZE_M, SEED);
  return {...p, sLat:s.lat, sLon:s.lon};
});
console.log('Laplace+Grid work err:', centroidAttack(obsLap, work.lat, work.lon));

const places = [
  { id:'home', label:'home', lat:home.lat, lon:home.lon, radiusM:200, bufferRadiusM:1000, visitCount:30, avgDwellMinutes:480 },
  { id:'work', label:'work', lat:work.lat, lon:work.lon, radiusM:200, bufferRadiusM:1000, visitCount:20, avgDwellMinutes:480 },
];
const obsZGZ = [];
for (const p of wlocs) {
  let inB=false, inC=false;
  for (const pl of places) {
    const d = haversine(p.lat,p.lon,pl.lat,pl.lon);
    if (d<=pl.radiusM) { inC=true; break; }
    if (d<=pl.bufferRadiusM) { inB=true; }
  }
  if (inC || inB) continue;
  const s = gridSnap(p.lat, p.lon, GRID_SIZE_M, SEED);
  obsZGZ.push({...p, sLat:s.lat, sLon:s.lon});
}
console.log('ZKLS G+Z work err:', centroidAttack(obsZGZ, work.lat, work.lon), 'n=', obsZGZ.length);

const cfg6 = {...DEFAULT_PRIVACY_CONFIG, gridSeed:SEED, baseEpsilon:BASE_EPSILON};
const r6 = new AdaptiveReporter(12,2);
const obs6 = [];
for (const p of wlocs) {
  const r = processLocation(p.lat, p.lon, places, cfg6, r6);
  if (r.type === 'coarse') obs6.push({...p, sLat:r.lat, sLon:r.lon});
}
console.log('6-Layer work err:', centroidAttack(obs6, work.lat, work.lon), 'n=', obs6.length);
