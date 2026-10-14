/**
 * Paper ① — K1: OSM land-use as a METHOD-INDEPENDENT external criterion
 * (panel fix: breaks the GT↔labeler circularity at the GT level).
 *
 * Two audits over the 90-day window, fixed cohort:
 *  A. GT audit — is the DERIVED home centroid in residential-like land use?
 *     is the DERIVED work centroid in work-like land use?
 *  B. Labeler audit — of places the SUT labels 'home' / 'work', what fraction
 *     sits in residential-like / work-like land use? (external label precision)
 *
 * Classification: Overpass features within 100 m of the centroid.
 *  residential-like: landuse=residential | building∈{residential,apartments,
 *    house,dormitory,terrace}
 *  work-like: landuse∈{commercial,retail,industrial,education} |
 *    building∈{commercial,office,industrial,university,school} |
 *    amenity∈{university,college,school,research_institute} | office=*
 * Best-effort: OSM Beijing coverage is partial → 'unknown' reported honestly.
 * Results cached in results/osm-cache.json (re-runs are free).
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { detectSensitivePlaces, DEFAULT_PRIVACY_CONFIG } from '../../packages/sdk/dist/privacy-location.js';

const PD = join(import.meta.dirname, 'processed');
const RD = join(import.meta.dirname, 'results');
const W = 90, R = 1000, AROUND = 100;
const OVERPASS = 'https://overpass-api.de/api/interpreter';

function hav(a, b, c, d) {
  const E = 6371000, p = Math.PI / 180;
  const x = Math.min(1, Math.sin((c-a)*p/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2);
  return E * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cache = {};
const cachePath = join(RD, 'osm-cache.json');
const key = (lat, lon) => lat.toFixed(5) + ',' + lon.toFixed(5);

async function classify(lat, lon) {
  const k = key(lat, lon);
  if (cache[k]) return cache[k];
  const q = `[out:json][timeout:20];
(way(around:${AROUND},${lat},${lon})[landuse];
 way(around:${AROUND},${lat},${lon})[building];
 way(around:${AROUND},${lat},${lon})[amenity~"university|college|school|research_institute"];
 way(around:${AROUND},${lat},${lon})[office];
 relation(around:${AROUND},${lat},${lon})[landuse];
 relation(around:${AROUND},${lat},${lon})[amenity~"university|college|school"];);
out tags 40;`;
  let els = null;
  for (let attempt = 0; attempt < 3 && !els; attempt++) {
    try {
      const r = await fetch(OVERPASS, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'construct-validity-research/1.0 (academic)' },
      });
      if (r.status === 429 || r.status === 504) { await sleep(15000); continue; }
      els = (await r.json()).elements;
    } catch { await sleep(5000); }
  }
  if (!els) return { cls: 'error', res: 0, work: 0 };
  const RES_B = ['residential', 'apartments', 'house', 'dormitory', 'terrace'];
  const WORK_L = ['commercial', 'retail', 'industrial', 'education'];
  const WORK_B = ['commercial', 'office', 'industrial', 'university', 'school'];
  let res = 0, work = 0;
  for (const e of els) {
    const t = e.tags || {};
    if (t.landuse === 'residential' || RES_B.includes(t.building)) res++;
    if (WORK_L.includes(t.landuse) || WORK_B.includes(t.building) || t.amenity || t.office) work++;
  }
  const cls = !res && !work ? 'unknown' : res >= work ? 'residential' : 'worklike';
  const out = { cls, res, work };
  cache[k] = out;
  await writeFile(cachePath, JSON.stringify(cache));
  await sleep(800);
  return out;
}

async function main() {
  await mkdir(RD, { recursive: true });
  try { cache = JSON.parse(await readFile(cachePath, 'utf-8')); } catch {}
  const users = JSON.parse(await readFile(join(PD, 'users.json'), 'utf-8'));

  const gt = { home: { residential: 0, worklike: 0, unknown: 0, error: 0 }, work: { residential: 0, worklike: 0, unknown: 0, error: 0 } };
  const lab = { home: { residential: 0, worklike: 0, unknown: 0, error: 0 }, work: { residential: 0, worklike: 0, unknown: 0, error: 0 } };
  let done = 0;

  for (const u of users) {
    const locs = JSON.parse(await readFile(join(PD, `${u.userId}.json`), 'utf-8'));
    const tr = locs.filter(l => l.day < W).map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));
    if (tr.length < 10) continue;

    // A. GT audit
    gt.home[(await classify(u.home.lat, u.home.lon)).cls]++;
    if (u.work) gt.work[(await classify(u.work.lat, u.work.lon)).cls]++;

    // B. labeler audit (90d detections)
    const det = detectSensitivePlaces(tr, { ...DEFAULT_PRIVACY_CONFIG, minVisitsForSensitive: 3, minDwellMinutes: 30 });
    for (const p of det) {
      if (p.label === 'home') lab.home[(await classify(p.lat, p.lon)).cls]++;
      else if (p.label === 'work') lab.work[(await classify(p.lat, p.lon)).cls]++;
    }
    done++;
    if (done % 10 === 0) console.log(`...${done} users`);
  }

  const pct = (o, k) => {
    const cov = o.residential + o.worklike;            // classifiable only
    const tot = cov + o.unknown + o.error;
    return { counts: o, coveragePct: tot ? +(100 * cov / tot).toFixed(1) : null, [`${k}OfClassifiablePct`]: cov ? +(100 * o[k] / cov).toFixed(1) : null };
  };
  const out = {
    _note: 'OSM/Overpass land-use external criterion, 90d window. Coverage = fraction of centroids with any classifiable OSM feature within 100m; precision computed over classifiable only (honest partial coverage).',
    usersEvaluated: done,
    gtAudit: { homeCentroids: pct(gt.home, 'residential'), workCentroids: pct(gt.work, 'worklike') },
    labelerAudit: { placesLabeledHome: pct(lab.home, 'residential'), placesLabeledWork: pct(lab.work, 'worklike') },
  };
  await writeFile(join(RD, 'osm-external-criterion.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
